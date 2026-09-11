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
 *  11. a directory with no usable `DATABASE_URL_ADMIN` is refused loudly, but
 *      only ONCE, at boot, never per request — and the real entry point
 *      still boots.
 *
 * And, from the fix round following review of 13aa15d:
 *
 *  12. a directory that cannot be CREATED at all (a regular file sitting at a
 *      path component) does not crash the process — `runBackup`'s own outer
 *      try/catch, proved through the REAL production call path
 *      (`backupTask`'s un-awaited promise chain) rather than a test's own
 *      try/catch, which would hide the bug this exists for;
 *  13. a directory that EXISTS but cannot be WRITTEN — the root-owned-volume
 *      case — neither crashes the process nor leaves `pg_dump` running for
 *      the full two-hour timeout once its destination errors;
 *  14. two concurrent runs never share one temporary file name, so two
 *      replicas sharing one volume can never interleave two dumps into one
 *      file;
 *  15. `PGPASSWORD` is set in the child's environment only when the admin URL
 *      actually carried a password, and never overwrites an inherited one
 *      with an empty string.
 *
 * And, from the SECOND fix round following review of 2ab867e:
 *
 *  16. a stale `.tmp` left by a crashed run is reclaimed at the start of the
 *      NEXT run, but only once it is old enough that no live run could still
 *      own it — a fresh, matching `.tmp` and an old, non-matching one both
 *      survive;
 *  17. the timeout bounds the whole RUN, not merely the child: a destination
 *      whose write() neither returns nor errors still settles the run and
 *      logs `timed_out: true`, through the same injectable seams `runBackup`
 *      now takes for exactly this.
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
  statSync, existsSync, chmodSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
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
  backupConfig, reportBackupConfig, pgDumpConnection, pgDumpArgs, runBackup, backupTask,
  backupInFlight,
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
  // FIX 5 (issue #75 fix round): the dump holds every tenant's rows plus
  // every stored ntfy token and Discord webhook, so it must land 0o600, not
  // the createWriteStream default (0666, typically 0644 under an ordinary
  // umask).
  const mode1 = statSync(join(dir1, files1[0])).mode & 0o777;
  ck('case1 (FIX 5): the dump file is created mode 0o600',
    mode1 === 0o600, mode1.toString(8));

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
  //
  // FIX 3 (issue #75 fix round): `backupConfig` used to log
  // `backup.admin_url_missing` itself, as a side effect of computing
  // `enabled` — and `GET /backup/status` calls exactly this function, via
  // `backupEnabled()`, on EVERY request. So the first assertion here is that
  // `backupConfig` alone now logs NOTHING; the message moved to the separate
  // `reportBackupConfig`, asserted next; and the THIRD block below is FIX 3's
  // own case — hitting the route repeatedly must produce zero error lines.
  const { lines: quietLines11, result: cfg11 } = await captureLogs(() =>
    backupConfig({ HABITERALL_BACKUP_DIR: dir11, DATABASE_URL }));
  ck('case11: enabled is false', cfg11.enabled === false, JSON.stringify(cfg11));
  ck('case11 (FIX 3): backupConfig itself logs nothing — it is pure now',
    quietLines11.length === 0, quietLines11.join('').slice(0, 400));

  const { lines: reportLines11 } = await captureLogs(() => reportBackupConfig(cfg11));
  ck('case11 (FIX 3): the separate reportBackupConfig logs backup.admin_url_missing at error, naming the variable',
    reportLines11.some((l) => l.includes('"level":"error"') && l.includes('"msg":"backup.admin_url_missing"')
      && l.includes('DATABASE_URL_ADMIN')),
    reportLines11.join('').slice(0, 800));

  console.log('--- case 11 (FIX 3): hitting GET /api/backup/status repeatedly in the misconfigured state logs zero error lines ---');
  process.env.HABITERALL_BACKUP_DIR = dir11;
  delete process.env.DATABASE_URL_ADMIN;
  const { lines: routeLines11 } = await captureLogs(async () => {
    for (let i = 0; i < 5; i++) {
      const r = await apiCall('/api/backup/status');
      assert.strictEqual(r.status, 200);
    }
  });
  ck('case11 (FIX 3): five requests in the misconfigured state produce ZERO error-level lines — the route costs nothing',
    !routeLines11.some((l) => l.includes('"level":"error"')),
    routeLines11.join('').slice(0, 800));
  delete process.env.HABITERALL_BACKUP_DIR;

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
    // FIX 3 (issue #75 fix round): `reportBackupConfig` is called exactly
    // ONCE at boot in `server.js`, unconditionally — never inside
    // `backupConfig` itself and never from a route. `waitFor`'s polling above
    // issued several requests to `/healthz`, which does not touch
    // `backupConfig` at all, but this count is still the direct check that
    // boot logs it once and only once, regardless of what else the process
    // does afterward.
    const missingCount11b = (logs11.match(/"msg":"backup\.admin_url_missing"/g) ?? []).length;
    ck('case11b (FIX 3): backup.admin_url_missing is logged EXACTLY ONCE at boot, not per request',
      missingCount11b === 1, `count=${missingCount11b}\n${logs11.slice(0, 800)}`);
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

  /* ---------- case 12 (FIX 1): a directory that cannot be created at all does not crash the process ---------- */

  console.log('--- case 12 (FIX 1): HABITERALL_BACKUP_DIR through a regular file does not crash the process ---');
  const blockerFile12 = join(workdir, 'case12-blocker-file');
  writeFileSync(blockerFile12, 'not a directory');
  const dir12a = join(blockerFile12, 'sub');   // mkdirSync(dir, {recursive:true}) throws ENOTDIR
  const envCfg12a = {
    ...baseEnv, HABITERALL_BACKUP_DIR: dir12a,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
  };
  const task12a = backupTask(envCfg12a);
  ck('case12a: backupTask is armed (the config itself is otherwise valid)', task12a !== null);

  // First, `runBackup` directly — this is what isolates its OWN outer
  // try/catch from `backupTask`'s belt-and-braces `.catch()` (added
  // alongside it): a mutation that removes only the outer try/catch must
  // still be caught even though the belt-and-braces layer would otherwise
  // paper over it in the production path exercised just below.
  const cfg12direct = backupConfig(envCfg12a);
  let threw12direct = null;
  try {
    await runBackup(cfg12direct, { instant: new Date(2031, 1, 20, 3, 0) });
  } catch (err) {
    threw12direct = err;
  }
  ck('case12a (FIX 1): runBackup itself does not reject, called directly',
    threw12direct === null, threw12direct ? String(threw12direct.stack ?? threw12direct) : '');

  // Then the REAL production call path, not a test's own try/catch around
  // `runBackup` directly: `backupTask` builds
  // `inFlight = runBackup(...).catch(...).finally(...)` and that closure is
  // never awaited by ITS OWN caller (`server.js`/`notifier.js`). A test that
  // only wrapped `runBackup` itself in try/catch would pass whether or not
  // the fix exists, because the test's own try/catch would hide the bug.
  // `process.on('unhandledRejection', ...)` is what lets an actual unhandled
  // rejection be OBSERVED here without also crashing this test process —
  // Node only terminates on one when there is no listener at all.
  let unhandled12a = null;
  const onUnhandled12a = (err) => { unhandled12a = err; };
  process.on('unhandledRejection', onUnhandled12a);
  const { lines: lines12a } = await captureLogs(async () => {
    task12a(new Date(2031, 1, 20, 3, 0));
    await backupInFlight();
    // An unhandled rejection surfaces on a LATER turn of the event loop than
    // the promise settling; give it one before checking.
    await new Promise((r) => setImmediate(r));
  });
  process.off('unhandledRejection', onUnhandled12a);
  ck('case12a (FIX 1): the real production call path produces NO unhandled rejection',
    unhandled12a === null, unhandled12a ? String(unhandled12a.stack ?? unhandled12a) : '');
  ck('case12a (FIX 1): an error was logged',
    lines12a.some((l) => l.includes('"msg":"backup.failed"')), lines12a.join('').slice(0, 400));
  ck('case12a (FIX 1): no file was written — the directory could not even be created',
    !existsSync(dir12a), dir12a);

  const stillServing12a = await apiCall('/api/habits');
  ck('case12a (FIX 1): the process is still serving after the failure',
    stillServing12a.status === 200, JSON.stringify(stillServing12a).slice(0, 200));

  /* ---------- case 13 (FIX 1 + FIX 2): a directory that EXISTS but cannot be WRITTEN ---------- */

  console.log('--- case 13 (FIX 1 + FIX 2): a directory that exists but cannot be written (the root-owned-volume case) ---');
  if (process.getuid && process.getuid() === 0) {
    ck('case13: skipped — the suite is running as root, which ignores a directory\'s mode bits', true,
      'skip: cannot simulate a permission-denied directory as root — see the report');
  } else {
    const dir13 = join(workdir, 'case13');
    mkdirSync(dir13, { recursive: true });
    chmodSync(dir13, 0o500);   // r-x: the dir exists and can be listed, but no new file can be created in it

    // A stub that emits comfortably more than a kernel pipe's default 64 KiB
    // so that — without FIX 2's kill — an unconsumed pipe would eventually
    // block this child's own write() and hang until BACKUP_TIMEOUT_MS (two
    // hours). `/dev/urandom` rather than a loop of printf: fast, and no
    // shell-quoting surface.
    const bigDump13 = join(workdir, 'big-pg-dump.sh');
    writeFileSync(bigDump13, '#!/bin/sh\nhead -c 500000 /dev/urandom\n');
    chmodSync(bigDump13, 0o755);

    const envCfg13 = {
      ...baseEnv, HABITERALL_BACKUP_DIR: dir13,
      HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
      HABITERALL_PG_DUMP: bigDump13,
    };
    const task13 = backupTask(envCfg13);

    let unhandled13 = null;
    const onUnhandled13 = (err) => { unhandled13 = err; };
    process.on('unhandledRejection', onUnhandled13);
    task13(new Date(2031, 1, 21, 3, 0));
    const inflight13 = backupInFlight();
    const startedAt13 = Date.now();
    // A generous bound: the bug's signature is TWO HOURS, so 30s is nowhere
    // near it, and a fixed run settles in well under a second. This does NOT
    // wait out an unfixed run's full timeout — it only needs to observe that
    // the run has NOT settled within the bound.
    const settled13 = await Promise.race([
      // `.then(onFulfilled, onRejected)` rather than `.catch()` after —
      // this must resolve the RACE either way a settlement happens, and
      // `inFlight` should never reject anyway (see `backupTask`'s own
      // belt-and-braces `.catch()`).
      inflight13.then(() => 'settled', () => 'settled-rejected'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 30000)),
    ]);
    const elapsed13 = Date.now() - startedAt13;
    await new Promise((r) => setImmediate(r));
    process.off('unhandledRejection', onUnhandled13);

    ck('case13 (FIX 2): the run settles in seconds rather than hanging for the full timeout',
      settled13 !== 'timeout', `settled=${settled13} elapsed=${elapsed13}ms`);
    ck('case13 (FIX 1): no unhandled rejection either',
      unhandled13 === null, unhandled13 ? String(unhandled13.stack ?? unhandled13) : '');

    const files13x = readdirSync(dir13);
    ck('case13: no .sql file was written', !files13x.some((f) => f.endsWith('.sql')), JSON.stringify(files13x));

    chmodSync(dir13, 0o700);   // restore so the outer cleanup (rmSync) can remove it
    const stillServing13 = await apiCall('/api/habits');
    ck('case13: the process is still serving after the failure',
      stillServing13.status === 200, JSON.stringify(stillServing13).slice(0, 200));
  }

  /* ---------- case 14 (FIX 4): two concurrent runs never share one temporary file name ---------- */

  console.log('--- case 14 (FIX 4): two concurrent runs never share one temporary file name ---');
  const dir14 = join(workdir, 'case14');
  mkdirSync(dir14, { recursive: true });
  const slowDump14 = join(workdir, 'slow-stub-pg-dump.sh');
  writeFileSync(slowDump14, '#!/bin/sh\nsleep 0.5\nprintf "dump-data-from-pid-%s\\n" "$$"\n');
  chmodSync(slowDump14, 0o755);
  const cfg14 = backupConfig({
    ...baseEnv, HABITERALL_BACKUP_DIR: dir14,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
    HABITERALL_PG_DUMP: slowDump14,
  });
  const instant14 = new Date(2031, 1, 22, 3, 0);
  // Two RUNS directly (not through `backupTask`'s own `inFlight` guard,
  // which exists precisely to keep one PROCESS from doing this to itself) —
  // standing in for two separate REPLICA processes racing the same
  // directory, each with its own module state and no shared `inFlight`.
  const run14a = runBackup(cfg14, { instant: instant14 });
  const run14b = runBackup(cfg14, { instant: instant14 });
  let tmpNames14 = [];
  await waitFor(() => {
    tmpNames14 = readdirSync(dir14).filter((f) => f.endsWith('.tmp'));
    return tmpNames14.length >= 2;
  }, { timeoutMs: 5000, intervalMs: 20, what: 'two distinct .tmp files to coexist' });
  ck('case14: two concurrent runs write to two DIFFERENT temporary names',
    new Set(tmpNames14).size === 2, JSON.stringify(tmpNames14));
  await Promise.all([run14a, run14b]);
  const files14 = readdirSync(dir14);
  ck('case14: neither run leaves a .tmp behind once both have settled',
    !files14.some((f) => f.endsWith('.tmp')), JSON.stringify(files14));
  ck('case14: exactly one final .sql file remains — one writer won the rename '
    + '(the residual of two replicas duplicating the work is a documented single-writer assumption, not this fix)',
    files14.filter((f) => f.endsWith('.sql')).length === 1, JSON.stringify(files14));

  /* ---------- case 15 (FIX 5): PGPASSWORD only when the admin URL actually carried one ---------- */

  console.log('--- case 15 (FIX 5): PGPASSWORD is set in the child only when the admin URL actually carried a password ---');
  const envDump15 = join(workdir, 'env-dump-pg-dump.sh');
  writeFileSync(envDump15,
    '#!/bin/sh\nif [ -n "${PGPASSWORD+x}" ]; then printf "PGPASSWORD_SET=%s\\n" "$PGPASSWORD"; '
    + 'else printf "PGPASSWORD_UNSET\\n"; fi\n');
  chmodSync(envDump15, 0o755);

  // (a) an admin URL WITH a password: PGPASSWORD is set to it.
  const dir15a = join(workdir, 'case15a');
  const cfg15a = backupConfig({
    ...baseEnv, HABITERALL_BACKUP_DIR: dir15a,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
    HABITERALL_PG_DUMP: envDump15,
  });
  ck('case15a: config is enabled (the admin URL in this suite carries a password)', cfg15a.enabled === true);
  // Derived from the SAME admin URL the suite runs with, rather than
  // hard-coded, so this case still means something if the suite is ever run
  // against different credentials.
  const expectedPassword15a = pgDumpConnection(DATABASE_URL_ADMIN).password;
  ck('case15a: the admin URL this suite runs with does carry a non-empty password '
    + '(or this case is not testing what it claims to)', expectedPassword15a.length > 0);
  await runBackup(cfg15a, { instant: new Date(2031, 1, 23, 3, 0) });
  const files15a = readdirSync(dir15a);
  const out15a = readFileSync(join(dir15a, files15a[0]), 'utf8');
  ck('case15a (FIX 5): PGPASSWORD is set in the child env, to the URL\'s own password',
    out15a.includes(`PGPASSWORD_SET=${expectedPassword15a}`), out15a);

  // (b) an admin URL with NO password segment at all: PGPASSWORD must not be
  // fabricated as an empty string, and — the exact bug — must not OVERWRITE
  // an inherited PGPASSWORD from the parent process's own environment.
  const dir15b = join(workdir, 'case15b');
  const url15b = 'postgres://owner@localhost:5432/habiterall';   // no password
  const cfg15b = backupConfig({
    DATABASE_URL_ADMIN: url15b, HABITERALL_BACKUP_DIR: dir15b,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
    HABITERALL_PG_DUMP: envDump15,
  });
  ck('case15b: a passwordless admin URL is still a valid, enabled connection string',
    cfg15b.enabled === true, JSON.stringify(cfg15b));

  const priorPgPassword15 = process.env.PGPASSWORD;
  process.env.PGPASSWORD = 'inherited-from-parent-env';
  try {
    await runBackup(cfg15b, { instant: new Date(2031, 1, 23, 3, 0) });
  } finally {
    if (priorPgPassword15 === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = priorPgPassword15;
  }
  const files15b = readdirSync(dir15b);
  const out15b = readFileSync(join(dir15b, files15b[0]), 'utf8');
  ck('case15b (FIX 5): an inherited PGPASSWORD is NOT overwritten with an empty string for a passwordless URL',
    out15b.includes('PGPASSWORD_SET=inherited-from-parent-env'), out15b);

  /* ---------- case 16 (FIX 1, second fix round): a crashed run's own stale .tmp is reclaimed, age-gated ---------- */

  console.log('--- case 16 (FIX 1, second fix round): a stale .tmp is reclaimed only once it is old enough ---');
  const dir16 = join(workdir, 'case16');
  mkdirSync(dir16, { recursive: true });

  // This module's own shape, for a date that has nothing to do with today —
  // the reclaim keys on AGE, never on date, and this proves it: a name dated
  // 2030-01-01 is reclaimed exactly as one dated today would be.
  const staleDate16 = '2030-01-01';
  const staleName16 = `${backupFileName(staleDate16, 'sql')}.${randomUUID()}.tmp`;
  writeFileSync(join(dir16, staleName16), 'a truncated dump from a run that never finished');
  const oldTime16 = new Date(Date.now() - 24 * 60 * 60 * 1000);   // a day old — well past any real run's own bound
  utimesSync(join(dir16, staleName16), oldTime16, oldTime16);

  // Same shape, but FRESH — as if a second run were genuinely still in
  // progress right now. Must survive: age is the only thing that tells the
  // two apart.
  const freshName16 = `${backupFileName(staleDate16, 'sql')}.${randomUUID()}.tmp`;
  writeFileSync(join(dir16, freshName16), 'a run that is still in progress right now');

  // OLD but NOT this module's shape — proves the match is by PATTERN, not
  // merely by age, so an unrelated old .tmp (a personal instance's, or
  // anything else) is never a candidate.
  const foreignName16 = 'not-a-habiterall-backup-shape.tmp';
  writeFileSync(join(dir16, foreignName16), 'unrelated file, must never be touched');
  utimesSync(join(dir16, foreignName16), oldTime16, oldTime16);

  const cfg16 = backupConfig({
    ...baseEnv, HABITERALL_BACKUP_DIR: dir16,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
  });
  const { lines: lines16 } = await captureLogs(() =>
    runBackup(cfg16, { instant: new Date(2031, 2, 1, 3, 0) }));

  const files16 = new Set(readdirSync(dir16));
  ck('case16: the stale, matching .tmp is reclaimed', !files16.has(staleName16), JSON.stringify([...files16]));
  ck('case16: the fresh, matching .tmp survives — too young to be a crash',
    files16.has(freshName16), JSON.stringify([...files16]));
  ck('case16: the old, non-matching .tmp survives — not this module\'s shape',
    files16.has(foreignName16), JSON.stringify([...files16]));
  ck('case16: this run\'s own dump still landed normally',
    [...files16].some((f) => f.endsWith('.sql')), JSON.stringify([...files16]));
  ck('case16: the reclaim was logged, naming the one file',
    lines16.some((l) => l.includes('"msg":"backup.reclaimed_stale_tmp"') && l.includes('"count":1')
      && l.includes(staleName16)),
    lines16.join('').slice(0, 800));

  /* ---------- case 17 (FIX 5, second fix round): the timeout bounds the whole RUN, not merely the child ---------- */

  console.log('--- case 17 (FIX 5, second fix round): a destination whose write() neither returns nor errors still settles the run ---');
  const dir17 = join(workdir, 'case17');
  const cfg17 = backupConfig({
    ...baseEnv, HABITERALL_BACKUP_DIR: dir17,
    HABITERALL_BACKUP_SCHEDULE: '00:00', HABITERALL_BACKUP_KEEP: '7',
  });

  // The write that neither returns nor errors: `_write`'s callback is never
  // invoked, so this stream can never reach 'finish', and therefore never
  // 'close' either — exactly the destination a hard-mounted, gone-away
  // network volume looks like from here.
  class NeverSettlingWritable extends Writable {
    _write(_chunk, _enc, _cb) { /* deliberately never calls back */ }
  }
  const stubCreateWriteStream17 = (_path, opts) => new NeverSettlingWritable(opts);

  let unhandled17 = null;
  const onUnhandled17 = (err) => { unhandled17 = err; };
  process.on('unhandledRejection', onUnhandled17);
  const startedAt17 = Date.now();
  const { lines: lines17 } = await captureLogs(() => runBackup(cfg17, {
    instant: new Date(2031, 2, 5, 3, 0),
    createWriteStream: stubCreateWriteStream17,
    // Short, injected bounds — see `runBackup`'s own JSDoc: this is the ONLY
    // place either is ever set to anything but the real two-hour/five-second
    // constants. Without FIX 5 this run would simply never settle at all
    // (the join has nothing else to wait on), so there is no risk of this
    // assertion passing for the wrong reason — an UNFIXED version hangs
    // rather than failing fast, which the mutation record below says plainly.
    timeoutMs: 200,
    killGraceMs: 50,
  }));
  const elapsed17 = Date.now() - startedAt17;
  process.off('unhandledRejection', onUnhandled17);

  ck('case17: the run settles quickly, bounded by the injected timeout+grace rather than hanging forever',
    elapsed17 < 5000, `elapsed=${elapsed17}ms`);
  ck('case17: no unhandled rejection either', unhandled17 === null,
    unhandled17 ? String(unhandled17.stack ?? unhandled17) : '');
  ck('case17: an error was logged carrying timed_out: true',
    lines17.some((l) => l.includes('"msg":"backup.failed"') && l.includes('"timed_out":true')),
    lines17.join('').slice(0, 800));
  const files17 = existsSync(dir17) ? readdirSync(dir17) : [];
  ck('case17: no .sql file was written on the timed-out path', !files17.some((f) => f.endsWith('.sql')),
    JSON.stringify(files17));
  ck('case17: no .tmp survives either', !files17.some((f) => f.endsWith('.tmp')), JSON.stringify(files17));

  console.log(`\n${fails ? `${fails} check(s) failed` : 'all checks passed'}`);
} finally {
  testServer.close();
  await admin.query('DELETE FROM users WHERE idp_subject = $1', [SUBJECT]);
  await admin.end().catch(() => {});
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(fails ? 1 : 0);
