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

server.close();
try { (await import('../src/db.js')).db.close(); } catch { /* already closed */ }
try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${fails === 0 ? 'all award checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
