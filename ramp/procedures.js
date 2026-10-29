/* The ramp procedure engine: runs a scenario's steps, checks each action against the safety rules, and
   keeps the score. No 3D here, so it runs under Node for the tests and in the browser as RampProcedures.

   A scenario (ramp/scenarios/*.json) lists the steps of a turn in order. Each step is an action done by a
   role (marshaller, wing walkers, lead agent, bridge operator, flight crew) or an event the 3D world
   reports (the aircraft entering the stand, stopping). The trainee plays one role and does that role's
   steps; the sim does everyone else's, each as soon as the steps it comes after are done.

   Every action has safety checks (beacon off before anyone approaches, chocks in before equipment moves
   in, ...). Doing an action that fails a check still happens, as it would on a real ramp, but it is logged
   as a violation with the reason. The world also reports what it sees each frame (people near running
   engines, equipment inside the ERA, where the aircraft stopped), which can raise violations too. */
(function (root) {
    'use strict';

    const ROLES = {
        marshaller: 'Marshaller', wingwalkerL: 'Wing walker (left)', wingwalkerR: 'Wing walker (right)',
        lead: 'Lead ramp agent', bridge: 'Bridge operator', pilot: 'Flight crew', observer: 'Observer'
    };

    // Safety checks, each true when it is safe. `text` says why it matters when it fails.
    const CHECKS = {
        aircraftStopped: { test: s => s.aircraft === 'stopped', severity: 'major',
            text: 'The aircraft is still moving.' },
        brakesSet: { test: s => s.brakes, severity: 'major',
            text: 'Parking brake not set: the aircraft could roll.' },
        enginesOff: { test: s => !s.engines, severity: 'major',
            text: 'Engines are still running: the intake and exhaust hazard zones are live.' },
        beaconOff: { test: s => !s.beacon, severity: 'major',
            text: 'The red anti-collision beacon is still on: nobody approaches the aircraft until it goes off.' },
        noseChocked: { test: s => s.chocks.nose, severity: 'major',
            text: 'The nose gear is not chocked.' },
        chocked: { test: s => s.chocks.nose && s.chocks.mains, severity: 'major',
            text: 'Equipment approached before the nose and main gear were chocked.' },
        conesOut: { test: s => s.cones, severity: 'minor',
            text: 'Safety cones were not set out around the aircraft first.' },
        walkaround: { test: s => s.walkaround, severity: 'minor',
            text: 'Arrival walkaround (damage check) not done before equipment approached.' },
        bridgeDocked: { test: s => s.bridge === 'docked', severity: 'major',
            text: 'The bridge is not docked at the door.' },
        gpuOn: { test: s => s.gpu, severity: 'minor',
            text: 'Ground power is not connected yet: the aircraft would lose power.' },
        standClear: { test: s => s.standClear, severity: 'major',
            text: 'Equipment or people were inside the ERA when the aircraft arrived.' },
        crewInPosition: { test: s => s.crew.marshaller && s.crew.wingwalkerL && s.crew.wingwalkerR, severity: 'major',
            text: 'Marshaller and both wing walkers must be in position before the aircraft enters the stand.' }
    };

    /* What each action does to the state and which checks it needs. Marshalling signals set the signal the
       flight crew follows; the 3D world turns that into aircraft movement. */
    const ACTIONS = {
        'fod-walk': { label: 'FOD walk of the stand', effect: s => { s.fodWalk = true; } },
        'clear-stand': { label: 'Clear equipment out of the ERA', effect: s => { s.standClear = true; } },
        'bridge-stowed': { label: 'Bridge stowed in its parking box', effect: s => { s.bridge = 'stowed'; } },
        'stage-chocks-cones': { label: 'Stage chocks and cones outside the ERA', effect: s => { s.staged = true; } },
        'marshaller-position': { label: 'Marshaller to the stop position', effect: s => { s.crew.marshaller = true; } },
        'wingwalkerL-position': { label: 'Left wing walker to the wingtip', effect: s => { s.crew.wingwalkerL = true; } },
        'wingwalkerR-position': { label: 'Right wing walker to the wingtip', effect: s => { s.crew.wingwalkerR = true; } },

        'signal-this-way': { label: 'Signal: this way (wands up)', signal: 'this-way' },
        'signal-come-ahead': { label: 'Signal: come ahead', signal: 'come-ahead', checks: ['crewInPosition', 'standClear'] },
        'signal-slow': { label: 'Signal: slow down', signal: 'slow' },
        'signal-stop': { label: 'Signal: stop', signal: 'stop' },
        'signal-emergency-stop': { label: 'Signal: EMERGENCY STOP', signal: 'emergency-stop' },
        'signal-set-brakes': { label: 'Signal: set brakes', signal: 'set-brakes', checks: ['aircraftStopped'] },
        'signal-cut-engines': { label: 'Signal: cut engines', signal: 'cut-engines', checks: ['aircraftStopped', 'brakesSet'] },
        'signal-chocks-in': { label: 'Signal: chocks inserted', signal: 'chocks-in', checks: ['chocked'] },

        'set-brakes': { label: 'Set parking brake', effect: s => { s.brakes = true; } },
        'engines-off': { label: 'Shut down engines', checks: ['brakesSet'], effect: s => { s.engines = false; } },
        'beacon-off': { label: 'Beacon off', checks: ['enginesOff'], effect: s => { s.beacon = false; } },

        'chock-nose': { label: 'Chock the nose gear', checks: ['aircraftStopped', 'enginesOff', 'beaconOff'],
            effect: s => { s.chocks.nose = true; } },
        'chock-mains': { label: 'Chock the main gear', checks: ['aircraftStopped', 'enginesOff', 'beaconOff', 'noseChocked'],
            effect: s => { s.chocks.mains = true; } },
        'cones-out': { label: 'Set out safety cones', checks: ['beaconOff'], effect: s => { s.cones = true; } },
        'walkaround': { label: 'Arrival walkaround', checks: ['beaconOff', 'chocked'], effect: s => { s.walkaround = true; } },
        'bridge-dock': { label: 'Drive the bridge to the L1 door', checks: ['beaconOff', 'enginesOff', 'chocked'],
            effect: s => { s.bridge = 'docked'; } },
        'door-open': { label: 'Knock: cabin crew opens L1', checks: ['bridgeDocked'], effect: s => { s.door = true; } },
        'gpu-connect': { label: 'Connect 400 Hz ground power', checks: ['beaconOff', 'chocked'], effect: s => { s.gpu = true; } },
        'pca-connect': { label: 'Connect preconditioned air', checks: ['beaconOff', 'chocked'], effect: s => { s.pca = true; } },
        'apu-off': { label: 'APU off', checks: ['gpuOn'], effect: s => { s.apu = false; } },
        'beltloader-in': { label: 'Belt loader to the forward hold', checks: ['beaconOff', 'chocked', 'conesOut', 'walkaround'],
            effect: s => { s.beltLoader = true; } },
        'unload': { label: 'Open the hold and unload bags', effect: s => { s.unloading = true; } }
    };

    const PENALTY = { minor: 5, major: 20, critical: 50 };

    function initialState() {
        return {
            aircraft: 'inbound', engines: true, beacon: true, brakes: false, apu: true, signal: null,
            chocks: { nose: false, mains: false }, cones: false, walkaround: false, bridge: 'unknown', door: false,
            gpu: false, pca: false, beltLoader: false, unloading: false, fodWalk: false, staged: false, standClear: false,
            crew: { marshaller: false, wingwalkerL: false, wingwalkerR: false }
        };
    }

    /* A run of a scenario with the trainee in one role. */
    function createRun(scenario, role = 'observer') {
        const steps = scenario.steps.map(step => ({ ...step, after: step.after || [], status: 'pending', doneAt: null }));
        return { scenario, role, t: 0, state: initialState(), steps, log: [], violations: [], seen: new Set(), finished: false };
    }

    const stepById = (run, id) => run.steps.find(s => s.id === id);
    const isDone = (run, id) => stepById(run, id)?.status === 'done';
    const ready = (run, step) => step.status === 'pending' && step.after.every(id => isDone(run, id));

    function note(run, text, kind = 'info') {
        run.log.push({ t: run.t, text, kind });
    }

    // Records a violation once per key, so a hazard that lasts many frames counts once.
    function violate(run, key, severity, text, by) {
        if (run.seen.has(key)) return null;
        run.seen.add(key);
        const v = { t: run.t, key, severity, text, by };
        run.violations.push(v);
        note(run, `${severity.toUpperCase()}: ${text}`, 'violation');
        return v;
    }

    /* Someone does an action. It always happens; failed checks and steps done out of order are logged.
       Returns the violations it caused. */
    function perform(run, actionId, role) {
        const action = ACTIONS[actionId];
        if (!action) throw new Error(`Unknown action ${actionId}`);
        const s = run.state, found = [];
        for (const id of action.checks || []) {
            const check = CHECKS[id];
            if (!check.test(s)) {
                const v = violate(run, `${actionId}:${id}`, check.severity, `${action.label}: ${check.text}`, role);
                if (v) found.push(v);
            }
        }
        // The scenario step this completes: the first open one for this action.
        const step = run.steps.find(st => st.action === actionId && st.status !== 'done');
        if (step) {
            const missing = step.after.filter(id => !isDone(run, id));
            if (missing.length && !step.anyOrder) {
                const names = missing.map(id => ACTIONS[stepById(run, id)?.action]?.label || id).join(', ');
                const v = violate(run, `${step.id}:order`, 'minor', `${action.label} done before: ${names}.`, role);
                if (v) found.push(v);
            }
            step.status = 'done';
            step.doneAt = run.t;
        }
        if (action.signal) s.signal = action.signal;
        action.effect?.(s);
        note(run, `${ROLES[role] || role}: ${action.label}`, found.length ? 'warn' : 'ok');
        run.finished = run.steps.every(st => st.status === 'done');
        return found;
    }

    /* The 3D world reports an event, such as the aircraft entering the stand or coming to a stop. It
       completes the matching event step. */
    function event(run, name) {
        const s = run.state;
        if (name === 'aircraft-entering') s.aircraft = 'entering';
        if (name === 'aircraft-stopped') s.aircraft = 'stopped';
        const step = run.steps.find(st => st.event === name && st.status !== 'done');
        if (step) { step.status = 'done'; step.doneAt = run.t; }
        note(run, EVENT_TEXT[name] || name);
        run.finished = run.steps.every(st => st.status === 'done');
    }
    const EVENT_TEXT = {
        'aircraft-in-sight': 'Aircraft in sight, turning onto the lead-in line.',
        'aircraft-entering': 'Aircraft entering the stand.',
        'aircraft-stopped': 'Aircraft stopped.'
    };

    /* What the world sees this frame:
       peopleNearEngines: names of crew inside an engine's intake or exhaust zone
       equipmentInEra:    names of vehicles or equipment inside the equipment restraint area
       aircraftMoving:    whether the aircraft is rolling
       collision:         what the aircraft struck, if anything */
    function observe(run, world, dt = 0) {
        run.t += dt;
        const s = run.state;
        if (s.engines) for (const who of world.peopleNearEngines || [])
            violate(run, `engine-zone:${who}`, 'critical', `${who} walked into the engine hazard zone with engines running.`, who);
        if (s.beacon || s.aircraft !== 'stopped') for (const what of world.equipmentInEra || [])
            violate(run, `era:${what}`, s.aircraft === 'inbound' ? 'major' : 'critical',
                `${what} inside the equipment restraint area while the aircraft ${s.aircraft === 'stopped' ? 'beacon is on' : 'is arriving'}.`, 'lead');
        if (world.collision) violate(run, `collision:${world.collision}`, 'critical', `The aircraft struck ${world.collision}.`, 'marshaller');
        if (run.scenario.guidance !== 'vdgs' && world.aircraftMoving && s.aircraft === 'entering' && !s.crew.marshaller)
            violate(run, 'unguided', 'major', 'Aircraft entered the stand with no marshaller guiding it.', 'marshaller');
    }

    /* Where the aircraft stopped against its stop bar, in meters past it (negative is short of it). The
       bridge can reach a door a little off, but not far. */
    function judgeStop(run, pastStopM) {
        const off = Math.abs(pastStopM);
        const where = pastStopM > 0 ? 'past' : 'short of';
        if (off > 3) violate(run, 'stop', 'critical', `Aircraft stopped ${off.toFixed(1)} m ${where} the stop bar: the bridge cannot be docked safely.`, 'marshaller');
        else if (off > 1) violate(run, 'stop', 'major', `Aircraft stopped ${off.toFixed(1)} m ${where} the stop bar.`, 'marshaller');
        else if (off > 0.5) violate(run, 'stop', 'minor', `Aircraft stopped ${off.toFixed(1)} m ${where} the stop bar.`, 'marshaller');
        else note(run, `Stopped on the bar (${off.toFixed(1)} m).`, 'ok');
    }

    /* The steps the sim should do now on behalf of the other roles: ready, not the trainee's, and past
       their delay since the step before them was done. Event steps wait for the world, and so do `live`
       steps (slow down, stop), which the 3D world does when the aircraft gets close enough. */
    function due(run) {
        return run.steps.filter(step => {
            if (step.event || step.live || step.role === run.role || !ready(run, step)) return false;
            const since = Math.max(0, ...step.after.map(id => stepById(run, id).doneAt));
            return run.t >= since + (step.delay ?? 2);
        });
    }

    // The trainee's steps that can be done now, for the prompts in guided mode.
    const nextForTrainee = run => run.steps.filter(step => step.role === run.role && ready(run, step));

    function score(run) {
        const lost = run.violations.reduce((sum, v) => sum + PENALTY[v.severity], 0);
        const critical = run.violations.some(v => v.severity === 'critical');
        const value = Math.max(0, 100 - lost);
        return { value, critical, passed: !critical && value >= (run.scenario.passMark ?? 80) };
    }

    const isReady = (run, id) => { const step = stepById(run, id); return Boolean(step && ready(run, step)); };

    const api = { ROLES, CHECKS, ACTIONS, createRun, perform, event, observe, judgeStop, due, nextForTrainee, score, initialState, isReady, isDone };
    root.RampProcedures = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
