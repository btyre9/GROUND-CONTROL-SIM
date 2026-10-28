/* Reads a METAR (live from the weather service, or one of the presets below) into what the tower view
   draws: wind, visibility, precipitation, fog, thunder and cloud layers. Also picks the runway that
   faces most into the wind. */
(function (root) {
    'use strict';

    const SM = 1609.34;

    // Presets are METARs too, so they go through the same reader as live weather. XXXX becomes the airport.
    const PRESETS = {
        clear: { label: 'Clear', metar: 'XXXX 22008KT 10SM SKC 22/10 A3002' },
        scattered: { label: 'Scattered clouds', metar: 'XXXX 23010KT 10SM SCT035 SCT120 21/11 A2998' },
        overcast: { label: 'Overcast', metar: 'XXXX 18012KT 7SM OVC012 14/11 A2984' },
        rain: { label: 'Rain', metar: 'XXXX 15014KT 3SM -RA BR BKN008 OVC015 12/11 A2976' },
        storms: { label: 'Thunderstorms', metar: 'XXXX 24018G30KT 1 1/2SM +TSRA BKN012CB OVC030 19/17 A2968' },
        fog: { label: 'Fog', metar: 'XXXX 00000KT 1/4SM FG VV002 08/08 A3010' },
        snow: { label: 'Snow', metar: 'XXXX 35016G24KT 3/4SM SN BR OVC006 M02/M04 A2990' }
    };
    const COVER = { SKC: 0, CLR: 0, NSC: 0, FEW: 0.2, SCT: 0.45, BKN: 0.75, OVC: 1, VV: 1 };

    function parseMetar(raw) {
        const result = { raw: String(raw).trim(), wind: { dir: null, speed: 0, gust: 0 }, visibilityM: 10 * SM,
            precip: null, intensity: 0, thunder: false, fog: false, mist: false, clouds: [], ceilingFt: null, cover: 0,
            tempC: null, altimeter: null };
        const tokens = result.raw.replace(/\s+RMK\s.*$/, '').split(/\s+/);
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            let m;
            if ((m = t.match(/^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/))) {
                const k = m[4] === 'MPS' ? 1.944 : 1;
                result.wind = { dir: m[1] === 'VRB' ? null : +m[1], speed: Math.round(+m[2] * k), gust: m[3] ? Math.round(+m[3] * k) : 0 };
            } else if ((m = t.match(/^([MP]?)(\d+)\/(\d+)SM$/))) {
                // A whole number before it ("1 1/2SM") was in the previous token.
                const whole = /^\d+$/.test(tokens[i - 1] || '') && i > 1 ? +tokens[i - 1] : 0;
                result.visibilityM = (whole + +m[2] / +m[3]) * SM;
            } else if ((m = t.match(/^([MP]?)(\d+)SM$/))) {
                result.visibilityM = +m[2] * SM;
            } else if (/^\d{4}$/.test(t) && i > 1 && !/^\d{6}Z$/.test(t)) {
                result.visibilityM = +t >= 9999 ? 10000 : +t;      // Meters, outside the US.
            } else if (t === 'CAVOK') {
                result.visibilityM = 10000;
            } else if ((m = t.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/))) {
                const layer = { cover: m[1], baseFt: +m[2] * 100, convective: Boolean(m[3]) };
                result.clouds.push(layer);
                if ((layer.cover === 'BKN' || layer.cover === 'OVC' || layer.cover === 'VV') && result.ceilingFt === null) result.ceilingFt = layer.baseFt;
            } else if ((m = t.match(/^(-|\+|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP)*)(BR|FG|FU|VA|DU|SA|HZ|PY)?$/)) && t.length >= 2 && !/^\d/.test(t)) {
                if (m[2] === 'TS' || /TS/.test(t)) result.thunder = true;
                if (m[4] === 'FG') result.fog = true;
                if (m[4] === 'BR' || m[4] === 'HZ') result.mist = true;
                if (m[3]) {
                    result.precip = /SN|SG|IC|PL/.test(m[3]) ? 'snow' : /RA|GR|GS/.test(m[3]) ? 'rain' : 'drizzle';
                    result.intensity = m[1] === '-' ? 1 : m[1] === '+' ? 3 : 2;
                }
            } else if ((m = t.match(/^(M?\d{2})\/(M?\d{2})?$/))) {
                result.tempC = +m[1].replace('M', '-');
            } else if ((m = t.match(/^A(\d{4})$/))) {
                result.altimeter = +m[1] / 100;
            }
        }
        result.cover = Math.max(0, ...result.clouds.map(c => COVER[c.cover] ?? 0));
        return result;
    }

    function preset(key, icao) {
        return parseMetar(PRESETS[key].metar.replace('XXXX', icao || 'XXXX'));
    }

    /* The runway end most into the wind: the most headwind, longer runways winning close calls.
       ends: [{ name, heading, lengthM }]. Calm or variable wind keeps the first choice. */
    function runwayForWind(ends, wind) {
        // Under 5 knots counts as calm: the airport keeps its preferred runway.
        if (!ends.length || wind.dir === null || wind.speed < 5) return null;
        let best = null, bestScore = -Infinity;
        for (const end of ends) {
            const headwind = wind.speed * Math.cos((wind.dir - end.heading) * Math.PI / 180);
            const score = headwind + end.lengthM / 1000;
            if (score > bestScore) { best = end; bestScore = score; }
        }
        return best.name;
    }

    // "Wind 220 at 12 gusting 20, visibility 3 miles, rain, ceiling 800" for the weather bar.
    function describe(w) {
        const wind = w.wind.speed < 1 ? 'Wind calm' : `Wind ${w.wind.dir === null ? 'variable' : String(w.wind.dir).padStart(3, '0')} at ${w.wind.speed}${w.wind.gust ? ` gusting ${w.wind.gust}` : ''}`;
        const miles = w.visibilityM / SM;
        const vis = miles >= 10 || w.visibilityM >= 9999 ? 'visibility 10+' : `visibility ${miles < 1 ? miles.toFixed(2).replace(/^0/, '') : Math.round(miles * 2) / 2} mi`;
        const wx = [w.thunder && 'thunderstorm', w.precip && `${['', 'light ', '', 'heavy '][w.intensity]}${w.precip}`, w.fog && 'fog', !w.fog && w.mist && 'mist'].filter(Boolean);
        const ceiling = w.ceilingFt !== null ? `ceiling ${w.ceilingFt.toLocaleString('en-US')} ft` : w.cover > 0 ? 'no ceiling' : 'sky clear';
        return [wind, vis, ...wx, ceiling].join(', ');
    }

    /* Open-Meteo's current conditions (worldwide, free, no key) written as a METAR, so they read like
       live US observations. Weather codes are the WMO ones; cloud bases are estimated from how much of
       the cover is low cloud. */
    function fromOpenMeteo(current, icao) {
        const pad = (n, w) => String(Math.round(n)).padStart(w, '0');
        const speed = current.wind_speed_10m || 0, gust = current.wind_gusts_10m || 0;
        const wind = speed < 1 ? '00000KT' : `${pad((Math.round(current.wind_direction_10m / 10) * 10) % 360 || 360, 3)}${pad(speed, 2)}${gust > speed + 9 ? `G${pad(gust, 2)}` : ''}KT`;
        const vis = Math.min(9999, Math.max(0, current.visibility ?? 9999));
        const code = current.weather_code ?? 0;
        const WX = { 45: 'FG', 48: 'FG', 51: '-DZ', 53: 'DZ', 55: '+DZ', 56: '-FZDZ', 57: 'FZDZ', 61: '-RA', 63: 'RA', 65: '+RA',
            66: '-FZRA', 67: 'FZRA', 71: '-SN', 73: 'SN', 75: '+SN', 77: 'SG', 80: '-SHRA', 81: 'SHRA', 82: '+SHRA',
            85: '-SHSN', 86: '+SHSN', 95: 'TSRA', 96: 'TSRA', 99: '+TSRA' };
        const cover = current.cloud_cover ?? 0, low = current.cloud_cover_low ?? 0;
        const amount = cover >= 95 ? 'OVC' : cover >= 60 ? 'BKN' : cover >= 30 ? 'SCT' : cover >= 10 ? 'FEW' : null;
        const base = code === 45 || code === 48 ? 2 : low >= 50 ? 12 : low >= 20 ? 30 : 60;
        const clouds = amount ? `${amount}${pad(base, 3)}` : 'SKC';
        return [icao, wind, vis >= 9999 ? '9999' : pad(vis, 4), WX[code] || '', clouds].filter(Boolean).join(' ');
    }

    /* A National Weather Service observation's separate values (api.weather.gov) written as a METAR, for
       the many reports that come without METAR text. */
    function fromNwsObservation(p, icao) {
        const value = q => q && q.value !== null && q.value !== undefined ? q.value : null;
        const kmh = value(p.windSpeed), gustKmh = value(p.windGust), dir = value(p.windDirection);
        const kt = v => Math.round(v * 0.539957);
        const pad = (n, w) => String(Math.round(n)).padStart(w, '0');
        const wind = kmh === null || kt(kmh) < 1 ? '00000KT' :
            `${dir === null ? 'VRB' : pad((Math.round(dir / 10) * 10) % 360 || 360, 3)}${pad(kt(kmh), 2)}${gustKmh ? `G${pad(kt(gustKmh), 2)}` : ''}KT`;
        // Rounded to the quarter mile first, so 2,414 m is 1 1/2 miles rather than just under.
        const miles = value(p.visibility) === null ? null : Math.round(value(p.visibility) / SM * 4) / 4;
        const quarters = { 1: '1/4', 2: '1/2', 3: '3/4' };
        const vis = miles === null ? '' : miles >= 10 ? '10SM' : miles >= 1 ?
            `${Math.floor(miles)}${miles % 1 >= 0.5 && miles < 3 ? ' 1/2' : ''}SM` : `${quarters[Math.max(1, Math.round(miles * 4))] || '3/4'}SM`;
        const weather = (p.presentWeather || []).map(w => w.rawString).filter(Boolean);
        const clouds = (p.cloudLayers || []).map(l => {
            const base = value(l.base);
            return ['CLR', 'SKC'].includes(l.amount) || base === null ? l.amount : `${l.amount}${pad(base * 3.28084 / 100, 3)}`;
        });
        return [icao, wind, vis, ...weather, ...clouds].filter(Boolean).join(' ');
    }

    const api = { parseMetar, preset, runwayForWind, describe, fromOpenMeteo, fromNwsObservation, PRESETS };
    root.Metar = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
