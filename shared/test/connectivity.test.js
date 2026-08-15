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

  // `hanging` is the failure this module exists for and the one a fake is most
  // likely to paper over: a server that accepts the connection and never
  // answers. `reachable: false` is the easy shape (a refused connection, which
  // a real browser rejects in about 3ms) and proves nothing about a timeout.
  const state = { reachable: true, hanging: false, requests: 0 };

  globalThis.window = { addEventListener: add, removeEventListener: remove };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: add,
    removeEventListener: remove,
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true }, configurable: true, writable: true,
  });

  // Honour the signal. The fake AbortController that used to stand here had
  // `signal = {}` and an `abort()` that did nothing, against a `fetch` that
  // ignored both — so any test asserting that a hang is given up on passed
  // whether or not the code under test had a timeout at all. Node's real
  // AbortController is used now, and this rejects when it fires, exactly as a
  // browser's fetch does.
  globalThis.fetch = async (_url, init = {}) => {
    state.requests++;
    if (state.hanging) {
      return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(
          new Error('The operation was aborted'), { name: 'AbortError' }
        ));
        if (init.signal?.aborted) fail();
        else init.signal?.addEventListener('abort', fail);
        // With no signal this promise never settles, which is the point.
      });
    }
    if (!state.reachable) throw new Error('ECONNREFUSED');
    return { ok: true };
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
  const { stop } = watchConnectivity((online) => seen.push(online), { maxDelayMs: 200, initialDelayMs: 50 });
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

  const { stop } = watchConnectivity(() => {}, { maxDelayMs: 200, initialDelayMs: 50 });
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
  const { stop } = watchConnectivity((online) => seen.push(online), { maxDelayMs: 80, initialDelayMs: 40 });
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
  const { stop } = watchConnectivity((online) => seen.push(online), { maxDelayMs: 5000, initialDelayMs: 3000 });
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
  const { stop } = watchConnectivity((online) => seen.push(online), { maxDelayMs: 5000, initialDelayMs: 3000 });
  await sleep(200);

  env.state.reachable = false;
  env.fire('offline');
  // No await beyond a tick: this must not depend on a network round trip.
  await sleep(20);
  assert.deepEqual(seen, [true, false]);

  stop();
});

test('a failed request of our own is an input, not just an output', async () => {
  // The hole this closes: while the watcher believes it is online it makes no
  // requests, and `online` / `offline` / `visibilitychange` none of them fire
  // when the interface is up and only the route is dead. So the app's own
  // failed write is the only thing that ever finds out, and before there was
  // an entry point for it the app went through an entire outage still looking
  // connected — no banner, and the queued-write badge hidden inside it.
  const env = fakeEnv();
  const { watchConnectivity } = await import('../public/offline.js');

  const seen = [];
  const { stop, reportOffline } = watchConnectivity(
    (online) => seen.push(online), { maxDelayMs: 200, initialDelayMs: 50 },
  );
  await sleep(150);
  assert.deepEqual(seen, [true], 'starts online');

  // A write just failed. No probe: the failure IS the evidence.
  env.state.reachable = false;
  const before = env.state.requests;
  reportOffline();
  await sleep(10);
  assert.deepEqual(seen, [true, false], 'reported offline on the first failure');
  assert.equal(env.state.requests, before,
    'asked the server to confirm what a failed request had already proved');

  stop();
});

test('a reported failure arms the poll, so the banner comes back down', async () => {
  // The trap that makes this more than a one-liner. Setting the state behind
  // the watcher's back leaves its own `last` at true: it neither starts polling
  // nor ever reports the transition it missed, so the banner sticks until a
  // `visibilitychange` happens to re-probe. Recovery with no event fired at all
  // is the only assertion that can tell the two apart.
  const env = fakeEnv();
  const { watchConnectivity } = await import('../public/offline.js');

  const seen = [];
  const { stop, reportOffline } = watchConnectivity(
    (online) => seen.push(online), { maxDelayMs: 200, initialDelayMs: 50 },
  );
  await sleep(150);

  env.state.reachable = false;
  reportOffline();
  await sleep(10);
  assert.deepEqual(seen, [true, false]);

  env.state.reachable = true;
  await sleep(600);            // nothing fired; only the backoff poll can find it
  assert.deepEqual(seen, [true, false, true],
    'never polled, so it never noticed the server came back');

  stop();
});

test('a probe against a server that answers nothing gives up', async () => {
  // The shape with no ceiling: the connection is accepted and no response ever
  // arrives. Chrome imposes no cap on that — measured still pending at 300s —
  // so `isReachable`'s own timeout is the only thing that ends it, and a fake
  // that ignores the signal would report this as passing with no timeout at all.
  const env = fakeEnv();
  const { isReachable } = await import('../public/offline.js');

  env.state.hanging = true;
  const started = Date.now();
  const reachable = await isReachable('/healthz', 80);
  const elapsed = Date.now() - started;

  assert.equal(reachable, false, 'a server that never answers is not reachable');
  assert.ok(elapsed < 1000, `waited ${elapsed}ms on a request that never settles`);
});

test('stopping removes every listener it added', async () => {
  // The watcher is started once per page today, but a leaked
  // `visibilitychange` handler would keep probing after teardown.
  const env = fakeEnv();
  const { watchConnectivity } = await import('../public/offline.js');

  const { stop } = watchConnectivity(() => {}, { maxDelayMs: 5000, initialDelayMs: 3000 });
  await sleep(150);

  assert.ok(env.countOf('visibilitychange') > 0, 'expected a visibility listener');
  stop();

  assert.equal(env.countOf('online'), 0);
  assert.equal(env.countOf('offline'), 0);
  assert.equal(env.countOf('visibilitychange'), 0);
});
