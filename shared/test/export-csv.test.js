import test from 'node:test';
import assert from 'node:assert/strict';

import { zip } from '../src/zip.js';
import { unzip } from '../src/unzip.js';
import {
  buildHabitsCsv, buildCheckmarksCsv, buildCsvArchive, esc, csvNumber,
} from '../src/export-csv.js';
import { parseLoopHabitsCSV, parseLoopCheckmarksCSV } from '../src/import.js';

/* ---------- the zip writer ---------- */

test('zip writes an archive the reader can open', () => {
  const buf = zip([
    { name: 'a.txt', data: 'hello' },
    { name: 'b.txt', data: 'world' },
  ]);

  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const out = unzip(buf);
  assert.equal(out.get('a.txt').toString(), 'hello');
  assert.equal(out.get('b.txt').toString(), 'world');
});

test('zip round-trips UTF-8 and embedded newlines', () => {
  const content = 'naïve,"quoted"\nsecond line\n';
  const out = unzip(zip([{ name: 'ü.csv', data: content }]));
  assert.equal(out.get('ü.csv').toString('utf8'), content);
});

test('a non-ASCII member name is flagged as UTF-8, in both headers', () => {
  // Our own reader cannot see this — `unzip.js` decodes UTF-8 whatever the
  // flag says — so the check is on the bytes. Without bit 11 a reader is
  // entitled to CP437, and Python's `zipfile` takes it: `Haébits你.csv` came
  // back as `Ha├⌐bitsΣ╜á.csv`.
  const archive = zip([{ name: 'Haébits你.csv', data: 'x' }]);
  const cdAt = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));

  assert.equal(archive.readUInt16LE(6) & 0x0800, 0x0800, 'local header');
  assert.equal(archive.readUInt16LE(cdAt + 8) & 0x0800, 0x0800, 'central directory');
  assert.ok(unzip(archive).has('Haébits你.csv'));
});

test('an ASCII member name is left alone', () => {
  // The flag says nothing about a name CP437 and UTF-8 agree on, and setting
  // it anyway would change every archive this project has ever written for a
  // case that does not exist. `Habits.csv` and `Checkmarks.csv` are both here.
  const archive = zip([{ name: 'Checkmarks.csv', data: 'x' }]);
  const cdAt = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));

  assert.equal(archive.readUInt16LE(6), 0);
  assert.equal(archive.readUInt16LE(cdAt + 8), 0);
});

test('zip handles an empty member', () => {
  const out = unzip(zip([{ name: 'empty.txt', data: '' }]));
  assert.equal(out.get('empty.txt').length, 0);
});

/* ---------- CSV escaping ---------- */

test('esc quotes only fields that need it', () => {
  assert.equal(esc('plain'), 'plain');
  assert.equal(esc('has,comma'), '"has,comma"');
  assert.equal(esc('has"quote'), '"has""quote"');
  assert.equal(esc('has\nnewline'), '"has\nnewline"');
  assert.equal(esc(null), '');
});

/* ---------- numbers ---------- */

test('csvNumber leaves ordinary amounts exactly as they were', () => {
  // The half of this that matters most. Anything a person actually records
  // must come out byte for byte, or the fix would be restating the precision
  // of every value in the file.
  for (const v of [0, 1, 2, 3, 8, 0.5, 12.25, 1000, 0.000001, 1e20, 123456.789]) {
    assert.equal(csvNumber(v), String(v), `${v} should be untouched`);
  }
});

test('csvNumber writes plain digits where JS would write an exponent', () => {
  assert.equal(csvNumber(1e-7), '0.0000001');
  assert.equal(csvNumber(1.5e-7), '0.00000015');
  assert.equal(csvNumber(1e21), '1000000000000000000000');
  assert.equal(csvNumber(1.25e21), '1250000000000000000000');
});

test('csvNumber round-trips through Number() at the extremes', () => {
  // Exact expansion, not rounding: whatever went in has to come back, or a
  // backup would quietly hold a different amount from the one recorded.
  for (const v of [1e-7, 1.5e-7, 5e-324, 1e21, 1.7976931348623157e308, 6.02e23]) {
    const written = csvNumber(v);
    assert.ok(!/e/i.test(written), `${v} still has an exponent: ${written}`);
    assert.equal(Number(written), v, `${written} should read back as ${v}`);
  }
});

/* ---------- the CSV pair ---------- */

const HABITS = [
  {
    id: 1, name: 'Water', description: 'Hydrate', type: 'numerical',
    unit: 'glasses', target_value: 8, target_type: 'at_least',
    freq_numerator: 1, freq_denominator: 1, color: '#22c55e', archived: 0,
    reminder_message: 'How many glasses so far?',
  },
  {
    // A description and NO prompt. The description must not leak into the
    // Question column — with both fields empty this habit could not tell the
    // difference, and the assertion below silently tested nothing.
    id: 2, name: 'Gym, early', description: 'Before work', type: 'boolean',
    unit: '', target_value: 0, target_type: 'at_least',
    freq_numerator: 3, freq_denominator: 7, color: '#f59e0b', archived: 0,
  },
];

const ENTRIES = {
  1: [
    { date: '2026-01-01', value: 8, status: '' },
    // The value that collides with Loop's SKIP sentinel.
    { date: '2026-01-02', value: 3, status: '' },
    { date: '2026-01-03', value: 0, status: 'skip' },
  ],
  2: [
    { date: '2026-01-01', value: 2, status: '' },
    { date: '2026-01-03', value: 0, status: 'skip' },
  ],
};

const entriesFor = (id) => ENTRIES[id] ?? [];

test('Habits.csv is readable by our own Habits.csv parser', () => {
  const meta = parseLoopHabitsCSV(buildHabitsCsv(HABITS));

  const water = meta.get('Water');
  assert.equal(water.type, 'numerical');
  assert.equal(water.unit, 'glasses');
  assert.equal(water.target_value, 8);
  assert.equal(water.target_type, 'at_least');

  // A name containing a comma must survive the quoting.
  const gym = meta.get('Gym, early');
  assert.ok(gym, 'a habit name with a comma round-trips');
  assert.equal(gym.type, 'boolean');
  assert.equal(gym.freq_numerator, 3);
  assert.equal(gym.freq_denominator, 7);
});

test('Question and Description are two columns holding two fields', () => {
  // The description was written into BOTH columns, and the importer read
  // Question as a fallback FOR description — so a habiterall CSV round trip
  // copied the description over the habit's reminder prompt, and the pair of
  // bugs hid each other.
  const meta = parseLoopHabitsCSV(buildHabitsCsv(HABITS));

  const water = meta.get('Water');
  assert.equal(water.reminder_message, 'How many glasses so far?');
  assert.equal(water.description, 'Hydrate');

  // A habit with no prompt writes an empty Question rather than a copy of its
  // description — which is the actual old behaviour, and needs a habit whose
  // description is non-empty to be visible at all.
  const gym = meta.get('Gym, early');
  assert.equal(gym.description, 'Before work');
  assert.equal(gym.reminder_message, '');
});

test('a measurable 3 survives the CSV pair instead of becoming a skip', () => {
  const meta = parseLoopHabitsCSV(buildHabitsCsv(HABITS));
  const parsed = parseLoopCheckmarksCSV(buildCheckmarksCsv(HABITS, entriesFor), meta);

  const water = parsed.find((h) => h.name === 'Water');
  const jan2 = water.entries.find((e) => e.date === '2026-01-02');
  assert.equal(jan2.value, 3);
  assert.equal(jan2.status, '', 'a numerical 3 is an amount, not Loop\'s SKIP');

  const jan3 = water.entries.find((e) => e.date === '2026-01-03');
  assert.equal(jan3.status, 'skip', 'a real skip is still a skip');

  const jan1 = water.entries.find((e) => e.date === '2026-01-01');
  assert.equal(jan1.value, 8, 'amounts above the sentinel range are not dropped');
});

test('an extreme amount reaches the cell as digits, both files', () => {
  // Reachable by writing one: `parseEntry` takes any finite non-negative
  // number, and `parseHabit` any finite non-negative target. Both used to be
  // handed to `String`, so the cell read `1e-7` / `1e+21`.
  const habits = [{
    ...HABITS[0], id: 9, name: 'Trace', unit: 'g', target_value: 1e21,
  }];
  const entries = { 9: [{ date: '2026-01-01', value: 1e-7, status: '' }] };

  const habitsCsv = buildHabitsCsv(habits);
  assert.ok(habitsCsv.includes(',1000000000000000000000,'), habitsCsv);

  const checkmarksCsv = buildCheckmarksCsv(habits, (id) => entries[id] ?? []);
  assert.match(checkmarksCsv, /2026-01-01,0\.0000001\b/);

  const parsed = parseLoopCheckmarksCSV(checkmarksCsv, parseLoopHabitsCSV(habitsCsv));
  const trace = parsed.find((h) => h.name === 'Trace');
  assert.equal(trace.entries[0].value, 1e-7, 'the amount survives the new spelling');
});

test('without Habits.csv the checkmarks alone are ambiguous', () => {
  // Documents *why* the export ships both files: parsed with no metadata,
  // every column defaults to boolean and the 3 is read as a skip. If this
  // ever stops being true, the archive could go back to a single file.
  const parsed = parseLoopCheckmarksCSV(buildCheckmarksCsv(HABITS, entriesFor));
  const water = parsed.find((h) => h.name === 'Water');
  const jan2 = water.entries.find((e) => e.date === '2026-01-02');
  assert.equal(jan2.status, 'skip');
});

test('buildCsvArchive contains both files', () => {
  const members = unzip(buildCsvArchive(HABITS, entriesFor));
  assert.deepEqual([...members.keys()].sort(), ['Checkmarks.csv', 'Habits.csv']);
  assert.match(members.get('Habits.csv').toString(), /^Position,Name,/);
  assert.match(members.get('Checkmarks.csv').toString(), /^Date,Water,/);
});

test('boolean columns use Loop\'s symbolic names', () => {
  const csv = buildCheckmarksCsv(HABITS, entriesFor);
  const rows = csv.trim().split('\n');
  const jan1 = rows.find((r) => r.startsWith('2026-01-01'));
  assert.match(jan1, /YES_MANUAL/);
  const jan3 = rows.find((r) => r.startsWith('2026-01-03'));
  assert.match(jan3, /SKIP/);
});
