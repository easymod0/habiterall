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
 * A number as plain decimal digits, never JS exponent notation.
 *
 * `String(1e-7)` is `1e-7` and `String(1e21)` is `1e+21`, and both are what a
 * cell used to hold — the API accepts any finite non-negative amount, so both
 * are reachable by writing one. Our own importer survives them because it
 * parses with `Number()`, but this is Loop's format and other tools read it;
 * a reader that expects a decimal sees text.
 *
 * The rewrite is an exact expansion, not a rounding, and it only ever runs on
 * a value whose shortest representation HAS an exponent — an ordinary 8 or 0.5
 * comes back byte for byte. That restraint is the point: silently restating
 * the precision of every amount in the file would be a worse bug than the one
 * this fixes. The price is paid at the extremes instead, where the cell gets
 * long (5e-324 is 326 characters), which is what not changing the number costs.
 */
export function csvNumber(value) {
  const n = Number(value);
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;

  const [, sign, int, frac = '', exp] = m;
  const digits = int + frac;
  // Where the point falls in `digits`. Placing it rather than computing is what
  // makes this lossless: the digits are the shortest ones that round-trip, and
  // they are copied, not arithmetic.
  const point = digits.length + Number(exp) - frac.length;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  // The middle case — a point falling INSIDE the digits — is unreachable today
  // and kept because it is the correct answer if it ever is reached. JS only
  // uses exponential form at exponents >= 21 or <= -7, and always with exactly
  // one integer digit, so `point` is either well past the end (the branch above)
  // or at or below zero (the branch below). Confirmed over ~930,000 doubles: no
  // hits. Do not delete it to raise coverage; it is a guard, not dead weight.
  return point > 0
    ? sign + digits.slice(0, point) + '.' + digits.slice(point)
    : sign + '0.' + '0'.repeat(-point) + digits;
}

/**
 * The metadata file. Column names match what `parseLoopHabitsCSV` looks for,
 * so our own export can be read back by our own importer.
 *
 * They are NOT Loop 2.x's header, which is
 * `Position,Name,Type,Question,Description,FrequencyNumerator,FrequencyDenominator,Color,Unit,Target Type,Target Value,Archived?`
 * — different order, spelled-out frequency columns, and `Archived?` with the
 * question mark. This is habiterall's own dialect and always has been; the
 * importer accepts both, and Loop has no Habits.csv importer at all, so nothing
 * downstream depends on matching it. Worth knowing before "fixing" either side
 * to agree with the other: `NumRepetitions` together with `Question` is a
 * combination no Loop version ever wrote, which makes it a fingerprint for a
 * habiterall file.
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
 *
 * The suffix has to be checked against the OTHER habits, not just counted per
 * name. `Run`, `Run`, `Run (2)` used to produce the header
 * `Date,Run,Run (2),Run (2)` — the exact collision this function exists to
 * prevent, re-created by the fix for it, and every consequence above then
 * followed for a user who had simply named a habit `Run (2)` by hand.
 *
 * Two rules make the answer independent of the order the duplicates arrive in.
 * A name is claimed by the FIRST habit that carries it, so a suffix never
 * displaces a habit that was named that way on purpose. And the candidate is
 * tested against every original name as well as the ones already handed out,
 * because the habit that owns the plain `Run (2)` may not have been reached
 * yet — checking only what has been assigned so far would rename it instead,
 * which is the same collision one habit further along.
 */
export function uniqueNames(habits) {
  const original = new Set(habits.map((h) => String(h.name ?? '')));
  const assigned = new Set();
  return habits.map((h) => {
    const name = String(h.name ?? '');
    if (!assigned.has(name)) {
      assigned.add(name);
      return h;
    }
    // `original` is finite, so this terminates: at worst it walks past every
    // name in the export.
    let n = 2;
    while (original.has(`${name} (${n})`) || assigned.has(`${name} (${n})`)) n++;
    assigned.add(`${name} (${n})`);
    return { ...h, name: `${name} (${n})` };
  });
}

export function buildHabitsCsv(habits) {
  const header = [
    'Position', 'Name', 'Question', 'Description', 'NumRepetitions',
    'Interval', 'Color', 'Type', 'Unit', 'Target Value', 'Target Type',
    'Archived', 'Category',
  ];

  const lines = [header.join(',')];
  habits.forEach((h, i) => {
    lines.push([
      i,
      esc(h.name),
      // Question and Description are two different Loop fields. This wrote the
      // description into both, so a habiterall CSV round trip copied it over the
      // habit's reminder prompt — and the importer read `question` as a fallback
      // for `description`, which is what kept the duplication invisible.
      esc(h.reminder_message ?? ''),
      esc(h.description ?? ''),
      csvNumber(h.freq_numerator ?? 1),
      csvNumber(h.freq_denominator ?? 1),
      esc(h.color ?? ''),
      // The enum name Loop writes, which the parser matches on.
      h.type === 'numerical' ? 'NUMERICAL' : 'YES_NO',
      esc(h.unit ?? ''),
      csvNumber(h.target_value ?? 0),
      h.target_type === 'at_most' ? 'AT_MOST' : 'AT_LEAST',
      h.archived ? 'true' : 'false',
      // The category's NAME, the same as the JSON backup — Loop has nowhere
      // to put this, which is why it is habiterall's own trailing column
      // rather than one Loop's dialect ever wrote.
      esc(h.category ?? ''),
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
      // An empty cell is a day with no row — Loop's UNKNOWN, and what the
      // importer reads back as one. A boolean row that is not YES is a stated
      // lapse and says so, or the round trip loses the distinction the whole
      // `questionMarks` setting rests on.
      if (e == null) row.push('');
      else if (e.status === 'skip') row.push('SKIP');
      else if (b.habit.type === 'boolean') {
        row.push(Number(e.value) === YES ? 'YES_MANUAL' : 'NO');
      } else row.push(csvNumber(e.value));
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
