const test = require('node:test');
const assert = require('node:assert/strict');
const { sun, moon, sunCrossing } = require('./astro');

const BOS = { lat: 42.3656, lon: -71.0096 };

test('the sun is high at midday in summer and below the horizon at night', () => {
    const noon = sun(new Date('2026-06-21T16:45:00Z'), BOS.lat, BOS.lon);          // About 12:45 local daylight time.
    assert.ok(noon.elevation > 68 && noon.elevation < 72, `elevation ${noon.elevation}`);
    assert.ok(noon.azimuth > 160 && noon.azimuth < 200, `azimuth ${noon.azimuth}`);
    assert.ok(sun(new Date('2026-06-22T04:00:00Z'), BOS.lat, BOS.lon).elevation < -15);
});

test('the sun rises in the east and sets in the west', () => {
    const rise = sunCrossing(new Date('2026-03-20T12:00:00Z'), BOS.lat, BOS.lon, true);
    const set = sunCrossing(new Date('2026-03-20T12:00:00Z'), BOS.lat, BOS.lon, false);
    // Equinox in Boston: sunrise about 10:50 UTC and sunset about 23:00 UTC.
    assert.ok(Math.abs(rise.getUTCHours() + rise.getUTCMinutes() / 60 - 10.8) < 0.4, rise.toISOString());
    assert.ok(Math.abs(set.getUTCHours() + set.getUTCMinutes() / 60 - 23.0) < 0.4, set.toISOString());
    assert.ok(Math.abs(sun(rise, BOS.lat, BOS.lon).azimuth - 90) < 6);
    assert.ok(Math.abs(sun(set, BOS.lat, BOS.lon).azimuth - 270) < 6);
});

test('the moon is nearly full at a known full moon and nearly dark at a new moon', () => {
    assert.ok(moon(new Date('2024-04-23T23:49:00Z'), BOS.lat, BOS.lon).lit > 0.97);
    assert.ok(moon(new Date('2024-04-08T18:21:00Z'), BOS.lat, BOS.lon).lit < 0.03);
});
