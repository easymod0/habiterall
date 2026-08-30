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
 * How many entries a bounded cache may hold, for a cache of SMALL entries.
 *
 * Not tuned against anything: the cost of a `blockCache` or `lastReportedZone`
 * entry is ~100 bytes and the cost of the sweep is one pass over the map, so
 * the number only has to be far above any working set and far below
 * "unbounded". Ten thousand accounts active inside one TTL window is already a
 * larger instance than this edition has been measured on.
 *
 * **A cache whose entries are not ~100 bytes must pass its own `max`, and the
 * default here is wrong for it.** This is a COUNT bound, so it converts to a
 * memory bound only through the entry cost, and shipping it as a default let
 * the `/overview` memo — whose entries are whole dashboards — inherit a number
 * justified by an entry cost three orders of magnitude smaller. Measured: an
 * `/overview` payload for 20 habits × 365 days retains 499 KB, and 50 × 365
 * retains 1.2 MB, so ten thousand of them is ~4.9 GB. `MAX_OVERVIEW_CACHED`
 * (`api.js`) is that cache's own number.
 */
export const MAX_CACHED = 10_000;

/**
 * Write `value` into `map` under `key`, keeping the map bounded.
 *
 * The stored shape is `{...value, at}` — every caller here already carried an
 * `at` for its own TTL, and reusing it is what lets the sweep be free.
 *
 * **An in-flight placeholder is not an eviction candidate.** `createMemo`
 * registers one under the key it is computing, and callers arriving meanwhile
 * find it instead of starting their own computation. Dropping it costs far
 * more than the entry it frees: the answer in flight fails the store-identity
 * guard and is never cached, AND the herd it was collapsing re-forms, so a
 * memo at its bound starts recomputing the very thing it is holding. Both
 * passes below therefore step over one — the TTL pass because a placeholder is
 * not stale but *running*, whichever way its `at` reads, and the eviction pass
 * because a settled entry is always the cheaper thing to lose. The bound stays
 * absolute: if nothing but placeholders is left, the second pass takes one
 * anyway rather than let the map grow past `max`.
 *
 * `createMemo`'s own sweep exempts a placeholder for this reason and this one
 * did not, which meant the exemption held right up until the memo reached
 * `max` — which is to say until load, which is the only time it matters.
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
    for (const [k, v] of map) if (!v.inflight && v.at < cutoff) map.delete(k);

    // Still full, so everything left is fresh and something live has to go.
    // Least recently written, which is what the delete above makes true —
    // and settled first, so a placeholder is the last thing given up.
    if (map.size >= max) evict(map, map.size - max + 1);
  }

  map.set(key, { ...value, at: now() });
}

/**
 * Drop `excess` entries, least recently written first, settled before
 * in-flight.
 *
 * Two passes rather than one, because "prefer a settled entry" and "the map
 * never exceeds `max`" are both requirements and only the order between them
 * is a choice. The first pass can come up short — every entry may be a
 * placeholder — so the second runs without the preference and takes whatever
 * is oldest.
 *
 * @param {Map<any, any>} map
 * @param {number} excess
 */
function evict(map, excess) {
  for (const [k, v] of map) {
    if (v.inflight) continue;
    map.delete(k);
    if (--excess <= 0) return;
  }
  for (const k of map.keys()) {
    map.delete(k);
    if (--excess <= 0) return;
  }
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
 * **Residency tracks the TTL here, and `max` is a backstop rather than the
 * bound.** `remember` sweeps only when the map is FULL, which is right for a
 * cache of ~100-byte entries and wrong for one holding whole dashboards: an
 * expired entry would sit there until entry `max` arrived, so a 2 s TTL would
 * cap how long an answer is TRUSTED and not how long it is KEPT, and the map
 * would fill to `max` and stay there. So a miss sweeps its own expired entries
 * first. That pass costs one iteration per live key on the path that is about
 * to run five queries and per-habit CPU, and what it buys is a live set of
 * "what was asked for in the last `ttlMs`" — which, since a computation holds a
 * pool connection, is bounded by `PG_POOL_MAX` × the TTL and not by `max` at
 * all.
 *
 * **`max` alone is a shared bound, and a shared bound is one an account can
 * spend on its own.** Nothing about a per-account key stops ONE account
 * filling every slot — `end` is any date up to the caller's today and `days`
 * is 1–365, so paging back through a few years is thousands of distinct keys
 * and none of it involves a write. The account doing it evicts every other
 * account's answers, and the memo becomes pure overhead for everyone else: all
 * of the sweep, none of the hits. `maxPerAccount` is the second half of the
 * bound and the one that makes the first fair — it caps what any single
 * account can hold, so `max` is only ever reached by genuinely many accounts
 * being active at once. Needs `perAccount`, which is what declares that a key
 * begins with `<account id>:`.
 *
 * @param {(arg: any) => Promise<any>} compute
 * @param {{ttlMs: number, max?: number, now?: () => number,
 *   perAccount?: boolean, maxPerAccount?: number}} opts
 */
export function createMemo(compute, {
  ttlMs, max = MAX_CACHED, now = Date.now, perAccount = false,
  maxPerAccount = Infinity,
}) {
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

    // A miss, so everything expensive is ahead of this anyway: drop every entry
    // no reader would trust, which is what makes the live set "the last `ttlMs`
    // of traffic" rather than "`max` entries, forever". An in-flight
    // placeholder is exempt however old it is — callers are awaiting it, and
    // deleting it would fail the store-identity guard below and quietly turn
    // every slow computation into an uncacheable one.
    const cutoff = now() - ttlMs;
    for (const [k, v] of entries) if (!v.inflight && v.at < cutoff) entries.delete(k);

    // ...and then this account's own share, so the slot about to be taken is
    // taken from ITS allowance and not from the shared bound. Done here rather
    // than in `remember` because only the memo knows a key is `<account>:...`
    // — `remember` is also `blockCache` and `lastReportedZone`, whose keys are
    // bare user ids with no window after them.
    if (perAccount && maxPerAccount < Infinity) {
      capAccount(entries, accountPrefix(key), maxPerAccount);
    }

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

  if (perAccount) perAccountMemos.add(memo);

  return memo;
}

/**
 * Every memo whose keys begin with `<account id>:`, so a write can forget one
 * account's answers from wherever the write happened.
 *
 * @type {Set<{forget: (prefix: string) => void}>}
 */
const perAccountMemos = new Set();

/**
 * Forget everything cached for one account.
 *
 * **The invalidation is one rule per WRITE, not one per router.** It was
 * `api.use(...)` alone, which is every non-safe method on the `/api` router and
 * therefore not every write: `NTFY_ANSWER_PATH` is mounted in `server.js` ABOVE
 * that router on purpose (so it is never reached through `requireAuth`), and
 * the Discord button never touches Express at all — it arrives on the gateway
 * socket. Both write a real entry through `interactionAdapter().record`, and
 * neither cleared the memo, so pressing Done on a reminder while the app was
 * open in a tab served that tab a dashboard computed before the press.
 *
 * The router middleware stays, because it is the only thing that can see the
 * eight other mutating routes without a list that drifts. This is the second
 * half: the ONE function every non-API write path calls. A third write path
 * added tomorrow still has to call it — but it is now a named thing to call,
 * rather than a router it has to be inside of.
 *
 * @param {number|string} userId
 */
export function forgetAccount(userId) {
  const prefix = `${userId}${ACCOUNT_SEP}`;
  for (const memo of perAccountMemos) memo.forget(prefix);
}

/**
 * What separates the account id from the rest of a per-account key.
 *
 * One constant because two things have to agree on it and both are silent when
 * they do not: `forgetAccount` under-forgets without it (`'1'` matches user
 * 12), and `capAccount` counts — and evicts — the wrong account's entries the
 * same way. Spelling it once is what stops the second caller getting it right
 * by coincidence.
 */
const ACCOUNT_SEP = ':';

/**
 * The `<account id>:` prefix of a per-account key.
 *
 * @param {string} key
 */
const accountPrefix = (key) => key.slice(0, key.indexOf(ACCOUNT_SEP) + 1);

/**
 * Hold one account to `limit` entries, dropping its own oldest to get there.
 *
 * Called on a MISS and before the new placeholder is registered, so the
 * account is left with room for exactly the entry it is about to take — which
 * is why the comparison below is `- limit + 1` and not `- limit`.
 *
 * Settled before in-flight and least recently written first, the same
 * preference `evict` applies to the shared bound and for the same reason: a
 * placeholder has callers attached to it, and taking one both wastes the
 * computation and re-forms the herd it was collapsing. Unlike `evict` this one
 * has no second pass — if an account really is holding `limit` computations at
 * once it may exceed its share until they settle, and that is the right way to
 * be wrong. The shared `max` is still absolute above it.
 *
 * @param {Map<string, any>} entries
 * @param {string} prefix
 * @param {number} limit
 */
function capAccount(entries, prefix, limit) {
  const mine = [];
  for (const [k, v] of entries) if (k.startsWith(prefix)) mine.push([k, v]);
  let excess = mine.length - limit + 1;
  if (excess <= 0) return;

  for (const [k, v] of mine) {
    if (v.inflight) continue;
    entries.delete(k);
    if (--excess <= 0) return;
  }
}
