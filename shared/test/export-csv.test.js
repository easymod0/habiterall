import test from 'node:test';
import assert from 'node:assert/strict';

import { zip } from '../src/zip.js';
import { unzip } from '../src/unzip.js';
import {
  buildHabitsCsv, buildCheckmarksCsv, buildCsvArchive, esc,
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
