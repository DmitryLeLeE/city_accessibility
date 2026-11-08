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
  snap: { poiM: 150, buildingM: 200, originM: 300 },

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
