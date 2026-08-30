/**
 * Postgres connection pool and the tenancy boundary.
 *
 * Every request-scoped query MUST go through `withUser`, which sets
 * `app.user_id` on the connection for the life of a transaction. The
 * Row-Level Security policies read that setting, so a query that forgets its
 * WHERE clause returns nothing instead of another user's rows.
 *
 * A query that WRITES goes through `withUserWrite` instead, which is `withUser`
 * plus the account's `data_version` bump in the same transaction.
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
 * `withUser`, plus the account's `data_version` bump, in the SAME transaction.
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
 * So this is the same discipline as `forgetAccount`: a named thing a write path
 * calls, rather than a router or a wrapper it happens to be inside of.
 *
 * **The bump shares the write's COMMIT, and that is the correctness property.**
 * Outside the transaction it could be observed without the write it announces
 * (a reader tags a rebuild with the new version and fills it from pre-write
 * data) or the write could be observed without it (a reader is served a stale
 * entry that is still reachable). Inside, no reader can see one without the
 * other.
 *
 * Issued AFTER `fn` rather than before, which is a lock-hold argument and not a
 * correctness one: the UPDATE takes a row lock on `users` that every concurrent
 * write by the same account then queues behind, so it is held for the tail of
 * the transaction rather than for all of it. Either order commits atomically.
 *
 * @param {number} userId
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withUserWrite(userId, fn) {
  return withUser(userId, async (client) => {
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
