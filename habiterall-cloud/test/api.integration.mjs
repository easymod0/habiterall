/**
 * Cloud API integration tests, against a real Postgres.
 *
 * Exercises the data layer directly rather than over HTTP, so it needs no
 * browser and no identity provider — which is what lets it run on every pull
 * request. The OIDC flow itself is covered by test/browser/cloudlogin.mjs.
 *
 *   DATABASE_URL=... ADMIN_URL=... node test/api.integration.mjs
 */

process.env.DATABASE_URL ??=
  'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';
const ADMIN_URL = process.env.ADMIN_URL ??
  'postgres://owner:testpw@localhost:5432/habiterall';

const { withUser, pool } = await import('../src/db/pool.js');
const { applyImport } = await import('../src/apply-import.js');
const { parseSettings } = await import('@habiterall/shared/validate.js');
const { writeLoopDatabase } = await import('@habiterall/shared/export-loop.js');
const { parseLoopDatabase } = await import('@habiterall/shared/import.js');
const { computeStats } = await import('@habiterall/shared/stats.js');

const pg = (await import('pg')).default;
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { unlinkSync } = await import('node:fs');

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();

// Two real users, so every check can be made against a second account.
await admin.query('DELETE FROM entries');
await admin.query('DELETE FROM habits');
await admin.query(`DELETE FROM users WHERE idp_subject LIKE 'ci-%'`);

const mkUser = async (sub) => {
  const { rows } = await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
     VALUES ($1, 'https://ci.example', $2, $3) RETURNING id`,
    [sub, `${sub}@example.com`, sub]
  );
  return rows[0].id;
};

const alice = await mkUser('ci-alice');
const bob = await mkUser('ci-bob');
console.log(`  alice=${alice}  bob=${bob}\n`);

/* ---------- habits and entries ---------- */

console.log('--- habits ---');

const habitId = await withUser(alice, async (db) => {
  const { rows } = await db.query(
    `INSERT INTO habits (user_id, name, type, unit, target_value, target_type,
                         freq_numerator, freq_denominator, color)
     VALUES ($1,'Water','numerical','glasses',8,'at_least',1,1,'#0ea5e9')
     RETURNING id`, [alice]);
  return rows[0].id;
});
ck('a habit can be created', habitId > 0, String(habitId));

await withUser(alice, (db) => db.query(
  `INSERT INTO entries (habit_id, user_id, date, value, status, notes)
   VALUES ($1,$2,'2026-01-01',9,'','strong day')`, [habitId, alice]));

const entries = await withUser(alice, (db) =>
  db.query(`SELECT to_char(date,'YYYY-MM-DD') AS date, value, status, notes
            FROM entries WHERE habit_id = $1`, [habitId]).then((r) => r.rows));
ck('an entry round-trips with its note',
  entries[0]?.value === 9 && entries[0]?.notes === 'strong day',
  JSON.stringify(entries));

/* ---------- stats ---------- */

console.log('--- stats ---');
const habit = await withUser(alice, (db) =>
  db.query('SELECT * FROM habits WHERE id = $1', [habitId]).then((r) => r.rows[0]));
const stats = computeStats(habit, entries, { end: '2026-01-08' });
ck('stats compute over stored rows', stats.scores.length === 8, String(stats.scores.length));
ck('a met target counts as completed', stats.totalCompleted === 1, String(stats.totalCompleted));

/* ---------- settings ---------- */

console.log('--- settings ---');
const { accepted, rejected } = parseSettings({ dayOrder: 'newest-left', nope: 1 });
ck('valid settings accepted', accepted.dayOrder === 'newest-left', JSON.stringify(accepted));
ck('unknown keys ignored', rejected.includes('nope'), JSON.stringify(rejected));

await withUser(alice, (db) => db.query(
  `UPDATE users SET settings = settings || $1::jsonb WHERE id = $2`,
  [JSON.stringify(accepted), alice]));

const aliceSettings = await withUser(alice, (db) =>
  db.query('SELECT settings FROM users WHERE id = $1', [alice]).then((r) => r.rows[0].settings));
ck('settings persist on the account', aliceSettings.dayOrder === 'newest-left',
  JSON.stringify(aliceSettings));

const bobSettings = await withUser(bob, (db) =>
  db.query('SELECT settings FROM users').then((r) => r.rows));
ck('another user cannot read them',
  bobSettings.length === 1 && !JSON.stringify(bobSettings).includes('newest-left'),
  JSON.stringify(bobSettings));

/* ---------- import isolation ---------- */

console.log('--- import ---');
// A backup claiming another user's ids must land in the importer's account.
const malicious = [{
  id: habitId, user_id: alice, name: 'Water', type: 'numerical',
  unit: 'glasses', target_value: 8, target_type: 'at_least',
  freq_numerator: 1, freq_denominator: 1, color: '#0ea5e9',
  entries: [{ date: '2026-02-02', value: 5, notes: 'injected' }],
}];
const result = await applyImport(bob, malicious, 'merge');
ck('the import succeeds for the importer',
  result.habitsCreated + result.habitsMerged === 1, JSON.stringify(result));

const aliceAfter = await withUser(alice, (db) =>
  db.query('SELECT COUNT(*)::int AS n FROM entries').then((r) => r.rows[0].n));
ck("the victim's data is untouched", aliceAfter === 1, String(aliceAfter));

const bobAfter = await withUser(bob, (db) =>
  db.query('SELECT COUNT(*)::int AS n FROM entries').then((r) => r.rows[0].n));
ck('it landed in the importer’s account', bobAfter === 1, String(bobAfter));

/* ---------- Loop round trip ---------- */

console.log('--- Loop .db round trip ---');
// This has caught two real bugs: a crash from a missing import, and habit
// targets being wrongly divided by 1000. Both only surfaced with real data.
const roundTrip = [
  {
    id: 1, name: 'Meditate', description: '', type: 'boolean', unit: '',
    target_value: 0, target_type: 'at_least', freq_numerator: 1,
    freq_denominator: 1, color: '#8b5cf6', archived: false,
  },
  {
    id: 2, name: 'Brush Teeth', description: '', type: 'numerical',
    unit: 'Times', target_value: 2, target_type: 'at_most',
    freq_numerator: 1, freq_denominator: 1, color: '#0ea5e9', archived: false,
  },
];
const rtEntries = {
  1: [
    { date: '2026-03-01', value: 2, status: '', notes: 'kept' },
    { date: '2026-03-02', value: 0, status: 'skip', notes: '' },
  ],
  2: [{ date: '2026-03-01', value: 2, status: '', notes: '' }],
};

const dbPath = join(tmpdir(), `ci-loop-${process.pid}.db`);
try { unlinkSync(dbPath); } catch {}
await writeLoopDatabase(dbPath, roundTrip, (id) => rtEntries[id] ?? []);
const reimported = await parseLoopDatabase(dbPath);

const byName = Object.fromEntries(reimported.map((h) => [h.name, h]));
ck('every habit survives the round trip', reimported.length === 2, String(reimported.length));
ck('an at-most target is NOT rescaled',
  byName['Brush Teeth']?.target_value === 2,
  String(byName['Brush Teeth']?.target_value));
ck('the unit survives', byName['Brush Teeth']?.unit === 'Times');
ck('a numerical value survives',
  byName['Brush Teeth']?.entries[0]?.value === 2,
  String(byName['Brush Teeth']?.entries[0]?.value));
ck('a skip stays a skip',
  byName['Meditate']?.entries.some((e) => e.status === 'skip'),
  JSON.stringify(byName['Meditate']?.entries));
ck('notes survive',
  byName['Meditate']?.entries[0]?.notes === 'kept',
  JSON.stringify(byName['Meditate']?.entries[0]));
unlinkSync(dbPath);

/* ---------- cleanup ---------- */

await admin.query('DELETE FROM entries');
await admin.query('DELETE FROM habits');
await admin.query(`DELETE FROM users WHERE idp_subject LIKE 'ci-%'`);
await admin.end();
await pool.end();

console.log(fails === 0 ? '\nALL CLOUD API CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
