#!/usr/bin/env node
/**
 * What the cloud edition's hot queries cost in POSTGRES, at a stated size.
 *
 *   DATABASE_URL=postgres://habiterall_app:apptestpw@localhost:5432/habiterall \
 *   ADMIN_URL=postgres://owner:testpw@localhost:5432/habiterall \
 *   node scripts/bench-queries.mjs
 *
 * `scripts/bench-overview.mjs` at the repo root measures the CPU `/overview`
 * spends inside `shared/src/stats.js` and says in its own header that query
 * cost is #185's — this is that half, and it is committed for the reason that
 * one is: an index change is justified by a plan, and a plan is only
 * comparable against another plan taken over the SAME fixture. The numbers in
 * #185's PR are falsifiable against this file and nothing else.
 *
 * ## It is DESTRUCTIVE, like the tenancy suite
 *
 * It empties `users`, `habits`, `entries` and `notify_log` and seeds its own
 * fixture, so point it at a throwaway database — the same one
 * `npm run test:tenancy` is pointed at, which already does the same thing.
 * It refuses to run against a database whose `users` table holds rows it did
 * not create, unless `--force` is passed.
 *
 * ## Every query is measured through the tenancy boundary
 *
 * The plans are taken as `habiterall_app` inside `withUser` /
 * `withNotifierScope`, never as the owner. That is the whole point: the RLS
 * `USING` clause is part of every plan the application can produce, and a plan
 * taken as a superuser — who bypasses RLS — is a plan of a query this app
 * never issues.
 *
 * ## What a forced plan proves and what it does not
 *
 * `--capability` re-runs each query with `enable_seqscan = off`. That answers
 * "can this index serve this predicate at all", which is a property of the
 * index definition and is what a test can pin. Whether the PLANNER CHOOSES it
 * is a function of table size and statistics, and that is what the default
 * (unforced) run reports. The two are different claims and this prints both.
 */

process.env.DATABASE_URL ??=
  'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';
const ADMIN_URL = process.env.ADMIN_URL ??
  'postgres://owner:testpw@localhost:5432/habiterall';

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const CAPABILITY = args.has('--capability');
const NO_SEED = args.has('--no-seed');

/* ---------- the fixture, stated as literals ---------- */

/**
 * Accounts. Large enough that a sequential scan of `users` is not free, which
 * is the condition finding #3 is about — on the two-row local stack the seq
 * scan is correct and the index would never be chosen.
 */
const USERS = 20_000;

/** Accounts with a server-delivered destination configured. 2.5% of the table. */
const NOTIFY_USERS = 500;

/** Accounts carrying habits and history. Kept well below USERS so the seed is quick. */
const ACTIVE_USERS = 200;

/** Habits per active account. */
const HABITS_PER_USER = 12;

/** Days of history per habit. */
const DAYS = 500;

/** Density of entries within that history, as tenths. 8 => 80%. */
const DENSITY_TENTHS = 8;

/** `KEEP_LOG_DAYS` in `src/notifier.js` — how deep the watermark table goes. */
const LOG_DAYS = 45;

/** The window `/overview` reads: SUMMARY_WINDOW_DAYS(400) + SCORE_WARMUP_DAYS. */
const WINDOW_START = '2025-06-01';
const WINDOW_END = '2026-05-31';

/** Fixed, so two runs a month apart compare. */
const HISTORY_START = '2025-01-01';
const LOG_START = '2026-05-01';

const pg = (await import('pg')).default;

/* ---------- seed ---------- */

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();

if (!NO_SEED) {
  const { rows: [pre] } = await admin.query(
    `SELECT count(*)::int AS n FROM users WHERE idp_issuer <> 'https://bench'`);
  if (pre.n > 0 && !FORCE) {
    console.error(
      `refusing to seed: users holds ${pre.n} row(s) this bench did not create.\n` +
      `Point ADMIN_URL at a throwaway database, or pass --force.`);
    await admin.end();
    process.exit(1);
  }

  console.log(`seeding: ${USERS} users, ${ACTIVE_USERS}x${HABITS_PER_USER} habits, ` +
    `${DAYS}d @ ${DENSITY_TENTHS * 10}% ...`);
  const t0 = Date.now();
  await admin.query('DELETE FROM notify_log');
  await admin.query('DELETE FROM notify_status');
  await admin.query('DELETE FROM entries');
  await admin.query('DELETE FROM habits');
  await admin.query('DELETE FROM categories');
  await admin.query('DELETE FROM users');

  await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, display_name, settings)
     SELECT 'bench-' || g, 'https://bench', 'Bench ' || g,
            CASE WHEN g <= $2 THEN '{"notifyChannels":["discord"]}'::jsonb
                 ELSE '{}'::jsonb END
       FROM generate_series(1, $1) g`,
    [USERS, NOTIFY_USERS]);

  await admin.query(
    `INSERT INTO habits (user_id, name, position, reminder_time)
     SELECT u.id, 'Habit ' || h, h, '08:00'
       FROM (SELECT id FROM users ORDER BY id LIMIT $1) u,
            generate_series(1, $2) h`,
    [ACTIVE_USERS, HABITS_PER_USER]);

  // Deterministic pseudo-random gaps: the arrangement of misses is identical
  // on every machine, so two runs differ only in what the schema changed.
  await admin.query(
    `INSERT INTO entries (habit_id, user_id, date, value, status)
     SELECT h.id, h.user_id, DATE '${HISTORY_START}' + d, 2, ''
       FROM habits h, generate_series(0, $1 - 1) d
      WHERE ((h.id * 7919 + d * 104729) % 10) < $2`,
    [DAYS, DENSITY_TENTHS]);

  await admin.query(
    `INSERT INTO notify_log (user_id, habit_id, channel, date)
     SELECT h.user_id, h.id, 'discord', DATE '${LOG_START}' + d
       FROM habits h, generate_series(0, $1 - 1) d`,
    [LOG_DAYS]);

  await admin.query('VACUUM ANALYZE users, habits, entries, notify_log');
  const counts = await admin.query(
    `SELECT (SELECT count(*) FROM users) AS users,
            (SELECT count(*) FROM habits) AS habits,
            (SELECT count(*) FROM entries) AS entries,
            (SELECT count(*) FROM notify_log) AS notify_log`);
  console.log(`  seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s:`,
    JSON.stringify(counts.rows[0]));
}

const { rows: [row] } = await admin.query(
  `SELECT u.id, (SELECT array_agg(h.id) FROM habits h WHERE h.user_id = u.id) AS habit_ids
     FROM users u WHERE EXISTS (SELECT 1 FROM habits h WHERE h.user_id = u.id)
    ORDER BY u.id LIMIT 1`);
if (!row) {
  console.error('no seeded account found — run without --no-seed first');
  await admin.end();
  process.exit(1);
}
// This client predates pool.js's BIGINT type parser, so ids arrive as strings.
const subject = { id: Number(row.id), habitIds: row.habit_ids.map(Number) };

/* ---------- the schema, as it stands ---------- */

const schema = await admin.query(
  `SELECT c.relname AS tbl, i.relname AS idx, pg_get_indexdef(i.oid) AS def,
          pg_relation_size(i.oid) AS bytes
     FROM pg_index x
     JOIN pg_class i ON i.oid = x.indexrelid
     JOIN pg_class c ON c.oid = x.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('entries','users','notify_log')
    ORDER BY c.relname, i.relname`);

const parallel = await admin.query(
  `SELECT proname, provolatile, proparallel FROM pg_proc
    WHERE proname IN ('app_current_user_id','app_is_notifier') ORDER BY 1`);

await admin.end();

/* ---------- measure, as the app role, through the boundary ---------- */

const { withUser, withNotifierScope, closePool } = await import('../src/db/pool.js');

/** EXPLAIN options. ANALYZE actually runs the query; BUFFERS is the point. */
const OPTS = 'ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF';

/** @param {import('pg').PoolClient} db @param {string} sql @param {any[]} params */
async function plan(db, sql, params) {
  if (CAPABILITY) await db.query('SET LOCAL enable_seqscan = off');
  const { rows } = await db.query(`EXPLAIN (${OPTS}) ${sql}`, params);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

const results = [];
const record = (name, sql, text) => {
  results.push({ name, sql, text });
  console.log(`\n### ${name}\n${text}`);
};

/* /overview's grid read and lifetime MIN — src/api.js */
await withUser(subject.id, async (db) => {
  record('overview: grid read over the window (api.js:448)',
    'entries WHERE habit_id = ANY AND date BETWEEN',
    await plan(db,
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
         FROM entries WHERE habit_id = ANY($1::bigint[]) AND date BETWEEN $2 AND $3
        ORDER BY date`,
      [subject.habitIds, WINDOW_START, WINDOW_END]));

  record('overview: lifetime first entry per habit (api.js:454)',
    'entries WHERE habit_id = ANY GROUP BY habit_id',
    await plan(db,
      `SELECT habit_id, to_char(MIN(date), 'YYYY-MM-DD') AS first_date
         FROM entries WHERE habit_id = ANY($1::bigint[]) GROUP BY habit_id`,
      [subject.habitIds]));
});

/* the notifier's per-account reads — src/notifier.js */
await withUser(subject.id, async (db) => {
  record('notifier: watermarks for a day (notifier.js:139)',
    'notify_log WHERE date = $1',
    await plan(db,
      `SELECT habit_id, channel FROM notify_log WHERE date = $1`, ['2026-06-01']));
});

/* prune's DELETE. EXPLAIN ANALYZE really deletes, so this throws a sentinel to
 * make withUser roll the transaction back — the fixture must survive the bench
 * or the plans taken after it are plans of a different table. */
const ROLLBACK = Symbol('rollback');
let pruneText = '';
await withUser(subject.id, async (db) => {
  pruneText = await plan(db,
    `DELETE FROM notify_log WHERE date < $1`, ['2026-05-10']);
  throw ROLLBACK;
}).catch((e) => { if (e !== ROLLBACK) throw e; });
record('notifier: prune old watermarks (notifier.js:257, rolled back)',
  'DELETE FROM notify_log WHERE date < $1', pruneText);

/* the once-a-minute scan for accounts to visit — src/notifier.js:69 */
await withNotifierScope(async (db) => {
  record('notifier: the 60s scan for accounts to visit (notifier.js:69)',
    "users WHERE blocked = false AND settings -> 'notifyChannels' ?| ...",
    await plan(db,
      `SELECT id, settings, device_time_zone FROM users
        WHERE blocked = false AND settings -> 'notifyChannels' ?| $1::text[]
        ORDER BY id LIMIT $2`,
      [['discord', 'ntfy'], 501]));
});

/* Can anything be parallelised at all? An aggregate over the whole of one
 * account's history is the query #185 says would want a parallel scan. This
 * asks the planner with nothing forced, and then with debug_parallel_query on,
 * which adds a Gather only if the plan is parallel-SAFE. */
await withUser(subject.id, async (db) => {
  const q = `SELECT count(*) FROM entries WHERE status = ''`;
  const nat = await db.query(`EXPLAIN (COSTS OFF) ${q}`);
  await db.query('SET LOCAL debug_parallel_query = on');
  const forced = await db.query(`EXPLAIN (COSTS OFF) ${q}`);
  const text =
    `natural plan:\n` + nat.rows.map((r) => '  ' + r['QUERY PLAN']).join('\n') +
    `\nwith debug_parallel_query = on:\n` +
    forced.rows.map((r) => '  ' + r['QUERY PLAN']).join('\n');
  record('parallelism: can a plan over entries gather at all?', q, text);
});

console.log('\n### schema under test');
for (const r of schema.rows) {
  console.log(`  ${r.tbl}.${r.idx}  ${(Number(r.bytes) / 1048576).toFixed(1)} MB`);
  console.log(`      ${r.def}`);
}
console.log('\n### policy functions');
for (const r of parallel.rows) {
  console.log(`  ${r.proname}: provolatile=${r.provolatile} proparallel=${r.proparallel}`);
}

await closePool();
