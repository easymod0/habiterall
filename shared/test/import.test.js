import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';


const {
  loopTimestampToISO, convertLoopValue, normalizeColor,
  parseCSV, parseLoopCheckmarksCSV, parseLoopHabitsCSV, parseLoopDatabase,
} = await import('../src/import.js');

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

test('a zip without a Checkmarks.csv says so', async () => {
  const { zip } = await import('../src/zip.js');
  // zip() takes {name, data}, not a pair — the CSV export is its only other
  // caller, so this is easy to get wrong from memory.
  const bogus = zip([{ name: 'Habits.csv', data: 'Name\nMeditate\n' }]);
  await assert.rejects(() => parseUpload(bogus), /Checkmarks\.csv/);
});

/* ---------- repairing an imported habit ---------- */

const { normaliseImportedHabit } = await import('../src/import.js');
const { LIMITS } = await import('../src/validate.js');

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
