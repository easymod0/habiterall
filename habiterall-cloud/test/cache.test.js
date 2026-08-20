import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MAX_CACHED, createMemo, forgetAccount, remember } from '../src/cache.js';

const src = (name) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');

/** A clock the test moves by hand, so a 60s TTL costs no seconds. */
const clock = (start = 1_000) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

const TTL = 60_000;

test('the bound is 10,000 entries', () => {
  // The literal, not the import compared against itself: a test reading
  // MAX_CACHED on both sides pins the name and nothing else.
  assert.equal(MAX_CACHED, 10_000);
});

test('a cache written with no explicit max is still bounded', () => {
  // The real call sites pass no `max`, so this is the one test that can fail
  // against a default of Infinity — every other test here injects a small one
  // and would pass against a `remember` that bounds nothing by default.
  const map = new Map();
  const time = clock();
  for (let i = 0; i <= MAX_CACHED; i++) {
    remember(map, i, { seen: i }, { ttlMs: TTL, now: time.now });
  }
  assert.equal(map.size, MAX_CACHED);
});

test('stale entries are what the sweep takes first', () => {
  const map = new Map();
  const time = clock();

  for (let i = 0; i < 4; i++) remember(map, `old${i}`, { i }, { ttlMs: TTL, max: 5, now: time.now });
  time.advance(TTL + 1);
  remember(map, 'fresh', { i: 'f' }, { ttlMs: TTL, max: 5, now: time.now });

  // Full now, and one more key arrives. The four expired ones cost a reader
  // nothing, so they go and the fresh one stays.
  remember(map, 'newest', { i: 'n' }, { ttlMs: TTL, max: 5, now: time.now });

  assert.deepEqual([...map.keys()], ['fresh', 'newest']);
});

test('when everything is fresh the least recently written goes, and the new entry survives', () => {
  const map = new Map();
  const time = clock();

  // Five entries, none of them anywhere near their TTL.
  for (let i = 0; i < 5; i++) {
    remember(map, `k${i}`, { i }, { ttlMs: TTL, max: 5, now: time.now });
    time.advance(10);
  }
  remember(map, 'k5', { i: 5 }, { ttlMs: TTL, max: 5, now: time.now });

  // Mutation check: delete the second pass in `remember` and this is the
  // assertion that fails — with only the TTL sweep the map grows to 6, which
  // is the whole "bounded by the accounts seen this process lifetime" bug.
  assert.equal(map.size, 5);
  // ...and the entry written just before the sweep must survive it. A sweep
  // that evicted the newest would be bounded and useless.
  assert.deepEqual(map.get('k5'), { i: 5, at: time.now() });
  assert.equal(map.has('k0'), false, 'the oldest write is the one dropped');
});

test('a rewrite neither grows the cache nor evicts anything', () => {
  const map = new Map();
  const time = clock();
  for (let i = 0; i < 5; i++) remember(map, `k${i}`, { i }, { ttlMs: TTL, max: 5, now: time.now });

  time.advance(10);
  remember(map, 'k0', { i: 'rewritten' }, { ttlMs: TTL, max: 5, now: time.now });

  assert.equal(map.size, 5);
  assert.deepEqual([...map.keys()].sort(), ['k0', 'k1', 'k2', 'k3', 'k4']);
  assert.equal(map.get('k0').i, 'rewritten');
});

test('a rewrite moves a key to the back of the eviction queue', () => {
  const map = new Map();
  const time = clock();
  for (let i = 0; i < 5; i++) {
    remember(map, `k${i}`, { i }, { ttlMs: TTL, max: 5, now: time.now });
    time.advance(10);
  }

  // k0 is the oldest insertion and now the most recent WRITE.
  remember(map, 'k0', { i: 'rewritten' }, { ttlMs: TTL, max: 5, now: time.now });
  time.advance(10);
  remember(map, 'k5', { i: 5 }, { ttlMs: TTL, max: 5, now: time.now });

  // Mutation check: drop the `map.delete(key)` at the top of `remember` and
  // k0 is evicted here instead of k1 — `Map.set` on a present key leaves its
  // position alone, so the fallback sweep would evict by FIRST insertion and
  // throw away the entry being written to most often.
  assert.equal(map.has('k0'), true, 'the most recently written key survives');
  assert.equal(map.has('k1'), false, 'the least recently written key goes');
});

test('no per-user cache is written past the bound', () => {
  // A guard on SOURCE TEXT, and the root CLAUDE.md is explicit about what that
  // is worth: it cannot see a renamed binding or an inverted comparison, and it
  // is kept for the one thing it does catch — a call site that goes around the
  // policy entirely. Everything above proves `remember` bounds a map; nothing
  // above proves either cache calls it, and "pinning the DECISION is not
  // pinning the WIRING" is four Android bugs' worth of this repo's own history.
  // The behavioural half is not reachable without driving 10,001 accounts
  // through a real Postgres, which is why this stops at the write.
  for (const [file, cache] of [['auth.js', 'blockCache'], ['api.js', 'lastReportedZone']]) {
    const text = src(file);
    assert.ok(
      text.includes(`remember(${cache},`),
      `${cache} must be written through remember()`
    );
    assert.ok(
      !text.includes(`${cache}.set(`),
      `${cache}.set() in ${file} goes around the bound in cache.js`
    );
  }
});

test('the stored shape carries `at`, which is what the TTL readers ask', () => {
  const map = new Map();
  const time = clock(5_000);
  remember(map, 7, { blocked: false }, { ttlMs: TTL, now: time.now });
  assert.deepEqual(map.get(7), { blocked: false, at: 5_000 });
});

/* ---------- the memo ---------- */

/** A computation that can be held open, so a burst can be assembled by hand. */
const gate = () => {
  let release;
  const opened = new Promise((r) => { release = r; });
  return { opened, release: (v) => release(v) };
};

test('a burst on a cold memo costs one computation, not one each', async () => {
  let calls = 0;
  const held = gate();
  const memo = createMemo(async () => { calls++; return held.opened; }, { ttlMs: 2_000 });

  // All arriving before any of them has resolved: the case the memo exists
  // for, since that is what three tabs plus a focus event look like. A test
  // that only asserted the SECOND SEQUENTIAL request was cheap would pass
  // against a memo with no `inflight` at all.
  const answers = Promise.all(Array.from({ length: 4 }, () => memo('u1:w', 'arg')));
  held.release('payload');

  assert.deepEqual(await answers, Array(4).fill('payload'));
  assert.equal(calls, 1);
});

test('the memo expires, so a stale answer cannot outlive its window', async () => {
  let calls = 0;
  const time = clock();
  const memo = createMemo(async () => `v${++calls}`, { ttlMs: 2_000, now: time.now });

  assert.equal(await memo('u1:w'), 'v1');
  time.advance(1_999);
  assert.equal(await memo('u1:w'), 'v1');
  time.advance(2);
  assert.equal(await memo('u1:w'), 'v2');
});

test('two keys do not share an answer', async () => {
  const memo = createMemo(async (arg) => arg, { ttlMs: 2_000 });
  assert.equal(await memo('u1:2026-08-20', 'alice'), 'alice');
  assert.equal(await memo('u2:2026-08-20', 'bob'), 'bob');
  assert.equal(await memo('u1:2026-08-20', 'ignored'), 'alice');
});

test('forget drops one account and leaves the others alone', async () => {
  const memo = createMemo(async (arg) => arg, { ttlMs: 2_000 });
  await memo('1:w', 'first');
  await memo('12:w', 'twelfth');

  memo.forget('1:');

  assert.equal(await memo('1:w', 'rebuilt'), 'rebuilt');
  // The separator is load bearing: forgetting user 1 must not forget user 12.
  assert.equal(await memo('12:w', 'ignored'), 'twelfth');
});

test('an answer computed before a write is never stored after it', async () => {
  // The tap-then-refetch regression, at the memo's own level. A GET is already
  // computing when a write lands; the write forgets, and the GET then settles
  // holding a payload that predates the tap. Storing it hands the NEXT reader
  // — the client's own refetch, which is the whole point of tapping — a
  // dashboard with the tap missing, for the length of the TTL.
  let calls = 0;
  const held = gate();
  const memo = createMemo(async () => { calls++; return held.opened; }, { ttlMs: 2_000 });

  const inflight = memo('7:w');
  memo.forget('7:');
  held.release('before the write');

  // The caller that started first still gets the answer it started for: it is
  // a read that raced a write and it is not wrong.
  assert.equal(await inflight, 'before the write');

  // ...but nothing may inherit it.
  const after = await memo('7:w');
  assert.equal(calls, 2, 'the post-write read must recompute');
  assert.notEqual(after, undefined);
});

test('a rejection is not cached', async () => {
  let calls = 0;
  const memo = createMemo(async () => {
    calls++;
    if (calls === 1) throw new Error('pool exhausted');
    return 'recovered';
  }, { ttlMs: 2_000 });

  await assert.rejects(() => memo('u1:w'), /pool exhausted/);
  // Remembering a failure for the TTL would turn one bad query into every
  // caller's bad query for as long as it lasted — which is why this differs
  // from health.js, where "the database did not answer" IS the result.
  assert.equal(await memo('u1:w'), 'recovered');
});

test('a synchronous throw rejects rather than escaping', async () => {
  const memo = createMemo(() => { throw new Error('built the key wrong'); }, { ttlMs: 2_000 });
  await assert.rejects(() => memo('u1:w'), /built the key wrong/);
  assert.equal(memo.size(), 0, 'and leaves no entry behind');
});

test('the memo is bounded by the same policy as the caches', async () => {
  const memo = createMemo(async (arg) => arg, { ttlMs: 2_000, max: 5 });
  for (let i = 0; i < 20; i++) await memo(`u${i}:w`, i);
  assert.equal(memo.size(), 5);
});

test('an expired entry goes on the next miss, not when the map fills', async () => {
  const time = clock();
  // `max` is deliberately far above anything this test reaches, because the
  // bug was that `max` was the ONLY thing that ever removed an entry: the
  // sweep in `remember` runs on a write and only when full, so with a bound of
  // 500 nothing expired was dropped until entry 500 arrived. A 2s TTL then
  // capped how long an answer was TRUSTED and not how long it was KEPT, and a
  // cache of 499 KB dashboards sat at its bound for the life of the process.
  const memo = createMemo(async (arg) => arg, { ttlMs: 2_000, max: 1_000, now: time.now });

  for (let i = 0; i < 50; i++) await memo(`sweep${i}:w`, i);
  assert.equal(memo.size(), 50, 'control: all fifty are resident while fresh');

  time.advance(2_001);
  await memo('sweepfresh:w', 'f');

  assert.equal(memo.size(), 1, 'the fifty expired entries are gone, and max was never reached');
});

test('the sweep leaves an in-flight computation alone however old it is', async () => {
  const time = clock();
  const held = gate();
  let calls = 0;
  // Only the slow key is held open — the other has to be able to SETTLE, since
  // settling it is what runs the sweep.
  const memo = createMemo(async (arg) => {
    if (arg !== 'slow') return arg;
    calls++;
    return held.opened;
  }, { ttlMs: 2_000, now: time.now });

  const inflight = memo('slow:w', 'slow');
  time.advance(5_000);              // older than the TTL, and still computing
  await memo('other:w', 'other');   // a miss, so it sweeps

  held.release('answer');
  assert.equal(await inflight, 'answer');

  // Sweeping the placeholder would fail the store-identity guard, so the
  // answer would never be stored — and every computation slower than the TTL
  // would become silently uncacheable, which is the exact case the memo is
  // most worth having.
  assert.equal(await memo('slow:w', 'slow'), 'answer');
  assert.equal(calls, 1, 'the settled answer was stored, not recomputed');
});

/* ---------- invalidation from outside the router ---------- */

test('forgetAccount reaches a per-account memo, and only those', async () => {
  const scoped = createMemo(async (arg) => arg, { ttlMs: 2_000, perAccount: true });
  const plain = createMemo(async (arg) => arg, { ttlMs: 2_000 });

  await scoped('90:w', 'before');
  await plain('90:w', 'before');

  forgetAccount(90);

  // The ntfy button and the Discord button both write outside the `/api`
  // router, so `api.use(...)` cannot be the only invalidation. This is what
  // they call instead.
  assert.equal(await scoped('90:w', 'after'), 'after', 'the registered memo forgot');
  // The control, and it is the half that fails against a `forgetAccount` that
  // just clears everything it can reach.
  assert.equal(await plain('90:w', 'after'), 'before', 'an unregistered memo is untouched');
});

test('forgetAccount forgets one account, not every account it prefixes', async () => {
  const memo = createMemo(async (arg) => arg, { ttlMs: 2_000, perAccount: true });
  await memo('8:w', 'eight');
  await memo('81:w', 'eighty-one');

  forgetAccount(8);

  assert.equal(await memo('8:w', 'rebuilt'), 'rebuilt');
  assert.equal(await memo('81:w', 'ignored'), 'eighty-one',
    'the separator is what stops account 8 forgetting account 81');
});

test('the notifier forgets AFTER its transaction commits, not inside it', () => {
  // `withUser` COMMITs after its callback returns (`db/pool.js`), so a
  // `forgetAccount` inside the callback forgets before the write is visible to
  // anything else — and leaves exactly the window the invalidation exists to
  // close: a concurrent /overview clears the memo, opens its own transaction,
  // cannot see the uncommitted row, and stores the pre-press dashboard, which
  // the commit then lands behind. The router middleware states this same rule
  // at its own registration, which is why it wraps `res.end` rather than
  // invalidating on the way in.
  //
  // Source text, and blind the usual way: it cannot see a `withUser` that
  // stopped committing on return, and it pins a SHAPE rather than an ordering.
  // The behavioural half needs a read still computing when a write commits,
  // which nothing over HTTP can arrange — the same limitation
  // `overview-memo.integration.mjs` already states for the `/api` path, and
  // the reason this is worth having at all.
  const text = src('notifier.js');
  const record = text.slice(
    text.indexOf('async record(account,'),
    text.indexOf('/* ---------- answering from an ntfy button')
  );
  assert.ok(record.length > 0, 'control: record() was found in notifier.js');
  assert.match(record, /\}\s*finally\s*\{\s*forgetAccount\(account\.id\);\s*\}/,
    'forgetAccount must run in a finally OUTSIDE withUser, so it follows the COMMIT');

  const inside = record.slice(
    record.indexOf('withUser(account.id'),
    record.lastIndexOf('});')
  );
  assert.ok(!inside.includes('forgetAccount'),
    'forgetAccount inside the withUser callback forgets before the write commits');
});

test('the /overview memo does not inherit a bound sized for 100-byte entries', () => {
  // Source text, and blind in the documented way — it cannot see a renamed
  // constant or 500 spelled as something else. Kept for the one thing it
  // catches, which is the thing that happened: `createMemo` called with a TTL
  // and nothing else, taking `MAX_CACHED` = 10,000 — a number justified in
  // cache.js by an entry costing ~100 bytes — for a cache whose entries
  // measure 499 KB at 20 habits × 365 days. Ten thousand of those is 4.9 GB.
  //
  // The behavioural halves are above: the sweep is what actually bounds
  // residency, and `forgetAccount` is what the non-router writes call. Neither
  // can see whether THIS memo asks for either, and no test can drive 500
  // distinct dashboard windows through a real Postgres to find out.
  const text = src('api.js');

  // The literal, so this fails if the number is widened back toward MAX_CACHED.
  assert.match(text, /const MAX_OVERVIEW_CACHED = 500;/,
    'MAX_OVERVIEW_CACHED must be its own number, stated here');

  const call = text.match(/createMemo\([\s\S]*?\}\);/)?.[0] ?? '';
  assert.ok(call.includes('max: MAX_OVERVIEW_CACHED'),
    'the overview memo must pass its own max, not inherit MAX_CACHED');
  assert.ok(call.includes('perAccount: true'),
    'the overview memo must be reachable by forgetAccount, or a button press cannot clear it');
});
