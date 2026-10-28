/* Subtle VHF radio sound for pilot transmissions: a click when the pilot keys the mic, a faint hiss under
   the voice, and a short squelch tail when they let go. Voices that pass through Web Audio (Kokoro) also get
   the narrow band and light grit of an aircraft radio. */
(function (root) {
    'use strict';

    const LEVELS = { hiss: 0.016, click: 0.12, tail: 0.07 };

    class RadioEffect {
        constructor(AudioContextClass = root.AudioContext || root.webkitAudioContext) {
            this.AudioContext = AudioContextClass;
            this.enabled = true;
            this.ownContext = null;
            this.noise = new WeakMap();   // context -> two seconds of white noise
            this.chains = new WeakMap();  // context -> voice filter input
            this.hiss = null;             // { source, gain } while a pilot is transmitting
        }

        get supported() { return Boolean(this.AudioContext); }

        setEnabled(enabled) {
            this.enabled = Boolean(enabled);
            if (!this.enabled) this.unkey(null, true);
        }

        // The browser speech engine plays outside Web Audio, so the static uses a context of its own.
        context() {
            if (!this.supported) return null;
            if (!this.ownContext) this.ownContext = new this.AudioContext();
            if (this.ownContext.state === 'suspended') this.ownContext.resume().catch(() => {});
            return this.ownContext;
        }

        noiseBuffer(context) {
            if (!this.noise.has(context)) {
                const length = Math.round(context.sampleRate * 2);
                const buffer = context.createBuffer(1, length, context.sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
                this.noise.set(context, buffer);
            }
            return this.noise.get(context);
        }

        // Where a voice source connects: 300–3,000 Hz band, a presence lift, gentle clipping.
        voiceInput(context) {
            if (!this.enabled) return context.destination;
            if (!this.chains.has(context)) {
                const highpass = context.createBiquadFilter();
                highpass.type = 'highpass'; highpass.frequency.value = 300;
                const lowpass = context.createBiquadFilter();
                lowpass.type = 'lowpass'; lowpass.frequency.value = 3000;
                const presence = context.createBiquadFilter();
                presence.type = 'peaking'; presence.frequency.value = 1800; presence.gain.value = 4; presence.Q.value = 0.9;
                const grit = context.createWaveShaper();
                const curve = new Float32Array(1024);
                for (let i = 0; i < curve.length; i++) {
                    const x = i / (curve.length - 1) * 2 - 1;
                    curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2);
                }
                grit.curve = curve;
                const level = context.createGain();
                level.gain.value = 0.9;
                highpass.connect(lowpass).connect(presence).connect(grit).connect(level).connect(context.destination);
                this.chains.set(context, highpass);
            }
            return this.chains.get(context);
        }

        // A burst of band-limited noise with a fast attack and the given decay.
        burst(context, peak, seconds, frequency) {
            const source = context.createBufferSource();
            source.buffer = this.noiseBuffer(context);
            const band = context.createBiquadFilter();
            band.type = 'bandpass'; band.frequency.value = frequency; band.Q.value = 0.8;
            const gain = context.createGain();
            const now = context.currentTime;
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(peak, now + 0.005);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
            source.connect(band).connect(gain).connect(context.destination);
            source.start(now, Math.random());
            source.stop(now + seconds + 0.02);
        }

        // Pilot keys the mic: a click, then a faint hiss for as long as they talk.
        keyUp(context = this.context()) {
            if (!this.enabled || !context) return;
            this.unkey(null, true);
            this.burst(context, LEVELS.click, 0.03, 2500);
            const source = context.createBufferSource();
            source.buffer = this.noiseBuffer(context);
            source.loop = true;
            const band = context.createBiquadFilter();
            band.type = 'bandpass'; band.frequency.value = 2200; band.Q.value = 0.5;
            const gain = context.createGain();
            gain.gain.setValueAtTime(0.0001, context.currentTime);
            gain.gain.exponentialRampToValueAtTime(LEVELS.hiss, context.currentTime + 0.04);
            source.connect(band).connect(gain).connect(context.destination);
            source.start();
            this.hiss = { source, gain, context };
        }

        // Pilot lets go: the hiss stops and the squelch closes with a short burst. Silent when interrupted.
        unkey(context = null, silent = false) {
            const hiss = this.hiss;
            this.hiss = null;
            if (hiss) {
                const now = hiss.context.currentTime;
                hiss.gain.gain.cancelScheduledValues(now);
                hiss.gain.gain.setValueAtTime(hiss.gain.gain.value || LEVELS.hiss, now);
                hiss.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
                hiss.source.stop(now + 0.05);
            }
            const target = context || hiss?.context;
            if (!silent && this.enabled && target) this.burst(target, LEVELS.tail, 0.18, 1500);
        }
    }

    root.RadioEffect = RadioEffect;
    if (typeof module !== 'undefined') module.exports = RadioEffect;
})(typeof window !== 'undefined' ? window : globalThis);
