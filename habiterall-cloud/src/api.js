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
import { backupEnabled } from './backup.js';
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
import { backupSettings, parseUpload } from '@habiterall/shared/import.js';
import { UNSET, YES, SKIP } from '@habiterall/shared/constants.js';
import {
  parseHabit, parseEntry, parseSettings, portableSettings, entryWrite, assertDate,
  assertNotFuture, parseCategory, parseCategoryId, foldCategoryName, LIMITS,
  DATE_RE, queryDate,
} from '@habiterall/shared/validate.js';
import {
  computeStats, summaryStats, creditAnchor, isCompleted,
  UNLOGGED_DEFAULT,
  unansweredCounts, today, addDays, daysBetween, MAX_RANGE_DAYS,
  computeCategoryStats, SCORE_WARMUP_DAYS, MAX_COMPARE_DAYS, COMPARE_WINDOW_DAYS,
  summariseByCategory,
} from '@habiterall/shared/stats.js';
import {
  STREAK_HISTORY_DAYS, recomputeBestStreak, stripSummaryCache, summaryCacheHit,
} from '@habiterall/shared/summary-cache.js';
import { computeAwards } from '@habiterall/shared/awards.js';
import { resolveHabitSort, needsLastMiss, sortHabitPayloads } from '@habiterall/shared/habit-order.js';

export const api = express.Router();

const SUMMARY_WINDOW_DAYS = 400;

// `STREAK_HISTORY_DAYS` used to be declared here and is imported from
// `@habiterall/shared/summary-cache.js` now, with its whole comment: the window
// is part of what the CACHED figure MEANS, so a bound that drifted between the
// editions would have them store two different numbers under one name.

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
      // memo saves is the TRANSACTION — a pool checkout and three round trips —
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

/**
 * A habit row on its way OUT to a client.
 *
 * Named to mirror the personal edition's `toApiHabit`, which exists for a
 * problem this edition does not have — SQLite's 0/1 `archived` against
 * Postgres's real BOOLEAN — so the two functions do different work under one
 * name on purpose: one boundary per edition, asked at the same places.
 *
 * What both do is drop the summary-cache columns. Every habit query here is
 * `SELECT *` or `RETURNING *`, deliberately (see `/export` below for why), so
 * the day those columns exist they are in client JSON unless something takes
 * them out — and they are the server's own observations about the cost of
 * deriving a figure, in the category `data_version` is in. They belong to no
 * `*_HABIT_FIELDS` list, `parseHabit` has never heard of them, and
 * `PORTABLE_HABIT_KEYS` in `test/api.integration.mjs` is the tripwire that says
 * so out loud.
 *
 * @template {Record<string, any>} T
 * @param {T} row
 * @returns {T}
 */
const toApiHabit = (row) => stripSummaryCache(row);

/* ---------- habits ---------- */

api.get('/habits', route(async (req, res) => {
  const archived = req.query.archived === 'true';
  const rows = await withUser(uid(req), (db) =>
    db.query(
      `SELECT * FROM habits WHERE archived = $1 ORDER BY position, id`,
      [archived]
    ).then((r) => r.rows)
  );
  res.json(rows.map(toApiHabit));
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

  res.status(201).json(toApiHabit(created));
}));

api.get('/habits/:id', route(async (req, res) => {
  const habit = await getHabit(req);
  res.json(toApiHabit(habit));
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
  // Narrowed: this route REPLACES, so `type`, `target_*` and `freq_*` can all
  // move — the completion rule itself changing, and both cached figures are
  // derived through it. One habit's, though; nothing here reaches another row.
  }, { habits: [id] });

  if (!updated) throw httpError(404, 'habit not found');
  res.json(toApiHabit(updated));
}));

api.delete('/habits/:id', route(async (req, res) => {
  const id = habitId(req);
  const gone = await withUserWrite(uid(req), (db) =>
    db.query(`DELETE FROM habits WHERE id = $1 RETURNING id`, [id])
      .then((r) => r.rowCount > 0)
  // Narrowed, and the narrowing is what makes this cheap rather than what
  // makes it correct: REMOVING a habit cannot change another habit's cached
  // pair, so clearing the account was strictly wasted work — and it was the
  // sole cause of a measured `habitDel x habitDel` deadlock, two deletions of
  // different habits each taking the other's row lock through an account-wide
  // clear. The clear on the row about to be deleted is a row write a moment
  // before a row deletion, which is a wasted update and never a wrong answer;
  // it stays because it is also the statement that takes this transaction's
  // `habits` lock BEFORE it reaches `users`, which is the one lock order this
  // edition has (see `withUserWrite`).
  , { habits: [id] });
  if (!gone) throw httpError(404, 'habit not found');
  res.status(204).end();
}));

api.post('/habits/reorder', route(async (req, res) => {
  // The account's own order has to be MANUAL for a permutation of it to mean
  // anything, and that has to be asked HERE rather than left to the clients.
  // `paint()` gates the drag handle on the sort (`shared/public/ui/dashboard.js`)
  // and Android hides its own reorder affordance, but a client gate is only ever
  // advisory: the APK ships separately from the server, so an OLD build against
  // a NEW one is the ordinary state after a release rather than a contrived
  // case, and that build has never heard of `habitSort`. It would offer the
  // drag, send the permutation, and rewrite every `position` the account has —
  // silently, because the sorted list it is looking at does not read `position`
  // and so shows nothing at all happening.
  //
  // 409 rather than 400: the body is well-formed and the ids are real, and what
  // is wrong is the account's state at the moment it arrived. It is also the
  // answer the outbox wants — `shared/public/offline.js` drops every 4xx but
  // 401 and 403 as permanently inapplicable, which is exactly right for a
  // reorder issued against a list that is not manually ordered. Replaying it
  // later cannot make it apply.
  //
  // **Read in its own `withUser` BEFORE `withUserWrite`, and that placement is
  // a lock-order decision rather than a style one.** Every mutating path in
  // this edition reaches `habits` before `users` — `withUserWrite` pre-clears
  // the summary stamp for exactly that reason, `ORDER BY id` in an explicit
  // `LockRows` pass — and `PUT /settings` going `users -> habits` alone once
  // deadlocked five pairs of ordinary routes into 500s on somebody's tap, which
  // nothing in either edition handles. A `SELECT` of `users.settings` inside
  // `fn` would take no ROW lock and so could not close a cycle by itself, but
  // it would put a `users` statement in the middle of a `habits` write on the
  // one route whose whole job is to rewrite `habits` rows, and the next reader
  // would have to re-derive that argument to know it was safe. Asking before
  // the write transaction opens means the question does not arise: the read
  // commits first, and a refusal opens no write transaction at all.
  //
  // The cost is one extra checkout on a route a human reaches by dragging a row,
  // not on a dashboard load — and the refusal path is now the cheaper of the
  // two. What it buys instead of a consistent snapshot is a window: the setting
  // can change between the read and the write, so a reorder can be accepted as
  // the account switches to a sort, or refused as it switches back. Both are
  // self-correcting on the client's next `/overview`, and neither writes an
  // order anybody is looking at — which is why this is stated rather than
  // closed with a `FOR SHARE` that would put a `users` row lock ahead of
  // `habits` and reintroduce precisely the inversion above.
  const sort = resolveHabitSort(await withUser(uid(req), (db) =>
    db.query(`SELECT settings ->> 'habitSort' AS habit_sort FROM users WHERE id = $1`, [uid(req)])
      .then((r) => r.rows[0]?.habit_sort)
  ));
  if (sort !== 'manual') {
    throw httpError(409, `habits are ordered by ${sort}; set habitSort to manual to reorder`);
  }

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

  // Hoisted out of `fn` so it can narrow the clear below. RLS still confines
  // both the update and the clear to the caller's own habits, so an id
  // belonging to someone else simply matches nothing in either.
  const ids = order.map((id) => Number(id));

  const rows = await withUserWrite(uid(req), async (db) => {
    // One statement instead of a round trip per id.
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
  // Narrowed to the habits this request actually named, rather than removed.
  // Reordering moves `position` and nothing either cached figure is derived
  // from, so the clear is not doing correctness work here — but every write in
  // this edition clears SOMETHING, and a route that opted out would be the one
  // place a future field added to the pair had no invalidation. Narrowing is
  // what makes keeping it cheap. `[]` still means the whole account
  // (`withUserWrite`), which is the right answer for a request that named no
  // habit at all: it writes nothing, so over-clearing costs one recomputation.
  }, { habits: ids });

  res.json(rows.map(toApiHabit));
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
    // Two lifetime dates per habit out of one grouped read: the earliest row of
    // any kind, which decides where a member's window OPENS, and the earliest
    // row that states a value, which decides where silence inside it starts
    // counting as success (#223). The second is a lifetime question for exactly
    // the reason the first is — the slice fetched above cannot answer either.
    // The FILTER matches `firstStatedAnswer` in `shared/src/stats.js`:
    // `COALESCE(status, '') <> 'skip'`, so a numerical habit's legitimate 3 is
    // still a stated value.
    const { rows: firstRows } = ids.length ? await db.query(
      `SELECT habit_id,
              to_char(MIN(date), 'YYYY-MM-DD') AS first_date,
              to_char(MIN(date) FILTER (WHERE COALESCE(status, '') <> 'skip'),
                      'YYYY-MM-DD') AS first_answer
       FROM entries WHERE habit_id = ANY($1) GROUP BY habit_id`,
      [ids]
    ) : { rows: [] };

    const byHabit = new Map(ids.map((id) => [id, []]));
    for (const r of entryRows) byHabit.get(r.habit_id).push(r);
    const firstEntry = new Map(firstRows.map((r) => [r.habit_id, r.first_date]));
    const firstAnswer = new Map(firstRows.map((r) => [r.habit_id, r.first_answer]));

    return computeCategoryStats(
      categories,
      habits.map((h) => ({
        habit: h,
        entries: byHabit.get(h.id) ?? [],
        // `?? null`, and never left absent: an omitted key tells
        // `computeCategoryStats` to derive the answer from the entries it was
        // given, which is the truncated slice this route deliberately fetched.
        firstEntry: firstEntry.get(h.id) ?? null,
        // Same rule, same reason: absent would mean "derive it from the
        // truncated slice", where `null` is the answer that the habit has
        // never stated one.
        firstAnswer: firstAnswer.get(h.id) ?? null,
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

  const storedNotes = await withUserWrite(uid(req), async (db) => {
    if (write.op === 'delete') {
      await db.query(`DELETE FROM entries WHERE habit_id = $1 AND date = $2`,
        [habit.id, date]);
      return '';
    }
    const { rows } = await upsertEntry(db, uid(req), habit.id, date, write.value, write.status, write.notes);
    // #298's returned row and #184's narrowed clear are the same statement and
    // the same call. A merge that kept one and dropped the other would revert a
    // shipped fix, and no test fails for the absence of the one it kept.
    return rows[0].notes;
  // Narrowed, and this is the call site the narrowing exists for: a tap is the
  // dominant dashboard interaction, and clearing the account would cost the
  // other nineteen habits their cached pair on every one.
  }, { habits: [habit.id] });

  res.json({ habit_id: habit.id, date, ...write.reply, notes: storedNotes });
}));

api.delete('/habits/:id/entries/:date', route(async (req, res) => {
  await getHabit(req);
  if (!DATE_RE.test(req.params.date)) throw httpError(400, 'date must be YYYY-MM-DD');

  await withUserWrite(uid(req), (db) =>
    db.query(`DELETE FROM entries WHERE habit_id = $1 AND date = $2`,
      [habitId(req), req.params.date]),
    // Narrowed, for the reason the PUT above is. A day going back to `unknown`
    // moves both figures exactly as answering it did.
    { habits: [habitId(req)] }
  );
  res.status(204).end();
}));

function upsertEntry(db, userId, habitId, date, value, status, notes) {
  // notes is bound once and referenced twice: the VALUES-side COALESCE
  // collapses an absent (NULL) note to '' for a fresh row, and the conflict
  // clause reads that same NULL as "leave the stored note alone" — it cannot
  // go through EXCLUDED.notes, which the VALUES-side COALESCE has already
  // flattened to '' by the time the conflict clause could see it.
  return db.query(
    `INSERT INTO entries (habit_id, user_id, date, value, status, notes)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,''))
     ON CONFLICT (habit_id, date) DO UPDATE
       SET value = EXCLUDED.value,
           status = EXCLUDED.status,
           notes = COALESCE($6, entries.notes)
     RETURNING notes`,
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
    habit: { ...toApiHabit(habit), unlogged_is_success: unansweredCounts(habit, unlogged) },
    ...stats,
    awards: computeAwards(stats, end, habit, unlogged, skipDays),
  });
}));

/**
 * Every habit's awards, over its full lifetime — the account-level
 * counterpart to the `awards` field on `GET /habits/:id/stats` (#140).
 * `docs/decisions/awards.md` already names the reason this exists: "Portfolio
 * awards read every habit at once and belong to an account-level route." This
 * route is that account-level route, but it does NOT implement portfolio
 * awards (#63) itself — `account` below is reserved for them.
 *
 * No `start`, no `end` query param, no `granularity`: this route takes none.
 * `end` is always the caller's today, and `computeStats` is handed no
 * `start` at all, so `resolveWindow` opens each habit's window at its own
 * earliest REAL entry, clamped to `MAX_RANGE_DAYS` — the identical treatment
 * `/habits/:id/stats` gives a request that names no `start`, which is what
 * the detail view sends. A narrower ceiling here would silently cap `tenure`
 * (which counts years) and `coverage` (which counts perfect months) and break
 * the agreement between the two routes, which is the whole point of this one.
 *
 * No `granularity` either: in `stats.js` it reaches only `history`, which
 * this route declines outright (see the opt-out note below), so there is no
 * pass left for it to reach.
 *
 * Every habit, archived included, exactly as `/categories/stats` reads them —
 * filtering here would be as wrong as it is there.
 *
 * A pure read inside one `withUser`, as `/categories/stats` does — no
 * statement here may touch a write path. Do not call `withUserWrite`, bump
 * `data_version` or write the per-habit summary cache from this handler.
 */
api.get('/awards', route(async (req, res) => {
  const end = callerToday(req);

  const payload = await withUser(uid(req), async (db) => {
    const { rows: habits } = await db.query(
      `SELECT * FROM habits ORDER BY position, id`
    );

    const { rows: [prefs] } = await db.query(
      `SELECT settings ->> 'weekStart'      AS week_start,
              settings ->> 'atMostUnlogged' AS unlogged,
              settings ->> 'skipDays'       AS skip_days
         FROM users WHERE id = $1`,
      [uid(req)]
    );
    const weekStart = /** @type {'monday'|'sunday'} */ (
      prefs?.week_start === 'sunday' ? 'sunday' : 'monday');
    const unlogged = unloggedFrom(prefs);
    // A real read of the stored setting, never a literal — it gates the
    // whole rest award, and a hard-coded value would hand (or deny) it to
    // every account regardless of what they asked for.
    const skipDays = prefs?.skip_days === 'true';

    const ids = habits.map((h) => h.id);
    const { rows: entryRows } = ids.length ? await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
       FROM entries WHERE habit_id = ANY($1) ORDER BY date`,
      [ids]
    ) : { rows: [] };
    const byHabit = new Map(ids.map((id) => [id, []]));
    for (const r of entryRows) byHabit.get(r.habit_id).push(r);

    return {
      habits: habits.map((habit) => {
        const entries = byHabit.get(habit.id) ?? [];
        // `computeAwards` (below) reads only `bestStreak`, `score`, `scores`,
        // `resilience`, `weekdays`, `streaks` and `coverage` off `stats` — see
        // the opt-out note above `computeStats` (shared/src/stats.js). This
        // route walks EVERY habit on the account, so `history`,
        // `weekdayByMonth` and `frequency` are declined: they are built and
        // thrown away on every call otherwise, measured at 66% of a habit's
        // cost. `coverage` stays `true` because `computeAwards` reads it for
        // the coverage award.
        const stats = computeStats(habit, entries, {
          end, weekStart, unlogged,
          history: false, weekdayByMonth: false, frequency: false,
        });
        return {
          id: habit.id,
          name: habit.name,
          color: habit.color,
          awards: computeAwards(stats, end, habit, unlogged, skipDays),
        };
      }),
      // Reserved for #63's portfolio awards, which read every habit at once
      // rather than one — always empty until that ships. A top-level object
      // rather than a bare array is what lets them land here additively.
      account: [],
    };
  });

  res.json(payload);
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
 * `entries` grid of up to 365 dated keys per habit, plus `skips`, plus `notes`
 * (issue #297: a bounded array of the same dated keys that hold a note — never
 * the note TEXT, which is up to 500 characters and would multiply this figure
 * rather than round it). Measured with `--expose-gc`, retained after a
 * collection: **499 KB** at 20 habits × 365 days and **1.2 MB** at 50 × 365.
 * Ten thousand of those is ~4.9 GB, and this edition's container dies with
 * every tenant on it.
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
  // `habitSort` is a new input, read out of `users.settings` inside
  // `buildOverview` itself — it is NOT spelled into `windowKey` below. That is
  // deliberate rather than an omission: `PUT /settings` is a write through
  // `withUserWrite`, which bumps `data_version` in the same transaction as the
  // setting change, so every memo entry built under the OLD sort is keyed at a
  // version no reader will ever ask for again. This sentence is load-bearing —
  // without that bump, changing the sort would go on serving the memoised old
  // order, and the dashboard would look simply broken. `test:dataversion` is
  // what guards it.
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
    const dataVersion = row?.data_version ?? 0;
    const key = keyAt(dataVersion);

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
    //
    // `dataVersion` is NOT handed to the rebuild, and it used to be. The
    // write-back was the only thing that wanted it, and its guard is now the
    // per-habit `summary_epoch` the habits read already carries (migration 019,
    // and `writeBackSummaries` for why the account-level counter could not do
    // the job). The counter is still what `keyAt` built the memo key from, one
    // screen up; it simply has no second consumer.
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
 * **Two of the four per-row figures are read off the habit instead of derived**
 * (#184). `bestStreak` and `totalCompleted` are statements about the habit's
 * WHOLE history, so neither can change between two loads on the same day unless
 * something was written — and a write is what clears `summary_asof`
 * (`withUserWrite`, `db/pool.js`). What follows is the same payload either way:
 * a habit whose stamp is the caller's own day is served its stored pair, and
 * every other habit is recomputed and has the answer written back.
 *
 * @param {import('pg').PoolClient} db a transaction already scoped to `user`
 * @param {{user: number, start: string, end: string, summaryEnd: string,
 *   archived: boolean}} arg no `dataVersion`: the write-back was its only
 *   consumer in here and is now guarded on the per-habit `summary_epoch` the
 *   habits read below already carries
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

  // One answer for the account, read once for the whole payload — the map
  // below runs per habit and this is not a per-habit question. `habitSort`
  // rides on the same query rather than a second one — see the KDoc on
  // `windowKey` above for why it is not in the memo key, and
  // shared/src/habit-order.js for why it is read from the stored setting
  // rather than a `?sort=` parameter at all.
  //
  // Read even with no habits below, and BEFORE the empty-habit return —
  // `habitSort` is the RESOLVED sort every return path must carry (issue
  // #200 review): an absent key on the wire has to mean "a server with no
  // sort feature at all", which is only true if no current server, on any
  // path, ever omits it.
  const { rows: [prefs] } = await db.query(
    `SELECT settings ->> 'atMostUnlogged' AS unlogged,
            settings ->> 'habitSort'      AS habit_sort
       FROM users WHERE id = $1`,
    [user]
  );
  const unlogged = unloggedFrom(prefs);
  const habitSort = resolveHabitSort(prefs?.habit_sort);

  if (!habits.length) {
    // Same key shape as the full path below: `categorySummaries` is absent
    // only in archived mode, never merely because there is nothing to
    // summarise yet — an empty category still draws its header. `habitSort`
    // is present here too, for the same reason as the full path — see above.
    return {
      start, end, categories, habits: [], habitSort,
      ...(archived ? {} : { categorySummaries: summariseByCategory(categories, [], new Map(), summaryEnd) }),
    };
  }

  const ids = habits.map((h) => h.id);

  // `manual`, almost every request, needs no extra pass at all — see
  // `needsLastMiss`.
  const wantsLastMiss = needsLastMiss(habitSort);
  /** @type {Map<number, string|null>} */
  const lastMissById = new Map();

  // The grouped lifetime read `/categories/stats` also runs (same shape, line
  // 453 there), reused here for two things the bounded windows below cannot
  // answer. `first_date` lets a section header tell "never logged" from "scored
  // zero", and is used for a null check only, never `addDays` or `dateRange`
  // (root CLAUDE.md). `first_answer` is whether the habit has EVER stated a
  // value, which is what decides where silence starts counting as success
  // (#223) — a lifetime question that a 400- or 1830-day slice holding nothing
  // but skips would answer "never" for a habit that answered years ago.
  //
  // It therefore runs in ARCHIVED mode too, where it used to be skipped because
  // `categorySummaries` is omitted there: the figures on each row are computed
  // either way, so the read has a second consumer now and skipping it would
  // make the archived view the one place these figures are wrong.
  const { rows: firstRows } = ids.length ? await db.query(
    `SELECT habit_id,
            to_char(MIN(date), 'YYYY-MM-DD') AS first_date,
            to_char(MIN(date) FILTER (WHERE COALESCE(status, '') <> 'skip'),
                    'YYYY-MM-DD') AS first_answer
     FROM entries WHERE habit_id = ANY($1) GROUP BY habit_id`,
    [ids]
  ) : { rows: [] };
  const firstEntry = new Map(firstRows.map((r) => [r.habit_id, r.first_date]));
  const firstAnswer = new Map(firstRows.map((r) => [r.habit_id, r.first_answer]));

  // **The partition, and everything below reads off it** (#184). A habit whose
  // `summary_asof` is the CALLER's own day already carries both lifetime
  // figures, so it needs neither the 1830-day read nor a row in the lifetime
  // aggregate. `summaryCacheHit` is where the comparison lives, and it is
  // equality rather than `<=` for a reason worth reading there: `summaryEnd`
  // moves backwards for an account used from two zones.
  const staleIds = habits.filter((h) => !summaryCacheHit(h, summaryEnd)).map((h) => h.id);
  // The complement, and it is what stops a stale habit paying twice. The
  // 1830-day window CONTAINS the 400-day one, so issuing the summary read for
  // every habit made a stale one fetch its most recent 400 days in BOTH
  // queries: ~2,230 days per habit on the cold path — the first load of any
  // day, when nothing is fresh, which is the load a user actually waits on —
  // where master shipped 1,830. A ~22% regression on exactly the request this
  // cache exists to make faster, hidden behind the win on the warm path. So a
  // stale habit derives its recent slice from the wide one it already has
  // (`all.filter`, which is what master did), and this query is for the fresh
  // habits alone.
  const staleSet = new Set(staleIds);
  const freshIds = ids.filter((id) => !staleSet.has(id));

  // One query for the grid window, one for the summary window, and — only if
  // something is stale — one for the streak scan, rather than two per habit.
  const { rows: windowRows } = await db.query(
    `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status,
            COALESCE(notes, '') <> '' AS has_note
     FROM entries WHERE habit_id = ANY($1) AND date BETWEEN $2 AND $3
     ORDER BY date`,
    [ids, start, end]
  );
  // The 400-day summary window, for the FRESH habits: `score` and
  // `currentStreak` are read over it and neither is cached, so every habit
  // needs the slice — but a stale one gets it out of the streak read below
  // instead. On the cold path this query is not issued at all. No upper bound,
  // exactly as before — an import can create future-dated rows and adding one
  // here would change an answer rather than only a cost.
  const cutoff = addDays(summaryEnd, -SUMMARY_WINDOW_DAYS);
  const { rows: recentRows } = freshIds.length ? await db.query(
    `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
     FROM entries WHERE habit_id = ANY($1) AND date >= $2 ORDER BY date`,
    [freshIds, cutoff]
  ) : { rows: [] };

  // Bounded, NOT lifetime. This query had no date predicate, so an account
  // with years of history shipped every row to Node and then spent ~850ms
  // of SYNCHRONOUS CPU per request in computeStreaks — blocking the event
  // loop for every other tenant. `boundedRange` caps the date SPAN, not the
  // row count, so it was no help here.
  //
  // STREAK_HISTORY_DAYS bounds what the streak scan reads. A streak longer
  // than this reports as capped rather than reading the whole table; the
  // count below is done in SQL instead of in JS.
  //
  // This read still serves the summary window for the habits it covers, by
  // filtering it down in JS — see `recent` below. What the cache changes is
  // WHICH habits it covers: a dashboard whose habits are all fresh issues this
  // query not at all, and 1,430 days of rows per habit stop being shipped to
  // Node to be discarded.
  const streakFrom = addDays(summaryEnd, -STREAK_HISTORY_DAYS);
  const { rows: allRows } = staleIds.length ? await db.query(
    `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
     FROM entries WHERE habit_id = ANY($1) AND date >= $2 ORDER BY date`,
    [staleIds, streakFrom]
  ) : { rows: [] };

  // Lifetime totals in the database, where counting is what it is for.
  // Postgres applies the same completion rule the shared code does; the
  // status check keeps skips out, matching isCompleted returning null.
  //
  // Scoped to the stale ids, which is the whole of the saving here — this is
  // the aggregate with no date predicate at all, so it reads every row the
  // account has ever written and gets dearer as the account ages. The `CASE`
  // itself is untouched: it mirrors `isCompleted`, personal's copy differs in
  // one commented way, and a third copy of the completion rule is #195.
  const { rows: totalRows } = staleIds.length ? await db.query(
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
    [staleIds]
  ) : { rows: [] };
  const totals = new Map(totalRows.map((r) => [r.habit_id, r.completed]));

  const grid = new Map(ids.map((id) => [id, {}]));
  const skips = new Map(ids.map((id) => [id, []]));
  // Dates only, never the text (issue #297): the memo below measures 499 KB
  // for 20 habits x 365 days, and a note is up to 500 characters. A skipped
  // day can still carry a note, so this is pushed outside the skip/not-skip
  // branch rather than inside one arm of it.
  const notesDates = new Map(ids.map((id) => [id, []]));
  for (const r of windowRows) {
    if (r.status === 'skip') {
      grid.get(r.habit_id)[r.date] = SKIP;
      skips.get(r.habit_id).push(r.date);
    } else {
      grid.get(r.habit_id)[r.date] = r.value;
    }
    if (r.has_note) notesDates.get(r.habit_id).push(r.date);
  }

  // `byHabit` holds the 1830-day slice and so has an entry only for a STALE
  // habit; `recentByHabit` holds the 400-day one and has an entry for every
  // habit. Two maps rather than one filtered per habit, which is what the split
  // above buys.
  const byHabit = new Map(staleIds.map((id) => [id, []]));
  for (const r of allRows) byHabit.get(r.habit_id).push(r);
  const recentByHabit = new Map(ids.map((id) => [id, []]));
  for (const r of recentRows) recentByHabit.get(r.habit_id).push(r);

  /**
   * @type {Array<{id: number, best_streak: number, total_completed: number,
   *   summary_epoch: number}>}
   */
  const recomputed = [];

  const habitPayloads = habits.map((h) => {
    // Fresh or stale decides which of the two reads above covers this habit,
    // and it is asked ONCE, here, so nothing below can answer it differently.
    // `byHabit` is keyed on `staleIds`, so holding a slice IS being stale.
    const fresh = !byHabit.has(h.id);
    const all = byHabit.get(h.id) ?? [];
    // **The 400-day slice comes from a different place for each half, and that
    // is the whole of why the two queries above are disjoint.** A FRESH habit
    // was in `recentRows` and nothing else; a STALE one was in `allRows`, whose
    // 1830-day window CONTAINS this one, so it filters its own rather than
    // being fetched twice. Issuing the recent query for every habit instead
    // made a stale habit fetch its last 400 days in BOTH — ~2,230 days per
    // habit on the cold path, where master shipped 1,830 — which is a
    // regression on precisely the request this cache exists to speed up.
    //
    // Reading `recentByHabit` unconditionally is the other way to get this
    // wrong and it is far worse than a cost: a stale habit is absent from
    // `recentRows`, so `recent` is `[]`, and `summaryStats` over no entries
    // answers `score: 0, currentStreak: 0`. Every habit is stale on the first
    // load of a day and after every write, so that is the dashboard blanking
    // its two live figures on the load a user actually watches, while
    // `bestStreak` and `totalCompleted` beside them stay right.
    const recent = fresh
      ? (recentByHabit.get(h.id) ?? [])
      : all.filter((e) => e.date >= cutoff);
    // Two numbers are read below — `score` and `currentStreak` — so this
    // calls `summaryStats` rather than `computeStats`: the same window and
    // the same two passes (`computeScores`, `computeStreaks`), with the
    // five passes `computeStats` also runs — `computeHistory`,
    // `computeWeekdays`, `computeWeekdayByMonth`, `computeFrequency`,
    // `computeResilience` — never started, once per habit, on the
    // dashboard's hot path. Awards are out of this route for the same
    // reason, stated at the `/stats` call site above.
    // **One credit date for all three figures on this row** (#223), resolved
    // from the account's LIFETIME first stated answer rather than from either
    // slice above. Both slices are bounded — 400 days for the summary, 1830 for
    // the streak scan — and "has this habit ever answered?" is not a question a
    // bounded window can answer: a limit habit answered 500 days ago and skipped
    // since holds nothing but a skip inside the 400-day slice, which would read
    // as no evidence at all. Measured: 0.051922 on this row against 1.000 on the
    // habit's own page, with `bestStreak` on this same payload disagreeing with
    // both because its wider slice could see the answer. Derived once and
    // shared, so the three figures cannot disagree by construction.
    const creditFrom = creditAnchor(firstAnswer.get(h.id) ?? null, summaryEnd);

    const stats = summaryStats(h, recent, {
      end: summaryEnd, unlogged, creditFrom, lastMiss: wantsLastMiss,
    });
    // Collected while each row is built rather than in a second pass over
    // `habitPayloads`: `stats.lastMiss` is absent unless `wantsLastMiss` asked
    // for it (see `summaryStats`), and `?? null` is what keeps an absent key
    // from becoming `undefined` in the map `sortHabitPayloads` reads below.
    if (wantsLastMiss) lastMissById.set(h.id, stats.lastMiss ?? null);

    // The cached pair, or the derivation it was cached from — off the same
    // `fresh` the slice above was chosen by, so a habit cannot be served a
    // stored `bestStreak` over a window it was told it had to recompute.
    //
    // `recomputeBestStreak` is the shared block (`summary-cache.js`), handed
    // the SAME `creditFrom` the summary above got rather than a second one
    // derived from its wider slice — the two disagree exactly when the habit's
    // answer falls between the two windows (#223).
    const bestStreak = fresh
      ? h.best_streak
      : recomputeBestStreak(h, all, { summaryEnd, unlogged, creditFrom });
    const totalCompleted = fresh ? h.total_completed : (totals.get(h.id) ?? 0);
    if (!fresh) {
      // `summary_epoch` comes off the row this recompute was derived FROM, and
      // it is the write-back's whole guard (see `writeBackSummaries`). It rides
      // on the row for free: `buildOverview`'s habits read is `SELECT *`, so
      // the column costs no extra query and no extra round trip.
      recomputed.push({
        id: h.id,
        best_streak: bestStreak,
        total_completed: totalCompleted,
        summary_epoch: h.summary_epoch,
      });
    }

    return {
      ...toApiHabit(h),
      entries: grid.get(h.id) ?? {},
      skips: skips.get(h.id) ?? [],
      notes: notesDates.get(h.id) ?? [],
      score: stats.score,
      currentStreak: stats.currentStreak,
      bestStreak,
      totalCompleted,
      // Same field, same reason as the `/stats` call site above: resolved
      // server-side because no renderer can import `unansweredCounts`, and
      // derived rather than stored.
      unlogged_is_success: unansweredCounts(h, unlogged),
    };
  });

  // Everything that was recomputed goes back on the row, so the next load on
  // this day reads it instead of deriving it again. A WRITE on a GET, and
  // deliberately not through `withUserWrite` — see `writeBackSummaries`.
  if (recomputed.length) {
    await writeBackSummaries(db, user, summaryEnd, recomputed);
  }

  // The mean is over `habitPayloads`' own `score` — the same number drawn
  // on the row beneath each header — never a second scoring pass. See
  // `summariseByCategory` (`@habiterall/shared/stats.js`) for the partition
  // rule.
  //
  // `categorySummaries` is built from `habitPayloads` in its UNSORTED,
  // `position, id` order, and the display sort is applied only to the
  // `habits` array returned below — never fed back into this call. That
  // ordering is what `sortHabitPayloads` returning a new array (rather than
  // sorting in place) exists to make safe: the mean and member counts must
  // not move depending on what the account's `habitSort` happens to be.
  //
  // The sort also comes AFTER `writeBackSummaries` above, and that ordering
  // is safe rather than merely convenient: `writeBackSummaries`' `candidates`
  // CTE takes its row locks `ORDER BY id`, precisely so that the order this
  // function hands rows over in cannot influence its lock order (see the KDoc
  // above `writeBackSummaries`). Reordering the payload here adds no
  // statement to that write and touches no lock.
  const categorySummaries = archived
    ? undefined
    : summariseByCategory(categories, habitPayloads, firstEntry, summaryEnd);

  return {
    start,
    end,
    categories,
    // The RESOLVED sort that actually ordered `habits` below, not the raw
    // stored string — echoed so both clients can gate reordering on the same
    // response the order itself came from, rather than a separately fetched
    // setting that can disagree with it (issue #200 review).
    habitSort,
    habits: sortHabitPayloads(habitPayloads, habitSort, lastMissById),
    ...(categorySummaries ? { categorySummaries } : {}),
  };
}

/**
 * Stamp the recomputed lifetime pairs onto the habit rows — unless anything
 * committed since the version we read.
 *
 * **This is a WRITE ON A GET and it must not bump `data_version`.** There is
 * exact precedent one screen up: the device-zone middleware writes
 * `users.device_time_zone` on GETs through bare `withUser` and deliberately
 * does not bump (`docs/decisions/caching.md`, "One write deliberately does not
 * bump"). Bumping here would invalidate the memo entry this very call is in the
 * middle of filling — a rebuild loop that never converges — and would break the
 * control assertion `test:dataversion` rests on, that a READ leaves the counter
 * alone. So: no `withUserWrite`, ever, on this path.
 *
 * **The `summary_epoch` predicate is the whole of why this is a named
 * function.** `withUser` is READ COMMITTED, so a write committing between the
 * entry reads above and this statement has already set `summary_asof = NULL` —
 * and without a guard we would immediately write it back, stamped as of TODAY,
 * from pre-write data. That is the "version last" failure `caching.md`
 * describes: it is silent, and it survives until the calendar day rolls over.
 * Zero rows update if anything moved, and the next load recomputes — wasteful
 * and correct, which is the direction this repo always picks.
 *
 * **The guard used to be the ACCOUNT's `data_version` and it could not hold.**
 * Written as a correlated subquery on `users`, it correlated to `$1` and to
 * nothing on the habits scan, so the planner hoisted it into an InitPlan behind
 * a One-Time Filter ABOVE the scan — evaluated once, cached in a PARAM_EXEC
 * slot, and so not a per-row qual at all. When this statement blocks on a
 * concurrent writer's row lock and resumes after it commits, Postgres re-checks
 * the qual against the newly committed TARGET tuple (EvalPlanQual); EPQ cannot
 * re-run an InitPlan, so the stale figures were stamped anyway. The commoner
 * interleaving needed no EPQ at all: `withUserWrite`'s clear carried
 * `AND summary_asof IS NOT NULL`, so with the stamp already NULL — the state
 * after every write — it took no row lock and this statement never blocked.
 * Measured over the real routes, `/overview` then served `totalCompleted=5`
 * against a ground truth of 6, on every replica, until the day rolled over.
 *
 * `summary_epoch` (migration 019) is a per-habit counter that
 * `withUserWrite`'s clear advances unconditionally. The predicate is on the
 * TARGET relation's own column, compared against the value read off the same
 * row this recompute was derived from, so EPQ re-checks it — and it is
 * per-habit, which is what invalidation has always been: a tap on habit A no
 * longer refuses the write-back for the other nineteen, because a tap on A
 * cannot move B's lifetime figures.
 *
 * The epoch rides on each ROW rather than as one scalar for the whole call, so
 * the join carries it: `$6` is a parallel array, and a habit whose epoch moved
 * drops out on its own while the rest are stamped.
 *
 * **`SKIP LOCKED` is why this statement never WAITS, and that is a separate
 * property from the guard above.** The guard decides whether a stamp is still
 * VALID. This decides whether the statement is willing to queue for the chance
 * to write one, and the answer is no.
 *
 * A deadlock needs a wait-for CYCLE, so every party in it has to be waiting.
 * There are only ever two parties here, and they are not equals. The clear in
 * `withUserWrite` is MANDATORY — it is correctness, it is on every write, and
 * it must take its row locks and hold them to the COMMIT. This is
 * OPPORTUNISTIC: it is a cache stamp on a GET, and losing one costs exactly one
 * recomputation on the next load. So the two do not need to agree on a row
 * ORDER, which was the shape of the residual after the clear was reordered —
 * this statement walks `ORDER BY position, id` while an un-narrowed clear
 * seq-scans in ctid order, and where those disagreed the two deadlocked, with
 * `reorder x settings` the worst case because `reorder` permutes `position`
 * while this reads it. Instead the DISCARDABLE party declines to wait at all,
 * and a party that never waits cannot be in a cycle.
 *
 * The `candidates` CTE takes the row locks with `SKIP LOCKED`, so any habit a
 * concurrent write already holds is dropped from the statement rather than
 * queued behind. The outer UPDATE then only ever touches rows this transaction
 * already holds at sufficient strength, so it does not wait either.
 *
 * **BOTH halves are load-bearing, and the first draft of this comment claimed
 * otherwise.** It said `SKIP LOCKED` was doing all the work and the `ORDER BY
 * id` was kept only for determinism. The mutation — remove `SKIP LOCKED`, keep
 * the CTE and the sort — measured that wrong, and they turn out to fix
 * DIFFERENT things:
 *
 *  - **`ORDER BY id` is what removed the write-back-versus-clear cycle.**
 *    Without the CTE this statement locked rows in the order `buildOverview`
 *    handed them over, which is `ORDER BY position, id` — and `position` is the
 *    column `POST /habits/reorder` exists to permute. So the write-back's lock
 *    order was being actively scrambled by another route while a clear
 *    seq-scanned in ctid order. Sorting by `id` decouples the order from a
 *    column anybody can reorder. Measured: `catDel x habitPutCat` 4 deadlocks
 *    before, 0 with the sort alone.
 *  - **`SKIP LOCKED` is what removed the WAITING**, and the waiting is most of
 *    the cost. With the sort but no `SKIP LOCKED`, `reorder x settings`
 *    completed 16 operations in 8 seconds against 12,505 with it — a ~780x
 *    difference — and its deadlocks were 9 against 3.
 *
 * Neither half is decoration, and a future reader removing the sort because
 * "nothing waits, so order cannot matter" would be repeating this comment's own
 * first mistake.
 *
 * `FOR NO KEY UPDATE`, not `FOR UPDATE`, and the difference is the skip rate.
 * `FOR UPDATE` conflicts with `FOR KEY SHARE`, which is what the `entries`
 * foreign key takes on a habit row — so it would skip a habit merely because
 * somebody was writing an ENTRY against it, which is the commonest write there
 * is. `FOR NO KEY UPDATE` is the strength an UPDATE that changes no key column
 * takes anyway, so it conflicts with exactly the writers whose row this would
 * be fighting over and with none of the readers.
 *
 * One cost is real and is accepted: a candidate whose epoch HAS moved is locked
 * by the CTE and then rejected by the outer guard, so this briefly holds a row
 * lock it makes no use of. It cannot deadlock on it — it never waits — and the
 * transaction is a dashboard read that ends immediately. The alternative,
 * folding the epoch into the CTE, would put the validity test back on the
 * pre-lock side of a `LockRows` node, which is the shape this whole guard
 * exists to avoid.
 *
 * A race is not deterministically reachable through the HTTP surface, so the
 * guard would be untestable inside `buildOverview`. Exported, it can be called
 * with a deliberately stale epoch, which is what
 * `test/summary-cache.integration.mjs` does — and it can be raced for real
 * against a forced interleaving, which is what
 * `test/summary-race.integration.mjs` does.
 *
 * @returns {Promise<number>} how many habit rows were stamped — which is now
 *   at most `rows.length` rather than exactly the ones that passed the guard: a
 *   row a concurrent write held was SKIPPED, and is simply left unstamped for
 *   the next load to recompute. A caller cannot tell the two apart from this
 *   number, and nothing needs to.
 *
 * @param {import('pg').PoolClient} db a transaction already scoped to `userId`
 * @param {string} summaryEnd the day the pairs were computed FOR — the stamp
 * @param {Array<{id: number, best_streak: number, total_completed: number,
 *   summary_epoch: number}>} rows each row's `summary_epoch` as it was on the
 *   habit row this recompute read (`pool.js` parses BIGINT as a Number, so it
 *   is a JS number). An absent one arrives as NULL, which equals nothing, so a
 *   caller that forgot it writes no row at all — the safe direction, and a
 *   cache that is never filled rather than one that is filled wrongly
 */
export async function writeBackSummaries(db, userId, summaryEnd, rows) {
  if (!rows.length) return 0;
  const result = await db.query(
    `WITH candidates AS (
        SELECT id FROM habits
         WHERE user_id = $1 AND id = ANY($3::bigint[])
         ORDER BY id
           FOR NO KEY UPDATE SKIP LOCKED
     )
     UPDATE habits h
        SET best_streak = v.best_streak,
            total_completed = v.total_completed,
            summary_asof = $2
       FROM (SELECT * FROM unnest($3::bigint[], $4::int[], $5::int[], $6::bigint[])
               AS t(id, best_streak, total_completed, summary_epoch)) v,
            candidates c
      WHERE h.id = v.id
        AND h.id = c.id
        AND h.user_id = $1
        AND h.summary_epoch = v.summary_epoch`,
    [userId, summaryEnd, rows.map((r) => r.id), rows.map((r) => r.best_streak),
     rows.map((r) => r.total_completed), rows.map((r) => r.summary_epoch)]
  );
  return result.rowCount ?? 0;
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

/**
 * The API surface is identical in both editions by promise, and `enabled` is
 * the field that carries the capability difference (issue #75). This
 * edition DOES take a scheduled backup on the same tick as its reminders —
 * a whole-database `pg_dump`, not a per-account export — because N accounts
 * under RLS have no privileged per-account export path here and the dump is
 * instance-level operator state with no owning account. So this route
 * carries the ONE bit a caller may be told — whether this instance is
 * configured to take scheduled backups at all — and nothing else:
 *
 * - `schedule`, `keep` and `last` are `null` for every caller, on purpose.
 *   In the personal edition the one account IS the operator; here every
 *   caller is one of N untrusted tenants, and the schedule, the retention
 *   count and a failure classification are the OPERATOR's business, not
 *   any one tenant's. There is no operator/admin identity in this edition —
 *   `requireAuth` gives `req.session.user` and nothing else — so "show the
 *   operator more" has nowhere to hang.
 * - Cloud keeps NO status record — not module state, not a table — only an
 *   in-memory `lastAttemptDate` in `backup.js` used for the day's dedupe. The
 *   operator's log is the durable record of how a run went. See
 *   `habiterall-cloud/CLAUDE.md`'s "Scheduled backups" section for why there
 *   is no table (no `data_version` bump on a nightly write, no new lock-order
 *   question for `withUserWrite`, and no tenancy case for state no tenant may
 *   read).
 * - It reads no table, so it needs no RLS policy, no grant, no migration
 *   and no tenancy-suite case, and `enabled` costs nothing to compute.
 *
 * Per-account restore, point-in-time recovery and replicas remain #240.
 */
api.get('/backup/status', route(async (req, res) => {
  res.json({ enabled: backupEnabled(), schedule: null, keep: null, last: null });
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
      //
      // `toApiHabit` drops the summary-cache columns for the second half of
      // that same argument, and they are the case that proves the `SELECT *`
      // still has to be paid for: migration 018 added three columns which are
      // the SERVER's observations rather than the habit's, so a query that
      // takes everything needs an explicit list of what a backup does not
      // carry. One list, in `shared/src/summary-cache.js`, so this route and
      // the seven others cannot each drop a different subset.
      data: habits.map((row) => {
        const { user_id, ...h } = toApiHabit(row);
        return {
          ...h,
          category: categoryNames.get(h.category_id) ?? '',
          entries: byHabit.get(h.id) ?? [],
        };
      }),
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

/**
 * The Loop-shaped CSV archive: `Habits.csv` + `Checkmarks.csv`, plus
 * `Categories.csv` when the account has any categories (#257). See the
 * personal edition's `/export.csv` for the whole reasoning, including why
 * that third member is optional.
 */
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

  const { habits, categories } = await parseUpload(buf);
  if (!habits.length) throw httpError(400, 'no habits found in the uploaded file');

  // `[]`, never `null`, for a format with nowhere to carry a category — see
  // the personal edition's route and `apply-import.js`'s own comment for why
  // a habit's `category` is resolved against this by NAME rather than by any
  // id the file happens to carry. `categories` is `parseUpload`'s own second
  // return value now (#282), out of the zip branch's one unzip rather than a
  // second one.
  const result = await applyImport(uid(req), habits, mode, categories ?? []);
  // `categorySkip` is set when the file's categories carried nothing usable, or
  // when more were declared than `LIMITS.categories` allows — see its own
  // comment in `backupCategories`. Added here rather than in `apply-import.js`,
  // which never sees the file's raw category rows, only the already-repaired
  // list handed to it above.
  //
  // UNSHIFTED, not pushed. `applyImport` has already filled `skipped` with one
  // line per bad row, and the dialog renders `slice(0, 8)` and then "…and N
  // more" — so an import that also carries eight bad dates would hide the one
  // message this whole channel exists for behind the ellipsis, and a
  // hand-edited file is precisely the shape that has both.
  if (categories?.categorySkip) result.skipped.unshift(categories.categorySkip);

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
