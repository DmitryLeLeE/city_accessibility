// Аналитика доступности: время до ближайшего объекта, индекс, сетка проблемных зон,
// статистика по районам, отчёт по изохронам.

import { CONFIG, CATEGORIES } from './config.js';
import { dijkstra, endpointPenalty, tracePath } from './graph.js';
import { isochroneGeometry, gridToMultiPolygon } from './isochrone.js';
import { makeProjector, pointInGeometry, geometryBBox } from './geo.js';

export const CAT_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

/** Привязывает входы объектов к графу и готовит источники для Дейкстры. */
export function prepareCategories(g, pois, catIds, snapM = CONFIG.snap.poiM) {
  const prepared = {};
  for (const id of catIds) prepared[id] = { items: [], sources: [] };
  for (const poi of pois) {
    const slot = prepared[poi.cat];
    if (!slot) continue;
    const ent = [];
    for (const [lon, lat] of poi.pts) {
      const s = g.snap(lat, lon, snapM);
      if (s) ent.push({ node: s.node, snapM: s.dist });
    }
    if (!ent.length) continue;
    slot.items.push({ poi, ent });
    for (const e of ent) slot.sources.push({ node: e.node, snapM: e.snapM });
  }
  return prepared;
}

/**
 * Время «от точки до сети» (по дворам, медленнее) плюс ожидаемая потеря, если точка
 * привязана к крупной дороге и может оказаться на её другой стороне. Секунды.
 */
const endSec = (g, node, snapM, speedMps) => (snapM * CONFIG.snap.offNetworkFactor) / speedMps + endpointPenalty(g, node);
const toSources = (g, slot, speedMps) => (slot?.sources || []).map(s => ({ node: s.node, cost0: endSec(g, s.node, s.snapM, speedMps) }));

const poiSeconds = (g, item, dist, speedMps) => {
  let best = Infinity;
  for (const e of item.ent) { const c = dist[e.node] + endSec(g, e.node, e.snapM, speedMps); if (c < best) best = c; }
  return best;
};

// ── отчёт по изохронам из точки ─────────────────────────────────────────────

export function isochroneReport(g, origin, prepared, { bands, speedMps }) {
  const snap = g.snap(origin.lat, origin.lon, CONFIG.snap.originM);
  if (!snap) return null;
  const maxMin = Math.max(...bands);
  const maxSec = maxMin * 60;
  const dist = dijkstra(g, [{ node: snap.node, cost0: endSec(g, snap.node, snap.dist, speedMps) }], maxSec, speedMps, true);

  const isochrones = [...bands].sort((a, b) => a - b).map(min => {
    const r = isochroneGeometry(g, dist, min * 60);
    return { min, geometry: r.geometry, areaKm2: r.areaM2 / 1e6 };
  });

  const cats = {};
  for (const [id, slot] of Object.entries(prepared)) {
    const reached = [];
    for (const item of slot.items) {
      const c = poiSeconds(g, item, dist, speedMps);
      if (c <= maxSec) reached.push({ poi: item.poi, minutes: c / 60, ent: item.ent });
    }
    reached.sort((a, b) => a.minutes - b.minutes);
    const counts = {};
    for (const b of bands) counts[b] = reached.filter(r => r.minutes <= b).length;
    cats[id] = { reached, counts, nearest: reached[0]?.minutes ?? null };
  }
  return { origin, snapM: snap.dist, snapNode: snap.node, dist, isochrones, cats, networkNodes: g.validCount };
}

// ── индекс и статистика ─────────────────────────────────────────────────────

export function scoreOf(minutes, { bestMin, worstMin } = CONFIG.index) {
  if (!(minutes < Infinity)) return 0;
  if (minutes <= bestMin) return 100;
  if (minutes >= worstMin) return 0;
  return (100 * (worstMin - minutes)) / (worstMin - bestMin);
}

/** Точки спроса: здания (вес = этажность) или узлы пешеходной сети (вес = длина). */
export function buildDemand(g, { buildings, mode, bbox }) {
  const [w, s, e, n] = bbox;
  const lat = [], lon = [], wt = [], node = [], snapM = [];
  if (mode === 'buildings' && buildings?.length) {
    let skipped = 0;
    for (const b of buildings) {
      if (b.lon < w || b.lon > e || b.lat < s || b.lat > n) continue;
      const sn = g.snap(b.lat, b.lon, CONFIG.snap.buildingM);
      if (!sn) { skipped++; continue; }
      lat.push(b.lat); lon.push(b.lon); wt.push(b.w); node.push(sn.node); snapM.push(sn.dist);
    }
    return { n: lat.length, lat, lon, w: wt, node, snapM, skipped, source: 'buildings' };
  }
  for (let i = 0; i < g.n; i++) {
    if (!g.valid[i]) continue;
    if (g.lon[i] < w || g.lon[i] > e || g.lat[i] < s || g.lat[i] > n) continue;
    let len = 0;
    for (let k = g.adjStart[i]; k < g.adjStart[i + 1]; k++) len += g.adjCost[k];
    lat.push(g.lat[i]); lon.push(g.lon[i]); wt.push(len / 2); node.push(i); snapM.push(0);
  }
  return { n: lat.length, lat, lon, w: wt, node, snapM, skipped: 0, source: 'network' };
}

function weightedMedian(times, weights) {
  const idx = times.map((_, i) => i).sort((a, b) => times[a] - times[b]);
  const total = weights.reduce((s, x) => s + x, 0);
  let acc = 0;
  for (const i of idx) { acc += weights[i]; if (acc >= total / 2) return times[i]; }
  return Infinity;
}

class Acc {
  constructor(catIds) {
    this.w = 0; this.score = 0;
    this.t = Object.fromEntries(catIds.map(c => [c, []]));
    this.wt = [];
    this.catScore = Object.fromEntries(catIds.map(c => [c, 0]));
  }
  add(w, composite, times, scores, catIds) {
    this.w += w; this.score += composite * w; this.wt.push(w);
    for (const c of catIds) { this.t[c].push(times[c]); this.catScore[c] += scores[c] * w; }
  }
  stats(catIds, bands) {
    const out = {};
    for (const c of catIds) {
      const ts = this.t[c], total = this.w;
      const shares = {};
      for (const b of bands) {
        let s = 0;
        for (let i = 0; i < ts.length; i++) if (ts[i] <= b) s += this.wt[i];
        shares[b] = total ? (100 * s) / total : 0;
      }
      out[c] = { median: total ? weightedMedian(ts, this.wt) : Infinity, shares, score: total ? this.catScore[c] / total : 0 };
    }
    return out;
  }
}

export function computeAnalysis({ g, prepared, demand, groups, catIds, bands, speedMps, bbox }) {
  const maxSec = CONFIG.fieldMaxMin * 60;
  const fields = {};
  for (const c of catIds) fields[c] = dijkstra(g, toSources(g, prepared[c], speedMps), maxSec, speedMps);

  const [w, s, e, n] = bbox;
  const proj = makeProjector((s + n) / 2, (w + e) / 2);
  const cellM = CONFIG.gridCellM;

  const groupBoxes = groups.map(gr => ({ gr, box: gr.bbox || geometryBBox(gr.geometry) }));
  const accs = groups.map(() => new Acc(catIds));
  const overall = new Acc(catIds);
  const cells = new Map();

  const times = {}, scores = {};
  for (let i = 0; i < demand.n; i++) {
    let sum = 0;
    for (const c of catIds) {
      const sec = fields[c][demand.node[i]] + endSec(g, demand.node[i], demand.snapM[i], speedMps);
      const t = sec <= maxSec ? sec / 60 : Infinity;
      times[c] = t; scores[c] = scoreOf(t); sum += scores[c];
    }
    const composite = catIds.length ? sum / catIds.length : 0;
    const wi = demand.w[i];
    overall.add(wi, composite, times, scores, catIds);

    for (let k = 0; k < groupBoxes.length; k++) {
      const { gr, box } = groupBoxes[k];
      const lo = demand.lon[i], la = demand.lat[i];
      if (lo < box[0] || lo > box[2] || la < box[1] || la > box[3]) continue;
      if (gr.isRect || pointInGeometry(lo, la, gr.geometry)) { accs[k].add(wi, composite, times, scores, catIds); break; }
    }

    const [x, y] = proj.toXY(demand.lat[i], demand.lon[i]);
    const cx = Math.floor(x / cellM), cy = Math.floor(y / cellM);
    const key = cx + ',' + cy;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { cx, cy, acc: new Acc(catIds) }));
    cell.acc.add(wi, composite, times, scores, catIds);
  }

  const districts = groups.map((gr, k) => {
    const a = accs[k];
    return {
      id: gr.id, name: gr.name, geometry: gr.geometry, coverage: gr.coverage ?? 1,
      weight: a.w, index: a.w ? a.score / a.w : null, stats: a.stats(catIds, bands),
    };
  });

  const cellList = [...cells.values()].map(c => {
    const a = c.acc;
    const x0 = c.cx * cellM, y0 = c.cy * cellM;
    const corners = [[x0, y0], [x0 + cellM, y0], [x0 + cellM, y0 + cellM], [x0, y0 + cellM], [x0, y0]]
      .map(([x, y]) => { const [la, lo] = proj.toLL(x, y); return [lo, la]; });
    let worst = null, worstScore = Infinity;
    for (const cid of catIds) {
      const sc = a.catScore[cid] / a.w;
      if (sc < worstScore) { worstScore = sc; worst = cid; }
    }
    return { cx: c.cx, cy: c.cy, ring: corners, weight: a.w, index: a.score / a.w, worst };
  });

  return {
    catIds, bands, overall: { weight: overall.w, index: overall.w ? overall.score / overall.w : null, stats: overall.stats(catIds, bands) },
    districts, cells: cellList, zones: findProblemZones(cellList, proj, cellM),
    demand: { n: demand.n, source: demand.source, skipped: demand.skipped },
  };
}

/** Связные группы «плохих» ячеек (8-соседство) → проблемные зоны. */
export function findProblemZones(cells, proj, cellM, below = CONFIG.index.problemBelow) {
  const ws = cells.map(c => c.weight).filter(x => x > 0).sort((a, b) => a - b);
  const minW = ws.length ? ws[Math.floor(ws.length / 2)] * 0.5 : 0;
  const bad = new Map();
  for (const c of cells) if (c.index < below && c.weight >= minW) bad.set(c.cx + ',' + c.cy, c);
  const seen = new Set(), zones = [];
  for (const [k, start] of bad) {
    if (seen.has(k)) continue;
    const members = [], queue = [start];
    seen.add(k);
    while (queue.length) {
      const c = queue.pop();
      members.push(c);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const nk = (c.cx + dx) + ',' + (c.cy + dy);
        if (!seen.has(nk) && bad.has(nk)) { seen.add(nk); queue.push(bad.get(nk)); }
      }
    }
    let w = 0, sx = 0, sy = 0, sc = 0;
    const worstTally = {};
    for (const c of members) {
      w += c.weight; sx += (c.cx + 0.5) * c.weight; sy += (c.cy + 0.5) * c.weight; sc += c.index * c.weight;
      worstTally[c.worst] = (worstTally[c.worst] || 0) + c.weight;
    }
    const worst = Object.entries(worstTally).sort((a, b) => b[1] - a[1])[0][0];
    const [lat, lon] = proj.toLL((sx / w) * cellM, (sy / w) * cellM);
    zones.push({ outline: zoneOutline(members, proj, cellM), cells: members, weight: w, index: sc / w, worst, areaKm2: (members.length * cellM * cellM) / 1e6, center: [lat, lon] });
  }
  zones.sort((a, b) => b.weight - a.weight);
  zones.forEach((z, i) => { z.id = i + 1; });
  return zones;
}

function zoneOutline(members, proj, cellM) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of members) { x0 = Math.min(x0, c.cx); x1 = Math.max(x1, c.cx); y0 = Math.min(y0, c.cy); y1 = Math.max(y1, c.cy); }
  const W = x1 - x0 + 3, H = y1 - y0 + 3;
  const filled = new Uint8Array(W * H);
  for (const c of members) filled[(c.cy - y0 + 1) * W + (c.cx - x0 + 1)] = 1;
  return gridToMultiPolygon(filled, W, H, (x0 - 1) * cellM, (y0 - 1) * cellM, cellM, proj).geometry;
}

// ── экспорт ─────────────────────────────────────────────────────────────────

const fmt = (x, d = 1) => (x === Infinity || x == null ? '' : x.toFixed(d));

export function districtsToCSV(result) {
  const head = ['Район', 'Вес (жители-прокси)', 'Индекс доступности'];
  for (const c of result.catIds) {
    head.push(`${CAT_BY_ID[c].label}: медиана, мин`);
    for (const b of result.bands) head.push(`${CAT_BY_ID[c].label}: ≤${b} мин, %`);
  }
  const rows = [head];
  for (const d of result.districts) {
    const row = [d.name, fmt(d.weight, 0), fmt(d.index, 1)];
    for (const c of result.catIds) {
      row.push(fmt(d.stats[c].median));
      for (const b of result.bands) row.push(fmt(d.stats[c].shares[b]));
    }
    rows.push(row);
  }
  const esc = v => (/[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  return '﻿' + rows.map(r => r.map(esc).join(';')).join('\n');
}

export function analysisToGeoJSON(result) {
  const features = [];
  for (const d of result.districts) {
    const props = { layer: 'district', name: d.name, index: d.index, weight: d.weight, coverage: d.coverage };
    for (const c of result.catIds) {
      props[`${c}_median_min`] = Number.isFinite(d.stats[c].median) ? d.stats[c].median : null;
      for (const b of result.bands) props[`${c}_share_${b}`] = d.stats[c].shares[b];
    }
    features.push({ type: 'Feature', properties: props, geometry: d.geometry });
  }
  for (const c of result.cells) {
    features.push({ type: 'Feature', properties: { layer: 'cell', index: c.index, weight: c.weight, worst: c.worst }, geometry: { type: 'Polygon', coordinates: [c.ring] } });
  }
  for (const z of result.zones) {
    features.push({ type: 'Feature', properties: { layer: 'problem_zone', id: z.id, index: z.index, weight: z.weight, area_km2: z.areaKm2, worst: z.worst }, geometry: z.outline });
  }
  return { type: 'FeatureCollection', features };
}

export function isochronesToGeoJSON(report) {
  return {
    type: 'FeatureCollection',
    features: report.isochrones.filter(i => i.geometry).map(i => ({
      type: 'Feature', properties: { minutes: i.min, area_km2: i.areaKm2 }, geometry: i.geometry,
    })),
  };
}

/** Районы-квадраты, если административных границ нет. */
export function makeGridGroups(bbox, cellM) {
  const [w, s, e, n] = bbox;
  const proj = makeProjector((s + n) / 2, (w + e) / 2);
  const [x0, y0] = proj.toXY(s, w), [x1, y1] = proj.toXY(n, e);
  const groups = [];
  let col = 0;
  for (let x = x0; x < x1 - cellM * 0.1; x += cellM, col++) {
    let row = 0;
    for (let y = y0; y < y1 - cellM * 0.1; y += cellM, row++) {
      const ring = [[x, y], [x + cellM, y], [x + cellM, y + cellM], [x, y + cellM], [x, y]]
        .map(([px, py]) => { const [la, lo] = proj.toLL(px, py); return [lo, la]; });
      const geometry = { type: 'Polygon', coordinates: [ring] };
      groups.push({ id: `g${col}_${row}`, name: `Квадрат ${col + 1}-${row + 1}`, geometry, isRect: true, bbox: geometryBBox(geometry), coverage: 1 });
    }
  }
  return groups;
}


/**
 * Маршрут от точки расчёта до объекта из отчёта изохрон: лучший вход, путь по графу,
 * разбивка времени на ходьбу, ожидание на переходах, подход к сети.
 */
export function routeToPoi(g, report, reached, speedMps) {
  let best = null;
  for (const e of reached.ent) {
    const tail = endSec(g, e.node, e.snapM, speedMps);
    const c = report.dist[e.node] + tail;
    if (!best || c < best.c) best = { c, e, tail };
  }
  if (!best || !(best.c < Infinity)) return null;
  const path = tracePath(g, report.dist, best.e.node, speedMps);
  if (!path) return null;
  return {
    totalSec: best.c,
    startSec: path.startSec, endSec: best.tail,
    walkSec: path.walkSec, waitSec: path.waitSec, lengthM: path.lengthM,
    events: path.events,
    coords: path.nodes.map(n => [g.lat[n], g.lon[n]]),
  };
}
