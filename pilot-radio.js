/* Small queue for browser spoken pilot transmissions. */
(function (root) {
    'use strict';

    class PilotRadio {
        constructor(synth, Utterance, onError = () => {}, effect = null) {
            // Radio static around each transmission (radio-effect.js).
            this.effect = effect;
            this.synth = synth;
            this.Utterance = Utterance;
            this.onError = onError;
            this.enabled = false;
            this.listening = false;
            this.queue = [];
            this.active = null;
            this.activeItem = null;
            this.voiceURI = '';
        }

        get supported() { return Boolean(this.synth && this.Utterance); }

        setVoice(voiceURI) { this.voiceURI = String(voiceURI || ''); }

        availableVoices() {
            if (!this.supported) return [];
            return this.synth.getVoices().filter(voice => /^en(?:-|_)/i.test(voice.lang));
        }

        setEnabled(enabled) {
            this.enabled = Boolean(enabled && this.supported);
            if (!this.enabled) this.clear();
            else this.playNext();
            return this.enabled;
        }

        clear() {
            this.queue = [];
            this.stopCurrent();
        }

        setListening(listening) {
            this.listening = Boolean(listening);
            if (this.listening) this.stopCurrent();
            else this.playNext();
        }

        stopCurrent() {
            if (this.active) this.effect?.unkey(null, true);
            this.active = null;
            this.activeItem = null;
            if (this.supported) this.synth.cancel();
        }

        say(text, callsign = '', priority = false) {
            if (!this.enabled || !String(text).trim()) return;
            const item = { text: String(text), callsign, priority };
            if (priority) {
                const firstRoutine = this.queue.findIndex(queued => !queued.priority);
                this.queue.splice(firstRoutine < 0 ? this.queue.length : firstRoutine, 0, item);
            }
            else this.queue.push(item);
            if (this.queue.length > 5) this.queue.length = 5;
            if (priority && this.activeItem && !this.activeItem.priority) this.stopCurrent();
            this.playNext();
        }

        playNext() {
            if (!this.enabled || this.listening || this.active || !this.queue.length) return;
            const item = this.queue.shift();
            const utterance = new this.Utterance(item.text);
            utterance.lang = 'en-US';
            utterance.rate = 0.96;
            utterance.pitch = 1;
            utterance.volume = 1;
            const selectedVoice = this.availableVoices().find(voice => voice.voiceURI === this.voiceURI);
            if (selectedVoice) utterance.voice = selectedVoice;
            utterance.onstart = () => { if (this.active === utterance) this.effect?.keyUp(); };
            utterance.onend = () => this.finish(utterance);
            utterance.onerror = event => {
                if (this.active === utterance && !['canceled', 'interrupted'].includes(event.error)) {
                    this.onError(`Pilot audio failed: ${event.error || 'unknown error'}`);
                }
                this.finish(utterance);
            };
            this.active = utterance;
            this.activeItem = item;
            try { this.synth.speak(utterance); }
            catch (error) {
                this.onError(`Pilot audio failed: ${error.message}`);
                this.finish(utterance);
            }
        }

        finish(utterance) {
            if (this.active !== utterance) return;
            this.effect?.unkey();
            this.active = null;
            this.activeItem = null;
            this.playNext();
        }

    }

    root.PilotRadio = PilotRadio;
    if (typeof module !== 'undefined') module.exports = PilotRadio;
})(typeof window !== 'undefined' ? window : globalThis);
