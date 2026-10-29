/* Weather you can see: a cloud layer at the reported ceiling drifting with the wind, rain streaks or
   snowflakes around the camera, lightning in thunderstorms, and windsocks that swing and droop with the
   wind. Fog, sky color and light levels are set in main.js from the same conditions (metar.js). */
import * as THREE from 'three';
import { makeLights, KIND } from './lights.js';
import { CumulusField } from './cumulus.js';

const KT = 0.514444, FT = 0.3048;

// Tileable cloud noise: several octaves of smooth value noise that wrap at the edges.
function cloudTexture(size = 256) {
    const lattice = (n, seed) => { const g = []; let s = seed; for (let i = 0; i < n * n; i++) { s = (s * 16807) % 2147483647; g.push(s / 2147483647); } return g; };
    const octaves = [[4, 0.5], [8, 0.25], [16, 0.15], [32, 0.1]].map(([n, w], i) => ({ n, w, g: lattice(n, 1234 + i * 77) }));
    const smooth = t => t * t * (3 - 2 * t);
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        let v = 0;
        for (const { n, w, g } of octaves) {
            const fx = x / size * n, fy = y / size * n, ix = Math.floor(fx), iy = Math.floor(fy);
            const tx = smooth(fx - ix), ty = smooth(fy - iy);
            const at = (a, b) => g[((b % n + n) % n) * n + (a % n + n) % n];
            v += w * ((at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty);
        }
        const i = (y * size + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = Math.min(255, v * 255); data[i + 3] = 255;
    }
    const texture = new THREE.DataTexture(data, size, size);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}

function cloudMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: { map: { value: cloudTexture() }, cover: { value: 0 }, offset: { value: new THREE.Vector2() },
            light: { value: new THREE.Color(1, 1, 1) }, shade: { value: new THREE.Color(0.6, 0.62, 0.66) },
            haze: { value: new THREE.Color(0.7, 0.72, 0.75) } },
        vertexShader: `
            varying vec2 vUv; varying vec3 vView;
            void main() {
                vUv = uv;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vView = mv.xyz;          // Distance is taken per pixel: the deck is one huge quad.
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: `
            uniform sampler2D map; uniform float cover; uniform vec2 offset; uniform vec3 light, shade, haze;
            varying vec2 vUv; varying vec3 vView;
            void main() {
                float vDist = length(vView);
                // Broken layers: patches where the noise is thick enough.
                float n = texture2D(map, vUv * 9.0 + offset).r * 0.75 + texture2D(map, vUv * 31.0 + offset * 1.3).r * 0.25;
                float a = smoothstep(1.0 - cover - 0.12, 1.0 - cover + 0.18, n);
                float tone = smoothstep(0.4, 1.0, n);
                if (cover > 1.0) {
                    // Overcast: rolling stratocumulus. Billow noise (folded at its middle value) makes
                    // rounded masses with a dark, heavy core and light seams where they meet; a gentle warp
                    // keeps the masses from lining up.
                    vec2 uv = vUv * 26.0 + offset;
                    vec2 warp = vec2(texture2D(map, uv * 0.21).r, texture2D(map, uv * 0.21 + 0.37).r) - 0.5;
                    float b1 = abs(texture2D(map, uv + warp * 0.5).r * 2.0 - 1.0);
                    float b2 = abs(texture2D(map, uv * 2.3 + warp * 0.7 + 0.5).r * 2.0 - 1.0);
                    float fine = texture2D(map, uv * 7.0).r;
                    tone = 0.15 + 0.85 * smoothstep(0.0, 0.5, b1 * 0.62 + b2 * 0.3 + fine * 0.08);
                    a = 1.0;
                }
                vec3 color = mix(light, shade, tone);
                // Far away the deck merges into the brighter haze at the horizon.
                color = mix(color, haze, smoothstep(4000.0, 22000.0, vDist));
                if (cover <= 1.0) a *= 1.0 - smoothstep(9000.0, 30000.0, vDist);      // Broken layers thin out.
                if (a < 0.01) discard;
                gl_FragColor = vec4(color, a * (cover > 1.0 ? 1.0 : 0.95));
            }`,
        transparent: true, depthWrite: false, side: THREE.DoubleSide
    });
}

function windsockTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 10; canvas.height = 2;
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < 5; i++) { ctx.fillStyle = i % 2 ? '#f4f4f0' : '#ff6a13'; ctx.fillRect(i * 2, 0, 2, 2); }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    return texture;
}

export class WeatherScene {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);
        const sky = new THREE.PlaneGeometry(70000, 70000);
        sky.rotateX(-Math.PI / 2);
        this.cloud = new THREE.Mesh(sky, cloudMaterial());
        this.cloud.renderOrder = 10;
        this.group.add(this.cloud);
        this.cumulus = new CumulusField(this.group);

        // Rain: short streaks (two points each) in a box that follows the camera.
        this.box = { w: 260, h: 140 };
        this.drops = 9000;
        this.rainPos = new Float32Array(this.drops * 6);
        const rain = new THREE.BufferGeometry();
        rain.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
        this.rain = new THREE.LineSegments(rain, new THREE.LineBasicMaterial({ color: 0xb8c2cc, transparent: true, opacity: 0.35, depthWrite: false }));
        this.rain.frustumCulled = false;
        this.snowPos = new Float32Array(this.drops * 3);
        const snow = new THREE.BufferGeometry();
        snow.setAttribute('position', new THREE.BufferAttribute(this.snowPos, 3));
        this.snow = new THREE.Points(snow, new THREE.PointsMaterial({ color: 0xffffff, size: 0.14, transparent: true, opacity: 0.9, depthWrite: false }));
        this.snow.frustumCulled = false;
        for (let i = 0; i < this.drops; i++) {
            const x = (Math.random() - 0.5) * this.box.w, y = Math.random() * this.box.h, z = (Math.random() - 0.5) * this.box.w;
            this.rainPos.set([x, y, z, x, y, z], i * 6);
            this.snowPos.set([x, y, z], i * 3);
        }
        this.group.add(this.rain, this.snow);
        this.windsocks = [];
        this.time = 0;
        this.flash = 0;
        this.nextLightning = 5;
        this.onThunder = () => {};
        this.set(null);
    }

    /* Windsocks from apt.dat: an orange-and-white sock on a 6 m pole, a light on top where it's lit. */
    addWindsocks(airport, project) {
        for (const ws of this.windsocks) this.group.remove(ws.object);
        this.windsocks = [];
        const material = new THREE.MeshLambertMaterial({ map: windsockTexture(), side: THREE.DoubleSide });
        const pole = new THREE.MeshLambertMaterial({ color: 0xd8d8d8 });
        const lamps = [];
        for (const ws of airport.windsocks) {
            const p = project(ws);
            const object = new THREE.Group();
            object.position.set(p.x, 0, p.z);
            const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 6, 8), pole);
            mast.position.y = 3;
            const pivot = new THREE.Group();
            pivot.position.y = 6;
            pivot.rotation.order = 'YXZ';
            const sock = new THREE.CylinderGeometry(0.45, 0.2, 3.6, 16, 1, true);
            sock.rotateX(-Math.PI / 2);         // Along -z: the "nose" points downwind.
            sock.translate(0, 0, -1.8);
            pivot.add(new THREE.Mesh(sock, material));
            object.add(mast, pivot);
            this.group.add(object);
            this.windsocks.push({ object, pivot, phase: Math.random() * 10 });
            if (ws.lit) lamps.push({ pos: [p.x, 6.4, p.z], color: [1, 0.9, 0.7], size: 0.8, kind: KIND.airfield });
        }
        if (this.lamps) this.group.remove(this.lamps);
        this.lamps = lamps.length ? makeLights(lamps) : null;
        if (this.lamps) this.group.add(this.lamps);
    }

    /* New conditions (from metar.js), or null for none. */
    set(conditions) {
        this.conditions = conditions;
        const c = conditions || { cover: 0, clouds: [], precip: null, intensity: 0, wind: { dir: null, speed: 0, gust: 0 } };
        const lowest = c.clouds[0];
        // Overcast is a flat deck; anything less is heaped cumulus (towering in thunderstorms).
        this.cloud.visible = c.cover >= 1 && !!lowest;
        this.cumulus.build({ cover: c.cover < 1 ? c.cover : 0, baseM: lowest ? Math.min(3000, Math.max(300, lowest.baseFt * FT)) : 1200,
            towering: c.clouds.some(l => l.convective) });
        this.cloud.position.y = lowest ? Math.min(lowest.baseFt * FT, 4000) : 2000;
        this.cloud.material.uniforms.cover.value = c.cover >= 1 ? 1.2 : c.cover;
        const share = [0, 0.35, 0.7, 1][c.intensity] || 0;
        this.rain.visible = c.precip === 'rain' || c.precip === 'drizzle';
        this.snow.visible = c.precip === 'snow';
        this.rain.geometry.setDrawRange(0, Math.round(this.drops * share * (c.precip === 'drizzle' ? 0.5 : 1)) * 2);
        this.snow.geometry.setDrawRange(0, Math.round(this.drops * share));
        if (!c.thunder) this.flash = 0;
    }

    // Cloud colors for the time of day: lit tops and shaded bases. Rain and snow only reflect the light
    // around them, so they dim at night instead of glowing.
    setLight(dark, sunDir, sunColor, haze) {
        this.cumulus.setLight({ sunDir, sunColor, dark, haze });
        const ambient = 1 - dark * 0.88;
        this.snow.material.color.setScalar(0.92 * ambient);
        this.rain.material.color.setRGB(0.72, 0.76, 0.8).multiplyScalar(ambient);
        const u = this.cloud.material.uniforms, overcast = u.cover.value > 1;
        // Overcast decks are lit from above, so seen from below they're mostly gray with darker masses.
        u.light.value.setRGB(...(overcast ? [0.52, 0.54, 0.57] : [1, 1, 1])).lerp(new THREE.Color(0.08, 0.09, 0.11), dark);
        u.shade.value.setRGB(...(overcast ? [0.13, 0.14, 0.16] : [0.58, 0.6, 0.64])).lerp(new THREE.Color(0.03, 0.035, 0.045), dark);
        if (haze) u.haze.value.copy(haze);
    }

    /* Each frame (dt is sim seconds, 0 while paused). Returns the lightning flash, 0 to 1. */
    update(dt, camera) {
        const c = this.conditions;
        this.time += dt;
        const wind = c?.wind || { dir: null, speed: 0, gust: 0 };
        const to = ((wind.dir ?? 0) + 180) * Math.PI / 180;      // Wind blows toward the opposite of where it's from.
        const vx = Math.sin(to) * wind.speed * KT, vz = -Math.cos(to) * wind.speed * KT;
        const u = this.cloud.material.uniforms;
        this.cumulus.update(new THREE.Vector3(vx, 0, vz), dt, camera, this.flash);
        // Clouds drift with the wind: shifting the texture moves the pattern (uv x is east, uv y is north).
        u.offset.value.x -= vx * dt / 7800;
        u.offset.value.y += vz * dt / 7800;

        const box = this.box, cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
        const wrap = (v, center, size) => v - center > size / 2 ? v - size : v - center < -size / 2 ? v + size : v;
        if (this.rain.visible && dt > 0) {
            const fall = 9 * dt, streak = 0.6, p = this.rainPos;
            for (let i = 0; i < p.length; i += 6) {
                let x = p[i] + vx * dt, y = p[i + 1] - fall, z = p[i + 2] + vz * dt;
                if (y < cy - box.h / 2 || y < 0) y += box.h;
                x = wrap(x, cx, box.w); z = wrap(z, cz, box.w);
                if (y > cy + box.h / 2) y -= box.h;
                p[i] = x; p[i + 1] = y; p[i + 2] = z;
                p[i + 3] = x - vx * 0.06; p[i + 4] = y + streak; p[i + 5] = z - vz * 0.06;
            }
            this.rain.geometry.attributes.position.needsUpdate = true;
        }
        if (this.snow.visible && dt > 0) {
            const p = this.snowPos;
            for (let i = 0; i < p.length; i += 3) {
                const sway = Math.sin(this.time * 1.3 + i) * 0.4;
                let x = p[i] + (vx * 0.8 + sway) * dt, y = p[i + 1] - 1.2 * dt, z = p[i + 2] + (vz * 0.8 + sway) * dt;
                if (y < cy - box.h / 2 || y < 0) y += box.h;
                if (y > cy + box.h / 2) y -= box.h;
                p[i] = wrap(x, cx, box.w); p[i + 1] = y; p[i + 2] = wrap(z, cz, box.w);
            }
            this.snow.geometry.attributes.position.needsUpdate = true;
        }

        // Windsocks point downwind, standing straight out at 15 knots and drooping below that.
        for (const ws of this.windsocks) {
            const gusting = wind.gust ? (Math.sin(this.time * 2.1 + ws.phase) + 1) / 2 : 0;
            const speed = wind.speed + (wind.gust - wind.speed) * gusting * (wind.gust ? 1 : 0);
            const droop = (1 - Math.min(1, speed / 15)) * 1.35;
            const flutter = Math.sin(this.time * 9 + ws.phase) * 0.05 * Math.min(1, speed / 8);
            ws.pivot.rotation.y = -to + flutter + (wind.dir === null ? Math.sin(this.time * 0.2 + ws.phase) : 0);
            ws.pivot.rotation.x = -droop;
        }

        // Lightning: a bright double flash every 6 to 20 seconds; the thunder follows a few seconds later.
        if (c?.thunder && dt > 0) {
            this.nextLightning -= dt;
            if (this.nextLightning <= 0) {
                this.nextLightning = 6 + Math.random() * 14;
                this.flashAt = this.time;
                this.onThunder(1.5 + Math.random() * 6);
            }
            const since = this.time - (this.flashAt ?? -10);
            this.flash = since < 0.08 ? 1 : since < 0.16 ? 0.15 : since < 0.24 ? 0.8 : Math.max(0, 0.5 - (since - 0.24) * 4);
        } else this.flash = 0;
        return this.flash;
    }
}
