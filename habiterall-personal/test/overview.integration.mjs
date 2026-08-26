/**
 * What `/overview` means by `end`.
 *
 * It answers two questions at once — which days the grid paints, and how the
 * habit is doing — and those wanted different dates. `end` decided both, so
 * paging the dashboard back a month restated the row summary as of that month:
 * "43%" and a streak of 0 sitting under the habit's name with nothing on the
 * row to say the figures had moved. The grid legitimately follows `end`; the
 * summary is a statement about today.
 *
 * This drives the real server against a throwaway database, because the split
 * is a property of the route rather than of the arithmetic underneath it —
 * `summaryStats` was always given whatever date it was handed.
 *
 *   node test/overview.integration.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-overview-'));
// This suite exercises the API, not sign-in or rate limiting, and auth now
// defaults ON — see shared/src/password.js. Both are turned off explicitly here,
// before the server module is imported, exactly as HABITERALL_DB must be.
process.env.HABITERALL_AUTH = 'off';
process.env.HABITERALL_RATE_LIMIT = 'off';
process.env.HABITERALL_DB = join(workdir, 'overview.db');

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
 *
 * `toISOString().slice(0,10)` is the obvious way to write this and is wrong
 * everywhere east of UTC: it yields tomorrow's date, `assertNotFuture` refuses
 * the write, and the suite fails with a column count. CI runs in UTC, so that
 * only ever breaks on somebody's laptop.
 */
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const post = (path, body) => fetch(`${base}/api${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const put = (path, body) => fetch(`${base}/api${path}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const overview = (params) =>
  fetch(`${base}/api/overview?${new URLSearchParams(params)}`).then((r) => r.json());

const overviewAs = (params, zone) =>
  fetch(`${base}/api/overview?${new URLSearchParams(params)}`,
    { headers: { 'X-Habiterall-Timezone': zone } }).then((r) => r.json());

const putAs = (path, body, zone) => fetch(`${base}/api${path}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Habiterall-Timezone': zone },
  body: JSON.stringify(body),
}).then((r) => r.json());

/** That zone's own "today", read the same way `callerDay` reads it. */
const todayIn = (zone) => new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const habit = await post('/habits', { name: 'Anchor', type: 'boolean' });

// A run of completions ending today, and nothing at all in the month before
// it. Paging back to that month is the case: the grid should paint an empty
// fortnight, and the summary should go on describing the streak.
const RECENT_DAYS = 10;
for (let i = 0; i < RECENT_DAYS; i++) {
  await put(`/habits/${habit.id}/entries/${daysAgo(i)}`, { value: 2 });
}

const now = await overview({ days: 7 });
const back = await overview({ days: 7, end: daysAgo(40) });

const rowOf = (data) => data.habits.find((h) => h.id === habit.id);
const today = rowOf(now);
const paged = rowOf(back);

ck('paging back does not move the strength percentage',
  paged.score === today.score, `${paged.score} vs ${today.score}`);
ck('paging back does not move the current streak',
  paged.currentStreak === today.currentStreak,
  `${paged.currentStreak} vs ${today.currentStreak}`);
ck('paging back does not drop a best streak set after that date',
  paged.bestStreak === today.bestStreak,
  `${paged.bestStreak} vs ${today.bestStreak}`);
ck('the summary is describing the run, not an empty window',
  today.currentStreak === RECENT_DAYS, String(today.currentStreak));

// ...and the half that must still follow `end`: the grid is why the parameter
// exists at all. Freezing that too would re-break the paging bug this route
// was given an `end` for in the first place.
ck('the grid window still follows end',
  back.end === daysAgo(40) && Object.keys(paged.entries).length === 0,
  `${back.end}, ${Object.keys(paged.entries).length} entries`);
ck('today\'s window still carries its entries',
  Object.keys(today.entries).length === 7,
  String(Object.keys(today.entries).length));

// `categorySummaries`: which members count is the same rule
// `computeCategoryStats` uses for `#/categories` — a never-logged member is
// excluded from the mean rather than averaged in at a strength of 0.
const category = await post('/categories', { name: 'Health', color: '#336699' });
const logged = await post('/habits',
  { name: 'Logged', type: 'boolean', category_id: category.id });
const neverLogged = await post('/habits',
  { name: 'Never logged', type: 'boolean', category_id: category.id });
await put(`/habits/${logged.id}/entries/${daysAgo(0)}`, { value: 2 });

const grouped = await overview({ days: 7 });
const summary = grouped.categorySummaries.find((s) => s.id === category.id);
const loggedRow = grouped.habits.find((h) => h.id === logged.id);

ck('a never-logged member is excluded, not averaged in at 0',
  summary && summary.members === 2 && summary.unloggedExcluded === 1,
  JSON.stringify(summary));
ck('the mean is the logged member\'s own score from this same payload',
  summary && summary.mean === loggedRow.score,
  `${summary && summary.mean} vs ${loggedRow.score}`);

const uncategorised = grouped.categorySummaries.find((s) => s.id === null);
ck('Uncategorised is always present, with id: null',
  uncategorised !== undefined, JSON.stringify(grouped.categorySummaries));

// The wiring, not just the rule: `summariseByCategory` must be handed
// `summaryEnd` — the same reading day `score` beside it was computed
// against — rather than merely "does this member have an entry at all".
// `Pacific/Kiritimati` (UTC+14) and `Pacific/Midway` (UTC-11) are 25 hours
// apart, so their calendar dates can NEVER be the same — this is
// deterministic, not a one-in-twenty-four race. Do not "simplify" this to
// two closer zones; that turns the test into one that usually asserts
// nothing.
//
// `logged` also gets a second entry, dated Midway's OWN today, so its landed
// status under the Midway-anchored read below does not depend on how the
// suite's host clock happens to relate to either zone — only `futureHabit`'s
// landing is left to the real gap between the two zones.
const futureHabit = await post('/habits',
  { name: 'FromAhead', type: 'boolean', category_id: category.id });
await putAs(`/habits/${futureHabit.id}/entries/${todayIn('Pacific/Kiritimati')}`,
  { value: 2 }, 'Pacific/Kiritimati');
await putAs(`/habits/${logged.id}/entries/${todayIn('Pacific/Midway')}`,
  { value: 2 }, 'Pacific/Midway');

const behind = await overviewAs({ days: 7 }, 'Pacific/Midway');
const behindSummary = behind.categorySummaries.find((s) => s.id === category.id);
const behindLoggedRow = behind.habits.find((h) => h.id === logged.id);
const behindFutureRow = behind.habits.find((h) => h.id === futureHabit.id);

ck('a member whose only entry is dated ahead of the reading day is excluded',
  behindSummary && behindSummary.unloggedExcluded === 2, // neverLogged + futureHabit
  JSON.stringify(behindSummary));
ck('the mean does not average in the future-dated member\'s own score',
  behindSummary && behindSummary.mean === behindLoggedRow.score,
  `${behindSummary && behindSummary.mean} vs ${behindLoggedRow.score} (future member\'s own score ${behindFutureRow.score})`);

const archivedOverview = await overview({ days: 7, archived: 'true' });
ck('?archived=true carries no categorySummaries',
  !('categorySummaries' in archivedOverview),
  JSON.stringify(Object.keys(archivedOverview)));

server.close();
try { (await import('../src/db.js')).db.close(); } catch { /* already closed */ }
try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${fails === 0 ? 'the summary is anchored on today' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
