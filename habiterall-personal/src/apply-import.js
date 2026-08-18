/**
 * SQLite writer for imported data (personal edition).
 *
 * Format parsing lives in shared/src/import.js; this module owns the
 * storage-specific half, so the shared parsers stay database-agnostic.
 */

import { db, UNSET, YES, SKIP } from './db.js';
// Loop stores colours as a palette index, so imported habits need the same
// index -> hex mapping the parsers use.
import { entryValue, normaliseImportedHabit } from '@habiterall/shared/import.js';
import { assertDate, LIMITS } from '@habiterall/shared/validate.js';

/* ---------- statements ---------- */

const insertHabit = db.prepare(`
  INSERT INTO habits (name, description, type, unit, target_value, target_type,
                      freq_numerator, freq_denominator, color, reminder_time,
                      reminder_message, at_most_unlogged, show_as, icon, position,
                      archived)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertEntry = db.prepare(`
  INSERT INTO entries (habit_id, date, value, status, notes) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(habit_id, date) DO UPDATE SET value = excluded.value,
                                            status = excluded.status,
                                            notes = excluded.notes
`);
/**
 * The same insert, but yielding to a row that is already there.
 *
 * Used for one case: a bare "not done" arriving in MERGE mode. A merge may add
 * what the account does not have; it must not delete an answer, and overwriting a
 * recorded completion with a lapse is deleting one. Now that a boolean 0 is a row
 * rather than a dropped value, the plain upsert above would do exactly that — and
 * a Loop backup is full of explicit NO rows, so merging a phone export taken
 * before the web history would have wiped every completion it disagreed with.
 *
 * "A bare not done" is not a boolean-only shape, which is how this was written
 * and what made the protection half a rule: a numerical habit's lapse is a row
 * holding 0, and gating the yield on `type === 'boolean'` let a merge write one
 * over eight recorded glasses of water.
 */
const insertEntryIfAbsent = db.prepare(`
  INSERT INTO entries (habit_id, date, value, status, notes) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(habit_id, date) DO NOTHING
`);
const findHabitByName = db.prepare(`SELECT * FROM habits WHERE name = ? LIMIT 1`);
const maxPosition = db.prepare(`SELECT COALESCE(MAX(position) + 1, 0) AS p FROM habits`);
const clearAllEntries = db.prepare(`DELETE FROM entries`);
const clearAllHabits = db.prepare(`DELETE FROM habits`);

/**
 * Write a normalized habit list into the database.
 *
 * `mode`:
 *   'merge'   - add new habits; for names that already exist, merge entries in
 *   'replace' - wipe everything first
 *
 * A habit shape is:
 *   { name, description, type, unit, target_value, target_type,
 *     freq_numerator, freq_denominator, color, archived, entries: [{date, value, notes}] }
 */
export function applyImport(habits, mode = 'merge') {
  // `entriesKept` counts days the file wanted to mark as missed and the account
  // already had an answer for. Declared here so the reply shape is stable.
  const result = {
    habitsCreated: 0, habitsMerged: 0, entriesImported: 0, entriesKept: 0, skipped: [],
  };

  db.prepare('BEGIN').run();
  try {
    if (mode === 'replace') {
      clearAllEntries.run();
      clearAllHabits.run();
    }

    // node:sqlite may hand back a bigint; the column is a small integer.
    let position = Number(maxPosition.get().p);

    for (const h of habits) {
      // Every field rule is in shared: the two editions' writers had drifted,
      // and this one had no length clamps at all.
      const clean = normaliseImportedHabit(h);
      // The CLAMPED name, because that is the name a habit is stored under.
      // Matching on the raw one is what broke merge idempotency for any name
      // over LIMITS.name: the lookup asked for 150 characters, the INSERT wrote
      // the first 100, so the next merge of the same file matched nothing and
      // created a second habit — three imports, three habits, one visible name.
      // Restoring twice is the normal way to check a backup is good, so this
      // defeated the workflow it is most likely to be used in. Every other
      // reader of the name follows it here, or the file's habit and the
      // account's habit come to be two different habits inside one loop.
      const name = clean.name;
      if (!name) {
        result.skipped.push('habit with empty name');
        continue;
      }

      // What the FILE says, which is how its values are encoded — a `3` is a
      // skip sentinel in a boolean column and three of something in a numerical
      // one. It is not a claim about what this account can store.
      const fileType = clean.type;
      const existing = mode === 'merge' ? findHabitByName.get(name) : null;

      // ...and on a merge the habit already exists, so its own type is the
      // authority for what may be WRITTEN. Taking the file's meant a file
      // claiming `numerical` could put an 8 on a boolean habit through import
      // that `PUT /entries/:date` answers 400 to — and `isCompleted` is
      // `value === YES` there, so that day reads as not done forever and the
      // tap cycle has no state for it.
      const type = existing ? existing.type : clean.type;
      let habitId;
      if (existing) {
        habitId = existing.id;
        result.habitsMerged++;
      } else {
        const info = insertHabit.run(
          clean.name,
          clean.description,
          clean.type,
          clean.unit,
          clean.target_value,
          clean.target_type,
          clean.freq_numerator,
          clean.freq_denominator,
          clean.color,
          clean.reminder_time,
          clean.reminder_message,
          clean.at_most_unlogged,
          clean.show_as,
          clean.icon,
          position++,
          // SQLite has no boolean.
          clean.archived ? 1 : 0
        );
        habitId = info.lastInsertRowid;
        result.habitsCreated++;
      }

      // Days the file answered in a vocabulary this habit has no room for; see
      // below. Counted rather than listed, because it is one fact about the
      // habit and not news about each of a year of days.
      let untranslatable = 0;

      for (const e of h.entries ?? []) {
        if (!e || typeof e !== 'object') continue;
        // The shape being right does not make the date real, and the pattern
        // this used to be was the whole check: `2026-02-30` imported as a 200
        // where `PUT /entries/2026-02-30` answers 400, and the two editions then
        // failed differently — SQLite filed the row under a day that does not
        // exist, Postgres threw a 22008 that lost the entire import. `assertDate`
        // is the rule the API already applies; see its own comment.
        try {
          assertDate(e.date);
        } catch {
          result.skipped.push(`bad date on "${name}": ${e.date}`);
          continue;
        }

        // Clamped to what `parseEntry` accepts, so import cannot store a note
        // this account's own API would truncate — and so a personal export can
        // be read by cloud, which has always clamped, without silently losing
        // the tail. Read from LIMITS rather than restated: two copies of a
        // number is how the editions came to disagree about this one.
        const notes = String(e.notes ?? '').slice(0, LIMITS.notes);

        // Read once, and by TYPE — `entryValue`, not `Number()`, which read
        // `null` and `''` as the number 0 and so wrote a stated lapse out of a
        // field the file left empty. Its own comment has the whole argument.
        const value = entryValue(e.value);

        // An explicit status always wins. The legacy SKIP wire value is only
        // honoured for a boolean FILE, where 3 is unambiguously a sentinel — in
        // a numerical one 3 is a real amount and must stay one. That question is
        // about how the value was written down, so it asks the file's type even
        // where the habit's is what decides the storage.
        // A skip does NOT yield, and that is the one asymmetry in the rule above.
        // A skip is an answer — `isCompleted` returns null for it, not false —
        // so a file asserting one is asserting something, where a bare lapse may
        // only be the absence of a row. The consequence is worth stating plainly
        // because it is the headline case inverted: a `SKIP` cell in a bare
        // Checkmarks.csv DOES overwrite a recorded eight glasses. Both editions
        // agree, and this is unchanged from before the yield was widened.
        const isSkip = e.status === 'skip' ||
          (fileType === 'boolean' && value === SKIP);
        if (isSkip) {
          insertEntry.run(habitId, e.date, 0, 'skip', notes);
          result.entriesImported++;
          continue;
        }

        if (value === null || value < 0) {
          result.skipped.push(`bad value on "${name}" at ${e.date}: ${e.value}`);
          continue;
        }

        // What the file says about the day, read in the file's own vocabulary: a
        // boolean file says "done" only with YES, a numerical one with any
        // amount above zero.
        const lapse = fileType === 'boolean' ? value !== YES : value === 0;

        let stored;
        if (fileType === type) {
          // A row is an answer, whatever it says. This used to drop a boolean row
          // that was not YES unless it carried a note — which quietly turned every
          // stated lapse in the file into a day nobody had answered, and made an
          // import lossy in exactly the way `questionMarks` exists to expose. A
          // day with no answer has no row in the file either, so there is nothing
          // here to decide about it.
          stored = lapse ? UNSET : value;
        } else if (lapse) {
          // The two disagree, which only a merge into a habit whose type has
          // changed can produce. A lapse is the one answer that means the same
          // thing on both sides — zero glasses and "no" are both a day the user
          // says they did not do it — so it crosses.
          stored = UNSET;
        } else {
          // Nothing else does. An amount is not a yes, and a yes carries no
          // amount: writing 8 into a boolean habit is what the API refuses, and
          // reading a boolean YES as "2 glasses" against a target of 8 turns a
          // completed day into a failure. Both were being done silently. There
          // is no faithful form for the day here, so it is reported rather than
          // invented — the same answer `reminder_days` gets for a weekday mask.
          untranslatable++;
          continue;
        }

        // A bare lapse yields to whatever the account already holds for that day,
        // in merge mode only — see `insertEntryIfAbsent`. With a note it is
        // content rather than an absence of one, and in replace mode there is
        // nothing to yield to.
        // `!notes.trim()`, not `!notes`: a note of one space is truthy and was
        // enough to defeat the yield, so a file could overwrite eight recorded
        // glasses with a lapse by carrying whitespace. Widening this carve-out
        // beyond boolean habits is what gave that reach over an amount.
        const yielding = mode === 'merge' && stored === UNSET && !notes.trim();
        const written = (yielding ? insertEntryIfAbsent : insertEntry)
          .run(habitId, e.date, stored, '', notes);
        if (written.changes > 0) result.entriesImported++;
        else result.entriesKept++;
      }

      if (untranslatable) {
        result.skipped.push(
          `the file records "${name}" as ${fileType} and this account has it as ` +
          `${type}: ${untranslatable} answered ` +
          `${untranslatable === 1 ? 'day has' : 'days have'} no faithful form here`
        );
      }
    }

    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
  return result;
}

