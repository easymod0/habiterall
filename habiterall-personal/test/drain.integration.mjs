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
 *
 * Check 4 is the other hole and it is EARLIER than a drain: the signal that
 * arrives while the process is still booting, before anything is listening. It
 * is the same spawn-and-signal shape, aimed at the window rather than at the
 * server.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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
 * Start the real server and return at once, waiting for nothing.
 *
 * Split out of `boot` for check 4, whose whole subject is the stretch of boot
 * BEFORE anything is listening — a helper that waits for the port could not
 * reach it.
 *
 * `log.js` writes every line to ONE stream — stdout — so that is where
 * `shutdown.armed`, `shutdown.early`, `shutdown.drained` and `shutdown.deadline`
 * appear; stderr is captured into the same buffer anyway, so a child that dies
 * before the logger exists is still readable in the failure detail rather than
 * being swallowed by `stdio: 'ignore'`.
 */
function spawnServer(env) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HABITERALL_RATE_LIMIT: 'off',
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
  // been drained, and the log assertions wait for that instead — a line
  // written a moment before `process.exit` can still be in flight at `exit`.
  child.on('exit', (code, signal) => {
    state.exitAt = Date.now();
    state.exit = { code, signal };
  });
  child.on('close', () => { state.closed = true; });
  return state;
}

/** Boot the real server, auth off, and wait for it to answer. */
async function boot(dbName) {
  const state = spawnServer({
    HABITERALL_DB: join(workdir, dbName),
    HABITERALL_AUTH: 'off',
    // Cleared explicitly: these are the documented way to configure this app,
    // so an ambient value in the developer's shell would reconfigure the very
    // thing under test — see `credential-change.integration.mjs`.
    HABITERALL_USERNAME: '',
    HABITERALL_PASSWORD: '',
    HABITERALL_PASSWORD_HASH: '',
  });

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

/**
 * The `p` in the seeded hash below, and the whole of check 4's boot window.
 *
 * `verifyPassword` (shared/src/password.js) reads N, r and p OUT OF the stored
 * hash and bounds them only by `Number.isInteger(v) && v > 0`. `p` multiplies
 * the work linearly and costs no extra memory, so a stored hash with a high one
 * is a deterministic, seconds-long boot window reached entirely through
 * production code — no patched module and no sleep. Measured here, N=16384 r=8:
 * p=1 28 ms, p=64 2178 ms, p=128 4761 ms, p=256 7923 ms. 128 is well clear of a
 * second and well under the 8 s deadline; do not raise it past node's 32 MB
 * `maxmem`, which `verifyPassword` catches and answers `false` to IMMEDIATELY —
 * silently closing the very window this buys.
 */
const SLOW_P = 128;

/**
 * How long check 4 waits for `shutdown.armed` before signalling anyway.
 *
 * The predicate is the point — it is what lets the signal land INSIDE the boot
 * window rather than after a sleep and a hope. The budget on it is the other
 * half, and it is what makes this check honest against an entry point with no
 * arm in it: such a process never logs the line, so a generous budget would
 * wait until it had finished booting and then signal a perfectly ordinary
 * running server, which drains and exits 0 and looks fine. Bounded here, the
 * unarmed build is signalled while it is still booting, where an unhandled
 * SIGTERM TERMINATES it — `code=null signal=SIGTERM`, which is the shape the
 * assertions below are written against.
 *
 * So two literals, and the control run asserts the ordering between them:
 * armed well inside this, and `startup` well outside it. A machine fast enough
 * to close the window before this elapses fails the control by name rather than
 * passing this check for the wrong reason — raise `SLOW_P` if that ever happens.
 */
const ARMED_BUDGET_MS = 1000;

/**
 * Seed throwaway databases whose stored credential is expensive to VERIFY.
 *
 * The key does not have to verify against anything: `initAuth` ->
 * `adoptEnvCredential` runs the FULL derivation before it compares, and that
 * derivation is the cost being bought.
 *
 * Written through the real `src/db.js` rather than a hand-rolled `CREATE TABLE`,
 * so the row sits in the schema the server actually has. Two copies, because
 * the control run below COMPLETES `adoptEnvCredential`, which overwrites the row
 * with an ordinary p=1 hash — one shared file would leave the second run with no
 * window at all.
 */
async function seedSlowCredential(...names) {
  const [first, ...rest] = names.map((n) => join(workdir, n));
  const previous = process.env.HABITERALL_DB;
  process.env.HABITERALL_DB = first;
  // `db.js` reads HABITERALL_DB once, at module load, so this has to be a
  // dynamic import taken with the variable set.
  const { db } = await import('../src/db.js');
  if (previous === undefined) delete process.env.HABITERALL_DB;
  else process.env.HABITERALL_DB = previous;

  const hash = ['scrypt', 16384, 8, SLOW_P,
    randomBytes(16).toString('base64'),
    randomBytes(64).toString('base64')].join('$');
  db.prepare(
    `INSERT INTO auth_credentials (id, username, hash) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username = excluded.username, hash = excluded.hash`
  ).run('admin', hash);
  // Closed before anything is copied: SQLite checkpoints and removes the WAL on
  // the last connection's close, so the file on disk is the whole database only
  // from this line.
  db.close();
  for (const path of rest) copyFileSync(first, path);
}

/** The environment that puts a slow `verifyPassword` on the boot path. */
const slowBootEnv = (dbName) => ({
  HABITERALL_DB: join(workdir, dbName),
  // Auth ON, deliberately not cleared the way `boot()` clears it: only an
  // environment credential reaches `adoptEnvCredential`, and that call is the
  // window. The empty string is not `off`, and `off` is the one value that
  // disables auth.
  HABITERALL_AUTH: '',
  HABITERALL_USERNAME: 'admin',
  HABITERALL_PASSWORD: 'this need not match the stored hash',
  HABITERALL_PASSWORD_HASH: '',
});

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
    // The measured answer is 0, on every run of this so far, and the bound is
    // deliberately one looser than that. The gap is a real race and not slack:
    // the poll writes a GET every 200 ms, and one written into the socket in
    // the same tick that the last answer is flushed is already on the wire
    // before the `close` sweep can shut the door behind it. Asserting `=== 0`
    // would pin timing rather than behaviour, and its failure would read as a
    // shutdown regression when it is a scheduler.
    //
    // That permitted one is not only a scheduler artefact, and it is the whole
    // of what the sweep COSTS: a peer that already wrote its next request onto
    // the pooled socket has it dropped rather than answered, where master
    // answered it — the 70 this case measures on master are requests this
    // branch does not serve. A proxy will not retry it either, bytes having
    // been on the wire, and `examples/Caddyfile` configures no retry. The trade
    // is right and it is not free; `docs/decisions/connectivity.md` argues it,
    // and it is why #208's readiness half is the other half rather than a
    // nice-to-have.
    //
    // The bound still bites where it has to: master serves 70 here, and the
    // no-sweep mutation served 9. `timings` carries the run's actual figure,
    // so a drift from 0 to 1 is visible in the output rather than hidden by
    // the tolerance that permits it.
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

  /* ---------- 4. a signal that lands in the boot window ---------- */

  // Earlier than every case above, and a different hole: nothing is listening
  // yet, so there is nothing to drain. Node is PID 1 in the image and a signal
  // with DEFAULT disposition is *discarded* for PID 1, so until `armShutdown`
  // ran this was a stretch in which `docker stop` did nothing whatever and the
  // operator waited the full grace for a SIGKILL.
  state = null;
  let control = null;
  try {
    await seedSlowCredential('bootwindow-control.db', 'bootwindow.db');

    // The control, and it is what makes the block below a measurement rather
    // than a race: the same environment, no signal at all, takes SECONDS to get
    // from `shutdown.armed` to `startup`. Without it "no startup line" would
    // also be true of a run that was simply signalled after it had finished.
    control = spawnServer(slowBootEnv('bootwindow-control.db'));
    const controlAt = Date.now();
    const controlArmed = await waitFor(
      () => control.logs.includes('shutdown.armed'), controlAt + 15000);
    const armedMs = Date.now() - controlAt;
    const started = await waitFor(
      () => control.logs.includes('"startup"'), controlAt + 30000);
    const startupMs = Date.now() - controlAt;
    timings.push(`4. control, no signal: armed at ${armedMs} ms, startup at ${startupMs} ms`);
    // Both literals, in the order ARMED_BUDGET_MS depends on: armed well inside
    // it, `startup` well outside it, so the signal below lands in the window on
    // an armed build and on an unarmed one alike.
    check('4. control: an unsignalled boot is armed at once and still booting a budget later',
      controlArmed && started && armedMs <= ARMED_BUDGET_MS && startupMs >= 2500,
      `armed=${armedMs}ms startup=${startupMs}ms budget=${ARMED_BUDGET_MS}ms`);
    await reap(control);
    control = null;

    state = spawnServer(slowBootEnv('bootwindow.db'));
    // A predicate, not a sleep, and it names what it wanted: without this line
    // the signal below lands wherever the machine happened to be. Bounded — see
    // ARMED_BUDGET_MS for why a generous bound would let an unarmed build boot
    // fully and then look fine.
    const armed = await waitFor(
      () => state.logs.includes('shutdown.armed'), Date.now() + ARMED_BUDGET_MS);
    check('4. the process says it is armed before it is listening', armed,
      JSON.stringify(state.logs.slice(-200)));

    const signalAt = Date.now();
    state.child.kill('SIGTERM');

    await waitFor(() => state.exit !== null, signalAt + 1500);
    const ms = state.exit ? state.exitAt - signalAt : -1;
    timings.push(`4. boot window: exit ${ms} ms, code ${state.exit?.code}, signal ${state.exit?.signal}`);

    // `signal === null` carries as much as the code does. Outside Docker an
    // unhandled SIGTERM TERMINATES the process, so "it exited quickly" is
    // exactly what the unfixed code also does — as `code=null signal=SIGTERM`.
    // A signalled death and a chosen exit must not read alike.
    check('4. the process CHOSE to exit 0 rather than being killed by the signal',
      state.exit?.code === 0 && state.exit?.signal === null,
      `code=${state.exit?.code} signal=${state.exit?.signal} ms=${ms}`);
    // The half that says the signal was not merely deferred into a hang. A
    // literal, nowhere near DRAIN_DEADLINE_MS, which is not imported here.
    check('4. and it left within 1500 ms of the signal', ms >= 0 && ms <= 1500, `ms=${ms}`);
    await waitFor(() => state.closed, Date.now() + 1000);
    check('4. having said it went out down the early path',
      state.logs.includes('shutdown.early'), JSON.stringify(state.logs.slice(-200)));
    // Self-validating, and the reason a window that quietly closed fails here
    // rather than passing for the wrong reason: `logStartup` had not run and no
    // drain had either, so the signal landed inside the window and not after it.
    check('4. and it landed INSIDE the window — nothing had started, nothing drained',
      !state.logs.includes('"startup"') && !state.logs.includes('shutdown.drained'),
      JSON.stringify(state.logs.slice(-200)));
  } catch (err) {
    check('4. a signal that lands in the boot window', false, String(err?.stack ?? err));
  } finally {
    await reap(control);
    await reap(state);
  }

  for (const t of timings) console.log(`      ${t}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nall drain checks passed');
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
