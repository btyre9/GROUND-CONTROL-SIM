const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseParked, groupOf } = require('./ramp-logic');

const gate = (name, extra = {}) => ({ name, kind: 'gate', categories: ['jets'], operation: 'airline', ...extra });
const ramp = [
    ...Array.from({ length: 40 }, (_, i) => gate(`A${i + 1}`)),
    ...Array.from({ length: 40 }, (_, i) => gate(`B${i + 1}`)),
    ...Array.from({ length: 20 }, (_, i) => gate(`R${i + 1}`, { kind: 'tie_down' })),
    gate('X1', { categories: ['props'] })
];

// A repeatable random sequence, so each test sees the same mix.
function seeded(seed) {
    return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
}

test('gates are grouped by concourse, with remote stands and cargo apart', () => {
    assert.equal(groupOf(gate('B10')), 'B');
    assert.equal(groupOf(gate('NC13')), 'NC');
    assert.equal(groupOf(gate('14M', { kind: 'tie_down' })), 'remote');
    assert.equal(groupOf(gate('C5', { operation: 'cargo' })), 'cargo');
});

test('the ramp is never full and only jet gates are used', () => {
    for (let seed = 1; seed <= 25; seed++) {
        const parked = chooseParked(ramp, seeded(seed));
        assert.ok(parked.length < 0.8 * 100, `seed ${seed}: ${parked.length} of 100 jet gates`);
        assert.ok(!parked.some(g => g.name === 'X1'));
    }
});

test('occupancy changes from one load to the next', () => {
    const counts = new Set(Array.from({ length: 10 }, (_, s) => chooseParked(ramp, seeded(s + 1)).length));
    assert.ok(counts.size > 3, [...counts].join(', '));
});
