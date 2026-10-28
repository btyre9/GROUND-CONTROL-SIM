/* Reads ground and tower clearances, typed or spoken, into actions the departures carry out:
   pushback, taxi (to a runway, via named taxiways), hold short, cross, hold position, continue,
   line up and wait, cleared for takeoff. Also writes the pilot's readback in radio phraseology. */
(function (root) {
    'use strict';

    const NATO = {
        ALPHA: 'A', ALFA: 'A', BRAVO: 'B', CHARLIE: 'C', DELTA: 'D', ECHO: 'E', FOXTROT: 'F', GOLF: 'G',
        HOTEL: 'H', INDIA: 'I', JULIET: 'J', JULIETT: 'J', KILO: 'K', LIMA: 'L', MIKE: 'M', NOVEMBER: 'N',
        OSCAR: 'O', PAPA: 'P', QUEBEC: 'Q', ROMEO: 'R', SIERRA: 'S', TANGO: 'T', UNIFORM: 'U', VICTOR: 'V',
        WHISKEY: 'W', WHISKY: 'W', XRAY: 'X', YANKEE: 'Y', ZULU: 'Z'
    };
    const LETTER_WORDS = Object.fromEntries(Object.entries(NATO).filter(([w]) => !['ALFA', 'JULIETT', 'WHISKY'].includes(w)).map(([w, l]) => [l, w]));
    const DIGITS = { ZERO: 0, OH: 0, ONE: 1, WON: 1, TWO: 2, TO: 2, TOO: 2, THREE: 3, TREE: 3, FOUR: 4, FOR: 4,
        FIVE: 5, FIFE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, ATE: 8, NINE: 9, NINER: 9 };
    const TEENS = { TEN: 10, ELEVEN: 11, TWELVE: 12, THIRTEEN: 13, FOURTEEN: 14, FIFTEEN: 15, SIXTEEN: 16,
        SEVENTEEN: 17, EIGHTEEN: 18, NINETEEN: 19 };
    const TENS = { TWENTY: 20, THIRTY: 30 };
    const SIDES = { LEFT: 'L', RIGHT: 'R', CENTER: 'C', CENTRE: 'C' };
    const SPOKEN_DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];

    // Typed shorthand, expanded to the spoken words before reading.
    const SHORT = {
        PB: 'PUSH BACK APPROVED', TX: 'TAXI', X: 'CROSS', HS: 'HOLD SHORT', HP: 'HOLD POSITION', CT: 'CONTINUE TAXI',
        LUAW: 'LINE UP AND WAIT', CTO: 'CLEARED FOR TAKEOFF'
    };
    const COMMAND_START = new Set(['PUSH', 'TAXI', 'CROSS', 'HOLD', 'CONTINUE', 'LINE', 'POSITION', 'CLEARED', 'RUNWAY']);
    const FILLER = new Set(['AND', 'THEN', 'PLEASE', 'OKAY', 'OK', 'UH', 'UM', 'THE', 'OF', 'AT']);

    function normalize(text, typed) {
        let s = String(text).toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
            .replace(/\bPUSHBACK\b|\bPUSH BACK\b|\bPUSHED BACK\b/g, 'PUSH BACK')
            .replace(/\bTAKE OFF\b/g, 'TAKEOFF')
            .replace(/\bCLEAR FOR\b|\bCLEARED TO\b/g, 'CLEARED FOR')
            .replace(/\bTAXIING\b|\bTAXIS\b|\bTAXIE\b|\bTEXAS\b/g, 'TAXI')
            .replace(/\bWHOLE SHORT\b|\bHOLE SHORT\b|\bHOLDSHORT\b/g, 'HOLD SHORT')
            .replace(/\bX RAY\b/g, 'XRAY');
        if (typed) s = s.split(' ').map(w => SHORT[w] || w).join(' ');
        return s.split(' ').filter(Boolean);
    }

    /* Runway from the words after RUNWAY: "two two right", "22R", "four left", "fifteen right". Returns
       { runway: '22R', used: words consumed } or null. */
    function readRunway(words, i) {
        let digits = '', j = i;
        if (/^\d{1,2}[LRC]?$/.test(words[j] || '')) {
            const m = words[j].match(/^(\d{1,2})([LRC]?)$/);
            digits = m[1]; j++;
            let side = m[2];
            if (!side && SIDES[words[j]]) side = SIDES[words[j++]];
            return { runway: digits.padStart(2, '0') + side, used: j - i };
        }
        while (j < words.length && digits.length < 2) {
            const w = words[j];
            if (DIGITS[w] !== undefined) { digits += DIGITS[w]; j++; continue; }
            if (TEENS[w] !== undefined && !digits) { digits = String(TEENS[w]); j++; continue; }
            if (TENS[w] !== undefined && !digits) {
                const unit = DIGITS[words[j + 1]];
                digits = String(TENS[w] + (unit > 0 ? unit : 0)); j += unit > 0 ? 2 : 1; continue;
            }
            break;
        }
        if (!digits || +digits < 1 || +digits > 36) return null;
        const side = SIDES[words[j]] ? SIDES[words[j++]] : '';
        return { runway: digits.padStart(2, '0') + side, used: j - i };
    }

    // A taxiway name at words[i]: "ECHO", "E", "NOVEMBER ONE", "N1".
    function readTaxiway(words, i) {
        const w = words[i];
        let letter = NATO[w] || (/^[A-Z]$/.test(w) ? w : null);
        if (/^[A-Z]\d$/.test(w || '')) return { name: w, used: 1 };
        if (!letter) return null;
        const digit = DIGITS[words[i + 1]];
        if (digit !== undefined && digit > 0 && !['TO', 'FOR', 'TOO'].includes(words[i + 1])) return { name: letter + digit, used: 2 };
        if (/^\d$/.test(words[i + 1] || '')) return { name: letter + words[i + 1], used: 2 };
        return { name: letter, used: 1 };
    }

    /* Reads one transmission. Returns { callsignWords, commands } where commands is a list of
       { action, runway?, via? }, or { error }. */
    function parse(text, { typed = false } = {}) {
        const words = normalize(text, typed);
        const start = words.findIndex(w => COMMAND_START.has(w));
        if (start < 0) return { error: 'No ground or tower instruction was heard.' };
        const callsignWords = words.slice(0, start).filter(w => !FILLER.has(w));
        const commands = [];
        let runway = null;      // A "runway two two right" that opens the clearance applies to what follows.
        let i = start;
        while (i < words.length) {
            const w = words[i], next = words[i + 1];
            if (FILLER.has(w)) { i++; continue; }
            if (w === 'RUNWAY') {
                const r = readRunway(words, i + 1);
                if (!r) return { error: 'I could not understand the runway.' };
                runway = r.runway; i += 1 + r.used; continue;
            }
            if (w === 'PUSH') {
                commands.push({ action: 'push' });
                i++;
                while (['BACK', 'APPROVED', 'APPROVE', 'PILOTS', 'PILOT', 'DISCRETION', 'S'].includes(words[i])) i++;
                continue;
            }
            if (w === 'TAXI') {
                i++;
                if (words[i] === 'TO') i++;
                if (words[i] === 'RUNWAY') {
                    const r = readRunway(words, i + 1);
                    if (!r) return { error: 'I could not understand the runway to taxi to.' };
                    runway = r.runway; i += 1 + r.used;
                } else if (/^\d/.test(words[i] || '')) {        // Typed: "TX 22R E A N".
                    const r = readRunway(words, i);
                    if (r) { runway = r.runway; i += r.used; }
                }
                if (words[i] === 'VIA') i++;
                const via = [];
                while (i < words.length) {
                    if (FILLER.has(words[i])) { i++; continue; }
                    if (COMMAND_START.has(words[i])) break;
                    const t = readTaxiway(words, i);
                    if (!t) break;
                    via.push(t.name); i += t.used;
                }
                if (!runway) return { error: 'Say which runway to taxi to.' };
                commands.push({ action: 'taxi', runway, via });
                continue;
            }
            if (w === 'CROSS') {
                i++;
                if (words[i] === 'RUNWAY') i++;
                const r = readRunway(words, i);
                if (!r) return { error: 'Say which runway to cross.' };
                commands.push({ action: 'cross', runway: r.runway }); i += r.used;
                continue;
            }
            if (w === 'HOLD' && next === 'SHORT') {
                i += 2;
                while (FILLER.has(words[i])) i++;
                if (words[i] === 'RUNWAY') i++;
                const r = readRunway(words, i);
                if (!r) return { error: 'Say which runway to hold short of.' };
                commands.push({ action: 'holdShort', runway: r.runway }); i += r.used;
                continue;
            }
            if (w === 'HOLD' && next === 'POSITION') { commands.push({ action: 'holdPosition' }); i += 2; continue; }
            if (w === 'CONTINUE') { commands.push({ action: 'continue' }); i += next === 'TAXI' ? 2 : 1; continue; }
            if ((w === 'LINE' && next === 'UP') || (w === 'POSITION' && next === 'AND')) {
                commands.push({ action: 'luaw', runway }); i += 4; continue;
            }
            if (w === 'CLEARED' && (next === 'FOR' || next === 'TAKEOFF')) {
                i += next === 'FOR' ? 2 : 1;
                if (words[i] === 'TAKEOFF') i++;
                if (words[i] === 'RUNWAY') {
                    const r = readRunway(words, i + 1);
                    if (r) { runway = r.runway; i += 1 + r.used; }
                }
                commands.push({ action: 'takeoff', runway });
                continue;
            }
            i++;
        }
        // A runway named after a line-up or takeoff clearance belongs to it too.
        for (const c of commands) if ((c.action === 'luaw' || c.action === 'takeoff') && !c.runway) c.runway = runway;
        if (!commands.length) return { error: 'No ground or tower instruction was heard.' };
        return { callsignWords, commands };
    }

    /* ---------- Saying it back ---------- */

    const sayDigits = n => String(n).split('').map(d => SPOKEN_DIGITS[+d]).join(' ');
    function sayRunway(runway) {
        const m = String(runway).match(/^0?(\d{1,2})([LRC]?)/);
        if (!m) return String(runway);
        const sides = { L: ' left', R: ' right', C: ' center' };
        return `${sayDigits(m[1])}${sides[m[2]] || ''}`;
    }
    const sayTaxiway = name => name.split('').map(c => /\d/.test(c) ? SPOKEN_DIGITS[+c] : (LETTER_WORDS[c] || c).toLowerCase()).join(' ');
    // Airline flight numbers as pilots say them: 497 "four ninety seven", 1423 "fourteen twenty three".
    function sayFlight(number) {
        const n = String(number);
        const pair = p => +p === 0 ? 'hundred' : +p < 10 ? `zero ${SPOKEN_DIGITS[+p]}`.replace('niner', 'nine') : spokenNumber(+p);
        if (n.length === 3) return `${SPOKEN_DIGITS[+n[0]].replace('niner', 'nine')} ${pair(n.slice(1))}`;
        if (n.length === 4) return `${spokenNumber(+n.slice(0, 2))} ${pair(n.slice(2))}`;
        return n.split('').map(d => SPOKEN_DIGITS[+d].replace('niner', 'nine')).join(' ');
    }
    function spokenNumber(n) {
        const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
            'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
        const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
        return n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ` ${ones[n % 10]}` : '');
    }

    const api = { parse, readRunway, sayRunway, sayTaxiway, sayFlight, NATO };
    root.GroundCommands = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
