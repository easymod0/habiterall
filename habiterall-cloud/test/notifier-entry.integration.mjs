/**
 * `notifier-entry.js` end to end, over a real spawned process — but NO
 * Postgres. `pg.Pool` is lazy (nothing connects at construction), so a
 * syntactically valid but unreachable `DATABASE_URL` is enough to boot this
 * entry point and drive every case below: `postgres://u:p@127.0.0.1:1/nodb`,
 * where port 1 refuses the connection instantly rather than timing out.
 *
 * Four properties are the review surface for #194 and each gets its own case:
 *
 *   1. `HABITERALL_NOTIFY=off` with no backup directory has nothing to run,
 *      and the entry point exits 0 rather than sitting there forever under
 *      `restart: on-failure`.
 *   2. `HABITERALL_NOTIFY=on` ticks and STAYS UP, and the process serves
 *      nothing at all — no `port` on its `startup` line, and a TCP connect to
 *      the port an `app` would have used is refused. A signal still drains it
 *      cleanly, through `armShutdown`'s own (only) path here, with the reason
 *      string that makes `shutdown.early` true for a process with no server.
 *   3. reminders off but a backup CONFIGURED still ticks, because the dump has
 *      no timer of its own and rides this one. The shipped half-configured
 *      state — a directory with no `DATABASE_URL_ADMIN` — is the other case,
 *      and it is "nothing to run" by `backupTask`'s own definition.
 *   4. this process is not reachable from `api.js` at all — every cloud test
 *      suite imports `api.js`, and this is "the tests never start a real
 *      tick" asserted rather than commented.
 *
 * `waitFor` polls a predicate and never sleeps a fixed duration — a suite
 * that guessed a timing here would be exactly the sleep-in-a-loop pattern
 * `docs/decisions/testing.md` measures against. Every spawned child is
 * reaped by PID in a `finally`. The two post-action settles are the
 * exception the root `CLAUDE.md` names: waiting to see that something did
 * NOT happen has no predicate to poll.
 *
 * **"and it is still alive" is the load-bearing half of cases 2 and 3, and it
 * is there because the first version of this branch did NOT survive.**
 * `startNotifier` unref'd its own tick interval, on an assumption that was
 * true of every caller until this one: "the HTTP server is what keeps the
 * process alive". This process has no server, and a deployment with no
 * Discord bot token opens no socket either — a webhook, an ntfy topic and a
 * nightly `pg_dump` leave nothing ref'd between ticks. So the process ran ONE
 * tick and exited 0, with no signal and no line: against a real Postgres on
 * the shipped 60s interval it went at 40-45 seconds, fifteen before its
 * second tick was due, and `restart: on-failure` correctly declined to
 * restart an exit 0. `ctx.keepAlive` (passed by `src/notifier.js`) is the
 * fix; `shared/test/notify.test.js` pins the option itself in both
 * directions, and these checks are the WIRING — that this edition's entry
 * point actually gets it.
 *
 *   node test/notifier-entry.integration.mjs
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A free port in the 3400-3419 lane, distinct from `DRAIN_TEST_PORT` (3405) so
// the two suites never collide when run side by side. Never bound by anything
// in this suite or in `notifier-entry.js` — the process is asserted to listen
// on NOTHING, and a raw TCP connect to this port is how that is checked.
const PORT = Number(process.env.NOTIFIER_TEST_PORT) || 3411;
const HOST = '127.0.0.1';

// Port 1 refuses a connection immediately rather than timing out — the point
// is a fast, deterministic failure on the notifier's first tick, not a real
// database.
const UNREACHABLE_DB = 'postgres://u:p@127.0.0.1:1/nodb';

const ROOT = new URL('..', import.meta.url).pathname;

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

/**
 * Spawn `node src/notifier-entry.js`, capturing stdout/stderr into one NDJSON
 * buffer (the logger writes every line to stdout; stderr is captured too so a
 * child that dies before the logger exists is still readable).
 */
function spawnNotifier(env) {
  const child = spawn(process.execPath, ['src/notifier-entry.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: UNREACHABLE_DB,
      SESSION_SECRET: 'notifier-integration-secret',
      PORT: String(PORT),
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
  child.on('exit', (code, signal) => {
    state.exitAt = Date.now();
    state.exit = { code, signal };
  });
  child.on('close', () => { state.closed = true; });
  return state;
}

/** Every well-formed JSON line in a log buffer, in order. */
function parseLines(logs) {
  const out = [];
  for (const line of logs.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a stray non-JSON line, ignored */ }
  }
  return out;
}

/** The first parsed line whose `msg` matches, or `undefined`. */
function findLine(logs, msg) {
  return parseLines(logs).find((l) => l.msg === msg);
}

/** Reap a child by PID and wait for it, so the next case finds the port free. */
async function reap(state) {
  if (!state) return;
  if (!state.exit) state.child.kill('SIGKILL');
  await waitFor(() => state.exit !== null, Date.now() + 5000);
}

/** Resolves true if a TCP connect to `port` is refused, false if it connects. */
function connectRefused(port) {
  return new Promise((resolve) => {
    const sock = connect(port, HOST);
    sock.on('error', (err) => { sock.destroy(); resolve(err.code === 'ECONNREFUSED'); });
    sock.on('connect', () => { sock.destroy(); resolve(false); });
  });
}

let state = null;

try {
  /* ---------- 1. HABITERALL_NOTIFY=off, no backup dir -> exits 0 ---------- */

  try {
    state = spawnNotifier({ HABITERALL_NOTIFY: 'off' });

    const exited = await waitFor(() => state.exit !== null, Date.now() + 5000);
    check('1. the process exits on its own with nothing to run', exited,
      JSON.stringify(state.logs.slice(-300)));

    const disabled = findLine(state.logs, 'notify.disabled');
    check('1. notify.disabled is logged', !!disabled, JSON.stringify(state.logs));
    check('1. notify.disabled names HABITERALL_NOTIFY=off',
      disabled?.reason === 'HABITERALL_NOTIFY=off', JSON.stringify(disabled));

    check('1. the process exits with code 0, not a signal',
      state.exit?.code === 0 && state.exit?.signal === null,
      `code=${state.exit?.code} signal=${state.exit?.signal}`);
  } catch (err) {
    check('1. HABITERALL_NOTIFY=off, no backup dir', false, String(err?.stack ?? err));
  } finally {
    await reap(state);
  }

  /* ---------- 2. HABITERALL_NOTIFY=on -> ticks, serves nothing ---------- */

  state = null;
  try {
    state = spawnNotifier({ HABITERALL_NOTIFY: 'on' });

    const starting = await waitFor(
      () => state.exit !== null || findLine(state.logs, 'notify.starting') !== undefined,
      Date.now() + 5000);
    check('2. notify.starting is logged', starting && state.exit === null,
      JSON.stringify(state.logs.slice(-300)));

    // `startup` is logged a line after `notify.starting` — wait for its own
    // parsed line rather than inferring it from a sibling event, so a slow
    // pipe flush cannot be read as a missing field.
    await waitFor(
      () => state.exit !== null || findLine(state.logs, 'startup') !== undefined,
      Date.now() + 5000);
    const startup = findLine(state.logs, 'startup');
    check('2. the startup line names edition cloud-notifier',
      startup?.edition === 'cloud-notifier', JSON.stringify(startup));
    check('2. the startup line carries no port field',
      startup !== undefined && !Object.hasOwn(startup, 'port'), JSON.stringify(startup));

    const refused = await connectRefused(PORT);
    check('2. a TCP connect to the port an app would use is refused', refused);

    // The first tick fails against the unreachable database — wait for the
    // line that says so, then assert the process is still up. A notifier
    // that dies on one bad tick is itself a reminder outage.
    const tickFailed = await waitFor(
      () => findLine(state.logs, 'notify.collect_failed') !== undefined || state.exit !== null,
      Date.now() + 5000);
    check('2. the first tick fails to reach Postgres, and is logged as such',
      tickFailed && state.exit === null, JSON.stringify(state.logs.slice(-300)));
    check('2. and the process is still alive after that failed tick',
      state.exit === null, JSON.stringify(state.exit));

    // Named separately from the SIGTERM checks below it, and it is the check
    // this suite exists for — see the file header. With the tick's interval
    // unref'd there is nothing left holding this process's event loop open
    // once the failed tick's socket is gone, and it exits 0 on its own with no
    // line saying so. A settle rather than a poll, deliberately: the thing
    // being asserted is that something did NOT happen, which has no predicate.
    // If it has already gone by the time we get here, sending SIGTERM to a
    // dead PID and reporting "no shutdown.early" would misname the failure.
    await sleep(500);
    const stillUp = state.exit === null;
    check('2. the process is still alive half a second after its first tick '
      + "(the tick's own timer is the only thing that refs this loop)",
      stillUp, JSON.stringify(state.exit));

    const signalAt = Date.now();
    if (stillUp) state.child.kill('SIGTERM');
    await waitFor(() => state.exit !== null, signalAt + 5000);
    const ms = state.exit ? state.exitAt - signalAt : -1;
    console.log(`      2. exit ${ms} ms after ${stillUp ? 'SIGTERM' : 'its own unprompted exit'}, code ${state.exit?.code}`);

    check('2. it exits 0, not killed by a signal',
      state.exit?.code === 0 && state.exit?.signal === null,
      `code=${state.exit?.code} signal=${state.exit?.signal}`);

    await waitFor(() => state.closed, Date.now() + 1000);
    if (stillUp) {
      const early = findLine(state.logs, 'shutdown.early');
      check('2. SIGTERM produced shutdown.early', !!early, JSON.stringify(state.logs.slice(-300)));
      // The exact reason `notifier-entry.js` passes to `armShutdown` — this IS
      // the process's only shutdown path (there is no server to adopt the
      // arm), so the default string in `shared/src/shutdown.js` ("signal
      // arrived before the server was listening") would be false here.
      check('2. and it carries the notifier-entry.js reason, not the default one',
        early?.reason === 'this process runs no server; this is its only shutdown path',
        JSON.stringify(early));
    } else {
      check('2. SIGTERM produced shutdown.early (NOT REACHED: nothing to signal — '
        + 'the process had already exited on its own)', false);
      check('2. and it carries the notifier-entry.js reason (NOT REACHED, same reason)', false);
    }
  } catch (err) {
    check('2. HABITERALL_NOTIFY=on ticks and serves nothing', false, String(err?.stack ?? err));
  } finally {
    await reap(state);
  }

  /* ---------- 3. reminders off, but a backup rides the same tick ---------- */

  state = null;
  const backupDir = mkdtempSync(join(tmpdir(), 'habiterall-notifier-'));
  try {
    // Six hours from now, so the scheduled dump's own time never arrives
    // during this suite and no `pg_dump` is ever spawned. The point here is
    // that the TICK runs, not that a backup is taken.
    const at = new Date(Date.now() + 6 * 3600_000);
    const schedule = `${String(at.getHours()).padStart(2, '0')}:`
      + `${String(at.getMinutes()).padStart(2, '0')}`;

    state = spawnNotifier({
      HABITERALL_NOTIFY: 'off',
      HABITERALL_BACKUP_DIR: backupDir,
      HABITERALL_BACKUP_SCHEDULE: schedule,
      // Parseable and never connected to at boot — `backupConfig` validates
      // the SHAPE of this string and opens nothing, which is what lets this
      // case run with no Postgres like every other one here.
      DATABASE_URL_ADMIN: 'postgres://owner:pw@127.0.0.1:1/nodb',
    });

    const ticking = await waitFor(
      () => state.exit !== null
        || findLine(state.logs, 'notify.disabled_but_ticking') !== undefined,
      Date.now() + 5000);
    check('3. reminders off with a backup configured still starts the tick',
      ticking && state.exit === null, JSON.stringify(state.logs.slice(-300)));

    const starting = findLine(state.logs, 'backup.starting');
    check('3. and the backup says so at boot, from THIS process',
      starting?.dir === backupDir, JSON.stringify(starting));
    check('3. no notify.starting: the scan is off, only the timer is on',
      findLine(state.logs, 'notify.starting') === undefined,
      JSON.stringify(state.logs.slice(-300)));

    // The same settle and the same reason as case 2: with reminders off the
    // tick's only job is to call the backup hook, and an unref'd timer would
    // take the nightly dump down with it just as silently.
    await sleep(500);
    check('3. and it is still alive to reach its next tick', state.exit === null,
      JSON.stringify(state.exit));
  } catch (err) {
    check('3. a backup keeps the tick running with reminders off', false,
      String(err?.stack ?? err));
  } finally {
    await reap(state);
    rmSync(backupDir, { recursive: true, force: true });
  }

  /* ---------- 3b. the shipped half-configured state ---------- */

  state = null;
  const halfDir = mkdtempSync(join(tmpdir(), 'habiterall-notifier-'));
  try {
    // A directory set with no `DATABASE_URL_ADMIN` is exactly what the shipped
    // compose files leave an operator in the moment they set the directory,
    // and `backupConfig` classifies it rather than half-enabling it: no hook,
    // so with reminders off there is genuinely nothing to run and this
    // container exits 0 like case 1. The loud error is what the operator gets
    // instead of a silently disabled feature — and it is logged BEFORE the
    // exit, which is the half a `reportBackupConfig` left behind in
    // `server.js` would have lost.
    state = spawnNotifier({ HABITERALL_NOTIFY: 'off', HABITERALL_BACKUP_DIR: halfDir });

    const exited = await waitFor(() => state.exit !== null, Date.now() + 5000);
    check('3b. a backup dir with no admin credential is not a backup hook',
      exited && state.exit?.code === 0, JSON.stringify(state.logs.slice(-300)));

    const missing = findLine(state.logs, 'backup.admin_url_missing');
    check('3b. and the missing credential is named, loudly, before it goes',
      missing?.level === 'error', JSON.stringify(missing));
  } catch (err) {
    check('3b. a backup dir with no admin credential', false, String(err?.stack ?? err));
  } finally {
    await reap(state);
    rmSync(halfDir, { recursive: true, force: true });
  }

  /* ---------- 4. this process is unreachable from api.js ---------- */

  state = null;
  try {
    const child = spawn(process.execPath,
      ['--input-type=module', '-e', "await import('./src/api.js')"], {
        cwd: ROOT,
        env: {
          ...process.env,
          DATABASE_URL: UNREACHABLE_DB,
          SESSION_SECRET: 'notifier-integration-secret',
          HABITERALL_NOTIFY: 'on',
          DISCORD_BOT_TOKEN: 'a-fake-token',
          LOG_LEVEL: 'info',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    state = { child, logs: '', exit: null };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { state.logs += d; });
    child.stderr.on('data', (d) => { state.logs += d; });
    child.on('exit', (code, signal) => { state.exit = { code, signal }; });

    const done = await waitFor(() => state.exit !== null, Date.now() + 5000);
    check('4. importing api.js (what every cloud test suite does) exits cleanly',
      done, JSON.stringify(state.logs.slice(-300)));
    check('4. no notify.starting line appears',
      !state.logs.includes('"notify.starting"'), JSON.stringify(state.logs));
    check('4. no discord gateway line appears',
      !state.logs.includes('"discord') && !state.logs.toLowerCase().includes('gateway'),
      JSON.stringify(state.logs));
  } catch (err) {
    check('4. api.js never starts the notifier', false, String(err?.stack ?? err));
  } finally {
    await reap(state);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall notifier-entry checks passed');
} finally {
  await reap(state);
}

process.exit(failures ? 1 : 0);
