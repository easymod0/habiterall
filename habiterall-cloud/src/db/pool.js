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

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
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
