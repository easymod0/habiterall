/**
 * The dashboard's two LIFETIME figures, cached on the habit row.
 *
 * `/overview` carries four figures per habit. Two of them — `score` and
 * `currentStreak` — are read over a bounded recent window and are cheap. The
 * other two are statements about the habit's WHOLE history and were re-derived
 * from scratch on every load: `bestStreak` walks `STREAK_HISTORY_DAYS` of days
 * per habit in synchronous JS, and `totalCompleted` is an aggregate with no
 * date predicate at all, so it reads every row the account has ever written and
 * gets steadily dearer as the account ages. Neither answer changes between two
 * loads on the same day unless something was WRITTEN, so both are stored beside
 * the habit — `best_streak`, `total_completed`, and `summary_asof`, the day
 * they were computed for — and the row the route already SELECTs carries them
 * at no extra query.
 *
 * The STORAGE half cannot live here: SQLite and Postgres, and the root
 * `CLAUDE.md` puts storage per edition on purpose. What lives here is the
 * RULE — what the cached pair means, when it is stale, and the recompute the
 * two editions would otherwise each spell for themselves. An edition deciding
 * any of those differently is two dashboards disagreeing about one habit, which
 * is the defect class this repo names most often.
 *
 * Pure logic: no storage, no HTTP, no DOM. See `docs/decisions/caching.md`.
 */

import { bestStreak, computeStreaks } from './stats.js';

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
 *
 * It lives here, imported by both editions, rather than being spelled once per
 * edition: the window is part of what the CACHED figure MEANS. A bound that
 * drifted in one edition would have the two store different numbers under one
 * name, and nothing about a stored figure says which window produced it.
 */
export const STREAK_HISTORY_DAYS = 1830;

/**
 * The three columns, in one list so that every reader and every stripper
 * agrees on what they are.
 *
 * They are NOT habit fields. They are observations the SERVER makes about the
 * cost of deriving a figure — the category `data_version` is in — so they
 * belong to no `*_HABIT_FIELDS` list, `parseHabit` knows nothing about them,
 * and they never reach a client or a backup. `stripSummaryCache` is how a
 * serialisation point says so.
 *
 * @type {readonly string[]}
 */
export const SUMMARY_CACHE_COLUMNS = Object.freeze([
  'best_streak',
  'total_completed',
  'summary_asof',
]);

/**
 * A habit row on its way OUT, without the cache columns.
 *
 * Non-destructive — both editions read a row and serialise a derivative of it
 * in the same handler, so removing the keys in place would take them off the
 * row the recompute is still reading. A falsy row is returned unchanged, the
 * way personal's `toApiHabit` already treats one.
 *
 * @template {Record<string, any>} T
 * @param {T} row
 * @returns {T}
 */
export function stripSummaryCache(row) {
  if (!row) return row;
  const out = { ...row };
  for (const column of SUMMARY_CACHE_COLUMNS) delete out[column];
  return out;
}

/**
 * Is this row's cached pair good for `summaryEnd`?
 *
 * `summary_asof` is the single validity flag, which is why the columns are
 * nullable and why a never-computed pair is not stored as `0`: a habit that
 * has genuinely never been completed has `total_completed = 0`, and collapsing
 * that into "no answer yet" is the same mistake `?? UNSET` is everywhere else
 * in this codebase. Invalidation clears the STAMP alone, so a stale pair sits
 * on the row beside a null `summary_asof` and must never be served.
 *
 * @param {Record<string, any>} row a habit row as storage returned it
 * @param {string} summaryEnd the day the caller wants the figures as of —
 *   `callerDay`, from the requesting device's own zone
 * @returns {boolean}
 */
export function summaryCacheHit(row, summaryEnd) {
  if (!row) return false;

  const asof = row.summary_asof;
  // A non-empty STRING or nothing: a null stamp is an invalidated row, and a
  // driver handing back something else (a `Date`, say, from a Postgres client
  // without `pg.types.setTypeParser(1082, …)`) is a shape this cannot compare
  // against a day and must not guess at. Both of those are a miss, which costs
  // a recomputation and never a wrong figure.
  if (typeof asof !== 'string' || asof === '') return false;

  // **`<>`, never `<`.** `summaryEnd` is the CALLER's day, so an account used
  // from two zones can move it BACKWARDS across a date boundary: a `<` test
  // would serve a device west of the last one a pair built for tomorrow, and
  // it would keep serving it all day. Equality is the only comparison that
  // makes a cache stamped with a day mean the day it says.
  if (asof !== summaryEnd) return false;

  // The stamp is the flag, but the figures are what gets served. A row failing
  // the schema's `habits_summary_cache_complete` CHECK — or one from an
  // edition whose migration ran halfway — recomputes rather than serving null
  // as a number.
  return row.best_streak !== null && row.best_streak !== undefined
    && row.total_completed !== null && row.total_completed !== undefined;
}

/**
 * `bestStreak` over the habit's history — the block both editions' `/overview`
 * would otherwise each spell.
 *
 * This scan is the route's own and never reaches `resolveWindow`, so it has to
 * be handed the same credit date explicitly — otherwise `bestStreak` is the one
 * figure on that payload still crediting silence the habit has no answer behind,
 * beside a `score` and a `currentStreak` that no longer do (#223: measured 365
 * here against 1 from `/stats`, same habit, same second). It must be the SAME
 * `creditFrom` the row's summary figures got, resolved by the caller from the
 * account's LIFETIME first stated answer, not a second one derived from the
 * slice handed in here — the two derivations disagree exactly when the habit's
 * answer falls between the two windows.
 *
 * @param {import('./types.js').Habit} habit
 * @param {Array<{date: string, value: number, status?: string}>} entries the
 *   habit's rows over the last `STREAK_HISTORY_DAYS`, in ASCENDING date order
 *   (which is what both editions' queries return): `entries[0]` is read as the
 *   start of the scan
 * @param {{summaryEnd: string, unlogged?: string, creditFrom?: string}} opts
 * @returns {number}
 */
export function recomputeBestStreak(habit, entries, { summaryEnd, unlogged, creditFrom }) {
  const entryMap = new Map(
    entries.map((e) => [e.date, { value: e.value, status: e.status }])
  );
  // No entries is not a zero-day window: the scan still runs over `summaryEnd`
  // itself, because on an at-most habit whose unanswered days count as success
  // that single day is a real streak of one.
  const streaks = computeStreaks(
    habit,
    entryMap,
    entries.length ? entries[0].date : summaryEnd,
    summaryEnd,
    unlogged,
    creditFrom
  );
  return bestStreak(streaks);
}
