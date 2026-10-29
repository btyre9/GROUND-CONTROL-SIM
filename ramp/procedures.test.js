const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('./procedures');

const scenarioDir = path.join(__dirname, 'scenarios');
const scenarios = fs.readdirSync(scenarioDir).filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .map(f => JSON.parse(fs.readFileSync(path.join(scenarioDir, f), 'utf8')));
const standard = scenarios.find(s => s.id === 'standard-arrival');

// Plays a run with the sim doing every role, firing world events as soon as they are ready.
function autoplay(run, { stopPast = 0 } = {}) {
    for (let guard = 0; guard < 2000 && !run.finished; guard++) {
        R.observe(run, {}, 1);
        for (const step of R.due(run)) R.perform(run, step.action, step.role);
        for (const step of run.steps.filter(s => s.status === 'pending' && R.isReady(run, s.id))) {
            if (step.event) {
                if (step.event === 'aircraft-stopped') R.judgeStop(run, stopPast);
                R.event(run, step.event);
            } else if (step.live) R.perform(run, step.action, step.role);
        }
    }
    return run;
}

test('every scenario names known actions and steps', () => {
    for (const scenario of scenarios) {
        const ids = new Set(scenario.steps.map(s => s.id));
        assert.equal(ids.size, scenario.steps.length, `${scenario.id}: duplicate step ids`);
        for (const step of scenario.steps) {
            if (!step.event) assert.ok(R.ACTIONS[step.action], `${scenario.id}: unknown action ${step.action}`);
            if (!step.event) assert.ok(R.ROLES[step.role], `${scenario.id}: unknown role ${step.role}`);
            for (const id of step.after || []) assert.ok(ids.has(id), `${scenario.id}: ${step.id} comes after unknown ${id}`);
        }
    }
});

test('the scenario as written is a clean turn: no violations', () => {
    for (const scenario of scenarios) {
        const run = autoplay(R.createRun(scenario));
        assert.ok(run.finished, `${scenario.id} did not finish`);
        assert.deepEqual(run.violations, [], `${scenario.id}: ${run.violations.map(v => v.text).join('; ')}`);
        assert.equal(R.score(run).value, 100);
    }
});

test('chocking with the beacon still on is a major violation', () => {
    const run = R.createRun(standard, 'lead');
    R.event(run, 'aircraft-stopped');
    const found = R.perform(run, 'chock-nose', 'lead');
    assert.ok(found.some(v => v.severity === 'major' && /beacon/.test(v.text)));
    assert.ok(found.some(v => /Engines are still running/.test(v.text)));
    assert.equal(run.state.chocks.nose, true, 'the action still happens');
});

test('the trainee role is left to the trainee', () => {
    const run = R.createRun(standard, 'lead');
    R.observe(run, {}, 10);
    assert.ok(!R.due(run).some(s => s.role === 'lead'));
    assert.deepEqual(R.nextForTrainee(run).map(s => s.id), ['fod']);
});

test('doing a step before the ones it follows is out of sequence', () => {
    const run = R.createRun(standard, 'lead');
    const found = R.perform(run, 'stage-chocks-cones', 'lead');
    assert.equal(found.length, 1);
    assert.match(found[0].text, /before: Clear equipment/);
});

test('a hazard seen over many frames counts once', () => {
    const run = R.createRun(standard);
    for (let i = 0; i < 30; i++) R.observe(run, { peopleNearEngines: ['Wing walker (left)'] }, 0.1);
    assert.equal(run.violations.length, 1);
    assert.equal(run.violations[0].severity, 'critical');
    assert.equal(R.score(run).passed, false);
});

test('stopping well past the stop bar fails the run', () => {
    const run = autoplay(R.createRun(standard), { stopPast: 3.4 });
    assert.ok(run.violations.some(v => v.key === 'stop' && v.severity === 'critical'));
    const close = autoplay(R.createRun(standard), { stopPast: 0.3 });
    assert.equal(close.violations.length, 0);
});

test('equipment in the ERA while the aircraft arrives is a violation', () => {
    const run = R.createRun(standard);
    R.observe(run, { equipmentInEra: ['Baggage cart'] }, 1);
    assert.equal(run.violations[0].severity, 'major');
    R.event(run, 'aircraft-stopped');
    run.state.beacon = false;
    R.observe(run, { equipmentInEra: ['Belt loader'] }, 1);
    assert.equal(run.violations.length, 1, 'fine once the beacon is off');
});
