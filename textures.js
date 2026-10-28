/* Textures drawn in code, so they work for any airport and need no downloads: pavement, building walls
   and roofs. Each one tiles and is sized in meters, matching UVs that are in meters. */
import * as THREE from 'three';

const cache = new Map();

// The same pseudo-random sequence every time, so surfaces never shimmer between loads.
function random(seed) {
    return () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function make(key, size, widthM, heightM, draw) {
    if (cache.has(key)) return cache.get(key);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    draw(ctx, size, random(key.length * 7919 + size));
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1 / widthM, 1 / heightM);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    cache.set(key, texture);
    return texture;
}

function speckle(ctx, size, rand, count, light, dark, alpha) {
    for (let i = 0; i < count; i++) {
        const v = rand() < 0.5 ? light : dark;
        ctx.fillStyle = `rgba(${v},${v},${v},${alpha * rand()})`;
        const s = 1 + rand() * 2;
        ctx.fillRect(rand() * size, rand() * size, s, s);
    }
}

function blotches(ctx, size, rand, count, rgb, alpha, maxR) {
    for (let i = 0; i < count; i++) {
        const x = rand() * size, y = rand() * size, r = maxR * (0.3 + rand());
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${rgb},${alpha * rand()})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
}

export function asphalt(dark = false) {
    return make(dark ? 'runway-asphalt' : 'asphalt', 512, 24, 24, (ctx, s, rand) => {
        // Weathered asphalt is lighter than fresh: closer to what aerial photos of airports show.
        ctx.fillStyle = dark ? '#55585b' : '#6c6f72';
        ctx.fillRect(0, 0, s, s);
        blotches(ctx, s, rand, 40, '40,40,42', 0.18, 70);
        blotches(ctx, s, rand, 20, '140,140,138', 0.1, 60);
        speckle(ctx, s, rand, 6000, 150, 50, 0.25);
        // Crack sealant: thin dark wandering lines.
        ctx.strokeStyle = 'rgba(15,15,15,0.35)';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 5; i++) {
            let x = rand() * s, y = rand() * s;
            ctx.beginPath(); ctx.moveTo(x, y);
            for (let k = 0; k < 12; k++) { x += (rand() - 0.5) * 40; y += rand() * 25; ctx.lineTo(x, y); }
            ctx.stroke();
        }
    });
}

// Concrete apron in 25 ft (7.6 m) slabs, four across, each a slightly different shade.
export function concrete() {
    return make('concrete', 512, 30.4, 30.4, (ctx, s, rand) => {
        const slab = s / 4;
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
            const v = 158 + Math.round((rand() - 0.5) * 16);
            ctx.fillStyle = `rgb(${v},${v},${v - 5})`;
            ctx.fillRect(i * slab, j * slab, slab, slab);
        }
        blotches(ctx, s, rand, 30, '60,58,55', 0.18, 40);      // Oil and tire stains.
        speckle(ctx, s, rand, 8000, 200, 90, 0.35);
        ctx.fillStyle = 'rgba(40,40,40,0.55)';
        for (let k = 0; k <= 4; k++) { ctx.fillRect(k * slab - 1, 0, 2, s); ctx.fillRect(0, k * slab - 1, s, 2); }
    });
}

export function roof() {
    return make('roof', 512, 40, 40, (ctx, s, rand) => {
        ctx.fillStyle = '#d6d6d1';
        ctx.fillRect(0, 0, s, s);
        blotches(ctx, s, rand, 25, '150,150,145', 0.25, 60);
        speckle(ctx, s, rand, 5000, 240, 140, 0.3);
        ctx.strokeStyle = 'rgba(120,120,115,0.35)';
        for (let k = 0; k < s; k += s / 8) { ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k, s); ctx.stroke(); }
        // Rooftop units.
        for (let i = 0; i < 6; i++) {
            const w = 12 + rand() * 30, h = 10 + rand() * 20, x = rand() * (s - w), y = rand() * (s - h);
            ctx.fillStyle = 'rgba(95,98,100,0.85)'; ctx.fillRect(x, y, w, h);
            ctx.fillStyle = 'rgba(60,62,64,0.9)'; ctx.fillRect(x + 2, y + h - 3, w - 4, 3);
        }
    });
}

/* Walls. Wall UVs run along the wall (u) and up it (v), in meters. */
export function wall(kind) {
    switch (kind) {
        case 'glass': return make('wall-glass', 512, 12, 8, (ctx, s) => {
            // Curtain wall: two 4 m floors of glass with mullions every 1.5 m and a slab band at each floor.
            const g = ctx.createLinearGradient(0, 0, 0, s);
            g.addColorStop(0, '#7f97a8'); g.addColorStop(0.5, '#5a7184'); g.addColorStop(1, '#6d8597');
            ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
            ctx.fillStyle = '#c9ced1';
            for (let k = 0; k < 8; k++) ctx.fillRect(k * s / 8 - 2, 0, 4, s);
            for (const y of [0, s / 2]) ctx.fillRect(0, y, s, s * 0.07);
        });
        case 'garage': return make('wall-garage', 256, 12, 6, (ctx, s) => {
            // Two 3 m decks: a concrete parapet over a dark open level, columns every 6 m.
            ctx.fillStyle = '#26282a'; ctx.fillRect(0, 0, s, s);
            ctx.fillStyle = '#bdb8ae';
            for (const y of [0, s / 2]) ctx.fillRect(0, y, s, s * 0.2);
            for (const x of [0, s / 2]) ctx.fillRect(x, 0, s * 0.04, s);
        });
        case 'hangar': return make('wall-hangar', 256, 8, 8, (ctx, s) => {
            // Corrugated siding.
            for (let x = 0; x < s; x += 8) {
                ctx.fillStyle = (x / 8) % 2 ? '#f2f2ef' : '#d7d8d6';
                ctx.fillRect(x, 0, 8, s);
            }
        });
        default: return make('wall-office', 256, 12, 8, (ctx, s) => {
            // Punched windows, three per bay on each 4 m floor.
            ctx.fillStyle = '#cfc9be'; ctx.fillRect(0, 0, s, s);
            ctx.fillStyle = '#3d4d5b';
            for (const y of [s * 0.12, s * 0.62]) for (let k = 0; k < 4; k++) ctx.fillRect(k * s / 4 + s / 16, y, s / 8, s * 0.22);
        });
    }
}

/* What glows on a wall at night: warm lit windows (some rooms dark), black everywhere else. Same size
   and layout as wall(kind), so the glow lines up with the windows. */
export function wallGlow(kind) {
    const lit = (ctx, x, y, w, h, rand) => {
        const v = rand();
        ctx.fillStyle = v < 0.3 ? '#000' : v < 0.85 ? '#ffd9a0' : '#cfe3ff';
        ctx.fillRect(x, y, w, h);
    };
    if (kind === 'glass') return make('glow-glass', 512, 12, 8, (ctx, s, rand) => {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, s, s);
        for (let floor = 0; floor < 2; floor++) for (let k = 0; k < 8; k++)
            lit(ctx, k * s / 8 + 3, floor * s / 2 + s * 0.08, s / 8 - 6, s / 2 - s * 0.1, rand);
    });
    return make('glow-office', 256, 12, 8, (ctx, s, rand) => {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, s, s);
        for (const y of [s * 0.12, s * 0.62]) for (let k = 0; k < 4; k++) lit(ctx, k * s / 4 + s / 16, y, s / 8, s * 0.22, rand);
    });
}
