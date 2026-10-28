const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMetar, preset, runwayForWind, describe, fromOpenMeteo, fromNwsObservation, PRESETS } = require('./metar');

test('a live Boston METAR', () => {
    const w = parseMetar('METAR KBOS 282054Z 12006KT 10SM FEW120 SCT200 BKN250 10/05 A3041 RMK AO2 SLP296');
    assert.deepEqual(w.wind, { dir: 120, speed: 6, gust: 0 });
    assert.equal(Math.round(w.visibilityM / 1609.34), 10);
    assert.equal(w.ceilingFt, 25000);
    assert.equal(w.cover, 0.75);
    assert.equal(w.tempC, 10);
    assert.equal(w.altimeter, 30.41);
    assert.equal(w.precip, null);
});

test('fractions of a mile, thunderstorms, rain and gusts', () => {
    const w = parseMetar('KBOS 241752Z 24018G30KT 1 1/2SM +TSRA BKN012CB OVC030 19/17 A2968');
    assert.ok(Math.abs(w.visibilityM - 1.5 * 1609.34) < 1);
    assert.equal(w.thunder, true);
    assert.equal(w.precip, 'rain');
    assert.equal(w.intensity, 3);
    assert.equal(w.wind.gust, 30);
    assert.equal(w.ceilingFt, 1200);
    assert.equal(w.clouds[0].convective, true);
});

test('fog, snow and meters', () => {
    const fog = parseMetar('KBOS 00000KT 1/4SM FG VV002 08/08 A3010');
    assert.equal(fog.fog, true);
    assert.equal(fog.ceilingFt, 200);
    assert.ok(fog.visibilityM < 500);
    const snow = parseMetar('KBOS 35016G24KT 3/4SM -SN BR OVC006 M02/M04');
    assert.equal(snow.precip, 'snow');
    assert.equal(snow.intensity, 1);
    assert.equal(snow.tempC, -2);
    assert.equal(snow.mist, true);
    assert.equal(parseMetar('EGLL 271050Z 25012KT 4000 RA BKN008').visibilityM, 4000);
    assert.equal(parseMetar('EGLL 271050Z 25012KT 9999 FEW030').visibilityM, 10000);
});

test('every preset reads cleanly', () => {
    for (const key of Object.keys(PRESETS)) {
        const w = preset(key, 'KBOS');
        assert.ok(w.raw.startsWith('KBOS'), key);
        assert.ok(describe(w).startsWith('Wind'), key);
    }
    assert.match(describe(preset('storms')), /thunderstorm, heavy rain, ceiling 1,200 ft/);
});

test('the runway most into the wind wins', () => {
    const ends = [{ name: '04R', heading: 35, lengthM: 3050 }, { name: '22L', heading: 215, lengthM: 3050 },
        { name: '27', heading: 271, lengthM: 2134 }, { name: '09', heading: 91, lengthM: 2134 }];
    assert.equal(runwayForWind(ends, { dir: 220, speed: 12 }), '22L');
    assert.equal(runwayForWind(ends, { dir: 270, speed: 20 }), '27');
    assert.equal(runwayForWind(ends, { dir: 40, speed: 4 }), null, 'under 5 knots keeps the current runway');
});

test('Open-Meteo conditions become a METAR the reader understands', () => {
    const metar = fromOpenMeteo({ wind_speed_10m: 14.2, wind_direction_10m: 262, wind_gusts_10m: 28, visibility: 3200,
        cloud_cover: 100, cloud_cover_low: 80, weather_code: 63 }, 'EGLL');
    assert.equal(metar, 'EGLL 26014G28KT 3200 RA OVC012');
    const w = parseMetar(metar);
    assert.equal(w.precip, 'rain');
    assert.equal(w.ceilingFt, 1200);
    assert.equal(w.visibilityM, 3200);
    assert.equal(fromOpenMeteo({ wind_speed_10m: 0.4, visibility: 24000, cloud_cover: 3, weather_code: 0 }, 'EGLL'), 'EGLL 00000KT 9999 SKC');
});

test('a weather service observation without METAR text is written as one', () => {
    const metar = fromNwsObservation({ windSpeed: { value: 18.5 }, windDirection: { value: 150 }, windGust: { value: null },
        visibility: { value: 2414 }, presentWeather: [{ rawString: '-RA' }, { rawString: 'BR' }],
        cloudLayers: [{ amount: 'BKN', base: { value: 610 } }, { amount: 'OVC', base: { value: 1830 } }] }, 'KBOS');
    assert.equal(metar, 'KBOS 15010KT 1 1/2SM -RA BR BKN020 OVC060');
    const w = parseMetar(metar);
    assert.equal(w.ceilingFt, 2000);
    assert.equal(w.precip, 'rain');
    assert.equal(fromNwsObservation({ windSpeed: { value: 0 }, visibility: { value: 16093 }, cloudLayers: [{ amount: 'CLR', base: { value: null } }] }, 'KBOS'),
        'KBOS 00000KT 10SM CLR');
});
