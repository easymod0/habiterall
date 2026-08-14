/**
 * SQLite writer for imported data (personal edition).
 *
 * Format parsing lives in shared/src/import.js; this module owns the
 * storage-specific half, so the shared parsers stay database-agnostic.
 */

import { db, UNSET, YES, SKIP } from './db.js';
// Loop stores colours as a palette index, so imported habits need the same
// index -> hex mapping the parsers use.
import { normaliseImportedHabit } from '@habiterall/shared/import.js';

/* ---------- statements ---------- */

const insertHabit = db.prepare(`
  INSERT INTO habits (name, description, type, unit, target_value, target_type,
                      freq_numerator, freq_denominator, color, reminder_time,
                      reminder_message, position, archived)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
 */
const insertEntryIfAbsent = db.prepare(`
  INSERT INTO entries (habit_id, date, value, status, notes) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(habit_id, date) DO NOTHING
`);
const findHabitByName = db.prepare(`SELECT * FROM habits WHERE name = ? LIMIT 1`);
const maxPosition = db.prepare(`SELECT COALESCE(MAX(position) + 1, 0) AS p FROM habits`);
const clearAllEntries = db.prepare(`DELETE FROM entries`);
const clearAllHabits = db.prepare(`DELETE FROM habits`);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
      const name = String(h.name ?? '').trim();
      if (!name) {
        result.skipped.push('habit with empty name');
        continue;
      }

      // Every field rule is in shared: the two editions' writers had drifted,
      // and this one had no length clamps at all.
      const clean = normaliseImportedHabit(h);
      const type = clean.type;
      const existing = mode === 'merge' ? findHabitByName.get(name) : null;

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
          position++,
          // SQLite has no boolean.
          clean.archived ? 1 : 0
        );
        habitId = info.lastInsertRowid;
        result.habitsCreated++;
      }

      for (const e of h.entries ?? []) {
        if (!e || typeof e !== 'object') continue;
        if (!DATE_RE.test(e.date ?? '')) {
          result.skipped.push(`bad date on "${name}": ${e.date}`);
          continue;
        }

        // An explicit status always wins. The legacy SKIP wire value is only
        // honoured for boolean habits, where 3 is unambiguously a sentinel —
        // on a numerical habit 3 is a real amount and must stay one.
        const isSkip = e.status === 'skip' ||
          (type === 'boolean' && Number(e.value) === SKIP);
        if (isSkip) {
          insertEntry.run(habitId, e.date, 0, 'skip', String(e.notes ?? ''));
          result.entriesImported++;
          continue;
        }

        const value = Number(e.value);
        if (!Number.isFinite(value) || value < 0) {
          result.skipped.push(`bad value on "${name}" at ${e.date}: ${e.value}`);
          continue;
        }
        const notes = String(e.notes ?? '');

        // A row is an answer, whatever it says. This used to drop a boolean row
        // that was not YES unless it carried a note — which quietly turned every
        // stated lapse in the file into a day nobody had answered, and made an
        // import lossy in exactly the way `questionMarks` exists to expose. A
        // day with no answer has no row in the file either, so there is nothing
        // here to decide about it.
        const stored = type === 'boolean' && value !== YES ? UNSET : value;
        // A bare lapse yields to whatever the account already holds for that day,
        // in merge mode only — see `insertEntryIfAbsent`. With a note it is
        // content rather than an absence of one, and in replace mode there is
        // nothing to yield to.
        const yielding = mode === 'merge' && stored === UNSET && !notes &&
          type === 'boolean';
        const written = (yielding ? insertEntryIfAbsent : insertEntry)
          .run(habitId, e.date, stored, '', notes);
        if (written.changes > 0) result.entriesImported++;
        else result.entriesKept++;
      }
    }

    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
  return result;
}

