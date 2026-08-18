/**
 * How often a rolling session is allowed to write its sliding expiry.
 *
 * `rolling: true` slides the session's expiry on every request, and
 * connect-pg-simple implements that as `UPDATE session SET expire = ... WHERE
 * sid = ...`. One write per request is the cost people expect from that
 * setting. The cost they do not expect is that concurrent requests for the SAME
 * user take the same row lock and therefore run ONE AT A TIME — measured on a
 * production instance, against a Postgres about 30ms away:
 *
 *     concurrency    with cookie              no cookie (control)
 *              1       60ms                     15ms
 *              2      112ms                     14ms
 *              5      184ms                     15ms
 *             10      465ms  (max 3037ms)       16ms
 *             20      942ms                     19ms
 *
 * The control shares TLS, the proxy, the app, the event loop and the pool, and
 * is flat. The only thing the left column adds is that one row. A page load
 * fires about five requests at once, so the browser serialises itself, five
 * deep, on every load — which is why this reproduces by refreshing a browser
 * and never from curl, where requests go one at a time and the queue never
 * forms.
 *
 * Extracted from server.js because server.js starts a server at import time, so
 * nothing declared in it can be unit tested.
 */

/**
 * How stale the STORED expiry is allowed to get before a touch actually writes.
 *
 * The trade is precision in the sliding window against write volume, and the
 * window is `SESSION_COOKIE.maxAge` — fourteen days. Skipping touches for an
 * hour means the row can expire up to an hour earlier than the cookie claims,
 * which is 0.3% of the window and unnoticeable; a session that is being used at
 * all is re-touched long before it matters. In exchange an active user writes
 * one row per hour rather than one per request.
 *
 * Deliberately a constant rather than an env var: making it configurable means
 * an entry in both compose files, `cloud.env.example` and the README, which
 * `shared/test/compose.test.js` enforces — and nothing yet suggests an operator
 * needs to tune it.
 */
export const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * @typedef {object} TouchStats
 * @property {number} session_touch_tracked  sessions the throttle is holding
 * @property {number} session_touch_skipped  touches suppressed since boot. Not
 *   quite "writes avoided": a touch whose UPDATE failed is recorded as done —
 *   see `record` below for why that is the right trade — so a run of database
 *   trouble is counted here as a saving.
 */

/**
 * Wrap a session store's `touch` so it writes at most once per interval per
 * session.
 *
 * Mutates the store in place rather than wrapping it in a new object, so
 * everything else about it — `get`, `destroy`, the pruning timer, its
 * EventEmitter behaviour — is untouched and cannot drift.
 *
 * `set` records a write too. A real save (login, or any request that modifies
 * the session) writes `expire` on its own, so counting it here stops the next
 * request paying for a touch the row does not need.
 *
 * The map is bounded, and bounded by CLEARING rather than by evicting the
 * oldest entry: the penalty for forgetting a session is one extra UPDATE, so an
 * LRU would be machinery for nothing. Per process, so N processes write at most
 * N rows per interval.
 *
 * @template {{touch?: Function, set?: Function, destroy?: Function}} S
 * @param {S} store
 * @param {{intervalMs?: number, maxEntries?: number, now?: () => number}} [opts]
 *   injected for tests, so an hour can pass without waiting one
 * @returns {S & {touchStats: () => {session_touch_tracked: number, session_touch_skipped: number}}}
 */
export function throttleTouch(store, {
  intervalMs = TOUCH_INTERVAL_MS,
  maxEntries = 10_000,
  now = Date.now,
} = {}) {
  /** @type {Map<string, number>} sid -> when its row was last written */
  const written = new Map();
  let skipped = 0;

  /**
   * Recorded BEFORE the write is issued, not after it succeeds, and that order
   * is the point rather than an oversight. Recording on success would leave the
   * whole burst this exists to stop — five concurrent requests on a cold map
   * would each find nothing recorded and each fire an UPDATE at the one row,
   * which is the serialisation the throttle is for.
   *
   * The cost is that a touch whose UPDATE fails is remembered as a touch that
   * happened, so the row goes unslid for one more interval. Against a fourteen-
   * day window that is an hour of extra staleness during database trouble the
   * user is already feeling, which is a cheaper failure than the one above.
   */
  const record = (sid) => {
    // Clear before insert, so the map can never exceed the bound even by one.
    if (written.size >= maxEntries) written.clear();
    written.set(sid, now());
  };

  const originalTouch = store.touch?.bind(store);
  const originalSet = store.set?.bind(store);
  const originalDestroy = store.destroy?.bind(store);

  if (originalTouch) {
    store.touch = (sid, sess, cb) => {
      const last = written.get(sid);
      if (last !== undefined && now() - last < intervalMs) {
        skipped++;
        // The callback still has to run: express-session waits on it before it
        // finishes the response, so a throttle that simply returned would hang
        // every request it skipped.
        return cb ? cb(null) : undefined;
      }
      record(sid);
      return originalTouch(sid, sess, cb);
    };
  }

  if (originalSet) {
    store.set = (sid, sess, cb) => {
      record(sid);
      return originalSet(sid, sess, cb);
    };
  }

  if (originalDestroy) {
    store.destroy = (sid, cb) => {
      written.delete(sid);
      return originalDestroy(sid, cb);
    };
  }

  // Reported by the runtime log, so the saving is visible rather than asserted.
  // The cast is because the property is being added here, which is the point.
  const enriched = /** @type {S & {touchStats: () => TouchStats}} */ (store);
  enriched.touchStats = () => ({
    session_touch_tracked: written.size,
    session_touch_skipped: skipped,
  });

  return enriched;
}
