import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MAX_CACHED, remember } from '../src/cache.js';

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
