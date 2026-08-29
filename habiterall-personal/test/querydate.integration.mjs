/**
 * Which validator a route asks about a date it takes into a RANGE.
 *
 * `DATE_RE` is four digits, a dash, two digits, a dash, two digits, and
 * nothing more — so `2026-00-10` and `2026-02-30` are shaped like dates and
 * are not days. Every route below passed one straight into the window
 * arithmetic, and the two halves of that arithmetic then disagreed: `fromISO`
 * ROLLS a bad component over, so `?end=2026-00-10` walked a history ending
 * 2025-12-10, while `totalCompleted` selects by the string comparison
 * `date <= '2026-00-10'`, which admits every real day up to 2025-12-31. Three
 * completions reported beside a six-day window that can hold at most one —
 * under a comment claiming the two are bounded identically.
 *
 * This drives the real server because that is the only thing that can show it.
 * `assertDate` has its own unit tests and they pin the RULE; nothing in
 * `shared/test/` can say which of the two validators a route reaches for, and
 * a route calling the weaker one satisfies every unit test in the repo.
 *
 *   node test/querydate.integration.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-querydate-'));

// Set before the server module is imported, exactly as HABITERALL_DB must be.
// Auth and the limiter are off for the same reason every other integration
// suite here turns them off: what is under test is the API, not sign-in.
process.env.HABITERALL_AUTH = 'off';
process.env.HABITERALL_RATE_LIMIT = 'off';
process.env.HABITERALL_DB = join(workdir, 'querydate.db');

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

const get = (path) => fetch(`${base}/api${path}`);

const habit = await (await fetch(`${base}/api/habits`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Query date', type: 'boolean' }),
})).json();

/**
 * Three completions, spread so that the pre-fix answer to `?end=2026-00-10`
 * and the honest answer to a canonical `?end=2025-12-10` are different
 * NUMBERS rather than the same one reached two ways. The last two sit after
 * the honest window closes and inside the string comparison's reach, which is
 * the whole of the disagreement.
 */
const SEEDED = ['2025-12-05', '2025-12-20', '2025-12-31'];
for (const date of SEEDED) {
  await fetch(`${base}/api/habits/${habit.id}/entries/${date}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 2 }),
  });
}

/* ---------- the shape is right and the day does not exist ---------- */

// Month 00. `fromISO` rolls it back into the previous December, so this is the
// date the wrong number above was measured on.
const NOT_A_MONTH = '2026-00-10';
// A real-looking day of a real month that this year does not have. The other
// half of the same gap, and the one a person could type by hand.
const NOT_A_DAY = '2026-02-30';

for (const [route, path] of [
  ['/habits/:id/stats', `/habits/${habit.id}/stats`],
  ['/categories/stats', '/categories/stats'],
  ['/overview', '/overview'],
]) {
  for (const bad of [NOT_A_MONTH, NOT_A_DAY]) {
    const r = await get(`${path}?end=${bad}`);
    ck(`GET ${route}?end=${bad} is 400`, r.status === 400, `HTTP ${r.status}`);
  }
}

// `start` had the same gap as `end` on the two routes that take one. NO client
// sends it — `ui/detail.js` and `ui/categories.js` ask for a granularity and
// nothing else, and the only date any client sends is `ui/dashboard.js`'s
// `end` on `/overview` — which is why tightening it costs nothing, and is the
// reason to say so here rather than leave a reader guessing what the new 400
// can reach.
for (const [route, path] of [
  ['/habits/:id/stats', `/habits/${habit.id}/stats`],
  ['/categories/stats', '/categories/stats'],
]) {
  for (const bad of [NOT_A_MONTH, NOT_A_DAY]) {
    const r = await get(`${path}?start=${bad}`);
    ck(`GET ${route}?start=${bad} is 400`, r.status === 400, `HTTP ${r.status}`);
  }
}

/* ---------- ...and a real day is still answered ----------
 *
 * The control. Without it this suite passes against a server that answers 400
 * to every request it is given, which is not the fix. */

for (const [route, path] of [
  ['/habits/:id/stats', `/habits/${habit.id}/stats`],
  ['/categories/stats', '/categories/stats'],
  ['/overview', '/overview'],
]) {
  const r = await get(`${path}?end=2025-12-10`);
  ck(`GET ${route}?end=2025-12-10 is still 200`, r.status === 200, `HTTP ${r.status}`);
}

const withStart = await get(`/habits/${habit.id}/stats?start=2025-12-01&end=2025-12-10`);
ck('...and a canonical start is answered too',
  withStart.status === 200, `HTTP ${withStart.status}`);

/* ---------- THE assertion: the wrong NUMBER is gone ----------
 *
 * A 400 proves the guard fired; it does not prove the figure it was guarding
 * was ever wrong. `2025-12-10` is the day `fromISO('2026-00-10')` rolls back
 * to, so this is the same window the broken request walked — and over it the
 * habit has exactly ONE completion, against the three the broken request
 * counted by string comparison. The literals are written out rather than
 * derived from SEEDED: a count computed from the fixture would agree with
 * whatever the route did to it. */

const honest = await (await get(`/habits/${habit.id}/stats?end=2025-12-10`)).json();
ck('the window the broken request walked holds 6 days',
  honest.history?.length === 6, `history.length=${honest.history?.length}`);
ck('THE assertion: and exactly ONE completion in it — the broken request ' +
  'reported 3, counted by `date <= "2026-00-10"` over a window ending 2025-12-10',
  honest.totalCompleted === 1, `totalCompleted=${honest.totalCompleted}`);

/* ---------- the two shapes `DATE_RE.test` coerced ---------- */

// A REPEATED parameter is an array, and `DATE_RE.test` string-coerced it: the
// joined `'2025-12-10,2026-01-01'` matched nothing, so the route quietly
// answered about today instead of about either date the caller named.
// `queryDate`'s `typeof` guard is what makes that a 400 — and it is also what
// keeps a ONE-element array (which `query parser: 'extended'` would produce
// from `?end[]=`, and this app's default 'simple' parser cannot) out of
// `assertDate`, where it passes the coerced regex test and then meets
// `.split` as a TypeError, i.e. a 500.
const arrayEnd = await get(`/habits/${habit.id}/stats?end=2025-12-10&end=2026-01-01`);
ck('a repeated `end` is 400, not a silent fallback to today',
  arrayEnd.status === 400, `HTTP ${arrayEnd.status}`);

// Present and empty is present-and-invalid: there is nothing to guess from,
// and no client sends it. Absent is different and is the fallback below.
const emptyEnd = await get(`/habits/${habit.id}/stats?end=`);
ck('a present but empty `end=` is 400', emptyEnd.status === 400, `HTTP ${emptyEnd.status}`);

// Absence is not an error — every one of these routes has a fallback, and the
// dashboard's first request names no date at all.
const noEnd = await get(`/habits/${habit.id}/stats`);
ck('naming no date at all is still 200', noEnd.status === 200, `HTTP ${noEnd.status}`);

server.close();
try { (await import('../src/db.js')).db.close(); } catch { /* already closed */ }
try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
