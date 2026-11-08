// Тесты ядра на синтетической сетке улиц (без сети и браузера).
import assert from 'node:assert/strict';
import osmtogeojson from 'osmtogeojson';
import { buildGraph, dijkstra } from '../js/graph.js';
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
test('расстояние по сетке ≈ манхэттенское', () => {
  const s = g.snap(c.lat, c.lon, 100);
  const dist = dijkstra(g, [{ node: s.node, cost0: 0 }]);
  const t = g.snap(ll(1500 + 400, 1500 + 300).lat, ll(1500 + 400, 1500 + 300).lon, 10);
  assert.ok(Math.abs(dist[t.node] - 700) < 5, String(dist[t.node]));
});
test('лестницы медленнее (штраф 1.5)', () => {
  const gs = buildGraph(gridWays(10, 100, 'steps'));
  const a = gs.snap(ll(0, 0).lat, ll(0, 0).lon, 10), b = gs.snap(ll(500, 0).lat, ll(500, 0).lon, 10);
  const d = dijkstra(gs, [{ node: a.node, cost0: 0 }]);
  assert.ok(Math.abs(d[b.node] - 750) < 5, String(d[b.node]));
});
test('мультиисточник берёт минимум', () => {
  const a = g.snap(ll(0, 0).lat, ll(0, 0).lon, 10), b = g.snap(ll(3000, 0).lat, ll(3000, 0).lon, 10);
  const d = dijkstra(g, [{ node: a.node, cost0: 0 }, { node: b.node, cost0: 0 }]);
  const m = g.snap(ll(1500, 0).lat, ll(1500, 0).lon, 10);
  assert.ok(Math.abs(d[m.node] - 1500) < 5);
});
test('мелкие изолированные острова отбрасываются', () => {
  const island = { id: 999, nodes: [1, 2, 3], geometry: [ll(5000, 5000), ll(5010, 5000), ll(5020, 5000)], tags: { highway: 'footway' } };
  const gi = buildGraph([...gridWays(10), island]);
  assert.ok(gi.validCount < gi.n);
  assert.equal(gi.snap(ll(5010, 5000).lat, ll(5010, 5000).lon, 50), null);
});

console.log('Изохроны');
const origin = g.snap(c.lat, c.lon, 100);
const dist = dijkstra(g, [{ node: origin.node, cost0: 0 }], 15 * 60 * SPEED);
test('площадь 5-минутной изохроны близка к ромбу 2R²', () => {
  const R = 5 * 60 * SPEED; // 400 м
  const r = isochroneGeometry(g, dist, R);
  const diamond = 2 * R * R;
  assert.ok(r.areaM2 > diamond * 0.85 && r.areaM2 < diamond * 2.0, `${r.areaM2} vs ${diamond}`);
  assert.equal(r.geometry.type, 'MultiPolygon');
});
test('изохроны вложены: 5 ⊂ 10 ⊂ 15', () => {
  const a = [5, 10, 15].map(m => isochroneGeometry(g, dist, m * 60 * SPEED).areaM2);
  assert.ok(a[0] < a[1] && a[1] < a[2], a.join(','));
});
test('центр внутри, дальняя точка снаружи', () => {
  const r = isochroneGeometry(g, dist, 5 * 60 * SPEED);
  assert.ok(pointInGeometry(c.lon, c.lat, r.geometry));
  const far = ll(1500 + 900, 1500);
  assert.ok(!pointInGeometry(far.lon, far.lat, r.geometry));
});
test('кольца замкнуты, внешние — против часовой', () => {
  const r = isochroneGeometry(g, dist, 10 * 60 * SPEED);
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
  const dd = dijkstra(gh, [{ node: o.node, cost0: 0 }], 25 * 60 * SPEED);
  const r = isochroneGeometry(gh, dd, 25 * 60 * SPEED);
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
  assert.ok(Math.abs(rep.cats.school.nearest - expected) < 0.2, String(rep.cats.school.nearest));
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
