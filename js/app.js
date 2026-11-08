import { CONFIG, CATEGORIES, BAND_COLORS, INDEX_STEPS, PROBLEM_COLOR, WALK } from './config.js';
import { loadNetwork, loadNodeTags, loadPois, loadBuildings, listAdminLevels, loadAdminAreas, geocode, clearMemoryCache } from './overpass.js';
import { buildGraph } from './graph.js';
import { F_SIGNAL, F_ZEBRA, F_MARKED, F_GATE, F_BLOCKED } from './walkmodel.js';
import { loadSavedParams, setParams, restoreDefaults } from './params.js';
import { methodHTML, readParamsFrom } from './method.js';
import { storeClear, storeCount, cacheStats } from './store.js';
import { _, setLang, getLang, locale, detectLang, saveLang, translateDom } from './i18n.js';
import { setNetLogger } from './overpass.js';

setLang(detectLang());
import {
  prepareCategories, isochroneReport, buildDemand, computeAnalysis, makeGridGroups,
  CAT_BY_ID, districtsToCSV, analysisToGeoJSON, isochronesToGeoJSON, routeToPoi,
} from './analysis.js';
import { bboxAround, expandBBox, bboxSpanKm, geometryBBox } from './geo.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const tick = () => new Promise(r => setTimeout(r, 0));
const nf = (x, d = 1) => x.toLocaleString(locale(), { maximumFractionDigits: d });
const catLabel = c => _(c.label);
const catShort = c => catLabel(c).split(' ')[0];
const fmtMin = x => (x == null || !Number.isFinite(x) ? '—' : nf(x, 1));

const state = {
  speedKmh: CONFIG.speedKmh,
  active: new Set(CATEGORIES.filter(c => c.default).map(c => c.id)),
  abort: null,
  graph: null,
  iso: null,
  origin: null,
  area: null,
  tab: 'iso',
  sort: { key: 'index', dir: 1 },
  metric: 'share',
  route: null,
};
loadSavedParams();

// ── карта ───────────────────────────────────────────────────────────────────

const map = L.map('map', { preferCanvas: true }).setView(CONFIG.defaultCenter, CONFIG.defaultZoom);
// Подложки без ключей и регистрации. OSM Standard — с учётом Tile Usage Policy (атрибуция, умеренная нагрузка);
// светлая серая от Esri удобна для наложений. Для большого трафика подставьте свой провайдер тайлов.
const baseMaps = {
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }),
  [_('Светлая (Esri)')]: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors',
  }),
};
baseMaps['OpenStreetMap'].addTo(map);
L.control.layers(baseMaps, null, { position: 'topleft', collapsed: true }).addTo(map);
['cells', 'districts', 'iso', 'zones', 'poi'].forEach((name, i) => { map.createPane(name).style.zIndex = 410 + i * 10; });

const isoGroup = L.layerGroup().addTo(map);
const routeGroup = L.layerGroup().addTo(map);
const areaLayers = {
  cells: L.layerGroup(), districts: L.layerGroup(), zones: L.layerGroup(), poi: L.layerGroup(),
};
const areaRect = L.rectangle([[0, 0], [0, 0]], { color: '#52514e', weight: 1.5, dashArray: '6 5', fill: false, interactive: false });
let originMarker = null;

// ── статус и задачи ─────────────────────────────────────────────────────────

function setStatus(msg, busy = false, error = false) {
  $('#status-text').textContent = msg;
  $('#status').classList.toggle('busy', busy);
  $('#status').classList.toggle('error', error);
  $('#cancel').hidden = !busy;
}
function startTask() {
  state.abort?.abort();
  state.abort = new AbortController();
  return state.abort.signal;
}
function fail(e) {
  if (e?.name === 'AbortError') return setStatus(_('Отменено.'));
  console.error(e);
  setStatus(e?.message || _('Что-то пошло не так.'), false, true);
}
$('#cancel').addEventListener('click', () => state.abort?.abort());

// ── журнал расчёта (открытость: что именно загружено и сколько это заняло) ───

const logState = { lines: [], t0: 0 };
function logStart(title) {
  logState.lines = []; logState.t0 = performance.now();
  logAdd(title);
}
function logAdd(msg) {
  const ts = ((performance.now() - logState.t0) / 1000).toFixed(1).padStart(5);
  logState.lines.push(`[${ts} ${_('с')}] ${msg}`);
  $('#log').textContent = logState.lines.join('\n');
  $('#log-box').hidden = false;
}
function logGraph(g, nodeTags) {
  let sig = 0, zeb = 0, mk = 0, gate = 0, blk = 0;
  for (let i = 0; i < g.n; i++) {
    const f = g.nodeFlags[i];
    if (f & F_SIGNAL) sig++; else if (f & F_ZEBRA) zeb++; else if (f & F_MARKED) mk++;
    if (f & F_GATE) gate++;
    if (f & F_BLOCKED) blk++;
  }
  logAdd(_('граф: {nodes} узлов, {edges} рёбер, {km} км; светофоров {sig}, «зебр» {zeb}, размеченных переходов {mk}, калиток {gate}, закрытых проходов {blk}', { nodes: g.validCount, edges: g.edges, km: nf(g.lengthKm, 0), sig, zeb, mk, gate, blk }));
  logAdd(_('параметры: скорость {v} км/ч, ожидание на светофоре (primary) {s} с, без регулирования (primary) {u} с', { v: nf(state.speedKmh, 1), s: nf(WALK.signalWait[5], 1), u: nf(WALK.unmarkedWait[5], 1) }));
}

// ── параметры ───────────────────────────────────────────────────────────────

const speedMps = () => (state.speedKmh * 1000) / 3600;

function parseBands() {
  const v = $('#bands').value.split(/[,;\s]+/).map(Number).filter(x => Number.isFinite(x) && x >= 1 && x <= 30);
  const u = [...new Set(v)].sort((a, b) => a - b).slice(0, 4);
  return u.length ? u : CONFIG.bands;
}

function activeCatIds() { return CATEGORIES.filter(c => state.active.has(c.id)).map(c => c.id); }

function buildCatsUI() {
  $('#cats').innerHTML = CATEGORIES.map(c => `
    <label class="cat"><input type="checkbox" data-cat="${c.id}" ${state.active.has(c.id) ? 'checked' : ''}>
      <span class="dot" style="background:${c.color}"></span>${esc(catLabel(c))}</label>`).join('');
  $('#cats').addEventListener('change', e => {
    const id = e.target.dataset.cat;
    if (!id) return;
    e.target.checked ? state.active.add(id) : state.active.delete(id);
    if (state.tab === 'iso') renderIso(); else if (state.area) recomputeArea();
  });
}

let recalcTimer = null;
function scheduleRecalc() {
  clearTimeout(recalcTimer);
  recalcTimer = setTimeout(() => {
    if (state.tab === 'iso' && state.origin) runIsochrone(state.origin, { fit: false });
    else if (state.tab === 'area' && state.area) recomputeArea();
  }, 450);
}
$('#speed').addEventListener('input', e => {
  state.speedKmh = Number(e.target.value);
  $('#speed-out').textContent = nf(state.speedKmh, 1) + ' ' + _('км/ч');
  scheduleRecalc();
});
$('#bands').addEventListener('change', scheduleRecalc);
$('#max-span').textContent = CONFIG.maxAnalysisSpanKm;

// ── вкладки ─────────────────────────────────────────────────────────────────

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('#tab-iso').hidden = tab !== 'iso';
  $('#tab-area').hidden = tab !== 'area';
  if (tab === 'iso') {
    Object.values(areaLayers).forEach(l => map.removeLayer(l));
    map.removeLayer(areaRect);
    isoGroup.addTo(map);
    routeGroup.addTo(map);
    if (originMarker) originMarker.addTo(map);
    renderIsoLegend();
  } else {
    map.removeLayer(isoGroup);
    map.removeLayer(routeGroup);
    if (originMarker) map.removeLayer(originMarker);
    if (state.area) attachAreaLayers();
    renderAreaLegend();
  }
  $('#layers').hidden = !(tab === 'area' && state.area);
  $('#legend').hidden = !(tab === 'iso' ? state.iso : state.area);
}
document.querySelector('.tabs').addEventListener('click', e => { if (e.target.dataset.tab) setTab(e.target.dataset.tab); });

// ── поиск ───────────────────────────────────────────────────────────────────

$('#search').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  const list = $('#search-results');
  try {
    setStatus(_('Ищу место…'), true);
    const res = await geocode(q, { signal: startTask(), lang: getLang() });
    setStatus(_('Готово к работе.'));
    list.innerHTML = res.length
      ? res.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.name)}</button></li>`).join('')
      : `<li><button type="button" disabled>${_('Ничего не найдено')}</button></li>`;
    list.hidden = false;
    list.onclick = ev => {
      const i = ev.target.dataset.i;
      if (i === undefined) return;
      const [w, s, e2, n] = res[i].bbox;
      map.fitBounds([[s, w], [n, e2]], { maxZoom: 15 });
      list.hidden = true;
    };
  } catch (err) { fail(err); }
});

// ── загрузка данных ─────────────────────────────────────────────────────────

async function loadAll(bbox, signal, buildingsBBox) {
  const [w, s0, e, n] = bbox;
  const [wKm, hKm] = bboxSpanKm(bbox);
  logAdd(_('область загрузки: {w} × {h} км ({box})', { w: nf(wKm, 1), h: nf(hKm, 1), box: `${s0.toFixed(4)},${w.toFixed(4)} — ${n.toFixed(4)},${e.toFixed(4)}` }));
  const hit0 = cacheStats.hits;
  const prog = label => (d, t) => setStatus(_('{label}: {d} из {t} фрагментов…', { label, d, t }), true);
  const step = async (label, fn, describe) => {
    const t = performance.now();
    const r = await fn();
    logAdd(`${label}: ${describe(r)} (${((performance.now() - t) / 1000).toFixed(1)} ${_('с')})`);
    return r;
  };
  const ways = await step(_('пешеходная сеть (Overpass)'), () => loadNetwork(bbox, { signal, onProgress: prog(_('Пешеходная сеть')) }), r => _('{n} путей', { n: r.length }));
  const nodeTags = await step(_('светофоры, переходы, калитки'), () => loadNodeTags(bbox, { signal, onProgress: prog(_('Светофоры и переходы')) }), r => _('{n} узлов с тегами', { n: r.size }));
  const pois = await step(_('объекты: больницы, школы, парки…'), () => loadPois(bbox, { signal, onProgress: prog(_('Школы, больницы, парки')) }), r => _('{n} объектов', { n: r.length }));
  const buildings = buildingsBBox ? await step(_('здания'), () => loadBuildings(buildingsBBox, { signal, onProgress: prog(_('Здания')) }), r => _('{n} зданий', { n: r.length })) : null;
  logAdd(_('фрагментов из локального кэша: {n}', { n: cacheStats.hits - hit0 }));
  return { ways, nodeTags, pois, buildings };
}

function getGraph(ways, nodeTags) {
  const sig = `${ways.length}:${ways[0]?.id}:${ways[ways.length - 1]?.id}:${nodeTags.size}`;
  if (state.graph?.sig === sig) { logAdd(_('граф: использован построенный ранее')); return state.graph.g; }
  const t = performance.now();
  const g = buildGraph(ways, { ...CONFIG.graph, nodeTags });
  state.graph = { sig, g };
  logGraph(g, nodeTags);
  logAdd(_('граф построен за {s} с', { s: ((performance.now() - t) / 1000).toFixed(1) }));
  return g;
}

// ── изохроны ────────────────────────────────────────────────────────────────

async function runIsochrone(latlng, { fit = true } = {}) {
  const signal = startTask();
  const bands = parseBands();
  const maxMin = Math.max(...bands);
  const radius = maxMin * 60 * speedMps() + CONFIG.snap.originM + CONFIG.snap.poiM + 100;
  const bbox = bboxAround(latlng.lat, latlng.lng, radius);
  state.origin = { lat: latlng.lat, lng: latlng.lng };
  state.route = null; routeGroup.clearLayers(); $('#route-box').innerHTML = '';
  placeOrigin(latlng);
  logStart(_('изохроны из точки {p}; пороги {b} мин', { p: `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`, b: bands.join('/') }));
  try {
    setStatus(_('Загружаю данные OpenStreetMap…'), true);
    const { ways, nodeTags, pois } = await loadAll(bbox, signal);
    if (!ways.length) throw new Error(_('В этой области нет данных о дорогах и тропинках.'));
    setStatus(_('Строю граф и считаю изохроны…'), true);
    await tick();
    const g = getGraph(ways, nodeTags);
    const prepared = prepareCategories(g, pois, CATEGORIES.map(c => c.id));
    const tIso = performance.now();
    const report = isochroneReport(g, { lat: latlng.lat, lon: latlng.lng }, prepared, { bands, speedMps: speedMps() });
    if (report) logAdd(_('расчёт Дейкстры и контуров: {s} с; старт привязан к сети на {m} м', { s: ((performance.now() - tIso) / 1000).toFixed(2), m: Math.round(report.snapM) }));
    if (!report) throw new Error(_('Рядом с точкой нет пешеходной сети (ближе {m} м). Выберите точку у улицы.', { m: CONFIG.snap.originM }));
    state.iso = { report, bands, g };
    renderIso();
    writeHash();
    const biggest = [...report.isochrones].reverse().find(i => i.geometry);
    if (fit && biggest) map.fitBounds(L.geoJSON(biggest.geometry).getBounds(), { padding: [40, 40], maxZoom: 16 });
    setStatus(_('Готово: {km} км дорожек и улиц в расчёте.', { km: nf(g.lengthKm, 0) }));
  } catch (e) { fail(e); }
}

function placeOrigin(latlng) {
  if (!originMarker) {
    originMarker = L.marker(latlng, {
      draggable: true, keyboard: false,
      icon: L.divIcon({ className: '', html: '<div class="origin-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    }).addTo(map);
    originMarker.on('dragend', () => runIsochrone(originMarker.getLatLng(), { fit: false }));
  } else originMarker.setLatLng(latlng);
}

const poiCenter = poi => {
  const n = poi.pts.length;
  return [poi.pts.reduce((s, p) => s + p[1], 0) / n, poi.pts.reduce((s, p) => s + p[0], 0) / n];
};

function renderIso() {
  const st = state.iso;
  isoGroup.clearLayers();
  if (!st) { $('#iso-result').innerHTML = ''; $('#iso-actions').hidden = true; $('#legend').hidden = true; return; }
  const { report, bands } = st;
  const isos = report.isochrones;

  [...isos].reverse().forEach((iso, k) => {
    if (!iso.geometry) return;
    const idx = isos.length - 1 - k;
    const color = BAND_COLORS[idx];
    L.geoJSON(iso.geometry, { pane: 'iso', style: { color, weight: 1.5, fillColor: color, fillOpacity: 0.28 } })
      .bindTooltip(`${iso.min} ${_('мин')} · ${nf(iso.areaKm2, 2)} ${_('км²')}`, { sticky: true })
      .addTo(isoGroup);
  });

  const maxMin = Math.max(...bands);
  const cats = activeCatIds();
  for (const id of cats) {
    const cat = CAT_BY_ID[id];
    for (const r of report.cats[id].reached) {
      const [lat, lon] = poiCenter(r.poi);
      L.circleMarker([lat, lon], { pane: 'poi', radius: 6, color: '#fff', weight: 1.5, fillColor: cat.color, fillOpacity: 1 })
        .bindTooltip(`${esc(r.poi.name || catLabel(cat))}<br>${nf(r.minutes, 1)} ${_('мин пешком')}`)
        .addTo(isoGroup);
    }
  }

  const chips = isos.map((iso, i) => `<span class="chip"><i class="sw" style="background:${BAND_COLORS[i]}"></i>${iso.min} ${_('мин')} · ${nf(iso.areaKm2, 2)} ${_('км²')}</span>`).join('');
  const rows = cats.map(id => {
    const c = report.cats[id], cat = CAT_BY_ID[id];
    const counts = bands.map(b => `<td>${c.counts[b] ? `<b>${c.counts[b]}</b>` : '<span class="muted">0</span>'}</td>`).join('');
    const nearest = c.nearest != null ? `${fmtMin(c.nearest)} ${_('мин')}` : `<span class="muted">&gt; ${maxMin} ${_('мин')}</span>`;
    return `<tr><td><span class="dot" style="background:${cat.color}"></span> ${esc(catLabel(cat))}</td>${counts}<td>${nearest}</td></tr>`;
  }).join('');
  const details = cats.map(id => {
    const c = report.cats[id], cat = CAT_BY_ID[id];
    if (!c.reached.length) return '';
    const items = c.reached.slice(0, 8).map((r, i) => {
      const [lat, lon] = poiCenter(r.poi);
      return `<li><button type="button" data-lat="${lat}" data-lon="${lon}">${esc(r.poi.name || _('Без названия'))} — ${fmtMin(r.minutes)} ${_('мин')}</button>
        <button type="button" class="ghost mini" data-route="${id}:${i}" title="${_('Показать маршрут и разбор времени')}">${_('маршрут')}</button>
        <button type="button" class="ghost mini" data-from="${lat},${lon}" title="${_('Изохроны из этого объекта (зона охвата)')}">${_('зона охвата')}</button></li>`;
    }).join('');
    return `<details><summary>${esc(catLabel(cat))}: ${c.reached.length}</summary><ul class="poi-list">${items}</ul></details>`;
  }).join('');

  $('#iso-result').innerHTML = `
    <div class="chips">${chips}</div>
    <div class="tbl-wrap"><table><thead><tr><th>${_('Объектов в зоне')}</th>${bands.map(b => `<th>≤ ${b} ${_('мин')}</th>`).join('')}<th>${_('Ближайший')}</th></tr></thead><tbody>${rows || `<tr><td colspan="9" class="muted">${_('Выберите категории выше')}</td></tr>`}</tbody></table></div>
    ${details}
    <p class="hint">${_('Старт привязан к ближайшей улице ({m} м). Скорость {v} км/ч, лестницы, покрытие и ожидание на переходах учтены.', { m: Math.round(report.snapM), v: nf(state.speedKmh, 1) })}</p>`;
  $('#iso-actions').hidden = false;
  renderIsoLegend();
}

$('#iso-result').addEventListener('click', e => {
  const r = e.target.closest('button[data-route]');
  if (r) return showRoute(r.dataset.route);
  const f = e.target.closest('button[data-from]');
  if (f) { const [la, lo] = f.dataset.from.split(',').map(Number); return calcFrom({ lat: la, lng: lo }); }
  const b = e.target.closest('button[data-lat]');
  if (b) map.flyTo([Number(b.dataset.lat), Number(b.dataset.lon)], 17, { duration: 0.6 });
});

// ── маршрут до объекта с разбором времени ────────────────────────────────────

const EVENT_LABEL = {
  signal: ['светофор', '#c0392b'], zebra: ['«зебра»', '#e67e22'], marked: ['размеченный переход', '#d4a017'],
  unmarked: ['переход без регулирования', '#8e44ad'], gate: ['калитка / шлагбаум', '#7f8c8d'], midblock: ['переход посреди квартала', '#16a085'],
};
const evLabel = k => _(EVENT_LABEL[k][0]);
const fmtSec = x => (x >= 90 ? `${nf(x / 60, 1)} ${_('мин')}` : `${Math.round(x)} ${_('с')}`);

function showRoute(key) {
  const st = state.iso;
  if (!st) return;
  const [id, i] = key.split(':');
  const reached = st.report.cats[id]?.reached[Number(i)];
  if (!reached) return;
  const rt = routeToPoi(st.g, st.report, reached, speedMps());
  routeGroup.clearLayers();
  if (!rt) { $('#route-box').innerHTML = `<p class="hint">${_('Маршрут восстановить не удалось.')}</p>`; return; }
  const line = L.polyline(rt.coords, { color: '#0b0b0b', weight: 4, opacity: 0.85 }).addTo(routeGroup);
  for (const ev of rt.events) {
    const label = evLabel(ev.kind), color = EVENT_LABEL[ev.kind][1];
    L.marker([ev.lat, ev.lon], { icon: L.divIcon({ className: '', html: `<div class="ev-pin" style="background:${color}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }) })
      .bindTooltip(_('{label}: ожидание {t}', { label, t: fmtSec(ev.sec) })).addTo(routeGroup);
  }
  map.fitBounds(line.getBounds(), { padding: [50, 50], maxZoom: 17 });
  const tot = rt.totalSec;
  const parts = [[_('ходьба по сети'), rt.walkSec, '#2a78d6'], [_('ожидание на переходах'), rt.waitSec, '#c0392b'], [_('подход к сети'), rt.startSec + rt.endSec, '#9aa0a6']];
  const bar = parts.map(([, v, c]) => `<i style="width:${(v / tot) * 100}%;background:${c}" title="${fmtSec(v)}"></i>`).join('');
  const legend = parts.map(([l, v, c]) => `<span class="chip"><i class="sw" style="background:${c}"></i>${l}: ${fmtSec(v)}</span>`).join('');
  const byKind = {};
  for (const ev of rt.events) { const k = byKind[ev.kind] ||= { n: 0, s: 0 }; k.n++; k.s += ev.sec; }
  const evList = Object.entries(byKind).map(([k, v]) => `<li>${evLabel(k)}: ${v.n} × → ${fmtSec(v.s)}</li>`).join('');
  $('#route-box').innerHTML = `<div class="route">
    <h4><span>${esc(reached.poi.name || catLabel(CAT_BY_ID[id]))}</span><span>${nf(tot / 60, 1)} ${_('мин')} · ${nf(rt.lengthM, 0)} ${_('м')}</span></h4>
    <div class="bar">${bar}</div><div class="chips">${legend}</div>
    ${evList ? `<ul>${evList}</ul>` : `<p class="hint">${_('На маршруте нет значимых ожиданий.')}</p>`}
    <p class="hint">${_('Средняя скорость с учётом ожиданий: {a} км/ч при расчётной {b}.', { a: nf((rt.lengthM / tot) * 3.6, 1), b: nf(state.speedKmh, 1) })}</p>
  </div>`;
  logAdd(_('маршрут до «{name}»: {len} м, ходьба {w}, ожидания {t} ({n} событий)', { name: reached.poi.name || catLabel(CAT_BY_ID[id]), len: nf(rt.lengthM, 0), w: fmtSec(rt.walkSec), t: fmtSec(rt.waitSec), n: rt.events.length }));
}
$('#iso-clear').addEventListener('click', () => {
  state.iso = null; state.origin = null; state.route = null;
  routeGroup.clearLayers(); $('#route-box').innerHTML = '';
  if (originMarker) { map.removeLayer(originMarker); originMarker = null; }
  renderIso();
  setStatus(_('Готово к работе.'));
});
$('#iso-export').addEventListener('click', () => {
  if (state.iso) download('isochrones.geojson', JSON.stringify(isochronesToGeoJSON(state.iso.report)), 'application/geo+json');
});

function renderIsoLegend() {
  const el = $('#legend');
  if (state.tab !== 'iso') return;
  if (!state.iso) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<b>${_('Время пешком')}</b>` + state.iso.report.isochrones
    .map((iso, i) => `<div class="lrow"><i class="sw" style="background:${BAND_COLORS[i]}"></i>${_('до')} ${iso.min} ${_('мин')}</div>`).join('');
}

// ── анализ города ───────────────────────────────────────────────────────────

const indexColor = v => { let c = INDEX_STEPS[0][1]; for (const [lo, col] of INDEX_STEPS) if (v >= lo) c = col; return c; };

function analysisBBox() {
  const b = map.getBounds();
  let [w, s, e, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const [wKm, hKm] = bboxSpanKm([w, s, e, n]);
  const max = CONFIG.maxAnalysisSpanKm;
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const kx = Math.min(1, max / wKm), ky = Math.min(1, max / hKm);
  const clipped = kx < 1 || ky < 1;
  if (clipped) { const hw = ((e - w) / 2) * kx, hh = ((n - s) / 2) * ky; [w, e, s, n] = [cx - hw, cx + hw, cy - hh, cy + hh]; }
  return { bbox: [w, s, e, n], clipped };
}

async function pickDistricts(bbox, mode, signal) {
  if (mode.startsWith('grid')) return { groups: makeGridGroups(bbox, Number(mode.slice(4))), note: _('квадраты') };
  let level = Number(mode);
  if (mode === 'auto') {
    setStatus(_('Ищу административные границы…'), true);
    const levels = await listAdminLevels(bbox, { signal });
    const ok = levels.find(l => l.count >= 3 && l.count <= 80);
    if (!ok) return { groups: makeGridGroups(bbox, 1000), note: _('квадраты 1 км (границы районов не найдены)') };
    level = ok.level;
  }
  setStatus(_('Загружаю границы районов (admin_level={l})…', { l: level }), true);
  const areas = await loadAdminAreas(bbox, level, { signal });
  if (areas.length < 2) return { groups: makeGridGroups(bbox, 1000), note: _('квадраты 1 км (в этой области нет районов нужного уровня)') };
  const [w, s, e, n] = bbox;
  const groups = areas.map(a => {
    const box = geometryBBox(a.geometry);
    const iw = Math.max(0, Math.min(e, box[2]) - Math.max(w, box[0])), ih = Math.max(0, Math.min(n, box[3]) - Math.max(s, box[1]));
    const full = (box[2] - box[0]) * (box[3] - box[1]);
    return { ...a, bbox: box, coverage: full > 0 ? (iw * ih) / full : 1 };
  }).filter(gr => gr.coverage > 0.02);
  return { groups, note: `admin_level=${level}` };
}

async function runAnalysis() {
  const signal = startTask();
  const btn = $('#run-area');
  btn.disabled = true;
  try {
    logStart(_('анализ видимой области'));
    const { bbox, clipped } = analysisBBox();
    areaRect.setBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]).addTo(map);
    const padM = CONFIG.index.worstMin * 60 * speedMps();
    const big = expandBBox(bbox, padM);
    const weightMode = $('#weight-mode').value;
    const { ways, nodeTags, pois, buildings } = await loadAll(big, signal, weightMode === 'buildings' ? bbox : null);
    if (!ways.length) throw new Error(_('В этой области нет данных о дорогах и тропинках.'));
    setStatus(_('Строю граф пешеходной сети…'), true);
    await tick();
    const g = getGraph(ways, nodeTags);
    const prepared = prepareCategories(g, pois, CATEGORIES.map(c => c.id));
    logAdd(_('объекты привязаны к графу: ') + CATEGORIES.map(c => `${catShort(c)} ${prepared[c.id].items.length}`).join(', '));
    setStatus(_('Привязываю здания к сети…'), true);
    await tick();
    let demand = buildDemand(g, { buildings, mode: weightMode, bbox });
    let usedMode = weightMode;
    if (!demand.n && weightMode === 'buildings') { demand = buildDemand(g, { mode: 'network', bbox }); usedMode = 'network'; }
    if (!demand.n) throw new Error(_('В выбранной области нет пешеходной сети.'));
    logAdd(_('точек спроса: {n} ({k})', { n: demand.n, k: usedMode === 'buildings' ? _('здания') : _('узлы сети') }));
    const { groups, note } = await pickDistricts(bbox, $('#district-mode').value, signal);
    logAdd(_('районы: {n} ({note})', { n: groups.length, note }));
    state.area = { ctx: { g, prepared, demand, groups, bbox, pois, note, clipped, usedMode }, result: null };
    recomputeArea();
    setTab('area');
  } catch (e) { fail(e); } finally { btn.disabled = false; }
}

function recomputeArea() {
  const a = state.area;
  if (!a) return;
  const catIds = activeCatIds();
  if (!catIds.length) { setStatus(_('Выберите хотя бы одну категорию.'), false, true); return; }
  setStatus(_('Считаю доступность…'), true);
  const { g, prepared, demand, groups, bbox } = a.ctx;
  const tA = performance.now();
  a.result = computeAnalysis({ g, prepared, demand, groups, catIds, bands: parseBands(), speedMps: speedMps(), bbox });
  logAdd(_('расчёт доступности: {s} с; ячеек {c}, проблемных зон {z}', { s: ((performance.now() - tA) / 1000).toFixed(1), c: a.result.cells.length, z: a.result.zones.length }));
  renderArea();
  writeHash();
  const c = a.ctx;
  setStatus(_('Готово. Районы: {note}.', { note: c.note }) + (c.clipped ? ' ' + _('Область урезана до {km} км — сдвиньте карту для другого участка.', { km: CONFIG.maxAnalysisSpanKm }) : ''));
}

function renderArea() {
  const { ctx, result } = state.area;
  const maxBand = result.bands[result.bands.length - 1];
  const tot = result.overall;

  const bars = result.catIds.map(id => {
    const v = tot.stats[id].shares[maxBand];
    return `<div class="sharebar"><span><i class="dot" style="background:${CAT_BY_ID[id].color}"></i> ${esc(catLabel(CAT_BY_ID[id]))}</span><div class="track"><i style="width:${v}%"></i></div><output>${nf(v, 0)}%</output></div>`;
  }).join('');

  const zones = result.zones.slice(0, 12).map(z => `
    <li><button type="button" data-zone="${z.id}"><span class="badge">${z.id}</span>
      <span>${_('индекс')} ${nf(z.index, 0)} · ${nf(z.weight / tot.weight * 100, 1)}% ${_('спроса')} · ${nf(z.areaKm2, 2)} ${_('км²')}<br><span class="muted">${_('хуже всего:')} ${esc(catLabel(CAT_BY_ID[z.worst]).toLowerCase())}</span></span></button></li>`).join('');

  $('#area-result').innerHTML = `
    <div class="tiles">
      <div class="tile"><b>${tot.index == null ? '—' : nf(tot.index, 0)}</b><span>${_('индекс доступности, 0–100')}</span></div>
      <div class="tile"><b>${result.zones.length}</b><span>${_('проблемных зон')}</span></div>
      <div class="tile"><b>${nf(result.demand.n, 0)}</b><span>${ctx.usedMode === 'buildings' ? _('зданий в расчёте') : _('узлов сети в расчёте')}</span></div>
    </div>
    <div class="h3">${_('Доля жителей в пределах {b} мин пешком', { b: maxBand })}</div>
    <div class="sharebars">${bars}</div>
    <div class="h3">${_('Проблемные зоны')}</div>
    ${zones ? `<ul class="zones">${zones}</ul>` : `<p class="hint">${_('Зон с индексом ниже {n} не найдено.', { n: CONFIG.index.problemBelow })}</p>`}
    <div class="h3">${_('Сравнение районов')}
      <select id="metric" aria-label="${_('Показатель')}"><option value="share" ${state.metric === 'share' ? 'selected' : ''}>${_('Доля ≤ {b} мин, %', { b: maxBand })}</option><option value="median" ${state.metric === 'median' ? 'selected' : ''}>${_('Медиана, мин')}</option></select>
    </div>
    <div class="tbl-wrap" id="dist-table"></div>
    <p class="hint">${_('Индекс: 100 баллов при ≤ {best} мин до объекта, 0 при ≥ {worst} мин, между ними линейно; среднее по выбранным категориям, взвешено по {w}. Это прокси, а не перепись населения.', { best: CONFIG.index.bestMin, worst: CONFIG.index.worstMin, w: ctx.usedMode === 'buildings' ? _('этажности зданий') : _('длине улиц') })}</p>
    <div class="actions"><button id="area-csv" class="ghost">${_('Скачать CSV')}</button><button id="area-geojson" class="ghost">${_('Скачать GeoJSON')}</button></div>`;
  renderDistrictTable();
  buildAreaLayers();
  if (state.tab === 'area') attachAreaLayers();
  renderAreaLegend();
  $('#layers').hidden = false;
  $('#legend').hidden = false;
}

function renderDistrictTable() {
  const { result } = state.area;
  const maxBand = result.bands[result.bands.length - 1];
  const rows = result.districts.filter(d => d.weight > 0);
  if (!['name', 'index', ...result.catIds].includes(state.sort.key)) state.sort.key = 'index';
  const { key, dir } = state.sort;
  const val = d => key === 'name' ? d.name : key === 'index' ? d.index
    : state.metric === 'share' ? d.stats[key].shares[maxBand] : d.stats[key].median;
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    return (typeof x === 'string' ? x.localeCompare(y, 'ru') : x - y) * dir;
  });
  const head = (k, label) => `<th class="sortable" data-sort="${k}" aria-sort="${state.sort.key === k ? (dir === 1 ? 'ascending' : 'descending') : 'none'}" tabindex="0">${label}</th>`;
  const body = rows.map(d => {
    const cells = result.catIds.map(id => {
      const s = d.stats[id];
      const txt = state.metric === 'share' ? `${nf(s.shares[maxBand], 0)}%` : (Number.isFinite(s.median) ? nf(s.median, 1) : `&gt;${CONFIG.fieldMaxMin}`);
      return `<td title="${_('медиана')} ${fmtMin(s.median)} ${_('мин')}; ${result.bands.map(b => `≤${b}: ${nf(s.shares[b], 0)}%`).join(', ')}">${txt}</td>`;
    }).join('');
    const warn = d.coverage < 0.95 ? ` <span class="warn" title="${_('Район виден лишь на {p}%: показатели посчитаны по видимой части', { p: nf(d.coverage * 100, 0) })}">⚠</span>` : '';
    return `<tr class="click" data-id="${esc(d.id)}"><td>${esc(d.name)}${warn}</td><td class="num-bar"><i style="width:${d.index}%"></i>${nf(d.index, 0)}</td>${cells}</tr>`;
  }).join('');
  $('#dist-table').innerHTML = `<table><thead><tr>${head('name', _('Район'))}${head('index', _('Индекс'))}${result.catIds.map(id => head(id, esc(catShort(CAT_BY_ID[id])))).join('')}</tr></thead><tbody>${body}</tbody></table>`;
}

$('#area-result').addEventListener('click', e => {
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const k = th.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
    return renderDistrictTable();
  }
  const tr = e.target.closest('tr[data-id]');
  if (tr && state.area?.result) {
    const d = state.area.result.districts.find(x => String(x.id) === tr.dataset.id);
    if (d) flash(d.geometry);
    return;
  }
  const zb = e.target.closest('button[data-zone]');
  if (zb && state.area?.result) {
    const z = state.area.result.zones.find(x => x.id === Number(zb.dataset.zone));
    if (z) { map.flyTo(z.center, 16, { duration: 0.6 }); flash(z.outline); }
    return;
  }
  if (e.target.id === 'area-csv') download('districts.csv', districtsToCSV(state.area.result), 'text/csv;charset=utf-8');
  if (e.target.id === 'area-geojson') download('accessibility.geojson', JSON.stringify(analysisToGeoJSON(state.area.result)), 'application/geo+json');
});
$('#area-result').addEventListener('change', e => {
  if (e.target.id === 'metric') { state.metric = e.target.value; renderDistrictTable(); }
});
$('#area-result').addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('th[data-sort]')) { e.preventDefault(); e.target.click(); }
});
$('#run-area').addEventListener('click', runAnalysis);

function flash(geometry) {
  const layer = L.geoJSON(geometry, { style: { color: '#0b0b0b', weight: 3, fill: false }, interactive: false }).addTo(map);
  map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 16 });
  setTimeout(() => map.removeLayer(layer), 2500);
}

function buildAreaLayers() {
  const { result, ctx } = state.area;
  for (const l of Object.values(areaLayers)) l.clearLayers();

  for (const c of result.cells) {
    L.polygon(c.ring.map(([lo, la]) => [la, lo]), { pane: 'cells', stroke: false, fillColor: indexColor(c.index), fillOpacity: 0.62 })
      .bindTooltip(`${_('Индекс')} ${nf(c.index, 0)} · ${_('хуже всего:')} ${esc(catLabel(CAT_BY_ID[c.worst]).toLowerCase())}`, { sticky: true })
      .addTo(areaLayers.cells);
  }
  for (const d of result.districts) {
    L.geoJSON(d.geometry, { pane: 'districts', style: { color: '#52514e', weight: 1.6, fill: false } })
      .bindTooltip(`${esc(d.name)}${d.index == null ? '' : ` · ${_('индекс')} ${nf(d.index, 0)}`}`, { sticky: true })
      .addTo(areaLayers.districts);
  }
  for (const z of result.zones) {
    L.geoJSON(z.outline, { pane: 'zones', style: { color: PROBLEM_COLOR, weight: 2.5, fillColor: PROBLEM_COLOR, fillOpacity: 0.08 } })
      .bindTooltip(_('Зона {id}: индекс {i}, хуже всего — {w}', { id: z.id, i: nf(z.index, 0), w: esc(catLabel(CAT_BY_ID[z.worst]).toLowerCase()) }), { sticky: true })
      .addTo(areaLayers.zones);
    if (z.id <= 15) {
      L.marker(z.center, { pane: 'poi', interactive: false, icon: L.divIcon({ className: '', html: `<div class="zone-num">${z.id}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) })
        .addTo(areaLayers.zones);
    }
  }
  const cats = result.catIds;
  let shown = 0;
  for (const p of ctx.pois) {
    if (!cats.includes(p.cat) || shown > 6000) continue;
    shown++;
    const [lat, lon] = poiCenter(p);
    L.circleMarker([lat, lon], { pane: 'poi', radius: 3.5, color: '#fff', weight: 1, fillColor: CAT_BY_ID[p.cat].color, fillOpacity: 1 })
      .bindTooltip(esc(p.name || catLabel(CAT_BY_ID[p.cat]))).addTo(areaLayers.poi);
  }

}

function attachAreaLayers() {
  buildLayerToggles();
  for (const [name, layer] of Object.entries(areaLayers)) {
    const on = document.querySelector(`#layers input[data-layer="${name}"]`)?.checked ?? true;
    if (on) layer.addTo(map); else map.removeLayer(layer);
  }
  areaRect.addTo(map);
}

function buildLayerToggles() {
  const el = $('#layers');
  if (el.dataset.built) return;
  el.dataset.built = '1';
  const defs = [['cells', _('Индекс по ячейкам 150 м'), true], ['districts', _('Границы районов'), true], ['zones', _('Проблемные зоны'), true], ['poi', _('Объекты'), true]];
  el.innerHTML = defs.map(([k, label, on]) => `<label><input type="checkbox" data-layer="${k}" ${on ? 'checked' : ''}>${label}</label>`).join('');
  el.addEventListener('change', e => {
    const k = e.target.dataset.layer;
    if (!k) return;
    e.target.checked ? areaLayers[k].addTo(map) : map.removeLayer(areaLayers[k]);
  });
}

function renderAreaLegend() {
  const el = $('#legend');
  if (state.tab !== 'area' || !state.area) return;
  el.innerHTML = `<b>${_('Индекс доступности')}</b>
    <div class="scale">${INDEX_STEPS.map(([, c]) => `<i style="background:${c}"></i>`).join('')}</div>
    <div class="ends"><span>${_('0 · плохо')}</span><span>${_('100 · хорошо')}</span></div>
    <div class="lrow" style="margin-top:6px"><i class="sw" style="border:2.5px solid ${PROBLEM_COLOR};background:none"></i>${_('проблемная зона')} (&lt; ${CONFIG.index.problemBelow})</div>`;
  el.hidden = false;
}

// ── прочее ──────────────────────────────────────────────────────────────────

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

map.on('click', e => { if (state.tab === 'iso') runIsochrone(e.latlng); });

// ── расчёт из любой точки по кнопке ──────────────────────────────────────────

function calcFrom(latlng, zoom = 15) {
  setTab('iso');
  map.setView([latlng.lat, latlng.lng], Math.max(map.getZoom(), zoom));
  return runIsochrone(latlng, { fit: true });
}
$('#from-center').addEventListener('click', () => calcFrom(map.getCenter(), 14));
$('#from-geo').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus(_('Геолокация недоступна в этом браузере.'), false, true);
  setStatus(_('Определяю местоположение…'), true);
  navigator.geolocation.getCurrentPosition(
    pos => calcFrom({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
    err => setStatus(_('Не удалось определить местоположение: {m}. Введите адрес или координаты.', { m: err.message || _('доступ запрещён') }), false, true),
    { enableHighAccuracy: false, timeout: 10000 });
});
const COORD_RE = /^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/;
$('#from-text').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#from-q').value.trim();
  if (!q) return;
  const m = COORD_RE.exec(q);
  if (m) {
    const lat = parseFloat(m[1].replace(',', '.')), lng = parseFloat(m[2].replace(',', '.'));
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return setStatus(_('Координаты вне допустимого диапазона.'), false, true);
    return calcFrom({ lat, lng });
  }
  try {
    setStatus(_('Ищу адрес…'), true);
    const res = await geocode(q, { signal: startTask(), lang: getLang() });
    if (!res.length) return setStatus(_('Адрес не найден.'), false, true);
    const [w, s0, e2, n] = res[0].bbox;
    calcFrom({ lat: (s0 + n) / 2, lng: (w + e2) / 2 });
  } catch (err) { fail(err); }
});

// ── пресеты скорости ─────────────────────────────────────────────────────────

function setSpeed(v, fromPreset) {
  state.speedKmh = v;
  $('#speed').value = v;
  $('#speed-out').textContent = nf(v, 1) + ' ' + _('км/ч');
  const opt = [...$('#preset').options].find(o => o.value !== 'custom' && Number(o.value) === v);
  $('#preset').value = opt ? opt.value : 'custom';
  if (!fromPreset) writeHash();
}
$('#preset').addEventListener('change', e => {
  if (e.target.value === 'custom') return;
  setSpeed(Number(e.target.value), true);
  scheduleRecalc();
});
$('#speed').addEventListener('input', e => setSpeed(Number(e.target.value)));

// ── ссылка на расчёт (состояние в URL-хэше) ──────────────────────────────────

function currentHash() {
  const c = map.getCenter();
  const q = new URLSearchParams();
  q.set('c', `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`);
  q.set('z', map.getZoom());
  q.set('s', state.speedKmh);
  q.set('b', parseBands().join(','));
  q.set('k', activeCatIds().join(','));
  q.set('l', getLang());
  if (state.origin) q.set('o', `${state.origin.lat.toFixed(5)},${state.origin.lng.toFixed(5)}`);
  return q.toString();
}
function writeHash() { try { history.replaceState(null, '', '#' + currentHash()); } catch { /* file:// и т. п. */ } }
map.on('moveend', () => { clearTimeout(writeHash.t); writeHash.t = setTimeout(writeHash, 400); });
$('#bands').addEventListener('change', writeHash);
$('#share').addEventListener('click', async () => {
  writeHash();
  const url = location.href;
  try { await navigator.clipboard.writeText(url); setStatus(_('Ссылка на текущий расчёт скопирована.')); }
  catch { prompt(_('Скопируйте ссылку:'), url); }
});

function restoreFromHash() {
  if (!location.hash.length) return;
  const q = new URLSearchParams(location.hash.slice(1));
  const pair = v => (v || '').split(',').map(Number);
  const [clat, clng] = pair(q.get('c'));
  if (Number.isFinite(clat) && Number.isFinite(clng)) map.setView([clat, clng], Number(q.get('z')) || CONFIG.defaultZoom);
  const sp = Number(q.get('s')); if (sp >= 3 && sp <= 6) setSpeed(sp, true);
  if (q.get('b')) $('#bands').value = q.get('b');
  if (q.get('k')) {
    state.active = new Set(q.get('k').split(',').filter(id => CAT_BY_ID[id]));
    if (!state.active.size) state.active = new Set(CATEGORIES.filter(c => c.default).map(c => c.id));
  }
  const [olat, olng] = pair(q.get('o'));
  if (Number.isFinite(olat) && Number.isFinite(olng) && Math.abs(olat) <= 90 && Math.abs(olng) <= 180) {
    setTimeout(() => runIsochrone({ lat: olat, lng: olng }, { fit: false }), 50);
  }
}

// ── окно «Как считается» + параметры + кэш ───────────────────────────────────

async function openMethod() {
  const dlg = $('#method'), body = $('#method-body');
  const draw = async () => {
    body.innerHTML = methodHTML(state.speedKmh) + `
      <h3>${_('7. Локальный кэш данных')}</h3>
      <p>${_('Фрагменты OSM сохраняются в браузере (IndexedDB) на 7 дней, поэтому повторные расчёты в той же области не обращаются к сети. Сейчас сохранено фрагментов:')} <b id="cache-n">…</b>.</p>
      <div class="params-actions"><button type="button" id="cache-clear">${_('Очистить кэш')}</button></div>`;
    $('#cache-n').textContent = await storeCount();
  };
  await draw();
  if (!dlg.open) dlg.showModal();
  body.onclick = async e => {
    if (e.target.id === 'params-apply') {
      if (setParams(readParamsFrom(body))) onParamsChanged();
      draw();
    } else if (e.target.id === 'params-reset') {
      if (restoreDefaults()) onParamsChanged();
      draw();
    } else if (e.target.id === 'cache-clear') {
      clearMemoryCache(); await storeClear(); draw(); setStatus(_('Кэш очищен.'));
    }
  };
}
function onParamsChanged() {
  state.graph = null; // таблицы ожиданий «запекаются» в граф — пересобираем
  logAdd(_('параметры модели изменены — граф будет перестроен'));
  if (state.tab === 'iso' && state.origin) runIsochrone(state.origin, { fit: false });
  else if (state.tab === 'area' && state.area) runAnalysis();
  setStatus(_('Параметры применены, пересчитываю…'), true);
}
$('#open-method').addEventListener('click', openMethod);
$('#method').addEventListener('click', e => { if (e.target.id === 'method') e.target.close(); }); // клик по фону

setNetLogger(m => logAdd(m));
translateDom(document.body);
document.title = _('City Accessibility — пешая доступность города');
$('#lang').textContent = getLang() === 'en' ? 'RU' : 'EN';
$('#lang').addEventListener('click', () => {
  const next = getLang() === 'en' ? 'ru' : 'en';
  saveLang(next);
  const q = new URLSearchParams(location.hash.slice(1)); q.set('l', next);
  location.hash = q.toString();
  location.reload();
});
restoreFromHash();
buildCatsUI();
