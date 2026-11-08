// Постоянный кэш тайлов Overpass в IndexedDB (в Node и при недоступности IDB — молча отключается).
const DB = 'cityacc-cache', STORE = 'tiles', VERSION = 1;
const TTL_MS = 7 * 24 * 3600 * 1000;
export const cacheStats = { hits: 0, misses: 0, stored: 0 };

let dbPromise;
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}
const wrap = (db, mode, fn) => new Promise(resolve => {
  try {
    const tx = db.transaction(STORE, mode);
    const r = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = tx.onabort = () => resolve(undefined);
  } catch { resolve(undefined); }
});

export async function storeGet(key) {
  const db = await open();
  if (!db) return undefined;
  const rec = await wrap(db, 'readonly', s => s.get(key));
  if (!rec || Date.now() - rec.t > TTL_MS) { cacheStats.misses++; return undefined; }
  cacheStats.hits++;
  return rec.v;
}
export async function storePut(key, value) {
  const db = await open();
  if (!db) return;
  await wrap(db, 'readwrite', s => s.put({ t: Date.now(), v: value }, key));
  cacheStats.stored++;
}
export async function storeClear() {
  const db = await open();
  if (!db) return false;
  await wrap(db, 'readwrite', s => s.clear());
  return true;
}
export async function storeCount() {
  const db = await open();
  if (!db) return 0;
  return (await wrap(db, 'readonly', s => s.count())) || 0;
}
