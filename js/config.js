// Все настройки и список категорий объектов — в одном месте.
// Чтобы добавить категорию, достаточно дописать объект в CATEGORIES.

export const CONFIG = {
  // Стартовый вид карты (можно сменить на любой город или искать через поле поиска)
  defaultCenter: [51.5336, 46.0343],
  defaultZoom: 13,

  speedKmh: 4.8,          // средняя скорость пешехода
  bands: [5, 10, 15],     // изохроны, минуты

  // Размер тайла загрузки данных в градусах (≈3.3 км × 2.1–3 км)
  tile: { lat: 0.03, lon: 0.045 },
  concurrency: 3,         // одновременных запросов к Overpass
  maxAnalysisSpanKm: 8,   // максимальная сторона области анализа

  overpass: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ],
  nominatim: 'https://nominatim.openstreetmap.org/search',

  graph: {
    maxSegmentM: 40,       // рёбра длиннее делятся — точнее привязка и контуры
    minComponentNodes: 25, // мелкие изолированные острова сети отбрасываются
    stepsPenalty: 1.5,     // лестницы «длиннее» в 1.5 раза
  },
  // offNetworkFactor: путь от точки до сети идёт по дворам/траве — медленнее, чем по тротуару
  snap: { poiM: 150, buildingM: 200, originM: 300, offNetworkFactor: 1.25 },

  // Индекс доступности: ≤ bestMin → 100 баллов, ≥ worstMin → 0, между — линейно
  index: { bestMin: 5, worstMin: 20, problemBelow: 35 },
  fieldMaxMin: 30,         // дальше этого времени объект считается недоступным
  gridCellM: 150,          // ячейка карты проблемных зон
};

// match() должен совпадать с Overpass-фильтрами filters.
export const CATEGORIES = [
  {
    id: 'hospital', label: 'Больницы и поликлиники', color: '#e34948', glyph: '+',
    default: true, kind: 'point',
    filters: ['["amenity"~"^(hospital|clinic)$"]'],
    match: t => t.amenity === 'hospital' || t.amenity === 'clinic',
  },
  {
    id: 'school', label: 'Школы', color: '#eb6834', glyph: 'Ш',
    default: true, kind: 'point',
    filters: ['["amenity"="school"]'],
    match: t => t.amenity === 'school',
  },
  {
    id: 'park', label: 'Парки и скверы', color: '#008300', glyph: 'П',
    default: true, kind: 'area',
    filters: ['["leisure"~"^(park|garden)$"]["access"!~"^(private|no)$"]'],
    match: t => (t.leisure === 'park' || t.leisure === 'garden') && t.access !== 'private' && t.access !== 'no',
  },
  {
    id: 'pharmacy', label: 'Аптеки', color: '#e87ba4', glyph: 'А',
    default: false, kind: 'point',
    filters: ['["amenity"="pharmacy"]'],
    match: t => t.amenity === 'pharmacy',
  },
  {
    id: 'kindergarten', label: 'Детские сады', color: '#1baf7a', glyph: 'Д',
    default: false, kind: 'point',
    filters: ['["amenity"="kindergarten"]'],
    match: t => t.amenity === 'kindergarten',
  },
  {
    id: 'grocery', label: 'Продуктовые магазины', color: '#eda100', glyph: 'М',
    default: false, kind: 'point',
    filters: ['["shop"~"^(supermarket|convenience|grocery|greengrocer)$"]'],
    match: t => ['supermarket', 'convenience', 'grocery', 'greengrocer'].includes(t.shop),
  },
  {
    id: 'transit', label: 'Остановки транспорта', color: '#6250d6', glyph: 'Т',
    default: false, kind: 'point',
    filters: ['["highway"="bus_stop"]', '["railway"="tram_stop"]', '["railway"="subway_entrance"]'],
    match: t => t.highway === 'bus_stop' || t.railway === 'tram_stop' || t.railway === 'subway_entrance',
  },
];

// Палитры (одна гамма для карты и таблицы)
export const BAND_COLORS = ['#184f95', '#256abf', '#5598e7', '#86b6ef']; // тёмный → светлый
export const INDEX_STEPS = [ // нижняя граница индекса → цвет
  [0, '#cde2fb'], [20, '#9ec5f4'], [35, '#6da7ec'], [50, '#3987e5'], [65, '#1c5cab'], [80, '#0d366b'],
];
export const PROBLEM_COLOR = '#e34948';

// ── Модель времени пешехода ─────────────────────────────────────────────────
// Время = длина × множитель(тип пути, покрытие, уклон) / скорость + задержки на узлах.
// Задержки — математические ожидания, считаются по классическим формулам теории транспортных
// потоков из параметров ниже (см. docs/METHODOLOGY.md); от скорости ходьбы не зависят.
// Индексы массивов — ранг дороги для машин:
//   0 пешеходный путь | 1 service/living_street | 2 residential/unclassified
//   3 tertiary | 4 secondary | 5 primary | 6 trunk

/** Среднее ожидание пешехода у светофора, с. Вебстер/HCM: d = (C − g)² / (2C), равномерное прибытие. */
export const websterWait = (cycleS, pedGreenS) => (cycleS - pedGreenS) ** 2 / (2 * cycleS);

/**
 * Среднее ожидание приемлемого интервала в потоке машин, с (формула Адамса):
 * d = (e^(λ·tc) − λ·tc − 1) / λ, где λ — интенсивность потока (авт/с), tc — критический интервал, с.
 * Пуассоновский поток, пешеход принимает интервал ≥ tc.
 */
export const adamsWait = (flowPerHour, criticalGapS) => {
  const lambda = flowPerHour / 3600;
  if (lambda <= 0) return 0;
  const x = lambda * criticalGapS;
  return (Math.exp(x) - x - 1) / lambda;
};

export const WALK = {
  // --- светофоры: длительность цикла C и пешеходной зелёной фазы g (с) по рангу дороги
  signalCycle: [0, 40, 60, 75, 90, 100, 110],
  signalGreen: [0, 12, 15, 15, 15, 15, 15],

  // --- нерегулируемый переход: ширина проезжей части (м), поток обоих направлений (авт/ч)
  roadWidth: [0, 4, 6, 7, 9, 12, 14],
  roadFlow:  [0, 30, 150, 400, 700, 1000, 1500],
  laneWidth: 3.25,          // если в OSM указан lanes — ширина = lanes × laneWidth
  crossSpeed: 1.2,          // расчётная скорость пешехода при переходе, м/с (HCM)
  startUpLoss: 3,           // потерянное время на старт, с (HCM)
  // Переход идёт по половине ширины навстречу потоку одного направления, затем второй половине:
  // d = 2 · Адамс(q/2, tc), tc = (w/2)/v + t_start

  zebraYield: 0.6,          // доля водителей, уступающих на «зебре» (ожидание × (1 − yield), не меньше 1 с)
  markedFactor: 0.7,        // размеченный нерегулируемый переход: ожидание × 0.7
  gateDelay: 4,             // калитка, шлагбаум, турникет, с

  stepsFactor: 1.8,
  surface: {
    asphalt: 1, concrete: 1, paved: 1, metal: 1, 'concrete:plates': 1.05, 'concrete:lanes': 1.05,
    paving_stones: 1.05, wood: 1.05, sett: 1.15, grass_paver: 1.15, compacted: 1.1, fine_gravel: 1.15,
    cobblestone: 1.2, gravel: 1.3, pebblestone: 1.3, unpaved: 1.25, unhewn_cobblestone: 1.35,
    dirt: 1.35, earth: 1.35, ground: 1.35, grass: 1.4, mud: 1.7, sand: 1.7, snow: 1.8, ice: 1.8,
  },
  unpavedDefault: { track: 1.15, path: 1.05 }, // если surface не указан
  smoothness: { excellent: 1, good: 1, intermediate: 1.05, bad: 1.3, very_bad: 1.5, horrible: 1.7, very_horrible: 2, impassable: 3 },

  // Ходьба по проезжей части без тротуара
  noSidewalkFactor: { 3: 1.2, 4: 1.3, 5: 1.4, 6: 1.4 },
  unknownSidewalkFactor: { 5: 1.15, 6: 1.15 }, // тега sidewalk нет на крупной дороге
  separateSidewalkFactor: 1.1,                  // тротуар нарисован отдельно — предпочитаем его
};

/** Нерегулируемое ожидание для дороги ранга rank; lanes — число полос из OSM (0 — неизвестно). */
export function unsignalizedWait(rank, lanes = 0) {
  if (!rank) return 0;
  const w = lanes > 0 ? lanes * WALK.laneWidth : WALK.roadWidth[rank];
  const tc = w / 2 / WALK.crossSpeed + WALK.startUpLoss;
  return 2 * adamsWait(WALK.roadFlow[rank] / 2, tc);
}

// Производные таблицы по рангам (используются там, где число полос неизвестно)
export function recomputeWalk() {
  WALK.signalWait = WALK.signalCycle.map((c, r) => (r ? websterWait(c, WALK.signalGreen[r]) : 0));
  WALK.unmarkedWait = WALK.roadWidth.map((_, r) => unsignalizedWait(r));
  WALK.zebraWait = WALK.unmarkedWait.map((w, r) => (r ? Math.max(1, w * (1 - WALK.zebraYield)) : 0));
}
recomputeWalk();

/** Редактируемые параметры модели (то, что можно менять в интерфейсе). Массивы — по рангам 0..6. */
export const EDITABLE = ['signalCycle', 'signalGreen', 'roadWidth', 'roadFlow', 'crossSpeed', 'startUpLoss', 'zebraYield', 'markedFactor', 'gateDelay', 'stepsFactor'];
export const DEFAULT_PARAMS = JSON.parse(JSON.stringify(Object.fromEntries(EDITABLE.map(k => [k, WALK[k]]))));
export const getParams = () => JSON.parse(JSON.stringify(Object.fromEntries(EDITABLE.map(k => [k, WALK[k]]))));
/** Применяет набор параметров (частичный), пересчитывает таблицы. Возвращает true, если что-то изменилось. */
export function applyParams(p) {
  let changed = false;
  for (const k of EDITABLE) {
    if (!p || p[k] === undefined) continue;
    const v = Array.isArray(DEFAULT_PARAMS[k])
      ? (Array.isArray(p[k]) && p[k].length === DEFAULT_PARAMS[k].length ? p[k].map(Number) : null)
      : Number(p[k]);
    if (v === null || (Array.isArray(v) ? v.some(x => !Number.isFinite(x) || x < 0) : !Number.isFinite(v) || v < 0)) continue;
    if (JSON.stringify(v) !== JSON.stringify(WALK[k])) { WALK[k] = v; changed = true; }
  }
  if (changed) recomputeWalk();
  return changed;
}
export const resetParams = () => applyParams(DEFAULT_PARAMS);
export const paramsAreDefault = () => JSON.stringify(getParams()) === JSON.stringify(DEFAULT_PARAMS);
