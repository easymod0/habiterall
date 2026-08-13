-- Per-habit reminder time.
--
-- Stored on the habit rather than on the device so it follows the account to
-- a new phone, and so the web UI can set it too. The native Android client
-- reads this and schedules a local alarm; the server does no scheduling and
-- sends no push, which keeps reminders working with no connectivity.
--
-- Local wall time, not UTC: "remind me at 08:00" means 08:00 wherever the
-- user is, and must not shift when they travel or when DST changes.

ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS reminder_time TEXT NOT NULL DEFAULT '';

-- '' (no reminder) or a 24-hour HH:MM.
ALTER TABLE habits
  DROP CONSTRAINT IF EXISTS habits_reminder_time_format;
ALTER TABLE habits
  ADD CONSTRAINT habits_reminder_time_format
  CHECK (reminder_time = '' OR reminder_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
