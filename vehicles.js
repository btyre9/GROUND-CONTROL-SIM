/* Ground vehicles on the service roads from the airport data (apt.dat rows 1206, 1400, 1401):
   - Pushback tugs wait at their parking spots. When a departure is ready to push, a tug and tow bar hook
     onto its nose gear and push it back, then the tug unhooks and drives back to a spot.
   - Baggage trains (a tractor and three or four carts) shuttle between the gates and the bag rooms, the
     carts following the tractor's track around corners.
   Models are in models/vehicles/ (made in Blender: blender/ground-vehicles.blend). Every vehicle has an
   amber beacon. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { smoothPath, pointAt, headingOf, forward } from './ground-traffic.js';
import { makeLights, lightMaterial, KIND } from './lights.js';

const P = window.AptParser;
const TOW_BAR = 5, TUG_HALF = 3.1, CART_GAP = 3.5, TRAIN_SPEED = 6.5, TUG_SPEED = 6;

const yaw = h => -THREE.MathUtils.degToRad(h);

// One amber flashing beacon at a height on a vehicle.
function beacon(object, height, phase) {
    const lights = makeLights([{ pos: [0, height, 0], color: [1, 0.55, 0.05], size: 0.6, kind: KIND.beacon, phase }], lightMaterial([1, 0, 0, 1]));
    object.add(lights);
}

/* A shortest route over the service roads, as points (local meters). */
function roadRoute(graph, airport, project, from, to) {
    const dist = new Map([[from, 0]]), prev = new Map(), done = new Set(), queue = [[0, from]];
    while (queue.length) {
        let best = 0;
        for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[best][0]) best = i;
        const [d, node] = queue.splice(best, 1)[0];
        if (done.has(node)) continue;
        done.add(node);
        if (node === to) break;
        for (const [next, len] of graph.get(node) || []) {
            if (d + len < (dist.get(next) ?? Infinity)) { dist.set(next, d + len); prev.set(next, node); queue.push([d + len, next]); }
        }
    }
    if (!done.has(to)) return null;
    const nodes = [to];
    while (nodes[0] !== from) nodes.unshift(prev.get(nodes[0]));
    return nodes.map(id => project(airport.taxiNodes.get(id)));
}

export class Vehicles {
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        scene.add(this.group);
        this.models = {};
        this.trains = [];
        this.tugs = [];
    }

    async load() {
        const loader = new GLTFLoader();
        await Promise.all(['tug', 'towbar', 'baggage-tractor', 'baggage-cart'].map(async name => {
            try {
                const gltf = await loader.loadAsync(`models/vehicles/${name}.glb`);
                gltf.scene.traverse(o => { if (o.isMesh) o.castShadow = true; });
                // Tow bars are painted safety yellow so they show against the concrete.
                if (name === 'towbar') gltf.scene.traverse(o => { if (o.isMesh) o.material.color.setHex(0xe0a800); });
                this.models[name] = gltf.scene;
            } catch { /* Without the file there are simply no vehicles of that kind. */ }
        }));
    }

    clear() {
        this.group.clear();
        this.trains = [];
        this.tugs = [];
    }

    setAirport(airport, project) {
        this.clear();
        this.airport = airport;
        this.project = project;
        // The service-road network, and its nodes for finding the nearest one.
        this.graph = new Map();
        const add = (a, b) => {
            const na = airport.taxiNodes.get(a), nb = airport.taxiNodes.get(b);
            if (!na || !nb) return;
            if (!this.graph.has(a)) this.graph.set(a, []);
            this.graph.get(a).push([b, P.distanceM(na, nb)]);
        };
        for (const e of airport.truckEdges) { add(e.a, e.b); if (!e.oneway) add(e.b, e.a); }
        this.roadNodes = [...this.graph.keys()].map(id => ({ id, ...project(airport.taxiNodes.get(id)) }));
        if (!this.roadNodes.length) return;

        // Spare tugs at about half the pushback spots.
        this.tugSpots = airport.truckParking.filter(p => p.type === 'pushback').map(p => ({ ...project(p), heading: p.heading, taken: null }));
        if (this.models.tug) for (const spot of this.tugSpots) if (Math.random() < 0.5) this.parkTug(this.newTug(), spot);

        // Baggage trains start at their parking spots and head for the bag rooms.
        const parking = airport.truckParking.filter(p => p.type === 'baggage_train').map(p => ({ ...project(p), heading: p.heading }));
        this.bagRooms = airport.truckDestinations.filter(d => d.types.includes('baggage_train')).map(d => ({ ...project(d), heading: d.heading }));
        this.trainSpots = parking;
        if (this.models['baggage-tractor'] && this.models['baggage-cart']) {
            const count = Math.min(8, Math.ceil(parking.length / 4));
            for (const spot of [...parking].sort(() => Math.random() - 0.5).slice(0, count)) this.trains.push(this.newTrain(spot));
        }
    }

    nearestRoadNode(p) {
        let best = null, bestD = Infinity;
        for (const n of this.roadNodes) {
            const d = Math.hypot(n.x - p.x, n.z - p.z);
            if (d < bestD) { best = n; bestD = d; }
        }
        return best;
    }

    // A driving path from a point to another over the roads, joining and leaving them at the nearest nodes.
    drivePath(from, to) {
        const a = this.nearestRoadNode(from), b = this.nearestRoadNode(to);
        const road = a && b && (a.id === b.id ? [{ x: a.x, z: a.z }] : roadRoute(this.graph, this.airport, this.project, a.id, b.id));
        const points = [{ x: from.x, z: from.z }, ...(road || []), { x: to.x, z: to.z }];
        return smoothPath(points.filter((p, i) => !i || Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) > 1), 12);
    }

    /* ---------- Pushback tugs ---------- */

    newTug() {
        const object = this.models.tug.clone();
        beacon(object, 2.8, Math.random());
        this.group.add(object);
        return { object, state: 'parked' };
    }

    parkTug(tug, spot) {
        tug.spot = spot; spot.taken = tug;
        tug.state = 'parked';
        tug.object.position.set(spot.x, 0, spot.z);
        tug.object.rotation.y = yaw(spot.heading);
        if (!this.tugs.includes(tug)) this.tugs.push(tug);
    }

    /* A tug and tow bar for a departure that's ready to push. A parked spare drives off, as if it were
       the one coming over, and the pushing tug appears on the nose. */
    attachTug(dep) {
        if (!this.models.tug || !this.models.towbar) return;
        const spare = this.tugs.find(t => t.state === 'parked');
        if (spare) { spare.spot.taken = null; this.group.remove(spare.object); this.tugs.splice(this.tugs.indexOf(spare), 1); }
        const tug = this.newTug();
        tug.state = 'pushing';
        tug.dep = dep;
        tug.bar = this.models.towbar.clone();
        this.group.add(tug.bar);
        this.tugs.push(tug);
        this.placeOnNose(tug);
    }

    // The tow bar runs forward from the nose gear and the tug faces the aircraft at its end.
    placeOnNose(tug) {
        const dep = tug.dep, f = forward(dep.heading);
        tug.bar.position.set(dep.nose.x, 0, dep.nose.z);
        tug.bar.rotation.y = yaw(dep.heading);
        const d = TOW_BAR + TUG_HALF;
        tug.object.position.set(dep.nose.x + f.x * d, 0, dep.nose.z + f.z * d);
        tug.object.rotation.y = yaw(dep.heading + 180);
    }

    updateTug(tug, dt) {
        if (tug.state === 'pushing') {
            const dep = tug.dep;
            if (dep.state === 'ready-push' || dep.state === 'pushing') return this.placeOnNose(tug);
            // Pushback done: unhook, back away from the nose, then drive to a free spot.
            this.group.remove(tug.bar);
            const spot = this.tugSpots.filter(s => !s.taken).sort((a, b) =>
                Math.hypot(a.x - tug.object.position.x, a.z - tug.object.position.z) - Math.hypot(b.x - tug.object.position.x, b.z - tug.object.position.z))[0];
            if (!spot) { this.group.remove(tug.object); tug.state = 'gone'; return; }
            spot.taken = tug;
            tug.spot = spot;
            const p = tug.object.position, f = forward(dep.heading);
            // Swing out to the side of the aircraft before heading for the spot.
            const side = { x: -f.z, z: f.x };
            const start = { x: p.x + side.x * 20 + f.x * 10, z: p.z + side.z * 20 + f.z * 10 };
            const path = this.drivePath(start, spot);
            tug.path = smoothPath([{ x: p.x, z: p.z }, ...path.points.map(q => ({ x: q.x, z: q.z }))], 10);
            tug.distance = 0;
            tug.state = 'driving';
        }
        if (tug.state === 'driving') {
            tug.distance += TUG_SPEED * dt;
            const here = pointAt(tug.path, tug.distance), ahead = pointAt(tug.path, tug.distance + 2);
            tug.object.position.set(here.x, 0, here.z);
            if (Math.hypot(ahead.x - here.x, ahead.z - here.z) > 0.2) tug.object.rotation.y = yaw(headingOf(here, ahead));
            if (tug.distance >= tug.path.length) this.parkTug(tug, tug.spot);
        }
    }

    /* ---------- Baggage trains ---------- */

    newTrain(spot) {
        const tractor = this.models['baggage-tractor'].clone();
        beacon(tractor, 2.4, Math.random());
        this.group.add(tractor);
        const carts = Array.from({ length: 3 + Math.round(Math.random()) }, () => {
            const cart = this.models['baggage-cart'].clone();
            this.group.add(cart);
            return cart;
        });
        // The track behind the tractor: carts are placed along it. It starts as a straight line back from the spot.
        const f = forward(spot.heading);
        const track = [];
        for (let i = 6; i >= 0; i--) track.push({ x: spot.x - f.x * i * CART_GAP * 1.5, z: spot.z - f.z * i * CART_GAP * 1.5 });
        const train = { tractor, carts, track, state: 'waiting', wait: 5 + Math.random() * 40, at: spot };
        this.placeTrain(train);
        return train;
    }

    // Each cart sits a fixed distance back along the tractor's track, facing along it.
    placeTrain(train) {
        const track = train.track;
        const along = back => {
            let d = back;
            for (let i = track.length - 1; i > 0; i--) {
                const a = track[i], b = track[i - 1], len = Math.hypot(a.x - b.x, a.z - b.z);
                if (d <= len) { const t = d / len; return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }; }
                d -= len;
            }
            return track[0];
        };
        const pose = (object, back) => {
            const front = along(back), rear = along(back + 2.4);
            object.position.set(front.x, 0, front.z);
            if (Math.hypot(front.x - rear.x, front.z - rear.z) > 0.05) object.rotation.y = yaw(headingOf(rear, front));
        };
        pose(train.tractor, 0);
        train.carts.forEach((cart, k) => pose(cart, 2.6 + k * CART_GAP));
        // Keep the track only as long as the train needs.
        const step = i => Math.hypot(track[i].x - track[i - 1].x, track[i].z - track[i - 1].z);
        const needed = 8 + train.carts.length * CART_GAP;
        let total = 0;
        for (let i = 1; i < track.length; i++) total += step(i);
        while (track.length > 2 && total - step(1) >= needed) { total -= step(1); track.shift(); }
    }

    updateTrain(train, dt) {
        if (train.state === 'waiting') {
            train.wait -= dt;
            if (train.wait > 0) return;
            // From a gate to a bag room, or back out to the gates.
            const toRoom = !this.bagRooms.includes(train.at) && this.bagRooms.length;
            const choices = toRoom ? this.bagRooms : this.trainSpots;
            const target = choices[Math.floor(Math.random() * choices.length)];
            const p = train.tractor.position;
            train.path = this.drivePath({ x: p.x, z: p.z }, target);
            train.distance = 0;
            train.at = target;
            train.state = 'driving';
        }
        if (train.state === 'driving') {
            // Slower in turns.
            const here = pointAt(train.path, train.distance), ahead = pointAt(train.path, train.distance + 12);
            const turn = Math.abs(((headingOf(here, pointAt(train.path, train.distance + 3)) - headingOf(here, ahead)) + 540) % 360 - 180);
            train.distance += (turn > 25 ? TRAIN_SPEED * 0.5 : TRAIN_SPEED) * dt;
            const now = pointAt(train.path, train.distance);
            const last = train.track[train.track.length - 1];
            if (Math.hypot(now.x - last.x, now.z - last.z) > 0.4) train.track.push(now);
            this.placeTrain(train);
            if (train.distance >= train.path.length) { train.state = 'waiting'; train.wait = 20 + Math.random() * 60; }
        }
    }

    update(dt) {
        if (!dt) return;
        for (const tug of this.tugs) this.updateTug(tug, dt);
        this.tugs = this.tugs.filter(t => t.state !== 'gone');
        for (const train of this.trains) this.updateTrain(train, dt);
    }
}
