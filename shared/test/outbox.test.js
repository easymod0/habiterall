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
 * four calls `offline.js` makes and nothing else, deliberately: reach for a
 * fifth and this crashes rather than quietly passing, which is the same bargain
 * the fake DOM in `test/browser/atmost.mjs` makes.
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

/** Queue one write and replay it against a server answering `status`. */
async function replay(status) {
  await clearAll();
  await enqueue({
    url: '/api/habits/1/entries/2026-01-05',
    method: 'PUT',
    body: JSON.stringify({ value: 2 }),
  });
  globalThis.fetch = async () => ({ ok: status >= 200 && status < 300, status });
  const result = await flush();
  return { ...result, left: await pendingCount() };
}

test('a write the server accepted is reported as sent, and leaves the queue', async () => {
  const r = await replay(200);
  assert.equal(r.sent, 1);
  assert.equal(r.failed.length, 0);
  assert.equal(r.left, 0);
});

test('a 404 is dropped, and reported as a FAILURE rather than a sync', async () => {
  // The habit was deleted on another device, so the write can never apply and
  // dropping it is right. What was wrong is the report: it was pushed onto
  // `sent`, so `syncNow` toasted "Synced 1 change" about an answer that had
  // just been thrown away — the message says the opposite of what happened,
  // which is the failure mode `respondInteraction`'s defer was fixed for.
  // `Api.kt`'s `isPermanent` has always counted 404 as a failure.
  const r = await replay(404);
  assert.equal(r.sent, 0, 'a discarded write is not a synced one');
  assert.deepEqual(r.failed.map((f) => f.status), [404]);
  assert.equal(r.left, 0, 'but it is still dropped — it can never apply');
});

test('a 400 is dropped and reported', async () => {
  const r = await replay(400);
  assert.equal(r.sent, 0);
  assert.deepEqual(r.failed.map((f) => f.status), [400]);
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
    assert.equal(r.left, 1, `${status} keeps the write queued`);
  }
});

test('a 5xx keeps its place in the queue', async () => {
  const r = await replay(503);
  assert.equal(r.left, 1);
  assert.equal(r.sent, 0);
  assert.equal(r.failed.length, 0);
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
