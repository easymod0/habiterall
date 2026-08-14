/**
 * What `/healthz` costs, and who is allowed to skip its rate limit.
 *
 * Extracted from server.js because server.js starts a server at import time,
 * so nothing in it can be unit tested — and the memo below has a failure mode
 * that is silent in exactly the wrong direction: an `inflight` that is never
 * cleared would report the last answer forever, which is a container calling
 * itself healthy while Postgres is down.
 */

/**
 * Loopback and the private ranges a container orchestrator probes from —
 * docker's bridge, a kubelet on the node, an IPv6 unique-local address.
 * Anchored and quantifier-free, so it cannot backtrack.
 *
 * The `::ffff:` prefix covers all four IPv4 branches rather than loopback
 * alone. Today it covers nothing: `app.listen(PORT, '0.0.0.0')` is an IPv4
 * socket, so `req.ip` is always a dotted quad. It is here for whoever moves
 * that bind to `::` for dual-stack, because on the day the mapped form starts
 * arriving, a skip that only knew `::ffff:127.` would quietly stop skipping
 * every orchestrator probe — and a healthchecker meeting a 429 restarts the
 * container, which is the outcome the skip exists to prevent.
 */
export const LOCAL_IPS =
  /^(::1|(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)|f[cd]|fe80:)/i;

/**
 * A database probe memoised for a second.
 *
 * `/healthz` is the only unauthenticated route that touches Postgres, which
 * without this makes it the cheapest way to exhaust a pool sized for the app
 * rather than for a flood: `PG_POOL_MAX` is 10 by default, and every waiting
 * probe is a connection a real request cannot have. One second of memo caps
 * that at one connection per second however many callers arrive — the
 * guarantee a per-IP rate limit cannot make, because a distributed flood pays
 * nothing for a fresh bucket.
 *
 * `inflight` is the other half of it. A burst arriving on a cold memo would
 * otherwise open a connection each and fill the memo afterwards, which is the
 * exact failure the memo exists to stop, at the exact moment it matters.
 *
 * A failed query is a cached `false`, not a thrown error: "the database did not
 * answer" is the result, and re-throwing it would only mean the route caught it
 * again a line later.
 *
 * @param {() => Promise<unknown>} query
 * @param {{ttlMs?: number, now?: () => number}} [opts] injected for tests, so
 *   the TTL can be crossed without sleeping through it
 * @returns {(() => Promise<boolean>) & {cached: () => boolean|null}}
 */
export function createHealthProbe(query, { ttlMs = 1000, now = Date.now } = {}) {
  let last = /** @type {{at: number, ok: boolean}|null} */ (null);
  let inflight = /** @type {Promise<boolean>|null} */ (null);

  const probe = () => {
    if (last && now() - last.at < ttlMs) return Promise.resolve(last.ok);
    if (inflight) return inflight;
    // `Promise.resolve().then(query)` rather than `query()`, so a synchronous
    // throw lands in the same place as a rejection instead of escaping.
    inflight = Promise.resolve().then(query).then(() => true, () => false)
      .then((ok) => {
        last = { at: now(), ok };
        inflight = null;
        return ok;
      });
    return inflight;
  };

  /**
   * The last answer, or `null` if there has never been one — which can only be
   * true before the first request reaches the route.
   */
  probe.cached = () => (last ? last.ok : null);

  return probe;
}

/**
 * The one place `/healthz` decides what a health answer looks like, so the
 * route and the over-limit handler cannot drift into two shapes.
 *
 * @param {import('express').Response} res
 * @param {boolean} ok
 */
export const sendHealth = (res, ok) => (ok
  ? res.json({ ok: true })
  : res.status(503).json({ ok: false, error: 'database unavailable' }));
