// Построение контура изохроны: достижимые узлы → растр → границы → сглаживание.
// Не требует внешних библиотек.

import { makeProjector, pointInRing, ringAreaSigned } from './geo.js';

/**
 * @param dist   результат dijkstra (эффективные метры)
 * @param maxCost порог стоимости для этой изохроны
 * @returns {geometry: MultiPolygon|null, areaM2, nodes}
 */
export function isochroneGeometry(g, dist, maxCost, opts = {}) {
  const cell = opts.cellM ?? 40;
  const dil = opts.dilate ?? 1;
  const minHole = opts.minHoleM2 ?? 40000;

  let count = 0, la0 = 0, lo0 = 0;
  for (let i = 0; i < g.n; i++) {
    if (dist[i] <= maxCost) { if (!count) { la0 = g.lat[i]; lo0 = g.lon[i]; } count++; }
  }
  if (!count) return { geometry: null, areaM2: 0, nodes: 0 };

  const proj = makeProjector(la0, lo0);
  const xs = new Float64Array(count), ys = new Float64Array(count);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, c = 0;
  for (let i = 0; i < g.n; i++) {
    if (dist[i] > maxCost) continue;
    const [x, y] = proj.toXY(g.lat[i], g.lon[i]);
    xs[c] = x; ys[c] = y; c++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }

  const pad = dil + 2;
  const ox = minX - pad * cell, oy = minY - pad * cell;
  const W = Math.ceil((maxX - minX) / cell) + 2 * pad + 1;
  const H = Math.ceil((maxY - minY) / cell) + 2 * pad + 1;
  const raw = new Uint8Array(W * H);
  for (let i = 0; i < count; i++) {
    raw[Math.floor((ys[i] - oy) / cell) * W + Math.floor((xs[i] - ox) / cell)] = 1;
  }
  const filled = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!raw[y * W + x]) continue;
    for (let dy = -dil; dy <= dil; dy++) for (let dx = -dil; dx <= dil; dx++) {
      filled[(y + dy) * W + (x + dx)] = 1;
    }
  }

  const r = gridToMultiPolygon(filled, W, H, ox, oy, cell, proj, { minHole, smooth: 2 });
  return { geometry: r.geometry, areaM2: r.areaM2, nodes: count };
}

/**
 * Заполненные клетки сетки → MultiPolygon (lon/lat).
 * Клетка (x, y) занимает [ox + x·cell, ox + (x+1)·cell] × [oy + y·cell, …].
 */
export function gridToMultiPolygon(filled, W, H, ox, oy, cell, proj, { minHole = 0, smooth = 0 } = {}) {
  const rings = traceBoundaries(filled, W, H);
  const outers = [], holes = [];
  for (const ring of rings) {
    let pts = ring.map(([vx, vy]) => [ox + vx * cell, oy + vy * cell]);
    for (let i = 0; i < smooth; i++) pts = chaikin(pts);
    const a = ringAreaSigned(pts);
    if (a > 0) outers.push({ pts, a });
    else if (-a >= minHole) holes.push({ pts, a: -a });
  }
  if (!outers.length) return { geometry: null, areaM2: 0 };

  const polys = outers.map(o => ({ outer: o, holes: [] }));
  let area = outers.reduce((s, o) => s + o.a, 0);
  for (const h of holes) {
    let host = null;
    for (const p of polys) {
      if (pointInRing(h.pts[0][0], h.pts[0][1], p.outer.pts) && (!host || p.outer.a < host.outer.a)) host = p;
    }
    if (host) { host.holes.push(h); area -= h.a; }
  }
  const toLL = pts => {
    const ring = pts.map(([x, y]) => { const [la, lo] = proj.toLL(x, y); return [lo, la]; });
    ring.push(ring[0]);
    return ring;
  };
  const coordinates = polys.map(p => [toLL(p.outer.pts), ...p.holes.map(h => toLL(h.pts))]);
  return { geometry: { type: 'MultiPolygon', coordinates }, areaM2: area };
}

/** Границы заполненных клеток: внутренность слева от направления (внешние — против часовой). */
function traceBoundaries(filled, W, H) {
  const V = W + 1;
  const ex0 = [], ey0 = [], ex1 = [], ey1 = [];
  const out = new Map();
  const add = (x0, y0, x1, y1) => {
    const i = ex0.length;
    ex0.push(x0); ey0.push(y0); ex1.push(x1); ey1.push(y1);
    const k = y0 * V + x0;
    const arr = out.get(k);
    if (arr) arr.push(i); else out.set(k, [i]);
  };
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : filled[y * W + x]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!filled[y * W + x]) continue;
    if (!at(x, y - 1)) add(x, y, x + 1, y);
    if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!at(x - 1, y)) add(x, y + 1, x, y);
  }
  const used = new Uint8Array(ex0.length);
  const rings = [];
  for (let s = 0; s < ex0.length; s++) {
    if (used[s]) continue;
    const startKey = ey0[s] * V + ex0[s];
    const ring = [[ex0[s], ey0[s]]];
    let cur = s;
    for (;;) {
      used[cur] = 1;
      const vx = ex1[cur], vy = ey1[cur];
      if (vy * V + vx === startKey) break;
      ring.push([vx, vy]);
      const dx = vx - ex0[cur], dy = vy - ey0[cur];
      const cands = (out.get(vy * V + vx) || []).filter(i => !used[i]);
      if (!cands.length) break;
      // предпочитаем левый поворот, затем прямо, затем правый
      const pref = [[-dy, dx], [dx, dy], [dy, -dx]];
      let next = -1;
      for (const [pdx, pdy] of pref) {
        next = cands.find(i => ex1[i] - ex0[i] === pdx && ey1[i] - ey0[i] === pdy);
        if (next !== undefined && next !== -1) break;
        next = -1;
      }
      if (next === -1) break;
      cur = next;
    }
    rings.push(dropCollinear(ring));
  }
  return rings.filter(r => r.length >= 4);
}

function dropCollinear(ring) {
  const n = ring.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n], q = ring[i], r = ring[(i + 1) % n];
    const cross = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
    if (cross !== 0) out.push(q);
  }
  return out;
}

function chaikin(pts) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]]);
    out.push([0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
  }
  return out;
}
