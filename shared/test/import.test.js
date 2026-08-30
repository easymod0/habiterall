import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';


const {
  loopTimestampToISO, convertLoopValue, normalizeColor, entryValue,
  parseCSV, parseLoopCheckmarksCSV, parseLoopHabitsCSV, parseLoopDatabase,
  parseHabiterallJSON, MAX_PARSE_HABITS, MAX_PARSE_ENTRIES, backupCategories,
} = await import('../src/import.js');
// Declared here, rather than beside `normaliseImportedHabit` below, because
// `backupCategories`'s own tests above need `LIMITS.categories` and
// `LIMITS.name` too.
const { LIMITS, parseHabit } = await import('../src/validate.js');

const YES = 2, SKIP = 3;

/* ---------- Loop timestamp conversion ---------- */

test('Loop timestamps are epoch millis read as UTC', () => {
  // 2026-01-15T00:00:00Z
  const ms = Date.UTC(2026, 0, 15);
  assert.equal(loopTimestampToISO(ms), '2026-01-15');
});

test('timestamp conversion is timezone-independent', () => {
  // A UTC-midnight timestamp must not slip a day for viewers west of UTC.
  const ms = Date.UTC(2026, 5, 1);
  assert.equal(loopTimestampToISO(ms), '2026-06-01');
  assert.equal(loopTimestampToISO(ms + 3600_000), '2026-06-01', 'mid-day stays on the same date');
});

test('timestamps before 2000 floor correctly', () => {
  assert.equal(loopTimestampToISO(Date.UTC(1998, 2, 10)), '1998-03-10');
});

test('a year below 1000 keeps its leading zeros', () => {
  // Not cosmetic: both editions' `applyImport` admit a date only through
  // `^\d{4}-\d{2}-\d{2}$`, so an unpadded year made a perfectly good Loop
  // timestamp arrive as `100-01-01` and the entry was dropped as malformed —
  // with no error and no skipped-row report. The `boundedRange` note in the
  // root CLAUDE.md cites an entry dated year 0100 as real data.
  const at = (y, m, d) => {
    const t = new Date(0);
    t.setUTCFullYear(y, m - 1, d);
    return t.getTime();
  };
  assert.equal(loopTimestampToISO(at(100, 1, 1)), '0100-01-01');
  assert.equal(loopTimestampToISO(at(999, 12, 31)), '0999-12-31');
  assert.equal(loopTimestampToISO(at(50, 3, 15)), '0050-03-15');
  assert.equal(loopTimestampToISO(at(1, 1, 1)), '0001-01-01');
});

test('invalid timestamps are rejected', () => {
  assert.equal(loopTimestampToISO('nonsense'), null);
  assert.equal(loopTimestampToISO(undefined), null);
});

test('an absent timestamp is not a day in 1970', () => {
  // `Number(null)`, `Number('')`, `Number([])` and `Number(false)` are all 0,
  // and 0 IS a real timestamp — the epoch — so a value check cannot tell a
  // missing column from a genuine 1970-01-01. Only `undefined` and `NaN` were
  // being refused; everything else read back as a real date on a row that had
  // none.
  for (const absent of [null, '', ' ', [], {}, true, false]) {
    assert.equal(loopTimestampToISO(absent), null, JSON.stringify(absent) ?? String(absent));
  }
  // ...while the epoch itself still reads as the day it is.
  assert.equal(loopTimestampToISO(0), '1970-01-01');
  // A numeric string is what a CAST(... AS TEXT) column hands back, and is real.
  assert.equal(loopTimestampToISO(String(Date.UTC(1998, 2, 10))), '1998-03-10');
});

test('a timestamp outside years 1-9999 is no date at all', () => {
  // Padding to four digits is what makes this worth stating: year 0 formats as
  // `0000-01-01`, which the writers' date regex would have accepted as an
  // ordinary date. Before the padding it was `0-01-01` and the regex caught
  // it, so the guard has to arrive with the padding rather than after it.
  assert.equal(loopTimestampToISO(-62_167_219_200_000), null, 'year 0');
  assert.equal(loopTimestampToISO(-100_000_000_000_000), null, 'BCE');
  // Beyond the ECMAScript date range the year is NaN; `275760-09-13` is the
  // far end of it and is not four digits either.
  assert.equal(loopTimestampToISO(8.64e15 + 1), null);
  assert.equal(loopTimestampToISO(8.64e15), null, 'year 275760');
  assert.equal(loopTimestampToISO(Infinity), null);
});

/* ---------- an entry's value ---------- */

test('an entry with no value is not a stated lapse', () => {
  // The same coercion as the timestamp above, with a sharper sink: `Number(null)`
  // and `Number('')` are 0, and a row holding 0 is a STATED lapse — a day the
  // user says they missed. So `{date, value: null}` was written as an answer
  // while `{date}` with no value key at all was refused, which is two spellings
  // of "the file said nothing" behaving differently.
  for (const nothing of [null, undefined, '', ' ', [], {}, true, false, NaN]) {
    assert.equal(entryValue(nothing), null, JSON.stringify(nothing) ?? String(nothing));
  }
  // ...while a stated zero still is one. This is the whole reason the check has
  // to be about the type: 0 is a legitimate value and indistinguishable from
  // `Number(null)` once the coercion has run.
  assert.equal(entryValue(0), 0);
});

test('a value that was stated is read, in the forms people write', () => {
  assert.equal(entryValue(8), 8);
  assert.equal(entryValue(2.5), 2.5);
  assert.equal(entryValue('8'), 8, 'a hand-written file quotes its numbers');
  assert.equal(entryValue(' 6 '), 6);
  assert.equal(entryValue('2.5'), 2.5);
  // Number()'s generosity about the FORM goes with its generosity about
  // nothing: neither is how anyone writes down a number of glasses of water.
  assert.equal(entryValue('0x10'), null);
  assert.equal(entryValue('1e3'), null);
  assert.equal(entryValue('8 glasses'), null);
  // Not finite, so not a value — the writers used to ask `Number.isFinite`
  // separately and now get the answer from here.
  assert.equal(entryValue(Infinity), null);
  assert.equal(entryValue(-Infinity), null);
  // Negative is a real number and rejected by the WRITERS, not here: `value < 0`
  // is a storage rule (both editions' columns are `CHECK (value >= 0)`), where
  // this function answers only "did the file state a number".
  assert.equal(entryValue(-1), -1);
});

/* ---------- Loop value conversion ---------- */

test('boolean sentinels map to habiterall encoding', () => {
  assert.deepEqual(convertLoopValue(2, false), { value: YES, status: '' }, 'YES_MANUAL');
  assert.deepEqual(convertLoopValue(1, false), { value: YES, status: '' }, 'YES_AUTO counts as done');
  assert.deepEqual(convertLoopValue(3, false), { value: 0, status: 'skip' }, 'SKIP');
  // NO and UNKNOWN are two different days, and collapsing them was losing real
  // data: on a backup from anyone not using Loop's question marks, an explicit
  // "I missed it" is most of the history, and all of it used to be dropped.
  assert.deepEqual(convertLoopValue(0, false), { value: 0, status: '' },
    'NO is a stated lapse and keeps its row');
  assert.equal(convertLoopValue(-1, false), null, 'UNKNOWN has no row at all');
});

test('numerical values are unscaled by 1000', () => {
  assert.deepEqual(convertLoopValue(7500, true), { value: 7.5, status: '' });
  assert.deepEqual(convertLoopValue(8000, true), { value: 8, status: '' });
  assert.deepEqual(convertLoopValue(0, true), { value: 0, status: '' },
    'a recorded zero is meaningful');
});

test('skip survives on numerical habits', () => {
  assert.deepEqual(convertLoopValue(3, true), { value: 0, status: 'skip' });
});

test('a numerical 3 units does NOT collide with the SKIP sentinel', () => {
  // Loop stores 3 units as 3000. Before the status column existed this
  // unscaled to 3 and was silently reclassified as a skip.
  const threeUnits = convertLoopValue(3000, true);
  const skip = convertLoopValue(3, true);

  assert.deepEqual(threeUnits, { value: 3, status: '' }, '3000 is three units');
  assert.equal(skip.status, 'skip');
  assert.notEqual(threeUnits.status, skip.status,
    'a real amount must never be indistinguishable from a skip');
});

/* ---------- colors ---------- */

test('hex colors pass through, palette indices map to hex', () => {
  assert.equal(normalizeColor('#ff8800'), '#ff8800');
  assert.match(normalizeColor(5), /^#[0-9a-f]{6}$/);
  assert.equal(normalizeColor('garbage'), '#3b82f6', 'falls back to blue');
});

/* ---------- CSV parsing ---------- */

test('CSV parser handles quotes, embedded commas and escapes', () => {
  const rows = parseCSV('a,"b,c",d\n1,"say ""hi""",3\n');
  assert.deepEqual(rows[0], ['a', 'b,c', 'd']);
  assert.deepEqual(rows[1], ['1', 'say "hi"', '3']);
});

test('CSV parser tolerates CRLF and a BOM', () => {
  const rows = parseCSV('﻿Date,X\r\n2026-01-01,YES_MANUAL\r\n');
  assert.deepEqual(rows[0], ['Date', 'X']);
  assert.deepEqual(rows[1], ['2026-01-01', 'YES_MANUAL']);
});

/* ---------- Loop Checkmarks.csv ---------- */

test('Checkmarks.csv yields one habit per column', () => {
  const csv = [
    'Date,Meditate,Read',
    '2026-01-01,YES_MANUAL,NO',
    '2026-01-02,SKIP,YES_AUTO',
    '2026-01-03,NO,YES_MANUAL',
  ].join('\n');

  const habits = parseLoopCheckmarksCSV(csv);
  assert.deepEqual(habits.map((h) => h.name), ['Meditate', 'Read']);

  const meditate = habits[0];
  assert.deepEqual(
    meditate.entries.map((e) => [e.date, e.value, e.status]),
    [['2026-01-01', YES, ''], ['2026-01-02', 0, 'skip'], ['2026-01-03', 0, '']],
    'a NO cell is a stated lapse and keeps its row; skip is flagged out-of-band'
  );

  const read = habits[1];
  assert.deepEqual(read.entries.map((e) => [e.date, e.value]),
    [['2026-01-01', 0], ['2026-01-02', YES], ['2026-01-03', YES]],
    'YES_AUTO counts as done, and the NO on the first day is a row of its own');
});

test('numerical columns use Habits.csv metadata', () => {
  const habitsCsv = [
    'Position,Name,Type,Question,Description,FrequencyNumerator,FrequencyDenominator,Color,Unit,Target Type,Target Value,Archived?',
    '001,Water,Measurable,,Stay hydrated,1,1,10,glasses,At Least,8.0,false',
  ].join('\n');
  const meta = parseLoopHabitsCSV(habitsCsv);

  assert.equal(meta.get('Water').type, 'numerical');
  assert.equal(meta.get('Water').unit, 'glasses');
  assert.equal(meta.get('Water').target_value, 8);
  assert.equal(meta.get('Water').target_type, 'at_least');

  const checkmarks = 'Date,Water\n2026-01-01,6\n2026-01-02,9\n';
  const [water] = parseLoopCheckmarksCSV(checkmarks, meta);

  assert.equal(water.type, 'numerical');
  assert.deepEqual(water.entries.map((e) => e.value), [6, 9],
    'CSV numerical values are already human-scale');
});

test('Habits.csv accepts Loop\'s NUMERICAL / YES_NO enum names', () => {
  const csv = [
    'Position,Name,Type,Question,Description,FrequencyNumerator,FrequencyDenominator,Color,Unit,Target Type,Target Value,Archived?',
    '001,Water,NUMERICAL,,,1,1,10,glasses,AT_LEAST,8.0,false',
    '002,Meditate,YES_NO,,,1,1,11,,,,false',
  ].join('\n');

  const meta = parseLoopHabitsCSV(csv);
  assert.equal(meta.get('Water').type, 'numerical');
  assert.equal(meta.get('Water').target_type, 'at_least');
  assert.equal(meta.get('Meditate').type, 'boolean',
    'YES_NO must not be misread as numerical');
});

test('Habits.csv question and description are two fields, not one', () => {
  // `question` used to be read as a FALLBACK for description. `idx` matches on
  // HEADERS and a real Loop export always has a `Description` one, so the
  // fallback never fired there and the prompt was simply DROPPED, exactly as
  // the .db path dropped it. Loop's question is habiterall's reminder_message,
  // and that is where it goes now — note Floss below, which has a prompt and an
  // empty description and did NOT come back with the prompt as its description.
  const csv = [
    'Position,Name,Type,Question,Description,FrequencyNumerator,FrequencyDenominator,Color,Unit,Target Type,Target Value,Archived?',
    '001,Meditate,YES_NO,Did you sit today?,Ten minutes each morning,1,1,11,,,,false',
    '002,Floss,YES_NO,Did you floss?,,1,1,11,,,,false',
  ].join('\n');

  const meta = parseLoopHabitsCSV(csv);
  assert.equal(meta.get('Meditate').reminder_message, 'Did you sit today?');
  assert.equal(meta.get('Meditate').description, 'Ten minutes each morning');

  // The case the old fallback got wrong: a question and no description.
  assert.equal(meta.get('Floss').reminder_message, 'Did you floss?');
  assert.equal(meta.get('Floss').description, '',
    'an empty description stays empty rather than borrowing the question');
});

test('a question read from Habits.csv reaches the parsed habit', () => {
  // parseLoopCheckmarksCSV builds each habit field by field from the metadata
  // map, so a field missing from that list is dropped however well it parsed.
  const csv = [
    'Position,Name,Type,Question,Description,FrequencyNumerator,FrequencyDenominator,Color,Unit,Target Type,Target Value,Archived?',
    '001,Meditate,YES_NO,Did you sit today?,Ten minutes,1,1,11,,,,false',
  ].join('\n');
  const [habit] = parseLoopCheckmarksCSV(
    'Date,Meditate\n2026-01-01,2\n', parseLoopHabitsCSV(csv)
  );
  assert.equal(habit.reminder_message, 'Did you sit today?');
  assert.equal(habit.description, 'Ten minutes');
});

test('a habit with no Habits.csv metadata has no prompt', () => {
  const [habit] = parseLoopCheckmarksCSV('Date,Ghost\n2026-01-01,2\n');
  assert.equal(habit.reminder_message, '');
});

test('Habits.csv reads AT_MOST enum form', () => {
  const csv = [
    'Position,Name,Type,Question,Description,FrequencyNumerator,FrequencyDenominator,Color,Unit,Target Type,Target Value,Archived?',
    '001,Smoking,NUMERICAL,,,1,1,3,cigarettes,AT_MOST,0.0,false',
  ].join('\n');
  assert.equal(parseLoopHabitsCSV(csv).get('Smoking').target_type, 'at_most');
});

test('Habits.csv at-most targets and archived flag are read', () => {
  const csv = [
    'Position,Name,Type,Question,Description,FrequencyNumerator,FrequencyDenominator,Color,Unit,Target Type,Target Value,Archived?',
    '002,Smoking,Measurable,,,1,1,3,cigarettes,At Most,0.0,true',
    '003,Gym,Yes/No,,,3,7,5,,,,false',
  ].join('\n');

  const meta = parseLoopHabitsCSV(csv);
  assert.equal(meta.get('Smoking').target_type, 'at_most');
  assert.equal(meta.get('Smoking').archived, 1);
  assert.equal(meta.get('Gym').type, 'boolean');
  assert.equal(meta.get('Gym').freq_numerator, 3);
  assert.equal(meta.get('Gym').freq_denominator, 7);
});

test('Checkmarks.csv rejects a file with no Date column', () => {
  assert.throws(() => parseLoopCheckmarksCSV('Foo,Bar\n1,2\n'), /Date/);
});

test('a Checkmarks.csv with no rows under it still names its habits', () => {
  // The row count says how many days have been answered; only the header says
  // what exists. Bailing on `rows.length < 2` read "no entries" as "no habits",
  // which is what an account that backs itself up on its first day exports.
  const habits = parseLoopCheckmarksCSV('Date,Alpha,Beta\n');
  assert.deepEqual(habits.map((h) => h.name), ['Alpha', 'Beta']);
  assert.deepEqual(habits.map((h) => h.entries.length), [0, 0]);
});

test('a header-only Checkmarks.csv still has to be a Checkmarks.csv', () => {
  // Reading the header rather than the rows must not turn the Date check into
  // something only a file with data has to pass.
  assert.throws(() => parseLoopCheckmarksCSV('Foo,Bar\n'), /Date/);
  assert.deepEqual(parseLoopCheckmarksCSV(''), [],
    'an empty file describes nothing, and the API answers 400 for that');
});

/* ---------- Loop .db backup ---------- */

/** Build a synthetic Loop database matching the real schema. */
async function makeLoopDb(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE Habits (
      id INTEGER PRIMARY KEY, name TEXT, description TEXT, question TEXT,
      freq_num INTEGER, freq_den INTEGER, color INTEGER, position INTEGER,
      reminder_hour INTEGER, reminder_min INTEGER, reminder_days INTEGER,
      highlight INTEGER, archived INTEGER, type INTEGER,
      target_value REAL, target_type INTEGER, unit TEXT, uuid TEXT
    );
    CREATE TABLE Repetitions (
      id INTEGER PRIMARY KEY, habit INTEGER, timestamp INTEGER,
      value INTEGER, notes TEXT
    );
  `);

  // Meditate has a question and a 07:05 reminder; Water has a MIDNIGHT one,
  // where both columns are 0 and only a presence check tells it from no
  // reminder at all; Gym leaves both NULL, which is Loop's "no reminder".
  d.prepare(`INSERT INTO Habits (id,name,description,question,freq_num,freq_den,color,
    position,archived,type,target_value,target_type,unit,reminder_hour,reminder_min,reminder_days)
    VALUES (1,'Meditate','Daily sit','Did you sit today?',1,1,11,0,0,0,0,0,'',7,5,127)`).run();
  d.prepare(`INSERT INTO Habits (id,name,description,question,freq_num,freq_den,color,
    position,archived,type,target_value,target_type,unit,reminder_hour,reminder_min,reminder_days)
    VALUES (2,'Water','','',1,1,9,1,0,1,8,0,'glasses',0,0,127)`).run();
  d.prepare(`INSERT INTO Habits (id,name,description,question,freq_num,freq_den,color,
    position,archived,type,target_value,target_type,unit)
    VALUES (3,'Gym','','',3,7,5,2,1,0,0,0,'')`).run();

  const rep = d.prepare(`INSERT INTO Repetitions (habit,timestamp,value,notes) VALUES (?,?,?,?)`);
  rep.run(1, Date.UTC(2026, 0, 1), 2, 'felt good');  // YES_MANUAL
  rep.run(1, Date.UTC(2026, 0, 2), 3, '');           // SKIP
  rep.run(1, Date.UTC(2026, 0, 3), 0, '');           // NO -> dropped
  rep.run(1, Date.UTC(2026, 0, 4), 1, '');           // YES_AUTO -> YES
  rep.run(2, Date.UTC(2026, 0, 1), 7500, '');        // 7.5 glasses
  rep.run(2, Date.UTC(2026, 0, 2), 9000, '');        // 9 glasses
  rep.run(3, Date.UTC(2026, 0, 5), 2, '');
  d.close();
}

test('Loop .db backup imports habits, types, targets and entries', async () => {
  const path = join(tmpdir(), `loop-test-${process.pid}.db`);
  try { unlinkSync(path); } catch {}
  await makeLoopDb(path);

  const habits = await parseLoopDatabase(path);
  assert.equal(habits.length, 3);

  const [meditate, water, gym] = habits;

  assert.equal(meditate.name, 'Meditate');
  assert.equal(meditate.type, 'boolean');
  assert.equal(meditate.description, 'Daily sit');
  assert.deepEqual(
    meditate.entries.map((e) => [e.date, e.value, e.status]),
    [
      ['2026-01-01', YES, ''],
      ['2026-01-02', 0, 'skip'],
      ['2026-01-03', 0, ''],       // Loop NO: a day the user said they missed
      ['2026-01-04', YES, ''],
    ],
    'NO keeps its row; YES_AUTO becomes YES; skip is out-of-band'
  );
  assert.equal(meditate.entries[0].notes, 'felt good', 'notes survive');

  assert.equal(water.type, 'numerical');
  assert.equal(water.unit, 'glasses');
  assert.equal(water.target_value, 8,
    'the target is stored UNSCALED in Habits, unlike entry values');
  assert.deepEqual(water.entries.map((e) => e.value), [7.5, 9], 'values unscaled');

  assert.equal(gym.archived, 1);
  assert.equal(gym.freq_numerator, 3);
  assert.equal(gym.freq_denominator, 7);

  // Loop's reminder_hour / reminder_min and its `question`, none of which were
  // in the SELECT at all — so a Loop backup's reminders were discarded on the
  // way in while the file had carried them all along.
  assert.equal(meditate.reminder_time, '07:05');
  assert.equal(meditate.reminder_message, 'Did you sit today?',
    'Loop\'s question is habiterall\'s reminder prompt');
  assert.equal(water.reminder_time, '00:00',
    'both columns 0 is midnight, not the absence of a reminder');
  assert.equal(gym.reminder_time, '', 'NULL columns are no reminder');
  assert.equal(gym.reminder_message, '');

  unlinkSync(path);
});

test('habit targets are NOT scaled, but entry values ARE', async () => {
  // Taken verbatim from a real Loop backup: "Brush Teeth, at most 2 Times"
  // is stored as Habits.target_value = 2 while its Repetitions carry
  // value = 2000. Dividing the target by 1000 (as entry values require)
  // turned the target into 0.002, so the habit could never be met.
  const path = join(tmpdir(), `loop-target-${process.pid}-${Math.round(performance.now())}.db`);
  try { unlinkSync(path); } catch {}

  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE Habits (id INTEGER PRIMARY KEY, name TEXT, description TEXT,
      question TEXT, freq_num INTEGER, freq_den INTEGER, color INTEGER,
      position INTEGER, archived INTEGER, type INTEGER, target_value REAL,
      target_type INTEGER, unit TEXT);
    CREATE TABLE Repetitions (id INTEGER PRIMARY KEY, habit INTEGER,
      timestamp INTEGER, value INTEGER, notes TEXT);
  `);
  d.prepare(`INSERT INTO Habits VALUES
    (7,'Brush Teeth','','',1,1,11,0,0,1,2,1,'Times')`).run();
  d.prepare(`INSERT INTO Repetitions (habit,timestamp,value,notes)
    VALUES (7,?,2000,'')`).run(Date.UTC(2026, 7, 11));
  d.close();

  const [habit] = await parseLoopDatabase(path);

  assert.equal(habit.target_value, 2, 'the target must survive unscaled');
  assert.equal(habit.target_type, 'at_most');
  assert.equal(habit.unit, 'Times');
  assert.equal(habit.entries[0].value, 2, 'the entry value IS scaled by 1000');

  unlinkSync(path);
});

test('only an all-days Loop reminder comes across', async () => {
  // reminder_days is a 7-bit weekday mask and habiterall has no concept of one.
  // Importing the time alone turned a Monday-only reminder into seven
  // notifications a week — and re-exporting wrote that widening back into the
  // user's own Loop app. Missing is the honest answer until habiterall grows
  // the concept; `days = 0` is the sharp case, a reminder that fires on no day
  // becoming a daily one.
  const path = join(tmpdir(), `loop-days-${process.pid}.db`);
  try { unlinkSync(path); } catch {}

  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE Habits (id INTEGER PRIMARY KEY, name TEXT, freq_num INTEGER,
      freq_den INTEGER, reminder_hour INTEGER, reminder_min INTEGER,
      reminder_days INTEGER);
    CREATE TABLE Repetitions (id INTEGER PRIMARY KEY, habit INTEGER,
      timestamp INTEGER, value INTEGER);
  `);
  const ins = d.prepare(`INSERT INTO Habits VALUES (?,?,1,1,8,0,?)`);
  ins.run(1, 'EveryDay', 127);
  ins.run(2, 'MondayOnly', 2);
  ins.run(3, 'NoDaysAtAll', 0);
  d.close();

  const byName = Object.fromEntries(
    (await parseLoopDatabase(path)).map((h) => [h.name, h])
  );
  assert.equal(byName['EveryDay'].reminder_time, '08:00', 'all seven bits: kept');
  assert.equal(byName['MondayOnly'].reminder_time, '',
    'a weekday-restricted reminder has no faithful form here');
  assert.equal(byName['NoDaysAtAll'].reminder_time, '',
    'a reminder that fires on no day must not become a daily one');

  unlinkSync(path);
});

test('a reminder column holding text is not coerced into a time', async () => {
  // `Number('')` is 0, so a bare `Number.isInteger(Number(x))` guard read an
  // EMPTY column as a real midnight reminder — a notification on a habit that
  // never had one. An INTEGER column holds text happily: SQLite's affinity
  // converts a well-formed number on the way in (so '1e1' really is stored as
  // 10, and reading it as 10:00 is SQLite's doing and correct) but leaves
  // everything else exactly as typed.
  const path = join(tmpdir(), `loop-textcol-${process.pid}.db`);
  try { unlinkSync(path); } catch {}

  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE Habits (id INTEGER PRIMARY KEY, name TEXT, freq_num INTEGER,
      freq_den INTEGER, reminder_hour INTEGER, reminder_min INTEGER,
      reminder_days INTEGER);
    CREATE TABLE Repetitions (id INTEGER PRIMARY KEY, habit INTEGER,
      timestamp INTEGER, value INTEGER);
  `);
  const ins = d.prepare(`INSERT INTO Habits VALUES (?,?,1,1,?,?,127)`);
  ins.run(1, 'Empty', '', '');
  ins.run(2, 'Spaces', ' ', ' ');
  ins.run(3, 'Hex', '0x7', '0');
  ins.run(4, 'Words', 'abc', 'def');
  ins.run(5, 'Real', 8, 0);
  d.close();

  const byName = Object.fromEntries(
    (await parseLoopDatabase(path)).map((h) => [h.name, h])
  );
  for (const n of ['Empty', 'Spaces', 'Hex', 'Words']) {
    assert.equal(byName[n].reminder_time, '', `${n} must not become a time`);
  }
  assert.equal(byName['Real'].reminder_time, '08:00', 'a real one still works');

  unlinkSync(path);
});

test('an out-of-range reminder column does not reject the whole backup', async () => {
  // These columns are selected as TEXT precisely so node:sqlite's row decoder
  // never sees them: an integer above 2^53 makes it throw for the entire
  // `.all()`, so one garbage cell used to take a whole importable backup with
  // it.
  const path = join(tmpdir(), `loop-huge-${process.pid}.db`);
  try { unlinkSync(path); } catch {}

  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE Habits (id INTEGER PRIMARY KEY, name TEXT, freq_num INTEGER,
      freq_den INTEGER, reminder_hour INTEGER, reminder_min INTEGER,
      reminder_days INTEGER);
    CREATE TABLE Repetitions (id INTEGER PRIMARY KEY, habit INTEGER,
      timestamp INTEGER, value INTEGER);
  `);
  d.prepare(`INSERT INTO Habits VALUES (1,'Huge',1,1,9223372036854775807,0,127)`).run();
  d.prepare(`INSERT INTO Habits VALUES (2,'Fine',1,1,8,0,127)`).run();
  d.close();

  const habits = await parseLoopDatabase(path);
  assert.equal(habits.length, 2, 'the importable habit still imports');
  assert.equal(habits[0].reminder_time, '', 'the garbage column is just no reminder');
  assert.equal(habits[1].reminder_time, '08:00');

  unlinkSync(path);
});

test('a Loop schema without the reminder or question columns still imports', async () => {
  // `pick` exists because these columns arrived in later schema versions. Three
  // of the four fields this file now reads are optional ones, so a backup from
  // an old Loop install has to come back as "no reminder, no prompt" rather
  // than failing the whole import on a missing column.
  const path = join(tmpdir(), `loop-old-schema-${process.pid}.db`);
  try { unlinkSync(path); } catch {}

  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE Habits (
      id INTEGER PRIMARY KEY, name TEXT, freq_num INTEGER, freq_den INTEGER
    );
    CREATE TABLE Repetitions (
      id INTEGER PRIMARY KEY, habit INTEGER, timestamp INTEGER, value INTEGER
    );
  `);
  d.prepare(`INSERT INTO Habits (id,name,freq_num,freq_den) VALUES (1,'Meditate',1,1)`).run();
  d.prepare(`INSERT INTO Repetitions (habit,timestamp,value) VALUES (1,?,2)`)
    .run(Date.UTC(2026, 0, 1));
  d.close();

  const [habit] = await parseLoopDatabase(path);
  assert.equal(habit.name, 'Meditate');
  assert.equal(habit.reminder_time, '');
  assert.equal(habit.reminder_message, '');
  assert.equal(habit.entries.length, 1, 'the entries still come through');

  unlinkSync(path);
});

test('a non-Loop SQLite file is rejected', async () => {
  const path = join(tmpdir(), `not-loop-${process.pid}.db`);
  try { unlinkSync(path); } catch {}
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec('CREATE TABLE Unrelated (id INTEGER PRIMARY KEY)');
  d.close();

  await assert.rejects(() => parseLoopDatabase(path), /not a Loop database/);
  unlinkSync(path);
});

test('a Loop db missing later-version columns still imports', async () => {
  // Older backups predate `unit`, `target_type`, and `notes`.
  const path = join(tmpdir(), `loop-old-${process.pid}.db`);
  try { unlinkSync(path); } catch {}
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE Habits (id INTEGER PRIMARY KEY, name TEXT, description TEXT,
      freq_num INTEGER, freq_den INTEGER, color INTEGER, position INTEGER, archived INTEGER);
    CREATE TABLE Repetitions (id INTEGER PRIMARY KEY, habit INTEGER, timestamp INTEGER, value INTEGER);
  `);
  d.prepare(`INSERT INTO Habits VALUES (1,'Legacy','',1,1,4,0,0)`).run();
  d.prepare(`INSERT INTO Repetitions (habit,timestamp,value) VALUES (1,?,2)`)
    .run(Date.UTC(2026, 0, 9));
  d.close();

  const habits = await parseLoopDatabase(path);
  assert.equal(habits.length, 1);
  assert.equal(habits[0].name, 'Legacy');
  assert.equal(habits[0].type, 'boolean', 'defaults to boolean when type is absent');
  assert.deepEqual(habits[0].entries.map((e) => e.date), ['2026-01-09']);

  unlinkSync(path);
});

/* ---------- a hostile .db must not decide how much memory this costs ---------- */

/**
 * A Loop-shaped database of exactly `rows` rows in one table and a valid
 * minimum in the other, so each ceiling can be pushed on its own.
 *
 * Every Repetitions row is Loop's UNKNOWN(-1), which the parser drops. That is
 * deliberate: nothing survives into the result, so what the ceiling is being
 * asked to bound is the READ, with no output to hide behind.
 */
async function makeOversizedDb(path, kind, rows) {
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE Habits (id INTEGER PRIMARY KEY, name TEXT, description TEXT, question TEXT,
      freq_num INTEGER, freq_den INTEGER, color INTEGER, position INTEGER, archived INTEGER,
      type INTEGER, target_value REAL, target_type INTEGER, unit TEXT,
      reminder_hour INTEGER, reminder_min INTEGER, reminder_days INTEGER);
    CREATE TABLE Repetitions (habit INTEGER, timestamp INTEGER, value INTEGER, notes TEXT);
  `);
  d.exec('BEGIN');
  if (kind === 'habits') {
    const ins = d.prepare(`INSERT INTO Habits VALUES (?,?,'','',1,1,11,?,0,0,0,0,'',NULL,NULL,127)`);
    for (let i = 1; i <= rows; i++) ins.run(i, `h${i}`, i);
  } else {
    d.prepare(`INSERT INTO Habits VALUES (1,'one','','',1,1,11,0,0,0,0,0,'',NULL,NULL,127)`).run();
    const ins = d.prepare(`INSERT INTO Repetitions VALUES (1,?,-1,'')`);
    for (let i = 1; i <= rows; i++) ins.run(i * 86_400_000);
  }
  d.exec('COMMIT');
  d.close();
}

/**
 * Parse in a child process with a 64MB heap, and report how it went.
 *
 * A child because the failure this pins is not an exception: `.all()` aborts
 * the whole process inside `node::sqlite::StatementExecutionHelper::All`, so
 * before the fix this does not fail an assertion, it takes the test runner's
 * subprocess down with SIGABRT and exit code 134. The heap cap is what keeps
 * that fast and cheap — the ceilings hold ~20MB, and 64MB is comfortably above
 * them and comfortably below what an unbounded read of these files needs.
 */
async function parseInCappedChild(path) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const src = new URL('../src/import.js', import.meta.url).href;
  const script = `
    const { parseLoopDatabase } = await import(${JSON.stringify(src)});
    try {
      const habits = await parseLoopDatabase(${JSON.stringify(path)});
      console.log('OK ' + habits.length);
    } catch (err) {
      console.log('THREW ' + err.status + ' ' + err.message);
    }`;

  try {
    const { stdout } = await promisify(execFile)(
      process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', script],
      { maxBuffer: 1 << 20 }
    );
    return stdout.trim();
  } catch (err) {
    return `DIED signal=${err.signal} code=${err.code}`;
  }
}

test('rows belonging to no habit are billed, not scanned for free', async () => {
  // The ceilings bounded memory and not time. `WHERE habit = ?` inside the
  // habit loop is one full table scan per habit on a file that omits the index
  // Loop's own schema has — and the budget could not see it, because a budget
  // spent by rows RETURNED is never spent by rows that match nothing. Measured
  // before the fix: 2,000 habits x 300,000 unmatched rows in a 6.4MB file took
  // 13.5 seconds and returned zero entries. Now it is one pass, every row is
  // billed, and this file is refused in a fraction of a second.
  const path = join(tmpdir(), `loop-scan-${process.pid}.db`);
  try { unlinkSync(path); } catch {}

  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE Habits (id INTEGER PRIMARY KEY, name TEXT, freq_num INTEGER, freq_den INTEGER);
    CREATE TABLE Repetitions (id INTEGER PRIMARY KEY, habit INTEGER, timestamp INTEGER, value INTEGER);
  `);
  d.exec('BEGIN');
  const h = d.prepare(`INSERT INTO Habits (id,name,freq_num,freq_den) VALUES (?,?,1,1)`);
  for (let i = 1; i <= 20; i++) h.run(i, 'h' + i);
  // Every row points at a habit that does not exist.
  const r = d.prepare(`INSERT INTO Repetitions (habit,timestamp,value) VALUES (?,?,?)`);
  for (let i = 0; i <= MAX_PARSE_ENTRIES; i++) r.run(999999, 1767225600000 + i * 86_400_000, 2);
  d.exec('COMMIT');
  d.close();

  await assert.rejects(() => parseLoopDatabase(path), (e) =>
    e.status === 400 && new RegExp(`more than ${MAX_PARSE_ENTRIES} entries`).test(e.message));

  unlinkSync(path);
});

test('one pass still puts every entry on its own habit, in order', async () => {
  // Reading Repetitions once and bucketing is only correct if the buckets are
  // right: the old query filtered per habit and sorted per habit, and this has
  // to do both from a single `ORDER BY habit, timestamp`.
  const path = join(tmpdir(), `loop-buckets-${process.pid}.db`);
  try { unlinkSync(path); } catch {}

  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE Habits (id INTEGER PRIMARY KEY, name TEXT, freq_num INTEGER, freq_den INTEGER, type INTEGER);
    CREATE TABLE Repetitions (id INTEGER PRIMARY KEY, habit INTEGER, timestamp INTEGER, value INTEGER, notes TEXT);
  `);
  d.prepare(`INSERT INTO Habits VALUES (1,'A',1,1,0)`).run();
  d.prepare(`INSERT INTO Habits VALUES (2,'B',1,1,1)`).run();
  // Interleaved and out of order on purpose, and habit 3 does not exist.
  const r = d.prepare(`INSERT INTO Repetitions (habit,timestamp,value,notes) VALUES (?,?,?,?)`);
  r.run(2, Date.UTC(2026, 0, 3), 7000, '');
  r.run(1, Date.UTC(2026, 0, 2), 2, 'second');
  r.run(3, Date.UTC(2026, 0, 9), 2, 'orphan');
  r.run(2, Date.UTC(2026, 0, 1), 5000, '');
  r.run(1, Date.UTC(2026, 0, 1), 2, 'first');
  d.close();

  const byName = Object.fromEntries(
    (await parseLoopDatabase(path)).map((x) => [x.name, x])
  );
  assert.deepEqual(byName.A.entries.map((e) => e.date), ['2026-01-01', '2026-01-02'],
    'sorted within the habit, not merely in file order');
  assert.equal(byName.A.entries[0].notes, 'first');
  assert.deepEqual(byName.B.entries.map((e) => e.value), [5, 7],
    'the numerical habit keeps its own rows, unscaled by its own type');
  assert.equal(Object.keys(byName).length, 2, 'the orphan row invented no habit');

  unlinkSync(path);
});

test('a hostile CSV is refused too, and it is the cheaper attack', async () => {
  // The .db ceiling landed first and left this path open. A header is ONE LINE,
  // so `Date,a,a,a,…` two million times is 7.6MB of CSV that deflates to under
  // 8KB — a ~1000:1 amplification the SQLite route could not reach — and every
  // column becomes a habit object. Measured before the ceiling: that upload
  // aborted a 512MB heap, uncatchably, exactly as the .db bomb did.
  const wide = 'Date' + ',a'.repeat(MAX_PARSE_HABITS + 1) + '\n2026-01-01' +
    ',2'.repeat(MAX_PARSE_HABITS + 1) + '\n';
  assert.throws(() => parseLoopCheckmarksCSV(wide), (e) =>
    e.status === 400 && new RegExp(`more than ${MAX_PARSE_HABITS} habits`).test(e.message));

  // And the other factor: few columns, but more cells than the budget allows.
  // Bounded as a TOTAL, so neither factor can be traded against the other.
  const cols = 10;
  const rowsNeeded = Math.ceil((MAX_PARSE_ENTRIES + 1) / cols);
  const tall = ['Date,' + Array.from({ length: cols }, (_, i) => 'h' + i).join(',')];
  for (let d = 0; d < rowsNeeded; d++) {
    tall.push(new Date(Date.UTC(2000, 0, 1) + d * 86_400_000).toISOString().slice(0, 10) +
      ',YES'.repeat(cols));
  }
  assert.throws(() => parseLoopCheckmarksCSV(tall.join('\n') + '\n'), (e) =>
    e.status === 400 && new RegExp(`more than ${MAX_PARSE_ENTRIES} entries`).test(e.message));
});

test('a hostile JSON backup is refused as well', () => {
  // Lower amplification — it arrives uncompressed — but the body limit is no
  // bound on object count: `{"name":"a","entries":[]}` is 26 bytes, so 16MB
  // still describes several hundred thousand habits.
  const many = { version: 1, app: 'habiterall',
    habits: Array.from({ length: MAX_PARSE_HABITS + 1 }, (_, i) => ({ name: 'h' + i })) };
  assert.throws(() => parseHabiterallJSON(many), (e) =>
    e.status === 400 && new RegExp(`more than ${MAX_PARSE_HABITS} habits`).test(e.message));

  const deep = { version: 1, app: 'habiterall',
    habits: [{ name: 'one',
      entries: Array.from({ length: MAX_PARSE_ENTRIES + 1 }, () => ({ date: '2026-01-01', value: 2 })) }] };
  assert.throws(() => parseHabiterallJSON(deep), (e) =>
    e.status === 400 && new RegExp(`more than ${MAX_PARSE_ENTRIES} entries`).test(e.message));
});

test('a real power user is nowhere near either ceiling', () => {
  // The bound is on a hostile file, not a product limit, and a parser that
  // refuses a legitimate backup is its own kind of data loss. 60 habits kept
  // every day for five years is 109,500 entries.
  const names = Array.from({ length: 60 }, (_, i) => 'h' + i);
  const rows = ['Date,' + names.join(',')];
  for (let d = 0; d < 1825; d++) {
    rows.push(new Date(Date.UTC(2020, 0, 1) + d * 86_400_000).toISOString().slice(0, 10) +
      ',YES'.repeat(60));
  }
  const habits = parseLoopCheckmarksCSV(rows.join('\n') + '\n');
  assert.equal(habits.length, 60);
  assert.equal(habits.reduce((n, h) => n + h.entries.length, 0), 109_500);
});

test('a hostile .db is refused rather than allowed to exhaust the heap', async () => {
  // 80,000 habit rows in 2.7MB and 400,000 entry rows in 7.2MB — both well
  // under the 16MB body limit, so neither is bounded by anything upstream.
  // Before the ceilings, each of these aborted a 64MB child with SIGABRT.
  for (const [kind, rows, expected] of [
    ['habits', 80_000, /more than 10000 habits/],
    ['entries', 400_000, /more than 250000 entries/],
  ]) {
    const path = join(tmpdir(), `loop-oversized-${kind}-${process.pid}.db`);
    try { unlinkSync(path); } catch {}
    await makeOversizedDb(path, kind, rows);

    const result = await parseInCappedChild(path);
    assert.match(result, /^THREW 400 /, `${kind}: expected a clean 400, got: ${result}`);
    assert.match(result, expected, `${kind}: the error should name the ceiling`);

    unlinkSync(path);
  }
});

test('a Habits view is not a Habits table', async () => {
  // The row count of a SQLite file is DECLARED, not stored, so a view over a
  // recursive CTE makes 8KB of upload claim five million rows. Loop only ever
  // writes tables. This is defence in depth — the ceilings above are the fix,
  // and they hold for a plain table, which this check cannot help with.
  const path = join(tmpdir(), `loop-view-${process.pid}.db`);
  try { unlinkSync(path); } catch {}
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE VIEW Habits AS
      WITH RECURSIVE c(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM c WHERE id < 5000000)
      SELECT id, 'h'||id AS name, '' AS description, '' AS question, 1 AS freq_num,
             1 AS freq_den, 11 AS color, id AS position, 0 AS archived, 0 AS type,
             0 AS target_value, 0 AS target_type, '' AS unit, NULL AS reminder_hour,
             NULL AS reminder_min, 127 AS reminder_days
      FROM c;
    CREATE TABLE Repetitions (habit INTEGER, timestamp INTEGER, value INTEGER, notes TEXT);
  `);
  d.close();

  // In the capped child for the same reason the ceiling test is: if the view
  // check ever stops working, this file's 5,000,000-row declaration goes to
  // `.all()` and aborts the RUNNER, which reports as a crashed test file at
  // 1:1 and silently abandons every test after it. A named failure is what a
  // regression here should look like.
  assert.match(await parseInCappedChild(path), /THREW 400 .*Habits is a view, not a table/);
  unlinkSync(path);
});

test('a Repetitions view is refused too', async () => {
  // Bounding only Habits leaves the same trick available one table over.
  const path = join(tmpdir(), `loop-repview-${process.pid}.db`);
  try { unlinkSync(path); } catch {}
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE Habits (id INTEGER PRIMARY KEY, name TEXT, description TEXT, question TEXT,
      freq_num INTEGER, freq_den INTEGER, color INTEGER, position INTEGER, archived INTEGER,
      type INTEGER, target_value REAL, target_type INTEGER, unit TEXT,
      reminder_hour INTEGER, reminder_min INTEGER, reminder_days INTEGER);
    INSERT INTO Habits VALUES (1,'one','','',1,1,11,0,0,0,0,0,'',NULL,NULL,127);
    CREATE VIEW Repetitions AS
      WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 5000000)
      SELECT 1 AS habit, (n * 86400000) AS timestamp, 2 AS value, '' AS notes FROM c;
  `);
  d.close();

  assert.match(await parseInCappedChild(path), /THREW 400 .*Repetitions is a view, not a table/);
  unlinkSync(path);
});

test('a backup that sits just under both ceilings still imports', async () => {
  // The ceilings are a bound on a hostile file, not a product limit, and a
  // parser that rejects a legitimate backup is its own kind of data loss.
  const path = join(tmpdir(), `loop-under-${process.pid}.db`);
  try { unlinkSync(path); } catch {}
  await makeOversizedDb(path, 'habits', 500);

  const habits = await parseLoopDatabase(path);
  assert.equal(habits.length, 500);
  assert.equal(habits[0].name, 'h1');

  unlinkSync(path);
});

test('a blank header column does not shift later habits\' data', () => {
  // `names` was filtered before use while the row was still read at `i + 1`,
  // so every habit after a blank column silently received its neighbour's
  // cell. Wrong data rather than a dropped row, which is the worse failure.
  const csv = 'Date,A,,B\n2024-01-01,YES_MANUAL,SKIP,NO\n';
  const habits = parseLoopCheckmarksCSV(csv);

  const a = habits.find((h) => h.name === 'A');
  const b = habits.find((h) => h.name === 'B');

  assert.equal(a.entries.length, 1, 'A keeps its own YES');
  assert.equal(a.entries[0].value, 2);

  // B's own cell is NO — a row holding 0, and emphatically not the blank
  // column's SKIP. The status is what this is really checking: a misaligned read
  // would hand B a skip.
  assert.deepEqual(b.entries.map((e) => [e.value, e.status]), [[0, '']],
    `B took the blank column's value: ${JSON.stringify(b.entries)}`);
});

test('several blank columns keep every habit aligned', () => {
  const csv = 'Date,,A,,,B,C\n2024-01-01,x,YES_MANUAL,y,z,SKIP,3\n';
  const habits = parseLoopCheckmarksCSV(csv);

  assert.deepEqual(habits.map((h) => h.name), ['A', 'B', 'C']);
  assert.equal(habits[0].entries[0].value, 2, 'A = YES');
  assert.equal(habits[1].entries[0].status, 'skip', 'B = SKIP');
  // C is boolean by default and 3 is Loop's SKIP sentinel there.
  assert.equal(habits[2].entries[0].status, 'skip', 'C = 3 -> skip on a boolean');
});

/* ---------- sniffing what arrived in the request body ---------- */

const { parseUpload } = await import('../src/import.js');
const { buildCsvArchive } = await import('../src/export-csv.js');
const { zip } = await import('../src/zip.js');

test('a habiterall JSON backup is recognised from its bytes', async () => {
  const backup = JSON.stringify({
    version: 1, app: 'habiterall',
    habits: [{ name: 'Meditate', type: 'boolean', entries: [] }],
  });
  const habits = await parseUpload(Buffer.from(backup, 'utf8'));
  assert.equal(habits.length, 1);
  assert.equal(habits[0].name, 'Meditate');
});

test('a bare array is accepted too, and a BOM does not defeat it', async () => {
  // A BOM survives a round trip through several Windows editors, and would
  // otherwise make JSON.parse fail on a file that is perfectly valid.
  const bare = JSON.stringify([{ name: 'Gym', type: 'boolean', entries: [] }]);
  assert.equal((await parseUpload(Buffer.from(bare, 'utf8')))[0].name, 'Gym');
  assert.equal((await parseUpload(Buffer.from('﻿' + bare, 'utf8')))[0].name, 'Gym');
});

test('a Loop CSV zip is recognised, and needs its Habits.csv', async () => {
  // buildCsvArchive produces exactly what Loop's export looks like, so the
  // sniffing is exercised against the real shape rather than a hand-made zip.
  const habits = [{
    id: 1, name: 'Water', type: 'numerical', unit: 'glasses', target_value: 8,
    target_type: 'at_least', freq_numerator: 1, freq_denominator: 1,
    color: '#22c55e', description: '', archived: 0,
  }];
  const zip = buildCsvArchive(habits, () => [
    { date: '2026-01-05', value: 3, status: '', notes: '' },
  ]);

  const parsed = await parseUpload(zip);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'numerical',
    'without Habits.csv the type is unknown and a 3 reads as Loop\'s SKIP');
  assert.equal(parsed[0].entries[0].value, 3);
});

test('a CSV archive of an account with no entries restores its habits', async () => {
  // A new account that backs itself up before recording anything. Habits.csv
  // described both habits in full and Checkmarks.csv was the lone header
  // `Date,Alpha,Beta` — which restored as nothing at all, with the API's
  // "no habits found in the uploaded file" 400 on top. The .db format has
  // always handled the same account correctly.
  const habits = [
    {
      id: 1, name: 'Alpha', type: 'boolean', unit: '', target_value: 0,
      target_type: 'at_least', freq_numerator: 1, freq_denominator: 1,
      color: '#22c55e', description: 'Nothing recorded yet', archived: 0,
    },
    {
      id: 2, name: 'Beta', type: 'numerical', unit: 'km', target_value: 5,
      target_type: 'at_least', freq_numerator: 3, freq_denominator: 7,
      color: '#f59e0b', description: '', archived: 0,
    },
  ];

  const parsed = await parseUpload(buildCsvArchive(habits, () => []));
  assert.deepEqual(parsed.map((h) => h.name), ['Alpha', 'Beta']);
  assert.equal(parsed[0].description, 'Nothing recorded yet');
  assert.equal(parsed[1].type, 'numerical',
    'the metadata is read for a habit that has no column data to interpret');
  assert.equal(parsed[1].unit, 'km');
  assert.equal(parsed[1].freq_denominator, 7);

  // The mixed case: one habit with entries and one without, in one archive.
  const mixed = await parseUpload(buildCsvArchive(habits, (id) =>
    (id === 1 ? [{ date: '2026-01-05', value: 2, status: '', notes: '' }] : [])));
  assert.deepEqual(mixed.map((h) => [h.name, h.entries.length]),
    [['Alpha', 1], ['Beta', 0]]);
});

test('a habit only Habits.csv knows about is still restored', async () => {
  // Habits.csv names every habit the archive describes, so it is a source of
  // habits and not only a lookup table. A column lost from Checkmarks.csv
  // otherwise takes the whole habit with it, metadata and all.
  const archive = zip([
    {
      name: 'Habits.csv',
      data: [
        'Position,Name,Type,Question,Description,FrequencyNumerator,FrequencyDenominator,Color,Unit,Target Type,Target Value,Archived?',
        '001,Water,NUMERICAL,,Stay hydrated,1,1,10,glasses,AT_LEAST,8.0,false',
        '002,Ghost,YES_NO,,Never checked off,1,1,11,,,,false',
      ].join('\n') + '\n',
    },
    { name: 'Checkmarks.csv', data: 'Date,Water\n2026-01-05,6\n' },
  ]);

  const parsed = await parseUpload(archive);
  assert.deepEqual(parsed.map((h) => h.name), ['Water', 'Ghost'],
    'checkmarks order first, then Habits.csv order for the rest');
  assert.equal(parsed[0].entries.length, 1);
  assert.deepEqual(parsed[1].entries, []);
  assert.equal(parsed[1].description, 'Never checked off');
});

test('an archive describing no habits at all is still empty', async () => {
  // The guard the API turns into a 400 has to keep working: reading the header
  // must not make every unusable upload look like a successful empty import.
  assert.deepEqual(
    await parseUpload(zip([{ name: 'Checkmarks.csv', data: 'Date\n' }])), [],
    'a Date column and nothing else names no habits');

  // A zero-byte member reads as an ABSENT one, because `find` returns its
  // contents and '' is falsy. Pinned as it stands: the answer is a 400 either
  // way, and which of the two sentences it is belongs with the "oversized
  // member reported as a missing one" note in #80 rather than here.
  await assert.rejects(
    () => parseUpload(zip([{ name: 'Checkmarks.csv', data: '' }])),
    /Checkmarks\.csv/);
});

test('an unrecognised upload is a 400, not a 500', async () => {
  for (const body of ['not a backup at all', '<html></html>', '']) {
    await assert.rejects(
      () => parseUpload(Buffer.from(body, 'utf8')),
      (err) => {
        assert.equal(err.status, 400, 'the error must carry a client status');
        return true;
      },
      `accepted ${JSON.stringify(body)}`
    );
  }
});

test('malformed JSON is a 400 whichever bracket it opens with', async () => {
  // The `[` form is wrapped before parseHabiterallJSON sees it, and the parse
  // that wrapped it sat in the ARGUMENT — outside that function's own try — so
  // `[{"name":"a"},` was a 500 and a stack trace at error level while `{` on the
  // same truncation was a 400 telling the user about their file. `err.status` is
  // the honest unit: both editions' error middleware reads exactly this field
  // (`err.status ?? 500`), so it is what decides the response the route sends.
  for (const body of ['[{"name":"a"},', '[nope', '[', '[1,2', '{', '{"habits":']) {
    await assert.rejects(
      () => parseUpload(Buffer.from(body, 'utf8')),
      (err) => {
        assert.equal(err.status, 400, `${JSON.stringify(body)} must carry a client status`);
        assert.match(err.message, /JSON/, 'and say what is wrong with the file');
        return true;
      },
      `accepted ${JSON.stringify(body)}`
    );
  }
});

test('a zip without a Checkmarks.csv says so', async () => {
  // zip() takes {name, data}, not a pair — the CSV export is its only other
  // caller, so this is easy to get wrong from memory.
  const bogus = zip([{ name: 'Habits.csv', data: 'Name\nMeditate\n' }]);
  await assert.rejects(() => parseUpload(bogus), /Checkmarks\.csv/);
});

/* ---------- categories in a habiterall JSON backup ---------- */

test('backupCategories reads categories from a real habiterall JSON backup', () => {
  const buf = Buffer.from(JSON.stringify({
    version: 1, app: 'habiterall',
    categories: [
      { name: 'Health', color: '#22c55e', position: 0 },
      { name: 'Work', color: '#3b82f6', position: 1 },
    ],
    habits: [],
  }));
  assert.deepEqual(backupCategories(buf), [
    { name: 'Health', color: '#22c55e', position: 0 },
    { name: 'Work', color: '#3b82f6', position: 1 },
  ]);
});

test('neither Loop format has anywhere to put a category, so backupCategories reads null', () => {
  // Sniffed the same way `parseUpload` sniffs a real upload — backupCategories
  // never gets far enough to open either file, because neither starts with a
  // '{': there is no `categories` key to have found even in principle.
  const loopDb = Buffer.from('SQLite format 3\0' + 'x'.repeat(20));
  assert.equal(backupCategories(loopDb), null);

  const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  assert.equal(backupCategories(zipMagic), null);
});

test('junk reads as no categories rather than throwing', () => {
  assert.equal(backupCategories(Buffer.alloc(0)), null);
  assert.equal(backupCategories(Buffer.from('not json at all')), null);
  assert.equal(backupCategories(Buffer.from('{not valid json')), null);
  // A `categories` key that is not an array at all — a file this repair
  // path has no honest reading of, so it is treated as absent.
  assert.equal(backupCategories(Buffer.from(JSON.stringify({ categories: 'nonsense' }))), null);
  assert.deepEqual(backupCategories(Buffer.from(JSON.stringify({ categories: [] }))), []);
});

test('a malformed category entry is repaired or dropped, never thrown on', () => {
  // The input is a file. `parseCategory` (validate.js) THROWS on an empty
  // name because a person typing one can be told; this is the repair half,
  // for a file that cannot be argued with, and a nameless entry is dropped
  // rather than invented — the same asymmetry `normaliseImportedHabit` has
  // against `parseHabit`.
  const buf = Buffer.from(JSON.stringify({
    categories: [
      { name: 'Health', color: 'not-a-colour' },
      { name: '   ' },
      'nonsense',
      42,
      { name: 'n'.repeat(500) },
    ],
  }));
  const cats = backupCategories(buf);
  assert.equal(cats.length, 2, JSON.stringify(cats));
  assert.equal(cats[0].name, 'Health');
  assert.match(cats[0].color, /^#[0-9a-f]{6}$/i, 'an invalid colour repairs to the default');
  assert.equal(cats[1].name.length, LIMITS.name, 'an over-long name is capped, not rejected');
});

test('backupCategories is capped at LIMITS.categories, the same ceiling POST /categories enforces', () => {
  const many = Array.from({ length: LIMITS.categories + 10 },
    (_, i) => ({ name: `Cat ${i}`, color: '#111111', position: i }));
  const buf = Buffer.from(JSON.stringify({ categories: many }));
  assert.equal(backupCategories(buf).length, LIMITS.categories);
});

/* ---------- categories in a zip's Categories.csv ---------- */

test('backupCategories reads Categories.csv out of a zip', () => {
  // Non-default colours and non-sequential positions — a fixture matching
  // what a category defaults to would pass even against code that read
  // nothing at all.
  const categories = [
    { name: 'Health', color: '#10b981', position: 5 },
    { name: 'Work', color: '#f43f5e', position: 1 },
  ];
  const habits = [{ id: 1, name: 'Meditate', category: '' }];
  const buf = buildCsvArchive(habits, () => [], categories);
  assert.deepEqual(backupCategories(buf), categories);
});

test('a zip without a Categories.csv reads null, exactly as today', () => {
  const habits = [{ id: 1, name: 'Meditate', category: '' }];
  const buf = buildCsvArchive(habits, () => [], []);
  assert.equal(backupCategories(buf), null);
});

test('a Categories.csv row is repaired the same way a JSON one is', () => {
  // A nameless row, a junk colour and a non-integer position, in one file —
  // the mutation for this test is making the zip branch skip the repair tail
  // and return the raw rows, which fails every assertion below.
  const csv = 'Name,Color,Position\n,#ffffff,0\nHealth,not-a-colour,oops\n';
  const buf = zip([
    { name: 'Habits.csv', data: 'Name\nMeditate\n' },
    { name: 'Checkmarks.csv', data: 'Date,Meditate\n' },
    { name: 'Categories.csv', data: csv },
  ]);
  const cats = backupCategories(buf);
  assert.equal(cats.length, 1, JSON.stringify(cats));               // the nameless row is dropped
  assert.equal(cats[0].name, 'Health');
  assert.match(cats[0].color, /^#[0-9a-f]{6}$/i, 'an invalid colour repairs to the default');
  assert.equal(cats[0].position, 0, 'a non-integer position is replaced by its index');
});

test('a Categories.csv with data survives with no categorySkip note', () => {
  // The ordinary case, so the two failure tests below are proving something:
  // a file that DOES carry usable rows must not also be reported as having
  // lost anything.
  const buf = buildCsvArchive(
    [{ id: 1, name: 'Meditate', category: '' }], () => [],
    [{ name: 'Health', color: '#10b981', position: 0 }]
  );
  assert.equal(backupCategories(buf).categorySkip, undefined);
});

test('a header-only Categories.csv is reported, not silently empty', () => {
  // Nothing in the repo's own writer produces this — `buildCsvArchive` omits
  // the member entirely for zero categories — so this is the shape a hand
  // edit or a truncated upload takes. The habit still restores, and until now
  // nothing said the account's colours and positions never arrived.
  const buf = zip([
    { name: 'Habits.csv', data: 'Name\nMeditate\n' },
    { name: 'Checkmarks.csv', data: 'Date,Meditate\n' },
    { name: 'Categories.csv', data: 'Name,Color,Position\n' },
  ]);
  const cats = backupCategories(buf);
  assert.equal(cats.length, 0);
  assert.match(cats.categorySkip, /no usable categories/);
});

test('a header with no Name column is reported the same way', () => {
  // `parseCategoriesCsvRows` returns `[]` outright when `name` is missing from
  // the header — a different code path to the header-only file above, and the
  // same user-visible outcome, so it gets the same report.
  const buf = zip([
    { name: 'Habits.csv', data: 'Name\nMeditate\n' },
    { name: 'Checkmarks.csv', data: 'Date,Meditate\n' },
    { name: 'Categories.csv', data: 'Color,Position\n#111111,0\n' },
  ]);
  const cats = backupCategories(buf);
  assert.equal(cats.length, 0);
  assert.match(cats.categorySkip, /no usable categories/);
});

test('a Categories.csv over LIMITS.categories reports how many were dropped', () => {
  const rows = Array.from(
    { length: LIMITS.categories + 3 }, (_, i) => `Cat ${i},#111111,${i}`
  ).join('\n');
  const buf = zip([
    { name: 'Habits.csv', data: 'Name\nMeditate\n' },
    { name: 'Checkmarks.csv', data: 'Date,Meditate\n' },
    { name: 'Categories.csv', data: `Name,Color,Position\n${rows}\n` },
  ]);
  const cats = backupCategories(buf);
  assert.equal(cats.length, LIMITS.categories);
  assert.match(cats.categorySkip, /3 of \d+ categories in Categories\.csv were dropped/);
  assert.match(cats.categorySkip, new RegExp(`at most ${LIMITS.categories} are allowed`));
});

test('a blank Position cell falls back to row index, not to 0 for every row', () => {
  // `Number('')` is `0`, and `Number.isInteger(0)` is true — so a blank cell
  // used to look like a stated position of 0 rather than an absent one, and
  // every row in a hand-edited file landed at 0 instead of its own index.
  // Junk text (covered above) hits the same fallback through a different
  // door: `Number('oops')` is `NaN`, which is not an integer either.
  const csv = 'Name,Color,Position\nAlpha,#111111,\nBeta,#222222,\nGamma,#333333,\n';
  const buf = zip([
    { name: 'Habits.csv', data: 'Name\nMeditate\n' },
    { name: 'Checkmarks.csv', data: 'Date,Meditate\n' },
    { name: 'Categories.csv', data: csv },
  ]);
  const cats = backupCategories(buf);
  assert.deepEqual(cats.map((c) => c.position), [0, 1, 2],
    JSON.stringify(cats));
});

test('a zip with only PK\'s magic bytes reads null rather than throwing', () => {
  // Not a complete zip at all — no end-of-central-directory record — so
  // `unzip` itself throws. `backupCategories` only ever answers a doubt with
  // `null`; the real upload is still rejected, by `parseUpload`.
  const truncated = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  assert.equal(backupCategories(truncated), null);
});

/* ---------- repairing an imported habit ---------- */

const { normaliseImportedHabit } = await import('../src/import.js');

test('an imported habit is clamped to the limits the API enforces', () => {
  // The personal edition's writer applied NO length clamps, so it accepted
  // through an import what its own API would have refused. Both now derive the
  // limits from the same place, so they cannot drift apart again.
  const clean = normaliseImportedHabit({
    name: 'n'.repeat(500),
    description: 'd'.repeat(5000),
    unit: 'u'.repeat(200),
    reminder_message: 'q'.repeat(1000),
  });
  assert.equal(clean.name.length, LIMITS.name);
  assert.equal(clean.description.length, LIMITS.description);
  assert.equal(clean.unit.length, LIMITS.unit);
  assert.equal(clean.reminder_message.length, LIMITS.reminderMessage);
});

test('no Loop format has anywhere to put an icon, so one always parses to \'\'', () => {
  // Neither parseLoopDatabase's row shape nor the CSV parsers ever produce an
  // `icon` key, so this is what every Loop-sourced habit hands
  // normaliseImportedHabit — the same absence a real .db or CSV parse would.
  assert.equal(normaliseImportedHabit({ name: 'Meditate' }).icon, '');
});

test('a habiterall JSON backup\'s icon survives normalisation', () => {
  assert.equal(normaliseImportedHabit({ name: 'Meditate', icon: '🧘' }).icon, '🧘');
});

test('the .db format has no concept of a category, so one always parses to \'\'', () => {
  // parseLoopDatabase's row shape never produces a `category` key — the same
  // absence a real .db parse would hand this function.
  assert.equal(normaliseImportedHabit({ name: 'Meditate' }).category, '');
});

test('a category name from a habiterall JSON backup or the CSV pair survives, and is capped', () => {
  assert.equal(normaliseImportedHabit({ name: 'Meditate', category: 'Health' }).category, 'Health');
  assert.equal(
    normaliseImportedHabit({ name: 'Meditate', category: 'c'.repeat(500) }).category.length,
    LIMITS.name
  );
});

test('a frequency Loop permits but we do not is squared up, not dropped', () => {
  // Loop allows a numerator above the denominator; our validation does not.
  assert.deepEqual(
    (({ freq_numerator: n, freq_denominator: d }) => ({ n, d }))(
      normaliseImportedHabit({ freq_numerator: 9, freq_denominator: 2 })
    ),
    { n: 9, d: 9 }
  );
  // And the denominator is capped, which one writer did and the other did not.
  assert.equal(
    normaliseImportedHabit({ freq_numerator: 1, freq_denominator: 100000 }).freq_denominator,
    LIMITS.freqDenominator
  );
});

test('a repaired frequency is one the API would have accepted', () => {
  // parseHabit is the oracle on purpose: this function exists so an import
  // cannot store what a typed-in habit could not, and the clamps used to undo
  // each other — squaring up raised the denominator, the cap lowered it again,
  // and the numerator was never bounded at all. Cloud's
  // `CHECK (freq_numerator <= freq_denominator)` then answered the file with a
  // 23514, so the same backup was a 500 and a lost import there and silent
  // nonsense in personal.
  const shapes = [
    [1000, 1], [400, 400], [2.5, 7], [1e30, 1], [9, 2], [1, 100000], [500, 1000],
    [Infinity, 1], [1, Infinity], [NaN, NaN], ['x', 'y'], [-3, -9], [0, 0], [0.4, 0.4],
    [1e308, 1e308], [undefined, undefined],
  ];
  for (const [n, d] of shapes) {
    const clean = normaliseImportedHabit({ name: 'F', freq_numerator: n, freq_denominator: d });
    assert.doesNotThrow(
      () => parseHabit(clean),
      `${n} / ${d} normalised to ${clean.freq_numerator} / ${clean.freq_denominator}, ` +
      'which the API refuses'
    );
  }
});

test('a frequency too wide to state is still a rate, not a daily habit', () => {
  // Acceptance by parseHabit is too weak an oracle on its own: `1 / 1` is
  // accepted, so an unbounded period silently collapsing to "every day" passed
  // the test above while being the largest invention this function can make.
  // These assert the VALUE, which is the only thing that catches it.
  const freq = (n, d) => {
    const c = normaliseImportedHabit({ name: 'F', freq_numerator: n, freq_denominator: d });
    return `${c.freq_numerator}/${c.freq_denominator}`;
  };

  // `1e400` is a legal JSON literal and parses to Infinity. The file said
  // "effectively never"; reading that as the default said "every day".
  assert.equal(freq(2, Infinity), '2/365', 'an unbounded period is the widest, not the narrowest');
  assert.equal(freq(1, Infinity), '1/365');

  // Scaling the rate rather than the count: `(num * cap) / den` overflows to
  // Infinity above ~4.9e305 and handed back the cap, so the two identical rates
  // below disagreed — 365/365 and 36/365 for the same one-in-ten-days habit.
  assert.equal(freq(1e306, 1e307), '36/365');
  assert.equal(freq(1e305, 1e306), '36/365', 'the same rate must give the same answer');

  // And the ordinary clamp is unmoved.
  assert.equal(freq(500, 1000), '182/365');
  assert.equal(freq(1000, 1), '365/365', 'a rate above daily really is daily');
  assert.equal(freq(9, 2), '9/9', 'the Loop shape still squares up');
});

test('a frequency too big to store is capped as a RATE, not as two numbers', () => {
  const freq = (n, d) => {
    const c = normaliseImportedHabit({ freq_numerator: n, freq_denominator: d });
    return `${c.freq_numerator}/${c.freq_denominator}`;
  };
  // A rate above once a day cannot be stored at all, and is already squared up
  // to daily; capping the period then has nothing left to take away.
  assert.equal(freq(1000, 1), '365/365');
  assert.equal(freq(400, 400), '365/365');
  // But a habit kept every other day for 1000 days is a LAX one, and clamping
  // the period while leaving the count behind turns it into a daily habit it
  // never was — an invention, not a repair.
  assert.equal(freq(500, 1000), '182/365');
  // The columns are INTEGER: the count rounds down and the period up, so the
  // repair asks no more than the file did.
  assert.equal(freq(2.5, 7), '2/7');
  // Infinity is a legal JSON number (`1e400` parses to it) and it means the
  // file DID say something, unlike NaN which means it did not. Read as the
  // default it used to give `1/1` — the same rate as the `365/365` two lines
  // up, stored differently, which is one rate with two representations. As the
  // widest bound it squares up like any other above-daily rate.
  assert.equal(freq(Infinity, 1), '365/365');
  // And the case that actually mattered: an unbounded PERIOD. `1/1` there is
  // not a second spelling of anything — it is a habit due every day, invented
  // out of one the file said was effectively never due.
  assert.equal(freq(2, Infinity), '2/365');
});

test('a prompt from a file is flattened like one that was typed', () => {
  // It ends up in the Android client's line-delimited reminder cache either way,
  // where a newline corrupts the record it sits in.
  assert.equal(
    normaliseImportedHabit({ reminder_message: 'Did you\r\nexercise\ntoday?' }).reminder_message,
    'Did you exercise today?'
  );
});

test('junk is repaired rather than rejected', () => {
  // The input is a file, often written by another application. Refusing a whole
  // import over one bad field would be the wrong trade — that is what
  // parseHabit is for, where a person is typing and can be told.
  const clean = normaliseImportedHabit({
    type: 'nonsense', target_type: 'nonsense', target_value: -5,
    color: 'not-a-colour', reminder_time: '25:99', archived: 'yes',
  });
  assert.equal(clean.type, 'boolean');
  assert.equal(clean.target_type, 'at_least');
  assert.equal(clean.target_value, 0);
  assert.match(clean.color, /^#[0-9a-f]{6}$/i);
  assert.equal(clean.reminder_time, '');
  assert.equal(clean.archived, true, 'a truthy value is archived; the writers map the type');
});
