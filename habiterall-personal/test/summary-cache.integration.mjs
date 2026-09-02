/**
 * The habit summary cache (#184) — `best_streak` and `total_completed`,
 * cached beside the habit as `summary_asof`. The rule for what the pair means
 * and when it is stale is `@habiterall/shared/summary-cache.js`, shared with
 * the cloud edition; this pins the WIRING, which a shared rule cannot: that a
 * write actually reaches `clearHabitSummary`, that a cache HIT is genuinely
 * served rather than silently ignored, and that the cold path — every stamp
 * cleared at once — still gets `score`/`currentStreak` right over the
 * 400-day slice this edition derives by FILTERING the 1830-day one rather
 * than fetching it a second time.
 *
 * Personal has no `data_version` and no `withUserWrite` to hang invalidation
 * off of, unlike cloud (`habiterall-cloud/src/db/pool.js`) — every write site
 * calls `clearHabitSummary`/`clearAllSummaries` by hand (`src/db.js`,
 * `src/api.js`, `src/apply-import.js`), so this is the one place that wiring
 * is exercised end to end rather than read off the source.
 *
 *   node test/summary-cache.integration.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-summarycache-'));
// This suite exercises the API, not sign-in or rate limiting, and auth now
// defaults ON — see shared/src/password.js. Both are turned off explicitly
// here, before the server module is imported, exactly as HABITERALL_DB must
// be.
process.env.HABITERALL_AUTH = 'off';
process.env.HABITERALL_RATE_LIMIT = 'off';
process.env.HABITERALL_DB = join(workdir, 'summarycache.db');

const { app } = await import('../src/server.js');
// The same DatabaseSync instance the routes hold, so a row planted or read
// directly below is visible to them without a second connection to fight WAL
// over — the same pattern overview.integration.mjs uses for its phantom row.
const { db, clearAllSummaries } = await import('../src/db.js');
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

/** `n` days ago on the LOCAL calendar, which is the calendar the server keeps. */
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const daysAhead = (n) => daysAgo(-n);

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

const overview = () => fetch(`${base}/api/overview?days=7`).then((r) => r.json());

/** The habit row exactly as storage holds it, cache columns included. */
const rawHabit = (id) => db.prepare(`SELECT * FROM habits WHERE id = ?`).get(id);

/* ---- 1: a write clears the stamp ---------------------------------------- */

const habitA = await post('/habits', { name: 'Stamp clears', type: 'boolean' });

// First load: the row has never been computed, so this is the stale path —
// it stamps the row for the caller's own today.
const firstLoad = await overview();
const rowAfterFirst = rawHabit(habitA.id);
ck('a fresh habit is stamped after its first /overview load',
  typeof rowAfterFirst.summary_asof === 'string' && rowAfterFirst.summary_asof.length > 0,
  JSON.stringify(rowAfterFirst));

const totalBefore = firstLoad.habits.find((h) => h.id === habitA.id)?.totalCompleted;
ck('sanity: nothing completed on habitA yet', totalBefore === 0, String(totalBefore));

// Second load, no write in between: this is the cache HIT this test's own
// stamp above set up — asserted structurally (the stamp still matches the
// row read a moment ago) rather than by timing, which nothing here can see.
const secondLoad = await overview();
ck('a second load with nothing written is still describing the same cached day',
  secondLoad.habits.find((h) => h.id === habitA.id)?.totalCompleted === totalBefore,
  String(secondLoad.habits.find((h) => h.id === habitA.id)?.totalCompleted));

await put(`/habits/${habitA.id}/entries/${daysAgo(0)}`, { value: 2 });

const rowAfterWrite = rawHabit(habitA.id);
ck('a write clears the stamp',
  rowAfterWrite.summary_asof === null, JSON.stringify(rowAfterWrite));

const thirdLoad = await overview();
const totalAfter = thirdLoad.habits.find((h) => h.id === habitA.id)?.totalCompleted;
ck('THE assertion: the next load reports the NEW totalCompleted, not the stale one',
  totalAfter === totalBefore + 1, `${totalAfter} vs ${totalBefore}`);

/* ---- 2: the day rollover -------------------------------------------------
 *
 * A stamp behind today (YESTERDAY, as the brief for this test names it) is
 * recomputed either way `summaryCacheHit` spells its day comparison —
 * `asof !== summaryEnd` and `asof < summaryEnd` agree whenever `asof` is
 * chronologically BEFORE `summaryEnd`, so that fixture alone cannot
 * distinguish the two. The shared file's own comment names the direction
 * that does: "`summaryEnd` is the CALLER's day, so an account used from two
 * zones can move it BACKWARDS across a date boundary" — a stamp built for
 * what was then "today" can be AHEAD of a later request's `summaryEnd`, and
 * only there does `!==` (stale) and `<` (still "fresh") disagree. Both
 * fixtures are exercised below, on the same habit, so the yesterday case is
 * asserted exactly as specified and the tomorrow case is what actually
 * proves the named mutation.
 */

const habitB = await post('/habits', { name: 'Rollover', type: 'boolean' });
// A real streak so the recomputed figures are non-trivial and distinguishable
// from the deliberately wrong pairs planted below.
for (let i = 4; i >= 0; i--) {
  await put(`/habits/${habitB.id}/entries/${daysAgo(i)}`, { value: 2 });
}
await overview(); // stamps habitB for today, off the real streak above.

const yesterday = daysAgo(1);
db.prepare(
  `UPDATE habits SET best_streak = ?, total_completed = ?, summary_asof = ? WHERE id = ?`
).run(9999, 9999, yesterday, habitB.id);

const afterYesterday = await overview();
const rowAfterYesterday = rawHabit(habitB.id);
const payloadAfterYesterday = afterYesterday.habits.find((h) => h.id === habitB.id);

ck('a stamp dated yesterday is recomputed, not served as the planted 9999 pair',
  payloadAfterYesterday.totalCompleted === 5 && payloadAfterYesterday.bestStreak === 5,
  JSON.stringify(payloadAfterYesterday));
ck('...and the stamp moves off yesterday, onto today',
  rowAfterYesterday.summary_asof === daysAgo(0),
  JSON.stringify({ row: rowAfterYesterday, yesterday, today: daysAgo(0) }));

const tomorrow = daysAhead(1);
db.prepare(
  `UPDATE habits SET best_streak = ?, total_completed = ?, summary_asof = ? WHERE id = ?`
).run(9999, 9999, tomorrow, habitB.id);

const afterTomorrow = await overview();
const rowAfterTomorrow = rawHabit(habitB.id);
const payloadAfterTomorrow = afterTomorrow.habits.find((h) => h.id === habitB.id);

ck('THE assertion: a stamp dated ahead of today is ALSO recomputed, not served ' +
  'as fresh — this is the direction `!==` vs `<` disagree on',
  payloadAfterTomorrow.totalCompleted === 5 && payloadAfterTomorrow.bestStreak === 5,
  JSON.stringify(payloadAfterTomorrow));
ck('...and the stamp moves off tomorrow, onto today',
  rowAfterTomorrow.summary_asof === daysAgo(0),
  JSON.stringify({ row: rowAfterTomorrow, tomorrow, today: daysAgo(0) }));

/* ---- 3: a cache HIT is genuinely served, not silently recomputed -------- */

const habitC = await post('/habits', { name: 'Cache hit', type: 'boolean' });
await put(`/habits/${habitC.id}/entries/${daysAgo(0)}`, { value: 2 });
// One real completion, so the true totalCompleted is 1 and the wrong,
// planted value below (777) cannot be mistaken for a correct recompute.
db.prepare(
  `UPDATE habits SET best_streak = ?, total_completed = ?, summary_asof = ? WHERE id = ?`
).run(777, 777, daysAgo(0), habitC.id);

const cacheHitLoad = await overview();
const cacheHitRow = cacheHitLoad.habits.find((h) => h.id === habitC.id);

ck('THE assertion: /overview serves the deliberately WRONG cached pair, ' +
  'proving it is read off the row rather than recomputed — without this, ' +
  'every other test here passes against a build that ignores the cache ' +
  'entirely',
  cacheHitRow.bestStreak === 777 && cacheHitRow.totalCompleted === 777,
  JSON.stringify(cacheHitRow));

/* ---- 4: score and currentStreak are right on the COLD path -------------- */

const habitD = await post('/habits', { name: 'Cold path', type: 'boolean' });
for (let i = 9; i >= 0; i--) {
  await put(`/habits/${habitD.id}/entries/${daysAgo(i)}`, { value: 2 });
}
// Every write above already cleared habitD's own stamp; clearAllSummaries is
// exercised for its own sake here (the replace-mode import's own call, and
// the shape "clear every stamp at once" the cold path — the first load of
// any day, or right after a restart — actually is) rather than trusting that
// habitD merely happens to already be uncached.
clearAllSummaries();

const coldLoad = await overview();
const coldRow = coldLoad.habits.find((h) => h.id === habitD.id);

ck('THE assertion: score is non-zero on the cold path, over the FILTERED slice',
  typeof coldRow.score === 'number' && coldRow.score > 0, String(coldRow.score));
ck('...and currentStreak sees the live ten-day run, not an empty derived slice',
  coldRow.currentStreak === 10, String(coldRow.currentStreak));

server.close();
try { (await import('../src/db.js')).db.close(); } catch { /* already closed */ }
try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${fails === 0 ? 'the summary cache is wired correctly' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
