/* Reads an uncompressed X-Plane DSF scenery tile (the binary files in "Earth nav data" of a Scenery Gateway
   pack): which library objects and polygons it uses, where objects stand, and the outlines of polygons such
   as terminal facades, with their height. The library art itself ships with X-Plane, not in the pack. */
(function (root) {
    'use strict';

    const atomId = (view, at) => String.fromCharCode(view.getUint8(at + 3), view.getUint8(at + 2), view.getUint8(at + 1), view.getUint8(at));

    function atoms(view, start, end) {
        const list = [];
        for (let at = start; at + 8 <= end;) {
            const length = view.getUint32(at + 4, true);
            if (length < 8) break;
            list.push({ id: atomId(view, at), start: at + 8, end: at + length });
            at += length;
        }
        return list;
    }

    function strings(bytes, atom) {
        const text = new TextDecoder().decode(bytes.subarray(atom.start, atom.end));
        return text.split('\0').slice(0, -1);
    }

    // A planar numeric pool: N points, each with P planes, each plane stored raw, differenced and/or run-length.
    function readPool(view, atom, wide) {
        let at = atom.start;
        const count = view.getUint32(at, true), planes = view.getUint8(at + 4);
        at += 5;
        const size = wide ? 4 : 2;
        const get = p => wide ? view.getUint32(p, true) : view.getUint16(p, true);
        const data = Array.from({ length: planes }, () => new Float64Array(count));
        for (let p = 0; p < planes; p++) {
            const mode = view.getUint8(at++);
            const values = data[p];
            if (mode & 2) {
                for (let i = 0; i < count;) {
                    const run = view.getUint8(at++);
                    if (run & 128) {
                        const v = get(at); at += size;
                        for (let k = 0; k < (run & 127); k++) values[i++] = v;
                    } else {
                        for (let k = 0; k < run; k++) { values[i++] = get(at); at += size; }
                    }
                }
            } else {
                for (let i = 0; i < count; i++) { values[i] = get(at); at += size; }
            }
            if (mode & 1) {
                const mask = wide ? 0x100000000 : 0x10000;
                for (let i = 1; i < count; i++) values[i] = (values[i] + values[i - 1]) % mask;
            }
        }
        return { count, planes, data, max: wide ? 4294967295 : 65535 };
    }

    function scalePool(pool, view, atom) {
        const points = [];
        const scales = [];
        for (let p = 0; p < pool.planes; p++) {
            scales.push([view.getFloat32(atom.start + p * 8, true), view.getFloat32(atom.start + p * 8 + 4, true)]);
        }
        for (let i = 0; i < pool.count; i++) {
            const point = new Array(pool.planes);
            for (let p = 0; p < pool.planes; p++) {
                const [scale, offset] = scales[p];
                point[p] = scale ? pool.data[p][i] / pool.max * scale + offset : pool.data[p][i];
            }
            points.push(point);
        }
        return points;
    }

    function parseDsf(buffer) {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const magic = new TextDecoder().decode(bytes.subarray(0, 8));
        if (magic !== 'XPLNEDSF') throw new Error('Not an uncompressed DSF file (it may be 7-Zip compressed).');
        const top = atoms(view, 12, bytes.length - 16);
        const find = id => top.find(a => a.id === id);

        const tile = { properties: {}, objectDefs: [], polygonDefs: [], objects: [], polygons: [] };
        const head = find('HEAD');
        if (head) {
            const prop = atoms(view, head.start, head.end).find(a => a.id === 'PROP');
            const list = prop ? strings(bytes, prop) : [];
            for (let i = 0; i + 1 < list.length; i += 2) tile.properties[list[i]] = list[i + 1];
        }
        const defn = find('DEFN');
        if (defn) for (const a of atoms(view, defn.start, defn.end)) {
            if (a.id === 'OBJT') tile.objectDefs = strings(bytes, a);
            if (a.id === 'POLY') tile.polygonDefs = strings(bytes, a);
        }

        // Pools are listed first and their scales after; the nth SCAL belongs to the nth POOL (likewise PO32
        // and SC32). Commands refer to pools by that order.
        const pools = [], pools32 = [];
        const geod = find('GEOD');
        if (geod) {
            const raw = { POOL: [], PO32: [] }, scale = { SCAL: [], SC32: [] };
            for (const a of atoms(view, geod.start, geod.end)) {
                if (a.id in raw) raw[a.id].push(readPool(view, a, a.id === 'PO32'));
                if (a.id in scale) scale[a.id].push(a);
            }
            raw.POOL.forEach((pool, i) => scale.SCAL[i] && pools.push(scalePool(pool, view, scale.SCAL[i])));
            raw.PO32.forEach((pool, i) => scale.SC32[i] && pools32.push(scalePool(pool, view, scale.SC32[i])));
        }

        const cmds = find('CMDS');
        if (!cmds) return tile;
        let at = cmds.start, pool = pools[0] || [], def = 0;
        const u8 = () => view.getUint8(at++);
        const u16 = () => { const v = view.getUint16(at, true); at += 2; return v; };
        const u32 = () => { const v = view.getUint32(at, true); at += 4; return v; };
        const object = i => {
            const p = pool[i];
            if (p) tile.objects.push({ def: tile.objectDefs[def], lon: p[0], lat: p[1], heading: p[2] ?? 0 });
        };
        const polygon = (param, windings) => {
            tile.polygons.push({ def: tile.polygonDefs[def], param, windings: windings.map(w => w.map(i => pool[i]).filter(Boolean)) });
        };

        while (at < cmds.end) {
            const op = u8();
            switch (op) {
                case 1: pool = pools[u16()] || []; break;
                case 2: u32(); break;
                case 3: def = u8(); break;
                case 4: def = u16(); break;
                case 5: def = u32(); break;
                case 6: u8(); break;
                case 7: object(u16()); break;
                case 8: { const first = u16(), last = u16(); for (let i = first; i < last; i++) object(i); break; }
                case 9: { const n = u8(); at += n * 2; break; }
                case 10: at += 4; break;
                case 11: { const n = u8(); at += n * 4; break; }
                case 12: { const param = u16(), n = u8(); const w = []; for (let i = 0; i < n; i++) w.push(u16()); polygon(param, [w]); break; }
                case 13: { const param = u16(), first = u16(), last = u16(); const w = []; for (let i = first; i < last; i++) w.push(i); polygon(param, [w]); break; }
                case 14: {
                    const param = u16(), windings = u8(), list = [];
                    for (let k = 0; k < windings; k++) { const n = u8(); const w = []; for (let i = 0; i < n; i++) w.push(u16()); list.push(w); }
                    polygon(param, list);
                    break;
                }
                case 15: {
                    const param = u16(), windings = u8(), marks = [];
                    for (let k = 0; k <= windings; k++) marks.push(u16());
                    const list = [];
                    for (let k = 0; k < windings; k++) { const w = []; for (let i = marks[k]; i < marks[k + 1]; i++) w.push(i); list.push(w); }
                    polygon(param, list);
                    break;
                }
                case 16: break;
                case 17: u8(); break;
                case 18: at += 9; break;
                case 23: case 26: case 29: { const n = u8(); at += n * 2; break; }
                case 24: case 27: case 30: { const n = u8(); at += n * 4; break; }
                case 25: case 28: case 31: at += 4; break;
                case 32: { const n = u8(); at += n; break; }
                case 33: { const n = u16(); at += n; break; }
                case 34: { const n = u32(); at += n; break; }
                default: throw new Error(`Unknown DSF command ${op} at byte ${at - 1}.`);
            }
        }
        return tile;
    }

    const api = { parseDsf };
    root.DsfParser = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
