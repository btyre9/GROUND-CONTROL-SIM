/* Aerial photos draped on the ground under the airport, so the coastline, roads and neighborhoods around
   it are real. Sharp tiles near the airport sit on coarser ones reaching to the horizon. US airports use
   USGS imagery (public domain); a tile USGS can't supply comes from Esri World Imagery instead. */
import * as THREE from 'three';

const SOURCES = [
    (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`,
    (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
];
export const CREDITS = ['USGS National Map', 'Esri, Maxar, Earthstar Geographics'];

// Multiplies every tile's colors: the photos have daylight baked in, so they are dimmed at night.
export const imageryTint = new THREE.Color(1, 1, 1);

// Zoom level and how far out it reaches, sharpest last so it draws on top.
const LEVELS = [{ zoom: 10, radiusM: 70000 }, { zoom: 13, radiusM: 16000 }, { zoom: 16, radiusM: 3600 }];

const tileX = (lon, z) => (lon + 180) / 360 * 2 ** z;
const tileY = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z;
const tileLon = (x, z) => x / 2 ** z * 360 - 180;
const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;

function loadTexture(loader, z, x, y, source = 0) {
    return new Promise((resolve, reject) => {
        loader.load(SOURCES[source](z, x, y), resolve, undefined, () => {
            if (source + 1 < SOURCES.length) loadTexture(loader, z, x, y, source + 1).then(resolve, reject);
            else reject(new Error('tile unavailable'));
        });
    }).then(texture => ({ texture, source }));
}

/* Returns the group at once; tiles appear as they arrive. `done` resolves with how many loaded and
   which sources were used, for the credit line. */
export function buildImagery(center, projection, firstOrder) {
    const group = new THREE.Group();
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const jobs = [], used = new Set();
    const metersPerLat = 111320, metersPerLon = 111320 * Math.cos(center.lat * Math.PI / 180);

    LEVELS.forEach(({ zoom, radiusM }, level) => {
        const dLat = radiusM / metersPerLat, dLon = radiusM / metersPerLon;
        const x0 = Math.floor(tileX(center.lon - dLon, zoom)), x1 = Math.floor(tileX(center.lon + dLon, zoom));
        const y0 = Math.floor(tileY(center.lat + dLat, zoom)), y1 = Math.floor(tileY(center.lat - dLat, zoom));
        const material = { depthTest: false, depthWrite: false };
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
            const nw = projection.toLocal(tileLat(y, zoom), tileLon(x, zoom));
            const se = projection.toLocal(tileLat(y + 1, zoom), tileLon(x + 1, zoom));
            const geometry = new THREE.PlaneGeometry(se.x - nw.x, se.z - nw.z);
            geometry.rotateX(-Math.PI / 2);
            geometry.translate((nw.x + se.x) / 2, 0, (nw.z + se.z) / 2);
            jobs.push(loadTexture(loader, zoom, x, y).then(({ texture, source }) => {
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.anisotropy = 8;
                used.add(source);
                const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, ...material }));
                mesh.material.color = imageryTint;     // Shared, so tiles arriving later match the time of day.
                mesh.renderOrder = firstOrder + level;
                mesh.matrixAutoUpdate = false;
                group.add(mesh);
                return true;
            }, () => false));
        }
    });
    const done = Promise.all(jobs).then(results => ({
        loaded: results.filter(Boolean).length, total: results.length, credits: [...used].sort().map(i => CREDITS[i])
    }));
    return { group, done };
}
