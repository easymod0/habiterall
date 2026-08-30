import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MAX_CACHED, createMemo, forgetAccount, remember } from '../src/cache.js';

const src = (name) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');

/**
 * The slice of TEXT between two anchors, or a failure naming the missing one.
 *
 * The point is the failure. `text.slice(text.indexOf(a), text.indexOf(b))`
 * with a reworded `b` gives `indexOf` = -1, and `slice(i, -1)` is not empty —
 * it is everything from `a` to one character short of the end. A guard built
 * that way silently stops asking about the function it named and starts asking
 * about the rest of the file, which is the "test that cannot fail" shape the
 * root CLAUDE.md lists first. Every guard below narrows to a region, so every
 * one of them can be defeated by an edit to a comment; asserting the anchors
 * were found is what turns that into a red test instead of a green one.
 */
function region(text, from, to) {
  const start = text.indexOf(from);
  assert.notEqual(start, -1, `anchor not found, so this guard tested nothing: ${from}`);
  const end = text.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `anchor not found, so this guard tested nothing: ${to}`);
  return text.slice(start, end);
}

/**
 * The same text with its comments taken out, for a guard about what the code
 * does NOT do.
 *
 * A positive source-text guard can be satisfied by a comment, which the note
 * above already says. A NEGATIVE one is worse: it can be FAILED by one, and it
 * was — the first version of the `Vary` guard below tripped over the paragraph
 * in `api.js` explaining why that call is deliberately absent, which is the
 * one comment anybody re-reading this would write. So both directions read
 * code only, and the region above is what keeps that honest.
 *
 * Line comments are matched at the start of a line rather than anywhere, so a
 * `'https://…'` inside a string survives. Nothing here needs to parse JS.
 */
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

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

test('a FULL cache does not evict the computation it is holding', async () => {
  // The other sweep. `createMemo`'s miss path exempts an in-flight placeholder
  // and `remember`'s did not, so the exemption held right up until the memo
  // reached `max` — which is to say it held until load, which is the only time
  // it matters. Then the placeholder was evicted by the TTL pass, the answer
  // in flight failed the store-identity guard and was never cached, and the
  // burst it was collapsing re-formed: a memo at its bound recomputing the
  // very thing it was already holding.
  const time = clock();
  const held = gate();
  let calls = 0;
  const memo = createMemo(async (arg) => {
    calls++;
    return arg === 'slow' ? held.opened : arg;
  }, { ttlMs: 100, max: 3, now: time.now });

  const first = memo('slow:w', 'slow');
  time.advance(500);                       // the placeholder is now older than the TTL
  for (const k of ['a', 'b', 'c']) await memo(`${k}:w`, k);   // fills to max, forcing remember's sweep

  assert.equal(calls, 4, 'control: one held computation plus the three that filled it');

  // The heart of it: a second caller arriving for the SAME still-computing key
  // must still find the placeholder rather than start its own run.
  const second = memo('slow:w', 'slow');
  held.release('answer');
  assert.equal(await first, 'answer');
  assert.equal(await second, 'answer');
  assert.equal(calls, 4, 'the in-flight computation was not evicted, so it was not repeated');
});

test('a settled entry is given up before an in-flight one, and the bound still holds', async () => {
  // The preference is settled-first, but `max` is not negotiable: if every
  // entry is a placeholder there is nothing cheap left and one goes anyway.
  const time = clock();
  const gates = [gate(), gate(), gate()];
  const memo = createMemo(async (i) => gates[i].opened, { ttlMs: 100, max: 2, now: time.now });

  const held = gates.map((_, i) => memo(`h${i}:w`, i));
  assert.ok(memo.size() <= 2, `the bound holds even with nothing settled, size=${memo.size()}`);

  gates.forEach((g, i) => g.release(`v${i}`));
  assert.deepEqual(await Promise.all(held), ['v0', 'v1', 'v2'],
    'and every caller is still answered, evicted placeholder or not');
});

/* ---------- one account's share of the bound ---------- */

test('one account cannot spend the whole shared bound', async () => {
  // `max` alone is a bound an account can take by itself: `end` is any date and
  // `days` is 1-365, so paging back through history is thousands of distinct
  // keys and no write is involved, so `forget` never fires. The account doing
  // it evicts every other account's answers and the memo becomes pure overhead
  // for everyone else — all of the sweep, none of the hits.
  const time = clock();
  const memo = createMemo(async (arg) => arg,
    { ttlMs: 2_000, max: 50, maxPerAccount: 4, perAccount: true, now: time.now });

  await memo('victim:w', 'still here');
  for (let i = 0; i < 40; i++) await memo(`hog:window${i}`, i);

  assert.equal(await memo('victim:w', 'recomputed'), 'still here',
    'the quiet account keeps its answer while another pages through 40 windows');
  assert.ok(memo.size() <= 5, `the hog is held to its share, size=${memo.size()}`);
});

test('the per-account cap gives up a settled entry before a computing one', async () => {
  // The same preference as `evict`, and it needs its own test because the two
  // sweeps are separate code: an account at its cap whose OLDEST entry is
  // still computing must lose a settled one instead. Taking the placeholder
  // would waste the computation, lose its answer to the store-identity guard,
  // and re-form the burst it was collapsing — for an account that has done
  // nothing but page, which is the shape this cap exists to handle gently.
  const time = clock();
  const held = gate();
  let slowCalls = 0;
  const memo = createMemo(async (arg) => {
    if (arg !== 'slow') return arg;
    slowCalls++;
    return held.opened;
  }, { ttlMs: 2_000, max: 50, maxPerAccount: 2, perAccount: true, now: time.now });

  const slow = memo('7:slow', 'slow');     // oldest, and still running
  await memo('7:settled', 'settled');      // newer, and cheap to lose
  await memo('7:third', 'third');          // the account is now over its cap

  const again = memo('7:slow', 'slow');
  held.release('answer');
  assert.equal(await slow, 'answer');
  assert.equal(await again, 'answer');
  assert.equal(slowCalls, 1, 'the computing entry was kept, so it was not run twice');

  // ...and the settled one is what actually went.
  assert.equal(await memo('7:settled', 'recomputed'), 'recomputed',
    'the settled entry is the one the cap took');
});

test('the per-account cap is per account, not a second global bound', async () => {
  const time = clock();
  const memo = createMemo(async (arg) => arg,
    { ttlMs: 2_000, max: 50, maxPerAccount: 2, perAccount: true, now: time.now });

  // Six accounts, two windows each: nobody is over their share, so nothing is
  // evicted. A cap that counted every key rather than the prefix's own would
  // leave two entries here instead of twelve.
  //
  // 1 and 12 are in the list on purpose — the separator matters here exactly
  // as it does in `forget`, and `'12:w1'.startsWith('1')` is the way to get it
  // wrong.
  const users = [1, 12, 2, 3, 4, 5];
  for (const user of users) {
    await memo(`${user}:w1`, `${user}-1`);
    await memo(`${user}:w2`, `${user}-2`);
  }
  assert.equal(memo.size(), 12, 'nobody is over their share, so nothing was evicted');

  // Account 1 goes one over and loses its OWN oldest window...
  await memo('1:w3', '1-3');
  assert.equal(await memo('1:w1', 'recomputed'), 'recomputed',
    "the capped account gives up its own least recently written window");

  // ...and account 12 is untouched by it.
  assert.equal(await memo('12:w1', 'recomputed'), '12-1',
    'account 1 reaching its cap must not evict account 12');
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
  const record = region(src('notifier.js'),
    'async record(account,', '/* ---------- answering from an ntfy button');

  assert.match(record, /\}\s*finally\s*\{\s*forgetAccount\(account\.id\);\s*\}/,
    'forgetAccount must run in a finally OUTSIDE withUser, so it follows the COMMIT');

  const inside = region(record, 'withUser(account.id', '} finally {');
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
  // residency, the per-account cap is what stops one account spending the
  // shared bound, and `forgetAccount` is what the non-router writes call. None
  // of them can see whether THIS memo asks for any of it, and no test can
  // drive a hundred distinct dashboard windows through a real Postgres.
  const text = src('api.js');

  // The literals, so this fails if either number is widened back toward
  // MAX_CACHED. 100 x the measured 499 KB is ~50 MB; 500 was ~250 MB, and
  // neither compose file sets a memory limit for that to be survivable in.
  assert.match(text, /const MAX_OVERVIEW_CACHED = 100;/,
    'MAX_OVERVIEW_CACHED must be its own number, stated here');
  assert.match(text, /const MAX_OVERVIEW_PER_ACCOUNT = 8;/,
    'one account must not be able to spend the whole shared bound');

  // Anchored on the binding, not on `createMemo(` — the first such call in the
  // file is this one only by luck, and a second memo added above it would
  // leave this guard quietly checking the wrong one.
  const call = region(text, 'const overviewMemo = createMemo(', '});');
  assert.ok(call.includes('max: MAX_OVERVIEW_CACHED'),
    'the overview memo must pass its own max, not inherit MAX_CACHED');
  assert.ok(call.includes('maxPerAccount: MAX_OVERVIEW_PER_ACCOUNT'),
    'without a per-account cap, one account paging history evicts every other account');
  assert.ok(call.includes('perAccount: true'),
    'the overview memo must be reachable by forgetAccount, or a button press cannot clear it');
});

/* ---------- reading your own writes, on more than one replica ---------- */

test('a fresh read is not served the memo, and its answer is stored', async () => {
  let calls = 0;
  const memo = createMemo(async () => `v${++calls}`, { ttlMs: 2_000 });

  assert.equal(await memo('5:w'), 'v1');
  assert.equal(await memo('5:w'), 'v1', 'control: an ordinary read inside the TTL is a hit');

  // The cross-replica case in miniature. This process never saw the write, so
  // `forget` never ran here and the entry above is still fresh by the clock —
  // the CLIENT is the only party that knows, and this is it saying so.
  assert.equal(await memo.fresh('5:w'), 'v2');
  assert.equal(calls, 2, 'the fresh read rebuilt rather than being served the entry');

  // ...and STORED, not merely bypassed: the refetch that paid for the rebuild
  // warms the memo for everything behind it. A `fresh` that read past the map
  // without writing to it would pass every assertion above this one.
  assert.equal(await memo('5:w'), 'v2', 'the next ordinary reader gets the rebuilt answer');
  assert.equal(calls, 2, 'and did not recompute to get it');
});

test('a fresh read does not join a computation that may predate the write', async () => {
  let calls = 0;
  const held = gate();
  const memo = createMemo(async () => { calls++; return held.opened; }, { ttlMs: 2_000 });

  // Started before this caller's write, and on a replica that never saw that
  // write there is nothing here that can tell — so joining it would hand back
  // exactly the pre-write answer being refused. `inflight` collapsing is the
  // right thing to lose here, and losing it is a choice rather than an
  // oversight.
  const early = memo('6:w');
  const fresh = memo.fresh('6:w');
  held.release('computed before the write');

  assert.equal(await early, 'computed before the write',
    'the caller that started first still gets the answer it started for');
  assert.equal(await fresh, 'computed before the write', 'and the fresh caller is answered too');

  // After the awaits, not before: `compute` is reached through
  // `Promise.resolve().then(...)`, so nothing has been called yet at the point
  // `memo.fresh` returns and a count taken there is 0 whatever the code does.
  assert.equal(calls, 2, 'the fresh read ran its own computation');
});

test('the client and the route spell the freshness header the same', () => {
  // `shared/public/offline.js` is browser code with no build step and does not
  // import this module, so the string is written twice on purpose — the same
  // shape `deviceClockHeader` next to it already has for `DEVICE_ZONE_HEADER`.
  // This is what stops the second copy drifting, and it is the whole reason
  // spelling it as a literal there is safe.
  const header = src('api.js').match(/const FRESH_HEADER = '([^']+)';/)?.[1];
  assert.ok(header, 'control: FRESH_HEADER is declared in api.js');

  const client = readFileSync(
    fileURLToPath(new URL('../../shared/public/offline.js', import.meta.url)), 'utf8');
  assert.match(
    client, new RegExp(`FRESH_HEADER = '${header}'`),
    `shared/public/offline.js must declare ${header}; a renamed header is a silently dead hint`
  );
  // The declaration alone is not the sending — a constant nothing reads is the
  // same silence with an extra line in it.
  assert.match(client, /\[FRESH_HEADER\]: '1'/,
    'and freshnessHeader must actually send it');

  // The PHONE is the third copy and the one that cannot import either of the
  // other two. It is guarded on its own side (`AppSettingsDefaultsTest`, which
  // reads both files), because Gradle is where a Kotlin file can be compiled;
  // named here so this test is not read as covering all three.
});

test('the /overview route honours the freshness header', () => {
  // Pinning the DECISION is not pinning the WIRING. Everything above proves
  // `memo.fresh` refuses a stale entry; none of it proves the route ever calls
  // it, and "the route reads no header at all" is exactly what this looked
  // like before. Source text, blind in the documented way, narrowed to the
  // route so a comment elsewhere cannot satisfy it.
  const route = code(region(src('api.js'), "api.get('/overview'", '}));'));
  assert.match(route, /req\.get\(FRESH_HEADER\)/, 'the route must read the header');
  assert.match(route, /overviewMemo\.fresh\(/, 'and reach the bypass with it');

  // ...and must NOT say so to caches, which is the counter-intuitive half and
  // the reason it is pinned here rather than left to a comment. `sw.js` stores
  // `/api/overview` with `cache.put(request, …)` and reads it back with
  // `caches.match(request)`, both of which select on the stored response's
  // `Vary`. This header rides on exactly one read — the refetch in the three
  // seconds after a write — so varying on it makes that read a different key
  // from every other. Measured in Chrome: the post-write `put` REPLACES the
  // cold-boot entry and the survivor matches only a request carrying the
  // header, so an offline boot gets `networkFirst`'s synthetic 503 and the
  // installed PWA opens to no dashboard at all.
  //
  // Nothing is lost: a `Vary` picks between stored representations and this
  // header is a demand to REBUILD, which a cache holding an entry cannot
  // satisfy. `overview-memo.integration.mjs` asserts the same thing about the
  // response's actual header, which is what makes this pair mutation-checkable
  // from both ends.
  assert.doesNotMatch(route, /res\.vary\(FRESH_HEADER\)/,
    'the route must not Vary on the freshness header — it splits the service ' +
    "worker's data cache and costs the offline dashboard entirely");
});

/* ---------- the bound in the unit that actually matters ---------- */

test('maxBytes without a sizeOf is refused at construction', () => {
  // A COUNT bound converts to a memory bound only through the entry cost, so a
  // byte bound with nothing to measure with would silently bound nothing —
  // which is precisely the shape (`a comment claiming a bound`) this whole
  // module exists because of. Loud at construction, not quiet under load.
  assert.throws(
    () => createMemo(async (a) => a, { ttlMs: 2_000, maxBytes: 1_000 }),
    /sizeOf/
  );
});

test('the memo is bounded by BYTES as well as by count', async () => {
  // `max` is deliberately far above what this reaches: the point is that the
  // count bound is not what stops it. Ten entries of 100 units (= 200 bytes at
  // two bytes a unit) is 2,000 bytes against a 1,000-byte budget, so half of
  // them have to go however many entries `max` would have allowed.
  const memo = createMemo(async (arg) => arg, {
    ttlMs: 2_000, max: 1_000, maxBytes: 1_000, sizeOf: (s) => s.length * 2,
  });

  for (let i = 0; i < 10; i++) await memo(`b${i}:w`, 'x'.repeat(100));

  const g = memo.gauge();
  assert.ok(g.bytes <= 1_000, `held ${g.bytes} bytes, over the 1000-byte budget`);
  assert.equal(g.entries, 5, 'five 200-byte entries is exactly the budget');
  // ...and it is the OLDEST that went, the same preference the other two
  // passes apply. A capBytes that evicted the newest would be bounded and
  // useless in the same way an evict that did would be.
  assert.equal(await memo('b0:w', 'rebuilt'), 'rebuilt', 'the oldest was dropped');
  assert.equal(await memo('b9:w', 'ignored'), 'x'.repeat(100), 'the newest was kept');
});

test('one huge entry does not evict everything behind it forever', async () => {
  // The budget is a total, so a single entry larger than the whole budget can
  // only ever be evicted by the pass that runs after IT is stored — which is
  // the ordering that keeps this from being a cache that holds nothing.
  const memo = createMemo(async (arg) => arg, {
    ttlMs: 2_000, maxBytes: 1_000, sizeOf: (s) => s.length * 2,
  });

  await memo('big:w', 'x'.repeat(5_000));
  assert.equal(memo.gauge().entries, 0, 'an entry over the whole budget is not kept');

  await memo('small:w', 'y'.repeat(10));
  assert.equal(memo.gauge().entries, 1, 'and it did not poison the cache behind it');
});

test('the sweep leaves an in-flight placeholder out of the byte total', async () => {
  const held = gate();
  const memo = createMemo(async (arg) => (arg === 'slow' ? held.opened : arg), {
    ttlMs: 2_000, maxBytes: 1_000, sizeOf: (s) => s.length * 2,
  });

  const inflight = memo('slow:w', 'slow');
  const g = memo.gauge();
  // Its size is genuinely not known yet, so counting it as anything would be
  // inventing a number — and counting it as large would evict settled entries
  // to make room for a cost nobody has measured.
  assert.equal(g.bytes, 0, 'a placeholder contributes no bytes');
  assert.equal(g.inflight, 1, 'but it is reported, so the gauge is not silent about it');

  held.release('z'.repeat(10));
  await inflight;
  assert.equal(memo.gauge().bytes, 20, 'and it is measured once it settles');
});

test('the /overview memo bounds itself in bytes and reports what it holds', () => {
  // Source text, blind the documented way. The behavioural halves are above;
  // what none of them can see is whether THIS memo asks for either, and no
  // test can drive 48 MB of real dashboards through a Postgres to find out.
  const text = src('api.js');

  assert.match(text, /const MAX_OVERVIEW_BYTES = 48 \* 1024 \* 1024;/,
    'the byte bound must be its own stated number');

  const call = region(text, 'const overviewMemo = createMemo(', '});');
  assert.ok(call.includes('maxBytes: MAX_OVERVIEW_BYTES'),
    'a count bound alone cannot see a 70x spread in entry cost');
  assert.ok(call.includes('sizeOf:'),
    'and maxBytes without sizeOf measures nothing');
  assert.ok(call.includes('JSON.stringify'),
    'the memo must hold the serialised payload, or sizeOf is an estimate and every hit re-stringifies');

  assert.match(text, /export const overviewMemoGauge/,
    'the memo must be readable from outside, or reaching either bound is silent');

  // The wiring half: a gauge nothing logs is `memo.size()` again.
  const server = readFileSync(
    fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  assert.match(server, /extra: \(\) => \(\{[^}]*overviewMemoGauge\(\)/,
    'the gauge must be on the runtime line beside pg_pool_max');
});

test('capBytes steps over an in-flight placeholder rather than freeing nothing', async () => {
  const held = gate();
  let slowCalls = 0;
  const memo = createMemo(async (arg) => {
    if (arg !== 'slow') return arg;
    slowCalls++;
    return held.opened;
  }, { ttlMs: 60_000, maxBytes: 1_000, sizeOf: (s) => s.length * 2 });

  // Registered FIRST, so it is the oldest thing in the map and therefore the
  // first candidate the eviction walk meets.
  const inflight = memo('slow:w', 'slow');

  // Six 200-byte entries against a 1,000-byte budget, so the last settle has
  // to evict something.
  for (let i = 0; i < 6; i++) await memo(`fill${i}:w`, 'x'.repeat(100));

  held.release('z'.repeat(10));
  assert.equal(await inflight, 'z'.repeat(10),
    'control: the caller awaiting it is answered either way');

  // Taking the placeholder frees NOTHING — its size is not known yet, so it
  // counts as 0 — and costs three things: the computation is wasted, its
  // answer fails the store-identity guard and is never cached, and the burst
  // it was collapsing re-forms. All to make no room at all. This is the same
  // exemption `remember` and the TTL sweep already make, in the third pass
  // that also has to make it.
  assert.equal(await memo('slow:w', 'slow'), 'z'.repeat(10));
  assert.equal(slowCalls, 1, 'the settled answer was stored, not recomputed');
});
