// Тесты ядра на синтетической сетке улиц (без сети и браузера).
import assert from 'node:assert/strict';
import osmtogeojson from 'osmtogeojson';
import { buildGraph, dijkstra } from '../js/graph.js';
import { wayModel, nodeFlags, inclineFactor, F_SIGNAL, F_ZEBRA, F_BLOCKED } from '../js/walkmodel.js';
import { WALK, websterWait, adamsWait, unsignalizedWait } from '../js/config.js';
import { isochroneGeometry } from '../js/isochrone.js';
import { prepareCategories, isochroneReport, buildDemand, computeAnalysis, makeGridGroups, scoreOf, districtsToCSV, analysisToGeoJSON } from '../js/analysis.js';
import { parsePois, buildingWeight } from '../js/overpass.js';
import { pointInGeometry, geometryAreaM2, haversine, expandBBox } from '../js/geo.js';

globalThis.osmtogeojson = osmtogeojson;

const LAT0 = 51.5, LON0 = 46.0;
const M_LAT = 111195, M_LON = 111195 * Math.cos(LAT0 * Math.PI / 180);
const ll = (xm, ym) => ({ lat: LAT0 + ym / M_LAT, lon: LON0 + xm / M_LON });

// Сетка улиц 100 м, размер N×N кварталов
function gridWays(N, step = 100, highway = 'residential') {
  const ways = [];
  let wid = 1;
  const nid = (i, j) => 1000 + i * 1000 + j;
  for (let j = 0; j <= N; j++) {
    const nodes = [], geometry = [];
    for (let i = 0; i <= N; i++) { nodes.push(nid(i, j)); geometry.push(ll(i * step, j * step)); }
    ways.push({ id: wid++, nodes, geometry, tags: { highway } });
  }
  for (let i = 0; i <= N; i++) {
    const nodes = [], geometry = [];
    for (let j = 0; j <= N; j++) { nodes.push(nid(i, j)); geometry.push(ll(i * step, j * step)); }
    ways.push({ id: wid++, nodes, geometry, tags: { highway } });
  }
  return ways;
}

// Сетка, где горизонтальные и вертикальные улицы имеют разные теги
function gridWays2(N, step, hTags, vTags) {
  const ways = [];
  let wid = 5000;
  const nid = (i, j) => 1000 + i * 1000 + j;
  for (let j = 0; j <= N; j++) {
    const nodes = [], geometry = [];
    for (let i = 0; i <= N; i++) { nodes.push(nid(i, j)); geometry.push(ll(i * step, j * step)); }
    ways.push({ id: wid++, nodes, geometry, tags: typeof hTags === 'function' ? hTags(j) : hTags });
  }
  for (let i = 0; i <= N; i++) {
    const nodes = [], geometry = [];
    for (let j = 0; j <= N; j++) { nodes.push(nid(i, j)); geometry.push(ll(i * step, j * step)); }
    ways.push({ id: wid++, nodes, geometry, tags: typeof vTags === 'function' ? vTags(i) : vTags });
  }
  return { ways, nid };
}
const near = (gg, x, y) => gg.snap(ll(x, y).lat, ll(x, y).lon, 15).node;
const T = (gg, from, to, nodeOpt) => {
  const d = dijkstra(gg, [{ node: near(gg, ...from), cost0: 0 }], 1e9, SPEED);
  return d[near(gg, ...to)];
};

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

const SPEED = 4.8 / 3.6;
const g = buildGraph(gridWays(30)); // 3×3 км
const centerXY = [1500, 1500];
const c = ll(...centerXY);

console.log('Граф и Дейкстра');
test('граф построен и связный', () => {
  assert.ok(g.n > 3000);
  assert.equal(g.validCount, g.n);
});
test('привязка к узлу даёт расстояние < 1 м для точки на перекрёстке', () => {
  const s = g.snap(c.lat, c.lon, 100);
  assert.ok(s && s.dist < 1, JSON.stringify(s));
});
test('привязка вне сети возвращает null', () => {
  assert.equal(g.snap(LAT0 + 0.5, LON0, 150), null);
});
test('мультиисточник берёт минимум', () => {
  const a = g.snap(ll(0, 0).lat, ll(0, 0).lon, 10), b = g.snap(ll(3000, 0).lat, ll(3000, 0).lon, 10);
  const d = dijkstra(g, [{ node: a.node, cost0: 0 }, { node: b.node, cost0: 0 }], 1e9, SPEED);
  const m = g.snap(ll(1500, 0).lat, ll(1500, 0).lon, 10);
  const one = dijkstra(g, [{ node: a.node, cost0: 0 }], 1e9, SPEED)[m.node];
  assert.ok(d[m.node] <= one + 1e-9 && d[m.node] > 1000 / SPEED);
});
test('мелкие изолированные острова отбрасываются', () => {
  const island = { id: 999, nodes: [1, 2, 3], geometry: [ll(5000, 5000), ll(5010, 5000), ll(5020, 5000)], tags: { highway: 'footway' } };
  const gi = buildGraph([...gridWays(10), island]);
  assert.ok(gi.validCount < gi.n);
  assert.equal(gi.snap(ll(5010, 5000).lat, ll(5010, 5000).lon, 50), null);
});

console.log('Модель пешехода: перекрёстки, переходы, покрытие');
const RES = WALK.unmarkedWait[2];
test('прямо по внутренней улице: на каждом перекрёстке переходим боковую (2 с)', () => {
  const t = T(g, [0, 1000], [500, 1000]);
  assert.ok(Math.abs(t - (500 / SPEED + 4 * RES)) < 0.5, String(t));
});
test('на Т-образном перекрёстке с «глухой» стороны переходить не нужно', () => {
  const t = T(g, [0, 0], [500, 0]);
  assert.ok(Math.abs(t - 500 / SPEED) < 0.01, String(t));
});
test('по диагонали «лесенка» дешевле прямого Г-образного пути (меньше переходов)', () => {
  const diag = T(g, [0, 1000], [500, 1500]);
  const base = 1000 / SPEED;
  // Г-образный путь: 8 пересечений боковых улиц; лесенка — около 5 переходов
  assert.ok(diag > base + 3 * RES && diag <= base + 8 * RES + 0.5, String(diag - base));
  // тот же маршрут по двум прямым отрезкам (через угол) не дешевле
  const viaCorner = T(g, [0, 1000], [500, 1000]) + T(g, [500, 1000], [500, 1500]);
  assert.ok(diag <= viaCorner + 1e-6);
});
test('светофоры на магистрали: пересечение 4 дорог = 4 ожидания', () => {
  const { ways, nid } = gridWays2(10, 100, { highway: 'primary' }, { highway: 'residential' });
  const tags = new Map();
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) tags.set(nid(i, j), { highway: 'traffic_signals' });
  const gs = buildGraph(ways, { nodeTags: tags });
  const t = T(gs, [500, 0], [500, 500]);
  assert.ok(Math.abs(t - (500 / SPEED + 4 * WALK.signalWait[5])) < 1, String(t));
  const gu = buildGraph(ways); // без тегов — переход «как придётся»
  const tu = T(gu, [500, 0], [500, 500]);
  assert.ok(Math.abs(tu - (500 / SPEED + 4 * WALK.unmarkedWait[5])) < 1, String(tu));
  assert.ok(t > tu);
});
test('вдоль магистрали боковые улицы дешевле: идти по крупной дороге быстрее, чем пересекать её', () => {
  const { ways } = gridWays2(10, 100, { highway: 'primary', sidewalk: 'both' }, { highway: 'residential' });
  const gg = buildGraph(ways);
  const along = T(gg, [0, 500], [500, 500]);   // вдоль primary, пересекаем residential
  const across = T(gg, [500, 0], [500, 500]);  // поперёк primary
  assert.ok(along < across, `${along} < ${across}`);
});
test('явный пешеходный переход (footway) со светофором, зеброй и без тегов', () => {
  const road = { id: 1, nodes: [], geometry: [], tags: { highway: 'primary', sidewalk: 'both' } };
  for (let i = -5; i <= 5; i++) { road.nodes.push(100 + i); road.geometry.push(ll(i * 100, 0)); }
  const cross = { id: 2, nodes: [], geometry: [], tags: { highway: 'footway', footway: 'crossing' } };
  for (let j = -3; j <= 3; j++) { cross.nodes.push(j === 0 ? 100 : 200 + j); cross.geometry.push(ll(0, j * 100)); }
  const walk = nt => {
    const gg = buildGraph([road, cross], { nodeTags: nt ? new Map([[100, nt]]) : undefined });
    return { across: T(gg, [0, -300], [0, 300]), along: T(gg, [-500, 0], [500, 0]) };
  };
  const sig = walk({ highway: 'crossing', crossing: 'traffic_signals' });
  const zeb = walk({ highway: 'crossing', crossing: 'zebra' });
  const none = walk(null);
  assert.ok(Math.abs(sig.across - (600 / SPEED + WALK.signalWait[5])) < 0.5, String(sig.across));
  assert.ok(Math.abs(zeb.across - (600 / SPEED + WALK.zebraWait[5])) < 0.5, String(zeb.across));
  assert.ok(Math.abs(none.across - (600 / SPEED + WALK.unmarkedWait[5])) < 0.5, String(none.across));
  assert.ok(sig.across > none.across && none.across > zeb.across);
  assert.ok(Math.abs(sig.along - 1000 / SPEED) < 0.01, 'идя вдоль дороги мимо перехода — без задержки');
});
test('калитка добавляет задержку, закрытая — блокирует', () => {
  const way = { id: 3, nodes: [1, 2, 3, 4, 5, 6], geometry: [0, 100, 200, 300, 400, 500].map(x => ll(x, 0)), tags: { highway: 'footway' } };
  const run = nt => T(buildGraph([way], { nodeTags: nt ? new Map([[3, nt]]) : undefined, minComponentNodes: 1 }), [0, 0], [500, 0]);
  assert.ok(Math.abs(run(null) - 500 / SPEED) < 0.01);
  assert.ok(Math.abs(run({ barrier: 'gate' }) - (500 / SPEED + WALK.gateDelay)) < 0.01);
  assert.equal(run({ barrier: 'gate', access: 'private' }), Infinity);
});
test('тупик: разворот возможен', () => {
  const way = { id: 4, nodes: [1, 2, 3], geometry: [0, 100, 200].map(x => ll(x, 0)), tags: { highway: 'footway' } };
  const gg = buildGraph([way], { minComponentNodes: 1 });
  const a = near(gg, 0, 0);
  const d = dijkstra(gg, [{ node: near(gg, 200, 0), cost0: 0 }], 1e9, SPEED);
  assert.ok(Math.abs(d[a] - 200 / SPEED) < 0.01);
});
test('лестница, покрытие, уклон, тротуар: множители', () => {
  assert.equal(wayModel({ highway: 'steps' }).factor, WALK.stepsFactor);
  assert.equal(wayModel({ highway: 'footway', surface: 'asphalt' }).factor, 1);
  assert.equal(wayModel({ highway: 'footway', surface: 'dirt' }).factor, WALK.surface.dirt);
  assert.equal(wayModel({ highway: 'path' }).factor, WALK.unpavedDefault.path);
  assert.ok(Math.abs(wayModel({ highway: 'footway', surface: 'asphalt', smoothness: 'bad' }).factor - 1.3) < 1e-9);
  assert.equal(wayModel({ highway: 'primary', sidewalk: 'no' }).factor, WALK.noSidewalkFactor[5]);
  assert.equal(wayModel({ highway: 'primary', sidewalk: 'both' }).factor, 1);
  assert.equal(wayModel({ highway: 'primary', sidewalk: 'separate' }).factor, WALK.separateSidewalkFactor);
  assert.equal(wayModel({ highway: 'residential' }).factor, 1);
  assert.ok(inclineFactor(0) === 1 && inclineFactor(0.1) > 1.15 && inclineFactor(0.1) < 1.3);
  assert.ok(wayModel({ highway: 'footway', incline: '10%' }).factor > 1.15);
  assert.equal(wayModel({ highway: 'service', service: 'parking_aisle' }).rank, 0);
  assert.equal(wayModel({ highway: 'secondary' }).rank, 4);
});
test('теги узлов → флаги', () => {
  assert.equal(nodeFlags({ highway: 'traffic_signals' }), F_SIGNAL);
  assert.equal(nodeFlags({ highway: 'crossing', crossing: 'traffic_signals' }), F_SIGNAL);
  assert.equal(nodeFlags({ highway: 'crossing', crossing: 'zebra' }), F_ZEBRA);
  assert.ok(nodeFlags({ barrier: 'gate', foot: 'no' }) & F_BLOCKED);
  assert.equal(nodeFlags({}), 0);
});
test('лестница на пути замедляет в 1.8 раза', () => {
  const way = { id: 5, nodes: [1, 2, 3, 4, 5, 6], geometry: [0, 100, 200, 300, 400, 500].map(x => ll(x, 0)), tags: { highway: 'steps' } };
  const t = T(buildGraph([way], { minComponentNodes: 1 }), [0, 0], [500, 0]);
  assert.ok(Math.abs(t - (500 * WALK.stepsFactor) / SPEED) < 0.01, String(t));
});

console.log('Формулы ожидания (проверка моделированием)');
// Детерминированный генератор для воспроизводимости
function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
test('Адамс: среднее ожидание в пуассоновском потоке совпадает с моделированием (±3 %)', () => {
  const r = rng(12345);
  const lambda = 0.1, tc = 6; // 360 авт/ч, критический интервал 6 с
  const horizon = 2e6;
  const veh = [];
  for (let t = 0; t < horizon; t += -Math.log(1 - r()) / lambda) veh.push(t);
  let total = 0, count = 0, idx = 0;
  for (let k = 0; k < 200000; k++) {
    const t = r() * (horizon - 1000);
    while (idx > 0 && veh[idx - 1] > t) idx--;
    while (veh[idx] <= t) idx++;
    let s = t, i = idx;
    while (veh[i] - s < tc) { s = veh[i]; i++; }
    total += s - t; count++;
  }
  const sim = total / count, formula = adamsWait(lambda * 3600, tc);
  assert.ok(Math.abs(sim - formula) / formula < 0.03, `${sim} vs ${formula}`);
});
test('Вебстер: среднее ожидание у светофора = численное интегрирование', () => {
  const C = 90, g = 15;
  let sum = 0; const n = 900000;
  for (let i = 0; i < n; i++) { const t = ((i + 0.5) / n) * C; sum += t < g ? 0 : C - t; } // пришёл в красную фазу — ждёт её конца
  assert.ok(Math.abs(sum / n - websterWait(C, g)) < 1e-3);
  assert.ok(Math.abs(websterWait(90, 15) - 31.25) < 1e-9);
});
test('ожидание растёт с рангом дороги и числом полос; при нулевом потоке — 0', () => {
  for (let r = 2; r <= 6; r++) assert.ok(WALK.unmarkedWait[r] > WALK.unmarkedWait[r - 1]);
  assert.ok(unsignalizedWait(5, 6) > unsignalizedWait(5, 2));
  assert.equal(adamsWait(0, 8), 0);
  assert.ok(WALK.signalWait[5] > WALK.zebraWait[5]);
});

console.log('Изохроны');
const origin = g.snap(c.lat, c.lon, 100);
const dist = dijkstra(g, [{ node: origin.node, cost0: 0 }], 15 * 60, SPEED);
test('площадь 5-минутной изохроны близка к ромбу 2R²', () => {
  const R = 5 * 60 * SPEED; // 400 м без задержек; с задержками на перекрёстках зона чуть меньше
  const r = isochroneGeometry(g, dist, 5 * 60);
  const diamond = 2 * R * R;
  assert.ok(r.areaM2 > diamond * 0.7 && r.areaM2 < diamond * 2.0, `${r.areaM2} vs ${diamond}`);
  assert.equal(r.geometry.type, 'MultiPolygon');
});
test('изохроны вложены: 5 ⊂ 10 ⊂ 15', () => {
  const a = [5, 10, 15].map(m => isochroneGeometry(g, dist, m * 60).areaM2);
  assert.ok(a[0] < a[1] && a[1] < a[2], a.join(','));
});
test('центр внутри, дальняя точка снаружи', () => {
  const r = isochroneGeometry(g, dist, 5 * 60);
  assert.ok(pointInGeometry(c.lon, c.lat, r.geometry));
  const far = ll(1500 + 900, 1500);
  assert.ok(!pointInGeometry(far.lon, far.lat, r.geometry));
});
test('кольца замкнуты, внешние — против часовой', () => {
  const r = isochroneGeometry(g, dist, 10 * 60);
  for (const poly of r.geometry.coordinates) {
    const ring = poly[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.ok(geometryAreaM2({ type: 'Polygon', coordinates: poly }) > 0);
  }
});
test('пустая изохрона при недостижимости', () => {
  const d = new Float64Array(g.n).fill(Infinity);
  assert.equal(isochroneGeometry(g, d, 100).geometry, null);
});
test('«дырка» (непроходимый участок) сохраняется', () => {
  // убираем центральный квартал сетки радиусом ~500 м вокруг точки (2500, 1500)
  const ways = gridWays(30).map(w => ({ ...w }));
  const filtered = ways.map(w => {
    const keep = w.geometry.map(p => { const x = (p.lon - LON0) * M_LON, y = (p.lat - LAT0) * M_LAT; return Math.hypot(x - 2000, y - 1500) > 350; });
    const pieces = []; let cur = null;
    w.geometry.forEach((p, i) => {
      if (keep[i]) { if (!cur) pieces.push(cur = { geometry: [], nodes: [] }); cur.geometry.push(p); cur.nodes.push(w.nodes[i]); } else cur = null;
    });
    return pieces.filter(pc => pc.geometry.length > 1).map((pc, k) => ({ id: w.id * 100 + k, nodes: pc.nodes, geometry: pc.geometry, tags: w.tags }));
  }).flat();
  const gh = buildGraph(filtered);
  const o = gh.snap(c.lat, c.lon, 100);
  const dd = dijkstra(gh, [{ node: o.node, cost0: 0 }], 25 * 60, SPEED);
  const r = isochroneGeometry(gh, dd, 25 * 60);
  const hole = ll(2000, 1500);
  assert.ok(!pointInGeometry(hole.lon, hole.lat, r.geometry), 'в дырке не должно быть заливки');
  assert.ok(r.geometry.coordinates.some(p => p.length > 1), 'ожидалась полигон с отверстием');
});

console.log('Отчёт и аналитика');
const pois = [
  { id: 'a', name: 'Школа А', cat: 'school', lat: ll(1500 + 300, 1500).lat, lon: ll(1500 + 300, 1500).lon, pts: [[ll(1800, 1500).lon, ll(1800, 1500).lat]] },
  { id: 'b', name: 'Школа Б', cat: 'school', lat: ll(1500, 1500 + 1000).lat, lon: ll(1500, 2500).lon, pts: [[ll(1500, 2500).lon, ll(1500, 2500).lat]] },
  { id: 'p', name: 'Парк', cat: 'park', lat: ll(0, 0).lat, lon: ll(0, 0).lon, pts: [[ll(100, 100).lon, ll(100, 100).lat], [ll(200, 100).lon, ll(200, 100).lat]] },
];
const prepared = prepareCategories(g, pois, ['school', 'park', 'hospital']);
test('привязка объектов', () => {
  assert.equal(prepared.school.items.length, 2);
  assert.equal(prepared.park.sources.length, 2);
  assert.equal(prepared.hospital.items.length, 0);
});
test('отчёт: время до школы А ≈ 300 м / 4.8 км/ч', () => {
  const rep = isochroneReport(g, { lat: c.lat, lon: c.lon }, prepared, { bands: [5, 10, 15], speedMps: SPEED });
  const expected = 300 / SPEED / 60;
  // + ожидание на 2 боковых улицах (по 2 с) и привязка к сети: расхождение в пределах 0.3 мин
  assert.ok(rep.cats.school.nearest >= expected && rep.cats.school.nearest - expected < 0.3, String(rep.cats.school.nearest));
  assert.equal(rep.cats.school.counts[5], 1);
  assert.equal(rep.cats.school.counts[15], 2);
  assert.equal(rep.cats.hospital.nearest, null);
  assert.equal(rep.isochrones.length, 3);
});
test('точка вне сети → null', () => {
  assert.equal(isochroneReport(g, { lat: 10, lon: 10 }, prepared, { bands: [5], speedMps: SPEED }), null);
});
test('шкала индекса', () => {
  assert.equal(scoreOf(3), 100); assert.equal(scoreOf(20), 0); assert.equal(scoreOf(Infinity), 0);
  assert.ok(Math.abs(scoreOf(12.5) - 50) < 1e-9);
});

const bbox = [LON0, LAT0, ll(3000, 3000).lon, ll(3000, 3000).lat];
test('анализ по сетке-районам и проблемные зоны', () => {
  const demand = buildDemand(g, { mode: 'network', bbox });
  const groups = makeGridGroups(bbox, 1000);
  const res = computeAnalysis({ g, prepared, demand, groups, catIds: ['school', 'park'], bands: [5, 10, 15], speedMps: SPEED, bbox });
  assert.equal(res.districts.length, 9);
  const withIdx = res.districts.filter(d => d.index != null);
  assert.ok(withIdx.length >= 8);
  // квадрат со школой А и парком лучше дальнего угла
  const best = Math.max(...withIdx.map(d => d.index)), worst = Math.min(...withIdx.map(d => d.index));
  assert.ok(best > worst + 20, `${best} ${worst}`);
  assert.ok(res.cells.length > 100);
  assert.ok(res.zones.length >= 1 && res.zones[0].weight > 0);
  assert.ok(res.overall.stats.school.shares[15] > 0);
  assert.ok(districtsToCSV(res).includes('Квадрат 1-1'));
  const gj = analysisToGeoJSON(res);
  assert.ok(gj.features.some(f => f.properties.layer === 'problem_zone'));
  const z = res.zones[0];
  assert.equal(z.outline.type, 'MultiPolygon');
  assert.ok(Math.abs(geometryAreaM2(z.outline) - z.areaKm2 * 1e6) / (z.areaKm2 * 1e6) < 0.05, 'площадь контура зоны = площади ячеек');
});
test('спрос по зданиям; здания вне сети исключаются', () => {
  const buildings = [
    { id: 1, ...ll(1500, 1510), w: 5 },
    { id: 2, ...ll(9000, 9000), w: 5 },
  ];
  const d = buildDemand(g, { mode: 'buildings', buildings, bbox: expandBBox(bbox, 10000) });
  assert.equal(d.n, 1); assert.equal(d.skipped, 1);
});

console.log('Разбор данных OSM');
test('POI: точки и полигон парка', () => {
  const elements = [
    { type: 'node', id: 1, lat: 51.5, lon: 46.0, tags: { amenity: 'hospital', name: 'Больница' } },
    { type: 'way', id: 2, center: { lat: 51.51, lon: 46.01 }, tags: { amenity: 'school' } },
    { type: 'node', id: 3, lat: 51.5, lon: 46.0, tags: { amenity: 'pharmacy' } },
    { type: 'way', id: 10, nodes: [11, 12, 13, 14, 11], tags: { leisure: 'park', name: 'Парк' },
      geometry: [{ lat: 51.500, lon: 46.000 }, { lat: 51.500, lon: 46.002 }, { lat: 51.502, lon: 46.002 }, { lat: 51.502, lon: 46.000 }, { lat: 51.500, lon: 46.000 }] },
    { type: 'way', id: 11, nodes: [21, 22, 23, 24, 21], tags: { leisure: 'park' },
      geometry: [{ lat: 51.5, lon: 46.0 }, { lat: 51.5, lon: 46.00001 }, { lat: 51.50001, lon: 46.00001 }, { lat: 51.50001, lon: 46.0 }, { lat: 51.5, lon: 46.0 }] },
  ];
  const p = parsePois(elements);
  assert.deepEqual(p.map(x => x.cat).sort(), ['hospital', 'park', 'pharmacy', 'school']);
  const park = p.find(x => x.cat === 'park');
  assert.ok(park.pts.length > 8 && park.name === 'Парк');
});
test('вес здания', () => {
  assert.equal(buildingWeight({ 'building:levels': '9' }), 9);
  assert.equal(buildingWeight({ building: 'apartments' }), 5);
  assert.equal(buildingWeight({ building: 'yes' }), 1);
});
test('haversine', () => {
  assert.ok(Math.abs(haversine(0, 0, 0, 1) - 111195) < 200);
});

console.log(`\nГотово: ${passed} тестов пройдено`);
