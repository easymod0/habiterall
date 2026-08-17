import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * `flush()` — what the outbox does with each answer the server can give.
 *
 * The queue had no status-code test of any kind: `browser/pwatest.mjs` drives
 * the happy path and asserts no status, so every rule in the replay loop —
 * which of a 401, 403, 404, 429 and 500 keeps its place in line, which is
 * dropped, and which is REPORTED as having landed — was carried by its comment
 * alone. The Kotlin half has had `OutboxRetryTest` pinning nine codes for as
 * long as it has existed, which is how the two came to disagree about 404.
 *
 * A minimal in-memory IndexedDB stands in for the browser's. It implements the
 * four store methods `offline.js` calls and nothing else, deliberately: reach
 * for a fifth and this crashes rather than quietly passing, which is the same
 * bargain the fake DOM in `test/browser/atmost.mjs` makes.
 *
 * Be exact about where that bargain STOPS, because the fake is faithful to the
 * branch table and blind to the database itself. It ignores the transaction's
 * mode, ignores the store's name, and answers `objectStoreNames.contains` with
 * `true`, so `createObjectStore` never runs. Measured: dropping
 * `{keyPath: 'seq', autoIncrement: true}` from the schema, and turning the
 * delete's `readwrite` into `readonly`, both leave this file 6/6 green — and
 * both fail `test/browser/pwatest.mjs`, which drives a real IndexedDB. The
 * schema and the transaction semantics stay pwatest's job; what is pinned here
 * is which answer does what.
 */

/** Enough of IndexedDB for `openDb`/`tx` in offline.js, and no more. */
function fakeIndexedDB() {
  /** @type {Map<number, any>} */
  const rows = new Map();
  let nextSeq = 1;

  const store = {
    add(value) {
      const seq = nextSeq++;
      rows.set(seq, { ...value, seq });
      return { result: seq };
    },
    delete(seq) { rows.delete(seq); return { result: undefined }; },
    getAll() { return { result: [...rows.values()] }; },
    clear() { rows.clear(); return { result: undefined }; },
  };

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction() {
      const t = {
        objectStore: () => store,
        oncomplete: null,
        onerror: null,
        onabort: null,
      };
      // Complete on a later turn, as a real transaction does, so `tx`'s promise
      // cannot resolve before its callback has run.
      queueMicrotask(() => t.oncomplete?.());
      return t;
    },
  };

  globalThis.indexedDB = {
    open() {
      const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  };
  return rows;
}

const rows = fakeIndexedDB();
const { enqueue, flush, pendingCount, clearAll } =
  await import('../public/offline.js');

/**
 * Queue TWO writes and replay them against a server answering `status`.
 *
 * Two, not one, because half of what this file pins is an ORDERING rule — "a
 * later write must never overtake an earlier one" — and with a single item
 * `break` and `continue` are indistinguishable. Measured: with one item queued,
 * turning the 5xx `break` into a `continue` left every test in the repository
 * green, and a 503 on write A followed by a good write B for the same day would
 * then land B and replay A over the top of it.
 *
 * `calls` is therefore part of the answer: a rule that keeps its place must also
 * stop the replay there.
 */
async function replay(status) {
  await clearAll();
  for (const date of ['2026-01-05', '2026-01-06']) {
    await enqueue({
      url: `/api/habits/1/entries/${date}`,
      method: 'PUT',
      body: JSON.stringify({ value: 2 }),
    });
  }
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: status >= 200 && status < 300, status };
  };
  const result = await flush();
  return { ...result, left: await pendingCount(), calls: calls.length, urls: calls };
}

test('a write the server accepted is reported as sent, and leaves the queue', async () => {
  const r = await replay(200);
  assert.equal(r.sent, 2);
  assert.equal(r.failed.length, 0);
  assert.equal(r.left, 0);
  assert.equal(r.calls, 2, 'a good answer carries on to the next write');
  // Oldest first. `calls === 1` on the stopping cases below proves only that the
  // loop HALTED after one item, not that it took the earlier one — measured,
  // reversing the sort in `flush()` left this file green and was caught solely
  // by pwatest's "last wins".
  assert.deepEqual(r.urls, [
    '/api/habits/1/entries/2026-01-05',
    '/api/habits/1/entries/2026-01-06',
  ], 'replayed oldest first');
});

test('a 404 is dropped, and reported as a FAILURE rather than a sync', async () => {
  // The habit was deleted on another device, so the write can never apply and
  // dropping it is right. What was wrong is the report: it was pushed onto
  // `sent`, so `syncNow` toasted "Synced 1 change" about an answer that had
  // just been thrown away — the message says the opposite of what happened,
  // which is the failure mode `respondInteraction`'s defer was fixed for.
  // `Api.kt`'s `isPermanent` has always counted 404 as a failure, and
  // `OutboxRetryTest` pins fourteen status codes to the web's none.
  const r = await replay(404);
  assert.equal(r.sent, 0, 'a discarded write is not a synced one');
  assert.deepEqual(r.failed.map((f) => f.status), [404, 404]);
  assert.equal(r.left, 0, 'but it is still dropped — it can never apply');
});

test('a 400 is dropped and reported', async () => {
  const r = await replay(400);
  assert.equal(r.sent, 0);
  assert.deepEqual(r.failed.map((f) => f.status), [400, 400]);
  assert.equal(r.left, 0);
});

test('401 and 403 keep their place in the queue', async () => {
  // Neither is a verdict on the write. 401 is an expired session; 403 is the
  // origin guard reporting a proxy that rewrites Host, which is a
  // misconfiguration that gets fixed — and the writes must replay when it is.
  for (const status of [401, 403]) {
    const r = await replay(status);
    assert.equal(r.sent, 0, `${status} did not sync`);
    assert.equal(r.failed.length, 0, `${status} is not a failure of the write`);
    assert.equal(r.left, 2, `${status} keeps the writes queued`);
    assert.equal(r.calls, 1, `${status} stops the replay rather than walking on`);
    assert.deepEqual(r.urls, ['/api/habits/1/entries/2026-01-05'],
      `${status} stopped on the EARLIEST write, not a later one`);
  }
});

test('a 5xx keeps its place in the queue', async () => {
  const r = await replay(503);
  assert.equal(r.left, 2);
  assert.equal(r.sent, 0);
  assert.equal(r.failed.length, 0);
  assert.equal(r.calls, 1, 'or a later write overtakes the one that failed');
});

test('a replayed write says which clock the device is on', async () => {
  // The bug this pins destroyed the write it was replaying, and only ever east
  // of the server. Every route that asks "is this today?" now judges by the
  // CALLER's day, read from this header — so a replay that omits it is judged
  // by the container's clock, which is UTC in both compose files. Auckland at
  // 11:00 on the 17th is the 16th in UTC: `assertNotFuture` answers 400, and a
  // 400 is dropped as permanently inapplicable two tests above. The check-off
  // is gone, and the only surface that says so is "1 change could not be
  // synced".
  //
  // `Api.kt` sets this on every request from an OkHttp interceptor, so the
  // identical offline tap has always survived on the phone. That asymmetry is
  // what made this look like a browser flake rather than a rule with a hole.
  await clearAll();
  await enqueue({ url: '/api/habits/1/entries/2026-08-17', method: 'PUT', body: '{}' });

  /** @type {any[]} */
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    seen.push(init.headers);
    return { ok: true, status: 200 };
  };
  await flush();

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(seen[0]['X-Habiterall-Timezone'], zone,
    'a replayed write carries the device zone, or the server dates it by its own clock');
  assert.equal(seen[0]['Content-Type'], 'application/json',
    'and still says what it is sending');
});

test('a queued record that states its own headers keeps them', async () => {
  // The zone is added underneath what the record carries, never over it. No
  // caller stores headers today — which is exactly why this is worth pinning,
  // since `item.headers` is otherwise a branch nothing exercises and the
  // spread order is invisible until the first caller that needs it.
  await clearAll();
  await enqueue({
    url: '/api/habits/1/entries/2026-08-17',
    method: 'PUT',
    body: '{}',
    headers: { 'Content-Type': 'text/plain', 'X-Habiterall-Timezone': 'Pacific/Auckland' },
  });

  /** @type {any[]} */
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    seen.push(init.headers);
    return { ok: true, status: 200 };
  };
  await flush();

  assert.equal(seen[0]['X-Habiterall-Timezone'], 'Pacific/Auckland');
  assert.equal(seen[0]['Content-Type'], 'text/plain');
});

test('a network failure stops the replay, preserving order', async () => {
  await clearAll();
  await enqueue({ url: '/api/a', method: 'PUT', body: '{}' });
  await enqueue({ url: '/api/b', method: 'PUT', body: '{}' });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('offline');
  };
  const r = await flush();
  assert.equal(calls, 1, 'it stops at the first failure rather than walking on');
  assert.equal(r.remaining, 2, 'and a later write never overtakes an earlier one');
  assert.equal(rows.size, 2);
});
