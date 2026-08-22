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
  FIXTURE, snapshot, diff, checkAgainstFixture,
  LOOP_HABIT_FIELDS, LOOP_DB_HABIT_FIELDS, CSV_HABIT_FIELDS,
} from '@habiterall/shared/test/roundtrip-fixture.mjs';
// The clamp import must honour is the one the API enforces, so the test asks
// the same table rather than restating a number that could drift from it.
import { LIMITS } from '@habiterall/shared/validate.js';

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

/* ---------- a server on a scratch database ---------- */

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-rt-'));
// Must be set before src/db.js is imported — it opens the file at module load.
// These suites exercise the API, not sign-in or rate limiting, and auth now
// defaults ON — see shared/src/password.js. Both are turned off explicitly here,
// before the server module is imported, exactly as HABITERALL_DB must be: a
// suite that writes a few hundred entries in a burst is what the 300/minute API
// limit is meant to catch, and here that burst is the point.
process.env.HABITERALL_AUTH = 'off';
process.env.HABITERALL_RATE_LIMIT = 'off';
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
  // The fixture names a category by NAME (see roundtrip-fixture.mjs), and the
  // API takes `category_id` — the same shape `applyImport` resolves against a
  // file's categories. Created here, once per distinct name, before any habit
  // so `POST /api/habits` below has an id to send.
  const categoryIds = new Map();
  for (const name of new Set(FIXTURE.map((h) => h.category).filter(Boolean))) {
    const created = await (await api('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })).json();
    categoryIds.set(name, created.id);
  }

  // The database is a fresh temp file, so there is nothing to clear first.
  for (const h of FIXTURE) {
    const created = await (await api('/api/habits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...h, category_id: categoryIds.get(h.category) ?? null }),
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
      // A PUT replaces every field, category_id included — the fixture has
      // no archived habit with a category today, but an omitted id here
      // would silently clear one the moment that changes.
      await api(`/api/habits/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...h, archived: true, category_id: categoryIds.get(h.category) ?? null,
        }),
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
// The CSV keeps the colour exactly, where the .db snaps it to a palette index.
const baselineCsv = await current({ fields: CSV_HABIT_FIELDS, notes: false });
// The .db carries a reminder time as well, and per-day notes, which is why this
// one is not `notes: false`. Habits.csv has no column for either.
const baselineLoopDb = await current({ fields: LOOP_DB_HABIT_FIELDS });

ck('fixture seeded', baselineFull.length === FIXTURE.length,
  `${baselineFull.length} habits`);

// Against the fixture, not against the route. `current()` IS `GET /api/export`,
// so everything below this line compares the export with itself; this is the
// only check in the suite that can see the export destroying a field.
checkAgainstFixture(baselineFull, ck);

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

/**
 * FIXTURE habits that declare an icon at all. The same guard `statedLapses()`
 * is for: without it, "every restored habit has icon === ''" would pass
 * whether or not the format actually dropped anything, because a fixture with
 * nothing to lose satisfies it either way.
 */
function habitsWithIcon() {
  return FIXTURE.filter((h) => (h.icon ?? '') !== '');
}

/* ---------- Loop .db ---------- */

console.log('\n--- Loop .db backup ---');

const loopDb = Buffer.from(await (await api('/api/export-loop.db')).arrayBuffer());
ck('the Loop export is a SQLite file',
  loopDb.subarray(0, 15).toString() === 'SQLite format 3',
  loopDb.subarray(0, 15).toString());

const loopResult = await restore(loopDb);
const afterLoop = await current({ fields: LOOP_DB_HABIT_FIELDS });

// Every entry, with no exception left: Loop's NO is a day habiterall can now
// both hold and write, so a stated lapse survives whether or not a note came
// with it. The note itself is inside this comparison now — `Repetitions.notes`
// is a real column that both halves of the round trip have always used, and
// the fixture header said otherwise for long enough that dropping it would
// have failed nothing. Only Checkmarks.csv genuinely cannot carry one.
ck('Loop round-trip preserves habits and entries',
  diff(baselineLoopDb, afterLoop) === null,
  diff(baselineLoopDb, afterLoop) ?? '');

const loopMeditate = afterLoop.find((h) => h.name === 'Meditate');
// The trailing field is the note, which this comparison now carries — so this
// asserts the lapse AND the text on it, where before it asserted neither for
// the noted one.
ck('Loop: a stated lapse survives, with or without a note',
  statedLapses().every((e) => loopMeditate.entries.includes(`${e.date}|0||${e.notes}`)),
  `${statedLapses().length} lapses in the fixture; got ${loopMeditate.entries.join(' ')}`);
ck('Loop restore skipped nothing',
  (loopResult.skipped ?? []).length === 0,
  (loopResult.skipped ?? []).join('; '));

// The specific encoding traps, asserted individually so a failure names itself.
const loopWater = afterLoop.find((h) => h.name === 'Water');
ck('Loop: numerical 3 stays 3, not a skip',
  loopWater.entries.includes('2026-01-06|3||busy day'),
  loopWater.entries.join(' '));
ck('Loop: a real skip stays a skip',
  loopWater.entries.includes('2026-01-08|0|skip|'),
  loopWater.entries.join(' '));
ck('Loop: target values are not scaled by 1000',
  loopWater.target_value === 8, String(loopWater.target_value));

const loopSnacks = afterLoop.find((h) => h.name === 'Snacks');
ck('Loop: at_most target type survives',
  loopSnacks.target_type === 'at_most', loopSnacks.target_type);
ck('Loop: a zero on an at_most habit survives',
  loopSnacks.entries.includes('2026-01-05|0||'),
  loopSnacks.entries.join(' '));

const loopReading = afterLoop.find((h) => h.name === 'Reading');
ck('Loop: a fractional target survives',
  loopReading.target_value === 12.5, String(loopReading.target_value));

// Loop's reminder_hour / reminder_min and its `question`, both of which were
// written as literal NULL / '' on the way out and never read on the way in.
ck('Loop: a reminder time survives',
  loopMeditate.reminder_time === '07:30', String(loopMeditate.reminder_time));
ck('Loop: a midnight reminder is a reminder, not a blank',
  loopSnacks.reminder_time === '00:00', String(loopSnacks.reminder_time));
ck('Loop: no reminder stays no reminder',
  loopReading.reminder_time === '', JSON.stringify(loopReading.reminder_time));
ck('Loop: the reminder prompt survives as question',
  loopMeditate.reminder_message === 'Did you sit for ten minutes?',
  String(loopMeditate.reminder_message));

// The three the fixture header called impossible. Named one at a time as well
// as being inside the comparison above, because "the .db cannot carry this" is
// the claim that kept them out, and a diff line is a poor place to read a
// refutation of it.
ck('Loop: the description survives',
  loopMeditate.description === 'Ten minutes, morning', String(loopMeditate.description));
ck('Loop: archived state survives',
  loopReading.archived === true && loopMeditate.archived === false,
  `Reading=${loopReading.archived} Meditate=${loopMeditate.archived}`);
ck('Loop: a per-day note survives, on a done day and on a lapse',
  loopMeditate.entries.includes('2026-01-06|2||felt good') &&
  loopMeditate.entries.includes('2026-01-08|0||overslept'),
  loopMeditate.entries.join(' '));

// The gap `icon` belongs to no Loop list: it is stated on the way in and read
// back afterwards, rather than assumed, and guarded so it cannot pass on a
// fixture with nothing to lose.
const iconHabits = habitsWithIcon();
ck('the fixture declares an icon on more than zero habits',
  iconHabits.length > 0, String(iconHabits.length));

const afterLoopIcons = await current();
ck('Loop: the restored habits carry an icon KEY at all',
  afterLoopIcons.every((h) => Object.hasOwn(h, 'icon')),
  afterLoopIcons.map((h) => `${h.name}:${Object.hasOwn(h, 'icon')}`).join(' '));
ck('Loop: every restored habit has icon === \'\', the format has nowhere to put one',
  afterLoopIcons.every((h) => h.icon === ''),
  afterLoopIcons.map((h) => `${h.name}:${JSON.stringify(h.icon)}`).join(' '));

/* ---------- CSV ---------- */

console.log('\n--- CSV archive (Habits.csv + Checkmarks.csv) ---');

// Back to the lossless snapshot first: the Loop .db section above left the
// account in whatever state a Loop restore produces, and Loop's model has no
// category at all — every habit came back uncategorised. `color` happens to
// survive that hop unchanged because the fixture's colours are already exact
// Loop palette entries, which is what let this section skip a restore of its
// own for as long as `category` was not one of the fields it watched.
await restore(jsonBackup, 'replace');

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
const afterCsv = await current({ fields: CSV_HABIT_FIELDS, notes: false });

ck('CSV restore skipped nothing',
  (csvResult.skipped ?? []).length === 0,
  (csvResult.skipped ?? []).join('; '));

// The CSV pair carries the same information the Loop .db does, so it is held to
// the same standard: every entry, notes aside.
ck('CSV round-trip preserves habits and entries',
  diff(baselineCsv, afterCsv) === null,
  diff(baselineCsv, afterCsv) ?? '');

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

// Habits.csv wrote the description into Question as well as Description, and
// the importer read Question as a fallback FOR description — so the duplication
// was invisible and the prompt was lost. The two columns are two fields.
ck('CSV: the reminder prompt survives, in the Question column',
  csvMeditate.reminder_message === 'Did you sit for ten minutes?',
  String(csvMeditate.reminder_message));
ck('CSV: the description is not overwritten by the prompt',
  (await current()).find((h) => h.name === 'Meditate').description === 'Ten minutes, morning',
  (await current()).find((h) => h.name === 'Meditate').description);
// Loop's CSV export has no reminder columns at all, so this one is expected to
// be dropped — asserted rather than assumed, since it is the difference between
// the two Loop formats and the reason there are two field lists.
ck('CSV: a reminder time is dropped, as the format requires',
  (await current()).find((h) => h.name === 'Meditate').reminder_time === '',
  (await current()).find((h) => h.name === 'Meditate').reminder_time);

const afterCsvIcons = await current();
ck('CSV: the restored habits carry an icon KEY at all',
  afterCsvIcons.every((h) => Object.hasOwn(h, 'icon')),
  afterCsvIcons.map((h) => `${h.name}:${Object.hasOwn(h, 'icon')}`).join(' '));
ck('CSV: every restored habit has icon === \'\', the format has nowhere to put one',
  afterCsvIcons.every((h) => h.icon === ''),
  afterCsvIcons.map((h) => `${h.name}:${JSON.stringify(h.icon)}`).join(' '));

/* ---------- a merge adds, and never deletes an answer ---------- */

console.log('\n--- merge does not overwrite an answer with a lapse ---');

// A row is an answer now, so a file's bare "not done" reaches the writer where it
// used to be dropped — and the plain upsert would then overwrite a recorded
// completion. A Loop backup is full of explicit NO rows (its cycle is YES -> NO
// with question marks off), so merging a phone export taken before the web
// history would have wiped every completion the two disagreed about.
await restore(jsonBackup, 'replace');
// Looked up on demand: a replace recreates every habit, so an id captured before
// one is stale afterwards.
const meditateId = async () => (await (await api('/api/habits')).json())
  .find((h) => h.name === 'Meditate').id;

const lapseOverDone = JSON.stringify({
  version: 1, app: 'habiterall',
  habits: [{
    name: 'Meditate', type: 'boolean',
    // 01-05 is a completion in the fixture; 01-11 is a day it has no row for.
    entries: [
      { date: '2026-01-05', value: 0, status: '', notes: '' },
      { date: '2026-01-11', value: 0, status: '', notes: '' },
    ],
  }],
});
const mergedLapses = await restore(Buffer.from(lapseOverDone, 'utf8'), 'merge');
const afterLapseMerge = await (await api(`/api/habits/${await meditateId()}/entries`)).json();
const on = (date) => afterLapseMerge.find((e) => e.date === date);

ck('the completion it disagreed with is still a completion',
  on('2026-01-05')?.value === 2, JSON.stringify(on('2026-01-05')));
ck('and it says so rather than counting a write it did not make',
  mergedLapses.entriesKept === 1 && mergedLapses.entriesImported === 1,
  JSON.stringify(mergedLapses));
ck('a lapse on a day the account had no answer for still lands',
  on('2026-01-11')?.value === 0 && on('2026-01-11')?.status === '',
  JSON.stringify(on('2026-01-11')));

// Replace mode has nothing to yield to, and must not start yielding.
await restore(Buffer.from(lapseOverDone, 'utf8'), 'replace');
const afterLapseReplace =
  await (await api(`/api/habits/${await meditateId()}/entries`)).json();
ck('in replace mode the file is the whole truth',
  afterLapseReplace.length === 2 &&
  afterLapseReplace.every((e) => e.value === 0),
  JSON.stringify(afterLapseReplace));

await restore(jsonBackup, 'replace');

/* ---------- ...and the same promise on a MEASURABLE habit ---------- */

console.log('\n--- merge does not overwrite an amount either ---');

// Everything above this line is about Meditate, which is boolean — and the
// yield was gated on `type === 'boolean'`, so the suite watched the protection
// work right beside the hole. A numerical habit's lapse is a row holding 0 too.
const idOf = async (name) =>
  (await (await api('/api/habits')).json()).find((h) => h.name === name).id;
const entriesOf = async (name) =>
  (await (await api(`/api/habits/${await idOf(name)}/entries`)).json());
const dayOf = async (name, date) =>
  (await entriesOf(name)).find((e) => e.date === date);

const zeroOverAmount = JSON.stringify({
  version: 1, app: 'habiterall',
  habits: [{
    name: 'Water', type: 'numerical',
    // 01-05 holds 8 glasses in the fixture; 01-11 has no row at all.
    entries: [
      { date: '2026-01-05', value: 0, status: '', notes: '' },
      { date: '2026-01-11', value: 0, status: '', notes: '' },
    ],
  }],
});
const mergedZeros = await restore(Buffer.from(zeroOverAmount, 'utf8'), 'merge');

ck('a bare 0 does not overwrite a recorded amount',
  (await dayOf('Water', '2026-01-05'))?.value === 8,
  JSON.stringify(await dayOf('Water', '2026-01-05')));
ck('and the day it kept is counted as kept',
  mergedZeros.entriesKept === 1 && mergedZeros.entriesImported === 1,
  JSON.stringify(mergedZeros));
ck('while a 0 on a day the habit has no answer for still lands',
  (await dayOf('Water', '2026-01-11'))?.value === 0,
  JSON.stringify(await dayOf('Water', '2026-01-11')));

// A note of one space is truthy, and `!notes` was enough to defeat the yield —
// so a file could overwrite a recorded amount with a lapse by carrying
// whitespace. It is content that suspends the rule, and a space is not content.
await restore(jsonBackup, 'replace');
const spaceNote = JSON.stringify({
  version: 1, app: 'habiterall',
  habits: [{ name: 'Water', type: 'numerical',
    entries: [{ date: '2026-01-05', value: 0, status: '', notes: '  ' }] }],
});
await restore(Buffer.from(spaceNote, 'utf8'), 'merge');
ck('a whitespace-only note does not buy a lapse the right to overwrite',
  (await dayOf('Water', '2026-01-05'))?.value === 8,
  JSON.stringify(await dayOf('Water', '2026-01-05')));

// ...and the one asymmetry, pinned so it is a decision and not an accident: a
// SKIP is an answer, so it DOES overwrite. `isCompleted` returns null for a
// skip rather than false, and a file asserting one is asserting something,
// where a bare lapse may only be the absence of a row.
await restore(jsonBackup, 'replace');
await restore(Buffer.from('Date,Water\n2026-01-05,SKIP\n', 'utf8'), 'merge');
ck('a skip DOES overwrite an amount, which is deliberate',
  (await dayOf('Water', '2026-01-05'))?.status === 'skip',
  JSON.stringify(await dayOf('Water', '2026-01-05')));

await restore(jsonBackup, 'replace');

/* ---------- a merge types entries by the habit, not by the file ---------- */

console.log('\n--- the account\'s own type decides what a value means ---');

await restore(jsonBackup, 'replace');

// The most ordinary file there is: a bare Checkmarks.csv, with no Habits.csv
// beside it to say what a habit is, so every column parses as boolean. Merged
// into this account it rewrote 8 and 10 glasses to the YES sentinel — 2, against
// a target of 8 — and reported two imported entries and a 200.
const bareCheckmarks = [
  'Date,Water',
  '2026-01-05,YES_MANUAL',
  '2026-01-07,YES_MANUAL',
  '2026-01-12,NO',
].join('\n') + '\n';
const mergedCsv = await restore(Buffer.from(bareCheckmarks, 'utf8'), 'merge');

ck('a yes/no file does not restate an amount',
  (await dayOf('Water', '2026-01-05'))?.value === 8 &&
  (await dayOf('Water', '2026-01-07'))?.value === 10,
  JSON.stringify(await entriesOf('Water')));
ck('and the days it could not translate are reported',
  mergedCsv.skipped.length === 1 && mergedCsv.skipped[0].includes('Water'),
  JSON.stringify(mergedCsv.skipped));
ck('but a NO still crosses, since a lapse means the same on both sides',
  (await dayOf('Water', '2026-01-12'))?.value === 0,
  JSON.stringify(await dayOf('Water', '2026-01-12')));

// And the other direction, which the API answers 400 to: an 8 on a boolean
// habit is a day `isCompleted` reads as not done forever, and the tap cycle has
// no state for it.
const claimsNumerical = JSON.stringify({
  version: 1, app: 'habiterall',
  habits: [{
    name: 'Meditate', type: 'numerical',
    entries: [{ date: '2026-01-12', value: 8, status: '', notes: '' }],
  }],
});
const mergedClaim = await restore(Buffer.from(claimsNumerical, 'utf8'), 'merge');
const apiOnBoolean = await fetch(
  `${base}/api/habits/${await idOf('Meditate')}/entries/2026-01-12`,
  { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 8 }) });

ck('the API refuses an amount on a yes/no habit', apiOnBoolean.status === 400,
  String(apiOnBoolean.status));
ck('and so does an import claiming the habit is measurable',
  (await dayOf('Meditate', '2026-01-12')) === undefined &&
  mergedClaim.skipped.length === 1,
  JSON.stringify([await dayOf('Meditate', '2026-01-12'), mergedClaim.skipped]));

/* ---------- an import obeys the rules the API obeys ---------- */

console.log('\n--- impossible dates, and over-long notes ---');

await restore(jsonBackup, 'replace');

// `2026-02-30` matches YYYY-MM-DD and is not a day. The API has refused it since
// `assertDate` was written; import checked the pattern only, so SQLite filed a
// row under a date no range query can reach — and the cloud edition, where the
// column is a real DATE, lost the whole upload to a 22008.
const impossibleDates = JSON.stringify({
  version: 1, app: 'habiterall',
  habits: [{
    name: 'Meditate', type: 'boolean',
    entries: [
      { date: '2026-02-30', value: 2, status: '', notes: '' },
      { date: '2026-13-45', value: 2, status: '', notes: '' },
      { date: '2026-01-12', value: 2, status: '', notes: '' },
    ],
  }],
});
const badDates = await restore(Buffer.from(impossibleDates, 'utf8'), 'merge');
const meditateDates = (await entriesOf('Meditate')).map((e) => e.date);

ck('a date that is not a day is reported rather than stored',
  badDates.skipped.length === 2 &&
  !meditateDates.some((d) => d === '2026-02-30' || d === '2026-13-45'),
  JSON.stringify([badDates.skipped, meditateDates]));
ck('and the rest of the file still lands',
  badDates.entriesImported === 1 && meditateDates.includes('2026-01-12'),
  JSON.stringify(badDates));

// Notes were clamped in cloud and unbounded here, so this edition accepted
// through import what its own API truncates — and a personal-to-cloud migration
// then lost the tail with nothing said.
const longNote = 'x'.repeat(LIMITS.notes + 400);
const overLongNotes = JSON.stringify({
  version: 1, app: 'habiterall',
  habits: [{
    name: 'Meditate', type: 'boolean',
    entries: [
      { date: '2026-01-13', value: 2, status: '', notes: longNote },
      { date: '2026-01-14', value: 0, status: 'skip', notes: longNote },
    ],
  }],
});
await restore(Buffer.from(overLongNotes, 'utf8'), 'merge');

ck('an imported note is clamped to what the API stores',
  (await dayOf('Meditate', '2026-01-13'))?.notes.length === LIMITS.notes,
  String((await dayOf('Meditate', '2026-01-13'))?.notes.length));
ck('a skip\'s note too, which took the other path out',
  (await dayOf('Meditate', '2026-01-14'))?.notes.length === LIMITS.notes,
  String((await dayOf('Meditate', '2026-01-14'))?.notes.length));

await restore(jsonBackup, 'replace');

/* ---------- "the file said nothing" has more than one spelling ---------- */

console.log('\n--- an entry with no value is not a lapse ---');

// `Number(null)` and `Number('')` are both 0, and 0 is a real answer here: a row
// holding zero is a STATED lapse, one of the four day-states. So `{date, value:
// null}` was written as a day the user said they had missed, while `{date}` with
// no value key at all was correctly refused — two spellings of the same silence
// behaving differently. Asserted in REPLACE mode because that is where it costs
// something: a merge yields a bare lapse to whatever the account holds, but a
// replace has nothing to yield to, and an invented lapse extends the habit's
// history window back to its own date and turns `recovery.rate === null` —
// "nothing has ever been missed" — into a real lapse.
const saidNothing = JSON.stringify({
  version: 1, app: 'habiterall',
  habits: [
    {
      name: 'Meditate', type: 'boolean',
      entries: [
        { date: '2026-02-01', value: null },
        { date: '2026-02-02' },
        { date: '2026-02-03', value: '' },
        { date: '2026-02-04', value: false },
        { date: '2026-02-05', value: 0 },      // this one IS a stated lapse
        { date: '2026-02-06', value: 2 },
      ],
    },
    // The guard is about the type of "nothing", not about tightening what counts
    // as a number: a quoted amount is an amount the file stated, and still lands.
    {
      name: 'Water', type: 'numerical',
      entries: [{ date: '2026-02-07', value: '8' }],
    },
  ],
});
const nothings = await restore(Buffer.from(saidNothing, 'utf8'), 'replace');
const answered = (await entriesOf('Meditate')).map((e) => e.date);

ck('null, absent, empty and false are all "the file said nothing"',
  !answered.some((d) =>
    ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04'].includes(d)),
  JSON.stringify(answered));
ck('and each is reported rather than silently dropped',
  nothings.skipped.filter((s) => s.startsWith('bad value')).length === 4,
  JSON.stringify(nothings.skipped));
ck('while a stated 0 is still a stated lapse',
  (await dayOf('Meditate', '2026-02-05'))?.value === 0 &&
  (await dayOf('Meditate', '2026-02-06'))?.value === 2,
  JSON.stringify(await entriesOf('Meditate')));
ck('and a quoted amount is still an amount',
  (await dayOf('Water', '2026-02-07'))?.value === 8,
  JSON.stringify(await dayOf('Water', '2026-02-07')));

await restore(jsonBackup, 'replace');

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
// `theme` is in here for the reason `reminder_message` taught the cloud suite:
// a field left at its default everywhere compares equal to itself and passes
// with the field dropped from the allowlist entirely. It is set to a value the
// registry's default is NOT, which is what makes the assertion below bite.
// `gridDays` and `detailCards` are here for the same reason, and `detailCards`
// needs it in two dimensions at once now that it stores order as well as
// membership: its default is all nine ids ON in `DETAIL_CARDS` order, so a
// fixture that varies only WHICH ids are on and leaves them in canonical order
// would still compare equal with the order silently dropped on export or
// import — the "fixture holds a field's default" defect, just one axis short
// of catching it. This one is a non-canonical order with two cards off.
// Every id must be named, and in a non-canonical order: this goes out through
// a real `PUT /api/settings`, so `parseCardList` runs on it — and any id left
// out would be INSERTED at its canonical position, leaving the stored value
// something this fixture never wrote. `recentDays` sits mid-list rather than
// first for that reason, and because a card whose canonical home is index 0 is
// the one a normaliser that quietly re-sorted would move without anyone seeing.
const nonCanonicalDetailCards = [
  { id: 'history', on: true }, { id: 'calendar', on: true },
  { id: 'strength', on: false }, { id: 'recentDays', on: true },
  { id: 'frequency', on: true },
  { id: 'weekdays', on: false }, { id: 'awards', on: true },
  { id: 'streaks', on: true }, { id: 'resilience', on: true },
  { id: 'weekdayMonths', on: true },
];
await putSettings({ skipDays: true, questionMarks: true, dayOrder: 'newest-right',
  atMostUnlogged: 'success', theme: 'dark', numberFormat: 'comma',
  gridDays: '7', detailCards: nonCanonicalDetailCards });
const withSettings = Buffer.from(await (await api('/api/export')).arrayBuffer());
const exported = JSON.parse(withSettings.toString('utf8')).settings ?? {};

ck('the JSON backup carries the settings',
  exported.skipDays === true && exported.questionMarks === true &&
  exported.dayOrder === 'newest-right' && exported.atMostUnlogged === 'success' &&
  exported.theme === 'dark' && exported.numberFormat === 'comma' &&
  exported.gridDays === '7' &&
  JSON.stringify(exported.detailCards) === JSON.stringify(nonCanonicalDetailCards),
  JSON.stringify(exported));

// And nothing that is a capability rather than a preference. A backup file is
// emailed and synced; a webhook URL is a bearer token for a channel.
await putSettings({ discordWebhook: 'https://discord.com/api/webhooks/1/secret' });
const guarded = JSON.parse(
  Buffer.from(await (await api('/api/export')).arrayBuffer()).toString('utf8'));
ck('and no notification destination',
  !Object.keys(guarded.settings ?? {}).some((k) => k.startsWith('discord') ||
    k.startsWith('notify')),
  JSON.stringify(guarded.settings));

// The reverse: a file cannot set one either.
const hostile = JSON.stringify({
  version: 1, app: 'habiterall', habits: [{ name: 'Meditate', type: 'boolean', entries: [] }],
  settings: { discordWebhook: 'https://discord.com/api/webhooks/999/attacker',
    notifyChannels: ['discord'], questionMarks: true },
});
await restore(Buffer.from(hostile, 'utf8'), 'replace');
const afterHostile = await getSettings();
ck('an uploaded file cannot repoint the reminders',
  afterHostile.discordWebhook === 'https://discord.com/api/webhooks/1/secret',
  afterHostile.discordWebhook);
ck('though it can still set a display preference',
  afterHostile.questionMarks === true, JSON.stringify(afterHostile.questionMarks));

// Put the habits back for the sections below.
await restore(jsonBackup, 'replace');
await putSettings({ skipDays: true, questionMarks: true, dayOrder: 'newest-right',
  atMostUnlogged: 'success', theme: 'dark', numberFormat: 'comma',
  gridDays: '7', detailCards: nonCanonicalDetailCards });

await putSettings({ skipDays: false, questionMarks: false, dayOrder: 'newest-left',
  atMostUnlogged: 'miss', theme: 'light', numberFormat: 'point',
  gridDays: 'auto', detailCards: ['awards'] });
const restored = await restore(withSettings, 'replace');
const back = await getSettings();

ck('a replace-mode restore puts them back',
  back.skipDays === true && back.questionMarks === true &&
  back.dayOrder === 'newest-right' && back.atMostUnlogged === 'success' &&
  back.theme === 'dark' && back.numberFormat === 'comma' &&
  back.gridDays === '7' &&
  JSON.stringify(back.detailCards) === JSON.stringify(nonCanonicalDetailCards),
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

// ...and the same claim about a name the clamp shortens, which is where it broke.
// The lookup asked for the raw 150 characters while the INSERT wrote the first
// LIMITS.name of them, so nothing ever matched: three merges of one file left
// three habits carrying one identical visible name. Cloud's own writer calls
// restoring twice "the normal way to check a backup is good", so this defeated
// the workflow the idempotency is FOR. No whitespace anywhere in it, so the
// stored name is exactly the first LIMITS.name characters and the assertion is
// not really about `trim`.
const longName = 'Read-a-chapter-of-something-long-'.repeat(5)
  .slice(0, LIMITS.name + 50);
const longNameFile = Buffer.from(JSON.stringify({
  version: 1, app: 'habiterall',
  habits: [{
    name: longName, type: 'boolean',
    entries: [{ date: '2026-01-05', value: 2, status: '', notes: '' }],
  }],
}), 'utf8');

const longMerges = [];
for (let i = 0; i < 3; i++) longMerges.push(await restore(longNameFile, 'merge'));
const byLongName = (await (await api('/api/habits')).json())
  .filter((h) => h.name === longName.slice(0, LIMITS.name));

ck('a name past the clamp is created once and merged into thereafter',
  longMerges[0].habitsCreated === 1 &&
  longMerges[1].habitsCreated === 0 && longMerges[1].habitsMerged === 1 &&
  longMerges[2].habitsCreated === 0 && byLongName.length === 1,
  JSON.stringify(longMerges.map((r) => [r.habitsCreated, r.habitsMerged])));

/* ---------- a merge never renames or recolours a category ---------- */

console.log('\n--- category resolution on import ---');

await restore(jsonBackup, 'replace');
const getCategories = async () => (await (await api('/api/categories')).json());

// Give the account's own "Health" a colour the file below does not have, the
// same way a user would through the picker's manage list.
const healthBefore = (await getCategories()).find((c) => c.name === 'Health');
await api(`/api/categories/${healthBefore.id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Health', color: '#123456' }),
});

// A file that names the same category, by the same folded name, in a
// different colour, and adds a new habit under it.
const healthMergeFile = JSON.stringify({
  version: 1, app: 'habiterall',
  categories: [{ name: 'health', color: '#ff0000', position: 0 }],
  habits: [{
    name: 'Yoga', type: 'boolean', category: 'health', entries: [],
  }],
});
await restore(Buffer.from(healthMergeFile, 'utf8'), 'merge');
const afterMerge2 = await getCategories();

ck('a merge does not recolour a category that already exists',
  afterMerge2.filter((c) => c.name === 'Health').length === 1 &&
  afterMerge2.find((c) => c.name === 'Health').color === '#123456',
  JSON.stringify(afterMerge2));
const yoga = (await (await api('/api/habits')).json()).find((h) => h.name === 'Yoga');
ck('and the new habit still resolves to the existing category, by folded name',
  yoga.category_id === healthBefore.id, JSON.stringify(yoga));

// A replace has nothing to preserve: the file's own categories become the
// account's, spelling and colour included — 'health', not 'Health', because
// a replace adopts the file's own name rather than the account's prior one.
await restore(Buffer.from(healthMergeFile, 'utf8'), 'replace');
const afterReplace2 = await getCategories();
ck('a replace applies the file\'s colour',
  afterReplace2.length === 1 && afterReplace2[0].name === 'health' &&
  afterReplace2[0].color === '#ff0000',
  JSON.stringify(afterReplace2));

await restore(jsonBackup, 'replace');

/* ---------- a category's declared position survives a restore ---------- */

console.log('\n--- category position on import ---');

// Declared out of the order they are LISTED in the array, on purpose: if the
// importer ignored `position` and simply appended each in array order (the
// bug this section exists to catch), the categories would come back Zeta,
// Alpha, Mid — the array's own order — and an assertion comparing against
// that same order would pass whether or not `position` was ever read. Sorted
// by the POSITION field the file actually states, the right order is
// Alpha, Mid, Zeta.
const positionedFile = JSON.stringify({
  version: 1, app: 'habiterall',
  categories: [
    { name: 'Zeta', color: '#3b82f6', position: 2 },
    { name: 'Alpha', color: '#22c55e', position: 0 },
    { name: 'Mid', color: '#ef4444', position: 1 },
  ],
  habits: [
    // Named only in a habit's own `category` field, so it never appears in
    // the `categories` array above and so declares no position at all — it
    // must still append, after every declared one.
    {
      name: 'Undeclared', type: 'boolean',
      category: 'Undeclared Category', entries: [],
    },
  ],
});
await restore(Buffer.from(positionedFile, 'utf8'), 'replace');
const positioned = await getCategories();

ck('a category restores at the position the file declared, not the order it was listed',
  positioned.map((c) => c.name).join(',') === 'Alpha,Mid,Zeta,Undeclared Category',
  JSON.stringify(positioned.map((c) => [c.name, c.position])));

await restore(jsonBackup, 'replace');

/* ---------- done ---------- */

server.close();
// Windows will not unlink a file SQLite still has open, so close the database
// before removing the scratch directory. Failing to clean up is not worth
// failing the run over — the OS clears the temp dir eventually.
try { (await import('../src/db.js')).db.close(); } catch { /* already closed */ }
try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${fails === 0 ? 'all round-trip checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
