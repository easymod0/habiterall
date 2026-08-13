/**
 * A shared fixture and comparison rules for backup round-trip tests.
 *
 * Used by both editions' round-trip suites so that "what a faithful restore
 * means" is defined once. The three export formats do not have the same
 * fidelity ceiling, and pretending they do produces either false failures or
 * a test that asserts nothing:
 *
 *   JSON  — habiterall's own backup. Lossless. Everything must survive.
 *   Loop .db — Loop's schema. Carries type, target, unit, frequency, colour
 *              and every entry, but has nowhere to put per-day notes, our
 *              description text, or archived state.
 *   CSV   — Loop's Checkmarks.csv. Dates and values only; every habit
 *           attribute is absent, so a restore can only rebuild boolean
 *           habits with their check pattern.
 *
 * The fixture deliberately includes the cases that have actually broken:
 * a 3 on a numerical habit (must not become a skip), an at_most target
 * (0 is a success), a non-integer amount, a skip, a note on an otherwise
 * empty day, and an archived habit.
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
    reminder_time: '',
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
 * Fields a Loop .db backup can carry. Notes, description and archived state
 * have nowhere to live in Loop's schema, so they are excluded here rather
 * than being asserted and failing for a reason that is not a bug.
 */
export const LOOP_HABIT_FIELDS = [
  'name', 'type', 'unit', 'target_value', 'target_type',
  'freq_numerator', 'freq_denominator',
];

/** Fields the lossless JSON backup must preserve exactly. */
export const JSON_HABIT_FIELDS = [
  ...LOOP_HABIT_FIELDS, 'description', 'color', 'reminder_time',
  'reminder_message', 'archived',
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
