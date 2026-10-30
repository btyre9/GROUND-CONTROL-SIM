/* OpenATC Ramp: one gate at Logan, an arriving 737, and the ramp crew who park it, make it safe and
   service it. The trainee plays one crew role, walking the ramp with WASD and doing that role's steps;
   the sim does everyone else's, following the scenario (ramp/scenarios/*.json) and ramp/procedures.js,
   which checks every action against the safety rules and keeps the score. */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { lightUniforms } from '../lights.js';
import { makeAirliner, placeAirliner, loadModels, setNightGlow, setAircraftLights, setAircraftEnvironment } from '../aircraft-model.js';
import { SkyDome } from '../sky.js';
import { STAND, AIRCRAFT, B737_POINTS, aircraftPoint, leadIn, pathAt } from './layout.js';
import { buildStand } from './stand.js';
import { JetBridge } from './jetway.js';
import { Person, setCrewDark, loadCrewModels } from './crew.js';
import { Atmosphere, WEATHER, patchObject, U as atmosphereUniforms } from './atmosphere.js';
import { chockPair, cone, BeltLoader, Mover, loadVehicleModels, bag, setGseDark } from './gse.js';

const R = window.RampProcedures;
const $ = id => document.getElementById(id);
const LOGAN = { lat: 42.3656, lon: -71.0096 };

/* ---------- Rendering ---------- */

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('three').appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.domElement.className = 'labels';
$('three').appendChild(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa8c6e3);
// Sky, fog, clouds, rain and snow (sets scene.fog, whose look comes from atmosphere's uniforms).
const atmosphere = new Atmosphere(scene);
const sky = new THREE.HemisphereLight(0xdfeaff, 0x77736a, 1.4);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
// The sun's shadows cover the stand only, so they stay sharp.
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -75, right: 75, top: 75, bottom: -75, near: 10, far: 900 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sky, sun, sun.target);
sun.target.position.set(0, 0, 15);
const skyDome = new SkyDome(scene);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 60000);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.maxPolarAngle = THREE.MathUtils.degToRad(88);
orbit.minDistance = 3;
orbit.maxDistance = 400;
orbit.enabled = false;

// What surrounds the aircraft, as image-based lighting: the sky by day, the floodlit apron at night.
const surroundings = new THREE.Scene();
const surroundMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, bottom: { value: new THREE.Color() } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top, horizon, bottom; varying vec3 vDir;
        void main() {
            float y = vDir.y;
            vec3 c = y > 0.0 ? mix(horizon, top, smoothstep(0.0, 0.45, y)) : mix(horizon, bottom, smoothstep(0.0, 0.2, -y));
            gl_FragColor = vec4(c, 1.0);
        }`
});
surroundings.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), surroundMaterial));
const pmrem = new THREE.PMREMGenerator(renderer);
let surroundTarget = null;

let composer = null, bloom = null;
function buildComposer() {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.15, 0.45, 1.0);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
}
function resize() {
    const { clientWidth: w, clientHeight: h } = $('three');
    if (!w || !h) return;
    renderer.setSize(w, h);
    if (!composer) buildComposer();
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    bloom.resolution.set(w / 2, h / 2);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

/* ---------- Time of day ---------- */

const world = { dark: 0 };
function timeFor(choice) {
    const now = new Date(), h = 3600000;
    const rise = window.Astro.sunCrossing(now, LOGAN.lat, LOGAN.lon, true);
    const set = window.Astro.sunCrossing(now, LOGAN.lat, LOGAN.lon, false);
    if (!rise || !set) return now;
    return new Date({ morning: +rise + 2.5 * h, noon: (+rise + +set) / 2, afternoon: +set - 3 * h,
        sunset: +set - 0.1 * h, dusk: +set + 0.4 * h, night: +set + 3 * h }[choice] ?? +now);
}

function applyLight(date = world.date) {
    world.date = date;
    const L = skyDome.update({ date, lat: LOGAN.lat, lon: LOGAN.lon, cover: 0, clouded: false, camera });
    const look = atmosphere.update(L, skyDome);
    world.dark = L.dark;
    scene.background.copy(look.background);
    // Under cloud the sky light is softer but fills in more; the sun dims with the cover.
    sky.color.copy(L.skyColor).lerp(new THREE.Color(0xc8ced6), look.clouded ? 0.7 : 0);
    sky.groundColor.copy(L.groundColor); sky.intensity = L.skyIntensity * (look.clouded ? 1.2 : 1);
    sun.color.copy(L.sunColor); sun.intensity = L.sunIntensity * look.sun;
    sun.position.copy(L.sunDir).multiplyScalar(400).add(sun.target.position);
    // At night the floodlights take over: no sun shadows from below the horizon or under overcast.
    sun.castShadow = L.sun.elevation > 2 && look.sun > 0.3;
    const u = surroundMaterial.uniforms, k = L.dark;
    if (look.clouded) {
        // What the aircraft reflect: the gray sky all round.
        u.top.value.copy(atmosphereUniforms.uFogZenith.value);
        u.horizon.value.copy(atmosphereUniforms.uFogHorizon.value).lerp(new THREE.Color(0xfff0dc).multiplyScalar(1.5), k * 0.6);
    } else {
        u.top.value.copy(L.skyColor).multiplyScalar(0.8).lerp(new THREE.Color(0x0b0e16), k);
        u.horizon.value.copy(L.horizon).lerp(new THREE.Color(0xfff0dc).multiplyScalar(1.5), k);
    }
    u.bottom.value.copy(L.groundColor).lerp(new THREE.Color(0x77716a), k);
    // Lights spread into halos in rain, snow and fog.
    lightUniforms.uHaze.value = Math.min(1, atmosphere.weather.haze * 1.2);
    lightUniforms.uFogFar.value = atmosphere.weather.visibility < 10000 ? atmosphere.weather.visibility * 1.3 : 1e6;
    surroundTarget?.dispose();
    surroundTarget = pmrem.fromScene(surroundings, 0, 0.1, 100);
    setAircraftEnvironment(surroundTarget.texture, 0.25 + 0.75 * k);
    scene.environment = surroundTarget.texture;
    scene.environmentIntensity = 0.25 + 0.3 * k;
    lightUniforms.uDark.value = k;
    if (bloom) { bloom.strength = 0.1 + k * 0.8; bloom.threshold = 1.0 - k * 0.25; }
    setNightGlow(k);
    setCrewDark(k);
    setGseDark(k);
    stand?.setDark(k, false);
    for (const b of bridges) b.setDark(k);
    $('clock').textContent = `${date.toISOString().slice(11, 16).replace(':', '')}Z`;
}

/* ---------- The ramp ---------- */

let stand = null;
const bridges = [];
let bridge = null;
const gse = { models: {}, beltLoader: null, tug: null, train: null, chocks: [], cones: [] };
const crew = {};
const path = leadIn(STAND);
let doorModel = false;

async function buildWorld() {
    stand = buildStand(scene);
    // This gate's bridge, stowed with its wheels in the parking box, and the neighbors' bridges.
    bridge = new JetBridge({ rotunda: STAND.rotunda, floor: STAND.concourseFloor, facadeZ: STAND.facadeZ });
    scene.add(bridge.group);
    bridges.push(bridge);
    stowBridge();

    const [ids, models] = await Promise.all([
        loadModels({ B739: 'models/B739-doors.glb' }).catch(() => []),
        loadVehicleModels()
    ]);
    gse.models = models;
    doorModel = ids.includes('B739');

    // The gates either side: a parked 737 with its bridge on.
    for (const dx of STAND.neighbors) {
        const b = new JetBridge({ rotunda: { x: STAND.rotunda.x + dx, z: STAND.rotunda.z }, floor: STAND.concourseFloor, facadeZ: STAND.facadeZ });
        scene.add(b.group);
        bridges.push(b);
        const plane = makeAirliner({ sizeClass: 'C', airline: dx < 0 ? 'ASA' : 'AAL' });
        const type = plane.userData.modelId || 'B739';
        const a = AIRCRAFT[type] || AIRCRAFT.B739;
        placeAirliner(plane, STAND.stop.x + dx, STAND.stop.z + a.wheelbase, 0);
        shadows(plane);
        patchObject(plane, { snow: false });
        scene.add(plane);
        const door = aircraftPoint(type, { x: STAND.stop.x + dx, z: STAND.stop.z }, 0, B737_POINTS.doorL1);
        b.pose = b.poseForDoor(door, 0);
        b.update(0);
        b.connectGpu(aircraftPoint(type, { x: STAND.stop.x + dx, z: STAND.stop.z }, 0, B737_POINTS.groundPower));
        b.connectPca(aircraftPoint(type, { x: STAND.stop.x + dx, z: STAND.stop.z }, 0, B737_POINTS.pcaPort));
        for (const p of [aircraftPoint(type, { x: dx, z: 0 }, 0, { x: 0, fromNoseGear: 0 })]) {
            const c = chockPair(0.9); c.position.set(p.x, 0, p.z); scene.add(c);
        }
    }

    // Belt loader, tug and baggage train in their staging boxes.
    gse.beltLoader = new BeltLoader();
    scene.add(gse.beltLoader.group);
    if (models.tug) {
        gse.tug = models.tug.clone();
        const m = new Mover(gse.tug); m.place(STAND.gse.tug.x, STAND.gse.tug.z, STAND.gse.tug.heading);
        scene.add(gse.tug);
    }
    if (models['baggage-tractor'] && models['baggage-cart']) {
        const tractor = models['baggage-tractor'].clone();
        const carts = [0, 1, 2].map(() => models['baggage-cart'].clone());
        gse.train = { tractor, carts, mover: new Mover(tractor), track: [] };
        scene.add(tractor, ...carts);
    }
    scene.add(hazardZones);
    // Everything built so far (stand, bridges, vehicles) takes the weather, snow included.
    patchObject(scene);
}

function shadows(object) {
    object.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
}

function stowBridge() {
    // Drive wheels in the parking box: the drive column stands 3.4 m back from the cab's turning point.
    const p = STAND.bridgePark, r = STAND.rotunda;
    const heading = (Math.atan2(p.x - r.x, -(p.z - r.z)) * 180 / Math.PI + 360) % 360;
    bridge.pose = { heading, length: Math.hypot(p.x - r.x, p.z - r.z) + 3.4, cabHeight: 3.2, cabTurn: -60 };
    bridge.target = null;
    bridge.connectGpu(null);
    bridge.connectPca(null);
    bridge.update(0);
}

/* Equipment left where it starts each run: chocks and cones on the rack, vehicles in their boxes. */
function resetEquipment() {
    for (const o of [...gse.chocks, ...gse.cones]) scene.remove(o);
    gse.chocks = [0, 1, 2].map((_, i) => { const c = chockPair(0.9); c.position.set(STAND.staging.x - 1.2 + i * 1.1, 0, STAND.staging.z); patchObject(c); scene.add(c); return c; });
    gse.cones = [0, 1, 2, 3, 4, 5].map((_, i) => { const c = cone(); c.position.set(STAND.staging.x + 0.6 + (i % 3) * 0.45, 0, STAND.staging.z - 0.4 + Math.floor(i / 3) * 0.6); patchObject(c); scene.add(c); return c; });
    const b = STAND.gse.beltLoader;
    gse.beltLoader.mover.place(b.x, b.z, b.heading);
    gse.beltLoader.mover.legs = [];
    gse.beltLoader.setTip(1.0);
    gse.beltLoader.running = false;
    if (gse.train) {
        const t = STAND.gse.bagTrain;
        gse.train.mover.place(t.x, t.z, t.heading);
        gse.train.mover.legs = [];
        gse.train.track = [];
        gse.train.carts.forEach((c, i) => { c.position.set(t.x, 0, t.z - 4.2 - i * 3.6); c.rotation.y = -t.heading * Math.PI / 180; });
    }
    for (const b2 of bags) scene.remove(b2.object);
    bags.length = 0;
}

/* ---------- The crew ---------- */

// Which crew model each role wears (models/crew/, made with tools/rocketbox_to_glb.py).
const CREW_MODELS = { marshaller: 'marshaller', wingwalkerL: 'wingwalker-1', wingwalkerR: 'wingwalker-2', lead: 'lead', bridge: 'agent', bin: 'wingwalker-1' };

async function buildCrew() {
    const rigged = await loadCrewModels([...new Set(Object.values(CREW_MODELS))]);
    const outfit = (role, options) => rigged ? { ...options, model: rigged.models[CREW_MODELS[role]], clips: rigged.clips } : options;
    const people = {
        marshaller: new Person('Marshaller', outfit('marshaller', { vest: 'orange', wands: true, label: 'MARSHAL' })),
        wingwalkerL: new Person('Wing walker L', outfit('wingwalkerL', { vest: 'lime', wands: true })),
        wingwalkerR: new Person('Wing walker R', outfit('wingwalkerR', { vest: 'lime', wands: true, cap: 'beanie' })),
        lead: new Person('Lead agent', outfit('lead', { vest: 'lime', headset: true, label: 'LEAD' })),
        bridge: new Person('Bridge operator', outfit('bridge', { vest: 'orange', headset: true, label: 'GATE', shirt: 0x34475c })),
        bin: new Person('Bin agent', outfit('bin', { vest: 'lime', cap: 'beanie' }))
    };
    for (const [role, p] of Object.entries(people)) {
        p.role = role;
        scene.add(p.group);
        const div = document.createElement('div');
        div.className = 'tag';
        div.textContent = p.name;
        p.tag = new CSS2DObject(div);
        p.tag.position.y = 2.15;
        p.group.add(p.tag);
        patchObject(p.group, { snow: false });
        crew[role] = p;
    }
}

function resetCrew() {
    // Everyone starts outside the ramp ops door, at the head of the walkway.
    let i = 0;
    for (const p of Object.values(crew)) {
        p.place(-35 + (i % 3) * 1.4, -16.5 - Math.floor(i / 3) * 1.4, 180);
        p.group.position.y = 0;
        p.group.visible = p.role !== 'bin';
        p.path = null; p.job = null; p.queue = []; p.crouch = 0; p.inCab = false;
        p.setSignal('idle');
        p.tag.element.classList.toggle('you', p.role === run?.role);
        p.tag.element.textContent = p.role === run?.role ? `${p.name} (you)` : p.name;
        i++;
    }
}

/* ---------- The arriving aircraft ---------- */

let aircraft = null;      // { plane, type, toStop, speed, nose, main, heading, stoppedFor, rpm, doors }

function spawnAircraft() {
    const plane = makeAirliner({ sizeClass: 'C', airline: run.scenario.aircraft.airline });
    const type = plane.userData.modelId && AIRCRAFT[plane.userData.modelId] ? plane.userData.modelId : 'B739';
    shadows(plane);
    patchObject(plane, { snow: false });
    scene.add(plane);
    const a = AIRCRAFT[type];
    const toStop = 205;
    const nose = pathAt(path, toStop), behind = pathAt(path, toStop + a.wheelbase);
    aircraft = { plane, type, a, toStop, speed: 5, nose, main: behind, heading: 270, stoppedFor: 0, rpm: 1, final: false };
    placeAircraft();
    setAircraftLights(plane, { beacon: true, taxi: true });
}

// The nose gear follows the line; the main gear trails behind it (as a real aircraft's does).
function placeAircraft() {
    const ac = aircraft;
    ac.nose = pathAt(path, ac.toStop);
    const dx = ac.nose.x - ac.main.x, dz = ac.nose.z - ac.main.z, d = Math.hypot(dx, dz) || 1;
    ac.main = { x: ac.nose.x - dx / d * ac.a.wheelbase, z: ac.nose.z - dz / d * ac.a.wheelbase };
    ac.heading = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
    placeAirliner(ac.plane, ac.main.x, ac.main.z, ac.heading);
}

const point = p => aircraftPoint(aircraft.type, aircraft.nose, aircraft.heading, p);

/* The flight crew: taxi on the lead-in line at the speed the marshaller (or the VDGS) asks for, and stop
   for any stop signal. Without guidance they hold rather than enter the stand. */
function flyPilot(dt) {
    const ac = aircraft, s = run.state;
    const vdgs = run.scenario.guidance === 'vdgs';
    let target;
    if (s.brakes || ac.final) target = 0;
    else if (wingwalkerStop) target = 0;
    else if (vdgs) target = ac.toStop > 40 ? 5 : ac.toStop > 14 ? 2.0 : ac.toStop > 3 ? 1.0 : ac.toStop > 0.25 ? 0.5 : 0;
    else if (ac.toStop > 48) target = ['this-way', 'come-ahead', 'slow'].includes(s.signal) || ac.toStop > 75 ? 5 : 0;
    else target = { 'come-ahead': 1.9, slow: 0.7 }[s.signal] ?? 0;
    // The crew stop by themselves just short of the terminal if nobody else stops them.
    if (ac.toStop < -3.5) target = 0;
    const decel = s.signal === 'emergency-stop' || wingwalkerStop ? 2.2 : 0.55;
    ac.speed = target < ac.speed ? Math.max(target, ac.speed - decel * dt) : Math.min(target, ac.speed + 0.35 * dt);
    ac.toStop -= ac.speed * dt;
    placeAircraft();
    setAircraftLights(ac.plane, { beacon: s.beacon, taxi: ac.speed > 0.05 && !s.brakes, strobe: false });
    // Engines spool down slowly after shutdown.
    ac.rpm = s.engines ? Math.min(1, ac.rpm + dt * 0.2) : Math.max(0, ac.rpm - dt / 22);

    // Events for the procedure.
    if (R.isReady(run, 'entering') && ac.toStop < 45) R.event(run, 'aircraft-entering');
    ac.stoppedFor = ac.speed < 0.01 ? ac.stoppedFor + dt : 0;
    const stopSignal = vdgs ? ac.toStop < 3 : ['stop', 'emergency-stop'].includes(s.signal) || ac.toStop < -3.5;
    const stopStep = run.steps.find(st => st.event === 'aircraft-stopped');
    if (!ac.final && stopStep?.status !== 'done' && ac.toStop < 10 && ac.stoppedFor > 3 && stopSignal) {
        ac.final = true;
        R.judgeStop(run, -ac.toStop);
        R.event(run, 'aircraft-stopped');
        if (vdgs) stand.vdgs.show({ mode: 'ok' });
    }
    // AI marshaller: slow down from a dozen meters out, stop so the nose gear rolls onto the bar.
    if (run.role !== 'marshaller' && !vdgs && s.aircraft === 'entering') {
        if (R.isReady(run, 'slow') && ac.toStop < 13) R.perform(run, 'signal-slow', 'marshaller');
        if (R.isReady(run, 'stop') && ac.toStop < ac.speed * ac.speed / (2 * 0.55) + 0.05) R.perform(run, 'signal-stop', 'marshaller');
    }
    // Docking guidance display.
    if (vdgs && !ac.final) {
        if (ac.toStop > 30) stand.vdgs.show({ mode: 'tracking', type: ac.type, distance: Math.min(99, ac.toStop) });
        else if (ac.toStop > 0.3) stand.vdgs.show({ mode: ac.speed > 1.6 && ac.toStop < 12 ? 'slow' : 'tracking', type: ac.type, distance: ac.toStop });
        else stand.vdgs.show({ mode: 'stop' });
    }
}

/* Doors on the door model: closed (0) is the shape itself, and each sampled value up to open (1) is a
   morph target named after it; between two samples the two are blended. */
function setDoor(name, value) {
    const plane = aircraft?.plane, door = plane?.userData.doors?.find(d => d.node === name);
    const node = door && plane.getObjectByName(name);
    if (!node) return false;
    const samples = door.samples;
    let i = 0;
    while (i < samples.length - 2 && samples[i + 1] < value) i++;
    const t = Math.max(0, Math.min(1, (value - samples[i]) / ((samples[i + 1] - samples[i]) || 1)));
    node.traverse(m => {
        if (!m.morphTargetInfluences) return;
        const at = value => m.morphTargetDictionary[String(value)];
        m.morphTargetInfluences.fill(0);
        if (at(samples[i]) !== undefined) m.morphTargetInfluences[at(samples[i])] = 1 - t;
        if (at(samples[i + 1]) !== undefined) m.morphTargetInfluences[at(samples[i + 1])] = t;
    });
    return true;
}
const doorAnims = [];
function openDoor(name, seconds, onDone) {
    doorAnims.push({ name, t: 0, seconds, onDone });
}

/* ---------- Jobs: what each action takes on the ramp ---------- */

/* Each job is a list of stages: walk to `at` (if given), work there for `work` seconds (crouched if
   `crouch`), then `run`. The sim's crew do them on their own; the trainee walks to each marked spot and
   presses E. Positions depend on where the aircraft actually stopped. */
function jobFor(action) {
    const ac = aircraft;
    const nose = ac?.nose, main = ac?.main;
    const stage = (at, label, extra = {}) => ({ at, label, work: 1, ...extra });
    const conePlaces = () => {
        const a = ac.a;
        const tail = point({ x: 0, fromNoseGear: a.length - a.noseAhead + 1.5 });
        return [
            point({ x: 5.0, fromMainGear: B737_POINTS.engines[1].inlet - 1.6 }),
            point({ x: 19.0, fromMainGear: B737_POINTS.wingtipFromMainGear }),
            tail,
            point({ x: -19.0, fromMainGear: B737_POINTS.wingtipFromMainGear }),
            point({ x: -5.0, fromMainGear: B737_POINTS.engines[0].inlet - 1.6 }),
            point({ x: 0, fromNoseGear: -a.noseAhead - 1.5 })
        ];
    };
    switch (action) {
        case 'fod-walk': return [[-12, 30], [12, 30], [12, 6], [-12, 6], [0, -3]].map(([x, z], i) =>
            stage({ x, z }, i < 4 ? 'FOD walk: check the stand' : 'FOD walk done', { work: 0.5, walkOnly: true }));
        case 'clear-stand': return [stage({ x: 6, z: 18 }, 'Check the ERA is clear of equipment')];
        case 'bridge-stowed': return [stage(bridge.stairsFoot(), 'Check the bridge is stowed in its box')];
        case 'stage-chocks-cones': return [stage({ x: STAND.staging.x, z: STAND.staging.z + 1.4 }, 'Check chocks and cones are staged')];
        case 'marshaller-position': return [stage(STAND.marshaller, 'Take the marshalling position', { face: 180 })];
        case 'wingwalkerL-position': return [stage(STAND.wingwalkerL, 'Take the left wingtip position', { face: 135 })];
        case 'wingwalkerR-position': return [stage(STAND.wingwalkerR, 'Take the right wingtip position', { face: 200 })];
        case 'chock-nose': {
            const p = point({ x: 0, fromNoseGear: 0 });
            return [stage({ x: STAND.staging.x - 1, z: STAND.staging.z + 1 }, 'Pick up chocks', { run: () => carry('chock') }),
                stage({ x: p.x + 1.1, z: p.z - 0.6 }, 'Chock the nose gear', { crouch: true, work: 2.5, run: () => placeChock(p) })];
        }
        case 'chock-mains': {
            const l = point({ x: -2.86, fromMainGear: 0 }), r = point({ x: 2.86, fromMainGear: 0 });
            // From the inboard side of each gear, clear of the engines' exhaust.
            const r2 = point({ x: 1.9, fromMainGear: -0.9 }), l2 = point({ x: -1.9, fromMainGear: -0.9 });
            return [stage(r2, 'Chock the right main gear', { crouch: true, work: 2.5, run: () => placeChock(r) }),
                stage(l2, 'Chock the left main gear', { crouch: true, work: 2.5, run: () => placeChock(l) })];
        }
        case 'cones-out': return [stage({ x: STAND.staging.x + 1, z: STAND.staging.z + 1 }, 'Pick up the cones'),
            ...conePlaces().map((p, i) => stage({ x: p.x + 0.6, z: p.z + 0.6 }, `Set cone ${i + 1} of 6`, { crouch: true, work: 0.8, run: () => placeCone(i, p) }))];
        case 'walkaround': {
            const a = ac.a;
            const ring = [[0, -a.noseAhead - 3], [6, 0], [20, a.wheelbase + 3], [6, a.wheelbase + 8], [0, a.length - a.noseAhead + 3],
                [-6, a.wheelbase + 8], [-20, a.wheelbase + 3], [-6, 0]];
            return ring.map(([x, back], i) => stage(point({ x, fromNoseGear: back }), `Walkaround: check for damage (${i + 1}/8)`, { work: 0.6, walkOnly: true }))
                .concat([stage(point({ x: 3, fromNoseGear: -a.noseAhead - 3 }), 'Walkaround done: give the crew a thumbs up', { signal: 'ok', work: 1.5 })]);
        }
        case 'bridge-dock': return [stage(bridge.stairsFoot(), 'Climb to the cab and drive the bridge to L1', { run: (p, done) => dockBridge(p, done), waits: true })];
        case 'door-open': return [stage(null, 'Knock on L1; the cabin crew open the door', { work: 2, signal: 'knock', run: (p, done) => { if (!openDoorOrSkip('door_L1', done)) done(); }, waits: true })];
        case 'gpu-connect': {
            const port = point(B737_POINTS.groundPower);
            const under = bridge.gpu.localToWorld(new THREE.Vector3(-1.1, 0, 0));
            return [stage({ x: under.x, z: under.z + 0.8 }, 'Lower the 400 Hz cable from the hoist'),
                stage({ x: port.x + 0.9, z: port.z - 0.4 }, 'Plug ground power into the receptacle', { work: 2, run: () => { bridge.connectGpu(port); } })];
        }
        case 'pca-connect': {
            const port = point(B737_POINTS.pcaPort);
            const basket = bridge.pca.localToWorld(new THREE.Vector3(0, 0, 0));
            return [stage({ x: basket.x, z: basket.z + 1.2 }, 'Pull the air hose out of its basket'),
                stage({ x: port.x - 1.1, z: port.z }, 'Connect the air hose to the belly connector', { crouch: true, work: 2.5, run: () => { bridge.connectPca(port); } })];
        }
        case 'beltloader-in': {
            const door = point(B737_POINTS.fwdCargo);
            return [stage({ x: door.x + 3.2, z: door.z - 2.5 }, 'Guide the belt loader to the forward hold', { signal: 'come-ahead', run: (p, done) => driveBeltLoader(door, p, done), waits: true })];
        }
        case 'unload': {
            const door = point(B737_POINTS.fwdCargo);
            return [stage({ x: door.x + 1.4, z: door.z + 1.3 }, 'Open the forward cargo door and start unloading', { work: 1, run: (p, done) => startUnload(door, done), waits: true })];
        }
        default: return [];
    }
}

function carry() { /* Chocks picked up: drawn when set down. */ }
let chocksPlaced = 0;
function placeChock(p) {
    const c = gse.chocks[chocksPlaced++ % gse.chocks.length];
    c.position.set(p.x, 0, p.z);
    c.rotation.y = -aircraft.heading * Math.PI / 180;
}
function placeCone(i, p) {
    const c = gse.cones[i];
    c.position.set(p.x, 0, p.z);
}

function dockBridge(person, done) {
    person.inCab = true;
    const door = point(B737_POINTS.doorL1);
    bridge.driveTo(bridge.poseForDoor(door, aircraft.heading), done);
}

function openDoorOrSkip(name, done) {
    if (!doorModel || !aircraft.plane.userData.doors?.length) return false;
    openDoor(name, 5, done);
    return true;
}

/* The belt loader drives up: to 6 m off, a brake check stop 3 m off, then creeps in to the sill. */
function driveBeltLoader(door, person, done) {
    const loader = gse.beltLoader;
    const heading = (aircraft.heading + 285) % 360;
    const h = heading * Math.PI / 180, dir = { x: Math.sin(h), z: -Math.cos(h) };
    loader.setTip(door.y + 0.05);
    const reach = loader.reach;
    const tip = { x: door.x + 0.2, z: door.z };
    const at = k => ({ x: tip.x - dir.x * (reach + k), z: tip.z - dir.z * (reach + k) });
    person.setSignal('come-ahead');
    loader.mover.drive([
        { ...at(9), speed: 2.2 }, { ...at(3), speed: 1.0, pause: 2.5 }, { ...at(0), speed: 0.3, heading }
    ], () => { person.setSignal('stop'); setTimeout(() => person.setSignal('idle'), 2500); done(); });
}

/* Unloading: the cargo door opens inward and up, the bin agent kneels in the hold and passes bags onto
   the belt, they ride down to the cart, and the baggage train draws up beside the belt. */
const bags = [];
let unloading = null;
function startUnload(door, done) {
    const finish = () => {
        const bin = crew.bin;
        bin.group.visible = true;
        bin.place(door.x - 1.0, door.z, (aircraft.heading + 90) % 360);
        bin.group.position.y = door.y;
        bin.crouch = 1;
        gse.beltLoader.running = true;
        unloading = { next: 1, left: 14, door };
        if (gse.train) {
            const loader = gse.beltLoader.group;
            const bottom = loader.localToWorld(new THREE.Vector3(1.6, 0, 3.8));
            gse.train.mover.drive([{ x: bottom.x + 6, z: bottom.z + 8, speed: 2.2 }, { x: bottom.x + 0.5, z: bottom.z + 1.5, speed: 1, heading: aircraft.heading }]);
        }
        done();
    };
    if (!openDoorOrSkip('fwd_cargo', finish)) finish();
}

function updateBags(dt) {
    if (!unloading) return;
    const boom = gse.beltLoader.boom;
    const top = boom.localToWorld(new THREE.Vector3(0, 0.2, -gse.beltLoader.length + 0.4));
    const bottom = boom.localToWorld(new THREE.Vector3(0, 0.2, -0.2));
    unloading.next -= dt;
    if (unloading.next <= 0 && unloading.left > 0) {
        const b = bag();
        b.position.copy(top);
        b.rotation.y = gse.beltLoader.group.rotation.y + (Math.random() - 0.5) * 0.4;
        patchObject(b, { snow: false });
        scene.add(b);
        bags.push({ object: b, s: 0, landed: false });
        unloading.next = 2.2 + Math.random();
        unloading.left--;
        crew.bin.crouch = 0.8 + Math.random() * 0.2;
    }
    const cart = gse.train?.carts[0];
    for (const b of bags) {
        if (b.landed) continue;
        b.s += dt * 0.9 / gse.beltLoader.length;
        if (b.s < 1) b.object.position.lerpVectors(top, bottom, b.s);
        else {
            b.landed = true;
            const n = bags.filter(x => x.landed).length - 1;
            const base = cart ? cart.position : bottom;
            b.object.position.set(base.x + ((n % 3) - 1) * 0.5, (cart ? 0.75 : 0) + Math.floor(n / 6) * 0.3, base.z + (Math.floor(n / 3) % 2 - 0.5) * 0.7);
        }
    }
    gse.beltLoader.running = bags.some(b => !b.landed) || unloading.left > 0;
}

// The baggage train's carts follow the tractor's track.
function updateTrain(dt) {
    const t = gse.train;
    if (!t) return;
    t.mover.update(dt);
    if (!t.mover.moving) return;
    const p = t.tractor.position;
    const last = t.track[t.track.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 0.25) t.track.push({ x: p.x, z: p.z });
    let need = 4.2;
    for (const cart of t.carts) {
        let d = 0;
        for (let i = t.track.length - 1; i > 0; i--) {
            d += Math.hypot(t.track[i].x - t.track[i - 1].x, t.track[i].z - t.track[i - 1].z);
            if (d >= need) {
                const a = t.track[i - 1], b = t.track[Math.min(t.track.length - 1, i + 3)];
                cart.position.set(a.x, 0, a.z);
                cart.rotation.y = Math.atan2(-(b.x - a.x), -(b.z - a.z));
                break;
            }
        }
        need += 3.6;
    }
}

/* ---------- Crew work ---------- */

// The sim's crew: take the due steps for their role and work through them in order.
function updateCrewWork() {
    for (const step of R.due(run)) {
        if (step.assigned) continue;
        step.assigned = true;
        if (step.role === 'pilot' || R.ACTIONS[step.action].signal) { R.perform(run, step.action, step.role); continue; }
        crew[step.role].queue.push(step);
    }
    for (const p of Object.values(crew)) {
        if (p === player || p.job || !p.queue.length) continue;
        startJob(p, p.queue.shift());
    }
}

function startJob(person, step) {
    person.job = { step, stages: jobFor(step.action), i: 0, waiting: false };
    nextStage(person);
}

function nextStage(person) {
    const job = person.job;
    const stage = job.stages[job.i];
    if (!stage) {
        R.perform(run, job.step.action, job.step.role);
        person.job = null;
        person.setSignal('idle');
        return;
    }
    const work = () => {
        if (stage.face !== undefined) person.place(person.position.x, person.position.z, stage.face);
        if (stage.signal) person.setSignal(stage.signal);
        person.crouch = stage.crouch ? 1 : 0;
        job.timer = stage.walkOnly ? 0.1 : stage.work;
        job.working = stage;
    };
    if (stage.at && !person.inCab) person.walkTo(stage.at.x, stage.at.z, work);
    else work();
}

// Called each frame for someone with a job: count down the work, then run the stage and move on.
function workJob(person, dt) {
    const job = person.job;
    if (!job?.working || job.waiting) return;
    job.timer -= dt;
    if (job.timer > 0) return;
    const stage = job.working;
    job.working = null;
    person.crouch = 0;
    const advance = () => { job.waiting = false; job.i++; if (person === player) return; nextStage(person); };
    if (stage.waits) { job.waiting = true; stage.run(person, advance); }
    else { stage.run?.(person); advance(); }
}

/* ---------- The trainee ---------- */

let player = null;
let wingwalkerStop = false;
const keys = new Set();
const view = { mode: 'follow', yaw: 200, pitch: 18, distance: 6.5 };
const marker = (() => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.05, 40), new THREE.MeshBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0.85, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05;
    const div = document.createElement('div'); div.className = 'spot';
    const label = new CSS2DObject(div); label.position.y = 1.6;
    const group = new THREE.Group(); group.add(ring, label); group.visible = false;
    scene.add(group);
    return { group, ring, div };
})();

// The trainee's current step: the one they picked, else the first of theirs that is ready.
let chosenStep = null;
function traineeStep() {
    if (chosenStep && chosenStep.status !== 'done') return chosenStep;
    chosenStep = null;
    return R.nextForTrainee(run).find(s => !R.ACTIONS[s.action].signal && !s.live) || null;
}

function updatePlayer(dt) {
    if (!player) return;
    if (!player.job) { const next = traineeStep(); if (next) startPlayerJob(next); }
    // A job in progress: working the current stage, or waiting for the bridge or loader.
    if (player.job?.working || player.job?.waiting) { workJob(player, dt); player.animate(dt); return; }
    if (player.inCab) { player.animate(dt); return; }
    const run2 = keys.has('shift') ? 2.6 : 1.4;
    let fx = 0, fz = 0;
    if (keys.has('w')) fz -= 1;
    if (keys.has('s')) fz += 1;
    if (keys.has('a')) fx -= 1;
    if (keys.has('d')) fx += 1;
    const len = Math.hypot(fx, fz);
    if (len) {
        // Relative to where the camera looks.
        const y = THREE.MathUtils.degToRad(view.yaw);
        const fwd = { x: -Math.sin(y), z: -Math.cos(y) }, right = { x: Math.cos(y), z: -Math.sin(y) };
        const dx = (fwd.x * -fz + right.x * fx) / len * run2 * dt, dz = (fwd.z * -fz + right.z * fx) / len * run2 * dt;
        player.moveBy(dx, dz, dt);
    } else player.moveBy(0, 0, dt);
}

// Where the trainee should go next, shown by the yellow ring; E does the stage when they are there.
function updatePrompt() {
    let text = '';
    marker.group.visible = false;
    if (!player || !run || run.finished) { $('prompt').innerHTML = ''; return; }
    if (player.job?.waiting) text = `${player.job.working?.label || player.job.stages[player.job.i]?.label || ''}…`;
    else if (player.job?.working) text = `${player.job.working.label}…`;
    else {
        const stage = player.job?.stages[player.job.i];
        if (stage) {
            const guided = $('guided').checked;
            const near = !stage.at || Math.hypot(stage.at.x - player.position.x, stage.at.z - player.position.z) < 2.2;
            if (stage.at && guided) {
                marker.group.visible = true;
                marker.group.position.set(stage.at.x, 0, stage.at.z);
                marker.div.textContent = stage.label;
                marker.ring.material.color.set(near ? 0x4fd1a5 : 0xf2c14e);
            }
            if (near) text = `Press <b>E</b>: ${stage.label}`;
            else if (guided) text = `Walk to the marker: ${stage.label}`;
        }
    }
    $('prompt').innerHTML = text;
}

const AT_AIRCRAFT = new Set(['chock-nose', 'chock-mains', 'cones-out', 'walkaround', 'bridge-dock', 'door-open', 'gpu-connect', 'pca-connect', 'beltloader-in', 'unload']);
function startPlayerJob(step) {
    // Steps at the aircraft can't start before it is on the stand.
    if (!aircraft && AT_AIRCRAFT.has(step.action)) return;
    player.job = { step, stages: jobFor(step.action), i: 0, waiting: false };
}

function interact() {
    const job = player?.job;
    if (!job || job.working || job.waiting) return;
    const stage = job.stages[job.i];
    if (!stage) return;
    if (stage.at && Math.hypot(stage.at.x - player.position.x, stage.at.z - player.position.z) > 2.2) return;
    if (stage.signal) player.setSignal(stage.signal);
    player.crouch = stage.crouch ? 1 : 0;
    job.timer = stage.work;
    job.working = stage;
    const after = () => {
        if (job.i >= job.stages.length) {
            R.perform(run, job.step.action, run.role);
            player.job = null;
            player.setSignal('idle');
        }
    };
    job.after = after;
}

// Signals the trainee gives with the number keys, depending on the role.
const SIGNAL_KEYS = {
    marshaller: [['1', 'signal-this-way', 'This way'], ['2', 'signal-come-ahead', 'Come ahead'], ['3', 'signal-slow', 'Slow'],
        ['4', 'signal-stop', 'Stop'], ['5', 'signal-emergency-stop', 'EMERG STOP'], ['6', 'signal-set-brakes', 'Set brakes'],
        ['7', 'signal-cut-engines', 'Cut engines'], ['8', 'signal-chocks-in', 'Chocks in']],
    wingwalker: [['4', 'stop', 'Stop'], ['5', 'emergency-stop', 'EMERG STOP'], ['9', 'all-clear', 'Wingtip clear']]
};
function signalKeys() {
    if (!run) return [];
    return run.role === 'marshaller' ? SIGNAL_KEYS.marshaller : run.role.startsWith('wingwalker') ? SIGNAL_KEYS.wingwalker : [];
}
function giveSignal(key) {
    const entry = signalKeys().find(k => k[0] === key);
    if (!entry || !player) return;
    if (run.role === 'marshaller') {
        R.perform(run, entry[1], 'marshaller');
    } else {
        // A wing walker's stop stops the aircraft; "clear" lets it go on.
        player.setSignal(entry[1]);
        wingwalkerStop = entry[1] !== 'all-clear';
        note(`${R.ROLES[run.role]}: ${entry[2]}`, wingwalkerStop ? 'warn' : 'ok');
    }
    renderSignals();
}
function renderSignals() {
    const el = $('signals');
    const list = signalKeys();
    el.classList.toggle('on', list.length > 0);
    const current = run?.role === 'marshaller' ? run.state.signal : player?.signal;
    el.innerHTML = list.map(([k, action, label]) => {
        const sig = R.ACTIONS[action]?.signal || action;
        return `<button data-key="${k}" class="${sig === current ? 'active' : ''}">${k} ${label}</button>`;
    }).join('');
}
$('signals').addEventListener('click', e => { const k = e.target.closest('button')?.dataset.key; if (k) giveSignal(k); });

function note(text, kind) { run.log.push({ t: run.t, text, kind }); }

/* ---------- Hazards the world reports ---------- */

const hazardZones = new THREE.Group();
hazardZones.visible = false;
function buildHazardZones() {
    hazardZones.clear();
    if (!aircraft) return;
    const red = new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.28, depthWrite: false });
    for (const e of B737_POINTS.engines) {
        const inlet = new THREE.Mesh(new THREE.CircleGeometry(3, 32), red);
        inlet.rotation.x = -Math.PI / 2; inlet.position.set(e.x, 0.06, e.inlet - 1.2);
        const exhaust = new THREE.Mesh(new THREE.PlaneGeometry(4, 45), red);
        exhaust.rotation.x = -Math.PI / 2; exhaust.position.set(e.x, 0.06, e.inlet + 4 + 22.5);
        hazardZones.add(inlet, exhaust);
    }
}

function inEngineZone(p) {
    if (!aircraft) return false;
    // Into the aircraft's frame: x right, z back from the main gear.
    const h = aircraft.heading * Math.PI / 180, dx = p.x - aircraft.main.x, dz = p.z - aircraft.main.z;
    const x = dx * Math.cos(h) + dz * Math.sin(h), z = -dx * Math.sin(h) + dz * Math.cos(h);
    return B737_POINTS.engines.some(e => Math.hypot(x - e.x, z - (e.inlet - 1.2)) < 3 ||
        (Math.abs(x - e.x) < 2 && z > e.inlet + 4 && z < e.inlet + 49));
}

function inEra(p) {
    const e = STAND.era;
    return p.x > e.x0 && p.x < e.x1 && p.z > e.z0 && p.z < e.z1;
}

function observeWorld(dt) {
    const s = run.state;
    const people = [];
    if (aircraft && aircraft.rpm > 0.3) {
        for (const p of Object.values(crew)) if (p.group.visible && !p.inCab && p.group.position.y < 0.5 && inEngineZone(p.position)) people.push(p === player ? `You (${p.name})` : p.name);
    }
    const equipment = [];
    if (aircraft && (s.beacon || aircraft.speed > 0.05)) {
        if (inEra(gse.beltLoader.group.position)) equipment.push('Belt loader');
        if (gse.train && inEra(gse.train.tractor.position)) equipment.push('Baggage tractor');
    }
    const before = run.violations.length;
    R.observe(run, { peopleNearEngines: people, equipmentInEra: equipment, aircraftMoving: aircraft?.speed > 0.05 }, dt);
    if (run.violations.length > before) flash(run.violations.at(-1).text);
}

let alertTimer = 0;
function flash(text) {
    $('alert').textContent = `⚠ ${text}`;
    $('alert').classList.add('on');
    alertTimer = 5;
}

/* ---------- Runs ---------- */

let run = null, scenarios = [], paused = false, speed = 1;

async function loadScenarios() {
    const ids = await (await fetch('ramp/scenario-list.json')).json();
    scenarios = await Promise.all(ids.map(async id => (await fetch(`ramp/scenarios/${id}.json`)).json()));
    $('scenario').innerHTML = scenarios.map((s, i) => `<option value="${i}">${s.title}</option>`).join('');
    fillRoles();
}

function fillRoles() {
    const scenario = scenarios[+$('scenario').value];
    const roles = ['observer', ...new Set(scenario.steps.map(s => s.role).filter(r => r && r !== 'pilot'))];
    $('role').innerHTML = roles.map(r => `<option value="${r}">${R.ROLES[r]}</option>`).join('');
    $('role').value = roles.includes('marshaller') ? 'marshaller' : roles.includes('lead') ? 'lead' : roles[1];
    $('brief').textContent = scenario.brief;
}
$('scenario').addEventListener('change', fillRoles);

function startRun() {
    const scenario = scenarios[+$('scenario').value];
    run = R.createRun(scenario, $('role').value);
    if (aircraft) { scene.remove(aircraft.plane); aircraft = null; }
    stowBridge();
    resetEquipment();
    resetCrew();
    chocksPlaced = 0;
    unloading = null;
    doorAnims.length = 0;
    wingwalkerStop = false;
    chosenStep = null;
    hazardZones.clear();
    stand.vdgs.show(scenario.guidance === 'vdgs' ? { mode: 'idle', text: 'B12' } : { mode: 'idle', text: '' });
    stand.vdgs.group.visible = scenario.guidance === 'vdgs';
    crew.marshaller.group.visible = scenario.steps.some(s => s.role === 'marshaller');
    player = crew[run.role] || null;
    $('weather').value = scenario.weather || 'clear';
    atmosphere.set($('weather').value);
    applyLight(timeFor(scenario.time));
    setView(player ? 'follow' : 'orbit');
    if (!player) { orbit.target.set(0, 2, 10); camera.position.set(45, 30, 60); }
    else view.yaw = 200;
    $('debrief').classList.remove('on');
    $('alert').classList.remove('on');
    renderSignals();
    renderPanel(true);
}
$('start').addEventListener('click', () => { startRun(); renderer.domElement.focus(); });

function finish() {
    const sc = R.score(run);
    const list = run.violations.map(v => `<li><b>${v.severity}</b> at ${fmt(v.t)}: ${v.text}</li>`).join('') || '<li>No violations. Clean turn.</li>';
    $('debrief-body').innerHTML = `<h3 class="${sc.passed ? 'pass' : 'fail'}">${sc.passed ? 'PASSED' : 'NOT PASSED'}: ${sc.value} / 100</h3>
        <p>${run.scenario.title}<br>Role: ${R.ROLES[run.role]} · Time ${fmt(run.t)}</p><ul>${list}</ul>
        <p><button id="again" class="primary">Run again</button> <button id="close-debrief">Keep looking around</button></p>`;
    $('debrief').classList.add('on');
    $('again').onclick = startRun;
    $('close-debrief').onclick = () => $('debrief').classList.remove('on');
}

const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

let panelKey = '';
function renderPanel(force = false) {
    if (!run) return;
    const key = run.steps.map(s => s.status).join() + run.log.length + run.role + (chosenStep?.id || '') + $('guided').checked;
    if (key === panelKey && !force) return;
    panelKey = key;
    const guided = $('guided').checked;
    $('steps').innerHTML = run.steps.map(s => {
        const ready = s.status !== 'done' && s.after.every(id => run.steps.find(x => x.id === id).status === 'done');
        const mine = s.role === run.role;
        const label = s.event ? `(${s.event.replace('aircraft-', 'aircraft ').replace('-', ' ')})` : R.ACTIONS[s.action].label;
        const hidden = !guided && mine && s.status !== 'done';
        return `<div class="step ${s.status} ${ready ? 'ready' : ''} ${mine ? 'mine' : ''} ${s.event ? 'event' : ''}" data-id="${s.id}">
            <span class="mark"></span><span>${hidden ? '· · ·' : label}</span><span class="who">${s.event ? '' : (R.ROLES[s.role] || '').split(' ')[0]}${s.doneAt !== null ? ' ' + fmt(s.doneAt) : ''}</span></div>`;
    }).join('');
    $('log').innerHTML = run.log.slice(-60).map(l => `<div class="${l.kind}">${fmt(l.t)} ${l.text}</div>`).join('');
    $('log').scrollTop = 1e6;
    $('score-value').textContent = R.score(run).value;
    const next = player && traineeStep();
    $('next').innerHTML = guided && next ? `Your next step: <b>${R.ACTIONS[next.action].label}</b>` : '';
}
$('steps').addEventListener('click', e => {
    const id = e.target.closest('.step')?.dataset.id;
    const step = run?.steps.find(s => s.id === id);
    // The trainee may pick any of their own steps, in or out of order (doing one early is logged).
    if (step && step.role === run.role && step.status !== 'done' && !player?.job?.working) {
        chosenStep = step;
        if (player) player.job = null;
    }
});
$('guided').addEventListener('change', () => renderPanel(true));

/* ---------- Views ---------- */

function setView(mode) {
    view.mode = mode === 'follow' && !player ? 'orbit' : mode;
    orbit.enabled = view.mode === 'orbit';
    if (view.mode === 'orbit' && player) orbit.target.copy(player.position).setY(1.5);
    $('view-btn').textContent = `View: ${{ follow: 'Follow', orbit: 'Orbit', pilot: 'Flight deck', cab: 'Bridge cab' }[view.mode]}`;
}
function cycleView() {
    const modes = ['follow', 'orbit', 'pilot', 'cab'].filter(m => (m !== 'follow' || player) && (m !== 'pilot' || aircraft));
    setView(modes[(modes.indexOf(view.mode) + 1) % modes.length]);
}
$('view-btn').addEventListener('click', cycleView);

function updateCamera(dt) {
    if (view.mode === 'follow' && player) {
        const y = THREE.MathUtils.degToRad(view.yaw), p = THREE.MathUtils.degToRad(view.pitch);
        const target = player.position.clone().add(new THREE.Vector3(0, 1.6, 0));
        target.y += player.group.position.y > 0.5 ? 0 : 0;
        camera.position.set(target.x + Math.sin(y) * Math.cos(p) * view.distance, target.y + Math.sin(p) * view.distance, target.z + Math.cos(y) * Math.cos(p) * view.distance);
        camera.lookAt(target);
    } else if (view.mode === 'orbit') {
        // WASD pans the orbit around the ramp when there is no one to walk.
        if (!player) {
            const v = new THREE.Vector3();
            camera.getWorldDirection(v); v.y = 0; v.normalize();
            const side = new THREE.Vector3(-v.z, 0, v.x);
            const k = 25 * dt;
            const move = new THREE.Vector3();
            if (keys.has('w')) move.addScaledVector(v, k);
            if (keys.has('s')) move.addScaledVector(v, -k);
            if (keys.has('d')) move.addScaledVector(side, k);
            if (keys.has('a')) move.addScaledVector(side, -k);
            camera.position.add(move); orbit.target.add(move);
        }
        orbit.update();
    } else if (view.mode === 'pilot' && aircraft) {
        // Captain's seat: left of the centerline, just behind the windshield.
        const eye = point({ x: -0.5, y: 0, fromNoseGear: -2.4 });
        const ahead = point({ x: -0.5, y: 0, fromNoseGear: -40 });
        camera.position.set(eye.x, 4.35, eye.z);
        camera.lookAt(ahead.x, 1.0, ahead.z);
    } else if (view.mode === 'cab') {
        const c = bridge.cab.localToWorld(new THREE.Vector3(-1.2, 1.65, -0.8));
        const f = bridge.cab.localToWorld(new THREE.Vector3(4, 0.8, 0.4));
        camera.position.copy(c); camera.lookAt(f);
    }
}

// Mouse: drag to look around the trainee, wheel to zoom.
let drag = null;
renderer.domElement.addEventListener('pointerdown', e => { if (view.mode === 'follow') drag = { x: e.clientX, y: e.clientY }; });
window.addEventListener('pointerup', () => { drag = null; });
window.addEventListener('pointermove', e => {
    if (!drag) return;
    view.yaw -= (e.clientX - drag.x) * 0.3;
    view.pitch = Math.max(-5, Math.min(75, view.pitch + (e.clientY - drag.y) * 0.25));
    drag = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('wheel', e => {
    if (view.mode !== 'follow') return;
    view.distance = Math.max(2.5, Math.min(40, view.distance * (e.deltaY > 0 ? 1.1 : 0.9)));
    e.preventDefault();
}, { passive: false });

window.addEventListener('keydown', e => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    keys.add(k === 'shift' ? 'shift' : k);
    if (k === 'e') interact();
    if (k === 'v') cycleView();
    if (k === 'h') toggleZones();
    if (k === 'p' || k === ' ') { togglePause(); e.preventDefault(); }
    if (/^[1-9]$/.test(k)) giveSignal(k);
});
window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase() === 'shift' ? 'shift' : e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function toggleZones() {
    hazardZones.visible = !hazardZones.visible;
    $('zones-btn').classList.toggle('primary', hazardZones.visible);
}
$('zones-btn').addEventListener('click', toggleZones);
function togglePause() { paused = !paused; $('pause-btn').textContent = paused ? 'Resume' : 'Pause'; }
$('pause-btn').addEventListener('click', togglePause);
$('speed').addEventListener('change', e => { speed = +e.target.value; });
$('weather').innerHTML = Object.entries(WEATHER).map(([id, w]) => `<option value="${id}">${w.label}</option>`).join('');
$('weather').addEventListener('change', e => { atmosphere.set(e.target.value); applyLight(); });

/* ---------- Main loop ---------- */

const clock = new THREE.Clock();
let simTime = 0, lightTimer = 0;

function step(dt) {
    simTime += dt;
    lightUniforms.uTime.value = simTime;
    // The world reports the aircraft once the stand is ready for it.
    if (R.isReady(run, 'in-sight') && !aircraft) {
        R.event(run, 'aircraft-in-sight');
        spawnAircraft();
        buildHazardZones();
    }
    if (aircraft) {
        flyPilot(dt);
        hazardZones.position.set(aircraft.main.x, 0, aircraft.main.z);
        hazardZones.rotation.y = -aircraft.heading * Math.PI / 180;
        hazardZones.children.forEach(m => { m.visible = aircraft.rpm > 0.3; });
    }
    updateCrewWork();
    for (const p of Object.values(crew)) {
        if (p === player) continue;
        if (p.job) workJob(p, dt);
        if (!p.inCab) p.update(dt); else p.animate(dt);
    }
    // The player's stage finishing: run it, then move on to the next.
    if (player?.job && !player.job.working && !player.job.waiting && player.job.after && player.job.lastI !== player.job.i) {
        player.job.lastI = player.job.i;
        player.job.after();
    }
    updatePlayer(dt);
    // Who is in the bridge cab rides with it.
    for (const p of Object.values(crew)) if (p.inCab) {
        const c = bridge.cab.localToWorld(new THREE.Vector3(0.6, 0, -1.0));
        p.group.position.copy(c);
    }
    // Signals shown by the marshaller and the wing walkers.
    const s = run.state;
    if (run.role !== 'marshaller') {
        const old = ['set-brakes', 'cut-engines', 'chocks-in'].includes(s.signal) && crew.marshaller.signalTime > 5;
        crew.marshaller.setSignal(s.crew.marshaller && s.signal && !old ? s.signal : 'idle');
    } else if (player) player.setSignal(s.signal && !(['chocks-in'].includes(s.signal) && player.signalTime > 5) ? s.signal : 'idle');
    for (const role of ['wingwalkerL', 'wingwalkerR']) {
        if (role === run.role || crew[role].job) continue;
        crew[role].setSignal(s.crew[role] && aircraft && aircraft.speed > 0.05 ? 'all-clear' : 'idle');
    }
    bridge.update(dt);
    gse.beltLoader.update(dt);
    updateTrain(dt);
    updateBags(dt);
    for (let i = doorAnims.length - 1; i >= 0; i--) {
        const d = doorAnims[i];
        d.t = Math.min(1, d.t + dt / d.seconds);
        setDoor(d.name, d.t);
        if (d.t >= 1) { doorAnims.splice(i, 1); d.onDone?.(); }
    }
    observeWorld(dt);
    if (run.finished && !run.debriefed && !unloading?.left) { run.debriefed = true; setTimeout(finish, 2500); }
}

function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, clock.getDelta());
    if (run && !paused) for (let i = 0; i < speed; i++) step(dt);
    if (alertTimer > 0 && (alertTimer -= dt) <= 0) $('alert').classList.remove('on');
    updatePrompt();
    updateCamera(dt);
    skyDome.follow(camera);
    lightUniforms.uScale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    atmosphere.tick(paused ? 0 : dt, camera, lightUniforms.uScale.value);
    if ((lightTimer += dt) > 1) { lightTimer = 0; renderPanel(); renderSignals(); }
    composer?.render();
    labels.render(scene, camera);
}

/* ---------- Start ---------- */

resize();
applyLight(timeFor('morning'));
camera.position.set(45, 30, 60);
orbit.target.set(0, 2, 10);
orbit.enabled = true;
await buildWorld();
await buildCrew();
await loadScenarios();
startRun();
$('loading').remove();
frame();
// For poking at the sim from the browser console.
// advance(seconds) fast-forwards the sim without waiting for frames (also works in a hidden tab).
window.ramp = { camera, orbit, get run() { return run; }, get aircraft() { return aircraft; }, crew, bridge, gse, setView, setDoor,
    advance(seconds) {
        for (let t = 0; t < seconds; t += 0.05) step(0.05);
        orbit.update();
        atmosphere.tick(Math.max(seconds, 0.016), camera, lightUniforms.uScale.value);
        composer.render(); labels.render(scene, camera);
    },
    atmosphere, setWeather(name, time) { $('weather').value = name; atmosphere.set(name); applyLight(time ? timeFor(time) : undefined); } };
