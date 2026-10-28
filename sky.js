/* The sky over the airport for a real date and time: an atmosphere that scatters sunlight (blue by day,
   gold and red near sunrise and sunset, the sun's disk), stars after dark, and the moon in its real phase.
   It also says what light falls on the scene: sun color and strength, sky and ground light, the haze
   color at the horizon, moonlight, and how dark it is (0 day, 1 night). */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Colors by sun elevation in degrees, interpolated between the stops.
function ramp(stops, elevation) {
    if (elevation >= stops[0][0]) return new THREE.Color(stops[0][1]);
    for (let i = 1; i < stops.length; i++) {
        const [e1, c1] = stops[i - 1], [e2, c2] = stops[i];
        if (elevation >= e2) return new THREE.Color(c2).lerp(new THREE.Color(c1), (elevation - e2) / (e1 - e2));
    }
    return new THREE.Color(stops[stops.length - 1][1]);
}
const HORIZON = [[20, 0xbccfe2], [8, 0xd8ccb8], [2, 0xe9a77a], [-2, 0xb07c74], [-6, 0x4b4560], [-12, 0x151b2c], [-18, 0x070b16]];
const SUNLIGHT = [[20, 0xfff4e0], [8, 0xffd7a8], [2, 0xff9a5a], [0, 0xff7a40]];
const SKYLIGHT = [[20, 0xdfeaff], [4, 0xffd3b4], [-4, 0x8a7ca8], [-12, 0x3a4870], [-18, 0x2a3555]];
const GROUND = [[20, 0x77736a], [0, 0x4a4540], [-8, 0x5a4a30]];          // Sodium floodlights after dark.

const direction = (azimuth, elevation) => {
    const a = THREE.MathUtils.degToRad(azimuth), e = THREE.MathUtils.degToRad(elevation);
    return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
};

// The moon's face, lit from one side by its phase.
function moonTexture(lit, waxing) {
    const size = 128, canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d'), r = size / 2 - 2, c = size / 2;
    ctx.fillStyle = 'rgba(40,44,52,0.35)';                  // Earthshine on the dark part.
    ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill();
    const img = ctx.getImageData(0, 0, size, size);
    const k = 1 - 2 * lit;                                   // Terminator position across the disk.
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const dx = (x - c) / r, dy = (y - c) / r;
        if (dx * dx + dy * dy > 1) continue;
        const half = Math.sqrt(1 - dy * dy);
        const sx = waxing ? dx : -dx;                        // Waxing moons are lit on the right (northern sky).
        if (sx > k * half) {
            const i = (y * size + x) * 4, mare = 0.85 + 0.15 * Math.sin(x * 0.21) * Math.cos(y * 0.17);
            img.data[i] = img.data[i + 1] = 235 * mare; img.data[i + 2] = 225 * mare; img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

export class SkyDome {
    constructor(scene) {
        this.sky = new Sky();
        this.sky.scale.setScalar(50000);
        this.sky.renderOrder = -2000;                         // Behind everything, before the flat ground layers.
        const m = this.sky.material;
        m.uniforms.turbidity.value = 2.2;
        m.uniforms.rayleigh.value = 2.4;
        m.uniforms.mieCoefficient.value = 0.003;
        m.uniforms.mieDirectionalG.value = 0.8;
        // The atmosphere is computed far brighter than the rest of the scene; scale it to sit with it.
        m.uniforms.skyGain = { value: 0.3 };
        m.fragmentShader = 'uniform float skyGain;\n' + m.fragmentShader.replace('gl_FragColor = vec4( retColor, 1.0 );', 'gl_FragColor = vec4( retColor * skyGain, 1.0 );');
        scene.add(this.sky);

        // Stars: a few thousand points far away, brighter ones rarer.
        const n = 2500, pos = new Float32Array(n * 3), color = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const u = Math.random(), v = Math.random() * 0.95 + 0.05;
            const a = u * Math.PI * 2, e = Math.asin(v);
            pos.set([Math.cos(a) * Math.cos(e) * 45000, Math.sin(e) * 45000, Math.sin(a) * Math.cos(e) * 45000], i * 3);
            const b = Math.pow(Math.random(), 3) * 0.9 + 0.1;
            color.set([b, b, b * (0.9 + Math.random() * 0.2)], i * 3);
        }
        const stars = new THREE.BufferGeometry();
        stars.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        stars.setAttribute('color', new THREE.BufferAttribute(color, 3));
        this.stars = new THREE.Points(stars, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true,
            transparent: true, depthWrite: false, fog: false }));
        this.stars.renderOrder = -1999;
        scene.add(this.stars);

        this.moon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false }));
        this.moon.renderOrder = -1998;
        this.moon.scale.setScalar(1300);                     // About 1.6°, three times life size, as the eye perceives it.
        scene.add(this.moon);
        this.moonLight = new THREE.DirectionalLight(0x9fb4ff, 0);
        scene.add(this.moonLight);
        this.moonKey = '';
    }

    // Each frame: keep the sky, stars and moon centered on the camera, the moon facing it.
    follow(camera) {
        this.sky.position.copy(camera.position);
        this.stars.position.copy(camera.position);
        if (this.moonDir) {
            this.moon.position.copy(camera.position).addScaledVector(this.moonDir, 40000);
            this.moon.lookAt(camera.position);
        }
    }

    /* Lighting for this moment. cover is cloud cover 0 to 1; clouded hides the sky dome behind overcast. */
    update({ date, lat, lon, cover, clouded, camera }) {
        const sun = window.Astro.sun(date, lat, lon), moon = window.Astro.moon(date, lat, lon);
        const sunDir = direction(sun.azimuth, sun.elevation);
        this.sky.material.uniforms.sunPosition.value.copy(sunDir);
        this.sky.visible = !clouded;
        const dark = smooth(8, -8, sun.elevation);
        const clear = 1 - cover;

        this.stars.visible = dark > 0.6 && !clouded;
        this.stars.material.opacity = (dark - 0.6) / 0.4 * clear;

        // The moon, placed at its real position; the texture is redrawn only when the phase changes visibly.
        const moonDir = direction(moon.azimuth, moon.elevation);
        this.moonDir = moonDir;
        this.moon.visible = moon.elevation > -2 && !clouded;
        this.follow(camera);
        const key = `${Math.round(moon.lit * 40)}${moon.waxing}`;
        if (key !== this.moonKey) {
            this.moonKey = key;
            this.moon.material.map?.dispose();
            this.moon.material.map = moonTexture(moon.lit, moon.waxing);
            this.moon.material.needsUpdate = true;
        }
        // Bright enough to bloom at night, pale by day.
        this.moon.material.color.setScalar(0.35 + dark * 0.85);
        const moonUp = smooth(0, 12, moon.elevation);
        this.moonLight.intensity = 0.35 * moon.lit * moonUp * dark * (1 - cover * 0.8);
        this.moonLight.position.copy(moonDir).multiplyScalar(5000);

        const sunUp = smooth(-1, 12, sun.elevation);
        return {
            dark, sunDir,
            sunColor: ramp(SUNLIGHT, sun.elevation), sunIntensity: 2.4 * sunUp,
            skyColor: ramp(SKYLIGHT, sun.elevation), groundColor: ramp(GROUND, sun.elevation),
            skyIntensity: 0.32 + 1.28 * smooth(-14, 15, sun.elevation),
            horizon: ramp(HORIZON, sun.elevation),
            sun, moon
        };
    }
}
