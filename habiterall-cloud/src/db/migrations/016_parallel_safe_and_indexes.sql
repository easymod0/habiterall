-- A plan change, and nothing else. Every query below returns exactly what it
-- returned before this file ran; what changes is how many blocks Postgres has
-- to touch to say it, and whether it is allowed to use more than one core.
--
-- Three separate costs, measured against a database holding 20,000 users /
-- 2,400 habits / 960,000 entries / 108,000 notify_log rows:
--
--   1. Neither policy function was PARALLEL SAFE, and the policies are on
--      every table, so NOTHING this application issues could be parallelised.
--   2. `idx_entries_habit` was byte-identical to `entries_pkey` — 39.9 MB of
--      duplicate index, maintained on every write, that no plan can prefer.
--   3. `notify_log`'s only index was on `(date)` alone, so a per-account read
--      of one day's watermarks read every account's rows for that day —
--      2,388 rows removed by filter to return 12, and 21,492 removed to
--      delete 108 in the prune.
--
-- LEAKPROOF is deliberately NOT applied to either function, and must not be.
-- It is a different lever entirely: it tells the planner it may push a
-- user-supplied qual BELOW a security barrier, and these functions ARE the
-- barrier. Parallel safety says the body may run in a worker process; leak
-- proofness says the body may not reveal its arguments through an error or a
-- timing. We want the first and specifically do not want the second.
--
-- Rolling-update safety: no column is added, dropped or renamed, so a
-- previous release runs unchanged against this schema and this file needs no
-- expand/contract dance. The lock cost is the whole of it — `CREATE INDEX`
-- takes SHARE (reads continue; writes to that table wait for the build) and
-- `DROP INDEX` takes a brief ACCESS EXCLUSIVE. `CONCURRENTLY` would avoid
-- both and cannot be used here: `migrate.js` wraps each migration in
-- BEGIN/COMMIT so a failure leaves no partial schema, and CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction block. Changing that means
-- giving up per-migration atomicity, which is issue #239's decision to make.

-- ---------------------------------------------------------------------------
-- 1. The policy functions may run in a parallel worker
-- ---------------------------------------------------------------------------
--
-- `CREATE FUNCTION` defaults to PARALLEL UNSAFE, and neither of these ever
-- said otherwise. Because both sit in the USING clause of a policy that
-- applies to every query the app role makes, one unsafe function took
-- parallelism away from the entire application: with
-- `debug_parallel_query = on`, a count(*) over `entries` inside `withUser`
-- produced an identical plan with no Gather node at all.
--
-- Both bodies are safe by the same argument. Each is a single
-- `current_setting` call, which Postgres itself marks `proparallel = 's'`
-- (true of both the one-argument and the two-argument form), and a GUC set
-- with `set_config(..., true)` is propagated to parallel workers along with
-- the rest of the leader's state — so a worker evaluating the policy reads
-- the same `app.user_id` and `app.scope` the leader set.
--
-- #185 names only `app_current_user_id`. `app_is_notifier` has to move with
-- it: `users_notifier_scan` is granted TO habiterall_app, so its qual is OR'd
-- into every query the app role makes against `users`, and leaving it unsafe
-- would leave `users` alone among the tables in still being unable to
-- parallelise anything.
--
-- Neither flag survives a later `CREATE OR REPLACE FUNCTION` that omits it,
-- silently, so `test/schema-plans.integration.mjs` asserts from the catalog
-- that no function any policy depends on is PARALLEL UNSAFE.
ALTER FUNCTION app_current_user_id() PARALLEL SAFE;
ALTER FUNCTION app_is_notifier()     PARALLEL SAFE;

-- ---------------------------------------------------------------------------
-- 2. `entries`: one index that was a copy, and one the grid read wanted
-- ---------------------------------------------------------------------------
--
-- `idx_entries_habit` was `btree (habit_id, date)`. So is `entries_pkey`,
-- which migration 001 declared on the same two columns in the same order. The
-- planner can use the primary key for anything the other could answer, so the
-- copy bought nothing and cost a second B-tree write on every entry upsert.
DROP INDEX IF EXISTS idx_entries_habit;

-- What `/overview` actually reads (api.js:448): every entry for THIS user's
-- habits over the window. With only the two indexes above the planner chose
-- `idx_entries_user` and applied `habit_id = ANY(...)` as a filter, touching
-- 3,360 heap blocks to return 3,360 rows — one block per row, because the
-- entries it wants are scattered across the account's whole history.
--
-- Leading with `user_id` is what makes this different from `entries_pkey`
-- (and from the index dropped above): the RLS predicate contributes
-- `user_id = app_current_user_id()` to every plan over this table, so an
-- index that does not start there cannot use it as a key.
--
-- INCLUDE (value, status) is exactly the rest of api.js:448's select list —
-- `habit_id` and `date` are already key columns — which is what lets the read
-- be answered as an Index Only Scan with no heap access at all. Payload
-- columns, not key columns: they are never a predicate here, and keeping them
-- out of the key keeps the tree narrow.
CREATE INDEX IF NOT EXISTS idx_entries_owner_habit
  ON entries (user_id, habit_id, date) INCLUDE (value, status);

-- Two things on this table are deliberately left alone.
--
-- `idx_entries_user (user_id, date)` STAYS. The index above cannot serve the
-- notifier's `WHERE user_id = X AND date = $1` (notifier.js:135), where
-- `habit_id` is unconstrained and sits between the two columns the predicate
-- does name.
--
-- `entries_pkey (habit_id, date)` is NOT touched. Its column order is a
-- security decision, not an oversight — migration 007 has the whole argument.
-- Read "the key does not lead with user_id" as a thing that was paid for: the
-- composite foreign key to `habits (id, user_id)` is what stops an attacker
-- squatting a key slot the victim cannot see, and re-keying this table would
-- take that defence apart.

-- ---------------------------------------------------------------------------
-- 3. `notify_log`: reads that are per-account but were keyed by day
-- ---------------------------------------------------------------------------
--
-- Both reads of this table run inside `withUser`, once per account, once per
-- tick: today's watermarks (notifier.js:139) and the prune (notifier.js:257).
-- With `(date)` as the only non-key index, each one read EVERY account's rows
-- for the dates in question and threw away all but its own — 2,388 rows
-- removed by filter to return 12, and 199 buffers to delete 108.
--
-- Leading with `user_id` also gives `notify_log_user_id_fkey` an index whose
-- first key column is one of its own, which it did not have: `DELETE FROM
-- users` had to sequentially scan this table to find the rows to cascade.
-- That was the one foreign key in the schema with no such index.
--
-- `(user_id, date)` and no INCLUDE. `INCLUDE (habit_id, channel)` would buy
-- an index-only scan of about twelve rows per account per tick, and charge
-- for it on every row stored; the heap fetch here is not what was expensive.
CREATE INDEX IF NOT EXISTS idx_notify_log_owner_date
  ON notify_log (user_id, date);

-- Superseded: every predicate it served names `user_id` as well, because the
-- policy contributes one.
DROP INDEX IF EXISTS idx_notify_log_date;

-- `notify_log_pkey (habit_id, channel, date)` is NOT touched, for migration
-- 008's reason and not by accident — it is the same invisible-row squat 007
-- guards `entries` against, and the composite FK to `habits (id, user_id)` is
-- what makes the planted pair impossible. This migration ADDS an index beside
-- the key; it does not re-key the table, and nothing here creates, drops or
-- alters a policy.
