import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';


const {
  writeLoopDatabase, colorToLoopIndex, isoToLoopTimestamp, toLoopEntry,
  timeToLoopReminder, isLoopEncodableDate, skipsForLog,
} = await import('../src/export-loop.js');
const {
  parseLoopDatabase, loopTimestampToISO, loopReminderToTime,
} = await import('../src/import.js');

const YES = 2;

const scratch = (name) => {
  const p = join(tmpdir(), `${name}-${process.pid}-${Math.round(performance.now())}.db`);
  try { unlinkSync(p); } catch {}
  return p;
};

/* ---------- primitives ---------- */

test('timestamps round-trip through Loop encoding', () => {
  // The years below 1000 are the pair of bugs this list was widened for, and
  // they are here together because each half hides the other. `Date.UTC`
  // applied the legacy two-digit-year mapping, so the writer put `0050-03-15`
  // in the file as 1950-03-15; the reader did not pad the year, so a correctly
  // written `0100-01-01` came back as `100-01-01` and was thrown away as a bad
  // date. Fix the writer alone and the reader starts silently dropping the
  // early dates it now receives — the round trip is the only assertion that
  // sees both.
  for (const iso of [
    '0001-01-01', '0050-03-15', '0099-12-31', '0100-01-01', '0999-12-31',
    '1000-01-01', '1998-03-10', '2026-01-01', '2026-06-15', '2027-12-31',
    '9999-12-31',
  ]) {
    assert.equal(loopTimestampToISO(isoToLoopTimestamp(iso)), iso, iso);
  }
});

test('an early year is written as itself, not 1900 years later', () => {
  // The round trip above would still pass if both halves agreed on a wrong
  // number, so pin the wire format too: this is what Loop's own reader gets.
  assert.equal(new Date(isoToLoopTimestamp('0050-03-15')).toISOString(),
    '0050-03-15T00:00:00.000Z');
  assert.equal(new Date(isoToLoopTimestamp('0099-12-31')).toISOString(),
    '0099-12-31T00:00:00.000Z');
});

test('timestamps are UTC midnight', () => {
  const ts = isoToLoopTimestamp('2026-06-15');
  assert.equal(ts % 86_400_000, 0, 'must be aligned to a day boundary');
  assert.equal(new Date(ts).toISOString(), '2026-06-15T00:00:00.000Z');
});

test('reminders round-trip through Loop\'s two integer columns', () => {
  for (const time of ['00:00', '07:05', '09:00', '12:00', '18:30', '23:59']) {
    const [h, m] = timeToLoopReminder(time);
    assert.equal(loopReminderToTime(h, m), time, time);
  }
});

test('no reminder is NULL in both columns, and comes back blank', () => {
  // Loop's own representation of "no reminder", and habiterall's is `''`. The
  // pair has to survive both ways or a habit acquires a 00:00 notification it
  // never had — the failure a falsiness check produces in either direction.
  assert.deepEqual(timeToLoopReminder(''), [null, null]);
  assert.deepEqual(timeToLoopReminder(undefined), [null, null]);
  assert.equal(loopReminderToTime(null, null), '');
  assert.equal(loopReminderToTime(undefined, undefined), '');

  // Midnight is the case that separates "absent" from "zero".
  assert.deepEqual(timeToLoopReminder('00:00'), [0, 0]);
  assert.equal(loopReminderToTime(0, 0), '00:00');
});

test('a reminder Loop could not have written is no reminder', () => {
  // A half-filled row is not a time, and inventing `:00` for it would put a
  // notification on someone's phone that their Loop install never had.
  assert.equal(loopReminderToTime(8, null), '');
  assert.equal(loopReminderToTime(null, 30), '');
  assert.equal(loopReminderToTime(24, 0), '');
  assert.equal(loopReminderToTime(-1, 0), '');
  assert.equal(loopReminderToTime(8, 60), '');
  assert.equal(loopReminderToTime(8.5, 0), '');
  assert.equal(loopReminderToTime('nonsense', 0), '');

  // And the same on the way out, for a stored value that got past TIME_RE
  // somehow. Both editions normalise before storing, so this is a backstop.
  assert.deepEqual(timeToLoopReminder('25:00'), [null, null]);
  assert.deepEqual(timeToLoopReminder('7:5'), [null, null]);
});

test('colors map to a palette index and back to something close', () => {
  assert.equal(colorToLoopIndex('#3b82f6'), 10, 'exact palette hit');
  assert.equal(colorToLoopIndex('#8b5cf6'), 12);
  assert.ok(colorToLoopIndex('garbage') >= 0, 'invalid input still yields an index');
  assert.ok(colorToLoopIndex('#3c83f7') === 10, 'near miss snaps to nearest');
});

test('boolean entries encode done as YES_MANUAL and a lapse as Loop NO', () => {
  const h = { type: 'boolean' };
  assert.equal(toLoopEntry(h, { value: YES, status: '' }), 2);
  assert.equal(toLoopEntry(h, { value: 0, status: 'skip' }), 3, 'skip');
  // A row is an answer, so it exports as one. Returning null here dropped every
  // stated lapse into "never answered" on the way out — the same information
  // Loop's own question-mark setting exists to keep.
  assert.equal(toLoopEntry(h, { value: 0, status: '' }), 0, 'a stated no is Loop NO');
  // Days with no row are simply not written, and Loop reads a missing day as
  // UNKNOWN. `writeLoopDatabase` never asks about those.
});

test('numerical entries are scaled by 1000', () => {
  const h = { type: 'numerical' };
  assert.equal(toLoopEntry(h, { value: 7.5, status: '' }), 7500);
  assert.equal(toLoopEntry(h, { value: 8, status: '' }), 8000);
  assert.equal(toLoopEntry(h, { value: 0, status: '' }), 0);
});

test('a tiny amount never exports into the sentinel band', () => {
  // 0.003 x 1000 = 3, which IS Loop's SKIP. Re-importing turned the recorded
  // amount into a skipped day: the value destroyed, and a failure silently
  // converted into a skip that bridges streaks and inflates the score.
  //
  // Loop resolves the ambiguity in favour of the sentinel, so it can only be
  // avoided on the way out. Nudging to 4 costs 0.001 of a unit — a rounding
  // error at a precision nothing tracks — and keeps the day a real entry.
  const h = { type: 'numerical' };

  for (const tiny of [0.001, 0.002, 0.003]) {
    const wire = toLoopEntry(h, { value: tiny, status: '' });
    assert.ok(wire > 3,
      `${tiny} exported as ${wire}, inside the sentinel band`);
  }

  // Zero must stay zero: it is a legitimate amount, especially for an
  // "at most" habit where 0 is the ideal outcome, and 0 is NO not SKIP.
  assert.equal(toLoopEntry(h, { value: 0, status: '' }), 0);

  // And a genuine skip is still the sentinel.
  assert.equal(toLoopEntry(h, { value: 0, status: 'skip' }), 3);
});

test('a numerical 3 exports as 3000, never as the SKIP sentinel', () => {
  const h = { type: 'numerical' };
  const three = toLoopEntry(h, { value: 3, status: '' });
  const skip = toLoopEntry(h, { value: 0, status: 'skip' });

  assert.equal(three, 3000, '3 units scales to 3000');
  assert.equal(skip, 3, 'the sentinel is the bare 3');
  assert.notEqual(three, skip, 'they must not collide');
});

/* ---------- full round trip ---------- */

const HABITS = [
  {
    id: 1, name: 'Meditate', description: 'Morning sit', type: 'boolean',
    unit: '', target_value: 0, target_type: 'at_least',
    freq_numerator: 1, freq_denominator: 1, color: '#8b5cf6', archived: 0,
    reminder_time: '07:05', reminder_message: 'Did you sit for ten minutes?',
  },
  {
    id: 2, name: 'Water', description: '', type: 'numerical',
    unit: 'glasses', target_value: 8, target_type: 'at_least',
    freq_numerator: 1, freq_denominator: 1, color: '#0ea5e9', archived: 0,
    // Midnight: both Loop columns are 0, so anything testing truthiness rather
    // than presence reports this habit as having no reminder.
    reminder_time: '00:00', reminder_message: '',
  },
  {
    // No reminder fields at all, which is what a caller that predates them
    // passes — and what a habit with no reminder looks like in storage.
    id: 3, name: 'Cigarettes', description: 'quitting', type: 'numerical',
    unit: 'cigs', target_value: 0, target_type: 'at_most',
    freq_numerator: 1, freq_denominator: 1, color: '#ef4444', archived: 0,
  },
  {
    id: 4, name: 'Gym', description: '', type: 'boolean',
    unit: '', target_value: 0, target_type: 'at_least',
    freq_numerator: 3, freq_denominator: 7, color: '#f59e0b', archived: 1,
    reminder_time: '23:59', reminder_message: 'Gym today?',
  },
];

const ENTRIES = {
  1: [
    { date: '2026-01-01', value: YES, status: '', notes: 'good one' },
    { date: '2026-01-02', value: 0, status: 'skip', notes: '' },
  ],
  2: [
    { date: '2026-01-01', value: 7.5, status: '', notes: '' },
    { date: '2026-01-02', value: 9, status: '', notes: '' },
  ],
  3: [
    { date: '2026-01-01', value: 0, status: '', notes: '' },
    { date: '2026-01-02', value: 3, status: '', notes: 'bad day' },
    { date: '2026-01-03', value: 0, status: 'skip', notes: '' },
  ],
  4: [{ date: '2026-01-05', value: YES, status: '', notes: '' }],
};

test('a full export re-imports with identical data', async () => {
  const path = scratch('loop-export');
  const result = await writeLoopDatabase(path, HABITS, (id) => ENTRIES[id] ?? []);

  assert.equal(result.habits, 4);
  // Not-done rows are intentionally dropped; every other entry is written.
  assert.equal(result.entries, 8);

  const reimported = await parseLoopDatabase(path);
  assert.equal(reimported.length, 4);

  const byName = Object.fromEntries(reimported.map((h) => [h.name, h]));

  const med = byName['Meditate'];
  assert.equal(med.type, 'boolean');
  assert.equal(med.description, 'Morning sit');
  assert.equal(med.color, '#8b5cf6', 'color survives the palette round trip');
  assert.deepEqual(
    med.entries.map((e) => [e.date, e.value, e.status]),
    [['2026-01-01', YES, ''], ['2026-01-02', 0, 'skip']]
  );
  assert.equal(med.entries[0].notes, 'good one', 'notes survive');

  const water = byName['Water'];
  assert.equal(water.type, 'numerical');
  assert.equal(water.unit, 'glasses');
  assert.equal(water.target_value, 8, 'target unscaled correctly');
  assert.deepEqual(water.entries.map((e) => e.value), [7.5, 9]);

  const cigs = byName['Cigarettes'];
  assert.equal(cigs.target_type, 'at_most');
  assert.deepEqual(
    cigs.entries.map((e) => [e.date, e.value, e.status]),
    [['2026-01-01', 0, ''], ['2026-01-02', 3, ''], ['2026-01-03', 0, 'skip']],
    'a real 3 stays a value; the skip stays a skip'
  );

  const gym = byName['Gym'];
  assert.equal(gym.archived, 1);
  assert.equal(gym.freq_numerator, 3);
  assert.equal(gym.freq_denominator, 7);

  // Loop's reminder_hour / reminder_min and its `question`. These were a literal
  // NULL, NULL and '' in the INSERT and absent from the import's SELECT, so a
  // habit's reminder survived neither direction of this trip.
  assert.equal(med.reminder_time, '07:05', 'a reminder time survives');
  assert.equal(med.reminder_message, 'Did you sit for ten minutes?',
    'the prompt survives as Loop\'s question');
  assert.equal(water.reminder_time, '00:00',
    'midnight is a reminder, not the absence of one');
  assert.equal(cigs.reminder_time, '', 'no reminder stays no reminder');
  assert.equal(cigs.reminder_message, '');
  assert.equal(gym.reminder_time, '23:59');

  // reminder_days is Loop's weekday mask, and is what the import gate reads.
  // A habit with a reminder gets all seven bits; one without gets 0, which is
  // what Loop's own writer stores. Read from the file, since nothing above
  // surfaces it.
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path, { readOnly: true });
  const days = Object.fromEntries(
    raw.prepare(`SELECT name, reminder_days FROM Habits`).all()
      .map((r) => [r.name, r.reminder_days])
  );
  raw.close();
  assert.equal(days['Meditate'], 127, 'a reminder is an all-days one');
  assert.equal(days['Cigarettes'], 0, 'no reminder, so no days — as Loop writes it');

  unlinkSync(path);
});

test('the exported file passes Loop\'s own validation query', async () => {
  const path = scratch('loop-valid');
  await writeLoopDatabase(path, HABITS, (id) => ENTRIES[id] ?? []);

  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path, { readOnly: true });

  // This is the exact check LoopDBImporter.isValidFile performs.
  const n = d.prepare(
    `SELECT COUNT(*) AS n FROM SQLITE_MASTER WHERE name='Habits' OR name='Repetitions'`
  ).get().n;
  assert.equal(n, 2, 'both tables must exist');

  // Loop also reads these columns by name.
  const cols = new Set(d.prepare(`PRAGMA table_info(Habits)`).all().map((c) => c.name));
  for (const required of [
    'id', 'name', 'description', 'question', 'freq_num', 'freq_den', 'color',
    'position', 'reminder_hour', 'reminder_min', 'reminder_days', 'highlight',
    'archived', 'type', 'target_value', 'target_type', 'unit', 'uuid',
  ]) {
    assert.ok(cols.has(required), `Habits.${required} must exist`);
  }

  const repCols = new Set(d.prepare(`PRAGMA table_info(Repetitions)`).all().map((c) => c.name));
  for (const required of ['habit', 'timestamp', 'value', 'notes']) {
    assert.ok(repCols.has(required), `Repetitions.${required} must exist`);
  }

  assert.equal(d.prepare('PRAGMA user_version').get().user_version, 25);

  // Every habit must carry a uuid — Loop uses it to deduplicate on import.
  const missing = d.prepare(
    `SELECT COUNT(*) AS n FROM Habits WHERE uuid IS NULL OR uuid = ''`
  ).get().n;
  assert.equal(missing, 0, 'every habit needs a uuid');

  d.close();
  unlinkSync(path);
});

test('the SQLite file header is what Loop sniffs for', async () => {
  const path = scratch('loop-header');
  await writeLoopDatabase(path, HABITS, (id) => ENTRIES[id] ?? []);

  const { readFileSync } = await import('node:fs');
  const buf = readFileSync(path);
  assert.equal(buf.toString('latin1', 0, 15), 'SQLite format 3');

  unlinkSync(path);
});

test('an empty database still produces a valid Loop file', async () => {
  const path = scratch('loop-empty');
  const result = await writeLoopDatabase(path, [], () => []);
  assert.deepEqual(result, { habits: 0, entries: 0, skipped: [] });

  const reimported = await parseLoopDatabase(path);
  assert.deepEqual(reimported, []);
  unlinkSync(path);
});

/* ---------- dates Loop's encoding cannot carry ---------- */

const LONE_HABIT = [{
  id: 1, name: 'Meditate', description: '', type: 'boolean',
  unit: '', target_value: 0, target_type: 'at_least',
  freq_numerator: 1, freq_denominator: 1, color: '#8b5cf6', archived: 0,
}];

test('a date that does not exist is not encodable', () => {
  // `Date.UTC` rolls over instead of refusing, which is the whole trap: each of
  // these produces a perfectly plausible timestamp for a different day.
  assert.equal(isLoopEncodableDate('2026-02-30'), false, 'February has no 30th');
  assert.equal(isLoopEncodableDate('2026-13-45'), false, 'nor a thirteenth month');
  assert.equal(isLoopEncodableDate('2026-02-29'), false, '2026 is not a leap year');
  assert.equal(isLoopEncodableDate('2026-00-10'), false);
  assert.equal(isLoopEncodableDate('2026-01-00'), false);
});

test('an ordinary date is encodable, including the awkward ones', () => {
  for (const iso of [
    '2026-01-01', '2026-06-15', '1998-03-10', '2024-02-29', '9999-12-31',
    // Years 100-999 are the case a STRING round trip gets wrong, because
    // `loopTimestampToISO` does not zero-pad the year — the reader's bug, not
    // the writer's. This guard compares numbers for exactly that reason: it
    // must not drop a row the export has always written correctly. CLAUDE.md
    // cites "one entry dated year 0100" as real data.
    '0100-01-01',
  ]) {
    assert.equal(isLoopEncodableDate(iso), true, iso);
  }
});

test('anything that is not the stored date form is not encodable', () => {
  // `2026-1-1` names the same instant as `2026-01-01`; only the string says
  // they are different days, so an account holding both would collide.
  for (const bad of ['2026-1-1', '', null, undefined, 'yesterday', '2026-01', 42]) {
    assert.equal(isLoopEncodableDate(bad), false, String(bad));
  }
});

test('an impossible date does not take the whole export down with it', async () => {
  // The bug: `isoToLoopTimestamp('2026-02-30')` rolls over onto 2026-03-02, and
  // the real row for that day is already there. The UNIQUE index on
  // (habit, timestamp) rejected the second insert, the rejection escaped
  // `writeLoopDatabase`, and `GET /api/export-loop.db` answered 500 — for as
  // long as the row existed, naming neither the habit nor the date.
  const path = scratch('loop-badcollide');
  const entries = {
    1: [
      { date: '2026-02-30', value: YES, status: '', notes: '' },
      { date: '2026-03-02', value: YES, status: '', notes: 'a real day' },
      { date: '2026-03-03', value: YES, status: '', notes: '' },
    ],
  };

  const result = await writeLoopDatabase(path, LONE_HABIT, (id) => entries[id] ?? []);

  assert.equal(result.entries, 2, 'every real day is still exported');
  assert.deepEqual(result.skipped,
    [{ habit: 1, date: '2026-02-30', reason: 'bad_date' }],
    'and the one that did not make it is named');

  // The row that survives must be the REAL one, notes and all. Dropping the
  // good day and keeping the impostor would also produce a 200 and two rows.
  const [h] = await parseLoopDatabase(path);
  assert.deepEqual(
    h.entries.map((e) => [e.date, e.notes]),
    [['2026-03-02', 'a real day'], ['2026-03-03', '']]
  );

  unlinkSync(path);
});

test('an impossible date is skipped even when nothing collides with it', async () => {
  // The quieter half, and the reason a collision guard alone would be the wrong
  // fix: with no real row on the day it rolls onto, the export SUCCEEDED and
  // wrote 2026-03-02 — filing an entry under a day the user never recorded, in
  // a file they restore into Loop and trust.
  const path = scratch('loop-badalone');
  const entries = { 1: [{ date: '2026-02-30', value: YES, status: '', notes: '' }] };

  const result = await writeLoopDatabase(path, LONE_HABIT, (id) => entries[id] ?? []);

  assert.equal(result.entries, 0);
  assert.deepEqual(result.skipped, [{ habit: 1, date: '2026-02-30', reason: 'bad_date' }]);

  const [h] = await parseLoopDatabase(path);
  assert.deepEqual(h.entries, [], 'no day is invented for it');

  unlinkSync(path);
});

test('a duplicated day is reported rather than thrown', async () => {
  // A backstop that should never fire — see the comment at the insert. It is
  // testable only by handing `entriesFor` something neither edition's storage
  // can produce, which is the point: this module cannot audit that callback,
  // and one throw costs every habit in the file.
  const path = scratch('loop-dup');
  const entries = {
    1: [
      { date: '2026-01-01', value: YES, status: '', notes: 'first' },
      { date: '2026-01-01', value: 0, status: '', notes: 'second' },
      { date: '2026-01-02', value: YES, status: '', notes: '' },
    ],
  };

  const result = await writeLoopDatabase(path, LONE_HABIT, (id) => entries[id] ?? []);

  assert.equal(result.entries, 2);
  assert.deepEqual(result.skipped,
    [{ habit: 1, date: '2026-01-01', reason: 'duplicate_day' }]);

  const [h] = await parseLoopDatabase(path);
  assert.deepEqual(h.entries.map((e) => e.notes), ['first', ''], 'the first wins');

  unlinkSync(path);
});

test('the skip report flattens into one log field', async () => {
  // `log.js` renders EVERY array as `[N items]`, so handing it the report
  // itself reports that something was dropped and never which row — the one
  // part a user can act on, and the whole complaint this change answers.
  const { createLogger } = await import('../src/log.js');
  const lines = [];
  const log = createLogger({ level: 'warn', format: 'json', write: (l) => lines.push(l) });

  const skipped = [{ habit: 7, date: '2026-02-30', reason: 'bad_date' }];
  log.warn('export.rows_skipped', { skipped: skipped.length, rows: skipsForLog(skipped) });

  assert.match(lines[0], /7@2026-02-30=bad_date/, lines[0]);

  // Long enough to be truncated mid-token by MAX_FIELD, which would read as a
  // date that does not exist in the account either.
  const many = Array.from({ length: 25 },
    (_, i) => ({ habit: i, date: '2026-02-30', reason: 'bad_date' }));
  assert.match(skipsForLog(many), / \+5 more$/);
  assert.equal(skipsForLog([]), '');
});

test('a clean account skips nothing, and two habits may hold the same day', async () => {
  // The UNIQUE index is on (habit, timestamp), so the seen-set has to be per
  // habit. One shared across the loop would report every habit after the first
  // as a duplicate and quietly export a single habit's history.
  const path = scratch('loop-sameday');
  const result = await writeLoopDatabase(path, HABITS, (id) => ENTRIES[id] ?? []);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.entries, 8, 'exactly what it always exported');
  unlinkSync(path);
});
