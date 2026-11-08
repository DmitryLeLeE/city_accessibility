// Пользовательские данные: GeoJSON с объектами и с населением. Чистые функции, без DOM.
import { sampleRing } from './geo.js';

const POP_KEYS = ['pop', 'population', 'people', 'weight', 'w', 'население', 'жителей'];
const STEP_M = 60;
const MAX_ENTRANCES = 40;

function features(gj) {
  if (!gj || typeof gj !== 'object') throw new Error('not GeoJSON');
  if (gj.type === 'FeatureCollection' && Array.isArray(gj.features)) return gj.features;
  if (gj.type === 'Feature') return [gj];
  if (gj.type && gj.coordinates) return [{ type: 'Feature', properties: {}, geometry: gj }];
  throw new Error('not GeoJSON');
}

const okLL = (lon, lat) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

function polygons(geom) {
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

/** Простая «центр масс» по вершинам внешнего кольца. */
export function ringCentroid(ring) {
  const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
}

export function popValue(props = {}) {
  for (const k of POP_KEYS) {
    const v = parseFloat(props[k]);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return 1;
}

/** Свои объекты → список POI категории custom. Точки — как есть, полигоны — входы по границе. */
export function parseCustomPois(gj) {
  const out = [];
  let skipped = 0;
  features(gj).forEach((f, i) => {
    const g = f?.geometry;
    if (!g) { skipped++; return; }
    const name = String(f.properties?.name ?? f.properties?.title ?? f.properties?.название ?? '');
    const id = `custom${i}`;
    if (g.type === 'Point' || g.type === 'MultiPoint') {
      const pts = (g.type === 'Point' ? [g.coordinates] : g.coordinates).filter(c => okLL(c[0], c[1]));
      pts.forEach((c, k) => out.push({ id: `${id}.${k}`, name, cat: 'custom', lat: c[1], lon: c[0], pts: [[c[0], c[1]]] }));
      if (!pts.length) skipped++;
    } else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      let pts = [];
      for (const rings of polygons(g)) pts = pts.concat(sampleRing(rings[0], STEP_M));
      pts = pts.filter(c => okLL(c[0], c[1]));
      if (!pts.length) { skipped++; return; }
      if (pts.length > MAX_ENTRANCES) { const k = pts.length / MAX_ENTRANCES; pts = Array.from({ length: MAX_ENTRANCES }, (_, j) => pts[Math.floor(j * k)]); }
      const [cx, cy] = ringCentroid(polygons(g)[0][0]);
      out.push({ id, name, cat: 'custom', lat: cy, lon: cx, pts });
    } else skipped++;
  });
  return { pois: out, skipped };
}

/** Население: точки с весом либо полигоны (вес целиком на центр полигона). */
export function parsePopulation(gj) {
  const pts = [];
  let skipped = 0, total = 0;
  for (const f of features(gj)) {
    const g = f?.geometry;
    if (!g) { skipped++; continue; }
    const w = popValue(f.properties);
    let c = null;
    if (g.type === 'Point') c = g.coordinates;
    else if (g.type === 'Polygon' || g.type === 'MultiPolygon') c = ringCentroid(polygons(g)[0][0]);
    if (!c || !okLL(c[0], c[1])) { skipped++; continue; }
    pts.push({ lat: c[1], lon: c[0], w });
    total += w;
  }
  return { pts, skipped, total };
}
