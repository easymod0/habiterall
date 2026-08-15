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
 * rather than blocking the queue forever — with two exceptions the server can
 * answer for reasons that have nothing to do with the write. See below.
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

      if (res.status === 401 || res.status === 403) {
        // Neither of these is a verdict on the WRITE, so neither may discard
        // one. 401 is an expired session: keep the queue and let the app prompt
        // for login. 403 is the origin guard, and it is a statement about the
        // deployment — a proxy rewriting Host with no hop trusted makes
        // `req.host` disagree with the browser's Origin, and every write is
        // refused while the misconfiguration lasts. Dropping on it meant the
        // first flush after that silently destroyed every check-off in the
        // outbox, which is the one thing this queue exists to prevent. Fixing
        // the proxy (or TRUST_PROXY) then replays them.
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

/**
 * Call `onChange(online)` when connectivity changes, and once immediately.
 *
 * The browser's `online` event is not enough on its own. It fires for changes
 * to the *network interface*, not to the server, so several ordinary
 * situations would otherwise strand the app in its offline state forever:
 *
 *   - the server restarts while the Wi-Fi never drops
 *   - the Wi-Fi is up but the router has no route, then recovers
 *   - a laptop wakes from sleep, where `online` is unreliable
 *
 * So this also re-probes when the tab becomes visible, and — only while
 * offline — polls with a backoff. The polling stops the moment the server
 * answers, so a healthy app makes no extra requests at all.
 *
 * Which leaves one hole, and it is the one an outage actually falls into: while
 * the watcher believes it is online it makes no requests, and `online` /
 * `offline` / `visibilitychange` none of them fire when the interface is up and
 * only the route is dead. The app's own failed requests are the missing input,
 * so `reportOffline` is returned alongside `stop` — see the note on it.
 *
 * @returns {{stop: () => void, reportOffline: () => void}}
 */
export function watchConnectivity(
  onChange,
  // `initialDelayMs` exists so the tests can exercise several backoff steps
  // in milliseconds rather than tens of seconds.
  { maxDelayMs = 60_000, initialDelayMs = 2000 } = {},
) {
  let timer = null;
  let delay = initialDelayMs;
  let stopped = false;
  let last = null;

  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };

  const emit = async () => {
    if (stopped) return;
    const online = await isReachable();
    clear();

    // Only notify on a real transition, so a poll every few seconds does not
    // re-render the dashboard or re-toast while nothing has changed.
    if (online !== last) {
      last = online;
      onChange(online);
    }

    if (online) {
      delay = initialDelayMs;   // reset for the next outage
    } else {
      // Back off to a minute: a server that has been down for a while is
      // unlikely to return within the next two seconds, and a tight loop on
      // a phone is a battery cost for nothing.
      timer = setTimeout(emit, delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  };

  const goOffline = () => {
    if (last !== false) { last = false; onChange(false); }
    clear();
    delay = initialDelayMs;
    timer = setTimeout(emit, delay);
  };

  // Returning to a backgrounded tab is the most likely moment for the world
  // to have changed underneath it. Named, so the cleanup can remove it —
  // an anonymous listener here would outlive the watcher.
  const onVisible = () => {
    if (document.visibilityState === 'visible') emit();
  };

  window.addEventListener('online', emit);
  window.addEventListener('offline', goOffline);
  document.addEventListener('visibilitychange', onVisible);

  emit();

  return {
    stop: () => {
      stopped = true;
      clear();
      window.removeEventListener('online', emit);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', onVisible);
    },

    /**
     * "A request of ours just failed to reach the server."
     *
     * This is `goOffline` — the same entry point the browser's `offline` event
     * uses — and it must stay that way rather than becoming a `setOffline` from
     * outside. Setting the state behind the watcher's back leaves its own `last`
     * at `true`, so it neither starts polling nor ever reports the transition it
     * has already missed: the banner goes up and stays up until a
     * `visibilitychange` happens to re-probe. Coming in through here reports the
     * transition once and arms the backoff poll, which is what takes the banner
     * back down a second or two after a blip.
     */
    reportOffline: goOffline,
  };
}
