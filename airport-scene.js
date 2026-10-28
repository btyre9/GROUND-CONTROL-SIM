/* Builds the 3D airport from a parsed apt.dat: water and grass, pavement, runways with FAA markings,
   painted taxiway lines, the control tower and jetways. The ground is flat, so its layers are drawn
   bottom-up in order instead of fighting over depth. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as TEX from './textures.js';
import { makeLights, KIND } from './lights.js';

const { tessellate, makeProjection, FT } = window.AptParser;

// Draw order of the flat ground layers, all negative so everything standing on the ground (order 0) comes after.
// Aerial imagery takes the three orders after water, coarsest first.
export const LAYER = { water: -1010, imagery: -1009, grass: -1000, pavement: -990, runway: -600, runwayPaint: -590, lineBorder: -580, line: -570, shadow: -500 };

const COLORS = {
    water: 0x2f5d78, grass: 0x5d7a45, asphalt: 0x4a4d50, concrete: 0x8f8f89, runway: 0x3b3d40, turf: 0x5d7a45,
    dirt: 0x8a7350, gravel: 0x8c8780, white: 0xf2f2ee, yellow: 0xe8b923, black: 0x1a1a1a, red: 0xc2362e
};

function groundMaterial(color, opacity = 1) {
    return new THREE.MeshLambertMaterial({ color, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
        transparent: opacity < 1, opacity });
}

function groundMesh(geometry, color, order, opacity = 1) {
    const mesh = new THREE.Mesh(geometry, color instanceof THREE.Material ? color : groundMaterial(color, opacity));
    mesh.renderOrder = order;
    mesh.matrixAutoUpdate = false;
    return mesh;
}

// Asphalt and concrete get textures (UVs are in meters); other surfaces stay plain colors.
const pavementMaterials = new Map();
function pavementMaterial(surface) {
    const concrete = surface === 2 || surface >= 50 && surface <= 57;
    const asphalt = surface === 1 || surface >= 20 && surface <= 38;
    const key = concrete ? 'concrete' : asphalt ? 'asphalt' : surface;
    if (!pavementMaterials.has(key)) {
        const material = groundMaterial(concrete || asphalt ? 0xffffff : surfaceColor(surface));
        if (concrete) material.map = TEX.concrete();
        if (asphalt) material.map = TEX.asphalt();
        if (concrete || asphalt) {
            material.userData.glow = 'apron';         // Floodlit at night: the pavement itself shows, warmly lit.
            material.userData.wet = true;
            material.emissiveMap = material.map;
        }
        pavementMaterials.set(key, material);
    }
    return pavementMaterials.get(key);
}

function surfaceColor(surface) {
    if (surface === 2 || surface >= 50 && surface <= 57) return COLORS.concrete;
    if (surface === 3) return COLORS.turf;
    if (surface === 4 || surface === 12) return COLORS.dirt;
    if (surface === 5) return COLORS.gravel;
    if (surface === 13) return COLORS.water;
    return COLORS.asphalt;
}

// Flat triangles from outer rings and holes given as local {x, z} points.
function polygonGeometry(outer, holes = []) {
    const shape = new THREE.Shape(outer.map(p => new THREE.Vector2(p.x, -p.z)));
    for (const hole of holes) shape.holes.push(new THREE.Path(hole.map(p => new THREE.Vector2(p.x, -p.z))));
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
}

/* Collects flat strips of paint (lines, dashes, bars) of one color into a single geometry. */
class PaintBucket {
    constructor() { this.positions = []; }
    quad(a, b, c, d) {      // Corners in order around the quad, each {x, z}.
        for (const p of [a, b, c, a, c, d]) this.positions.push(p.x, 0, p.z);
    }
    // A strip along a to b, shifted sideways by offset (positive is to the left of travel).
    strip(a, b, offset, width) {
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 1e-6) return;
        const nx = (b.z - a.z) / len, nz = -(b.x - a.x) / len;     // Left of travel when north is -z.
        const lo = offset - width / 2, hi = offset + width / 2;
        this.quad({ x: a.x + nx * lo, z: a.z + nz * lo }, { x: b.x + nx * lo, z: b.z + nz * lo },
            { x: b.x + nx * hi, z: b.z + nz * hi }, { x: a.x + nx * hi, z: a.z + nz * hi });
    }
    // A solid or dashed line along a polyline; dashes keep their rhythm around corners.
    polyline(points, offset, width, dash = 0, gap = 0) {
        let phase = 0;
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1];
            const len = Math.hypot(b.x - a.x, b.z - a.z);
            if (!dash) { this.strip(a, b, offset, width); continue; }
            let s = 0;
            while (s < len) {
                const period = dash + gap, inPeriod = phase % period;
                const on = inPeriod < dash;
                // At least a tenth of a millimeter, so rounding can never stall the walk along the line.
                const run = Math.max(1e-4, Math.min(len - s, on ? dash - inPeriod : period - inPeriod));
                if (on) {
                    const f0 = s / len, f1 = (s + run) / len;
                    this.strip({ x: a.x + (b.x - a.x) * f0, z: a.z + (b.z - a.z) * f0 },
                        { x: a.x + (b.x - a.x) * f1, z: a.z + (b.z - a.z) * f1 }, offset, width);
                }
                s += run; phase += run;
            }
        }
    }
    mesh(color, order) {
        if (!this.positions.length) return null;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(
            Array.from({ length: this.positions.length / 3 }, () => [0, 1, 0]).flat(), 3));
        return groundMesh(geometry, color, order);
    }
}

/* FAA pavement markings by apt.dat line type: stripes of [offset, width, dash, gap] in meters, and color.
   Codes 51 and up are the same lines with a black border (code minus 50). Codes 10-31 came with X-Plane
   11.30 and are not in the published spec, so they are drawn as the closest yellow, white or red line. */
const LINE_STYLES = {
    1: { color: 'yellow', stripes: [[0, 0.3]] },                                    // Taxiway centerline
    2: { color: 'yellow', stripes: [[0, 0.3, 3, 3]] },                              // Broken centerline
    3: { color: 'yellow', stripes: [[0.25, 0.2], [-0.25, 0.2]] },                    // Taxiway edge
    4: { color: 'yellow', stripes: [[0.75, 0.2], [0.35, 0.2], [-0.35, 0.2, 0.9, 0.9], [-0.75, 0.2, 0.9, 0.9]] },  // Runway hold
    5: { color: 'yellow', stripes: [[0.25, 0.2], [-0.25, 0.2, 0.9, 0.9]] },          // Other hold
    6: { color: 'yellow', stripes: [[0.6, 0.2], [-0.6, 0.2], [0, 1.2, 0.3, 1.5]] },  // ILS hold (ladder)
    7: { color: 'yellow', stripes: [[0, 0.2], [0.45, 0.2, 0.9, 0.9], [-0.45, 0.2, 0.9, 0.9]] },  // Centerline in runway safety area
    8: { color: 'yellow', stripes: [[0, 0.3, 3, 9]] },                              // Queuing lane
    9: { color: 'yellow', stripes: [[0.25, 0.2, 3, 9], [-0.25, 0.2, 3, 9]] },
    10: { color: 'yellow', stripes: [[0, 0.45]] },
    11: { color: 'yellow', stripes: [[0, 0.45, 3, 3]] },
    12: { color: 'yellow', stripes: [[0.3, 0.3], [-0.3, 0.3]] },
    13: { color: 'yellow', stripes: [[0, 0.3], [0.45, 0.15, 0.9, 0.9], [-0.45, 0.15, 0.9, 0.9]] },
    20: { color: 'white', stripes: [[0, 0.3]] },
    21: { color: 'white', stripes: [[0, 0.6, 0.6, 0.6]] },                           // Checkerboard
    22: { color: 'white', stripes: [[0, 0.3, 3, 3]] },
    23: { color: 'white', stripes: [[0.25, 0.2], [-0.25, 0.2]] },
    24: { color: 'white', stripes: [[0, 0.45]] },
    25: { color: 'white', stripes: [[0, 0.45, 3, 3]] },
    30: { color: 'red', stripes: [[0, 0.3]] },
    31: { color: 'red', stripes: [[0, 0.3, 3, 3]] }
};

function lineStyle(type) {
    const bordered = type > 50 && type < 100;
    const base = bordered ? type - 50 : type;
    const style = LINE_STYLES[base] || (base < 20 ? LINE_STYLES[1] : base < 30 ? LINE_STYLES[20] : base < 40 ? LINE_STYLES[30] : null);
    return style && { ...style, bordered };
}

function addPaintedLines(points, buckets) {
    // Split the outline into runs that share one painted line type.
    let run = [];
    const flush = type => {
        const style = type && lineStyle(type);
        if (style && run.length > 1) {
            if (style.bordered) {
                const span = Math.max(...style.stripes.map(([o, w]) => Math.abs(o) + w / 2));
                buckets.black.polyline(run, 0, span * 2 + 0.3);
            }
            for (const [offset, width, dash, gap] of style.stripes) buckets[style.color].polyline(run, offset, width, dash, gap);
        }
        run = [];
    };
    let type = 0;
    for (const p of points) {
        if (p.line !== type) { if (run.length) { run.push(p); flush(type); } type = p.line; }
        run.push(p);
    }
    flush(type);
}

/* Runway paint following FAA AC 150/5340-1: threshold bars, designation, centerline, aiming point,
   touchdown zone and side stripes. */
function addRunway(runway, project, group, paint) {
    const [e1, e2] = runway.ends;
    const a = project(e1), b = project(e2);
    const length = Math.hypot(b.x - a.x, b.z - a.z), W = runway.widthM;
    const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length;

    const along = (from, dir, t, side) => ({ x: from.x + dir.x * t - dir.z * side, z: from.z + dir.z * t + dir.x * side });
    const box = (from, dir, t0, t1, side, width) =>
        paint.strip(along(from, dir, t0, side), along(from, dir, t1, side), 0, width);

    const forward = { x: ux, z: uz }, backward = { x: -ux, z: -uz };
    const over1 = e1.overrunM || 0, over2 = e2.overrunM || 0;
    const surface = polygonGeometry([along(a, forward, -over1, -W / 2), along(a, forward, length + over2, -W / 2),
        along(a, forward, length + over2, W / 2), along(a, forward, -over1, W / 2)]);
    const runwayMaterial = groundMaterial(0xffffff);
    runwayMaterial.map = TEX.asphalt(true);
    runwayMaterial.userData.wet = true;
    group.add(groundMesh(surface, runwayMaterial, LAYER.runway));

    const precision = Math.max(e1.markings, e2.markings) >= 3;
    const t1 = e1.displacedM || 0, t2 = length - (e2.displacedM || 0);
    // Side stripes and the centerline between the two designations.
    if (precision) for (const side of [-1, 1]) box(a, forward, t1, t2, side * (W / 2 - 1.2), 0.9);
    const clStart = t1 + 130, clEnd = t2 - 130;
    for (let t = clStart; t + 36.6 <= clEnd; t += 36.6 + 24.4) box(a, forward, t, t + 36.6, 0, precision ? 0.9 : 0.45);

    [[e1, a, forward, e1.displacedM || 0], [e2, b, backward, e2.displacedM || 0]].forEach(([end, origin, dir, displaced]) => {
        if (end.markings < 1) return;
        // Threshold bars: 150 ft long, 5.75 ft wide, count by runway width.
        if (end.markings >= 2) {
            const bars = W >= 60 ? 16 : W >= 45 ? 12 : W >= 30 ? 8 : W >= 23 ? 6 : 4;
            for (let k = 0; k < bars / 2; k++) {
                const side = W / 2 - 1.5 - 0.875 - k * 3.5;
                box(origin, dir, displaced + 6, displaced + 6 + 45.7, side, 1.75);
                box(origin, dir, displaced + 6, displaced + 6 + 45.7, -side, 1.75);
            }
        }
        if (displaced > 0) box(origin, dir, displaced - 1.5, displaced, 0, W - 1);    // Displaced threshold bar.
        group.add(designation(end.name, origin, dir, displaced + 6 + 45.7 + 6));
        if (end.markings >= 2 && length > 1280) for (const side of [-1, 1])
            box(origin, dir, displaced + 311, displaced + 311 + 45.7, side * 15.5, 9.1);
        if (end.markings >= 3) {
            // Touchdown zone: 3, 2, 2, 1, 1 stripes at 500 ft intervals around the aiming point.
            for (const [ft, count] of [[500, 3], [1500, 2], [2000, 2], [2500, 1], [3000, 1]]) {
                const t = displaced + ft * FT;
                if (t + 23 > length / 2) continue;
                for (let k = 0; k < count; k++) for (const side of [-1, 1])
                    box(origin, dir, t, t + 22.9, side * (11 + 0.9 + k * 3.35), 1.8);
            }
        }
    });
    return { name: `${e1.name}/${e2.name}`, a, b, length, heading: (Math.atan2(ux, -uz) * 180 / Math.PI + 360) % 360 };
}

// Runway number and letter (FAA drops the leading zero), letter nearest the threshold.
function designation(name, origin, dir, start) {
    const number = String(parseInt(name, 10)), letter = name.replace(/^\d+/, '');
    const group = new THREE.Group();
    const parts = letter ? [[letter, start], [number, start + 18.3 + 6]] : [[number, start]];
    for (const [text, t] of parts) {
        const canvas = document.createElement('canvas');
        canvas.width = 128 * text.length; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 250px "DIN Alternate", "Arial Narrow", Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const measured = ctx.measureText(text).width;
        ctx.setTransform(Math.min(1, canvas.width * 0.92 / measured), 0, 0, 1, canvas.width / 2, canvas.height / 2 + 10);
        ctx.fillText(text, 0, 0);
        const texture = new THREE.CanvasTexture(canvas);
        texture.anisotropy = 8;
        const width = 6 * text.length, height = 18.3;
        const plane = new THREE.PlaneGeometry(width, height);
        plane.rotateX(-Math.PI / 2);            // Lying flat; the text's top now points north (-z).
        // Transparent things draw after everything solid, so this one tests depth to stay under aircraft.
        const mesh = new THREE.Mesh(plane, new THREE.MeshLambertMaterial({ map: texture, transparent: true, depthWrite: false }));
        mesh.renderOrder = LAYER.runwayPaint + 1;
        // Point the top of the text along the runway, away from the threshold.
        mesh.rotation.y = Math.atan2(-dir.x, -dir.z);
        const mid = t + height / 2;
        mesh.position.set(origin.x + dir.x * mid, 0, origin.z + dir.z * mid);
        group.add(mesh);
    }
    return group;
}

function addTower(tower, project, group) {
    const p = project(tower);
    const cabFloor = tower.heightFt * FT - 3;
    const concrete = new THREE.MeshStandardMaterial({ color: 0xc9c4b8, roughness: 0.9 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1d2a33, roughness: 0.15, metalness: 0.6 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 5, cabFloor - 4, 16), concrete);
    shaft.position.set(p.x, (cabFloor - 4) / 2, p.z);
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(9, 7, 4, 8), concrete);
    deck.position.set(p.x, cabFloor - 2, p.z);
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(9.5, 8.5, 6, 8), glass);
    cab.position.set(p.x, cabFloor + 3, p.z);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(7, 10, 1.5, 8), concrete);
    roof.position.set(p.x, cabFloor + 6.75, p.z);
    const building = new THREE.Group();
    building.add(shaft, deck, cab, roof);
    group.add(building);
    return { x: p.x, y: tower.heightFt * FT, z: p.z, building };
}

/* Jetways from their rotunda: the tunnel in its parked heading, then the cab that meets the door. */
function addJetways(jetways, project, group) {
    const material = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.7, metalness: 0.2 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.8 });
    const parts = [], darkParts = [];
    for (const jw of jetways) {
        const p = project(jw);
        const h = 4.2 + jw.size * 0.6;                            // Sill height grows with aircraft size.
        const rotunda = new THREE.CylinderGeometry(2.2, 2.2, h + 1.5, 12);
        rotunda.translate(p.x, (h + 1.5) / 2, p.z);
        parts.push(rotunda);
        const dirT = THREE.MathUtils.degToRad(jw.heading);
        const dx = Math.sin(dirT), dz = -Math.cos(dirT);
        const tunnel = new THREE.BoxGeometry(2.6, 2.8, jw.lengthM);
        tunnel.rotateY(-dirT);
        tunnel.translate(p.x + dx * jw.lengthM / 2, h + 1.4, p.z + dz * jw.lengthM / 2);
        parts.push(tunnel);
        const end = { x: p.x + dx * jw.lengthM, z: p.z + dz * jw.lengthM };
        const cab = new THREE.BoxGeometry(3.6, 3.2, 3.2);
        cab.rotateY(-THREE.MathUtils.degToRad(jw.cabHeading));
        cab.translate(end.x, h + 1.6, end.z);
        parts.push(cab);
        const leg = new THREE.BoxGeometry(0.5, h, 0.5);
        leg.translate(end.x - dx * 3, h / 2, end.z - dz * 3);
        darkParts.push(leg);
    }
    if (!parts.length) return;
    const mesh = new THREE.Mesh(mergeGeometries(parts), material);
    const legs = new THREE.Mesh(mergeGeometries(darkParts), dark);
    mesh.castShadow = legs.castShadow = true;
    group.add(mesh, legs);
}

/* Airfield lights from apt.dat light codes along pavement edges and lines, plus runway lights:
   [color, spacing in meters] by code. */
const AIRFIELD_LIGHTS = {
    101: [[0.15, 1, 0.35], 15], 102: [[0.25, 0.45, 1], 30], 103: [[1, 0.7, 0.1], 1.5], 104: [[1, 0.7, 0.1], 1.5],
    105: [[0.6, 0.9, 0.2], 15], 106: [[1, 0.12, 0.1], 30], 107: [[0.15, 1, 0.35], 15], 108: [[0.6, 0.9, 0.2], 15]
};

function airfieldLights(airport, ringPoints, runways) {
    const lights = [];
    const add = (x, z, color, size = 0.9) => lights.push({ pos: [x, 0.35, z], color, size, kind: KIND.airfield });
    const along = (points, code) => {
        const [color, spacing] = AIRFIELD_LIGHTS[code];
        let next = 0, walked = 0;
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1], len = Math.hypot(b.x - a.x, b.z - a.z);
            while (next <= walked + len) {
                const f = (next - walked) / (len || 1);
                add(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f, color);
                next += spacing;
            }
            walked += len;
        }
    };
    for (const shape of [...airport.pavements, ...airport.lines]) for (const ring of shape.rings) {
        const points = tessellate(ring).map(p => ({ ...ringPoints(p), light: p.light }));
        if (ring.closed && points.length) points.push({ ...points[0], light: 0 });
        let run = [], code = 0;
        for (const p of points) {
            if (p.light !== code) { if (run.length) { run.push(p); if (AIRFIELD_LIGHTS[code]) along(run, code); } run = []; code = p.light; }
            run.push(p);
        }
        if (AIRFIELD_LIGHTS[code] && run.length > 1) along(run, code);
    }
    airport.runways.forEach((runway, i) => {
        const { a, b, length } = runways[i];
        const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length, half = runway.widthM / 2 + 1.5;
        const at = (t, side) => [a.x + ux * t - uz * side, a.z + uz * t + ux * side];
        if (runway.edgeLights) for (let t = 0; t <= length; t += 60) for (const side of [-half, half]) add(...at(t, side), [1, 0.93, 0.78], 1.3);
        if (runway.centerLights) for (let t = 15; t < length; t += 15) add(...at(t, 0), length - t < 300 || t < 300 ? [1, 0.2, 0.15] : [1, 0.95, 0.85], 0.9);
        // Green threshold bars face arriving aircraft; red end lights mark the far end.
        const [t1, t2] = [runway.ends[0].displacedM || 0, length - (runway.ends[1].displacedM || 0)];
        for (let k = -4; k <= 4; k++) {
            const side = k * runway.widthM / 9;
            add(...at(t1, side), [0.15, 1, 0.35], 1.3); add(...at(t2, side), [0.15, 1, 0.35], 1.3);
            add(...at(0, side), [1, 0.12, 0.1], 1.1); add(...at(length, side), [1, 0.12, 0.1], 1.1);
        }
    });
    return lights.length ? makeLights(lights) : null;
}

export function buildAirport(airport) {
    const projection = makeProjection(airport.origin);
    const project = p => projection.toLocal(p.lat, p.lon);
    const group = new THREE.Group();

    const water = new THREE.PlaneGeometry(60000, 60000);
    water.rotateX(-Math.PI / 2);
    group.add(groundMesh(water, COLORS.water, LAYER.water));

    const ringPoints = ring => tessellate(ring).map(p => ({ ...project(p), line: p.line }));
    // Painted lines also run along the closing side of a closed outline.
    const paintPoints = (ring, points) => ring.closed && points.length ? [...points, { ...points[0], line: 0 }] : points;
    const grass = [];
    for (const area of airport.boundary) {
        const rings = area.rings.map(ringPoints);
        if (rings[0]?.length > 2) grass.push(polygonGeometry(rings[0], rings.slice(1)));
    }
    if (!grass.length) {        // No boundary: a grass field around the runways.
        const pts = airport.runways.flatMap(r => r.ends.map(project));
        const xs = pts.map(p => p.x), zs = pts.map(p => p.z), m = 600;
        grass.push(polygonGeometry([{ x: Math.min(...xs) - m, z: Math.min(...zs) - m }, { x: Math.max(...xs) + m, z: Math.min(...zs) - m },
            { x: Math.max(...xs) + m, z: Math.max(...zs) + m }, { x: Math.min(...xs) - m, z: Math.max(...zs) + m }]));
    }
    // Hidden while aerial imagery shows the real ground; shown again if the imagery can't load.
    const grassMesh = groundMesh(mergeGeometries(grass), COLORS.grass, LAYER.grass);
    group.add(grassMesh);

    const buckets = { yellow: new PaintBucket(), white: new PaintBucket(), red: new PaintBucket(), black: new PaintBucket() };
    airport.pavements.forEach((pavement, i) => {
        const rings = pavement.rings.map(ringPoints);
        if (pavement.surface !== 15 && rings[0]?.length > 2) {
            group.add(groundMesh(polygonGeometry(rings[0], rings.slice(1)), pavementMaterial(pavement.surface), LAYER.pavement + i % 380));
        }
        rings.forEach((points, r) => addPaintedLines(paintPoints(pavement.rings[r], points), buckets));
    });
    for (const line of airport.lines) for (const ring of line.rings) addPaintedLines(paintPoints(ring, ringPoints(ring)), buckets);

    const runwayPaint = new PaintBucket();
    const runways = airport.runways.map(r => addRunway(r, project, group, runwayPaint));
    for (const [bucket, color, order] of [[runwayPaint, COLORS.white, LAYER.runwayPaint], [buckets.black, COLORS.black, LAYER.lineBorder],
        [buckets.yellow, COLORS.yellow, LAYER.line], [buckets.white, COLORS.white, LAYER.line], [buckets.red, COLORS.red, LAYER.line]]) {
        const mesh = bucket.mesh(color, order);
        if (mesh) group.add(mesh);
    }

    const lights = airfieldLights(airport, project, runways);
    if (lights) group.add(lights);

    const tower = airport.tower ? addTower(airport.tower, project, group) : null;
    addJetways(airport.jetways, project, group);
    return { group, projection, project, runways, tower, grass: grassMesh };
}

/* ---------- Buildings and ramp equipment from the pack's DSF tiles ---------- */

// Facade outlines by the library art they name; param is the height in meters. wall picks the texture.
const FACADES = [
    [/fenc|Fence|Wall-|pier|embankment/i, null],            // Fences and piers are skipped for now.
    [/term_roof/, { wall: 'glass', minHeight: 1 }],
    [/term_bridge/, { wall: 'glass', minHeight: 8 }],
    [/Terminal_kit|Modern_Airports\/Facades\/modern/, { wall: 'glass', minHeight: 9 }],
    [/Blue_Hangar/, { wall: 'hangar', tint: 0x7d9bbd, minHeight: 12 }],
    [/Hangar/i, { wall: 'hangar', minHeight: 12 }],
    [/Garage|parking/i, { wall: 'garage', minHeight: 10 }],
    [/warehouse|industrial/i, { wall: 'hangar', tint: 0xd8cdb8, minHeight: 10 }],
    [/\.fac$/, { wall: 'office', minHeight: 10 }]
];

// An extruded outline's roof (its caps) and walls (its sides) as two geometries, for two materials.
function splitExtrusion(geometry) {
    return geometry.groups.map(({ start, count }) => {
        const part = new THREE.BufferGeometry();
        for (const name of ['position', 'normal', 'uv']) {
            const attr = geometry.attributes[name];
            part.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(start * attr.itemSize, (start + count) * attr.itemSize), attr.itemSize));
        }
        return part;
    });
}

const FLOODLIGHT = /HighMast|AreaFlood|ParkingLot_|Omni_Parking|PrimaryLight|HighwayRampLight/;

// Ramp equipment and lighting as simple boxes: [pattern, width, length, height, color].
const OBJECT_BOXES = [
    [/Luggage_Cart/, 1.4, 2.6, 1.3, 0x7d858c], [/Cargo_Container|LD3|ULD/i, 1.6, 1.6, 1.6, 0xb8bec4],
    [/Cargo_Dolly/, 1.7, 3.0, 0.6, 0x5a6066], [/Tow_Tractor|Baggage_Tractor/i, 1.5, 2.8, 1.6, 0xe0b000],
    [/Tug|Pushback/i, 2.6, 5.5, 1.8, 0xe8c010], [/Fuel_Truck|Fuel/i, 2.5, 9, 3.0, 0xf0f0ec],
    [/Catering/i, 2.5, 7, 3.6, 0xf0f0ec], [/Belt_Loader/i, 1.8, 7, 1.6, 0xe8c010], [/GPU/i, 1.4, 2.2, 1.4, 0xe8c010],
    [/Bus/i, 2.6, 12, 3.2, 0xdcdcdc], [/Stair/i, 2, 6, 3, 0xe0e0e0],
    [/HighMast/, 0.7, 0.7, 25, 0x8a8f94], [/AreaFlood|ParkingLot_|Omni_Parking|PrimaryLight|HighwayRampLight/, 0.35, 0.35, 10, 0x8a8f94]
];

export function buildStructures(tiles, project) {
    const group = new THREE.Group();
    const byColor = new Map();
    const add = (color, geometry) => { if (!byColor.has(color)) byColor.set(color, []); byColor.get(color).push(geometry); };

    const walls = new Map(), roofs = [], lamps = [];
    for (const tile of tiles) {
        for (const polygon of tile.polygons) {
            if (!/\.fac$/.test(polygon.def || '')) continue;
            const style = FACADES.find(([pattern]) => pattern.test(polygon.def))?.[1];
            if (!style) continue;
            const rings = polygon.windings.map(w => w.map(p => project({ lon: p[0], lat: p[1] }))).filter(r => r.length > 2);
            if (!rings.length) continue;
            const height = Math.max(polygon.param || 0, style.minHeight);
            const shape = new THREE.Shape(rings[0].map(p => new THREE.Vector2(p.x, -p.z)));
            for (const hole of rings.slice(1)) shape.holes.push(new THREE.Path(hole.map(p => new THREE.Vector2(p.x, -p.z))));
            const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
            geometry.rotateX(-Math.PI / 2);         // Extrusion depth becomes height above the ground.
            const [roof, wall] = splitExtrusion(geometry);
            roofs.push(roof);
            const key = `${style.wall}-${style.tint || 0xffffff}`;
            if (!walls.has(key)) walls.set(key, { style, parts: [] });
            walls.get(key).parts.push(wall);
        }
        for (const object of tile.objects) {
            if (FLOODLIGHT.test(object.def || '')) {
                const p = project(object), high = /HighMast/.test(object.def);
                lamps.push({ pos: [p.x, high ? 25 : 10, p.z], color: [1, 0.85, 0.6], size: high ? 3 : 1.6, kind: KIND.airfield });
            }
            const box = OBJECT_BOXES.find(([pattern]) => pattern.test(object.def || ''));
            if (!box) continue;
            const [, width, length, height, color] = box;
            const p = project(object);
            const geometry = new THREE.BoxGeometry(width, height, length);
            geometry.rotateY(-THREE.MathUtils.degToRad(object.heading));
            geometry.translate(p.x, height / 2, p.z);
            add(color, geometry);
        }
    }
    const material = (map, color = 0xffffff) => new THREE.MeshStandardMaterial({ map, color, roughness: 0.85, metalness: 0.05 });
    const meshes = [...walls.values()].map(({ style, parts }) => {
        const mesh = new THREE.Mesh(mergeGeometries(parts), material(TEX.wall(style.wall), style.tint));
        if (style.wall === 'glass' || style.wall === 'office') {
            mesh.material.userData.glow = 'windows';
            mesh.material.emissiveMap = TEX.wallGlow(style.wall);
        }
        return mesh;
    });
    if (roofs.length) meshes.push(new THREE.Mesh(mergeGeometries(roofs), material(TEX.roof())));
    for (const mesh of meshes) { mesh.matrixAutoUpdate = false; mesh.castShadow = true; group.add(mesh); }
    if (lamps.length) group.add(makeLights(lamps));
    for (const [color, geometries] of byColor) {
        const mesh = new THREE.Mesh(mergeGeometries(geometries.map(g => g.index ? g.toNonIndexed() : g)),
            new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05 }));
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
    }
    return group;
}

/* Lighting for the time of day: dark is 0 by day and 1 at night. Floodlit aprons and lit terminal
   windows glow. */
export function setDarkness(group, dark) {
    group.traverse(o => {
        const glow = o.material?.userData?.glow;
        if (glow === 'apron') o.material.emissive.setRGB(0.5, 0.42, 0.3).multiplyScalar(dark);
        if (glow === 'windows') o.material.emissive.setScalar(0.9 * dark);
    });
}

// Wet pavement after rain looks darker.
export function setWet(group, wet) {
    group.traverse(o => { if (o.material?.userData?.wet) o.material.color.setScalar(wet ? 0.72 : 1); });
}
