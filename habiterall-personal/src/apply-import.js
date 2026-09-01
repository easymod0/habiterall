/**
 * SQLite writer for imported data (personal edition).
 *
 * Format parsing lives in shared/src/import.js; this module owns the
 * storage-specific half, so the shared parsers stay database-agnostic.
 */

import { db, UNSET, YES, SKIP, isCategoryNameConflict } from './db.js';
// Loop stores colours as a palette index, so imported habits need the same
// index -> hex mapping the parsers use.
import { entryValue, normaliseImportedHabit } from '@habiterall/shared/import.js';
import { assertDate, foldCategoryName, DEFAULT_COLOR, LIMITS } from '@habiterall/shared/validate.js';

/* ---------- statements ---------- */

const insertHabit = db.prepare(`
  INSERT INTO habits (name, description, type, unit, target_value, target_type,
                      freq_numerator, freq_denominator, color, reminder_time,
                      reminder_message, at_most_unlogged, show_as, icon, position,
                      archived, category_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
// A user's own categories, resolved by NAME (never by the stale id a backup
// carries — see `resolveOrCreateCategory` below) before any habit that names
// one is written.
const allCategories = db.prepare(
  `SELECT id, name, color FROM categories ORDER BY position, id`
);
// The third parameter is the file's own DECLARED position, or `null` when
// there isn't one (a habit-derived category, or a file that omitted it) —
// see `saneDeclaredPosition` below. `COALESCE` falls through to the old
// append behaviour in that case, and also when the account has no categories
// yet to take a MAX of.
const insertCategory = db.prepare(`
  INSERT INTO categories (name, color, position)
  VALUES (?, ?, COALESCE(?, (SELECT MAX(position) + 1 FROM categories), 0))
`);
const clearAllCategories = db.prepare(`DELETE FROM categories`);
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
// Postgres's `categories.position` column is an INTEGER; both editions should
// draw the same "absurd" line, so this bound applies here too even though
// SQLite itself would happily store a bigger number.
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
 *
 * @param {any[]} habits
 * @param {'merge'|'replace'} mode
 * @param {Array<{name: string, color: string, position?: number}>} categories
 *   the file's own categories, from `parseUpload`'s `categories` — `[]`
 *   (never `null`) for a format with nowhere to carry one, so the loop below
 *   has nothing to iterate. A habit's own `category` is a NAME, not this
 *   array's index, and is resolved against it below.
 */
export function applyImport(habits, mode = 'merge', categories = []) {
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
      // A replace means "make this account look like the file", and that
      // includes its categories — never a partial wipe that left a stray
      // category behind with nothing pointing at it.
      clearAllCategories.run();
    }

    // Preloaded with whatever the account already has — empty right after the
    // replace-mode wipe above, so the file's categories below always insert;
    // on a merge, whatever already exists by folded name is found here first.
    const categoryIdByFold = new Map(
      /** @type {any[]} */ (allCategories.all())
        .map((c) => [foldCategoryName(c.name), c.id])
    );

    // Folds claimed by THIS import's own declared-category loop below,
    // tracked separately from `categoryIdByFold` — which also holds whatever
    // the account already had before this import ran, and a fold matching
    // that is the merge rule working (issue #256's own headline case: an
    // İstanbul import resolving onto an account's pre-existing Istanbul
    // records no skip). What this set answers is the narrower question of
    // whether a SECOND category the file itself declares folds to a name a
    // FIRST one already claimed in the same file — information only the file
    // can lose, and only `result.skipped` says so.
    const declaredFoldsThisImport = new Set();

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
     * @param {boolean} [declared] true only for a call from the file's own
     *   declared-categories loop below, never for a habit's `category`
     *   field — a habit-derived name did not declare anything and must never
     *   report a collision, only resolve one. When true, a fold already
     *   claimed by an EARLIER declared category in this same file is
     *   recorded in `result.skipped` rather than silently absorbed, because
     *   that is information the file itself loses and nothing else says.
     * @returns {number | null}
     */
    function resolveOrCreateCategory(name, color, declaredPosition, declared = false) {
      const folded = foldCategoryName(name);
      if (!folded) return null;
      // The collision check has to run BEFORE the `categoryIdByFold.has`
      // early return just below — that map is exactly what answers this
      // fold once a PRIOR declared category has actually resolved it, so
      // checking after would report nothing for a second declared name that
      // collides with a first. `declaredFoldsThisImport` is populated only
      // on a path below that actually resolves or creates a row — never
      // here, unconditionally, which is what this used to do: it marked a
      // fold "claimed" even when the LIMITS check or a conflict just below
      // answered null and created nothing, so a file declaring two colliding
      // names against an account already at the ceiling had its first call
      // report "at most N are allowed" and its second call report "an
      // earlier category in this file already folds to the same name" —
      // naming a category that was never created.
      if (declared && declaredFoldsThisImport.has(folded)) {
        result.skipped.push(
          `category "${name}" not created: an earlier category in this ` +
          'file already folds to the same name');
      }
      if (categoryIdByFold.has(folded)) {
        if (declared) declaredFoldsThisImport.add(folded);
        return categoryIdByFold.get(folded);
      }
      if (categoryIdByFold.size >= LIMITS.categories) {
        result.skipped.push(
          `category "${name}" not created: at most ${LIMITS.categories} are allowed`);
        return null;
      }
      let info;
      try {
        info = insertCategory.run(name, color, saneDeclaredPosition(declaredPosition));
      } catch (err) {
        // The map above already covers an exact fold match; this is what
        // catches a name whose only difference from an existing category is
        // outside ASCII case, which SQLite's NOCASE backstop cannot fold the
        // way `foldCategoryName` does. Recorded as a skip rather than left to
        // throw: the whole import runs in one transaction (BEGIN, above in
        // applyImport), so an uncaught constraint violation here used to roll
        // back every habit and entry the file was ever going to add, not
        // only the category that collided.
        if (isCategoryNameConflict(err)) {
          result.skipped.push(
            `category "${name}" not created: a category with that name already exists`);
          return null;
        }
        throw err;
      }
      // node:sqlite may hand back a bigint; the column is a small integer.
      const id = Number(info.lastInsertRowid);
      categoryIdByFold.set(folded, id);
      if (declared) declaredFoldsThisImport.add(folded);
      return id;
    }

    // The file's own declared categories, each with its own colour — applied
    // before any habit, so a habit naming one of these below almost never has
    // to invent it. `parseUpload`'s `categories` already caps this at
    // LIMITS.categories and drops anything nameless; the cap above is the
    // backstop for a merge pushing the account's own total past it.
    for (const c of categories) resolveOrCreateCategory(c.name, c.color, c.position, true);

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
        // A merge matched by name touches nothing else about an existing
        // habit, so the category is resolved (and, if needed, created) only
        // for a habit actually being inserted — an existing one keeps
        // whatever category_id it already has. `''` is uncategorised and
        // resolves to null without touching the map at all.
        const categoryId = clean.category
          ? resolveOrCreateCategory(clean.category, DEFAULT_COLOR)
          : null;
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
          clean.archived ? 1 : 0,
          categoryId
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

