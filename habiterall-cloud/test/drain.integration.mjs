/**
 * SIGTERM must finish what this server already accepted, and then close the
 * POOL on its way out.
 *
 * `shared/test/shutdown.test.js` proves the module and
 * `habiterall-personal/test/drain.integration.mjs` proves one edition's wiring.
 * Neither proves this one, and the difference is not cosmetic: personal's
 * cleanup is a synchronous `db.close()` while this edition's is
 * `async () => closePool()`. Exit code **0** is reachable only through
 * `await cleanup()` resolving inside `server.close()`'s callback — the deadline
 * path exits 1 and runs no cleanup at all, a rejected `closePool()` is a named
 * `shutdown.cleanup_failed` and an `exit(1)`, and a SIGKILL shows as a signal
 * rather than a code. So the exit code is the assertion that carries the async
 * path, and it is the primary evidence here.
 *
 * Deliberately shorter than personal's suite. The pooling peer and the 8s
 * deadline are properties of `shared/src/shutdown.js`, already pinned against a
 * real process there; what is edition-specific is the cleanup, and one
 * in-flight request is enough to reach it.
 *
 * A raw socket rather than `fetch`, because the case under test is a request
 * HALF SENT when the signal lands on a POOLED connection, which no HTTP client
 * will do for you. Cloud has no auth-off mode, so the in-flight request is an
 * unauthenticated one and its answer is a `401` — which is a real answer for
 * this purpose. It must be `POST /api/habits` and it must carry
 * `Content-Type: application/json`: `/api/import` is mounted with `requireAuth`
 * ABOVE `express.json()`, so it would be refused the instant the headers
 * arrived and nothing would ever be in flight, while without the content type
 * `express.json()` does not engage and there is no hold either. As it stands
 * the body parser buffers, waiting for the `Content-Length` promised here —
 * that is the hold — and `requireAuth` below it answers once the body lands.
 *
 * The second check is the OTHER hole and it is earlier than any drain: a signal
 * that arrives while the process is still booting, before anything is
 * listening. This edition owns the LONG version of it — `await start()` is
 * `await initAuth()`, which is OIDC discovery, bounded only by openid-client's
 * 30-second default, three times the shipped `stop_grace_period: 10s` — so it is
 * checked here, against a real spawned process, with an IdP that never answers.
 *
 *   DATABASE_URL=... ADMIN_URL=... node test/drain.integration.mjs
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';

process.env.ADMIN_URL ??= 'postgres://owner:testpw@localhost:5432/habiterall';
process.env.DATABASE_URL ??= 'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';

// The default is what CI runs; the override is what keeps a local run inside
// its own lane when several checkouts are being tested at once.
const PORT = Number(process.env.DRAIN_TEST_PORT) || 3503;
const HOST = '127.0.0.1';

// What this suite's own child process calls itself to Postgres, so
// `pg_stat_activity` can be asked about THIS server's backends and not about
// whatever else is connected to a shared test database.
const APP_NAME = `habiterall-drain-${process.pid}`;
const childDatabaseUrl = () => {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('application_name', APP_NAME);
  return String(url);
};

const admin = new pg.Client({ connectionString: process.env.ADMIN_URL });

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a predicate until it holds or `until` passes. Answers whether it held. */
async function waitFor(predicate, until) {
  while (Date.now() < until) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

/** Minimal OIDC discovery, so `initAuth` can complete without a real IdP. */
async function fakeIssuer() {
  let base;
  const srv = createServer((req, res) => {
    if (req.url.startsWith('/.well-known/openid-configuration')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/auth`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  base = `http://127.0.0.1:${srv.address().port}`;
  return { srv, base };
}

/**
 * An IdP that accepts the connection, takes the request, and never answers.
 *
 * The exact unreachable-IdP shape the PR body describes, with no network in it.
 * `client.discovery` passes no `timeout` option, so openid-client 6.8.5's own
 * default applies (`performDiscovery`: `options?.timeout ?? 30`) and
 * `await initAuth()` waits on this for ~30 seconds before aborting. That wait IS
 * this edition's boot window: bounded, but at three times the shipped
 * `stop_grace_period`, and two orders of magnitude past anything asserted below.
 */
async function stallingIssuer() {
  const srv = createServer(() => { /* deliberately never answered */ });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}

/**
 * Start the real server and return at once, waiting for nothing.
 *
 * Split out of `boot` for the boot-window check, whose whole subject is the
 * stretch BEFORE anything is listening — a helper that waits for the port could
 * not reach it.
 *
 * `log.js` writes every line to ONE stream — stdout — so that is where
 * `shutdown.armed`, `shutdown.early` and `shutdown.drained` appear; stderr is
 * captured into the same buffer anyway, so a child that dies before the logger
 * exists is still readable in the failure detail rather than being swallowed.
 */
function spawnServer(env) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: childDatabaseUrl(),
      SESSION_SECRET: 'drain-integration-secret',
      PUBLIC_URL: `http://localhost:${PORT}`,
      OIDC_CLIENT_ID: 'test-client',
      OIDC_CLIENT_SECRET: 'test-secret',
      ALLOW_INSECURE_OIDC: 'true',
      HABITERALL_NOTIFY: 'off',
      LOG_LEVEL: 'info',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = { child, logs: '', exit: null, exitAt: 0, closed: false };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { state.logs += d; });
  child.stderr.on('data', (d) => { state.logs += d; });
  // `exit` is what the timing is taken from; `close` is when the pipes have
  // been drained, and the log assertion waits for that instead — a line written
  // a moment before `process.exit` can still be in flight at `exit`.
  child.on('exit', (code, signal) => {
    state.exitAt = Date.now();
    state.exit = { code, signal };
  });
  child.on('close', () => { state.closed = true; });
  return state;
}

/** Boot the real server against a working issuer and wait for it to answer. */
async function boot(issuer) {
  const state = spawnServer({ OIDC_ISSUER: issuer });

  for (let i = 0; i < 100; i++) {
    if (state.exit) throw new Error(`server exited during boot :: ${state.logs}`);
    if (await probe()) return state;
    await sleep(250);
  }
  throw new Error(`server did not start :: ${state.logs}`);
}

/** Reap a child by PID and wait for it, so the next check finds the port free. */
async function reap(state) {
  if (!state) return;
  if (!state.exit) state.child.kill('SIGKILL');
  await waitFor(() => state.exit !== null, Date.now() + 5000);
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

const healthzRequest =
  `GET /healthz HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nConnection: keep-alive\r\n\r\n`;
const habitBody = JSON.stringify({ name: 'a request that outlives the signal' });
const habitHead =
  `POST /api/habits HTTP/1.1\r\n` +
  `Host: ${HOST}:${PORT}\r\n` +
  // Without this `express.json()` never engages, and with nothing buffering the
  // body there is no hold at all.
  `Content-Type: application/json\r\n` +
  `Content-Length: ${Buffer.byteLength(habitBody)}\r\n` +
  `Connection: keep-alive\r\n\r\n`;

/** How many backends this suite's child process currently holds. */
async function appBackends() {
  const { rows } = await admin.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name = $1 AND usename = 'habiterall_app'`,
    [APP_NAME],
  );
  return rows[0].n;
}

const timings = [];
const { srv, base: issuer } = await fakeIssuer();
const stalling = await stallingIssuer();
let state = null;

try {
  /* ---------- 1. a request in flight when the signal lands ---------- */

  try {
    await admin.connect();
    state = await boot(issuer);

    // Warm the socket, so what follows travels on a POOLED connection as a
    // reverse proxy's would. An unwarmed connection is not the case under test.
    const s = openSocket();
    await new Promise((r) => s.sock.once('connect', r).once('error', r));
    s.sock.write(healthzRequest);
    const warmed = await waitFor(() => s.seen.includes('"ok":true'), Date.now() + 5000);
    check('1. the socket is warm, so what follows is a pooled connection',
      warmed, JSON.stringify(s.seen.slice(0, 120)));
    s.seen = '';

    // Headers and the first ten bytes of the body. `express.json()` now holds
    // the request, waiting for the rest, and nothing below it has run.
    s.sock.write(habitHead + habitBody.slice(0, 10));
    await sleep(200);
    // The control. Without it the signal lands on an idle socket and every
    // assertion below is true of a server with no drain in it.
    check('1. nothing has come back before the signal', s.seen === '',
      JSON.stringify(s.seen.slice(0, 120)));

    // The other control, for the witness at the bottom: the warm `/healthz`
    // above ran `SELECT 1` through the pool, so this child owns a backend to
    // begin with and "no backend afterwards" is a change rather than a fact
    // about a database nothing ever connected to.
    const before = await appBackends();
    check('1. control: the child holds a Postgres backend before the signal',
      before >= 1, `${APP_NAME} -> ${before}`);

    const signalAt = Date.now();
    state.child.kill('SIGTERM');
    await sleep(150);
    s.sock.write(habitBody.slice(10));

    await waitFor(() => state.exit !== null, signalAt + 1500);
    const ms = state.exit ? state.exitAt - signalAt : -1;
    timings.push(`1. in flight: exit ${ms} ms, code ${state.exit?.code}`);

    check('1. the held request is answered 401 after the signal',
      /^HTTP\/1\.1 401 /.test(s.seen),
      JSON.stringify(s.seen.split('\r\n')[0] ?? s.seen.slice(0, 120)));
    // Exactly 0, and this is the assertion carrying the async cleanup: the only
    // route to it is `await closePool()` resolving inside `server.close()`'s
    // callback. The deadline exits 1, a rejection would exit non-zero, and a
    // SIGKILL would report a signal instead of a code.
    check('1. and the process exits 0 within 1500 ms of the signal',
      state.exit?.code === 0 && ms >= 0 && ms <= 1500,
      `code=${state.exit?.code} signal=${state.exit?.signal} ms=${ms}`);
    await waitFor(() => state.closed, Date.now() + 1000);
    check('1. having said the drain completed', state.logs.includes('shutdown.drained'),
      JSON.stringify(state.logs.slice(-200)));

    // The second, weaker witness. Weaker on purpose and worth being precise
    // about: an exiting process closes its sockets whether or not it called
    // `closePool`, so this cannot tell a graceful pool teardown from the kernel
    // doing it. What it does see is the case this whole suite is about — a
    // process that never leaves keeps its pool, and its backends stay in
    // `pg_stat_activity` for the whole poll below.
    const gone = await waitFor(async () => (await appBackends()) === 0, Date.now() + 3000);
    check('1. and Postgres holds no backend for this server afterwards',
      gone, `${APP_NAME} -> ${await appBackends()}`);
    s.sock.destroy();
  } catch (err) {
    check('1. a request in flight when the signal lands', false, String(err?.stack ?? err));
  } finally {
    await reap(state);
  }

  /* ---------- 2. a signal that lands in the boot window ---------- */

  // Earlier than the case above and a different hole: `await start()` is
  // `await initAuth()`, so with the IdP stalled nothing is listening and there
  // is nothing to drain. Node is PID 1 in the image and a signal with DEFAULT
  // disposition is *discarded* for PID 1 — so until `armShutdown` ran, this
  // window is one in which `docker stop` did nothing whatever and the operator
  // waited the full grace for a SIGKILL. ~30 seconds wide here — openid-client's
  // own discovery default, which `client.discovery` does not override — and so
  // three times the grace it has to survive.
  state = null;
  try {
    state = spawnServer({ OIDC_ISSUER: stalling.base });
    // A predicate, not a sleep, and it names what it wanted: without this line
    // the signal below lands wherever the machine happened to be. Bounded, and
    // that bound is what makes this honest against an entry point with no arm
    // in it: such a process never logs the line, and waiting on it without a
    // bound would hang the suite rather than signalling. The window here is
    // ~30 SECONDS — the issuer never answers, and that is openid-client's
    // discovery timeout — so anything past node's own boot is inside it, and one
    // second is a thirtyfold margin on that.
    const armed = await waitFor(
      () => state.logs.includes('shutdown.armed'), Date.now() + 1000);
    check('2. the process says it is armed before it is listening', armed,
      JSON.stringify(state.logs.slice(-200)));

    const signalAt = Date.now();
    state.child.kill('SIGTERM');

    await waitFor(() => state.exit !== null, signalAt + 1500);
    const ms = state.exit ? state.exitAt - signalAt : -1;
    timings.push(`2. boot window: exit ${ms} ms, code ${state.exit?.code}, signal ${state.exit?.signal}`);

    // `signal === null` carries as much as the code does. Outside Docker an
    // unhandled SIGTERM TERMINATES the process, so "it exited quickly" is
    // exactly what the unfixed code also does — as `code=null signal=SIGTERM`.
    // A signalled death and a chosen exit must not read alike. And the 0 is
    // this edition's own half again: the early cleanup here is the ASYNC one,
    // so exit 0 is the assertion that carries `await closePool()` on the early
    // path, exactly as it carries it on the drain path above.
    check('2. the process CHOSE to exit 0 rather than being killed by the signal',
      state.exit?.code === 0 && state.exit?.signal === null,
      `code=${state.exit?.code} signal=${state.exit?.signal} ms=${ms}`);
    // The half that says the signal was not merely deferred into a hang. A
    // literal, nowhere near DRAIN_DEADLINE_MS, which is not imported here.
    check('2. and it left within 1500 ms of the signal', ms >= 0 && ms <= 1500, `ms=${ms}`);
    await waitFor(() => state.closed, Date.now() + 1000);
    check('2. having said it went out down the early path',
      state.logs.includes('shutdown.early'), JSON.stringify(state.logs.slice(-200)));
    // Self-validating, and the reason a window that quietly closed fails here
    // rather than passing for the wrong reason: `logStartup` had not run and no
    // drain had either, so the signal landed inside the window and not after it.
    check('2. and it landed INSIDE the window — nothing had started, nothing drained',
      !state.logs.includes('"startup"') && !state.logs.includes('shutdown.drained'),
      JSON.stringify(state.logs.slice(-200)));
  } catch (err) {
    check('2. a signal that lands in the boot window', false, String(err?.stack ?? err));
  } finally {
    await reap(state);
  }

  for (const t of timings) console.log(`      ${t}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nall drain checks passed');
} finally {
  await reap(state);
  await admin.end().catch(() => {});
  srv.close();
  // The held request keeps this server's socket open, so `close()` alone would
  // never complete and the suite would not exit.
  stalling.srv.closeAllConnections();
  stalling.srv.close();
}

process.exit(failures ? 1 : 0);
