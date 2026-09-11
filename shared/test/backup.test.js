import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const {
  parseBackupSchedule, BACKUP_FILE_PREFIX, backupFileName, BACKUP_FILE_RE,
  BACKUP_DB_FILE_RE, BACKUP_SQL_FILE_RE, parseBackupFormat, dueBackup, prunableBackups,
} = await import('../src/backup.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Every literal below is asserted directly, never against a constant imported
// from the module under test — a test importing the constant it checks pins
// the name and nothing else, and could not tell a correct value from a
// silently-renamed one.

test('parseBackupSchedule: valid HH:MM values', () => {
  assert.equal(parseBackupSchedule('03:07'), 187);
  assert.equal(parseBackupSchedule('00:00'), 0);
  assert.equal(parseBackupSchedule('23:59'), 1439);
});

test('parseBackupSchedule: every invalid shape is null, not a throw', () => {
  for (const bad of ['24:00', '3:00', '0300', '', 'abc', undefined]) {
    assert.equal(parseBackupSchedule(bad), null, String(bad));
  }
});

test('backupFileName and BACKUP_FILE_PREFIX', () => {
  assert.equal(BACKUP_FILE_PREFIX, 'habiterall-backup-');
  assert.equal(backupFileName('2026-09-10'), 'habiterall-backup-2026-09-10.json');
});

test('BACKUP_FILE_RE matches only the exact generated shape', () => {
  assert.equal(BACKUP_FILE_RE.test('habiterall-backup-2026-09-10.json'), true);
  // Must NOT match a `.tmp` partial written while the export is in flight.
  assert.equal(BACKUP_FILE_RE.test('habiterall-backup-2026-09-10.json.tmp'), false);
  // Must NOT match an unrelated `.json` file that happens to share the dir.
  assert.equal(BACKUP_FILE_RE.test('backup.json'), false);
  assert.equal(BACKUP_FILE_RE.test('notes.json'), false);
  assert.equal(BACKUP_FILE_RE.test('habiterall-backup-2026-9-10.json'), false);
  assert.equal(BACKUP_FILE_RE.test('prefix-habiterall-backup-2026-09-10.json'), false);
});

// `scheduleMinutes: 187` throughout — deliberately NOT the 180 that `03:00`
// (the documented default) parses to, so a bug that silently falls back to
// the default schedule instead of using the parsed value cannot pass these.
// This is the ONLY case in the file where `minutes === scheduleMinutes`, and
// that makes it load-bearing beyond its own name: it is the sole guard on
// `>=` rather than `>` in `dueBackup`'s comparison. "restarted late catches up
// the day it missed" below uses `minutes: 1439` against `scheduleMinutes:
// 187`, where `1439 > 187` holds either way, so that case cannot tell `>=`
// from `>` — deleting this one as "redundant" with it would remove the only
// test that can.
test('dueBackup: exactly at the scheduled minute, first run of the day', () => {
  assert.equal(
    dueBackup({ date: '2026-09-10', minutes: 187, scheduleMinutes: 187, lastRunDate: '' }),
    true);
});

test('dueBackup: one minute early is not due', () => {
  assert.equal(
    dueBackup({ date: '2026-09-10', minutes: 186, scheduleMinutes: 187, lastRunDate: '' }),
    false);
});

test('dueBackup: already ran today — the dedupe', () => {
  assert.equal(
    dueBackup({
      date: '2026-09-10', minutes: 1439, scheduleMinutes: 187, lastRunDate: '2026-09-10',
    }),
    false);
});

// `minutes: 1439` against `scheduleMinutes: 187` means `1439 > 187` holds
// whether the comparison is `>` or `>=`, so this case CANNOT tell the two
// apart — it is not the boundary test. "exactly at the scheduled minute"
// above is the one that is, and this comment is here so the two are not
// mistaken for duplicates of each other.
test('dueBackup: restarted late catches up the day it missed', () => {
  assert.equal(
    dueBackup({
      date: '2026-09-10', minutes: 1439, scheduleMinutes: 187, lastRunDate: '2026-09-09',
    }),
    true);
});

test('dueBackup: new day, scheduled hour has not come yet', () => {
  assert.equal(
    dueBackup({
      date: '2026-09-10', minutes: 60, scheduleMinutes: 187, lastRunDate: '2026-09-09',
    }),
    false);
});

test('dueBackup: an unparseable schedule (null) is never due', () => {
  assert.equal(
    dueBackup({ date: '2026-09-10', minutes: 1439, scheduleMinutes: null, lastRunDate: '' }),
    false);
});

// `keep: 2` throughout, deliberately not the default of 7. Every call below
// now carries `kinds: ['json']` — phase two made `kinds` a required option,
// so these phase-one cases had to gain it; the assertions themselves are
// unchanged.
test('prunableBackups: five dated files, keep 2, returns the three oldest, oldest first', () => {
  // Deliberately unsorted input, to prove the function sorts rather than
  // trusting `readdirSync`'s (unspecified) order.
  const names = [
    'habiterall-backup-2026-09-03.json',
    'habiterall-backup-2026-09-01.json',
    'habiterall-backup-2026-09-05.json',
    'habiterall-backup-2026-09-02.json',
    'habiterall-backup-2026-09-04.json',
  ];
  assert.deepEqual(prunableBackups(names, 2, { kinds: ['json'] }), [
    'habiterall-backup-2026-09-01.json',
    'habiterall-backup-2026-09-02.json',
    'habiterall-backup-2026-09-03.json',
  ]);
});

test('prunableBackups: a directory holding files it did not write returns nothing', () => {
  // This is the assertion that matters most in the file: a retention policy
  // over files this module generated must never widen into a directory wipe.
  // Two foreign `.json` files (not one) are included on purpose: a widened
  // `BACKUP_FILE_RE` (e.g. `/\.json$/`) would then match 3 names against
  // `keep: 2`, which is what makes this fixture actually try to delete one of
  // them under that mutation rather than passing by the accident of matching
  // exactly `keep` many.
  const names = [
    'habiterall.db', 'habiterall.db-wal', 'notes.txt', 'backup.json', 'other.json',
    'habiterall-backup-2026-09-10.json.tmp', 'habiterall-backup-2026-09-01.json',
  ];
  assert.deepEqual(prunableBackups(names, 2, { kinds: ['json'] }), []);
});

test('prunableBackups: keep greater than the number of matching files returns nothing', () => {
  const names = ['habiterall-backup-2026-09-01.json', 'habiterall-backup-2026-09-02.json'];
  assert.deepEqual(prunableBackups(names, 5, { kinds: ['json'] }), []);
});

test('prunableBackups: keep equal to the file count, one file, all of it "except"', () => {
  // The boundary case the brief names directly: a single matching file, kept
  // exactly, and it also happens to be the run's own output — nothing is
  // prunable either way this is computed.
  const names = ['habiterall-backup-2026-09-10.json'];
  assert.deepEqual(
    prunableBackups(names, 1, { except: 'habiterall-backup-2026-09-10.json', kinds: ['json'] }),
    []);
});

test('prunableBackups: except is never returned even when the date arithmetic alone would pick it', () => {
  // `except` names the file THIS run just wrote, and the guarantee is that it
  // is never returned "even if the arithmetic says so" (the module's own
  // comment). An ordinary run's `except` is the newest file and so is already
  // safe by construction under date-sorted retention — this fixture makes the
  // guard load-bearing on purpose by naming `except` as one of the OLDEST
  // files, so only the explicit filter — and not the date-based cut — can be
  // what keeps it out of the result.
  const names = [
    'habiterall-backup-2026-09-01.json', // except — oldest by date, still protected
    'habiterall-backup-2026-09-05.json',
    'habiterall-backup-2026-09-10.json',
  ];
  assert.deepEqual(
    prunableBackups(names, 1, { except: 'habiterall-backup-2026-09-01.json', kinds: ['json'] }),
    ['habiterall-backup-2026-09-05.json']);
});

test('prunableBackups: an invalid keep (0) still never returns except', () => {
  // "Treat keep < 1 ... as a caller error the caller has already normalised
  // — but still never return except": with only the just-written file present
  // and keep 0 (nothing kept), the date-based arithmetic alone would delete
  // it; the guard is what stops that.
  const names = ['habiterall-backup-2026-09-10.json'];
  assert.deepEqual(
    prunableBackups(names, 0, { except: 'habiterall-backup-2026-09-10.json', kinds: ['json'] }),
    []);
});

/* ---------- phase two: the `.db` and `.sql` filename families ---------- */

test('parseBackupFormat: the three valid values', () => {
  assert.equal(parseBackupFormat('json'), 'json');
  assert.equal(parseBackupFormat('db'), 'db');
  assert.equal(parseBackupFormat('both'), 'both');
});

test('parseBackupFormat: case and surrounding space are tolerated', () => {
  assert.equal(parseBackupFormat(' BOTH '), 'both');
  assert.equal(parseBackupFormat('DB '), 'db');
});

test('parseBackupFormat: everything else is null, not a throw', () => {
  for (const bad of ['sqlite', 'json,db', 'jsondb', '', undefined, null, 3]) {
    assert.equal(parseBackupFormat(bad), null, String(bad));
  }
});

test('backupFileName: kind selects the extension, and the default still holds', () => {
  assert.equal(backupFileName('2026-09-11', 'db'), 'habiterall-backup-2026-09-11.db');
  assert.equal(backupFileName('2026-09-11', 'sql'), 'habiterall-backup-2026-09-11.sql');
  // No kind argument at all -> the phase-one `.json` default, unchanged.
  assert.equal(backupFileName('2026-09-11'), 'habiterall-backup-2026-09-11.json');
});

test('BACKUP_DB_FILE_RE refuses every other family and every .tmp', () => {
  assert.equal(BACKUP_DB_FILE_RE.test('habiterall-backup-2026-09-11.db'), true);
  assert.equal(BACKUP_DB_FILE_RE.test('habiterall-backup-2026-09-11.db.tmp'), false);
  assert.equal(BACKUP_DB_FILE_RE.test('habiterall-backup-2026-09-11.json'), false);
  assert.equal(BACKUP_DB_FILE_RE.test('habiterall.db'), false);
  assert.equal(BACKUP_DB_FILE_RE.test('habiterall.db-wal'), false);
  assert.equal(BACKUP_DB_FILE_RE.test('my-habiterall-backup-2026-09-11.db'), false);
});

test('BACKUP_SQL_FILE_RE refuses every other family and every .tmp', () => {
  assert.equal(BACKUP_SQL_FILE_RE.test('habiterall-backup-2026-09-11.sql'), true);
  assert.equal(BACKUP_SQL_FILE_RE.test('habiterall-backup-2026-09-11.sql.tmp'), false);
  assert.equal(BACKUP_SQL_FILE_RE.test('habiterall-backup-2026-09-11.db'), false);
  assert.equal(BACKUP_SQL_FILE_RE.test('habiterall-backup-2026-09-11.json'), false);
  assert.equal(BACKUP_SQL_FILE_RE.test('dump.sql'), false);
});

test('prunableBackups: two families, keep 2, a directory holding files neither writer generated', () => {
  // Five dated files per family (json, db), plus foreign files that must
  // survive untouched: a live `habiterall.db` and its `-wal` sidecar, a
  // stray `notes.txt`, an unrelated `backup.json`, cloud's own `dump.sql`,
  // and a `.tmp` partial for each family this module DOES generate.
  const names = [
    'habiterall-backup-2026-09-03.json', 'habiterall-backup-2026-09-01.json',
    'habiterall-backup-2026-09-05.json', 'habiterall-backup-2026-09-02.json',
    'habiterall-backup-2026-09-04.json',
    'habiterall-backup-2026-09-03.db', 'habiterall-backup-2026-09-01.db',
    'habiterall-backup-2026-09-05.db', 'habiterall-backup-2026-09-02.db',
    'habiterall-backup-2026-09-04.db',
    'habiterall.db', 'habiterall.db-wal', 'notes.txt', 'backup.json', 'dump.sql',
    'habiterall-backup-2026-09-10.json.tmp', 'habiterall-backup-2026-09-10.db.tmp',
  ];
  const foreign = ['habiterall.db', 'habiterall.db-wal', 'notes.txt', 'backup.json', 'dump.sql',
    'habiterall-backup-2026-09-10.json.tmp', 'habiterall-backup-2026-09-10.db.tmp'];
  assert.deepEqual(
    prunableBackups(names, 2, { kinds: ['json', 'db'] }),
    [
      'habiterall-backup-2026-09-01.json',
      'habiterall-backup-2026-09-02.json',
      'habiterall-backup-2026-09-03.json',
      'habiterall-backup-2026-09-01.db',
      'habiterall-backup-2026-09-02.db',
      'habiterall-backup-2026-09-03.db',
    ],
    `must return exactly the three oldest of each family, oldest first, and none of ` +
    `the foreign files: ${JSON.stringify(foreign)}`);
});

test('prunableBackups: a family not asked for is never touched, even when it is over the limit', () => {
  // The same directory as above, but `kinds: ['json']` only — the five `.db`
  // files are all over `keep: 2`, and none of them may come back.
  const names = [
    'habiterall-backup-2026-09-03.json', 'habiterall-backup-2026-09-01.json',
    'habiterall-backup-2026-09-05.json', 'habiterall-backup-2026-09-02.json',
    'habiterall-backup-2026-09-04.json',
    'habiterall-backup-2026-09-03.db', 'habiterall-backup-2026-09-01.db',
    'habiterall-backup-2026-09-05.db', 'habiterall-backup-2026-09-02.db',
    'habiterall-backup-2026-09-04.db',
  ];
  assert.deepEqual(
    prunableBackups(names, 2, { kinds: ['json'] }),
    [
      'habiterall-backup-2026-09-01.json',
      'habiterall-backup-2026-09-02.json',
      'habiterall-backup-2026-09-03.json',
    ]);
});

test('prunableBackups: kinds naming a family with no matching files returns nothing', () => {
  const names = [
    'habiterall-backup-2026-09-01.json', 'habiterall-backup-2026-09-02.json',
    'habiterall-backup-2026-09-01.db',
  ];
  assert.deepEqual(prunableBackups(names, 2, { kinds: ['sql'] }), []);
});

test('prunableBackups: except accepts an array, and protects an entry in each family', () => {
  // Both `except` entries are named among the files `keep`'s own arithmetic
  // would otherwise prune (the oldest of each family, not merely the newest,
  // which `keep` would protect on its own regardless of `except`) — the same
  // reasoning the single-family "except is never returned even when the date
  // arithmetic alone would pick it" case above uses, extended to the array
  // form and across two families. A mutation dropping the array handling and
  // honouring only a bare string would see `except` (the array itself) match
  // neither filename here, and both oldest files would wrongly come back.
  const names = [
    'habiterall-backup-2026-09-01.json', // except — oldest, still protected
    'habiterall-backup-2026-09-05.json',
    'habiterall-backup-2026-09-01.db',   // except — oldest, still protected
    'habiterall-backup-2026-09-05.db',
  ];
  assert.deepEqual(
    prunableBackups(names, 1, {
      kinds: ['json', 'db'],
      except: ['habiterall-backup-2026-09-01.json', 'habiterall-backup-2026-09-01.db'],
    }),
    []);
});

test('prunableBackups: kinds omitted entirely throws', () => {
  const names = ['habiterall-backup-2026-09-01.json'];
  assert.throws(
    () => prunableBackups(names, 2, {}),
    (err) => err instanceof TypeError && /kinds/.test(err.message));
});

test('prunableBackups: kinds as an empty array throws', () => {
  const names = ['habiterall-backup-2026-09-01.json'];
  assert.throws(
    () => prunableBackups(names, 2, { kinds: [] }),
    (err) => err instanceof TypeError && /kinds/.test(err.message));
});

test('prunableBackups: kinds as a bare string (not an array) throws', () => {
  const names = ['habiterall-backup-2026-09-01.json'];
  assert.throws(
    () => prunableBackups(names, 2, { kinds: /** @type {any} */ ('json') }),
    (err) => err instanceof TypeError && /kinds/.test(err.message));
});

test('prunableBackups: an unknown kind name throws and names the offender', () => {
  const names = ['habiterall-backup-2026-09-01.json'];
  assert.throws(
    () => prunableBackups(names, 2, { kinds: ['json', 'nope'] }),
    (err) => err instanceof TypeError && /nope/.test(err.message));
});

/* ---------- a source-text guard on the atomic write in the personal edition ----------
 *
 * `runBackup` (habiterall-personal/src/backup.js) writes `<name>.json.tmp` and
 * then `renameSync`s it onto the final name, on the claim that a reader can
 * never observe a truncated file. An interrupted write cannot be forced
 * in-process — there is no seam to suspend a process mid-syscall — so there is
 * no BEHAVIOURAL test available for the claim itself, and this reads source
 * text instead of proving the property.
 *
 * What a source-text guard cannot see: a renamed binding (a tmp path spelled
 * under a different name that this regex would not recognise as the tmp
 * path), or a reordering that keeps both call shapes present but changes
 * which one runs first or under what condition. It can only refuse the one
 * shape it was written to refuse: any `writeFileSync` aimed at something
 * other than the path a later `renameSync` moves onto the final name.
 * `habiterall-personal/test/backup.integration.mjs` case 7 ("no partial left
 * behind") is the BEHAVIOURAL test beside it — it drives a real run and
 * asserts no `.tmp` file survives, which is the thing this guard cannot
 * check at all.
 *
 * An empty match list means nothing until the denominator is known (root
 * CLAUDE.md), so the inventory this guard actually saw is printed, and a
 * guard that quietly matched zero call sites fails loudly rather than
 * passing.
 */
test('backup.js writes only through the tmp path, never straight onto the final one', () => {
  const src = readFileSync(join(root, 'habiterall-personal', 'src', 'backup.js'), 'utf8');

  const renameCalls = [...src.matchAll(/renameSync\(\s*(\w+)\s*,\s*(\w+)\s*\)/g)];
  const writeCalls = [...src.matchAll(/writeFileSync\(\s*(\w+)/g)];

  console.log('backup.js atomic-write guard inventory:', {
    renameSync: renameCalls.map((m) => m[0]),
    writeFileSync: writeCalls.map((m) => m[0]),
  });

  assert.ok(renameCalls.length > 0,
    'matched no renameSync(tmp, final) call in backup.js — the atomic rename is missing, ' +
    'or the guard is not seeing it');
  assert.ok(writeCalls.length > 0,
    'matched no writeFileSync( call in backup.js — an empty offender list means nothing ' +
    'until the denominator is known, and here it is zero: the guard is checking nothing');

  const [, tmpVar, finalVar] = renameCalls[0];
  for (const [call, arg] of writeCalls) {
    assert.notEqual(arg, finalVar,
      `${call} writes directly to the final path variable (${finalVar}) rather than the ` +
      `tmp path the rename later moves onto it`);
    assert.equal(arg, tmpVar,
      `${call} writes to ${arg}, not the tmp path (${tmpVar}) that ${renameCalls[0][0]} ` +
      'later renames onto the final path');
  }
});
