/* A top-down map of the airport with live traffic, like the FAA airport diagram or an ASDE-X ground radar
   screen: pavement, runways, buildings and taxiway names, with every aircraft drawn to scale and the
   moving ones tagged. Drag to pan, scroll to zoom, click an aircraft to select it. */
import { spokenRunway } from './ground-traffic.js';

const P = window.AptParser;
const KT = 0.514444;

// Colors for the two looks: the printed FAA diagram and a dark ASDE-X style screen.
const STYLES = {
    diagram: { bg: '#ffffff', pavement: '#c9c9c9', runway: '#111111', building: '#1a1a1a', line: '#9a9a9a',
        label: '#111111', labelBg: 'rgba(255,255,255,0.85)', parked: '#7a7a7a', moving: '#0a7d2c', holding: '#c77700',
        selected: '#0057d8', airborne: '#6b2fb3', tag: '#111111', route: '#0057d8' },
    asde: { bg: '#0b1015', pavement: '#2c3440', runway: '#5a6470', building: '#1d4f6e', line: '#3b4654',
        label: '#e8c547', labelBg: 'rgba(0,0,0,0.6)', parked: '#5f6b78', moving: '#3fe08a', holding: '#ffb340',
        selected: '#4fc3ff', airborne: '#c792ff', tag: '#d8e2ea', route: '#4fc3ff' }
};

export class GroundRadar {
    constructor(canvas, world, onSelect) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.world = world;
        this.onSelect = onSelect;
        this.style = 'diagram';
        this.view = { x: 0, z: 0, scale: 0.15 };      // Center in local meters, pixels per meter.
        this.layers = null;
        canvas.addEventListener('wheel', e => this.zoom(e), { passive: false });
        canvas.addEventListener('pointerdown', e => this.press(e));
        window.addEventListener('pointermove', e => this.drag(e));
        window.addEventListener('pointerup', e => this.release(e));
    }

    /* Paths for the static map, in local meters, built once per airport. */
    build(airport, project, tiles) {
        const ring = r => P.tessellate(r).map(p => project(p));
        const polygon = (path, points) => {
            points.forEach((p, i) => (i ? path.lineTo(p.x, p.z) : path.moveTo(p.x, p.z)));
            path.closePath();
        };
        const runways = new Path2D(), buildings = new Path2D(), lines = new Path2D();
        // One path per pavement area, filled even-odd so its holes (grass islands) stay open.
        const pavement = airport.pavements.filter(pave => pave.surface !== 15).map(pave => {
            const path = new Path2D();
            for (const r of pave.rings) polygon(path, ring(r));
            return path;
        });
        for (const edge of airport.taxiEdges) {
            const a = airport.taxiNodes.get(edge.a), b = airport.taxiNodes.get(edge.b);
            if (!a || !b || edge.runway) continue;
            const pa = project(a), pb = project(b);
            lines.moveTo(pa.x, pa.z); lines.lineTo(pb.x, pb.z);
        }
        const ends = [];
        for (const rw of airport.runways) {
            const [e1, e2] = rw.ends.map(e => project(e));
            const len = Math.hypot(e2.x - e1.x, e2.z - e1.z), nx = -(e2.z - e1.z) / len * rw.widthM / 2, nz = (e2.x - e1.x) / len * rw.widthM / 2;
            polygon(runways, [{ x: e1.x + nx, z: e1.z + nz }, { x: e2.x + nx, z: e2.z + nz }, { x: e2.x - nx, z: e2.z - nz }, { x: e1.x - nx, z: e1.z - nz }]);
            // Each end's number sits just beyond the end, read from the approach.
            const ux = (e2.x - e1.x) / len, uz = (e2.z - e1.z) / len;
            ends.push({ text: spokenRunway(rw.ends[0].name), x: e1.x - ux * 90, z: e1.z - uz * 90 });
            ends.push({ text: spokenRunway(rw.ends[1].name), x: e2.x + ux * 90, z: e2.z + uz * 90 });
        }
        for (const tile of tiles) for (const poly of tile.polygons) {
            if (!/\.fac$/.test(poly.def || '') || /fenc|Fence|Wall-|pier|embankment/i.test(poly.def)) continue;
            for (const w of poly.windings) if (w.length > 2) polygon(buildings, w.map(p => project({ lon: p[0], lat: p[1] })));
        }
        const labels = P.taxiwayLabels(airport, 380).map(l => ({ ...l, ...project(l) }));
        const gates = airport.gates.map(g => ({ name: g.name, ...project(g) }));
        this.layers = { pavement, runways, buildings, lines, ends, labels, gates };
        // Start framed on the runways.
        const xs = ends.map(e => e.x), zs = ends.map(e => e.z);
        this.view.x = (Math.min(...xs) + Math.max(...xs)) / 2;
        this.view.z = (Math.min(...zs) + Math.max(...zs)) / 2;
        this.fit = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) * 1.1;
        this.view.scale = 0;
    }

    toScreen(x, z) {
        const { width, height } = this.canvas;
        return { x: (x - this.view.x) * this.view.scale + width / 2, y: (z - this.view.z) * this.view.scale + height / 2 };
    }

    toWorld(px, py) {
        const { width, height } = this.canvas;
        return { x: (px - width / 2) / this.view.scale + this.view.x, z: (py - height / 2) / this.view.scale + this.view.z };
    }

    zoom(e) {
        e.preventDefault();
        const r = this.canvas.getBoundingClientRect(), dpr = this.canvas.width / r.width;
        const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
        const before = this.toWorld(px, py);
        this.view.scale = Math.min(8, Math.max(0.03, this.view.scale * Math.exp(-e.deltaY * 0.0015)));
        const after = this.toWorld(px, py);
        this.view.x += before.x - after.x;
        this.view.z += before.z - after.z;
    }

    press(e) { this.dragging = { x: e.clientX, y: e.clientY, moved: false }; }

    drag(e) {
        if (!this.dragging) return;
        const dpr = this.canvas.width / this.canvas.getBoundingClientRect().width;
        const dx = (e.clientX - this.dragging.x) * dpr, dy = (e.clientY - this.dragging.y) * dpr;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.dragging.moved = true;
        this.view.x -= dx / this.view.scale;
        this.view.z -= dy / this.view.scale;
        this.dragging.x = e.clientX; this.dragging.y = e.clientY;
    }

    release(e) {
        const click = this.dragging && !this.dragging.moved;
        this.dragging = null;
        if (!click || e.target !== this.canvas) return;
        const r = this.canvas.getBoundingClientRect(), dpr = this.canvas.width / r.width;
        const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
        let best = null, bestD = 30 * dpr;
        for (const dep of this.world.movers) {
            const s = this.toScreen(dep.plane.position.x, dep.plane.position.z);
            const d = Math.hypot(s.x - px, s.y - py);
            if (d < bestD) { best = dep; bestD = d; }
        }
        if (best) this.onSelect(best);
    }

    resize() {
        const r = this.canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio, 2);
        const before = Math.min(this.canvas.width, this.canvas.height);
        this.canvas.width = Math.max(1, Math.round(r.width * dpr));
        this.canvas.height = Math.max(1, Math.round(r.height * dpr));
        // Keep showing the same area when the window grows or shrinks (as when swapping views).
        const after = Math.min(this.canvas.width, this.canvas.height);
        if (this.view.scale && before > 1 && after > 1) this.view.scale *= after / before;
    }

    draw() {
        const { ctx, canvas, layers } = this;
        if (!layers || !canvas.width) return;
        if (!this.view.scale) this.view.scale = Math.min(canvas.width, canvas.height) / this.fit;
        const c = STYLES[this.style], s = this.view.scale, dpr = canvas.width / (canvas.getBoundingClientRect().width || 1);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(s, 0, 0, s, canvas.width / 2 - this.view.x * s, canvas.height / 2 - this.view.z * s);
        ctx.fillStyle = c.pavement;
        for (const path of layers.pavement) ctx.fill(path, 'evenodd');
        ctx.fillStyle = c.runway; ctx.fill(layers.runways);
        ctx.fillStyle = c.building; ctx.fill(layers.buildings);
        ctx.strokeStyle = c.line; ctx.lineWidth = 1 / s; ctx.stroke(layers.lines);

        // Text and aircraft are drawn in screen pixels so they stay readable at any zoom.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const text = (str, x, y, size, color, bg) => {
            ctx.font = `bold ${size * dpr}px "Helvetica Neue", Arial, sans-serif`;
            if (bg) { const w = ctx.measureText(str).width + 6 * dpr; ctx.fillStyle = bg; ctx.fillRect(x - w / 2, y - size * dpr * 0.65, w, size * dpr * 1.3); }
            ctx.fillStyle = color; ctx.fillText(str, x, y);
        };
        // Labels that would overlap one already drawn are left out until you zoom in.
        const drawn = [];
        const room = (p, gap) => {
            if (p.x < 0 || p.y < 0 || p.x > canvas.width || p.y > canvas.height) return false;
            if (drawn.some(q => Math.abs(q.x - p.x) < gap * dpr && Math.abs(q.y - p.y) < gap * 0.6 * dpr)) return false;
            drawn.push(p);
            return true;
        };
        for (const end of layers.ends) { const p = this.toScreen(end.x, end.z); if (room(p, 22)) text(end.text, p.x, p.y, 13, c.label); }
        for (const l of layers.labels) { const p = this.toScreen(l.x, l.z); if (room(p, 26)) text(l.name, p.x, p.y, 11, c.label, c.labelBg); }
        if (s > 0.9) for (const g of layers.gates) { const p = this.toScreen(g.x, g.z); if (room(p, 24)) text(g.name, p.x, p.y, 9, c.parked); }

        for (const plane of this.world.parked.values()) this.aircraft(plane.position, plane.rotation.y, plane.userData.scale, c.parked);
        const selected = this.world.selected;
        if (selected?.path && selected.altitude === 0) this.route(selected, c.route);
        for (const dep of this.world.movers) {
            const color = dep === selected ? c.selected : dep.altitude > 0 ? c.airborne : dep.state === 'holding' || dep.state === 'ready-push' || dep.state === 'ready-taxi' || dep.state === 'lined-up' ? c.holding : c.moving;
            const p = this.aircraft(dep.plane.position, dep.plane.rotation.y, dep.plane.userData.scale, color);
            // Data tag: callsign, size class and ground speed, then what it's doing.
            ctx.strokeStyle = color; ctx.lineWidth = dpr;
            ctx.beginPath(); ctx.moveTo(p.x + 8 * dpr, p.y - 8 * dpr); ctx.lineTo(p.x + 20 * dpr, p.y - 20 * dpr); ctx.stroke();
            ctx.textAlign = 'left';
            ctx.font = `bold ${11 * dpr}px ui-monospace, Menlo, monospace`;
            ctx.fillStyle = color;
            ctx.fillText(`${dep.callsign} ${dep.sizeClass} ${String(Math.round(dep.speed / KT)).padStart(2, '0')}`, p.x + 22 * dpr, p.y - 26 * dpr);
            ctx.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
            ctx.fillStyle = c.tag;
            ctx.fillText(dep.status, p.x + 22 * dpr, p.y - 13 * dpr);
            ctx.textAlign = 'center';
        }
    }

    // An airplane silhouette to scale (never smaller than a few pixels), nose along its heading.
    aircraft(position, yaw, scale, color) {
        const { ctx } = this, dpr = this.canvas.width / (this.canvas.getBoundingClientRect().width || 1);
        const p = this.toScreen(position.x, position.z);
        const k = Math.max(this.view.scale * (scale || 1), 0.22 * dpr);   // Pixels per A320 meter.
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(-yaw);
        ctx.scale(k, k);
        ctx.fillStyle = color;
        ctx.beginPath();
        // Fuselage, wings and tail of an A320-sized jet, main gear at the origin, nose toward -y.
        ctx.moveTo(0, -17.6); ctx.lineTo(2, -14); ctx.lineTo(2, -3.6); ctx.lineTo(17.9, 3.8); ctx.lineTo(17.9, 5.4); ctx.lineTo(2, 3);
        ctx.lineTo(1.4, 13.4); ctx.lineTo(6.3, 16.6); ctx.lineTo(6.3, 18); ctx.lineTo(0.6, 17.4); ctx.lineTo(0, 20);
        ctx.lineTo(-0.6, 17.4); ctx.lineTo(-6.3, 18); ctx.lineTo(-6.3, 16.6); ctx.lineTo(-1.4, 13.4); ctx.lineTo(-2, 3);
        ctx.lineTo(-17.9, 5.4); ctx.lineTo(-17.9, 3.8); ctx.lineTo(-2, -3.6); ctx.lineTo(-2, -14); ctx.closePath();
        ctx.fill();
        ctx.restore();
        return p;
    }

    // What's left of the selected aircraft's taxi route.
    route(dep, color) {
        const { ctx } = this, dpr = this.canvas.width / (this.canvas.getBoundingClientRect().width || 1);
        const pts = dep.path.points.filter(p => p.d >= dep.distance);
        if (pts.length < 2) return;
        ctx.strokeStyle = color; ctx.lineWidth = 3 * dpr; ctx.setLineDash([8 * dpr, 6 * dpr]);
        ctx.beginPath();
        pts.forEach((p, i) => { const s = this.toScreen(p.x, p.z); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
        ctx.stroke();
        ctx.setLineDash([]);
        for (const hold of dep.holds.filter(h => !h.cleared && h.d >= dep.distance)) {
            const at = dep.path.points.find(p => p.d >= hold.d) || pts[pts.length - 1];
            const s = this.toScreen(at.x, at.z);
            ctx.fillStyle = '#d0021b'; ctx.fillRect(s.x - 5 * dpr, s.y - 5 * dpr, 10 * dpr, 10 * dpr);
        }
    }
}
