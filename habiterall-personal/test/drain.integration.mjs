/**
 * SIGTERM must finish what this server already accepted, and then leave on its
 * own terms.
 *
 * `shared/test/shutdown.test.js` proves the module. It cannot prove the WIRING:
 * `installShutdown` is called from `src/server.js`'s entry-point block, with
 * this edition's `beforeClose` and its synchronous `db.close()` cleanup, and
 * none of that runs in a unit test. So this suite spawns the real
 * `src/server.js`, signals it, and reads the answer off a raw socket.
 *
 * A raw socket rather than `fetch`, because every case here turns on a request
 * being HALF SENT when the signal lands, which no HTTP client will do for you —
 * and on the socket being a POOLED one, which is what a reverse proxy holds and
 * what nothing sweeps. Each check warms its socket with a complete `GET
 * /healthz` first for exactly that reason: an unwarmed connection is not the
 * case under test.
 *
 * The budgets are literals and deliberately nowhere near either real number.
 * Measured on the real server: 156 ms fixed against 6158 ms unfixed for the
 * in-flight case, and Node's `keepAliveTimeout` is 5000 ms — so a budget at or
 * above ~5 s would pass against a server with no drain in it at all.
 * `DRAIN_DEADLINE_MS` is not imported here either; check 3 asserts the seconds a
 * process actually took.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The default is what CI runs; the override is what keeps a local run inside
// its own lane when several checkouts are being tested at once.
const PORT = Number(process.env.DRAIN_TEST_PORT) || 3502;
const HOST = '127.0.0.1';
const workdir = mkdtempSync(join(tmpdir(), 'habiterall-drain-'));
const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a predicate until it holds or `until` passes. Answers whether it held. */
async function waitFor(predicate, until) {
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

/**
 * Boot the real server and wait for it to answer.
 *
 * `log.js` writes every line to ONE stream — stdout — so that is where
 * `shutdown.drained` and `shutdown.deadline` appear; stderr is captured into the
 * same buffer anyway, so a child that dies before the logger exists is still
 * readable in the failure detail rather than being swallowed by `stdio: 'ignore'`.
 */
async function boot(dbName) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HABITERALL_DB: join(workdir, dbName),
      HABITERALL_AUTH: 'off',
      HABITERALL_RATE_LIMIT: 'off',
      HABITERALL_NOTIFY: 'off',
      LOG_LEVEL: 'info',
      // Cleared explicitly: these are the documented way to configure this app,
      // so an ambient value in the developer's shell would reconfigure the very
      // thing under test — see `credential-change.integration.mjs`.
      HABITERALL_USERNAME: '',
      HABITERALL_PASSWORD: '',
      HABITERALL_PASSWORD_HASH: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = { child, logs: '', exit: null, exitAt: 0, closed: false };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { state.logs += d; });
  child.stderr.on('data', (d) => { state.logs += d; });
  // `exit` is what the timing is taken from; `close` is when the pipes have
  // been drained, and the log assertions wait for that instead — a line
  // written a moment before `process.exit` can still be in flight at `exit`.
  child.on('exit', (code, signal) => {
    state.exitAt = Date.now();
    state.exit = { code, signal };
  });
  child.on('close', () => { state.closed = true; });

  for (let i = 0; i < 80; i++) {
    if (state.exit) throw new Error(`server exited during boot :: ${state.logs}`);
    if (await probe()) return state;
    await sleep(250);
  }
  throw new Error(`server did not start :: ${state.logs}`);
}

/** One throwaway connection, closed by the server, so nothing is left pooled. */
function probe() {
  return new Promise((resolve) => {
    const sock = connect(PORT, HOST);
    let seen = '';
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.on('error', () => done(false));
    sock.on('close', () => resolve(seen.includes('"ok":true')));
    sock.on('data', (d) => { seen += d; if (seen.includes('"ok":true')) done(true); });
    sock.on('connect', () => sock.write(
      `GET /healthz HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nConnection: close\r\n\r\n`
    ));
  });
}

/** A keep-alive socket that records everything the server sends back. */
function openSocket() {
  const sock = connect(PORT, HOST);
  const s = { sock, seen: '' };
  sock.setEncoding('utf8');
  sock.on('data', (d) => { s.seen += d; });
  sock.on('error', () => {});
  return s;
}

const KEEPALIVE = `Host: ${HOST}:${PORT}\r\nConnection: keep-alive\r\n\r\n`;
const healthzRequest = `GET /healthz HTTP/1.1\r\n${KEEPALIVE}`;
const habitBody = JSON.stringify({ name: 'a request that outlives the signal' });
const habitHead =
  `POST /api/habits HTTP/1.1\r\n` +
  `Host: ${HOST}:${PORT}\r\n` +
  `Content-Type: application/json\r\n` +
  `Content-Length: ${Buffer.byteLength(habitBody)}\r\n` +
  `Connection: keep-alive\r\n\r\n`;

/** Warm a socket so what follows travels on a POOLED connection, as a proxy's does. */
async function warm(s, label) {
  await new Promise((r) => s.sock.once('connect', r).once('error', r));
  s.sock.write(healthzRequest);
  const warmed = await waitFor(() => s.seen.includes('"ok":true'), Date.now() + 5000);
  check(`${label} the socket is warm, so what follows is a pooled connection`,
    warmed, JSON.stringify(s.seen.slice(0, 120)));
  s.seen = '';
  return warmed;
}

/** Reap a child by PID and wait for it, so the next check finds the port free. */
async function reap(state) {
  if (!state) return;
  if (!state.exit) state.child.kill('SIGKILL');
  await waitFor(() => state.exit !== null, Date.now() + 5000);
}

const timings = [];

try {
  /* ---------- 1. a request in flight when the signal lands ---------- */

  // The whole suite in one check. Measured, this is the case that hangs: the
  // request had its `request` event long before the signal, so nothing a signal
  // handler installs can see it, and when it finally goes idle nothing sweeps it.
  let state = null;
  try {
    state = await boot('inflight.db');
    const s = openSocket();
    await warm(s, '1.');

    // Headers and the first ten bytes of the body. The route now has the
    // request and cannot answer it.
    s.sock.write(habitHead + habitBody.slice(0, 10));
    await sleep(200);
    // The control. Without it the signal lands on an idle socket and every
    // assertion below is true of a server with no drain in it.
    check('1. nothing has come back before the signal', s.seen === '',
      JSON.stringify(s.seen.slice(0, 120)));

    const signalAt = Date.now();
    state.child.kill('SIGTERM');
    await sleep(150);
    s.sock.write(habitBody.slice(10));

    await waitFor(() => state.exit !== null, signalAt + 1500);
    const ms = state.exit ? state.exitAt - signalAt : -1;
    timings.push(`1. in flight: exit ${ms} ms, code ${state.exit?.code}`);

    check('1. the held request is answered 201 with a real id',
      /^HTTP\/1\.1 201 /.test(s.seen) && /"id":\s*\d+/.test(s.seen),
      JSON.stringify(s.seen.split('\r\n')[0] ?? s.seen.slice(0, 120)));
    check('1. and the process exits 0 within 1500 ms of the signal',
      state.exit?.code === 0 && ms >= 0 && ms <= 1500,
      `code=${state.exit?.code} signal=${state.exit?.signal} ms=${ms}`);
    await waitFor(() => state.closed, Date.now() + 1000);
    check('1. having said the drain completed', state.logs.includes('shutdown.drained'),
      JSON.stringify(state.logs.slice(-200)));
    s.sock.destroy();
  } catch (err) {
    check('1. a request in flight when the signal lands', false, String(err?.message ?? err));
  } finally {
    await reap(state);
  }

  /* ---------- 2. a peer that keeps using the pooled socket ---------- */

  // Master serves whatever the proxy sends next — 70 further requests in one
  // measured run — and never leaves. The sweep hooked to each response's
  // `close` is what shuts the door behind the last answer.
  state = null;
  let poll = null;
  try {
    state = await boot('pooling.db');
    const s = openSocket();
    await warm(s, '2.');

    s.sock.write(habitHead + habitBody.slice(0, 10));
    await sleep(200);
    check('2. nothing has come back before the signal', s.seen === '',
      JSON.stringify(s.seen.slice(0, 120)));

    const signalAt = Date.now();
    state.child.kill('SIGTERM');
    await sleep(150);
    s.sock.write(habitBody.slice(10));

    const answered = await waitFor(() => /^HTTP\/1\.1 201 /.test(s.seen), Date.now() + 1000);
    check('2. the held request is still answered 201', answered,
      JSON.stringify(s.seen.split('\r\n')[0] ?? s.seen.slice(0, 120)));

    // From here everything the socket receives is a FURTHER answer.
    s.seen = '';
    poll = setInterval(() => { if (!s.sock.destroyed) s.sock.write(healthzRequest); }, 200);

    await waitFor(() => state.exit !== null, signalAt + 2000);
    clearInterval(poll);
    poll = null;
    const ms = state.exit ? state.exitAt - signalAt : -1;
    const served = (s.seen.match(/"ok":true/g) ?? []).length;
    timings.push(`2. pooling peer: exit ${ms} ms, code ${state.exit?.code}, ${served} further request(s) served`);

    check('2. the process exits 0 within 2000 ms despite the peer',
      state.exit?.code === 0 && ms >= 0 && ms <= 2000,
      `code=${state.exit?.code} signal=${state.exit?.signal} ms=${ms}`);
    // At most one, not zero: a GET written in the same tick as the last answer
    // is already on the wire before anything can sweep the connection.
    check('2. and at most one further request is served after the signal',
      served <= 1, `served=${served}`);
    s.sock.destroy();
  } catch (err) {
    check('2. a peer that keeps using the pooled socket', false, String(err?.message ?? err));
  } finally {
    if (poll) clearInterval(poll);
    await reap(state);
  }

  /* ---------- 3. the ceiling, in the real process ---------- */

  // A body that never arrives: the connection is never idle, so `server.close()`
  // can never call back and no sweep can reach it. The only thing left is the
  // deadline — and this is the one assertion that pins the 8 s constant to a
  // process rather than to a module, which is to say the one that proves WE
  // choose the exit and its code rather than Docker's SIGKILL at 10 s.
  state = null;
  try {
    state = await boot('deadline.db');
    const s = openSocket();
    await warm(s, '3.');

    s.sock.write(habitHead + habitBody.slice(0, 10));
    await sleep(200);
    check('3. nothing has come back before the signal', s.seen === '',
      JSON.stringify(s.seen.slice(0, 120)));

    const signalAt = Date.now();
    state.child.kill('SIGTERM');
    // The rest of the body is never written.

    await waitFor(() => state.exit !== null, signalAt + 9500);
    const ms = state.exit ? state.exitAt - signalAt : -1;
    timings.push(`3. never-idle peer: exit ${ms} ms, code ${state.exit?.code}`);

    check('3. the process exits 1 between 7000 and 9500 ms of the signal',
      state.exit?.code === 1 && ms >= 7000 && ms <= 9500,
      `code=${state.exit?.code} signal=${state.exit?.signal} ms=${ms}`);
    await waitFor(() => state.closed, Date.now() + 1000);
    check('3. having said the drain ran out rather than being killed',
      state.logs.includes('shutdown.deadline'), JSON.stringify(state.logs.slice(-200)));
    s.sock.destroy();
  } catch (err) {
    check('3. the ceiling, in the real process', false, String(err?.message ?? err));
  } finally {
    await reap(state);
  }

  for (const t of timings) console.log(`      ${t}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nall drain checks passed');
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
