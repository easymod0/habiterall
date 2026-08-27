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
 * Boot the real server and wait for it to answer.
 *
 * `log.js` writes every line to ONE stream — stdout — so that is where
 * `shutdown.drained` appears; stderr is captured into the same buffer anyway,
 * so a child that dies before the logger exists is still readable in the
 * failure detail rather than being swallowed.
 */
async function boot(issuer) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: childDatabaseUrl(),
      SESSION_SECRET: 'drain-integration-secret',
      PUBLIC_URL: `http://localhost:${PORT}`,
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: 'test-client',
      OIDC_CLIENT_SECRET: 'test-secret',
      ALLOW_INSECURE_OIDC: 'true',
      HABITERALL_NOTIFY: 'off',
      LOG_LEVEL: 'info',
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

  for (let i = 0; i < 100; i++) {
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
let state = null;

try {
  await admin.connect();
  state = await boot(issuer);

  // Warm the socket, so what follows travels on a POOLED connection as a
  // reverse proxy's would. An unwarmed connection is not the case under test.
  const s = openSocket();
  await new Promise((r) => s.sock.once('connect', r).once('error', r));
  s.sock.write(healthzRequest);
  const warmed = await waitFor(() => s.seen.includes('"ok":true'), Date.now() + 5000);
  check('the socket is warm, so what follows is a pooled connection',
    warmed, JSON.stringify(s.seen.slice(0, 120)));
  s.seen = '';

  // Headers and the first ten bytes of the body. `express.json()` now holds the
  // request, waiting for the rest, and nothing below it has run.
  s.sock.write(habitHead + habitBody.slice(0, 10));
  await sleep(200);
  // The control. Without it the signal lands on an idle socket and every
  // assertion below is true of a server with no drain in it.
  check('nothing has come back before the signal', s.seen === '',
    JSON.stringify(s.seen.slice(0, 120)));

  // The other control, for the witness at the bottom: the warm `/healthz`
  // above ran `SELECT 1` through the pool, so this child owns a backend to
  // begin with and "no backend afterwards" is a change rather than a fact
  // about a database nothing ever connected to.
  const before = await appBackends();
  check('control: the child holds a Postgres backend before the signal',
    before >= 1, `${APP_NAME} -> ${before}`);

  const signalAt = Date.now();
  state.child.kill('SIGTERM');
  await sleep(150);
  s.sock.write(habitBody.slice(10));

  await waitFor(() => state.exit !== null, signalAt + 1500);
  const ms = state.exit ? state.exitAt - signalAt : -1;
  timings.push(`in flight: exit ${ms} ms, code ${state.exit?.code}`);

  check('the held request is answered 401 after the signal',
    /^HTTP\/1\.1 401 /.test(s.seen),
    JSON.stringify(s.seen.split('\r\n')[0] ?? s.seen.slice(0, 120)));
  // Exactly 0, and this is the assertion carrying the async cleanup: the only
  // route to it is `await closePool()` resolving inside `server.close()`'s
  // callback. The deadline exits 1, a rejection would exit non-zero, and a
  // SIGKILL would report a signal instead of a code.
  check('and the process exits 0 within 1500 ms of the signal',
    state.exit?.code === 0 && ms >= 0 && ms <= 1500,
    `code=${state.exit?.code} signal=${state.exit?.signal} ms=${ms}`);
  await waitFor(() => state.closed, Date.now() + 1000);
  check('having said the drain completed', state.logs.includes('shutdown.drained'),
    JSON.stringify(state.logs.slice(-200)));

  // The second, weaker witness. Weaker on purpose and worth being precise
  // about: an exiting process closes its sockets whether or not it called
  // `closePool`, so this cannot tell a graceful pool teardown from the kernel
  // doing it. What it does see is the case this whole suite is about — a
  // process that never leaves keeps its pool, and its backends stay in
  // `pg_stat_activity` for the whole poll below.
  const gone = await waitFor(async () => (await appBackends()) === 0, Date.now() + 3000);
  check('and Postgres holds no backend for this server afterwards',
    gone, `${APP_NAME} -> ${await appBackends()}`);
  s.sock.destroy();

  for (const t of timings) console.log(`      ${t}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nall drain checks passed');
} catch (err) {
  check('a request in flight when the signal lands', false, String(err?.stack ?? err));
} finally {
  if (state && !state.exit) state.child.kill('SIGKILL');
  if (state) await waitFor(() => state.exit !== null, Date.now() + 5000);
  await admin.end().catch(() => {});
  srv.close();
}

process.exit(failures ? 1 : 0);
