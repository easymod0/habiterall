import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';


const {
  writeLoopDatabase, colorToLoopIndex, isoToLoopTimestamp, toLoopEntry,
} = await import('../src/export-loop.js');
const { parseLoopDatabase, loopTimestampToISO } = await import('../src/import.js');

const YES = 2;

const scratch = (name) => {
  const p = join(tmpdir(), `${name}-${process.pid}-${Math.round(performance.now())}.db`);
  try { unlinkSync(p); } catch {}
  return p;
};

/* ---------- primitives ---------- */

test('timestamps round-trip through Loop encoding', () => {
  for (const iso of ['2026-01-01', '2026-06-15', '1998-03-10', '2027-12-31']) {
    assert.equal(loopTimestampToISO(isoToLoopTimestamp(iso)), iso, iso);
  }
});

test('timestamps are UTC midnight', () => {
  const ts = isoToLoopTimestamp('2026-06-15');
  assert.equal(ts % 86_400_000, 0, 'must be aligned to a day boundary');
  assert.equal(new Date(ts).toISOString(), '2026-06-15T00:00:00.000Z');
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
  },
  {
    id: 2, name: 'Water', description: '', type: 'numerical',
    unit: 'glasses', target_value: 8, target_type: 'at_least',
    freq_numerator: 1, freq_denominator: 1, color: '#0ea5e9', archived: 0,
  },
  {
    id: 3, name: 'Cigarettes', description: 'quitting', type: 'numerical',
    unit: 'cigs', target_value: 0, target_type: 'at_most',
    freq_numerator: 1, freq_denominator: 1, color: '#ef4444', archived: 0,
  },
  {
    id: 4, name: 'Gym', description: '', type: 'boolean',
    unit: '', target_value: 0, target_type: 'at_least',
    freq_numerator: 3, freq_denominator: 7, color: '#f59e0b', archived: 1,
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
  assert.deepEqual(result, { habits: 0, entries: 0 });

  const reimported = await parseLoopDatabase(path);
  assert.deepEqual(reimported, []);
  unlinkSync(path);
});
