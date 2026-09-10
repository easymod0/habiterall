/**
 * `reset()` (`./browser/fixtures.mjs`) is what makes every browser suite
 * deterministic, and a passing suite cannot show you that it worked.
 *
 * The line these tests exist for cleared the account's stored settings and
 * ended `.catch(() => {})`, so a reset that did NOT happen looked exactly
 * like one that did. What that costs is not a failing reset — it is the NEXT
 * suite on that instance running against the previous one's preferences:
 * `countcheck` sets `numberFormat: 'comma'` late in its run, and a suite then
 * waiting for "8.5" against a box holding "8,5" spends a 20-second timeout
 * naming neither the setting nor the suite that left it.
 *
 * A real server is not the witness here — the swallow's whole point is that
 * against a healthy one both versions behave identically — so these drive
 * `reset()` against a stub that answers the way a broken instance does. The
 * stub is deliberately not a mock of the API: it stores what it is sent, so
 * the "answered but cleared nothing" case is a real GET disagreeing with a
 * real DELETE rather than an assertion about a call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { reset } from './browser/fixtures.mjs';

/**
 * A stand-in for one fleet instance: the eight routes `reset()` reaches, over
 * real HTTP on a loopback port, with two faults switchable per test.
 *
 * `settings` starts with a key in it on purpose. A stub that began empty would
 * pass the postcondition check with `DELETE /settings` never wired up at all —
 * the fixture-equal-to-its-expectation shape the root `CLAUDE.md` names first.
 *
 * @param {{deleteStatus?: number, ignoreDelete?: boolean}} [faults]
 */
async function stubInstance(faults = {}) {
  const { deleteStatus = 200, ignoreDelete = false } = faults;

  const state = {
    settings: { numberFormat: 'comma' },
    habits: [],
    entries: [],
    nextId: 1,
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '');
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      const json = body.length ? JSON.parse(Buffer.concat(body).toString()) : {};

      if (path === '/settings' && req.method === 'GET') return send(200, state.settings);
      if (path === '/settings' && req.method === 'DELETE') {
        if (deleteStatus !== 200) return send(deleteStatus, { error: 'settings are stuck' });
        if (!ignoreDelete) state.settings = {};
        return send(200, {});
      }
      if (path === '/categories' && req.method === 'GET') return send(200, []);
      if (path.startsWith('/categories/') && req.method === 'DELETE') return send(200, {});
      if (path === '/habits' && req.method === 'GET') return send(200, state.habits);
      if (path === '/habits' && req.method === 'POST') {
        const habit = { ...json, id: state.nextId++ };
        state.habits.push(habit);
        return send(200, habit);
      }
      if (/^\/habits\/\d+$/.test(path) && req.method === 'DELETE') {
        const id = Number(path.split('/')[2]);
        state.habits = state.habits.filter((h) => h.id !== id);
        return send(204, {});
      }
      if (/^\/habits\/\d+\/entries\/[\d-]+$/.test(path) && req.method === 'PUT') {
        state.entries.push(path);
        return send(200, {});
      }
      return send(404, { error: `stub has no route for ${req.method} ${path}` });
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, close: () => new Promise((r) => server.close(r)) };
}

/**
 * The control, and it is what makes the two failures below attributable: with
 * the stub behaving, `reset()` runs to the end and creates the fixture set.
 * Without this, a `reset()` that threw on the very first request would satisfy
 * both of them.
 */
test('reset() against a healthy instance clears the settings and creates the fixtures', async () => {
  const instance = await stubInstance();
  try {
    const created = await reset({ days: 1, base: instance.base });
    assert.equal(created.length, 4, 'the four fixture habits');
    assert.deepEqual(instance.state.settings, {}, 'and the stored settings are gone');
  } finally {
    await instance.close();
  }
});

test('reset() FAILS, naming the instance, when DELETE /settings is refused', async () => {
  const instance = await stubInstance({ deleteStatus: 500 });
  try {
    await assert.rejects(
      () => reset({ days: 1, base: instance.base }),
      (err) => {
        // The status and the path, so the sentence the runner prints is
        // actionable — and the BASE, because a 16-worker fleet has sixteen
        // instances and `/settings -> 500` says nothing about which answered.
        assert.match(err.message, /\/api\/settings -> 500/, err.message);
        assert.ok(err.message.includes(instance.base),
          `the failure does not name the instance: ${err.message}`);
        return true;
      }
    );
    // And it stopped there rather than seeding on top of the leftovers: a
    // reset that carries on after failing to clear is the swallow again with
    // extra steps.
    assert.deepEqual(instance.state.habits, [], 'nothing was created after the failure');
  } finally {
    await instance.close();
  }
});

test('reset() FAILS when DELETE /settings answers 200 and clears nothing', async () => {
  // The case no status code can catch, and the one the swallow was hiding
  // behind: a route that answers and does not act. A proxy's cached 200, a
  // multi-user instance whose DELETE landed on another account's row, or the
  // route wired to the wrong table all present exactly this way.
  const instance = await stubInstance({ ignoreDelete: true });
  try {
    await assert.rejects(
      () => reset({ days: 1, base: instance.base }),
      (err) => {
        assert.match(err.message, /1 setting\(s\) are still stored \(numberFormat\)/, err.message);
        assert.ok(err.message.includes(instance.base),
          `the failure does not name the instance: ${err.message}`);
        // **The other cause has to be IN the sentence.** The stub here is a
        // route that ignores its DELETE, but this failure is also what a stray
        // browser produces: one still pointed at this base keeps writing to it
        // (`theme.js`'s `reconcile` pushes a stored theme into an account that
        // has none, which is what this DELETE has just made the account), so
        // the reader is sent to a route that is fine.
        //
        // What the sentence names CHANGED with #317 and this assertion changed
        // with it. The reachable case used to be a browser the runner itself
        // orphaned — its `SUITE_TIMEOUT_MS` kill is a process-GROUP kill while
        // `launchChrome` spawns Chrome `detached: true`, measured at 13 live
        // processes after one forced timeout — and the runner reaps that one
        // now. What is left is a browser it never started: a suite run by hand
        // and killed, or another checkout's fleet on the same base. Pinning the
        // wording is the point; a message that still blamed the runner's own
        // kill would send the reader somewhere nothing can be wrong any more.
        assert.match(err.message, /a suite it did not start/, err.message);
        assert.match(err.message, /remote-debugging-port/, err.message);
        return true;
      }
    );
  } finally {
    await instance.close();
  }
});
