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
// Задержки — ожидаемые (средние) секунды, не зависят от скорости ходьбы.
// Индексы массивов — ранг дороги для машин:
//   0 пешеходный путь | 1 service/living_street | 2 residential/unclassified
//   3 tertiary | 4 secondary | 5 primary | 6 trunk
export const WALK = {
  // Ожидание при переходе дороги соответствующего ранга, с
  signalWait:    [0, 10, 20, 22, 28, 32, 38], // светофор: среднее ожидание зелёной фазы
  zebraWait:     [0, 1, 2, 3, 5, 7, 10],      // «зебра» без светофора: ожидание просвета/уступания
  unmarkedWait:  [0, 1, 2, 5, 10, 16, 24],    // переход без разметки/перекрёсток без данных
  markedFactor: 0.7,                          // размеченный, но нерегулируемый: unmarked × 0.7
  multiLaneFactor: 1.3,                       // ≥ 4 полос без светофора ждать дольше
  gateDelay: 4,                               // калитка, шлагбаум, турникет, с

  // Поворот на перекрёстке с одной дороги на другую: в среднем ½ перехода
  turnCrossingShare: 0.5,
  straightMaxDeg: 35,     // отклонение, до которого движение считается «прямо»
  crossLegMinDeg: 30,     // боковая улица — ветка под углом > 30° к направлению движения

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
