/**
 * One eviction policy, and the memo built on top of it.
 *
 * Three per-user caches live in this edition and every one of them is keyed by
 * something an account chooses: `blockCache` (auth.js), `lastReportedZone`
 * (api.js) and the `/overview` memo. All three had — or would have had — the
 * same comment claiming a bound, and the same absence of one: an entry is
 * written on first use and nothing ever removes it, so the real bound is
 * "every account that has made a request since this process started". Slow
 * rather than dangerous at ~100 bytes an entry, but `shared/CLAUDE.md` already
 * records the same shape being a real problem once — `formatterFor` retained
 * 2.2MB after GC for 16,384 case variants of one zone name.
 *
 * It is one module rather than a copy per cache because two copies of an
 * eviction policy is how they come to disagree, and because the memo below has
 * to reuse this rather than invent a third (#193 says so at its Bounds
 * heading).
 *
 * `session-touch.js`'s map is deliberately NOT one of them and must not be
 * folded in here. It bounds by CLEARING, with its own argument for why: the
 * penalty for forgetting a session there is one extra UPDATE, so an LRU would
 * be machinery for nothing. Forgetting an entry in any of the three below costs
 * a query, a Postgres round trip, or a whole `/overview` recomputation, which
 * is what buys the sweep.
 *
 * Extracted from the modules that use it for the reason `health.js` was:
 * `server.js` starts a server at import time, so nothing declared alongside it
 * can be unit tested — and a memo buried in a route handler is no more
 * reachable than one declared in `server.js`.
 */

/**
 * How many entries a bounded cache may hold.
 *
 * Not tuned against anything: the cost of an entry is ~100 bytes and the cost
 * of the sweep is one pass over the map, so the number only has to be far
 * above any working set and far below "unbounded". Ten thousand accounts
 * active inside one TTL window is already a larger instance than this edition
 * has been measured on.
 */
export const MAX_CACHED = 10_000;

/**
 * Write `value` into `map` under `key`, keeping the map bounded.
 *
 * The stored shape is `{...value, at}` — every caller here already carried an
 * `at` for its own TTL, and reusing it is what lets the sweep be free.
 *
 * @param {Map<any, any>} map
 * @param {any} key
 * @param {object} value
 * @param {{ttlMs: number, max?: number, now?: () => number}} opts
 */
export function remember(map, key, value, { ttlMs, max = MAX_CACHED, now = Date.now }) {
  // Deleted first so a REWRITE moves the key to the end of the insertion
  // order. `Map.set` on a key that is already present leaves its position
  // alone, which would make the fallback sweep below evict by first insertion
  // rather than by last write — and the entry it would then drop is the one
  // being written to most often.
  const existed = map.delete(key);

  // Only a NEW key can grow the map, so a rewrite never pays for a sweep.
  if (!existed && map.size >= max) {
    // The stale ones first. An entry past its TTL is one no reader would trust
    // anyway, so dropping it costs a caller nothing at all.
    const cutoff = now() - ttlMs;
    for (const [k, v] of map) if (v.at < cutoff) map.delete(k);

    // Still full, so everything in here is fresh and something live has to go.
    // Least recently written, which is what the delete above makes true.
    if (map.size >= max) {
      let excess = map.size - max + 1;
      for (const k of map.keys()) {
        map.delete(k);
        if (--excess <= 0) break;
      }
    }
  }

  map.set(key, { ...value, at: now() });
}

/**
 * A per-key TTL memo with an `inflight` guard, over an injected computation.
 *
 * `health.js`'s probe generalised to more than one key. Both halves it got
 * right are load bearing here for the same reasons, and the second is the one
 * a naive `{value, at}` memo misses entirely:
 *
 * - **The TTL** caps how often the expensive thing runs for one key.
 * - **`inflight` collapses a concurrent burst.** `/overview` is requested on
 *   every app open, on every `visibilitychange`, once per open tab and again on
 *   reconnect, so three tabs plus a focus event is four identical requests
 *   within a few seconds. On a cold memo without this they each run the whole
 *   computation and then each fill the memo — the exact case the memo exists
 *   for, missed at the exact moment it matters.
 *
 * A rejection is NOT cached, unlike `health.js`, where "the database did not
 * answer" is itself the result. Here the caller is a route that will answer
 * 500, and remembering that for the TTL would turn one failed query into every
 * caller's failed query for as long as it lasted.
 *
 * @param {(arg: any) => Promise<any>} compute
 * @param {{ttlMs: number, max?: number, now?: () => number}} opts
 */
export function createMemo(compute, { ttlMs, max = MAX_CACHED, now = Date.now }) {
  /**
   * key -> `{at, value}` once settled, `{at, inflight}` while computing.
   * @type {Map<string, {at: number, value?: any, inflight?: Promise<any>}>}
   */
  const entries = new Map();

  /**
   * @param {string} key everything the answer depends on, spelled out
   * @param {any} [arg] handed to `compute` on a miss
   */
  const memo = (key, arg) => {
    const hit = entries.get(key);
    if (hit?.inflight) return hit.inflight;
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value);

    // `Promise.resolve().then(...)` rather than calling `compute` here, so a
    // synchronous throw lands in the rejection path with everything else
    // instead of escaping past the bookkeeping below. `health.js`'s reason.
    const inflight = Promise.resolve().then(() => compute(arg)).then(
      (value) => {
        // Stored only if this entry is still the one registered below.
        // `forget` DELETES it, so a write that landed while this was computing
        // means the answer in hand describes the account as it was BEFORE that
        // write — and storing it is precisely the tap-then-refetch regression:
        // the client taps a day, the write returns, the client refetches, and
        // a payload computed before the tap paints it away.
        //
        // The caller awaiting this promise still gets that pre-write answer,
        // which is correct — it is a read that raced a write, and it started
        // first. What must not happen is a LATER reader inheriting it.
        if (entries.get(key)?.inflight === inflight) {
          remember(entries, key, { value }, { ttlMs, max, now });
        }
        return value;
      },
      (err) => {
        if (entries.get(key)?.inflight === inflight) entries.delete(key);
        throw err;
      }
    );

    // Registered SYNCHRONOUSLY, before anything gets a chance to await: a burst
    // arriving on a cold memo has to find this rather than each start its own.
    // Through `remember`, so an in-flight placeholder is bounded exactly as a
    // settled answer is.
    remember(entries, key, { inflight }, { ttlMs, max, now });
    return inflight;
  };

  /**
   * Drop every key beginning with `prefix`, in flight or not.
   *
   * The prefix is how "this account's answers" is spelled, so it must end in
   * the separator the keys use — `'12:'` and not `'12'`, or forgetting user 1
   * forgets user 12 as well.
   *
   * @param {string} prefix
   */
  memo.forget = (prefix) => {
    for (const k of entries.keys()) if (k.startsWith(prefix)) entries.delete(k);
  };

  /** For tests and for a gauge; nothing in a route should need it. */
  memo.size = () => entries.size;

  return memo;
}
