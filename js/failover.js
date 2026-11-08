// Отказоустойчивые запросы: перебор зеркал, таймаут на попытку, «охлаждение» упавших зеркал,
// повторные раунды с нарастающей паузой. Без зависимостей от браузера — проверяется в Node.

import { _ } from './i18n.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/** Состояние здоровья зеркал: успешное — вперёд, упавшее — в «карантин» с растущим сроком. */
export class MirrorPool {
  constructor(urls, { baseCooldownMs = 15000, maxCooldownMs = 300000, now = () => Date.now() } = {}) {
    this.urls = [...urls];
    this.st = new Map(this.urls.map(u => [u, { fails: 0, until: 0, ok: 0 }]));
    this.baseCooldownMs = baseCooldownMs; this.maxCooldownMs = maxCooldownMs; this.now = now;
  }
  /** Сначала здоровые (чаще успешные — раньше), затем те, что в карантине (раньше всех — у кого карантин кончается). */
  order() {
    const t = this.now();
    const healthy = this.urls.filter(u => this.st.get(u).until <= t).sort((a, b) => this.st.get(b).ok - this.st.get(a).ok);
    const cooling = this.urls.filter(u => this.st.get(u).until > t).sort((a, b) => this.st.get(a).until - this.st.get(b).until);
    return [...healthy, ...cooling];
  }
  success(u) { const s = this.st.get(u); s.fails = 0; s.until = 0; s.ok++; }
  failure(u) {
    const s = this.st.get(u);
    s.fails++;
    s.until = this.now() + Math.min(this.maxCooldownMs, this.baseCooldownMs * 2 ** (s.fails - 1));
  }
  reset() { for (const s of this.st.values()) { s.fails = 0; s.until = 0; s.ok = 0; } }
}

/**
 * Выполняет запрос, пробуя зеркала по очереди; если упали все — пауза и новый раунд.
 * @param pool MirrorPool
 * @param attempt async (url, signal) => result; бросает ошибку при сбое (HTTP, разбор, ремарка сервера)
 * @param opts { signal, rounds=3, timeoutMs=70000, backoffMs=1200, onEvent(msg), sleepFn }
 */
export async function withFailover(pool, attempt, { signal, rounds = 3, timeoutMs = 70000, backoffMs = 1200, onEvent, sleepFn = sleep } = {}) {
  const errors = [];
  for (let round = 0; round < rounds; round++) {
    const urls = pool.order();
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
      try {
        const res = await attempt(url, ctl.signal);
        pool.success(url);
        if (errors.length) onEvent?.(_('сервер {h} ответил после {n} неудачных попыток', { h: host(url), n: errors.length }));
        return res;
      } catch (e) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const why = timedOut ? _('таймаут {s} с', { s: Math.round(timeoutMs / 1000) }) : (e?.message || String(e));
        errors.push(`${host(url)}: ${why}`);
        pool.failure(url);
        const next = urls[i + 1];
        onEvent?.(_('сервер {h} недоступен ({why})', { h: host(url), why }) + (next ? _(', пробую {n}', { n: host(next) }) : ''));
        if (e?.retryAfterMs) await sleepFn(Math.min(e.retryAfterMs, 8000), signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    if (round < rounds - 1) {
      onEvent?.(_('все серверы не ответили, повтор через {s} с', { s: ((backoffMs * (round + 1)) / 1000).toFixed(1) }));
      await sleepFn(backoffMs * (round + 1), signal);
    }
  }
  const err = new Error(_('Серверы данных недоступны ({list})', { list: errors.slice(-pool.urls.length).join('; ') }));
  err.errors = errors;
  throw err;
}

const host = u => { try { return new URL(u).host; } catch { return u; } };

/** Ошибка HTTP с учётом Retry-After (429/503). */
export function httpError(res) {
  const e = new Error('HTTP ' + res.status);
  const ra = Number(res.headers?.get?.('Retry-After'));
  if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = ra * 1000;
  return e;
}
