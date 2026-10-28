const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDsf } = require('./dsf-parser');

// Builds a tiny DSF: one object and one three-sided facade in a pool with lon, lat and heading planes.
function atom(id, ...parts) {
    const body = Buffer.concat(parts);
    const header = Buffer.alloc(8);
    header.write(id.split('').reverse().join(''), 0, 'latin1');
    header.writeUInt32LE(body.length + 8, 4);
    return Buffer.concat([header, body]);
}
const strings = list => Buffer.from(list.map(s => s + '\0').join(''), 'latin1');
const u16 = (...v) => { const b = Buffer.alloc(v.length * 2); v.forEach((x, i) => b.writeUInt16LE(x, i * 2)); return b; };
const u8 = (...v) => Buffer.from(v);

function sampleDsf() {
    const points = [[0, 0, 0], [65535, 0, 32768], [65535, 65535, 0]];
    const planes = [0, 1, 2].map(p => Buffer.concat([u8(0), u16(...points.map(pt => pt[p]))]));
    const poolHead = Buffer.alloc(5); poolHead.writeUInt32LE(3, 0); poolHead.writeUInt8(3, 4);
    const scal = Buffer.alloc(24);
    [[1, -71], [1, 42], [360, 0]].forEach(([s, o], i) => { scal.writeFloatLE(s, i * 8); scal.writeFloatLE(o, i * 8 + 4); });
    const cmds = Buffer.concat([u8(1), u16(0), u8(3, 0), u8(7), u16(1), u8(12), u16(14), u8(3), u16(0, 1, 2), u8(32, 2), Buffer.from('hi')]);
    const body = Buffer.concat([
        atom('HEAD', atom('PROP', strings(['sim/west', '-71', 'sim/south', '42']))),
        atom('DEFN', atom('OBJT', strings(['lib/airport/Ramp_Equipment/Tug660_Dn_1.obj'])),
            atom('POLY', strings(['lib/airport/Modern_Airports/Terminal_kit/term_building_Tall_01.fac']))),
        atom('GEOD', atom('POOL', poolHead, ...planes), atom('SCAL', scal)),
        atom('CMDS', cmds)
    ]);
    const version = Buffer.alloc(4); version.writeUInt32LE(1, 0);
    return Buffer.concat([Buffer.from('XPLNEDSF', 'latin1'), version, body, Buffer.alloc(16)]);
}

test('reads properties, definitions, object placements and facade outlines', () => {
    const tile = parseDsf(sampleDsf());
    assert.equal(tile.properties['sim/west'], '-71');
    assert.equal(tile.objects.length, 1);
    assert.equal(tile.objects[0].def, 'lib/airport/Ramp_Equipment/Tug660_Dn_1.obj');
    assert.ok(Math.abs(tile.objects[0].lon - -70) < 1e-6);
    assert.ok(Math.abs(tile.objects[0].heading - 180) < 0.01);
    assert.equal(tile.polygons.length, 1);
    assert.equal(tile.polygons[0].param, 14);
    assert.deepEqual(tile.polygons[0].windings[0].map(p => [p[0], p[1]]), [[-71, 42], [-70, 42], [-70, 43]]);
});

test('rejects compressed or foreign files', () => {
    assert.throws(() => parseDsf(Buffer.from('7z\xBC\xAF\x27\x1C........')), /Not an uncompressed DSF/);
});
