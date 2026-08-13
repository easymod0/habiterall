/**
 * CSV export, in Loop's own archive shape: Habits.csv + Checkmarks.csv in a
 * zip.
 *
 * Checkmarks.csv alone cannot describe the data. It has one column per habit
 * and nothing that says what a habit *is*, so on re-import every column
 * defaults to boolean — and a measurable habit's value of 3 is then read as
 * Loop's SKIP sentinel while 8 and 10 are dropped as unknown ones. Habits.csv
 * carries the types, targets and units that make the numbers interpretable.
 *
 * Both editions call this so the two exports cannot drift.
 */

import { YES } from './constants.js';
import { zip } from './zip.js';

/** Quote a CSV field only when it needs it. */
export function esc(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The metadata file. Column names match what `parseLoopHabitsCSV` looks for,
 * so our own export can be read back by our own importer.
 */
/**
 * Make every habit name unique for the duration of an export.
 *
 * Both CSV files identify a habit by NAME — `Checkmarks.csv` has one column
 * per name, and `Habits.csv` is looked up by name on the way back in. Two
 * habits called "Run" therefore collapse to one metadata entry on import,
 * last-wins: both inherit the survivor's type, target and unit, and a
 * measurable habit re-read as boolean has its recorded amounts DROPPED
 * entirely, not merely mistyped.
 *
 * Nothing stops duplicate names existing — the validator does not require
 * uniqueness — so the export has to disambiguate. A suffix is visible and
 * reversible by hand; silently losing a habit's history is not.
 */
function uniqueNames(habits) {
  const seen = new Map();
  return habits.map((h) => {
    const name = String(h.name ?? '');
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? h : { ...h, name: `${name} (${n})` };
  });
}

export function buildHabitsCsv(habits) {
  const header = [
    'Position', 'Name', 'Question', 'Description', 'NumRepetitions',
    'Interval', 'Color', 'Type', 'Unit', 'Target Value', 'Target Type',
    'Archived',
  ];

  const lines = [header.join(',')];
  habits.forEach((h, i) => {
    lines.push([
      i,
      esc(h.name),
      esc(h.description ?? ''),
      esc(h.description ?? ''),
      Number(h.freq_numerator ?? 1),
      Number(h.freq_denominator ?? 1),
      esc(h.color ?? ''),
      // The enum name Loop writes, which the parser matches on.
      h.type === 'numerical' ? 'NUMERICAL' : 'YES_NO',
      esc(h.unit ?? ''),
      Number(h.target_value ?? 0),
      h.target_type === 'at_most' ? 'AT_MOST' : 'AT_LEAST',
      h.archived ? 'true' : 'false',
    ].join(','));
  });

  return lines.join('\n') + '\n';
}

/**
 * The checkmark grid: a Date column, then one column per habit.
 *
 * @param {Array} habits
 * @param {(habitId: any) => Array} entriesFor
 */
export function buildCheckmarksCsv(habits, entriesFor) {
  const byHabit = habits.map((h) => ({
    habit: h,
    entries: new Map(entriesFor(h.id).map((e) => [e.date, e])),
  }));

  const allDates = [...new Set(byHabit.flatMap((b) => [...b.entries.keys()]))].sort();

  const lines = [['Date', ...habits.map((h) => esc(h.name))].join(',')];

  for (const date of allDates) {
    const row = [date];
    for (const b of byHabit) {
      const e = b.entries.get(date);
      if (e == null) row.push('');
      else if (e.status === 'skip') row.push('SKIP');
      else if (b.habit.type === 'boolean') row.push(Number(e.value) === YES ? 'YES_MANUAL' : '');
      else row.push(String(e.value));
    }
    lines.push(row.join(','));
  }

  return lines.join('\n') + '\n';
}

/**
 * The full archive.
 *
 * @param {Array} habits
 * @param {(habitId: any) => Array} entriesFor
 * @param {Date} [modified]
 * @returns {Buffer}
 */
export function buildCsvArchive(habits, entriesFor, modified = new Date()) {
  // Disambiguate ONCE, here, so both files agree on the same names. Doing it
  // inside each builder separately would be enough for Habits.csv and
  // Checkmarks.csv to disagree about which "Run" is which.
  const named = uniqueNames(habits);
  return zip([
    { name: 'Habits.csv', data: buildHabitsCsv(named) },
    { name: 'Checkmarks.csv', data: buildCheckmarksCsv(named, entriesFor) },
  ], modified);
}
