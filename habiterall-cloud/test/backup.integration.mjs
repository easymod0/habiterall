/**
 * Cloud's whole-database `pg_dump`, against a real Postgres (issue #75).
 *
 * `shared/test/backup.test.js` proves the retention math with no storage at
 * all, and `habiterall-personal/test/backup.integration.mjs` proves the JSON
 * export and the `VACUUM INTO` snapshot end to end. What only exists once
 * wired to a real database, a real `pg_dump` and a real tick:
 *
 *   1. THE case that justifies the whole change: a row written through the
 *      admin connection is in the dump file, by name — not the file's
 *      existence, not its size.
 *   2. the password reaches the child as `PGPASSWORD` and never as an argv
 *      element, through the exported pure functions rather than a source-text
 *      claim;
 *   3. `--enable-row-security` is never in the argv, pinned both by value and
 *      by a source-text guard that prints what it searched;
 *   4. retention only ever touches the `.sql` family, leaving a personal
 *      instance's `.json`/`.db` files (and anything foreign) alone;
 *   5. the dedupe survives a real day's worth of ticks AND a simulated
 *      restart — the file on disk is the record, not the in-memory date;
 *   6. a failed run is loud, bounded, and leaves no partial file;
 *   7. a failed run is not retried until the next local day, and a restart
 *      does retry once;
 *   8. `GET /api/backup/status` discloses only the one bit, over the real
 *      router;
 *   9. `HABITERALL_NOTIFY=off` does not take the backup down with it, over
 *      the real `notifier.js` `start()` — and the hook it calls returns
 *      promptly rather than blocking the shared tick on the dump;
 *  10. disabled by default (no `HABITERALL_BACKUP_DIR`), on both halves;
 *  11. a directory with no usable `DATABASE_URL_ADMIN` is refused loudly, and
 *      the real entry point still boots.
 *
 * `pg_dump` opens its own connection outside the pool, so nothing here goes
 * through `withUser`/`withoutUser`: an admin `pg.Client` is used directly for
 * fixtures and for reading the dump back, exactly as the module under test
 * reads and writes with its own child process.
 *
 * `GET /api/backup/status` is exercised by mounting the real `api` router
 * (imported, not reimplemented) behind a hand-rolled session middleware
 * rather than by spawning the whole server — `api.js` has no side effect at
 * import time and nothing here depends on `requireAuth`'s cookie mechanics,
 * which `data-version.integration.mjs` already covers. Cloud's `server.js`
 * has NO `isEntryPoint` guard (it always listens), so it is never imported
 * directly in this process; the one thing only the real entry point can
 * prove — case 11's "the server still boots" — is checked by spawning it as a
 * child, the same way every other cloud suite that needs the real server does.
 *
 *   DATABASE_URL=... ADMIN_URL=... DATABASE_URL_ADMIN=... \
 *     HABITERALL_PG_DUMP=/tmp/habiterall-pgshim/pg_dump \
 *     node test/backup.integration.mjs
 */

import {
  mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  statSync, existsSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import pg from 'pg';
import express from 'express';

process.env.DATABASE_URL ??=
  'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_URL = process.env.ADMIN_URL ?? 'postgres://owner:testpw@localhost:5432/habiterall';
const DATABASE_URL_ADMIN = process.env.DATABASE_URL_ADMIN ?? ADMIN_URL;
const PG_DUMP = process.env.HABITERALL_PG_DUMP ?? 'pg_dump';

const backupModulePath = fileURLToPath(new URL('../src/backup.js', import.meta.url));
const backup = await import('../src/backup.js');
const {
  backupConfig, pgDumpConnection, pgDumpArgs, runBackup, backupTask, backupInFlight,
} = backup;
const notifier = await import('../src/notifier.js');
const { api } = await import('../src/api.js');
const { BACKUP_SQL_FILE_RE, backupFileName } = await import('@habiterall/shared/backup.js');
const { zonedClock } = await import('@habiterall/shared/notify.js');

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

/** Wait for the app, never for a duration — poll a predicate, throw naming it. */
async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50, what = 'condition' } = {}) {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** `log.js`'s write is resolved at emit time, so patching stdout during the
 * call is enough to read what it said. */
async function captureLogs(fn) {
  const lines = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  let result;
  try {
    result = await fn();
  } finally {
    process.stdout.write = realWrite;
  }
  return { lines, result };
}

const offsetDate = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Minimal OIDC discovery, so `initAuth` can complete without a real IdP —
 * needed only for case 11b, the one thing only the real entry point proves. */
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

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-cloud-backup-'));

/** Every case spreads this and overrides `HABITERALL_BACKUP_DIR` etc. */
const baseEnv = { DATABASE_URL_ADMIN, HABITERALL_PG_DUMP: PG_DUMP };

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();

const SUBJECT = 'ci-backup-suite';
const CANARY_NAME = `CANARY-issue75-${Date.now()}-${Math.random().toString(36).slice(2)}`;

await admin.query('DELETE FROM users WHERE idp_subject = $1', [SUBJECT]);
const { rows: [{ id: fixtureUserRaw }] } = await admin.query(
  `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
   VALUES ($1, 'https://ci.example', 'backup-suite@example.com', 'backup-suite')
   RETURNING id`,
  [SUBJECT]
);
const fixtureUserId = Number(fixtureUserRaw);
await admin.query(
  `INSERT INTO habits (user_id, name) VALUES ($1, $2)`,
  [fixtureUserId, CANARY_NAME]
);

/** The real router, mounted behind a hand-rolled session — see the header
 * comment for why this is enough and what it deliberately does not cover. */
const testApp = express();
testApp.use((req, res, next) => {
  req.session = { user: { id: fixtureUserId, email: 'x', name: 'x', blocked: false } };
  next();
});
testApp.use('/api', api);
const testServer = await new Promise((resolve) => {
  const s = testApp.listen(0, '127.0.0.1', () => resolve(s));
});
const testBase = `http://127.0.0.1:${testServer.address().port}`;
const apiCall = async (path) => {
  const res = await fetch(testBase + path);
  const body = res.status === 204 ? null : await res.json();
  return { status: res.status, body };
};

try {
  /* ---------- case 1: the canary row is in the dump ---------- */

  console.log('--- case 1: the canary row is in the dump ---');
  const dir1 = join(workdir, 'case1');
  const cfg1 = backupConfig({
    ...baseEnv, HABITERALL_BACKUP_DIR: dir1,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
  });
  ck('case1: backups are enabled with a valid admin URL', cfg1.enabled === true, JSON.stringify(cfg1));
  await runBackup(cfg1, { instant: new Date(2031, 0, 10, 3, 0) });

  const files1 = readdirSync(dir1);
  ck('case1: exactly one .sql file after the run',
    files1.length === 1 && files1[0].endsWith('.sql'), JSON.stringify(files1));
  const dumpText1 = readFileSync(join(dir1, files1[0]), 'utf8');
  ck("case1: the canary habit's name is in the dump — not the file's existence, not its size",
    dumpText1.includes(CANARY_NAME), `dump length=${dumpText1.length}`);

  /* ---------- case 2: no password in argv ---------- */

  console.log('--- case 2: the password reaches the child as PGPASSWORD, never in argv ---');
  const PASSWORD2 = 'sekret-p@ss/word=2+more';
  const url2 = `postgres://someuser:${encodeURIComponent(PASSWORD2)}@localhost:5432/habiterall`;
  const conn2 = pgDumpConnection(url2);
  ck('case2: the rebuilt connection string carries no password', !conn2.arg.includes(PASSWORD2), conn2.arg);
  ck('case2: the password is returned separately, decoded', conn2.password === PASSWORD2, conn2.password);
  const args2 = pgDumpArgs(conn2.arg);
  ck('case2: no argv element is or contains the password',
    args2.every((a) => !a.includes(PASSWORD2)), JSON.stringify(args2));

  /* ---------- case 3: --enable-row-security is never passed ---------- */

  console.log('--- case 3: --enable-row-security never appears ---');
  const args3 = pgDumpArgs('postgres://u:p@h/db');
  ck('case3: the exact argv, by value',
    JSON.stringify(args3) === JSON.stringify(['--no-password', '--format=plain', '--dbname', 'postgres://u:p@h/db']),
    JSON.stringify(args3));
  ck('case3: --enable-row-security is not among them',
    !args3.includes('--enable-row-security'), JSON.stringify(args3));

  const src3 = readFileSync(backupModulePath, 'utf8');
  const spawnSites3 = [...src3.matchAll(/spawn\([^)]*\)/gs)].map((m) => m[0]);
  console.log(`  (source guard inspected ${spawnSites3.length} spawn() call site(s) in src/backup.js)`);
  ck('case3: at least one spawn() call site exists to search (the denominator)',
    spawnSites3.length > 0, String(spawnSites3.length));
  // Comments legitimately name the flag in prose (the whole point of the
  // warning above `pgDumpArgs`), so the guard has to read CODE, not text —
  // block comments and whole-line `//` comments are stripped before the grep,
  // or this would fail against its own documentation forever.
  const codeOnly3 = src3
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  ck('case3: no spawn() call site, and no CODE line in the file, contains --enable-row-security',
    !codeOnly3.includes('--enable-row-security'), 'grep (code only) hit --enable-row-security');

  /* ---------- case 4: retention only ever touches its own .sql family ---------- */

  console.log('--- case 4: retention only ever touches the .sql family ---');
  const dir4 = join(workdir, 'case4');
  mkdirSync(dir4, { recursive: true });
  const instant4 = new Date(2031, 0, 15, 3, 0);
  const { date: today4 } = zonedClock(instant4, '');
  const olderDates4 = [-5, -4, -3, -2, -1].map((n) => offsetDate(today4, n));
  for (const d of olderDates4) {
    writeFileSync(join(dir4, backupFileName(d, 'sql')), '-- not a real dump, retention never opens it\n');
  }
  writeFileSync(join(dir4, 'keep-me.txt'), 'not a backup');
  const foreignDate4 = offsetDate(today4, -6);
  const staleTmp4 = `${backupFileName(foreignDate4, 'sql')}.tmp`;
  writeFileSync(join(dir4, staleTmp4), 'a partial write from a previous, interrupted run');
  writeFileSync(join(dir4, backupFileName(foreignDate4, 'json')), '{}');
  writeFileSync(join(dir4, backupFileName(foreignDate4, 'db')), 'not a real sqlite file');

  const cfg4 = backupConfig({
    ...baseEnv, HABITERALL_BACKUP_DIR: dir4,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '2',
  });
  await runBackup(cfg4, { instant: instant4 });

  const files4 = new Set(readdirSync(dir4));
  const expected4 = new Set([
    backupFileName(today4, 'sql'),
    backupFileName(olderDates4[4], 'sql'),
    'keep-me.txt', staleTmp4,
    backupFileName(foreignDate4, 'json'), backupFileName(foreignDate4, 'db'),
  ]);
  ck('case4: retention keeps exactly KEEP of its own .sql family, every foreign file untouched',
    files4.size === expected4.size && [...files4].every((f) => expected4.has(f)),
    JSON.stringify([...files4]));

  /* ---------- case 5: dedupe, including across a simulated restart ---------- */

  console.log('--- case 5: dedupe, including across a simulated restart ---');
  const dir5 = join(workdir, 'case5');
  const envCfg5 = {
    ...baseEnv, HABITERALL_BACKUP_DIR: dir5,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
  };
  const task5 = backupTask(envCfg5);
  ck('case5: backupTask is armed', task5 !== null);
  const instant5 = new Date(2031, 0, 20, 4, 0);

  task5(instant5);
  await backupInFlight();
  const files5a = readdirSync(dir5);
  ck('case5: one file after the first tick', files5a.length === 1, JSON.stringify(files5a));
  const path5 = join(dir5, files5a[0]);
  const mtime5a = statSync(path5).mtimeMs;

  task5(instant5);
  await backupInFlight();
  const files5b = readdirSync(dir5);
  ck('case5: still exactly one file after a second tick the same day (in-memory dedupe)',
    files5b.length === 1 && statSync(path5).mtimeMs === mtime5a, JSON.stringify(files5b));

  // Simulate a restart: a FRESH module instance, so `inFlight`/`lastAttemptDate`
  // reset. This is the only way to observe that within one process — an
  // ordinary re-import shares the cached module and its state — and it is
  // what proves the dedupe is the FILESYSTEM, not the in-memory date: the
  // fresh instance's own in-memory date is empty, yet it still does not
  // re-dump, because today's file already exists on disk.
  const freshBackup5 = await import(`../src/backup.js?restart=${Date.now()}-${Math.random()}`);
  const task5c = freshBackup5.backupTask(envCfg5);
  task5c(instant5);
  await freshBackup5.backupInFlight();
  const files5c = readdirSync(dir5);
  ck('case5: a fresh module instance (a restart) still does not re-dump — the FILE is the record',
    files5c.length === 1 && statSync(path5).mtimeMs === mtime5a, JSON.stringify(files5c));

  /* ---------- case 6: a failed run is loud, bounded, and leaves nothing ---------- */

  console.log('--- case 6: a failed run is loud, bounded, and leaves nothing ---');
  const failDump6 = join(workdir, 'fail-pg-dump.sh');
  writeFileSync(failDump6,
    '#!/bin/sh\necho "pg_dump: error: server version mismatch (simulated)" 1>&2\nexit 1\n');
  chmodSync(failDump6, 0o755);

  const dir6 = join(workdir, 'case6');
  const cfg6 = backupConfig({
    ...baseEnv, HABITERALL_BACKUP_DIR: dir6,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
    HABITERALL_PG_DUMP: failDump6,
  });
  let threw6 = null;
  let lines6 = [];
  try {
    const captured = await captureLogs(() => runBackup(cfg6, { instant: new Date(2031, 0, 25, 5, 0) }));
    lines6 = captured.lines;
  } catch (err) {
    threw6 = err;
  }
  ck('case6: a failed dump does not throw', threw6 === null, threw6 ? String(threw6.stack ?? threw6) : '');
  const files6 = existsSync(dir6) ? readdirSync(dir6) : [];
  ck('case6: no .sql file was created', !files6.some((f) => f.endsWith('.sql')), JSON.stringify(files6));
  ck('case6: no .tmp survives', !files6.some((f) => f.endsWith('.tmp')), JSON.stringify(files6));
  ck('case6: an error was logged carrying the exit code and the stderr tail',
    lines6.some((l) => l.includes('"msg":"backup.failed"') && l.includes('"exit_code":1')
      && l.includes('server version mismatch')),
    lines6.join('').slice(0, 800));

  const stillServing6 = await apiCall('/api/habits');
  ck('case6: the process is still serving after the failure',
    stillServing6.status === 200, JSON.stringify(stillServing6).slice(0, 200));

  /* ---------- case 7: a failed run does not retry every minute ---------- */

  console.log('--- case 7: a failed run does not retry until the next local day ---');
  const marker7 = join(workdir, 'case7-invocations');
  writeFileSync(marker7, '');
  const failDump7 = join(workdir, 'fail-pg-dump-counting.sh');
  writeFileSync(failDump7, `#!/bin/sh
echo x >> "${marker7}"
echo "pg_dump: error: server version mismatch (simulated)" 1>&2
exit 1
`);
  chmodSync(failDump7, 0o755);

  const dir7 = join(workdir, 'case7');
  const envCfg7 = {
    ...baseEnv, HABITERALL_BACKUP_DIR: dir7,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
    HABITERALL_PG_DUMP: failDump7,
  };
  const task7 = backupTask(envCfg7);
  const instant7a = new Date(2031, 1, 5, 3, 0);
  task7(instant7a);
  await backupInFlight();
  const invocations7a = readFileSync(marker7, 'utf8').split('\n').filter(Boolean).length;
  ck('case7: the first tick attempts the dump', invocations7a === 1, `invocations=${invocations7a}`);

  const instant7b = new Date(2031, 1, 5, 3, 30);   // later, same local day
  task7(instant7b);
  await backupInFlight();
  const invocations7b = readFileSync(marker7, 'utf8').split('\n').filter(Boolean).length;
  ck('case7: a later tick the same day does not retry — the child was not spawned a second time',
    invocations7b === 1, `invocations=${invocations7b}`);

  const freshBackup7 = await import(`../src/backup.js?restart=case7-${Date.now()}-${Math.random()}`);
  const task7c = freshBackup7.backupTask(envCfg7);
  task7c(instant7a);
  await freshBackup7.backupInFlight();
  const invocations7c = readFileSync(marker7, 'utf8').split('\n').filter(Boolean).length;
  ck('case7: a fresh module instance (a restart) DOES try again',
    invocations7c === 2, `invocations=${invocations7c}`);

  /* ---------- case 8: no disclosure ---------- */

  console.log('--- case 8: GET /api/backup/status discloses only the one bit ---');
  const dir8 = join(workdir, 'case8-route');
  process.env.HABITERALL_BACKUP_DIR = dir8;
  process.env.DATABASE_URL_ADMIN = DATABASE_URL_ADMIN;
  process.env.HABITERALL_PG_DUMP = PG_DUMP;
  // Off their defaults, so a mutation that echoes them back is visible as a
  // SPECIFIC leaked value rather than one that happens to already be null.
  process.env.HABITERALL_BACKUP_SCHEDULE = '04:17';
  process.env.HABITERALL_BACKUP_KEEP = '11';

  const cfg8 = backupConfig(process.env);
  ck('case8: backups are enabled for this route check', cfg8.enabled === true, JSON.stringify(cfg8));
  // A completed run first — the route must disclose nothing even once there
  // is something (in principle) to disclose, not merely on an untouched config.
  await runBackup(cfg8, { instant: new Date(2031, 1, 10, 3, 0) });

  const status8 = await apiCall('/api/backup/status');
  try {
    assert.deepStrictEqual(status8.body, { enabled: true, schedule: null, keep: null, last: null });
    ck('case8: the body deepEquals exactly {enabled:true, schedule:null, keep:null, last:null}', true);
  } catch (err) {
    ck('case8: the body deepEquals exactly {enabled:true, schedule:null, keep:null, last:null}',
      false, err.message);
  }
  const status8Text = JSON.stringify(status8.body);
  ck('case8: nothing in the body names the directory, the schedule or the keep count',
    !status8Text.includes(dir8) && !status8Text.includes('04:17') && !status8Text.includes('11'),
    status8Text);

  delete process.env.HABITERALL_BACKUP_DIR;
  delete process.env.DATABASE_URL_ADMIN;
  delete process.env.HABITERALL_PG_DUMP;
  delete process.env.HABITERALL_BACKUP_SCHEDULE;
  delete process.env.HABITERALL_BACKUP_KEEP;

  /* ---------- case 9: reminders off, backups still run ---------- */

  console.log('--- case 9: reminders off, backups still run (the real notifier.js start()) ---');
  const dir9 = join(workdir, 'case9');
  const backupHook9 = backupTask({
    ...baseEnv, HABITERALL_BACKUP_DIR: dir9,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
  });
  ck('case9: the backup task is armed', backupHook9 !== null);

  let live9 = null;
  try {
    const { lines: lines9, result } = await captureLogs(() =>
      notifier.start({ HABITERALL_NOTIFY: 'off', HABITERALL_NOTIFY_INTERVAL_MS: '60000' },
        { onTick: backupHook9 }));
    live9 = result;
    ck('case9: start() does not return null with reminders off but a backup hook present',
      live9 !== null, lines9.join(''));
    ck('case9: and says so — reminders are off but the tick keeps running for the scheduled job',
      lines9.some((l) => l.includes('"msg":"notify.disabled_but_ticking"')), lines9.join(''));

    await waitFor(() => {
      try { return readdirSync(dir9).some((n) => BACKUP_SQL_FILE_RE.test(n)); } catch { return false; }
    }, { what: 'a .sql backup file to appear under HABITERALL_NOTIFY=off' });
    ck('case9: a backup file is written even with reminders off', true);
  } finally {
    live9?.stop();
  }

  // The non-blocking half: the returned hook must return promptly when
  // AWAITED — exactly what `startNotifier`'s own `await ctx.onTick(instant)`
  // does — never itself awaiting the dump. A slow `pg_dump` stand-in (a
  // deliberate 1s sleep) is what makes the difference observable: an
  // implementation that returns synchronously resolves this await in a few
  // milliseconds regardless of how long the dump underneath takes, while one
  // that `return`s (or awaits) the dump's own promise takes the full second.
  console.log('--- case 9b: the hook returns promptly, never blocking the shared tick on the dump ---');
  const slowDump9b = join(workdir, 'slow-pg-dump.sh');
  writeFileSync(slowDump9b, `#!/bin/sh\nsleep 1\nexec "${PG_DUMP}" "$@"\n`);
  chmodSync(slowDump9b, 0o755);

  const dir9b = join(workdir, 'case9b');
  const task9b = backupTask({
    ...baseEnv, HABITERALL_BACKUP_DIR: dir9b,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
    HABITERALL_PG_DUMP: slowDump9b,
  });
  const instant9b = new Date(2031, 1, 1, 6, 0);
  const startedAt9b = Date.now();
  await task9b(instant9b);
  const awaited9b = Date.now() - startedAt9b;
  ck('case9b: awaiting the hook returns promptly, not awaiting the dump itself',
    awaited9b < 300, `${awaited9b}ms`);
  ck('case9b: the dump is still in flight after the call returns', backupInFlight() !== null);
  await backupInFlight();
  const files9b = readdirSync(dir9b);
  ck('case9b: the slow dump still completes and lands a file',
    files9b.some((f) => f.endsWith('.sql')), JSON.stringify(files9b));

  /* ---------- case 10: disabled ---------- */

  console.log('--- case 10: disabled ---');
  const cfg10 = backupConfig({});
  ck('case10: backupConfig reports disabled with no dir set', cfg10.enabled === false, JSON.stringify(cfg10));
  const task10 = backupTask({});
  ck('case10: backupTask() is null with no dir set', task10 === null);

  delete process.env.HABITERALL_BACKUP_DIR;
  const status10 = await apiCall('/api/backup/status');
  try {
    assert.deepStrictEqual(status10.body, { enabled: false, schedule: null, keep: null, last: null });
    ck('case10: the route reports disabled with the same shape', true);
  } catch (err) {
    ck('case10: the route reports disabled with the same shape', false, err.message);
  }

  /* ---------- case 11: no usable DATABASE_URL_ADMIN ---------- */

  console.log('--- case 11: a dir with no usable DATABASE_URL_ADMIN is refused loudly ---');
  const dir11 = join(workdir, 'case11');
  // `DATABASE_URL` (the app role) IS present here, on purpose: this is
  // premise 8's exact shape — an operator who set the ordinary app
  // connection but never DATABASE_URL_ADMIN — and it is what would catch a
  // reverted `DATABASE_URL_ADMIN ?? DATABASE_URL` fallback even if case 11b's
  // spawned server did not.
  const { lines: lines11, result: cfg11 } = await captureLogs(() =>
    backupConfig({ HABITERALL_BACKUP_DIR: dir11, DATABASE_URL }));
  ck('case11: enabled is false', cfg11.enabled === false, JSON.stringify(cfg11));
  ck('case11: backup.admin_url_missing is logged at error, naming the variable',
    lines11.some((l) => l.includes('"level":"error"') && l.includes('"msg":"backup.admin_url_missing"')
      && l.includes('DATABASE_URL_ADMIN')),
    lines11.join('').slice(0, 800));

  console.log('--- case 11b: through the real entry point, the server still boots ---');
  const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));
  const { srv: issuerSrv, base: issuer } = await fakeIssuer();
  const port11 = 3600 + (process.pid % 21);
  const base11 = `http://127.0.0.1:${port11}`;
  let child11 = null;
  let exit11 = null;
  let logs11 = '';
  try {
    const spawnEnv11 = {
      ...process.env,
      PORT: String(port11),
      SESSION_SECRET: 'backup-suite-secret',
      PUBLIC_URL: `http://localhost:${port11}`,
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: 'test-client',
      OIDC_CLIENT_SECRET: 'test-secret',
      ALLOW_INSECURE_OIDC: 'true',
      HABITERALL_NOTIFY: 'off',
      LOG_LEVEL: 'error',
      HABITERALL_BACKUP_DIR: dir11,
      HABITERALL_PG_DUMP: PG_DUMP,
    };
    // The one variable this case is about the ABSENCE of — never inherited
    // from the parent test process, whatever an earlier case left behind.
    delete spawnEnv11.DATABASE_URL_ADMIN;

    child11 = spawn(process.execPath, [serverPath], {
      cwd: new URL('..', import.meta.url).pathname,
      env: spawnEnv11,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child11.stdout.on('data', (d) => { logs11 += String(d); });
    child11.stderr.on('data', (d) => { logs11 += String(d); });
    child11.on('exit', (code, signal) => { exit11 = { code, signal }; });

    await waitFor(async () => {
      if (exit11) throw new Error(`case 11b: the real server exited during boot :: ${logs11}`);
      try { return (await fetch(`${base11}/healthz`)).ok; } catch { return false; }
    }, {
      timeoutMs: 10000,
      what: 'case 11b: the real, spawned server (misconfigured backups) to answer /healthz',
    });
    ck('case11b: the server boots and answers healthy despite the misconfigured backup variable', true);
    ck('case11b: the real process logged backup.admin_url_missing at boot too',
      logs11.includes('"msg":"backup.admin_url_missing"'), logs11.slice(0, 800));
  } finally {
    if (child11 && exit11 === null) {
      child11.kill('SIGTERM');
      await new Promise((resolve) => {
        const to = setTimeout(resolve, 5000);
        child11.once('exit', () => { clearTimeout(to); resolve(); });
      });
    }
    issuerSrv.close();
  }

  console.log(`\n${fails ? `${fails} check(s) failed` : 'all checks passed'}`);
} finally {
  testServer.close();
  await admin.query('DELETE FROM users WHERE idp_subject = $1', [SUBJECT]);
  await admin.end().catch(() => {});
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(fails ? 1 : 0);
