/**
 * Whose calendar day a route judges by.
 *
 * `today()` is the SERVER PROCESS's day, and every route that asked "is this
 * today?" asked it that way. Both compose files ship a container in UTC, so
 * for a user east of the server the current column of their own grid is a
 * future date: the tap was refused with `cannot record entries in the future`
 * — a sentence that is false about the user's own calendar — for as many
 * hours a day as the offset. Thirteen of them in Auckland.
 *
 * The same date clamps the read anchors, so the half of this that is not a
 * refusal is a silence: a day that WAS recorded is scored as of the server's
 * yesterday, and the streak sits still at the moment it is being watched.
 *
 * This drives the real server, because the bug is in the routes rather than
 * in the arithmetic underneath them — `assertNotFuture` guards the write,
 * `computeStats` is what `/habits/:id/stats` reads, and `summaryStats` is what
 * `/overview`'s streak below reads now, and all three were always doing
 * exactly as they were told. (This is the only suite that checks
 * `summaryStats`'s caller-day anchor at route level.)
 *
 * The two zones are chosen so this suite says the same thing at every hour.
 * Etc/GMT+12 and Pacific/Kiritimati are 26 hours apart, which is the whole
 * spread of the Earth, so the caller's date is ALWAYS ahead of the server's
 * — by two days for part of the day, which is also the answer to "why not
 * just allow tomorrow".
 *
 *   node test/callerday.integration.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-callerday-'));

// Set before the server module is imported, exactly as HABITERALL_DB must be.
// TZ is the point of the suite: it puts the process at the far west while the
// client claims the far east, which is the shape of the bug on a default
// container (UTC) with a user anywhere east of it.
process.env.TZ = 'Etc/GMT+12';
process.env.HABITERALL_AUTH = 'off';
process.env.HABITERALL_RATE_LIMIT = 'off';
process.env.HABITERALL_DB = join(workdir, 'callerday.db');

const CLIENT_ZONE = 'Pacific/Kiritimati';

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

/** The calendar day in a zone, computed the way a client's own clock would. */
const dayIn = (zone, offsetDays = 0) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(Date.now());
  const at = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const d = new Date(`${at.year}-${at.month}-${at.day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const CLIENT_TODAY = dayIn(CLIENT_ZONE);
const CLIENT_TOMORROW = dayIn(CLIENT_ZONE, 1);
const SERVER_TODAY = dayIn(process.env.TZ);

// The premise. If this ever fails the rest of the suite is meaningless rather
// than passing, so it is asserted rather than assumed.
ck('the caller is a day or more ahead of the server',
  CLIENT_TODAY > SERVER_TODAY, `${CLIENT_TODAY} > ${SERVER_TODAY}`);

/** A request as a real client makes it — both clients send this header. */
const asClient = (extra = {}) => ({
  'Content-Type': 'application/json',
  'X-Habiterall-Timezone': CLIENT_ZONE,
  ...extra,
});

const post = (path, body) => fetch(`${base}/api${path}`, {
  method: 'POST', headers: asClient(), body: JSON.stringify(body),
}).then((r) => r.json());

const put = (path, body, headers = asClient()) => fetch(`${base}/api${path}`, {
  method: 'PUT', headers, body: JSON.stringify(body),
});

const get = (path, headers = { 'X-Habiterall-Timezone': CLIENT_ZONE }) =>
  fetch(`${base}/api${path}`, { headers });

const habit = await post('/habits', { name: 'Reachable', type: 'boolean' });

/* ---------- the write ---------- */

const wrote = await put(`/habits/${habit.id}/entries/${CLIENT_TODAY}`, { value: 2 });
ck('the day on the caller\'s own grid can be recorded',
  wrote.status === 200, `HTTP ${wrote.status} for ${CLIENT_TODAY}`);

const stored = await get(`/habits/${habit.id}/entries`).then((r) => r.json());
ck('...and the row is really there',
  stored.some((e) => e.date === CLIENT_TODAY && e.value === 2),
  JSON.stringify(stored));

// Still a guard, and still exact — it is the caller's day it is exact about.
// Without this the fix would read as "the future check was removed".
const future = await put(
  `/habits/${habit.id}/entries/${CLIENT_TOMORROW}`, { value: 2 });
ck('the caller\'s tomorrow is still refused',
  future.status === 400, `HTTP ${future.status} for ${CLIENT_TOMORROW}`);

// A caller that reports no zone is one the server cannot place, so it keeps
// the server's clock — which is what it had before any of this. Deliberate,
// and pinned so that widening it later is a decision rather than a drift.
const unplaced = await put(
  `/habits/${habit.id}/entries/${CLIENT_TODAY}`, { value: 2 },
  { 'Content-Type': 'application/json' });
ck('a caller that says nothing is judged by the server\'s clock',
  unplaced.status === 400, `HTTP ${unplaced.status}`);

/* ---------- the read anchors ---------- */

// The other half, and the one with no error message. `end` decides the grid
// window; `summaryEnd` decides what the streak is computed as of. Both were
// the server's day, so a caller east of it painted a grid that stopped short
// of today and read a summary as of yesterday.
await put(`/habits/${habit.id}/entries/${dayIn(CLIENT_ZONE, -1)}`, { value: 2 });

const view = await get('/overview?days=30').then((r) => r.json());
const row = view.habits.find((h) => h.id === habit.id);

ck('the grid window reaches the caller\'s today',
  view.end === CLIENT_TODAY, `end=${view.end}, wanted ${CLIENT_TODAY}`);
ck('...so today\'s cell is painted from a row, not left blank',
  row.entries[CLIENT_TODAY] === 2, JSON.stringify(row.entries));

// Two consecutive days, ending on the caller's today. Anchored on the
// server's day this is 0 or 1 depending on the hour — never 2 — so this one
// assertion fails both against the unfixed server and against a server where
// only the write guard was moved.
ck('the streak is counted as of the caller\'s today',
  row.currentStreak === 2, `currentStreak=${row.currentStreak}`);

// The detail view's range controls ask for a window starting today, which the
// clamp turned into `start > end` and a 400 — a range the user can select and
// the server refuses.
const statsToday = await get(
  `/habits/${habit.id}/stats?start=${CLIENT_TODAY}&granularity=day`);
ck('a stats range starting today is a range the server will compute',
  statsToday.status === 200, `HTTP ${statsToday.status}`);

const unplacedStats = await fetch(
  `${base}/api/habits/${habit.id}/stats?start=${CLIENT_TODAY}&granularity=day`);
ck('...and an unplaced caller still gets the server\'s clock here too',
  unplacedStats.status === 400, `HTTP ${unplacedStats.status}`);

server.close();
rmSync(workdir, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
