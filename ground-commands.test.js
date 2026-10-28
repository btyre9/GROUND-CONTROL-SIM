const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, sayRunway, sayTaxiway, sayFlight } = require('./ground-commands');

test('spoken pushback, with the callsign in front', () => {
    const r = parse('Delta four ninety seven, push back approved');
    assert.deepEqual(r.callsignWords, ['DELTA', 'FOUR', 'NINETY', 'SEVEN']);
    assert.deepEqual(r.commands, [{ action: 'push' }]);
});

test('taxi clearance names the runway, the taxiways and a hold short', () => {
    const r = parse('JetBlue 412 runway two two right taxi via echo alpha november hold short runway four left');
    assert.deepEqual(r.commands, [
        { action: 'taxi', runway: '22R', via: ['E', 'A', 'N'] },
        { action: 'holdShort', runway: '04L' }
    ]);
});

test('taxi to runway first, numbered taxiways and spoken numbers', () => {
    const r = parse('American 12 taxi to runway fifteen right via november one bravo lima');
    assert.deepEqual(r.commands, [{ action: 'taxi', runway: '15R', via: ['N1', 'B', 'L'] }]);
    assert.deepEqual(parse('taxi to runway twenty seven via kilo').commands[0], { action: 'taxi', runway: '27', via: ['K'] });
});

test('crossing, line up and wait, takeoff and hold position', () => {
    assert.deepEqual(parse('cross runway four left').commands, [{ action: 'cross', runway: '04L' }]);
    assert.deepEqual(parse('runway two two right, line up and wait').commands, [{ action: 'luaw', runway: '22R' }]);
    assert.deepEqual(parse('runway two two right cleared for take off').commands, [{ action: 'takeoff', runway: '22R' }]);
    assert.deepEqual(parse('cleared for takeoff runway 9').commands, [{ action: 'takeoff', runway: '09' }]);
    assert.deepEqual(parse('hold position').commands, [{ action: 'holdPosition' }]);
    assert.deepEqual(parse('continue taxi').commands, [{ action: 'continue' }]);
});

test('typed shorthand', () => {
    assert.deepEqual(parse('PB', { typed: true }).commands, [{ action: 'push' }]);
    assert.deepEqual(parse('DAL497 TX 22R E A N HS 4L', { typed: true }), {
        callsignWords: ['DAL497'],
        commands: [{ action: 'taxi', runway: '22R', via: ['E', 'A', 'N'] }, { action: 'holdShort', runway: '04L' }]
    });
    assert.deepEqual(parse('X 4L', { typed: true }).commands, [{ action: 'cross', runway: '04L' }]);
    assert.deepEqual(parse('CTO', { typed: true }).commands, [{ action: 'takeoff', runway: null }]);
});

test('a taxi clearance without a runway is refused', () => {
    assert.match(parse('taxi via echo alpha').error, /runway/);
    assert.match(parse('good morning').error, /No ground or tower instruction/);
});

test('readback wording', () => {
    assert.equal(sayRunway('22R'), 'two two right');
    assert.equal(sayRunway('04L'), 'four left');
    assert.equal(sayTaxiway('N1'), 'november one');
    assert.equal(sayFlight(497), 'four ninety seven');
    assert.equal(sayFlight(1423), 'fourteen twenty three');
    assert.equal(sayFlight(905), 'nine zero five');
    assert.equal(sayFlight(600), 'six hundred');
});
