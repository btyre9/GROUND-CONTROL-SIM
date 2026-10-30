/* Ground support equipment on the stand: chocks, safety cones, the belt loader, the pushback tug and a
   baggage train (the last two are the Blender models the tower sim uses, models/vehicles/).

   Vehicles follow the aircraft convention: the front toward -z, origin on the ground at the center,
   heading 0 = north. They drive along straight legs at ramp speeds: 5 mph (2.2 m/s) on the stand,
   walking pace inside the ERA, and stop short of the aircraft for a brake check before creeping in. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { makeLights, lightMaterial, KIND } from '../lights.js';

const mat = (color, roughness = 0.6, metalness = 0.15, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
const M = {
    chock: mat(0xf2b705, 0.7, 0), rope: mat(0x2a2a2a, 0.9, 0), cone: mat(0xff5a14, 0.6, 0), coneBase: mat(0x151515, 0.9, 0),
    collar: mat(0xe8eaec, 0.25, 0.6, { emissive: 0xffffff, emissiveIntensity: 0 }),
    body: mat(0xeef0f0, 0.45, 0.2), chassis: mat(0x2e3337, 0.6, 0.4), tire: mat(0x1b1b1b, 0.95, 0), rail: mat(0xe8b400, 0.5, 0.2),
    belt: mat(0x111111, 0.85, 0), seat: mat(0x202020, 0.8, 0), pad: mat(0x0f0f0f, 0.9, 0)
};

function box(w, h, d, material, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    return m;
}
function wheel(r, w, x, z) {
    const g = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 18), M.tire);
    tire.rotation.z = Math.PI / 2; tire.castShadow = true;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.5, r * 0.5, w + 0.02, 10), M.chassis);
    hub.rotation.z = Math.PI / 2;
    g.add(tire, hub); g.position.set(x, r, z);
    return g;
}

/* A pair of chocks: two urethane wedges joined by a rope, one each side of a tire. `span` is the tire
   diameter they straddle. */
export function chockPair(span = 0.9) {
    const g = new THREE.Group();
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(0.28, 0); shape.lineTo(0.08, 0.2); shape.lineTo(0, 0.2); shape.closePath();
    const wedge = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false });
    wedge.translate(0, 0, -0.25);
    for (const s of [-1, 1]) {
        const w = new THREE.Mesh(wedge, M.chock);
        w.castShadow = true;
        w.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
        w.position.z = s * span / 2;
        g.add(w);
    }
    const rope = box(0.03, 0.03, span + 0.3, M.rope, 0.3, 0.1, 0);
    g.add(rope);
    return g;
}

// A 28-inch traffic cone with two retro-reflective collars.
export function cone() {
    const g = new THREE.Group();
    g.add(box(0.36, 0.04, 0.36, M.coneBase, 0, 0.02, 0));
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.15, 0.68, 16), M.cone);
    body.position.y = 0.38; body.castShadow = true;
    g.add(body);
    for (const [y, r] of [[0.52, 0.065], [0.36, 0.1]]) {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(r - 0.005, r + 0.012, 0.08, 16, 1, true), M.collar);
        c.position.y = y; g.add(c);
    }
    return g;
}

/* A belt loader: chassis on four wheels, the driver's seat on the left at the back, and the conveyor
   boom that tilts up to the hold door, with handrails and a rubber bumper pad on the nose. The belt's
   chevrons scroll when it runs. Front is -z. */
export class BeltLoader {
    constructor() {
        const g = this.group = new THREE.Group();
        g.add(box(1.9, 0.45, 6.6, M.chassis, 0, 0.62, 0));
        for (const [x, z] of [[-0.85, -2.2], [0.85, -2.2], [-0.85, 2.3], [0.85, 2.3]]) g.add(wheel(0.33, 0.25, x, z));
        // Engine cover and the driver's station.
        g.add(box(1.1, 0.6, 1.5, M.body, 0.35, 1.15, 2.3));
        g.add(box(0.5, 0.08, 0.5, M.seat, -0.55, 1.15, 2.4), box(0.5, 0.55, 0.08, M.seat, -0.55, 1.45, 2.66));
        const steer = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.02, 6, 16), M.seat);
        steer.position.set(-0.55, 1.5, 1.95); steer.rotation.x = -1.0;
        g.add(steer, box(0.08, 0.45, 0.08, M.chassis, -0.55, 1.28, 2.0));
        // ROPS frame over the seat.
        for (const x of [-0.85, -0.25]) g.add(box(0.06, 1.3, 0.06, M.rail, x, 1.75, 2.75));
        g.add(box(0.7, 0.06, 0.06, M.rail, -0.55, 2.4, 2.75));
        // Conveyor boom, pivoting at the back.
        this.boom = new THREE.Group();
        this.boom.position.set(0.25, 1.05, 2.4);
        const length = 7.4;
        this.beltTexture = (() => {
            const c = document.createElement('canvas'); c.width = 32; c.height = 64;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#121212'; ctx.fillRect(0, 0, 32, 64);
            ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = 4;
            for (let y = 0; y < 64; y += 16) { ctx.beginPath(); ctx.moveTo(2, y + 10); ctx.lineTo(16, y); ctx.lineTo(30, y + 10); ctx.stroke(); }
            const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, length / 1.2);
            return t;
        })();
        const belt = box(0.8, 0.06, length, mat(0xffffff, 0.85, 0, { map: this.beltTexture }), 0, 0.12, -length / 2);
        this.boom.add(box(1.0, 0.22, length, M.body, 0, 0, -length / 2), belt);
        for (const s of [-1, 1]) {
            this.boom.add(box(0.05, 0.05, length - 1.2, M.rail, s * 0.5, 0.95, -length / 2 - 0.4));
            for (let z = -1; z > -length + 0.6; z -= 1.6) this.boom.add(box(0.04, 0.85, 0.04, M.rail, s * 0.5, 0.55, z));
        }
        this.boom.add(box(1.0, 0.3, 0.25, M.pad, 0, 0.02, -length - 0.1));      // Bumper pad
        g.add(this.boom);
        // Lift ram under the boom.
        this.ram = box(0.16, 1, 0.16, M.chassis, 0.25, 1.0, -1.6);
        g.add(this.ram);
        // Amber beacon on the ROPS frame.
        g.add(makeLights([{ pos: [-0.55, 2.5, 2.75], color: [1, 0.55, 0.05], size: 0.6, kind: KIND.beacon, phase: 0.7 }], lightMaterial([1, 0, 0, 1])));
        g.traverse(o => { if (o.isMesh) o.castShadow = true; });
        this.length = length;
        this.running = false;
        this.setTip(0.9);
        this.mover = new Mover(g);
    }

    // Tilt the boom so its tip is at this height (meters).
    setTip(height) {
        const rise = height - this.boom.position.y;
        this.boom.rotation.x = Math.asin(Math.max(-0.2, Math.min(0.5, rise / this.length)));
        this.ram.position.y = 0.8 + rise * 0.25;
        this.ram.scale.y = 0.6 + rise * 0.5;
        this.tipHeight = height;
    }

    // How far the boom's tip (its bumper pad) is ahead of the vehicle's origin, for driving up to a door.
    get reach() { return this.length * Math.cos(this.boom.rotation.x) + 0.2 - this.boom.position.z; }

    update(dt) {
        this.mover.update(dt);
        if (this.running) this.beltTexture.offset.y -= dt * 0.9;
    }
}

/* Drives a vehicle along a list of legs: { x, z, speed, pause } — straight to each point, turning to
   face it first, then pausing (a brake check) if asked. */
export class Mover {
    constructor(object) {
        this.object = object;
        this.legs = [];
        this.speed = 0;
        this.heading = 0;
    }

    place(x, z, heading) {
        this.object.position.set(x, 0, z);
        this.heading = heading;
        this.object.rotation.y = -heading * Math.PI / 180;
    }

    drive(legs, onDone) { this.legs = [...legs]; this.onDone = onDone; }

    get moving() { return this.legs.length > 0; }

    update(dt) {
        const leg = this.legs[0];
        if (!leg) { this.speed = 0; return; }
        const p = this.object.position, dx = leg.x - p.x, dz = leg.z - p.z, d = Math.hypot(dx, dz);
        if (d < 0.05) {
            if (leg.heading !== undefined) this.place(leg.x, leg.z, leg.heading);
            this.speed = 0;
            if ((leg.pause || 0) > 0) { leg.pause -= dt; return; }
            this.legs.shift();
            if (!this.legs.length) { const done = this.onDone; this.onDone = null; done?.(); }
            return;
        }
        // Turn toward the point (vehicles reverse onto it if it's behind and close).
        const want = Math.atan2(dx, -dz) * 180 / Math.PI;
        const reverse = leg.reverse;
        const target = reverse ? want + 180 : want;
        let turn = ((target - this.heading + 540) % 360) - 180;
        const maxTurn = 40 * dt;
        this.heading += Math.max(-maxTurn, Math.min(maxTurn, turn));
        this.speed = Math.min(leg.speed ?? 2.2, d * 0.8 + 0.1);
        const step = Math.min(d, this.speed * dt) * (Math.abs(turn) > 60 ? 0.3 : 1);
        this.object.position.x += dx / d * step;
        this.object.position.z += dz / d * step;
        this.object.rotation.y = -this.heading * Math.PI / 180;
    }
}

/* The tug and baggage train models from the tower sim, if they are there. */
export async function loadVehicleModels() {
    const loader = new GLTFLoader(), models = {};
    await Promise.all(['tug', 'towbar', 'baggage-tractor', 'baggage-cart'].map(async name => {
        try {
            const gltf = await loader.loadAsync(`models/vehicles/${name}.glb`);
            gltf.scene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
            models[name] = gltf.scene;
        } catch { /* Not there: that vehicle is left out. */ }
    }));
    return models;
}

/* Suitcases and bags in assorted colors and sizes, for the belt and the carts. */
const BAG_COLORS = [0x1b1b1b, 0x22344f, 0x6b1d1d, 0x2f4d2f, 0x5a5a5a, 0x8a6a3b, 0x3d2a52, 0xb3b3b3];
export function bag(random = Math.random) {
    const w = 0.4 + random() * 0.3, h = 0.22 + random() * 0.12, d = 0.55 + random() * 0.25;
    const g = new THREE.Group();
    g.add(box(w, h, d, mat(BAG_COLORS[Math.floor(random() * BAG_COLORS.length)], 0.7, 0.05), 0, h / 2, 0));
    g.add(box(0.12, 0.03, 0.03, M.chassis, 0, h + 0.015, 0));      // Handle
    // Bag tag on the handle.
    g.add(box(0.05, 0.08, 0.005, mat(0xf4f1e6, 0.8, 0), 0.06, h - 0.02, 0.02));
    return g;
}

export function setGseDark(dark) {
    M.collar.emissiveIntensity = dark * 0.4;
}
