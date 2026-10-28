/* Cumulus clouds: each one a heap of soft puffs, flat at the base and piled up on top, lit by the sun
   on its upper side and shaded underneath, golden at sunrise and sunset. They drift with the wind across
   a field around the airport and fade into the haze far away. All puffs are drawn in one call; their
   drift and wrap-around happen on the graphics card. */
import * as THREE from 'three';

const FIELD = 26000;           // Meters across the square of sky the clouds wrap around in.

// A soft round puff with a lumpy edge, white with alpha.
function puffTexture() {
    const size = 128, canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    // Many faint, overlapping blobs with long soft falloffs, so no puff has a round edge.
    for (let i = 0; i < 26; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * size * 0.2;
        const x = size / 2 + Math.cos(a) * r, y = size / 2 + Math.sin(a) * r, rad = size * (0.12 + Math.random() * 0.2);
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, 'rgba(255,255,255,0.3)');
        g.addColorStop(0.35, 'rgba(255,255,255,0.18)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

const vertexShader = `
    attribute vec3 offset;      // Puff center in the cloud field.
    attribute float size;
    attribute float height;     // 0 at the cloud's base to 1 at its top.
    attribute vec3 normal2;     // Which way this puff faces out of its cloud.
    uniform vec3 drift, center, sunDir;
    uniform float field;
    varying vec2 vUv;
    varying float vLit, vHeight, vDist;
    void main() {
        vec3 p = offset;
        // Drift with the wind, wrapping around the field kept centered on the camera.
        p.xz = mod(p.xz + drift.xz - center.xz + field * 0.5, field) - field * 0.5 + center.xz;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        mv.xy += position.xy * size;                       // Always facing the camera.
        vUv = uv;
        vHeight = height;
        vLit = clamp(dot(normal2, sunDir) * 0.5 + 0.5, 0.0, 1.0);
        vDist = length(mv.xyz);
        gl_Position = projectionMatrix * mv;
    }`;

const fragmentShader = `
    uniform sampler2D map;
    uniform vec3 sunColor, shade, haze;
    uniform float opacity, sunUp, flash, fadeFar;
    varying vec2 vUv;
    varying float vLit, vHeight, vDist;
    void main() {
        vec4 tex = texture2D(map, vUv);
        if (tex.a < 0.01) discard;
        // Tops and the sun-facing side catch the sun; bases sit in shade.
        float light = mix(0.25, 1.0, smoothstep(0.0, 1.0, vHeight * 0.6 + vLit * 0.6)) * sunUp;
        vec3 color = mix(shade, sunColor, light) + flash * vec3(0.8, 0.85, 1.0);
        float fade = smoothstep(fadeFar, fadeFar * 0.45, vDist);
        color = mix(haze, color, 0.35 + 0.65 * fade);
        gl_FragColor = vec4(color, tex.a * opacity * fade);
    }`;

export class CumulusField {
    constructor(group) {
        const quad = new THREE.PlaneGeometry(1, 1);
        this.geometry = new THREE.InstancedBufferGeometry();
        this.geometry.index = quad.index;
        this.geometry.setAttribute('position', quad.attributes.position);
        this.geometry.setAttribute('uv', quad.attributes.uv);
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                map: { value: puffTexture() }, drift: { value: new THREE.Vector3() }, center: { value: new THREE.Vector3() },
                field: { value: FIELD }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color(1, 1, 1) },
                shade: { value: new THREE.Color(0.55, 0.58, 0.64) }, haze: { value: new THREE.Color(0.75, 0.8, 0.86) },
                opacity: { value: 0.9 }, sunUp: { value: 1 }, flash: { value: 0 }, fadeFar: { value: 22000 }
            },
            vertexShader, fragmentShader, transparent: true, depthWrite: false, fog: false
        });
        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 5;
        this.mesh.visible = false;
        group.add(this.mesh);
    }

    /* A new sky: how many clouds (from cover), where their bases are, and whether they tower. */
    build({ cover, baseM, towering }) {
        const clouds = Math.round(cover >= 0.75 ? 150 : cover >= 0.45 ? 70 : cover > 0 ? 28 : 0);
        this.mesh.visible = clouds > 0;
        if (!clouds) return;
        const offsets = [], sizes = [], heights = [], normals = [];
        for (let c = 0; c < clouds; c++) {
            const cx = (Math.random() - 0.5) * FIELD, cz = (Math.random() - 0.5) * FIELD;
            const radius = 250 + Math.random() * 550;
            const tall = radius * (towering ? 2.2 + Math.random() * 1.5 : 0.5 + Math.random() * 0.4);
            const puffs = Math.round(24 + radius / 18);
            for (let i = 0; i < puffs; i++) {
                // A dome: wide at the base, narrowing as it rises.
                const h = Math.pow(Math.random(), 1.6);
                const spread = radius * (1 - h * 0.65);
                const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
                const x = Math.cos(a) * r, z = Math.sin(a) * r, y = h * tall;
                offsets.push(cx + x, baseM + y + radius * 0.15, cz + z);
                sizes.push(radius * (0.35 + Math.random() * 0.4) * (1 - h * 0.35));
                heights.push(h);
                const n = new THREE.Vector3(x, y * 0.8 + radius * 0.25, z).normalize();
                normals.push(n.x, n.y, n.z);
            }
        }
        const attr = (data, n) => new THREE.InstancedBufferAttribute(new Float32Array(data), n);
        this.geometry.setAttribute('offset', attr(offsets, 3));
        this.geometry.setAttribute('size', attr(sizes, 1));
        this.geometry.setAttribute('height', attr(heights, 1));
        this.geometry.setAttribute('normal2', attr(normals, 3));
        this.geometry.instanceCount = sizes.length;
    }

    // Sunlight on the clouds; dark is 0 by day and 1 at night.
    setLight({ sunDir, sunColor, dark, haze }) {
        const u = this.material.uniforms;
        if (sunDir) u.sunDir.value.copy(sunDir);
        // Warm sunlight at low sun; at night the clouds are only faintly visible.
        if (sunColor) u.sunColor.value.copy(sunColor).multiplyScalar(1.15);
        u.sunUp.value = 1 - dark * 0.9;
        u.shade.value.setRGB(0.52, 0.55, 0.62).multiplyScalar(1 - dark * 0.88);
        if (haze) u.haze.value.copy(haze);
    }

    update(windVelocity, dt, camera, flash) {
        const u = this.material.uniforms;
        u.drift.value.addScaledVector(windVelocity, dt);
        u.center.value.copy(camera.position);
        u.flash.value = flash;
    }
}
