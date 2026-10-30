/* Departures you control from the gate to the sky: pushback, taxi along the real taxiway network, holding
   short of every runway until cleared to cross, line up and wait, takeoff. The nose wheel follows the
   taxiway centerline and the main gear trails it, so the tail cuts inside turns like a real jet. */
import { makeAirliner, placeAirliner, setAircraftLights, AIRLINES } from './aircraft-model.js';

const P = window.AptParser;
const KT = 0.514444;
const TAXI_MS = 20 * KT, TURN_MS = 9 * KT, PUSH_MS = 2.5 * KT;
const BRAKE = 1.2, ACCEL = 0.6;           // m/s², gentle like a loaded airliner.
const ROTATE_KT = { A: 70, B: 110, C: 145, D: 150, E: 160, F: 165 };

export const spokenRunway = name => name.replace(/^0/, '');
export const spokenPair = pair => pair.split('/').map(spokenRunway).join('/');

// Rounded corners through the route's nodes, sampled finely, with the distance at which each node is reached.
export function smoothPath(points, radius = 28) {
    const out = [{ ...points[0], d: 0 }], nodeDist = [0];
    const push = p => {
        const last = out[out.length - 1];
        const step = Math.hypot(p.x - last.x, p.z - last.z);
        if (step > 0.01) out.push({ x: p.x, z: p.z, d: last.d + step });
    };
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], c = points[i + 1];
        if (!c) { push(b); nodeDist.push(out[out.length - 1].d); break; }
        const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z);
        const r = Math.min(radius, ab / 2, bc / 2);
        const p1 = { x: b.x - (b.x - a.x) / ab * r, z: b.z - (b.z - a.z) / ab * r };
        const p2 = { x: b.x + (c.x - b.x) / bc * r, z: b.z + (c.z - b.z) / bc * r };
        push(p1);
        nodeDist.push(out[out.length - 1].d);
        for (let s = 1; s <= 8; s++) {
            const t = s / 8, u = 1 - t;
            push({ x: u * u * p1.x + 2 * u * t * b.x + t * t * p2.x, z: u * u * p1.z + 2 * u * t * b.z + t * t * p2.z });
        }
    }
    return { points: out, nodeDist, length: out[out.length - 1].d };
}

export function pointAt(path, d) {
    const pts = path.points;
    let lo = 0, hi = pts.length - 1;
    if (d >= pts[hi].d) return { x: pts[hi].x, z: pts[hi].z };
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].d <= d) lo = mid; else hi = mid; }
    const a = pts[lo], b = pts[hi], f = (d - a.d) / (b.d - a.d || 1);
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
}

export const headingOf = (from, to) => (Math.atan2(to.x - from.x, -(to.z - from.z)) * 180 / Math.PI + 360) % 360;
export const forward = h => ({ x: Math.sin(h * Math.PI / 180), z: -Math.cos(h * Math.PI / 180) });
const turnBetween = (a, b) => ((b - a + 540) % 360) - 180;

// The largest heading change in the next stretch of path, to slow down before corners.
function upcomingTurn(path, d, ahead = 45) {
    const h0 = headingOf(pointAt(path, d), pointAt(path, d + 5));
    let most = 0;
    for (let s = 10; s <= ahead; s += 5) {
        most = Math.max(most, Math.abs(turnBetween(h0, headingOf(pointAt(path, d + s - 5), pointAt(path, d + s)))));
    }
    return most;
}

export class Departure {
    // plane: the jet already parked at the gate, so it keeps its model and paint.
    constructor(world, gate, airline, flight, plane = null) {
        this.world = world;
        this.gate = gate;
        this.airline = airline;
        this.callsign = `${airline}${flight}`;
        this.telephony = `${AIRLINES[airline]?.name || airline} ${flight}`;
        this.spokenCallsign = `${AIRLINES[airline]?.name || airline} ${window.GroundCommands.sayFlight(flight)}`;
        this.calls = [];        // What the pilot says unprompted; main.js plays and logs them.
        this.sizeClass = gate.sizeClass || 'C';
        this.plane = plane || makeAirliner({ sizeClass: this.sizeClass, airline });
        this.wheelbase = this.plane.userData.wheelbase;
        const g = world.project(gate);
        this.nose = { x: g.x, z: g.z };
        this.heading = gate.heading;
        const f = forward(this.heading);
        this.main = { x: g.x - f.x * this.wheelbase, z: g.z - f.z * this.wheelbase };
        this.speed = 0;
        this.altitude = 0;
        this.pitch = 0;
        this.state = 'ready-push';
        this.status = 'Ready to push';
        this.clearance = '';
        this.place();
        this.call(`${world.facility} Ground, ${this.spokenCallsign}, gate ${gate.name}, ready to push`);
    }

    call(text) { this.calls.push(text); }

    place() {
        placeAirliner(this.plane, this.main.x, this.main.z, this.heading, this.altitude, this.pitch);
        // As in FAA AC 120-74: beacon on from pushback, the taxi light while taxiing, strobes on entering the
        // runway, and landing lights once cleared for takeoff.
        setAircraftLights(this.plane, { beacon: this.state !== 'ready-push',
            taxi: (this.state === 'taxi' && this.speed > 1) || this.state === 'takeoff',
            strobe: this.state === 'takeoff' || this.state === 'lined-up', landing: this.state === 'takeoff' });
    }

    /* Plans the route to the runway, along the named taxiways if given; returns false when the network
       does not reach it that way. Before pushback it starts on the taxilane behind the gate; once moving,
       from the next point on the current route. */
    planRoute(runwayEnd, via = []) {
        const world = this.world;
        const runway = world.airport.runways.find(r => r.ends.some(e => e.name === runwayEnd));
        if (!runway) return false;
        const threshold = runway.ends.find(e => e.name === runwayEnd);
        const onRunway = new Set();
        for (const e of world.airport.taxiEdges) if (e.runway && e.name.split('/').includes(runwayEnd)) { onRunway.add(e.a); onRunway.add(e.b); }
        const target = P.nearestTaxiNode(world.airport, threshold, n => onRunway.has(n.id));

        let start, lead = [];
        if (this.route && this.state !== 'ready-push' && this.state !== 'pushing') {
            if (this.state === 'ready-taxi') start = world.airport.taxiNodes.get(this.route.nodes[0]);
            else {
                // Keep rolling to the next node on the current route, then follow the new one from there.
                const k = this.path.nodeDist.findIndex(d => d > this.distance + 5);
                if (k < 0 || k >= this.route.nodes.length) return false;
                start = world.airport.taxiNodes.get(this.route.nodes[k]);
                lead = [{ ...this.nose }];
            }
        } else {
            const f = forward(this.gate.heading);
            const g = world.project(this.gate);
            const behind = world.projection.toLatLon(g.x - f.x * (this.wheelbase + 35), g.z - f.z * (this.wheelbase + 35));
            start = P.nearestTaxiNode(world.airport, behind, n => world.graph.has(n.id));
        }
        const route = start && target && P.findRouteVia(world.airport, start.id, target.id, via, world.graph);
        if (!route || route.nodes.length < 2) return false;

        this.runwayEnd = runwayEnd;
        this.runwayPair = runway.ends.map(e => e.name).join('/');
        this.route = route;
        const pts = [...lead, ...route.nodes.map(id => world.project(world.airport.taxiNodes.get(id)))];
        // Roll onto the runway centerline and line up with it.
        const rw = world.runways.find(r => r.name === this.runwayPair);
        const dir = runwayEnd === runway.ends[0].name ? { x: rw.b.x - rw.a.x, z: rw.b.z - rw.a.z } : { x: rw.a.x - rw.b.x, z: rw.a.z - rw.b.z };
        const len = Math.hypot(dir.x, dir.z);
        this.runwayDir = { x: dir.x / len, z: dir.z / len };
        const last = pts[pts.length - 1];
        pts.push({ x: last.x + this.runwayDir.x * 60, z: last.z + this.runwayDir.z * 60 });
        this.path = smoothPath(pts);
        if (lead.length) this.path.nodeDist.shift();      // nodeDist lines up with route.nodes again.
        this.distance = 0;
        this.takeoffCleared = false;

        // Hold short where the route enters each runway's protected area, and before the departure runway.
        this.holds = [];
        const zone = (edge, pair) => edge.activeZones.some(z => z.runways.some(r => pair.split('/').includes(r)));
        route.edges.forEach((edge, i) => {
            if (!edge.runway || (i > 0 && route.edges[i - 1].runway && route.edges[i - 1].name === edge.name)) return;
            let j = i;
            while (j > 0 && !route.edges[j - 1].runway && zone(route.edges[j - 1], edge.name)) j--;
            const departing = edge.name.split('/').includes(runwayEnd);
            this.holds.push({ d: Math.max(0, this.path.nodeDist[j] - 4), runway: edge.name, departing, cleared: false,
                at: route.edges[Math.max(0, j - 1)].name });
        });
        // Only the last entry onto the departure runway is the line-up; earlier ones are crossings.
        const lineups = this.holds.filter(h => h.departing);
        lineups.slice(0, -1).forEach(h => { h.departing = false; });
        this.via = P.describeRoute(route.edges).via;
        if (this.state === 'ready-push') this.pushTarget = { nose: pts[0], heading: headingOf(pts[0], pointAt(this.path, 20)) };
        return true;
    }

    approvePush() {
        if (this.state !== 'ready-push') return;
        const ht = this.pushTarget.heading;
        const f = forward(ht), f0 = forward(this.heading);
        this.push = {
            from: { ...this.main }, h0: this.heading, h1: ht,
            to: { x: this.pushTarget.nose.x - f.x * this.wheelbase, z: this.pushTarget.nose.z - f.z * this.wheelbase }
        };
        const span = Math.hypot(this.push.to.x - this.main.x, this.push.to.z - this.main.z);
        this.push.ctrl = { x: this.main.x - f0.x * span * 0.6, z: this.main.z - f0.z * span * 0.6 };
        this.push.length = span * 1.25 + 10;
        this.push.t = 0;
        this.state = 'pushing';
        this.status = 'Pushing back';
        this.clearance = `${this.telephony}, push back approved.`;
    }

    // The taxi clearance as the controller says it, ending with the first hold short.
    taxiClearanceText() {
        const firstHold = this.holds.find(h => !h.departing);
        const lineup = this.holds.find(h => h.departing);
        const holdText = firstHold && (!lineup || firstHold.d < lineup.d) ? `, hold short of runway ${spokenPair(firstHold.runway)}` : '';
        return `runway ${spokenRunway(this.runwayEnd)}, taxi via ${this.via.join(', ')}${holdText}`;
    }

    approveTaxi() {
        if (this.state === 'pushing') { this.taxiAfterPush = true; return; }
        if (this.state !== 'ready-taxi') return;
        this.clearance = `${this.telephony}, ${this.taxiClearanceText()}.`;
        this.state = 'taxi';
        this.status = `Taxiing to ${spokenRunway(this.runwayEnd)}`;
    }

    /* Carries out one spoken or typed instruction (from ground-commands.js) and returns what the pilot
       says: the readback, or why they can't. */
    instruct(command) {
        const G = window.GroundCommands, me = this.spokenCallsign;
        const runwayName = r => G.sayRunway(r);
        const unable = text => ({ ok: false, say: `${text}, ${me}` });
        const pairOf = r => this.world.airport.runways.find(rw => rw.ends.some(e => e.name === r));
        switch (command.action) {
            case 'push':
                if (this.state !== 'ready-push') return unable(this.state === 'pushing' ? 'Already pushing back' : 'We\'re already off the gate');
                this.approvePush();
                return { ok: true, say: `Push back approved, ${me}` };
            case 'taxi': {
                if (!pairOf(command.runway)) return unable(`Unable, there's no runway ${runwayName(command.runway)} here`);
                if (['takeoff', 'gone', 'lined-up'].includes(this.state)) return unable('Unable, we\'re on the runway');
                if (!this.planRoute(command.runway, command.via)) {
                    const via = command.via.length ? ` via ${command.via.map(G.sayTaxiway).join(', ')}` : '';
                    return unable(`Unable to reach runway ${runwayName(command.runway)}${via}, say again the route`);
                }
                if (this.state === 'ready-push' || this.state === 'pushing') this.taxiAfterPush = true;
                else { this.state = 'taxi'; this.holdingPosition = false; }
                this.status = `Taxiing to ${spokenRunway(this.runwayEnd)}`;
                const firstHold = this.holds.find(h => !h.departing && h.d >= this.distance);
                const hold = firstHold ? `, hold short runway ${runwayName(firstHold.runway.split('/')[0])}` : '';
                this.clearance = `${this.telephony}, ${this.taxiClearanceText()}.`;
                return { ok: true, say: `Runway ${runwayName(this.runwayEnd)}, taxi via ${this.via.map(G.sayTaxiway).join(', ')}${hold}, ${me}` };
            }
            case 'cross': {
                const hold = this.holds?.find(h => !h.cleared && !h.departing && h.runway.split('/').includes(command.runway));
                if (!hold) return unable(`We don't cross runway ${runwayName(command.runway)} on our route`);
                hold.cleared = true;
                if (this.state === 'holding' && this.nextHold() !== hold) { this.state = 'taxi'; this.status = `Crossing ${spokenPair(hold.runway)}`; }
                this.clearance = `${this.telephony}, cross runway ${spokenPair(hold.runway)}.`;
                return { ok: true, say: `Cross runway ${runwayName(command.runway)}, ${me}` };
            }
            case 'holdShort': {
                const hold = this.holds?.find(h => h.d >= this.distance - 1 && h.runway.split('/').includes(command.runway));
                if (hold && !hold.departing) hold.cleared = false;
                return { ok: true, say: `Hold short runway ${runwayName(command.runway)}, ${me}` };
            }
            case 'holdPosition':
                this.holdingPosition = true;
                return { ok: true, say: `Holding position, ${me}` };
            case 'continue':
                if (!this.holdingPosition) return unable('We\'re not holding');
                this.holdingPosition = false;
                return { ok: true, say: `Continue taxi, ${me}` };
            case 'luaw': case 'takeoff': {
                const takeoff = command.action === 'takeoff';
                if (command.runway && command.runway !== this.runwayEnd) return unable(`Say again, we're departing runway ${runwayName(this.runwayEnd)}`);
                if (!['taxi', 'holding', 'lined-up'].includes(this.state)) return unable('Unable, we\'re not at the runway yet');
                if (!takeoff && this.state === 'lined-up') return unable('Already lined up');
                this.lineUp(takeoff);
                return { ok: true, say: takeoff ? `Cleared for takeoff runway ${runwayName(this.runwayEnd)}, ${me}` :
                    `Line up and wait runway ${runwayName(this.runwayEnd)}, ${me}` };
            }
        }
        return unable('Say again');
    }

    nextHold() { return this.holds.find(h => !h.cleared && h.d >= this.distance - 1); }

    lineUp(takeoff) {
        const hold = this.holds.find(h => h.departing);
        if (!hold || !['taxi', 'holding', 'lined-up'].includes(this.state)) return;
        hold.cleared = true;
        this.takeoffCleared = this.takeoffCleared || takeoff;
        this.clearance = `${this.telephony}, runway ${spokenRunway(this.runwayEnd)}, ${takeoff ? 'cleared for takeoff' : 'line up and wait'}.`;
        if (this.state === 'holding') this.state = 'taxi';
        if (this.state === 'lined-up' && takeoff) this.startTakeoff();
    }

    startTakeoff() {
        this.state = 'takeoff';
        this.status = 'Takeoff roll';
        this.heading = headingOf({ x: 0, z: 0 }, this.runwayDir);
    }

    // What the strip's buttons offer right now.
    actions() {
        const hold = this.nextHold();
        switch (this.state) {
            case 'ready-push': return [['push', 'Push approved']];
            case 'ready-taxi': return [['taxi', `Taxi ${spokenRunway(this.runwayEnd)}`]];
            case 'taxi': case 'holding':
                if (hold && !hold.departing) return [['cross', `Cross ${spokenPair(hold.runway)}`]];
                if (hold && hold.departing) return [['luaw', 'Line up & wait'], ['takeoff', 'Cleared takeoff']];
                if (!this.takeoffCleared) return [['takeoff', 'Cleared takeoff']];
                return [];
            case 'lined-up': return [['takeoff', 'Cleared takeoff']];
            default: return [];
        }
    }

    // Speed limit from the next stop: a hold line, the end of the line-up, or traffic ahead.
    stopLimit(others) {
        let limit = Infinity;
        const hold = this.nextHold();
        if (hold) limit = Math.min(limit, Math.sqrt(2 * BRAKE * Math.max(0, hold.d - this.distance)));
        if (!this.takeoffCleared && this.lineupDone()) limit = 0;
        if (this.holdingPosition) limit = 0;
        const f = forward(this.heading);
        for (const other of others) {
            if (other === this || other.altitude > 0) continue;
            for (const p of [other.main, other.nose]) {
                const dx = p.x - this.nose.x, dz = p.z - this.nose.z;
                const along = dx * f.x + dz * f.z, side = Math.abs(dx * f.z - dz * f.x);
                if (along > 0 && along < 90 && side < 18) limit = Math.min(limit, Math.sqrt(2 * BRAKE * Math.max(0, along - 40)));
            }
        }
        return limit;
    }

    lineupDone() { return this.distance >= this.path.length - 0.5; }

    update(dt, others) {
        switch (this.state) {
            case 'pushing': {
                const p = this.push;
                p.t = Math.min(1, p.t + PUSH_MS * dt / p.length);
                const t = p.t, u = 1 - t, ease = t * t * (3 - 2 * t);
                this.main = { x: u * u * p.from.x + 2 * u * t * p.ctrl.x + t * t * p.to.x, z: u * u * p.from.z + 2 * u * t * p.ctrl.z + t * t * p.to.z };
                this.heading = (p.h0 + turnBetween(p.h0, p.h1) * ease + 360) % 360;
                const f = forward(this.heading);
                this.nose = { x: this.main.x + f.x * this.wheelbase, z: this.main.z + f.z * this.wheelbase };
                if (t >= 1) {
                    this.state = 'ready-taxi'; this.status = 'Ready to taxi';
                    if (this.taxiAfterPush) { this.taxiAfterPush = false; this.state = 'taxi'; this.status = `Taxiing to ${spokenRunway(this.runwayEnd)}`; }
                    else this.call(`${this.spokenCallsign}, ready to taxi`);
                }
                break;
            }
            case 'taxi': {
                const limit = Math.min(upcomingTurn(this.path, this.distance) > 25 ? TURN_MS : TAXI_MS, this.stopLimit(others),
                    Math.sqrt(2 * BRAKE * Math.max(0, this.path.length - this.distance)) + (this.takeoffCleared ? 3 : 0));
                this.speed = this.speed < limit ? Math.min(limit, this.speed + ACCEL * dt) : Math.max(limit, this.speed - BRAKE * 2 * dt);
                this.distance = Math.min(this.path.length, this.distance + this.speed * dt);
                this.followNose(pointAt(this.path, this.distance));
                const hold = this.nextHold();
                if (this.speed < 0.05 && hold && hold.d - this.distance < 3) {
                    this.state = 'holding';
                    this.status = hold.departing ? `Holding short ${spokenRunway(this.runwayEnd)}, ready` : `Holding short ${spokenPair(hold.runway)}`;
                    const G = window.GroundCommands;
                    this.call(hold.departing ? `${this.world.facility} Tower, ${this.spokenCallsign}, holding short runway ${G.sayRunway(this.runwayEnd)}, ready for departure` :
                        `${this.spokenCallsign}, holding short runway ${G.sayRunway(hold.runway.split('/')[0])}`);
                } else if (this.lineupDone()) {
                    if (this.takeoffCleared) this.startTakeoff();
                    else if (this.speed < 0.1) { this.state = 'lined-up'; this.status = `Lined up ${spokenRunway(this.runwayEnd)}`; }
                } else if (this.speed > 0.5) {
                    const liningUp = this.holds.find(h => h.departing)?.cleared;
                    this.status = this.takeoffCleared ? 'Lining up for takeoff' :
                        liningUp ? `Lining up ${spokenRunway(this.runwayEnd)}` : `Taxiing to ${spokenRunway(this.runwayEnd)}`;
                }
                break;
            }
            case 'takeoff': {
                const vr = ROTATE_KT[this.sizeClass] * KT;
                // Full power on the roll; once airborne, hold the initial climb speed (about Vr + 20 kt).
                this.speed = this.altitude > 0 ? Math.min(vr + 20 * KT, this.speed + 0.8 * dt) : this.speed + 2.1 * dt;
                const step = this.speed * dt;
                this.main = { x: this.main.x + this.runwayDir.x * step, z: this.main.z + this.runwayDir.z * step };
                this.nose = { x: this.main.x + this.runwayDir.x * this.wheelbase, z: this.main.z + this.runwayDir.z * this.wheelbase };
                if (this.speed >= vr) this.pitch = Math.min(8, this.pitch + 2.7 * dt);
                if (this.pitch >= 6) this.altitude += Math.min(12, (this.pitch - 5) * 4) * dt * Math.min(1, this.altitude / 20 + 0.4);
                this.status = this.altitude > 0 ? `Airborne, ${Math.round(this.altitude / 0.3048)} ft` : `Takeoff roll, ${Math.round(this.speed / KT)} kt`;
                if (this.altitude > 900) this.state = 'gone';
                break;
            }
        }
        this.place();
    }

    // Nose wheel to the new point; the main gear follows at the wheelbase behind it.
    followNose(point) {
        this.nose = point;
        const dx = this.nose.x - this.main.x, dz = this.nose.z - this.main.z;
        const len = Math.hypot(dx, dz) || 1;
        this.main = { x: this.nose.x - dx / len * this.wheelbase, z: this.nose.z - dz / len * this.wheelbase };
        this.heading = headingOf(this.main, this.nose);
    }
}
