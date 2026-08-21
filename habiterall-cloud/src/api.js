/**
 * REST API. Every handler runs inside `withUser`, so Row-Level Security
 * scopes each query to the session's user. Note that the queries below still
 * carry explicit `user_id` predicates where it aids the planner — RLS is the
 * guarantee, not the only line of defence.
 */

import express from 'express';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withUser } from './db/pool.js';
import { applyImport } from './apply-import.js';
import { deliveryStatus, sendTest } from './notifier.js';
import {
  writeLoopDatabase, EXPORT_SKIPPED_HEADER, skipsForLog,
} from '@habiterall/shared/export-loop.js';
import { buildCsvArchive } from '@habiterall/shared/export-csv.js';
import {
  DEVICE_ZONE_HEADER, callerDay, reportedZone,
} from '@habiterall/shared/notify.js';
import { log } from '@habiterall/shared/log.js';
// Format sniffing and every parser live in shared: the two editions had
// separate copies of the sniffing, and they had drifted.
import { backupSettings, backupCategories, parseUpload } from '@habiterall/shared/import.js';
import { UNSET, YES, SKIP } from '@habiterall/shared/constants.js';
import {
  parseHabit, parseEntry, parseSettings, portableSettings, entryWrite, assertDate,
  assertNotFuture, parseCategory, foldCategoryName, LIMITS,
  DATE_RE,
} from '@habiterall/shared/validate.js';
import {
  computeStats, summaryStats, computeStreaks, bestStreak, isCompleted, UNLOGGED_DEFAULT,
  unansweredCounts, today, addDays, daysBetween, MAX_RANGE_DAYS,
} from '@habiterall/shared/stats.js';
import { computeAwards } from '@habiterall/shared/awards.js';

export const api = express.Router();

const SUMMARY_WINDOW_DAYS = 400;

/**
 * How far back the dashboard's streak scan reads.
 *
 * The scan used to be unbounded, so a long history meant hundreds of
 * thousands of rows shipped to Node and ~850ms of synchronous CPU per
 * request — on a single-threaded server that stalls every tenant, and one
 * account could saturate the process within its rate limit.
 *
 * Five years bounds the work while being far beyond any streak a person will
 * actually run. `bestStreak` is therefore "best in the last five years",
 * which is the honest reading of a dashboard summary anyway.
 */
const STREAK_HISTORY_DAYS = 1830;

/** Per-user ceilings. Cheap insurance against one account exhausting the box. */
const MAX_HABITS_PER_USER = Number(process.env.MAX_HABITS_PER_USER) || 200;

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

const uid = (req) => req.session.user.id;

/** Wrap an async handler so rejections reach the error middleware. */
const route = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * Note which clock the caller's device is on, for `notifyTimezone: 'auto'`.
 *
 * On requests that already happen, so following your zone costs no extra
 * traffic — and the UPDATE is guarded by `WHERE device_time_zone IS DISTINCT
 * FROM $1`, so a settled account writes here never. Read back by the notifier
 * through `resolveTimeZone`, and only for an account that has not named a zone.
 *
 * Inside `withUser`, so RLS applies and the write can only ever touch the
 * caller's own row — the app role has column-level UPDATE on this one column
 * (migration 013) and cannot reach `idp_subject` or `blocked`.
 *
 * Never fatal, and not awaited into the request's critical path beyond the
 * write itself: a request must not fail because the server could not write
 * down where the user is.
 */
/**
 * How long a memoised zone is trusted before the database is asked again.
 *
 * A TTL, and it is the whole correctness of this cache. Without one the memo's
 * invariant is "the memo equals what the row holds", which is only true PER
 * PROCESS — and this edition runs behind a load balancer. With two instances,
 * each suppresses writes based on what IT last wrote, so the row freezes on
 * whichever warmed up last and later check-ins from the other device never
 * correct it. Measured with two real processes against one Postgres: the row
 * stayed on the phone's zone through five more desktop requests, and the
 * account's reminders then arrive on the wrong device's clock indefinitely.
 * Stale for a minute is the intended trade; wrong forever is not.
 *
 * A minute, matching `isBlocked`'s `BLOCK_CHECK_MS` next door, which is the
 * cache this is modelled on — and which has a TTL, contrary to what an earlier
 * comment here claimed.
 */
const ZONE_CHECK_MS = 60_000;

/** userId -> {zone, at}. Bounded by the accounts seen this process lifetime. */
const lastReportedZone = new Map();

api.use(route(async (req, res, next) => {
  // Say that the answer depends on it — see the note on personal's copy. It
  // matters more here: one origin serves every account, so the zones asking
  // the same URL are as many as the instance has users.
  res.vary(DEVICE_ZONE_HEADER);

  const user = uid(req);
  const zone = reportedZone(req.get(DEVICE_ZONE_HEADER));
  const hit = lastReportedZone.get(user);
  const fresh = hit && hit.zone === zone && Date.now() - hit.at < ZONE_CHECK_MS;
  if (zone && !fresh) {
    try {
      // `IS DISTINCT FROM` still does the real work: this writes no row, no
      // WAL and no transaction id when the value already matches. What the
      // memo saves is the TRANSACTION — a pool checkout and four round trips —
      // on the requests in between.
      await withUser(user, (db) => db.query(
        `UPDATE users SET device_time_zone = $1
          WHERE id = $2 AND device_time_zone IS DISTINCT FROM $1`,
        [zone, user]
      ));
      // After the write, so a failure is retried on the next request rather
      // than remembered as done.
      lastReportedZone.set(user, { zone, at: Date.now() });
    } catch (err) {
      log.warn('settings.device_clock_not_stored', { user }, err);
    }
  }
  next();
}));

/**
 * What day it is for the client making this request.
 *
 * Every route that asks "is this today?" asks it of the CALLER, not of the
 * process. `today()` is the container's calendar day, which is UTC in both
 * compose files and therefore right for almost nobody — and this edition is
 * the one where it is wrong for most of its users at once, since a cloud
 * instance serves whatever zones its accounts are in. A user east of the
 * server had the current column of their own grid refused as a future date
 * for as many hours a day as the offset, and — because the same date clamps
 * the summary anchor — a day they did record was scored as of the server's
 * yesterday, so the streak sat still.
 *
 * Read from the header rather than from `device_time_zone`, for the reason
 * `callerDay` states: this is a fact about one device, not about the account.
 * That it needs no row is a second benefit — this is on the hot path of every
 * request, where the stored zone is a query.
 */
const callerToday = (req) => callerDay(req.get(DEVICE_ZONE_HEADER));

/**
 * Resolve an already-parsed habit's `category_id` into something safe to
 * store. `parseHabit` has already decided the SHAPE — a positive safe
 * integer or `null`, with anything malformed folded to `null` and no 400 —
 * so this only decides EXISTENCE, a database question the shared validator
 * has no connection to answer.
 *
 * A null/absent id passes straight through as the stated clear it is. A
 * present id that names nothing is a 400: storing it anyway would leave a
 * habit pointing at a category that was never created, and `ON DELETE SET
 * NULL` would have nothing to ever fire on.
 *
 * The SELECT runs on DB, already inside `withUser` — RLS scopes it to the
 * caller's own categories, so an id that belongs to another user is
 * indistinguishable from one that does not exist at all, and gives the same
 * 400 rather than an existence oracle.
 *
 * @param {{query: Function}} db - already inside `withUser`
 * @param {{category_id?: number | null}} body - the output of `parseHabit`
 * @returns {Promise<number | null>}
 */
async function resolveCategoryId(db, body) {
  const id = body.category_id ?? null;
  if (id === null) return null;
  const { rows } = await db.query(`SELECT id FROM categories WHERE id = $1`, [id]);
  if (!rows.length) throw httpError(400, 'category not found');
  return id;
}

/* ---------- habits ---------- */

api.get('/habits', route(async (req, res) => {
  const archived = req.query.archived === 'true';
  const rows = await withUser(uid(req), (db) =>
    db.query(
      `SELECT * FROM habits WHERE archived = $1 ORDER BY position, id`,
      [archived]
    ).then((r) => r.rows)
  );
  res.json(rows);
}));

api.post('/habits', route(async (req, res) => {
  const h = parseHabit(req.body);

  const created = await withUser(uid(req), async (db) => {
    const categoryId = await resolveCategoryId(db, h);

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM habits`
    );
    if (count >= MAX_HABITS_PER_USER) {
      throw httpError(403, `habit limit reached (${MAX_HABITS_PER_USER})`);
    }

    const { rows } = await db.query(
      `INSERT INTO habits (user_id, name, description, type, unit, target_value,
                           target_type, freq_numerator, freq_denominator, color,
                           reminder_time, reminder_message, at_most_unlogged,
                           show_as, icon, category_id, archived, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               COALESCE((SELECT MAX(position) + 1 FROM habits), 0))
       RETURNING *`,
      [uid(req), h.name, h.description, h.type, h.unit, h.target_value,
       h.target_type, h.freq_numerator, h.freq_denominator, h.color,
       h.reminder_time, h.reminder_message, h.at_most_unlogged, h.show_as,
       h.icon, categoryId, h.archived]
    );
    return rows[0];
  });

  res.status(201).json(created);
}));

api.get('/habits/:id', route(async (req, res) => {
  const habit = await getHabit(req);
  res.json(habit);
}));

api.put('/habits/:id', route(async (req, res) => {
  const h = parseHabit(req.body);
  const id = habitId(req);

  const updated = await withUser(uid(req), async (db) => {
    const categoryId = await resolveCategoryId(db, h);

    const { rows } = await db.query(
      `UPDATE habits SET name=$1, description=$2, type=$3, unit=$4,
              target_value=$5, target_type=$6, freq_numerator=$7,
              freq_denominator=$8, color=$9, reminder_time=$10,
              reminder_message=$11, at_most_unlogged=$12, show_as=$13,
              icon=$14, category_id=$15, archived=$16
       WHERE id = $17 RETURNING *`,
      [h.name, h.description, h.type, h.unit, h.target_value, h.target_type,
       h.freq_numerator, h.freq_denominator, h.color, h.reminder_time,
       h.reminder_message, h.at_most_unlogged, h.show_as, h.icon, categoryId,
       h.archived, id]
    );
    return rows[0];
  });

  if (!updated) throw httpError(404, 'habit not found');
  res.json(updated);
}));

api.delete('/habits/:id', route(async (req, res) => {
  const id = habitId(req);
  const gone = await withUser(uid(req), (db) =>
    db.query(`DELETE FROM habits WHERE id = $1 RETURNING id`, [id])
      .then((r) => r.rowCount > 0)
  );
  if (!gone) throw httpError(404, 'habit not found');
  res.status(204).end();
}));

api.post('/habits/reorder', route(async (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order) || order.some((n) => !Number.isInteger(Number(n)))) {
    throw httpError(400, 'order must be an array of habit ids');
  }
  // The array length was unvalidated and drove a serial UPDATE loop inside one
  // transaction, so a single legal request could hold a pool connection for
  // minutes — a 1MB body fits ~500,000 ids, and duplicates pass validation, so
  // no habits even had to exist. One caller could stall every tenant.
  if (order.length > MAX_HABITS_PER_USER) {
    throw httpError(400, `order may not exceed ${MAX_HABITS_PER_USER} ids`);
  }

  const rows = await withUser(uid(req), async (db) => {
    // One statement instead of a round trip per id. RLS still confines the
    // update to the caller's own habits, so an id belonging to someone else
    // simply matches nothing.
    const ids = order.map((id) => Number(id));
    if (ids.length) {
      await db.query(
        `UPDATE habits SET position = v.position
           FROM (SELECT * FROM unnest($1::bigint[], $2::int[]) AS t(id, position)) AS v
          WHERE habits.id = v.id`,
        [ids, ids.map((_, i) => i)]
      );
    }
    return db.query(
      `SELECT * FROM habits WHERE archived = false ORDER BY position, id`
    ).then((r) => r.rows);
  });

  res.json(rows);
}));

/* ---------- categories ---------- */

/**
 * Whether NAME already names a category other than EXCLUDE_ID, for the
 * caller whose scope DB is already inside.
 *
 * Folded through `foldCategoryName` — the one shared rule, so this and the
 * personal edition's SQLite `NOCASE` check agree on 'Élan' vs 'élan' rather
 * than each drawing its own line. `LIMITS.categories` keeps this a scan of at
 * most 30 rows, so there is no reason to push it into SQL — Postgres's own
 * `lower()` unique index (migration 015) stays a backstop.
 *
 * @param {{query: Function}} db
 * @param {string} name
 * @param {number | null} excludeId
 * @returns {Promise<boolean>}
 */
async function categoryNameTaken(db, name, excludeId) {
  const folded = foldCategoryName(name);
  const { rows } = await db.query(`SELECT id, name FROM categories`);
  return rows.some((c) => c.id !== excludeId && foldCategoryName(c.name) === folded);
}

api.get('/categories', route(async (req, res) => {
  const rows = await withUser(uid(req), (db) =>
    db.query(`SELECT * FROM categories ORDER BY position, id`).then((r) => r.rows)
  );
  res.json(rows);
}));

api.post('/categories', route(async (req, res) => {
  const c = parseCategory(req.body);

  const created = await withUser(uid(req), async (db) => {
    if (await categoryNameTaken(db, c.name, null)) {
      throw httpError(409, 'category already exists');
    }
    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM categories`
    );
    if (count >= LIMITS.categories) {
      throw httpError(400, `at most ${LIMITS.categories} categories are allowed`);
    }
    const { rows } = await db.query(
      `INSERT INTO categories (user_id, name, color, position)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM categories), 0))
       RETURNING *`,
      [uid(req), c.name, c.color]
    );
    return rows[0];
  });

  res.status(201).json(created);
}));

api.put('/categories/:id', route(async (req, res) => {
  const id = categoryId(req);
  const c = parseCategory(req.body);

  const updated = await withUser(uid(req), async (db) => {
    // Existence checked first, matching the personal edition's ordering: a
    // request naming a category that is not (or no longer) the caller's own
    // gets a 404 rather than a 409 it happened to also collide on.
    const { rows: existing } = await db.query(`SELECT id FROM categories WHERE id = $1`, [id]);
    if (!existing.length) throw httpError(404, 'category not found');

    if (await categoryNameTaken(db, c.name, id)) {
      throw httpError(409, 'category already exists');
    }
    const { rows } = await db.query(
      `UPDATE categories SET name = $1, color = $2 WHERE id = $3 RETURNING *`,
      [c.name, c.color, id]
    );
    return rows[0];
  });

  res.json(updated);
}));

api.delete('/categories/:id', route(async (req, res) => {
  const id = categoryId(req);
  // ON DELETE SET NULL, never CASCADE (migration 015): this is tidying up a
  // label, not a request to destroy every habit that wore it. Its habits,
  // and every entry on them, survive — uncategorised.
  const gone = await withUser(uid(req), (db) =>
    db.query(`DELETE FROM categories WHERE id = $1 RETURNING id`, [id])
      .then((r) => r.rowCount > 0)
  );
  if (!gone) throw httpError(404, 'category not found');
  res.status(204).end();
}));

api.post('/categories/reorder', route(async (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order) || order.some((n) => !Number.isInteger(Number(n)))) {
    throw httpError(400, 'order must be an array of category ids');
  }
  if (order.length > LIMITS.categories) {
    throw httpError(400, `order may not exceed ${LIMITS.categories} ids`);
  }

  const rows = await withUser(uid(req), async (db) => {
    const ids = order.map((id) => Number(id));
    if (ids.length) {
      await db.query(
        `UPDATE categories SET position = v.position
           FROM (SELECT * FROM unnest($1::bigint[], $2::int[]) AS t(id, position)) AS v
          WHERE categories.id = v.id`,
        [ids, ids.map((_, i) => i)]
      );
    }
    return db.query(`SELECT * FROM categories ORDER BY position, id`).then((r) => r.rows);
  });

  res.json(rows);
}));

/* ---------- entries ---------- */

api.get('/habits/:id/entries', route(async (req, res) => {
  await getHabit(req); // 404s if it is not the caller's
  const rows = await withUser(uid(req), (db) =>
    db.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, value, status, notes
       FROM entries WHERE habit_id = $1 ORDER BY date`,
      [habitId(req)]
    ).then((r) => r.rows)
  );
  res.json(rows);
}));

api.put('/habits/:id/entries/:date', route(async (req, res) => {
  const habit = await getHabit(req);
  const date = req.params.date;

  assertDate(date);
  assertNotFuture(date, callerToday(req));

  const parsed = parseEntry(habit, req.body, { UNSET, YES, SKIP });

  // The rule — a skip is out of band, and every other write is a ROW, including
  // value 0, which is the answer "no" — lives in shared/validate.js, because the
  // personal edition and the Discord button handler have to apply exactly the
  // same one. Clearing a day is the DELETE route below, not a PUT of zero.
  const write = entryWrite(habit, parsed, { UNSET, SKIP });

  await withUser(uid(req), async (db) => {
    if (write.op === 'delete') {
      await db.query(`DELETE FROM entries WHERE habit_id = $1 AND date = $2`,
        [habit.id, date]);
      return;
    }
    await upsertEntry(db, uid(req), habit.id, date, write.value, write.status, write.notes);
  });

  res.json({ habit_id: habit.id, date, ...write.reply });
}));

api.delete('/habits/:id/entries/:date', route(async (req, res) => {
  await getHabit(req);
  if (!DATE_RE.test(req.params.date)) throw httpError(400, 'date must be YYYY-MM-DD');

  await withUser(uid(req), (db) =>
    db.query(`DELETE FROM entries WHERE habit_id = $1 AND date = $2`,
      [habitId(req), req.params.date])
  );
  res.status(204).end();
}));

function upsertEntry(db, userId, habitId, date, value, status, notes) {
  return db.query(
    `INSERT INTO entries (habit_id, user_id, date, value, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (habit_id, date) DO UPDATE
       SET value = EXCLUDED.value,
           status = EXCLUDED.status,
           notes = EXCLUDED.notes`,
    [habitId, userId, date, value, status, notes]
  );
}

/* ---------- stats ---------- */

api.get('/habits/:id/stats', route(async (req, res) => {
  const habit = await getHabit(req);

  const now = callerToday(req);
  const requestedEnd = DATE_RE.test(req.query.end ?? '') ? req.query.end : now;
  const end = requestedEnd > now ? now : requestedEnd;

  const start = DATE_RE.test(req.query.start ?? '') ? req.query.start : undefined;
  if (start) {
    if (start > end) throw httpError(400, 'start must not be after end');
    if (daysBetween(start, end) > MAX_RANGE_DAYS) {
      throw httpError(400, `range must not exceed ${MAX_RANGE_DAYS} days`);
    }
  }

  const { entries, weekStart, unlogged, skipDays } = await withUser(uid(req), async (db) => {
    const { rows } = await db.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, value, status, notes
       FROM entries WHERE habit_id = $1 ORDER BY date`,
      [habit.id]
    );
    // The week boundary is a user preference, so history and the
    // times-per-week chart must be bucketed the way they read their calendar.
    const { rows: [u] } = await db.query(
      `SELECT settings ->> 'weekStart'      AS week_start,
              settings ->> 'atMostUnlogged' AS unlogged,
              settings ->> 'skipDays'       AS skip_days
         FROM users WHERE id = $1`,
      [uid(req)]
    );
    const weekStart = /** @type {'monday'|'sunday'} */ (
      u?.week_start === 'sunday' ? 'sunday' : 'monday');
    // `->>` is the TEXT accessor, so a JSON `true` arrives as the string
    // 'true'. Reading it with `->` and a truthiness test would make the string
    // "false" enable the setting, which is the shape of bug `unloggedFrom`
    // avoids by comparing against the one value that means something.
    return {
      entries: rows, weekStart, unlogged: unloggedFrom(u),
      skipDays: u?.skip_days === 'true',
    };
  });

  const stats = computeStats(habit, entries, {
    start, end, granularity: req.query.granularity ?? 'day', weekStart, unlogged,
  });

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
}));

api.get('/overview', route(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

  // The dashboard can page back through history, so it asks for the window it
  // is actually showing. Without this the grid rendered empty cells for any
  // day outside the most recent fortnight — the entries were never fetched.
  const now = callerToday(req);
  const requestedEnd = DATE_RE.test(req.query.end ?? '') ? req.query.end : now;
  const end = requestedEnd > now ? now : requestedEnd;
  const start = addDays(end, -(days - 1));
  const archived = req.query.archived === 'true';

  // ...and `end` decides the GRID window only. The row summary — strength,
  // current streak, best streak — is a statement about the habit now, so it is
  // anchored on today whatever window is on screen. They shared one date, and
  // paging back a month restated the summary as of that month: "43%" with
  // nothing on the row to say it was not today's. The detail view is the
  // surface that answers "as of when", and it has its own range controls.
  const summaryEnd = now;

  const payload = await withUser(uid(req), async (db) => {
    const { rows: habits } = await db.query(
      `SELECT * FROM habits WHERE archived = $1 ORDER BY position, id`,
      [archived]
    );
    // One extra SELECT, read once for the whole payload for the same reason
    // `unlogged` is below: the dashboard groups by category behind
    // `groupByCategory`, and every habit on the page needs the same list. Read
    // even with no habits — a category with none yet still draws its header.
    const { rows: categories } = await db.query(
      `SELECT * FROM categories ORDER BY position, id`
    );
    if (!habits.length) return { start, end, categories, habits: [] };

    const ids = habits.map((h) => h.id);

    // One answer for the account, read once for the whole payload — the map
    // below runs per habit and this is not a per-habit question.
    const { rows: [prefs] } = await db.query(
      `SELECT settings ->> 'atMostUnlogged' AS unlogged FROM users WHERE id = $1`,
      [uid(req)]
    );
    const unlogged = unloggedFrom(prefs);

    // One query for the grid window, one for the lifetime figures, rather
    // than two per habit.
    const { rows: windowRows } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
       FROM entries WHERE habit_id = ANY($1) AND date BETWEEN $2 AND $3
       ORDER BY date`,
      [ids, start, end]
    );
    // Bounded, NOT lifetime. This query had no date predicate, so an account
    // with years of history shipped every row to Node and then spent ~850ms
    // of SYNCHRONOUS CPU per request in computeStreaks — blocking the event
    // loop for every other tenant. `boundedRange` caps the date SPAN, not the
    // row count, so it was no help here.
    //
    // STREAK_HISTORY_DAYS bounds what the streak scan reads. A streak longer
    // than this reports as capped rather than reading the whole table; the
    // count below is done in SQL instead of in JS.
    const streakFrom = addDays(summaryEnd, -STREAK_HISTORY_DAYS);
    const { rows: allRows } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
       FROM entries WHERE habit_id = ANY($1) AND date >= $2 ORDER BY date`,
      [ids, streakFrom]
    );

    // Lifetime totals in the database, where counting is what it is for.
    // Postgres applies the same completion rule the shared code does; the
    // status check keeps skips out, matching isCompleted returning null.
    const { rows: totalRows } = await db.query(
      `SELECT e.habit_id,
              COUNT(*) FILTER (
                WHERE COALESCE(e.status, '') <> 'skip'
                  AND CASE
                        WHEN h.type = 'boolean' THEN e.value = 2
                        WHEN h.target_type = 'at_most' THEN e.value <= h.target_value
                        ELSE e.value >= h.target_value
                      END
              )::int AS completed
         FROM entries e JOIN habits h ON h.id = e.habit_id
        WHERE e.habit_id = ANY($1)
        GROUP BY e.habit_id`,
      [ids]
    );
    const totals = new Map(totalRows.map((r) => [r.habit_id, r.completed]));

    const grid = new Map(ids.map((id) => [id, {}]));
    const skips = new Map(ids.map((id) => [id, []]));
    for (const r of windowRows) {
      if (r.status === 'skip') {
        grid.get(r.habit_id)[r.date] = SKIP;
        skips.get(r.habit_id).push(r.date);
      } else {
        grid.get(r.habit_id)[r.date] = r.value;
      }
    }

    const byHabit = new Map(ids.map((id) => [id, []]));
    for (const r of allRows) byHabit.get(r.habit_id).push(r);

    const cutoff = addDays(summaryEnd, -SUMMARY_WINDOW_DAYS);

    return {
      start,
      end,
      categories,
      habits: habits.map((h) => {
        const all = byHabit.get(h.id) ?? [];
        const recent = all.filter((e) => e.date >= cutoff);
        // Two numbers are read below — `score` and `currentStreak` — so this
        // calls `summaryStats` rather than `computeStats`: the same window and
        // the same two passes (`computeScores`, `computeStreaks`), with the
        // five passes `computeStats` also runs — `computeHistory`,
        // `computeWeekdays`, `computeWeekdayByMonth`, `computeFrequency`,
        // `computeResilience` — never started, once per habit, on the
        // dashboard's hot path. Awards are out of this route for the same
        // reason, stated at the `/stats` call site above.
        const stats = summaryStats(h, recent, { end: summaryEnd, unlogged });

        const totalCompleted = totals.get(h.id) ?? 0;

        const streaks = computeStreaks(
          h,
          new Map(all.map((e) => [e.date, { value: e.value, status: e.status }])),
          all.length ? all[0].date : summaryEnd,
          summaryEnd,
          unlogged
        );

        return {
          ...h,
          entries: grid.get(h.id) ?? {},
          skips: skips.get(h.id) ?? [],
          score: stats.score,
          currentStreak: stats.currentStreak,
          bestStreak: bestStreak(streaks),
          totalCompleted,
          // Same field, same reason as the `/stats` call site above: resolved
          // server-side because no renderer can import `unansweredCounts`, and
          // derived rather than stored.
          unlogged_is_success: unansweredCounts(h, unlogged),
        };
      }),
    };
  });

  res.json(payload);
}));

/**
 * What a day with no row counts as on an at-most habit, from a `users` row.
 *
 * Read out of the settings JSONB and handed to `computeStats`, rather than
 * looked up inside it: the shared code takes no database, which is the whole
 * reason one copy of it serves both editions. Anything but the stored word is
 * the default, exactly as the week start beside it is read.
 *
 * @param {{unlogged?: string|null}} [row]
 */
function unloggedFrom(row) {
  return row?.unlogged === 'success' ? 'success' : UNLOGGED_DEFAULT;
}

/* ---------- settings ---------- */

/**
 * Preferences follow the account rather than the device, so a choice made on
 * a laptop applies on a phone. Stored as JSONB on the user row; the existing
 * users_select_self / users_update_self policies scope both queries.
 */
api.get('/settings', route(async (req, res) => {
  const settings = await withUser(uid(req), (db) =>
    db.query(`SELECT settings FROM users WHERE id = $1`, [uid(req)])
      .then((r) => r.rows[0]?.settings ?? {})
  );
  res.json(settings);
}));

/** Merge a patch. Unknown or invalid keys are dropped, not rejected. */
api.put('/settings', route(async (req, res) => {
  const { accepted, rejected } = parseSettings(req.body);

  const merged = await withUser(uid(req), (db) =>
    // Merge server-side so two devices racing cannot clobber each other's
    // unrelated keys.
    db.query(
      `UPDATE users SET settings = settings || $1::jsonb
       WHERE id = $2 RETURNING settings`,
      [JSON.stringify(accepted), uid(req)]
    ).then((r) => r.rows[0]?.settings ?? {})
  );

  res.json({ settings: merged, ignored: rejected });
}));

api.delete('/settings', route(async (req, res) => {
  await withUser(uid(req), (db) =>
    db.query(`UPDATE users SET settings = '{}'::jsonb WHERE id = $1`, [uid(req)])
  );
  res.json({});
}));

/* ---------- notifications ---------- */

/**
 * Post a test message to every configured server-delivered destination.
 *
 * Without it, a wrong webhook URL is only discoverable by waiting for a
 * reminder that never comes and then reading a log the user has no access to.
 * The reply carries each channel's own outcome.
 *
 * The settings are re-read here rather than taken from the request: the URL the
 * server will fetch must be one it has already validated and stored, or this
 * endpoint would be a way to make the server fetch an arbitrary body.
 */
api.post('/notify/test', route(async (req, res) => {
  const settings = await withUser(uid(req), (db) =>
    db.query(`SELECT settings FROM users WHERE id = $1`, [uid(req)])
      .then((r) => r.rows[0]?.settings ?? {})
  );
  res.json({ results: await sendTest(uid(req), settings) });
}));

/**
 * How each destination last behaved.
 *
 * The test button above is the other half of this and has one flaw: it has to
 * be PRESSED, and nothing suggests pressing it. A webhook deleted in April
 * stops the reminders while the habit, its time and the destination toggle all
 * go on looking correct — and on a shared instance the warn line it produces is
 * unreachable: the user cannot see it, and the operator has no reason to be
 * reading one account's warnings. So this reports what the notifier already
 * learned at 08:00, and the settings dialog shows it without being asked.
 *
 * Only the last outcome per channel, and only for channels something has
 * actually been attempted for. It is deliberately NOT a statement about
 * configuration: `channelConfigured` stays the authority on whether a
 * destination can deliver, and this says only whether it did.
 */
api.get('/notify/status', route(async (req, res) => {
  res.json({ channels: await deliveryStatus(uid(req)) });
}));

/* ---------- export ---------- */

api.get('/export', route(async (req, res) => {
  const { data, categories, settings } = await withUser(uid(req), async (db) => {
    const { rows: habits } = await db.query(
      `SELECT * FROM habits ORDER BY archived, position, id`
    );
    const { rows: entries } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status, notes
       FROM entries ORDER BY habit_id, date`
    );
    const { rows: categoryRows } = await db.query(
      `SELECT * FROM categories ORDER BY position, id`
    );
    // The backup carries a category by NAME, not by id: an id is meaningless
    // once restored somewhere else (or nowhere, on a Loop round trip), and a
    // name is what `normaliseImportedHabit` and `backupCategories` (import.js)
    // already agree the wire format is.
    const categoryNames = new Map(categoryRows.map((c) => [c.id, c.name]));
    const byHabit = new Map(habits.map((h) => [h.id, []]));
    for (const e of entries) {
      const { habit_id, ...rest } = e;
      byHabit.get(habit_id)?.push(rest);
    }
    // Read inside the same transaction as the habits, so the backup is one
    // consistent picture of the account rather than two reads with a write
    // possible between them.
    const { rows } = await db.query(`SELECT settings FROM users WHERE id = $1`, [uid(req)]);
    return {
      // `user_id` comes off `SELECT *` and has no business in a portable file:
      // it is this deployment's tenancy key, it means nothing anywhere else,
      // and the personal edition — which has no such column — writes a backup
      // without it, so the two editions described the same account with two
      // different shapes. Dropped here rather than by naming columns in the
      // query, because a backup that silently omits a NEW column is the worse
      // failure of the two: migration 009 added `reminder_message`, and a
      // hand-kept SELECT list is exactly what would have left it behind.
      data: habits.map(({ user_id, ...h }) => ({
        ...h,
        category: categoryNames.get(h.category_id) ?? '',
        entries: byHabit.get(h.id) ?? [],
      })),
      // A user's own categories, so a backup can recreate them by name rather
      // than by an id that means nothing once restored — see apply-import.js.
      categories: categoryRows.map((c) => ({ name: c.name, color: c.color, position: c.position })),
      settings: rows[0]?.settings ?? {},
    };
  });

  if (req.query.download === 'true') {
    res.setHeader('Content-Disposition',
      `attachment; filename="habiterall-backup-${today()}.json"`);
  }
  res.json({
    version: 1,
    app: 'habiterall',
    exported_at: new Date().toISOString(),
    habits: data,
    categories,
    // Part of the account, and two of them now decide what the rows MEAN — see
    // the personal edition's export for the whole reasoning. Filtered: a webhook
    // URL is a capability, and a backup file travels.
    settings: portableSettings(settings),
  });
}));

/** All checkmarks as a single Loop-shaped CSV. */
api.get('/export.csv', route(async (req, res) => {
  const { habits, entries, categoryRows } = await withUser(uid(req), async (db) => {
    const { rows: habits } = await db.query(
      `SELECT * FROM habits ORDER BY archived, position, id`);
    const { rows: entries } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
       FROM entries ORDER BY date`);
    const { rows: categoryRows } = await db.query(`SELECT id, name FROM categories`);
    return { habits, entries, categoryRows };
  });

  const byHabit = new Map(habits.map((h) => [h.id, []]));
  for (const e of entries) byHabit.get(e.habit_id)?.push(e);

  // `buildHabitsCsv` reads `h.category` by NAME, the same as `/export`
  // above — a raw habit row only carries `category_id`, which means nothing
  // once restored elsewhere (or nowhere, on a Loop round trip).
  const categoryNames = new Map(categoryRows.map((c) => [c.id, c.name]));
  const withCategory = habits.map((h) => ({
    ...h, category: categoryNames.get(h.category_id) ?? '',
  }));

  const body = buildCsvArchive(withCategory, (id) => byHabit.get(id) ?? []);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename="habiterall-csv-${today()}.zip"`);
  res.send(body);
}));

/**
 * A Loop Habit Tracker .db backup of this user's data.
 *
 * The skip report is here as well as in the personal edition even though
 * Postgres' `DATE` column has never let an impossible date in, because what
 * `writeLoopDatabase` refuses is not "an invalid date" but "a date Loop's
 * encoding cannot carry back unchanged" — a question about the exporter, which
 * both editions run the same copy of. A route that answered it in only one of
 * them is the drift this project keeps paying for.
 */
api.get('/export-loop.db', route(async (req, res) => {
  const { habits, byHabit } = await withUser(uid(req), async (db) => {
    const { rows: habits } = await db.query(
      `SELECT * FROM habits ORDER BY archived, position, id`);
    const { rows: entries } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status, notes
       FROM entries ORDER BY habit_id, date`);
    const byHabit = new Map(habits.map((h) => [h.id, []]));
    for (const e of entries) byHabit.get(e.habit_id)?.push(e);
    return { habits, byHabit };
  });

  const path = join(tmpdir(), `habiterall-loop-${randomUUID()}.db`);
  try {
    const { skipped } = await writeLoopDatabase(path, habits, (id) => byHabit.get(id) ?? []);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `attachment; filename="Loop Habits Backup ${today()}.db"`);
    if (skipped.length) {
      res.setHeader(EXPORT_SKIPPED_HEADER, String(skipped.length));
      // Ids and dates only — see the README's rule on what a log may hold.
      (req.log ?? log).warn('export.rows_skipped', {
        user: uid(req), format: 'loop_db',
        skipped: skipped.length, rows: skipsForLog(skipped),
      });
    }
    res.send(readFileSync(path));
  } finally {
    try { unlinkSync(path); } catch { /* best effort */ }
  }
}));

/* ---------- import ---------- */

const MODES = new Set(['merge', 'replace']);

/**
 * Import a backup into the CALLER'S OWN account.
 *
 * The uploaded file is treated as untrusted data: ids inside it are ignored
 * entirely, and every row written carries the session's user_id. See
 * src/apply-import.js for the three layers of tenancy enforcement.
 */
api.post('/import', route(async (req, res) => {
  const mode = MODES.has(req.query.mode) ? req.query.mode : 'merge';
  const buf = req.body;

  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw httpError(400, 'request body must be the file to import');
  }

  const habits = await parseUpload(buf);
  if (!habits.length) throw httpError(400, 'no habits found in the uploaded file');

  // `[]`, never `null`, for a format with nowhere to carry a category — see
  // the personal edition's route and `apply-import.js`'s own comment for why
  // a habit's `category` is resolved against this by NAME rather than by any
  // id the file happens to carry.
  const result = await applyImport(uid(req), habits, mode, backupCategories(buf) ?? []);

  // Replace mode only — "make this account look like the file". A merge adds
  // habits to what is already here and must not rewrite the rest of the
  // account's preferences. Through parseSettings, so an uploaded file cannot
  // store a value the API itself would refuse; and through withUser, so it is
  // the caller's own row and no one else's that RLS will let it reach.
  let settings = 0;
  if (mode === 'replace') {
    const raw = backupSettings(buf);
    // Filtered before the validator — see the personal edition's route for what
    // an unfiltered file could do to a reader's notification settings.
    const { accepted } = raw ? parseSettings(portableSettings(raw)) : { accepted: {} };
    if (Object.keys(accepted).length) {
      await withUser(uid(req), (db) => db.query(
        `UPDATE users SET settings = settings || $1::jsonb WHERE id = $2`,
        [JSON.stringify(accepted), uid(req)]
      ));
      settings = Object.keys(accepted).length;
    }
  }

  res.json({ mode, ...result, settings });
}));

/* ---------- helpers ---------- */

/** Fetch a habit, 404ing if it does not exist OR is not the caller's. */
/**
 * A habit id from the URL, validated.
 *
 * `Number(req.params.id)` alone let `/api/habits/abc` reach Postgres as NaN
 * and `/api/habits/1e30` as a float, both of which came back as a 22P02
 * "invalid input syntax for bigint" — an unhandled 500 and a logged stack
 * trace for what is plainly a client error.
 */
function habitId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'invalid habit id');
  return id;
}

/** A category id from the URL, validated the same way `habitId` is. */
function categoryId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'invalid category id');
  return id;
}

async function getHabit(req) {
  const id = habitId(req);

  const habit = await withUser(uid(req), (db) =>
    db.query(`SELECT * FROM habits WHERE id = $1`, [id]).then((r) => r.rows[0])
  );
  // RLS makes another user's habit indistinguishable from a missing one,
  // which is what we want: no existence oracle.
  if (!habit) throw httpError(404, 'habit not found');
  return habit;
}

export default api;
