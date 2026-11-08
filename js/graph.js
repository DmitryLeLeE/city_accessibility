// Пешеходный граф из ответа Overpass (out geom) + алгоритм Дейкстры.
//
// Стоимость ребра — «эффективные метры» (длина × множитель типа пути/покрытия/уклона);
// время ребра = стоимость / скорость.
//
// Перекрёстки. Дорога в графе — осевая линия, но ходят по тротуару, поэтому состояние
// пешехода — (дуга, сторона дороги: справа/слева по ходу). Каждый узел с ветвлением
// моделируется «кольцом» концов тротуаров: у каждой ветки есть левый и правый конец,
// соседние ветки соединены углом (бесплатно), а чтобы попасть с одного конца ветки на
// другой, нужно перейти эту дорогу (ожидание зависит от класса дороги и светофора).
// Так «сами собой» получаются правила: прямо = перейти боковую улицу на своей стороне,
// на Т-образном перекрёстке с противоположной стороны переходить не нужно, поворот
// «налево» требует перехода, крупная дорога без переходов — барьер.

import { haversine } from './geo.js';
import { WALK } from './config.js';
import { wayModel, nodeFlags, crossWait, F_GATE, F_BLOCKED, F_SIGNAL, F_ZEBRA, F_MARKED } from './walkmodel.js';

export function buildGraph(ways, opts = {}) {
  const maxSeg = opts.maxSegmentM ?? 40;
  const minComp = opts.minComponentNodes ?? 25;
  const nodeTags = opts.nodeTags; // Map(osmNodeId → теги) или undefined

  const idMap = new Map();
  const lat = [], lon = [];
  const eFrom = [], eTo = [], eCost = [], eCls = [], eLanes = [];

  const nodeFor = (id, la, lo) => {
    let i = idMap.get(id);
    if (i === undefined) { i = lat.length; idMap.set(id, i); lat.push(la); lon.push(lo); }
    return i;
  };
  const addEdge = (a, b, c, cls, lanes) => { eFrom.push(a); eTo.push(b); eCost.push(c); eCls.push(cls); eLanes.push(lanes); };

  for (const w of ways) {
    const geom = w.geometry, ids = w.nodes;
    if (!geom || !ids || geom.length < 2) continue;
    const { rank, lanes, factor: pen } = wayModel(w.tags);
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
        addEdge(prev, mid, (d / parts) * pen, rank, lanes);
        prev = mid;
      }
      addEdge(prev, b, (d / parts) * pen, rank, lanes);
    }
  }

  const n = lat.length;
  const m = eFrom.length;

  // CSR (неориентированный граф): каждая дуга хранит класс дороги, полосы и азимут
  const deg = new Int32Array(n + 1);
  for (let i = 0; i < m; i++) { deg[eFrom[i] + 1]++; deg[eTo[i] + 1]++; }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const adjStart = deg;
  const fill = new Int32Array(n);
  const A = 2 * m;
  const adjTo = new Int32Array(A);
  const adjCost = new Float32Array(A);
  const arcFrom = new Int32Array(A);
  const arcRev = new Int32Array(A);
  const arcCls = new Uint8Array(A);
  const arcLanes = new Uint8Array(A);
  const arcBearing = new Float32Array(A);
  const bearing = (a, b) => ((Math.atan2((lon[b] - lon[a]) * Math.cos(lat[a] * Math.PI / 180), lat[b] - lat[a]) * 180 / Math.PI) + 360) % 360;
  for (let i = 0; i < m; i++) {
    const a = eFrom[i], b = eTo[i], c = eCost[i];
    const p = adjStart[a] + fill[a]++;
    const q = adjStart[b] + fill[b]++;
    adjTo[p] = b; adjCost[p] = c; arcFrom[p] = a; arcCls[p] = eCls[i]; arcLanes[p] = eLanes[i]; arcBearing[p] = bearing(a, b); arcRev[p] = q;
    adjTo[q] = a; adjCost[q] = c; arcFrom[q] = b; arcCls[q] = eCls[i]; arcLanes[q] = eLanes[i]; arcBearing[q] = bearing(b, a); arcRev[q] = p;
  }

  // Флаги узлов (светофоры, переходы, калитки)
  const flags = new Uint8Array(n);
  if (nodeTags) {
    for (const [id, tags] of nodeTags) {
      const i = idMap.get(id);
      if (i !== undefined) flags[i] = nodeFlags(tags);
    }
  }

  // «Кольца» перекрёстков: для узлов с ветвлением, тупиков и узлов с флагами
  const special = new Uint8Array(n);
  const jStart = new Int32Array(n);
  const legIdx = new Uint8Array(A);   // порядковый номер ветки (по часовой) в узле
  const nodeRank = new Uint8Array(n); // максимальный класс дороги в узле
  let jSize = 0;
  for (let v = 0; v < n; v++) {
    const k = adjStart[v + 1] - adjStart[v];
    for (let e = adjStart[v]; e < adjStart[v + 1]; e++) if (arcCls[e] > nodeRank[v]) nodeRank[v] = arcCls[e];
    if (k !== 2 || flags[v]) { special[v] = 1; jStart[v] = jSize; jSize += (2 * k) * (2 * k); }
  }
  const jMat = new Float32Array(jSize);
  for (let v = 0; v < n; v++) {
    if (!special[v]) continue;
    const lo = adjStart[v], k = adjStart[v + 1] - lo, dim = 2 * k;
    const order = Array.from({ length: k }, (_, i) => lo + i).sort((x, y) => arcBearing[x] - arcBearing[y]);
    order.forEach((e, idx) => { legIdx[e] = idx; });
    const M = new Float64Array(dim * dim).fill(Infinity);
    const L = i => 2 * i, R = i => 2 * i + 1;
    for (let i = 0; i < dim; i++) M[i * dim + i] = 0;
    const link = (x, y, c) => { if (c < M[x * dim + y]) { M[x * dim + y] = c; M[y * dim + x] = c; } };
    for (let i = 0; i < k; i++) {
      link(R(i), L((i + 1) % k), 0); // угол между соседними ветками
      const e = order[i];
      link(L(i), R(i), arcCls[e] ? crossWait(flags[v], arcCls[e], arcLanes[e]) : 0); // переход через ветку
    }
    for (let q = 0; q < dim; q++) for (let x = 0; x < dim; x++) {
      const mx = M[x * dim + q];
      if (mx === Infinity) continue;
      for (let y = 0; y < dim; y++) { const c = mx + M[q * dim + y]; if (c < M[x * dim + y]) M[x * dim + y] = c; }
    }
    jMat.set(M, jStart[v]);
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
    adjStart, adjTo, adjCost, arcFrom, arcRev, arcCls, arcLanes, arcBearing, nodeFlags: flags, nodeRank, special, jStart, jMat, legIdx, valid,
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

/** Ожидаемая «потеря» на конечной точке, привязанной к крупной дороге: объект может оказаться на другой стороне. */
export function endpointPenalty(g, node) {
  const r = g.nodeRank[node];
  return r >= 3 ? 0.25 * WALK.unmarkedWait[r] : 0;
}

/**
 * Дейкстра по состояниям (дуга, сторона дороги). Учитывает ожидание на переходах.
 * @param sources [{node, cost0}] — начальные узлы; cost0 в секундах
 * @param maxSec  предел времени, с
 * @param speedMps скорость пешехода, м/с
 * @returns Float64Array времени прибытия в узел, с (Infinity — недостижим)
 */
export function dijkstra(g, sources, maxSec = Infinity, speedMps = 4.8 / 3.6, track = false) {
  const { n, adjStart, adjTo, adjCost, arcRev, arcCls, special, jStart, jMat, legIdx, nodeFlags: flags } = g;
  const inv = 1 / speedMps;
  const midBlock = WALK.unmarkedWait;
  const dist = new Float64Array(adjTo.length * 2).fill(Infinity); // состояние = дуга*2 + сторона (0 — справа по ходу)
  const nodeDist = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap();
  // режим track: для восстановления маршрута храним предшественника, ожидание и тип перехода
  const pred = track ? new Int32Array(adjTo.length * 2).fill(-1) : null;
  const waitAt = track ? new Float32Array(adjTo.length * 2) : null;
  const kindAt = track ? new Uint8Array(adjTo.length * 2) : null; // 0 — просто шаг, 1 — узел/перекрёсток, 2 — переход посреди квартала
  const srcOf = track ? new Int32Array(adjTo.length * 2).fill(-1) : null;
  const relax = (st, nd, from = -1, w = 0, k = 0, si = -1) => {
    if (nd <= maxSec && nd < dist[st]) {
      dist[st] = nd; heap.push(nd, st);
      if (track) { pred[st] = from; waitAt[st] = w; kindAt[st] = k; srcOf[st] = si; }
    }
  };

  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    if (s.cost0 > maxSec) continue;
    if (s.cost0 < nodeDist[s.node]) nodeDist[s.node] = s.cost0;
    for (let e = adjStart[s.node]; e < adjStart[s.node + 1]; e++) {
      const t = s.cost0 + adjCost[e] * inv;
      relax(2 * e, t, -1, 0, 0, si);
      if (arcCls[e]) relax(2 * e + 1, t, -1, 0, 0, si);
    }
  }

  while (heap.size) {
    const st = heap.pop();
    const d = heap.popped;
    if (d > dist[st]) continue;
    const a = st >> 1, side = st & 1, v = adjTo[a];
    if (d < nodeDist[v]) nodeDist[v] = d;
    const lo = adjStart[v], hi = adjStart[v + 1];

    if (!special[v]) {
      // обычный узел степени 2: идём дальше по той же стороне
      const b = lo === arcRev[a] ? lo + 1 : lo;
      const nd = d + adjCost[b] * inv;
      relax(2 * b + (arcCls[b] ? side : 0), nd, st);
      // на небольших улицах можно перейти дорогу где угодно
      const c = arcCls[a];
      if (c && c <= 2 && arcCls[b]) relax(2 * b + (1 - side), nd + midBlock[c], st, midBlock[c], 2);
      continue;
    }

    const fl = flags[v];
    if (fl & F_BLOCKED) continue;
    const gate = fl & F_GATE ? WALK.gateDelay : 0;
    const dim = 2 * (hi - lo), M = jStart[v];
    // конец тротуара, на котором мы подошли: справа по ходу = левый конец обратной ветки
    const rev = arcRev[a], kr = legIdx[rev];
    const arrive = arcCls[a] ? (side === 0 ? 2 * kr : 2 * kr + 1) : 2 * kr + 1;
    for (let b = lo; b < hi; b++) {
      const kb = legIdx[b];
      const base = d + gate + adjCost[b] * inv;
      // уходим по правой стороне ветки (правый конец) или по левой
      const w1 = jMat[M + arrive * dim + 2 * kb + 1];
      relax(2 * b, base + w1, st, w1, 1);
      if (arcCls[b]) { const w2 = jMat[M + arrive * dim + 2 * kb]; relax(2 * b + 1, base + w2, st, w2, 1); }
    }
  }
  if (track) {
    // лучшее состояние для каждого узла (последняя дуга, пришедшая в узел)
    const nodeState = new Int32Array(n).fill(-1);
    for (let st = 0; st < dist.length; st++) {
      if (dist[st] === Infinity) continue;
      const v = adjTo[st >> 1];
      if (nodeState[v] < 0 || dist[st] <= dist[nodeState[v]]) nodeState[v] = st;
    }
    nodeDist.trace = { dist, pred, waitAt, kindAt, srcOf, nodeState, sources };
  }
  return nodeDist;
}

/**
 * Восстанавливает маршрут до узла из результата dijkstra(..., track=true).
 * @returns {null | {sourceIndex, nodes:number[], walkSec, waitSec, startSec, lengthM, events:[{kind, sec, lat, lon, node}]}}
 * kind: signal | zebra | marked | unmarked | gate | midblock
 */
export function tracePath(g, nodeDist, node, speedMps = 4.8 / 3.6) {
  const tr = nodeDist.trace;
  if (!tr || tr.nodeState[node] < 0) return null;
  const { pred, waitAt, kindAt, srcOf, dist, sources } = tr;
  const chain = [];
  for (let st = tr.nodeState[node]; st >= 0; st = pred[st]) chain.push(st);
  chain.reverse();
  const first = chain[0];
  const sourceIndex = srcOf[first];
  const nodes = [g.arcFrom[first >> 1]];
  const events = [];
  let waitSec = 0, lengthM = 0;
  for (const st of chain) {
    const a = st >> 1, u = g.arcFrom[a], v = g.adjTo[a];
    lengthM += g.adjCost[a];
    nodes.push(v);
    // ожидание происходит в узле u — начале дуги, на которую вышли
    const fl = g.nodeFlags[u], k = kindAt[st], w = waitAt[st];
    if (k === 2 && w > 0) {
      waitSec += w; events.push({ kind: 'midblock', sec: w, lat: g.lat[u], lon: g.lon[u], node: u });
    } else if (k === 1) {
      if (fl & F_GATE) { waitSec += WALK.gateDelay; events.push({ kind: 'gate', sec: WALK.gateDelay, lat: g.lat[u], lon: g.lon[u], node: u }); }
      if (w > 0.05) {
        const kind = fl & F_SIGNAL ? 'signal' : fl & F_ZEBRA ? 'zebra' : fl & F_MARKED ? 'marked' : 'unmarked';
        waitSec += w; events.push({ kind, sec: w, lat: g.lat[u], lon: g.lon[u], node: u });
      }
    }
  }
  const last = chain[chain.length - 1];
  const startSec = sources[sourceIndex].cost0;
  const total = dist[last];
  return { sourceIndex, nodes, startSec, lengthM, waitSec, walkSec: total - startSec - waitSec, totalSec: total, events };
}
