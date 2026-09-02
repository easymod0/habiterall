-- The dashboard's two LIFETIME figures, cached on the habit row.
--
-- `/overview` carries four figures per habit and two of them are statements
-- about the habit's WHOLE history: `bestStreak`, which walks
-- STREAK_HISTORY_DAYS of days per habit in synchronous JS, and
-- `totalCompleted`, an aggregate with no date predicate at all — so it reads
-- every row the account has ever written, on every dashboard load, and gets
-- steadily dearer as the account ages. Neither answer changes between two loads
-- on the same day unless something was WRITTEN, so both are stored here and the
-- row the route already SELECTs carries them at no extra query. The rule for
-- what they MEAN and when they are stale is `shared/src/summary-cache.js`, one
-- copy for both editions; only the storage is per edition.
--
-- NULLABLE, with no DEFAULT, and that is the whole of the design. A
-- `NOT NULL DEFAULT 0` would make a habit that has genuinely never been
-- completed indistinguishable from one whose pair has never been computed —
-- the collapse the root CLAUDE.md forbids everywhere else ("Never write
-- `entryMap.get(date) ?? UNSET`"), in the schema this time. `summary_asof` is
-- the single validity flag: it holds the day the pair was computed FOR, so a
-- stale pair sits beside a NULL stamp and is never served. Every existing row
-- gets NULL on upgrade, which is "invalidated" for free.
--
-- DATE, not TEXT, and the read path needs no `to_char` for it: `db/pool.js`
-- installs `pg.types.setTypeParser(1082, (v) => v)`, so a DATE comes back as
-- the raw 'YYYY-MM-DD' string the comparison wants. (Personal stores the same
-- stamp as TEXT, because every date in SQLite is TEXT there.)
--
-- These are OBSERVATIONS the SERVER makes about the cost of deriving a figure,
-- exactly the category `data_version` is in (migration 017: "an OBSERVATION the
-- SERVER makes about writes… no business in `/api/export`") and
-- `unlogged_is_success` is in. They are NOT habit fields: they are in no
-- `*_HABIT_FIELDS` list, `parseHabit` knows nothing about them, and they are
-- stripped at every serialisation point, so they never reach a client and never
-- land in a portable backup.
--
-- Rolling-update safety: three columns are ADDED and nothing is dropped,
-- renamed or re-typed, so a previous release runs unchanged against this
-- schema — it simply never reads or writes them, and every row it inserts
-- leaves them NULL, which the CHECK below permits and which the read path
-- treats as "recompute".

ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS best_streak     INTEGER,
  ADD COLUMN IF NOT EXISTS total_completed INTEGER,
  ADD COLUMN IF NOT EXISTS summary_asof    DATE;

-- The invariant, structurally: a stamp without figures behind it is a row the
-- read path would serve NULL as a number for. Written so the stamp alone
-- decides validity — clearing `summary_asof` is what an invalidation does, and
-- it leaves the two figures in place, which this permits and nothing reads.
--
-- `DROP … IF EXISTS` then `ADD`, the idiom migrations 011 and 014 already use,
-- so re-running against a database that somehow has it is not an error.
ALTER TABLE habits DROP CONSTRAINT IF EXISTS habits_summary_cache_complete;
ALTER TABLE habits ADD CONSTRAINT habits_summary_cache_complete
  CHECK (summary_asof IS NULL
         OR (best_streak IS NOT NULL AND total_completed IS NOT NULL));

-- No new RLS policy, and no column grant. Both absences are deliberate, and a
-- reader expecting the `GRANT UPDATE (col)` line migrations 013 and 017 carry
-- should read this rather than assume it was forgotten.
--
-- No policy: this adds no TABLE. The existing `habits_*` owner policies are on
-- the row and cover every column it has, including ones added later — an
-- account can read and write these three on its own habits and nobody else's,
-- which is exactly what is wanted.
--
-- No grant: `002_roles.sql:23` is a TABLE-level
-- `GRANT SELECT, INSERT, UPDATE, DELETE ON users, habits, entries`, so the app
-- role already holds UPDATE on every column of `habits`. The column-level
-- grants 013 and 017 add are on `users`, where the grant IS column-level on
-- purpose — that is what keeps `idp_subject` and `blocked` out of the app
-- role's reach — and adding a column there means naming it. `habits` has no
-- such split and gaining one for these would be a new boundary invented for
-- three columns that are the server's own.
