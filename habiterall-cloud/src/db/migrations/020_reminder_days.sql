-- Which weekdays a habit's reminder time fires on.
--
-- A 7-bit mask in which bit N is JavaScript's own `getDay()` N: bit 0 Sunday,
-- bit 1 Monday, … bit 6 Saturday. That is the numbering every weekday axis in
-- this app already uses, so nothing downstream has to remember a second one.
--
-- It is deliberately NOT Loop's own mask, whose bit 0 is SATURDAY (verified
-- from uhabits' `NotificationTray.shouldShowReminderToday` and its
-- `WeekdayPickerDialog`, which labels the raw bit array starting at Saturday).
-- The rotation between the two lives in the importer and the Loop exporter,
-- so Loop's convention never reaches this column.
--
-- 127 — every day — for every existing row, which is the one value that
-- changes nothing: those habits were reminding every day a moment before this
-- ran. 0 is a legal value meaning "no day"; nothing may repair it to 127, or a
-- mask of zero becomes a daily reminder, which is the defect #78 refused to
-- ship.
--
-- Mirrors `parseReminderDays` in shared/public/ui/time.js. The CHECK is here as
-- well as there for the reason the reminder_message and at_most_unlogged
-- constraints are: the importer and any future writer reach this table too, and
-- a value outside the range would be read by a `>> weekday & 1` gate as some
-- other set of days — working, but not what was asked for, and invisible.
--
-- No grant line, and none is needed: `habits` carries table-level
-- `GRANT SELECT, INSERT, UPDATE, DELETE` to `habiterall_app` (migration 002),
-- so a new column is covered by it — unlike `users`, whose UPDATE is
-- column-level and is why migrations 013 and 017 each carry one. Migration 018
-- says the same at more length.
--
-- Not a lock-order question. The rule in habiterall-cloud/CLAUDE.md is about a
-- statement added to a shared WRITE WRAPPER, where two request paths can reach
-- `habits` and `users` in different orders. This runs as the admin credential
-- in `migrate.js`'s own process, one migration per transaction, touching one
-- table and taking no `users` lock at all — there is no second path for it to
-- invert against.

ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS reminder_days INTEGER NOT NULL DEFAULT 127;

ALTER TABLE habits
  DROP CONSTRAINT IF EXISTS habits_reminder_days_range;
ALTER TABLE habits
  ADD CONSTRAINT habits_reminder_days_range
  CHECK (reminder_days BETWEEN 0 AND 127);
