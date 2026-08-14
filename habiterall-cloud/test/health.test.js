import test from 'node:test';
import assert from 'node:assert/strict';

import { LOCAL_IPS, createHealthProbe } from '../src/health.js';

/** A clock the test moves by hand, so a one-second TTL costs no seconds. */
const clock = (start = 1_000) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

test('a burst of probes costs one connection, not one each', async () => {
  let calls = 0;
  const probe = createHealthProbe(async () => { calls++; }, clock());

  // Cold memo, all arriving before any of them has resolved: the case the
  // whole thing exists for, since that is what a flood looks like.
  const answers = await Promise.all(Array.from({ length: 50 }, () => probe()));

  assert.equal(calls, 1);
  assert.deepEqual(answers, Array(50).fill(true));
});

test('the memo expires, so a database that goes away is noticed', async () => {
  let up = true;
  let calls = 0;
  const time = clock();
  const probe = createHealthProbe(
    async () => { calls++; if (!up) throw new Error('no route to host'); },
    { ttlMs: 1000, now: time.now },
  );

  assert.equal(await probe(), true);
  up = false;

  // Inside the window the memo answers, and nothing reaches the pool.
  time.advance(999);
  assert.equal(await probe(), true);
  assert.equal(calls, 1);

  // Past it, the truth. An `inflight` left set by the failure would pin the
  // answer at the last good one forever — a container reporting itself healthy
  // while Postgres is down, which is the failure this test is really about.
  time.advance(1);
  assert.equal(await probe(), false);
  assert.equal(calls, 2);

  // And back again, rather than latching.
  up = true;
  time.advance(1000);
  assert.equal(await probe(), true);
});

test('a query that throws synchronously is an unhealthy answer, not a crash', async () => {
  const probe = createHealthProbe(() => { throw new Error('pool ended'); }, clock());
  assert.equal(await probe(), false);
});

test('cached() is null only until the first answer', async () => {
  const time = clock();
  const probe = createHealthProbe(async () => {}, { ttlMs: 1000, now: time.now });

  // The over-limit handler reads this. Null means "no request has landed yet",
  // which is why it falls through to a real probe rather than guessing.
  assert.equal(probe.cached(), null);
  await probe();
  assert.equal(probe.cached(), true);

  // Stale is still an answer: cached() reports the last one, expiry is the
  // probe's business.
  time.advance(60_000);
  assert.equal(probe.cached(), true);
});

test('the health limiter skips the interfaces an orchestrator probes from', () => {
  for (const ip of [
    '127.0.0.1', '::1', '::ffff:127.0.0.1',
    '10.0.0.5', '172.17.0.1', '172.31.255.254', '192.168.1.1',
    // Mapped form, for whoever moves the bind from 0.0.0.0 to :: — the reason
    // the prefix is shared across all four branches rather than loopback only.
    '::ffff:10.0.0.5', '::ffff:172.17.0.1', '::ffff:192.168.1.1',
    'fd00::1', 'fc00::1', 'fe80::1',
  ]) {
    assert.equal(LOCAL_IPS.test(ip), true, `${ip} should be skipped`);
  }

  for (const ip of [
    '8.8.8.8', '203.0.113.9',
    '100.64.0.1',      // CGNAT, not a private range
    '172.32.0.1',      // just past the /12
    '172.15.0.1',      // just before it
    '11.0.0.1', '1.10.0.1', '192.169.1.1',
    '2001:db8::1', 'face::1',
    '',
  ]) {
    assert.equal(LOCAL_IPS.test(ip), false, `${ip} should not be skipped`);
  }
});
