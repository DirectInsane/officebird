// Per-domain icon cache with TTL, over a pluggable key/value store.

export const POSITIVE_TTL_MS = 30 * 864e5;
export const NEGATIVE_TTL_MS = 7 * 864e5;

export function isFresh(entry, now) {
  if (!entry) {
    return false;
  }
  const ttl = entry.dataUrl ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
  return now - entry.fetchedAt < ttl;
}

export function memoryStore() {
  const map = new Map();
  return {
    async get(key) { return map.get(key); },
    async set(key, value) { map.set(key, value); },
    async clear() { map.clear(); },
  };
}

export function idbStore(dbName = "qol", storeName = "icons") {
  const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function run(mode, fn) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  return {
    get: key => run("readonly", store => store.get(key)),
    set: (key, value) => run("readwrite", store => store.put(value, key)),
    clear: () => run("readwrite", store => store.clear()),
  };
}

export class IconCache {
  constructor(store, now = Date.now) {
    this.store = store;
    this.now = now;
  }

  async get(domain) {
    const entry = await this.store.get(domain);
    if (!isFresh(entry, this.now())) {
      return undefined;
    }
    return { dataUrl: entry.dataUrl, source: entry.source };
  }

  async put(domain, dataUrl, source) {
    await this.store.set(domain, { dataUrl, source, fetchedAt: this.now() });
  }

  async clear() {
    await this.store.clear();
  }
}
