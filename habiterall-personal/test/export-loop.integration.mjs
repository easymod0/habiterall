/**
 * What `GET /api/export-loop.db` does when the account already holds a date
 * that is not a real day.
 *
 * `isoToLoopTimestamp` is `Date.UTC`, which rolls over rather than refusing, so
 * `2026-02-30` became 2026-03-02 on the way out. With a real row on that day
 * the UNIQUE index on (habit, timestamp) rejected the insert, the rejection
 * escaped `writeLoopDatabase`, and the route answered **500 — permanently**,
 * naming neither the habit nor the date. The user's own backup, restored, is
 * how the row got there; nothing they could see said which one it was.
 *
 * This drives the real server because the failure was a 500 from a route: the
 * unit suite can prove the writer returns a report, only this can prove the
 * request comes back 200 with a file on it and says so on the way past.
 *
 * The bad row is INSERTed straight into storage rather than posted through
 * `/api/import`, and deliberately. The import writer is where such a row gets
 * in today and #85 is closing that door — after which an import-based setup
 * would stop reproducing anything, while the accounts that already hold one
 * would still be broken. "However it got there" is the case under test.
 *
 *   node test/export-loop.integration.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-exportloop-'));
// Both off before the server module is imported, exactly as HABITERALL_DB must
// be — this suite exercises the export, not sign-in or rate limiting.
process.env.HABITERALL_AUTH = 'off';
process.env.HABITERALL_RATE_LIMIT = 'off';
process.env.HABITERALL_DB = join(workdir, 'exportloop.db');

const { app } = await import('../src/server.js');
// The same DatabaseSync instance the routes hold, so there is no second
// connection to fight WAL over.
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

/* ---------- an account with one impossible date in it ---------- */

const habit = await post('/habits', { name: 'Meditate', type: 'boolean' });

// Two real days, recorded the way anyone would. The notes are not decoration:
// 2026-02-30 rolls over ONTO 2026-03-02, so without something telling the two
// rows apart, a suite that checks only dates and counts cannot see which of
// them survived — see the assertion below.
await put(`/habits/${habit.id}/entries/2026-03-02`, { value: 2, notes: 'the real day' });
await put(`/habits/${habit.id}/entries/2026-03-03`, { value: 2 });

// And the row the API itself will not write. Confirm that first, because if
// this ever starts succeeding the premise of the whole suite has moved.
const refused = await fetch(
  `${base}/api/habits/${habit.id}/entries/2026-02-30`,
  {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 2 }),
  });
ck('the API still refuses an impossible date', refused.status === 400,
  `status=${refused.status}`);

db.prepare(
  `INSERT INTO entries (habit_id, date, value, status, notes) VALUES (?, ?, ?, ?, ?)`
).run(habit.id, '2026-02-30', 2, '', 'the impossible one');

const stored = db.prepare(
  `SELECT date FROM entries WHERE habit_id = ? ORDER BY date`).all(habit.id);
ck('the account now holds a date that is not a day',
  stored.some((r) => r.date === '2026-02-30'),
  stored.map((r) => r.date).join(' '));

/* ---------- the export ---------- */

const res = await fetch(`${base}/api/export-loop.db`);
const body = Buffer.from(await res.arrayBuffer());

ck('the export answers 200 rather than 500', res.status === 200,
  `status=${res.status}`);
ck('and the body is a real SQLite file',
  body.subarray(0, 15).toString('latin1') === 'SQLite format 3',
  `${body.length} bytes`);
ck('the response says how many rows did not make it',
  res.headers.get('x-habiterall-export-skipped') === '1',
  `header=${res.headers.get('x-habiterall-export-skipped')}`);

/* ---------- and nothing good was dropped on the way ---------- */

const loopPath = join(workdir, 'exported.db');
const { writeFileSync } = await import('node:fs');
writeFileSync(loopPath, body);

const { parseLoopDatabase } = await import('@habiterall/shared/import.js');
const [exported] = await parseLoopDatabase(loopPath);

ck('every real day survives', exported != null &&
  exported.entries.map((e) => e.date).join(' ') === '2026-03-02 2026-03-03',
  exported?.entries.map((e) => e.date).join(' '));

// The failure this replaced silence with: writing the rolled-over day would
// also produce a 200 here, with 2026-03-02 holding whichever row won.
ck('and no day is invented for the row that was skipped',
  exported != null && exported.entries.length === 2,
  String(exported?.entries.length));

// Which row won is the assertion that actually pins the encodability gate.
// Take the gate away and the seen-set still stops the UNIQUE violation, still
// reports one skipped row, and still exports two days called 2026-03-02 and
// 2026-03-03 — but `2026-02-30` sorts first, so it claims that timestamp and
// the REAL day is the one dropped. Every check above passes on that. Only the
// note tells them apart.
ck('and the day that survived is the real one, not the rolled-over ghost',
  exported?.entries.find((e) => e.date === '2026-03-02')?.notes === 'the real day',
  JSON.stringify(exported?.entries.find((e) => e.date === '2026-03-02')));

/* ---------- a clean account is untouched by any of it ---------- */

const clean = await post('/habits', { name: 'Water', type: 'boolean' });
await put(`/habits/${clean.id}/entries/2026-03-02`, { value: 2 });

db.prepare(`DELETE FROM entries WHERE habit_id = ? AND date = ?`)
  .run(habit.id, '2026-02-30');

const ok = await fetch(`${base}/api/export-loop.db`);
await ok.arrayBuffer();
ck('with the bad row gone, nothing is reported',
  ok.status === 200 && ok.headers.get('x-habiterall-export-skipped') === null,
  `status=${ok.status} header=${ok.headers.get('x-habiterall-export-skipped')}`);

/* ---------- done ---------- */

server.close();
db.close();
rmSync(workdir, { recursive: true, force: true });

console.log(fails ? `\n${fails} check(s) failed` : '\nall export checks passed');
process.exit(fails ? 1 : 0);
