// Загрузка данных OpenStreetMap: Overpass (тайлами, с кэшем и повторами) и Nominatim.

import { CONFIG, CATEGORIES } from './config.js';
import { geometryAreaM2, sampleRing } from './geo.js';
import { storeGet, storePut } from './store.js';

import { getLang, _ } from './i18n.js';
import { MirrorPool, withFailover, httpError } from './failover.js';

export const overpassPool = new MirrorPool(CONFIG.overpass);
let netLogger = null;
/** Подписка на события сети (переключение зеркал) — для журнала расчёта. */
export const setNetLogger = fn => { netLogger = fn; };

export async function runOverpass(query, { signal, rounds = CONFIG.retryRounds, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  return withFailover(overpassPool, async (url, sig) => {
    const res = await doFetch(url, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: sig,
    });
    if (!res.ok) throw httpError(res);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(_('ответ не JSON (сервер перегружен?)')); }
    if (json.remark && /runtime error|timed out|out of memory|too many requests/i.test(json.remark)) throw new Error(json.remark);
    if (!Array.isArray(json.elements)) throw new Error(_('в ответе нет elements'));
    return json;
  }, { signal, rounds, timeoutMs: CONFIG.requestTimeoutMs, onEvent: m => netLogger?.(m) });
}

/** Проверка зеркал: маленький запрос на каждое, время ответа или причина сбоя. */
export async function pingMirrors({ fetchImpl, timeoutMs = 15000 } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const q = '[out:json][timeout:10];node(51.5336,46.0343,51.5337,46.0344);out;';
  return Promise.all(CONFIG.overpass.map(async url => {
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      if (!res.ok) return { url, ok: false, ms: Math.round(performance.now() - t0), why: 'HTTP ' + res.status };
      const json = await res.json();
      return { url, ok: Array.isArray(json.elements), ms: Math.round(performance.now() - t0), why: json.remark || '' };
    } catch (e) {
      return { url, ok: false, ms: Math.round(performance.now() - t0), why: e.name === 'AbortError' ? _('таймаут {s} с', { s: Math.round(timeoutMs / 1000) }) : (e.message || String(e)) };
    } finally { clearTimeout(timer); }
  }));
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
export const clearMemoryCache = () => cache.clear();
const CACHE_VER = 'v1';

function cached(kind, tile, loader) {
  const key = `${CACHE_VER}:${kind}:${tile.ty}:${tile.tx}`;
  if (!cache.has(key)) {
    // сначала постоянный кэш (IndexedDB), затем сеть
    const p = (async () => {
      const hit = await storeGet(key);
      if (hit !== undefined) return hit;
      const val = await loader();
      storePut(key, val);
      return val;
    })().catch(err => { cache.delete(key); throw err; });
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

const WAY_TAGS = ['highway', 'service', 'sidewalk', 'sidewalk:both', 'sidewalk:left', 'sidewalk:right', 'surface', 'smoothness', 'incline', 'lanes'];
const pick = (tags = {}, keys) => { const o = {}; for (const k of keys) if (tags[k] != null) o[k] = tags[k]; return o; };

export async function loadNetwork(bbox, opts) {
  const parts = await loadKind('net', bbox, async (tile, signal) => {
    const json = await runOverpass(NETWORK_QUERY(bboxStr(tile.bbox)), { signal });
    return json.elements
      .filter(el => el.type === 'way' && el.geometry)
      .map(el => ({ id: el.id, nodes: el.nodes, geometry: el.geometry, tags: pick(el.tags, WAY_TAGS) }));
  }, opts);
  const seen = new Map();
  for (const part of parts) for (const w of part) if (!seen.has(w.id)) seen.set(w.id, w);
  return [...seen.values()];
}

// ── теги узлов: светофоры, переходы, калитки ────────────────────────────────

const NODE_QUERY = bb => `[out:json][timeout:90];
(
  node["highway"~"^(crossing|traffic_signals)$"](${bb});
  node["crossing"](${bb});
  node["barrier"~"^(gate|lift_gate|swing_gate|turnstile|stile|kissing_gate|toll_booth|chain|cycle_barrier)$"](${bb});
);
out tags;`;
const NODE_TAGS = ['highway', 'crossing', 'crossing:signals', 'crossing:markings', 'crossing_ref', 'barrier', 'access', 'foot'];

/** @returns Map(osmNodeId → теги) */
export async function loadNodeTags(bbox, opts) {
  const parts = await loadKind('nodes', bbox, async (tile, signal) => {
    const json = await runOverpass(NODE_QUERY(bboxStr(tile.bbox)), { signal });
    return json.elements.filter(el => el.type === 'node').map(el => [el.id, pick(el.tags, NODE_TAGS)]);
  }, opts);
  return new Map(parts.flat());
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
    .map(f => ({ id: f.properties.id, name: f.properties[`name:${getLang()}`] || f.properties.name || `${_('Район')} ${f.properties.id}`, geometry: f.geometry }));
}

// ── поиск места ─────────────────────────────────────────────────────────────

const geocodePool = new MirrorPool(CONFIG.geocoders.map(x => x.url));

function parseNominatim(arr) {
  return arr.map(r => ({
    name: r.display_name, lat: Number(r.lat), lon: Number(r.lon),
    bbox: [Number(r.boundingbox[2]), Number(r.boundingbox[0]), Number(r.boundingbox[3]), Number(r.boundingbox[1])],
  }));
}
export function parsePhoton(json) {
  return (json.features || []).filter(f => f.geometry?.coordinates).map(f => {
    const p = f.properties || {}, [lon, lat] = f.geometry.coordinates;
    const name = [p.name, p.street && [p.street, p.housenumber].filter(Boolean).join(' '), p.district, p.city || p.town || p.village, p.state, p.country].filter(Boolean).join(', ');
    const ex = p.extent; // [minLon, maxLat, maxLon, minLat]
    const d = 0.004;
    return { name: name || _('Без названия'), lat, lon, bbox: ex ? [ex[0], ex[3], ex[2], ex[1]] : [lon - d, lat - d, lon + d, lat + d] };
  });
}

/** Поиск места: Nominatim, при сбое — Photon (перебор всех геокодеров с повторами). */
export async function geocode(q, { signal, lang = 'ru', fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const types = Object.fromEntries(CONFIG.geocoders.map(x => [x.url, x.type]));
  return withFailover(geocodePool, async (url, sig) => {
    const full = types[url] === 'photon'
      ? `${url}?limit=6&lang=${lang === 'ru' ? 'default' : lang}&q=${encodeURIComponent(q)}`
      : `${url}?format=jsonv2&limit=6&accept-language=${lang}&q=${encodeURIComponent(q)}`;
    const res = await doFetch(full, { signal: sig });
    if (!res.ok) throw httpError(res);
    const json = await res.json();
    return types[url] === 'photon' ? parsePhoton(json) : parseNominatim(json);
  }, { signal, rounds: 2, timeoutMs: 20000, onEvent: m => netLogger?.(m) });
}
