/* Weather and atmosphere for the ramp, done the way the browser game Slow Roads does it, plus wet and
   snowy ground:

   - Sky and fog are one function. Every material's fog is replaced by a radial exp² fog whose color
     blends from a horizon color to a zenith color by how high the view looks, with a glow toward the
     sun and a noisy haze that hugs the ground. Overcast, rain, snow and fog skies are a big sphere
     drawn entirely in that fog, so ground and sky meet with no seam. Clear skies keep the scattering
     sky (sky.js) with fog colors taken from its horizon.
   - A look table per weather (colors, visibility, haze, cloud cover, sun dimming) is blended with the
     time of day; that table, more than any physics, is where the look comes from.
   - Clouds are one plane at the ceiling, following the camera: a tiling noise texture sampled at two
     scales drifting with the wind, lit on its underside, its far edges bent down to the horizon.
   - Rain and snow fall entirely on the GPU: each drop's position wraps around a box that moves with
     the camera (mod() in the vertex shader), so nothing is uploaded per frame. Rain is drawn as short
     streaks along its fall, snow as soft flakes that sway.
   - Wet ground darkens and turns glossy, with puddles (a noise mask) almost mirror smooth, rippling in
     rain, so they reflect the sky and floodlights. Snow settles on upward-facing surfaces of the ramp,
     bridge and equipment (not on the aircraft or people, which have just arrived).

   Materials are changed with onBeforeCompile (chained after any change they already have) and share
   one set of uniforms, so a weather change reaches everything at once. */
import * as THREE from 'three';

// Shared by every patched material.
export const U = {
    uFogHorizon: { value: new THREE.Color() }, uFogZenith: { value: new THREE.Color() }, uFogDensity: { value: 0.0002 },
    uFogNear: { value: 50 }, uHaze: { value: 0 }, uHazeHeight: { value: 30 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunGlow: { value: new THREE.Color() }, uWeatherTime: { value: 0 }, uWet: { value: 0 }, uSnowCover: { value: 0 }, uRain: { value: 0 }
};

/* The look of each weather, by day; night darkens it in update(). cover: cloud cover; ceiling in
   meters; visibility in meters (sets fog density); haze: ground haze strength; sun: how much direct
   sun gets through; wet, snowCover: on the ground; precip: 'rain' | 'snow' and its rate (0 to 1). */
export const WEATHER = {
    clear:     { label: 'Clear', cover: 0, ceiling: 1500, visibility: 30000, haze: 0.15, sun: 1, wet: 0, snowCover: 0 },
    scattered: { label: 'Scattered clouds', cover: 0.45, ceiling: 1100, visibility: 20000, haze: 0.2, sun: 0.9, wet: 0, snowCover: 0,
        cloudLight: 0xf4f6f8, cloudDark: 0x9aa4b0 },
    overcast:  { label: 'Overcast', cover: 1, ceiling: 500, visibility: 9000, haze: 0.35, sun: 0.12, wet: 0, snowCover: 0, gray: 0.75,
        horizon: 0xb4bcc4, zenith: 0x8d969f, cloudLight: 0xb9c0c7, cloudDark: 0x6d757e },
    rain:      { label: 'Rain', cover: 1, ceiling: 300, visibility: 3500, haze: 0.55, sun: 0.05, wet: 1, snowCover: 0, gray: 0.9,
        horizon: 0x8f979f, zenith: 0x6b737c, cloudLight: 0x8c949c, cloudDark: 0x4c535a, precip: 'rain', rate: 0.8 },
    snow:      { label: 'Snow', cover: 1, ceiling: 350, visibility: 1600, haze: 0.6, sun: 0.08, wet: 0.25, snowCover: 0.85, gray: 0.9,
        horizon: 0xd6dce2, zenith: 0xb7bfc8, cloudLight: 0xd2d8de, cloudDark: 0x98a1aa, precip: 'snow', rate: 0.8 },
    fog:       { label: 'Fog', cover: 1, ceiling: 60, visibility: 400, haze: 1, sun: 0.04, wet: 0.35, snowCover: 0, gray: 1,
        horizon: 0xc3c8cc, zenith: 0xb3b9be, cloudLight: 0xc0c5c9, cloudDark: 0xa0a6ab }
};

const NOISE = `
    float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float wNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(wHash(i), wHash(i + vec2(1, 0)), u.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), u.x), u.y);
    }
    float wFbm(vec2 p) { return wNoise(p) * 0.5 + wNoise(p * 2.03) * 0.3 + wNoise(p * 4.1) * 0.2; }`;

/* Changes a material: world position and normal for the effects, the sky-and-fog function in place
   of three's fog, and (for lit materials) wet and snowy surfaces. snow: whether snow settles on it;
   sky: the material is the sky itself (always fully fog). */
export function patchMaterial(material, { snow = true, sky = false } = {}) {
    if (material.userData.weather) return;
    material.userData.weather = true;
    const before = material.onBeforeCompile;
    const beforeKey = material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
        before?.call(material, shader, renderer);
        Object.assign(shader.uniforms, U);
        const lit = shader.fragmentShader.includes('#include <roughnessmap_fragment>');
        const normals = shader.vertexShader.includes('#include <beginnormal_vertex>') && lit;
        shader.vertexShader = 'varying vec3 vWPos;\nvarying vec3 vWN;\n' + shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
            vec4 wPos = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
                wPos = instanceMatrix * wPos;
            #endif
            wPos = modelMatrix * wPos;
            vWPos = wPos.xyz;
            ${normals ? 'vWN = normalize(mat3(modelMatrix) * objectNormal);' : 'vWN = vec3(0.0, 1.0, 0.0);'}`);
        let fs = `varying vec3 vWPos;\nvarying vec3 vWN;
            uniform vec3 uFogHorizon, uFogZenith, uSunDir, uSunGlow;
            uniform float uFogDensity, uFogNear, uHaze, uHazeHeight, uWeatherTime, uWet, uSnowCover, uRain;
            ${NOISE}\n` + shader.fragmentShader;
        if (lit) {
            // Wet: horizontal surfaces darken and gloss over; puddles on the ground go almost mirror
            // smooth. Snow: upward-facing surfaces turn white and matte, thinner on slopes and in patches.
            fs = fs.replace('#include <map_fragment>', `#include <map_fragment>
                float wUp = smoothstep(0.55, 0.9, vWN.y);
                float wGround = wUp * step(vWPos.y, 0.3);
                float wPuddle = wGround * smoothstep(0.58, 0.68, wFbm(vWPos.xz * 0.12));
                float wWet = uWet * (0.35 + 0.65 * wUp);
                diffuseColor.rgb *= 1.0 - 0.38 * wWet - 0.25 * uWet * wPuddle;
                // The ramp is plowed: a dusting with drifts in patches, so markings show through;
                // roofs, the bridge and equipment are covered.
                float wDrift = mix(0.3, 1.0, smoothstep(0.5, 0.62, wFbm(vWPos.xz * 0.22)));
                float wSnow = ${snow ? 'uSnowCover * wUp * mix(1.0, wDrift, wGround)' : '0.0'};
                diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.92, 0.95), clamp(wSnow, 0.0, 1.0));`)
                .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
                roughnessFactor = mix(roughnessFactor, mix(0.3, 0.04, wPuddle), wWet * 0.9);
                roughnessFactor = mix(roughnessFactor, 0.8, clamp(wSnow, 0.0, 1.0));`)
                .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
                // Rain rings on the puddles: rippled normals.
                if (uRain > 0.0 && wPuddle > 0.0) {
                    vec2 rp = vWPos.xz * 3.0;
                    vec2 cell = floor(rp), f = fract(rp) - 0.5;
                    float t = fract(uWeatherTime * 0.8 + wHash(cell));
                    float ring = sin((length(f) - t * 0.5) * 40.0) * (1.0 - t) * smoothstep(0.5, 0.0, length(f));
                    normal = normalize(normal + (viewMatrix * vec4(f.x * ring, 0.0, f.y * ring, 0.0)).xyz * 0.6 * uRain * wPuddle);
                }`);
        }
        fs = fs.replace('#include <fog_fragment>', `
            #ifdef USE_FOG
                vec3 wView = vWPos - cameraPosition;
                float wDist = length(wView);
                vec3 wDir = wView / max(wDist, 1e-3);
                vec3 wFogColor = mix(uFogHorizon, uFogZenith, smoothstep(0.0, 0.45, wDir.y));
                wFogColor += uSunGlow * pow(max(dot(wDir, uSunDir), 0.0), 6.0);
                float wFog = 1.0 - exp(-pow(uFogDensity * max(wDist - uFogNear, 0.0), 2.0));
                // Ground haze: thicker low down, its top lifted and lowered by noise.
                float wTop = uHazeHeight * (0.6 + 0.8 * wNoise(vWPos.xz * 0.004));
                float wLow = exp(-max(min(vWPos.y, cameraPosition.y + wDir.y * wDist * 0.5), 0.0) / max(wTop, 1.0));
                wFog = max(wFog, uHaze * wLow * (1.0 - exp(-wDist * 0.0012)));
                ${sky ? 'wFog = 1.0;' : ''}
                gl_FragColor.rgb = mix(gl_FragColor.rgb, wFogColor, clamp(wFog, 0.0, 1.0));
            #endif`);
        shader.fragmentShader = fs;
    };
    material.customProgramCacheKey = () => `${beforeKey ? beforeKey() : ''}|weather${snow ? '+snow' : ''}${sky ? '+sky' : ''}`;
    material.needsUpdate = true;
}

export function patchObject(object, options) {
    object.traverse(o => {
        if (!o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            if (m.isMeshStandardMaterial || m.isMeshBasicMaterial || m.isMeshPhongMaterial || m.isMeshLambertMaterial) patchMaterial(m, options);
        }
    });
}

/* A tiling noise texture for the clouds: fractal value noise that wraps at the edges. */
function cloudTexture(size = 256) {
    const data = new Uint8Array(size * size * 4);
    const grid = (n, seed) => {
        const g = new Float32Array(n * n);
        let s = seed;
        for (let i = 0; i < g.length; i++) { s = (s * 16807) % 2147483647; g[i] = s / 2147483647; }
        return g;
    };
    const octaves = [[4, 0.5, grid(4, 11)], [8, 0.25, grid(8, 23)], [16, 0.15, grid(16, 37)], [32, 0.1, grid(32, 53)]];
    const smooth = t => t * t * (3 - 2 * t);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        let v = 0;
        for (const [n, amp, g] of octaves) {
            const fx = x / size * n, fy = y / size * n, ix = Math.floor(fx), iy = Math.floor(fy);
            const tx = smooth(fx - ix), ty = smooth(fy - iy);
            const at = (i, j) => g[((j + n) % n) * n + ((i + n) % n)];
            v += amp * ((at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty);
        }
        const i = (y * size + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = Math.round(v * 255);
        data[i + 3] = 255;
    }
    const t = new THREE.DataTexture(data, size, size);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
}

/* Falling rain or snow: count drops in a box that follows the camera. */
function precipitation(kind, count) {
    // Snow packs closer round the camera than rain: flakes are only seen near by.
    const box = kind === 'rain' ? new THREE.Vector3(60, 30, 60) : new THREE.Vector3(32, 18, 32);
    const seeds = new Float32Array(count * 3 * (kind === 'rain' ? 2 : 1));
    const ends = new Float32Array(count * (kind === 'rain' ? 2 : 1));
    for (let i = 0; i < count; i++) {
        const s = [Math.random(), Math.random(), Math.random()];
        if (kind === 'rain') { seeds.set(s, i * 6); seeds.set(s, i * 6 + 3); ends[i * 2 + 1] = 1; }
        else seeds.set(s, i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
    geometry.setAttribute('end', new THREE.BufferAttribute(ends, 1));
    const uniforms = {
        uTime: { value: 0 }, uBox: { value: box }, uCenter: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2(1.5, 0.5) },
        uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uScale: { value: 400 }
    };
    const fall = kind === 'rain' ? 9.0 : 1.1;
    const material = new THREE.ShaderMaterial({
        uniforms, transparent: true, depthWrite: false,
        vertexShader: `
            attribute float end;
            uniform float uTime, uScale; uniform vec3 uBox, uCenter; uniform vec2 uWind;
            varying float vFade;
            void main() {
                vec3 p = position * uBox;
                p.y -= uTime * ${fall.toFixed(1)} * (0.85 + 0.3 * position.x);
                p.xz += uWind * uTime * ${kind === 'rain' ? '1.0' : '0.6'};
                ${kind === 'snow' ? 'p.x += sin(uTime * 1.3 + position.z * 40.0) * 0.6; p.z += cos(uTime * 1.1 + position.x * 40.0) * 0.6;' : ''}
                // Wrap into the box around the camera.
                p = mod(p - (uCenter - uBox * 0.5), uBox) + (uCenter - uBox * 0.5);
                ${kind === 'rain' ? `p -= end * vec3(uWind.x, -${fall.toFixed(1)}, uWind.y) * 0.035;` : ''}
                vec4 mv = modelViewMatrix * vec4(p, 1.0);
                vFade = 1.0 - smoothstep(uBox.x * 0.3, uBox.x * 0.5, length(mv.xyz));
                gl_Position = projectionMatrix * mv;
                // Flakes drawn a little larger than life (they'd be motion-blurred streaks), never under 2 px.
                gl_PointSize = max(2.0, uScale * 0.07 / -mv.z);
            }`,
        fragmentShader: `
            uniform vec3 uColor; uniform float uOpacity;
            varying float vFade;
            void main() {
                ${kind === 'snow' ? 'float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; float a = smoothstep(0.5, 0.25, d);' : 'float a = 1.0;'}
                gl_FragColor = vec4(uColor, a * uOpacity * vFade);
            }`
    });
    const object = kind === 'rain' ? new THREE.LineSegments(geometry, material) : new THREE.Points(geometry, material);
    object.frustumCulled = false;
    object.renderOrder = 10;
    return { object, uniforms };
}

export class Atmosphere {
    constructor(scene) {
        this.scene = scene;
        this.weather = WEATHER.clear;
        // Fog must be on for materials to compile their fog; the values come from the uniforms.
        scene.fog = new THREE.FogExp2(0xffffff, 0.0002);

        // Sky for clouded weather: a sphere drawn entirely in fog.
        const skyMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, depthWrite: false });
        patchMaterial(skyMaterial, { sky: true });
        this.skySphere = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), skyMaterial);
        this.skySphere.renderOrder = -1999;
        this.skySphere.frustumCulled = false;
        scene.add(this.skySphere);

        // Cloud deck.
        this.cloudUniforms = {
            uClouds: { value: cloudTexture() }, uCover: { value: 0 }, uOffset: { value: new THREE.Vector2() },
            uLight: { value: new THREE.Color() }, uDark: { value: new THREE.Color() }, uHeight: { value: 800 }, uRadius: { value: 7000 }
        };
        const cloudMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
        cloudMaterial.onBeforeCompile = shader => {
            Object.assign(shader.uniforms, this.cloudUniforms);
            shader.vertexShader = 'uniform float uHeight, uRadius;\nvarying vec2 vCloudUv;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
                vec4 cw = modelMatrix * vec4(transformed, 1.0);
                vCloudUv = cw.xz;
                // Bend the far edges down toward the horizon, as the curve of a real deck looks. The
                // plane is turned flat, so its local +z points down.
                float d = length(transformed.xy) / uRadius;
                transformed.z += d * d * uHeight * 0.95;`);
            shader.fragmentShader = 'uniform sampler2D uClouds;\nuniform float uCover;\nuniform vec2 uOffset;\nuniform vec3 uLight, uDark;\nvarying vec2 vCloudUv;\n' +
                shader.fragmentShader.replace('#include <map_fragment>', `
                    float c1 = texture2D(uClouds, vCloudUv / 2600.0 + uOffset).r;
                    float c2 = texture2D(uClouds, vCloudUv / 900.0 + uOffset * 1.7).r;
                    float c = c1 * 0.65 + c2 * 0.35;
                    float alpha = smoothstep(1.0 - uCover * 0.9 - 0.12, 1.0 - uCover * 0.9 + 0.18, c);
                    alpha = max(alpha, smoothstep(0.85, 1.0, uCover));
                    diffuseColor.rgb = mix(uDark, uLight, smoothstep(0.35, 0.8, c));
                    diffuseColor.a = alpha;`);
        };
        cloudMaterial.customProgramCacheKey = () => 'cloud-deck';
        patchMaterial(cloudMaterial);       // So the deck fades into the horizon with everything else.
        this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000, 48, 48), cloudMaterial);
        this.clouds.rotation.x = Math.PI / 2;
        this.clouds.renderOrder = -1500;
        this.clouds.frustumCulled = false;
        scene.add(this.clouds);

        this.rain = precipitation('rain', 9000);
        this.snow = precipitation('snow', 9000);
        scene.add(this.rain.object, this.snow.object);
        this.time = 0;
    }

    set(name) {
        this.weather = WEATHER[name] || WEATHER.clear;
        this.name = name;
    }

    /* After the sky has worked out the light for the moment (L from SkyDome.update): fog, haze and
       cloud colors from the look table, dimmed toward night; the sun dimmed by the clouds. Returns how
       much sun gets through and whether the clear sky dome should show. */
    update(L, skyDome) {
        const w = this.weather, dark = L.dark;
        const night = new THREE.Color(0x070b16);
        const gray = w.gray || 0;
        // Horizon and zenith: the sky's own by day in clear weather, the weather's grays when clouded,
        // both darkening with the night but keeping a little floodlit glow near the ground.
        const horizon = L.horizon.clone().lerp(new THREE.Color(w.horizon ?? 0xb0b8c0), gray);
        const zenith = L.skyColor.clone().multiplyScalar(0.55).lerp(new THREE.Color(w.zenith ?? 0x7d8794), gray);
        const dim = 1 - dark * 0.9;
        horizon.multiplyScalar(gray ? dim : 1).lerp(new THREE.Color(0x2a2620), gray * dark * 0.5);
        zenith.multiplyScalar(gray ? dim : 1).lerp(night, gray * dark * 0.6);
        U.uFogHorizon.value.copy(horizon);
        U.uFogZenith.value.copy(zenith);
        U.uSunDir.value.copy(L.sunDir);
        U.uSunGlow.value.copy(L.sunColor).multiplyScalar(0.25 * w.sun * (1 - dark));
        // Visibility: fog thick enough that contrast is mostly gone at the reported distance.
        U.uFogDensity.value = 1.7 / w.visibility;
        U.uFogNear.value = Math.min(60, w.visibility * 0.05);
        U.uHaze.value = w.haze;
        U.uHazeHeight.value = w.visibility < 1000 ? 120 : 35;
        U.uWet.value = w.wet;
        U.uSnowCover.value = w.snowCover;
        U.uRain.value = w.precip === 'rain' ? w.rate : 0;
        // Clouds: lit underside by day, dark at night.
        this.clouds.visible = w.cover > 0;
        const cu = this.cloudUniforms;
        cu.uCover.value = w.cover;
        cu.uHeight.value = w.ceiling;
        cu.uLight.value.set(w.cloudLight ?? 0xffffff).lerp(L.sunColor, 0.15 * (1 - gray)).multiplyScalar(1 - dark * 0.92);
        cu.uDark.value.set(w.cloudDark ?? 0xa0a8b2).multiplyScalar(1 - dark * 0.95);
        this.clouds.position.y = w.ceiling;
        // The clear sky dome shows unless the weather hides it.
        const clouded = gray > 0.5;
        skyDome.sky.visible = !clouded;
        skyDome.stars.visible = skyDome.stars.visible && !clouded;
        skyDome.moon.visible = skyDome.moon.visible && !clouded;
        this.skySphere.visible = clouded;
        // Rain and snow.
        const p = w.precip;
        this.rain.object.visible = p === 'rain';
        this.snow.object.visible = p === 'snow';
        this.rain.uniforms.uColor.value.setRGB(0.75, 0.78, 0.82).multiplyScalar(1 - dark * 0.5);
        this.rain.uniforms.uOpacity.value = 0.32 * (w.rate || 0);
        this.snow.uniforms.uColor.value.setScalar(0.95 - dark * 0.35);
        this.snow.uniforms.uOpacity.value = 0.9 * (w.rate || 0);
        return { sun: w.sun, clouded, wet: w.wet > 0.5, background: horizon };
    }

    // Each frame: time for drops and ripples, the clouds' drift, and everything centered on the camera.
    tick(dt, camera, pixelScale) {
        this.time += dt;
        U.uWeatherTime.value = this.time;
        for (const p of [this.rain, this.snow]) {
            p.uniforms.uTime.value = this.time;
            p.uniforms.uCenter.value.copy(camera.position);
            p.uniforms.uScale.value = pixelScale;
        }
        this.cloudUniforms.uOffset.value.set(this.time * 0.0009, this.time * 0.0004);
        this.clouds.position.x = camera.position.x;
        this.clouds.position.z = camera.position.z;
        this.skySphere.position.copy(camera.position);
    }
}
