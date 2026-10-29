/* Airliners: real 3D models where we have one for the size class, otherwise a placeholder built from
   simple shapes. Either way the origin is the main landing gear on the ground (where it pivots when
   turning and rotating for takeoff) and the nose points to -z. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { LAYER } from './airport-scene.js';

import { makeLights, lightMaterial, lightUniforms, KIND } from './lights.js';

/* Real models and their liveries come from 3d-aircraft/aircraft.json (written by tools/add_livery.py).
   Models are glTF in meters, nose to -z, origin on the ground between the main gear. Without the file
   (it is not in the public repo) the placeholder airliner stands in. */
const MANIFEST = '3d-aircraft/aircraft.json';
const models = {};          // id -> { scene, wheelbase, lights, sizeClasses }
let liveries = [];          // { model, airline, name, textures: { materialName: url } }

// Night glow: lit textures and cabin windows follow this, from 0 by day to 1 at night.
export const nightGlow = { value: 0 };

/* The surroundings' lighting map (sky by day, the floodlit airport at night) lights only the aircraft,
   so their paint stays readable at night; buildings keep their own look. Every aircraft material is kept
   here so a new map reaches them all. */
const environment = { map: null, intensity: 1 };
const litMaterials = new Set();
function lit(material) {
    material.envMap = environment.map;
    material.envMapIntensity = environment.intensity;
    litMaterials.add(material);
    return material;
}
export function setAircraftEnvironment(map, intensity) {
    const recompile = !environment.map !== !map;
    environment.map = map; environment.intensity = intensity;
    for (const material of litMaterials) {
        material.envMap = map; material.envMapIntensity = intensity;
        if (recompile) material.needsUpdate = true;
    }
}
const glowingMaterials = new Set();

/* files: a different file for a model id, such as a version with opening doors for the ramp sim. */
export async function loadModels(files = {}) {
    let manifest;
    try {
        manifest = await (await fetch(MANIFEST)).json();
    } catch {
        return [];
    }
    const loader = new GLTFLoader();
    await Promise.all(Object.entries(manifest.models).map(async ([id, model]) => {
        try {
            const gltf = await loader.loadAsync(`3d-aircraft/${files[id] || model.file}`);
            const extras = gltf.asset?.extras || {};
            gltf.scene.traverse(o => { if (o.isMesh) o.castShadow = true; });
            const wheelbase = extras.wheelbaseM || WHEELBASE_M * SIZE_SCALE[model.sizeClasses[0]];
            const shape = shapeOf(gltf.scene, wheelbase);
            models[id] = { id, scene: gltf.scene, sizeClasses: model.sizeClasses, wheelbase, fin: shape.fin, doors: extras.doors || [],
                lights: extras.lights?.length ? extras.lights : lightsFromShape(shape) };
        } catch (err) {
            console.warn(`Aircraft model ${id} did not load:`, err.message);
        }
    }));
    liveries = manifest.liveries.filter(l => models[l.model]);
    return Object.keys(models);
}

/* Which model and livery an airline's jet at a gate of this size gets: its own livery where we have one,
   otherwise any model that fits the gate in plain paint. */
function chooseModel(sizeClass, airline) {
    const fits = id => models[id].sizeClasses.includes(sizeClass);
    const own = liveries.filter(l => l.airline === airline && fits(l.model));
    if (own.length) {
        const livery = own[Math.floor(Math.random() * own.length)];
        return { model: models[livery.model], livery };
    }
    const fitting = Object.keys(models).filter(fits);
    if (!fitting.length) return null;
    return { model: models[fitting[Math.floor(Math.random() * fitting.length)]], livery: null };
}

const textureLoader = new THREE.TextureLoader();
const textures = new Map();
function liveryTexture(url, like) {
    if (!textures.has(url)) {
        const texture = textureLoader.load(`3d-aircraft/${url}`);
        texture.flipY = false;               // glTF texture convention.
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
        texture.wrapS = like?.wrapS ?? THREE.RepeatWrapping;
        texture.wrapT = like?.wrapT ?? THREE.RepeatWrapping;
        textures.set(url, texture);
    }
    return textures.get(url);
}

/* The house paint the model ships with, made plain: strongly colored (purple LevelUp) areas turn white,
   so airlines without a livery fly an unbranded jet instead of someone else's colors. */
const plainTextures = new Map();
function plainTexture(texture) {
    if (!texture?.image || plainTextures.has(texture)) return plainTextures.get(texture) || texture;
    const image = texture.image;
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        if (max - min > 60 && b >= r && b > g + 40) { px[i] = 236; px[i + 1] = 237; px[i + 2] = 235; }
    }
    ctx.putImageData(data, 0, 0);
    const plain = new THREE.CanvasTexture(canvas);
    for (const key of ['flipY', 'colorSpace', 'wrapS', 'wrapT', 'anisotropy']) plain[key] = texture[key];
    plainTextures.set(texture, plain);
    return plain;
}

/* Night lighting painted on the model. Logo lights on the stabilizer wash the lower fin in its own paint
   (fin: logo height, logo position along the body, reach, lowest point lit). With a seed, cabin windows
   each get a random number too, so some are lit and others not. */
function nightLighting(material, fin, seed = null) {
    const windows = seed !== null;
    material.onBeforeCompile = shader => {
        shader.uniforms.uNight = nightGlow;
        shader.uniforms.uFin = { value: fin || new THREE.Vector4(0, 0, 0, 1e6) };
        shader.uniforms.uSeed = { value: seed ?? 0 };
        shader.vertexShader = 'attribute float _window;\nvarying float vWindow;\nvarying vec3 vLocal;\n' +
            shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
                vLocal = position;
                ${windows ? 'vWindow = _window;' : 'vWindow = 0.0;'}`);
        shader.fragmentShader = 'uniform float uSeed;\nuniform float uNight;\nuniform vec4 uFin;\nvarying float vWindow;\nvarying vec3 vLocal;\n' +
            shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
                float onFin = step(abs(vLocal.x), 0.7) * step(uFin.w, vLocal.y);
                float logo = onFin * (1.0 - smoothstep(uFin.z * 0.25, uFin.z, distance(vLocal.yz, uFin.xy)));
                totalEmissiveRadiance += diffuseColor.rgb * logo * uNight * 0.6;
                ${windows ? `float litWindow = step(fract(vWindow * 13.7 + uSeed), 0.6);
                totalEmissiveRadiance += vec3(1.0, 0.8, 0.5) * litWindow * uNight * 1.4;` : ''}`);
    };
    material.customProgramCacheKey = () => windows ? 'night-windows' : 'night-logo';
    return material;
}

// Materials per model and livery, shared by every jet in that paint; windows get their own per jet.
const liveryMaterials = new Map();
function paintedMaterial(original, model, livery) {
    const key = `${model.id}|${livery?.folder || 'plain'}|${original.uuid}`;
    if (!liveryMaterials.has(key)) {
        const material = original.clone();
        const url = livery?.textures[original.name];
        if (url) material.map = liveryTexture(url, original.map);
        else if (!livery && original.map && !original.transparent && model.id.startsWith('B73')) material.map = plainTexture(original.map);
        if (material.emissiveMap) glowingMaterials.add(material);
        lit(nightLighting(material, model.fin));
        liveryMaterials.set(key, material);
    }
    return liveryMaterials.get(key);
}

export function setNightGlow(value) {
    nightGlow.value = value;
    for (const material of glowingMaterials) material.emissive.setScalar(value * 1.2);
    for (const material of finMaterials.values()) material.emissive.copy(material.color).multiplyScalar(value * 0.45);
}

function realAirliner(model, livery, sizeClass) {
    const object = model.scene.clone();
    const seed = Math.random();
    object.traverse(o => {
        if (!o.isMesh) return;
        const windows = o.material.userData?.windows;
        o.material = paintedMaterial(o.material, model, livery);
        if (windows) o.material = lit(nightLighting(o.material.clone(), model.fin, seed));
    });
    const plane = withShadow(object, SIZE_SCALE[sizeClass] || 1, model.wheelbase);
    plane.userData.modelId = model.id;
    plane.userData.liveryName = livery?.name || '';
    plane.userData.doors = model.doors;
    // Its lights, all switched off until the sim says otherwise (steady ones show only after dark). Lights
    // whose color X-Plane sets at run time come through negative and would darken the scene, so they go.
    const kinds = { beacon: KIND.beacon, strobe: KIND.strobe, landing: KIND.landing };
    const list = model.lights.filter(l => l.color.every(c => c >= 0)).map(l => ({ pos: l.pos,
        color: l.color.map(c => c * (LIGHT_GAIN[l.type] ?? 1)), kind: kinds[l.type] ?? KIND.steady, size: LIGHT_SIZE[l.type] ?? 1.2 }));
    // X-Plane draws the nose gear taxi light from the gear animation, so the export leaves it out.
    list.push({ pos: [0, 1.05, -model.wheelbase - 0.3], color: TAXI_COLOR, kind: KIND.taxi, size: LIGHT_SIZE.taxi });
    return withLights(plane, object, list, seed, model.wheelbase);
}

const LIGHT_SIZE = { landing: 2.4, strobe: 3, beacon: 1.4, taxi: 4 };
// Strobes and the taxi light are far brighter than the position lights.
const LIGHT_GAIN = { strobe: 2.6, landing: 1.5 };
const TAXI_COLOR = [2.6, 2.5, 2.2];

/* For a model exported without lights: places the standard set from its own shape. Wingtips are its
   widest points, the beacons sit on the roof and belly ahead of the main gear, and the tail light at the
   back of the tail cone. Models have the main gear at the origin and the nose toward -z. */
function shapeOf(scene, wheelbase) {
    scene.updateMatrixWorld(true);
    const v = new THREE.Vector3(), points = [];
    scene.traverse(o => {
        if (!o.isMesh) return;
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i += 2) points.push(v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).toArray());
    });
    // Reduced rather than spread: a model has far more points than a call can take as arguments.
    const max = list => list.reduce((m, x) => Math.max(m, x), -Infinity), min = list => -max(list.map(x => -x));
    const span = max(points.map(p => Math.abs(p[0])));
    const tip = side => {
        const near = points.filter(p => p[0] * side > span * 0.985);
        return [side * span, near.reduce((a, p) => a + p[1], 0) / near.length, min(near.map(p => p[2]))];
    };
    const midZ = -wheelbase * 0.3;
    const body = points.filter(p => Math.abs(p[0]) < 0.4 && Math.abs(p[2] - midZ) < wheelbase * 0.1);
    const top = max(body.map(p => p[1])), belly = min(body.filter(p => p[1] > 0.6).map(p => p[1]));
    // The tail cone, not the fin above it, which sweeps back farther.
    const cone = points.filter(p => Math.abs(p[0]) < 0.5 && p[1] < top);
    const tailZ = max(cone.map(p => p[2]));
    const tailY = cone.filter(p => p[2] > tailZ - 0.5).reduce((a, p, _, all) => a + p[1] / all.length, 0);
    // The fin: everything on the centerline above the roof. Logo lights on the stabilizer light its lower part.
    const fin = points.filter(p => Math.abs(p[0]) < 0.6 && p[1] > top + 0.3);
    const finTop = max(fin.map(p => p[1])), logoY = top + (finTop - top) * 0.4;
    const atLogo = fin.filter(p => Math.abs(p[1] - logoY) < 0.6);
    const logoZ = atLogo.reduce((a, p) => a + p[2], 0) / atLogo.length;
    return { span, left: tip(-1), right: tip(1), midZ, top, belly, tailZ, tailY,
        fin: fin.length ? new THREE.Vector4(logoY, logoZ, (finTop - top) * 0.6, top - 0.3) : null };
}

function lightsFromShape({ left, right, midZ, top, belly, tailZ, tailY }) {
    const halfWidth = (top - belly) / 2, rootY = belly + halfWidth * 0.4;
    return [
        { type: 'beacon', color: [1, 0, 0], pos: [0, top + 0.15, midZ] },
        { type: 'beacon', color: [1, 0, 0], pos: [0, belly - 0.15, midZ * 0.4] },
        { type: 'nav', color: [0.9, 0.03, 0], pos: [left[0] - 0.1, left[1], left[2] + 0.3] },
        { type: 'nav', color: [0, 0.9, 0.3], pos: [right[0] + 0.1, right[1], right[2] + 0.3] },
        { type: 'strobe', color: [0.85, 0.85, 1], pos: [left[0] - 0.1, left[1], left[2] + 0.7] },
        { type: 'strobe', color: [0.85, 0.85, 1], pos: [right[0] + 0.1, right[1], right[2] + 0.7] },
        { type: 'nav', color: [0.95, 0.82, 0.72], pos: [0, tailY, tailZ + 0.1] },
        { type: 'strobe', color: [1, 1, 1], pos: [0, tailY, tailZ + 0.2] },
        { type: 'landing', color: [0.9, 0.9, 1], pos: [-(halfWidth + 0.9), rootY, midZ * 0.75] },
        { type: 'landing', color: [0.9, 0.9, 1], pos: [halfWidth + 0.9, rootY, midZ * 0.75] }
    ];
}

// The placeholder's lights in its A320 meters: red beacons on top and under the belly, red (left) and
// green (right) wingtip lights with white strobes and white tail lights, wing root landing lights, and
// the taxi light on the nose gear.
const PLACEHOLDER_LIGHTS = [
    { pos: [0, 5.25, -2], color: [1, 0, 0], kind: KIND.beacon, size: LIGHT_SIZE.beacon },
    { pos: [0, 1.15, -1], color: [1, 0, 0], kind: KIND.beacon, size: LIGHT_SIZE.beacon },
    { pos: [-17.95, 3.9, 3.9], color: [0.9, 0.03, 0], kind: KIND.steady, size: 1.2 },
    { pos: [17.95, 3.9, 3.9], color: [0, 0.9, 0.3], kind: KIND.steady, size: 1.2 },
    { pos: [-17.95, 3.9, 5.3], color: [0.95, 0.82, 0.72], kind: KIND.steady, size: 1.2 },
    { pos: [17.95, 3.9, 5.3], color: [0.95, 0.82, 0.72], kind: KIND.steady, size: 1.2 },
    { pos: [-18.05, 3.9, 4.3], color: [2.2, 2.2, 2.6], kind: KIND.strobe, size: LIGHT_SIZE.strobe },
    { pos: [18.05, 3.9, 4.3], color: [2.2, 2.2, 2.6], kind: KIND.strobe, size: LIGHT_SIZE.strobe },
    { pos: [0, 3.65, 20.1], color: [2.6, 2.6, 2.6], kind: KIND.strobe, size: LIGHT_SIZE.strobe },
    { pos: [-2.6, 2.3, -3.4], color: [1.35, 1.35, 1.5], kind: KIND.landing, size: LIGHT_SIZE.landing },
    { pos: [2.6, 2.3, -3.4], color: [1.35, 1.35, 1.5], kind: KIND.landing, size: LIGHT_SIZE.landing },
    { pos: [0, 1.3, -12.85], color: TAXI_COLOR, kind: KIND.taxi, size: LIGHT_SIZE.taxi }
];

// Adds lights to a model, everything but the steady ones switched off, and keeps their switches on the plane.
function withLights(plane, model, list, seed, wheelbase) {
    const lights = makeLights(list.map(l => ({ ...l, phase: seed })), lightMaterial([0, 0, 0, 1]));
    model.add(lights);
    plane.userData.lights = lights.material.uniforms;
    plane.userData.pool = taxiPool(plane, wheelbase);
    return plane;
}

/* The patch of pavement the taxi light lights up ahead of the nose: brightest just ahead, spreading and
   fading forward. It rides on the ground shadow, so it stays on the pavement. */
const poolGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, -0.5);
function taxiPool(plane, wheelbase) {
    const material = new THREE.ShaderMaterial({
        uniforms: { uI: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform float uI; varying vec2 vUv;
            void main() {
                float y = vUv.y, x = (vUv.x - 0.5) * 2.0 / (0.3 + 0.7 * y);
                float glow = exp(-x * x * 2.5) * smoothstep(0.0, 0.1, y) * (1.0 - smoothstep(0.3, 1.0, y));
                gl_FragColor = vec4(vec3(1.0, 0.93, 0.8) * glow * uI, 1.0);
            }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
    const pool = new THREE.Mesh(poolGeometry, material);
    const shadow = plane.userData.shadow, k = shadow.scale.x;
    pool.scale.set(20 / k, 1, 55 / k);
    pool.position.set(0, 0.01, -(wheelbase + 3) / k);
    pool.renderOrder = LAYER.shadow + 1;
    pool.visible = false;
    shadow.add(pool);
    return material.uniforms.uI;
}

// Wingspan scale against an A320 for each ICAO aerodrome size class.
export const SIZE_SCALE = { A: 0.35, B: 0.62, C: 1, D: 1.35, E: 1.75, F: 2.05 };
export const WHEELBASE_M = 12.6;      // A320, nose gear to main gear.

export const AIRLINES = {
    AAL: { name: 'American', tail: 0xb7bcc2, stripe: 0xc8102e }, DAL: { name: 'Delta', tail: 0x0a2240, stripe: 0xc8102e },
    UAL: { name: 'United', tail: 0x0b2d6b, stripe: 0x0b2d6b }, JBU: { name: 'JetBlue', tail: 0x1c3f94, stripe: 0x1c3f94 },
    SWA: { name: 'Southwest', tail: 0x304cb2, stripe: 0xe8b923 }, ASA: { name: 'Alaska', tail: 0x01426a, stripe: 0x01426a },
    NKS: { name: 'Spirit', tail: 0xf5d800, stripe: 0x111111 }, BAW: { name: 'Speedbird', tail: 0x1c2b5a, stripe: 0xc8102e },
    JAL: { name: 'Japan Air', tail: 0xffffff, stripe: 0xc8102e }, EIN: { name: 'Shamrock', tail: 0x006a4e, stripe: 0x006a4e },
    TAP: { name: 'Air Portugal', tail: 0x2dbd4a, stripe: 0xc8102e }, ITA: { name: 'Itarrow', tail: 0x003b8e, stripe: 0x003b8e },
    UPS: { name: 'UPS', tail: 0x4a2a14, stripe: 0xf2b200 }, FDX: { name: 'FedEx', tail: 0x4d148c, stripe: 0xff6600 },
    ACA: { name: 'Air Canada', tail: 0x111111, stripe: 0xd22630 }, FFT: { name: 'Frontier', tail: 0x2e8540, stripe: 0x2e8540 }
};
export const PASSENGER_AIRLINES = ['AAL', 'DAL', 'UAL', 'JBU', 'SWA', 'ASA', 'NKS', 'ACA', 'FFT'];

let parts = null;

// Shapes are laid out in A320 meters with the main gear at the origin.
function buildParts() {
    const wingShape = (rootX, rootLE, rootChord, tipX, sweepM, tipChord) => {
        const s = new THREE.Shape();
        s.moveTo(rootX, rootLE); s.lineTo(tipX, rootLE + sweepM); s.lineTo(tipX, rootLE + sweepM + tipChord);
        s.lineTo(rootX, rootLE + rootChord); s.closePath();
        return s;
    };
    const flatWing = (shape, thickness) => {
        const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
        g.rotateX(Math.PI / 2);            // Shape (x, z) lies flat; thickness hangs below.
        return g;
    };
    // Mirroring turns triangles inside out, so swap two corners of each to face outward again.
    const flipWinding = g => {
        for (const attr of Object.values(g.attributes)) {
            const n = attr.itemSize, a = attr.array;
            for (let t = 0; t < a.length; t += 3 * n) for (let k = 0; k < n; k++) {
                const tmp = a[t + n + k]; a[t + n + k] = a[t + 2 * n + k]; a[t + 2 * n + k] = tmp;
            }
        }
        return g;
    };
    const mirrored = (g, dihedralDeg, y) => {
        const right = g.clone(); right.rotateZ(THREE.MathUtils.degToRad(dihedralDeg)); right.translate(0, y, 0);
        const left = flipWinding(g.clone().scale(-1, 1, 1)); left.rotateZ(THREE.MathUtils.degToRad(-dihedralDeg)); left.translate(0, y, 0);
        return [right, left];
    };

    const body = [];
    const cabin = new THREE.CylinderGeometry(2, 2, 24, 20); cabin.rotateX(Math.PI / 2); cabin.translate(0, 3.2, -1.6);
    const nose = new THREE.SphereGeometry(2, 20, 12); nose.scale(1, 1, 2.1); nose.translate(0, 3.2, -13.6);
    const tailcone = new THREE.CylinderGeometry(0.45, 2, 9.6, 20); tailcone.rotateX(Math.PI / 2); tailcone.translate(0, 3.65, 15.2);
    body.push(cabin, nose, tailcone);

    const wing = mirrored(flatWing(wingShape(1.8, -3.6, 6.5, 17.9, 7.4, 1.6), 0.35), 5, 2.4);
    const stab = mirrored(flatWing(wingShape(0.9, 13.2, 3.6, 6.3, 3.4, 1.4), 0.2), 6, 4.1);
    const finShape = new THREE.Shape();
    finShape.moveTo(12.8, 4.6); finShape.lineTo(17.0, 11.3); finShape.lineTo(19.4, 11.3); finShape.lineTo(19.8, 4.6); finShape.closePath();
    const fin = new THREE.ExtrudeGeometry(finShape, { depth: 0.35, bevelEnabled: false });
    fin.rotateY(-Math.PI / 2); fin.translate(0.175, 0, 0);
    // The fin shape was drawn as (z, y); rotating maps it to x = -depth, z = shape x.

    const engines = [];
    for (const side of [-1, 1]) {
        const e = new THREE.CylinderGeometry(1.05, 0.85, 4.2, 18); e.rotateX(Math.PI / 2); e.translate(side * 5.8, 1.45, -5.4);
        const pylon = new THREE.BoxGeometry(0.3, 1.0, 3.2); pylon.translate(side * 5.8, 2.2, -4.6);
        engines.push(e, pylon);
    }
    const gear = [];
    const leg = (x, z, h) => { const g = new THREE.CylinderGeometry(0.12, 0.12, h, 6); g.translate(x, h / 2, z); return g; };
    const wheel = (x, z) => { const g = new THREE.CylinderGeometry(0.55, 0.55, 0.4, 12); g.rotateZ(Math.PI / 2); g.translate(x, 0.55, z); return g; };
    gear.push(leg(0, -12.6, 1.6), wheel(0, -12.6), leg(3.8, 0, 1.8), leg(-3.8, 0, 1.8),
        wheel(3.6, 0), wheel(4.0, 0), wheel(-3.6, 0), wheel(-4.0, 0));
    const windows = new THREE.BoxGeometry(1.6, 0.55, 0.9); windows.translate(0, 4.15, -16.0);

    // Ground shadow: fuselage, wings and stabilizer outlines that never overlap, so it darkens evenly.
    const shadowShapes = [];
    const rect = new THREE.Shape(); rect.moveTo(-2, -17.6); rect.lineTo(2, -17.6); rect.lineTo(2, 12); rect.lineTo(0.5, 20); rect.lineTo(-0.5, 20); rect.lineTo(-2, 12); rect.closePath();
    shadowShapes.push(rect);
    for (const side of [-1, 1]) {
        const w = new THREE.Shape(); w.moveTo(side * 2, -3.6); w.lineTo(side * 17.9, 3.8); w.lineTo(side * 17.9, 5.4); w.lineTo(side * 2, 2.9); w.closePath();
        const s = new THREE.Shape(); s.moveTo(side * 1.2, 13.4); s.lineTo(side * 6.3, 16.6); s.lineTo(side * 6.3, 18.0); s.lineTo(side * 0.9, 16.8); s.closePath();
        shadowShapes.push(w, s);
    }
    const shadow = new THREE.ShapeGeometry(shadowShapes);
    shadow.rotateX(Math.PI / 2);      // Shape y becomes +z, so the outline keeps the nose at -z.

    parts = {
        body: mergeGeometries(body), wings: mergeGeometries([...wing, ...stab]), fin, engines: mergeGeometries(engines),
        gear: mergeGeometries(gear), windows, shadow
    };
}

const materials = new Map();
function material(color, options = {}) {
    const key = `${color}-${JSON.stringify(options)}`;
    if (!materials.has(key)) materials.set(key, lit(new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, ...options })));
    return materials.get(key);
}
// The placeholder's fin, lit by its logo lights at night.
const finMaterials = new Map();
function finMaterial(color) {
    if (!finMaterials.has(color)) finMaterials.set(color, lit(new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1 })));
    return finMaterials.get(color);
}

// Drawn after everything solid but depth-tested, so it darkens the ground and never the aircraft.
const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32,
    depthWrite: false, side: THREE.DoubleSide });

export function makeAirliner({ sizeClass = 'C', airline = '' } = {}) {
    if (!parts) buildParts();
    const scale = SIZE_SCALE[sizeClass] || 1;
    const real = chooseModel(sizeClass, airline);
    if (real) return realAirliner(real.model, real.livery, sizeClass);
    const livery = AIRLINES[airline] || { tail: 0x8a96a3, stripe: 0x8a96a3 };
    const plane = new THREE.Group();
    const model = new THREE.Group();
    const meshes = [
        new THREE.Mesh(parts.body, material(0xf3f4f5)),
        new THREE.Mesh(parts.wings, material(0xb9bec4)),
        new THREE.Mesh(parts.fin, finMaterial(livery.tail)),
        new THREE.Mesh(parts.engines, material(livery.stripe === livery.tail ? 0xd5d8dc : livery.stripe)),
        new THREE.Mesh(parts.gear, material(0x2a2a2a)),
        new THREE.Mesh(parts.windows, material(0x111820, { roughness: 0.2 }))
    ];
    for (const m of meshes) { m.castShadow = true; model.add(m); }
    model.scale.setScalar(scale);
    return withLights(withShadow(model, scale, WHEELBASE_M * scale), model, PLACEHOLDER_LIGHTS, Math.random(), WHEELBASE_M * scale);
}

function withShadow(model, scale, wheelbase) {
    const plane = new THREE.Group();
    plane.add(model);
    plane.rotation.order = 'YXZ';

    const shadow = new THREE.Mesh(parts.shadow, shadowMaterial);
    shadow.scale.setScalar(scale);
    shadow.rotation.order = 'YXZ';
    shadow.renderOrder = LAYER.shadow;
    shadow.position.y = 0.05;
    plane.userData = { shadow, model, wheelbase, scale };
    return plane;
}

// Switches an airliner's lights. Steady lights (nav, logo) are always on.
export function setAircraftLights(plane, { beacon = false, strobe = false, landing = false, taxi = false } = {}) {
    const lights = plane.userData.lights;
    if (!lights) return;
    lights.uOn.value.set(beacon ? 1 : 0, strobe ? 1 : 0, landing ? 1 : 0, 1);
    lights.uTaxi.value = taxi ? 1 : 0;
    // The pool shows mostly at night and goes once the wheels leave the pavement.
    const pool = plane.userData.pool, onGround = plane.position.y < 3;
    pool.value = taxi && onGround ? 0.08 + 0.5 * lightUniforms.uDark.value : 0;
    plane.userData.shadow.children[0].visible = pool.value > 0;
}

// Places a plane by its main gear position (local meters) and heading, keeping its shadow under it.
export function placeAirliner(plane, x, z, heading, altitude = 0, pitchDeg = 0) {
    const yaw = -THREE.MathUtils.degToRad(heading);
    plane.position.set(x, altitude, z);
    plane.rotation.set(THREE.MathUtils.degToRad(pitchDeg), yaw, 0);
    const shadow = plane.userData.shadow;
    shadow.position.set(x + altitude * 0.35, 0.05, z + altitude * 0.25);
    shadow.rotation.y = yaw;
    shadow.visible = altitude < 600;
}
