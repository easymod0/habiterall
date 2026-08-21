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

import { withUser, isCategoryNameConflict } from './db/pool.js';
import { UNSET, YES, SKIP } from '@habiterall/shared/constants.js';
import { entryValue, normaliseImportedHabit } from '@habiterall/shared/import.js';
import { assertDate, foldCategoryName, DEFAULT_COLOR, LIMITS } from '@habiterall/shared/validate.js';

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

// `categories.position` is a Postgres INTEGER (migration 015), so this is the
// actual ceiling the column can hold — a bigger declared value would 22003
// the whole import rather than fall back to appending. Personal mirrors this
// same bound in its own writer so both editions draw the same "absurd" line.
const MAX_CATEGORY_POSITION = 2_147_483_647;

/**
 * The file's own `position` is user-supplied and untrusted. `null`/`undefined`
 * means "the file did not say" (append, same as before this step); a value
 * that survives here is "the file said something usable" and is applied as
 * written. Anything else — non-finite, negative, or bigger than
 * `MAX_CATEGORY_POSITION` — falls back to appending too, the same distinction
 * `normaliseImportedHabit` already draws elsewhere.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function saneDeclaredPosition(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_CATEGORY_POSITION) return null;
  return n;
}

/**
 * Write a parsed habit list into the importing user's own account.
 *
 * @param {number} userId  authenticated user, from the session — never the file
 * @param {Array}  habits  parsed habits (shape from the shared parsers)
 * @param {'merge'|'replace'} mode
 * @param {Array<{name: string, color: string, position?: number}>} categories
 *   the file's own categories, from `backupCategories(buf)` — `[]` (never
 *   `null`) for a format with nowhere to carry one. A habit's own `category`
 *   is a NAME, not this array's index, and is resolved against it below —
 *   see the personal edition's writer for the identical rule, mirrored here
 *   inside the same `withUser` transaction rather than a second one.
 */
export async function applyImport(userId, habits, mode = 'merge', categories = []) {
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

  // Every field rule is in shared, so an imported habit is clamped the same way
  // in both editions — and to the same limits the API enforces. Done for the
  // whole file up front, because the CLAMPED name is what the account stores and
  // therefore the only name that can be matched, counted or looked up. It used
  // to be computed inside the INSERT branch alone, so the two questions asked
  // before it — "is this name new?" and "does a habit by this name exist?" —
  // both asked about a name no row could ever hold.
  const cleaned = habits.map((h) => normaliseImportedHabit(h));

  // One transaction: a failure part-way leaves the account untouched rather
  // than half-imported.
  await withUser(userId, async (db) => {
    if (mode === 'replace') {
      // RLS scopes these to the caller, so "delete everything" can only ever
      // mean "everything of mine".
      await db.query('DELETE FROM entries');
      await db.query('DELETE FROM habits');
      // A replace means "make this account look like the file", and that
      // includes its categories — never a partial wipe that left a stray
      // category behind with nothing pointing at it. RLS scopes this too.
      await db.query('DELETE FROM categories');
    }

    // Preloaded with whatever the account already has — empty right after the
    // replace-mode wipe above, so the file's categories below always insert;
    // on a merge, whatever already exists by folded name is found here first.
    const { rows: existingCategories } = await db.query(
      `SELECT id, name FROM categories`
    );
    const categoryIdByFold = new Map(
      existingCategories.map((c) => [foldCategoryName(c.name), c.id])
    );

    /**
     * Resolve NAME to a category id, creating one if the account (or this
     * import, so far) has none by that folded name — and never renaming or
     * recolouring one that already does. The same rule already written for
     * settings: a merge may ADD what is missing and must not overwrite what
     * is already there. Respects `LIMITS.categories`, the same ceiling
     * `POST /categories` enforces.
     *
     * @param {string} name
     * @param {string} color used only when a new category is actually created
     * @param {unknown} [declaredPosition] the file's own `position` for this
     *   category, if it declared one — a habit-derived category (named only
     *   in a habit's `category` field) never has one and always appends.
     * @returns {Promise<number | null>}
     */
    async function resolveOrCreateCategory(name, color, declaredPosition) {
      const folded = foldCategoryName(name);
      if (!folded) return null;
      if (categoryIdByFold.has(folded)) return categoryIdByFold.get(folded);
      if (categoryIdByFold.size >= LIMITS.categories) {
        result.skipped.push(
          `category "${name}" not created: at most ${LIMITS.categories} are allowed`);
        return null;
      }
      // $4 is the file's own DECLARED position, or `null` when there isn't
      // one — `COALESCE` falls through to the old append behaviour in that
      // case, and also when the account has no categories yet to take a MAX
      // of. RLS scopes the subquery to this user like everything else here.
      //
      // Wrapped in its own SAVEPOINT: Postgres, unlike SQLite, poisons the
      // WHOLE transaction the instant one statement inside it errors — every
      // later query would answer `25P02 current transaction is aborted`
      // rather than run at all. This function is called once per category
      // inside the ONE transaction `withUser` opened for the whole import,
      // and a caught conflict here has to let every category and habit AFTER
      // it still be attempted, not just avoid throwing itself.
      let rows;
      try {
        await db.query('SAVEPOINT category_insert');
        ({ rows } = await db.query(
          `INSERT INTO categories (user_id, name, color, position)
           VALUES ($1, $2, $3,
                   COALESCE($4, (SELECT MAX(position) + 1 FROM categories), 0))
           RETURNING id`,
          [userId, name, color, saneDeclaredPosition(declaredPosition)]
        ));
        await db.query('RELEASE SAVEPOINT category_insert');
      } catch (err) {
        // Undo just this statement's damage to the transaction, whether or
        // not what follows recognises the error — an unrecognised one still
        // has to leave the transaction usable for `withUser`'s own ROLLBACK.
        await db.query('ROLLBACK TO SAVEPOINT category_insert').catch(() => {});
        // `ROLLBACK TO` rewinds the WORK done since the savepoint; it does not
        // retire the savepoint itself, so without this the NEXT call's own
        // `SAVEPOINT category_insert` nests inside this one instead of
        // replacing it. `resolveOrCreateCategory` runs once per habit for a
        // habit-derived name, and `LIMITS.categories` only gates SUCCESSES, so
        // a file of N habits each naming a distinct colliding category leaves
        // N live subtransactions open in the one transaction `withUser` opened
        // for the whole import — Postgres degrades past roughly 64 of them via
        // the subtransaction SLRU. Released unconditionally, alongside the
        // rollback above, for the same reason that one runs before the error
        // is even looked at: whether or not it is recognised, the transaction
        // still has to come out of this function in a state `withUser`'s own
        // ROLLBACK — or the next iteration's fresh SAVEPOINT — can rely on.
        await db.query('RELEASE SAVEPOINT category_insert').catch(() => {});
        // The map above already covers an exact fold match; this is what
        // catches a name whose only difference from an existing one disagrees
        // with Postgres's own `lower()` backstop, or a genuine race. Recorded
        // as a skip rather than left to throw: without the savepoint above,
        // an uncaught constraint violation here took every habit and entry
        // the file was ever going to add down with it, not only the category
        // that collided.
        if (isCategoryNameConflict(err)) {
          result.skipped.push(
            `category "${name}" not created: a category with that name already exists`);
          return null;
        }
        throw err;
      }
      const id = rows[0].id;
      categoryIdByFold.set(folded, id);
      return id;
    }

    // The file's own declared categories, each with its own colour — applied
    // before any habit, so a habit naming one of these below almost never has
    // to invent it. `backupCategories(buf)` already caps this at
    // LIMITS.categories and drops anything nameless; the cap above is the
    // backstop for a merge pushing the account's own total past it.
    for (const c of categories) await resolveOrCreateCategory(c.name, c.color, c.position);

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
    //
    // Which is exactly what the RAW name broke. `existingNames` holds what is
    // stored and storage holds the clamped name, so for any name over
    // LIMITS.name nothing here ever matched: every re-import of the same backup
    // was counted as an addition and, worse, went on to make one.
    const incoming = new Set(cleaned.map((c) => c.name).filter(Boolean));
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

    for (const [i, h] of habits.entries()) {
      const clean = cleaned[i];
      // The CLAMPED name, because that is the name a habit is stored under —
      // see `cleaned` above, and the personal edition's writer, which had the
      // identical bug for the identical reason.
      const name = clean.name;
      if (!name) {
        result.skipped.push('habit with empty name');
        continue;
      }

      // What the FILE says, which is how its values are encoded — a `3` is a
      // skip sentinel in a boolean column and three of something in a numerical
      // one. It is not a claim about what this account can store.
      const fileType = clean.type;
      // ...and on a merge the habit already exists, so its own type is the
      // authority for what may be WRITTEN. Taking the file's meant a file
      // claiming `numerical` could put an 8 on a boolean habit through import
      // that `PUT /entries/:date` answers 400 to — and `isCompleted` is
      // `value === YES` there, so that day reads as not done forever and the
      // tap cycle has no state for it.
      let type = fileType;

      // Match on NAME, never on an id from the file.
      let habitId = null;
      if (mode === 'merge') {
        const { rows } = await db.query(
          `SELECT id, type FROM habits WHERE name = $1 LIMIT 1`, [name]
        );
        if (rows.length) {
          habitId = rows[0].id;
          type = rows[0].type;
          result.habitsMerged++;
        }
      }

      if (habitId === null) {
        // A merge matched by name touches nothing else about an existing
        // habit, so the category is resolved (and, if needed, created) only
        // for a habit actually being inserted — an existing one keeps
        // whatever category_id it already has. `''` is uncategorised and
        // resolves to null without touching the map at all.
        const categoryId = clean.category
          ? await resolveOrCreateCategory(clean.category, DEFAULT_COLOR)
          : null;
        const { rows } = await db.query(
          `INSERT INTO habits (user_id, name, description, type, unit,
                               target_value, target_type, freq_numerator,
                               freq_denominator, color, reminder_time,
                               reminder_message, at_most_unlogged, show_as,
                               icon, position, archived, category_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
            clean.at_most_unlogged,
            clean.show_as,
            clean.icon,
            position++,
            clean.archived,
            categoryId,
          ]
        );
        habitId = rows[0].id;
        result.habitsCreated++;
      }

      // Days the file answered in a vocabulary this habit has no room for; see
      // below. Counted rather than listed, because it is one fact about the
      // habit and not news about each of a year of days.
      let untranslatable = 0;

      for (const e of h.entries ?? []) {
        if (!e || typeof e !== 'object') continue;
        // The shape being right does not make the date real, and the pattern
        // this used to be was the whole check: `2026-02-30` matched it, reached
        // Postgres, and came back as a 22008 that surfaced as a 500 and rolled
        // the whole import back — where personal filed the row under a day that
        // does not exist. `assertDate` is the rule the API already applies; see
        // its own comment, which records this being paid for once already.
        try {
          assertDate(e.date);
        } catch {
          result.skipped.push(`bad date on "${name}": ${e.date}`);
          continue;
        }

        // Clamped to what `parseEntry` accepts, read from LIMITS rather than
        // restated: the literal 500 that was here is the same number by
        // coincidence rather than by construction, and personal had no clamp at
        // all — so a note this edition truncates was one that edition stored.
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
          await upsert(db, userId, habitId, e.date, 0, 'skip', notes);
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
          // A row is an answer, whatever it says — the same rule as the personal
          // edition's writer, and the reason it changed is written there. Dropping
          // a boolean 0 without a note turned every stated lapse in the file into a
          // day nobody had answered.
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

        // And the same exception: in merge mode a bare lapse yields to an answer
        // the account already has, because a merge may add what is missing and
        // must not delete a completion. A Loop backup is full of explicit NO rows.
        // Not gated on the type — a numerical habit's lapse is a row holding 0,
        // and gating it there let a merge write one over eight recorded glasses.
        // `!notes.trim()`, not `!notes`: a note of one space is truthy and was
        // enough to defeat the yield, so a file could overwrite eight recorded
        // glasses with a lapse by carrying whitespace. Widening this carve-out
        // beyond boolean habits is what gave that reach over an amount.
        const yielding = mode === 'merge' && stored === UNSET && !notes.trim();
        const written = await upsert(
          db, userId, habitId, e.date, stored, '', notes, { yielding });
        if (written) result.entriesImported++;
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
    [habitId, userId, date, value, status, String(notes ?? '').slice(0, LIMITS.notes)]
  );
  return rowCount > 0;
}
