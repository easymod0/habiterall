/**
 * Postgres writer for imported data (cloud edition).
 *
 * SECURITY: an import writes many rows in one operation, so it is the most
 * dangerous place for a tenancy mistake. Three independent defences apply:
 *
 *   1. Every INSERT sets user_id explicitly from the authenticated session.
 *   2. All work happens inside `withUser`, so Row-Level Security rejects any
 *      row whose user_id does not match `app.user_id` (the WITH CHECK clause).
 *   3. Ids that arrive inside the uploaded file are IGNORED. A backup taken
 *      from another account — or a hand-edited one naming someone else's
 *      habit id — cannot address rows outside the importer's own data,
 *      because we never use an id from the payload.
 *
 * The parsers in @habiterall/shared/import.js produce plain data and never
 * touch a database, which is what lets the same format logic serve both the
 * single-user and multi-user editions.
 */

import { withUser } from './db/pool.js';
import { UNSET, YES, SKIP } from '@habiterall/shared/constants.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Ceilings so one upload cannot exhaust the database on a shared host. */
const MAX_HABITS_PER_IMPORT = Number(process.env.MAX_HABITS_PER_IMPORT) || 200;
const MAX_ENTRIES_PER_IMPORT = Number(process.env.MAX_ENTRIES_PER_IMPORT) || 200_000;

/**
 * Write a parsed habit list into the importing user's own account.
 *
 * @param {number} userId  authenticated user, from the session — never the file
 * @param {Array}  habits  parsed habits (shape from the shared parsers)
 * @param {'merge'|'replace'} mode
 */
export async function applyImport(userId, habits, mode = 'merge') {
  const result = {
    habitsCreated: 0, habitsMerged: 0, entriesImported: 0, skipped: [],
  };

  if (habits.length > MAX_HABITS_PER_IMPORT) {
    throw Object.assign(
      new Error(`import contains too many habits (limit ${MAX_HABITS_PER_IMPORT})`),
      { status: 413 }
    );
  }

  const totalEntries = habits.reduce((n, h) => n + (h.entries?.length ?? 0), 0);
  if (totalEntries > MAX_ENTRIES_PER_IMPORT) {
    throw Object.assign(
      new Error(`import contains too many entries (limit ${MAX_ENTRIES_PER_IMPORT})`),
      { status: 413 }
    );
  }

  // One transaction: a failure part-way leaves the account untouched rather
  // than half-imported.
  await withUser(userId, async (db) => {
    if (mode === 'replace') {
      // RLS scopes these to the caller, so "delete everything" can only ever
      // mean "everything of mine".
      await db.query('DELETE FROM entries');
      await db.query('DELETE FROM habits');
    }

    const { rows: [{ next }] } = await db.query(
      `SELECT COALESCE(MAX(position) + 1, 0) AS next FROM habits`
    );
    let position = next;

    for (const h of habits) {
      const name = String(h.name ?? '').trim();
      if (!name) {
        result.skipped.push('habit with empty name');
        continue;
      }

      const type = h.type === 'numerical' ? 'numerical' : 'boolean';

      // Match on NAME, never on an id from the file.
      let habitId = null;
      if (mode === 'merge') {
        const { rows } = await db.query(
          `SELECT id FROM habits WHERE name = $1 LIMIT 1`, [name]
        );
        if (rows.length) {
          habitId = rows[0].id;
          result.habitsMerged++;
        }
      }

      if (habitId === null) {
        const num = Math.max(1, Number(h.freq_numerator) || 1);
        let den = Math.max(1, Number(h.freq_denominator) || 1);
        if (num > den) den = num;

        const { rows } = await db.query(
          `INSERT INTO habits (user_id, name, description, type, unit,
                               target_value, target_type, freq_numerator,
                               freq_denominator, color, reminder_time,
                               position, archived)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id`,
          [
            userId,                                   // from the session, always
            name,
            String(h.description ?? '').slice(0, 500),
            type,
            String(h.unit ?? '').slice(0, 20),
            Math.max(0, Number(h.target_value) || 0),
            h.target_type === 'at_most' ? 'at_most' : 'at_least',
            num,
            Math.min(den, 365),
            /^#[0-9a-fA-F]{6}$/.test(h.color ?? '') ? h.color : '#3b82f6',
            /^([01]\d|2[0-3]):[0-5]\d$/.test(h.reminder_time ?? '') ? h.reminder_time : '',
            position++,
            !!h.archived,
          ]
        );
        habitId = rows[0].id;
        result.habitsCreated++;
      }

      for (const e of h.entries ?? []) {
        if (!e || typeof e !== 'object') continue;
        if (!DATE_RE.test(e.date ?? '')) {
          result.skipped.push(`bad date on "${name}": ${e.date}`);
          continue;
        }

        const isSkip = e.status === 'skip' ||
          (type === 'boolean' && Number(e.value) === SKIP);

        if (isSkip) {
          await upsert(db, userId, habitId, e.date, 0, 'skip', e.notes);
          result.entriesImported++;
          continue;
        }

        const value = Number(e.value);
        if (!Number.isFinite(value) || value < 0) {
          result.skipped.push(`bad value on "${name}" at ${e.date}: ${e.value}`);
          continue;
        }

        const notes = String(e.notes ?? '').slice(0, 500);

        // Boolean "not done" is the absence of a row, unless a note needs
        // somewhere to live.
        if (type === 'boolean' && value !== YES) {
          if (!notes) continue;
          await upsert(db, userId, habitId, e.date, UNSET, '', notes);
          result.entriesImported++;
          continue;
        }

        await upsert(db, userId, habitId, e.date, value, '', notes);
        result.entriesImported++;
      }
    }
  });

  return result;
}

function upsert(db, userId, habitId, date, value, status, notes) {
  return db.query(
    `INSERT INTO entries (habit_id, user_id, date, value, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (habit_id, date) DO UPDATE
       SET value = EXCLUDED.value,
           status = EXCLUDED.status,
           notes = EXCLUDED.notes`,
    [habitId, userId, date, value, status, String(notes ?? '').slice(0, 500)]
  );
}
