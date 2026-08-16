/**
 * A shared fixture and comparison rules for backup round-trip tests.
 *
 * Used by both editions' round-trip suites so that "what a faithful restore
 * means" is defined once. The three export formats do not have the same
 * fidelity ceiling, and pretending they do produces either false failures or
 * a test that asserts nothing:
 *
 *   JSON  — habiterall's own backup. Lossless. Everything must survive.
 *   Loop .db — Loop's schema. Carries every habit field but the colour, which
 *           it stores as a palette index and therefore snaps.
 *   CSV   — Loop's Habits.csv + Checkmarks.csv. Loses a reminder time and the
 *           per-day notes, and is the ONLY Loop format that keeps the colour
 *           exactly, because Habits.csv writes the hex.
 *
 * So the two Loop formats are not nested: each carries something the other
 * does not, which is why there are three lists below and not two.
 *
 * That reads nothing like what stood here, which claimed the .db had "nowhere
 * to put per-day notes, our description text, or archived state" and excluded
 * all three. Every word of it was false of the code beneath: `writeLoopDatabase`
 * writes `Habits.description`, `Habits.archived` and `Repetitions.notes`, and
 * `parseLoopDatabase` selects all three back. It was true once, and a comment
 * that has outlived its code is worse here than in most places — this file is
 * where the two editions agree what a faithful restore MEANS, so a field named
 * as impossible is a field neither suite will ever notice going missing.
 * Habits.csv turned out to carry the first two as well (a `Description` and an
 * `Archived` column, both read by `parseLoopHabitsCSV`), so they are in the
 * list BOTH formats are held to rather than the .db's own.
 *
 * The fixture deliberately includes the cases that have actually broken:
 * a 3 on a numerical habit (must not become a skip), an at_most target
 * (0 is a success), a non-integer amount, a skip, a note on an otherwise
 * empty day, an archived habit — and a stated lapse with no note on it, which
 * is the one that has to survive as a ROW. Every format has somewhere to put it
 * (Loop's own NO, a `NO` cell in the CSV), and a format that dropped it would
 * turn "I missed this day" into "nobody has answered this day" on the way
 * through, which is precisely the difference `questionMarks` shows.
 */

export const FIXTURE = [
  {
    name: 'Meditate',
    description: 'Ten minutes, morning',
    type: 'boolean',
    unit: '',
    target_value: 0,
    target_type: 'at_least',
    freq_numerator: 1,
    freq_denominator: 1,
    color: '#3b82f6',
    reminder_time: '07:30',
    reminder_message: 'Did you sit for ten minutes?',
    archived: false,
    entries: [
      { date: '2026-01-05', value: 2, status: '', notes: '' },
      { date: '2026-01-06', value: 2, status: '', notes: 'felt good' },
      // A skip: must stay a skip and never collapse into a value of 3.
      { date: '2026-01-07', value: 0, status: 'skip', notes: '' },
      // A note on a not-done day: the row exists only to carry the note.
      { date: '2026-01-08', value: 0, status: '', notes: 'overslept' },
      { date: '2026-01-09', value: 2, status: '', notes: '' },
      // A stated lapse with nothing else on it. Bare, so nothing but the row
      // itself can carry the fact that the day was answered at all.
      { date: '2026-01-10', value: 0, status: '', notes: '' },
    ],
  },
  {
    name: 'Water',
    description: 'Glasses per day',
    type: 'numerical',
    unit: 'glasses',
    target_value: 8,
    target_type: 'at_least',
    freq_numerator: 1,
    freq_denominator: 1,
    color: '#22c55e',
    reminder_time: '09:00',
    reminder_message: 'How many glasses of water so far?',
    archived: false,
    entries: [
      { date: '2026-01-05', value: 8, status: '', notes: '' },
      // A literal 3 on a numerical habit. This is the regression that matters
      // most: 3 is Loop's SKIP sentinel, and treating it as one here silently
      // rewrites real data.
      { date: '2026-01-06', value: 3, status: '', notes: 'busy day' },
      { date: '2026-01-07', value: 10, status: '', notes: '' },
      { date: '2026-01-08', value: 0, status: 'skip', notes: '' },
    ],
  },
  {
    name: 'Snacks',
    description: 'Fewer is better',
    type: 'numerical',
    unit: '',
    // at_most with a target of 2: zero is a success, which is the inverse of
    // the usual rule and has been got wrong before.
    target_value: 2,
    target_type: 'at_most',
    freq_numerator: 1,
    freq_denominator: 1,
    color: '#ef4444',
    // Midnight, which is the hour every hand-rolled HH:MM converter gets wrong
    // — and on the Loop side it is the reminder whose two columns are both 0,
    // so a falsiness check anywhere reports it as "no reminder".
    reminder_time: '00:00',
    // NOT 'default', deliberately. This is the only habit in the fixture that
    // can carry it, so leaving it at the default would compare 'default'
    // against 'default' everywhere and pass with the field dropped — which is
    // exactly how `reminder_message` went unwatched in the cloud suite for as
    // long as it did.
    at_most_unlogged: 'success',
    // Shown as something to avoid — a rendering choice, and the reason it can
    // be one: no Loop format carries it, and losing it on a round trip costs
    // the display and not the meaning. NOT 'amount', or the comparison would
    // be two defaults agreeing again.
    show_as: 'avoid',
    archived: false,
    entries: [
      { date: '2026-01-05', value: 0, status: '', notes: '' },
      { date: '2026-01-06', value: 1, status: '', notes: '' },
      { date: '2026-01-07', value: 4, status: '', notes: 'party' },
    ],
  },
  {
    name: 'Gym',
    description: 'Three times a week',
    type: 'boolean',
    unit: '',
    target_value: 0,
    target_type: 'at_least',
    // A non-daily frequency: 3 per 7 must survive, not be flattened to 1/1.
    freq_numerator: 3,
    freq_denominator: 7,
    color: '#f59e0b',
    reminder_time: '18:00',
    reminder_message: '',
    archived: false,
    entries: [
      { date: '2026-01-05', value: 2, status: '', notes: '' },
      { date: '2026-01-07', value: 2, status: '', notes: '' },
      { date: '2026-01-09', value: 2, status: '', notes: '' },
    ],
  },
  {
    name: 'Reading',
    description: 'Retired habit',
    type: 'numerical',
    unit: 'pages',
    // A fractional target, to catch any accidental integer rounding.
    target_value: 12.5,
    target_type: 'at_least',
    freq_numerator: 1,
    freq_denominator: 1,
    color: '#8b5cf6',
    reminder_time: '',
    archived: true,
    entries: [
      { date: '2026-01-05', value: 20, status: '', notes: '' },
      { date: '2026-01-06', value: 12.5, status: '', notes: '' },
    ],
  },
];

/** Normalized comparison key for one habit's entries. */
export function entryKey(e) {
  const status = e.status === 'skip' ? 'skip' : '';
  return `${e.date}|${Number(e.value)}|${status}`;
}

/** Entries as a sorted, comparable array of strings. */
export function entrySet(entries) {
  return entries.map(entryKey).sort();
}

/** Entries including notes, for the lossless format. */
export function entrySetWithNotes(entries) {
  return entries
    .map((e) => `${entryKey(e)}|${e.notes ?? ''}`)
    .sort();
}

/**
 * Fields BOTH Loop formats can carry.
 *
 * `reminder_message` is Loop's `question` — the prompt a reminder asks, which
 * is the same field under another name. The .db has the column and Habits.csv
 * has the header, so both formats carry it.
 *
 * `description` and `archived` are here for the same reason and were left out
 * for years anyway, on a comment rather than a measurement. Both formats have
 * always had somewhere to put them; the CSV's `Description` column is in fact
 * already asserted a few lines apart in both suites, by hand, for one habit.
 *
 * `color` is the one habit field that stays out, and it belongs in NEITHER
 * list rather than in one of them: the .db stores Loop's palette *index*, so
 * `colorToLoopIndex` snaps `#123456` to `#475569` on the way out, while
 * Habits.csv writes the hex verbatim and keeps it. So it is not a field the
 * two Loop formats share — it goes in `CSV_HABIT_FIELDS` below, and nowhere
 * near the .db.
 *
 * Leaving it out of BOTH was the state this file was in, and it cost exactly
 * what the excluded fields above cost: rewriting `esc(h.color)` to a constant
 * in `buildHabitsCsv` — every habit's colour destroyed on export — passed both
 * suites.
 */
export const LOOP_HABIT_FIELDS = [
  'name', 'type', 'unit', 'target_value', 'target_type',
  'freq_numerator', 'freq_denominator', 'reminder_message',
  'description', 'archived',
];

/**
 * ...and what only the .db can carry. Loop stores a reminder as
 * `reminder_hour` / `reminder_min` in the Habits *table* and exports neither to
 * Habits.csv, so a reminder time survives one Loop format and not the other.
 * That asymmetry is the format's, not a bug, which is why it is three lists.
 *
 * Per-day notes are the .db's other exclusive, and they are not a field on the
 * habit — they ride on `Repetitions.notes`, so they are the `notes` flag to
 * `snapshot` rather than an entry here. Checkmarks.csv is a grid of values with
 * nowhere to hang one, which is why the CSV comparisons keep `notes: false`
 * and the .db comparisons no longer do.
 */
export const LOOP_DB_HABIT_FIELDS = [...LOOP_HABIT_FIELDS, 'reminder_time'];

/**
 * ...and what only the CSV pair can carry. Just the colour, for the reason
 * given above — Habits.csv writes the hex and the .db cannot.
 */
export const CSV_HABIT_FIELDS = [...LOOP_HABIT_FIELDS, 'color'];

/**
 * Fields the lossless JSON backup must preserve exactly.
 *
 * `at_most_unlogged` is habiterall's own and belongs in NO Loop list: it is a
 * preference about how to read the rows, and Loop's schema has nowhere to put
 * one — its backup carries no preferences at all. So a Loop round trip
 * correctly returns it to 'default', and only this list watches it. The
 * paragraph above `LOOP_HABIT_FIELDS` is about the cost of a field in neither
 * list; this is the case where exactly one is right.
 */
export const JSON_HABIT_FIELDS = [
  ...LOOP_DB_HABIT_FIELDS, 'color', 'at_most_unlogged', 'show_as',
];

export function pick(obj, fields) {
  const out = {};
  for (const f of fields) {
    let v = obj[f];
    // SQLite stores booleans as 0/1 and numbers may arrive as strings from pg.
    if (f === 'archived') v = Boolean(v === true || v === 1 || v === '1' || v === 't');
    else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && f !== 'name' && f !== 'unit') {
      v = Number(v);
    } else if (f === 'target_value') v = Number(v);
    out[f] = v;
  }
  return out;
}

/**
 * Check a baseline snapshot against the FIXTURE, which is the only oracle in
 * this file that does not come out of the code under test.
 *
 * Both round-trip suites read their "before" through the thing they are
 * testing — personal's `current()` is `GET /api/export`, and cloud builds its
 * expectation with `toJsonBackup` — so a field the export destroys is
 * destroyed identically on both sides of every `diff()` and the round trip
 * agrees with itself. Measured against `3c19da4`: clobbering `color`, `unit`,
 * `at_most_unlogged` and `show_as` in personal's `toApiHabit` passed 546 unit
 * tests plus every integration and offline browser suite in the repo. That is
 * the whole of #113's `show_as` and every habit-level unlogged override
 * silently switched off, with nothing red.
 *
 * Only the fields a fixture habit actually DECLARES are compared, so this
 * cannot go stale: adding a field to the fixture starts watching it, and a
 * habit that leaves one at its default is not asked about it — which is the
 * same rule the fixture's own comments already apply by hand when they set
 * `at_most_unlogged` and `show_as` away from their defaults on purpose.
 *
 * @param {any[]} baseline  the output of `snapshot(...)` with default fields
 * @param {(name: string, ok: boolean, detail?: string) => void} ck
 */
export function checkAgainstFixture(baseline, ck) {
  ck('every fixture habit is in the baseline',
    baseline.length === FIXTURE.length,
    `${baseline.length} of ${FIXTURE.length}`);

  for (const want of FIXTURE) {
    const got = baseline.find((h) => h.name === want.name);
    if (!got) {
      ck(`fixture habit "${want.name}" is in the baseline`, false);
      continue;
    }
    for (const field of JSON_HABIT_FIELDS) {
      if (!Object.hasOwn(want, field)) continue;
      const expected = pick(want, [field])[field];
      ck(`${want.name}: ${field} is what was stored`,
        got[field] === expected,
        `expected ${JSON.stringify(expected)} got ${JSON.stringify(got[field])}`);
    }
    const wantEntries = entrySetWithNotes(want.entries ?? []);
    ck(`${want.name}: every entry is what was stored`,
      JSON.stringify(got.entries) === JSON.stringify(wantEntries),
      `expected ${JSON.stringify(wantEntries)} got ${JSON.stringify(got.entries)}`);
  }
}

/**
 * A stable, order-independent description of the whole dataset, for the
 * formats that are supposed to be lossless.
 */
export function snapshot(habits, { fields = JSON_HABIT_FIELDS, notes = true } = {}) {
  return habits
    .map((h) => ({
      ...pick(h, fields),
      entries: notes ? entrySetWithNotes(h.entries ?? []) : entrySet(h.entries ?? []),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Deep equality with a readable diff, good enough for test output. */
export function diff(a, b) {
  const sa = JSON.stringify(a, null, 1);
  const sb = JSON.stringify(b, null, 1);
  if (sa === sb) return null;
  const la = sa.split('\n');
  const lb = sb.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i}: expected ${la[i] ?? '(none)'} got ${lb[i] ?? '(none)'}`;
  }
  return 'differs';
}
