/**
 * Postgres connection pool and the tenancy boundary.
 *
 * Every request-scoped query MUST go through `withUser`, which sets
 * `app.user_id` on the connection for the life of a transaction. The
 * Row-Level Security policies read that setting, so a query that forgets its
 * WHERE clause returns nothing instead of another user's rows.
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
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 15_000;

/**
 * How long a transaction may sit open doing nothing.
 *
 * The cheaper of the two to choose, and the more important: it fires only when
 * a transaction is open and idle, which `withUser` should never produce. So
 * anything this kills is a bug — an `fn` that awaited something non-database
 * in the middle of a transaction, holding a pool connection across it.
 */
const IDLE_IN_TRANSACTION_MS = Number(process.env.PG_IDLE_TX_TIMEOUT_MS) || 30_000;

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
 * Run `fn` inside a transaction scoped to one user.
 *
 * `set_config(..., true)` is transaction-local, so the setting cannot leak to
 * the next borrower of this pooled connection.
 *
 * @param {number} userId
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withUser(userId, fn) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('withUser requires a valid user id');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', String(userId)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT set_config($1, $2, true)', ['app.scope', 'notifier']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
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
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
