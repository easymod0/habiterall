/**
 * Backup round-trip fidelity, cloud edition.
 *
 * The same fixture and the same comparison rules as the personal edition's
 * suite, so the two cannot drift on what a faithful restore means. Runs
 * against the data layer rather than over HTTP, for the same reason
 * api.integration.mjs does: no browser and no identity provider, so it can
 * run on every pull request.
 *
 * Adds the check the personal edition has no equivalent of: a restore must
 * land entirely inside the importing account.
 *
 *   DATABASE_URL=... ADMIN_URL=... node test/roundtrip.integration.mjs
 */

process.env.DATABASE_URL ??=
  'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';
const ADMIN_URL = process.env.ADMIN_URL ??
  'postgres://owner:testpw@localhost:5432/habiterall';

const { withUser, pool } = await import('../src/db/pool.js');
const { applyImport } = await import('../src/apply-import.js');
const { writeLoopDatabase } = await import('@habiterall/shared/export-loop.js');
const { buildCsvArchive } = await import('@habiterall/shared/export-csv.js');
const {
  parseLoopDatabase, parseHabiterallJSON,
  parseLoopCheckmarksCSV, parseLoopHabitsCSV,
} = await import('@habiterall/shared/import.js');
const { unzip } = await import('@habiterall/shared/unzip.js');
const {
  FIXTURE, snapshot, diff, LOOP_HABIT_FIELDS, JSON_HABIT_FIELDS,
} = await import('@habiterall/shared/test/roundtrip-fixture.mjs');

const pg = (await import('pg')).default;
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { readFileSync, unlinkSync } = await import('node:fs');

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();

await admin.query('DELETE FROM entries');
await admin.query('DELETE FROM habits');
await admin.query(`DELETE FROM users WHERE idp_subject LIKE 'rt-%'`);

const mkUser = async (sub) => {
  const { rows } = await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
     VALUES ($1, 'https://ci.example', $2, $3) RETURNING id`,
    [sub, `${sub}@example.com`, sub]
  );
  return rows[0].id;
};

const alice = await mkUser('rt-alice');
const bob = await mkUser('rt-bob');
console.log(`  alice=${alice}  bob=${bob}\n`);

/* ---------- helpers ---------- */

/** Seed the fixture into a user's account, directly. */
async function seed(userId) {
  await withUser(userId, async (db) => {
    for (const [i, h] of FIXTURE.entries()) {
      const { rows } = await db.query(
        `INSERT INTO habits (user_id, name, description, type, unit, target_value,
                             target_type, freq_numerator, freq_denominator, color,
                             reminder_time, position, archived)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [userId, h.name, h.description, h.type, h.unit, h.target_value,
          h.target_type, h.freq_numerator, h.freq_denominator, h.color,
          h.reminder_time ?? '', i, h.archived]
      );
      const habitId = rows[0].id;

      for (const e of h.entries) {
        await db.query(
          `INSERT INTO entries (user_id, habit_id, date, value, status, notes)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [userId, habitId, e.date, e.value, e.status ?? '', e.notes]
        );
      }
    }
  });
}

/** Read a user's whole dataset in the shared export shape. */
async function read(userId) {
  return withUser(userId, async (db) => {
    const { rows: habits } = await db.query(
      `SELECT * FROM habits ORDER BY archived, position, id`);
    const { rows: entries } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status, notes
       FROM entries ORDER BY date`);

    const byHabit = new Map(habits.map((h) => [h.id, []]));
    for (const e of entries) {
      byHabit.get(e.habit_id)?.push({
        date: e.date,
        value: Number(e.value),
        status: e.status ?? '',
        notes: e.notes ?? '',
      });
    }
    return habits.map((h) => ({
      ...h,
      reminder_time: h.reminder_time ?? '',
      entries: byHabit.get(h.id) ?? [],
    }));
  });
}

async function wipe(userId) {
  await withUser(userId, async (db) => {
    await db.query('DELETE FROM entries');
    await db.query('DELETE FROM habits');
  });
}

/** The JSON backup payload the /export route builds. */
const toJsonBackup = (habits) => ({
  version: 1, app: 'habiterall', habits,
});

/** Same note-only rule as the personal suite. */
function noteOnly(habitName, entryKeyStr) {
  const h = FIXTURE.find((f) => f.name === habitName);
  if (!h || h.type !== 'boolean') return false;
  const date = entryKeyStr.split('|')[0];
  const e = h.entries.find((x) => x.date === date);
  return Boolean(e && e.status !== 'skip' && e.value === 0 && e.notes);
}

/* ---------- baseline ---------- */

console.log('--- baseline ---');

await seed(alice);
const seeded = await read(alice);
const baselineFull = snapshot(seeded, { fields: JSON_HABIT_FIELDS });
const baselineLoop = snapshot(seeded, { fields: LOOP_HABIT_FIELDS, notes: false });
const baselineLoopLossy = baselineLoop.map((h) => ({
  ...h,
  entries: h.entries.filter((e) => !noteOnly(h.name, e)),
}));

ck('fixture seeded', baselineFull.length === FIXTURE.length,
  `${baselineFull.length} habits`);

const water = baselineFull.find((h) => h.name === 'Water');
ck('a literal 3 on a numerical habit is not a skip',
  water.entries.some((e) => e.startsWith('2026-01-06|3|') && !e.includes('|skip')),
  water.entries.find((e) => e.startsWith('2026-01-06')));

/* ---------- JSON: lossless ---------- */

console.log('\n--- JSON backup (lossless) ---');

const jsonBackup = toJsonBackup(seeded);
await wipe(alice);
const jsonResult = await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');
const afterJson = snapshot(await read(alice), { fields: JSON_HABIT_FIELDS });

ck('JSON round-trip preserves everything',
  diff(baselineFull, afterJson) === null,
  diff(baselineFull, afterJson) ?? '');
ck('JSON restore skipped nothing',
  jsonResult.skipped.length === 0, jsonResult.skipped.join('; '));

// Idempotence: restoring the same backup again must not change or duplicate.
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');
const afterTwice = snapshot(await read(alice), { fields: JSON_HABIT_FIELDS });
ck('a second JSON restore is idempotent',
  diff(baselineFull, afterTwice) === null,
  diff(baselineFull, afterTwice) ?? '');

/* ---------- Loop .db ---------- */

console.log('\n--- Loop .db backup ---');

const loopPath = join(tmpdir(), `habiterall-rt-${process.pid}.db`);
await writeLoopDatabase(loopPath, seeded, (id) =>
  seeded.find((h) => h.id === id)?.entries ?? []);
const loopBytes = readFileSync(loopPath);
ck('the Loop export is a SQLite file',
  loopBytes.subarray(0, 15).toString() === 'SQLite format 3');

const loopHabits = await parseLoopDatabase(loopPath);
await wipe(alice);
const loopResult = await applyImport(alice, loopHabits, 'replace');
const afterLoop = snapshot(await read(alice), { fields: LOOP_HABIT_FIELDS, notes: false });
try { unlinkSync(loopPath); } catch { /* best effort */ }

ck('Loop round-trip preserves habits and entries',
  diff(baselineLoopLossy, afterLoop) === null,
  diff(baselineLoopLossy, afterLoop) ?? '');
ck('Loop restore skipped nothing',
  loopResult.skipped.length === 0, loopResult.skipped.join('; '));

const loopWater = afterLoop.find((h) => h.name === 'Water');
ck('Loop: numerical 3 stays 3, not a skip',
  loopWater.entries.includes('2026-01-06|3|'), loopWater.entries.join(' '));
ck('Loop: target values are not scaled by 1000',
  loopWater.target_value === 8, String(loopWater.target_value));

/* ---------- CSV archive ---------- */

console.log('\n--- CSV archive (Habits.csv + Checkmarks.csv) ---');

const csvZip = buildCsvArchive(seeded, (id) =>
  seeded.find((h) => h.id === id)?.entries ?? []);
const members = unzip(csvZip);
ck('the archive contains both CSVs',
  members.has('Habits.csv') && members.has('Checkmarks.csv'),
  [...members.keys()].join(', '));

const meta = parseLoopHabitsCSV(members.get('Habits.csv').toString('utf8'));
const csvHabits = parseLoopCheckmarksCSV(members.get('Checkmarks.csv').toString('utf8'), meta);

await wipe(alice);
const csvResult = await applyImport(alice, csvHabits, 'replace');
const afterCsv = snapshot(await read(alice), { fields: LOOP_HABIT_FIELDS, notes: false });

ck('CSV round-trip preserves habits and entries',
  diff(baselineLoopLossy, afterCsv) === null,
  diff(baselineLoopLossy, afterCsv) ?? '');
ck('CSV restore skipped nothing',
  csvResult.skipped.length === 0, csvResult.skipped.join('; '));

const csvWater = afterCsv.find((h) => h.name === 'Water');
ck('CSV: a numerical 3 stays 3, not a skip',
  csvWater.entries.includes('2026-01-06|3|'), csvWater.entries.join(' '));
ck('CSV: large amounts are not dropped as unknown sentinels',
  csvWater.entries.includes('2026-01-05|8|') && csvWater.entries.includes('2026-01-07|10|'),
  csvWater.entries.join(' '));

/* ---------- tenancy: a restore stays in its own account ---------- */

console.log('\n--- tenancy ---');

// Bob restores Alice's backup, ids and all. It must become Bob's own copy and
// must not touch a single row of Alice's — the ids in the file are ignored by
// design, and RLS is the backstop if that ever regresses.
await wipe(alice);
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');
const aliceBefore = snapshot(await read(alice), { fields: JSON_HABIT_FIELDS });

await applyImport(bob, parseHabiterallJSON(jsonBackup), 'replace');

const aliceAfter = snapshot(await read(alice), { fields: JSON_HABIT_FIELDS });
const bobAfter = snapshot(await read(bob), { fields: JSON_HABIT_FIELDS });

ck("importing as Bob leaves Alice's data untouched",
  diff(aliceBefore, aliceAfter) === null,
  diff(aliceBefore, aliceAfter) ?? '');
ck('Bob gets his own faithful copy',
  diff(baselineFull, bobAfter) === null,
  diff(baselineFull, bobAfter) ?? '');

// The rows really are distinct, not shared: no habit id appears in both.
const ids = async (u) => new Set((await read(u)).map((h) => String(h.id)));
const aliceIds = await ids(alice);
const bobIds = await ids(bob);
ck('the two accounts share no habit rows',
  [...bobIds].every((id) => !aliceIds.has(id)),
  `alice=${aliceIds.size} bob=${bobIds.size}`);

// A replace-mode restore must scope its wipe to the importer.
ck("Bob's replace did not delete Alice's habits",
  aliceIds.size === FIXTURE.length, `${aliceIds.size} habits`);

/* ---------- done ---------- */

await admin.query('DELETE FROM entries');
await admin.query('DELETE FROM habits');
await admin.query(`DELETE FROM users WHERE idp_subject LIKE 'rt-%'`);
await admin.end();
await pool.end();

console.log(`\n${fails === 0 ? 'all round-trip checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
