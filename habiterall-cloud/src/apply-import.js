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
import { normaliseImportedHabit } from '@habiterall/shared/import.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Ceilings so one upload cannot exhaust the database on a shared host. */
const MAX_HABITS_PER_IMPORT = Number(process.env.MAX_HABITS_PER_IMPORT) || 200;
/**
 * 200,000 entries was legal and took over two minutes, holding a pool
 * connection and an open transaction throughout — ten such uploads exhaust
 * the default pool and every other tenant's request times out. 50,000 is
 * still ~135 years of daily history for one habit.
 */
const MAX_ENTRIES_PER_IMPORT = Number(process.env.MAX_ENTRIES_PER_IMPORT) || 50_000;

/**
 * Cap on the account TOTAL, not just this upload.
 *
 * `POST /habits` enforces a per-user habit limit but import did not, so two
 * successive 199-habit merges produced 398 habits — and every one of those
 * multiplies the per-habit work in /overview. Must match api.js.
 */
const MAX_HABITS_PER_USER = Number(process.env.MAX_HABITS_PER_USER) || 200;

/**
 * Write a parsed habit list into the importing user's own account.
 *
 * @param {number} userId  authenticated user, from the session — never the file
 * @param {Array}  habits  parsed habits (shape from the shared parsers)
 * @param {'merge'|'replace'} mode
 */
export async function applyImport(userId, habits, mode = 'merge') {
  const result = {
    // `entriesKept` counts days the file wanted to mark as missed and the account
    // already had an answer for. Declared here so the reply shape is stable.
    habitsCreated: 0, habitsMerged: 0, entriesImported: 0, entriesKept: 0, skipped: [],
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

    // Bound the ACCOUNT, not just this upload. `POST /habits` enforces a
    // per-user limit and import did not, so repeated merges accumulated
    // without limit — and each habit multiplies the per-habit work every
    // /overview request does. Counted inside the transaction so a `replace`
    // that just cleared the table starts from zero.
    const { rows: existingRows } = await db.query(`SELECT name FROM habits`);
    const existingNames = new Set(existingRows.map((r) => r.name));

    // Only names that do NOT already exist can add rows — merge matches by
    // name. Counting every incoming name would refuse a re-import of the same
    // backup, which has to stay idempotent: restoring twice is the normal way
    // to check a backup is good.
    const incoming = new Set(
      habits.map((h) => String(h.name ?? '').trim()).filter(Boolean)
    );
    let willAdd = 0;
    for (const name of incoming) if (!existingNames.has(name)) willAdd++;

    if (existingNames.size + willAdd > MAX_HABITS_PER_USER) {
      throw Object.assign(
        new Error(
          `import would exceed the habit limit (${MAX_HABITS_PER_USER}); ` +
          `you have ${existingNames.size} and this adds ${willAdd}`
        ),
        { status: 413 }
      );
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
        // Every field rule is in shared, so an imported habit is clamped the
        // same way in both editions — and to the same limits the API enforces.
        const clean = normaliseImportedHabit(h);

        const { rows } = await db.query(
          `INSERT INTO habits (user_id, name, description, type, unit,
                               target_value, target_type, freq_numerator,
                               freq_denominator, color, reminder_time,
                               reminder_message, position, archived)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING id`,
          [
            userId,                                   // from the session, always
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
            clean.archived,
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

        // A row is an answer, whatever it says — the same rule as the personal
        // edition's writer, and the reason it changed is written there. Dropping
        // a boolean 0 without a note turned every stated lapse in the file into a
        // day nobody had answered.
        const stored = type === 'boolean' && value !== YES ? UNSET : value;
        // And the same exception: in merge mode a bare lapse yields to an answer
        // the account already has, because a merge may add what is missing and
        // must not delete a completion. A Loop backup is full of explicit NO rows.
        const yielding = mode === 'merge' && stored === UNSET && !notes &&
          type === 'boolean';
        const written = await upsert(
          db, userId, habitId, e.date, stored, '', notes, { yielding });
        if (written) result.entriesImported++;
        else result.entriesKept++;
      }
    }
  });

  return result;
}

/**
 * @param {{yielding?: boolean}} [opts] `yielding` leaves a row that is already
 *   there alone — a merge adding a bare "not done" must not overwrite an answer.
 * @returns {Promise<boolean>} whether a row was written
 */
async function upsert(db, userId, habitId, date, value, status, notes, opts = {}) {
  const onConflict = opts.yielding
    ? 'DO NOTHING'
    : `DO UPDATE
         SET value = EXCLUDED.value,
             status = EXCLUDED.status,
             notes = EXCLUDED.notes`;

  const { rowCount } = await db.query(
    `INSERT INTO entries (habit_id, user_id, date, value, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (habit_id, date) ${onConflict}`,
    [habitId, userId, date, value, status, String(notes ?? '').slice(0, 500)]
  );
  return rowCount > 0;
}
