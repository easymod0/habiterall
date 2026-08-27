import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { installShutdown, DRAIN_DEADLINE_MS } from '../src/shutdown.js';

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

async function harness({ deadlineMs = 5000 } = {}) {
  const order = [];
  /** @type {{level: string, event: string, fields: any}[]} */
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
  const record = (level) => (event, fields) => {
    logs.push({ level, event, fields });
    order.push(event);
  };

  installShutdown(server, {
    log: { info: record('info'), warn: record('warn'), error: record('error') },
    beforeClose: () => order.push('beforeClose'),
    cleanup: async () => {
      await null;
      order.push('cleanup');
    },
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

test('DRAIN_DEADLINE_MS is 8000', () => {
  // The literal, on purpose. Docker's default `stop_grace_period` is 10s, so
  // this number's whole job is to be under it — asserting it against its own
  // import would pin the name and nothing about that relationship.
  assert.equal(DRAIN_DEADLINE_MS, 8000);
});
