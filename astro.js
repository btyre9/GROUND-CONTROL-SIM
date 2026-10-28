/* Where the sun and moon are for a place and time, and how much of the moon is lit. These are the
   compact formulas from SunCalc (Vladimir Agafonkin), good to a fraction of a degree. Angles come back
   in degrees: elevation above the horizon, and azimuth as a compass bearing from true north. */
(function (root) {
    'use strict';

    const PI = Math.PI, rad = PI / 180, e = rad * 23.4397;      // Obliquity of the Earth's axis.
    const toDays = date => date.valueOf() / 86400000 - 0.5 + 2440588 - 2451545;
    const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
    const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
    const azimuth = (H, phi, dec) => Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    const altitude = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;

    function sunCoords(d) {
        const M = rad * (357.5291 + 0.98560028 * d);
        const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
        const L = M + C + rad * 102.9372 + PI;
        return { dec: declination(L, 0), ra: rightAscension(L, 0) };
    }

    function moonCoords(d) {
        const L = rad * (218.316 + 13.176396 * d), M = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.229350 * d);
        const l = L + rad * 6.289 * Math.sin(M), b = rad * 5.128 * Math.sin(F);
        return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) };
    }

    // SunCalc measures azimuth from south, turning west; a compass bearing is measured from north.
    const bearing = az => ((az / rad + 180) % 360 + 360) % 360;

    function sun(date, lat, lon) {
        const d = toDays(date), c = sunCoords(d), H = siderealTime(d, rad * -lon) - c.ra;
        return { elevation: altitude(H, rad * lat, c.dec) / rad, azimuth: bearing(azimuth(H, rad * lat, c.dec)) };
    }

    function moon(date, lat, lon) {
        const d = toDays(date), c = moonCoords(d), H = siderealTime(d, rad * -lon) - c.ra;
        const s = sunCoords(d), sunDist = 149598000;
        const phi = Math.acos(Math.sin(s.dec) * Math.sin(c.dec) + Math.cos(s.dec) * Math.cos(c.dec) * Math.cos(s.ra - c.ra));
        const inc = Math.atan2(sunDist * Math.sin(phi), c.dist - sunDist * Math.cos(phi));
        const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - c.ra),
            Math.sin(s.dec) * Math.cos(c.dec) - Math.cos(s.dec) * Math.sin(c.dec) * Math.cos(s.ra - c.ra));
        return {
            elevation: altitude(H, rad * lat, c.dec) / rad, azimuth: bearing(azimuth(H, rad * lat, c.dec)),
            lit: (1 + Math.cos(inc)) / 2,                                   // Fraction of the disk lit, 0 new to 1 full.
            waxing: angle < 0
        };
    }

    // The time today (UTC) when the sun crosses the horizon going up or down, found by bisection.
    function sunCrossing(date, lat, lon, rising) {
        const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
        const noonOffset = -lon / 15 * 3600000;                            // Solar noon in UTC, roughly.
        let lo = day + 12 * 3600000 + noonOffset + (rising ? -12 : 0) * 3600000, hi = lo + 12 * 3600000;
        const above = t => sun(new Date(t), lat, lon).elevation > -0.83;
        if (above(lo) === above(hi)) return null;                          // Midnight sun or polar night.
        for (let i = 0; i < 30; i++) {
            const mid = (lo + hi) / 2;
            if (above(mid) === above(lo)) lo = mid; else hi = mid;
        }
        return new Date((lo + hi) / 2);
    }

    const api = { sun, moon, sunCrossing };
    root.Astro = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
