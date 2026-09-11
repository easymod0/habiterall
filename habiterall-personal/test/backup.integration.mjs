/**
 * The scheduled JSON backup, end to end (issue #75).
 *
 * `shared/test/backup.test.js` proves the schedule/retention math with no
 * storage at all. What that suite cannot see is the half that only exists
 * once wired to a real filesystem, a real database and the real tick:
 *
 *   1. the scheduled file's parsed payload deep-equals what `GET /api/export`
 *      produces, `exported_at` aside — it is NOT byte-for-byte (the route
 *      sends compact JSON, the file is written two-space indented, and the
 *      timestamps differ by construction), but both come from the one code
 *      path `buildBackupPayload` exists for;
 *   2. the dedupe survives a real day's worth of ticks without rewriting;
 *   3. retention only ever deletes files this module wrote;
 *   4. a failure (an unwritable directory) is reported, never fatal, and a
 *      repair recovers on the next local day — the case that would otherwise
 *      fail every night in a log nobody reads;
 *   5. the status route never discloses the directory the operator chose;
 *   6. the feature stays off until `HABITERALL_BACKUP_DIR` is set;
 *   7. a successful run leaves no `.tmp` behind;
 *   8. `HABITERALL_NOTIFY=off` must not silently take the backup down with
 *      it — the coupling defect `notifier.js`'s `start()` exists to prevent;
 *   9. ...and the reverse must hold too: `HABITERALL_NOTIFY=off` must keep the
 *      Discord GATEWAY shut even with a bot token configured, because the
 *      backup hook joins only the tick and never the reminders' receive half.
 *
 * Phase two adds `HABITERALL_BACKUP_FORMAT` ('json' | 'db' | 'both') and a
 * `VACUUM INTO` `.db` snapshot beside the JSON export. Cases F1-F7, inserted
 * before case 8 below, cover: a `db`-only run, a `both` run (and that its
 * `.json` half is unchanged), that the `.db` snapshot carries an UNPORTABLE
 * setting the JSON export withholds, that retention is per family, that
 * switching format away from `both` still prunes the orphaned family, that an
 * unparseable format value falls back to `json` and warns, and that a
 * `VACUUM INTO` failure is reported rather than fatal. Each explicitly sets
 * `HABITERALL_BACKUP_FORMAT` for its own case and the block restores it to
 * unset before case 8, so the format-default assumption every case from 8
 * onward was written against still holds.
 *
 * Every case drives `backupTask`/`runBackup` with a CHOSEN instant rather
 * than waiting on the wall clock — the exceptions are cases 8 and 8b, which
 * have to go through the real `start()` to prove the wiring, and use a
 * schedule of '00:00' so each is due at whatever real time the suite happens
 * to run.
 *
 *   node test/backup.integration.mjs
 */

import {
  mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-backup-'));
// Exactly the notify.integration.mjs idiom: both set before the first import,
// since HABITERALL_DB is read by db.js at module load. The feature starts
// OFF (decision 3) — every case below sets HABITERALL_BACKUP_DIR itself.
process.env.HABITERALL_AUTH = 'off';
process.env.HABITERALL_RATE_LIMIT = 'off';
process.env.HABITERALL_DB = join(workdir, 'backup.db');
process.env.HABITERALL_BACKUP_DIR = '';

const { app } = await import('../src/server.js');
const { buildBackupPayload } = await import('../src/api.js');
const { backupTask } = await import('../src/backup.js');
const { start: startNotifier } = await import('../src/notifier.js');
const { zonedClock } = await import('@habiterall/shared/notify.js');
const { backupFileName, BACKUP_FILE_RE } = await import('@habiterall/shared/backup.js');

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

const api = async (path, init = {}) => {
  const res = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json' }, ...init,
  });
  const body = res.status === 204 ? null : await res.json();
  return { status: res.status, body };
};

/** `createLogger`'s write is resolved at emit time, so patching stdout during
 * the call is enough to read what it said — the same trick notify.integration
 * uses for the watermark-prune-failure case. */
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

/** Wait for the app, never for a duration — poll a predicate, throw naming it. */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25, what = 'condition' } = {}) {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const offsetDate = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// `backup_status` is ONE row for the whole account (decision 8, root
// CLAUDE.md) — not one per directory — so every case in this file shares a
// single dedupe key. Two cases that ticked on the same local DATE would have
// the second one silently do nothing, which is indistinguishable from the
// bug this suite exists to catch. Each case below (bar 6, which never ticks,
// and 8, which is pinned to the real wall clock to prove the live wiring)
// gets its own day from a synthetic, far-future calendar via this counter —
// constructed with the LOCAL-time `Date` constructor so it is self-consistent
// with `zonedClock(instant, '')` regardless of the runner's own time zone,
// and far enough from any real "today" that case 8's real-clock tick can
// never collide with one of these.
let syntheticDay = 1;
const nextInstant = (hour = 3, minute = 7) => new Date(2031, 0, syntheticDay++, hour, minute);

try {
  /* ---------- fixtures, every value off its default on purpose ---------- */

  const cat1 = await api('/api/categories', {
    method: 'POST', body: JSON.stringify({ name: 'Health', color: '#3b82f6' }),
  });
  ck('a first category is created', cat1.status === 201, JSON.stringify(cat1.body));
  // Position is assigned by insertion order (MAX(position) + 1), never chosen
  // by the caller — a SECOND category is what makes its position non-default.
  const cat2 = await api('/api/categories', {
    method: 'POST', body: JSON.stringify({ name: 'Chores', color: '#22c55e' }),
  });
  ck('a second category lands at a non-default position',
    cat2.status === 201 && cat2.body.position === 1, JSON.stringify(cat2.body));

  const habit = await api('/api/habits', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Water',
      type: 'numerical',            // default is 'boolean'
      target_type: 'at_most',       // default is 'at_least'
      target_value: 5,              // default is 0
      reminder_message: 'How many glasses?',   // default is ''
      category_id: cat2.body.id,
    }),
  });
  ck('the fixture habit is created off every relevant default',
    habit.status === 201 &&
    habit.body.type === 'numerical' && habit.body.target_type === 'at_most' &&
    habit.body.target_value === 5 && habit.body.reminder_message === 'How many glasses?',
    JSON.stringify(habit.body));
  const habitId = habit.body.id;

  // A stated lapse (status: 'skip') and a stated "no" (value: 0) — the two day
  // states a naive `entryMap.get(date) ?? UNSET` collapses into "unknown".
  // Fixed, far-past dates: entries in the future are refused, and these need
  // never depend on when the suite is run.
  const skipEntry = await api(`/api/habits/${habitId}/entries/2020-01-05`, {
    method: 'PUT', body: JSON.stringify({ status: 'skip' }),
  });
  ck('a skip entry is seeded', skipEntry.status === 200, JSON.stringify(skipEntry.body));
  const lapseEntry = await api(`/api/habits/${habitId}/entries/2020-01-06`, {
    method: 'PUT', body: JSON.stringify({ value: 0 }),
  });
  ck('a stated-lapse entry (value: 0) is seeded', lapseEntry.status === 200, JSON.stringify(lapseEntry.body));

  // A PORTABLE setting (default false), seeded now so the `settings` table is
  // non-empty for every case from here on, including case F1's ".db snapshot
  // has a settings row" — case F3, later, seeds an UNPORTABLE one on top of
  // this and asserts a sharper distinction (present in the .db, absent from
  // the .json).
  const skipDaysSeed = await api('/api/settings', {
    method: 'PUT', body: JSON.stringify({ skipDays: true }),
  });
  ck('a portable setting (skipDays) is seeded off its default',
    skipDaysSeed.status === 200 && skipDaysSeed.body.settings?.skipDays === true,
    JSON.stringify(skipDaysSeed.body));

  /* ---------- case 1: the scheduled file is what the button produces ---------- */

  const dir1 = join(workdir, 'case1');
  const instant1 = nextInstant();
  // The schedule is set to exactly the minute the tick's own instant carries
  // — the same "at the current server minute, exactly at the boundary"
  // property the brief asks for, just against a synthetic instant rather
  // than the real wall clock (see the note above `nextInstant`).
  const { date: today1, time: nowHHMM1 } = zonedClock(instant1, '');
  process.env.HABITERALL_BACKUP_DIR = dir1;
  process.env.HABITERALL_BACKUP_SCHEDULE = nowHHMM1;
  process.env.HABITERALL_BACKUP_KEEP = '7';

  const task1 = backupTask(process.env, { payload: buildBackupPayload });
  ck('backupTask is armed once a directory is configured', task1 !== null);
  await task1(instant1);

  const files1 = readdirSync(dir1);
  ck('exactly one file appears after the tick', files1.length === 1, JSON.stringify(files1));
  ck('it is named for today', files1[0] === backupFileName(today1), files1[0]);

  const written1 = JSON.parse(readFileSync(join(dir1, files1[0]), 'utf8'));
  const viaButton1 = (await api('/api/export')).body;
  delete written1.exported_at;
  delete viaButton1.exported_at;
  try {
    assert.deepStrictEqual(written1, viaButton1);
    ck('the scheduled file is exactly what GET /api/export produces (exported_at aside)', true);
  } catch (err) {
    ck('the scheduled file is exactly what GET /api/export produces (exported_at aside)', false, err.message);
  }

  /* ---------- case 2: dedupe ---------- */

  const dir2 = join(workdir, 'case2');
  process.env.HABITERALL_BACKUP_DIR = dir2;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';   // due at any time of day
  process.env.HABITERALL_BACKUP_KEEP = '7';

  const task2 = backupTask(process.env, { payload: buildBackupPayload });
  const instant2 = nextInstant();
  await task2(instant2);
  const files2a = readdirSync(dir2);
  ck('one file after the first tick', files2a.length === 1, JSON.stringify(files2a));
  const path2 = join(dir2, files2a[0]);
  const mtimeAfterFirst = statSync(path2).mtimeMs;

  await task2(instant2);   // the same instant — the same local day
  const files2b = readdirSync(dir2);
  ck('still exactly one file after a second tick the same day', files2b.length === 1, JSON.stringify(files2b));
  ck('the file was not rewritten the second time (mtime unchanged)',
    statSync(path2).mtimeMs === mtimeAfterFirst,
    `${mtimeAfterFirst} -> ${statSync(path2).mtimeMs}`);

  const { date: today2 } = zonedClock(instant2, '');
  const status2 = (await api('/api/backup/status')).body;
  ck("GET /api/backup/status reports today's date as the last run",
    status2.last?.date === today2, JSON.stringify(status2));

  /* ---------- case 3: retention ---------- */

  const dir3 = join(workdir, 'case3');
  mkdirSync(dir3, { recursive: true });
  const instant3 = nextInstant();
  const { date: today3 } = zonedClock(instant3, '');
  const olderDates3 = [-5, -4, -3, -2, -1].map((n) => offsetDate(today3, n));
  for (const d of olderDates3) writeFileSync(join(dir3, backupFileName(d)), '{}');
  writeFileSync(join(dir3, 'keep-me.txt'), 'not a backup');
  const staleTmp3 = `${backupFileName(offsetDate(today3, -6))}.tmp`;
  writeFileSync(join(dir3, staleTmp3), 'a partial write from a previous, interrupted run');

  process.env.HABITERALL_BACKUP_DIR = dir3;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '2';

  const task3 = backupTask(process.env, { payload: buildBackupPayload });
  const { lines: lines3 } = await captureLogs(() => task3(instant3));

  const files3 = new Set(readdirSync(dir3));
  const expected3 = new Set([
    backupFileName(today3),           // the file this run just wrote
    backupFileName(olderDates3[4]),   // the newest one older than it (yesterday)
    'keep-me.txt',
    staleTmp3,
  ]);
  ck('retention keeps exactly the newest KEEP dated files, and leaves foreign files alone',
    files3.size === expected3.size && [...files3].every((f) => expected3.has(f)),
    JSON.stringify([...files3]));
  ck('the deletion is logged, naming the count',
    lines3.some((l) => l.includes('"msg":"backup.pruned"') && l.includes('"count":4')),
    lines3.join('').slice(0, 800));
  // scalar() (shared/src/log.js) collapses any array to `[N items]`, so
  // `files: pruned` alone never puts a single name in the emitted line — this
  // is the assertion that keeps `files: pruned.join(', ')` from regressing.
  ck('the deletion names at least one of the actual pruned filenames',
    lines3.some((l) => l.includes('"msg":"backup.pruned"') &&
      olderDates3.slice(0, 4).some((d) => l.includes(backupFileName(d)))),
    lines3.join('').slice(0, 800));

  /* ---------- case 4: the failure path ---------- */

  const dir4base = join(workdir, 'case4');
  mkdirSync(dir4base, { recursive: true });
  const blocker4 = join(dir4base, 'blocker');
  writeFileSync(blocker4, 'a regular file standing where a directory is expected');
  const badDir4 = join(blocker4, 'sub');

  process.env.HABITERALL_BACKUP_DIR = badDir4;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '7';

  const task4 = backupTask(process.env, { payload: buildBackupPayload });
  const instant4 = nextInstant();
  let threw4 = null;
  let lines4 = [];
  try {
    const captured = await captureLogs(() => task4(instant4));
    lines4 = captured.lines;
  } catch (err) {
    threw4 = err;
  }
  ck('a tick against a directory that cannot be created does not throw', threw4 === null,
    threw4 ? String(threw4?.stack ?? threw4) : '');

  const stillServing4 = await api('/api/habits');
  ck('the process is still serving after the failure', stillServing4.status === 200,
    JSON.stringify(stillServing4).slice(0, 200));

  const status4 = (await api('/api/backup/status')).body;
  ck("the status route reports the failed run with a non-empty error",
    status4.last?.state === 'error' && typeof status4.last?.error === 'string' && status4.last.error.length > 0,
    JSON.stringify(status4));
  ck('the failure was logged at error',
    lines4.some((l) => l.includes('"level":"error"') && l.includes('backup')),
    lines4.join('').slice(0, 800));

  // The status route's error must be a CLASSIFICATION, never the raw fs error
  // message — which embeds this very directory (`ENOTDIR: not a directory,
  // mkdir '<badDir4>'`). Assert both halves: the path is nowhere in the
  // response, and the classification still names the code.
  const status4Text = JSON.stringify(status4);
  ck('the status response discloses none of the backup directory path',
    !status4Text.includes(badDir4) && !status4Text.includes(blocker4) &&
    !status4Text.includes(workdir) && !status4Text.includes('blocker'),
    status4Text);
  ck("the reported error names the code (ENOTDIR) rather than the raw message",
    status4.last.error.includes('ENOTDIR'), status4Text);

  // Repair the directory and tick again on the NEXT local date — a failure
  // must not permanently disable the feature.
  const goodDir4 = join(dir4base, 'repaired');
  process.env.HABITERALL_BACKUP_DIR = goodDir4;
  const task4b = backupTask(process.env, { payload: buildBackupPayload });
  // The next entry off `nextInstant`'s counter, which is the next synthetic
  // calendar day — the "next local date" the case needs, without depending on
  // adding 24h to a `Date` landing on the calendar day it looks like it
  // should (a DST transition can move that).
  const instant4b = nextInstant();
  await task4b(instant4b);
  const status4b = (await api('/api/backup/status')).body;
  ck('a repaired directory recovers on the next local date',
    status4b.last?.state === 'ok', JSON.stringify(status4b));

  /* ---------- case 5: no path disclosure ---------- */

  const dir5 = join(workdir, 'nested', 'deep', 'case5');
  process.env.HABITERALL_BACKUP_DIR = dir5;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '7';
  const task5 = backupTask(process.env, { payload: buildBackupPayload });
  await task5(nextInstant());

  const status5 = (await api('/api/backup/status')).body;
  const status5Text = JSON.stringify(status5);
  ck('the directory path never appears in the response',
    !status5Text.includes(dir5) && !status5Text.includes(workdir), status5Text);
  ck("last.file has no '/' in it — a basename only",
    typeof status5.last?.file === 'string' && status5.last.file.length > 0 &&
    !status5.last.file.includes('/'), status5Text);

  /* ---------- case 6: disabled ---------- */

  process.env.HABITERALL_BACKUP_DIR = '';
  const task6 = backupTask(process.env, { payload: buildBackupPayload });
  ck('backupTask() returns null when HABITERALL_BACKUP_DIR is unset', task6 === null);

  const status6 = (await api('/api/backup/status')).body;
  ck('the status route reports the feature disabled',
    status6.enabled === false && status6.schedule === null && status6.keep === null,
    JSON.stringify(status6));

  /* ---------- case 7: no partial left behind ---------- */

  const dir7 = join(workdir, 'case7');
  process.env.HABITERALL_BACKUP_DIR = dir7;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '7';
  const task7 = backupTask(process.env, { payload: buildBackupPayload });
  await task7(nextInstant());
  const files7 = readdirSync(dir7);
  ck('no .tmp file remains after a successful run',
    !files7.some((f) => f.endsWith('.tmp')), JSON.stringify(files7));

  /* ---------- case F1: format: 'db' writes one file, no .json ---------- */

  const dirF1 = join(workdir, 'caseF1');
  process.env.HABITERALL_BACKUP_DIR = dirF1;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '7';
  process.env.HABITERALL_BACKUP_FORMAT = 'db';

  const taskF1 = backupTask(process.env, { payload: buildBackupPayload });
  const instantF1 = nextInstant();
  const { date: todayF1 } = zonedClock(instantF1, '');
  await taskF1(instantF1);

  const filesF1 = readdirSync(dirF1);
  ck('format: db writes exactly one file', filesF1.length === 1, JSON.stringify(filesF1));
  ck("it is today's .db file, not a .json one",
    filesF1[0] === backupFileName(todayF1, 'db'), filesF1[0]);
  ck('no .tmp remains after a successful db-only run',
    !filesF1.some((f) => f.endsWith('.tmp')), JSON.stringify(filesF1));
  // The status row must agree the run was clean. Without this, a mutation
  // that has `VACUUM INTO` write straight at the FINAL name (bypassing the
  // tmp-then-rename step) still leaves exactly one correctly-named .db file
  // on disk — the file-listing checks above alone cannot tell that apart
  // from a genuinely atomic write — but the unconditional `renameSync`
  // afterward then fails (its `.tmp` source never existed), so the run is
  // recorded as `'error'` even though a complete file sits at the name a
  // restore would trust. This is the assertion that catches it.
  const statusF1 = (await api('/api/backup/status')).body;
  ck('the status row reports the db-only run as ok, not error',
    statusF1.last?.state === 'ok' && statusF1.last?.error === '', JSON.stringify(statusF1));

  const snapshotF1 = new DatabaseSync(join(dirF1, filesF1[0]), { readOnly: true });
  try {
    const habitNamesF1 = /** @type {any[]} */ (snapshotF1.prepare('SELECT name FROM habits').all())
      .map((r) => r.name);
    ck('the fixture habit is in the .db snapshot, by name',
      habitNamesF1.includes('Water'), JSON.stringify(habitNamesF1));
    const settingsCountF1 = /** @type {any} */ (
      snapshotF1.prepare('SELECT COUNT(*) AS c FROM settings').get()).c;
    ck('the .db snapshot has a settings row', settingsCountF1 > 0, String(settingsCountF1));
    const categoriesCountF1 = /** @type {any} */ (
      snapshotF1.prepare('SELECT COUNT(*) AS c FROM categories').get()).c;
    ck('the .db snapshot has a categories row', categoriesCountF1 > 0, String(categoriesCountF1));
  } finally {
    snapshotF1.close();
  }

  /* ---------- case F2: format: 'both' writes both, .json half unchanged ---------- */

  const dirF2 = join(workdir, 'caseF2');
  process.env.HABITERALL_BACKUP_DIR = dirF2;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '7';
  process.env.HABITERALL_BACKUP_FORMAT = 'both';

  const taskF2 = backupTask(process.env, { payload: buildBackupPayload });
  const instantF2 = nextInstant();
  const { date: todayF2 } = zonedClock(instantF2, '');
  await taskF2(instantF2);

  const jsonNameF2 = backupFileName(todayF2, 'json');
  const dbNameF2 = backupFileName(todayF2, 'db');
  const filesF2 = readdirSync(dirF2);
  ck('format: both writes exactly two files', filesF2.length === 2, JSON.stringify(filesF2));
  ck('both are dated today, one of each family',
    new Set(filesF2).has(jsonNameF2) && new Set(filesF2).has(dbNameF2), JSON.stringify(filesF2));

  const writtenJsonF2 = JSON.parse(readFileSync(join(dirF2, jsonNameF2), 'utf8'));
  const viaButtonF2 = (await api('/api/export')).body;
  delete writtenJsonF2.exported_at;
  delete viaButtonF2.exported_at;
  try {
    assert.deepStrictEqual(writtenJsonF2, viaButtonF2);
    ck("the .json half of a 'both' run still deepEquals GET /api/export", true);
  } catch (err) {
    ck("the .json half of a 'both' run still deepEquals GET /api/export", false, err.message);
  }

  const statusF2 = (await api('/api/backup/status')).body;
  ck('status.file names both files (json, then db — the write order)',
    statusF2.last?.file === `${jsonNameF2}, ${dbNameF2}`, JSON.stringify(statusF2));
  const realBytesF2 = statSync(join(dirF2, jsonNameF2)).size + statSync(join(dirF2, dbNameF2)).size;
  ck("status.bytes is the sum of both files' real sizes on disk (statSync), not a re-derivation",
    statusF2.last?.bytes === realBytesF2, JSON.stringify(statusF2));

  /* ---------- case F2b: except protects EVERY file this run wrote, not just the first --- */
  //
  // Ordinarily today's own file is the NEWEST in its family, so the date-sort
  // cut alone would never select it and `except` never has to do any real
  // work — which is why F2 above cannot catch `except` degrading to "only the
  // first name". This plants a genuinely NEWER file in the .db family before
  // the tick (as a clock skew, or a file dropped in by hand, could) so `keep`
  // ranks TODAY's own .db file among the ones the arithmetic alone would
  // prune, and only `except` protecting the SECOND file this 'both' run wrote
  // (the .db one, after the .json one) can save it.

  const dirF2b = join(workdir, 'caseF2b');
  mkdirSync(dirF2b, { recursive: true });
  const instantF2b = nextInstant();
  const { date: todayF2b } = zonedClock(instantF2b, '');
  const futureDateF2b = offsetDate(todayF2b, 5);
  writeFileSync(join(dirF2b, backupFileName(futureDateF2b, 'db')), 'a coincidentally newer .db file');

  process.env.HABITERALL_BACKUP_DIR = dirF2b;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '1';   // ranks today's .db as the one to prune, absent `except`
  process.env.HABITERALL_BACKUP_FORMAT = 'both';

  const taskF2b = backupTask(process.env, { payload: buildBackupPayload });
  await taskF2b(instantF2b);

  const filesF2b = new Set(readdirSync(dirF2b));
  const expectedF2b = new Set([
    backupFileName(todayF2b, 'json'), backupFileName(todayF2b, 'db'),
    backupFileName(futureDateF2b, 'db'),
  ]);
  ck("except protects the SECOND file a 'both' run wrote (.db), not only the first (.json)",
    filesF2b.size === expectedF2b.size && [...filesF2b].every((f) => expectedF2b.has(f)),
    JSON.stringify([...filesF2b]));

  /* ---------- case F3: the .db snapshot carries what the JSON export withholds --- */

  const discordWebhookF3 = 'https://discord.com/api/webhooks/123456789012345678/a-secret-token';
  const putSettingsF3 = await api('/api/settings', {
    method: 'PUT', body: JSON.stringify({ discordWebhook: discordWebhookF3 }),
  });
  ck('an UNPORTABLE setting is set through the API',
    putSettingsF3.status === 200 && putSettingsF3.body.settings?.discordWebhook === discordWebhookF3,
    JSON.stringify(putSettingsF3.body));

  const dirF3 = join(workdir, 'caseF3');
  process.env.HABITERALL_BACKUP_DIR = dirF3;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '7';
  process.env.HABITERALL_BACKUP_FORMAT = 'both';

  const taskF3 = backupTask(process.env, { payload: buildBackupPayload });
  const instantF3 = nextInstant();
  const { date: todayF3 } = zonedClock(instantF3, '');
  await taskF3(instantF3);

  const jsonNameF3 = backupFileName(todayF3, 'json');
  const dbNameF3 = backupFileName(todayF3, 'db');
  const writtenJsonTextF3 = readFileSync(join(dirF3, jsonNameF3), 'utf8');
  ck('the unportable setting is nowhere in the .json file — the JSON export withholds it',
    !writtenJsonTextF3.includes(discordWebhookF3), writtenJsonTextF3.slice(0, 400));

  const snapshotF3 = new DatabaseSync(join(dirF3, dbNameF3), { readOnly: true });
  try {
    const rowF3 = /** @type {any} */ (
      snapshotF3.prepare('SELECT value FROM settings WHERE key = ?').get('discordWebhook'));
    ck("the unportable setting IS in the .db snapshot's settings table — the whole reason the format exists",
      rowF3 !== undefined && String(rowF3.value).includes(discordWebhookF3), JSON.stringify(rowF3));
  } finally {
    snapshotF3.close();
  }

  /* ---------- case F4: retention is per family ---------- */

  const dirF4 = join(workdir, 'caseF4');
  mkdirSync(dirF4, { recursive: true });
  const instantF4 = nextInstant();
  const { date: todayF4 } = zonedClock(instantF4, '');
  const olderDatesF4 = [-5, -4, -3, -2, -1].map((n) => offsetDate(todayF4, n));
  for (const d of olderDatesF4) {
    writeFileSync(join(dirF4, backupFileName(d, 'json')), '{}');
    writeFileSync(join(dirF4, backupFileName(d, 'db')), 'not a real sqlite file, but retention never opens it');
  }
  writeFileSync(join(dirF4, 'keep-me.txt'), 'not a backup');
  writeFileSync(join(dirF4, 'habiterall.db'), 'the live database file — must never be touched');
  writeFileSync(join(dirF4, 'habiterall.db-wal'), 'its WAL sidecar — must never be touched');
  const staleDbTmpF4 = `${backupFileName(offsetDate(todayF4, -6), 'db')}.tmp`;
  writeFileSync(join(dirF4, staleDbTmpF4), 'a stale .db.tmp from an unrelated, older crashed run');

  process.env.HABITERALL_BACKUP_DIR = dirF4;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '2';
  process.env.HABITERALL_BACKUP_FORMAT = 'both';

  const taskF4 = backupTask(process.env, { payload: buildBackupPayload });
  await taskF4(instantF4);

  const filesF4 = new Set(readdirSync(dirF4));
  const expectedF4 = new Set([
    backupFileName(todayF4, 'json'), backupFileName(todayF4, 'db'),
    backupFileName(olderDatesF4[4], 'json'), backupFileName(olderDatesF4[4], 'db'),
    'keep-me.txt', 'habiterall.db', 'habiterall.db-wal', staleDbTmpF4,
  ]);
  ck('retention keeps exactly the newest KEEP of EACH family, and every foreign file untouched',
    filesF4.size === expectedF4.size && [...filesF4].every((f) => expectedF4.has(f)),
    JSON.stringify([...filesF4]));

  /* ---------- case F5: switching format does not orphan the other family ---------- */

  const dirF5 = join(workdir, 'caseF5');
  mkdirSync(dirF5, { recursive: true });
  const instantF5 = nextInstant();
  const { date: todayF5 } = zonedClock(instantF5, '');
  // Five .db files "left over from a previous `both` era" — nothing here
  // ever writes a .json one, which is the point: this run's format is 'json'
  // only, and the .db family must still be managed.
  const olderDatesF5 = [-5, -4, -3, -2, -1].map((n) => offsetDate(todayF5, n));
  for (const d of olderDatesF5) {
    writeFileSync(join(dirF5, backupFileName(d, 'db')), 'a leftover .db snapshot from a "both" era');
  }

  process.env.HABITERALL_BACKUP_DIR = dirF5;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '2';
  process.env.HABITERALL_BACKUP_FORMAT = 'json';

  const taskF5 = backupTask(process.env, { payload: buildBackupPayload });
  await taskF5(instantF5);

  const filesF5 = readdirSync(dirF5);
  const remainingDbF5 = new Set(filesF5.filter((f) => f.endsWith('.db')));
  ck("switching to format: 'json' still prunes the orphaned .db family down to keep",
    remainingDbF5.size === 2 &&
    remainingDbF5.has(backupFileName(olderDatesF5[4], 'db')) &&
    remainingDbF5.has(backupFileName(olderDatesF5[3], 'db')),
    JSON.stringify(filesF5));
  ck("and the .json file for today was still written",
    filesF5.includes(backupFileName(todayF5, 'json')), JSON.stringify(filesF5));

  /* ---------- case F6: a bad format value falls back to json and warns ---------- */

  const dirF6 = join(workdir, 'caseF6');
  process.env.HABITERALL_BACKUP_DIR = dirF6;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '7';
  process.env.HABITERALL_BACKUP_FORMAT = 'sqlite';   // not one of json | db | both

  const { lines: linesF6 } = await captureLogs(async () => {
    const taskF6 = backupTask(process.env, { payload: buildBackupPayload });
    await taskF6(nextInstant());
  });

  const filesF6 = readdirSync(dirF6);
  ck("an unparseable format value falls back to writing a .json file",
    filesF6.length === 1 && filesF6[0].endsWith('.json'), JSON.stringify(filesF6));
  ck('backup.format_invalid was logged',
    linesF6.some((l) => l.includes('"msg":"backup.format_invalid"')), linesF6.join('').slice(0, 400));

  /* ---------- case F7: a VACUUM INTO failure is reported, not fatal ---------- */

  const dirF7base = join(workdir, 'caseF7');
  mkdirSync(dirF7base, { recursive: true });
  const blockerF7 = join(dirF7base, 'blocker');
  writeFileSync(blockerF7, 'a regular file standing where a directory is expected');
  const badDirF7 = join(blockerF7, 'sub');

  process.env.HABITERALL_BACKUP_DIR = badDirF7;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '7';
  process.env.HABITERALL_BACKUP_FORMAT = 'db';

  const taskF7 = backupTask(process.env, { payload: buildBackupPayload });
  const instantF7 = nextInstant();
  let threwF7 = null;
  let linesF7 = [];
  try {
    const captured = await captureLogs(() => taskF7(instantF7));
    linesF7 = captured.lines;
  } catch (err) {
    threwF7 = err;
  }
  ck("a format: 'db' tick against a directory that cannot be created does not throw", threwF7 === null,
    threwF7 ? String(threwF7?.stack ?? threwF7) : '');

  const stillServingF7 = await api('/api/habits');
  ck('the process is still serving after the db-format failure', stillServingF7.status === 200,
    JSON.stringify(stillServingF7).slice(0, 200));

  const statusF7 = (await api('/api/backup/status')).body;
  ck("the status route reports the failed db-format run with a non-empty error",
    statusF7.last?.state === 'error' && typeof statusF7.last?.error === 'string' &&
    statusF7.last.error.length > 0, JSON.stringify(statusF7));

  const statusF7Text = JSON.stringify(statusF7);
  ck('the status response discloses none of the backup directory path',
    !statusF7Text.includes(badDirF7) && !statusF7Text.includes(blockerF7) &&
    !statusF7Text.includes(workdir) && !statusF7Text.includes('blocker'),
    statusF7Text);
  ck('the db-format failure was logged at error',
    linesF7.some((l) => l.includes('"level":"error"') && l.includes('backup')),
    linesF7.join('').slice(0, 800));

  // Restore the format to unset before case 8 onward, which were written
  // against the (unset -> 'json') default and assert against `BACKUP_FILE_RE`
  // (the .json-only pattern) directly.
  delete process.env.HABITERALL_BACKUP_FORMAT;

  /* ---------- case 8: reminders off, backups still run ---------- */
  //
  // The coupling defect step 4b exists to prevent: a backup hung purely off
  // the notifier's tick would otherwise never run on an instance with
  // HABITERALL_NOTIFY=off. Driven over the REAL notifier.start(), not by
  // calling backupTask directly, because that wiring is exactly what is under
  // test — a source-text guard could not see a reverted branch, only running
  // it can. The schedule is '00:00' (always due) so this needs no coordination
  // with the real wall clock the live tick fires on.
  //
  // "No reminder was delivered" is asserted through the branch's own log line
  // (`notify.disabled_but_ticking`, which states in so many words that
  // `collect` has been replaced with one that returns nothing) rather than by
  // configuring a live destination and reminder time: doing that safely would
  // need a reminder_time matching the exact real-world minute the tick fires
  // on, which is the kind of clock-dependent flake the "wait for the app,
  // never for a duration" rule warns against. `shared/test/notify.test.js`
  // already proves `onTick`'s isolation from `collect` in the general case;
  // this is the wiring proof that this EDITION's `start()` reaches it.

  const dir8 = join(workdir, 'case8');
  process.env.HABITERALL_BACKUP_DIR = dir8;
  process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
  process.env.HABITERALL_BACKUP_KEEP = '7';
  process.env.HABITERALL_NOTIFY = 'off';
  process.env.HABITERALL_NOTIFY_INTERVAL_MS = '1000';   // the floor notifierConfig enforces

  const backupHook8 = backupTask(process.env, { payload: buildBackupPayload });
  ck('the backup task is armed for this case', backupHook8 !== null);

  let liveNotifier8 = null;
  try {
    const { lines: startLines8, result } = await captureLogs(() =>
      startNotifier(process.env, backupHook8 ? { onTick: backupHook8 } : {})
    );
    liveNotifier8 = result;
    ck("start() does not return null with reminders off but a backup hook present",
      liveNotifier8 !== null, startLines8.join(''));
    ck('and says so: reminders are off but the tick keeps running for the scheduled job',
      startLines8.some((l) => l.includes('"msg":"notify.disabled_but_ticking"')), startLines8.join(''));

    await waitFor(() => {
      try { return readdirSync(dir8).some((name) => BACKUP_FILE_RE.test(name)); }
      catch { return false; }
    }, { what: 'a backup file to appear under HABITERALL_NOTIFY=off' });
    ck('a backup file is written even with reminders off', true);
  } finally {
    liveNotifier8?.stop();
  }

  /* ---------- case 8b: HABITERALL_NOTIFY=off must keep the Discord gateway shut ---------- */
  //
  // The backup hook joins the TICK only; the gateway is the reminders'
  // RECEIVE half and must stay shut with them, even when a bot token is
  // configured — otherwise an operator who only set HABITERALL_BACKUP_DIR
  // (with a stray DISCORD_BOT_TOKEN left set from before reminders were
  // turned off) gets the bot back online, socket open, and a stale
  // Yes/No/Skip button left in a channel able to write an entry again.
  // `connectGateway`'s `open()` calls `new WebSocketImpl(url)` synchronously
  // with `WebSocketImpl` defaulting to `globalThis.WebSocket`
  // (`shared/src/discord-gateway.js`), so a fake class recording its own
  // construction is enough to prove no socket opened without an ounce of
  // real network. Driven over the real `start()`, the same reason case 8
  // is: only running the wiring can see a reverted `config.enabled &&`.

  class FakeWebSocket8b {
    constructor(url) { FakeWebSocket8b.constructed.push(url); }
    close() {}
    send() {}
  }
  FakeWebSocket8b.constructed = [];

  const realWebSocket8b = globalThis.WebSocket;
  // Deleted in the `finally` below, before case 9 spawns a child with
  // `{...process.env, ...}` — a leaked token would otherwise travel into it.
  process.env.DISCORD_BOT_TOKEN = 'fake-token-for-case-8b';
  globalThis.WebSocket = /** @type {any} */ (FakeWebSocket8b);

  let liveNotifier8b = null;
  try {
    const dir8b = join(workdir, 'case8b');
    process.env.HABITERALL_BACKUP_DIR = dir8b;
    process.env.HABITERALL_BACKUP_SCHEDULE = '00:00';
    process.env.HABITERALL_BACKUP_KEEP = '7';
    process.env.HABITERALL_NOTIFY = 'off';
    process.env.HABITERALL_NOTIFY_INTERVAL_MS = '1000';

    // `backup_status` is the ONE shared row (see the note above `syntheticDay`),
    // and case 8 has already claimed today's real wall-clock date — so a
    // second real-clock case waiting for a FILE would wait on a run
    // `dueBackup` correctly refuses to repeat the same local day, and time
    // out for a reason that has nothing to do with what this case tests. What
    // is under test here is only that the wrapped hook FIRES on the tick —
    // `startNotifier` calls `onTick` every interval regardless of what
    // `dueBackup` decides inside it — so the hook itself is wrapped to count
    // its own invocations rather than relying on a file landing on disk.
    let ticks8b = 0;
    const backupHookReal8b = backupTask(process.env, { payload: buildBackupPayload });
    const backupHook8b = backupHookReal8b
      ? async (instant) => { ticks8b++; await backupHookReal8b(instant); }
      : null;
    liveNotifier8b = startNotifier(process.env, backupHook8b ? { onTick: backupHook8b } : {});

    await waitFor(() => ticks8b > 0,
      { what: 'the tick to fire at least once in case 8b, proving the tick still ran' });

    ck('HABITERALL_NOTIFY=off keeps the Discord gateway shut even with a bot token configured',
      FakeWebSocket8b.constructed.length === 0, JSON.stringify(FakeWebSocket8b.constructed));
  } finally {
    liveNotifier8b?.stop();
    globalThis.WebSocket = realWebSocket8b;
    delete process.env.DISCORD_BOT_TOKEN;
  }

  /* ---------- case 9: the real entry point, spawned, wires the real hook ---------- */
  //
  // Every case above drives `backupTask`/`runBackup` (or, in case 8, the real
  // `notifier.js` `start()`) directly against an IMPORTED `server.js` — and
  // `server.js`'s own line that joins the two,
  //
  //   const notifier = startNotifier(process.env, backup ? { onTick: backup } : {});
  //
  // lives inside its `isEntryPoint` guard, which is false for every case above
  // (this whole file imports `server.js` as a module). A silent revert of that
  // line to `startNotifier(process.env, {})` drops the backup hook from the
  // actual deployed server while every case above — and `npm test`, and the
  // rest of this integration suite — stays green, because none of them ever
  // RUN the entry point. This case does, the way
  // `test/drain.integration.mjs` spawns the real server to prove wiring a unit
  // test cannot see: a child process, a real `HABITERALL_BACKUP_SCHEDULE=00:00`
  // so a run is always due, and a poll for a real file landing on a real disk
  // through the real tick.

  const workdir9 = mkdtempSync(join(tmpdir(), 'habiterall-backup-case9-'));
  const dir9 = join(workdir9, 'backups');
  const serverPath9 = fileURLToPath(new URL('../src/server.js', import.meta.url));
  // 3600-3620 only, per the brief this case was written from — a sibling
  // agent owns other ranges. Spread across it by pid so two runs of this
  // suite at once (this file's own worker plus a CI retry, say) do not
  // collide on one port.
  const port9 = 3600 + (process.pid % 21);
  const base9 = `http://127.0.0.1:${port9}`;

  let child9 = null;
  let exit9 = null;
  let logs9 = '';
  try {
    child9 = spawn(process.execPath, [serverPath9], {
      env: {
        ...process.env,
        PORT: String(port9),
        HABITERALL_DB: join(workdir9, 'case9.db'),
        HABITERALL_AUTH: 'off',
        HABITERALL_RATE_LIMIT: 'off',
        // Explicit rather than inherited from case 8's mutation of
        // `process.env` above, so this case does not depend on running after
        // it: this is the ordinary reminders-on shape, since the
        // reminders-off coupling is what case 8 already proves.
        HABITERALL_NOTIFY: 'on',
        HABITERALL_BACKUP_DIR: dir9,
        HABITERALL_BACKUP_SCHEDULE: '00:00',   // always due
        HABITERALL_BACKUP_KEEP: '7',
        // The floor `notifierConfig` enforces (see case 8 above) — `start()`
        // also runs its first tick synchronously, so this is a backstop for
        // the poll below rather than what the first backup depends on.
        HABITERALL_NOTIFY_INTERVAL_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child9.stdout.on('data', (d) => { logs9 += String(d); });
    child9.stderr.on('data', (d) => { logs9 += String(d); });
    child9.on('exit', (code, signal) => { exit9 = { code, signal }; });

    await waitFor(async () => {
      if (exit9) throw new Error(`case 9: the real server exited during boot :: ${logs9}`);
      try {
        const res = await fetch(`${base9}/healthz`);
        return res.ok;
      } catch { return false; }
    }, { timeoutMs: 10000, what: 'case 9: the real, spawned server to answer /healthz' });

    await waitFor(() => {
      try { return readdirSync(dir9).some((name) => BACKUP_FILE_RE.test(name)); }
      catch { return false; }
    }, {
      timeoutMs: 15000,
      what: "case 9: a backup file to appear through the REAL server's own wiring",
    });
    ck('case 9: the real spawned server writes a backup file through its own wiring', true);
  } finally {
    if (child9 && exit9 === null) {
      child9.kill('SIGTERM');
      await new Promise((resolve) => {
        const to = setTimeout(resolve, 5000);
        child9.once('exit', () => { clearTimeout(to); resolve(); });
      });
    }
    ck('case 9: the spawned server process has exited', exit9 !== null, JSON.stringify(exit9));
    rmSync(workdir9, { recursive: true, force: true });
  }

  console.log(`\n${fails ? `${fails} check(s) failed` : 'all checks passed'}`);
} finally {
  server.close();
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(fails ? 1 : 0);
