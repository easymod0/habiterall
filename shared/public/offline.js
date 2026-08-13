/**
 * Offline write queue ("outbox") and connectivity state.
 *
 * When a write fails because the device is offline, it is persisted to
 * IndexedDB and replayed — in submission order — once connectivity returns.
 * Order matters: toggling a habit done then skipped must not land reversed.
 *
 * Deliberately NOT in the service worker: the SW cannot update the page's
 * optimistic state, and Background Sync is unavailable on iOS. Replaying from
 * the page keeps one code path on every platform.
 */

const DB_NAME = 'habiterall-offline';
const DB_VERSION = 1;
const STORE = 'outbox';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // autoIncrement gives us submission order for free.
        db.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/* ---------- queue operations ---------- */

/** Persist a write for later. Returns the queue length. */
export async function enqueue(entry) {
  await tx('readwrite', (store) => store.add({
    ...entry,
    queuedAt: Date.now(),
  }));
  return pendingCount();
}

export function pending() {
  return tx('readonly', (store) => store.getAll());
}

export async function pendingCount() {
  const all = await pending();
  return all.length;
}

export function clearAll() {
  return tx('readwrite', (store) => store.clear());
}

function remove(seq) {
  return tx('readwrite', (store) => store.delete(seq));
}

/* ---------- replay ---------- */

let flushing = false;

/**
 * Replay queued writes oldest-first.
 *
 * Stops at the first network failure so ordering is preserved — a later write
 * must never overtake an earlier one. A 4xx means the request will never
 * succeed (deleted habit, stale payload), so it is dropped and reported
 * rather than blocking the queue forever.
 *
 * @returns {Promise<{sent:number, failed:Array, remaining:number}>}
 */
export async function flush() {
  if (flushing) return { sent: 0, failed: [], remaining: await pendingCount() };
  flushing = true;

  const sent = [];
  const failed = [];

  try {
    const queued = (await pending()).sort((a, b) => a.seq - b.seq);

    for (const item of queued) {
      let res;
      try {
        res = await fetch(item.url, {
          method: item.method,
          headers: item.headers ?? { 'Content-Type': 'application/json' },
          body: item.body,
          credentials: 'same-origin',
        });
      } catch {
        break; // still offline; keep this and everything after it
      }

      if (res.ok || res.status === 404) {
        // 404: the target is gone, so the write can never apply. Drop it.
        await remove(item.seq);
        sent.push(item);
        continue;
      }

      if (res.status === 401) {
        // Session expired. Keep the queue and let the app prompt for login.
        break;
      }

      if (res.status >= 400 && res.status < 500) {
        await remove(item.seq);
        failed.push({ item, status: res.status });
        continue;
      }

      break; // 5xx — server trouble, retry later
    }
  } finally {
    flushing = false;
  }

  return { sent: sent.length, failed, remaining: await pendingCount() };
}

/* ---------- connectivity ---------- */

/**
 * `navigator.onLine` only reports whether an interface exists, not whether
 * the server is reachable, so treat it as a hint and confirm with a probe.
 */
export async function isReachable(url = '/healthz', timeoutMs = 4000) {
  if (navigator.onLine === false) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { method: 'GET', cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Call `onChange(online)` when connectivity changes, and once immediately. */
export function watchConnectivity(onChange) {
  const emit = async () => onChange(await isReachable());
  window.addEventListener('online', emit);
  window.addEventListener('offline', () => onChange(false));
  emit();
  return () => {
    window.removeEventListener('online', emit);
    window.removeEventListener('offline', emit);
  };
}
