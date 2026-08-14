/**
 * Backup round-trip fidelity, personal edition.
 *
 * Seeds a known dataset, exports it in every format the app offers, re-imports
 * each one into an empty database, and asserts the data that comes back is the
 * data that went in — to whatever fidelity the format can carry.
 *
 * Drives the real HTTP server rather than calling the parsers directly: the
 * export routes are where the encoding decisions actually live, and a parser
 * test cannot catch a route that serves the wrong thing.
 *
 *   node test/roundtrip.integration.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIXTURE, snapshot, diff, LOOP_HABIT_FIELDS,
} from '@habiterall/shared/test/roundtrip-fixture.mjs';

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

/* ---------- a server on a scratch database ---------- */

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-rt-'));
// Must be set before src/db.js is imported — it opens the file at module load.
process.env.HABITERALL_DB = join(workdir, 'roundtrip.db');

const { app } = await import('../src/server.js');

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`  server on ${base}\n  db at ${process.env.HABITERALL_DB}\n`);

const api = async (path, init) => {
  const res = await fetch(base + path, init);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res;
};

/* ---------- seed the fixture through the public API ---------- */

async function seed() {
  // The database is a fresh temp file, so there is nothing to clear first.
  for (const h of FIXTURE) {
    const created = await (await api('/api/habits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(h),
    })).json();

    for (const e of h.entries) {
      const body = e.status === 'skip'
        ? { status: 'skip', notes: e.notes }
        : { value: e.value, notes: e.notes };
      await api(`/api/habits/${created.id}/entries/${e.date}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    // Archive last: an archived habit may not accept entry writes.
    if (h.archived) {
      await api(`/api/habits/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...h, archived: true }),
      });
    }
  }
}

/** The current database contents, in the shared comparison shape. */
async function current(opts) {
  const backup = await (await api('/api/export')).json();
  return snapshot(backup.habits, opts);
}

async function restore(buffer, mode = 'replace') {
  const res = await fetch(`${base}/api/import?mode=${mode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buffer,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`import -> ${res.status} ${text}`);
  return JSON.parse(text);
}

await seed();

/* ---------- baseline ---------- */

console.log('--- baseline ---');
const baselineFull = await current();
const baselineLoop = await current({ fields: LOOP_HABIT_FIELDS, notes: false });

ck('fixture seeded', baselineFull.length === FIXTURE.length,
  `${baselineFull.length} habits`);

// Guard the guard: if the fixture did not survive being written in the first
// place, every round-trip below would compare wrong data against wrong data
// and pass.
const water = baselineFull.find((h) => h.name === 'Water');
ck('a literal 3 on a numerical habit is not a skip',
  water.entries.some((e) => e.startsWith('2026-01-06|3|') && !e.includes('|skip')),
  water.entries.find((e) => e.startsWith('2026-01-06')));

const meditate = baselineFull.find((h) => h.name === 'Meditate');
ck('a skip is stored as a skip',
  meditate.entries.some((e) => e === '2026-01-07|0|skip|'),
  meditate.entries.find((e) => e.startsWith('2026-01-07')));
ck('a note survives on a not-done day',
  meditate.entries.some((e) => e === '2026-01-08|0||overslept'),
  meditate.entries.find((e) => e.startsWith('2026-01-08')));

const reading = baselineFull.find((h) => h.name === 'Reading');
ck('a fractional target is not rounded', reading.target_value === 12.5,
  String(reading.target_value));
ck('an archived habit is exported', reading.archived === true);

const gym = baselineFull.find((h) => h.name === 'Gym');
ck('a 3-per-7 frequency survives',
  gym.freq_numerator === 3 && gym.freq_denominator === 7,
  `${gym.freq_numerator}/${gym.freq_denominator}`);

/* ---------- JSON: lossless ---------- */

console.log('\n--- JSON backup (lossless) ---');

const jsonBackup = Buffer.from(await (await api('/api/export')).text());
const jsonResult = await restore(jsonBackup);
const afterJson = await current();

ck('JSON round-trip preserves everything',
  diff(baselineFull, afterJson) === null,
  diff(baselineFull, afterJson) ?? '');
ck('JSON restore reports every habit',
  jsonResult.habitsCreated === FIXTURE.length,
  `created=${jsonResult.habitsCreated} merged=${jsonResult.habitsMerged}`);
ck('JSON restore skipped nothing',
  (jsonResult.skipped ?? []).length === 0,
  (jsonResult.skipped ?? []).join('; '));

// Importing the same backup twice must not duplicate or drift.
await restore(jsonBackup);
const afterTwice = await current();
ck('a second JSON restore is idempotent',
  diff(baselineFull, afterTwice) === null,
  diff(baselineFull, afterTwice) ?? '');

/**
 * Days that exist only because the user answered "no": a boolean habit, not
 * done, with or without a note. Derived from the fixture rather than hardcoded,
 * so adding one does not silently weaken the assertion below.
 *
 * These used to be the documented gap in the Loop and CSV round trips — a
 * boolean 0 was dropped on the way out unless a note came with it, and the
 * bare ones did not exist at all because nothing could create one. Both
 * formats have a place for them (`NO`, which is what Loop calls the same day),
 * so the gap is closed and this counts what would reopen it.
 */
function statedLapses() {
  return FIXTURE
    .filter((h) => h.type === 'boolean')
    .flatMap((h) => h.entries.filter((e) => e.status !== 'skip' && e.value === 0));
}

/* ---------- Loop .db ---------- */

console.log('\n--- Loop .db backup ---');

const loopDb = Buffer.from(await (await api('/api/export-loop.db')).arrayBuffer());
ck('the Loop export is a SQLite file',
  loopDb.subarray(0, 15).toString() === 'SQLite format 3',
  loopDb.subarray(0, 15).toString());

const loopResult = await restore(loopDb);
const afterLoop = await current({ fields: LOOP_HABIT_FIELDS, notes: false });

// Every entry, with no exception left: Loop's NO is a day habiterall can now
// both hold and write, so a stated lapse survives whether or not a note came
// with it. Notes themselves are still outside this comparison (`notes: false`),
// which is what the CSV cannot carry.
ck('Loop round-trip preserves habits and entries',
  diff(baselineLoop, afterLoop) === null,
  diff(baselineLoop, afterLoop) ?? '');

const loopMeditate = afterLoop.find((h) => h.name === 'Meditate');
ck('Loop: a stated lapse survives, with or without a note',
  statedLapses().every((e) => loopMeditate.entries.includes(`${e.date}|0|`)),
  `${statedLapses().length} lapses in the fixture; got ${loopMeditate.entries.join(' ')}`);
ck('Loop restore skipped nothing',
  (loopResult.skipped ?? []).length === 0,
  (loopResult.skipped ?? []).join('; '));

// The specific encoding traps, asserted individually so a failure names itself.
const loopWater = afterLoop.find((h) => h.name === 'Water');
ck('Loop: numerical 3 stays 3, not a skip',
  loopWater.entries.includes('2026-01-06|3|'),
  loopWater.entries.join(' '));
ck('Loop: a real skip stays a skip',
  loopWater.entries.includes('2026-01-08|0|skip'),
  loopWater.entries.join(' '));
ck('Loop: target values are not scaled by 1000',
  loopWater.target_value === 8, String(loopWater.target_value));

const loopSnacks = afterLoop.find((h) => h.name === 'Snacks');
ck('Loop: at_most target type survives',
  loopSnacks.target_type === 'at_most', loopSnacks.target_type);
ck('Loop: a zero on an at_most habit survives',
  loopSnacks.entries.includes('2026-01-05|0|'),
  loopSnacks.entries.join(' '));

const loopReading = afterLoop.find((h) => h.name === 'Reading');
ck('Loop: a fractional target survives',
  loopReading.target_value === 12.5, String(loopReading.target_value));

/* ---------- CSV ---------- */

console.log('\n--- CSV archive (Habits.csv + Checkmarks.csv) ---');

const csvZip = Buffer.from(await (await api('/api/export.csv')).arrayBuffer());
ck('the CSV export is a zip', csvZip.subarray(0, 2).toString() === 'PK',
  csvZip.subarray(0, 4).toString('hex'));

// Habits.csv carries the types, so the numbers in Checkmarks.csv are
// interpretable on the way back in. Without it every column would default to
// boolean and a measurable 3 would be read as Loop's SKIP sentinel.
const { unzip } = await import('@habiterall/shared/unzip.js');
const members = unzip(csvZip);
ck('the archive contains both CSVs',
  members.has('Habits.csv') && members.has('Checkmarks.csv'),
  [...members.keys()].join(', '));

const csvResult = await restore(csvZip);
const afterCsv = await current({ fields: LOOP_HABIT_FIELDS, notes: false });

ck('CSV restore skipped nothing',
  (csvResult.skipped ?? []).length === 0,
  (csvResult.skipped ?? []).join('; '));

// The CSV pair carries the same information the Loop .db does, so it is held to
// the same standard: every entry, notes aside.
ck('CSV round-trip preserves habits and entries',
  diff(baselineLoop, afterCsv) === null,
  diff(baselineLoop, afterCsv) ?? '');

const csvMeditate = afterCsv.find((h) => h.name === 'Meditate');
ck('CSV: a stated lapse survives as a NO cell',
  statedLapses().every((e) => csvMeditate.entries.includes(`${e.date}|0|`)),
  csvMeditate.entries.join(' '));

const csvWater = afterCsv.find((h) => h.name === 'Water');
ck('CSV: a numerical 3 stays 3, not a skip',
  csvWater.entries.includes('2026-01-06|3|'),
  csvWater.entries.join(' '));
ck('CSV: large amounts are not dropped as unknown sentinels',
  csvWater.entries.includes('2026-01-05|8|') && csvWater.entries.includes('2026-01-07|10|'),
  csvWater.entries.join(' '));
ck('CSV: a real skip stays a skip',
  csvWater.entries.includes('2026-01-08|0|skip'),
  csvWater.entries.join(' '));
ck('CSV: habit types survive', csvWater.type === 'numerical', csvWater.type);

const csvSnacks = afterCsv.find((h) => h.name === 'Snacks');
ck('CSV: at_most target type survives',
  csvSnacks.target_type === 'at_most', csvSnacks.target_type);

const csvGym = afterCsv.find((h) => h.name === 'Gym');
ck('CSV: a 3-per-7 frequency survives',
  csvGym.freq_numerator === 3 && csvGym.freq_denominator === 7,
  `${csvGym.freq_numerator}/${csvGym.freq_denominator}`);

/* ---------- settings travel with the data ---------- */

console.log('\n--- settings ---');

const putSettings = (patch) => api('/api/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
});
const getSettings = async () => (await (await api('/api/settings')).json());

// Two of these decide what the rows in the same backup MEAN, so a backup that
// did not carry them restored a history the app then read differently. The JSON
// export carried no settings at all until this was fixed.
await putSettings({ skipDays: true, questionMarks: true, dayOrder: 'newest-right' });
const withSettings = Buffer.from(await (await api('/api/export')).arrayBuffer());
const exported = JSON.parse(withSettings.toString('utf8')).settings ?? {};

ck('the JSON backup carries the settings',
  exported.skipDays === true && exported.questionMarks === true &&
  exported.dayOrder === 'newest-right',
  JSON.stringify(exported));

await putSettings({ skipDays: false, questionMarks: false, dayOrder: 'newest-left' });
const restored = await restore(withSettings, 'replace');
const back = await getSettings();

ck('a replace-mode restore puts them back',
  back.skipDays === true && back.questionMarks === true &&
  back.dayOrder === 'newest-right',
  JSON.stringify(back));
ck('and says how many it applied', restored.settings >= 3, String(restored.settings));

// A merge is "add these habits to what I have", not "make my account look like
// this file" — it must leave the rest of the account alone.
await putSettings({ skipDays: false, questionMarks: false });
const merged = await restore(withSettings, 'merge');
const afterMergeSettings = await getSettings();

ck('a merge leaves them alone',
  afterMergeSettings.skipDays === false && afterMergeSettings.questionMarks === false,
  JSON.stringify(afterMergeSettings));
ck('and reports applying none', merged.settings === 0, String(merged.settings));

/* ---------- merge mode must not duplicate ---------- */

console.log('\n--- merge mode ---');

// Restore the full dataset, then merge the same backup on top: matching names
// must merge rather than create a second copy.
await restore(jsonBackup, 'replace');
const beforeMerge = await current();
const mergeResult = await restore(jsonBackup, 'merge');
const afterMerge = await current();

ck('merging an identical backup creates nothing',
  mergeResult.habitsCreated === 0,
  `created=${mergeResult.habitsCreated} merged=${mergeResult.habitsMerged}`);
ck('merging an identical backup changes no data',
  diff(beforeMerge, afterMerge) === null,
  diff(beforeMerge, afterMerge) ?? '');

/* ---------- done ---------- */

server.close();
// Windows will not unlink a file SQLite still has open, so close the database
// before removing the scratch directory. Failing to clean up is not worth
// failing the run over — the OS clears the temp dir eventually.
try { (await import('../src/db.js')).db.close(); } catch { /* already closed */ }
try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${fails === 0 ? 'all round-trip checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
