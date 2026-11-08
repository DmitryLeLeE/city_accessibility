// Пешеходный граф из ответа Overpass (out geom) + алгоритм Дейкстры.
// Стоимость рёбер хранится в «эффективных метрах» (длина × штраф за тип пути);
// время = стоимость / скорость.

import { haversine } from './geo.js';

export function buildGraph(ways, opts = {}) {
  const maxSeg = opts.maxSegmentM ?? 40;
  const stepsPen = opts.stepsPenalty ?? 1.5;
  const minComp = opts.minComponentNodes ?? 25;

  const idMap = new Map();
  const lat = [], lon = [];
  const eFrom = [], eTo = [], eCost = [];

  const nodeFor = (id, la, lo) => {
    let i = idMap.get(id);
    if (i === undefined) { i = lat.length; idMap.set(id, i); lat.push(la); lon.push(lo); }
    return i;
  };
  const addEdge = (a, b, c) => { eFrom.push(a); eTo.push(b); eCost.push(c); };

  for (const w of ways) {
    const geom = w.geometry, ids = w.nodes;
    if (!geom || !ids || geom.length < 2) continue;
    const pen = w.tags && w.tags.highway === 'steps' ? stepsPen : 1;
    for (let k = 0; k < geom.length - 1; k++) {
      const p = geom[k], q = geom[k + 1];
      if (!p || !q) continue;
      const a = nodeFor(ids[k], p.lat, p.lon);
      const b = nodeFor(ids[k + 1], q.lat, q.lon);
      if (a === b) continue;
      const d = haversine(p.lat, p.lon, q.lat, q.lon);
      const parts = Math.max(1, Math.ceil(d / maxSeg));
      let prev = a;
      for (let s = 1; s < parts; s++) {
        const t = s / parts;
        const mid = lat.length;
        lat.push(p.lat + (q.lat - p.lat) * t);
        lon.push(p.lon + (q.lon - p.lon) * t);
        addEdge(prev, mid, (d / parts) * pen);
        prev = mid;
      }
      addEdge(prev, b, (d / parts) * pen);
    }
  }

  const n = lat.length;
  const m = eFrom.length;

  // CSR (неориентированный граф)
  const deg = new Int32Array(n + 1);
  for (let i = 0; i < m; i++) { deg[eFrom[i] + 1]++; deg[eTo[i] + 1]++; }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const adjStart = deg;
  const fill = new Int32Array(n);
  const adjTo = new Int32Array(2 * m);
  const adjCost = new Float32Array(2 * m);
  for (let i = 0; i < m; i++) {
    const a = eFrom[i], b = eTo[i], c = eCost[i];
    let p = adjStart[a] + fill[a]++; adjTo[p] = b; adjCost[p] = c;
    p = adjStart[b] + fill[b]++; adjTo[p] = a; adjCost[p] = c;
  }

  // Компоненты связности
  const comp = new Int32Array(n).fill(-1);
  const compSize = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    const id = compSize.length;
    let top = 0, size = 0;
    stack[top++] = s; comp[s] = id;
    while (top) {
      const v = stack[--top]; size++;
      for (let e = adjStart[v]; e < adjStart[v + 1]; e++) {
        const u = adjTo[e];
        if (comp[u] === -1) { comp[u] = id; stack[top++] = u; }
      }
    }
    compSize.push(size);
  }
  const valid = new Uint8Array(n);
  let validCount = 0;
  for (let i = 0; i < n; i++) if (compSize[comp[i]] >= minComp) { valid[i] = 1; validCount++; }

  let totalCost = 0;
  for (let i = 0; i < m; i++) totalCost += eCost[i];

  const g = {
    n, edges: m, validCount,
    lat: Float64Array.from(lat), lon: Float64Array.from(lon),
    adjStart, adjTo, adjCost, valid,
    lengthKm: totalCost / 1000,
  };
  g.index = buildSpatialIndex(g);
  g.snap = (la, lo, maxM) => snapToGraph(g, la, lo, maxM);
  return g;
}

// ── пространственный индекс для привязки точек к узлам ──────────────────────

const CELL_DEG = 0.001; // ≈111 м по широте

function buildSpatialIndex(g) {
  let latMin = Infinity, lonMin = Infinity, latMax = -Infinity;
  for (let i = 0; i < g.n; i++) {
    if (!g.valid[i]) continue;
    if (g.lat[i] < latMin) latMin = g.lat[i];
    if (g.lat[i] > latMax) latMax = g.lat[i];
    if (g.lon[i] < lonMin) lonMin = g.lon[i];
  }
  const cosLat = Math.cos((((latMin + latMax) / 2) || 0) * Math.PI / 180) || 1;
  const dLon = CELL_DEG / cosLat;
  const cells = new Map();
  const key = (iy, ix) => iy * 1048576 + ix;
  for (let i = 0; i < g.n; i++) {
    if (!g.valid[i]) continue;
    const iy = Math.floor((g.lat[i] - latMin) / CELL_DEG);
    const ix = Math.floor((g.lon[i] - lonMin) / dLon);
    const k = key(iy, ix);
    let arr = cells.get(k);
    if (!arr) cells.set(k, (arr = []));
    arr.push(i);
  }
  return { cells, latMin, lonMin, dLon, cosLat, key, empty: cells.size === 0 };
}

function snapToGraph(g, la, lo, maxM) {
  const ix0 = g.index;
  if (ix0.empty) return null;
  const cy = Math.floor((la - ix0.latMin) / CELL_DEG);
  const cx = Math.floor((lo - ix0.lonMin) / ix0.dLon);
  const maxR = Math.ceil(maxM / 111195 / CELL_DEG) + 1;
  const kLat = 111195, kLon = 111195 * Math.cos(la * Math.PI / 180);
  let best = -1, bestD = Infinity;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const arr = ix0.cells.get(ix0.key(cy + dy, cx + dx));
        if (!arr) continue;
        for (const i of arr) {
          const d = Math.hypot((g.lat[i] - la) * kLat, (g.lon[i] - lo) * kLon);
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    if (best >= 0 && bestD <= r * CELL_DEG * 111195) break;
  }
  return best >= 0 && bestD <= maxM ? { node: best, dist: bestD } : null;
}

// ── Дейкстра с несколькими источниками ──────────────────────────────────────

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lastK = k.pop(), lastV = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lastK; v[i] = lastV;
    }
    this.popped = topK;
    return topV;
  }
}

/**
 * @param sources [{node, cost0}] — начальные узлы и стартовая стоимость
 * @param maxCost предел стоимости (эффективные метры)
 * @returns Float64Array стоимостей (Infinity — недостижимо)
 */
export function dijkstra(g, sources, maxCost = Infinity) {
  const dist = new Float64Array(g.n).fill(Infinity);
  const heap = new MinHeap();
  for (const s of sources) {
    if (s.cost0 <= maxCost && s.cost0 < dist[s.node]) { dist[s.node] = s.cost0; heap.push(s.cost0, s.node); }
  }
  const { adjStart, adjTo, adjCost } = g;
  while (heap.size) {
    const v = heap.pop();
    const d = heap.popped;
    if (d > dist[v]) continue;
    for (let e = adjStart[v]; e < adjStart[v + 1]; e++) {
      const nd = d + adjCost[e];
      if (nd <= maxCost && nd < dist[adjTo[e]]) { dist[adjTo[e]] = nd; heap.push(nd, adjTo[e]); }
    }
  }
  return dist;
}
