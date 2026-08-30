import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { installShutdown, armShutdown, DRAIN_DEADLINE_MS } from '../src/shutdown.js';

// A real server on an ephemeral port and a real keep-alive agent, never a fake
// or a spy: what is under test is Node's own connection bookkeeping — which
// socket counts as idle, and when — and a fake has none of it.

const HELD_BODY = 'the answer the held request was owed';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll rather than sleep, and answer whether it happened inside the budget. */
async function waitFor(predicate, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(5);
  }
  return predicate();
}

// `cleanupFails` is `false`, `'async'` or `'sync'`, because the two editions
// fail in two different SHAPES and one line of `shutdown.js` is what covers
// both. Cloud passes `cleanup: () => closePool()` — a promise that rejects when
// a client errors during `pool.end()`. Personal passes `cleanup: () =>
// db.close()`, with no `async` and no `await`, so `ERR_INVALID_STATE` on an
// already-closed handle is a SYNCHRONOUS throw out of the call. `.then(() =>
// cleanup())` catches that one; `Promise.resolve(cleanup())` would let it
// escape into `server.close()`'s callback as an uncaught exception, which is
// the crash-shaped exit this module exists to avoid.
async function harness({ deadlineMs = 5000, cleanupFails = false } = {}) {
  const order = [];
  /** @type {{level: string, event: string, fields: any, err: any}[]} */
  const logs = [];
  /** @type {number[]} */
  const exits = [];
  const sockets = new Set();
  const servedSockets = [];
  const handlers = new Map();

  const server = http.createServer((req, res) => {
    servedSockets.push(req.socket);
    // Never answered: this is the peer that will not let go.
    if (req.url === '/hang') return;
    // In flight when the signal lands, idle a moment after it.
    if (req.url === '/hold') {
      setTimeout(() => res.end(HELD_BODY), 300);
      return;
    }
    res.end('warm');
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  // The log lands in `order` alongside the callbacks, not in a list of its own:
  // `shutdown.drained` claims the drain FINISHED, so where it sits relative to
  // `cleanup` and `exit` is the only interesting thing about it.
  const record = (level) => (event, fields, err) => {
    logs.push({ level, event, fields, err });
    order.push(event);
  };

  // Neither failing shape pushes anything: it never gets that far.
  const cleanup = cleanupFails === 'sync'
    // Personal's: thrown on the first line, before any await, so the call
    // itself throws rather than returning a promise at all.
    ? () => { throw new Error('db.close blew up'); }
    // Cloud's: a rejection AFTER an await, so the call returns a promise and
    // the failure arrives on a later turn.
    : async () => {
      await null;
      // Any truthy value that is not `'sync'`, so a caller writing `true`
      // gets a failing cleanup rather than a silently passing one. An option
      // whose typo means "do not fail" is how a test stops being able to fail.
      if (cleanupFails) throw new Error('closePool blew up');
      order.push('cleanup');
    };

  installShutdown(server, {
    log: { info: record('info'), warn: record('warn'), error: record('error') },
    beforeClose: () => order.push('beforeClose'),
    cleanup,
    deadlineMs,
    exit: (code) => {
      order.push(`exit:${code}`);
      exits.push(code);
    },
    onSignal: (signal, handler) => handlers.set(signal, handler),
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (server.address());
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  const get = (path) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });

  return {
    order,
    logs,
    exits,
    servedSockets,
    get,
    fire: (signal) => handlers.get(signal)(),
    untilServed: (n) => waitFor(() => servedSockets.length >= n, 2000),
    waitFor,
    async stop() {
      agent.destroy();
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r(undefined)));
    },
  };
}

test('a connection that goes idle AFTER the signal is closed, and the held request still gets its real answer', async () => {
  const h = await harness();
  try {
    // Warm the pool, so the request that follows is on a socket the agent is
    // holding open rather than a fresh one.
    assert.equal((await h.get('/warm')).body, 'warm');

    let heldDone = false;
    const held = h.get('/hold').then((v) => { heldDone = true; return v; });
    assert.ok(await h.untilServed(2), 'the held request never reached the handler');
    // The control that makes the rest of this test mean anything: the signal
    // below lands while the request genuinely has no answer yet.
    assert.equal(heldDone, false, 'the held request was answered before the signal');

    const firedAt = Date.now();
    h.fire('SIGTERM');

    const answer = await held;
    // A drain that kills in-flight work is not a fix.
    assert.equal(answer.status, 200);
    assert.equal(answer.body, HELD_BODY);
    assert.equal(
      h.servedSockets[0],
      h.servedSockets[1],
      'the agent did not reuse the pooled socket, so this is not the case under test',
    );

    // 1000ms measured from the signal, and deliberately nowhere near
    // `keepAliveTimeout` (5000ms): with nothing sweeping the connection once it
    // goes idle the process leaves in ~6200ms, so any budget near 5s is a test
    // that cannot fail.
    const exited = await h.waitFor(
      () => h.exits.length > 0,
      Math.max(0, firedAt + 1000 - Date.now()),
    );
    assert.ok(
      exited,
      `nothing exited within 1000ms of the signal; the idle connection was never swept (exits: ${JSON.stringify(h.exits)})`,
    );
    assert.deepEqual(h.exits, [0]);
  } finally {
    await h.stop();
  }
});

test('the deadline forces exit(1) when the peer will not let go', async () => {
  const h = await harness({ deadlineMs: 150 });
  try {
    h.get('/hang').catch(() => {});
    assert.ok(await h.untilServed(1), 'the hung request never reached the handler');
    h.fire('SIGTERM');

    const exited = await h.waitFor(() => h.exits.length > 0, 1500);
    assert.ok(exited, 'the deadline never fired: a request that never answers held the process open');
    assert.deepEqual(h.exits, [1]);
  } finally {
    await h.stop();
  }
});

test('cleanup runs before exit(0) on the clean path, and not at all on the deadline path', async () => {
  const clean = await harness();
  try {
    clean.fire('SIGTERM');
    assert.ok(await clean.waitFor(() => clean.exits.length > 0, 1000), 'the clean path never exited');
    // `shutdown.drained` claims the drain FINISHED, so it has to come after the
    // cleanup it is claiming for — and once, from the one path that reaches it.
    // A real-server suite has nothing else to read "cleanup ran" off.
    assert.equal(
      clean.order.filter((e) => e === 'shutdown.drained').length,
      1,
      `shutdown.drained was not logged exactly once (order: ${JSON.stringify(clean.order)})`,
    );
    assert.ok(
      clean.order.indexOf('shutdown.drained') > clean.order.indexOf('cleanup'),
      `shutdown.drained claimed a completed drain before cleanup ran (order: ${JSON.stringify(clean.order)})`,
    );
    assert.deepEqual(clean.order, ['shutdown', 'beforeClose', 'cleanup', 'shutdown.drained', 'exit:0']);
    const drained = clean.logs.find((l) => l.event === 'shutdown.drained');
    assert.ok(drained, 'shutdown.drained was not logged at all');
    assert.equal(drained.level, 'info');
    assert.equal(drained.fields.signal, 'SIGTERM');
    // Measured from the signal, not from whenever the closure happened to be
    // built: a duration that is not a number is a line an operator cannot read.
    assert.ok(
      Number.isFinite(drained.fields.ms) && drained.fields.ms >= 0,
      `shutdown.drained reported no usable duration: ${JSON.stringify(drained.fields)}`,
    );
  } finally {
    await clean.stop();
  }

  const stuck = await harness({ deadlineMs: 150 });
  try {
    stuck.get('/hang').catch(() => {});
    assert.ok(await stuck.untilServed(1), 'the hung request never reached the handler');
    stuck.fire('SIGTERM');
    assert.ok(await stuck.waitFor(() => stuck.exits.length > 0, 1500), 'the deadline never fired');
    // Something is already stuck. A cleanup here can hang too, and would lose
    // the exit the deadline just bought — so this path also has no drain to
    // claim, and must not log one.
    assert.equal(
      stuck.order.filter((e) => e === 'shutdown.drained').length,
      0,
      `the deadline path claimed a completed drain it never ran (order: ${JSON.stringify(stuck.order)})`,
    );
    assert.deepEqual(stuck.order, ['shutdown', 'beforeClose', 'shutdown.deadline', 'exit:1']);
    await sleep(100);
    assert.deepEqual(
      stuck.order,
      ['shutdown', 'beforeClose', 'shutdown.deadline', 'exit:1'],
      'cleanup arrived late on the deadline path',
    );
  } finally {
    await stuck.stop();
  }
});

test('a cleanup that REJECTS is named and exits 1, and claims no completed drain', async () => {
  const h = await harness({ cleanupFails: 'async' });
  try {
    h.fire('SIGTERM');
    assert.ok(
      await h.waitFor(() => h.exits.length > 0, 1000),
      'nothing exited: the rejected cleanup was left to become an unhandled rejection',
    );

    // The drain itself succeeded — every accepted response was finished — and
    // only the teardown failed, so this is its own event rather than the
    // deadline's. Left uncaught it would have been an unhandled rejection,
    // which Node reports as a crash: status 1, a raw stack, and no line here at
    // all saying which of the two happened.
    assert.deepEqual(h.order, ['shutdown', 'beforeClose', 'shutdown.cleanup_failed', 'exit:1']);
    assert.equal(
      h.order.filter((e) => e === 'shutdown.drained').length,
      0,
      `a failed teardown claimed a completed drain (order: ${JSON.stringify(h.order)})`,
    );

    const failed = h.logs.find((l) => l.event === 'shutdown.cleanup_failed');
    assert.ok(failed, 'the failure was not logged at all');
    assert.equal(failed.level, 'error');
    assert.equal(failed.fields.signal, 'SIGTERM');
    assert.ok(
      Number.isFinite(failed.fields.ms),
      `no usable duration on the failure line: ${JSON.stringify(failed.fields)}`,
    );
    // Third argument, this repo's logger shape. Without it the operator gets an
    // event name and nothing about what threw.
    assert.equal(failed.err?.message, 'closePool blew up');

    // Nothing arrives late: no second exit, and no drained line behind it.
    await sleep(100);
    assert.deepEqual(
      h.order,
      ['shutdown', 'beforeClose', 'shutdown.cleanup_failed', 'exit:1'],
      'something arrived after the failed cleanup had already chosen the exit',
    );
  } finally {
    await h.stop();
  }
});

test('a cleanup that throws SYNCHRONOUSLY is named and exits 1 too, which is personal\'s shape', async () => {
  // The test above cannot see this one. `cleanup: () => db.close()` has no
  // `async` and no `await`, so `ERR_INVALID_STATE` on an already-closed handle
  // never becomes a rejected promise — it throws out of the call. Under
  // `Promise.resolve(cleanup())` the throw escapes into `server.close()`'s
  // callback as an uncaught exception: exit 1 with a raw stack and no
  // `shutdown.cleanup_failed` at all, on the edition that line names.
  const h = await harness({ cleanupFails: 'sync' });
  try {
    h.fire('SIGTERM');
    assert.ok(
      await h.waitFor(() => h.exits.length > 0, 1000),
      'nothing exited: the synchronous throw escaped the chain instead of being caught',
    );

    assert.deepEqual(h.order, ['shutdown', 'beforeClose', 'shutdown.cleanup_failed', 'exit:1']);
    assert.equal(
      h.order.filter((e) => e === 'shutdown.drained').length,
      0,
      `a failed teardown claimed a completed drain (order: ${JSON.stringify(h.order)})`,
    );

    const failed = h.logs.find((l) => l.event === 'shutdown.cleanup_failed');
    assert.ok(failed, 'the failure was not logged at all');
    assert.equal(failed.level, 'error');
    assert.equal(failed.fields.signal, 'SIGTERM');
    assert.ok(
      Number.isFinite(failed.fields.ms),
      `no usable duration on the failure line: ${JSON.stringify(failed.fields)}`,
    );
    assert.equal(failed.err?.message, 'db.close blew up');

    await sleep(100);
    assert.deepEqual(
      h.order,
      ['shutdown', 'beforeClose', 'shutdown.cleanup_failed', 'exit:1'],
      'something arrived after the failed cleanup had already chosen the exit',
    );
  } finally {
    await h.stop();
  }
});

test('a second signal exits immediately and does not re-enter the sequence', async () => {
  const h = await harness();
  try {
    h.get('/hang').catch(() => {});
    assert.ok(await h.untilServed(1), 'the hung request never reached the handler');

    h.fire('SIGTERM');
    assert.deepEqual(h.exits, [], 'the first signal must leave the drain in progress');

    h.fire('SIGTERM');
    // Synchronously: an operator pressing Ctrl-C twice is asking for now, and
    // the same guard is what stops `cleanup` running a second time.
    assert.deepEqual(h.exits, [1], 'a second signal did not exit immediately');
    assert.equal(
      h.order.filter((e) => e === 'beforeClose').length,
      1,
      'the shutdown sequence was re-entered by the second signal',
    );
  } finally {
    await h.stop();
  }
});

// The boot window: the process has started, something has been opened, and
// nothing is listening yet. `armShutdown` needs no server at all — that is the
// whole condition it covers — so its harness is the logger, the exits and the
// handlers it was asked to register, and nothing else.
function armHarness({ deadlineMs = 5000, cleanupFails = false } = {}) {
  /** @type {string[]} */
  const order = [];
  /** @type {{level: string, event: string, fields: any, err: any}[]} */
  const logs = [];
  /** @type {number[]} */
  const exits = [];
  const handlers = new Map();

  const record = (level) => (event, fields, err) => {
    logs.push({ level, event, fields, err });
    order.push(event);
  };

  // The same two shapes as the drain harness, and for the same reason: personal
  // passes `cleanup: () => db.close()`, which THROWS out of the call, while
  // cloud passes `cleanup: () => closePool()`, which rejects a turn later. One
  // line of the early path covers both, so both are asked here too.
  const cleanup = cleanupFails === 'sync'
    ? () => { throw new Error('db.close blew up'); }
    : async () => {
      await null;
      if (cleanupFails) throw new Error('closePool blew up');
      order.push('cleanup');
    };

  // No `signals`, on purpose: the default is what both entry points get, and
  // firing SIGTERM below only reaches a handler if the default really is both.
  const arm = armShutdown({
    log: { info: record('info'), warn: record('warn'), error: record('error') },
    cleanup,
    deadlineMs,
    exit: (code) => {
      order.push(`exit:${code}`);
      exits.push(code);
    },
    onSignal: (signal, handler) => handlers.set(signal, handler),
  });

  return {
    arm,
    order,
    logs,
    exits,
    registered: () => [...handlers.keys()],
    fire: (signal) => handlers.get(signal)(),
  };
}

/**
 * A real listening server handed `installShutdown` with an arm, and a count of
 * the process handlers it registered on its own account.
 */
async function installedWithArm(arm) {
  /** @type {string[]} */
  const order = [];
  /** @type {string[]} */
  const registered = [];
  /** @type {number[]} */
  const exits = [];
  const server = http.createServer((_req, res) => res.end('warm'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  installShutdown(server, {
    log: {
      info: (event) => order.push(event),
      warn: (event) => order.push(event),
      error: (event) => order.push(event),
    },
    beforeClose: () => order.push('beforeClose'),
    cleanup: () => order.push('cleanup'),
    arm,
    exit: (code) => {
      order.push(`exit:${code}`);
      exits.push(code);
    },
    onSignal: (signal) => registered.push(signal),
  });
  return {
    server,
    order,
    registered,
    exits,
    stop: () => new Promise((r) => (server.listening ? server.close(() => r(undefined)) : r(undefined))),
  };
}

test('a signal in the boot window runs cleanup and exits 0, having said so afterwards', async () => {
  const h = armHarness();
  h.fire('SIGTERM');
  assert.ok(
    await waitFor(() => h.exits.length > 0, 1000),
    'nothing exited: a signal arriving before the server exists was swallowed, which is the bug',
  );

  // `shutdown.early` claims the teardown FINISHED, so — exactly as
  // `shutdown.drained` above — it has to come after the cleanup it claims for.
  // A suite spawning the real server reads "cleanup ran" off this line and has
  // nothing else to read it off.
  assert.ok(
    h.order.indexOf('shutdown.early') > h.order.indexOf('cleanup'),
    `shutdown.early claimed a finished teardown before cleanup ran (order: ${JSON.stringify(h.order)})`,
  );
  assert.deepEqual(h.order, ['shutdown.armed', 'cleanup', 'shutdown.early', 'exit:0']);
  // 0 and not 1: nothing had been accepted, so nothing was dropped. 1 is
  // reserved for the deadline and the failed teardown, and an operator reading
  // a status beside an event has only this to tell the three apart.
  assert.deepEqual(h.exits, [0]);

  // The armed line is what STEP 2's suites wait on to know they may signal
  // inside the boot window, so it is logged once, at info, before any signal,
  // naming both signals it took.
  const armed = h.logs.find((l) => l.event === 'shutdown.armed');
  assert.ok(armed, 'nothing said the process could be stopped cleanly from that instant');
  assert.equal(armed.level, 'info');
  assert.deepEqual(armed.fields.signals, ['SIGINT', 'SIGTERM']);
  assert.deepEqual(h.registered(), ['SIGINT', 'SIGTERM']);

  const early = h.logs.find((l) => l.event === 'shutdown.early');
  assert.equal(early.level, 'info');
  assert.equal(early.fields.signal, 'SIGTERM');
  assert.ok(
    Number.isFinite(early.fields.ms) && early.fields.ms >= 0,
    `shutdown.early reported no usable duration: ${JSON.stringify(early.fields)}`,
  );
  // An early exit and a drained one are both `exit(0)` with a line above them;
  // the reason is the only thing on the line that says which happened.
  assert.ok(
    typeof early.fields.reason === 'string' && early.fields.reason.length > 0,
    `shutdown.early gave no reason, so it reads as a completed drain: ${JSON.stringify(early.fields)}`,
  );
});

test('an early cleanup that REJECTS, and one that throws SYNCHRONOUSLY, are both named and exit 1', async () => {
  for (const [shape, message] of [['async', 'closePool blew up'], ['sync', 'db.close blew up']]) {
    const h = armHarness({ cleanupFails: shape });
    h.fire('SIGTERM');
    assert.ok(
      await waitFor(() => h.exits.length > 0, 1000),
      `nothing exited on the ${shape} failure: it escaped the chain instead of being caught`,
    );

    assert.deepEqual(h.order, ['shutdown.armed', 'shutdown.cleanup_failed', 'exit:1']);
    assert.deepEqual(h.exits, [1]);
    // The teardown failed, so there is nothing to claim: an operator seeing
    // `shutdown.early` beside a status of 1 has been told two opposite things.
    assert.equal(
      h.order.filter((e) => e === 'shutdown.early').length,
      0,
      `a failed teardown claimed a clean early exit (order: ${JSON.stringify(h.order)})`,
    );

    const failed = h.logs.find((l) => l.event === 'shutdown.cleanup_failed');
    assert.ok(failed, `the ${shape} failure was not logged at all`);
    assert.equal(failed.level, 'error');
    assert.equal(failed.fields.signal, 'SIGTERM');
    assert.ok(
      Number.isFinite(failed.fields.ms),
      `no usable duration on the failure line: ${JSON.stringify(failed.fields)}`,
    );
    assert.equal(failed.err?.message, message);

    await sleep(50);
    assert.deepEqual(
      h.order,
      ['shutdown.armed', 'shutdown.cleanup_failed', 'exit:1'],
      `something arrived after the ${shape} failure had already chosen the exit`,
    );
  }
});

test('once the drain handler is adopted the signal reaches IT, and the early path does not run', async () => {
  const h = armHarness();
  /** @type {string[]} */
  const reached = [];
  assert.equal(h.arm.adopt((signal) => reached.push(signal)), true, 'a quiet boot window refused adoption');

  h.fire('SIGTERM');
  // Synchronously, and with the signal NAME: the drain handler logs it, keys
  // its guard on it, and puts it on every line it writes.
  assert.deepEqual(reached, ['SIGTERM'], 'the adopted handler was not called with the signal');

  await sleep(50);
  // The arm must be inert from adoption onward. Running both would tear the
  // storage down under a drain that is still answering requests with it.
  assert.deepEqual(h.order, ['shutdown.armed'], `the early path ran under an adopted handler (order: ${JSON.stringify(h.order)})`);
  assert.deepEqual(h.exits, [], 'the arm exited out from under the drain it had handed the signal to');
});

test('`adopt` refuses once a signal has arrived, and installShutdown then only stops accepting', async () => {
  const h = armHarness();
  h.fire('SIGTERM');
  // The early exit already owns the exit. A drain adopted now would be a second
  // sequence over the storage the first one is already closing.
  assert.equal(h.arm.adopt(() => {}), false, 'adoption was accepted after the early exit had already begun');

  const i = await installedWithArm(h.arm);
  try {
    // `server.close()`, not a `return` on its own: the listener came up during
    // the exit and would otherwise go on accepting connections it will never
    // answer for however long the early cleanup takes.
    assert.equal(i.server.listening, false, 'the brand-new listener kept accepting while the process was already leaving');
    // The line first, then `beforeClose`, the same order the drain path logs
    // in: an operator whose stop landed here would otherwise see a listener
    // torn down at birth with nothing saying why.
    assert.deepEqual(i.order, ['shutdown.adoption_refused', 'beforeClose']);
    // No drain: nothing has been accepted, and `cleanup` belongs to the arm,
    // which is already running it.
    assert.deepEqual(i.exits, []);
    assert.deepEqual(i.registered, []);
  } finally {
    await i.stop();
    await waitFor(() => h.exits.length > 0, 1000);
  }
});

test('installShutdown given an arm registers NO process handler of its own', async () => {
  const h = armHarness();
  const i = await installedWithArm(h.arm);
  try {
    // The one that stops a doubled signal. The arm's listener is already on
    // every signal and now dispatches into the drain; a second registration
    // here would run the drain and the early exit off one press — `cleanup`
    // twice, and two exits racing to name the status.
    assert.deepEqual(
      i.registered,
      [],
      `installShutdown registered its own handler beside the arm's (${JSON.stringify(i.registered)})`,
    );
    assert.equal(i.server.listening, true, 'a quiet boot window still closed the server');

    // And the adoption is live: the arm's listener now reaches the drain.
    i.server.close();
    h.fire('SIGTERM');
    assert.ok(await waitFor(() => i.exits.length > 0, 1000), 'the adopted drain never ran');
    assert.deepEqual(i.order, ['shutdown', 'beforeClose', 'cleanup', 'shutdown.drained', 'exit:0']);
    // Every line came from the drain; the arm logged nothing past its own.
    assert.deepEqual(h.order, ['shutdown.armed']);
  } finally {
    await i.stop();
  }
});

test('a second signal before adoption exits immediately and does not re-run the cleanup', async () => {
  const h = armHarness();
  h.fire('SIGTERM');
  assert.deepEqual(h.exits, [], 'the first signal exited before its cleanup could have run');

  h.fire('SIGTERM');
  // Synchronously, the same way the drain's guard answers: an operator pressing
  // Ctrl-C twice is asking for now.
  assert.deepEqual(h.exits, [1], 'a second signal did not exit immediately');
  assert.deepEqual(h.order, ['shutdown.armed', 'shutdown.forced', 'exit:1']);
  const forced = h.logs.find((l) => l.event === 'shutdown.forced');
  assert.equal(forced.level, 'warn');
  assert.equal(forced.fields.signal, 'SIGTERM');

  // The guard's other half: the first cleanup finishes once, not twice, and the
  // second signal did not start a second one behind it.
  assert.ok(await waitFor(() => h.exits.length > 1, 1000), 'the first signal never finished its cleanup');
  assert.equal(
    h.order.filter((e) => e === 'cleanup').length,
    1,
    `the second signal re-ran the cleanup (order: ${JSON.stringify(h.order)})`,
  );
});

test('DRAIN_DEADLINE_MS is 8000', () => {
  // The literal, on purpose. Docker's default `stop_grace_period` is 10s, so
  // this number's whole job is to be under it — asserting it against its own
  // import would pin the name and nothing about that relationship.
  assert.equal(DRAIN_DEADLINE_MS, 8000);
});
