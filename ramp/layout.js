/* Where everything stands on the ramp, in meters. x is east, z south, y up; the aircraft parks nose
   north (toward -z) with its nose gear stopped on the stop bar at the origin.

   Aircraft points are measured from the 3D models (tools/xplane_obj_to_glb.py output), in the model's
   own frame: x right, y up, nose toward -z, origin on the ground between the main gear. */

export const AIRCRAFT = {
    // 737 family: the nose is 4.15 m ahead of the nose gear and the L1 door 0.84 m behind it on every
    // variant, so one stop bar serves all three.
    B737: { name: '737-700', wheelbase: 12.53, noseAhead: 4.15, length: 34.0, span: 36.4 },
    B738: { name: '737-800', wheelbase: 15.39, noseAhead: 4.15, length: 39.7, span: 36.4 },
    B739: { name: '737-900ER', wheelbase: 17.07, noseAhead: 4.15, length: 42.4, span: 36.4 }
};

/* Points on a 737, measured back from the nose gear (+ aft) or the main gear, sides x (+ right). Door
   sills come from the door model's extras (B739-doors.glb). The models stand on fully extended gear, so
   doors are about 0.5 m higher than on a real 737 at the gate; the bridge and loader go to the model's. */
export const B737_POINTS = {
    doorL1: { x: -1.9, y: 3.24, fromNoseGear: 0.84 },          // Cabin floor at the door sill.
    fwdCargo: { x: 1.7, y: 1.85, fromNoseGear: 4.58 },         // Forward hold door, right side.
    aftCargo: { x: 1.7, y: 1.93, fromMainGear: 9.55 },          // Aft hold door, right side.
    groundPower: { x: 0.75, y: 1.6, fromNoseGear: 1.1 },       // External power receptacle, right of the nose gear.
    pcaPort: { x: -0.55, y: 1.62, fromMainGear: -7.4 },       // Preconditioned air connector on the belly.
    interphone: { x: 0.35, y: 0.95, fromNoseGear: 0.4 },       // Headset jack at the nose gear.
    engines: [{ x: -4.95, y: 1.6, inlet: -6.6 }, { x: 4.95, y: 1.6, inlet: -6.6 }],   // inlet z from the main gear
    wingtipFromMainGear: 3.6
};

/* A point on the parked aircraft in stand coordinates, given where its nose gear is and its heading
   (0 = nose north). */
export function aircraftPoint(type, nose, headingDeg, point) {
    const a = AIRCRAFT[type] || AIRCRAFT.B739;
    const back = point.fromNoseGear ?? (a.wheelbase + (point.fromMainGear ?? 0));
    const h = headingDeg * Math.PI / 180;
    // Forward is (sin h, -cos h); right is (cos h, sin h).
    return { x: nose.x - Math.sin(h) * back + Math.cos(h) * point.x, y: point.y, z: nose.z + Math.cos(h) * back + Math.sin(h) * point.x };
}

export const STAND = {
    name: 'B12',
    stop: { x: 0, z: 0 },               // Nose gear on the 737 stop bar.
    facadeZ: -20,                        // Terminal wall.
    concourseFloor: 4.4,                 // Upper (departure) level, where the bridge joins.
    serviceRoad: { z0: -15, z1: -8.5 },  // Head-of-stand road, passing under the bridge.
    rotunda: { x: -20, z: -16.5 },
    // Equipment restraint area: nothing parks inside while an aircraft moves in or out.
    era: { x0: -21.5, x1: 21.5, z0: -6.5, z1: 44 },
    // Lead-in line: along the taxilane, a turn, then straight north to the stop bar.
    taxilaneZ: 70, turnRadius: 32,
    marshaller: { x: 0, z: -6.5 },
    wingwalkerL: { x: -23, z: 26 },
    wingwalkerR: { x: 23, z: 26 },
    staging: { x: 12, z: -7 },           // Chocks and cones, outside the ERA.
    gse: { beltLoader: { x: 28, z: -2, heading: 270 }, tug: { x: -32, z: -4, heading: 90 }, bagTrain: { x: 34, z: 12, heading: 180 } },
    bridgePark: { x: -14.7, z: -3.2 },   // Where the drive wheels sit when the bridge is stowed.
    neighbors: [-50, 50]                 // Lead-in lines of the gates either side.
};

/* The lead-in line as a path for the nose gear, from far out on the taxilane (coming from the east) to
   past the stop bar: points every meter, with the distance to go to the stop bar. */
export function leadIn(stand = STAND) {
    const pts = [], r = stand.turnRadius, zt = stand.taxilaneZ, x0 = stand.stop.x;
    const push = (x, z) => pts.push({ x, z });
    for (let x = x0 + r + 130; x > x0 + r; x -= 1) push(x, zt);
    const cx = x0 + r, cz = zt - r;               // Turn center: from heading west to heading north.
    for (let a = 0; a <= 90; a += 2) {
        const t = a * Math.PI / 180;
        push(cx - Math.sin(t) * r, cz + Math.cos(t) * r);
    }
    for (let z = cz - 1; z >= stand.stop.z - 8; z -= 1) push(x0, z);
    let d = 0;
    for (let i = pts.length - 1; i >= 0; i--) {
        if (i < pts.length - 1) d += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
        pts[i].fromEnd = d;
    }
    const overrun = 8;
    for (const p of pts) p.toStop = p.fromEnd - overrun;
    return pts;
}

// The point on a path at a distance to go to the stop bar (negative is past it).
export function pathAt(path, toStop) {
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        if (b.toStop <= toStop) {
            const k = (a.toStop - toStop) / ((a.toStop - b.toStop) || 1);
            return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
        }
    }
    return { ...path[path.length - 1] };
}
