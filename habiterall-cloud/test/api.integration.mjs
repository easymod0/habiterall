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
const { parseSettings, foldCategoryName } = await import('@habiterall/shared/validate.js');
const { writeLoopDatabase } = await import('@habiterall/shared/export-loop.js');
const { parseLoopDatabase } = await import('@habiterall/shared/import.js');
// Dates only. `/categories/stats`'s own ceiling is asserted as the LITERAL
// 1830 below and deliberately not imported: a test that imports the constant it
// checks pins the name and nothing else — the `fresh` window passed with 7
// widened to 30 while its own comment claimed the boundary was covered.
const { computeStats, today, addDays } = await import('@habiterall/shared/stats.js');

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
  'archived', 'at_most_unlogged', 'category', 'category_id', 'color', 'created_at',
  'description', 'entries', 'freq_denominator', 'freq_numerator', 'icon', 'id', 'name',
  'position', 'reminder_message', 'reminder_time', 'show_as', 'target_type',
  'target_value', 'type', 'unit',
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

/* ---------- categories over HTTP ---------- */

console.log('--- categories over HTTP ---');
// Same reason as the block above: `resolveCategoryId` and `categoryNameTaken`
// are pinned as functions in shared/test/validate.test.js, but pinning the
// decision does not pin that the ROUTE calls it. This drives the real
// handler, over the same router the fake session above already mounts.

const freshHabitForCategory = await postHabit({ name: 'Category shape check', type: 'boolean' });
ck("a fresh habit's category_id is JSON null, not merely falsy",
  Object.is(freshHabitForCategory.category_id, null),
  JSON.stringify(freshHabitForCategory.category_id));

const nonexistentCategoryId = 999999;
const badCategoryOnCreate = await fetch(`${overviewBase}/api/habits`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Bad category', type: 'boolean', category_id: nonexistentCategoryId }),
});
ck('POST /habits with a nonexistent category_id is 400 over the real route',
  badCategoryOnCreate.status === 400, String(badCategoryOnCreate.status));

// bob's own category. RLS makes it indistinguishable from one that does not
// exist at all, so alice's request must get the SAME 400 as the one above —
// this is `resolveCategoryId`'s existence check, not a second rule.
const bobsCategory = await withUser(bob, async (db) => {
  const { rows } = await db.query(
    `INSERT INTO categories (user_id, name) VALUES ($1, 'Bobs Category') RETURNING id`,
    [bob]
  );
  return rows[0].id;
});
const foreignCategoryOnCreate = await fetch(`${overviewBase}/api/habits`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Foreign category', type: 'boolean', category_id: bobsCategory }),
});
ck("POST /habits with another user's category_id is 400, same as a missing one",
  foreignCategoryOnCreate.status === 400, String(foreignCategoryOnCreate.status));

const postCategory = (body) => fetch(`${overviewBase}/api/categories`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const wellness = await postCategory({ name: 'Wellness', color: '#22c55e' });
ck('POST /categories creates it, with the name and colour sent',
  wellness.name === 'Wellness' && wellness.color === '#22c55e', JSON.stringify(wellness));

const caseFoldedDuplicate = await fetch(`${overviewBase}/api/categories`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'wellness' }),
});
ck("a second category differing from 'Wellness' only by case is 409",
  caseFoldedDuplicate.status === 409, String(caseFoldedDuplicate.status));

const habitWithCategory = await postHabit({
  name: 'Read', type: 'boolean', category_id: wellness.id,
});
ck('a habit created with a category_id keeps it',
  habitWithCategory.category_id === wellness.id, JSON.stringify(habitWithCategory.category_id));

const deleteCategoryResp = await fetch(`${overviewBase}/api/categories/${wellness.id}`,
  { method: 'DELETE' });
ck('DELETE /categories/:id succeeds', deleteCategoryResp.status === 204,
  String(deleteCategoryResp.status));

// ON DELETE SET NULL, never CASCADE: the habit survives its category's
// deletion, uncategorised — the route's comment says so, this drives it.
const survivingHabit = await fetch(`${overviewBase}/api/habits/${habitWithCategory.id}`)
  .then((r) => r.json());
ck("the habit survives its category's deletion, and comes back uncategorised",
  Object.is(survivingHabit.category_id, null), JSON.stringify(survivingHabit.category_id));

/* ---- issue #256: İstanbul / Istanbul is the same bug as Wellness / wellness
 * above, at a codepoint the ASCII pair cannot exercise — `.toLowerCase()` maps
 * U+0130 ('İ') to 'i' followed by a combining dot (U+0307), never to plain
 * 'i', so the OLD fold disagreed with Postgres's `lower()`, which collapses
 * both `I` and `İ` to plain 'i'. This edition's own unique index (migration
 * 015, built ON `lower(name)`) already refuses the pair regardless of the
 * fold — the divergence is that the PERSONAL edition's ASCII-only `NOCASE`
 * does not, and so let a second row through where this edition's DB alone
 * caught it. This block pins the ROUTE and the IMPORTER, not the fold itself
 * — that is `shared/test/validate.test.js` — because a fold being right does
 * not make its two callers use it.
 *
 * Every literal below is a literal NAME comparison, deliberately never a call
 * to `foldCategoryName` — asserting `foldCategoryName(a) === foldCategoryName(b)`
 * would test the function against itself and pass unchanged even with the
 * fold reverted to plain `.toLowerCase()`.
 */
const istanbulRes = await fetch(`${overviewBase}/api/categories`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Istanbul', color: '#111111' }),
});
ck("POST /categories creates 'Istanbul'", istanbulRes.status === 201, String(istanbulRes.status));
const istanbul = await istanbulRes.json();

const dotlessIstanbulRes = await fetch(`${overviewBase}/api/categories`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'İstanbul' }),
});
ck(
  "'İstanbul' (U+0130) after 'Istanbul' is 409 here regardless of the fold — " +
  "Postgres's own lower()-backed unique index already refuses this pair on " +
  "its own; the divergence issue #256 is about is the OTHER edition " +
  'answering 201 to the identical request',
  dotlessIstanbulRes.status === 409, String(dotlessIstanbulRes.status));

// A dedicated app for the import route: it needs `express.raw()` mounted
// AHEAD of `express.json()` for this one path, exactly as the real
// server.js mounts it — see the comment there — which `overviewApp` above
// does not carry (its `express.json()` is global, so a raw body posted
// through it would never reach `req.body` as a Buffer). Same fake session as
// `overviewApp`, same router, same account.
const importApp = express();
importApp.use((req, _res, next) => { req.session = { user: { id: alice } }; next(); });
importApp.use('/api/import', express.raw({ type: '*/*', limit: '5mb' }));
importApp.use(express.json());
importApp.use('/api', api);
const importServer = await new Promise((resolve) => {
  const s = importApp.listen(0, '127.0.0.1', () => resolve(s));
});
const importBase = `http://127.0.0.1:${importServer.address().port}`;

// A merge-mode import declaring 'İstanbul' as a CATEGORY (colour deliberately
// NOT DEFAULT_COLOR — a fixture carrying the default would still pass with
// the never-recolour rule below deleted) and a habit naming it. `entries: []`
// because this block is about category resolution, not entry fidelity.
const importBackup = Buffer.from(JSON.stringify({
  categories: [{ name: 'İstanbul', color: '#abcdef' }],
  habits: [{
    name: 'issue-256 imported habit', type: 'boolean', category: 'İstanbul', entries: [],
  }],
}));
const importRes = await fetch(`${importBase}/api/import?mode=merge`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: importBackup,
});
ck('the İstanbul import itself succeeds', importRes.status === 200, String(importRes.status));
const importResult = await importRes.json();
ck(
  '…and records no skip — today the categories loop\'s own INSERT attempt ' +
  "reaches Postgres's lower()-backed unique index (the old fold does not " +
  "match the pre-existing row's fold, so nothing short-circuits it first), " +
  'and the caught conflict is recorded as a skip — that skip is the ' +
  'divergence issue #256 is about for this edition',
  Array.isArray(importResult.skipped) && importResult.skipped.length === 0,
  JSON.stringify(importResult.skipped));

const categoriesAfterImport = await fetch(`${overviewBase}/api/categories`).then((r) => r.json());
const matchingIstanbul = categoriesAfterImport
  .filter((c) => c.name === 'Istanbul' || c.name === 'İstanbul');
ck('THE assertion: still exactly ONE category named either spelling',
  matchingIstanbul.length === 1, JSON.stringify(categoriesAfterImport.map((c) => c.name)));

const importedHabits = await fetch(`${overviewBase}/api/habits`).then((r) => r.json());
const importedHabit = importedHabits.find((h) => h.name === 'issue-256 imported habit');
ck(
  "THE assertion: the imported habit's category_id is the PRE-EXISTING " +
  "'Istanbul' row's id — asserting the ID and not merely the count, since a " +
  'second row could otherwise absorb the habit and still leave a count of ' +
  'one if the pre-existing row were the one left duplicated instead',
  importedHabit?.category_id === istanbul.id,
  `${importedHabit?.category_id} vs ${istanbul.id} (categories: ` +
    `${JSON.stringify(categoriesAfterImport.map((c) => ({ id: c.id, name: c.name })))})`);

const istanbulAfterImport = categoriesAfterImport.find((c) => c.id === istanbul.id);
ck(
  "resolve-or-create must never recolour a category it found: the import's " +
  "own colour (#abcdef, not DEFAULT_COLOR) must not have overwritten the " +
  "pre-existing row's #111111",
  istanbulAfterImport?.color === '#111111', JSON.stringify(istanbulAfterImport));

// Clean up everything this block created, by NAME — 'İstanbul' only exists as
// a row here when the fold is broken, so this is unconditional rather than
// assuming which rows are present. Left dirty, the later reorder block's
// `pinnedOrder` sanity check (position 0/1 of the WHOLE list) would be
// reading past a category this block put there.
if (importedHabit) {
  await fetch(`${overviewBase}/api/habits/${importedHabit.id}`, { method: 'DELETE' });
}
for (const c of categoriesAfterImport) {
  if (c.name === 'Istanbul' || c.name === 'İstanbul') {
    await fetch(`${overviewBase}/api/categories/${c.id}`, { method: 'DELETE' });
  }
}
importServer.close();

/* ---- issue #256 (review round): a replace-mode restore silently merges two
 * of the FILE's own categories, and nothing said so ----
 *
 * The block above is a MERGE importing one declared category that resolves
 * onto an account's pre-existing row — the headline case, and it must keep
 * recording NO skip; that is the whole point of this PR. This block is the
 * other shape: a SINGLE file declaring TWO categories, `Istanbul` and
 * `İstanbul`, that fold to the same name. The second one is not created —
 * `resolveOrCreateCategory` resolves it onto the first — and unlike the
 * headline case, this loss is information only the FILE has: two categories
 * the file itself declared came back as one, and before this fix nothing in
 * `result.skipped` said so.
 *
 * Different colours and a habit each, so a fixture carrying DEFAULT_COLOR or
 * no habits could not pass with the collapse-reporting rule deleted.
 */
const dupImportApp = express();
dupImportApp.use((req, _res, next) => { req.session = { user: { id: alice } }; next(); });
dupImportApp.use('/api/import', express.raw({ type: '*/*', limit: '5mb' }));
dupImportApp.use(express.json());
dupImportApp.use('/api', api);
const dupImportServer = await new Promise((resolve) => {
  const s = dupImportApp.listen(0, '127.0.0.1', () => resolve(s));
});
const dupImportBase = `http://127.0.0.1:${dupImportServer.address().port}`;

const dupBackup = Buffer.from(JSON.stringify({
  categories: [
    { name: 'Istanbul', color: '#101010' },
    { name: 'İstanbul', color: '#202020' },
  ],
  habits: [
    { name: 'issue-256 dup habit A', type: 'boolean', category: 'Istanbul', entries: [] },
    { name: 'issue-256 dup habit B', type: 'boolean', category: 'İstanbul', entries: [] },
  ],
}));
const dupImportRes = await fetch(`${dupImportBase}/api/import?mode=merge`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: dupBackup,
});
ck('the dup-category import itself succeeds',
  dupImportRes.status === 200, String(dupImportRes.status));
const dupImportResult = await dupImportRes.json();
ck(
  'THE assertion: the SECOND declared category (İstanbul, folding to the ' +
  "same name as the FIRST declared category, Istanbul) IS reported in " +
  "skipped — two categories the file itself declared collapsing to one is " +
  'information only the file has, unlike the headline merge-onto-existing case',
  Array.isArray(dupImportResult.skipped) &&
    dupImportResult.skipped.some((s) => s.includes('İstanbul')),
  JSON.stringify(dupImportResult.skipped));

const dupCategories = await fetch(`${overviewBase}/api/categories`).then((r) => r.json());
const dupMatching = dupCategories.filter((c) => c.name === 'Istanbul' || c.name === 'İstanbul');
ck('still exactly ONE category named either spelling after the dup import',
  dupMatching.length === 1, JSON.stringify(dupCategories.map((c) => c.name)));

const dupHabits = await fetch(`${overviewBase}/api/habits`).then((r) => r.json());
const dupHabitA = dupHabits.find((h) => h.name === 'issue-256 dup habit A');
const dupHabitB = dupHabits.find((h) => h.name === 'issue-256 dup habit B');
ck(
  "THE assertion: both habits' category_id is the SAME id — the FIRST " +
  "declared category's (Istanbul), never a second row",
  dupHabitA?.category_id != null &&
    dupHabitA.category_id === dupHabitB?.category_id &&
    dupHabitA.category_id === dupMatching[0]?.id,
  `A=${dupHabitA?.category_id} B=${dupHabitB?.category_id} ` +
    `kept=${JSON.stringify(dupMatching)}`);

// Clean up everything this block created.
for (const h of [dupHabitA, dupHabitB]) {
  if (h) await fetch(`${overviewBase}/api/habits/${h.id}`, { method: 'DELETE' });
}
for (const c of dupCategories) {
  if (c.name === 'Istanbul' || c.name === 'İstanbul') {
    await fetch(`${overviewBase}/api/categories/${c.id}`, { method: 'DELETE' });
  }
}
dupImportServer.close();

/* ---- issue #256: the fold vs Postgres lower(), swept over every codepoint,
 * under BOTH collation providers this server can answer with ----
 *
 * The block above pins the ROUTE and the IMPORTER at one worked example
 * (İstanbul/Istanbul). This one pins the PROPERTY that example is standing
 * in for: for every pair of codepoints Postgres's `lower()` collapses to the
 * same character, `foldCategoryName` must not keep them apart — the rule a
 * route-level check needs to stay at least as strict as its DB backstop.
 *
 * It is a ONE-WAY containment and deliberately never
 * `foldCategoryName(ch) === lower(ch)` — that equality is FALSE on a correct
 * fold, for the 124 circled-capital codepoints (e.g. U+24B6) where JS's
 * `toLowerCase()` folds and libc's `lower()` does not. That direction is
 * harmless (the route only gets stricter, never looser than the index) and
 * asserting equality would fail an implementation that is doing this right.
 *
 * Run under the session's DEFAULT collation (this server's database default,
 * libc-backed — the same provider `postgres:17-alpine`'s shipped image
 * uses) AND explicitly under `und-x-icu`, because a fold that only satisfies
 * containment against the collation provider this suite happens to connect
 * through says nothing about a managed Postgres that offers ICU instead —
 * which is exactly how #256's review round found the committed fold's one
 * remaining break (a decomposed `i` + U+0307 spelling that ICU's `lower()`
 * collapses against `İ`/`I` and libc's does not). The ICU sweep is skipped
 * with a printed note if this server carries no ICU collations at all,
 * rather than failing — provisioning ICU is an operator choice this suite
 * cannot make for them.
 *
 * `lower()` is read off THIS Postgres in one query per provider rather than
 * assumed — the grouping key defaults to a codepoint's own character when
 * the query names no divergence for it, which is what puts plain 'i'
 * (U+0069) in the same group as 'I' (U+0049) and 'İ' (U+0130) even though
 * only the latter two are rows in the result set.
 */
const { rows: [{ n: icuCollationCount }] } = await admin.query(
  `SELECT count(*) AS n FROM pg_collation WHERE collprovider = 'i'`
);
const hasIcuCollation = Number(icuCollationCount) > 0;

const cpLabel = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')} (${String.fromCodePoint(cp)})`;

async function sweepCodepoints(providerLabel, collateSql) {
  console.log(`\n--- foldCategoryName vs Postgres lower(): every codepoint (${providerLabel}) ---`);

  const codepointSqlStart = Date.now();
  const { rows: divergentRows } = await admin.query(
    `SELECT n, lower(chr(n)::text ${collateSql}) AS lo FROM generate_series(1, 1114111) AS n
     WHERE (n < 55296 OR n > 57343) AND lower(chr(n)::text ${collateSql}) <> chr(n)`
  );
  const codepointSqlMs = Date.now() - codepointSqlStart;

  // Codepoint -> what Postgres folds it to. Absent means "maps to itself",
  // which is exactly the WHERE clause above, negated.
  const postgresFold = new Map(divergentRows.map((r) => [Number(r.n), r.lo]));

  const codepointWalkStart = Date.now();
  const groups = new Map();   // Postgres's answer -> every codepoint folding to it
  for (let cp = 1; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;   // surrogate range: no character there
    const ch = String.fromCodePoint(cp);
    // Whitespace-only: `foldCategoryName` trims before folding, so every one of
    // these already folds to '' on its own — comparing that against a real
    // letter sharing Postgres's group (if one ever does) would fail on the
    // TRIM, not on anything this sweep is about.
    if (/^\s+$/u.test(ch)) continue;
    const key = postgresFold.get(cp) ?? ch;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cp);
  }
  const codepointWalkMs = Date.now() - codepointWalkStart;
  console.log(`  (query ${codepointSqlMs}ms, walk ${codepointWalkMs}ms, ${groups.size} groups)`);

  let offence = null;
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const first = foldCategoryName(String.fromCodePoint(members[0]));
    for (const cp of members.slice(1)) {
      const folded = foldCategoryName(String.fromCodePoint(cp));
      if (folded !== first) {
        offence = { a: members[0], b: cp, foldA: first, foldB: folded, key };
        break;
      }
    }
    if (offence) break;
  }
  ck(
    `foldCategoryName is constant within every group Postgres lower() ` +
    `collapses under ${providerLabel} (one-way containment — the fold may ` +
    'be stricter than lower(), never looser)',
    offence === null,
    offence
      ? `${cpLabel(offence.a)} folds to ${JSON.stringify(offence.foldA)} but ` +
        `${cpLabel(offence.b)} folds to ${JSON.stringify(offence.foldB)}, though ` +
        `Postgres's lower() under ${providerLabel} puts both in one group`
      : '');
}

await sweepCodepoints('libc / database default', '');
if (hasIcuCollation) {
  await sweepCodepoints('ICU (und-x-icu)', 'collate "und-x-icu"');
} else {
  console.log('\n--- foldCategoryName vs Postgres lower() under ICU: SKIPPED — ' +
    'this server has no ICU collations (SELECT count(*) FROM pg_collation ' +
    "WHERE collprovider='i' returned 0) ---");
}

/* ---- the contextual pairs a per-codepoint sweep cannot see ----
 *
 * The codepoint sweep above reduces a STRING question (does the unique
 * index collapse two names) to one about codepoints taken in isolation,
 * which only holds where `lower()` folds each codepoint the same way
 * regardless of what sits next to it. Final_Sigma is exactly a case where it
 * does not: Postgres's ICU provider implements the SAME context-sensitive
 * rule JS's `toLowerCase()` does — a lone `Σ` handed to either sees no
 * preceding cased letter and always folds to plain `σ`, so the codepoint
 * sweep above cannot observe the divergence at all, and asserting that
 * `lower()` is a per-codepoint homomorphism (this suite used to) is false
 * under ICU for exactly this reason: measured on this server, ICU's
 * `lower('ΟΔΟΣ')` is `'οδος'` (ending in FINAL sigma, U+03C2) while
 * `lower('Οδοσ')` is `'οδοσ'` — two different strings, so ICU does not even
 * collapse this pair, matching JS's own context-sensitive answer for it.
 * Under libc, by contrast, `lower()` folds every `Σ`/`σ` to U+03C3
 * regardless of position, so libc DOES collapse the pair and per-codepoint
 * folding (this function's whole strategy) is what is needed to catch it.
 *
 * So the property worth asserting is not the homomorphism — it is
 * containment, checked directly against a small table of the pairs this
 * issue is actually about, under BOTH providers: whenever Postgres's own
 * `lower()` says two names are the same, `foldCategoryName` must say so too.
 * `İstanbul`/the decomposed spelling ('i' + U+0307) is the pair the U+0130
 * fix is FOR — built with an explicit \u0307 escape, never a pasted
 * combining character.
 */
const decomposedIstanbul = 'i' + '\u0307' + 'stanbul';
const contextualPairs = [
  ['İstanbul', decomposedIstanbul],
  ['İstanbul', 'Istanbul'],
  ['ΟΔΟΣ', 'Οδοσ'],
  ['Élan', 'élan'],
];

for (const [providerLabel, collateSql] of [
  ['libc / database default', ''],
  ...(hasIcuCollation ? [['ICU (und-x-icu)', 'collate "und-x-icu"']] : []),
]) {
  for (const [a, b] of contextualPairs) {
    const { rows: [{ la, lb }] } = await admin.query(
      `SELECT lower($1::text ${collateSql}) AS la, lower($2::text ${collateSql}) AS lb`,
      [a, b]
    );
    const postgresCollapses = la === lb;
    const foldCollapses = foldCategoryName(a) === foldCategoryName(b);
    ck(
      `[${providerLabel}] lower() collapsing (${JSON.stringify(a)}, ` +
      `${JSON.stringify(b)}) implies foldCategoryName does too`,
      !postgresCollapses || foldCollapses,
      `lower(): ${JSON.stringify(la)} vs ${JSON.stringify(lb)} ` +
      `(collapses=${postgresCollapses}); fold(): ` +
      `${JSON.stringify(foldCategoryName(a))} vs ${JSON.stringify(foldCategoryName(b))}`);
  }
}
if (!hasIcuCollation) {
  console.log('--- contextual-pair table under ICU: SKIPPED — no ICU collations on this server ---');
}

/* ---------- an entry in a reorder list that merely COERCES to an id ----------
 *
 * `Number.isInteger(Number(n))` — what both editions asked — says YES to
 * `null`, `''` and `[]` (all 0), to `true` (1), and to `[7]`, because
 * `Number(['7'])` is 7. `parseCategoryId` (shared/src/validate.js) is the
 * shape rule now, the same one `/categories/:id` asks of the URL, and the two
 * editions ask it in the same order so a malformed reorder cannot be a 400
 * here and a 200 there.
 *
 * The nested-array case is the one asserted BEHAVIOURALLY rather than by
 * status, and deliberately so: it is the only spelling whose coerced id this
 * account actually owns. `[true]` coerces to id 1, which under RLS belongs to
 * whoever holds it — the UPDATE simply matches no row here, so in this edition
 * that spelling can only ever be a 200 that moved nothing, never a wrong
 * write. The personal edition, with one account and no RLS, is where `[true]`
 * moves a real category, and its own suite pins that. Both statuses are
 * checked in both, because the alignment is the point.
 */

const reorderPost = (order) => fetch(`${overviewBase}/api/categories/reorder`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ order }),
});
const categoryIds = () => fetch(`${overviewBase}/api/categories`)
  .then((r) => r.json()).then((rows) => rows.map((c) => c.id));

const reorderFirst = await postCategory({ name: 'Zzz Reorder A' });
const reorderSecond = await postCategory({ name: 'Zzz Reorder B' });
// A deliberate order, so "nothing moved" is a fact about this list rather
// than a coincidence of whatever order the rows were created in.
await reorderPost([reorderSecond.id, reorderFirst.id]);
const pinnedOrder = await categoryIds();
ck('sanity: the account is in a deliberate order, B before A',
  pinnedOrder[0] === reorderSecond.id && pinnedOrder[1] === reorderFirst.id,
  JSON.stringify({ pinnedOrder, a: reorderFirst.id, b: reorderSecond.id }));

for (const [label, entry] of [
  ['`true`', true], ['`null`', null], ["`''`", ''], ['`[]`', []],
]) {
  const resp = await reorderPost([entry]);
  ck(`POST /categories/reorder with ${label} is 400, not a 200 that moved nothing`,
    resp.status === 400, String(resp.status));
}

const nestedResp = await reorderPost([[reorderFirst.id]]);
ck('POST /categories/reorder with a NESTED id is 400 — Number([7]) is 7, an id ' +
   'this account really owns',
  nestedResp.status === 400, String(nestedResp.status));

const afterRefusals = await categoryIds();
ck('THE assertion: not one of the five refused requests moved a category',
  JSON.stringify(afterRefusals) === JSON.stringify(pinnedOrder),
  JSON.stringify({ pinnedOrder, afterRefusals }));

const reorderStillWorks = await reorderPost([reorderFirst.id, String(reorderSecond.id)]);
ck('a well-shaped reorder still succeeds, spelled as a number OR as a string',
  reorderStillWorks.status === 200, String(reorderStillWorks.status));
const afterRealReorder = await categoryIds();
ck('...and it actually moved them',
  afterRealReorder[0] === reorderFirst.id && afterRealReorder[1] === reorderSecond.id,
  JSON.stringify(afterRealReorder));

/* ---- GET /categories/stats — the three things only the ROUTE can get wrong ----
 *
 * `computeCategoryStats` has its own unit tests and they pin the arithmetic.
 * These pin the WIRING, which is what a route gets wrong without touching the
 * rule at all: what it hands the function, and what it refuses to compute.
 *
 * The same block personal's `apishape.integration.mjs` carries, asking the same
 * questions of the same URL — the two editions answering one request
 * differently is the defect class this repo names most often, and this is the
 * half of that promise a shared unit test cannot make.
 */

console.log('\n--- categories/stats ---');

const STATS_END = today();
const STATS_START = addDays(STATS_END, -29);

const statsUrl = (params) =>
  `${overviewBase}/api/categories/stats?${new URLSearchParams(params)}`;

const categoryStats = async (params = {}) => (await (await fetch(statsUrl({
  start: STATS_START, end: STATS_END, granularity: 'day', ...params,
}))).json());

const logDay = (id, date) => fetch(`${overviewBase}/api/habits/${id}/entries/${date}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ value: 2 }),
});

/* -- archived members: excluded from the category, and COUNTED -- */

const keptCategory = await postCategory({ name: 'Compare Kept', color: '#123456' });

const keptHabit = await postHabit(
  { name: 'Compare Kept habit', type: 'boolean', category_id: keptCategory.id }
);
const archivedHabit = await postHabit(
  { name: 'Compare Archived habit', type: 'boolean', category_id: keptCategory.id }
);
// Both logged, so the archived one has a real strength to be left out OF —
// a member sitting at no score would drop out of the mean either way.
for (let i = 0; i < 10; i++) {
  await logDay(keptHabit.id, addDays(STATS_END, -i));
  await logDay(archivedHabit.id, addDays(STATS_END, -i));
}

const beforeArchive = await categoryStats();
const keptBefore = beforeArchive.categories.find((c) => c.id === keptCategory.id);
ck('both members are counted while both are active',
  keptBefore?.members === 2, `members: ${keptBefore?.members}`);
ck('sanity: the window ends on the day that was asked for',
  beforeArchive.buckets.at(-1) === STATS_END,
  JSON.stringify({ last: beforeArchive.buckets.at(-1), STATS_END }));

const archivedCountBefore = beforeArchive.archivedExcluded;

await putHabit(archivedHabit.id, {
  name: 'Compare Archived habit', type: 'boolean',
  category_id: keptCategory.id, archived: true,
});

const afterArchive = await categoryStats();
const keptAfter = afterArchive.categories.find((c) => c.id === keptCategory.id);
ck('an archived member leaves its category\'s member count',
  keptAfter?.members === 1, `members: ${keptAfter?.members}`);
ck('THE assertion: and it is COUNTED in archivedExcluded — a route that ' +
  'filtered on `archived` in SQL reports 0 here forever, and the view has ' +
  'nothing to say about what it left out',
  afterArchive.archivedExcluded === archivedCountBefore + 1,
  JSON.stringify({ archivedCountBefore, after: afterArchive.archivedExcluded }));
ck('...and the one active member is both the best and the worst named',
  keptAfter?.best?.id === keptHabit.id && keptAfter?.worst?.id === keptHabit.id,
  JSON.stringify({ best: keptAfter?.best, worst: keptAfter?.worst }));

/* -- an ABANDONED habit is in the mean; only a NEVER-LOGGED one is excluded --
 *
 * The route fetches entries from `start - 400`, so a habit last logged before
 * that comes back with an empty slice — indistinguishable, from the slice
 * alone, from one that has never been logged at all. They are different facts
 * and only one of them should keep a habit out of its category's mean: an
 * abandoned habit has a real strength near zero and really is dragging the
 * category down. The lifetime `MIN(date)` is what tells them apart, and this is
 * the only assertion in the suite that can see whether the route supplies it.
 */

const abandonedCategory = await postCategory(
  { name: 'Compare Abandoned', color: '#654321' });
const abandonedHabit = await postHabit(
  { name: 'Compare Abandoned habit', type: 'boolean',
    category_id: abandonedCategory.id }
);
// 900 days back: well outside the fetched window (29 + 400 = 429 days), and
// well inside the lifetime the grouped MIN(date) reads.
for (let i = 0; i < 3; i++) {
  await logDay(abandonedHabit.id, addDays(STATS_END, -(900 + i)));
}

const neverCategory = await postCategory({ name: 'Compare Never', color: '#abcdef' });
const neverHabit = await postHabit(
  { name: 'Compare Never habit', type: 'boolean', category_id: neverCategory.id }
);

const landing = await categoryStats();
const abandoned = landing.categories.find((c) => c.id === abandonedCategory.id);
const never = landing.categories.find((c) => c.id === neverCategory.id);

ck('the abandoned habit is a member of its category',
  abandoned?.members === 1, `members: ${abandoned?.members}`);
ck('THE assertion: it is NOT reported as never logged — its entries are older ' +
  'than the fetched slice, so only a lifetime MIN(date) can say so',
  abandoned?.unloggedExcluded === 0,
  JSON.stringify({ unloggedExcluded: abandoned?.unloggedExcluded,
                   mean: abandoned?.mean }));
ck('...so it is averaged into the mean rather than left out of it',
  typeof abandoned?.mean === 'number', JSON.stringify(abandoned?.mean));

ck('a habit that has never been logged is counted, and counted as unlogged',
  never?.members === 1 && never?.unloggedExcluded === 1,
  JSON.stringify({ members: never?.members,
                   unloggedExcluded: never?.unloggedExcluded }));
ck('...and a category with nothing landed has no mean at all, never 0',
  Object.is(never?.mean, null), JSON.stringify(never?.mean));

ck('Uncategorised is the last section, and carries id null',
  Object.is(landing.categories.at(-1).id, null),
  JSON.stringify(landing.categories.at(-1)?.id));

/* -- the warm-up: this route agrees with the habit's OWN page --
 *
 * `computeScores` starts its EWMA at 0 on the first day of the range it is
 * handed, so a comparison computed cold at the requested `start` reports every
 * habit weaker than `/habits/:id/stats` does — `ui/detail.js` sends that route
 * no `start`, so a habit's own page is always converged from its first entry.
 * Two surfaces disagreeing about the same habit is indistinguishable from one
 * of them being broken, which is why each member is scored over
 * `[start - SCORE_WARMUP_DAYS, end]` and sliced back.
 *
 * `stats.test.js` pins that DECISION and cannot pin the WIRING: the pure
 * function scores whatever entries it is handed, so a route fetching from
 * `start` rather than from `start - SCORE_WARMUP_DAYS` satisfies every unit
 * test in this repo — the member simply arrives with a shorter history and
 * `computeCategoryStats` has no way to know it was short-changed. This is the
 * route-layer half, and the assertion is deliberately CROSS-SURFACE: the claim
 * the warm-up makes is not "400 days are fetched", it is "the comparison says
 * what the habit's own page says".
 *
 * It needs a SHORT window to be falsifiable at all. The default window is 365
 * days — some 28 half-lives of this decay — so a series starting cold at that
 * edge has re-converged long before `end` and the two figures agree whether or
 * not the warm-up is there. Twenty days is inside its reach.
 *
 * The personal edition's `apishape.integration.mjs` carries the same block over
 * the same URL. The two editions' entry reads are separate lines — this one's
 * `BETWEEN $2 AND $3`, that one's `entriesInRange` — and each can rot alone.
 */

// Three times the window compared below, so the warm-up has real history to
// reach back for rather than a few days of it.
const WARMUP_HISTORY_DAYS = 60;
// Inclusive, so this is a 20-day window and not a 21-day one.
const WARMUP_START = addDays(STATS_END, -19);

const warmupCategory = await postCategory({ name: 'Compare Warmup', color: '#0f766e' });
const warmupHabit = await postHabit(
  { name: 'Compare Warmup habit', type: 'boolean', category_id: warmupCategory.id }
);
for (let i = 0; i < WARMUP_HISTORY_DAYS; i++) {
  await logDay(warmupHabit.id, addDays(STATS_END, -i));
}

// The habit's own page, asked exactly as the detail view asks it: an `end`,
// and no `start` at all.
const ownPage = await fetch(
  `${overviewBase}/api/habits/${warmupHabit.id}/stats?end=${STATS_END}`
).then((r) => r.json());
const ownScore = ownPage.scores?.at(-1)?.score;

// The control, and it is what makes the assertion below able to fail: the
// member's history must start well BEFORE the compared window opens. Against a
// habit first logged inside that window, a route with no warm-up produces the
// very same agreement, because there would be nothing earlier to miss.
ck('sanity: the member has history reaching far back beyond the compared window',
  ownPage.scores?.length === WARMUP_HISTORY_DAYS
    && WARMUP_HISTORY_DAYS > 20,
  JSON.stringify({ points: ownPage.scores?.length, WARMUP_HISTORY_DAYS }));

const shortWindow = await categoryStats({ start: WARMUP_START });
const warm = shortWindow.categories.find((c) => c.id === warmupCategory.id);

ck('sanity: that window really is the short one, 20 days of buckets',
  shortWindow.buckets.length === 20,
  JSON.stringify({ buckets: shortWindow.buckets.length, WARMUP_START }));
ck('sanity: and the category has exactly the one member being compared',
  warm?.members === 1 && warm?.unloggedExcluded === 0,
  JSON.stringify({ members: warm?.members, unlogged: warm?.unloggedExcluded }));

// Compared against the habit's own figure, never a literal: the number is a
// property of this fixture, and writing it out would pin the fixture rather
// than the agreement between the two surfaces.
ck('THE assertion: over a 20-day window the category mean IS the member\'s own ' +
  'strength — a route fetching entries from `start` instead of ' +
  '`start - SCORE_WARMUP_DAYS` reports it weaker here than its own page does',
  warm?.mean === ownScore && typeof ownScore === 'number',
  JSON.stringify({ mean: warm?.mean, ownScore }));
ck('...and the chart\'s last point is that same number, not a near-miss',
  warm?.series.at(-1)?.value === warm?.mean,
  JSON.stringify({ last: warm?.series.at(-1)?.value, mean: warm?.mean }));

/* -- ...and it agrees about an AVOID habit, which is the shape it can FLATTER --
 *
 * The block above covers the at-least shape, and that shape cannot see half of
 * this. The warm-up reaches back before the member existed, and on an at-least
 * habit those phantom days credit 0 — so the two surfaces agree whether or not
 * the range is clamped to the member's own first entry. On an at-most habit
 * whose unlogged days count as KEPT (`at_most_unlogged: 'success'`, or the
 * account's `atMostUnlogged`, which is every `show_as: 'avoid'` habit under that
 * setting) an unlogged day is FULL credit, so an unclamped warm-up converges a
 * limit created last week to ~1.0 while its own page reads under half that.
 * That is every limit habit's opening state, which makes it the reading a user
 * is most likely to meet first.
 *
 * Over the ordinary 30-day request rather than the short window above, and
 * deliberately: the disagreement is about days before the habit existed, so it
 * does not need a narrow window to show, and pinning it here says the DEFAULT
 * question this route is asked answers honestly for this shape.
 */

const avoidCategory = await postCategory({ name: 'Compare Avoid', color: '#b45309' });
const avoidHabit = await postHabit({
  name: 'Compare Avoid habit', type: 'numerical', unit: 'cans',
  target_type: 'at_most', target_value: 0,
  at_most_unlogged: 'success', show_as: 'avoid',
  category_id: avoidCategory.id,
});
// One slip, ten days back — `target + 1`, which is what `valueForState` writes
// for a slip on an avoided habit. Every other day of its life is unlogged,
// which is the state the setting counts as kept.
await fetch(`${overviewBase}/api/habits/${avoidHabit.id}/entries/${addDays(STATS_END, -10)}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ value: 1 }),
});

const avoidOwnPage = await fetch(
  `${overviewBase}/api/habits/${avoidHabit.id}/stats?end=${STATS_END}`
).then((r) => r.json());
const avoidOwnScore = avoidOwnPage.scores?.at(-1)?.score;

ck('sanity: this habit\'s unlogged days really do count as kept',
  avoidOwnPage.habit?.unlogged_is_success === true,
  JSON.stringify(avoidOwnPage.habit?.unlogged_is_success));
// The control that makes the assertion able to fail: a member already near 1.0
// on its own page would agree with a converged comparison by accident.
ck('sanity: and its own page has it well short of converged',
  typeof avoidOwnScore === 'number' && avoidOwnScore > 0.1 && avoidOwnScore < 0.75,
  JSON.stringify(avoidOwnScore));

const withAvoid = await categoryStats();
const avoidSection = withAvoid.categories.find((c) => c.id === avoidCategory.id);

ck('sanity: the avoid habit is the one member of its category',
  avoidSection?.members === 1 && avoidSection?.unloggedExcluded === 0,
  JSON.stringify({ members: avoidSection?.members,
                   unlogged: avoidSection?.unloggedExcluded }));
ck('THE assertion: a limit created inside the window reads the same here as on ' +
  'its own page — a warm-up not clamped to the member\'s first entry credits ' +
  '400 days before it existed as kept and converges it to ~1.0',
  avoidSection?.mean === avoidOwnScore && typeof avoidOwnScore === 'number',
  JSON.stringify({ mean: avoidSection?.mean, ownScore: avoidOwnScore }));
ck('...and the chart\'s last point is that same number here too',
  avoidSection?.series.at(-1)?.value === avoidSection?.mean,
  JSON.stringify({ last: avoidSection?.series.at(-1)?.value, mean: avoidSection?.mean }));

/* -- the range bounds --
 *
 * The ceiling is this route's OWN, and it is 1830 days — five years — not the
 * 3660 of `/habits/:id/stats`. That route walks one habit; this one walks
 * every habit in the account, so `MAX_RANGE_DAYS` here buys a cost multiplied
 * by the habit count.
 *
 * 1830 and 1831 are written out rather than imported, on purpose. A test that
 * imports the constant it checks pins the NAME and nothing else and goes on
 * passing while the boundary moves underneath it — the exact way the `fresh`
 * window survived widening from 7 to 30.
 */

const tooWide = await fetch(statsUrl({
  start: addDays(STATS_END, -1831), end: STATS_END, granularity: 'month',
}));
ck('a window of 1831 days — one past this route\'s ceiling — gives 400',
  tooWide.status === 400, String(tooWide.status));

const atCeiling = await fetch(statsUrl({
  start: addDays(STATS_END, -1830), end: STATS_END, granularity: 'month',
}));
ck('...and exactly 1830 is still answered, so the bound is the documented one ' +
  'and not one day tighter',
  atCeiling.status === 200, String(atCeiling.status));

// The bound is this route's own and NOT the one /habits/:id/stats enforces:
// a span that route serves happily is refused here.
const atOtherCeiling = await fetch(statsUrl({
  start: addDays(STATS_END, -3660), end: STATS_END, granularity: 'month',
}));
ck('a 3660-day window — fine for one habit on /habits/:id/stats — is refused ' +
  'here, because this route walks every habit in the account',
  atOtherCeiling.status === 400, String(atOtherCeiling.status));

const backwards = await fetch(statsUrl({
  start: STATS_END, end: addDays(STATS_END, -1),
}));
ck('a start after end gives 400', backwards.status === 400, String(backwards.status));

const futureEnd = await categoryStats({ end: addDays(STATS_END, 10) });
ck("an end in the future is clamped to the caller's today",
  futureEnd.buckets.at(-1) === STATS_END,
  JSON.stringify({ last: futureEnd.buckets.at(-1), STATS_END }));

/* -- ...and a caller that names no start gets a YEAR, not the ceiling --
 *
 * The simplest request the route takes must not be the most expensive one it
 * can answer. At the ceiling this would be 1831 daily buckets PER CATEGORY for
 * asking the plainest possible question; a caller who wants five years says so.
 *
 * `COMPARE_WINDOW_DAYS` lives in `shared/src/stats.js` so the two editions
 * cannot answer a start-less URL with different bucket counts — and, like the
 * ceiling above, it is written out here rather than imported. Importing it
 * would pin the name and let the window move underneath this check; the 366 is
 * the inclusive day count `addDays(end, -365)` actually produces.
 */

const defaulted = await (await fetch(
  statsUrl({ end: STATS_END, granularity: 'day' })
)).json();
ck('an absent start opens the window a year before end, not at the ceiling',
  defaulted.buckets.length === 366 && defaulted.buckets[0] === addDays(STATS_END, -365),
  JSON.stringify({ buckets: defaulted.buckets.length, first: defaulted.buckets[0],
                   wanted: addDays(STATS_END, -365) }));

// The rows above are alice's, and the import-isolation checks below count every
// entry she has. Clear only what this block wrote.
await withUser(alice, (db) => db.query(
  `DELETE FROM entries WHERE habit_id = ANY($1)`,
  [[keptHabit.id, archivedHabit.id, abandonedHabit.id, neverHabit.id, warmupHabit.id,
    avoidHabit.id]]
));

/* ---------- which validator a date-into-a-RANGE route asks ----------
 *
 * `DATE_RE` is four digits, a dash, two digits, a dash, two digits, and
 * nothing more, so `2026-00-10` and `2026-02-30` are shaped like dates and are
 * not days. All three routes below took one straight into the window
 * arithmetic, whose two halves then disagreed: `fromISO` ROLLS a bad component
 * over, so `?end=2026-00-10` walked a history ending 2025-12-10, while
 * `totalCompleted` selects by the string comparison `date <= '2026-00-10'`,
 * which admits every real day up to 2025-12-31.
 *
 * The same block habiterall-personal's `querydate.integration.mjs` carries,
 * asking the same questions of the same URLs — this edition had the identical
 * five sites, and the two editions answering one request differently is the
 * defect class this repo names most often.
 */

console.log('\n--- a date into a range ---');

const NOT_A_MONTH = '2026-00-10';
const NOT_A_DAY = '2026-02-30';

const dateHabit = await postHabit({ name: 'Query date', type: 'boolean' });
// Spread so the pre-fix answer to `?end=2026-00-10` and the honest answer to a
// canonical `?end=2025-12-10` are different NUMBERS rather than the same one
// reached two ways: the last two sit after the honest window closes and inside
// the string comparison's reach.
for (const date of ['2025-12-05', '2025-12-20', '2025-12-31']) {
  await logDay(dateHabit.id, date);
}

for (const [route, path] of [
  ['/habits/:id/stats', `/api/habits/${dateHabit.id}/stats`],
  ['/categories/stats', '/api/categories/stats'],
  ['/overview', '/api/overview'],
]) {
  for (const bad of [NOT_A_MONTH, NOT_A_DAY]) {
    const r = await fetch(`${overviewBase}${path}?end=${bad}`);
    ck(`GET ${route}?end=${bad} is 400`, r.status === 400, `HTTP ${r.status}`);
  }
  // The control. Without it this block passes against a route that answers 400
  // to everything, which is not the fix.
  const good = await fetch(`${overviewBase}${path}?end=2025-12-10`);
  ck(`GET ${route}?end=2025-12-10 is still 200`, good.status === 200, `HTTP ${good.status}`);
}

// `start` had the same gap as `end` on the two routes that take one.
for (const [route, path] of [
  ['/habits/:id/stats', `/api/habits/${dateHabit.id}/stats`],
  ['/categories/stats', '/api/categories/stats'],
]) {
  for (const bad of [NOT_A_MONTH, NOT_A_DAY]) {
    const r = await fetch(`${overviewBase}${path}?start=${bad}`);
    ck(`GET ${route}?start=${bad} is 400`, r.status === 400, `HTTP ${r.status}`);
  }
}

// A 400 proves the guard fired; it does not prove the figure it guarded was
// ever wrong. `2025-12-10` is the day `fromISO('2026-00-10')` rolls back to, so
// this is the window the broken request walked — and over it the habit has
// exactly ONE completion against the three that comparison counted. Both
// numbers are literals: a count derived from the fixture would agree with
// whatever the route did to it.
const honestWindow = await fetch(
  `${overviewBase}/api/habits/${dateHabit.id}/stats?end=2025-12-10`
).then((r) => r.json());
ck('the window the broken request walked holds 6 days',
  honestWindow.history?.length === 6, `history.length=${honestWindow.history?.length}`);
ck('THE assertion: and exactly ONE completion in it — the broken request ' +
  'reported 3, counted by `date <= "2026-00-10"` over a window ending 2025-12-10',
  honestWindow.totalCompleted === 1, `totalCompleted=${honestWindow.totalCompleted}`);

// A repeated parameter is an ARRAY, which `DATE_RE.test` string-coerced: the
// joined value matched nothing, so the route quietly answered about today
// instead of about either date named. What makes it a 400 now is `assertDate`
// THROWING where the old ternary fell back, over a coerced string with a comma
// in it — NOT `queryDate`'s `typeof` guard, which this row passes without.
// The guard is for the ONE-element array only `query parser: 'extended'` can
// produce, which coerces to a valid-looking date and then meets `.split` as a
// 500; no route can be pointed at that, so it is pinned as a unit test in
// `shared/test/validate.test.js` instead.
const repeatedEnd = await fetch(
  `${overviewBase}/api/habits/${dateHabit.id}/stats?end=2025-12-10&end=2026-01-01`);
ck('a repeated `end` is 400, not a silent fallback to today',
  repeatedEnd.status === 400, `HTTP ${repeatedEnd.status}`);

// Present and empty is present-and-invalid. Absent is different, and is the
// fallback every one of these routes has.
const emptyEnd = await fetch(`${overviewBase}/api/habits/${dateHabit.id}/stats?end=`);
ck('a present but empty `end=` is 400', emptyEnd.status === 400, `HTTP ${emptyEnd.status}`);

const noEnd = await fetch(`${overviewBase}/api/habits/${dateHabit.id}/stats`);
ck('naming no date at all is still 200', noEnd.status === 200, `HTTP ${noEnd.status}`);

// Same reason as the block above: the import-isolation checks below count
// every entry alice has.
await withUser(alice, (db) => db.query(
  `DELETE FROM entries WHERE habit_id = $1`, [dateHabit.id]));

/* ---------- /overview's own categorySummaries ----------
 *
 * Same three assertions habiterall-personal's overview.integration.mjs pins,
 * over the SAME rule — a never-logged member is excluded from the mean
 * rather than averaged in at 0 — asked of /overview rather than
 * /categories/stats this time. The two editions must answer this request
 * identically, which is the whole reason `summariseMembers` lives in
 * shared/src with two callers rather than being reimplemented here.
 */

console.log('\n--- overview categorySummaries ---');

const summaryCategory = await postCategory({ name: 'Overview Summary', color: '#0891b2' });
const summaryLogged = await postHabit(
  { name: 'Overview Summary logged', type: 'boolean', category_id: summaryCategory.id });
const summaryNeverLogged = await postHabit(
  { name: 'Overview Summary never logged', type: 'boolean', category_id: summaryCategory.id });
await logDay(summaryLogged.id, isoDaysAgo(0));

const groupedOverview = await getOverview({ days: 7 });
const overviewSummary = groupedOverview.categorySummaries
  ?.find((s) => s.id === summaryCategory.id);
const summaryLoggedRow = groupedOverview.habits.find((h) => h.id === summaryLogged.id);

ck("a never-logged member is excluded from /overview's own mean, not averaged in at 0",
  overviewSummary?.members === 2 && overviewSummary?.unloggedExcluded === 1,
  JSON.stringify(overviewSummary));
ck("the mean is the logged member's own score from this same /overview payload",
  overviewSummary?.mean === summaryLoggedRow?.score,
  `${overviewSummary?.mean} vs ${summaryLoggedRow?.score}`);
ck('sanity: the never-logged habit really is on the payload, just excluded',
  groupedOverview.habits.some((h) => h.id === summaryNeverLogged.id), '');

const overviewUncategorised = groupedOverview.categorySummaries?.find((s) => s.id === null);
ck('Uncategorised is always present on /overview too, with id: null',
  overviewUncategorised !== undefined, JSON.stringify(groupedOverview.categorySummaries));

const archivedOverviewCloud = await getOverview({ days: 7, archived: 'true' });
ck('?archived=true carries no categorySummaries, same as the personal edition',
  !('categorySummaries' in archivedOverviewCloud),
  JSON.stringify(Object.keys(archivedOverviewCloud)));

// The WIRING, not just the rule: `summariseByCategory` must be handed
// `summaryEnd` — the same day `score` beside it was computed against —
// rather than merely asked "does this member have an entry at all". A unit
// test on `summariseByCategory` (shared/test/stats.test.js) cannot prove the
// route passes that day; only a real write through the public API, read back
// from a different caller's "today", can. `Pacific/Kiritimati` (UTC+14) and
// `Pacific/Midway` (UTC-11) are 25 hours apart, so their calendar dates can
// NEVER be the same — this is deterministic, not a one-in-twenty-four race.
// Do not "simplify" this to two closer zones; that turns the test into one
// that usually asserts nothing.
const ZONE_AHEAD = 'Pacific/Kiritimati';
const ZONE_BEHIND = 'Pacific/Midway';
const zoneToday = (zone) => new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
ck('the two zones are never on the same calendar day',
  zoneToday(ZONE_AHEAD) !== zoneToday(ZONE_BEHIND),
  `${zoneToday(ZONE_AHEAD)} vs ${zoneToday(ZONE_BEHIND)}`);

const putAsZone = (zone, path, body) => fetch(`${overviewBase}${path}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Habiterall-Timezone': zone },
  body: JSON.stringify(body),
}).then((r) => r.json());
const getAsZone = (zone, params) => fetch(
  `${overviewBase}/api/overview?${new URLSearchParams(params)}`,
  { headers: { 'X-Habiterall-Timezone': zone } }
).then((r) => r.json());

const summaryFuture = await postHabit(
  { name: 'Overview Summary from ahead', type: 'boolean', category_id: summaryCategory.id });
// Dated that zone's own today — accepted by the write guard for THAT caller —
// which is ahead of `ZONE_BEHIND`'s today by the argument above.
await putAsZone(ZONE_AHEAD, `/api/habits/${summaryFuture.id}/entries/${zoneToday(ZONE_AHEAD)}`,
  { value: 2 });
// `summaryLogged` gets a second entry dated `ZONE_BEHIND`'s own today, so its
// landed status under the Midway-anchored read below does not depend on how
// this host's own clock happens to relate to either zone — only
// `summaryFuture`'s landing is left to the real gap between the two.
await putAsZone(ZONE_BEHIND, `/api/habits/${summaryLogged.id}/entries/${zoneToday(ZONE_BEHIND)}`,
  { value: 2 });

const behindOverview = await getAsZone(ZONE_BEHIND, { days: 7 });
const behindSummary = behindOverview.categorySummaries?.find((s) => s.id === summaryCategory.id);
const behindLoggedRow = behindOverview.habits.find((h) => h.id === summaryLogged.id);
const behindFutureRow = behindOverview.habits.find((h) => h.id === summaryFuture.id);

ck('a member whose only entry is dated ahead of the reading day is excluded',
  behindSummary?.unloggedExcluded === 2, // summaryNeverLogged + summaryFuture
  JSON.stringify(behindSummary));
ck("the mean does not average in the future-dated member's own score",
  behindSummary?.mean === behindLoggedRow?.score,
  `${behindSummary?.mean} vs ${behindLoggedRow?.score} `
  + `(future member's own score ${behindFutureRow?.score})`);

// Same reason as the block above: the import-isolation checks below count
// every entry alice has.
await withUser(alice, (db) => db.query(
  `DELETE FROM entries WHERE habit_id = ANY($1)`, [[summaryLogged.id, summaryFuture.id]]
));

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
// `score` is pinned too, alongside the streak — it is the figure `unlogged`
// moves hardest, and the route-level wiring of `summaryStats`'s `unlogged`
// argument was otherwise checked nowhere but `stats.test.js`'s own fixtures.
ck('  while still carrying the summary figures it is for',
  coverageRow.score === 0.381137 && coverageRow.currentStreak === RECENT_DAYS,
  `${coverageRow.score} / ${coverageRow.currentStreak}`);

/* ---------- unlogged_is_success ---------- */

console.log('\n--- unlogged_is_success ---');
// `unansweredCounts`'s own unit tests (shared/test/stats.test.js) pin the
// precedence rule; this is the WIRING at the two routes that resolve it onto
// the response, which is exactly what can drift without the rule itself
// changing at all. Every habit below carries no entries, so every day is
// unanswered on purpose.
const putSettings = (patch) => fetch(`${overviewBase}/api/settings`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
});

const overviewFlagFor = async (id) => {
  const body = await getOverview({ days: 7 });
  return body.habits.find((h) => h.id === id)?.unlogged_is_success;
};
const statsFlagFor = async (id) => {
  const body = await fetch(`${overviewBase}/api/habits/${id}/stats`).then((r) => r.json());
  return body.habit.unlogged_is_success;
};

// Assert a real JSON boolean, not merely a value that happens to be truthy or
// falsy — an implementation that echoed the raw setting string would pass a
// loose comparison on every row here.
const ckFlag = async (label, id, expected) => {
  const [ov, st] = await Promise.all([overviewFlagFor(id), statsFlagFor(id)]);
  ck(`${label} (/overview)`, ov === expected, `got ${JSON.stringify(ov)} (${typeof ov})`);
  ck(`${label} (/stats)`, st === expected, `got ${JSON.stringify(st)} (${typeof st})`);
};

await putSettings({ atMostUnlogged: 'success' });

const numericalAtMostDefault = await postHabit({
  name: 'Soda (default)', type: 'numerical', target_type: 'at_most', target_value: 2,
});
await ckFlag('account success, habit default, numerical at-most -> true',
  numericalAtMostDefault.id, true);

const booleanHabit = await postHabit({ name: 'Meditate', type: 'boolean' });
await ckFlag('account success, habit default, boolean -> false', booleanHabit.id, false);

const numericalAtLeast = await postHabit({
  name: 'Pushups', type: 'numerical', target_type: 'at_least', target_value: 20,
});
await ckFlag('account success, habit default, numerical at-least -> false',
  numericalAtLeast.id, false);

await putSettings({ atMostUnlogged: 'miss' });

const habitOverridesSuccess = await postHabit({
  name: 'Soda (override success)', type: 'numerical', target_type: 'at_most',
  target_value: 2, at_most_unlogged: 'success',
});
await ckFlag('account miss, habit success, numerical at-most -> true',
  habitOverridesSuccess.id, true);

await putSettings({ atMostUnlogged: 'success' });

const habitOverridesMiss = await postHabit({
  name: 'Soda (override miss)', type: 'numerical', target_type: 'at_most',
  target_value: 2, at_most_unlogged: 'miss',
});
await ckFlag('account success, habit miss, numerical at-most -> false',
  habitOverridesMiss.id, false);

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
