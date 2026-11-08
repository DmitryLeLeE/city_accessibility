// Сохранённые расчёты для сравнения (localStorage). Хранится компактная сводка, не геометрия.
const KEY = 'cityacc.saved.v1';
const MAX = 20;

const store = () => { try { return globalThis.localStorage; } catch { return null; } };

export function loadSaved(st = store()) {
  try { const a = JSON.parse(st?.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

function persist(list, st) { try { st?.setItem(KEY, JSON.stringify(list)); } catch { /* квота — не критично */ } return list; }

/** entry: {name, ts, speedKmh, bands, mode, scenario, summary}. Новые — в начало, не более MAX. */
export function addSaved(entry, st = store()) {
  const list = loadSaved(st);
  list.unshift({ id: `${entry.ts}-${Math.random().toString(36).slice(2, 6)}`, ...entry });
  return persist(list.slice(0, MAX), st);
}

export function removeSaved(id, st = store()) { return persist(loadSaved(st).filter(e => e.id !== id), st); }
export function clearSaved(st = store()) { return persist([], st); }

const q = v => `"${String(v).replace(/"/g, '""')}"`;

/** CSV таблицы сравнения; catLabels: {id: подпись}. */
export function savedToCSV(list, catLabels, head) {
  const ids = [...new Set(list.flatMap(e => Object.keys(e.summary.cats)))];
  const cols = [head.name, head.date, head.speed, head.index, head.zones, ...ids.map(i => `${catLabels[i] || i}, ${head.share}`)];
  const rows = list.map(e => [q(e.name), new Date(e.ts).toISOString().slice(0, 16).replace('T', ' '), e.speedKmh,
    e.summary.index == null ? '' : e.summary.index.toFixed(1), e.summary.zones,
    ...ids.map(i => (e.summary.cats[i] ? e.summary.cats[i].share.toFixed(1) : ''))]);
  return '﻿' + [cols.map(q).join(','), ...rows.map(r => r.join(','))].join('\n');
}
