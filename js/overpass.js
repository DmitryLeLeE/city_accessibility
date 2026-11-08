// Загрузка данных OpenStreetMap: Overpass (тайлами, с кэшем и повторами) и Nominatim.

import { CONFIG, CATEGORIES } from './config.js';
import { geometryAreaM2, sampleRing } from './geo.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

let endpointShift = 0;

export async function runOverpass(query, { signal, retries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    const url = CONFIG.overpass[(endpointShift + attempt) % CONFIG.overpass.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark);
      endpointShift = (endpointShift + attempt) % CONFIG.overpass.length;
      return json;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      await sleep(900 * (attempt + 1), signal);
    }
  }
  throw new Error('Overpass недоступен: ' + (lastErr?.message || 'неизвестная ошибка'));
}

// ── тайлы ───────────────────────────────────────────────────────────────────

export function tilesForBBox([w, s, e, n]) {
  const { lat: LAT, lon: LON } = CONFIG.tile;
  const tiles = [];
  for (let ty = Math.floor(s / LAT); ty <= Math.floor(n / LAT); ty++) {
    for (let tx = Math.floor(w / LON); tx <= Math.floor(e / LON); tx++) {
      tiles.push({ ty, tx, bbox: [tx * LON, ty * LAT, (tx + 1) * LON, (ty + 1) * LAT] });
    }
  }
  return tiles;
}

const bboxStr = ([w, s, e, n]) => `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;

const cache = new Map(); // "kind:ty:tx" → Promise

function cached(kind, tile, loader) {
  const key = `${kind}:${tile.ty}:${tile.tx}`;
  if (!cache.has(key)) {
    const p = loader().catch(err => { cache.delete(key); throw err; });
    cache.set(key, p);
  }
  return cache.get(key);
}

async function pool(items, limit, worker, signal) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function loadKind(kind, bbox, loaderFor, { onProgress, signal } = {}) {
  const tiles = tilesForBBox(bbox);
  let done = 0;
  onProgress?.(0, tiles.length);
  return pool(tiles, CONFIG.concurrency, async tile => {
    const r = await cached(kind, tile, () => loaderFor(tile, signal));
    onProgress?.(++done, tiles.length);
    return r;
  }, signal);
}

// ── сеть ────────────────────────────────────────────────────────────────────

const NETWORK_QUERY = bb => `[out:json][timeout:90];
way["highway"]
  ["highway"!~"^(motorway|motorway_link|bus_guideway|raceway|proposed|construction|abandoned|platform|elevator|escape|bus_stop|rest_area|services|corridor)$"]
  ["foot"!~"^(no|private)$"]["access"!~"^(private|no)$"]["motorroad"!="yes"]["area"!="yes"](${bb});
out geom;`;

export async function loadNetwork(bbox, opts) {
  const parts = await loadKind('net', bbox, async (tile, signal) => {
    const json = await runOverpass(NETWORK_QUERY(bboxStr(tile.bbox)), { signal });
    return json.elements
      .filter(el => el.type === 'way' && el.geometry)
      .map(el => ({ id: el.id, nodes: el.nodes, geometry: el.geometry, tags: { highway: el.tags?.highway } }));
  }, opts);
  const seen = new Map();
  for (const part of parts) for (const w of part) if (!seen.has(w.id)) seen.set(w.id, w);
  return [...seen.values()];
}

// ── объекты (POI) ───────────────────────────────────────────────────────────

function poiQuery(bb) {
  const pts = [], areas = [];
  for (const c of CATEGORIES) {
    for (const f of c.filters) {
      if (c.kind === 'area') areas.push(`way${f}(${bb});`, `rel${f}(${bb});`);
      else pts.push(`nwr${f}(${bb});`);
    }
  }
  return `[out:json][timeout:90];
(${pts.join('')})->.a;
.a out tags center;
(${areas.join('')})->.p;
.p out body geom;`;
}

const MIN_PARK_M2 = 2000;
const PARK_STEP_M = 60;

/** Превращает элементы Overpass в список объектов {id, name, cat, lat, lon, pts}. */
export function parsePois(elements, toGeoJSON = globalThis.osmtogeojson) {
  const pois = [];
  const areaEls = [];
  for (const el of elements) {
    const isArea = el.geometry || el.members?.some(m => m.geometry);
    if (isArea) { areaEls.push(el); continue; }
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const tags = el.tags || {};
    for (const c of CATEGORIES) {
      if (c.kind === 'point' && c.match(tags)) {
        pois.push({ id: `${el.type[0]}${el.id}:${c.id}`, name: tags.name || '', cat: c.id, lat, lon, pts: [[lon, lat]] });
      }
    }
  }
  if (areaEls.length && toGeoJSON) {
    const fc = toGeoJSON({ elements: areaEls }, { flatProperties: true });
    for (const f of fc.features) {
      const geom = f.geometry;
      if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;
      const props = f.properties || {};
      for (const c of CATEGORIES) {
        if (c.kind !== 'area' || !c.match(props)) continue;
        if (geometryAreaM2(geom) < MIN_PARK_M2) continue;
        const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
        const pts = polys.flatMap(p => sampleRing(p[0], PARK_STEP_M));
        if (!pts.length) continue;
        const [lon, lat] = pts[0];
        pois.push({ id: `${props.id}:${c.id}`, name: props.name || '', cat: c.id, lat, lon, pts });
      }
    }
  }
  return pois;
}

export async function loadPois(bbox, opts) {
  const parts = await loadKind('poi', bbox, async (tile, signal) => {
    const json = await runOverpass(poiQuery(bboxStr(tile.bbox)), { signal });
    return parsePois(json.elements);
  }, opts);
  const seen = new Map();
  for (const part of parts) for (const p of part) if (!seen.has(p.id)) seen.set(p.id, p);
  return [...seen.values()];
}

// ── здания (прокси численности населения) ───────────────────────────────────

const NON_RESIDENTIAL = 'garage|garages|shed|roof|industrial|commercial|retail|warehouse|service|kiosk|school|hospital|church|cathedral|chapel|train_station|transportation|civic|public|office|university|college|kindergarten|hangar|barn|farm_auxiliary|greenhouse|carport|container|construction|ruins|hut|cabin|toilets|gatehouse|stable|cowshed|sty|boathouse|bunker|digester|silo|tank|transformer_tower|water_tower|static_caravan|supermarket|hotel|parking|stadium|sports_hall|sports_centre|grandstand|pavilion|bridge|allotment_house|tent|mosque|synagogue|temple|monastery';

const BUILDING_QUERY = bb => `[out:json][timeout:90];
way["building"]["building"!~"^(${NON_RESIDENTIAL})$"](${bb});
out tags center qt;`;

export function buildingWeight(tags = {}) {
  const lv = parseFloat(tags['building:levels']);
  if (lv > 0) return Math.min(lv, 30);
  return tags.building === 'apartments' ? 5 : 1;
}

export async function loadBuildings(bbox, opts) {
  const parts = await loadKind('bld', bbox, async (tile, signal) => {
    const json = await runOverpass(BUILDING_QUERY(bboxStr(tile.bbox)), { signal });
    return json.elements
      .filter(el => el.center)
      .map(el => ({ id: el.id, lat: el.center.lat, lon: el.center.lon, w: buildingWeight(el.tags) }));
  }, opts);
  const seen = new Map();
  for (const part of parts) for (const b of part) if (!seen.has(b.id)) seen.set(b.id, b);
  return [...seen.values()];
}

// ── районы (административные границы) ───────────────────────────────────────

/** Какие уровни admin_level есть в области: [{level, count}]. */
export async function listAdminLevels(bbox, { signal } = {}) {
  const [w, s, e, n] = bbox;
  const json = await runOverpass(`[out:json][timeout:60];
rel["boundary"="administrative"]["admin_level"~"^(6|7|8|9|10|11)$"](${bboxStr(bbox)});
out tags bb;`, { signal });
  const counts = new Map();
  for (const el of json.elements) {
    const b = el.bounds;
    if (!b) continue;
    const cx = (b.minlon + b.maxlon) / 2, cy = (b.minlat + b.maxlat) / 2;
    if (cx < w || cx > e || cy < s || cy > n) continue;
    const lv = Number(el.tags.admin_level);
    counts.set(lv, (counts.get(lv) || 0) + 1);
  }
  return [...counts.entries()].map(([level, count]) => ({ level, count })).sort((a, b) => a.level - b.level);
}

export async function loadAdminAreas(bbox, level, { signal, toGeoJSON = globalThis.osmtogeojson } = {}) {
  const json = await runOverpass(`[out:json][timeout:90];
rel["boundary"="administrative"]["admin_level"="${level}"](${bboxStr(bbox)});
out body geom;`, { signal });
  const fc = toGeoJSON(json, { flatProperties: true });
  return fc.features
    .filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
    .map(f => ({ id: f.properties.id, name: f.properties['name:ru'] || f.properties.name || `Район ${f.properties.id}`, geometry: f.geometry }));
}

// ── поиск места ─────────────────────────────────────────────────────────────

export async function geocode(q, { signal } = {}) {
  const url = `${CONFIG.nominatim}?format=jsonv2&limit=6&accept-language=ru&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('Геокодер вернул HTTP ' + res.status);
  const arr = await res.json();
  return arr.map(r => ({
    name: r.display_name,
    lat: Number(r.lat), lon: Number(r.lon),
    bbox: [Number(r.boundingbox[2]), Number(r.boundingbox[0]), Number(r.boundingbox[3]), Number(r.boundingbox[1])],
  }));
}
