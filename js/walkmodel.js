// Модель пешехода: множители времени по тегам пути и задержки на узлах.
// Все числа — в config.js (WALK), здесь только логика.

import { WALK } from './config.js';

export const F_SIGNAL = 1, F_ZEBRA = 2, F_MARKED = 4, F_GATE = 8, F_BLOCKED = 16;

const RANK = {
  service: 1, living_street: 1,
  unclassified: 2, residential: 2, road: 2,
  tertiary: 3, tertiary_link: 3, secondary: 4, secondary_link: 4,
  primary: 5, primary_link: 5, trunk: 6, trunk_link: 6,
};

const first = v => (v == null ? undefined : String(v).split(';')[0].trim());

/** Скорость по формуле Тоблера (км/ч) для уклона s (доля). */
const tobler = s => 6 * Math.exp(-3.5 * Math.abs(s + 0.05));

/** Множитель времени за уклон: среднее по подъёму и спуску (направление пути не известно). */
export function inclineFactor(s) {
  s = Math.abs(s);
  return Math.min(3, (tobler(0) / tobler(s) + tobler(0) / tobler(-s)) / 2);
}

export function parseIncline(v) {
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(%|°)?\s*$/.exec(String(v ?? ''));
  if (!m) return null;
  const x = parseFloat(m[1].replace(',', '.'));
  return m[2] === '°' ? Math.tan((x * Math.PI) / 180) : x / 100;
}

/** @returns {rank, lanes, factor} для пути OSM. */
export function wayModel(tags = {}) {
  const hw = tags.highway;
  let rank = RANK[hw] ?? 0;
  const service = tags.service;
  if (hw === 'service' && (service === 'parking_aisle' || service === 'driveway' || service === 'drive-through')) rank = 0;
  const lanes = Math.min(parseInt(tags.lanes, 10) || 0, 20);

  let f = 1;
  if (hw === 'steps') {
    f *= WALK.stepsFactor;
  } else {
    const surf = first(tags.surface);
    f *= surf ? (WALK.surface[surf] ?? 1.15) : (WALK.unpavedDefault[hw] ?? 1);
    const sm = first(tags.smoothness);
    if (sm) f *= WALK.smoothness[sm] ?? 1;
  }

  if (rank >= 3) {
    const sw = [tags.sidewalk, tags['sidewalk:both'], tags['sidewalk:left'], tags['sidewalk:right']].map(first).filter(Boolean);
    if (sw.includes('separate')) f *= WALK.separateSidewalkFactor;
    else if (sw.length && sw.every(v => v === 'no' || v === 'none')) f *= WALK.noSidewalkFactor[rank] ?? 1;
    else if (!sw.length) f *= WALK.unknownSidewalkFactor[rank] ?? 1;
  }

  const inc = parseIncline(tags.incline);
  if (inc != null) f *= inclineFactor(inc);
  return { rank, lanes, factor: f };
}

const GATES = new Set(['gate', 'lift_gate', 'swing_gate', 'turnstile', 'stile', 'kissing_gate', 'toll_booth', 'chain', 'cycle_barrier']);

/** Битовые флаги узла по его тегам (переход, светофор, калитка). */
export function nodeFlags(tags = {}) {
  let fl = 0;
  const cr = tags.crossing;
  if (tags.highway === 'traffic_signals' || cr === 'traffic_signals' || tags['crossing:signals'] === 'yes') fl |= F_SIGNAL;
  else if (cr === 'zebra' || cr === 'marked' || tags.crossing_ref === 'zebra' || tags['crossing:markings'] === 'zebra') fl |= F_ZEBRA;
  else if (tags.highway === 'crossing' && cr !== 'unmarked') fl |= F_MARKED;
  if (GATES.has(tags.barrier)) {
    fl |= (tags.access === 'no' || tags.access === 'private' || tags.foot === 'no' || tags.foot === 'private') ? F_BLOCKED : F_GATE;
  }
  return fl;
}

/** Среднее ожидание при переходе дороги ранга rank (секунды). */
export function crossWait(flags, rank, lanes) {
  let w;
  if (flags & F_SIGNAL) return WALK.signalWait[rank];
  if (flags & F_ZEBRA) w = WALK.zebraWait[rank];
  else if (flags & F_MARKED) w = WALK.unmarkedWait[rank] * WALK.markedFactor;
  else w = WALK.unmarkedWait[rank];
  if (rank >= 3 && lanes >= 4) w *= WALK.multiLaneFactor;
  return w;
}
