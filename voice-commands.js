/* Converts a spoken ATC transmission (one or more instructions) into the simulator's short commands. */
(function (root) {
    'use strict';

    const UNITS = {
        ZERO: 0, OH: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4,
        FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, NINER: 9,
        TEN: 10, ELEVEN: 11, TWELVE: 12, THIRTEEN: 13,
        FOURTEEN: 14, FIFTEEN: 15, SIXTEEN: 16, SEVENTEEN: 17,
        EIGHTEEN: 18, NINETEEN: 19
    };
    const TENS = {
        TWENTY: 20, THIRTY: 30, FORTY: 40, FIFTY: 50,
        SIXTY: 60, SEVENTY: 70, EIGHTY: 80, NINETY: 90
    };
    const COMMAND_START = new Set([
        'DESCEND', 'CLIMB', 'MAINTAIN', 'TURN', 'FLY', 'HEADING',
        'REDUCE', 'INCREASE', 'SPEED', 'PROCEED', 'DIRECT',
        'CLEARED', 'GO', 'ABORT', 'RUNWAY', 'CONTACT', 'MONITOR', 'EXPECT', 'LINE', 'POSITION', 'HOLD'
    ]);
    const FILLER_WORDS = new Set(['OK', 'OKAY', 'UH', 'UM', 'PLEASE', 'NOW', 'AND']);
    // "Expedite" or "immediately" anywhere in a transmission asks for it to be carried out at once.
    const EXPEDITE_WORDS = new Set(['EXPEDITE', 'EXPEDITED', 'EXPEDITING', 'IMMEDIATELY', 'IMMEDIATE']);
    const NATO = {
        ALPHA: 'A', ALFA: 'A', BRAVO: 'B', CHARLIE: 'C', DELTA: 'D', ECHO: 'E', FOXTROT: 'F', GOLF: 'G',
        HOTEL: 'H', INDIA: 'I', JULIET: 'J', JULIETT: 'J', KILO: 'K', LIMA: 'L', MIKE: 'M', NOVEMBER: 'N',
        OSCAR: 'O', PAPA: 'P', QUEBEC: 'Q', ROMEO: 'R', SIERRA: 'S', TANGO: 'T', UNIFORM: 'U', VICTOR: 'V',
        WHISKEY: 'W', WHISKY: 'W', XRAY: 'X', YANKEE: 'Y', ZULU: 'Z'
    };
    const NAVAID_WORDS = new Set(['VOR', 'VORTAC', 'TACAN', 'NDB', 'DME', 'INTERSECTION', 'WAYPOINT', 'FIX']);
    // "Flight" starts an instruction only in "flight level"; otherwise it is part of a callsign ("Delta flight 228").
    const findCommandStart = words => words.findIndex((word, i) =>
        COMMAND_START.has(word) || (word === 'FLIGHT' && words[i + 1] === 'LEVEL'));
    // Words that can follow RUNWAY in a takeoff clearance, so the clearance does not swallow the next instruction.
    const RUNWAY_WORD = '(?:\\d{1,2}[LCR]?|ZERO|OH|ONE|TWO|TO|TOO|THREE|FOUR|FOR|FIVE|SIX|SEVEN|EIGHT|NINE|NINER|LEFT|RIGHT|CENTER)';
    const TAKEOFF = new RegExp(`^(?:RUNWAY(?: ${RUNWAY_WORD})+ )?CLEARED (?:FOR )?TAKEOFF(?: RUNWAY(?: ${RUNWAY_WORD})+)?$`);
    // "Runway two seven, line up and wait" (formerly "position and hold").
    const LINE_UP = new RegExp(`^(?:RUNWAY(?: ${RUNWAY_WORD})+ )?(?:LINE UP AND WAIT|POSITION AND HOLD)(?: RUNWAY(?: ${RUNWAY_WORD})+)?$`);

    function numberFromWords(words) {
        if (!words.length) return null;
        const thousand = words.indexOf('THOUSAND');
        if (thousand >= 0) {
            const high = numberFromWords(words.slice(0, thousand));
            const low = thousand === words.length - 1 ? 0 : numberFromWords(words.slice(thousand + 1));
            return high >= 1 && high <= 99 && low !== null && low < 1000 ? high * 1000 + low : null;
        }
        const hundred = words.indexOf('HUNDRED');
        if (hundred >= 0) {
            const high = numberFromWords(words.slice(0, hundred));
            const low = hundred === words.length - 1 ? 0 : numberFromWords(words.slice(hundred + 1));
            return high >= 1 && high <= 9 && low !== null && low < 100 ? high * 100 + low : null;
        }

        let digits = '';
        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            if (/^\d+$/.test(word)) { digits += word; continue; }
            if (TENS[word] !== undefined) {
                let value = TENS[word];
                if (UNITS[words[i + 1]] > 0 && UNITS[words[i + 1]] < 10) {
                    value += UNITS[words[++i]];
                }
                digits += String(value);
            } else if (UNITS[word] !== undefined) {
                digits += String(UNITS[word]);
            } else return null;
        }
        return digits ? Number(digits) : null;
    }

    function normalize(text) {
        return String(text).toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
            .replace(/\bTO SEND\b/g, 'DESCEND')
            .replace(/\bTHE SEND\b|\bDESCENT\b|\bDISSENT\b|\bDESEND\b/g, 'DESCEND')
            .replace(/\bCLIENT\b/g, 'CLIMB')
            // "Climb" is often heard as "cline"; CLINE is also a Charlotte fix, so keep it after "direct".
            .replace(/(?<!\bDIRECT (?:TO )?)\b(?:CLINE|KLINE|CLIME|CLIMES)\b/g, 'CLIMB')
            .replace(/\bMAINTAINED\b|\bMAINTAINING\b/g, 'MAINTAIN')
            // Recognition often drops or adds a tense ending: "clear for takeoff", "climbed to", "descending".
            .replace(/\bCLEAR(?= (?:FOR|TO|ILS|THE)\b)/g, 'CLEARED')
            .replace(/\bCLIMBED IN\b|\bCLIMBED\b|\bCLIMBING\b|\bCLIMBIN\b|\bCLIMATE\b/g, 'CLIMB')
            .replace(/\bDESCENDED\b|\bDESCENDING\b/g, 'DESCEND')
            .replace(/\bTURN WRITE\b/g, 'TURN RIGHT')
            .replace(/\bTURN LIFT\b/g, 'TURN LEFT')
            // "Heading" is often heard as "hitting" or "heating".
            .replace(/\bHEAD IN\b|\bHONEY\b|\bHITTING\b|\bHEATING\b|\bHEDDING\b|\bHEADED\b|\bHEADIN\b/g, 'HEADING')
            .replace(/\bFT\b/g, 'FEET')
            .replace(/\bTAKE OFF\b/g, 'TAKEOFF')
            .replace(/\bLINEUP\b|\bLINED UP\b/g, 'LINE UP')
            .replace(/\b(NORTH|SOUTH) (EAST|WEST)\b/g, '$1$2')
            .replace(/\bHOLDING\b|\bHOLE\b/g, 'HOLD')
            .replace(/\bI L S\b/g, 'ILS');
    }

    function airlineAliases(code, airline) {
        const aliases = [[code], code.split('')];
        if (airline) {
            const name = normalize(airline.name).split(' ');
            aliases.push(name, [...name, 'AIRLINES']);
            if (name.length === 1) aliases.push(name[0].split(''));
            if (code === 'SWA') aliases.push(['SOUTH', 'WEST']);
        }
        return aliases;
    }

    function flightNumberFromWords(words) {
        const heardDigits = { TO: 'TWO', TOO: 'TWO', FOR: 'FOUR', ATE: 'EIGHT', WON: 'ONE' };
        return numberFromWords(words.map(word => heardDigits[word] || word));
    }

    function oneEditApart(left, right) {
        if (Math.abs(left.length - right.length) > 1) return false;
        let i = 0, j = 0, edits = 0;
        while (i < left.length && j < right.length) {
            if (left[i] === right[j]) { i++; j++; continue; }
            if (++edits > 1) return false;
            if (left.length >= right.length) i++;
            if (right.length >= left.length) j++;
        }
        return edits + (left.length - i) + (right.length - j) === 1;
    }

    function matchesCallsign(callsignWords, plane, airline, approximateCarrier = false) {
        if (callsignWords.length === 1 && callsignWords[0] === plane.id) return true;
        const code = plane.id.slice(0, 3);
        return airlineAliases(code, airline).some(alias => {
            const heardCarrier = callsignWords.slice(0, alias.length);
            const exact = heardCarrier.join(' ') === alias.join(' ');
            const nearName = approximateCarrier && airline && alias[0] !== code &&
                alias.length <= 2 && heardCarrier.length === alias.length &&
                oneEditApart(heardCarrier.join(''), alias.join(''));
            if (!exact && !nearName) return false;
            let flightWords = callsignWords.slice(alias.length);
            if (flightWords[0] === 'FLIGHT') flightWords = flightWords.slice(1);
            if (flightWords[0] === 'NUMBER') flightWords = flightWords.slice(1);
            if (!flightWords.length) return !approximateCarrier;
            const number = flightNumberFromWords(flightWords);
            return number !== null && String(number) === plane.id.slice(3);
        });
    }

    function parseAltitude(phrase, elevation) {
        let words = phrase.split(' ').filter(Boolean);
        const flightLevel = words[0] === 'FLIGHT' && words[1] === 'LEVEL';
        if (flightLevel) words = words.slice(2);
        else if (words[0] === 'FL') words = words.slice(1);
        words = words.filter(word => !['FEET', 'FOOT', 'AT', 'TO', 'THE', 'AND'].includes(word));
        const number = numberFromWords(words);
        if (number === null) return { error: 'I could not understand the altitude.' };
        if (flightLevel || phrase.startsWith('FL ')) {
            // This simulator also accepts a full altitude after "flight level":
            // "flight level 3000" means 3,000 feet; "flight level 300" remains FL300.
            if (number >= 1000 && number <= 60000) {
                if (number < elevation) return { error: `I heard ${number.toLocaleString('en-US')} feet, below this sector’s usable range. Please repeat the altitude.` };
                return { value: number };
            }
            if (number >= 180 && number <= 600) return { value: number * 100 };
            return { error: 'Say a full altitude such as flight level three thousand, or a standard flight level such as flight level three zero zero.' };
        }
        if (number < elevation || number > 60000) {
            return { error: `I heard ${number.toLocaleString('en-US')} feet, outside this sector’s usable range. Please repeat the altitude.` };
        }
        return { value: number };
    }

    /* "two six right", "26R", "one eight", "zero one center" -> "26R", "18", "01C". */
    function runwayFromWords(text) {
        const words = text.split(' ');
        const sides = { LEFT: 'L', RIGHT: 'R', CENTER: 'C', CENTRE: 'C' };
        let side = '';
        if (sides[words.at(-1)]) side = sides[words.pop()];
        if (words.length === 1 && /^\d{1,2}[LRC]$/.test(words[0])) {
            side = words[0].at(-1);
            words[0] = words[0].slice(0, -1);
        }
        const runway = numberFromWords(words);
        return runway === null || runway < 1 || runway > 36 ? null : `${String(runway).padStart(2, '0')}${side}`;
    }

    // A fix or navaid name as heard: "boy kin", "Rome VOR", "bravo oscar yankee kilo november". The simulator
    // matches the heard name to a fix or navaid; here it only has to be one name, not more instructions.
    function fixName(text) {
        let words = text.split(' ');
        if (words.slice(-3).join('') === 'VOR' && words.length > 3) words = words.slice(0, -3);
        while (words.length > 1 && NAVAID_WORDS.has(words.at(-1))) words.pop();
        if (words.length > 5 || words.some(word => COMMAND_START.has(word) || word === 'FLIGHT')) return null;
        return words.length > 1 && words.every(word => NATO[word]) ? words.map(word => NATO[word]).join('') : words.join('');
    }

    function parseInstruction(phrase, elevation, plane) {
        let match = phrase.match(/^(DESCEND|CLIMB)(?: TO)?(?: AND)?(?: MAINTAIN)?(?: AT)? (.+)$/);
        const direction = match ? match[1] : null;
        if (!match && !phrase.startsWith('MAINTAIN SPEED ')) match = phrase.match(/^MAINTAIN (.+)$/);
        if (match) {
            const altitude = parseAltitude(match[direction ? 2 : 1], elevation);
            if (altitude.error) return { error: altitude.error };
            if (direction === 'DESCEND' && altitude.value > plane.altitude + 100) {
                return { error: `I heard ${altitude.value.toLocaleString('en-US')} feet, above the aircraft. Please repeat the altitude or use climb.` };
            }
            if (direction === 'CLIMB' && altitude.value < plane.altitude - 100) {
                return { error: `I heard ${altitude.value.toLocaleString('en-US')} feet, below the aircraft. Please repeat the altitude or use descend.` };
            }
            return { command: `A ${altitude.value}` };
        }

        match = phrase.match(/^TURN (LEFT|RIGHT)(?: TO| AT)?(?: HEADING)? (.+)$/);
        if (match) {
            const heading = numberFromWords(match[2].split(' ').filter(word => !['DEGREES', 'DEGREE', 'AND'].includes(word)));
            if (heading === null || heading < 0 || heading > 360) return { error: 'I could not understand the heading.' };
            return { command: `${match[1] === 'LEFT' ? 'TL' : 'TR'} ${heading}` };
        }
        match = phrase.match(/^(?:FLY )?HEADING (.+)$/);
        if (match) {
            const heading = numberFromWords(match[1].split(' ').filter(word => !['DEGREES', 'DEGREE', 'AND'].includes(word)));
            if (heading === null || heading < 0 || heading > 360) return { error: 'I could not understand the heading.' };
            return { command: `H ${heading}` };
        }

        match = phrase.match(/^(?:(?:REDUCE|INCREASE|MAINTAIN) SPEED(?: TO)?|SPEED) (.+)$/);
        if (match) {
            const speed = numberFromWords(match[1].split(' ').filter(word => !['KNOTS', 'KNOT'].includes(word)));
            if (speed === null || speed < 80 || speed > 450) return { error: 'I could not understand the speed.' };
            return { command: `S ${speed}` };
        }

        // "Direct boy kin", "direct Rome VOR", "direct bravo oscar yankee kilo november".
        match = phrase.match(/^(?:PROCEED )?DIRECT(?: TO)? (.+)$/);
        const directFix = match && fixName(match[1]);
        if (directFix) return { command: `C ${directFix}` };

        // "Hold at chopper", "hold northeast of chopper, left turns", "hold over Rome VOR as published".
        match = phrase.match(/^HOLD (?:(NORTH|NORTHEAST|EAST|SOUTHEAST|SOUTH|SOUTHWEST|WEST|NORTHWEST) OF|AT|OVER) (.+?)(?: AS PUBLISHED)?(?: (LEFT|RIGHT)(?: HAND)? TURNS?)?(?: AS PUBLISHED)?$/);
        const holdFix = match && fixName(match[2]);
        if (holdFix) {
            const side = match[1] ? { NORTH: 'N', NORTHEAST: 'NE', EAST: 'E', SOUTHEAST: 'SE', SOUTH: 'S', SOUTHWEST: 'SW', WEST: 'W', NORTHWEST: 'NW' }[match[1]] : '';
            const turns = match[3] === 'LEFT' ? 'LT' : '';
            return { command: ['HOLD', holdFix, side, turns].filter(Boolean).join(' ') };
        }

        if (TAKEOFF.test(phrase)) return { command: 'CTO' };
        if (LINE_UP.test(phrase)) return { command: 'LUAW' };
        // A bare altitude such as "flight level one zero thousand" assigns it, like "maintain".
        if (phrase.startsWith('FLIGHT LEVEL ')) {
            const altitude = parseAltitude(phrase, elevation);
            return altitude.error ? { error: altitude.error } : { command: `A ${altitude.value}` };
        }
        // "Contact tower", "contact Atlanta Center one three two point four seven", "monitor tower".
        if (/^(?:CONTACT|MONITOR)\b/.test(phrase) && phrase.split(' ').slice(1).every(word => !COMMAND_START.has(word))) {
            return { command: 'HO' };
        }

        match = phrase.match(/^CLEARED (?:FOR (?:THE )?)?ILS(?: APPROACH)? RUNWAY (.+)$/);
        if (match) {
            const runway = runwayFromWords(match[1]);
            return runway ? { command: `L ${runway}` } : { error: 'I could not understand the runway.' };
        }

        // "Expect runway two six right", "expect the ILS runway 26R approach": the runway to plan for.
        match = phrase.match(/^EXPECT (?:THE )?(?:(?:ILS|VISUAL|RNAV)(?: APPROACH)? )?(?:(?:TO )?RUNWAY )?(.+?)(?: APPROACH)?$/);
        if (match) {
            const runway = runwayFromWords(match[1]);
            return runway ? { command: `EXP ${runway}` } : { error: 'I could not understand the runway to expect.' };
        }

        if (phrase === 'GO AROUND' || phrase === 'ABORT') return { command: 'GA' };
        return { error: 'I could not match that instruction. Try one clearance at a time.' };
    }

    function resolveCallsign(transcript, aircraft, airlines, allowApproximateCarrier = true) {
        const callsignWords = normalize(transcript).split(' ').filter(word => word && word !== 'HEAVY');
        if (!callsignWords.length) return { ok: false, error: 'No callsign was heard. Say the airline and flight number, or select an aircraft strip first.' };
        const exactMatches = aircraft.filter(plane =>
            matchesCallsign(callsignWords, plane, airlines.find(item => item.id === plane.id.slice(0, 3))));
        const matches = exactMatches.length || !allowApproximateCarrier ? exactMatches : aircraft.filter(plane =>
            matchesCallsign(callsignWords, plane, airlines.find(item => item.id === plane.id.slice(0, 3)), true));
        if (matches.length !== 1) {
            if (matches.length) return { ok: false, error: 'Several aircraft match. Say the airline and full flight number.' };
            const carrier = airlines.find(item => airlineAliases(item.id, item).some(alias =>
                callsignWords.slice(0, alias.length).join(' ') === alias.join(' ')));
            const relevant = carrier ? aircraft.filter(plane => plane.id.startsWith(carrier.id)) : aircraft;
            const available = relevant.slice(0, 8).map(plane => plane.id).join(', ');
            const scope = carrier ? `${carrier.name} callsigns` : 'Active callsigns';
            const guidance = available ? `${scope}: ${available}${relevant.length > 8 ? ', …' : ''}.` :
                carrier ? `No ${carrier.name} aircraft are active.` : 'No aircraft are active yet.';
            return { ok: false, error: `I heard "${callsignWords.join(' ')}", but no active aircraft matches. ${guidance}` };
        }
        return { ok: true, id: matches[0].id };
    }

    function parse(transcript, aircraft, airlines, elevation, allowApproximateCarrier = true) {
        let words = normalize(transcript).split(' ').filter(Boolean);
        const expedite = words.some(word => EXPEDITE_WORDS.has(word));
        if (expedite) {
            words = words.filter(word => !EXPEDITE_WORDS.has(word));
            // "Expedite your descent", "expedite climb": hurry the current clearance, no new value.
            if (['CLIMB', 'DESCEND', 'TURN'].includes(words.at(-1))) {
                words.pop();
                if (['YOUR', 'THE'].includes(words.at(-1))) words.pop();
            }
        }
        const commandIndex = findCommandStart(words);
        if (commandIndex < 0) {
            if (expedite) {
                const alone = resolveCallsign(words.join(' '), aircraft, airlines, false);
                if (alone.ok) return { ok: true, command: `${alone.id} XP` };
            }
            // A callsign on its own selects that aircraft.
            if (resolveCallsign(words.join(' '), aircraft, airlines, false).ok) return { ok: false, error: 'No instruction was recognized.' };
            // Otherwise the callsign may be fine with an instruction we did not recognize; say which aircraft we heard.
            for (let end = words.length - 1; end > 0; end--) {
                const heard = resolveCallsign(words.slice(0, end).join(' '), aircraft, airlines, false);
                if (heard.ok) {
                    return { ok: false, error: `I heard ${heard.id}, but couldn't find an instruction in "${words.slice(end).join(' ').toLowerCase()}". ` +
                        'Start with climb, descend, maintain, flight level, turn, heading, speed, direct, cleared, or contact.' };
                }
            }
            return { ok: false, error: 'No instruction was recognized.' };
        }
        const resolved = resolveCallsign(words.slice(0, commandIndex).join(' '), aircraft, airlines, allowApproximateCarrier);
        if (!resolved.ok) return resolved;
        const plane = aircraft.find(item => item.id === resolved.id);

        const commands = parseInstructions(words.slice(commandIndex), elevation, plane);
        if (commands.error) return { ok: false, error: commands.error };
        return { ok: true, command: `${plane.id} ${expedite ? 'XP ' : ''}${commands.join(' ')}` };
    }

    /* Splits a transmission into instructions, taking the longest phrase that parses each time:
       "cleared for takeoff climb to ten thousand" becomes ["CTO", "A 10000"]. */
    function parseInstructions(words, elevation, plane) {
        const commands = [];
        let i = 0;
        while (i < words.length) {
            while (i < words.length && (FILLER_WORDS.has(words[i]) || words[i] === 'THEN')) i++;
            if (i >= words.length) break;
            let end = words.length, result = null;
            for (; end > i; end--) {
                result = parseInstruction(words.slice(i, end).join(' '), elevation, plane);
                if (!result.error) break;
            }
            if (end === i) {
                const error = parseInstruction(words.slice(i).join(' '), elevation, plane).error;
                return { error: commands.length ? `${error} I understood the first part, but not "${words.slice(i).join(' ').toLowerCase()}".` : error };
            }
            commands.push(result.command);
            i = end;
        }
        return commands;
    }

    function choose(transcripts, aircraft, airlines, elevation, selectedAircraftId = '') {
        const options = [...new Set(transcripts.map(text => String(text).trim()).filter(Boolean))];
        if (!options.length) return { ok: false, transcript: '', error: 'No speech was recognized.' };
        const selected = aircraft.find(plane => plane.id === selectedAircraftId);
        const parsed = options.map(transcript => {
            let result = parse(transcript, aircraft, airlines, elevation);
            const words = normalize(transcript).split(' ').filter(Boolean);
            const commandIndex = findCommandStart(words);
            const before = words.slice(0, Math.max(commandIndex, 0));
            if (!result.ok && selected && commandIndex >= 0 &&
                before.every(word => FILLER_WORDS.has(word) || EXPEDITE_WORDS.has(word) || word === 'YOUR' || word === 'THE')) {
                const expedite = words.some(word => EXPEDITE_WORDS.has(word)) ? 'EXPEDITE ' : '';
                result = parse(`${selected.id} ${expedite}${words.slice(commandIndex).join(' ')}`, aircraft, airlines, elevation);
            }
            return { transcript, result };
        });
        const valid = parsed.filter(item => item.result.ok);
        const commands = [...new Set(valid.map(item => item.result.command))];
        if (commands.length > 1) {
            return { ok: false, transcript: options[0], error: 'Recognition found different possible clearances. Please repeat the full callsign and instruction.' };
        }
        if (commands.length === 1) {
            const matching = valid.filter(item => item.result.command === commands[0]);
            const selected = matching.find(item => parse(item.transcript, aircraft, airlines, elevation, false).ok) || matching[0];
            return { ok: true, transcript: selected.transcript, command: commands[0] };
        }
        return { ok: false, transcript: options[0], error: parsed[0].result.error };
    }

    function chooseCallsign(transcripts, aircraft, airlines) {
        const options = [...new Set(transcripts.map(text => String(text).trim()).filter(Boolean))];
        const matches = options.map(transcript => ({ transcript, result: resolveCallsign(transcript, aircraft, airlines) }))
            .filter(item => item.result.ok);
        const ids = [...new Set(matches.map(item => item.result.id))];
        if (ids.length > 1) return { ok: false, error: 'Recognition heard different possible callsigns. Please repeat the flight number.' };
        if (ids.length === 1) return { ok: true, id: ids[0], transcript: matches.find(item => item.result.id === ids[0]).transcript };
        return { ok: false, error: options.length ? resolveCallsign(options[0], aircraft, airlines).error : 'No speech was recognized.' };
    }

    // Sound-alike key for fix names: C, K, Q and CK sound alike, PH is F, vowels and H drop after the
    // first letter, and doubled letters collapse. "Boykin" and BOYKN both become BKN.
    function soundKey(text) {
        return String(text).toUpperCase().replace(/[^A-Z0-9]/g, '')
            .replace(/PH/g, 'F').replace(/CK|Q|C/g, 'K').replace(/X/g, 'KS').replace(/Z/g, 'S')
            .replace(/(?!^)[AEIOUYH]/g, '').replace(/(.)\1+/g, '$1');
    }

    function editDistance(a, b) {
        const row = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
            let previous = row[0];
            row[0] = i;
            for (let j = 1; j <= b.length; j++) {
                const current = row[j];
                row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
                previous = current;
            }
        }
        return row[b.length];
    }

    /* Finds the fix or navaid meant by a typed or heard name: its identifier, a navaid's place name
       ("Rome" for RMG), or a sound-alike ("chopper" for CHPPR). Ties go to the one nearest the aircraft. */
    function matchFix(spoken, fixes, near) {
        const word = String(spoken).toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!word) return null;
        const exact = fixes.find(fix => fix.name === word);
        if (exact) return exact;
        const key = soundKey(word);
        const byPlace = fixes.filter(fix => fix.title && fix.title.toUpperCase().replace(/[^A-Z]/g, '') === word);
        let matches = byPlace.length ? byPlace :
            fixes.filter(fix => soundKey(fix.name) === key || (fix.title && soundKey(fix.title) === key));
        if (!matches.length && key.length >= 3) matches = fixes.filter(fix => editDistance(soundKey(fix.name), key) === 1);
        if (!matches.length) return null;
        const distance = fix => near ? Math.hypot((fix.lat - near.lat) * 60, (fix.lon - near.lon) * 60 * Math.cos(near.lat * Math.PI / 180)) : 0;
        return matches.reduce((best, fix) => distance(fix) < distance(best) ? fix : best);
    }

    root.ATCVoice = { parse, choose, resolveCallsign, chooseCallsign, matchFix, soundKey };
    if (typeof module !== 'undefined') module.exports = root.ATCVoice;
})(typeof window !== 'undefined' ? window : globalThis);
