/**
 * SQLite writer for imported data (personal edition).
 *
 * Format parsing lives in shared/src/import.js; this module owns the
 * storage-specific half, so the shared parsers stay database-agnostic.
 */

import { db, UNSET, YES, SKIP } from './db.js';
// Loop stores colours as a palette index, so imported habits need the same
// index -> hex mapping the parsers use.
import { normalizeColor } from '@habiterall/shared/import.js';

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
  const result = { habitsCreated: 0, habitsMerged: 0, entriesImported: 0, skipped: [] };

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

      const type = h.type === 'numerical' ? 'numerical' : 'boolean';
      const existing = mode === 'merge' ? findHabitByName.get(name) : null;

      let habitId;
      if (existing) {
        habitId = existing.id;
        result.habitsMerged++;
      } else {
        const num = Math.max(1, Number(h.freq_numerator) || 1);
        let den = Math.max(1, Number(h.freq_denominator) || 1);
        if (num > den) den = num; // Loop permits shapes our validation rejects

        const info = insertHabit.run(
          name,
          String(h.description ?? ''),
          type,
          String(h.unit ?? ''),
          Number(h.target_value) || 0,
          h.target_type === 'at_most' ? 'at_most' : 'at_least',
          num,
          den,
          normalizeColor(h.color),
          /^([01]\d|2[0-3]):[0-5]\d$/.test(h.reminder_time ?? '') ? h.reminder_time : '',
          // One line, capped: the same rule parseHabit applies, because an
          // imported prompt lands in the Android client's line-delimited cache
          // exactly like one typed into the dialog.
          String(h.reminder_message ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200),
          position++,
          h.archived ? 1 : 0
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

        // Absence encodes "not done" for boolean habits, so a zero row is
        // normally dropped — unless it carries a note, which needs a row to
        // live on ("didn't run today, was ill").
        if (type === 'boolean' && value !== YES) {
          if (!notes) continue;
          insertEntry.run(habitId, e.date, UNSET, '', notes);
          result.entriesImported++;
          continue;
        }

        insertEntry.run(habitId, e.date, value, '', notes);
        result.entriesImported++;
      }
    }

    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
  return result;
}

