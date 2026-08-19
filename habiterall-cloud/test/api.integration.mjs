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

/* ---------- what /overview means by `end` ---------- */

console.log('--- overview ---');
// The one place this suite goes through the router rather than the data layer,
// because the bug was in the route: `end` decided both the grid window and the
// date the row summary was computed as of, so paging the dashboard back a month
// restated "43%" and a streak of 0 as if they were today's. The grid must still
// follow `end` — that is what the parameter is for — while strength and the
// streaks stay anchored on today. Mirrors habiterall-personal's
// test/overview.integration.mjs; the two editions promise the same API.
const express = (await import('express')).default;
const { api } = await import('../src/api.js');

const overviewApp = express();
// As the real server mounts it. This block was read-only until the caller's-day
// checks below, and a PUT without it reaches `parseEntry` with no body at all —
// which fails as a validation error and looks like a rule under test.
overviewApp.use(express.json());
// Enough of a session for `uid(req)`. The OIDC flow is browser-tested; what is
// under test here is arithmetic behind the route.
overviewApp.use((req, _res, next) => { req.session = { user: { id: alice } }; next(); });
overviewApp.use('/api', api);
const overviewServer = await new Promise((resolve) => {
  const s = overviewApp.listen(0, '127.0.0.1', () => resolve(s));
});
const overviewBase = `http://127.0.0.1:${overviewServer.address().port}`;

// `n` days ago on the LOCAL calendar, which is the calendar `today()` keeps.
// `toISOString()` here yields tomorrow's date everywhere east of UTC, and CI
// runs in UTC — so the obvious spelling only ever fails on somebody's laptop.
const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// A run of completions ending today, and nothing in the month before it.
const RECENT_DAYS = 10;
await withUser(alice, async (db) => {
  for (let i = 0; i < RECENT_DAYS; i++) {
    await db.query(
      `INSERT INTO entries (habit_id, user_id, date, value, status, notes)
       VALUES ($1,$2,$3,9,'','')
       ON CONFLICT (habit_id, date) DO UPDATE SET value = excluded.value`,
      [habitId, alice, isoDaysAgo(i)]
    );
  }
});

const getOverview = (params) =>
  fetch(`${overviewBase}/api/overview?${new URLSearchParams(params)}`).then((r) => r.json());

const nowView = await getOverview({ days: 7 });
const pagedView = await getOverview({ days: 7, end: isoDaysAgo(40) });
const rowNow = nowView.habits.find((h) => h.id === habitId);
const rowPaged = pagedView.habits.find((h) => h.id === habitId);

ck('paging back does not move the strength percentage',
  rowPaged.score === rowNow.score, `${rowPaged.score} vs ${rowNow.score}`);
ck('paging back does not move the current streak',
  rowPaged.currentStreak === rowNow.currentStreak,
  `${rowPaged.currentStreak} vs ${rowNow.currentStreak}`);
ck('paging back does not drop a best streak set after that date',
  rowPaged.bestStreak === rowNow.bestStreak,
  `${rowPaged.bestStreak} vs ${rowNow.bestStreak}`);
ck('the summary is describing the run, not an empty window',
  rowNow.currentStreak === RECENT_DAYS, String(rowNow.currentStreak));
ck('the grid window still follows end',
  pagedView.end === isoDaysAgo(40) && Object.keys(rowPaged.entries).length === 0,
  `${pagedView.end}, ${Object.keys(rowPaged.entries).length} entries`);
ck("today's window still carries its entries",
  Object.keys(rowNow.entries).length === 7,
  String(Object.keys(rowNow.entries).length));

// While the router is mounted, the other route added alongside it. The notify
// suite exercises the storage behind this through `notifier.deliveryStatus`
// directly, which would go on passing if the route itself were wired to the
// wrong function or forgot to scope itself to the session's user.
const { recordOutcome } = await import('../src/notifier.js');
await recordOutcome({ id: alice }, 'discord', {
  ok: false, status: 404, error: 'the webhook was deleted', permanent: true, date: '2026-08-15',
});
// Bob's own, on the same channel and with the opposite verdict, so "scoped to
// the session" is a real question rather than one row being the only row.
await recordOutcome({ id: bob }, 'discord', {
  ok: true, status: 204, error: '', permanent: false, date: '2026-08-15',
});

const status = await fetch(`${overviewBase}/api/notify/status`).then((r) => r.json());
ck('GET /notify/status reports the last delivery outcome',
  status.channels?.[0]?.channel === 'discord' && status.channels[0].ok === false,
  JSON.stringify(status));
ck('and it is the session\'s own, not whoever failed last',
  status.channels.length === 1 && status.channels[0].error === 'the webhook was deleted',
  JSON.stringify(status));
ck('the timestamp is ISO, as the personal edition also reports it',
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(status.channels[0].at ?? ''),
  status.channels[0].at);

// The export is the third route that only tells the truth through the router:
// the data layer returns rows, and what a backup FILE contains is decided
// above it. `SELECT *` put this deployment's tenancy key on every habit in a
// file people email to themselves, and the personal edition — which has no
// such column — wrote the same account with a different shape.
const backup = await fetch(`${overviewBase}/api/export`).then((r) => r.json());
const exported = backup.habits.find((h) => h.id === habitId);
ck('the JSON backup carries no user_id',
  exported != null && !('user_id' in exported), Object.keys(exported ?? {}).join(','));

// Read off the personal edition's own `/api/export`, so a habit column reaching
// CLOUD's backup and not personal's fails here.
//
// Be clear about the half it does not cover: this is a hardcoded snapshot in
// cloud's suite, so drift in the other direction — personal growing a column
// cloud does not have — still passes. `apishape.integration.mjs` pins personal's
// shape rather than forbidding extra keys, so it does not catch it either.
// Closing that needs the list to live somewhere both editions assert against.
const PORTABLE_HABIT_KEYS = [
  'archived', 'at_most_unlogged', 'color', 'created_at', 'description', 'entries',
  'freq_denominator', 'freq_numerator', 'icon', 'id', 'name', 'position',
  'reminder_message', 'reminder_time', 'show_as', 'target_type', 'target_value',
  'type', 'unit',
];
ck('and describes a habit exactly as the personal edition does',
  JSON.stringify(Object.keys(exported ?? {}).sort()) === JSON.stringify(PORTABLE_HABIT_KEYS),
  Object.keys(exported ?? {}).sort().join(','));

/* ---------- the device-clock middleware ---------- */
//
// The whole reporting half of `notifyTimezone: 'auto'` — and until this, every
// piece of it was deletable with the suite green: the middleware, the web
// client's header and the phone's interceptor. Only the server RULE was
// covered, which is the half that was never wrong.
//
// It runs on this app because the middleware sits at the top of the same
// router, and `uid(req)` is satisfied by the fake session above.

const zoneOf = (id) => withUser(id, (db) =>
  db.query(`SELECT device_time_zone FROM users WHERE id = $1`, [id])
    .then((r) => r.rows[0]?.device_time_zone ?? null));

await fetch(`${overviewBase}/api/habits`, {
  headers: { 'X-Habiterall-Timezone': 'Asia/Tokyo' },
});
ck('a header on an ordinary request records the device clock',
  await zoneOf(alice) === 'Asia/Tokyo', JSON.stringify(await zoneOf(alice)));

// It is stored on `users`, NOT in the settings blob — the distinction the
// whole design rests on, because it is what keeps `auto` reversible and keeps
// a device's zone out of a backup.
const settingsBlob = await withUser(alice, (db) =>
  db.query(`SELECT settings FROM users WHERE id = $1`, [alice])
    .then((r) => JSON.stringify(r.rows[0]?.settings ?? {})));
ck('and not in the settings blob, which is what a backup carries',
  !settingsBlob.includes('Asia/Tokyo'), settingsBlob);

await fetch(`${overviewBase}/api/habits`, {
  headers: { 'X-Habiterall-Timezone': 'Europe/Berlin' },
});
ck('a device that moves is followed', await zoneOf(alice) === 'Europe/Berlin',
  JSON.stringify(await zoneOf(alice)));

for (const junk of ['auto', 'Moon/Base', 'x'.repeat(200), "'; DROP TABLE users;--"]) {
  await fetch(`${overviewBase}/api/habits`, { headers: { 'X-Habiterall-Timezone': junk } });
}
ck('and junk is refused rather than stored', await zoneOf(alice) === 'Europe/Berlin',
  JSON.stringify(await zoneOf(alice)));

// Bob's row must be untouched by anything Alice's device says. The write runs
// under `withUser`, so RLS is what guarantees this; the tenancy suite attacks
// it directly, and this asserts the ordinary path never strays.
ck('one account\'s device says nothing about another\'s',
  await zoneOf(bob) === '', JSON.stringify(await zoneOf(bob)));

/* ---------- habit writes over HTTP ---------- */

console.log('--- habit writes over HTTP ---');
// Everything above this point either goes straight at the data layer or reads
// a route that only ever GETs. `insertHabit`'s `$n` list and `updateHabit`'s
// SET list are the riskiest edit in this whole change — a renumbering that
// slips is a bind-count error at best and a value landing in the WRONG COLUMN
// at worst — and nothing above exercises `POST /habits` or `PUT /habits/:id`
// at all. This does, over the same router the fake session above already
// mounts.
//
// Every field is set to something OTHER than its default: a field left at
// its default compares equal to itself and passes with the field dropped
// entirely, which is the failure this repo names most often. Iterating the
// SENT body's own keys, rather than a hand-written list, is what makes a
// field added later covered automatically instead of silently exempt.
const everyField = {
  name: 'Every Field',
  description: 'a description, not the empty one',
  type: 'numerical',
  unit: 'reps',
  target_value: 5,
  target_type: 'at_most',
  freq_numerator: 3,
  freq_denominator: 7,
  color: '#ff00ff',
  reminder_time: '08:30',
  reminder_message: 'Did you do it?',
  at_most_unlogged: 'success',
  show_as: 'avoid',
  icon: '🧘',
  archived: true,
};

const postHabit = (body) => fetch(`${overviewBase}/api/habits`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const created = await postHabit(everyField);
const wrongOnCreate = Object.keys(everyField)
  .filter((k) => created[k] !== everyField[k])
  .map((k) => `${k}: sent ${JSON.stringify(everyField[k])}, got ${JSON.stringify(created[k])}`);
ck('POST /habits round-trips every field', wrongOnCreate.length === 0,
  wrongOnCreate.join('; '));

// PUT REPLACES: send the same body back with the ONE thing a real caller
// changes, and everything else — icon included — must still be what was
// sent, not silently reset to a default by a column the SQL forgot.
const putHabit = (id, body) => fetch(`${overviewBase}/api/habits/${id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const oneFieldChanged = { ...everyField, archived: false };
const updated2 = await putHabit(created.id, oneFieldChanged);
const wrongOnUpdate = Object.keys(everyField)
  .filter((k) => k !== 'archived' && updated2[k] !== everyField[k])
  .map((k) => `${k}: sent ${JSON.stringify(everyField[k])}, got ${JSON.stringify(updated2[k])}`);
ck('PUT /habits/:id replaces, and carries every OTHER field unchanged',
  wrongOnUpdate.length === 0, wrongOnUpdate.join('; '));
ck('  and the one field that was meant to change, did',
  updated2.archived === false, JSON.stringify(updated2.archived));

/* ---------- and which day that device is ON ---------- */

// The header decides more than where a reminder lands: every route that asks
// "is this today?" asks it of the CALLER. `today()` is the container's day,
// which is UTC in both compose files, so a user east of it had the current
// column of their own grid refused as a future date — and, since the same date
// clamps the summary anchor, a day they DID record scored as of the server's
// yesterday. Personal's test/callerday.integration.mjs drives this against a
// process pinned west; a cloud suite cannot move the process clock out from
// under the rest of itself, so it asks the question that is true at every
// instant on every machine instead: two callers, two answers.
//
// Etc/GMT+12 and Pacific/Kiritimati are 26 hours apart — the whole spread of
// the Earth — so their calendar days ALWAYS differ, whatever the server's is.
//
// The four checks below are load bearing AS A SET, and no single one of them
// is. Which one catches the unfixed code depends on the hour the suite runs
// at: before 10:00 UTC the two `end` checks fail, from 10:00 to 12:00 only the
// west one does, and from 12:00 the write guard's `unreached` check is the
// only one left. So `a caller may record the day it is on` passes against a
// server judging by its own clock for fourteen hours out of twenty-four, and
// trimming any of these later would silently narrow the coverage to whenever
// CI happens to run. Personal's `test/callerday.integration.mjs` is the one
// that mutation-tests cleanly at every hour, because it can pin the process
// clock west; this suite cannot, and buys the same certainty by asking four
// questions instead of one.
const WEST = 'Etc/GMT+12';
const EAST = 'Pacific/Kiritimati';
const dayIn = (zone) => new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

ck('the two ends of the Earth are never on the same day',
  dayIn(EAST) > dayIn(WEST), `${dayIn(EAST)} vs ${dayIn(WEST)}`);

const asZone = (zone) => (path, init = {}) => fetch(`${overviewBase}${path}`, {
  ...init,
  headers: { 'Content-Type': 'application/json', 'X-Habiterall-Timezone': zone,
    ...(init.headers ?? {}) },
});
const fromEast = asZone(EAST);
const fromWest = asZone(WEST);

const eastView = await fromEast('/api/overview?days=7').then((r) => r.json());
const westView = await fromWest('/api/overview?days=7').then((r) => r.json());
ck('the grid window ends on the day the CALLER is on',
  eastView.end === dayIn(EAST) && westView.end === dayIn(WEST),
  `east ${eastView.end}, west ${westView.end}`);

// The write guard, from both sides of one date. The east caller's today is the
// west caller's tomorrow, so one date is simultaneously recordable and
// refusable depending on who asks — which is the whole claim.
const eastToday = dayIn(EAST);
const ownDay = await fromEast(`/api/habits/${habitId}/entries/${eastToday}`,
  { method: 'PUT', body: JSON.stringify({ value: 9 }) });
const unreached = await fromWest(`/api/habits/${habitId}/entries/${eastToday}`,
  { method: 'PUT', body: JSON.stringify({ value: 9 }) });
ck('a caller may record the day it is on', ownDay.status === 200,
  `HTTP ${ownDay.status} for ${eastToday}`);
ck('...and may not record a day it has not reached', unreached.status === 400,
  `HTTP ${unreached.status} for ${eastToday}`);

/* ---------- what the awards read out of the settings blob ---------- */

console.log('\n--- awards ---');
// `shared/test/awards.test.js` reads this edition's api.js as TEXT to check
// that `computeAwards` is handed the account's `skipDays`. That matches the
// FILE rather than the binding that reaches the call, so a misspelt JSONB key
// — `->> 'skipdays'`, with the column alias left alone — sails past it while
// every account silently loses the award. Cloud is where that is easiest to get
// wrong, because the key is a string inside SQL and not an identifier anything
// checks. Only a request through the router can tell the two apart.
//
// The habit already has a run of `RECENT_DAYS` ending today. One of those days
// becomes a deliberate rest, with on-pace days either side of it so it lies
// INSIDE `[start, end]` of the run rather than beside it.
await withUser(alice, (db) => db.query(
  `UPDATE entries SET value = 0, status = 'skip' WHERE habit_id = $1 AND date = $2`,
  [habitId, isoDaysAgo(4)]
));

const restAwardFor = async () => {
  const s = await fetch(`${overviewBase}/api/habits/${habitId}/stats`).then((r) => r.json());
  return (s.awards ?? []).find((a) => a.family === 'rest');
};
const setSkipDays = (v) => withUser(alice, (db) => db.query(
  `UPDATE users SET settings = settings || $1::jsonb WHERE id = $2`,
  [JSON.stringify({ skipDays: v }), alice]
));

await setSkipDays(false);
ck('with skipDays off there is no rest award',
  (await restAwardFor()) === undefined, JSON.stringify(await restAwardFor()));

await setSkipDays(true);
const restOn = await restAwardFor();
ck('storing skipDays: true turns it on', restOn !== undefined, JSON.stringify(restOn));
ck('  and it reports the run\'s own rest', restOn?.value === 1, JSON.stringify(restOn));

// The direction a hard-coded `true` cannot survive, and the one no check over
// source text can see at all.
await setSkipDays(false);
ck('and storing it off again withdraws it',
  (await restAwardFor()) === undefined, JSON.stringify(await restAwardFor()));

// `coverage` is on `/stats` and deliberately not on `/overview`, which now
// calls `summaryStats` once per habit for two fields rather than `computeStats`
// for eleven and discarding the rest.
const statsBody = await fetch(`${overviewBase}/api/habits/${habitId}/stats`)
  .then((r) => r.json());
ck('/stats carries the coverage field', Array.isArray(statsBody.coverage),
  JSON.stringify(statsBody.coverage));
const coverageRow = (await getOverview({ days: 7 })).habits.find((h) => h.id === habitId);
ck('/overview does not compute it per habit', coverageRow.coverage === undefined,
  JSON.stringify(coverageRow.coverage));
// Pinned to the value the fixture determines, not just its type: the rest day
// above sits inside the run rather than beside it, so it bridges the streak
// rather than ending it and `currentStreak` is still the full run length.
ck('  while still carrying the summary figures it is for',
  typeof coverageRow.score === 'number' && coverageRow.currentStreak === RECENT_DAYS,
  `${coverageRow.score} / ${coverageRow.currentStreak}`);

overviewServer.close();
// The rows above would otherwise be counted by the checks that follow.
await withUser(alice, (db) =>
  db.query(`DELETE FROM entries WHERE habit_id = $1 AND date <> '2026-01-01'`, [habitId]));

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
