/* The tower: loads an X-Plane Scenery Gateway airport, builds it in 3D, parks airliners at the gates and
   hands you departures to push, taxi, cross and clear for takeoff. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { unzipSync, strFromU8 } from 'fflate';
import { buildAirport, buildStructures, setDarkness, setWet, LAYER } from './airport-scene.js';
import { buildImagery, imageryTint } from './imagery.js';
import { lightUniforms } from './lights.js';
import { makeAirliner, placeAirliner, loadModels, setNightGlow, setAircraftLights, PASSENGER_AIRLINES, AIRLINES } from './aircraft-model.js';
import { Departure, spokenRunway } from './ground-traffic.js';
import { GroundRadar } from './ground-radar.js';
import { AirportSound } from './sounds.js';
import { WeatherScene } from './weather.js';
import { SkyDome } from './sky.js';
import { Vehicles } from './vehicles.js';

const P = window.AptParser;
const $ = id => document.getElementById(id);

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Lights are drawn brighter than white into a floating-point image, ACES tone mapping brings them back
// to the screen without flattening them, and bloom spreads a glow around whatever is brightest.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
$('three').appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.domElement.className = 'labels';
$('three').appendChild(labels.domElement);

const scene = new THREE.Scene();
const SKY = 0xa8c6e3;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 5000, 26000);
const sky = new THREE.HemisphereLight(0xdfeaff, 0x77736a, 1.6);     // Sky above, sunlit pavement and grass below.
scene.add(sky);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
sun.position.set(-3000, 6000, 2500);

/* The sim's clock: the real time ("Now") or a time of day picked from the menu, worked out from that
   day's sunrise and sunset at the airport. It runs on with the sim, so the sun keeps moving. */
const clock = { date: new Date(), applied: 0 };
function setTimeOfDay(choice) {
    world.time = choice;
    const origin = world.airport?.origin, now = new Date();
    if (choice !== 'now' && origin) {
        const rise = window.Astro.sunCrossing(now, origin.lat, origin.lon, true);
        const set = window.Astro.sunCrossing(now, origin.lat, origin.lon, false);
        const h = 3600000;
        const at = rise && set ? {
            sunrise: +rise + 0.1 * h, morning: +rise + 2.5 * h, noon: (+rise + +set) / 2, afternoon: +set - 3 * h,
            sunset: +set - 0.1 * h, dusk: +set + 0.4 * h, night: +set + 3 * h
        }[choice] : +now;
        clock.date = new Date(at);
    } else clock.date = now;
    applyEnvironment();
}

/* Time of day and weather together: the sky and the light on the scene, fog distance from the
   visibility, how much sun gets through the clouds, wet ground, and airfield lights on after dark or in
   low visibility. */
function applyEnvironment() {
    const w = world.weather, cover = w?.cover || 0, wet = Boolean(w?.precip);
    const origin = world.airport?.origin || { lat: 42.36, lon: -71.0 };
    const thick = w && w.visibilityM < 5000;
    const L = skyDome.update({ date: clock.date, lat: origin.lat, lon: origin.lon, cover, clouded: cover >= 0.75 || thick, camera });
    // Haze at the horizon, grayed by cloud cover and thick weather.
    const overcast = new THREE.Color(0x9aa2ab).lerp(new THREE.Color(0x0b0d11), L.dark);
    scene.fog.color.copy(L.horizon).lerp(overcast, Math.min(1, cover * 0.9 + (thick ? 0.5 : 0)));
    // The fog's far edge sits a little past the reported visibility.
    const far = w ? Math.min(26000, Math.max(250, w.visibilityM * 1.3)) : 26000;
    scene.fog.far = far;
    scene.fog.near = Math.min(5000, far * 0.08);
    lightUniforms.uFogFar.value = w && w.visibilityM < 15000 ? far : 1e6;
    // Fog at night glows faintly with the airport's own lights.
    if (thick) scene.fog.color.lerp(new THREE.Color(0x3a3630), L.dark * (1 - w.visibilityM / 5000) * 0.6);
    scene.background.copy(scene.fog.color);
    sky.color.copy(L.skyColor); sky.groundColor.copy(L.groundColor); sky.intensity = L.skyIntensity * (1 - cover * 0.3);
    sun.color.copy(L.sunColor); sun.intensity = L.sunIntensity * (1 - cover * 0.8);
    sun.position.copy(L.sunDir).multiplyScalar(6000);
    imageryTint.setScalar((1 - L.dark * 0.82) * (wet ? 0.8 : 1));
    const lowVisibility = w && (w.visibilityM < 4800 || (w.ceilingFt !== null && w.ceilingFt < 1000));
    const dark = Math.max(L.dark, lowVisibility ? 0.6 : 0);
    lightUniforms.uDark.value = dark;
    // In fog, mist or rain, lights spread into halos.
    lightUniforms.uHaze.value = w ? Math.min(1, Math.max(0, 1 - w.visibilityM / 6000) + (w.precip ? 0.3 : 0) + (w.mist ? 0.2 : 0)) : 0;
    // Bloom: a faint sheen by day, a strong glow around lights at night.
    if (bloom) {
        bloom.strength = 0.12 + dark * 0.9;
        bloom.threshold = 1.0 - dark * 0.25;
        bloom.radius = 0.4 + lightUniforms.uHaze.value * 0.4;
    }
    setNightGlow(L.dark);
    weatherScene.setLight(L.dark, L.sunDir, L.sunColor, scene.fog.color);
    if (world.built) { setDarkness(world.built.group, L.dark); setWet(world.built.group, wet); }
    world.lighting = { sky: scene.background.clone(), skyIntensity: sky.intensity };
    clock.applied = +clock.date;
    const z = clock.date.toISOString().slice(11, 16).replace(':', '');
    $('clock').textContent = `${z}Z · sun ${Math.round(L.sun.elevation)}°`;
}
scene.add(sun);

const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 60000);
camera.rotation.order = 'YXZ';
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.maxPolarAngle = THREE.MathUtils.degToRad(86);
orbit.minDistance = 15;
orbit.maxDistance = 20000;
orbit.enabled = false;

const sound = new AirportSound(camera);
sound.load();
const skyDome = new SkyDome(scene);
const vehicles = new Vehicles(scene);
const weatherScene = new WeatherScene(scene);
weatherScene.onThunder = delay => sound.thunder(delay);

const world = { airport: null, built: null, graph: null, parked: new Map(), movers: [], selected: null };
let mode = 'tower';
const look = { yaw: 0, pitch: -8, fov: 45 };      // Tower view: where you're looking, in degrees.
let simSpeed = 1, nextRequest = 20, nextFlight = 1;
let paused = false, simClock = 0;      // Sim time in seconds; it stops while paused.

// If Chrome resets the graphics card (a heavy frame or a driver hiccup), say so and rebuild once it's back.
renderer.domElement.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    setMessage('Graphics were reset by the browser; restoring…');
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
    composer = null;
    resize();
    setMessage('Graphics restored.');
});

// Post-processing chain: the scene (HDR, 4x antialiased), bloom at half resolution, then tone mapping.
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
    radar?.resize();
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

/* The top-down map starts in the small window; Swap trades it with the 3D view. */
const radar = new GroundRadar($('radar'), world, dep => { world.selected = dep; renderStrips(); });
$('inset-body').appendChild($('radar'));
new ResizeObserver(resize).observe($('inset-body'));
$('swap').addEventListener('click', () => {
    const three = $('three'), map = $('radar'), inMain = map.parentElement === $('view');
    $(inMain ? 'inset-body' : 'view').prepend(map);
    $(inMain ? 'view' : 'inset-body').prepend(three);
    $('inset-title').textContent = inMain ? 'GROUND MAP' : '3D VIEW';
    $('inset').classList.remove('collapsed');
    resize();
});
$('map-style').addEventListener('click', e => {
    radar.style = radar.style === 'diagram' ? 'asde' : 'diagram';
    e.target.textContent = radar.style === 'diagram' ? 'ASDE-X' : 'Diagram';
});
$('inset-toggle').addEventListener('click', e => {
    $('inset').classList.toggle('collapsed');
    e.target.textContent = $('inset').classList.contains('collapsed') ? '+' : '–';
    resize();
});

/* ---------- Loading an airport ---------- */

// A Scenery Gateway pack: the airport layout (apt.dat) and the tiles placing its buildings (*.dsf).
function readPack(bytes) {
    const files = unzipSync(bytes, { filter: f => /(^|\/)apt\.dat$|\.dsf$/i.test(f.name) });
    const apt = Object.keys(files).find(n => /apt\.dat$/i.test(n));
    if (!apt) throw new Error('No apt.dat in that zip. Use a scenery pack from the X-Plane Scenery Gateway.');
    const tiles = [];
    for (const name of Object.keys(files).filter(n => /\.dsf$/i.test(n))) {
        try { tiles.push(window.DsfParser.parseDsf(files[name])); } catch (err) { console.warn(name, err.message); }
    }
    return { apt: strFromU8(files[apt]), tiles };
}

async function loadFromUrl(url) {
    setMessage(`Loading ${url}…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${url} (${res.status}).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    loadAirport(url.endsWith('.zip') ? readPack(bytes) : { apt: strFromU8(bytes), tiles: [] });
}

async function loadFromFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    loadAirport(/\.zip$/i.test(file.name) ? readPack(bytes) : { apt: strFromU8(bytes), tiles: [] });
}

function clearAirport() {
    if (world.built) scene.remove(world.built.group);
    for (const m of world.movers) removeMover(m);
    world.taxiwayLabels?.traverse(o => o.element?.remove());
    for (const plane of world.parked.values()) scene.remove(plane, plane.userData.shadow);
    world.parked.clear();
    world.movers = [];
}

function loadAirport({ apt, tiles }) {
    clearAirport();
    const airport = P.parseAptDat(apt);
    if (!airport.runways.length) throw new Error('That file has no runways.');
    world.airport = airport;
    world.facility = airport.meta.city || airport.name.split(' ')[0];
    world.graph = P.buildGraph(airport);
    world.built = buildAirport(airport);
    world.project = world.built.project;
    world.projection = world.built.projection;
    world.runways = world.built.runways;
    world.built.group.add(buildStructures(tiles, world.project));
    setTimeOfDay(world.time || $('time').value);
    radar.build(airport, world.project, tiles);
    weatherScene.addWindsocks(airport, world.project);
    vehicles.setAirport(airport, world.project);
    loadWeather($('weather').value);

    // Taxiway names floating over the taxiways, like the letters on the airport diagram.
    world.taxiwayLabels = new THREE.Group();
    for (const label of P.taxiwayLabels(airport, 450)) {
        const tag = document.createElement('div');
        tag.className = 'twy';
        tag.textContent = label.name;
        const object = new CSS2DObject(tag);
        const p = world.project(label);
        object.position.set(p.x, 4, p.z);
        world.taxiwayLabels.add(object);
    }
    world.taxiwayLabels.visible = $('taxiway-toggle').checked;
    world.built.group.add(world.taxiwayLabels);
    scene.add(world.built.group);

    $('airport-name').textContent = `${airport.icao} · ${airport.name}`;
    const select = $('runway');
    select.innerHTML = '';
    for (const end of airport.runways.flatMap(r => r.ends)) select.add(new Option(spokenRunway(end.name), end.name));
    const preferred = ['22R', '27', '04R'].find(n => airport.runways.some(r => r.ends.some(e => e.name === n)));
    if (preferred) select.value = preferred;

    parkAirliners();
    const center = world.runways.reduce((s, r) => ({ x: s.x + (r.a.x + r.b.x) / 2 / world.runways.length, z: s.z + (r.a.z + r.b.z) / 2 / world.runways.length }), { x: 0, z: 0 });
    world.center = center;
    loadTowerModel(airport, center);

    // Real ground around the airport from aerial photos; the plain grass returns if they can't load.
    const imagery = buildImagery(world.projection.toLatLon(center.x, center.z), world.projection, LAYER.imagery);
    world.built.group.add(imagery.group);
    world.built.grass.visible = false;
    imagery.done.then(({ loaded, total, credits }) => {
        if (world.airport !== airport) return;
        if (loaded < total / 2) world.built.grass.visible = true;
        $('credits').textContent = credits.length ? `Imagery: ${credits.join(' · ')}` : '';
    });
    const towerPos = world.built.tower || { x: center.x, y: 60, z: center.z + 1500 };
    look.yaw = (Math.atan2(center.x - towerPos.x, -(center.z - towerPos.z)) * 180 / Math.PI + 360) % 360;
    orbitView.target.set(center.x, 0, center.z);
    orbitView.position.set(center.x - 1800, 1400, center.z + 2200);
    if (mode === 'orbit') { camera.position.copy(orbitView.position); orbit.target.copy(orbitView.target); }
    setMode(mode);
    nextRequest = 3;
    const buildings = tiles.reduce((n, t) => n + t.polygons.filter(p => /\.fac$/.test(p.def || '')).length, 0);
    setMessage(`${airport.runways.length} runways · ${airport.gates.length} gates · ${airport.taxiEdges.length} taxiway segments · ${airport.jetways.length} jetways · ${buildings} building outlines`);
}

function parkAirliners() {
    for (const gate of window.RampLogic.chooseParked(world.airport.gates)) {
        const airline = gate.airlines.length ? gate.airlines[Math.floor(Math.random() * gate.airlines.length)] :
            gate.operation === 'cargo' ? 'FDX' : PASSENGER_AIRLINES[Math.floor(Math.random() * PASSENGER_AIRLINES.length)];
        const plane = makeAirliner({ sizeClass: gate.sizeClass || 'C', airline });
        const p = world.project(gate);
        const f = { x: Math.sin(gate.heading * Math.PI / 180), z: -Math.cos(gate.heading * Math.PI / 180) };
        const wb = plane.userData.wheelbase;
        placeAirliner(plane, p.x - f.x * wb, p.z - f.z * wb, gate.heading);
        plane.userData.airline = airline;
        scene.add(plane, plane.userData.shadow);
        world.parked.set(gate, plane);
    }
}

/* A tower built in Blender for this airport (models/<icao>-tower.glb) replaces the plain one, turned to
   face the airfield. Without a file the plain tower stays. */
async function loadTowerModel(airport, center) {
    const tower = world.built.tower;
    if (!tower) return;
    let gltf;
    try { gltf = await new GLTFLoader().loadAsync(`models/${airport.icao.toLowerCase()}-tower.glb`); } catch { return; }
    if (world.airport !== airport) return;
    const model = gltf.scene;
    model.position.set(tower.x, 0, tower.z);
    model.rotation.y = Math.atan2(center.x - tower.x, center.z - tower.z);     // Its front (+z) toward the field.
    model.traverse(o => { if (o.isMesh) o.castShadow = true; });
    tower.building.clear();
    tower.building.add(model);
}

/* ---------- Departures ---------- */

function requestDeparture() {
    const ready = [...world.parked.keys()].filter(g => g.kind === 'gate' && !world.movers.some(m => m.gate === g));
    if (!ready.length) return null;
    const gate = ready[Math.floor(Math.random() * ready.length)];
    const parked = world.parked.get(gate);
    const flight = 100 + ((nextFlight++ * 397) % 2800);
    const dep = new Departure(world, gate, parked.userData.airline, flight, parked);
    if (!dep.planRoute($('runway').value)) return null;
    world.parked.delete(gate);
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = dep.callsign;
    dep.label = new CSS2DObject(tag);
    dep.label.position.set(0, 16, 0);
    dep.label.visible = !world.tagsHidden;
    vehicles.attachTug(dep);
    dep.plane.add(dep.label);
    world.movers.push(dep);
    renderStrips();
    return dep;
}

function removeMover(dep) {
    dep.label?.element.remove();
    scene.remove(dep.plane, dep.plane.userData.shadow);
    if (world.selected === dep) world.selected = null;
}

// A strip button: the same clearance as saying it, so the pilot reads it back.
function act(dep, action) {
    const hold = dep.nextHold?.();
    const command = {
        push: { action: 'push' },
        taxi: { action: 'taxi', runway: dep.runwayEnd, via: [] },
        cross: { action: 'cross', runway: hold?.runway.split('/')[0] },
        luaw: { action: 'luaw', runway: dep.runwayEnd },
        takeoff: { action: 'takeoff', runway: dep.runwayEnd }
    }[action];
    issue(dep, [command]);
    if (dep.clearance) log(`ATC: ${dep.clearance}`, 'atc');
}

/* ---------- Radio: your clearances, typed or spoken, and the pilots' replies ---------- */

const pilotRadio = new window.PilotRadio(window.speechSynthesis, window.SpeechSynthesisUtterance,
    error => log(error, 'error'), window.RadioEffect ? new window.RadioEffect() : null);
const AIRLINE_LIST = Object.entries(AIRLINES).map(([id, a]) => ({ id, name: a.name }));

// Browsers only speak after you've clicked or typed something on the page.
function wakeVoices() {
    if ($('pilot-voice').checked && !pilotRadio.enabled) pilotRadio.setEnabled(true);
    if ($('sound').checked) { sound.start(); sound.setRain(world.weather?.precip === 'snow' ? 0 : world.weather?.intensity || 0); }
}
window.addEventListener('pointerdown', wakeVoices);
window.addEventListener('keydown', wakeVoices);

function pilotSay(text, dep) {
    log(`${dep.callsign}: ${text}`, 'pilot');
    pilotRadio.say(text, dep.callsign);
}

// Carries out a transmission's instructions; the pilot reads them all back in one reply.
function issue(dep, commands) {
    // Once one instruction can't be done, the pilot says so and doesn't go on with the rest.
    const replies = [];
    for (const command of commands) {
        const reply = dep.instruct(command);
        replies.push(reply);
        if (!reply.ok) break;
    }
    const tail = `, ${dep.spokenCallsign}`;
    const parts = [];
    for (const reply of replies) {
        const say = reply.say.endsWith(tail) ? reply.say.slice(0, -tail.length) : reply.say;
        // A taxi readback already includes its hold short; don't say it twice.
        if (!parts.some(p => p.toLowerCase().includes(say.toLowerCase()))) parts.push(parts.length ? say[0].toLowerCase() + say.slice(1) : say);
    }
    const text = parts.join(', ') + tail;
    world.selected = dep;
    pilotSay(text, dep);
    renderStrips();
}

/* Reads what you typed or said (several recognition guesses, best first) and sends it to the aircraft
   named, or the selected strip when no callsign was given. */
function handleTransmission(transcripts, typed) {
    let problem = null;
    for (const transcript of transcripts) {
        const parsed = window.GroundCommands.parse(transcript, { typed });
        if (parsed.error) { problem ??= parsed.error; continue; }
        let dep = world.selected;
        if (parsed.callsignWords.length) {
            const found = window.ATCVoice.resolveCallsign(parsed.callsignWords.join(' '),
                world.movers.map(m => ({ id: m.callsign })), AIRLINE_LIST);
            if (!found.ok) { problem ??= found.error; continue; }
            dep = world.movers.find(m => m.callsign === found.id);
        }
        if (!dep) { problem ??= 'Say the callsign, or select a flight strip first.'; continue; }
        log(`ATC: ${transcript}`, 'atc');
        issue(dep, parsed.commands);
        return true;
    }
    log(problem || 'Nothing was heard.', 'error');
    return false;
}

$('command').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    if (handleTransmission([e.target.value.trim()], true)) e.target.value = '';
});

// Microphone: keeps listening through short pauses and finishes 2.5 s after you stop talking.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!Recognition) {
    $('mic').disabled = true;
    $('mic').title = 'Speech recognition is unavailable in this browser (use Chrome). Typed commands still work.';
} else {
    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    let listening = false, heard = [], silence = null, limit = null;
    const stop = () => { if (listening) recognition.stop(); };
    $('mic').addEventListener('click', () => {
        wakeVoices();
        if (listening) { recognition.stop(); return; }
        pilotRadio.setListening(true);
        try { recognition.start(); } catch (error) { pilotRadio.setListening(false); log(`Microphone could not start: ${error.message}`, 'error'); }
    });
    recognition.onstart = () => {
        listening = true; heard = [];
        limit = setTimeout(stop, 20000);
        $('mic').textContent = 'LISTENING'; $('mic').classList.add('live');
    };
    recognition.onresult = event => {
        let guesses = [''];
        for (const result of Array.from(event.results)) {
            const alternatives = Array.from(result).slice(0, 5).map(a => a.transcript.trim());
            guesses = guesses.flatMap(prefix => alternatives.map(text => `${prefix} ${text}`.trim())).slice(0, 20);
        }
        heard = guesses;
        $('command').value = guesses[0] || '';
        clearTimeout(silence);
        silence = setTimeout(stop, 2500);
    };
    recognition.onerror = event => {
        const messages = { 'not-allowed': 'Microphone access was denied.', 'audio-capture': 'No microphone was found.',
            'no-speech': 'No speech was heard. Try again.', network: 'Speech recognition needs a network connection.' };
        log(messages[event.error] || `Speech recognition error: ${event.error}`, 'error');
    };
    recognition.onend = () => {
        clearTimeout(silence); clearTimeout(limit);
        listening = false;
        pilotRadio.setListening(false);
        $('mic').textContent = 'MIC'; $('mic').classList.remove('live');
        if (heard.length && handleTransmission(heard, false)) $('command').value = '';
    };
}
$('pilot-voice').addEventListener('change', e => pilotRadio.setEnabled(e.target.checked));
$('help').addEventListener('click', () => $('help-panel').classList.toggle('open'));

function log(text, kind = '') {
    const line = document.createElement('div');
    line.textContent = text;
    if (kind) line.className = kind;
    $('log').prepend(line);
    while ($('log').children.length > 8) $('log').lastChild.remove();
}

let stripKey = '';
function renderStrips() {
    const key = world.movers.map(m => `${m.callsign}|${m.status}|${m.actions().map(a => a[0]).join()}|${world.selected === m}`).join(';');
    if (key === stripKey) return;
    stripKey = key;
    const box = $('strips');
    box.innerHTML = '';
    for (const dep of world.movers) {
        const strip = document.createElement('div');
        strip.className = 'strip' + (world.selected === dep ? ' selected' : '');
        strip.innerHTML = `<div class="strip-head"><b>${dep.callsign}</b><span>${dep.sizeClass} · ${dep.gate.name} → ${spokenRunway(dep.runwayEnd)}</span></div>
            <div class="strip-status">${dep.status}</div><div class="strip-actions"></div>`;
        strip.addEventListener('click', () => { world.selected = dep; renderStrips(); });
        for (const [action, label] of dep.actions()) {
            const b = document.createElement('button');
            b.textContent = label;
            b.addEventListener('click', e => { e.stopPropagation(); act(dep, action); });
            strip.querySelector('.strip-actions').append(b);
        }
        const view = document.createElement('button');
        view.className = 'view';
        view.textContent = '🎯';
        view.title = 'Fly the camera to this aircraft and orbit it';
        view.addEventListener('click', e => { e.stopPropagation(); viewAircraft(dep); });
        strip.querySelector('.strip-head b').after(view);
        box.append(strip);
    }
    if (!world.movers.length) box.innerHTML = '<div class="empty">No departures yet. They call for pushback every minute or two.</div>';
}

/* ---------- Cameras ---------- */

const orbitView = { position: new THREE.Vector3(), target: new THREE.Vector3() };
function setMode(next) {
    if (mode === 'orbit' && next !== 'orbit') { orbitView.position.copy(camera.position); orbitView.target.copy(orbit.target); }
    if (next === 'orbit' && mode !== 'orbit') { camera.position.copy(orbitView.position); orbit.target.copy(orbitView.target); }
    mode = next;
    orbit.enabled = mode === 'orbit';
    // From the cab you're inside the tower, so it's hidden.
    if (world.built?.tower) world.built.tower.building.visible = mode !== 'tower';
    for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('active', b.dataset.mode === mode);
    if (mode === 'orbit') { camera.fov = 45; camera.updateProjectionMatrix(); orbit.update(); }
}

function updateCamera() {
    if (mode === 'tower') {
        const t = world.built?.tower || { x: 0, y: 60, z: 0 };
        camera.position.set(t.x, t.y, t.z);
        camera.rotation.set(THREE.MathUtils.degToRad(look.pitch), -THREE.MathUtils.degToRad(look.yaw), 0);
        if (camera.fov !== look.fov) { camera.fov = look.fov; camera.updateProjectionMatrix(); }
    } else if (mode === 'follow') {
        const target = world.selected || world.movers[0];
        if (!target) return;
        const p = target.plane.position, h = THREE.MathUtils.degToRad(target.heading);
        const back = 70 * target.plane.userData.scale;
        const chase = new THREE.Vector3(p.x - Math.sin(h) * back, p.y + 22 * target.plane.userData.scale, p.z + Math.cos(h) * back);
        // Glide behind the aircraft, but jump there when switching from far away.
        if (camera.position.distanceTo(chase) > 400) camera.position.copy(chase); else camera.position.lerp(chase, 0.08);
        camera.lookAt(p.x, p.y + 4, p.z);
        if (camera.fov !== 50) { camera.fov = 50; camera.updateProjectionMatrix(); }
    } else {
        // Orbiting an aircraft: the camera moves along with it, so it stays where you put it around the jet.
        if (world.focus && !world.movers.includes(world.focus)) world.focus = null;
        if (world.focus) {
            const p = world.focus.plane.position;
            camera.position.add(new THREE.Vector3().subVectors(p, world.focusAt));
            orbit.target.add(new THREE.Vector3().subVectors(p, world.focusAt));
            world.focusAt.copy(p);
        }
        orbit.update();
    }
}

// The strip's target button: the orbit camera, close to the aircraft, front quarter view.
function viewAircraft(dep) {
    world.selected = dep;
    setMode('orbit');
    const p = dep.plane.position, k = dep.plane.userData.scale || 1, h = THREE.MathUtils.degToRad(dep.heading);
    const ahead = { x: Math.sin(h), z: -Math.cos(h) }, right = { x: Math.cos(h), z: Math.sin(h) };
    orbit.target.set(p.x, p.y + 4 * k, p.z);
    camera.position.set(p.x + (ahead.x * 45 + right.x * 40) * k, p.y + 16 * k, p.z + (ahead.z * 45 + right.z * 40) * k);
    world.focus = dep;
    world.focusAt = p.clone();
    orbit.update();
    renderStrips();
}

// Tower view: drag to look around, scroll to zoom like binoculars.
let dragging = null;
renderer.domElement.addEventListener('pointerdown', e => { if (mode === 'tower') dragging = { x: e.clientX, y: e.clientY }; });
window.addEventListener('pointerup', () => { dragging = null; });
window.addEventListener('pointermove', e => {
    if (!dragging) return;
    const k = look.fov / renderer.domElement.clientHeight;
    look.yaw = (look.yaw - (e.clientX - dragging.x) * k + 360) % 360;
    look.pitch = Math.max(-80, Math.min(30, look.pitch + (e.clientY - dragging.y) * k));
    dragging = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('wheel', e => {
    if (mode !== 'tower') return;
    e.preventDefault();
    look.fov = Math.max(4, Math.min(75, look.fov * Math.exp(e.deltaY * 0.0015)));
}, { passive: false });

/* ---------- Loop ---------- */

let last = performance.now();
function frame(now) {
    const dt = paused ? 0 : Math.min(0.1, (now - last) / 1000) * simSpeed;
    simClock += dt;
    // The clock runs with the sim; the sky and light are refreshed every 20 sim seconds.
    if (world.time === 'now') clock.date = new Date(); else clock.date = new Date(+clock.date + dt * 1000);
    if (Math.abs(+clock.date - clock.applied) > 20000) applyEnvironment();
    skyDome.follow(camera);
    last = now;
    if (world.airport) {
        nextRequest -= dt;
        if (nextRequest <= 0) {
            nextRequest = 60 + Math.random() * 60;
            if (world.movers.filter(m => m.state === 'ready-push').length < 3) requestDeparture();
        }
        for (const dep of world.movers) dep.update(dt, world.movers);
        vehicles.update(dt);
        for (const dep of world.movers) while (dep.calls.length) pilotSay(dep.calls.shift(), dep);
        for (const dep of world.movers) if (dep.state === 'takeoff' && !dep.roared) { dep.roared = true; sound.takeoff(dep.plane); }
        for (const dep of world.movers.filter(m => m.state === 'gone')) {
            log(`${dep.telephony} departed runway ${spokenRunway(dep.runwayEnd)}.`);
            removeMover(dep);
        }
        world.movers = world.movers.filter(m => m.state !== 'gone');
        for (const dep of world.movers) dep.label.element.classList.toggle('selected', dep === world.selected);
        renderStrips();
    }
    updateCamera();
    // Lightning lights up the sky for a moment.
    const flash = weatherScene.update(dt, camera);
    if (world.lighting) {
        scene.background.copy(world.lighting.sky).lerp(new THREE.Color(0xdfe6ff), flash * 0.7);
        sky.intensity = world.lighting.skyIntensity + flash * 4;
    }
    if (sound.started) {
        let gateM = Infinity;
        for (const plane of world.parked.values()) gateM = Math.min(gateM, Math.hypot(plane.position.x - camera.position.x, plane.position.z - camera.position.z, camera.position.y));
        sound.update({ inTower: mode === 'tower', dark: lightUniforms.uDark.value, gateM });
    }
    lightUniforms.uTime.value = simClock;      // Beacons and strobes freeze too.
    lightUniforms.uScale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    composer.render();
    labels.render(scene, camera);
    radar.draw();
    requestAnimationFrame(frame);
}

function setMessage(text) { $('message').textContent = text; }

/* ---------- Controls ---------- */

for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => { world.focus = null; setMode(b.dataset.mode); });
$('sound').addEventListener('change', e => sound.setEnabled(e.target.checked));
$('weather').addEventListener('change', e => loadWeather(e.target.value));

/* ---------- Weather ---------- */

/* Live weather: the latest METAR from the US National Weather Service, or Open-Meteo's current
   conditions anywhere else. Refreshed every 10 minutes while Live is chosen. */
async function liveWeather(airport) {
    try {
        // The newest observation is often an automatic one without METAR text, so take the newest METAR.
        // Prefer a recent report's METAR text; many come without it, so otherwise write the newest one's values as one.
        const res = await fetch(`https://api.weather.gov/stations/${airport.icao}/observations?limit=6`, { cache: 'no-store' });
        const reports = res.ok ? (await res.json()).features?.map(f => f.properties) || [] : [];
        const raw = reports.slice(0, 3).map(p => p.rawMessage).find(Boolean);
        if (raw) return { metar: raw, source: 'National Weather Service' };
        if (reports[0]?.windSpeed) return { metar: window.Metar.fromNwsObservation(reports[0], airport.icao), source: 'National Weather Service' };
    } catch { /* Not a US station, or offline: try Open-Meteo. */ }
    const { lat, lon } = airport.origin;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&wind_speed_unit=kn` +
        '&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,cloud_cover,cloud_cover_low,weather_code';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`weather service returned ${res.status}`);
    return { metar: window.Metar.fromOpenMeteo((await res.json()).current, airport.icao), source: 'Open-Meteo' };
}

let liveTimer = null;
async function loadWeather(choice) {
    clearTimeout(liveTimer);
    const airport = world.airport;
    if (!airport) return;
    if (choice !== 'live') return setWeather(window.Metar.preset(choice, airport.icao), 'Preset');
    try {
        const { metar, source } = await liveWeather(airport);
        if (world.airport !== airport || $('weather').value !== 'live') return;
        setWeather(window.Metar.parseMetar(metar), source);
    } catch (err) {
        log(`Live weather is unavailable (${err.message}); showing clear skies.`, 'error');
        setWeather(window.Metar.preset('clear', airport.icao), 'Preset');
    }
    liveTimer = setTimeout(() => loadWeather($('weather').value), 10 * 60 * 1000);
}

function setWeather(conditions, source) {
    world.weather = conditions;
    weatherScene.set(conditions);
    applyEnvironment();
    sound.setRain(conditions.precip === 'snow' ? 0 : conditions.intensity);
    $('wx').textContent = `${conditions.raw.replace(/^(METAR|SPECI)\s+/, '').replace(/\s+RMK\s.*$/, '')}  ·  ${window.Metar.describe(conditions)}  ·  ${source}`;
    // Departures switch to the runway most into the wind (you can still pick another).
    const ends = world.runways.flatMap((rw, i) => world.airport.runways[i].ends.map((end, k) =>
        ({ name: end.name, heading: (rw.heading + k * 180) % 360, lengthM: rw.length })));
    const best = window.Metar.runwayForWind(ends, conditions.wind);
    if (best && best !== $('runway').value) {
        $('runway').value = best;
        log(`${window.Metar.describe(conditions).split(',')[0]}: departures now use runway ${spokenRunway(best)}.`);
    }
}
$('speed').addEventListener('change', e => { simSpeed = +e.target.value; });
$('time').addEventListener('change', e => setTimeOfDay(e.target.value));
$('spawn').addEventListener('click', () => requestDeparture());

/* Pause: traffic, timers and flashing lights stop, sound and pilot radio go quiet; the cameras and the
   map still work so you can look around. P or the space bar toggles it (not while typing a clearance). */
function setPaused(on) {
    paused = on;
    $('pause').textContent = on ? '▶ Resume' : '❚❚ Pause';
    $('pause').classList.toggle('active', on);
    $('paused').hidden = !on;
    if (sound.started) on ? sound.listener.context.suspend() : sound.listener.context.resume();
    pilotRadio.setListening(on);
}
$('pause').addEventListener('click', () => setPaused(!paused));
window.addEventListener('keydown', e => {
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.key === 'p' || e.key === 'P' || e.key === ' ') { e.preventDefault(); setPaused(!paused); }
});
$('labels-toggle').addEventListener('change', e => {
    for (const dep of world.movers) dep.label.visible = e.target.checked;
    world.tagsHidden = !e.target.checked;
});
$('taxiway-toggle').addEventListener('change', e => { if (world.taxiwayLabels) world.taxiwayLabels.visible = e.target.checked; });
$('file').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadFromFile(f).catch(err => setMessage(err.message)); });
$('view').addEventListener('dragover', e => e.preventDefault());
$('view').addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) loadFromFile(f).catch(err => setMessage(err.message));
});

resize();
requestAnimationFrame(frame);
const source = new URLSearchParams(location.search).get('airport') || 'KBOS_Scenery_Pack.zip';
Promise.all([loadModels(), vehicles.load()]).then(() => loadFromUrl(source)).catch(err => setMessage(err.message));
window.groundControl = { world, scene, camera, orbit, look, radar, sound, weatherScene, vehicles, loadWeather, setMode,
    setClock: date => { world.time = 'custom'; clock.date = new Date(date); applyEnvironment(); }, setPaused, viewAircraft, requestDeparture, act };
