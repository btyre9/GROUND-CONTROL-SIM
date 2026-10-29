/* The ramp around one gate: concrete apron and asphalt taxilane, the painted markings a ramp agent works
   to, the terminal with its concourse glass and bag-room doors, the docking guidance display, and the
   floodlight masts.

   Markings follow common US practice (FAA AC 150/5340-1 colors, airline stand layouts):
   - lead-in line: yellow with a black border, from the taxilane to the stop bar
   - stop bar across the lead-in, labeled with the types that stop there
   - equipment restraint area (ERA): red line; no equipment inside while an aircraft moves
   - head-of-stand service road: white edge lines, dashed center line, "STOP" where it crosses the lead-in
   - bridge drive area and parking box: hatched, where the bridge wheels may go
   - GSE staging boxes and the chock and cone rack outside the ERA */
import * as THREE from 'three';
import * as TEX from '../textures.js';
import { makeLights, KIND } from '../lights.js';
import { STAND, leadIn } from './layout.js';

const AREA = { x0: -95, x1: 95, z0: -20, z1: 95 };   // The painted apron.
const PX = 14;                                          // Marking texture pixels per meter.

function markings(stand) {
    const w = AREA.x1 - AREA.x0, h = AREA.z1 - AREA.z0;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * PX); canvas.height = Math.round(h * PX);
    const ctx = canvas.getContext('2d');
    const X = x => (x - AREA.x0) * PX, Z = z => (z - AREA.z0) * PX;
    const line = (pts, color, width, dash = []) => {
        ctx.beginPath(); ctx.setLineDash(dash.map(d => d * PX));
        pts.forEach((p, i) => i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z)));
        ctx.strokeStyle = color; ctx.lineWidth = width * PX; ctx.lineCap = 'butt'; ctx.stroke();
        ctx.setLineDash([]);
    };
    const text = (s, x, z, size, color, rotate = 0) => {
        ctx.save(); ctx.translate(X(x), Z(z)); ctx.rotate(rotate);
        ctx.font = `bold ${size * PX}px "Helvetica Neue", Arial, sans-serif`;
        ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(s, 0, 0); ctx.restore();
    };
    const hatch = (x0, z0, x1, z1, color, step = 1.2) => {
        ctx.save(); ctx.beginPath(); ctx.rect(X(x0), Z(z0), (x1 - x0) * PX, (z1 - z0) * PX); ctx.clip();
        ctx.strokeStyle = color; ctx.lineWidth = 0.15 * PX;
        for (let d = -(z1 - z0); d < x1 - x0; d += step) {
            ctx.beginPath(); ctx.moveTo(X(x0 + d), Z(z0)); ctx.lineTo(X(x0 + d + (z1 - z0)), Z(z1)); ctx.stroke();
        }
        ctx.restore();
        line([{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }, { x: x0, z: z0 }], color, 0.15);
    };
    const YELLOW = '#f2c200', RED = '#c8102e', WHITE = '#f3f3ee', BLACK = '#111';

    // Taxilane centerline and its edge markings.
    line([{ x: AREA.x0, z: stand.taxilaneZ }, { x: AREA.x1, z: stand.taxilaneZ }], BLACK, 0.45);
    line([{ x: AREA.x0, z: stand.taxilaneZ }, { x: AREA.x1, z: stand.taxilaneZ }], YELLOW, 0.15);

    // Lead-in lines for this gate and the gates either side, black bordered so they show on concrete.
    for (const dx of [0, ...stand.neighbors]) {
        const pts = leadIn({ ...stand, stop: { x: stand.stop.x + dx, z: stand.stop.z } }).filter(p => p.toStop >= -1.5);
        line(pts, BLACK, 0.45);
        line(pts, YELLOW, 0.15);
        // Stop bar: 0.3 m yellow bar across the line, black bordered, with the types.
        const sx = stand.stop.x + dx, sz = stand.stop.z;
        ctx.fillStyle = BLACK; ctx.fillRect(X(sx - 2.2), Z(sz - 0.3), 4.4 * PX, 0.6 * PX);
        ctx.fillStyle = YELLOW; ctx.fillRect(X(sx - 2.0), Z(sz - 0.15), 4.0 * PX, 0.3 * PX);
        text('737', sx - 3.6, sz + 0.05, 0.9, YELLOW);
        text('-7/-8/-9', sx + 4.4, sz + 0.05, 0.75, YELLOW);
        // A320 family stops a little further on (its door is further back from the nose gear).
        ctx.fillStyle = YELLOW; ctx.fillRect(X(sx - 1.6), Z(sz - 2.15), 3.2 * PX, 0.3 * PX);
        text('A320', sx - 3.0, sz - 2.0, 0.75, YELLOW);
        text(stand.name.replace(/\d+$/, n => String(+n + Math.sign(dx))), sx, sz + 14, 2.2, YELLOW);
    }

    // Equipment restraint area: a red line around the aircraft's envelope, with "ERA" at the corners.
    const e = stand.era;
    for (const dx of [0, ...stand.neighbors]) {
        const pts = [{ x: e.x0 + dx, z: e.z1 }, { x: e.x0 + dx, z: e.z0 }, { x: e.x1 + dx, z: e.z0 }, { x: e.x1 + dx, z: e.z1 }];
        line(pts, WHITE, 0.35);
        line(pts, RED, 0.2);
        text('ERA', e.x0 + dx + 1.8, e.z0 + 1.6, 1.0, RED);
        text('ERA', e.x1 + dx - 1.8, e.z0 + 1.6, 1.0, RED);
    }

    // Head-of-stand service road.
    const r = stand.serviceRoad;
    line([{ x: AREA.x0, z: r.z0 }, { x: AREA.x1, z: r.z0 }], WHITE, 0.15);
    line([{ x: AREA.x0, z: r.z1 }, { x: AREA.x1, z: r.z1 }], WHITE, 0.15);
    line([{ x: AREA.x0, z: (r.z0 + r.z1) / 2 }, { x: AREA.x1, z: (r.z0 + r.z1) / 2 }], WHITE, 0.12, [3, 3]);
    for (const dx of [0, ...stand.neighbors]) {
        // "Zipper" crosswalk markings where vehicles must give way to aircraft crossing the road edge.
        for (let x = -4; x <= 4; x += 1) line([{ x: dx + x, z: r.z1 }, { x: dx + x + 0.5, z: r.z1 + 0.9 }], WHITE, 0.15);
    }
    text('SERVICE ROAD', -60, (r.z0 + r.z1) / 2 + 1.5, 1.2, WHITE);
    text('SERVICE ROAD', 70, (r.z0 + r.z1) / 2 - 1.5, 1.2, WHITE, Math.PI);

    // Bridge drive area (hatched white) and the box its wheels park in.
    const p = stand.bridgePark;
    hatch(p.x - 2.6, p.z - 1.8, p.x + 2.6, p.z + 1.8, RED, 0.8);
    text('BRIDGE', p.x, p.z + 2.8, 0.7, WHITE);
    ctx.save(); ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(X(stand.rotunda.x), Z(stand.rotunda.z), 27 * PX, Math.PI * 0.12, Math.PI * 0.42);
    ctx.strokeStyle = WHITE; ctx.lineWidth = 0.15 * PX; ctx.setLineDash([1.2 * PX, 0.8 * PX]); ctx.stroke();
    ctx.restore(); ctx.setLineDash([]);

    // GSE staging boxes and the chock and cone rack, all outside the ERA.
    const box = (x, z, w2, h2, label) => {
        line([{ x: x - w2, z: z - h2 }, { x: x + w2, z: z - h2 }, { x: x + w2, z: z + h2 }, { x: x - w2, z: z + h2 }, { x: x - w2, z: z - h2 }], WHITE, 0.15);
        text(label, x, z, 0.65, WHITE);
    };
    const s = stand.staging;
    box(s.x, s.z, 2.2, 0.9, 'CHOCKS / CONES');
    box(stand.gse.beltLoader.x, stand.gse.beltLoader.z, 4.5, 1.6, 'BELT LOADER');
    box(stand.gse.tug.x, stand.gse.tug.z, 3.5, 1.6, 'TUG');
    box(stand.gse.bagTrain.x, stand.gse.bagTrain.z + 2, 1.6, 9, '');
    text('BAG CARTS', stand.gse.bagTrain.x, stand.gse.bagTrain.z + 2, 0.7, WHITE, Math.PI / 2);

    // Pedestrian walkway from the ramp door to the stand.
    for (let x = -36; x <= -30; x += 1.0) { ctx.fillStyle = WHITE; ctx.fillRect(X(x), Z(r.z0), 0.5 * PX, (r.z1 - r.z0) * PX); }

    // Fuel hydrant pits under the wings: round lids ringed in yellow.
    for (const dx of [-8.5, 8.5]) {
        ctx.beginPath(); ctx.arc(X(dx), Z(13.5), 0.45 * PX, 0, Math.PI * 2); ctx.fillStyle = '#3d3f42'; ctx.fill();
        ctx.lineWidth = 0.12 * PX; ctx.strokeStyle = YELLOW; ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 16;
    return texture;
}

// A ground layer covering a rectangle, with UVs in meters for the tiling textures.
function groundPlane(x0, z0, x1, z1, material, y = 0) {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    g.rotateX(-Math.PI / 2);
    g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
    const uv = g.attributes.uv, pos = g.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i), -pos.getZ(i));
    const mesh = new THREE.Mesh(g, material);
    mesh.receiveShadow = true;
    return mesh;
}

/* The terminal: ramp level with bag-room roll-up doors and the ops door, the glass concourse above
   (where the bridges join), the roof, and the gate number. */
function terminal(stand) {
    const group = new THREE.Group();
    const z = stand.facadeZ, depth = 30, x0 = -110, x1 = 110;
    const lower = new THREE.MeshStandardMaterial({ map: TEX.wall('office'), color: 0xcfc9bd, roughness: 0.9 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x23323f, roughness: 0.08, metalness: 0.6, envMapIntensity: 1 });
    const mullion = new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.5, metalness: 0.6 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x8c9094, roughness: 0.8 });
    const floor = stand.concourseFloor;

    const wallBox = (w, h, d, x, y, zz, material) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
        m.position.set(x, y, zz); m.castShadow = m.receiveShadow = true; group.add(m); return m;
    };
    // Ramp level, set back under the concourse so the glass overhangs it a little.
    wallBox(x1 - x0, floor, depth, 0, floor / 2, z - depth / 2 - 0.8, lower);
    const lowerUv = group.children[0].geometry.attributes.uv;
    for (let i = 0; i < lowerUv.count; i++) lowerUv.setXY(i, lowerUv.getX(i) * (x1 - x0) / 12, lowerUv.getY(i) * floor / 8);
    // Concourse: glass curtain wall with mullions, and a solid band at the floor and roof edges.
    const top = 11;
    wallBox(x1 - x0, top - floor, depth, 0, floor + (top - floor) / 2, z - depth / 2, glass);
    for (let x = x0; x <= x1; x += 1.6) wallBox(0.08, top - floor, 0.25, x, floor + (top - floor) / 2, z + 0.05, mullion);
    for (const y of [floor + 0.05, floor + 3.2, top - 0.3]) wallBox(x1 - x0, y === floor + 3.2 ? 0.08 : 0.6, 0.3, 0, y, z + 0.08, y === floor + 3.2 ? mullion : roofMat);
    wallBox(x1 - x0 + 2, 0.8, depth + 2, 0, top + 0.4, z - depth / 2, roofMat);

    // Bag-room roll-up doors and the ramp ops door.
    const door = new THREE.MeshStandardMaterial({ color: 0x9fa6aa, roughness: 0.6, metalness: 0.4 });
    for (const x of [-46, -8, 30]) {
        wallBox(5.5, 3.6, 0.15, x, 1.8, z + 0.05, door);
        for (let y = 0.3; y < 3.6; y += 0.3) wallBox(5.5, 0.03, 0.18, x, y, z + 0.07, mullion);
    }
    const ops = new THREE.MeshStandardMaterial({ color: 0x3b5f86, roughness: 0.6 });
    wallBox(1.1, 2.2, 0.12, -33, 1.1, z + 0.05, ops);

    // Gate number high on the concourse glass, and on the ramp level wall.
    const sign = (label, w, h, x, y) => {
        const c = document.createElement('canvas'); c.width = 256; c.height = 128;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#1b2733'; ctx.fillRect(0, 0, 256, 128);
        ctx.fillStyle = '#ffd200'; ctx.font = 'bold 92px "Helvetica Neue", Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, 128, 68);
        const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.3 }));
        m.position.set(x, y, z + 0.3); group.add(m);
        return m.material;
    };
    const signs = [];
    for (const dx of [0, ...stand.neighbors]) {
        const name = stand.name.replace(/\d+$/, n => String(+n + Math.sign(dx)));
        signs.push(sign(name, 3.2, 1.6, dx + 7, top - 1.6), sign(name, 1.6, 0.8, dx + 3, 3.0));
    }
    group.userData.signs = signs;
    return group;
}

/* The docking guidance display (VDGS, like Safedock or APIS): on the terminal on the lead-in line's
   extension, showing the type, a closing-rate bar and the distance to go, then STOP. Used at stands
   without a marshaller. */
export class Vdgs {
    constructor(stand) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = 256; this.canvas.height = 320;
        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.colorSpace = THREE.SRGBColorSpace;
        const group = new THREE.Group();
        const housing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.0, 0.5), new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.6 }));
        const face = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.5),
            new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }));
        face.position.z = 0.26;
        group.add(housing, face);
        group.position.set(stand.stop.x, 8.5, stand.facadeZ + 0.6);
        this.group = group;
        this.show({ text: 'B12', mode: 'idle' });
    }

    // mode: idle | tracking (distance meters to go) | stop | ok | slow
    show({ type = '', mode = 'idle', distance = 0, text = '' }) {
        const key = `${type}|${mode}|${Math.round(distance * 2)}|${text}`;
        if (key === this.key) return;
        this.key = key;
        const ctx = this.canvas.getContext('2d');
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 256, 320);
        ctx.textAlign = 'center'; ctx.font = 'bold 44px ui-monospace, Menlo, monospace';
        const amber = '#ffb000', red = '#ff2a1a', green = '#3cff6a';
        if (mode === 'idle') { ctx.fillStyle = amber; ctx.fillText(text, 128, 170); }
        if (mode === 'tracking' || mode === 'slow') {
            ctx.fillStyle = amber; ctx.fillText(type, 128, 54);
            ctx.fillText(mode === 'slow' ? 'SLOW' : `${distance.toFixed(distance < 10 ? 1 : 0)}m`, 128, 300);
            // Closing bar: shrinks as the aircraft nears the stop position.
            const rows = Math.max(0, Math.min(10, Math.ceil(distance / 2)));
            for (let i = 0; i < 10; i++) {
                ctx.fillStyle = i < rows ? amber : '#221800';
                ctx.fillRect(108, 240 - i * 17, 40, 12);
            }
        }
        if (mode === 'stop') { ctx.fillStyle = red; ctx.font = 'bold 64px ui-monospace, Menlo, monospace'; ctx.fillText('STOP', 128, 170); }
        if (mode === 'ok') { ctx.fillStyle = green; ctx.font = 'bold 64px ui-monospace, Menlo, monospace'; ctx.fillText('OK', 128, 170); }
        this.texture.needsUpdate = true;
    }
}

/* Floodlight masts: tall poles with banks of lamps that light the stand from high up at night. */
function floodlightMasts(scene, positions) {
    const group = new THREE.Group();
    const pole = new THREE.MeshStandardMaterial({ color: 0x8f969c, roughness: 0.6, metalness: 0.5 });
    const lamps = [];
    const spots = [];
    for (const [x, z] of positions) {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.45, 28, 10), pole);
        mast.position.set(x, 14, z); mast.castShadow = true;
        const head = new THREE.Mesh(new THREE.BoxGeometry(4, 1.2, 1.2), pole);
        head.position.set(x, 28.2, z);
        group.add(mast, head);
        for (let i = -1.5; i <= 1.5; i += 1) lamps.push({ pos: [x + i, 27.6, z + 0.6], color: [1, 0.93, 0.8], size: 2.5, kind: KIND.airfield });
        const spot = new THREE.SpotLight(0xfff1dc, 0, 140, Math.PI / 3.2, 0.6, 1.2);
        spot.position.set(x, 28, z);
        spot.target.position.set(x * 0.3, 0, 14);
        group.add(spot, spot.target);
        spots.push(spot);
    }
    group.add(makeLights(lamps));
    scene.add(group);
    return spots;
}

export function buildStand(scene, stand = STAND) {
    const group = new THREE.Group();
    // Concrete apron, asphalt taxilane and the grass and pavement beyond.
    const concrete = new THREE.MeshStandardMaterial({ map: TEX.concrete(), color: 0xe2e0db, roughness: 0.92 });
    const asphalt = new THREE.MeshStandardMaterial({ map: TEX.asphalt(), color: 0xd0d0d0, roughness: 0.95 });
    group.add(groundPlane(-400, -60, 400, 64, concrete));
    group.add(groundPlane(-400, 64, 400, 400, asphalt, -0.01));
    // The airfield beyond, out to where haze and fog take over from it.
    group.add(groundPlane(-4000, -4000, 4000, 4000, new THREE.MeshStandardMaterial({ map: TEX.asphalt(), color: 0xa9aaa6, roughness: 0.95 }), -0.05));
    const paint = new THREE.MeshStandardMaterial({ map: markings(stand), transparent: true, roughness: 0.75,
        polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false });
    const marks = groundPlane(AREA.x0, AREA.z0, AREA.x1, AREA.z1, paint, 0.02);
    const uv = marks.geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - AREA.x0) / (AREA.x1 - AREA.x0), 1 - (-uv.getY(i) - AREA.z0) / (AREA.z1 - AREA.z0));
    group.add(marks);
    group.add(terminal(stand));
    const vdgs = new Vdgs(stand);
    group.add(vdgs.group);
    scene.add(group);
    const floodlights = floodlightMasts(scene, [[-40, -11], [40, -11], [-90, -11], [90, -11]]);
    return {
        group, vdgs,
        // Floodlights on with the dark; wet pavement shines.
        setDark(dark, wet) {
            for (const s of floodlights) s.intensity = dark * 40;
            concrete.roughness = asphalt.roughness = wet ? 0.35 : 0.92;
            for (const m of group.children.at(-2).userData.signs || []) m.emissiveIntensity = 0.3 + dark * 1.2;
        }
    };
}
