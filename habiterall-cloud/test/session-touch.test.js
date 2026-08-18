import test from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_COOKIE } from '@habiterall/shared/security.js';

import { throttleTouch, TOUCH_INTERVAL_MS } from '../src/session-touch.js';

/** A clock the test moves by hand, so an hour costs no time. */
const clock = (start = 1_000) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

/** A store that records what reached it, standing in for connect-pg-simple. */
const fakeStore = () => {
  const calls = { touch: [], set: [], destroy: [] };
  return {
    calls,
    touch(sid, sess, cb) { calls.touch.push(sid); cb?.(null); },
    set(sid, sess, cb) { calls.set.push(sid); cb?.(null); },
    destroy(sid, cb) { calls.destroy.push(sid); cb?.(null); },
  };
};

const touch = (store, sid) => new Promise((res) => store.touch(sid, {}, res));

/**
 * Every test here is bounded, because the interesting way this breaks is a
 * HANG rather than a wrong answer: skip the callback and express-session waits
 * on it forever. Without a bound, that regression stalls the whole run instead
 * of failing it — mutation-testing it wedged `node --test` until it was killed.
 */
const BOUNDED = { timeout: 2_000 };

test('a burst of requests writes the row once, not once each', BOUNDED, async () => {
  const store = throttleTouch(fakeStore(), { now: clock().now });

  // What a page load does: about five requests at once, one session.
  await Promise.all(Array.from({ length: 5 }, () => touch(store, 'sid-a')));

  assert.equal(store.calls.touch.length, 1);
});

test('the callback still runs on a skipped touch', BOUNDED, async () => {
  // The failure this guards is not a slow response, it is no response at all:
  // express-session waits on this callback before finishing the request, so a
  // throttle that returned without calling it would hang every request it
  // skipped — and only the ones it skipped, so the first would look fine.
  const store = throttleTouch(fakeStore(), { now: clock().now });
  await touch(store, 'sid-a');

  const ran = await Promise.race([
    touch(store, 'sid-a').then(() => 'called back'),
    new Promise((res) => setTimeout(() => res('HUNG'), 50)),
  ]);

  assert.equal(ran, 'called back');
  assert.equal(store.calls.touch.length, 1);
});

test('the expiry still slides, once the interval has passed', BOUNDED, async () => {
  const time = clock();
  const store = throttleTouch(fakeStore(), { now: time.now });

  await touch(store, 'sid-a');
  assert.equal(store.calls.touch.length, 1);

  // Assert the literal rather than importing the constant into the comparison:
  // a test that reads TOUCH_INTERVAL_MS on both sides passes if it changes to
  // a year. One hour, in milliseconds.
  assert.equal(TOUCH_INTERVAL_MS, 3_600_000);

  time.advance(3_599_999);
  await touch(store, 'sid-a');
  assert.equal(store.calls.touch.length, 1, 'still inside the interval');

  time.advance(1);
  await touch(store, 'sid-a');
  assert.equal(store.calls.touch.length, 2, 'past it, the row is written');
});

test('the interval stays a small fraction of the window it slides', BOUNDED, () => {
  // The case for an hour is arithmetic over `SESSION_COOKIE.maxAge` — 0.3% of
  // a fourteen-day window. But that constant lives in another package and
  // serves both editions, so the rule is written in two files and only one of
  // them knows it is holding one.
  //
  // Shorten the window past the interval and an ACTIVE session is signed out in
  // silence: the row is written once for `t0 + maxAge`, every touch until
  // `t0 + 1h` is skipped, and the row is gone while the cookie — refreshed on
  // every response by `rolling: true` — still claims a live session. Nothing
  // else in this repo notices. The tests above inject their own clock, and the
  // integration suite only ever asserts that `expire` does NOT move, which is
  // exactly what a session nobody is renewing also looks like.
  const staleFraction = TOUCH_INTERVAL_MS / SESSION_COOKIE.maxAge;
  assert.ok(TOUCH_INTERVAL_MS * 24 <= SESSION_COOKIE.maxAge,
    `TOUCH_INTERVAL_MS of ${TOUCH_INTERVAL_MS}ms against a ${SESSION_COOKIE.maxAge}ms `
    + `window lets the stored expiry fall ${(staleFraction * 100).toFixed(1)}% behind `
    + 'the cookie. Shorten the interval, or say here why this window can carry it.');
});

test('sessions are throttled independently', BOUNDED, async () => {
  const store = throttleTouch(fakeStore(), { now: clock().now });

  await touch(store, 'sid-a');
  await touch(store, 'sid-b');
  await touch(store, 'sid-a');

  // Two different users must not throttle each other — the whole point is that
  // the lock is per row, so the bookkeeping has to be per row too.
  assert.deepEqual(store.calls.touch, ['sid-a', 'sid-b']);
});

test('a real save counts as a write, so the next request does not repeat it', BOUNDED, async () => {
  const time = clock();
  const store = throttleTouch(fakeStore(), { now: time.now });

  // Login writes the row through `set`.
  await new Promise((res) => store.set('sid-a', { user: 1 }, res));
  await touch(store, 'sid-a');

  assert.equal(store.calls.set.length, 1);
  assert.equal(store.calls.touch.length, 0, 'the row was just written by set');
});

test('destroy forgets the session, so a reused id is not skipped', BOUNDED, async () => {
  const time = clock();
  const store = throttleTouch(fakeStore(), { now: time.now });

  await touch(store, 'sid-a');
  await new Promise((res) => store.destroy('sid-a', res));
  await touch(store, 'sid-a');

  assert.deepEqual(store.calls.destroy, ['sid-a']);
  assert.equal(store.calls.touch.length, 2);
});

test('the map is bounded, and the penalty for forgetting is one extra write', BOUNDED, async () => {
  const store = throttleTouch(fakeStore(), { now: clock().now, maxEntries: 4 });

  for (let i = 0; i < 50; i++) await touch(store, `sid-${i}`);

  // The bound is what matters: two per-user caches in this codebase have
  // claimed one and had none.
  assert.ok(store.touchStats().session_touch_tracked <= 4,
    `tracked ${store.touchStats().session_touch_tracked}`);
});

test('the saving is reported, not merely believed', BOUNDED, async () => {
  const store = throttleTouch(fakeStore(), { now: clock().now });

  await Promise.all(Array.from({ length: 5 }, () => touch(store, 'sid-a')));

  assert.equal(store.touchStats().session_touch_skipped, 4);
});

test('a store with no touch of its own is left alone', BOUNDED, () => {
  // MemoryStore in a test rig, or any store that never implemented touch.
  const bare = { get() {}, set() {}, destroy() {} };
  assert.doesNotThrow(() => throttleTouch(bare));
  assert.equal(bare.touch, undefined);
});
