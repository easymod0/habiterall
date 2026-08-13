import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * `watchConnectivity` against a fake window/document.
 *
 * The behaviour that matters is what the browser's `online` event does NOT
 * cover: the server restarting while the network never drops. That left the
 * app stuck showing "offline" until a manual reload, and no amount of
 * listening to `online` would have fixed it.
 */

/** Install a fake DOM and return handles to drive it. */
function fakeEnv() {
  const listeners = {};
  const add = (t, f) => { (listeners[t] ??= []).push(f); };
  const remove = (t, f) => {
    listeners[t] = (listeners[t] ?? []).filter((x) => x !== f);
  };

  const state = { reachable: true, requests: 0 };

  globalThis.window = { addEventListener: add, removeEventListener: remove };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: add,
    removeEventListener: remove,
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true }, configurable: true, writable: true,
  });
  globalThis.fetch = async () => {
    state.requests++;
    if (!state.reachable) throw new Error('ECONNREFUSED');
    return { ok: true };
  };
  globalThis.AbortController = class {
    constructor() { this.signal = {}; }
    abort() {}
  };

  return {
    state,
    listeners,
    fire: (type) => (listeners[type] ?? []).forEach((f) => f()),
    countOf: (type) => (listeners[type] ?? []).length,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('recovers when the server returns without any network event', async () => {
  // The case that motivated all of this: `node server.js` is restarted while
  // the Wi-Fi never drops, so `online` never fires. Only polling finds it.
  const env = fakeEnv();
  const { watchConnectivity } = await import('../public/offline.js');

  const seen = [];
  const stop = watchConnectivity((online) => seen.push(online), { maxDelayMs: 200, initialDelayMs: 50 });
  await sleep(250);
  assert.deepEqual(seen, [true], 'starts online');

  env.state.reachable = false;
  env.fire('online');            // a failed request, not a real reconnection
  await sleep(500);
  assert.deepEqual(seen, [true, false], 'notices the server is gone');

  env.state.reachable = true;
  await sleep(1200);             // no events fired at all — the poll must find it
  assert.deepEqual(seen, [true, false, true],
    'recovered by polling, with no network event');

  stop();
});

test('polls only while offline, never while healthy', async () => {
  // A poll every few seconds on a phone is a battery cost, and the app is
  // healthy the overwhelming majority of the time.
  const env = fakeEnv();
  const { watchConnectivity } = await import('../public/offline.js');

  const stop = watchConnectivity(() => {}, { maxDelayMs: 200, initialDelayMs: 50 });
  await sleep(250);

  const afterStartup = env.state.requests;
  await sleep(900);
  assert.equal(env.state.requests, afterStartup,
    `made ${env.state.requests - afterStartup} needless requests while online`);

  stop();
});

test('only reports genuine transitions, not every poll', async () => {
  // The app reloads the dashboard on reconnect, so a callback per poll would
  // re-render and re-toast every couple of seconds during an outage.
  const env = fakeEnv();
  const { watchConnectivity } = await import('../public/offline.js');

  const seen = [];
  const stop = watchConnectivity((online) => seen.push(online), { maxDelayMs: 80, initialDelayMs: 40 });
  await sleep(200);

  env.state.reachable = false;
  env.fire('online');
  await sleep(900);   // several polls, all failing

  assert.equal(seen.filter((x) => x === false).length, 1,
    `reported offline ${seen.filter((x) => x === false).length} times`);

  stop();
});

test('re-probes when the tab becomes visible', async () => {
  // A backgrounded tab is where the world is most likely to have changed.
  const env = fakeEnv();
  const { watchConnectivity } = await import('../public/offline.js');

  const seen = [];
  const stop = watchConnectivity((online) => seen.push(online), { maxDelayMs: 5000, initialDelayMs: 3000 });
  await sleep(200);
  assert.deepEqual(seen, [true]);

  env.state.reachable = false;
  env.fire('visibilitychange');
  await sleep(300);
  assert.deepEqual(seen, [true, false], 'the visibility probe caught it');

  stop();
});

test('the offline event reports immediately, without waiting for a probe', async () => {
  // Losing Wi-Fi is unambiguous; making the user wait on a fetch timeout to
  // be told so would be worse than useless.
  const env = fakeEnv();
  const { watchConnectivity } = await import('../public/offline.js');

  const seen = [];
  const stop = watchConnectivity((online) => seen.push(online), { maxDelayMs: 5000, initialDelayMs: 3000 });
  await sleep(200);

  env.state.reachable = false;
  env.fire('offline');
  // No await beyond a tick: this must not depend on a network round trip.
  await sleep(20);
  assert.deepEqual(seen, [true, false]);

  stop();
});

test('stopping removes every listener it added', async () => {
  // The watcher is started once per page today, but a leaked
  // `visibilitychange` handler would keep probing after teardown.
  const env = fakeEnv();
  const { watchConnectivity } = await import('../public/offline.js');

  const stop = watchConnectivity(() => {}, { maxDelayMs: 5000, initialDelayMs: 3000 });
  await sleep(150);

  assert.ok(env.countOf('visibilitychange') > 0, 'expected a visibility listener');
  stop();

  assert.equal(env.countOf('online'), 0);
  assert.equal(env.countOf('offline'), 0);
  assert.equal(env.countOf('visibilitychange'), 0);
});
