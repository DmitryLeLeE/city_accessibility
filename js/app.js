import { CONFIG, CATEGORIES, BAND_COLORS, INDEX_STEPS, PROBLEM_COLOR } from './config.js';
import { loadNetwork, loadPois, loadBuildings, listAdminLevels, loadAdminAreas, geocode } from './overpass.js';
import { buildGraph } from './graph.js';
import {
  prepareCategories, isochroneReport, buildDemand, computeAnalysis, makeGridGroups,
  CAT_BY_ID, districtsToCSV, analysisToGeoJSON, isochronesToGeoJSON,
} from './analysis.js';
import { bboxAround, expandBBox, bboxSpanKm, geometryBBox } from './geo.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const tick = () => new Promise(r => setTimeout(r, 0));
const nf = (x, d = 1) => x.toLocaleString('ru-RU', { maximumFractionDigits: d });
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
};

// ── карта ───────────────────────────────────────────────────────────────────

const map = L.map('map', { preferCanvas: true }).setView(CONFIG.defaultCenter, CONFIG.defaultZoom);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd', maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);
['cells', 'districts', 'iso', 'zones', 'poi'].forEach((name, i) => { map.createPane(name).style.zIndex = 410 + i * 10; });

const isoGroup = L.layerGroup().addTo(map);
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
  if (e?.name === 'AbortError') return setStatus('Отменено.');
  console.error(e);
  setStatus(e?.message || 'Что-то пошло не так.', false, true);
}
$('#cancel').addEventListener('click', () => state.abort?.abort());

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
      <span class="dot" style="background:${c.color}"></span>${esc(c.label)}</label>`).join('');
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
  $('#speed-out').textContent = nf(state.speedKmh, 1) + ' км/ч';
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
    if (originMarker) originMarker.addTo(map);
    renderIsoLegend();
  } else {
    map.removeLayer(isoGroup);
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
    setStatus('Ищу место…', true);
    const res = await geocode(q, { signal: startTask() });
    setStatus('Готово к работе.');
    list.innerHTML = res.length
      ? res.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.name)}</button></li>`).join('')
      : '<li><button type="button" disabled>Ничего не найдено</button></li>';
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
  const prog = label => (d, t) => setStatus(`${label}: ${d} из ${t} фрагментов…`, true);
  const ways = await loadNetwork(bbox, { signal, onProgress: prog('Пешеходная сеть') });
  const pois = await loadPois(bbox, { signal, onProgress: prog('Школы, больницы, парки') });
  const buildings = buildingsBBox ? await loadBuildings(buildingsBBox, { signal, onProgress: prog('Здания') }) : null;
  return { ways, pois, buildings };
}

function getGraph(ways) {
  const sig = `${ways.length}:${ways[0]?.id}:${ways[ways.length - 1]?.id}`;
  if (state.graph?.sig === sig) return state.graph.g;
  const g = buildGraph(ways, CONFIG.graph);
  state.graph = { sig, g };
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
  placeOrigin(latlng);
  try {
    setStatus('Загружаю данные OpenStreetMap…', true);
    const { ways, pois } = await loadAll(bbox, signal);
    if (!ways.length) throw new Error('В этой области нет данных о дорогах и тропинках.');
    setStatus('Строю граф и считаю изохроны…', true);
    await tick();
    const g = getGraph(ways);
    const prepared = prepareCategories(g, pois, CATEGORIES.map(c => c.id));
    const report = isochroneReport(g, { lat: latlng.lat, lon: latlng.lng }, prepared, { bands, speedMps: speedMps() });
    if (!report) throw new Error(`Рядом с точкой нет пешеходной сети (ближе ${CONFIG.snap.originM} м). Выберите точку у улицы.`);
    state.iso = { report, bands };
    renderIso();
    const biggest = [...report.isochrones].reverse().find(i => i.geometry);
    if (fit && biggest) map.fitBounds(L.geoJSON(biggest.geometry).getBounds(), { padding: [40, 40], maxZoom: 16 });
    setStatus(`Готово: ${nf(g.lengthKm, 0)} км дорожек и улиц в расчёте.`);
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
      .bindTooltip(`${iso.min} мин · ${nf(iso.areaKm2, 2)} км²`, { sticky: true })
      .addTo(isoGroup);
  });

  const maxMin = Math.max(...bands);
  const cats = activeCatIds();
  for (const id of cats) {
    const cat = CAT_BY_ID[id];
    for (const r of report.cats[id].reached) {
      const [lat, lon] = poiCenter(r.poi);
      L.circleMarker([lat, lon], { pane: 'poi', radius: 6, color: '#fff', weight: 1.5, fillColor: cat.color, fillOpacity: 1 })
        .bindTooltip(`${esc(r.poi.name || cat.label)}<br>${nf(r.minutes, 1)} мин пешком`)
        .addTo(isoGroup);
    }
  }

  const chips = isos.map((iso, i) => `<span class="chip"><i class="sw" style="background:${BAND_COLORS[i]}"></i>${iso.min} мин · ${nf(iso.areaKm2, 2)} км²</span>`).join('');
  const rows = cats.map(id => {
    const c = report.cats[id], cat = CAT_BY_ID[id];
    const counts = bands.map(b => `<td>${c.counts[b] ? `<b>${c.counts[b]}</b>` : '<span class="muted">0</span>'}</td>`).join('');
    const nearest = c.nearest != null ? `${fmtMin(c.nearest)} мин` : `<span class="muted">&gt; ${maxMin} мин</span>`;
    return `<tr><td><span class="dot" style="background:${cat.color}"></span> ${esc(cat.label)}</td>${counts}<td>${nearest}</td></tr>`;
  }).join('');
  const details = cats.map(id => {
    const c = report.cats[id], cat = CAT_BY_ID[id];
    if (!c.reached.length) return '';
    const items = c.reached.slice(0, 8).map((r, i) => {
      const [lat, lon] = poiCenter(r.poi);
      return `<li><button type="button" data-lat="${lat}" data-lon="${lon}">${esc(r.poi.name || 'Без названия')} — ${fmtMin(r.minutes)} мин</button></li>`;
    }).join('');
    return `<details><summary>${esc(cat.label)}: ${c.reached.length}</summary><ul class="poi-list">${items}</ul></details>`;
  }).join('');

  $('#iso-result').innerHTML = `
    <div class="chips">${chips}</div>
    <div class="tbl-wrap"><table><thead><tr><th>Объектов в зоне</th>${bands.map(b => `<th>≤ ${b} мин</th>`).join('')}<th>Ближайший</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="muted">Выберите категории выше</td></tr>'}</tbody></table></div>
    ${details}
    <p class="hint">Старт привязан к ближайшей улице (${Math.round(report.snapM)} м). Скорость ${nf(state.speedKmh, 1)} км/ч, лестницы медленнее.</p>`;
  $('#iso-actions').hidden = false;
  renderIsoLegend();
}

$('#iso-result').addEventListener('click', e => {
  const b = e.target.closest('button[data-lat]');
  if (b) map.flyTo([Number(b.dataset.lat), Number(b.dataset.lon)], 17, { duration: 0.6 });
});
$('#iso-clear').addEventListener('click', () => {
  state.iso = null; state.origin = null;
  if (originMarker) { map.removeLayer(originMarker); originMarker = null; }
  renderIso();
  setStatus('Готово к работе.');
});
$('#iso-export').addEventListener('click', () => {
  if (state.iso) download('isochrones.geojson', JSON.stringify(isochronesToGeoJSON(state.iso.report)), 'application/geo+json');
});

function renderIsoLegend() {
  const el = $('#legend');
  if (state.tab !== 'iso') return;
  if (!state.iso) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '<b>Время пешком</b>' + state.iso.report.isochrones
    .map((iso, i) => `<div class="lrow"><i class="sw" style="background:${BAND_COLORS[i]}"></i>до ${iso.min} мин</div>`).join('');
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
  if (mode.startsWith('grid')) return { groups: makeGridGroups(bbox, Number(mode.slice(4))), note: 'квадраты' };
  let level = Number(mode);
  if (mode === 'auto') {
    setStatus('Ищу административные границы…', true);
    const levels = await listAdminLevels(bbox, { signal });
    const ok = levels.find(l => l.count >= 3 && l.count <= 80);
    if (!ok) return { groups: makeGridGroups(bbox, 1000), note: 'квадраты 1 км (границы районов не найдены)' };
    level = ok.level;
  }
  setStatus(`Загружаю границы районов (admin_level=${level})…`, true);
  const areas = await loadAdminAreas(bbox, level, { signal });
  if (areas.length < 2) return { groups: makeGridGroups(bbox, 1000), note: 'квадраты 1 км (в этой области нет районов нужного уровня)' };
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
    const { bbox, clipped } = analysisBBox();
    areaRect.setBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]).addTo(map);
    const padM = CONFIG.index.worstMin * 60 * speedMps();
    const big = expandBBox(bbox, padM);
    const weightMode = $('#weight-mode').value;
    const { ways, pois, buildings } = await loadAll(big, signal, weightMode === 'buildings' ? bbox : null);
    if (!ways.length) throw new Error('В этой области нет данных о дорогах и тропинках.');
    setStatus('Строю граф пешеходной сети…', true);
    await tick();
    const g = getGraph(ways);
    const prepared = prepareCategories(g, pois, CATEGORIES.map(c => c.id));
    setStatus('Привязываю здания к сети…', true);
    await tick();
    let demand = buildDemand(g, { buildings, mode: weightMode, bbox });
    let usedMode = weightMode;
    if (!demand.n && weightMode === 'buildings') { demand = buildDemand(g, { mode: 'network', bbox }); usedMode = 'network'; }
    if (!demand.n) throw new Error('В выбранной области нет пешеходной сети.');
    const { groups, note } = await pickDistricts(bbox, $('#district-mode').value, signal);
    state.area = { ctx: { g, prepared, demand, groups, bbox, pois, note, clipped, usedMode }, result: null };
    recomputeArea();
    setTab('area');
  } catch (e) { fail(e); } finally { btn.disabled = false; }
}

function recomputeArea() {
  const a = state.area;
  if (!a) return;
  const catIds = activeCatIds();
  if (!catIds.length) { setStatus('Выберите хотя бы одну категорию.', false, true); return; }
  setStatus('Считаю доступность…', true);
  const { g, prepared, demand, groups, bbox } = a.ctx;
  a.result = computeAnalysis({ g, prepared, demand, groups, catIds, bands: parseBands(), speedMps: speedMps(), bbox });
  renderArea();
  const c = a.ctx;
  setStatus(`Готово. Районы: ${c.note}.${c.clipped ? ` Область урезана до ${CONFIG.maxAnalysisSpanKm} км — сдвиньте карту для другого участка.` : ''}`);
}

function renderArea() {
  const { ctx, result } = state.area;
  const maxBand = result.bands[result.bands.length - 1];
  const tot = result.overall;

  const bars = result.catIds.map(id => {
    const v = tot.stats[id].shares[maxBand];
    return `<div class="sharebar"><span><i class="dot" style="background:${CAT_BY_ID[id].color}"></i> ${esc(CAT_BY_ID[id].label)}</span><div class="track"><i style="width:${v}%"></i></div><output>${nf(v, 0)}%</output></div>`;
  }).join('');

  const zones = result.zones.slice(0, 12).map(z => `
    <li><button type="button" data-zone="${z.id}"><span class="badge">${z.id}</span>
      <span>индекс ${nf(z.index, 0)} · ${nf(z.weight / tot.weight * 100, 1)}% спроса · ${nf(z.areaKm2, 2)} км²<br><span class="muted">хуже всего: ${esc(CAT_BY_ID[z.worst].label.toLowerCase())}</span></span></button></li>`).join('');

  $('#area-result').innerHTML = `
    <div class="tiles">
      <div class="tile"><b>${tot.index == null ? '—' : nf(tot.index, 0)}</b><span>индекс доступности, 0–100</span></div>
      <div class="tile"><b>${result.zones.length}</b><span>проблемных зон</span></div>
      <div class="tile"><b>${nf(result.demand.n, 0)}</b><span>${ctx.usedMode === 'buildings' ? 'зданий в расчёте' : 'узлов сети в расчёте'}</span></div>
    </div>
    <div class="h3">Доля жителей в пределах ${maxBand} мин пешком</div>
    <div class="sharebars">${bars}</div>
    <div class="h3">Проблемные зоны</div>
    ${zones ? `<ul class="zones">${zones}</ul>` : '<p class="hint">Зон с индексом ниже ' + CONFIG.index.problemBelow + ' не найдено.</p>'}
    <div class="h3">Сравнение районов
      <select id="metric" aria-label="Показатель"><option value="share" ${state.metric === 'share' ? 'selected' : ''}>Доля ≤ ${maxBand} мин, %</option><option value="median" ${state.metric === 'median' ? 'selected' : ''}>Медиана, мин</option></select>
    </div>
    <div class="tbl-wrap" id="dist-table"></div>
    <p class="hint">Индекс: 100 баллов при ≤ ${CONFIG.index.bestMin} мин до объекта, 0 при ≥ ${CONFIG.index.worstMin} мин, между ними линейно; среднее по выбранным категориям, взвешено по ${ctx.usedMode === 'buildings' ? 'этажности зданий' : 'длине улиц'}. Это прокси, а не перепись населения.</p>
    <div class="actions"><button id="area-csv" class="ghost">Скачать CSV</button><button id="area-geojson" class="ghost">Скачать GeoJSON</button></div>`;
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
      return `<td title="медиана ${fmtMin(s.median)} мин; ${result.bands.map(b => `≤${b}: ${nf(s.shares[b], 0)}%`).join(', ')}">${txt}</td>`;
    }).join('');
    const warn = d.coverage < 0.95 ? ` <span class="warn" title="Район виден лишь на ${nf(d.coverage * 100, 0)}%: показатели посчитаны по видимой части">⚠</span>` : '';
    return `<tr class="click" data-id="${esc(d.id)}"><td>${esc(d.name)}${warn}</td><td class="num-bar"><i style="width:${d.index}%"></i>${nf(d.index, 0)}</td>${cells}</tr>`;
  }).join('');
  $('#dist-table').innerHTML = `<table><thead><tr>${head('name', 'Район')}${head('index', 'Индекс')}${result.catIds.map(id => head(id, esc(CAT_BY_ID[id].label.split(' ')[0]))).join('')}</tr></thead><tbody>${body}</tbody></table>`;
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
      .bindTooltip(`Индекс ${nf(c.index, 0)} · хуже всего: ${esc(CAT_BY_ID[c.worst].label.toLowerCase())}`, { sticky: true })
      .addTo(areaLayers.cells);
  }
  for (const d of result.districts) {
    L.geoJSON(d.geometry, { pane: 'districts', style: { color: '#52514e', weight: 1.6, fill: false } })
      .bindTooltip(`${esc(d.name)}${d.index == null ? '' : ` · индекс ${nf(d.index, 0)}`}`, { sticky: true })
      .addTo(areaLayers.districts);
  }
  for (const z of result.zones) {
    L.geoJSON(z.outline, { pane: 'zones', style: { color: PROBLEM_COLOR, weight: 2.5, fillColor: PROBLEM_COLOR, fillOpacity: 0.08 } })
      .bindTooltip(`Зона ${z.id}: индекс ${nf(z.index, 0)}, хуже всего — ${esc(CAT_BY_ID[z.worst].label.toLowerCase())}`, { sticky: true })
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
      .bindTooltip(esc(p.name || CAT_BY_ID[p.cat].label)).addTo(areaLayers.poi);
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
  const defs = [['cells', 'Индекс по ячейкам 150 м', true], ['districts', 'Границы районов', true], ['zones', 'Проблемные зоны', true], ['poi', 'Объекты', true]];
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
  el.innerHTML = `<b>Индекс доступности</b>
    <div class="scale">${INDEX_STEPS.map(([, c]) => `<i style="background:${c}"></i>`).join('')}</div>
    <div class="ends"><span>0 · плохо</span><span>100 · хорошо</span></div>
    <div class="lrow" style="margin-top:6px"><i class="sw" style="border:2.5px solid ${PROBLEM_COLOR};background:none"></i>проблемная зона (&lt; ${CONFIG.index.problemBelow})</div>`;
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
buildCatsUI();
