// Локализация: исходный язык — русский, ключ — русская строка; для en берётся перевод из EN.
// Плейсхолдеры вида {n} подставляются из объекта vars. Нет перевода — показывается русский текст.
import { EN } from './lang-en.js';

let lang = 'ru';
export const getLang = () => lang;
export function setLang(l) { lang = l === 'en' ? 'en' : 'ru'; if (typeof document !== 'undefined') document.documentElement.lang = lang; }
export const locale = () => (lang === 'en' ? 'en-US' : 'ru-RU');

export function _(key, vars) {
  let s = lang === 'en' ? (EN[key] ?? key) : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  return s;
}

/** Определение языка: ?l=en / хэш l=en → сохранённый выбор → язык браузера. */
export function detectLang() {
  try {
    const h = new URLSearchParams((globalThis.location?.hash || '').slice(1)).get('l');
    if (h === 'en' || h === 'ru') return h;
    const saved = globalThis.localStorage?.getItem('cityacc.lang');
    if (saved === 'en' || saved === 'ru') return saved;
    return /^ru|^uk|^be|^kk/i.test(globalThis.navigator?.language || 'ru') ? 'ru' : 'en';
  } catch { return 'ru'; }
}
export function saveLang(l) { try { globalThis.localStorage?.setItem('cityacc.lang', l); } catch { /* ignore */ } }

/** Переводит статическую разметку: текстовые узлы, placeholder/title/aria-label, блоки data-i18n-html. */
export function translateDom(root) {
  if (lang !== 'en') return;
  const norm = s => s.replace(/\s+/g, ' ').trim();
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    const k = norm(el.innerHTML);
    if (EN[k]) el.innerHTML = EN[k];
    el.removeAttribute('data-i18n-html');
  }
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (w.nextNode()) nodes.push(w.currentNode);
  for (const n of nodes) {
    const k = norm(n.nodeValue);
    if (k && EN[k]) { const v = n.nodeValue; n.nodeValue = v.slice(0, v.length - v.trimStart().length) + EN[k].trim() + v.slice(v.trimEnd().length); }
  }
  for (const el of root.querySelectorAll('[placeholder],[title],[aria-label]')) {
    for (const a of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v && EN[norm(v)]) el.setAttribute(a, EN[norm(v)]);
    }
  }
}
