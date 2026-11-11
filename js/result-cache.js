// 検索結果のキャッシュ（IndexedDB）。使えない環境では何もしない
const DB_NAME = 'tcs-cache';
const STORE = 'entries';
const MAX_ENTRIES = 40;   // 古いものから消す

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then((db) => new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result ?? null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

/** 期限内なら値を返す。期限切れ・無しなら null */
export async function cacheGet(key) {
  const rec = await run('readonly', (s) => s.get(key));
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    run('readwrite', (s) => s.delete(key));
    return null;
  }
  return rec.value;
}

/** ttlMs の間だけ保存する */
export async function cacheSet(key, value, ttlMs) {
  const now = Date.now();
  await run('readwrite', (s) => s.put({ value, savedAt: now, expiresAt: now + ttlMs }, key));
  prune();
}

/** 期限切れを消し、件数が多ければ古いものから消す */
async function prune() {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const live = [];
    const now = Date.now();
    store.openCursor().onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur) {
        live.sort((a, b) => b.savedAt - a.savedAt);
        for (const { key } of live.slice(MAX_ENTRIES)) store.delete(key);
        return;
      }
      if (cur.value.expiresAt < now) cur.delete();
      else live.push({ key: cur.key, savedAt: cur.value.savedAt });
      cur.continue();
    };
  } catch { /* ignore */ }
}
