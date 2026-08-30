/**
 * REST API. Every handler runs inside `withUser`, so Row-Level Security
 * scopes each query to the session's user — and every MUTATING one inside
 * `withUserWrite`, which is the same transaction plus the account's
 * `data_version` bump. Note that the queries below still carry explicit
 * `user_id` predicates where it aids the planner — RLS is the guarantee, not
 * the only line of defence.
 */

import express from 'express';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withUser, withUserWrite, isCategoryNameConflict } from './db/pool.js';
import { createMemo, forgetAccount, remember } from './cache.js';
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
  assertNotFuture, parseCategory, parseCategoryId, foldCategoryName, LIMITS,
  DATE_RE, queryDate,
} from '@habiterall/shared/validate.js';
import {
  computeStats, summaryStats, computeStreaks, bestStreak, isCompleted, UNLOGGED_DEFAULT,
  unansweredCounts, today, addDays, daysBetween, MAX_RANGE_DAYS,
  computeCategoryStats, SCORE_WARMUP_DAYS, MAX_COMPARE_DAYS, COMPARE_WINDOW_DAYS,
  summariseByCategory,
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

/**
 * userId -> `{zone, at}`, bounded by `remember` rather than by its own comment.
 *
 * "Bounded by the accounts seen this process lifetime" is what this used to
 * say, and that is a restatement of the leak rather than a bound. See
 * `cache.js`, which is one policy for this, `blockCache` next door and the
 * `/overview` memo below.
 */
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
      remember(lastReportedZone, user, { zone }, { ttlMs: ZONE_CHECK_MS });
    } catch (err) {
      log.warn('settings.device_clock_not_stored', { user }, err);
    }
  }
  next();
}));

/**
 * Forget an account's memoised dashboards when it writes anything.
 *
 * One rule for every non-safe method rather than a call in each of the nine
 * mutating routes, because a list of routes is a list that drifts — and the
 * cost of forgetting too much is one recomputation, where the cost of
 * forgetting too little is a user's tap painted away. `POST /notify/test`
 * writes nothing `/overview` reads and is invalidated anyway, on purpose.
 *
 * It is registered HERE, above every route, and not beside the memo it clears:
 * Express runs middleware in registration order, so mounted below `/habits` it
 * would never see a request those routes had already answered.
 *
 * It runs on the way OUT, wrapped around `res.end`, and both halves of that are
 * deliberate. Invalidating before the handler would leave the window this
 * exists to close — a concurrent read repopulating the memo from pre-write data
 * between the invalidation and the COMMIT. Invalidating from the `finish` event
 * would be a scheduling argument instead of an ordering one: `finish` fires
 * from a later turn of the loop than the write it follows, so "the client
 * cannot have refetched yet" would be a claim about timing rather than
 * something the code makes true. Wrapping `res.end` makes it true — the memo is
 * clear before the first byte of the answer leaves, which is before the client
 * can know the write happened at all.
 *
 * Unconditional on status, so a write that failed halfway through still drops
 * what it may have changed.
 *
 * Through `forgetAccount` rather than `overviewMemo.forget`, because this
 * router is NOT every write path — `NTFY_ANSWER_PATH` is mounted above it and
 * the Discord button never reaches Express. Those call the same function; see
 * its comment in `cache.js`.
 *
 * **Since #192 this is not what makes the memo correct, and it stays anyway.**
 * The account's `data_version` is in the `/overview` key, so a write already
 * makes every entry built before it unreachable — on every replica, which is
 * something no amount of forgetting inside one process could do. What this
 * still buys is eager reclamation (an unreachable entry is resident until the
 * 60 s TTL sweep meets it) and cover for a write path that forgot to bump. Both
 * reasons are written out at `forgetAccount`; the ordering care below is
 * unchanged and is still what makes the second of them worth having.
 */
api.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const user = uid(req);
  const end = res.end.bind(res);
  res.end = (...args) => {
    forgetAccount(user);
    return end(...args);
  };
  next();
});

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

  const created = await withUserWrite(uid(req), async (db) => {
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

  const updated = await withUserWrite(uid(req), async (db) => {
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
  const gone = await withUserWrite(uid(req), (db) =>
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

  const rows = await withUserWrite(uid(req), async (db) => {
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

/**
 * Which of this account's categories is holding up, over one window.
 *
 * The arithmetic is `computeCategoryStats` (shared/src/stats.js) and every word
 * about what it means is there. This route's whole job is the three things a
 * pure function cannot do for itself, and each of them is a way the figures go
 * quietly wrong rather than loudly:
 *
 *   1. Hand it EVERY habit, archived included — hence a SELECT with no
 *      `archived` predicate rather than the two `/habits` takes a parameter
 *      for. `archivedExcluded` is derived from the members handed over, so a
 *      route that filtered here reports 0 forever and the comparison view has
 *      nothing to say about what it left out.
 *   2. Supply each member's LIFETIME `firstEntry`. The entry read below is
 *      bounded, so a habit last logged before that window comes back with an
 *      empty slice — indistinguishable, from the slice alone, from one that has
 *      never been logged. An abandoned habit has a real strength near zero and
 *      belongs in its category's mean; a never-logged one has no strength to
 *      average in at all. One grouped `MIN(date)` answers the question the
 *      slice cannot, off the `(habit_id, date)` primary key.
 *   3. Read the entries in ONE pass. `WHERE habit_id = $1` inside the loop is
 *      the shape that took 13.5 seconds in the importer (`shared/CLAUDE.md`),
 *      and this route runs it against however many habits the account has.
 *
 * Every query is inside one `withUser`, so RLS scopes all five to the session's
 * user and a forgotten predicate returns nothing rather than somebody else's
 * account — which is exactly what the `SELECT * FROM habits` with no `WHERE` of
 * its own is relying on. That is also why the categories and the habits are
 * read in the same transaction as the entries: a category deleted between two
 * of them would leave its habits pointing at an id no section carries, and
 * `computeCategoryStats` folds those into Uncategorised rather than dropping
 * them.
 *
 * Registered ABOVE the `/categories/:id` routes, and a `GET /categories/:id`
 * added later must go below this line: `parseCategoryId('stats')` is null, so a
 * pattern route reaching this path first answers 400 for a URL that is not an
 * id at all.
 *
 * Identical to the personal edition's, deliberately and to the day — the two
 * bounds it enforces are imported from `shared/src/stats.js` for exactly that
 * reason.
 */
api.get('/categories/stats', route(async (req, res) => {
  // The three bounds `/habits/:id/stats` states, in the same order and for the
  // same reason: never compute past the CALLER's today, never backwards, and
  // never more than a ceiling, because every pass below allocates one element
  // per day. The ceiling itself is NOT that route's — see `MAX_COMPARE_DAYS`.
  // That route walks one habit; this one walks every habit the account has, so
  // the same span costs the habit count times as much.
  const now = callerToday(req);
  const requestedEnd = queryDate(req.query.end, now);
  const end = requestedEnd > now ? now : requestedEnd;

  const requestedStart = queryDate(req.query.start, undefined);
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

  const payload = await withUser(uid(req), async (db) => {
    const { rows: categories } = await db.query(
      `SELECT * FROM categories ORDER BY position, id`
    );
    // No `archived` predicate — see (1) above.
    const { rows: habits } = await db.query(
      `SELECT * FROM habits ORDER BY position, id`
    );

    // One answer for the account, read once for the whole payload rather than
    // per habit, exactly as `/overview` reads `unlogged`: the map below runs
    // once per habit and neither of these is a per-habit question.
    const { rows: [prefs] } = await db.query(
      `SELECT settings ->> 'weekStart'      AS week_start,
              settings ->> 'atMostUnlogged' AS unlogged
         FROM users WHERE id = $1`,
      [uid(req)]
    );
    const weekStart = /** @type {'monday'|'sunday'} */ (
      prefs?.week_start === 'sunday' ? 'sunday' : 'monday');
    const unlogged = unloggedFrom(prefs);

    const ids = habits.map((h) => h.id);

    // One SELECT over the window and one grouped MIN over the lifetime — see
    // (2) and (3) above. The warm-up start is DERIVED from the window, never
    // read back from a stored date, and the span it opens is the clamp above
    // plus the fixed 400 days.
    const { rows: entryRows } = ids.length ? await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
       FROM entries WHERE habit_id = ANY($1) AND date BETWEEN $2 AND $3
       ORDER BY date`,
      [ids, addDays(start, -SCORE_WARMUP_DAYS), end]
    ) : { rows: [] };
    const { rows: firstRows } = ids.length ? await db.query(
      `SELECT habit_id, to_char(MIN(date), 'YYYY-MM-DD') AS first_date
       FROM entries WHERE habit_id = ANY($1) GROUP BY habit_id`,
      [ids]
    ) : { rows: [] };

    const byHabit = new Map(ids.map((id) => [id, []]));
    for (const r of entryRows) byHabit.get(r.habit_id).push(r);
    const firstEntry = new Map(firstRows.map((r) => [r.habit_id, r.first_date]));

    return computeCategoryStats(
      categories,
      habits.map((h) => ({
        habit: h,
        entries: byHabit.get(h.id) ?? [],
        // `?? null`, and never left absent: an omitted key tells
        // `computeCategoryStats` to derive the answer from the entries it was
        // given, which is the truncated slice this route deliberately fetched.
        firstEntry: firstEntry.get(h.id) ?? null,
      })),
      { start, end, granularity, weekStart, unlogged }
    );
  });

  res.json(payload);
}));

/**
 * The order every category route below follows, and the reason it is
 * written down rather than left to be re-derived per route: SHAPE (a
 * positive integer id, else 400, `categoryId` above) before EXISTENCE (else
 * 404) before the BODY through `parseCategory` (else its own 400) before the
 * DUPLICATE name (else 409). `PUT /categories/:id` used to parse the body
 * before checking existence, which personal never did; this is the order
 * both editions now share, so add a route here later in that same sequence
 * rather than inventing a new one.
 */
api.post('/categories', route(async (req, res) => {
  const c = parseCategory(req.body);

  const created = await withUserWrite(uid(req), async (db) => {
    if (await categoryNameTaken(db, c.name, null)) {
      throw httpError(409, 'category already exists');
    }
    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM categories`
    );
    if (count >= LIMITS.categories) {
      throw httpError(400, `at most ${LIMITS.categories} categories are allowed`);
    }
    try {
      const { rows } = await db.query(
        `INSERT INTO categories (user_id, name, color, position)
         VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM categories), 0))
         RETURNING *`,
        [uid(req), c.name, c.color]
      );
      return rows[0];
    } catch (err) {
      // The route's own check above covers the ordinary path; this is what
      // catches a fold that disagrees with Postgres's own lower() backstop,
      // or a genuine race between two requests, rather than surfacing the
      // constraint violation as an unexplained 500.
      if (isCategoryNameConflict(err)) throw httpError(409, 'category already exists');
      throw err;
    }
  });

  res.status(201).json(created);
}));

api.put('/categories/:id', route(async (req, res) => {
  const id = categoryId(req);

  const updated = await withUserWrite(uid(req), async (db) => {
    // Existence checked BEFORE the body is parsed, matching the personal
    // edition's ordering — see the comment above `POST /categories`. A
    // request naming a category that is not (or no longer) the caller's own
    // gets a 404 rather than a 400 from a body it will never use.
    const { rows: existing } = await db.query(`SELECT id FROM categories WHERE id = $1`, [id]);
    if (!existing.length) throw httpError(404, 'category not found');

    const c = parseCategory(req.body);
    if (await categoryNameTaken(db, c.name, id)) {
      throw httpError(409, 'category already exists');
    }
    try {
      const { rows } = await db.query(
        `UPDATE categories SET name = $1, color = $2 WHERE id = $3 RETURNING *`,
        [c.name, c.color, id]
      );
      return rows[0];
    } catch (err) {
      if (isCategoryNameConflict(err)) throw httpError(409, 'category already exists');
      throw err;
    }
  });

  res.json(updated);
}));

api.delete('/categories/:id', route(async (req, res) => {
  const id = categoryId(req);
  // ON DELETE SET NULL, never CASCADE (migration 015): this is tidying up a
  // label, not a request to destroy every habit that wore it. Its habits,
  // and every entry on them, survive — uncategorised.
  const gone = await withUserWrite(uid(req), (db) =>
    db.query(`DELETE FROM categories WHERE id = $1 RETURNING id`, [id])
      .then((r) => r.rowCount > 0)
  );
  if (!gone) throw httpError(404, 'category not found');
  res.status(204).end();
}));

api.post('/categories/reorder', route(async (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order)) throw httpError(400, 'order must be an array of category ids');
  if (order.length > LIMITS.categories) {
    throw httpError(400, `order may not exceed ${LIMITS.categories} ids`);
  }
  // `parseCategoryId`, the same rule `categoryId` below asks of the URL — not
  // `Number.isInteger(Number(n))`, which answers YES to `null`, `''` and `[]`
  // (all 0) and to `true` (1), so every one of those reached the UPDATE as an
  // id nobody named. See the personal edition's copy of this route for the
  // whole reasoning; the two are checked in the same order, with the same
  // three sentences, because a reorder refused in one edition and accepted in
  // the other is the divergence `shared/src/validate.js` exists to prevent.
  const ids = order.map((n) => parseCategoryId(n));
  if (ids.some((id) => id === null)) {
    throw httpError(400, 'order must contain only category ids');
  }

  const rows = await withUserWrite(uid(req), async (db) => {
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

  await withUserWrite(uid(req), async (db) => {
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

  await withUserWrite(uid(req), (db) =>
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
  const requestedEnd = queryDate(req.query.end, now);
  const end = requestedEnd > now ? now : requestedEnd;

  const start = queryDate(req.query.start, undefined);
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

/**
 * How long an `/overview` answer is served from memory before it is rebuilt.
 *
 * The dashboard is not requested once per user action. It is requested on every
 * app open, on every `visibilitychange` — the PWA refetches on foreground —
 * once per open tab, and again on reconnect after the offline banner clears. So
 * three tabs plus a focus event is four identical computations within a few
 * seconds, for an account whose data last changed hours ago, on the most
 * expensive route the app has.
 *
 * **Sixty seconds, because this stopped being the correctness mechanism.** It
 * was two, and two was as long as it was safe to serve an answer nothing could
 * prove was current: a write invalidated inside one process, and on a second
 * replica the timer was all there was. #192 put the account's `data_version`
 * in the key, so an entry built before ANY write — on any replica, by any
 * device — is unreachable rather than merely old. What is left for a timer to
 * do is bound how long an unreachable entry stays resident and cap the damage
 * from a write path that forgot to bump, so it is a backstop and can be long.
 *
 * Sixty rather than longer because it is still the floor under a missed bump
 * (see `forgetAccount` in `cache.js`), and because residency has to be paid
 * for: everything asked for in the last minute is held, which is why
 * `MAX_OVERVIEW_CACHED` had to be re-derived from `MAX_OVERVIEW_BYTES` at the
 * same time rather than left where a 2 s live set had put it.
 */
const OVERVIEW_TTL_MS = 60_000;

/**
 * How many dashboards the memo may hold — its OWN number, not `MAX_CACHED`.
 *
 * `MAX_CACHED` is 10,000 and is justified by an entry costing ~100 bytes,
 * which is true of the two caches it was written for and false of this one. An
 * entry here is a whole `/overview` payload — every habit row spread, plus an
 * `entries` grid of up to 365 dated keys per habit, plus `skips`. Measured with
 * `--expose-gc`, retained after a collection: **499 KB** at 20 habits × 365
 * days and **1.2 MB** at 50 × 365. Ten thousand of those is ~4.9 GB, and this
 * edition's container dies with every tenant on it.
 *
 * Nothing stops an account reaching that count either: `end` is any date up to
 * the caller's today and `days` is 1–365, so every distinct window is a
 * distinct key and there are far more than ten thousand of them. Paging back
 * through a few years of history is the honest way to do it; the read
 * limiter's 300 req/min is the dishonest one, and neither involves a write, so
 * `forget` never fires.
 *
 * **It was 100, and 100 was sized against a residency argument the 60 s TTL
 * destroys.** The reasoning was "entries live `OVERVIEW_TTL_MS`, a computation
 * holds one of `PG_POOL_MAX` = 10 connections while it runs, so the live set is
 * what ten connections can produce in two seconds" — which was true at two
 * seconds and is nonsense at sixty. At 100 entries and a minute-long TTL,
 * `remember` would spend its time evicting entries that are still fresh: all of
 * the sweep, none of the hits, which is the failure that shows up only as "the
 * dashboard is slow again".
 *
 * So `MAX_OVERVIEW_BYTES` is now the operative bound and this is what makes it
 * one: the count has to be high enough that 48 MB is reached FIRST at every
 * entry size a real account produces. Re-measured over the real route for
 * #192, in the unit `sizeOf` actually returns:
 *
 *   |  shape                        | one entry | fits in 48 MB |
 *   |-------------------------------|-----------|---------------|
 *   |  8 habits x 30 days (typical) |   15.1 KB |         3,254 |
 *   |  8 habits x 365 days          |   93.6 KB |           525 |
 *   | 20 habits x 365 days          |  233.4 KB |           210 |
 *   | 50 habits x 365 days          |  582.9 KB |            84 |
 *
 * 3,300 clears the largest of those counts, which is the SMALLEST entry's —
 * 3,254 — because that is the one that decides it: a big dashboard reaches
 * 48 MB in 84 entries and any count at all is a backstop for it. (The archive's
 * 18 KB / 499 KB / 1.2 MB are the RETAINED OBJECT and roughly twice the string;
 * `capBytes` sums the string. See its comment in `cache.js`.)
 *
 * Below ~15 KB an entry this bound DOES bind first — an account with two habits
 * and a week of history is far smaller — and that is the backstop doing its
 * job: 3,300 of anything that small is a few megabytes, and what is bounded
 * there is the map itself rather than the dashboards in it.
 *
 * The failure directions are unchanged and both are silent: too small and the
 * memo thrashes, too large and the process grows until it is killed.
 * `MAX_OVERVIEW_BYTES` is what stops the second whatever this is set to, and
 * `memo.gauge` on the runtime line is what tells the two apart.
 */
const MAX_OVERVIEW_CACHED = 3_300;

/**
 * ...and the same bound expressed in the unit that actually matters.
 *
 * A COUNT converts to a memory bound only through the entry cost, and this
 * cache's entries vary by ~39x: 15.1 KB for a typical 8-habit dashboard on its
 * default window, 233.4 KB at 20 habits × 365 days, 582.9 KB at 50 × 365
 * (re-measured for #192 — see `MAX_OVERVIEW_CACHED` above). Since that TTL
 * change the count is derived from THIS number rather than the other way round,
 * so this is the bound and not a check on one: 48 MB, enforced, whatever mix of
 * dashboard sizes an instance happens to hold.
 *
 * Measured in UTF-16 code units doubled, because the entries are STRINGS (see
 * the memo below) and V8 stores one as Latin-1 or as UTF-16 — so two bytes per
 * unit is the ceiling rather than a guess, and this bound cannot be under-read
 * by an account whose habit names are not ASCII.
 */
const MAX_OVERVIEW_BYTES = 48 * 1024 * 1024;

/**
 * How many of those one account may hold.
 *
 * `MAX_OVERVIEW_CACHED` on its own is a bound an account can spend alone —
 * every distinct `end`/`days` pair is a key, so paging back through a few
 * years fills it, and the account doing that evicts everybody else's answers.
 * The memo then costs every other tenant the sweep and returns them no hits,
 * which is worse than not having it.
 *
 * Eight, because that is roughly what one account can legitimately have live: a
 * real dashboard holds one or two, since the grid window only changes when the
 * user pages, and a couple more for a second device and the archived view. So
 * this is a cap on the abusive shape and not on the ordinary one, and
 * `MAX_OVERVIEW_CACHED` is only reachable by genuinely many accounts being
 * active at once, which is what a backstop should mean.
 *
 * **The 60 s TTL made this matter more, not less.** The arithmetic here used to
 * be "the read limiter allows 300 req/min = 5/s, entries live 2 s, so a client
 * hammering distinct windows as fast as it is allowed holds ~10" — at sixty
 * seconds that same client holds ~300, and eight accounts doing it would be the
 * whole shared count. The number does not move, because it was never sized
 * against the hammering; it is what makes the hammering cost the account doing
 * it and nobody else.
 *
 * Since #192 the version is in the key too, so an account's entries at
 * SUPERSEDED versions count against this share as well as its windows do.
 * That is the right way round — they are unreachable, so its own cap is
 * exactly who should give them up — and the invalidation usually gets there
 * first, which is one of the two reasons `forgetAccount` is kept.
 */
const MAX_OVERVIEW_PER_ACCOUNT = 8;

/**
 * `/overview`, memoised per account, per DATA VERSION, per window and per
 * CALLER DAY.
 *
 * The caller's day is the subtle one and it is why the key is built by hand
 * rather than from the query string. `summaryEnd` is the caller's own today,
 * resolved from `X-Habiterall-Timezone` — so two devices on an account either
 * side of a date boundary send the SAME URL and must not share an answer.
 * `res.vary(DEVICE_ZONE_HEADER)` says exactly this to HTTP caches; a
 * server-side memo has to say it in its key.
 *
 * **The version is what makes this correct on more than one replica** (#192).
 * The memo is per process and so is the invalidation, so a tap handled by A and
 * a refetch balanced to B was served B's own pre-tap answer — the very
 * regression the invalidation exists to prevent, arriving through the load
 * balancer. `users.data_version` is bumped in the same transaction as every
 * write (`withUserWrite`, `db/pool.js`), so every entry built before that write
 * is now keyed at a version no reader will ever ask for again. Unreachable
 * everywhere, at once, with no cooperation from any client — which is strictly
 * more than the `X-Habiterall-Fresh` header this replaces ever bought — that
 * header could only speak for the device that WROTE, so a second tab or a phone
 * that had not itself written was served the stale dashboard anyway — and is
 * why #192 deleted it outright rather than converting it.
 *
 * It costs one primary-key lookup on `users` per request, and the read is
 * folded into the rebuild's own transaction on a miss so it is only ever a
 * SEPARATE round trip on the path that would otherwise touch Postgres not at
 * all. Measured against the rebuild it lets the memo keep: 0.3 ms against
 * 16-75 ms, break-even at 0.37-1.87% of requests converted from miss to hit.
 * `scripts/bench-version-read.mjs` is where those numbers come from and
 * `docs/decisions/caching.md` is where they are argued.
 *
 * Read the hit-rate metric knowing it is 1/N. The ANSWERS are no longer 1/N.
 */
const overviewMemo = createMemo(async ({ db, ...arg }) =>
  JSON.stringify(await buildOverview(db, arg)), {
  ttlMs: OVERVIEW_TTL_MS,
  max: MAX_OVERVIEW_CACHED,
  maxBytes: MAX_OVERVIEW_BYTES,
  // UTF-16 code units doubled: V8 stores a string as Latin-1 or UTF-16, so
  // this is the ceiling on what one entry retains rather than an estimate.
  sizeOf: (json) => json.length * 2,
  maxPerAccount: MAX_OVERVIEW_PER_ACCOUNT,
  perAccount: true,
});

/** What the memo is holding, for the runtime log in `server.js`. */
export const overviewMemoGauge = () => {
  const g = overviewMemo.gauge();
  return {
    overview_memo_entries: g.entries,
    overview_memo_bytes: g.bytes,
    overview_memo_inflight: g.inflight,
  };
};

api.get('/overview', route(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

  // The dashboard can page back through history, so it asks for the window it
  // is actually showing. Without this the grid rendered empty cells for any
  // day outside the most recent fortnight — the entries were never fetched.
  const now = callerToday(req);
  const requestedEnd = queryDate(req.query.end, now);
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

  const user = uid(req);
  // Every input `buildOverview` reads, spelled out. `days` is not in it because
  // `start` is derived from it and two windows with the same ends are the same
  // window; `summaryEnd` IS, even though it equals `end` on an unpaged
  // dashboard, because paging back separates them.
  //
  // The account's `data_version` goes in FRONT of all of it (#192), and it is
  // second rather than first: `<account id>:` has to stay the whole of what
  // `forgetAccount` and `capAccount` match on — that prefix is
  // `key.slice(0, key.indexOf(':') + 1)` in `cache.js`, and a version holds no
  // colon, so neither of them can see the difference.
  const windowKey = `${start}:${end}:${summaryEnd}:${archived}`;
  const keyAt = (version) => `${user}:${version}:${windowKey}`;
  const arg = { user, start, end, summaryEnd, archived };

  // The memo holds the SERIALISED payload, so a hit skips a `JSON.stringify` of
  // up to ~580 KB as well as the five queries — on a single-threaded server that
  // is everyone's latency, which is what `runtime.loop_blocked` is watched for.
  // It is also what makes `sizeOf` exact rather than an estimate, and it means
  // no two callers can ever be handed the same mutable object.
  //
  // `type` before `send`: `res.send` of a STRING defaults the content type to
  // text/html, where `res.json` would have set it. With it set first the two
  // are byte-identical — no `json replacer` or `json spaces` is configured on
  // this app, and `overview-memo.integration.mjs` asserts a hit and a miss
  // agree on status, content type and body.
  res.type('application/json');

  // **The version read is unconditional, and there is no path around it.** An
  // earlier draft skipped it while `pool.waitingCount > 0` and served a recent
  // entry unchecked, to keep a memo hit free on the far side of the pool cliff
  // (`docs/decisions/caching.md` still has the measurements, as an operator
  // note). It bought that latency with the one property this route exists to
  // have: a tap taken on replica A, whose refetch lands on a busy B, is
  // answered from B's pre-tap entry — the user's own tap painted away, which
  // the deleted `X-Habiterall-Fresh` header could not do at any pool depth.
  //
  // **What that costs is a latency cliff up to `PG_POOL_MAX` and a 5xx past
  // it**, and the second half is worth knowing before it is met. A hit used to
  // touch Postgres zero times, so it was answered however saturated the pool
  // was; now it queues, and `connectionTimeoutMillis` (5 s, `db/pool.js`) is
  // what ends the queue — with a rejection, not a slow answer. `networkFirst`
  // in `sw.js` only falls back to the saved dashboard from the `catch` around
  // its `fetch`, so a 500 that arrives is shown as an error. That is the
  // accepted price of the read being unconditional rather than a case to
  // special-case here: `docs/decisions/caching.md` has the three regimes, why
  // a bail-out is the wrong shape, and what to build if it is ever reached.
  //
  // One transaction for the version and, if it comes to it, the data.
  const held = await withUser(user, async (db) => {
    // **The version is read BEFORE the data, and never after.** `withUser` is
    // READ COMMITTED, so these are separate snapshots and the order decides
    // which way an interleaved write can be wrong.
    //
    // Version FIRST: a write committing after this line and before the queries
    // below leaves an entry tagged with the OLD version holding the NEW data.
    // Nobody will ever ask for that key again — the next reader reads the bumped
    // version and misses — so the entry is unreachable and the answer is rebuilt.
    //
    // Version LAST would be the mirror image and is the reason this comment is
    // here rather than in a commit message: the entry would be tagged with the
    // NEW version holding data read before the write, every later reader would
    // ask for exactly that key, and all of them would be served the stale
    // payload for the whole 60 s TTL. One line of ordering, silent in the worse
    // direction, which is the failure #192 exists to remove rather than move.
    const { rows: [row] } = await db.query(
      `SELECT data_version FROM users WHERE id = $1`, [user]);
    // A missing row is an account deleted mid-request; RLS answers the queries
    // below with nothing anyway, so 0 keeps the key well formed rather than
    // spelling `undefined` into it.
    const key = keyAt(row?.data_version ?? 0);

    // Which of the three cases this is decides whether the connection now in
    // hand is wanted — see `memo.peek` in `cache.js`. Synchronous, so nothing
    // can change between asking and acting.
    const hit = overviewMemo.peek(key);
    // Somebody else is already building this exact key. Join it OUTSIDE the
    // transaction: waiting in here would hold one connection per waiter for the
    // length of one rebuild, which is the burst this memo exists to collapse
    // spending the pool it exists to protect.
    if (hit && 'inflight' in hit) return { pending: hit.inflight };
    // A hit. This transaction did one primary-key lookup and is done with the
    // connection — which is the cost the bench prices at 0.3 ms.
    if (hit && 'value' in hit) return { json: hit.value };
    // A miss, so the rebuild runs on THIS connection and the version read above
    // was free: it shared the checkout the five queries were going to make
    // anyway. Awaited in here, because `db` is only alive until this returns.
    return { json: await overviewMemo(key, { db, ...arg }) };
  });

  res.send('json' in held ? held.json : await held.pending);
}));

/**
 * The whole of what `/overview` returns, as a function of its inputs alone.
 *
 * Split out of the route so the memo above has something to memoise, and so
 * nothing in here can reach for `req` — a payload that depended on a header the
 * key does not carry is the one way this cache can be wrong.
 *
 * **It is HANDED a transaction rather than opening one** (#192). The route has
 * already checked out a connection to read `data_version` — that read has to
 * come first and it has to be a real one — so opening a second here would make
 * every miss cost two checkouts to save nothing. The caller's `withUser` is
 * what scopes these queries; `user` is still passed because two of them name it
 * for the planner, not because RLS needs telling twice.
 *
 * @param {import('pg').PoolClient} db a transaction already scoped to `user`
 * @param {{user: number, start: string, end: string, summaryEnd: string,
 *   archived: boolean}} arg
 */
async function buildOverview(db, { user, start, end, summaryEnd, archived }) {
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
  if (!habits.length) {
    // Same key shape as the full path below: `categorySummaries` is absent
    // only in archived mode, never merely because there is nothing to
    // summarise yet — an empty category still draws its header.
    return {
      start, end, categories, habits: [],
      ...(archived ? {} : { categorySummaries: summariseByCategory(categories, [], new Map(), summaryEnd) }),
    };
  }

  const ids = habits.map((h) => h.id);

  // One answer for the account, read once for the whole payload — the map
  // below runs per habit and this is not a per-habit question.
  const { rows: [prefs] } = await db.query(
    `SELECT settings ->> 'atMostUnlogged' AS unlogged FROM users WHERE id = $1`,
    [user]
  );
  const unlogged = unloggedFrom(prefs);

  // The grouped lifetime `MIN(date)` read `/categories/stats` already runs
  // (same shape, line 453 there), reused here so a section header can tell
  // "never logged" from "scored zero" — the bounded windows below cannot
  // answer that, and `first_date` is used for a null check only, never
  // `addDays` or `dateRange` (root CLAUDE.md). Skipped entirely in archived
  // mode: that fetch has nothing active to average, so `categorySummaries`
  // is omitted below rather than computed and discarded.
  const { rows: firstRows } = archived ? { rows: [] } : await db.query(
    `SELECT habit_id, to_char(MIN(date), 'YYYY-MM-DD') AS first_date
     FROM entries WHERE habit_id = ANY($1) GROUP BY habit_id`,
    [ids]
  );
  const firstEntry = new Map(firstRows.map((r) => [r.habit_id, r.first_date]));

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

  const habitPayloads = habits.map((h) => {
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
  });

  // The mean is over `habitPayloads`' own `score` — the same number drawn
  // on the row beneath each header — never a second scoring pass. See
  // `summariseByCategory` (`@habiterall/shared/stats.js`) for the partition
  // rule.
  return {
    start,
    end,
    categories,
    habits: habitPayloads,
    ...(archived ? {} : { categorySummaries: summariseByCategory(categories, habitPayloads, firstEntry, summaryEnd) }),
  };
}

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

  const merged = await withUserWrite(uid(req), (db) =>
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
  await withUserWrite(uid(req), (db) =>
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
  // `withUserWrite` over a SELECT, deliberately. This route writes nothing
  // `/overview` reads — its own storage write is `notify_status`, through
  // `recordOutcome` — so the bump buys nothing here and costs one dashboard
  // rebuild. It is uniformity that is being bought: the invalidation middleware
  // above already forgets on this route for exactly the same reason, and the
  // property worth keeping is "a non-safe route bumps", which survives the next
  // route being added. Over-bumping costs a recomputation; under-bumping serves
  // stale data for the whole TTL and nothing reports it.
  const settings = await withUserWrite(uid(req), (db) =>
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
    const { rows: categoryRows } = await db.query(
      `SELECT id, name, color, position FROM categories ORDER BY position, id`);
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

  const body = buildCsvArchive(withCategory, (id) => byHabit.get(id) ?? [], categoryRows);

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
  const parsedCategories = backupCategories(buf);
  const result = await applyImport(uid(req), habits, mode, parsedCategories ?? []);
  // `categorySkip` is set only for a zip whose `Categories.csv` carried
  // nothing usable — see its own comment in `backupCategories`. Added here
  // rather than in `apply-import.js`, which never sees the file's raw
  // category rows, only the already-repaired list handed to it above.
  if (parsedCategories?.categorySkip) result.skipped.push(parsedCategories.categorySkip);

  // Replace mode only — "make this account look like the file". A merge adds
  // habits to what is already here and must not rewrite the rest of the
  // account's preferences. Through parseSettings, so an uploaded file cannot
  // store a value the API itself would refuse; and through withUserWrite, so it
  // is the caller's own row and no one else's that RLS will let it reach. A
  // replace-mode import therefore bumps twice — once in `applyImport`'s own
  // transaction and once here — which is a recomputation nobody notices, where
  // sharing one bump between two transactions would mean choosing which of them
  // announces the other's write.
  let settings = 0;
  if (mode === 'replace') {
    const raw = backupSettings(buf);
    // Filtered before the validator — see the personal edition's route for what
    // an unfiltered file could do to a reader's notification settings.
    const { accepted } = raw ? parseSettings(portableSettings(raw)) : { accepted: {} };
    if (Object.keys(accepted).length) {
      await withUserWrite(uid(req), (db) => db.query(
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
