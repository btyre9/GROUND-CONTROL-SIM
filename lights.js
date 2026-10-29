/* Point lights drawn as glowing dots: aircraft beacons, strobes, nav and landing lights, and the
   airfield's taxiway and runway lights. They stay a few pixels wide however far away, like real lights
   seen from the tower, and fade in as it gets dark (beacons and strobes show in daylight too). */
import * as THREE from 'three';

// Shared by every light: time for flashing, darkness from 0 (day) to 1 (night), and screen scale.
// uHaze (0 to 1) widens each light into a halo in fog, mist or rain.
// uFogFar fades lights out in fog, a little beyond where buildings disappear (lights carry farther).
export const lightUniforms = { uTime: { value: 0 }, uDark: { value: 0 }, uScale: { value: 400 }, uHaze: { value: 0 }, uFogFar: { value: 1e6 } };

// Kinds: how a light behaves.
export const KIND = { steady: 0, beacon: 1, strobe: 2, landing: 3, airfield: 4, taxi: 5 };

const vertexShader = `
    attribute vec3 color;
    attribute float size;
    attribute float kind;
    attribute float phase;
    uniform float uTime, uDark, uScale, uHaze, uFogFar;
    uniform vec4 uOn;          // Switches for beacon, strobe, landing and steady lights.
    uniform float uTaxi;       // Switch for the nose gear taxi light.
    varying vec3 vColor;
    varying float vBright;
    void main() {
        float on = 1.0;
        if (kind < 0.5) on = uOn.w * uDark;
        else if (kind < 1.5) { float t = fract(uTime * 0.9 + phase); on = uOn.x * (t < 0.12 ? 1.0 : 0.0) * (0.35 + 0.65 * uDark); }
        else if (kind < 2.5) { float t = fract(uTime * 0.8 + phase); on = uOn.y * ((t < 0.05 || (t > 0.12 && t < 0.17)) ? 1.0 : 0.0); }
        else if (kind < 3.5) on = uOn.z * (0.25 + 0.75 * uDark);
        else if (kind < 4.5) on = uDark;
        else on = uTaxi * (0.25 + 0.75 * uDark);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        on *= 1.0 - smoothstep(uFogFar * 0.7, uFogFar * 1.8, -mv.z);
        vColor = color;
        vBright = on;
        gl_PointSize = on > 0.0 ? max(2.0, size * (1.0 + uHaze * 1.5) * uScale / -mv.z) : 0.0;
        gl_Position = projectionMatrix * mv;
    }`;

/* A hot core brighter than white (so bloom picks it up) inside a glow that fades like light does,
   reaching nothing well before the sprite's edge so there is no visible rim. In haze the glow spreads. */
const fragmentShader = `
    uniform float uHaze;
    varying vec3 vColor;
    varying float vBright;
    void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (vBright <= 0.0 || d >= 1.0) discard;
        float spread = 1.0 + uHaze * 1.5;
        float core = exp(-pow(d * spread * 3.2, 2.0)) * 3.5;
        float falloff = 7.0 - uHaze * 3.0;
        float halo = (exp(-d * d * falloff) - exp(-falloff)) / (1.0 - exp(-falloff)) * 0.25 * (0.3 + uHaze);
        gl_FragColor = vec4(vColor * vBright * (core + halo), 1.0);
    }`;

export function lightMaterial(on = [1, 1, 1, 1], taxi = 0) {
    return new THREE.ShaderMaterial({
        uniforms: { ...lightUniforms, uOn: { value: new THREE.Vector4(...on) }, uTaxi: { value: taxi } },
        vertexShader, fragmentShader, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
}

/* lights: [{ pos: [x, y, z], color: [r, g, b], size (meters of glow), kind, phase }] */
export function makeLights(lights, material = lightMaterial()) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(lights.flatMap(l => l.pos), 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(lights.flatMap(l => l.color), 3));
    geometry.setAttribute('size', new THREE.Float32BufferAttribute(lights.map(l => l.size), 1));
    geometry.setAttribute('kind', new THREE.Float32BufferAttribute(lights.map(l => l.kind), 1));
    geometry.setAttribute('phase', new THREE.Float32BufferAttribute(lights.map(l => l.phase ?? 0), 1));
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    return points;
}
