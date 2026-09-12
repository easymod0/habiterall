/**
 * The two award inputs the route reads out of storage, checked as BEHAVIOUR.
 *
 * `shared/test/awards.test.js` pins the arithmetic, and it also reads this
 * file's source to check that `computeAwards` is handed everything the gates
 * need. That text check is real but it is the weakest thing in this feature:
 * it matches the FILE rather than the binding that reaches the call, so a
 * misspelt settings key (`skipdays`, with the SQL alias unchanged) or an
 * inverted comparison sails past it while every account silently loses the
 * award. Only a request can tell those apart, which is what this is.
 *
 * Two properties, one per direction:
 *
 * 1. `skipDays` gates the rest award, and the value that gates it is the one
 *    the account stored — so setting it through `PUT /api/settings` has to
 *    turn the badge on, and clearing it has to turn the badge off. An
 *    always-true binding passes the first half and fails the second; a wrong
 *    key or an inverted read fails the first.
 * 2. `/stats` carries `coverage` and `/overview` does not. That asymmetry is a
 *    deliberate cost decision — coverage is its own pass over the window and
 *    `/overview` calls `summaryStats` for two fields instead — and it is the
 *    kind of thing that is quietly undone by someone tidying an options
 *    object.
 *
 *   node test/awards.integration.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-awards-'));
// As every other integration suite here: auth defaults ON, and both switches
// have to be set before the server module is imported.
process.env.HABITERALL_AUTH = 'off';
process.env.HABITERALL_RATE_LIMIT = 'off';
process.env.HABITERALL_DB = join(workdir, 'awards.db');

const { app } = await import('../src/server.js');
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

/**
 * `n` days ago on the LOCAL calendar, which is the calendar the server keeps.
 * `toISOString()` is the obvious spelling and is a day out east of UTC, where
 * `assertNotFuture` then refuses the write — see overview.integration.mjs.
 */
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const json = (path, method, body) => fetch(`${base}/api${path}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => (r.status === 204 ? null : r.json()));

const post = (path, body) => json(path, 'POST', body);
const put = (path, body) => json(path, 'PUT', body);
const get = (path) => fetch(`${base}/api${path}`).then((r) => r.json());

/* ---------- 1. skipDays gates the rest award, from storage ---------- */

console.log('--- the rest award follows the stored setting ---');

const habit = await post('/habits', { name: 'Rested', type: 'boolean' });

// Twelve days on pace with one deliberate rest inside them: long enough to
// clear the award's minimum run, and the skip is bracketed by on-pace days on
// both sides so it is genuinely inside `[start, end]` of the run.
const REST_AT = 6;
for (let i = 11; i >= 0; i--) {
  await put(`/habits/${habit.id}/entries/${daysAgo(i)}`,
    i === REST_AT ? { value: 0, status: 'skip' } : { value: 2 });
}

const restAward = async () =>
  (await get(`/habits/${habit.id}/stats`)).awards.find((a) => a.family === 'rest');

// The setting has never been written, so the account is on the registry
// default — which is OFF, and is exactly the state most accounts are in.
ck('with the setting untouched there is no rest award',
  (await restAward()) === undefined, JSON.stringify(await restAward()));

await put('/settings', { skipDays: true });
const on = await restAward();
ck('storing skipDays: true turns it on', on !== undefined, JSON.stringify(on));
ck('  and it is the run\'s own rest that is being reported',
  on?.value === 1, JSON.stringify(on));

// The half a hard-coded `true` cannot pass, and the half a text check cannot
// see: turning the setting back off has to withdraw the award.
await put('/settings', { skipDays: false });
ck('storing skipDays: false turns it off again',
  (await restAward()) === undefined, JSON.stringify(await restAward()));

// The stored value is what decides it, so a value the server refuses must not
// leave the award on. `SETTING_VALUES` enumerates this one, so a string is
// rejected and the stored `false` stands.
const rejected = await put('/settings', { skipDays: 'yes please' });
ck('a value the server refuses does not enable it',
  (await restAward()) === undefined,
  `ignored=${JSON.stringify(rejected?.ignored ?? rejected)}`);

/* ---------- 2. coverage is on /stats and not on /overview ---------- */

console.log('\n--- coverage is paid for where it is read ---');

const stats = await get(`/habits/${habit.id}/stats`);
ck('/stats carries the coverage field', Array.isArray(stats.coverage),
  JSON.stringify(stats.coverage));

const rows = await get('/overview?days=7');
const row = rows.habits.find((h) => h.id === habit.id);
ck('/overview does not compute it per habit', row.coverage === undefined,
  JSON.stringify(row.coverage));
// The row is not empty of everything, or the check above would pass on a route
// that had stopped working altogether. `currentStreak` and `bestStreak` are
// pinned to the literal the fixture above produces — the 12-day run, held
// together across its one bracketed skip — rather than merely typeof-checked,
// the way cloud's equivalent assertion was strengthened in #183's step 2.
// `score` is pinned too: it is the figure `unlogged` moves hardest, and until
// now nothing at the route level checked that `summaryStats` was even handed
// it — `stats.test.js`'s parity fixtures were the only place `unlogged`'s
// wiring was covered at all.
ck('  while still carrying the three summary figures it is for',
  row.score === 0.443734 && row.currentStreak === 12 && row.bestStreak === 12,
  `${row.score} / ${row.currentStreak} / ${row.bestStreak}`);

/* ---------- 3. GET /awards agrees with /habits/:id/stats (#140) ---------- */

console.log('\n--- the account-level route agrees with the per-habit one ---');

// skipDays back on for this fixture — a skip inside the run below is what
// makes M2 (dropping `skipDays` from the `/awards` `computeAwards` call)
// visible in the deepEqual: with the setting off there is no rest award on
// either side to diverge over.
await put('/settings', { skipDays: true });

// 100 days, one of them a deliberate skip that BRIDGES rather than breaks the
// run (skips are transparent to `computeStreaks`): long enough to reach the
// top streak rung (`SURVIVAL_THRESHOLDS`' last entry, 100), to fully contain
// at least one calendar month with an answer on every day (`coverage`), and
// to earn a `rest` award once `skipDays` is on — three award FAMILIES, so the
// fixture is nowhere near the trap the brief calls out, a fixture that earns
// exactly one cheap award and so cannot see a narrowed window (M1) or a
// dropped setting (M2) changing anything. 100 days is also enough that
// computing `/awards` over a narrowed window (M1) diverges from the
// full-history answer: capped to the trailing 31 days the best streak drops
// from 100 to 31, which crosses the 60-day rung boundary.
const marathon = await post('/habits', { name: 'Marathon', type: 'boolean' });
for (let i = 99; i >= 0; i--) {
  await put(`/habits/${marathon.id}/entries/${daysAgo(i)}`,
    i === 10 ? { value: 0, status: 'skip' } : { value: 2 });
}

// A second habit, archived, so the archived-habit assertion below is not
// vacuous — `/categories/stats` includes archived habits and this route must
// too (M3).
const retired = await post('/habits', { name: 'Retired', type: 'boolean' });
await put(`/habits/${retired.id}/entries/${daysAgo(0)}`, { value: 2 });
await put(`/habits/${retired.id}`, { name: 'Retired', type: 'boolean', archived: true });

const fromAwardsRoute = (await get('/awards')).habits
  .find((h) => h.id === marathon.id).awards;
const fromStatsRoute = (await get(`/habits/${marathon.id}/stats`)).awards;

// The comparison below is worthless unless the fixture actually earned
// something: `deepEqual([], [])` passes against a route returning nothing at
// all, or against `computeAwards` never being called.
ck('the fixture earned at least one award',
  fromAwardsRoute.length > 0, JSON.stringify(fromAwardsRoute));
ck('  from at least two different families',
  new Set(fromAwardsRoute.map((a) => a.family)).size >= 2,
  JSON.stringify(fromAwardsRoute.map((a) => a.family)));
ck('/awards and /habits/:id/stats report the identical award array',
  JSON.stringify(fromAwardsRoute) === JSON.stringify(fromStatsRoute),
  `awards=${JSON.stringify(fromAwardsRoute)} stats=${JSON.stringify(fromStatsRoute)}`);

const awardsPayload = await get('/awards');
ck('every habit in the account is listed, archived included',
  new Set(awardsPayload.habits.map((h) => h.id)).size ===
    new Set([habit.id, marathon.id, retired.id]).size &&
    [habit.id, marathon.id, retired.id].every(
      (id) => awardsPayload.habits.some((h) => h.id === id)),
  JSON.stringify(awardsPayload.habits.map((h) => h.id)));
ck('the archived habit specifically is present',
  awardsPayload.habits.some((h) => h.id === retired.id),
  JSON.stringify(awardsPayload.habits.map((h) => h.id)));
ck('account is present and is an array (reserved for #63)',
  Array.isArray(awardsPayload.account) && awardsPayload.account.length === 0,
  JSON.stringify(awardsPayload.account));

// No range parameter has any influence: the route takes none, and a caller
// that sends one anyway (an old bookmark, a copy-pasted URL) must be ignored
// rather than answered differently or refused.
const withParams = await get(
  `/awards?start=${daysAgo(10)}&end=${daysAgo(1)}&granularity=month`);
ck('?start, ?end and ?granularity change nothing',
  JSON.stringify(withParams) === JSON.stringify(awardsPayload),
  `plain=${JSON.stringify(awardsPayload)} withParams=${JSON.stringify(withParams)}`);

/* ---------- 4. the `awards` setting is a RENDERING switch (#140) ---------- */

console.log('\n--- the awards off switch changes no API answer ---');

// A value the server does not enumerate is dropped, not stored — the same
// `SETTING_VALUES` enforcement every other toggle here gets.
const badAwards = await put('/settings', { awards: 'yes' });
ck('a non-boolean value is rejected',
  badAwards.ignored?.includes('awards') && badAwards.settings.awards === undefined,
  JSON.stringify(badAwards));

await put('/settings', { awards: false });
ck('a real boolean is stored and comes back from GET /settings',
  (await get('/settings')).awards === false,
  JSON.stringify(await get('/settings')));

// The pinned claim: this is a RENDERING preference, so both routes must go on
// reporting the identical awards whether the switch is on or off. Reusing the
// `marathon` habit above, which already earned two award families — the same
// property the deepEqual check needs, restated here so a route that started
// reading the setting would have somewhere for the difference to show up.
const withOff = {
  awards: (await get('/awards')).habits.find((h) => h.id === marathon.id).awards,
  stats: (await get(`/habits/${marathon.id}/stats`)).awards,
};
await put('/settings', { awards: true });
const withOn = {
  awards: (await get('/awards')).habits.find((h) => h.id === marathon.id).awards,
  stats: (await get(`/habits/${marathon.id}/stats`)).awards,
};
ck('GET /awards is unchanged by the setting',
  JSON.stringify(withOff.awards) === JSON.stringify(withOn.awards),
  `off=${JSON.stringify(withOff.awards)} on=${JSON.stringify(withOn.awards)}`);
ck('GET /habits/:id/stats is unchanged by the setting',
  JSON.stringify(withOff.stats) === JSON.stringify(withOn.stats),
  `off=${JSON.stringify(withOff.stats)} on=${JSON.stringify(withOn.stats)}`);
// Worthless unless there is something here to have gone missing.
ck('  and there is something on both sides for that comparison to mean anything',
  withOff.awards.length > 0 && withOn.awards.length > 0,
  `off=${JSON.stringify(withOff.awards)} on=${JSON.stringify(withOn.awards)}`);

server.close();
try { (await import('../src/db.js')).db.close(); } catch { /* already closed */ }
try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${fails === 0 ? 'all award checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
