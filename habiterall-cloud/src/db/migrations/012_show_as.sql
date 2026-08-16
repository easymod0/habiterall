-- How a habit is SHOWN: as an amount to reach, or as something to avoid.
--
-- A habit you want to stop is stored as what it is — a measurable habit with
-- an at-most target — which needs no new storage, round-trips through Loop
-- perfectly, and is already what `isCompleted` and the score read. What it
-- lacked was an interaction: you answered it by typing a number, a filled cell
-- painted as an achievement, and the wording asked whether you had done the
-- thing you are trying not to do.
--
-- So this decides the RENDERING and nothing else, and that is the whole reason
-- it can exist. Issue #64's other option was a flag inverting the JUDGEMENT,
-- and Loop's schema has nowhere to carry one — losing it on a round trip would
-- flip every verdict in the file. Losing this loses a display preference, and
-- the rows go on meaning exactly what they meant.
--
-- 'amount' for everything that already exists, which is what every one of them
-- is being shown as now.
--
-- Mirrors SHOW_AS in shared/src/validate.js. The CHECK is here as well as
-- there for the reason the reminder_message constraints have one: the importer
-- reaches this table too, and a value outside the set would render as 'amount'
-- — working, but not what was asked for, and invisible.

ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS show_as TEXT NOT NULL DEFAULT 'amount';

ALTER TABLE habits
  DROP CONSTRAINT IF EXISTS habits_show_as;
ALTER TABLE habits
  ADD CONSTRAINT habits_show_as CHECK (show_as IN ('amount', 'avoid'));
