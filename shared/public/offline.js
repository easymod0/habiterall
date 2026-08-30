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

/**
 * Persist a write. Returns its `seq`, which is also its replay order.
 *
 * The seq is the return value because `api()` stages a write BEFORE attempting
 * it and needs to take it back out again once the server has answered — see
 * the enqueue-first note there. Nothing else uses it; `pendingCount()` is a
 * call away for callers that want the length.
 */
export async function enqueue(entry) {
  return tx('readwrite', (store) => store.add({
    ...entry,
    queuedAt: Date.now(),
  }));
}

/** Take a staged write back out, by the `seq` `enqueue` returned. */
export function unstage(seq) {
  return remove(seq);
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

/* ---------- talking to the server ---------- */

/**
 * Tell the server which clock this device is on.
 *
 * A header on requests that already happen, rather than a call of its own —
 * the whole point is that following your zone costs no extra traffic. ~30 bytes
 * on each request; the server compares it to what it holds and writes only when
 * it differs, which for a settled account is never.
 *
 * It is read for two things, and the second is why this lives HERE rather than
 * beside the live `fetch` in `ui/api.js`. The first is a server-sent reminder
 * for an account whose `notifyTimezone` is `auto` (see `resolveTimeZone` in
 * shared/src/notify.js). The second is what day the CALLER is on, which every
 * route that asks "is this today?" now judges by — so a request that omits this
 * is judged by the container's clock, which is UTC in both compose files.
 *
 * A replayed write is such a request. `flush()` below rebuilds it from the
 * queued record, and the record holds a url, a method and a body — so before
 * this, a check-off tapped offline east of the server came back with no zone
 * on it, was refused as a future date, and was DELETED from the queue as
 * permanently inapplicable. The window is every hour between the user's local
 * midnight and the server's: thirteen hours a day at UTC+13.
 *
 * Silent on a runtime that will not answer: this is an optimisation of the
 * default, never a requirement.
 */
export function deviceClockHeader() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? { 'X-Habiterall-Timezone': zone } : {};
  } catch {
    return {};
  }
}

/* ---------- reading your own writes ---------- */

/**
 * How long after a write this client asks a read to skip a server-side cache.
 *
 * Cloud memoises `/overview` per PROCESS and clears that memo when a write
 * arrives — which is one process's memo, cleared by the process that took the
 * write. On two replicas a tap balanced to A and the refetch behind it balanced
 * to B is served B's own pre-tap answer, and the invalidation A ran cannot
 * reach it. This header is what makes the refetch say so, and it costs a
 * recomputation rather than a round trip: no version to fetch, no shared cache
 * to coordinate, nothing for the server to remember.
 *
 * Longer than cloud's `OVERVIEW_TTL_MS` (2s) ON PURPOSE, and that is the whole
 * argument for the number. Any entry a replica holds that predates this write
 * has expired by the time the window closes, so "bypass while the window is
 * open" and "no stale entry can exist after it" meet with a second to spare.
 * A shorter window than the TTL would leave a gap that reads as the original
 * bug; a much longer one would only cost this client hits it could have had.
 *
 * A DURATION, so it is measured on `performance.now()` rather than the wall
 * clock: a device that resyncs its clock mid-window would otherwise either
 * bypass the cache for hours or close the window early, and the second of
 * those is the one that loses a tap.
 */
const FRESH_AFTER_WRITE_MS = 3_000;

/**
 * The header itself, spelled once here rather than inline at the return below.
 *
 * Three copies exist — this one, `FRESH_HEADER` in `habiterall-cloud/src/api.js`
 * and the Kotlin one in `Api.kt` — because the browser cannot import the
 * server's module and the phone cannot import either, exactly as
 * `DEVICE_ZONE_HEADER` already is. A NAMED constant on all three sides is what
 * lets both drift guards (`habiterall-cloud/test/cache.test.js` and
 * `AppSettingsDefaultsTest`) read a declaration rather than pattern-match the
 * place it happens to be used.
 */
const FRESH_HEADER = 'X-Habiterall-Fresh';

/** Monotonic where there is one; the wall clock is the fallback, not the rule. */
const monotonic = () =>
  (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

let lastWriteAt = -Infinity;

/**
 * Note that this client has written something the server may not have shown it.
 *
 * Called for every write that gets an ANSWER, whatever the status, for the same
 * reason cloud's invalidation middleware is unconditional on status: a write
 * that failed halfway through still changed what it may have changed. Called
 * from both write paths — `api()` and `flush()`'s replay below — because a
 * replayed check-off is a write the dashboard has to show as much as a live one
 * is, and the outbox drains straight into a refresh.
 */
export function noteWrite() {
  lastWriteAt = monotonic();
}

/**
 * The "do not serve me a cached answer" header, while this client has a write
 * the server may not have caught up with.
 *
 * A HINT and not a rule: a server is free to ignore it, and the worst a client
 * that sent it on every request could do to itself is get the behaviour every
 * client had before the memo existed, under the same read limiter that bounded
 * it then. That is why it needs no signature and is not a mirror of anything —
 * nothing offline depends on it, and a wrong answer here costs a recomputation.
 */
export function freshnessHeader() {
  return monotonic() - lastWriteAt < FRESH_AFTER_WRITE_MS
    ? { [FRESH_HEADER]: '1' }
    : {};
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
          // The zone is read NOW rather than stored on the queued record, and
          // that is the difference between one rule and three: `api()` stages
          // every replayable write and `ui/settings.js` enqueues one directly,
          // so a header captured at submission would have to be captured at
          // each of them. Replay time is also the better answer for the case
          // that motivates it — the queue drains seconds after connectivity
          // returns, on the same device, in the same zone.
          //
          // `item.headers` still wins where a record carries them, so nothing
          // a caller stated about its own request is overwritten here.
          headers: {
            'Content-Type': 'application/json',
            ...deviceClockHeader(),
            ...(item.headers ?? {}),
          },
          body: item.body,
          credentials: 'same-origin',
        });
      } catch {
        break; // still offline; keep this and everything after it
      }

      // An answer arrived, so this account may have changed on the server —
      // noted before the status is looked at, exactly as `api()` does it and
      // for the same reason cloud's invalidation is unconditional on status.
      // The drain is usually followed straight away by a refresh, and that
      // refresh is the one that must not be served a replica's pre-replay
      // dashboard.
      noteWrite();

      if (res.ok) {
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
        // Including 404, which used to be counted as SENT — "the target is
        // gone, so the write can never apply" is true, and dropping it is
        // right, but it is a discarded answer and reporting it as a synced one
        // tells the user the opposite of what happened. `Api.kt`'s
        // `isPermanent` has always put 404 on this side of the line.
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
