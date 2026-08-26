import express from 'express';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { db, UNSET, YES, SKIP, isCategoryNameConflict } from './db.js';
import {
  computeStats, summaryStats, computeStreaks, bestStreak, isCompleted, UNLOGGED_DEFAULT,
  unansweredCounts, today, addDays, daysBetween, MAX_RANGE_DAYS,
  computeCategoryStats, SCORE_WARMUP_DAYS, MAX_COMPARE_DAYS, COMPARE_WINDOW_DAYS,
  summariseByCategory,
} from '@habiterall/shared/stats.js';
import { computeAwards } from '@habiterall/shared/awards.js';

/** Lookback used for the dashboard's score/current-streak summary. */
const SUMMARY_WINDOW_DAYS = 400;

/**
 * How far back the dashboard's streak scan reads. Five years — far beyond
 * any streak a person will run, and it keeps the dashboard O(window) per
 * habit instead of O(lifetime). Matches the cloud edition.
 */
const STREAK_HISTORY_DAYS = 1830;
// Format sniffing and every parser live in shared: the two editions had
// separate copies of the sniffing, and they had drifted.
import { backupSettings, backupCategories, parseUpload } from '@habiterall/shared/import.js';
import { applyImport } from './apply-import.js';
import { deliveryStatus, sendTest } from './notifier.js';
import {
  parseHabit, parseEntry, parseSettings, portableSettings, entryWrite, assertDate,
  assertNotFuture, parseCategory, parseCategoryId, foldCategoryName, LIMITS,
  DATE_RE,
} from '@habiterall/shared/validate.js';
import {
  writeLoopDatabase, EXPORT_SKIPPED_HEADER, skipsForLog,
} from '@habiterall/shared/export-loop.js';
import { buildCsvArchive } from '@habiterall/shared/export-csv.js';
import {
  DEVICE_ZONE_HEADER, callerDay, reportedZone,
} from '@habiterall/shared/notify.js';
import { log } from '@habiterall/shared/log.js';

export const api = express.Router();

/**
 * Note which clock the caller's device is on, for `notifyTimezone: 'auto'`.
 *
 * On requests that already happen, so following your zone costs no extra
 * traffic — and written only when it CHANGES, which for a settled account is
 * never. Read back by the notifier through `resolveTimeZone`, and only for an
 * account that has not named a zone of its own.
 *
 * Never fatal. This is an optimisation of a default: a request must not fail
 * because the server could not write down where the user is.
 */
/** The last zone written, so an unchanged one costs not even a SELECT. */
let lastReportedZone = null;

api.use((req, res, next) => {
  // Say that the answer depends on it. `/overview` and `/stats` now derive
  // their window from this header, so two clients in different zones asking
  // the same URL want different bodies — and a response that does not admit
  // that is one a shared cache may hand to the wrong one. Set for every /api
  // response rather than at the three routes that read it: it is the honest
  // direction to be wrong in, and the alternative is remembering to add it to
  // the fourth.
  res.vary(DEVICE_ZONE_HEADER);

  const zone = reportedZone(req.get(DEVICE_ZONE_HEADER));
  if (zone && zone !== lastReportedZone) {
    try {
      if (zone !== String(q.deviceClock.get()?.time_zone ?? '')) {
        q.setDeviceClock.run(zone);
      }
      lastReportedZone = zone;
    } catch (err) {
      log.warn('settings.device_clock_not_stored', {}, err);
    }
  }
  next();
});

/**
 * What day it is for the client making this request.
 *
 * Every route that asks "is this today?" asks it of the CALLER, not of the
 * process. `today()` is the container's calendar day, which is UTC in both
 * compose files and therefore right for almost nobody: a user east of the
 * server had the current column of their own grid refused as a future date
 * for as many hours a day as the offset, and — because the same date clamps
 * the summary anchor — a day they did record was scored as of the server's
 * yesterday, so the streak sat still.
 *
 * Read from the header rather than from the stored zone, for the reason
 * `callerDay` states: this is a fact about one device, not about the account.
 */
const callerToday = (req) => callerDay(req.get(DEVICE_ZONE_HEADER));

/* ---------- statements ---------- */

const q = {
  deviceClock: db.prepare(`SELECT time_zone FROM device_clock WHERE id = 1`),
  setDeviceClock: db.prepare(`
    INSERT INTO device_clock (id, time_zone) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET time_zone = excluded.time_zone,
                                  at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `),
  allHabits: db.prepare(
    `SELECT * FROM habits WHERE archived = ? ORDER BY position, id`
  ),
  /**
   * Every habit, whatever its state — a query of its own rather than two calls
   * to `allHabits` concatenated, which is the same rows at twice the work and
   * in an order neither statement promises.
   *
   * `GET /categories/stats` is its only caller and needs the archived ones:
   * `computeCategoryStats` reports `archivedExcluded` from the members it is
   * handed, so a route that filtered them out in SQL would make that figure
   * permanently 0 and leave the comparison view with nothing to say about what
   * it left out.
   */
  everyHabit: db.prepare(`SELECT * FROM habits ORDER BY position, id`),
  habitById: db.prepare(`SELECT * FROM habits WHERE id = ?`),
  insertHabit: db.prepare(`
    INSERT INTO habits (name, description, type, unit, target_value, target_type,
                        freq_numerator, freq_denominator, color, reminder_time,
                        reminder_message, at_most_unlogged, show_as, icon,
                        category_id, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            COALESCE((SELECT MAX(position) + 1 FROM habits), 0))
  `),
  updateHabit: db.prepare(`
    UPDATE habits SET name = ?, description = ?, type = ?, unit = ?,
      target_value = ?, target_type = ?, freq_numerator = ?,
      freq_denominator = ?, color = ?, reminder_time = ?, reminder_message = ?,
      at_most_unlogged = ?, show_as = ?, icon = ?, category_id = ?, archived = ?
    WHERE id = ?
  `),
  deleteHabit: db.prepare(`DELETE FROM habits WHERE id = ?`),
  setPosition: db.prepare(`UPDATE habits SET position = ? WHERE id = ?`),
  // Categories: a user's own habit groupings, never seeded — see db.js.
  allCategories: db.prepare(`SELECT * FROM categories ORDER BY position, id`),
  categoryById: db.prepare(`SELECT * FROM categories WHERE id = ?`),
  // Folded in JS (foldCategoryName), not in SQL: the same rule has to answer
  // identically in the cloud edition's Postgres, so one function decides it
  // for both rather than two different COLLATE/lower() expressions agreeing
  // by coincidence. This reads every category and filters here, which is fine
  // at LIMITS.categories's ceiling of 30 rows.
  categoriesForFold: db.prepare(`SELECT id, name FROM categories`),
  insertCategory: db.prepare(`
    INSERT INTO categories (name, color, position)
    VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM categories), 0))
  `),
  updateCategory: db.prepare(`UPDATE categories SET name = ?, color = ? WHERE id = ?`),
  deleteCategory: db.prepare(`DELETE FROM categories WHERE id = ?`),
  setCategoryPosition: db.prepare(`UPDATE categories SET position = ? WHERE id = ?`),
  countCategories: db.prepare(`SELECT COUNT(*) AS n FROM categories`),
  // `status` is carried alongside `value` rather than folded into it: a
  // numerical habit may legitimately record 3, which must never be mistaken
  // for the SKIP sentinel.
  entriesFor: db.prepare(`
    SELECT date, value, status, notes
    FROM entries WHERE habit_id = ? ORDER BY date
  `),
  /**
   * Lifetime completion count, done in SQLite instead of by walking every
   * row in JS. The CASE mirrors `isCompleted` exactly — a skip is never a
   * completion, whatever its value.
   */
  countCompleted: db.prepare(`
    SELECT COUNT(*) AS n FROM entries
     WHERE habit_id = ?
       AND COALESCE(status, '') <> 'skip'
       AND CASE
             WHEN ? = 'boolean'  THEN value = 2
             WHEN ? = 'at_most'  THEN value <= ?
             ELSE value >= ?
           END
  `),
  entriesInRange: db.prepare(`
    SELECT habit_id, date, value, status
    FROM entries WHERE date >= ? AND date <= ? ORDER BY date
  `),
  /**
   * Every habit's LIFETIME earliest entry, grouped in SQLite — one query, not
   * one per habit, and it reads the `(habit_id, date)` primary key rather than
   * any row.
   *
   * `GET /categories/stats` fetches entries from a bounded window, so a habit
   * last logged before that window comes back with none — and a member with no
   * entries in hand is indistinguishable from one that has never been logged,
   * which is the difference between an abandoned habit dragging its category
   * down and one that has no strength to average in at all. This answers the
   * question the fetched slice cannot.
   */
  firstEntryPerHabit: db.prepare(`
    SELECT habit_id, MIN(date) AS first_date FROM entries GROUP BY habit_id
  `),
  entriesForSince: db.prepare(`
    SELECT date, value, status, notes
    FROM entries WHERE habit_id = ? AND date >= ? ORDER BY date
  `),
  upsertEntry: db.prepare(`
    INSERT INTO entries (habit_id, date, value, status, notes) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(habit_id, date) DO UPDATE SET value = excluded.value,
                                              status = excluded.status,
                                              notes = excluded.notes
  `),
  deleteEntry: db.prepare(`DELETE FROM entries WHERE habit_id = ? AND date = ?`),
  allSettings: db.prepare(`SELECT key, value FROM settings`),
  putSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  clearSettings: db.prepare(`DELETE FROM settings`),
};

/* ---------- validation ---------- */

// Habit and entry rules live in @habiterall/shared/validate.js so both
// editions enforce exactly the same limits. SQLite has no boolean type, so
// `archived` is mapped to 0/1 at the call sites below.

/** Shared validation, with `archived` mapped to SQLite's 0/1. */
function habitRow(body) {
  const h = parseHabit(body);
  return { ...h, archived: h.archived ? 1 : 0 };
}

/**
 * A habit row on its way OUT to a client.
 *
 * SQLite has no boolean type, so `archived` comes back as 0 or 1 while the
 * cloud edition's Postgres BOOLEAN returns true/false — the same endpoint
 * describing the same habit with two different JSON types. The web UI happens
 * to survive it (0 and false are both falsy), but the native Android client
 * declares `archived: Boolean` and refuses to deserialise:
 *
 *   Expected valid boolean literal prefix, but had '0'
 *
 * The API contract is a boolean. Convert here, at the single boundary, rather
 * than teaching every client to accept both.
 */
function toApiHabit(row) {
  if (!row) return row;
  return { ...row, archived: Boolean(row.archived) };
}

/**
 * An Error carrying the HTTP status the API should return.
 * @param {number} status
 * @param {string} message
 * @returns {Error & {status: number}}
 */
function httpError(status, message) {
  const err = /** @type {Error & {status: number}} */ (new Error(message));
  err.status = status;
  return err;
}

/**
 * Resolve an already-parsed habit's `category_id` into something safe to
 * store. `parseHabit` has already decided the SHAPE — a positive safe
 * integer or `null`, with anything malformed (a string, a float, 0, a
 * negative id, `true`, a crafted `'__proto__'`) folded to `null` and no 400 —
 * so this only decides EXISTENCE, which is a database question the shared
 * validator has no connection to answer.
 *
 * A null/absent id passes straight through as the stated clear it is. A
 * present id that names nothing is a 400: storing it anyway would leave a
 * habit pointing at a category that was never created, and `ON DELETE SET
 * NULL` would have nothing to ever fire on.
 *
 * @param {{category_id?: number | null}} body - the output of `parseHabit`
 * @returns {number | null}
 */
function resolveCategoryId(body) {
  const id = body.category_id ?? null;
  if (id === null) return null;
  if (!q.categoryById.get(id)) throw httpError(400, 'category not found');
  return id;
}

/**
 * node:sqlite returns loosely-typed rows; this is the one place we assert the
 * shape our own schema guarantees.
 * @param {unknown} row
 * @returns {import('@habiterall/shared/types.js').Habit}
 */
const asHabit = (row) => /** @type {any} */ (row);

/* ---------- habits ---------- */

api.get('/habits', (req, res) => {
  const archived = req.query.archived === 'true' ? 1 : 0;
  res.json(q.allHabits.all(archived).map(toApiHabit));
});

api.post('/habits', (req, res) => {
  const h = habitRow(req.body);
  const categoryId = resolveCategoryId(h);
  const info = q.insertHabit.run(
    h.name, h.description, h.type, h.unit, h.target_value,
    h.target_type, h.freq_numerator, h.freq_denominator, h.color, h.reminder_time,
    h.reminder_message, h.at_most_unlogged, h.show_as, h.icon, categoryId
  );
  res.status(201).json(toApiHabit(q.habitById.get(info.lastInsertRowid)));
});

api.get('/habits/:id', (req, res) => {
  const habit = asHabit(q.habitById.get(Number(req.params.id)));
  if (!habit) throw httpError(404, 'habit not found');
  res.json(toApiHabit(habit));
});

api.put('/habits/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!q.habitById.get(id)) throw httpError(404, 'habit not found');

  const h = habitRow(req.body);
  const categoryId = resolveCategoryId(h);
  q.updateHabit.run(
    h.name, h.description, h.type, h.unit, h.target_value, h.target_type,
    h.freq_numerator, h.freq_denominator, h.color, h.reminder_time,
    h.reminder_message, h.at_most_unlogged, h.show_as, h.icon, categoryId,
    h.archived, id
  );
  res.json(toApiHabit(q.habitById.get(id)));
});

api.delete('/habits/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!q.habitById.get(id)) throw httpError(404, 'habit not found');
  q.deleteHabit.run(id);
  res.status(204).end();
});

/**
 * Ceiling on a reorder request.
 *
 * The array length was unvalidated and drove one UPDATE per element inside a
 * transaction, so a 1MB body — roughly 500,000 ids — could hold the database
 * for minutes. Duplicates pass validation too, so no habits even had to
 * exist. This edition has no rate limiter, which makes the bound matter more
 * here than in cloud, not less.
 */
const MAX_REORDER_IDS = 1000;

api.post('/habits/reorder', (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order)) throw httpError(400, 'order must be an array of habit ids');
  if (order.length > MAX_REORDER_IDS) {
    throw httpError(400, `order may not exceed ${MAX_REORDER_IDS} ids`);
  }
  if (order.some((n) => !Number.isFinite(Number(n)))) {
    throw httpError(400, 'order must contain only habit ids');
  }
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    order.forEach((id, i) => q.setPosition.run(i, Number(id)));
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  res.json(q.allHabits.all(0).map(toApiHabit));
});

/* ---------- categories ---------- */

/**
 * A category id from the URL. The SHAPE check has to run before EXISTENCE —
 * see the ordering comment above the two routes below — or a non-numeric id
 * and one that is merely absent answer identically: `Number('abc')` is `NaN`,
 * which matches no row and used to fall straight through to the same 404 a
 * real, missing id gets.
 *
 * The shape itself is `parseCategoryId` (shared/src/validate.js), which cloud
 * asks too — the rule was written out in both editions, which is one rule in
 * two places even when the two copies agree.
 *
 * @param {import('express').Request} req
 * @returns {number}
 */
function categoryId(req) {
  const id = parseCategoryId(req.params.id);
  if (id === null) throw httpError(400, 'invalid category id');
  return id;
}

/**
 * Whether NAME already names a category other than EXCLUDE_ID.
 *
 * Folded through `foldCategoryName` — the one shared rule, so this and the
 * cloud edition's `lower()`-based Postgres check agree on 'Élan' vs 'élan'
 * rather than each drawing its own line. `LIMITS.categories` keeps this a
 * scan of at most 30 rows, so there is no reason to push it into SQL.
 *
 * @param {string} name
 * @param {number | null} excludeId
 * @returns {boolean}
 */
function categoryNameTaken(name, excludeId) {
  const folded = foldCategoryName(name);
  return /** @type {any[]} */ (q.categoriesForFold.all())
    .some((c) => c.id !== excludeId && foldCategoryName(c.name) === folded);
}

api.get('/categories', (req, res) => {
  res.json(q.allCategories.all());
});

/**
 * Which of this account's categories is holding up, over one window.
 *
 * The arithmetic is `computeCategoryStats` (shared/src/stats.js) and every word
 * about what it means is there. This route's whole job is the three things a
 * pure function cannot do for itself, and each of them is a way the figures go
 * quietly wrong rather than loudly:
 *
 *   1. Hand it EVERY habit, archived included. Filtering here makes
 *      `archivedExcluded` permanently 0 — see `q.everyHabit`.
 *   2. Supply each member's lifetime `firstEntry` — see `q.firstEntryPerHabit`.
 *   3. Read the entries in ONE pass. `WHERE habit_id = ?` inside the loop is
 *      the shape that took 13.5 seconds in the importer (`shared/CLAUDE.md`),
 *      and this route runs it against however many habits the account has.
 *
 * Registered ABOVE the `/categories/:id` routes, and a `GET /categories/:id`
 * added later must go below this line: `parseCategoryId('stats')` is null, so a
 * pattern route reaching this path first answers 400 for a URL that is not an
 * id at all.
 */
api.get('/categories/stats', (req, res) => {
  // The three bounds `/habits/:id/stats` states, in the same order and for the
  // same reason: never compute past the CALLER's today, never backwards, and
  // never more than a ceiling, because every pass below allocates one element
  // per day. The ceiling itself is NOT that route's — see `MAX_COMPARE_DAYS`.
  // That route walks one habit; this one walks every habit the account has, so
  // the same span costs the habit count times as much.
  const now = callerToday(req);
  const requestedEnd = DATE_RE.test(req.query.end ?? '') ? req.query.end : now;
  const end = requestedEnd > now ? now : requestedEnd;

  const requestedStart = DATE_RE.test(req.query.start ?? '') ? req.query.start : undefined;
  if (requestedStart) {
    if (requestedStart > end) throw httpError(400, 'start must not be after end');
    if (daysBetween(requestedStart, end) > MAX_COMPARE_DAYS) {
      throw httpError(400, `range must not exceed ${MAX_COMPARE_DAYS} days`);
    }
  }

  // A caller that named no start gets a YEAR, not the ceiling: the simplest
  // possible request must not be the most expensive one this route can answer,
  // and five years is available to anyone who asks for it. Derived from `end`
  // rather than read back from the earliest stored entry — a date out of the
  // database is attacker-controlled (root CLAUDE.md), and it is the wrong
  // question here anyway, since a comparison has as many first entries as it
  // has members.
  const start = requestedStart ?? addDays(end, -COMPARE_WINDOW_DAYS);

  const granularity = req.query.granularity ?? 'day';

  const habits = /** @type {any[]} */ (q.everyHabit.all());

  const firstEntry = new Map(
    /** @type {any[]} */ (q.firstEntryPerHabit.all())
      .map((r) => [r.habit_id, /** @type {string} */ (r.first_date)])
  );

  // One SELECT over `entries`, bucketed by habit — the same shape `/overview`
  // uses, for the same reason. The warm-up start is DERIVED from the window,
  // never from a stored date, and the range it opens is bounded by the clamp
  // above plus the fixed 400 days.
  const rows = q.entriesInRange.all(addDays(start, -SCORE_WARMUP_DAYS), end);
  const byHabit = new Map(habits.map((h) => [h.id, []]));
  for (const r of rows) {
    const bucket = byHabit.get(r.habit_id);
    if (!bucket) continue;
    bucket.push(r);
  }

  // Read once for the whole payload rather than per habit, exactly as
  // `/overview` reads `unlogged`: they are one answer for the account, and the
  // map below runs once per habit.
  const unlogged = storedUnlogged();
  const weekStart = storedWeekStart();

  res.json(computeCategoryStats(
    /** @type {any} */ (q.allCategories.all()),
    habits.map((h) => ({
      habit: asHabit(h),
      entries: /** @type {any} */ (byHabit.get(h.id) ?? []),
      // `?? null`, and never left absent: an omitted key tells
      // `computeCategoryStats` to derive the answer from the entries it was
      // given, which is the truncated slice this route deliberately fetched.
      firstEntry: firstEntry.get(h.id) ?? null,
    })),
    { start, end, granularity, weekStart, unlogged }
  ));
});

/**
 * The order every category route below follows, and the reason it is
 * written down rather than left to be re-derived per route: SHAPE (a
 * positive integer id, else 400) before EXISTENCE (else 404) before the BODY
 * through `parseCategory` (else its own 400) before the DUPLICATE name (else
 * 409). Cloud's `PUT /categories/:id` used to parse the body before checking
 * existence; this is the order both editions now share, so add a route here
 * later in that same sequence rather than inventing a new one.
 */
api.post('/categories', (req, res) => {
  const c = parseCategory(req.body);
  if (categoryNameTaken(c.name, null)) throw httpError(409, 'category already exists');
  if (/** @type {any} */ (q.countCategories.get()).n >= LIMITS.categories) {
    throw httpError(400, `at most ${LIMITS.categories} categories are allowed`);
  }
  let info;
  try {
    info = q.insertCategory.run(c.name, c.color);
  } catch (err) {
    // The route's own check above covers the ordinary path; this is what
    // catches a fold that disagrees with SQLite's ASCII-only NOCASE backstop,
    // or a genuine race between two requests, rather than surfacing the
    // constraint violation as an unexplained 500.
    if (isCategoryNameConflict(err)) throw httpError(409, 'category already exists');
    throw err;
  }
  res.status(201).json(q.categoryById.get(info.lastInsertRowid));
});

api.put('/categories/:id', (req, res) => {
  const id = categoryId(req);
  if (!q.categoryById.get(id)) throw httpError(404, 'category not found');

  const c = parseCategory(req.body);
  if (categoryNameTaken(c.name, id)) throw httpError(409, 'category already exists');
  try {
    q.updateCategory.run(c.name, c.color, id);
  } catch (err) {
    if (isCategoryNameConflict(err)) throw httpError(409, 'category already exists');
    throw err;
  }
  res.json(q.categoryById.get(id));
});

api.delete('/categories/:id', (req, res) => {
  const id = categoryId(req);
  if (!q.categoryById.get(id)) throw httpError(404, 'category not found');
  // ON DELETE SET NULL, never CASCADE (db.js): this is tidying up a label,
  // not a request to destroy every habit that wore it. Its habits, and every
  // entry on them, survive — uncategorised.
  q.deleteCategory.run(id);
  res.status(204).end();
});

api.post('/categories/reorder', (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order)) throw httpError(400, 'order must be an array of category ids');
  if (order.length > LIMITS.categories) {
    throw httpError(400, `order may not exceed ${LIMITS.categories} ids`);
  }
  // `parseCategoryId`, the same rule `categoryId` above asks of the URL — not
  // `isFinite(Number(n))`, which accepted `1.5` here and 400'd it in cloud, and
  // not `Number.isInteger(Number(n))` either, which answers YES to `null`,
  // `''` and `[]` (all 0) and to `true` (1). Every one of those reached
  // `setCategoryPosition` as an id nobody named: 0 matches no row and reports
  // 200 having moved nothing, and 1 moves whichever category happens to be
  // id 1. A reorder that reports success and applies to something the caller
  // did not name is the failure a client cannot see, which is what this check
  // was added for in the first place.
  const ids = order.map((n) => parseCategoryId(n));
  if (ids.some((id) => id === null)) {
    throw httpError(400, 'order must contain only category ids');
  }
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    ids.forEach((id, i) => q.setCategoryPosition.run(i, id));
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  res.json(q.allCategories.all());
});

/* ---------- entries ---------- */

api.get('/habits/:id/entries', (req, res) => {
  const id = Number(req.params.id);
  if (!q.habitById.get(id)) throw httpError(404, 'habit not found');
  res.json(q.entriesFor.all(id));
});

api.put('/habits/:id/entries/:date', (req, res) => {
  const id = Number(req.params.id);
  const date = req.params.date;
  const habit = asHabit(q.habitById.get(id));

  if (!habit) throw httpError(404, 'habit not found');
  assertDate(date);
  assertNotFuture(date, callerToday(req));

  const parsed = parseEntry(habit, req.body, { UNSET, YES, SKIP });

  // The rule — a skip is out of band, and every other write is a ROW, including
  // value 0, which is the answer "no" — lives in shared/validate.js, because the
  // other edition and the Discord button handler have to apply exactly the same
  // one. Clearing a day is the DELETE route below, not a PUT of zero.
  const write = entryWrite(habit, parsed, { UNSET, SKIP });

  if (write.op === 'delete') q.deleteEntry.run(id, date);
  else q.upsertEntry.run(id, date, write.value, write.status, write.notes);

  res.json({ habit_id: id, date, ...write.reply });
});

api.delete('/habits/:id/entries/:date', (req, res) => {
  const id = Number(req.params.id);
  if (!q.habitById.get(id)) throw httpError(404, 'habit not found');
  if (!DATE_RE.test(req.params.date)) throw httpError(400, 'date must be YYYY-MM-DD');

  q.deleteEntry.run(id, req.params.date);
  res.status(204).end();
});

/* ---------- stats ---------- */

api.get('/habits/:id/stats', (req, res) => {
  const id = Number(req.params.id);
  const habit = asHabit(q.habitById.get(id));
  if (!habit) throw httpError(404, 'habit not found');

  // Never compute past today, and never span more than MAX_RANGE_DAYS: the
  // stats passes allocate one element per day, so an unbounded range is a
  // trivial denial of service.
  const now = callerToday(req);
  const requestedEnd = DATE_RE.test(req.query.end ?? '') ? req.query.end : now;
  const end = requestedEnd > now ? now : requestedEnd;

  let start = DATE_RE.test(req.query.start ?? '') ? req.query.start : undefined;
  if (start) {
    if (start > end) throw httpError(400, 'start must not be after end');
    if (daysBetween(start, end) > MAX_RANGE_DAYS) {
      throw httpError(400, `range must not exceed ${MAX_RANGE_DAYS} days`);
    }
  }

  const granularity = req.query.granularity ?? 'day';

  const entries = /** @type {any} */ (q.entriesFor.all(id));
  const unlogged = storedUnlogged();
  const skipDays = storedSkipDays();
  const stats = computeStats(habit, entries,
    { start, end, granularity, weekStart: storedWeekStart(), unlogged });

  // Awards are a reading of the figures above and are computed HERE rather
  // than inside `computeStats`, because this is `computeStats`'s only caller
  // now — `/overview` calls `summaryStats` for two numbers instead, and never
  // sees an awards field to decline. Same reason, same place, in both
  // editions — see the awards section of the root CLAUDE.md.
  //
  // `habit` and `unlogged` are the SAME pair `computeStats` was given: awards
  // read them for one gate, and a different answer there than here would
  // withhold a card whose figures say the opposite. `skipDays` is a third
  // input of the same kind — it gates the rest award — and `computeStats` is
  // not given it because the arithmetic has no opinion about it: a stored skip
  // bridges a run whether or not this account can record a new one.
  res.json({
    // `unlogged_is_success` says whether a day with no row at all already
    // counts as kept on this habit — resolved HERE, from the same account
    // setting and habit override `unansweredCounts` already reads for the
    // figures above, because `shared/src` is not served to the browser and no
    // renderer can call `unansweredCounts` itself. Derived, not stored: it
    // goes into no migration and no `*_HABIT_FIELDS` list.
    habit: { ...habit, unlogged_is_success: unansweredCounts(habit, unlogged) },
    ...stats,
    awards: computeAwards(stats, end, habit, unlogged, skipDays),
  });
});

/**
 * The main grid: every active habit plus its entries for the last N days,
 * in one round trip so the dashboard renders without a request per habit.
 */
api.get('/overview', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

  // The dashboard can page back through history, so it asks for the window it
  // is actually showing. Without this the grid rendered empty cells for any
  // day outside the most recent fortnight — the entries were never fetched.
  const now = callerToday(req);
  const requestedEnd = DATE_RE.test(req.query.end ?? '') ? req.query.end : now;
  const end = requestedEnd > now ? now : requestedEnd;
  const start = addDays(end, -(days - 1));

  // ...and `end` decides the GRID window only. The row summary — strength,
  // current streak, best streak — is a statement about the habit now, so it is
  // anchored on today whatever window is on screen. They shared one date, and
  // paging back a month restated the summary as of that month: "43%" with
  // nothing on the row to say it was not today's. The detail view is the
  // surface that answers "as of when", and it has its own range controls.
  const summaryEnd = now;

  // Archived habits are hidden by default but can be requested explicitly.
  const archived = req.query.archived === 'true';
  const habits = /** @type {any[]} */ (archived ? q.allHabits.all(1) : q.allHabits.all(0));
  const rows = q.entriesInRange.all(start, end);

  // Read once for the whole payload rather than per habit: it is one answer
  // for the account, and this loop already runs once per habit on the
  // dashboard's hot path.
  const unlogged = storedUnlogged();

  // The grouped lifetime `MIN(date)` read `/categories/stats` already runs
  // (`q.firstEntryPerHabit`), reused here so a section header can tell "never
  // logged" from "scored zero" — the bounded windows below cannot answer that,
  // and `first_date` is used for a null check only, never `addDays` or
  // `dateRange` (root CLAUDE.md). Skipped entirely in archived mode: that
  // fetch has nothing active to average, so `categorySummaries` is omitted
  // below rather than computed and discarded.
  const firstEntry = archived ? null : new Map(
    /** @type {any[]} */ (q.firstEntryPerHabit.all())
      .map((r) => [r.habit_id, /** @type {string} */ (r.first_date)])
  );

  // For the grid the frontend only needs something paintable, so skips are
  // flattened onto the SKIP wire value here. Scoring never uses this map.
  // `skips` lists the skipped dates separately, so a numerical habit that
  // legitimately recorded 3 is never mistaken for a skipped day.
  const byHabit = new Map(habits.map((h) => [h.id, {}]));
  const skipsByHabit = new Map(habits.map((h) => [h.id, []]));
  for (const r of rows) {
    const bucket = byHabit.get(r.habit_id);
    if (!bucket) continue;
    if (r.status === 'skip') {
      bucket[/** @type {string} */ (r.date)] = SKIP;
      skipsByHabit.get(r.habit_id).push(/** @type {string} */ (r.date));
    } else {
      bucket[/** @type {string} */ (r.date)] = r.value;
    }
  }

  // One extra SELECT, read once for the whole payload for the same reason
  // `unlogged` is above: the dashboard groups by category behind
  // `groupByCategory`, and every habit on the page needs the same list.
  const categories = /** @type {any[]} */ (q.allCategories.all());

  const habitPayloads = habits.map((h) => {
    // The dashboard summary only needs a bounded lookback: with a 30-day
    // half-life the score has long since converged, and streaks that matter
    // here are recent. This keeps the dashboard O(window) rather than
    // O(lifetime) per habit.
    // Bounded, not lifetime. Reading every entry per habit made the
    // dashboard O(lifetime x habits) and, worse, fed an unbounded array
    // into computeStreaks — hundreds of thousands of iterations of
    // synchronous work on a single-threaded server.
    //
    // Both lookbacks count back from `summaryEnd`, not from the grid's
    // `end`: these three figures describe the habit today.
    const entries = /** @type {any} */ (
      q.entriesForSince.all(h.id, addDays(summaryEnd, -STREAK_HISTORY_DAYS))
    );
    const windowed = /** @type {any} */ (
      q.entriesForSince.all(h.id, addDays(summaryEnd, -SUMMARY_WINDOW_DAYS))
    );
    // Two numbers are read below — `score` and `currentStreak` — so this
    // calls `summaryStats` rather than `computeStats`: the same window and
    // the same two passes (`computeScores`, `computeStreaks`), with the five
    // passes `computeStats` also runs — `computeHistory`, `computeWeekdays`,
    // `computeWeekdayByMonth`, `computeFrequency`, `computeResilience` — never
    // started, once per habit, on the dashboard's hot path. Awards are out of
    // this route for the same reason, stated at the `/stats` call site above.
    const stats = summaryStats(h, windowed, { end: summaryEnd, unlogged });

    // Counted in SQLite rather than by walking every row in JS. The
    // expression mirrors isCompleted exactly, including that a skip is
    // "not applicable" and never a completion — passing `e.value` instead
    // of the whole row is what made this edition count skips as done on
    // at_most habits while cloud did not.
    const totalCompleted = /** @type {any} */ (
      q.countCompleted.get(
        h.id, h.type, h.target_type, h.target_value, h.target_value
      )
    ).n;

    const allStreaks = computeStreaks(
      h,
      new Map(entries.map((e) => [e.date, { value: e.value, status: e.status }])),
      entries.length ? entries[0].date : summaryEnd,
      summaryEnd,
      unlogged
    );

    return {
      ...toApiHabit(h),
      entries: byHabit.get(h.id) ?? {},
      skips: skipsByHabit.get(h.id) ?? [],
      score: stats.score,
      currentStreak: stats.currentStreak,
      bestStreak: bestStreak(allStreaks),
      totalCompleted,
      // Same field, same reason as the `/stats` call site above: resolved
      // server-side because no renderer can import `unansweredCounts`, and
      // derived rather than stored.
      unlogged_is_success: unansweredCounts(h, unlogged),
    };
  });

  // The mean is over `habitPayloads`' own `score` — the same number drawn on
  // the row beneath each header — never a second scoring pass. See
  // `summariseByCategory` (`@habiterall/shared/stats.js`) for the partition
  // rule — the same one the grouped dashboard makes (`dashboard.js`) and
  // `computeCategoryStats` makes.
  const categorySummaries = archived
    ? undefined
    : summariseByCategory(categories, habitPayloads, firstEntry);

  res.json({
    start,
    end,
    categories,
    habits: habitPayloads,
    ...(categorySummaries ? { categorySummaries } : {}),
  });
});

/** One stored setting, decoded, or null if it is absent or unreadable. */
function storedSetting(key) {
  const row = q.allSettings.all().find((r) => r.key === key);
  try {
    return row ? JSON.parse(String(row.value)) : null;
  } catch {
    return null;
  }
}

/** The user's week-start preference, defaulting to ISO (Monday). */
function storedWeekStart() {
  return storedSetting('weekStart') === 'sunday' ? 'sunday' : 'monday';
}

/**
 * What a day with no row counts as on an at-most habit.
 *
 * Read here and handed to `computeStats` rather than looked up inside it: the
 * shared code takes no database, which is the whole reason it can serve both
 * editions. Anything but the stored word is the default, exactly as
 * `storedWeekStart` treats its own.
 */
function storedUnlogged() {
  return storedSetting('atMostUnlogged') === 'success' ? 'success' : UNLOGGED_DEFAULT;
}

/**
 * Whether this account records skipped days at all.
 *
 * Loop's own default is off and so is ours, which is why the strict `=== true`:
 * anything but the stored boolean is the default, exactly as the two above
 * treat theirs. Read for the awards gate only — nothing in `computeStats`
 * consults it, because a skip already stored bridges a run whatever the setting
 * says today.
 */
function storedSkipDays() {
  return storedSetting('skipDays') === true;
}

/* ---------- settings ---------- */

/**
 * Preferences live server-side so they survive a browser reset and are
 * captured by the same backup as the habits. Values are stored as JSON text
 * because SQLite has no boolean.
 */
function readSettings() {
  const out = {};
  for (const { key, value } of q.allSettings.all()) {
    // node:sqlite returns loosely-typed columns; both are TEXT by schema.
    try { out[String(key)] = JSON.parse(String(value)); }
    catch { /* skip a corrupt row rather than fail the whole request */ }
  }
  return out;
}

api.get('/settings', (req, res) => {
  res.json(readSettings());
});

/** Merge a patch. Unknown or invalid keys are dropped, not rejected. */
api.put('/settings', (req, res) => {
  const { accepted, rejected } = parseSettings(req.body);
  for (const [key, value] of Object.entries(accepted)) {
    q.putSetting.run(key, JSON.stringify(value));
  }
  res.json({ settings: accepted, ignored: rejected });
});

api.delete('/settings', (req, res) => {
  q.clearSettings.run();
  res.json({});
});

/* ---------- notifications ---------- */

/**
 * Post a test message to every configured server-delivered destination.
 *
 * Without this a wrong webhook URL is only discoverable by waiting for a
 * reminder that never arrives and then reading the server log. The reply
 * carries each channel's own outcome, because "it failed" is not useful when
 * two destinations are configured.
 */
api.post('/notify/test', (req, res, next) => {
  sendTest()
    .then((results) => res.json({ results }))
    .catch(next);
});

/**
 * How each destination last behaved.
 *
 * The test button above is the other half of this and has one flaw: it has to
 * be PRESSED, and nothing suggests pressing it. A webhook deleted in April
 * stops the reminders while the habit, its time and the destination toggle all
 * go on looking correct — so this reports what the notifier already learned at
 * 08:00, and the settings dialog shows it without being asked.
 *
 * Only the last outcome per channel, and only for channels something has
 * actually been attempted for. It is deliberately NOT a statement about
 * configuration: `channelConfigured` stays the authority on whether a
 * destination can deliver, and this says only whether it did.
 */
api.get('/notify/status', (req, res) => {
  res.json({ channels: deliveryStatus() });
});

/* ---------- export / import ---------- */

api.get('/export', (req, res) => {
  const habits = q.allHabits.all(0).concat(q.allHabits.all(1));
  // The backup carries a category by NAME, not by id: an id is meaningless
  // once restored somewhere else (or nowhere, on a Loop round trip), and a
  // name is what `normaliseImportedHabit` and `backupCategories` (import.js)
  // already agree the wire format is.
  // Read once and used twice below — the habit-by-habit name lookup and the
  // top-level list are two views of the same rows, and this handler asked for
  // them separately.
  const categories = /** @type {any[]} */ (q.allCategories.all());
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
  const payload = {
    version: 1,
    app: 'habiterall',
    exported_at: new Date().toISOString(),
    habits: habits.map((h) => ({
      ...toApiHabit(h),
      category: categoryNames.get(h.category_id) ?? '',
      entries: q.entriesFor.all(h.id),
    })),
    // A user's own categories, so a backup can recreate them by name rather
    // than by an id that means nothing once restored — see apply-import.js.
    categories: categories
      .map((c) => ({ name: c.name, color: c.color, position: c.position })),
    // Preferences travel with the data. They are the account, not the device —
    // and two of them (skipDays, questionMarks) now decide what the same rows
    // MEAN, so a backup that dropped them restored a history the app then read
    // differently. Only a replace-mode import applies them; see the route.
    //
    // `portableSettings`, not the whole table: a backup is a file people email
    // to themselves, and `discordWebhook` is a bearer capability for a channel.
    settings: portableSettings(readSettings()),
  };

  if (req.query.download === 'true') {
    const stamp = today();
    res.setHeader('Content-Disposition',
      `attachment; filename="habiterall-backup-${stamp}.json"`);
  }
  res.json(payload);
});

/**
 * Export as a zip of Habits.csv + Checkmarks.csv, the same shape Loop
 * produces. Both files are needed: Checkmarks.csv alone has no habit types,
 * so a measurable habit's 3 would be read back as Loop's SKIP sentinel.
 *
 * The route keeps its `.csv` name for existing bookmarks; the payload is a zip.
 */
api.get('/export.csv', (req, res) => {
  const habits = q.allHabits.all(0).concat(q.allHabits.all(1));
  // `buildHabitsCsv` reads `h.category` by NAME, the same as `/export`
  // above — a raw habit row only carries `category_id`, which means nothing
  // once restored elsewhere (or nowhere, on a Loop round trip).
  const categoryNames = new Map(
    /** @type {any[]} */ (q.allCategories.all()).map((c) => [c.id, c.name])
  );
  const withCategory = habits.map((h) => ({
    ...h, category: categoryNames.get(h.category_id) ?? '',
  }));
  const body = buildCsvArchive(withCategory, (id) => q.entriesFor.all(id));

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename="habiterall-csv-${today()}.zip"`);
  res.send(body);
});

/**
 * Export everything as a Loop Habit Tracker .db backup, so the data can be
 * restored into the Loop Android app.
 *
 * A row Loop cannot carry is left out rather than taking the request down with
 * it, and `writeLoopDatabase` says which. Both surfaces are here because
 * neither reaches everybody: the header is for a client that made the request
 * itself — curl or devtools — and the log is for the one that did not, since
 * the browser downloads this through an `<a download>`, which reads no headers.
 *
 * Not `Api.kt`, despite the shape of that sentence: the Android client makes no
 * export request at all, and its one response accessor keeps a status and a
 * body and no headers. If it ever does export, this is where its surface has to
 * be reconsidered rather than assumed.
 *
 * SQLite makes this edition the EASIER one to reach — `2026-02-30` is stored as
 * the string it was given, so an import writer checking only the shape of a
 * date left the row sitting there. But cloud is reachable too, which is why the
 * same code is there and not merely for symmetry: Postgres accepts any year
 * 1–99 as a DATE, `to_char` hands back `0050-03-15`, and that is a date this
 * exporter cannot encode either.
 */
api.get('/export-loop.db', (req, res, next) => {
  const habits = q.allHabits.all(0).concat(q.allHabits.all(1));
  // A random name, matching the cloud edition: a predictable one in a shared
  // /tmp is a file another local user can wait for, and this one holds every
  // habit and entry.
  const path = join(tmpdir(), `habiterall-loop-${randomUUID()}.db`);

  writeLoopDatabase(path, habits, (id) => q.entriesFor.all(id))
    .then(({ skipped }) => {
      const body = readFileSync(path);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition',
        `attachment; filename="Loop Habits Backup ${today()}.db"`);
      if (skipped.length) {
        res.setHeader(EXPORT_SKIPPED_HEADER, String(skipped.length));
        // Ids and dates only — see the README's rule on what a log may hold.
        (req.log ?? log).warn('export.rows_skipped',
          { format: 'loop_db', skipped: skipped.length, rows: skipsForLog(skipped) });
      }
      res.send(body);
    })
    .catch(next)
    .finally(() => { try { unlinkSync(path); } catch { /* best effort */ } });
});

/* ---------- import ---------- */

const MODES = new Set(['merge', 'replace']);

/**
 * Import a habiterall JSON backup, a Loop .db backup, or a Loop CSV export
 * (zip or a single Checkmarks.csv). The body is the raw file; the format is
 * sniffed from its contents rather than trusted from the client.
 */
api.post('/import', (req, res, next) => {
  const mode = MODES.has(req.query.mode) ? req.query.mode : 'merge';
  const buf = req.body;

  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw httpError(400, 'request body must be the file to import');
  }

  // Express 4 does not catch rejections from async handlers, so forward them.
  parseUpload(buf)
    .then((habits) => {
      if (!habits.length) throw httpError(400, 'no habits found in the uploaded file');
      // `[]`, never `null`, for a format with nowhere to carry a category —
      // `applyImport` iterates this before a single habit is written; see its
      // own comment for why a habit's `category` is resolved against it by
      // NAME rather than by any id the file happens to carry.
      const result = applyImport(habits, mode, backupCategories(buf) ?? []);

      // Replace mode only: it means "make this account look like the file", and
      // the file's preferences are part of that. A merge is "add these habits to
      // what I have" and has no business rewriting how the rest of the account
      // is displayed. Through parseSettings, so a hand-edited backup cannot
      // store a value the API would refuse.
      let settings = 0;
      if (mode === 'replace') {
        const raw = backupSettings(buf);
        if (raw) {
          // Filtered BEFORE the validator, so a file cannot set a notification
          // destination however well-formed its value is: a shared "starter
          // habits" backup would otherwise repoint the reminders of everyone who
          // restored it at a channel its author reads.
          const { accepted } = parseSettings(portableSettings(raw));
          for (const [key, value] of Object.entries(accepted)) {
            q.putSetting.run(key, JSON.stringify(value));
          }
          settings = Object.keys(accepted).length;
        }
      }

      res.json({ mode, ...result, settings });
    })
    .catch(next);
});

export default api;
