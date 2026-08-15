-- What a day with NO ROW is worth, on this habit.
--
-- The question only arises for an at-most target — a limit — where zero is
-- UNDER the goal, so the absence of an answer reads as a perfect one. Every
-- other habit already treats an unanswered day as a miss, because no value is
-- short of an at-least target and is not YES.
--
-- The account answers it once in `users.settings ->> 'atMostUnlogged'`, and
-- this overrides that for one habit, because the two kinds of limit want
-- opposite answers and people keep both: "I didn't smoke today" is worth a tap
-- and is the whole reward, while "I had no soda" is not something anyone opens
-- an app for and the point is to record the exception.
--
-- 'default' means "follow the account", and it is what every existing row
-- gets — the one value that changes nothing, since the account's answer is
-- what those habits were being scored with a moment before this ran.
--
-- Mirrors AT_MOST_UNLOGGED in shared/src/validate.js. The CHECK is here as
-- well as there for the reason the reminder_message constraints are: the
-- importer and any future writer reach this table too, and a value outside the
-- set would be read as 'default' by `unansweredCounts` — working, but not what
-- was asked for, and invisible.

ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS at_most_unlogged TEXT NOT NULL DEFAULT 'default';

ALTER TABLE habits
  DROP CONSTRAINT IF EXISTS habits_at_most_unlogged;
ALTER TABLE habits
  ADD CONSTRAINT habits_at_most_unlogged
  CHECK (at_most_unlogged IN ('default', 'miss', 'success'));
