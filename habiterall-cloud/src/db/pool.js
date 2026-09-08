/**
 * Postgres connection pool and the tenancy boundary.
 *
 * Every request-scoped query MUST go through `withUser`, which sets
 * `app.user_id` on the connection for the life of a transaction. The
 * Row-Level Security policies read that setting, so a query that forgets its
 * WHERE clause returns nothing instead of another user's rows.
 *
 * A query that WRITES goes through `withUserWrite` instead, which is `withUser`
 * plus the account's `data_version` bump and its habits' cached summary figures
 * being invalidated, both in the same transaction.
 */

import pg from 'pg';
import { log } from '@habiterall/shared/log.js';
import { assertConnectionString } from './url.js';

const { Pool } = pg;

// Return DATE columns as 'YYYY-MM-DD' strings rather than JS Dates, which
// would be reinterpreted in the server's timezone and shift by a day.
pg.types.setTypeParser(1082, (v) => v);
// BIGINT as a Number: ids here stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

// Before the pool, not on its first query — see url.js for what that
// difference cost.
assertConnectionString(process.env.DATABASE_URL, 'DATABASE_URL');

/**
 * How long one statement may run before Postgres cancels it.
 *
 * Nothing bounded a query before this. One pathological statement held one of
 * ten pool connections until it finished or the client went away — and what
 * reached the operator was OTHER requests failing their five-second checkout
 * with a connection-timeout error naming nothing about the query responsible.
 * The cause is invisible and the effect is everywhere, which is the confusing
 * direction.
 *
 * Fifteen seconds is a DEFAULT rather than a measurement, and it is env-settable
 * for that reason. The routes able to want more are the ones reading unbounded
 * history — `/export`, `/export.csv`, `/export-loop.db` all read every row an
 * account has — so an instance holding a decade for somebody may need to raise
 * this, or those three may want their own longer timeout set per transaction.
 * What is not defensible is the number that was here before, which was none.
 */
const STATEMENT_TIMEOUT_MS = timeoutFromEnv('PG_STATEMENT_TIMEOUT_MS', 15_000);

/**
 * How long a transaction may sit open doing nothing.
 *
 * The cheaper of the two to choose, and the more important: it fires only when
 * a transaction is open and idle, which `withUser` should never produce. So
 * anything this kills is a bug — an `fn` that awaited something non-database
 * in the middle of a transaction, holding a pool connection across it.
 */
const IDLE_IN_TRANSACTION_MS = timeoutFromEnv('PG_IDLE_TX_TIMEOUT_MS', 30_000);

/**
 * A Postgres timeout parameter, from the environment.
 *
 * `Number(env) || fallback` is the idiom next door at `PG_POOL_MAX` and it is
 * wrong for these two, because **0 is a value Postgres has a meaning for**: it
 * is how you say "no timeout". Through `||` that spelling silently becomes the
 * default — so the one setting this file's own documentation tells an operator
 * to reach for, when an export of a very long history is being cancelled, is
 * the one setting that cannot be made. `PG_POOL_MAX=0` has no such meaning,
 * which is why the idiom is fine there and only there.
 *
 * Anything not a non-negative finite number is the default, and says so: a
 * typo in a compose file must not silently remove a bound, and it must not
 * remove it quietly either.
 *
 * The key is a parameter, so the two names are nowhere near the read and
 * nothing scanning this file could find them — which is what the marker below
 * is for, and what `compose.test.js` fails without.
 *
 * @env PG_STATEMENT_TIMEOUT_MS PG_IDLE_TX_TIMEOUT_MS
 *
 * @param {string} name
 * @param {number} fallback
 */
function timeoutFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    // `setting` and `given` rather than `name` and `value`, which the logger
    // redacts as PII — this warning exists to name the typo, and a line
    // reading `name: [redacted]` names nothing.
    log.warn('pg.timeout_env_ignored', { setting: name, given: raw, using: fallback });
    return fallback;
  }
  return ms;
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Passed through by `pg` as connection parameters, so they apply to every
  // session the pool opens rather than needing a SET per checkout.
  statement_timeout: STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_MS,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

/**
 * The two timeouts, for the startup log.
 *
 * They belong beside `pg_pool_max` for the same reason it is there: they are
 * numbers an operator needs to see without reading the source, and a query
 * cancelled at fifteen seconds is otherwise indistinguishable from one that
 * failed for any other reason.
 */
export const poolTimeouts = () => ({
  pg_statement_timeout_ms: STATEMENT_TIMEOUT_MS,
  pg_idle_tx_timeout_ms: IDLE_IN_TRANSACTION_MS,
});

pool.on('error', (err) => {
  // An idle client erroring must not take the process down.
  log.error('pg.client_error', err);
});

/**
 * The pool, as numbers to graph.
 *
 * `waiting` is the one that matters and the one nothing else reveals: a request
 * queued for a connection is indistinguishable from a slow query in a latency
 * chart, and the fix is the opposite one. It goes non-zero when `max × replicas`
 * has outgrown what Postgres will hand out, which is exactly the wall a
 * scaled-out deployment hits first.
 */
export function poolGauge() {
  return {
    pg_total: pool.totalCount,
    pg_idle: pool.idleCount,
    pg_waiting: pool.waitingCount,
    pg_max: pool.options?.max ?? null,
  };
}

/**
 * SQLSTATEs for the two timeouts above, so a cancellation can be named.
 *
 * `57014` is `query_canceled` and `25P03` is
 * `idle_in_transaction_session_timeout`.
 */
const TIMEOUT_CODES = {
  57014: 'pg.statement_timeout',
  '25P03': 'pg.idle_tx_timeout',
};

/**
 * Log a cancelled query as the thing it is, then leave the error alone.
 *
 * Without this the timeouts above trade one anonymous failure for another. The
 * problem they were added for was that a pathological statement showed up as
 * OTHER requests failing their checkout, "naming nothing about the query
 * responsible" — and a bare 500 out of `57014` names nothing either.
 *
 * Logged, not converted. A 503 would tell the offline outbox the write is
 * retryable, and a statement that cannot finish in the time allowed will not
 * finish on the replay either — so the honest answer to the client is still
 * the 500 it was already getting. What changes is only that the operator can
 * tell "we gave up on it" from "it broke", which is the whole difference
 * between raising `PG_STATEMENT_TIMEOUT_MS` and going looking for a bug.
 *
 * The `pg` error carries the SQLSTATE and the message; it is passed through as
 * the error argument so the log keeps both.
 *
 * @param {any} err
 * @param {object} context
 */
function noteTimeout(err, context) {
  // `Object.hasOwn`, per the root CLAUDE.md's rule, and `withoutUser` is what
  // makes it more than pedantry: it wraps arbitrary callbacks — the session
  // store, the IdP-subject lookup — so the error reaching here is not always
  // one `pg` raised, and `err.code` is not always a SQLSTATE. A plain lookup
  // resolves `constructor` and `toString` to functions and `__proto__` to an
  // object, each of them truthy, so an unrelated error would be logged as a
  // cancellation with a non-string event name.
  const code = String(err?.code);
  const event = Object.hasOwn(TIMEOUT_CODES, code) ? TIMEOUT_CODES[code] : null;
  if (!event) return;
  log.error(event, {
    ...context,
    // The POOL's setting, which is the number an operator would change. A
    // transaction that set its own with `SET LOCAL` is the one case where this
    // is not the limit that actually fired, so it is named for what it is
    // rather than for what it usually means.
    pool_limit_ms:
      event === 'pg.statement_timeout' ? STATEMENT_TIMEOUT_MS : IDLE_IN_TRANSACTION_MS,
  }, err);
}

/**
 * Take a connection, and NAME the failure when one cannot be had.
 *
 * **A checkout failure is the one pool event with nothing to recognise it by.**
 * All three helpers below call `pool.connect()` BEFORE their `try`, deliberately
 * — there is no client to roll back or release yet — so the rejection escapes
 * past `noteTimeout` entirely. And `noteTimeout` could not have named it in any
 * case: it matches SQLSTATEs, and this error never reached Postgres to be given
 * one. What an operator saw was a 500 with nothing in the log but the request.
 *
 * That was survivable while it was rare. Since #192 it is not: `/overview` used
 * to answer a memo hit without touching Postgres at all, and now every request
 * reads `users.data_version` first, so a saturated pool produces this failure on
 * the busiest route in the app rather than only on the expensive one.
 * `docs/decisions/caching.md` asks for exactly that to be countable before
 * anyone decides whether the version read wants a pool of its own — a decision
 * nothing could inform while the event had no name.
 *
 * **The gauge is what tells the two causes apart, which is why it is logged
 * rather than a message match.** `pg` signals its own `connectionTimeoutMillis`
 * with a plain `Error` carrying no SQLSTATE and no code, so the alternative is
 * pattern-matching a library's prose — and the numbers are the better answer
 * anyway, since they say which knob moved rather than which branch fired.
 *
 * **`pg_total` against `pg_max` is the discriminator, and `pg_waiting` is not
 * part of it.** A pool too small reads `pg_total` at `pg_max`; a database that
 * is not there reads `pg_total` 0. The obvious third clause — "and somebody was
 * queued" — is the one that must NOT be written, because it is false in exactly
 * the case it describes: `pg` removes a request from its `_pendingQueue` inside
 * the `connectionTimeoutMillis` callback, BEFORE handing the error back, so the
 * waiter that timed out never counts itself. A lone waiter behind a full pool
 * therefore logs `pg_waiting: 0` at the moment it IS the saturation. It reads
 * non-zero only when several waiters are timing out together, which makes it a
 * corroborator of scale and never the thing that decides. `api.integration.mjs`
 * drives a real pool held at `max` and pins both halves.
 *
 * Logged and rethrown UNTOUCHED, the same rule `noteTimeout` states: a 503 here
 * would tell the offline outbox this write is retryable, and a pool that cannot
 * hand out a connection will not hand one out for the replay either.
 *
 * @param {string} scope which helper wanted it, so the log says what was refused
 * @returns {Promise<pg.PoolClient>}
 */
async function checkout(scope) {
  try {
    return await pool.connect();
  } catch (err) {
    log.error('pg.checkout_failed', { scope, ...poolGauge() }, err);
    throw err;
  }
}

/**
 * Run `fn` inside a transaction scoped to one user.
 *
 * `set_config(..., true)` is transaction-local, so the setting cannot leak to
 * the next borrower of this pooled connection.
 *
 * `BEGIN` and the `set_config` are issued as one multi-statement `query()`
 * call, folding what was four round trips around the body (`BEGIN`,
 * `set_config`, `fn`, `COMMIT`) into three. That relies on `userId` being
 * interpolated rather than bound — `pg`'s extended query protocol cannot
 * carry a bind parameter across a `;`-separated multi-statement string, only
 * the simple query protocol can — which is safe here ONLY because the guard
 * above requires the JS type `number`, not merely a value that LOOKS
 * numeric. **That guard is therefore both the correctness check and the
 * injection guard for this interpolation, and it is `Number.isInteger`'s
 * type test that is doing the guarding, not the arithmetic.** A template
 * literal calls `ToString` on `userId`, and a genuine JS number always
 * stringifies to plain digits (plus `-`, `.`, `e`, `+`) — nothing a SQL parser
 * reads as a second statement. (An id at or above `1e21` is the case that
 * needs `+`: `Number.isInteger(1e21)` is `true`, and `` `${1e21}` `` is
 * `"1e+21"`. That still cannot reach Postgres as anything but a loud failure —
 * the `::bigint` cast in `app_current_user_id()` rejects exponential notation
 * outright — and no real `users.id` gets anywhere near `1e21` regardless.)
 * Swap the type test for something coercive —
 * `Number.isFinite(Number(userId))`, say — and the two checks stop looking
 * at the same conversion: `Number(x)` calls `x.valueOf()`, `${x}` calls
 * `x.toString()`, and an object with a `valueOf` returning `1` and a
 * `toString` returning `"1'; DROP TABLE users; --"` sails through the
 * coercive check while the template embeds the second, malicious string
 * verbatim — confirmed in Node. `Number.isInteger` closes this because it
 * returns `false` for anything not already of type `number`, before either
 * conversion runs. Do not loosen this guard without re-deriving this
 * paragraph.
 *
 * @param {number} userId
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withUser(userId, fn) {
  // Both the correctness check AND the injection guard for the interpolation
  // below: `Number.isInteger` demands the JS type `number`, so a crafted
  // value can never reach the multi-statement query string below. Swapping
  // in a coercive check (e.g. `Number.isFinite(Number(userId))`) would not
  // reintroduce the same guarantee — see the doc comment above.
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('withUser requires a valid user id');
  }

  const client = await checkout('withUser');
  try {
    await client.query(`BEGIN; SELECT set_config('app.user_id', '${userId}', true)`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    noteTimeout(err, { scope: 'withUser', user: userId });
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * `withUser`, plus the account's `data_version` bump and the habit summary
 * cache being cleared, in the SAME transaction.
 *
 * Every write path opts into this by name. It is deliberately NOT a line inside
 * `withUser`, and the issue that asked for it got this wrong in a way worth
 * writing down: "every write already runs inside `withUser`, so there is
 * exactly one place to put it" is true of the writes and false of the function
 * — **`withUser` wraps the READS too**. A bump there would fire on every
 * `/overview`, every `/stats` and every `GET /habits`, which turns each of them
 * into a write, takes a row lock on `users` per read, and leaves a counter that
 * moves constantly while meaning nothing. The version's whole value is that it
 * changes when the DATA changes.
 *
 * **The same argument is what puts the summary-cache clear here rather than a
 * line further out or a line further in.** Inside `withUser` it would fire on
 * every read, and a dashboard that invalidates its own cache on being looked at
 * recomputes forever. Spread over a list of the mutating routes it would drift,
 * exactly as `docs/decisions/caching.md` says the memo's invalidation would: "a
 * list of the nine mutating routes is a list that drifts, and the two errors
 * are not symmetrical — forgetting too much costs a recomputation, forgetting
 * too little paints a user's own tap away." Here it inherits the enumeration
 * `test:dataversion` already holds every write path to, including the two that
 * never reach the `/api` router.
 *
 * So this is the same discipline as `forgetAccount`: a named thing a write path
 * calls, rather than a router or a wrapper it happens to be inside of.
 *
 * **Both extra statements share the write's COMMIT, and that is the correctness
 * property.** Outside the transaction the bump could be observed without the
 * write it announces (a reader tags a rebuild with the new version and fills it
 * from pre-write data) or the write could be observed without it (a reader is
 * served a stale entry that is still reachable). Inside, no reader can see one
 * without the other — and the clear cannot be rolled back while the write it
 * invalidates for commits.
 *
 * **The clear runs BEFORE `fn` and the bump AFTER, and that ordering is now a
 * correctness argument rather than a lock-hold one.** An earlier version issued
 * both after `fn`, reasoning that row locks held for the tail of a transaction
 * are cheaper than row locks held for all of it. True, and beside the point:
 * with the clear last, `habits` and `users` were locked in one order by every
 * write path except `PUT /settings`, whose own `fn` writes `users` first and
 * only then reached the account-wide clear on `habits`. That is a lock-order
 * INVERSION between two ordinary routes, and it deadlocks —
 *
 *     tap      : habits -> users
 *     settings : users  -> habits
 *
 * — with no `40P01` handling anywhere in this edition, so the victim surfaced
 * as an unhandled 500 on a user's tap. Measured over the real routes: five
 * pairs of write paths deadlocked (`settings x tap`, `tap x habitDel`,
 * `habitDel x habitDel`, `catDel x habitPutCat`, `reorder x settings`) where a
 * pre-#301 re-implementation with no clear at all deadlocked zero times in
 * every one of them, and `catDel x habitPutCat` throughput collapsed by two
 * orders of magnitude. `writeBackSummaries` — a write on a GET — appeared in
 * most of the observed cycles, so a DASHBOARD LOAD could deadlock.
 *
 * Moving the clear in front of `fn` gives every mutating path in this edition
 * ONE lock order BETWEEN THE TWO TABLES, `habits` then `users`, which is what
 * makes the table-level cycle unconstructible rather than merely rarer.
 * Measured after: `settings x tap`, `tap x habitDel` and `habitDel x habitDel`
 * all reach zero.
 *
 * **It does not settle the ROW order within `habits`, and that is a live
 * residual rather than a closed question.** `writeBackSummaries` locks the rows
 * `buildOverview` handed it, in `ORDER BY position, id`; an un-narrowed clear
 * has only a `user_id` predicate and no index leading on `user_id`, so it
 * seq-scans and locks in ctid order. Where those disagree the two deadlock, and
 * pre-clearing AMPLIFIED that pair (`reorder x settings`: 2 before, 8 after)
 * because the clear is now the first statement of every write and overlaps
 * maximally with concurrent dashboard loads. `docs/decisions/caching.md` has
 * the matrix, the cycle Postgres named, and the three candidate remedies —
 * each of which costs something and none of which is in this change.
 *
 * Pre-clearing is sound for every
 * path, and each way it could have been unsound is a case rather than a
 * worry: a habit CREATED inside `fn` did not exist to clear and has no cached
 * pair to invalidate (`summary_asof` and `summary_epoch` start at NULL and 0);
 * a habit DELETED inside `fn` is cleared a moment before it goes, which is
 * wasted work on one row and never a wrong answer; and the entry write's
 * foreign keys take `FOR KEY SHARE`, which does not conflict with the
 * `RowExclusiveLock` the clear already holds on the same habits row. Nothing
 * computes the id list inside `fn` either — `habits` is an OPTION, decided
 * before `fn` runs — so there is no path for which the clear needs `fn`'s
 * result.
 *
 * The lock-hold cost is real and is paid knowingly: concurrent writes by the
 * SAME account now queue on the clear at the top of the transaction rather
 * than at the tail. One account's writes serialising against each other is a
 * throughput note; two of them deadlocking is a 500.
 *
 * Either order still commits atomically, which is why this is an ordering
 * choice and not a transactional one.
 *
 * @param {number} userId
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @param {{habits?: number[] | null}} [opts] `habits` narrows the summary-cache
 *   clear to the ids the caller knows it touched. The default, `null`, clears
 *   every habit on the account: forgetting too much is the safe direction, and
 *   it is what a write path that says nothing gets. Narrowing is the whole
 *   performance point — one tap must not cost the other nineteen rows their
 *   cached pair — so a caller passes it only when it can name the habit.
 *   **An EMPTY array means the same as `null`**, not "clear nothing":
 *   `id = ANY('{}')` is false for every row, so the one spelling that fails in
 *   the unsafe direction is the one a caller reaches by computing an id list
 *   that happens to come out empty — and it would fail silently. The asymmetry
 *   the paragraphs above rest on decides it: over-clearing costs a
 *   recomputation, under-clearing serves a figure from before the write.
 * @returns {Promise<T>}
 * @template T
 */
export async function withUserWrite(userId, fn, { habits = null } = {}) {
  // See the JSDoc: `[]` is a caller that named no habit, which is a caller that
  // gets the whole account cleared.
  const narrowTo = habits?.length ? habits : null;
  return withUser(userId, async (client) => {
    // FIRST, so that `habits` is locked before `users` on every write path in
    // this edition — see the JSDoc above for the deadlock this ordering
    // removes and for why pre-clearing is sound on every path.
    //
    // The stamp alone is cleared, never the two figures: `summary_asof` is the
    // validity flag (see `shared/src/summary-cache.js`), so a stale pair left
    // beside a NULL stamp is unreadable rather than wrong, and the schema's
    // `habits_summary_cache_complete` CHECK is written to permit exactly that.
    //
    // **`summary_epoch` advances with the stamp, and there is deliberately no
    // longer an `AND summary_asof IS NOT NULL` beside it.** That predicate was
    // here to make the statement write no row, no WAL and no transaction id
    // when nothing was cached, the way the device-zone middleware's
    // `IS DISTINCT FROM` does — and it was the mechanism by which the
    // write-back's guard failed silently. When the stamp is already NULL, which
    // is the state after every write, the predicate matched no row: the clear
    // took NO ROW LOCK, so a concurrent `/overview` write-back never blocked on
    // it and never had its qual re-checked, and the stamp itself said nothing
    // either — the reader read NULL and the clear left NULL. The epoch is what
    // the reader compares now, so it has to advance whether or not there was a
    // stamp to clear, and the row has to be written so that the lock exists.
    // Migration 019's header has the measurement and the EvalPlanQual reason.
    //
    // The cost is one row write per habit in scope per account write, where a
    // dormant account previously paid none. It is bounded by the narrowing
    // below, and the update stays HOT-eligible because neither column is in any
    // index.
    await client.query(
      `UPDATE habits SET summary_asof = NULL, summary_epoch = summary_epoch + 1
        WHERE user_id = $1
          AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))`,
      [userId, narrowTo]);
    const result = await fn(client);
    await client.query(
      'UPDATE users SET data_version = data_version + 1 WHERE id = $1', [userId]);
    return result;
  });
}

/**
 * Run a read-only scan across users, for the reminder scheduler only.
 *
 * The notifier is the one job with no user to scope to: it must ask "who has a
 * server-delivered destination configured?" before it knows whose day to look
 * at. `withoutUser` cannot answer that — with no `app.user_id` set, the
 * `users_self` policy matches nothing and the scan returns zero rows, which is
 * RLS working correctly.
 *
 * So this sets a transaction-local `app.scope`, which migration 008's
 * `users_notifier_scan` policy requires. That policy is FOR SELECT and demands
 * `app_current_user_id() IS NULL`, so this can never widen a request already
 * scoped to a user, and it reaches no table but `users`. Once the scan has the
 * ids, per-user work goes back through `withUser` like everything else.
 *
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withNotifierScope(fn) {
  const client = await checkout('withNotifierScope');
  try {
    await client.query(`BEGIN READ ONLY; SELECT set_config('app.scope', 'notifier', true)`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    noteTimeout(err, { scope: 'withNotifierScope' });
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run a query with NO user context, for operations that legitimately span
 * users: migrations, session storage, and looking a user up by their IdP
 * subject before we know their id.
 *
 * Keep the surface of this function small — it bypasses the RLS boundary.
 */
export async function withoutUser(fn) {
  const client = await checkout('withoutUser');
  try {
    return await fn(client);
  } catch (err) {
    // A catch only so a cancellation here is named too — the session store and
    // the IdP-subject lookup run through this, and a timeout in either is the
    // shape hardest to recognise from the outside. Rethrown untouched; there
    // is no transaction to roll back.
    noteTimeout(err, { scope: 'withoutUser' });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Whether ERR is Postgres reporting `categories_user_name_key` (migration
 * 015's `UNIQUE INDEX ON categories (user_id, lower(name))`) refusing an
 * INSERT or UPDATE — the DB-level backstop firing on a race the route's own
 * `categoryNameTaken` check missed.
 *
 * `23505` is `unique_violation`'s SQLSTATE and is not enough on its own: any
 * unique index anywhere could raise it. Matched together with `constraint`,
 * the specific index name pg surfaces from the server's error fields, so a
 * caller cannot mistake some other table's collision (or a future second
 * constraint on this one) for a duplicate category name and quietly
 * swallow it.
 *
 * @param {any} err
 * @returns {boolean}
 */
export function isCategoryNameConflict(err) {
  return err?.code === '23505' && err.constraint === 'categories_user_name_key';
}

export async function closePool() {
  await pool.end();
}
