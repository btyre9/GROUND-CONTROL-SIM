/* Reads an X-Plane apt.dat airport layout (the format the X-Plane Scenery Gateway shares for thousands of
   airports): runways, pavement, painted lines, the taxi route network, gates, jetways, ground-vehicle routes
   and the tower viewpoint. Also turns curved outlines into points and finds taxi routes. */
(function (root) {
    'use strict';

    const FT = 0.3048;
    const EARTH_M = 6371000;
    const toRad = d => d * Math.PI / 180;

    // A local flat map in meters around the airport: x east, z south (the 3D scene's convention).
    function makeProjection(origin) {
        const metersPerLon = toRad(1) * EARTH_M * Math.cos(toRad(origin.lat));
        const metersPerLat = toRad(1) * EARTH_M;
        return {
            toLocal: (lat, lon) => ({ x: (lon - origin.lon) * metersPerLon, z: -(lat - origin.lat) * metersPerLat }),
            toLatLon: (x, z) => ({ lat: origin.lat - z / metersPerLat, lon: origin.lon + x / metersPerLon })
        };
    }

    function distanceM(a, b) {
        const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon) * Math.cos(toRad((a.lat + b.lat) / 2));
        return Math.hypot(dLat, dLon) * EARTH_M;
    }

    function bearingDeg(a, b) {
        const dLat = b.lat - a.lat, dLon = (b.lon - a.lon) * Math.cos(toRad((a.lat + b.lat) / 2));
        return (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
    }

    // Rows 111-116: one outline node, optionally curved, optionally starting a painted line or light row.
    function readNode(code, t) {
        const curved = code === 112 || code === 114 || code === 116;
        const node = { lat: +t[1], lon: +t[2] };
        let rest = 3;
        if (curved) { node.ctrl = { lat: +t[3], lon: +t[4] }; rest = 5; }
        for (const value of t.slice(rest).map(Number)) {
            if (value >= 101 && value <= 199) node.light = value;
            else if (value > 0) node.line = value;
        }
        return { node, closes: code === 113 || code === 114, ends: code === 115 || code === 116 };
    }

    function parseAptDat(text) {
        const airport = {
            icao: '', name: '', elevationFt: 0, meta: {}, tower: null, runways: [], pavements: [], lines: [],
            boundary: [], gates: [], jetways: [], signs: [], windsocks: [], frequencies: [],
            taxiNodes: new Map(), taxiEdges: [], truckEdges: [], truckParking: [], truckDestinations: []
        };
        let shape = null;     // The pavement, line or boundary whose outline nodes are being read.
        let ring = null;
        let lastEdge = null, lastGate = null;

        const finishRing = () => { if (ring && ring.nodes.length) shape.rings.push(ring); ring = null; };
        const finishShape = () => { finishRing(); shape = null; };

        for (const raw of text.split(/\r?\n/)) {
            const t = raw.trim().split(/\s+/);
            const code = Number(t[0]);
            if (!t[0] || Number.isNaN(code)) continue;

            if (code >= 111 && code <= 116) {
                if (!shape) continue;
                const { node, closes, ends } = readNode(code, t);
                if (!ring) ring = { nodes: [], closed: false };
                ring.nodes.push(node);
                if (closes || ends) { ring.closed = closes; finishRing(); }
                continue;
            }
            finishShape();

            switch (code) {
                case 1: case 16: case 17:
                    if (airport.icao) break;     // Only the first airport in a file.
                    airport.elevationFt = +t[1];
                    airport.icao = t[4];
                    airport.name = t.slice(5).join(' ');
                    break;
                case 1302: airport.meta[t[1]] = t.slice(2).join(' '); break;
                case 14: airport.tower = { lat: +t[1], lon: +t[2], heightFt: +t[3], name: t.slice(5).join(' ') }; break;
                case 100: {
                    const end = i => ({ name: t[8 + i * 9], lat: +t[9 + i * 9], lon: +t[10 + i * 9],
                        displacedM: +t[11 + i * 9], overrunM: +t[12 + i * 9], markings: +t[13 + i * 9],
                        approachLights: +t[14 + i * 9], tdzLights: +t[15 + i * 9], reil: +t[16 + i * 9] });
                    airport.runways.push({ widthM: +t[1], surface: +t[2], shoulder: +t[3], centerLights: +t[5] === 1,
                        edgeLights: +t[6], ends: [end(0), end(1)] });
                    break;
                }
                case 110:
                    shape = { surface: +t[1], name: t.slice(4).join(' '), rings: [] };
                    airport.pavements.push(shape);
                    break;
                case 120:
                    shape = { name: t.slice(1).join(' '), rings: [] };
                    airport.lines.push(shape);
                    break;
                case 130:
                    shape = { name: t.slice(1).join(' '), rings: [] };
                    airport.boundary.push(shape);
                    break;
                case 19:
                    airport.windsocks.push({ lat: +t[1], lon: +t[2], lit: t[3] === '1', name: t.slice(4).join(' ') });
                    break;
                case 20:
                    airport.signs.push({ lat: +t[1], lon: +t[2], heading: +t[3], size: +t[5], text: t.slice(6).join(' ') });
                    break;
                case 1201:
                    airport.taxiNodes.set(+t[4], { id: +t[4], lat: +t[1], lon: +t[2], usage: t[3], name: t.slice(5).join(' ') });
                    break;
                case 1202:
                    lastEdge = { a: +t[1], b: +t[2], oneway: t[3] === 'oneway', runway: t[4] === 'runway',
                        widthClass: t[4].startsWith('taxiway_') ? t[4].slice(8) : '', name: t.slice(5).join(' '), activeZones: [] };
                    airport.taxiEdges.push(lastEdge);
                    break;
                case 1204:
                    if (lastEdge) lastEdge.activeZones.push({ kind: t[1], runways: (t[2] || '').split(',') });
                    break;
                case 1206:
                    airport.truckEdges.push({ a: +t[1], b: +t[2], oneway: t[3] === 'oneway', name: t.slice(4).join(' ') });
                    break;
                case 1300:
                    lastGate = { lat: +t[1], lon: +t[2], heading: +t[3], kind: t[4], categories: (t[5] || '').split('|'),
                        name: t.slice(6).join(' '), sizeClass: '', operation: '', airlines: [] };
                    airport.gates.push(lastGate);
                    break;
                case 1301:
                    if (lastGate) { lastGate.sizeClass = t[1]; lastGate.operation = t[2] || ''; lastGate.airlines = t.slice(3).join(' ').split(/[\s,]+/).filter(Boolean).map(a => a.toUpperCase()); }
                    break;
                case 1400:
                    airport.truckParking.push({ lat: +t[1], lon: +t[2], heading: +t[3], type: t[4], count: +t[5], name: t.slice(6).join(' ') });
                    break;
                case 1401:
                    airport.truckDestinations.push({ lat: +t[1], lon: +t[2], heading: +t[3], types: t[4].split('|'), name: t.slice(5).join(' ') });
                    break;
                case 1500:
                    // Field 6 is reserved by the spec.
                    airport.jetways.push({ lat: +t[1], lon: +t[2], heading: +t[3], style: +t[4], size: +t[5],
                        lengthM: +t[7], cabHeading: +t[8] });
                    break;
                default:
                    if (code >= 50 && code <= 56 || code >= 1050 && code <= 1056) {
                        const mhz = code >= 1050 ? +t[1] / 1000 : +t[1] / 100;
                        airport.frequencies.push({ type: code % 1000 % 50, mhz, name: t.slice(2).join(' ') });
                    }
            }
        }
        finishShape();

        const lat = parseFloat(airport.meta.datum_lat), lon = parseFloat(airport.meta.datum_lon);
        airport.origin = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } :
            airport.tower ? { lat: airport.tower.lat, lon: airport.tower.lon } :
            airport.runways.length ? { lat: airport.runways[0].ends[0].lat, lon: airport.runways[0].ends[0].lon } : { lat: 0, lon: 0 };
        return airport;
    }

    function bezierPoint(p0, c1, c2, p1, s) {
        const u = 1 - s;
        if (c1 && c2) return u * u * u * p0 + 3 * u * u * s * c1 + 3 * u * s * s * c2 + s * s * s * p1;
        const c = c1 ?? c2;
        return u * u * p0 + 2 * u * s * c + s * s * p1;
    }

    /* Points along an outline. A curved node's control point pulls the following segment; the mirror of it
       pulls the segment arriving at the node. Each point carries the painted line and light types that the
       outline has from it up to the next point. */
    function tessellate(ring, stepsPerCurve = 12) {
        const nodes = ring.nodes, points = [];
        const count = ring.closed ? nodes.length : nodes.length - 1;
        for (let i = 0; i < count; i++) {
            const a = nodes[i], b = nodes[(i + 1) % nodes.length];
            const c1 = a.ctrl || null;
            const c2 = b.ctrl ? { lat: 2 * b.lat - b.ctrl.lat, lon: 2 * b.lon - b.ctrl.lon } : null;
            const steps = c1 || c2 ? stepsPerCurve : 1;
            for (let s = 0; s < steps; s++) {
                const f = s / steps;
                points.push({
                    lat: c1 || c2 ? bezierPoint(a.lat, c1?.lat, c2?.lat, b.lat, f) : a.lat,
                    lon: c1 || c2 ? bezierPoint(a.lon, c1?.lon, c2?.lon, b.lon, f) : a.lon,
                    line: a.line || 0, light: a.light || 0
                });
            }
        }
        if (!ring.closed && nodes.length) {
            const last = nodes[nodes.length - 1];
            points.push({ lat: last.lat, lon: last.lon, line: 0, light: 0 });
        }
        return points;
    }

    /* The taxi route network as a graph. Runway edges can be used, but only to cross or enter the runway. */
    function buildGraph(airport) {
        const links = new Map();
        const add = (from, to, edge) => {
            const a = airport.taxiNodes.get(from), b = airport.taxiNodes.get(to);
            if (!a || !b) return;
            if (!links.has(from)) links.set(from, []);
            links.get(from).push({ to, edge, lengthM: distanceM(a, b) });
        };
        for (const edge of airport.taxiEdges) {
            add(edge.a, edge.b, edge);
            if (!edge.oneway) add(edge.b, edge.a, edge);
        }
        return links;
    }

    // Shortest route by distance, with a penalty on runway edges so aircraft stay on taxiways where they can.
    function findRoute(airport, from, to, graph = buildGraph(airport), runwayPenalty = 4) {
        const dist = new Map([[from, 0]]), previous = new Map(), done = new Set();
        const queue = [[0, from]];
        while (queue.length) {
            let best = 0;
            for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[best][0]) best = i;
            const [d, node] = queue.splice(best, 1)[0];
            if (done.has(node)) continue;
            done.add(node);
            if (node === to) break;
            for (const link of graph.get(node) || []) {
                const cost = d + link.lengthM * (link.edge.runway ? runwayPenalty : 1);
                if (cost < (dist.get(link.to) ?? Infinity)) {
                    dist.set(link.to, cost);
                    previous.set(link.to, { node, edge: link.edge });
                    queue.push([cost, link.to]);
                }
            }
        }
        if (!done.has(to)) return null;
        const nodes = [to], edges = [];
        for (let n = to; n !== from;) {
            const step = previous.get(n);
            edges.unshift(step.edge);
            nodes.unshift(step.node);
            n = step.node;
        }
        return { nodes, edges };
    }

    /* A route that follows the taxiways named in a clearance, in order ("via E, A, N"). Unnamed ramp
       connectors and runway crossings are allowed anywhere; a taxiway that wasn't named is allowed only for
       a short hop, leaving the ramp (within 250 m of the start) or reaching the runway (within 400 m). */
    function findRouteVia(airport, from, to, via, graph = buildGraph(airport)) {
        if (!via.length) return findRoute(airport, from, to, graph);
        const names = via.map(v => v.toUpperCase());
        const start = airport.taxiNodes.get(from), end = airport.taxiNodes.get(to);
        const near = (id, place, meters) => distanceM(airport.taxiNodes.get(id), place) <= meters;
        const key = (node, k) => `${node}|${k}`;
        const dist = new Map([[key(from, -1), 0]]), previous = new Map(), done = new Set();
        const queue = [[0, from, -1]];
        let goal = null;
        while (queue.length) {
            let best = 0;
            for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[best][0]) best = i;
            const [d, node, k] = queue.splice(best, 1)[0];
            const here = key(node, k);
            if (done.has(here)) continue;
            done.add(here);
            if (node === to && k === names.length - 1) { goal = here; break; }
            for (const link of graph.get(node) || []) {
                const name = link.edge.name.trim().toUpperCase();
                let nextK = k, cost = link.lengthM;
                if (link.edge.runway) cost *= 4;
                else if (k + 1 < names.length && name === names[k + 1]) nextK = k + 1;
                else if (k >= 0 && name === names[k]) nextK = k;
                else if (name && k === -1 && near(link.to, start, 250)) cost *= 3;
                else if (name && k === names.length - 1 && near(link.to, end, 400)) cost *= 3;
                else if (name) continue;
                const next = key(link.to, nextK), total = d + cost;
                if (total < (dist.get(next) ?? Infinity)) {
                    dist.set(next, total);
                    previous.set(next, { state: here, edge: link.edge, node });
                    queue.push([total, link.to, nextK]);
                }
            }
        }
        if (!goal) return null;
        const nodes = [to], edges = [];
        for (let s = goal; previous.has(s);) {
            const step = previous.get(s);
            edges.unshift(step.edge);
            nodes.unshift(step.node);
            s = step.state;
        }
        return { nodes, edges };
    }

    // "via K, B, C" names from a route, plus the runways it crosses on the way.
    function describeRoute(edges) {
        const via = [], crossings = [];
        for (const edge of edges) {
            const name = edge.name.trim();
            if (!name) continue;
            if (edge.runway) { if (crossings.at(-1) !== name) crossings.push(name); continue; }
            if (via.at(-1) !== name) via.push(name);
        }
        return { via, crossings };
    }

    function nearestTaxiNode(airport, point, filter = () => true) {
        let best = null, bestDist = Infinity;
        for (const node of airport.taxiNodes.values()) {
            if (!filter(node)) continue;
            const d = distanceM(point, node);
            if (d < bestDist) { best = node; bestDist = d; }
        }
        return best;
    }

    /* Where to write each taxiway's name: midpoints of its longest segments, at least minSpacing meters
       apart for the same name, with the direction the taxiway runs there (for the map). */
    function taxiwayLabels(airport, minSpacing = 450) {
        const byName = new Map();
        for (const edge of airport.taxiEdges) {
            const a = airport.taxiNodes.get(edge.a), b = airport.taxiNodes.get(edge.b);
            const name = edge.name.trim();
            if (edge.runway || !name || !a || !b) continue;
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push({ a, b, length: distanceM(a, b) });
        }
        const labels = [];
        for (const [name, edges] of byName) {
            const placed = [];
            for (const { a, b } of edges.sort((x, y) => y.length - x.length)) {
                const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
                if (placed.some(p => distanceM(p, mid) < minSpacing)) continue;
                placed.push(mid);
                labels.push({ name, ...mid, heading: bearingDeg(a, b) });
            }
        }
        return labels;
    }

    const api = { FT, makeProjection, distanceM, bearingDeg, parseAptDat, tessellate, buildGraph, findRoute,
        findRouteVia, describeRoute, nearestTaxiNode, taxiwayLabels };
    root.AptParser = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
