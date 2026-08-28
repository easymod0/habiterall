/**
 * Schema invariants and query plans, against a real Postgres.
 *
 * Migration 016 changes no result: every query in the application returns
 * exactly what it returned before it ran. What it changes is how Postgres is
 * allowed to answer, and nothing in the API suites can see that — which is
 * why this file exists and why it asserts against the catalog and the planner
 * rather than against a payload.
 *
 * Two rules it is written to, both learned the expensive way:
 *
 * 1. **A structural assertion and a planner assertion are different tests, and
 *    the second one needs a fixture.** What an index IS — its key columns, in
 *    order, and its INCLUDE list — comes out of the catalog, is independent of
 *    how many rows the table holds, and is what assertion 4a pins. Whether the
 *    planner CHOOSES it is a different question, and `SET LOCAL enable_seqscan
 *    = off` does not turn the second into the first: it rules out a sequential
 *    scan and leaves every index in the schema competing, and on an empty
 *    table `entries_pkey` wins. This file previously claimed the forced-scan
 *    form asserted "capability, not planner CHOICE" and asserted assertion 4
 *    that way — against a freshly-migrated database, which is what CI has, it
 *    failed. Assertion 4b is therefore an honest planner-choice assertion: it
 *    seeds 6,000 entries, ANALYZEs, and forces off BOTH sequential and bitmap
 *    scans, because a bitmap scan over the right index is still not an Index
 *    Only Scan and would not falsify a missing INCLUDE list.
 *
 * 2. **Derive it from the catalog, not from a list of names.** Assertions 1-3
 *    ask a question of the whole schema ("is any policy function parallel
 *    unsafe?", "does any table carry two identical indexes?", "does any
 *    foreign key lack an index to cascade through?") rather than naming the
 *    three objects #185 was about. A test that names them pins the names and
 *    nothing else, and would not notice a fourth table added next year, nor a
 *    later `CREATE OR REPLACE FUNCTION` silently resetting PARALLEL SAFE back
 *    to UNSAFE — which is the regression #185 explicitly asks to be guarded.
 *
 * Every plan here is taken as `habiterall_app` through `withUser`. That is not
 * incidental: RLS puts a security qual on the table, and an EXPLAIN taken on
 * an owner connection is a plan of a query this application never issues. See
 * `CLAUDE.md`, "An RLS table cannot be indexed on a non-leakproof operator".
 */
// Connection strings come from the environment so the same script serves CI
// (Postgres on 5432) and a local run against the compose stack (via a proxy
// on 55432). See test/README.md.
process.env.DATABASE_URL ??=
  'postgres://habiterall_app:apptestpw@localhost:55432/habiterall';
const ADMIN_URL = process.env.ADMIN_URL ??
  'postgres://owner:testpw@localhost:55432/habiterall';

const { withUser, pool } = await import('../src/db/pool.js');

let fails = 0;
const check = (l, c, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' :: ' + e : ''}`);
  if (!c) fails++;
};

const pg = (await import('pg')).default;
const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();

/* ---------- 1. no policy function is PARALLEL UNSAFE ---------- */
//
// Walked through pg_depend rather than by name: every policy records a
// dependency on the functions its USING and WITH CHECK clauses call, so this
// finds a function a policy added later brings with it too. `CREATE FUNCTION`
// defaults to PARALLEL UNSAFE and `CREATE OR REPLACE` resets the flag when it
// omits the clause, so this is a flag that goes away silently.
//
// One unsafe function here is not one slow query: these functions sit in the
// USING clause of a policy on every table, so an unsafe one takes parallelism
// away from every query the application issues, all at once.
//
// The predicate is `<> 's'` and NOT `= 'u'`, which is the whole of what this
// assertion is worth. `PARALLEL RESTRICTED` may only run in the parallel group
// LEADER, so an expression containing it cannot appear in a partial path — and
// an RLS qual is applied at the scan, so a restricted policy function is a scan
// that cannot be parallelised. `debug_parallel_query` in force mode only wraps
// a plan whose top node is `parallel_safe`, so what comes out is no `Gather` at
// all: byte for byte the regression migration 016 exists to undo. Written
// `= 'u'`, a third policy function marked `'r'` by an author being cautious
// passes this and takes parallelism away from every query the app role issues.
// The control below cannot see it either — it names the two functions by hand.

console.log('--- every function an RLS policy depends on is PARALLEL SAFE ---');

const { rows: unsafe } = await admin.query(`
  SELECT DISTINCT p.proname, p.proparallel, pol.polname, cl.relname
    FROM pg_depend d
    JOIN pg_proc p ON p.oid = d.refobjid AND d.refclassid = 'pg_proc'::regclass
    JOIN pg_policy pol ON pol.oid = d.objid AND d.classid = 'pg_policy'::regclass
    JOIN pg_class cl ON cl.oid = pol.polrelid
   WHERE p.proparallel <> 's'
`);
check('every function reached from a policy is PARALLEL SAFE, not merely not unsafe',
  unsafe.length === 0,
  JSON.stringify(unsafe.map(
    (r) => `${r.proname} is '${r.proparallel}' via ${r.polname} on ${r.relname}`)));

// The control. If the join above matched nothing at all — a renamed catalog
// column, a typo in a regclass literal — the assertion would pass against a
// schema with no policies in it whatsoever, which is the shape of test this
// repo ships most. So: the walk really does reach the two functions #185 is
// about, and their flag really is 's'.
const { rows: reached } = await admin.query(`
  SELECT DISTINCT p.proname, p.proparallel
    FROM pg_depend d
    JOIN pg_proc p ON p.oid = d.refobjid AND d.refclassid = 'pg_proc'::regclass
    JOIN pg_policy pol ON pol.oid = d.objid AND d.classid = 'pg_policy'::regclass
   ORDER BY p.proname
`);
const safeNamed = (n) => reached.some((r) => r.proname === n && r.proparallel === 's');
check('the walk reaches both policy functions, and both read PARALLEL SAFE',
  safeNamed('app_current_user_id') && safeNamed('app_is_notifier'),
  JSON.stringify(reached));

/* ---------- 2. no table carries two identical indexes ---------- */
//
// "Identical" as Postgres defines it and not as a human reading two names
// would: same table, same key columns in the same order, same operator
// classes, same collation/ordering options, same predicate, same expressions
// and the same split between key and INCLUDE columns. Uniqueness is
// deliberately NOT part of the grouping — a unique index answers everything a
// plain index on the same key answers, so `entries_pkey` and the old
// `idx_entries_habit` really were one index maintained twice.

console.log('--- no table carries two indexes with identical definitions ---');

// `string_agg`, not `array_agg`: the latter returns a Postgres `name[]`, which
// node-postgres has no parser for, so the value arrived as the raw string
// `{a,b}` and the failure path threw `r.indexes.join is not a function`
// instead of reporting. A throw here is worse than a wrong message — it
// aborted the run, so one duplicate index skipped every assertion below.
const { rows: dupes } = await admin.query(`
  SELECT c.relname AS table_name,
         string_agg(i.relname, ' = ' ORDER BY i.relname) AS indexes
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
   GROUP BY c.relname, x.indrelid, x.indkey::text, x.indclass::text,
            x.indoption::text, pg_get_expr(x.indpred, x.indrelid),
            pg_get_expr(x.indexprs, x.indrelid), x.indnkeyatts
  HAVING count(*) > 1
`);
check('no duplicate index anywhere in the public schema',
  dupes.length === 0,
  JSON.stringify(dupes.map((r) => `${r.table_name}: ${r.indexes}`)));

/* ---------- 3. every foreign key can cascade through an index ---------- */
//
// A DELETE on the referenced side has to find the referencing rows, and with
// no index whose FIRST key column is one of the FK's own columns it does that
// with a sequential scan. `notify_log_user_id_fkey` was the one violation in
// the schema, so `DELETE FROM users` scanned all of notify_log; migration
// 016's `(user_id, date)` fixes it as a side effect of the read it was for.

console.log('--- every foreign key has an index to cascade through ---');

// `indpred IS NULL AND indisvalid` is what makes the index counted here one a
// cascade could actually use: a PARTIAL index covers only the rows its
// predicate admits, and an INVALID one — what a failed `CREATE INDEX
// CONCURRENTLY` leaves in the catalog — is not used by any plan at all.
// Without those two the check is satisfied by an index that does nothing for a
// `DELETE FROM users`, which is the whole of what it is here to notice.
const { rows: unindexedFks } = await admin.query(`
  SELECT con.conname, c.relname
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE con.contype = 'f' AND n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_index x
                      WHERE x.indrelid = con.conrelid
                        AND x.indkey[0] = ANY(con.conkey)
                        AND x.indpred IS NULL AND x.indisvalid)
`);
check('no foreign key would cascade through a sequential scan',
  unindexedFks.length === 0,
  JSON.stringify(unindexedFks.map((r) => `${r.conname} on ${r.relname}`)));

/* ---------- 4a. what idx_entries_owner_habit IS ---------- */
//
// Structural, from the catalog, and so independent of how many rows the table
// holds — this half runs on an empty database. `indkey` in index order, split
// at `indnkeyatts` into key columns and INCLUDE columns, rather than the text
// of `pg_get_indexdef`: a source-text match reads the same whether or not the
// planner can do anything with what it describes.
//
// The two lists are written out as literals on purpose. Deriving them from the
// migration, or importing a constant, would pin the name and let the order
// change underneath it — and the ORDER is the whole point here. Leading with
// `user_id` is what makes this index different from `entries_pkey`, because
// the RLS policy contributes `user_id = app_current_user_id()` to every plan
// over this table; `INCLUDE (value, status)` is what lets the grid read be
// answered without touching the heap.

console.log('--- idx_entries_owner_habit: key columns and INCLUDE list ---');

const { rows: idxCols } = await admin.query(`
  SELECT a.attname, x.indnkeyatts
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
   WHERE n.nspname = 'public' AND c.relname = 'entries'
     AND i.relname = 'idx_entries_owner_habit'
   ORDER BY k.ord
`);
const nkey = idxCols.length ? idxCols[0].indnkeyatts : 0;
const keyCols = idxCols.slice(0, nkey).map((r) => r.attname);
const includeCols = idxCols.slice(nkey).map((r) => r.attname);
check('its key is exactly (user_id, habit_id, date), in that order',
  JSON.stringify(keyCols) === JSON.stringify(['user_id', 'habit_id', 'date']),
  JSON.stringify(keyCols));
check('it INCLUDEs exactly (value, status)',
  JSON.stringify(includeCols) === JSON.stringify(['value', 'status']),
  JSON.stringify(includeCols));

/* ---------- a small account to take plans against ---------- */
//
// The plans below need a real user id (withUser refuses anything else) and a
// real habit id to put in the `= ANY(...)` array. Seeded through the admin
// connection, which is a superuser and bypasses RLS, exactly as the tenancy
// suite does; removed again at the end.

const { rows: [subject] } = await admin.query(
  `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
   VALUES ('sub-plans','https://idp','plans@example.com','Plans') RETURNING id`);
const { rows: [seedHabit] } = await admin.query(
  `INSERT INTO habits (user_id, name, type) VALUES ($1,'Plan Subject','boolean')
   RETURNING id`, [subject.id]);
await admin.query(
  `INSERT INTO entries (habit_id, user_id, date, value)
   VALUES ($1,$2,'2026-01-01',2), ($1,$2,'2026-01-02',2)`,
  [seedHabit.id, subject.id]);
await admin.query(
  `INSERT INTO notify_log (user_id, habit_id, channel, date)
   VALUES ($1,$2,'discord','2026-01-01')`, [subject.id, seedHabit.id]);

/**
 * EXPLAIN SQL inside an account, with sequential scans forbidden — and, when
 * `bitmapscan` is off, bitmap scans too.
 */
const planFor = (userId, sql, params, { bitmapscan = 'on' } = {}) =>
  withUser(userId, async (db) => {
    await db.query('SET LOCAL enable_seqscan = off');
    await db.query(`SET LOCAL enable_bitmapscan = ${bitmapscan}`);
    const { rows } = await db.query(`EXPLAIN (COSTS OFF) ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });

/* ---------- 4b. /overview's grid read IS answered by that index ---------- */
//
// The query text below is the application's own, indentation aside —
// including `habit_id = ANY($1)`, where this file used to write
// `ANY($1::bigint[])`, a cast no route writes. It is the grid window read,
// which both routes that draw a grid issue: `api.js:806-808`, the `windowRows`
// read in `GET /overview`, and `api.js:448-450`, the `entryRows` read in
// `GET /categories/stats`. The two differ only in the window they pass —
// `/categories/stats` widens the start by the score warm-up — so one plan
// covers both.
//
// This is a planner-CHOICE assertion and it is only meaningful on a seeded,
// ANALYZEd table: 10 users x 6 habits x 100 consecutive days = 6,000 entries.
// That size is margin, and the margin was measured on this fixture's own shape
// by varying the day count — 300 entries and the planner picks
// `idx_entries_user`, 600 and it picks the Index Only Scan asserted below, and
// on the EMPTY database CI has it picks `entries_pkey`. The previous version
// of this assertion seeded two rows, so it failed in CI and nowhere else. Do
// not shrink this fixture: the floor is a cost estimate, and it moves.
//
// BOTH scan types have to be forced off, measured over that same fixture:
//
//   enable_seqscan = off only
//     ->  Bitmap Heap Scan on entries
//           ->  Bitmap Index Scan on idx_entries_owner_habit   <-- no "Index Only Scan"
//   enable_seqscan = off AND enable_bitmapscan = off
//     ->  Index Only Scan using idx_entries_owner_habit on entries
//
// The bitmap form uses the right index and still visits the heap, so with only
// the first GUC the Index-Only-Scan assertion — the one that falsifies a
// missing INCLUDE list — could never pass.

console.log("--- planner choice: /overview's grid read, as an index-only scan ---");

const { rows: fixtureUsers } = await admin.query(
  `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
   SELECT 'sub-plans-' || g, 'https://idp', 'plans' || g || '@example.com', 'Plans ' || g
     FROM generate_series(1, 10) AS g
   RETURNING id`);
const fixtureIds = fixtureUsers.map((r) => r.id);
await admin.query(
  `INSERT INTO habits (user_id, name, type)
   SELECT u, 'Fixture ' || h, 'boolean'
     FROM unnest($1::bigint[]) AS u, generate_series(1, 6) AS h`, [fixtureIds]);
await admin.query(
  `INSERT INTO entries (habit_id, user_id, date, value)
   SELECT h.id, h.user_id, DATE '2026-01-01' + d, 2
     FROM habits h, generate_series(0, 99) AS d
    WHERE h.user_id = ANY($1::bigint[])`, [fixtureIds]);
await admin.query('ANALYZE users, habits, entries');

const { rows: fixtureHabits } = await admin.query(
  'SELECT id FROM habits WHERE user_id = $1 ORDER BY id', [fixtureIds[0]]);
const gridPlan = await planFor(fixtureIds[0],
  `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
       FROM entries WHERE habit_id = ANY($1) AND date BETWEEN $2 AND $3
       ORDER BY date`,
  [fixtureHabits.map((r) => r.id), '2026-01-01', '2026-01-31'],
  { bitmapscan: 'off' });
check('the grid window is served by idx_entries_owner_habit',
  gridPlan.includes('idx_entries_owner_habit'), gridPlan);
check('...as an Index Only Scan, so INCLUDE (value, status) covers the row',
  gridPlan.includes('Index Only Scan'), gridPlan);

// Straight back out. The CI `cloud` job runs several suites against one
// database, and 6,000 entries belonging to ten users nobody signed in as is
// not a state the next suite should have to reason about. Deleting the users
// cascades to their habits and entries.
await admin.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [fixtureIds]);
// And re-analyse, because deleting the rows does not delete the statistics
// that describe them: this suite runs first in the CI `cloud` job, and leaving
// them behind hands the next suite a planner that thinks `entries` holds 6,000
// rows when it holds none.
await admin.query('ANALYZE users, habits, entries');

/* ---------- 5. the watermark read leads with user_id ---------- */
//
// `notifier.js`'s "what have I already sent today?" read, run once per account
// per tick inside withUser. `notify_log_pkey` is `(habit_id, channel, date)`,
// which cannot use `date` as a leading key, so before 016 the only usable
// index was `(date)` alone — every account's rows for that date, filtered down
// to a dozen.

console.log('--- capability: the per-account watermark read ---');

const watermarkPlan = await planFor(subject.id,
  `SELECT habit_id, channel FROM notify_log WHERE date = $1`, ['2026-01-01']);
check('the watermark read is served by idx_notify_log_owner_date',
  watermarkPlan.includes('idx_notify_log_owner_date'), watermarkPlan);

/* ---------- 5a. what idx_notify_log_owner_date IS ---------- */
//
// Beside the plan check above and not instead of it, for the reason 4a is
// beside 4b: the plan check looks for the index NAME, and an index keyed
// `(date, user_id)` still serves `WHERE date = $1` and still appears in that
// plan by that name. Re-keying it that way was measured against the check
// above and it PASSED — so the ORDER, which is the whole of what 016 buys
// here, is pinned from the catalog exactly as `idx_entries_owner_habit`'s is.
//
// Literals again, and `indkey` in index order split at `indnkeyatts` rather
// than the text of `pg_get_indexdef`. Leading with `user_id` is what turns
// this from "every account's rows for that date" into "this account's", and
// it is also what gives `notify_log_user_id_fkey` a first key column of its
// own to cascade through. The empty INCLUDE list is a decision too: covering
// `(habit_id, channel)` would buy an index-only scan of about twelve rows per
// account per tick and charge for it on every row stored.

console.log('--- idx_notify_log_owner_date: key columns and INCLUDE list ---');

const { rows: logIdxCols } = await admin.query(`
  SELECT a.attname, x.indnkeyatts
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
   WHERE n.nspname = 'public' AND c.relname = 'notify_log'
     AND i.relname = 'idx_notify_log_owner_date'
   ORDER BY k.ord
`);
const logNkey = logIdxCols.length ? logIdxCols[0].indnkeyatts : 0;
const logKeyCols = logIdxCols.slice(0, logNkey).map((r) => r.attname);
const logIncludeCols = logIdxCols.slice(logNkey).map((r) => r.attname);
check('its key is exactly (user_id, date), in that order',
  JSON.stringify(logKeyCols) === JSON.stringify(['user_id', 'date']),
  JSON.stringify(logKeyCols));
check('and it INCLUDEs nothing',
  JSON.stringify(logIncludeCols) === '[]', JSON.stringify(logIncludeCols));

/* ---------- clean up after ourselves ---------- */
// Only this file's own accounts: habits, entries and notify_log all cascade
// from them. Nothing else in the database is this suite's to delete — unlike
// the tenancy suite, which owns the whole instance while it runs.
await admin.query('DELETE FROM users WHERE id = $1', [subject.id]);

await admin.end();
await pool.end();
console.log(fails === 0 ? '\nALL SCHEMA/PLAN CHECKS PASSED' : `\n${fails} SCHEMA/PLAN CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
