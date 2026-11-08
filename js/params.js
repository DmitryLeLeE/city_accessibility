// Сохранение пользовательских параметров модели в localStorage + сброс кэшей, зависящих от них.
import { applyParams, getParams, resetParams } from './config.js';
import { resetWalkCache } from './walkmodel.js';

const KEY = 'cityacc.params.v1';
const safe = fn => { try { return fn(); } catch { return null; } };

/** Загружает сохранённые параметры (если есть). */
export function loadSavedParams() {
  const raw = safe(() => globalThis.localStorage?.getItem(KEY));
  if (!raw) return false;
  const p = safe(() => JSON.parse(raw));
  const ch = p ? applyParams(p) : false;
  if (ch) resetWalkCache();
  return ch;
}
/** Применяет параметры, сохраняет их. true — граф нужно пересобрать. */
export function setParams(p) {
  const ch = applyParams(p);
  if (ch) { resetWalkCache(); safe(() => globalThis.localStorage?.setItem(KEY, JSON.stringify(getParams()))); }
  return ch;
}
export function restoreDefaults() {
  const ch = resetParams();
  resetWalkCache();
  safe(() => globalThis.localStorage?.removeItem(KEY));
  return ch;
}
