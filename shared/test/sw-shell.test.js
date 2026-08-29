import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `shellFirst`, from the REAL `sw.js`, run in Node against a fake
 * `self`/`caches`. Copies `connectivity.test.js`'s discipline: `sw.js` is a
 * classic worker script (no `import`/`export` allowed — see its own
 * `CLAUDE.md` note), so it is driven the same way that file drives
 * `offline.js` — a fake environment installed on `globalThis` before import,
 * real `fetch`/`Request`/`Response`/`Headers`/`URL` from Node itself.
 *
 * The shape this exists for: a server that accepts the connection and never
 * answers. `shellFirst`'s `revalidateFirst` branch awaits that fetch BEFORE
 * looking at the cache one line below, so an unbounded fetch there is an
 * installed PWA that opens to nothing at all, even with `/index.html` sitting
 * in the shell cache the whole time.
 */

const SW_URL = pathToFileURL(path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sw.js',
)).href;

/** Install a fake worker global and return the captured listeners. */
function installFakeSelf() {
  const listeners = {};
  globalThis.self = {
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    location: { origin: 'https://example.test' },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  return listeners;
}

/**
 * Fake `caches` over a `Map` of named stores, each itself a `Map<url, Response>`.
 * Keyed on `request.url` (a plain string), which is all `keyFor` needs — the
 * fake requests below carry no other identity `caches.match`/`.put` could key on.
 */
function installFakeCaches() {
  const stores = new Map();
  const keyFor = (request) => (typeof request === 'string' ? request : request.url);
  const storeFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };

  globalThis.caches = {
    open: async (name) => {
      const store = storeFor(name);
      return {
        match: async (request) => store.get(keyFor(request)),
        put: async (request, response) => { store.set(keyFor(request), response); },
        keys: async () => [...store.keys()],
        delete: async (request) => store.delete(keyFor(request)),
      };
    },
    // Top-level `caches.match` searches every named cache, the same as a real
    // browser's does across a worker's whole cache storage.
    match: async (request) => {
      for (const store of stores.values()) {
        const hit = store.get(keyFor(request));
        if (hit) return hit;
      }
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };

  return { seed: (name, url, response) => storeFor(name).set(url, response) };
}

/**
 * The fake `fetch` that honours an abort signal and hangs when there is none —
 * `connectivity.test.js:37-52`'s shape and reason: a fake `AbortController`
 * with `signal = {}` and a no-op `abort()` made a hang-and-assert-aborted test
 * pass with no timeout in the code under test at all.
 */
function installFakeFetch() {
  globalThis.fetch = async (_input, init = {}) => new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(
      new Error('The operation was aborted'), { name: 'AbortError' },
    ));
    if (init.signal?.aborted) fail();
    else init.signal?.addEventListener('abort', fail);
    // With no signal this promise never settles — which is the point.
  });
}

/**
 * Stub `AbortSignal.timeout` for the duration of a test: record the
 * milliseconds it was asked for, and hand back a signal already aborted, so
 * a fixed `shellFirst` gives up on the hung fetch above immediately rather
 * than after a real 10s. `sw.js` looks `AbortSignal.timeout` up off the
 * global at call time, so reassigning the static here reaches it.
 */
function stubAbortTimeout() {
  const original = AbortSignal.timeout;
  const calls = [];
  AbortSignal.timeout = (ms) => {
    calls.push(ms);
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  };
  return { calls, restore: () => { AbortSignal.timeout = original; } };
}

/**
 * A fake `Request`. `shellFirst` reads only `.mode` and `.destination`; the
 * `fetch` listener above it also reads `.method` and `.url`. Node's real
 * `Request` refuses `mode: 'navigate'` (the Fetch spec's constructor rejects
 * it outright), so a plain object carrying exactly those four fields plus
 * whatever the fake `caches` keys on (`.url`) is used instead of fighting it.
 */
function fakeRequest({ url, mode, destination }) {
  return { url, method: 'GET', mode, destination };
}

/**
 * `sw.js` does `const sw = self;` and registers its listeners at import
 * time, so a fresh fake `self` per test needs a fresh module evaluation too —
 * Node's ESM cache would otherwise hand back the module from the FIRST test's
 * import, whose listeners still close over that test's `self`. The query
 * string makes each import a distinct module identity.
 */
async function loadFetchListener() {
  const listeners = installFakeSelf();
  await import(`${SW_URL}?bust=${Math.random()}`);
  const [fetchListener] = listeners.fetch;
  assert.ok(fetchListener, 'sw.js never registered a fetch listener');
  return fetchListener;
}

/** Drive the captured `fetch` listener the way the browser would. */
function dispatch(listener, request) {
  let captured;
  listener({ request, respondWith: (p) => { captured = p; } });
  return captured;
}

const RACE_TIMEOUT_MS = 2000;

/** Reject naming what was wanted, rather than let a hang time out the suite. */
function raceAgainstHang(promise, message) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), RACE_TIMEOUT_MS);
    }),
  ]);
}

for (const [label, request] of [
  ['a navigation', () => fakeRequest({
    url: 'https://example.test/index.html', mode: 'navigate', destination: '',
  })],
  ['a stylesheet', () => fakeRequest({
    url: 'https://example.test/style.css', mode: '', destination: 'style',
  })],
]) {
  test(`shellFirst (${label}): resolves to the cached shell instead of awaiting a hung fetch`, async () => {
    installFakeFetch();
    const { seed } = installFakeCaches();
    const timeout = stubAbortTimeout();
    try {
      const req = request();
      const cached = new Response('cached shell', { status: 200 });
      seed('preseed', req.url, cached);

      const listener = await loadFetchListener();
      const responded = dispatch(listener, req);

      const response = await raceAgainstHang(
        responded,
        'the navigation never resolved: shellFirst awaited an unbounded ' +
        'fetch with a cached shell one line below',
      );
      assert.equal(await response.text(), 'cached shell',
        'shellFirst did not fall back to the cached copy');

      assert.deepEqual(timeout.calls, [10000],
        `AbortSignal.timeout was called with ${JSON.stringify(timeout.calls)}, not [10000]`);
    } finally {
      timeout.restore();
    }
  });
}

test('shellFirst (a script): the fast cache-first path never depends on the network', async () => {
  installFakeFetch();
  const { seed } = installFakeCaches();
  const timeout = stubAbortTimeout();
  try {
    const req = fakeRequest({
      url: 'https://example.test/shared/app.js', mode: '', destination: 'script',
    });
    const cached = new Response('cached script', { status: 200 });
    seed('preseed', req.url, cached);

    const listener = await loadFetchListener();
    const responded = dispatch(listener, req);

    // Not `revalidateFirst`, so the cached copy must come back immediately —
    // the background refresh fetch is left hanging (no signal is even given
    // to it while unfixed) and this path must not be the one waiting on it.
    const response = await raceAgainstHang(
      responded,
      'the script request never resolved: the cache-first fast path should ' +
      'never wait on the network at all',
    );
    assert.equal(await response.text(), 'cached script');
  } finally {
    timeout.restore();
  }
});
