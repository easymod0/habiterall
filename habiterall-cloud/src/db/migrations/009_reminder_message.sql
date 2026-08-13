-- What a reminder asks.
--
-- The notification used to be built from the habit alone — its name as a title
-- and a sentence assembled from its type and goal. That is a reasonable
-- default and a poor prompt: "Meditate / have you done this today?" reads like
-- a form, where "Did you sit for ten minutes?" reads like a question. For a
-- measurable habit it matters more, because the useful prompt names the unit:
-- "How many cups of water did you drink today?"
--
-- '' keeps the generated sentence, so nothing has to be filled in.
--
-- Capped at 200 characters to match LIMITS.reminderMessage in
-- shared/src/validate.js: below Discord's 256-character embed title, so a
-- prompt is never silently truncated on the way out.

ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS reminder_message TEXT NOT NULL DEFAULT '';

ALTER TABLE habits
  DROP CONSTRAINT IF EXISTS habits_reminder_message_length;
ALTER TABLE habits
  ADD CONSTRAINT habits_reminder_message_length
  CHECK (char_length(reminder_message) <= 200);

-- A prompt is one line. The Android client mirrors reminders into a
-- line-delimited cache, so a newline stored here would corrupt the record it
-- sits in — the validator strips them, and this makes that a property of the
-- data rather than of the code path that happened to write it.
ALTER TABLE habits
  DROP CONSTRAINT IF EXISTS habits_reminder_message_single_line;
ALTER TABLE habits
  ADD CONSTRAINT habits_reminder_message_single_line
  CHECK (reminder_message !~ '[\r\n]');
