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
// The same DatabaseSync instance the routes hold, so a phantom-dated row
// planted below (issue #270's last anchor site) is visible to them without a
// second connection to fight WAL over.
const { db } = await import('../src/db.js');
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

// issue #200 review: `habitSort` must be on EVERY return path, including the
// one with no habits at all — an ABSENT key is what a client reads as "an old
// server with no sort feature, so the list is already in position order", and
// that reasoning collapses the moment a CURRENT server can omit the key on any
// path. Asked before the first habit exists, deliberately.
const emptyOverview = await overview({ days: 7 });
ck("with no habits at all, /overview still carries habitSort: 'manual'",
  emptyOverview.habitSort === 'manual', JSON.stringify(emptyOverview.habitSort));

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
ck('...but ?archived=true still carries habitSort',
  'habitSort' in archivedOverview && archivedOverview.habitSort === 'manual',
  JSON.stringify(archivedOverview.habitSort));

/* ---- issue #223: /overview's bestStreak reads the same credit rule ----
 *
 * `score` and `currentStreak` come from `summaryStats`, which goes through
 * `resolveWindow`; `bestStreak` is a streak scan the ROUTE does itself, over a
 * wider window and starting at the earliest row of any kind. So the credit date
 * has to be handed to it explicitly, and until it was, this route served
 * `bestStreak: 365` for a habit whose own `/stats` page said 1 — same habit,
 * same second, three figures from two rules.
 *
 * A limit habit whose unlogged days count as kept, holding ONE skip a year ago
 * and nothing else. That is the issue's own fixture, and it is the shape where
 * the two rules disagree maximally: the skip contributes nothing to any run
 * while being the only row in the habit's history. Both figures are asserted as
 * literals, and the cloud edition's API suite asserts the SAME literals over its
 * own implementation of this route — the two editions ship one route surface
 * from two code paths and have drifted before.
 */
const limit = await post('/habits', {
  name: 'Coffee', type: 'numerical', target_type: 'at_most', target_value: 2,
  at_most_unlogged: 'success', unit: 'cups',
});
await put(`/habits/${limit.id}/entries/${daysAgo(365)}`, { status: 'skip' });

const withLimit = await overview({ days: 7 });
const limitRow = withLimit.habits.find((h) => h.id === limit.id);
const limitStats = await fetch(`${base}/api/habits/${limit.id}/stats`).then((r) => r.json());

ck('a skip-only limit habit reports no unearned best streak on /overview',
  limitRow.bestStreak === 1, String(limitRow.bestStreak));
ck('...and /overview agrees with /stats about all three figures',
  limitRow.bestStreak === limitStats.bestStreak
  && limitRow.currentStreak === limitStats.currentStreak
  && limitRow.score === limitStats.score,
  `overview ${limitRow.score}/${limitRow.currentStreak}/${limitRow.bestStreak} vs `
  + `stats ${limitStats.score}/${limitStats.currentStreak}/${limitStats.bestStreak}`);
ck('the habit is genuinely resolved to success, or this fixture proves nothing',
  limitRow.unlogged_is_success === true, String(limitRow.unlogged_is_success));
ck('a habit with zero completions still says so',
  limitRow.totalCompleted === 0, String(limitRow.totalCompleted));

// The other half of the same rule: a stored LAPSE is real evidence, so the same
// habit shape with a 0 row a year ago DOES keep its long best streak. Without
// this the assertions above pass against a route that credits nothing ever.
const lapsing = await post('/habits', {
  name: 'Soda', type: 'numerical', target_type: 'at_most', target_value: 2,
  at_most_unlogged: 'success', unit: 'cans',
});
await put(`/habits/${lapsing.id}/entries/${daysAgo(365)}`, { value: 0 });

const withLapse = await overview({ days: 7 });
const lapseRow = withLapse.habits.find((h) => h.id === lapsing.id);
const lapseStats = await fetch(`${base}/api/habits/${lapsing.id}/stats`)
  .then((r) => r.json());

/* The shape the first round of this fix got wrong, and the reason the credit
 * date is a LIFETIME date rather than one derived from whichever slice a figure
 * happens to read. This route reads 400 days for `score`/`currentStreak` and
 * 1830 for its own `bestStreak` scan, so a limit habit answered 500 days ago and
 * skipped since holds nothing but a skip inside the narrow slice — which reads
 * as "never answered" while the habit's own page, over lifetime rows, sees the
 * answer and credits from it. Measured: master agreed at 1.000 on both surfaces;
 * a slice-derived credit date read 0.051922 here against 1.000 there, with
 * `bestStreak` on this same payload disagreeing with both because its wider
 * slice COULD see the answer. Every fixture above puts its only row 365 days
 * back, inside both windows, where the two derivations agree and neither can
 * fail — which is exactly why this one is here. */
const oldAnswer = await post('/habits', {
  name: 'Wine', type: 'numerical', target_type: 'at_most', target_value: 2,
  at_most_unlogged: 'success', unit: 'glasses',
});
await put(`/habits/${oldAnswer.id}/entries/${daysAgo(500)}`, { value: 1 });
await put(`/habits/${oldAnswer.id}/entries/${daysAgo(350)}`, { status: 'skip' });

const withOld = await overview({ days: 7 });
const oldRow = withOld.habits.find((h) => h.id === oldAnswer.id);
const oldStats = await fetch(`${base}/api/habits/${oldAnswer.id}/stats`)
  .then((r) => r.json());

ck('a habit answered before the summary window still has its silence credited',
  oldRow.score === 1, String(oldRow.score));
ck('...so the dashboard and the detail page agree about its strength',
  oldRow.score === oldStats.score, `${oldRow.score} vs ${oldStats.score}`);
ck('...and bestStreak agrees with the score beside it rather than with a ' +
  'second credit date derived from its own wider window',
  oldRow.bestStreak === oldStats.bestStreak,
  `${oldRow.bestStreak} vs ${oldStats.bestStreak}`);

/* `currentStreak` is the one figure on this payload that does NOT agree, and it
 * is pinned WHERE IT STANDS rather than asserted into a parity that does not
 * hold. Not the credit date — both reads resolve the same one — and not
 * `unlogged`: purely the window. `summaryStats` gets a 400-day slice holding
 * nothing but the skip, and a skip cannot OPEN a run, so the streak starts the
 * day after it; the habit's own page opens at the stated answer 500 days back
 * and carries that skip through without breaking it. Older than #223,
 * reproduced identical on master, and closing it means making this route's
 * streaks a lifetime read — a behaviour change on the dashboard's hot path.
 *
 * Two LITERALS and not `oldStats.currentStreak - 151`, because the point is
 * that changing SUMMARY_WINDOW_DAYS fails here by name: widened past 500 the
 * slice sees the answer and this reads 501, narrowed below 350 it sees no row
 * at all and reads 1. A relative assertion would go on passing through both.
 * See docs/decisions/day-states.md. */
ck('...while currentStreak still disagrees, at the width of the 400-day slice',
  oldRow.currentStreak === 350, String(oldRow.currentStreak));
ck('...against the lifetime read behind the habit\'s own page',
  oldStats.currentStreak === 501, String(oldStats.currentStreak));

// ...and in ARCHIVED mode, which is the one line of the route with no other
// test on it. The grouped lifetime read that answers the credit date used to be
// skipped there — it fed only `categorySummaries`, which archived mode omits —
// so re-gating it makes this row report 0.051922 against the same habit's own
// page at 1, and nothing else in either edition's suite would notice. The row
// figures are computed either way, so the read has to run either way.
await put(`/habits/${oldAnswer.id}`, {
  name: 'Wine', type: 'numerical', target_type: 'at_most', target_value: 2,
  at_most_unlogged: 'success', unit: 'glasses', archived: true,
});
const archivedView = await overview({ days: 7, archived: 'true' });
const archivedRow = archivedView.habits.find((h) => h.id === oldAnswer.id);

ck('an archived habit\'s figures are credited from the same lifetime answer',
  archivedRow && archivedRow.score === oldStats.score,
  `${archivedRow && archivedRow.score} vs ${oldStats.score}`);
ck('...and its bestStreak too',
  archivedRow && archivedRow.bestStreak === oldStats.bestStreak,
  `${archivedRow && archivedRow.bestStreak} vs ${oldStats.bestStreak}`);

ck('a stored lapse still earns the credited best streak',
  lapseRow.bestStreak === 366, String(lapseRow.bestStreak));
ck('...and the two surfaces agree about that too',
  lapseRow.bestStreak === lapseStats.bestStreak
  && lapseRow.currentStreak === lapseStats.currentStreak,
  `overview ${lapseRow.currentStreak}/${lapseRow.bestStreak} vs `
  + `stats ${lapseStats.currentStreak}/${lapseStats.bestStreak}`);

/* ---- issue #270, the last anchor site: /overview's OWN bestStreak scan ----
 *
 * `score` and `currentStreak` above come from `summaryStats`, which goes
 * through `resolveWindow` and so already refuses a phantom row when choosing
 * where its window opens. `bestStreak` is a streak scan this route runs
 * itself, over a `streakMap` built one line above the call, and it used to
 * open at `entries[0].date` — the raw LEXICAL min out of `ORDER BY date`,
 * exactly as phantom-capable as the `MIN(date)` reads `creditAnchor` already
 * refuses. A row dated `2026-07-99` sorts before every real one in this
 * fixture, opens the window there, and `boundedRange` rolls that forward past
 * `summaryEnd` — the scan comes back empty and `bestStreak` reads 0 beside a
 * `currentStreak`/`score` that no longer do, which is the disagreement this
 * fix closes.
 *
 * The phantom row is INSERTed directly, as `export-loop.integration.mjs`
 * does: `assertDate` refuses it on every write path, so a suite proving this
 * has to plant it the way an old row (or a database predating that guard)
 * would already hold one.
 */
const phantomAnchor = await post('/habits', { name: 'PhantomAnchor', type: 'boolean' });
for (let i = 8; i >= 0; i--) {
  await put(`/habits/${phantomAnchor.id}/entries/${daysAgo(i)}`, { value: 2 });
}
// Lexically before every real row above: 40 days back is more than a month
// clear of the 9-day fixture, so `daysAgo(40)`'s 'YYYY-MM' prefix is strictly
// less than the earliest real entry's, whatever the '-99' day component sorts
// against within it.
const phantomDate = `${daysAgo(40).slice(0, 7)}-99`;
db.prepare(
  `INSERT INTO entries (habit_id, date, value, status, notes) VALUES (?, ?, ?, ?, ?)`
).run(phantomAnchor.id, phantomDate, 2, '', '');

const withPhantom = await overview({ days: 7 });
const phantomRow = withPhantom.habits.find((h) => h.id === phantomAnchor.id);
const phantomStats = await fetch(`${base}/api/habits/${phantomAnchor.id}/stats`)
  .then((r) => r.json());

ck('a phantom-dated row does not zero the route\'s own bestStreak scan',
  phantomRow.bestStreak === 9, String(phantomRow.bestStreak));
ck('...currentStreak is the live nine-day run, not zeroed by the same row',
  phantomRow.currentStreak === 9, String(phantomRow.currentStreak));
ck('...and all three figures agree with the habit\'s own page',
  phantomRow.bestStreak === phantomStats.bestStreak
  && phantomRow.currentStreak === phantomStats.currentStreak
  && phantomRow.score === phantomStats.score,
  `overview ${phantomRow.score}/${phantomRow.currentStreak}/${phantomRow.bestStreak} vs `
  + `stats ${phantomStats.score}/${phantomStats.currentStreak}/${phantomStats.bestStreak}`);

/* ---- issue #200: /overview orders the habit list by the stored `habitSort` ----
 *
 * Created in an order that is deliberately NOT name order and NOT score
 * order: Charlie first (created, so first in POSITION order) and scores
 * HIGHEST; Alpha second and scores LOWEST (no entries at all); Bravo third
 * and scores in between. So manual (`Charlie, Alpha, Bravo`), name
 * (`Alpha, Bravo, Charlie`) and strength/streak (`Charlie, Bravo, Alpha`) are
 * three genuinely different orders, and no assertion below can pass by
 * coincidence between two of them.
 */
const sortCharlie = await post('/habits', { name: 'Charlie', type: 'boolean' });
const sortAlpha = await post('/habits', { name: 'Alpha', type: 'boolean' });
const sortBravo = await post('/habits', { name: 'Bravo', type: 'boolean' });
const SORT_IDS = new Set([sortCharlie.id, sortAlpha.id, sortBravo.id]);
const sortOrderOf = (data) =>
  data.habits.filter((h) => SORT_IDS.has(h.id)).map((h) => h.name);

// Charlie: a strong, unbroken 20-day run. Bravo: a shorter 5-day one. Alpha:
// nothing, so its score and current streak are both 0.
for (let i = 19; i >= 0; i--) await put(`/habits/${sortCharlie.id}/entries/${daysAgo(i)}`, { value: 2 });
for (let i = 4; i >= 0; i--) await put(`/habits/${sortBravo.id}/entries/${daysAgo(i)}`, { value: 2 });

// A tie, deliberately: two habits in one category with IDENTICAL entries, so
// their `score` is the exact same number. `summariseByCategory`'s `best`/
// `worst` (`extremeMember`) keeps whichever member it meets FIRST on a tie —
// so this is what makes the "categorySummaries must not move" check below
// able to fail at all: a caller that fed it the SORTED array rather than the
// unsorted one would hand it these two members in a different order under
// `name` than under `manual`, and the tie would resolve to a different
// habit. Named so their creation (position) order and their name order
// disagree: TieZzz is created first and sorts LAST by name.
const tieCategory = await post('/categories', { name: 'TieCat', color: '#a3a3a3' });
const tieZzz = await post('/habits',
  { name: 'TieZzz', type: 'boolean', category_id: tieCategory.id });
const tieAaa = await post('/habits',
  { name: 'TieAaa', type: 'boolean', category_id: tieCategory.id });
for (let i = 4; i >= 0; i--) {
  await put(`/habits/${tieZzz.id}/entries/${daysAgo(i)}`, { value: 2 });
  await put(`/habits/${tieAaa.id}/entries/${daysAgo(i)}`, { value: 2 });
}

// No habitSort stored at all — not one storing 'manual' — is the case this
// asserts: the account's row for the setting does not exist yet.
const sortManual = await overview({ days: 7 });
ck('with no habitSort stored, /overview returns manual (position, id) order',
  JSON.stringify(sortOrderOf(sortManual)) === JSON.stringify(['Charlie', 'Alpha', 'Bravo']),
  JSON.stringify(sortOrderOf(sortManual)));
ck('...and the tied pair reads TieZzz first, in POSITION order',
  sortManual.categorySummaries.find((s) => s.id === tieCategory.id)?.best?.name === 'TieZzz',
  JSON.stringify(sortManual.categorySummaries.find((s) => s.id === tieCategory.id)));

await put('/settings', { habitSort: 'name' });
const sortByName = await overview({ days: 7 });
ck("habitSort: 'name' sorts A-Z, case-insensitively",
  JSON.stringify(sortOrderOf(sortByName)) === JSON.stringify(['Alpha', 'Bravo', 'Charlie']),
  JSON.stringify(sortOrderOf(sortByName)));
ck("...and the payload's own habitSort says 'name', in the SAME response that carries the order",
  sortByName.habitSort === 'name', JSON.stringify(sortByName.habitSort));

await put('/settings', { habitSort: 'strength' });
const sortByStrength = await overview({ days: 7 });
const strengthScores = sortByStrength.habits
  .filter((h) => SORT_IDS.has(h.id)).map((h) => h.score);
ck("habitSort: 'strength' sorts strongest first",
  JSON.stringify(sortOrderOf(sortByStrength)) === JSON.stringify(['Charlie', 'Bravo', 'Alpha']),
  JSON.stringify(sortOrderOf(sortByStrength)));
ck('...and the scores sorted by are genuinely different, or this proves nothing',
  new Set(strengthScores).size === 3, JSON.stringify(strengthScores));

await put('/settings', { habitSort: 'streak' });
const sortByStreak = await overview({ days: 7 });
ck("habitSort: 'streak' sorts the longest current streak first",
  JSON.stringify(sortOrderOf(sortByStreak)) === JSON.stringify(['Charlie', 'Bravo', 'Alpha']),
  JSON.stringify(sortOrderOf(sortByStreak)));

/* 'recently missed' needs its own fixture: a habit with NO entries at all is
 * not "never missed" under `computeMissRuns` — its window is a single day
 * (today), unanswered, which reads as missed TODAY. "Never missed" here means
 * a continuous, gap-free run instead. */
const rmNever = await post('/habits', { name: 'NeverMissed', type: 'boolean' });
const rmWeekAgo = await post('/habits', { name: 'MissedWeekAgo', type: 'boolean' });
const rmYesterday = await post('/habits', { name: 'MissedYesterday', type: 'boolean' });
for (let i = 9; i >= 0; i--) await put(`/habits/${rmNever.id}/entries/${daysAgo(i)}`, { value: 2 });
for (let i = 9; i >= 0; i--) {
  await put(`/habits/${rmWeekAgo.id}/entries/${daysAgo(i)}`, { value: i === 7 ? 0 : 2 });
}
for (let i = 9; i >= 0; i--) {
  await put(`/habits/${rmYesterday.id}/entries/${daysAgo(i)}`, { value: i === 1 ? 0 : 2 });
}
const RM_IDS = new Set([rmNever.id, rmWeekAgo.id, rmYesterday.id]);

await put('/settings', { habitSort: 'recently missed' });
const sortByRecentMiss = await overview({ days: 7 });
const recentMissOrder = sortByRecentMiss.habits
  .filter((h) => RM_IDS.has(h.id)).map((h) => h.name);
ck("habitSort: 'recently missed' sorts the most recent miss first, never-missed last",
  JSON.stringify(recentMissOrder)
    === JSON.stringify(['MissedYesterday', 'MissedWeekAgo', 'NeverMissed']),
  JSON.stringify(recentMissOrder));

// An unrecognised value is rejected outright, and the stored setting is left
// exactly as it was — back to 'manual' here, deliberately, rather than
// whatever the last of the sorts above happened to leave it as, so "still
// returns manual order" is asserting the REJECTION and not merely echoing
// 'recently missed' order by coincidence.
await put('/settings', { habitSort: 'manual' });
const rejectedSort = await put('/settings', { habitSort: 'nope' });
ck("PUT /settings {habitSort: 'nope'} is rejected",
  Array.isArray(rejectedSort.ignored) && rejectedSort.ignored.includes('habitSort'),
  JSON.stringify(rejectedSort));
const afterRejectedSort = await overview({ days: 7 });
ck('...and /overview still returns manual order',
  JSON.stringify(sortOrderOf(afterRejectedSort)) === JSON.stringify(['Charlie', 'Alpha', 'Bravo']),
  JSON.stringify(sortOrderOf(afterRejectedSort)));

// issue #200 review: `habitSort` on the payload must be the RESOLVED value,
// never the raw stored string. `PUT /settings` already refuses 'nope' at
// write time (above), which only pins the WRITE-time validator — it says
// nothing about a row already holding a bad value (a hand-edited database, or
// one written by an older server). So this bypasses the API and writes the
// raw string directly, the same way a stale or hand-edited row would arrive.
db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('habitSort', ?)`)
  .run(JSON.stringify('nope'));
const withRawBadSort = await overview({ days: 7 });
ck("a raw stored habitSort of 'nope' is resolved to 'manual' on the payload, never echoed raw",
  withRawBadSort.habitSort === 'manual', JSON.stringify(withRawBadSort.habitSort));
ck('...and the list is in manual (position, id) order to match',
  JSON.stringify(sortOrderOf(withRawBadSort)) === JSON.stringify(['Charlie', 'Alpha', 'Bravo']),
  JSON.stringify(sortOrderOf(withRawBadSort)));
await put('/settings', { habitSort: 'manual' });

// A sort reorders the list; it must change nothing else on any row.
const charlieManual = sortManual.habits.find((h) => h.id === sortCharlie.id);
const charlieByName = sortByName.habits.find((h) => h.id === sortCharlie.id);
ck('a sort moves the row and changes none of the figures on it',
  charlieManual.score === charlieByName.score
  && charlieManual.currentStreak === charlieByName.currentStreak
  && charlieManual.bestStreak === charlieByName.bestStreak
  && charlieManual.totalCompleted === charlieByName.totalCompleted,
  `manual ${charlieManual.score}/${charlieManual.currentStreak}/${charlieManual.bestStreak}/`
  + `${charlieManual.totalCompleted} vs name ${charlieByName.score}/${charlieByName.currentStreak}/`
  + `${charlieByName.bestStreak}/${charlieByName.totalCompleted}`);

// categorySummaries is the aggregate the unsorted-payloads rule protects —
// built from `habitPayloads` before the display sort is ever applied — and it
// must not move with the list beneath it, tie included.
ck('categorySummaries is byte-identical under manual and under name',
  JSON.stringify(sortManual.categorySummaries) === JSON.stringify(sortByName.categorySummaries),
  `${JSON.stringify(sortManual.categorySummaries)} vs ${JSON.stringify(sortByName.categorySummaries)}`);

await put('/settings', { habitSort: 'manual' });

/* ---------- POST /habits/reorder is gated on the SERVER ----------
 *
 * issue #200 review, HIGH: the drag handle is gated in `paint()` and Android
 * hides its own affordance, but a client gate is advisory. The APK ships
 * separately from the server, so an OLD build against a NEW one is the
 * ordinary state after a release — and that build has never heard of
 * `habitSort`, so it offers the drag, sends the permutation, and rewrites
 * every `position` the account has. Silently: the sorted list it is looking at
 * does not read `position`, so nothing appears to happen.
 *
 * The status is read here, which `post` above cannot do (it returns parsed
 * JSON and throws the response away), and the STORED ORDER is asserted
 * afterwards rather than only the status — a 409 that had already written the
 * positions would pass a status-only check, which is the whole defect.
 */
const rawReorder = (order) => fetch(`${base}/api/habits/reorder`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ order }),
});

/** The manual order, read by switching the sort off rather than by trusting it. */
const manualOrderNow = async () => {
  await put('/settings', { habitSort: 'manual' });
  return sortOrderOf(await overview({ days: 7 }));
};

const orderBefore = await manualOrderNow();
ck('the fixture starts in a known manual order, so a rewrite of it is visible',
  JSON.stringify(orderBefore) === JSON.stringify(['Charlie', 'Alpha', 'Bravo']),
  JSON.stringify(orderBefore));

// The permutation is a REAL one — the exact reverse — so a guard that let it
// through would be caught by the order assertion below rather than by luck.
const reversal = [sortBravo.id, sortAlpha.id, sortCharlie.id];

for (const sort of ['name', 'strength', 'streak', 'recently missed']) {
  await put('/settings', { habitSort: sort });
  const refused = await rawReorder(reversal);
  const body = await refused.json();
  ck(`POST /habits/reorder is 409 while habitSort is '${sort}'`,
    refused.status === 409, `got ${refused.status} ${JSON.stringify(body)}`);
  ck(`...and the refusal names the sort in force, not a generic message`,
    typeof body.error === 'string' && body.error.includes(sort),
    JSON.stringify(body.error));
  const after = await manualOrderNow();
  ck(`...and NOTHING was written: the manual order is untouched under '${sort}'`,
    JSON.stringify(after) === JSON.stringify(orderBefore),
    `${JSON.stringify(after)} vs ${JSON.stringify(orderBefore)}`);
}

// The other half, or the gate could simply refuse everything and pass above.
await put('/settings', { habitSort: 'manual' });
const allowed = await rawReorder(reversal);
ck('POST /habits/reorder still succeeds under manual', allowed.status === 200,
  `got ${allowed.status}`);
const reordered = await manualOrderNow();
ck('...and the permutation actually took effect',
  JSON.stringify(reordered) === JSON.stringify(['Bravo', 'Alpha', 'Charlie']),
  JSON.stringify(reordered));

// Put it back, so anything appended after this block starts where it expects.
await rawReorder([sortCharlie.id, sortAlpha.id, sortBravo.id]);
await put('/settings', { habitSort: 'manual' });

server.close();
try { (await import('../src/db.js')).db.close(); } catch { /* already closed */ }
try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${fails === 0 ? 'the summary is anchored on today' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
