-- Server-sent reminders: what has already gone out, and how the scheduler is
-- allowed to find out whose reminders it should send.
--
-- The Android channel needs none of this. The phone schedules its own alarms
-- from `habits.reminder_time` and fires them offline; only a channel the
-- SERVER delivers (a Discord webhook today) needs the server to keep time,
-- and therefore needs a record of what it has already said.

CREATE TABLE IF NOT EXISTS notify_log (
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  habit_id BIGINT NOT NULL,
  -- 'discord', etc. Part of the key so enabling a second destination is not
  -- silenced on its first day by a send to the first.
  channel  TEXT   NOT NULL,
  -- The LOCAL date the reminder was for, in the user's own zone. Not a
  -- timestamp: the question is "has today's 08:00 nudge gone yet", and a
  -- timestamp would need the day boundary re-derived on every read.
  date     DATE   NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (habit_id, channel, date),

  -- The composite key from migration 007, for the same reason it exists there:
  -- with a primary key that does not include user_id, a row carrying the
  -- attacker's user_id and the victim's habit_id would otherwise occupy a slot
  -- the victim cannot see, and the victim's own INSERT would fail on a
  -- conflict with an invisible row — silently costing them that reminder,
  -- permanently, with no way to clear it. The FK makes the pair impossible.
  FOREIGN KEY (habit_id, user_id) REFERENCES habits (id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notify_log_date ON notify_log(date);

ALTER TABLE notify_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notify_log_owner ON notify_log;
CREATE POLICY notify_log_owner ON notify_log
  USING (user_id = app_current_user_id())
  WITH CHECK (
    user_id = app_current_user_id()
    AND EXISTS (
      SELECT 1 FROM habits h
       WHERE h.id = notify_log.habit_id
         AND h.user_id = app_current_user_id()
    )
  );

GRANT SELECT, INSERT, DELETE ON notify_log TO habiterall_app;

-- ---------------------------------------------------------------------------
-- Letting the scheduler find the accounts it must visit
-- ---------------------------------------------------------------------------
--
-- Every other query in this app runs inside `withUser`, which is why RLS can
-- be the guarantee rather than a second opinion. The notifier is the one job
-- that legitimately starts without a user: it has to ask "who has a webhook
-- configured?" before it knows whose day to look at.
--
-- `withoutUser` cannot answer that. It sets no `app.user_id`, so
-- `app_current_user_id()` is NULL, `users_self` matches nothing, and FORCE RLS
-- applies even to the owner — the scan correctly returns zero rows.
--
-- The alternatives were a second database credential with BYPASSRLS, or this:
-- a SELECT-only policy for a transaction-local scope flag that the request
-- path never sets. It is narrow in three ways that matter:
--
--   * FOR SELECT only, so nothing can be written through it;
--   * it requires app_current_user_id() IS NULL, so it can never widen a
--     request that is already scoped to a user — the two conditions are
--     mutually exclusive by construction;
--   * it grants nothing on `habits` or `entries`. The scan yields user ids
--     and settings; the reminders themselves are then read through the
--     ordinary `withUser` path, policies and all.
--
-- And it adds no privilege an attacker did not already have: reaching
-- `set_config('app.scope', ...)` means arbitrary SQL as habiterall_app, at
-- which point setting `app.user_id` to any value is equally available. What it
-- does buy is that a forgotten WHERE clause in ordinary route code still
-- returns nothing, which is the promise the rest of the design rests on.
CREATE OR REPLACE FUNCTION app_is_notifier() RETURNS BOOLEAN
  LANGUAGE sql STABLE AS
$$ SELECT app_current_user_id() IS NULL
        AND current_setting('app.scope', true) = 'notifier' $$;

DROP POLICY IF EXISTS users_notifier_scan ON users;
CREATE POLICY users_notifier_scan ON users
  FOR SELECT TO habiterall_app
  USING (app_is_notifier());
