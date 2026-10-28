/* Airport sound: an outdoor ambience by day and a quieter distant one at night, the whine of jets at the
   gates when you're near them, and takeoff roars placed at the departing jet so distance and direction
   are heard. From the tower cab everything is muffled by the glass. The recordings live in sound/web/
   (kept out of the public repo, as they are licensed); without them the sim is simply silent. */
import * as THREE from 'three';

const BEDS = { exterior: 'sound/web/exterior-loop.m4a', night: 'sound/web/night-loop.m4a', gate: 'sound/web/gate-loop.m4a' };
const TAKEOFFS = ['sound/web/takeoff-1.m4a', 'sound/web/takeoff-2.m4a', 'sound/web/takeoff-3.m4a'];

export class AirportSound {
    constructor(camera) {
        this.listener = new THREE.AudioListener();
        camera.add(this.listener);
        const ctx = this.listener.context;
        // The cab glass: a low-pass filter on everything the listener hears.
        this.glass = ctx.createBiquadFilter();
        this.glass.type = 'lowpass';
        this.glass.frequency.value = 20000;
        this.listener.setFilter(this.glass);
        this.beds = {};
        this.takeoffBuffers = [];
        this.enabled = true;
    }

    async load() {
        const loader = new THREE.AudioLoader();
        const get = url => loader.loadAsync(url).catch(() => null);
        const [beds, takeoffs] = await Promise.all([
            Promise.all(Object.entries(BEDS).map(async ([name, url]) => [name, await get(url)])),
            Promise.all(TAKEOFFS.map(get))
        ]);
        for (const [name, buffer] of beds) {
            if (!buffer) continue;
            const sound = new THREE.Audio(this.listener);
            sound.setBuffer(buffer);
            sound.setLoop(true);
            sound.setVolume(0);
            this.beds[name] = sound;
        }
        this.takeoffBuffers = takeoffs.filter(Boolean);
        return Object.keys(this.beds).length + this.takeoffBuffers.length;
    }

    // Browsers only play sound after you've clicked or typed on the page.
    start() {
        if (this.started || !this.enabled) return;
        this.listener.context.resume();
        for (const sound of Object.values(this.beds)) sound.play();
        this.started = true;
    }

    setEnabled(on) {
        this.enabled = on;
        this.listener.setMasterVolume(on ? 1 : 0);
        if (on) this.start();
    }

    /* Each frame: inTower (behind glass), dark (0 day to 1 night), gateM (meters to the nearest parked jet). */
    update({ inTower, dark, gateM }) {
        if (!this.started) return;
        const now = this.listener.context.currentTime;
        const ease = (sound, value) => sound && sound.gain.gain.setTargetAtTime(value, now, 0.6);
        const glass = inTower ? 0.55 : 1;
        ease(this.beds.exterior, 0.5 * (1 - dark * 0.85) * glass);
        ease(this.beds.night, 0.75 * dark * glass);
        ease(this.beds.gate, 0.6 * Math.max(0, Math.min(1, 1 - (gateM - 40) / 260)) * (inTower ? 0.25 : 1));
        this.glass.frequency.setTargetAtTime(inTower ? 900 : 20000, now, 0.3);
    }

    // Noise, made once and shared by the rain hiss and the thunder.
    noise(seconds) {
        const ctx = this.listener.context, buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        let brown = 0;
        for (let i = 0; i < data.length; i++) { brown = (brown + 0.02 * (Math.random() * 2 - 1)) / 1.02; data[i] = brown * 3.5; }
        return buffer;
    }

    /* Rain on the field: a soft hiss, louder with heavier rain (intensity 0 to 3). */
    setRain(intensity) {
        if (!this.started) return;
        const ctx = this.listener.context;
        if (!this.rain) {
            const source = ctx.createBufferSource();
            source.buffer = this.noise(4);
            source.loop = true;
            const band = ctx.createBiquadFilter();
            band.type = 'highpass'; band.frequency.value = 900;
            this.rain = ctx.createGain();
            this.rain.gain.value = 0;
            source.connect(band).connect(this.rain).connect(this.listener.getInput());
            source.start();
        }
        this.rain.gain.setTargetAtTime([0, 0.25, 0.5, 0.9][intensity] || 0, ctx.currentTime, 1.5);
    }

    /* A thunder rumble after the given delay: a crack, then a long low roll. */
    thunder(delay) {
        if (!this.started) return;
        const ctx = this.listener.context, at = ctx.currentTime + delay;
        const source = ctx.createBufferSource();
        source.buffer = this.thunderNoise ||= this.noise(6);
        const low = ctx.createBiquadFilter();
        low.type = 'lowpass'; low.frequency.value = 220 + Math.random() * 200;
        const gain = ctx.createGain();
        const loud = 0.6 + Math.random() * 0.6;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(loud, at + 0.08);
        gain.gain.setTargetAtTime(loud * 0.5, at + 0.3, 0.5);
        gain.gain.setTargetAtTime(0, at + 1.5, 1.4);
        source.connect(low).connect(gain).connect(this.listener.getInput());
        source.start(at);
        source.stop(at + 6);
    }

    // A takeoff roar that rides with the aircraft; heard full at 150 m and fading with distance.
    takeoff(object) {
        if (!this.started || !this.takeoffBuffers.length) return;
        const sound = new THREE.PositionalAudio(this.listener);
        sound.setBuffer(this.takeoffBuffers[Math.floor(Math.random() * this.takeoffBuffers.length)]);
        sound.setRefDistance(150);
        sound.setRolloffFactor(1.1);
        sound.setMaxDistance(12000);
        sound.setVolume(1.6);
        sound.onEnded = () => { sound.isPlaying = false; sound.removeFromParent(); };
        object.add(sound);
        sound.play();
    }
}
