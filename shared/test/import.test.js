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

test('invalid timestamps are rejected', () => {
  assert.equal(loopTimestampToISO('nonsense'), null);
  assert.equal(loopTimestampToISO(undefined), null);
});

/* ---------- Loop value conversion ---------- */

test('boolean sentinels map to habiterall encoding', () => {
  assert.deepEqual(convertLoopValue(2, false), { value: YES, status: '' }, 'YES_MANUAL');
  assert.deepEqual(convertLoopValue(1, false), { value: YES, status: '' }, 'YES_AUTO counts as done');
  assert.deepEqual(convertLoopValue(3, false), { value: 0, status: 'skip' }, 'SKIP');
  assert.equal(convertLoopValue(0, false), null, 'NO is stored as absence');
  assert.equal(convertLoopValue(-1, false), null, 'UNKNOWN is dropped');
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
    [['2026-01-01', YES, ''], ['2026-01-02', 0, 'skip']],
    'NO rows are omitted entirely; skip is flagged out-of-band'
  );

  const read = habits[1];
  assert.deepEqual(read.entries.map((e) => e.value), [YES, YES], 'YES_AUTO counts');
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

  d.prepare(`INSERT INTO Habits (id,name,description,question,freq_num,freq_den,color,
    position,archived,type,target_value,target_type,unit)
    VALUES (1,'Meditate','Daily sit','',1,1,11,0,0,0,0,0,'')`).run();
  d.prepare(`INSERT INTO Habits (id,name,description,question,freq_num,freq_den,color,
    position,archived,type,target_value,target_type,unit)
    VALUES (2,'Water','','',1,1,9,1,0,1,8,0,'glasses')`).run();
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
    [['2026-01-01', YES, ''], ['2026-01-02', 0, 'skip'], ['2026-01-04', YES, '']],
    'NO is dropped; YES_AUTO becomes YES; skip is out-of-band'
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

  // B's own cell is NO, which is stored as absence — it must NOT inherit the
  // blank column's SKIP.
  assert.deepEqual(b.entries, [],
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
