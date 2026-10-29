/* Ramp agents: low-poly people dressed for the ramp, with a rig of joints so they can walk, crouch to
   set chocks, and give the standard marshalling signals (FAA AC 00-34, ICAO Annex 2 Appendix 1).

   What they wear (typical airline ramp PPE):
   - ANSI/ISEA 107 Class 2 or 3 high-visibility vest, fluorescent yellow-green or orange, with silver
     retro-reflective bands round the body and over the shoulders (they light up in headlights at night)
   - hearing protection: earmuffs; agents on the radio wear a headset with a boom mic instead, its cord
     running to a handheld radio clipped to the vest
   - safety-toe boots, work gloves, company work trousers and shirt, cap or beanie
   - marshallers and wing walkers carry a pair of orange lighted wands

   Each person faces +z in their own frame. Arms hang along -y from the shoulder; a shoulder turns about
   x to raise the arm forward and about z to raise it out to the side.

   With the crew models (models/crew/, Rocketbox avatars dressed by tools/rocketbox_to_glb.py) people
   are those rigged avatars instead: they walk, run, idle, crouch and knock with recorded animations,
   and signals aim their real arm bones in the same directions the drawn rig's arms would point.
   Without the models, the drawn people stand in. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const SKIN = [0xf1c9a5, 0xd9a47c, 0xb5794f, 0x8a5734, 0x5e3a22];
const mat = (color, roughness = 0.75, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });

// Vest texture: the fluorescent fabric and the two silver bands round the body.
function vestTexture(color, label) {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = color; ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#d8dcdf';
    ctx.fillRect(0, 54, 128, 12); ctx.fillRect(0, 86, 128, 12);
    if (label) {
        ctx.fillStyle = '#16202a'; ctx.font = 'bold 15px Arial'; ctx.textAlign = 'center';
        ctx.fillText(label, 96, 40);
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

const VEST = { lime: '#c8f526', orange: '#ff7a1a' };
const wandMaterial = mat(0xff5a00, 0.4, { emissive: 0xff4a00, emissiveIntensity: 1.5 });
const reflectiveMaterials = [];

function part(geometry, material, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z); m.castShadow = true;
    return m;
}
const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 10);

/* Signals as arm poses over time. Angles in degrees: a = out to the side, f = forward, e = elbow bend
   (in the plane the arm was raised in), for the left (L) and right (R) arm. */
const wave = (t, hz, lo, hi) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin(t * hz * Math.PI * 2));
const SIGNALS = {
    idle: () => ({ L: { a: 8, e: 12 }, R: { a: 8, e: 12 } }),
    // Arms straight up, wands up: "this way", identifying the stand.
    'this-way': () => ({ L: { a: 172 }, R: { a: 172 } }),
    // Arms out, forearms waved up and back toward the head: "come ahead".
    'come-ahead': t => ({ L: { a: 88, e: wave(t, 0.9, 55, 125) }, R: { a: 88, e: wave(t, 0.9, 55, 125) } }),
    // Arms down and out, patted up and down: "slow down".
    slow: t => ({ L: { a: wave(t, 1.1, 22, 45), f: 15 }, R: { a: wave(t, 1.1, 22, 45), f: 15 } }),
    // Wands crossed above the head: "stop".
    stop: () => ({ L: { a: 158, e: 42 }, R: { a: 158, e: 42 } }),
    // Crossed above the head, again and again, quickly: "emergency stop".
    'emergency-stop': t => ({ L: { a: wave(t, 2.2, 125, 162), e: 50 }, R: { a: wave(t, 2.2, 125, 162), e: 50 } }),
    // Right wand raised just above shoulder height: "set brakes".
    'set-brakes': t => ({ L: { a: 8 }, R: { f: 100, a: 10, e: wave(t, 0.5, 60, 90) } }),
    // Right wand drawn across the throat: "cut engines".
    'cut-engines': t => ({ L: { a: 8 }, R: { f: 80, a: wave(t, 1.3, -35, 20), e: 110 } }),
    // Wands above the head, jabbed inward until they touch: "chocks inserted".
    'chocks-in': t => ({ L: { a: wave(t, 1.4, 150, 168), e: wave(t, 1.4, 15, 45) }, R: { a: wave(t, 1.4, 150, 168), e: wave(t, 1.4, 15, 45) } }),
    // Wing walker, wingtip clear: one wand held up high.
    'all-clear': () => ({ L: { a: 10 }, R: { a: 165, e: 0 } }),
    // Thumbs up / OK to the flight crew after the walkaround.
    ok: () => ({ L: { a: 8 }, R: { f: 70, a: 25, e: 70 } })
};

/* ---------- Rigged people (Rocketbox avatars, models/crew/) ---------- */

/* The crew models and the shared animation clips. Clips keep only bone rotations (and the pelvis'
   bob), so clips made on one body fit every other: bone lengths stay each avatar's own. */
export async function loadCrewModels(files) {
    const loader = new GLTFLoader();
    const load = f => loader.loadAsync(`models/crew/${f}.glb`).catch(() => null);
    const [anim, ...models] = await Promise.all([load('animations'), ...files.map(load)]);
    if (!anim || models.some(m => !m)) return null;
    const clips = {};
    for (const clip of anim.animations) {
        clip.tracks = clip.tracks.filter(t => t.name.endsWith('.quaternion') || t.name === 'Bip01_Pelvis.position');
        clips[clip.name] = clip;
    }
    for (const m of models) m.scene.traverse(o => {
        if (!o.isMesh) return;
        if (o.material.name === 'hivis_vest') riggedVests.add(o.material);
        if (o.material.name === 'wand') riggedWands.add(o.material);
    });
    return { clips, models: Object.fromEntries(files.map((f, i) => [f, models[i].scene])) };
}
const riggedVests = new Set(), riggedWands = new Set();

// A stand-in arm with the same joints as the drawn rig, to turn a signal's angles into directions.
const dummy = (() => {
    const shoulder = new THREE.Object3D(), elbow = new THREE.Object3D();
    shoulder.rotation.order = elbow.rotation.order = 'ZXY';
    elbow.position.y = -0.3;
    shoulder.add(elbow);
    return { shoulder, elbow };
})();
const DOWN = new THREE.Vector3(0, -1, 0);
function armDirections(p, side) {
    const rad = THREE.MathUtils.degToRad;
    dummy.shoulder.rotation.set(-rad(p.f || 0), 0, side * rad(p.a || 0));
    dummy.elbow.rotation.set(-rad(p.ef || 0) - (p.f ? rad(p.e || 0) : 0), 0, p.f ? 0 : side * rad(p.e || 0));
    dummy.shoulder.updateMatrixWorld(true);
    return {
        upper: DOWN.clone().applyQuaternion(dummy.shoulder.quaternion),
        fore: DOWN.clone().applyQuaternion(dummy.elbow.getWorldQuaternion(new THREE.Quaternion()))
    };
}

// Turns a bone so that the way to its child points along a direction in the world.
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion(), _p = new THREE.Quaternion();
function aim(bone, child, direction) {
    bone.updateWorldMatrix(true, true);
    const from = child.getWorldPosition(_a).sub(bone.getWorldPosition(_b)).normalize();
    const turn = new THREE.Quaternion().setFromUnitVectors(from, direction);
    const world = bone.getWorldQuaternion(_q).premultiply(turn);
    bone.quaternion.copy(bone.parent.getWorldQuaternion(_p).invert().multiply(world));
}

export class Person {
    /* role: label shown over the head; outfit: { vest: 'lime'|'orange', headset: bool, wands: bool, cap }.
       With `model` (a crew model) and `clips`, the person is that rigged avatar instead of the drawn one. */
    constructor(name, { vest = 'lime', headset = false, wands = false, cap = 'cap', label = 'RAMP', skin, shirt = 0x1f2d3d, model = null, clips = null } = {}) {
        this.name = name;
        this.group = new THREE.Group();
        this.root = new THREE.Group();       // Raised or lowered when crouching.
        this.group.add(this.root);
        this.heading = 0;
        this.signal = 'idle';
        this.signalTime = 0;
        this.walkPhase = 0;
        this.speed = 0;
        this.crouch = 0;
        this.path = null;
        this.tasks = [];
        this.headset = headset;
        if (model && clips) { this.buildRigged(model, clips, wands); return; }

        const skinMat = mat(skin ?? SKIN[Math.floor(Math.random() * SKIN.length)], 0.6);
        const pants = mat(0x232a33, 0.85), shirtMat = mat(shirt, 0.8), boot = mat(0x111111, 0.6), glove = mat(0x3a3a33, 0.9);
        const vestTex = vestTexture(VEST[vest] || vest, label);
        const vestMat = mat(0xffffff, 0.7, { map: vestTex, emissive: 0xffffff, emissiveMap: vestTex, emissiveIntensity: 0.05 });
        reflectiveMaterials.push(vestMat);
        const band = mat(0xd8dcdf, 0.3, { metalness: 0.6, emissive: 0xffffff, emissiveIntensity: 0.05 });
        reflectiveMaterials.push(band);

        // Legs: thigh at the hip, shin at the knee, boot.
        this.legs = [-1, 1].map(s => {
            const hip = new THREE.Group(); hip.position.set(s * 0.1, 0.92, 0);
            hip.add(part(capsule(0.075, 0.32), pants, 0, -0.22, 0));
            const knee = new THREE.Group(); knee.position.y = -0.44;
            knee.add(part(capsule(0.065, 0.32), pants, 0, -0.21, 0));
            const shoe = part(new THREE.BoxGeometry(0.12, 0.1, 0.28), boot, 0, -0.43, 0.05);
            knee.add(shoe);
            hip.add(knee);
            this.root.add(hip);
            return { hip, knee };
        });

        // Body: shirt, vest over it with its shoulder bands, and the belt.
        const torso = new THREE.Group(); torso.position.y = 0.92;
        torso.add(part(capsule(0.17, 0.32).scale(1, 1, 0.68), shirtMat, 0, 0.3, 0));
        const vestMesh = part(new THREE.CylinderGeometry(0.188, 0.178, 0.46, 14, 1, true).scale(1, 1, 0.72), vestMat, 0, 0.28, 0);
        vestMesh.material.side = THREE.DoubleSide;
        torso.add(vestMesh);
        for (const s of [-1, 1]) torso.add(part(new THREE.BoxGeometry(0.06, 0.02, 0.3), band, s * 0.1, 0.52, 0));
        torso.add(part(new THREE.CylinderGeometry(0.175, 0.175, 0.05, 14).scale(1, 1, 0.7), mat(0x111111), 0, 0.03, 0));
        this.root.add(torso);
        this.torso = torso;

        // Head: neck, head, cap or beanie, and hearing protection.
        const head = new THREE.Group(); head.position.y = 1.58;
        head.add(part(new THREE.CylinderGeometry(0.05, 0.055, 0.08, 8), skinMat, 0, -0.08, 0));
        head.add(part(new THREE.SphereGeometry(0.105, 16, 12).scale(0.92, 1.08, 1), skinMat, 0, 0.04, 0));
        const capMat = mat(0x14202c, 0.8);
        if (cap === 'beanie') head.add(part(new THREE.SphereGeometry(0.11, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), capMat, 0, 0.06, 0));
        else {
            head.add(part(new THREE.SphereGeometry(0.108, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), capMat, 0, 0.07, 0));
            head.add(part(new THREE.BoxGeometry(0.17, 0.012, 0.1), capMat, 0, 0.075, 0.13));
        }
        // Safety glasses.
        head.add(part(new THREE.BoxGeometry(0.17, 0.035, 0.02), mat(0x0d0d0d, 0.15, { metalness: 0.4 }), 0, 0.06, 0.1));
        // Earmuffs (or headset cups), with the band over the cap.
        const cupMat = headset ? mat(0x1a1a1a, 0.5) : mat(0xe03c1e, 0.5);
        for (const s of [-1, 1]) {
            const cup = part(new THREE.CylinderGeometry(0.055, 0.055, 0.05, 14), cupMat, s * 0.11, 0.03, 0);
            cup.rotation.z = Math.PI / 2;
            head.add(cup);
        }
        const bandArc = part(new THREE.TorusGeometry(0.12, 0.012, 6, 16, Math.PI), mat(0x222222, 0.5), 0, 0.03, 0);
        head.add(bandArc);
        if (headset) {
            // Boom mic in front of the mouth, and the cord down to the radio on the vest.
            const boom = part(new THREE.CylinderGeometry(0.006, 0.006, 0.15, 6), mat(0x111111), -0.09, -0.03, 0.07);
            boom.rotation.set(Math.PI / 2.4, 0, 0.6);
            head.add(boom, part(new THREE.SphereGeometry(0.014, 8, 6), mat(0x111111), -0.045, -0.06, 0.12));
            const radio = part(new THREE.BoxGeometry(0.06, 0.11, 0.035), mat(0x1c1c1c, 0.5), -0.09, 0.42, 0.14);
            const antenna = part(new THREE.CylinderGeometry(0.006, 0.008, 0.08, 6), mat(0x111111), -0.075, 0.51, 0.14);
            torso.add(radio, antenna);
            const cord = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
                new THREE.Vector3(-0.11, 1.6, 0.0), new THREE.Vector3(-0.14, 1.48, 0.08), new THREE.Vector3(-0.1, 1.4, 0.15)]), 10, 0.006, 5), mat(0x111111));
            this.root.add(cord);
        }
        this.root.add(head);
        this.head = head;

        // Arms: shoulder, elbow, glove, and a lighted wand in each hand if they marshal.
        this.arms = [1, -1].map(s => {       // +x is the person's left.
            const shoulder = new THREE.Group(); shoulder.position.set(s * 0.215, 1.43, 0);
            shoulder.rotation.order = 'ZXY';
            shoulder.add(part(capsule(0.055, 0.22), shirtMat, 0, -0.15, 0));
            const elbow = new THREE.Group(); elbow.position.y = -0.3; elbow.rotation.order = 'ZXY';
            elbow.add(part(capsule(0.048, 0.2), shirtMat, 0, -0.13, 0));
            elbow.add(part(new THREE.BoxGeometry(0.075, 0.1, 0.05), glove, 0, -0.3, 0));
            if (wands) {
                const wand = new THREE.Group();
                wand.add(part(new THREE.CylinderGeometry(0.02, 0.02, 0.1, 8), mat(0x111111), 0, -0.33, 0.03));
                wand.add(part(new THREE.CylinderGeometry(0.025, 0.02, 0.42, 10), wandMaterial, 0, -0.58, 0.03));
                elbow.add(wand);
            }
            shoulder.add(elbow);
            this.root.add(shoulder);
            return { shoulder, elbow, side: s };
        });

        this.group.traverse(o => { if (o.isMesh) o.castShadow = true; });
    }

    place(x, z, heading = this.heading) {
        this.group.position.set(x, 0, z);
        this.heading = heading;
        this.group.rotation.y = -heading * Math.PI / 180 + Math.PI;
    }

    get position() { return this.group.position; }

    // Face a point on the ground.
    face(x, z) {
        this.place(this.group.position.x, this.group.position.z, Math.atan2(x - this.group.position.x, -(z - this.group.position.z)) * 180 / Math.PI);
    }

    /* Walk to a point and call back on arrival. Walking pace is about 1.4 m/s; ramp agents never run
       near aircraft. */
    walkTo(x, z, onArrive, speed = 1.4) {
        this.path = { x, z, speed, onArrive };
    }

    setSignal(signal) {
        if (signal !== this.signal) { this.signal = signal; this.signalTime = 0; }
    }

    update(dt) {
        this.signalTime += dt;
        // Walking toward the current target.
        if (this.path) {
            const p = this.group.position, dx = this.path.x - p.x, dz = this.path.z - p.z, d = Math.hypot(dx, dz);
            if (d < 0.15) {
                const done = this.path.onArrive;
                this.path = null; this.speed = 0;
                done?.();
            } else {
                this.speed = Math.min(this.path.speed, d * 2 + 0.3);
                const step = Math.min(d, this.speed * dt);
                const heading = Math.atan2(dx, -dz) * 180 / Math.PI;
                this.place(p.x + dx / d * step, p.z + dz / d * step, heading);
            }
        }
        this.animate(dt);
    }

    // Moved by the player instead of a path (WASD): speed in m/s.
    moveBy(dx, dz, dt) {
        const d = Math.hypot(dx, dz);
        this.speed = dt > 0 ? d / dt : 0;
        if (d > 1e-4) this.place(this.group.position.x + dx, this.group.position.z + dz, Math.atan2(dx, -dz) * 180 / Math.PI);
        this.animate(dt);
    }

    buildRigged(model, clips, wands) {
        const body = cloneSkinned(model);
        body.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
        for (const name of ['wand_L', 'wand_R']) { const w = body.getObjectByName(name); if (w) w.visible = wands; }
        // Rocketbox's animations face the other way from its avatars' bind pose, so the animated body
        // is turned round to face +z like everyone else.
        body.rotation.y = Math.PI;
        this.root.add(body);
        this.mixer = new THREE.AnimationMixer(body);
        this.actions = Object.fromEntries(Object.entries(clips).map(([name, clip]) => [name, this.mixer.clipAction(clip)]));
        this.clip = null;
        // Arms by side: Biped's L is the person's left, which is +x when facing +z.
        const bone = n => body.getObjectByName(`Bip01_${n}`);
        this.armBones = [['L', 1], ['R', -1]].map(([s, side]) =>
            ({ upper: bone(`${s}_UpperArm`), fore: bone(`${s}_Forearm`), hand: bone(`${s}_Hand`), finger: bone(`${s}_Finger2`), side }));
        this.play('idle_neutral_01');
    }

    play(name, fade = 0.3) {
        if (name === this.clip || !this.actions[name]) return;
        const next = this.actions[name].reset().setEffectiveWeight(1).fadeIn(fade).play();
        if (this.clip) this.actions[this.clip].fadeOut(fade);
        this.clip = name;
        return next;
    }

    animateRigged(dt) {
        const moving = this.speed > 0.1;
        const clip = this.crouch > 0.5 ? 'crouch_idle' : this.signal === 'knock' ? 'knock_door'
            : this.speed > 2 ? 'run_slow_01' : moving ? 'walk_neutral_01' : 'idle_neutral_01';
        this.play(clip);
        // Walk and run cycles keep pace with the ground (about 1.35 m/s and 3.2 m/s as recorded).
        if (moving) this.actions[clip].timeScale = this.speed / (clip === 'run_slow_01' ? 3.2 : 1.35);
        this.root.position.y = 0;
        this.mixer.update(dt);
        // Signals: the arms are aimed over whatever the body is doing.
        const signal = SIGNALS[this.signal];
        if (!signal || this.signal === 'idle' || this.signal === 'knock') return;
        const pose = signal(this.signalTime);
        const toWorld = this.group.getWorldQuaternion(new THREE.Quaternion());
        for (const arm of this.armBones) {
            const dirs = armDirections(arm.side > 0 ? pose.L : pose.R, arm.side);
            aim(arm.upper, arm.fore, dirs.upper.applyQuaternion(toWorld));
            aim(arm.fore, arm.hand, dirs.fore.clone().applyQuaternion(toWorld));
            aim(arm.hand, arm.finger, dirs.fore.applyQuaternion(toWorld));
        }
    }

    animate(dt) {
        if (this.mixer) return this.animateRigged(dt);
        const moving = this.speed > 0.05;
        this.walkPhase += dt * this.speed * 4.2;
        const swing = moving ? Math.sin(this.walkPhase) * Math.min(1, this.speed / 1.4) : 0;
        // Crouch: hips drop, knees bend.
        const c = this.crouch;
        this.root.position.y = -0.38 * c;
        this.legs.forEach((leg, i) => {
            const s = i ? 1 : -1;
            leg.hip.rotation.x = -swing * 0.5 * s - c * 1.3;
            leg.knee.rotation.x = Math.max(0, swing * s) * 0.7 + c * 2.0 + (moving ? 0.15 : 0);
        });
        this.torso.rotation.x = c * 0.35;
        // Arms: the signal pose, or swinging with the walk.
        const pose = moving && this.signal === 'idle'
            ? { L: { a: 6, f: swing * 25, e: 15 }, R: { a: 6, f: -swing * 25, e: 15 } }
            : (SIGNALS[this.signal] || SIGNALS.idle)(this.signalTime);
        for (const arm of this.arms) {
            const p = arm.side > 0 ? pose.L : pose.R;
            const rad = THREE.MathUtils.degToRad;
            arm.shoulder.rotation.set(-rad(p.f || 0), 0, arm.side * rad(p.a || 0));
            arm.elbow.rotation.set(-rad(p.ef || 0) - (p.f ? rad(p.e || 0) : 0), 0, p.f ? 0 : arm.side * rad(p.e || 0));
        }
    }
}

/* The night look: retro-reflective bands catch the light and the wands glow brighter. */
export function setCrewDark(dark) {
    for (const m of reflectiveMaterials) m.emissiveIntensity = 0.05 + dark * 0.5;
    wandMaterial.emissiveIntensity = 1.5 + dark * 4;
    for (const m of riggedVests) m.emissiveIntensity = 0.05 + dark * 0.6;
    for (const m of riggedWands) m.emissiveIntensity = 1.5 + dark * 4;
}

export const SIGNAL_NAMES = Object.keys(SIGNALS);
