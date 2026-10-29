/* An apron-drive passenger boarding bridge with the ground support equipment that lives on it.

   The bridge, from the terminal out:
   - fixed link from the concourse to the rotunda, which stands on its own column and turns
   - three telescoping tunnels (steel sides, a window band), sloping from the concourse floor down to
     the cab; the outer tunnel rides on the drive column
   - drive column: two telescoping lift legs on a cross beam, height restrictor bars, and the bogie with
     its two drive wheels, which steer
   - cab: turns to meet the aircraft; bumper, canopy (the accordion hood that closes over the door),
     auto-leveler wheel arm, floodlights, camera, warning beacon, service stairs down to the ramp

   Equipment slung under it (point-of-use, as most US airports now require):
   - preconditioned air (PCA) unit under the outer tunnel, its 14-inch yellow flex hose stowed in a basket
   - 400 Hz ground power converter with a powered cable hoist under the cab
   - potable water cabinet with a hose reel on the drive column
   - cable carrier (festoon) along the tunnels for power and control cables

   Hoses and cables are drawn as tubes along a sagging curve between their end points, so they can be
   run out to the aircraft's connectors. */
import * as THREE from 'three';
import { makeLights, lightMaterial, KIND } from '../lights.js';

const mat = (color, roughness = 0.6, metalness = 0.2, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
const M = {
    steel: mat(0xd8dadc, 0.55, 0.35), steelDark: mat(0x6e757b, 0.6, 0.5), glass: mat(0x1b2731, 0.1, 0.7),
    rubber: mat(0x141414, 0.9, 0), canopy: mat(0x2c2c2c, 0.85, 0), yellow: mat(0xe8b400, 0.55, 0.1),
    pca: mat(0xe9ebec, 0.5, 0.2), gpu: mat(0x50585f, 0.55, 0.4), water: mat(0x2a63a8, 0.5, 0.2),
    hose: mat(0xf1c21b, 0.7, 0), cable: mat(0x18181a, 0.6, 0), blueHose: mat(0x1f58b8, 0.6, 0), tire: mat(0x1d1d1d, 0.95, 0),
    floor: mat(0x3d4247, 0.9, 0)
};

// Vertical ribs drawn into the steel sides, so the tunnels read as corrugated panels.
function ribbed() {
    const c = document.createElement('canvas'); c.width = 64; c.height = 8;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#d9dbdd'; ctx.fillRect(0, 0, 64, 8);
    for (let x = 0; x < 64; x += 8) { ctx.fillStyle = '#b7bbbe'; ctx.fillRect(x, 0, 2, 8); ctx.fillStyle = '#eef0f1'; ctx.fillRect(x + 2, 0, 1, 8); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
// Black helix on the yellow PCA hose, as on the real thing.
function hoseTexture() {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f1c21b'; ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = '#1b1b1b'; ctx.lineWidth = 7;
    for (let i = -64; i < 128; i += 22) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 64, 64); ctx.stroke(); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function box(w, h, d, material, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    return m;
}
function cylinder(r, h, material, segments = 16) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, segments), material);
    m.castShadow = true;
    return m;
}

/* A tunnel section along +x from 0 to length: steel sides with a window band, roof, floor and the
   rubbing strips. Its origin is at the floor center at the inner end. */
function tunnel(length, width, height) {
    const g = new THREE.Group();
    const side = mat(0xffffff, 0.55, 0.35, { map: ribbed() });
    side.map.repeat.set(length / 0.6, 1);
    for (const s of [-1, 1]) {
        const wall = box(length, height, 0.08, side, length / 2, height / 2, s * width / 2);
        g.add(wall);
        // Window band at eye height, broken by posts.
        const band = box(length - 0.6, 0.75, 0.02, M.glass, length / 2, height * 0.6, s * (width / 2 + 0.05));
        band.castShadow = false;
        g.add(band);
        for (let x = 0.3; x < length; x += 1.5) g.add(box(0.12, 0.8, 0.03, M.steel, x, height * 0.6, s * (width / 2 + 0.06)));
        // Bottom and top rubbing strips, where the next tunnel slides.
        g.add(box(length, 0.14, 0.12, M.steelDark, length / 2, 0.07, s * (width / 2 + 0.04)));
        g.add(box(length, 0.14, 0.12, M.steelDark, length / 2, height - 0.07, s * (width / 2 + 0.04)));
    }
    g.add(box(length, 0.1, width + 0.1, M.steel, length / 2, height + 0.05, 0));         // Roof
    g.add(box(length, 0.18, width, M.steelDark, length / 2, -0.09, 0));                   // Floor pan
    // Roof drip edges and rain gutter.
    for (const s of [-1, 1]) g.add(box(length, 0.06, 0.08, M.steelDark, length / 2, height + 0.12, s * (width / 2 + 0.04)));
    return g;
}

/* A hose or cable hanging between points: a tube along a curve that sags to the ground (or to `sag`
   meters below the lower end) between them. Rebuilt whenever its ends move. */
class Flex {
    constructor(radius, material, segments = 40) {
        this.radius = radius; this.material = material; this.segments = segments;
        this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
        this.mesh.castShadow = true;
        this.key = '';
    }

    // points: control points from one end to the other; the curve passes through all of them.
    set(points) {
        const key = points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`).join('|');
        if (key === this.key) return;
        this.key = key;
        const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
        this.mesh.geometry.dispose();
        this.mesh.geometry = new THREE.TubeGeometry(curve, this.segments, this.radius, 10, false);
        const uv = this.mesh.geometry.attributes.uv;
        const length = curve.getLength();
        for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * length / (this.radius * 6));
    }
}

/* A coil of hose or cable, as it lies stowed in a basket or on a reel drum. */
function coil(radius, turns, tube, material, axis = 'y') {
    const pts = [];
    for (let i = 0; i <= turns * 24; i++) {
        const a = i / 24 * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * radius, i / 24 * tube * 2.1, Math.sin(a) * radius));
    }
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), turns * 24, tube, 8, false);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    const m = new THREE.Mesh(g, material); m.castShadow = true;
    return m;
}

export class JetBridge {
    /* rotunda: { x, z } in stand meters; floor: concourse floor height; facadeZ: the terminal wall. */
    constructor({ rotunda, floor, facadeZ }) {
        this.rotunda = rotunda;
        this.floor = floor;
        this.group = new THREE.Group();
        this.group.position.set(rotunda.x, 0, rotunda.z);

        // Pose: heading of the bridge from the rotunda (degrees, 0 = north), length from the rotunda
        // center to the cab's turning point, cab floor height, and the cab's turn relative to the bridge.
        this.pose = { heading: 135, length: 18, cabHeight: 3.2, cabTurn: -45 };
        this.target = null;              // Where it is driving to, as a pose.
        this.moving = false;
        this.wheelTurn = 0;

        // Fixed link from the terminal wall to the rotunda.
        const linkLength = rotunda.z - facadeZ;
        const link = tunnel(linkLength, 2.6, 2.7);
        link.rotation.y = Math.PI / 2;
        link.position.set(0, floor, 0);
        this.group.add(link);

        // Rotunda: column, drum and the turning roof.
        const column = cylinder(0.55, floor - 0.3, M.steelDark, 20);
        column.position.y = (floor - 0.3) / 2;
        const drum = cylinder(2.1, 2.9, M.steel, 32);
        drum.position.y = floor + 1.35;
        const roof = cylinder(2.25, 0.12, M.steelDark, 32);
        roof.position.y = floor + 2.85;
        const skirt = cylinder(2.15, 0.35, M.steelDark, 32);
        skirt.position.y = floor - 0.15;
        this.group.add(column, drum, roof, skirt);

        // The turning part: everything from the rotunda out.
        this.arm = new THREE.Group();
        this.group.add(this.arm);
        // Pitched part: the tunnels, which slope from the rotunda floor to the cab floor.
        this.slope = new THREE.Group();
        this.slope.position.y = floor;
        this.arm.add(this.slope);
        this.tunnels = [tunnel(9.5, 2.5, 2.6), tunnel(9.5, 2.75, 2.8), tunnel(9.5, 3.0, 3.0)];
        this.tunnels.forEach(t => this.slope.add(t));
        this.tunnels[1].position.y = -0.1; this.tunnels[2].position.y = -0.2;

        // Cable carrier (festoon) on the side of the first two tunnels.
        this.festoon = new THREE.Group();
        for (let i = 0; i < 14; i++) this.festoon.add(box(0.5, 0.12, 0.35, M.steelDark, i * 1.3, 0, 0));
        this.festoon.position.set(2.2, 0.3, 1.45);
        this.slope.add(this.festoon);

        this.buildDriveColumn();
        this.buildCab();
        this.buildEquipment();
        this.update(0);
    }

    buildDriveColumn() {
        const drive = this.drive = new THREE.Group();
        this.arm.add(drive);
        // Cross beam under the outer tunnel, lift legs either side, and the restrictor bars.
        this.beam = box(0.5, 0.5, 4.2, M.steelDark);
        drive.add(this.beam);
        this.legs = [];
        for (const s of [-1, 1]) {
            const outer = box(0.42, 1, 0.42, M.steelDark);
            const inner = box(0.3, 1, 0.3, M.steel);
            outer.position.z = inner.position.z = s * 1.75;
            drive.add(outer, inner);
            this.legs.push({ outer, inner });
            // Yellow/black height restrictor: equipment under the bridge must stay below it.
            const bar = box(0.08, 0.5, 0.6, M.yellow, 0.25, 1.9, s * 1.75);
            drive.add(bar);
        }
        // Bogie: turntable, frame, two drive wheels, and the wheel guards.
        this.bogie = new THREE.Group();
        this.bogie.add(box(1.4, 0.35, 2.6, M.steelDark, 0, 0.95, 0));
        this.wheels = [];
        for (const s of [-1, 1]) {
            const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.45, 24), M.tire);
            wheel.rotation.x = Math.PI / 2; wheel.position.set(0, 0.55, s * 0.75); wheel.castShadow = true;
            const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.47, 12), M.yellow);
            hub.rotation.x = Math.PI / 2; hub.position.copy(wheel.position);
            this.bogie.add(wheel, hub);
            this.wheels.push(wheel, hub);
            // Wheel guard: bumper bars that stop the bridge if they touch anything.
            this.bogie.add(box(0.1, 0.25, 1.2, M.yellow, 0.75, 0.35, s * 0.75), box(0.1, 0.25, 1.2, M.yellow, -0.75, 0.35, s * 0.75));
        }
        drive.add(this.bogie);
        // Amber rotating beacon: flashes while the bridge drives.
        this.beacon = makeLights([{ pos: [0, 0, 0], color: [1, 0.5, 0.05], size: 0.7, kind: KIND.beacon, phase: 0.3 }], lightMaterial([0, 0, 0, 1]));
        drive.add(this.beacon);
    }

    buildCab() {
        const cab = this.cab = new THREE.Group();
        this.arm.add(cab);
        const W = 3.6, D = 3.2, H = 2.9;
        this.cabSize = { W, D, H };
        // Shell: steel back half, glass front corners for the operator.
        const shell = new THREE.Group();
        shell.add(box(D, 0.2, W, M.floor, 0, -0.1, 0));
        shell.add(box(D, 0.12, W + 0.2, M.steel, 0, H, 0));
        for (const s of [-1, 1]) {
            shell.add(box(D * 0.5, H, 0.08, M.steel, -D * 0.25, H / 2, s * W / 2));
            shell.add(box(D * 0.5, H * 0.55, 0.06, M.glass, D * 0.25, H * 0.62, s * W / 2));
            shell.add(box(D * 0.5, H * 0.33, 0.08, M.steel, D * 0.25, H * 0.17, s * W / 2));
        }
        // Front: the door opening with the canopy around it.
        for (const s of [-1, 1]) shell.add(box(0.12, H, 0.7, M.steel, D / 2, H / 2, s * (W / 2 - 0.35)));
        shell.add(box(0.12, 0.45, W, M.steel, D / 2, H - 0.22, 0));
        cab.add(shell);
        // Control console in the front left corner, seen through the glass.
        cab.add(box(0.6, 1.0, 0.9, M.steelDark, D / 2 - 0.5, 0.5, -W / 2 + 0.6));
        // Canopy: accordion bellows that reach out to the fuselage. Its depth follows `canopyOut`.
        this.canopy = new THREE.Group();
        this.canopyFolds = [];
        for (let i = 0; i < 5; i++) {
            const fold = new THREE.Group();
            fold.add(box(0.14, 0.12, 2.3, M.canopy, 0, 2.45, 0));
            for (const s of [-1, 1]) fold.add(box(0.14, 2.4, 0.12, M.canopy, 0, 1.2, s * 1.15));
            this.canopy.add(fold);
            this.canopyFolds.push(fold);
        }
        this.canopy.position.x = D / 2 + 0.06;
        cab.add(this.canopy);
        // Bumper along the floor edge, and the auto-leveler wheel that rides on the fuselage.
        cab.add(box(0.25, 0.25, W - 0.4, M.rubber, D / 2 + 0.18, 0.05, 0));
        this.leveler = new THREE.Group();
        const arm = box(0.6, 0.08, 0.08, M.steelDark, 0.3, 0, 0);
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 14), M.tire);
        wheel.rotation.x = Math.PI / 2; wheel.position.x = 0.62;
        this.leveler.add(arm, wheel);
        this.leveler.position.set(D / 2 + 0.1, 0.5, W / 2 - 0.25);
        cab.add(this.leveler);
        // Floodlights under the cab, and a camera on the roof corner.
        cab.add(box(0.35, 0.18, 0.35, M.steelDark, D / 2 - 0.2, -0.32, -1.2), box(0.35, 0.18, 0.35, M.steelDark, D / 2 - 0.2, -0.32, 1.2));
        cab.add(box(0.28, 0.2, 0.18, M.gpu, D / 2 - 0.1, H + 0.2, -W / 2 + 0.2));
        this.cabLights = makeLights([
            { pos: [D / 2 - 0.2, -0.42, -1.2], color: [1, 0.95, 0.85], size: 1.2, kind: KIND.airfield },
            { pos: [D / 2 - 0.2, -0.42, 1.2], color: [1, 0.95, 0.85], size: 1.2, kind: KIND.airfield }]);
        cab.add(this.cabLights);
        this.floodlight = new THREE.SpotLight(0xfff2dc, 0, 25, Math.PI / 3, 0.7, 1.5);
        this.floodlight.position.set(D / 2, -0.3, 0);
        this.floodlight.target.position.set(D / 2 + 4, -3, 0);
        cab.add(this.floodlight, this.floodlight.target);

        // Service stairs: from a side door of the cab down to the ramp, with a landing and handrails.
        // They hang from the cab and turn with it; the bottom step stays a hand's width off the ground.
        this.stairs = new THREE.Group();
        cab.add(this.stairs);
        this.stairs.position.set(-D / 2 + 0.6, 0, W / 2 + 0.05);
        this.stairSteps = [];
        for (let i = 0; i < 16; i++) {
            const step = box(0.28, 0.05, 0.9, M.steelDark);
            this.stairs.add(step);
            this.stairSteps.push(step);
        }
        this.stringers = [box(1, 0.2, 0.06, M.yellow), box(1, 0.2, 0.06, M.yellow), box(1, 0.05, 0.05, M.yellow), box(1, 0.05, 0.05, M.yellow)];
        this.stringers.forEach(s => this.stairs.add(s));
    }

    buildEquipment() {
        // PCA unit under the outer tunnel: a long white cabinet with its intake grilles and a duct outlet.
        const pca = this.pca = new THREE.Group();
        pca.add(box(3.6, 1.15, 1.7, M.pca));
        for (let i = -1; i <= 1; i++) pca.add(box(0.8, 0.6, 0.02, M.steelDark, i * 1.1, 0.05, 0.86));
        pca.add(box(3.62, 0.1, 1.72, M.steelDark, 0, -0.58, 0));
        const outlet = cylinder(0.22, 0.5, M.steelDark); outlet.rotation.z = Math.PI / 2; outlet.position.set(-2.0, -0.25, 0);
        pca.add(outlet);
        // Hose basket below it with the hose coiled in it.
        const basket = new THREE.Group();
        basket.add(box(2.4, 0.06, 1.3, M.steelDark, 0, -0.5, 0));
        for (const s of [-1, 1]) basket.add(box(2.4, 0.5, 0.04, M.steelDark, 0, -0.25, s * 0.65), box(0.04, 0.5, 1.3, M.steelDark, s * 1.2, -0.25, 0));
        const hoseMat = M.hose.clone(); hoseMat.map = hoseTexture();
        this.hoseMaterial = hoseMat;
        this.hoseCoil = coil(0.45, 3, 0.18, hoseMat);
        this.hoseCoil.scale.set(2.3, 1, 1); this.hoseCoil.position.y = -0.45;
        basket.add(this.hoseCoil);
        basket.position.y = -0.9;
        pca.add(basket);
        this.slope.add(pca);

        // 400 Hz converter and its cable hoist, hung under the cab end of the outer tunnel.
        const gpu = this.gpu = new THREE.Group();
        gpu.add(box(1.5, 0.75, 1.0, M.gpu));
        gpu.add(box(0.6, 0.3, 0.02, mat(0x1d3c5e, 0.4, 0.2), 0.2, 0.1, 0.51));      // Status panel
        // Hoist: a motor drum with the cable wound on it.
        const drum = cylinder(0.32, 0.6, M.steelDark); drum.rotation.x = Math.PI / 2; drum.position.set(-1.1, -0.1, 0);
        this.cableCoil = coil(0.36, 4, 0.04, M.cable, 'y');
        this.cableCoil.rotation.x = Math.PI / 2; this.cableCoil.position.set(-1.1, -0.1, -0.25);
        gpu.add(drum, this.cableCoil);
        this.slope.add(gpu);

        // Potable water cabinet with a blue hose reel, on the drive column.
        const water = this.water = new THREE.Group();
        water.add(box(0.5, 0.9, 0.7, M.water));
        const reel = coil(0.22, 3, 0.03, M.blueHose); reel.rotation.z = Math.PI / 2; reel.position.set(0, -0.6, 0);
        water.add(reel);
        this.drive.add(water);

        // The run-out hose and cable; hidden until connected.
        this.pcaHose = new Flex(0.18, hoseMat, 60);
        this.gpuCable = new Flex(0.035, M.cable, 50);
        this.pcaHose.mesh.visible = this.gpuCable.mesh.visible = false;
        this.group.add(this.pcaHose.mesh, this.gpuCable.mesh);
    }

    /* Start driving to a pose; `speed` in meters (or degrees) per second. The bridge moves slowly, as
       real ones do, around 0.5 m/s, slower in the last meter. */
    driveTo(pose, onArrive) {
        this.target = { ...this.pose, ...pose };
        this.onArrive = onArrive;
        this.moving = true;
    }

    /* The pose that puts the cab's bumper against a door: point { x, y, z } in stand meters on a fuselage
       whose heading is given (the door faces left of it). */
    poseForDoor(door, aircraftHeading) {
        // The cab faces the fuselage: toward the aircraft's right, i.e. heading + 90.
        const face = aircraftHeading + 90;
        const f = face * Math.PI / 180;
        const reach = this.cabSize.D / 2 + 0.35;
        const cx = door.x - Math.sin(f) * reach, cz = door.z + Math.cos(f) * reach;
        const dx = cx - this.rotunda.x, dz = cz - this.rotunda.z;
        const heading = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
        // The cab turns the short way: between -180 and 180 degrees from the bridge.
        return { heading, length: Math.hypot(dx, dz), cabHeight: door.y, cabTurn: ((face - heading) % 360 + 540) % 360 - 180 };
    }

    // The cab's door threshold in stand coordinates, for walking up and for the camera.
    cabPoint() {
        const v = new THREE.Vector3(this.cabSize.D / 2, 0, 0);
        return this.cab.localToWorld(v);
    }

    // Where the stairs reach the ground.
    stairsFoot() {
        return this.stairSteps[0].getWorldPosition(new THREE.Vector3());
    }

    update(dt) {
        if (this.target) {
            const p = this.pose, t = this.target;
            let done = true;
            const approach = (key, rate) => {
                const d = t[key] - p[key];
                const step = rate * dt * (Math.abs(d) < 1 ? 0.4 : 1);
                if (Math.abs(d) <= step) p[key] = t[key];
                else { p[key] += Math.sign(d) * step; done = false; }
            };
            // Swing and telescope together, then turn the cab and set the height for the door.
            approach('heading', 1.6);
            approach('length', 0.55);
            approach('cabHeight', 0.15);
            approach('cabTurn', 6);
            this.wheelTurn += dt * 1.8;
            if (done) {
                this.target = null;
                this.moving = false;
                this.onArrive?.();
            }
        }
        this.pose_();
    }

    pose_() {
        const { heading, length, cabHeight, cabTurn } = this.pose;
        // The arm points along its local +x; heading 0 is north (-z), so turn x to the heading.
        this.arm.rotation.y = -(heading - 90) * Math.PI / 180;
        const drop = cabHeight - this.floor;
        const pitch = Math.atan2(drop, length);
        this.slope.rotation.z = pitch;
        const run = length / Math.cos(pitch);
        // Tunnels: the inner one fixed at the rotunda, the outer one ends at the cab, the middle one between.
        const [a, b, c] = this.tunnels;
        a.position.x = 1.9;
        c.position.x = run - 9.5 - this.cabSize.D / 2 + 0.2;
        b.position.x = (a.position.x + c.position.x) / 2;
        this.festoon.position.x = 2.2;
        this.festoon.scale.x = Math.max(0.5, (b.position.x + 4) / 18);

        // Cab at the end, level, turned to the door.
        const cabCenter = length;
        this.cab.position.set(cabCenter, cabHeight, 0);
        this.cab.rotation.y = -cabTurn * Math.PI / 180;
        this.canopy.visible = true;

        // Drive column under the outer tunnel, 3 m back from the cab; the tunnel floor height there.
        const dx = length - 3.4;
        const floorThere = this.floor + drop * dx / length - 0.2;
        this.drive.position.set(dx, 0, 0);
        this.beam.position.y = floorThere - 0.45;
        for (const leg of this.legs) {
            const top = floorThere - 0.7, bottom = 1.1;
            const h = Math.max(0.3, top - bottom);
            leg.outer.scale.y = h * 0.55; leg.outer.position.y = bottom + h * 0.275;
            leg.inner.scale.y = h * 0.6; leg.inner.position.y = top - h * 0.3;
        }
        this.water.position.set(0.5, 2.1, -1.75);
        this.beacon.position.set(0, floorThere - 0.1, -1.6);
        this.beacon.material.uniforms.uOn.value.x = this.moving ? 1 : 0;
        // The bogie steers in the direction of travel when driving.
        this.bogie.rotation.y = this.moving ? Math.sin(this.wheelTurn * 0.3) * 0.2 + 0.4 : 0;
        for (const w of this.wheels) w.rotation.y = this.wheelTurn;

        // Equipment under the tunnels, along the slope.
        this.pca.position.set(c.position.x + 3.2, -0.95, 0);
        this.gpu.position.set(c.position.x + 7.6, -0.65, 0.6);

        // Stairs: from the cab floor down to just off the ground, along the cab's side.
        const steps = this.stairSteps, n = steps.length, rise = Math.max(0.5, cabHeight - 0.15) / n;
        for (let i = 0; i < n; i++) steps[i].position.set(-(n - 1 - i) * 0.26, 0.15 + i * rise - cabHeight, 0.45);
        const run2 = (n - 1) * 0.26, h2 = cabHeight - 0.15;
        const len = Math.hypot(run2, h2), ang = Math.atan2(h2, run2);
        this.stringers.forEach((s, k) => {
            s.scale.x = len;
            s.rotation.z = ang;
            s.position.set(-run2 / 2, 0.15 + h2 / 2 - cabHeight + (k >= 2 ? 0.95 : 0), k % 2 ? 0.92 : -0.02);
        });
    }

    /* Run the PCA hose from the basket to a connector on the aircraft (stand meters), or stow it. */
    connectPca(port) {
        this.pcaHose.mesh.visible = Boolean(port);
        this.hoseCoil.visible = !port;
        if (!port) return;
        this.group.updateMatrixWorld(true);
        const from = this.pca.localToWorld(new THREE.Vector3(-2.2, -0.25, 0));
        const toLocal = p => this.group.worldToLocal(p.clone());
        const a = toLocal(from), b = toLocal(new THREE.Vector3(port.x, port.y, port.z));
        const mid = a.clone().lerp(b, 0.5);
        // The hose drops from the unit, lies along the ground, and rises to the belly connector.
        this.pcaHose.set([a, new THREE.Vector3(a.x, 0.6, a.z).lerp(mid, 0.2), new THREE.Vector3(mid.x, 0.2, mid.z),
            new THREE.Vector3(b.x, 0.25, b.z).lerp(mid, 0.25), new THREE.Vector3(b.x, b.y - 0.5, b.z), b]);
    }

    /* Lower the 400 Hz cable from the hoist and plug it into the aircraft's receptacle, or reel it in. */
    connectGpu(port) {
        this.gpuCable.mesh.visible = Boolean(port);
        this.cableCoil.scale.setScalar(port ? 0.7 : 1);
        if (!port) return;
        this.group.updateMatrixWorld(true);
        const from = this.gpu.localToWorld(new THREE.Vector3(-1.1, -0.45, 0));
        const toLocal = p => this.group.worldToLocal(p.clone());
        const a = toLocal(from), b = toLocal(new THREE.Vector3(port.x, port.y, port.z));
        const mid = a.clone().lerp(b, 0.5);
        this.gpuCable.set([a, new THREE.Vector3(a.x, a.y * 0.4, a.z).lerp(mid, 0.15), new THREE.Vector3(mid.x, 0.04, mid.z),
            new THREE.Vector3(b.x, 0.05, b.z).lerp(mid, 0.2), new THREE.Vector3(b.x, b.y - 0.4, b.z), b]);
    }

    setDark(dark) {
        this.floodlight.intensity = dark * 2;
    }
}
