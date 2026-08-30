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
  // `withUserWrite` COMMITs after its callback returns (`db/pool.js`, through
  // the `withUser` it wraps — the version bump goes in ahead of it), so a
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

  const inside = region(record, 'withUserWrite(account.id', '} finally {');
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
  // MAX_CACHED. Why 3,300 rather than the 100 that was here is the subject of
  // the bounds test further down; what this one asks is only that the memo has
  // a number of its OWN.
  assert.match(text, /const MAX_OVERVIEW_CACHED = 3_300;/,
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

/* ---------- the version in the key, and the window it is served in spite of ---------- */

test('the account prefix survives the version being spliced into the key', async () => {
  // #192 puts `data_version` SECOND, between the account id and the window, and
  // both of the things that match on a prefix take everything up to the FIRST
  // separator (`accountPrefix`, cache.js). So this is asking that the change
  // the route made is invisible to them — not by reading the code, which is
  // where "the prefix is unchanged" would be an assumption, but by forgetting
  // one account and watching the other keep its answer.
  const memo = createMemo(async (arg) => arg, { ttlMs: 2_000, perAccount: true });
  await memo('1:7:2026-08-01:2026-08-30:2026-08-30:false', 'one at v7');
  await memo('12:7:2026-08-01:2026-08-30:2026-08-30:false', 'twelve at v7');

  forgetAccount(1);

  assert.equal(await memo('1:7:2026-08-01:2026-08-30:2026-08-30:false', 'rebuilt'), 'rebuilt');
  assert.equal(await memo('12:7:2026-08-01:2026-08-30:2026-08-30:false', 'ignored'), 'twelve at v7',
    'forgetting account 1 must not forget account 12, version in the key or not');
});

test("an account's superseded versions are charged to its own share, not to another's", async () => {
  // The other prefix reader. Every write bumps the version, so one account's
  // keys now differ in the middle as well as at the end — and the entries at
  // versions nobody will ask for again have to be evicted from ITS allowance.
  const time = clock();
  const memo = createMemo(async (arg) => arg,
    { ttlMs: 60_000, max: 50, maxPerAccount: 2, perAccount: true, now: time.now });

  await memo('4:1:w', 'v1');
  await memo('4:2:w', 'v2');
  await memo('9:1:w', 'the neighbour');
  await memo('4:3:w', 'v3');          // account 4 is now over its share

  assert.equal(await memo('4:1:w', 'recomputed'), 'recomputed',
    'the account over its cap gives up its own oldest version');
  assert.equal(await memo('9:1:w', 'ignored'), 'the neighbour',
    'and the neighbour keeps its answer');
});

test('peek answers hit, join or nothing, and computes none of them', async () => {
  // The route needs the three cases APART, because it is holding a pool
  // connection when it asks and only one of the three wants it. `memo()` itself
  // cannot answer that: it acts on the case as well as deciding it.
  const time = clock();
  const held = gate();
  let calls = 0;
  const memo = createMemo(async (arg) => {
    calls++;
    return arg === 'slow' ? held.opened : arg;
  }, { ttlMs: 2_000, now: time.now });

  assert.equal(memo.peek('1:9:w'), undefined, 'nothing here yet');
  assert.equal(calls, 0, 'and a peek does not start a computation');

  const inflight = memo('1:9:slow', 'slow');
  assert.deepEqual(Object.keys(memo.peek('1:9:slow')), ['inflight'],
    'a running computation is offered to be joined, not repeated');
  held.release('answer');
  await inflight;

  assert.deepEqual(memo.peek('1:9:slow'), { value: 'answer' }, 'and settles into a value');
  assert.equal(calls, 1, 'still one computation for all of that');

  // The TTL is the memo's own, so a peek can never hand back something `memo()`
  // would have refused — which is the only way the split could be wrong.
  time.advance(2_001);
  assert.equal(memo.peek('1:9:slow'), undefined, 'an expired entry is not offered');
});

/* ---------- the route's half of all of that ---------- */

test('the /overview key carries the version, and the version is read BEFORE the data', () => {
  // Source text, blind in the documented way — and the ORDERING is the half no
  // behavioural test in this repo can reach, because the case that separates
  // the two needs a write committing between the version read and the queries
  // after it, which nothing over HTTP can arrange. Stated here and argued in
  // full at the read itself.
  //
  // Which way it is wrong is why it is worth a guard at all: version-first tags
  // an entry OLDER than its data, and that entry is simply unreachable and gets
  // rebuilt. Version-last tags one NEWER than its data, every later reader asks
  // for exactly that key, and all of them are served the stale payload for the
  // whole 60 s TTL.
  const route = code(region(src('api.js'), "api.get('/overview'", '}));'));

  assert.match(route, /keyAt = \(version\) => `\$\{user\}:\$\{version\}:\$\{windowKey\}`/,
    'the version must be in the key, and second — first is the account prefix');

  const read = route.indexOf('SELECT data_version');
  const build = route.indexOf('overviewMemo(key');
  assert.notEqual(read, -1, 'control: the route must read the version at all');
  assert.notEqual(build, -1, 'control: the route must reach the memo at all');
  assert.ok(read < build, 'the version is read before the rebuild, never after');
});

test('the version read and the rebuild share ONE transaction', () => {
  // A miss is already checking out a connection, so the read is free there —
  // and a second `withUser` would make every miss pay two checkouts to save
  // nothing. Both halves are guarded: the route opens the transaction and hands
  // it down, and `buildOverview` no longer opens one of its own.
  const text = src('api.js');
  const route = code(region(text, "api.get('/overview'", '}));'));

  const tx = region(route, 'await withUser(user,', '  });');
  assert.match(tx, /SELECT data_version/, 'the version read is inside the transaction');
  assert.match(tx, /overviewMemo\(key, \{ db, \.\.\.arg \}\)/,
    'and so is the rebuild, on the same connection');

  const build = code(region(text, 'async function buildOverview(', '\n}\n'));
  assert.ok(!build.includes('withUser('),
    'buildOverview must use the transaction it is handed, not open a second one');
});

test('a joiner hands its connection back BEFORE waiting, not after', () => {
  // **This reads SOURCE TEXT, so it cannot see a renamed binding or an
  // inverted comparison** — the blindness every guard in this block shares, and
  // the reason the root CLAUDE.md asks for a behavioural test beside one. Here
  // the behavioural halves are next door and injected: `peek answers hit, join
  // or nothing, and computes none of them` pins the three cases apart, and `a
  // burst on a cold memo costs one computation, not one each` pins that a join
  // is a join. What neither can see is the ROUTE choosing between them, which
  // is the whole reason `memo.peek` exists at all — a caller that had nothing
  // else to spend would just call `memo()`.
  //
  // And nothing over HTTP can see it either, which is why this guard is here
  // rather than in `overview-memo.integration.mjs`. That suite had a
  // six-request burst check asserting every caller was answered 200 with the
  // same bytes; both are true of six INDEPENDENT rebuilds over data nothing is
  // writing to, and it passed with the join disabled at the route AND in
  // `memo()`. It is deleted, and its header records why.
  //
  // What is at stake is the pool rather than a recomputation. A waiter that
  // blocks inside `withUser` holds one of `PG_POOL_MAX` = 10 connections for
  // the length of SOMEBODY ELSE's rebuild — four tabs foregrounding at once is
  // four connections spent waiting to be handed one answer, which is the burst
  // this memo exists to collapse spending the pool it exists to protect.
  const route = code(region(src('api.js'), "api.get('/overview'", '}));'));
  const tx = region(route, 'await withUser(user,', '  });');

  assert.match(tx, /overviewMemo\.peek\(/,
    'the three cases must be told apart while the connection is still in hand');
  assert.match(tx, /return \{ pending:/,
    'a joiner hands the promise back out rather than settling it in here');
  assert.ok(!/await\s+[\w.]*inflight/.test(tx),
    'the joined computation must never be awaited inside the transaction: '
    + 'that is one held connection per waiter, for the length of one rebuild');

  // ...and it IS awaited once out there. A `pending` nobody waits on is an
  // empty body, so the negative above needs this to be worth anything.
  const txEnd = route.indexOf(tx) + tx.length;
  const joined = route.search(/await\s+[\w.]*\.pending/);
  assert.notEqual(joined, -1, 'control: something must await the joined computation');
  assert.ok(joined > txEnd,
    'and it must happen after the transaction has closed, holding nothing');
});

test('no mutating route in api.js writes through bare withUser', () => {
  // The bump lives in `withUserWrite` (`db/pool.js`), so a route that writes
  // through bare `withUser` changes the account's data and announces nothing:
  // every `/overview` entry built before it stays reachable on every replica
  // for the whole 60 s TTL, and the only thing that catches it is
  // `forgetAccount` clearing the one process the write happened to land on.
  // That cost used to be ≤ 2 s of cross-replica staleness and is now ≤ 60 s.
  //
  // **This reads SOURCE TEXT, so it cannot see a renamed binding, a wrapper
  // that forwards to bare `withUser`, or a write issued through the `pool`
  // directly.** The behavioural suite underneath it is
  // `test/data-version.integration.mjs` (`npm run test:dataversion -w
  // habiterall-cloud`), which reads `data_version` out of band with the ADMIN
  // connection before and after a request and requires it to have strictly
  // increased. What that suite cannot do is notice a route it was never told
  // about — it enumerates the write paths by hand, one case each — which is
  // exactly what this covers and why the two are worth having together.
  //
  // **The rule is general; its BLINDNESS is what has to be listed.** Two
  // deliberate things sit outside the enumeration below, and neither is
  // weakened away:
  //
  //  - `api.use(...)` middleware is not enumerated at all. The device-zone
  //    middleware writes `users.device_time_zone` through bare `withUser` on
  //    GETs and must NOT bump — bumping on a read would invalidate an
  //    account's dashboards on its own reads. So a rule that reached the
  //    middleware would have to exempt it by name, and a `api.use` write path
  //    added later is not seen here. `docs/decisions/caching.md`'s "One write
  //    deliberately does not bump" is where that exception is argued.
  //  - `getHabit(req)` reads through bare `withUser` and IS called from
  //    mutating handlers. It is a top-level helper, so it falls outside every
  //    handler region below and the negative assertion never meets it. That is
  //    why the negative half is written against the handler's own text rather
  //    than against everything it transitively calls.
  //
  // The negative half is therefore stricter than the correctness property: a
  // read-only `withUser` inline in a mutating handler would be perfectly
  // sound and would still fail here. No handler does one today, and making
  // the first one a reviewed act is the point — the alternative is a positive
  // assertion alone, which passes on a handler that writes twice and bumps
  // once.
  const text = src('api.js');

  const handlers = [...text.matchAll(
    /^api\.(post|put|patch|delete)\('([^']+)'[\s\S]*?^\}\)\);$/gm)];

  // Control: an anchor reworded or a route written some other way turns the
  // walk below into a loop over nothing, which is the "test that cannot fail"
  // shape this file's `region` helper exists because of.
  assert.ok(handlers.length >= 14,
    `only ${handlers.length} mutating handlers found — the enumeration has `
    + 'stopped matching, so this guard tested nothing');
  const found = handlers.map(([, method, path]) => `${method.toUpperCase()} ${path}`);
  for (const named of ['PUT /habits/:id/entries/:date',
    'DELETE /habits/:id/entries/:date', 'POST /import', 'PUT /settings']) {
    assert.ok(found.includes(named), `control: ${named} must be among ${found.join(', ')}`);
  }

  for (const [whole, method, path] of handlers) {
    // Comments only, in both directions: a positive source guard can be
    // satisfied by a comment and a negative one can be failed by one — and
    // `POST /notify/test` carries a paragraph about `withUserWrite` for
    // exactly the reason this guard exists.
    const body = code(whole);
    const name = `${method.toUpperCase()} ${path}`;

    assert.ok(body.includes('withUserWrite('),
      `${name} reaches no withUserWrite: whatever it changes, nothing bumps `
      + 'data_version and every replica keeps serving its pre-write dashboard');
    // `withUserWrite(` does not match this — the paren is what separates them.
    assert.ok(!/withUser\(/.test(body),
      `${name} calls bare withUser: that transaction does not bump `
      + 'data_version, so anything it writes is invisible to the /overview key');
  }
});

test('at the new TTL the byte bound still binds before the count', () => {
  // The count was 100, sized against "the live set is PG_POOL_MAX x TTL" — an
  // argument that only holds while the TTL is short. At 60 s it is gone, and a
  // count of 100 would evict entries that are still fresh: all of the sweep,
  // none of the hits. So `MAX_OVERVIEW_BYTES` has to be what actually bounds
  // this cache, and that is only true if the count is above the number of
  // entries 48 MB holds — at the SMALLEST real entry, which is the one that
  // reaches a count bound first.
  //
  // The sizes are measured over the real route (`MAX_OVERVIEW_CACHED`'s comment
  // has the table) and restated here as literals rather than imported, so this
  // pins the arithmetic and not a pair of names.
  const text = src('api.js');
  assert.match(text, /const MAX_OVERVIEW_CACHED = 3_300;/);
  assert.match(text, /const MAX_OVERVIEW_BYTES = 48 \* 1024 \* 1024;/);

  // The TTL is pinned HERE because the count above is derived from it: 3,300 is
  // only the right number while the residency argument the 60 s replaced —
  // "the live set is `PG_POOL_MAX` x TTL" — is the dead one. Drop the TTL back
  // to seconds and the count is three orders of magnitude too large; raise it
  // again and 48 MB is doing even more of the work alone. A literal, per the
  // root `CLAUDE.md`: importing the constant would pin its name and nothing
  // else, and the `fresh` window it replaced passed for months with 7 widened
  // to 30 while its own comment claimed the boundary was covered.
  //
  // It is asserted in this suite rather than only in
  // `overview-memo.integration.mjs` because that one needs Postgres, so a drift
  // would be invisible to `npm test` — which is the run that gates a commit.
  assert.match(text, /const OVERVIEW_TTL_MS = 60_000;/,
    'the TTL the count above is derived from');

  // ...and then read back out of the source, so changing the literal in one
  // place and the assertion above in the other still fails here.
  const maxCached = Number(
    text.match(/const MAX_OVERVIEW_CACHED = ([\d_]+);/)[1].replace(/_/g, ''));
  const maxBytes = 48 * 1024 * 1024;

  for (const [shape, kb] of [
    ['8 habits x 30 days (typical)', 15.1],
    ['8 habits x 365 days', 93.6],
    ['20 habits x 365 days', 233.4],
    ['50 habits x 365 days', 582.9],
  ]) {
    const fits = Math.floor(maxBytes / (kb * 1024));
    assert.ok(fits <= maxCached,
      `${shape}: ${fits} entries of ${kb} KB fit in 48 MB, so the COUNT (${maxCached}) `
      + 'binds first and the memo evicts entries that are still fresh');
  }
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
