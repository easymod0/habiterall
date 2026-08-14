-- How each destination last behaved, so a delivery failure has somewhere to be
-- SEEN.
--
-- A permanent failure — a deleted webhook, the bot kicked from the channel, a
-- revoked token — is recorded as sent and logged at warn, which is right: a 404
-- answers 404 forever and retrying every minute until midnight helps nobody.
-- The problem was that the log was the ONLY surface. Reminders stopped, and the
-- habit, its reminder time and the destination toggle all went on looking
-- correct. A self-hosted operator can at least read their own log; a cloud user
-- cannot, and the operator has no reason to be reading one account's warnings.
--
-- One row per user per channel, holding the LAST outcome and nothing else. A
-- history would answer a question nobody is asking, and the settings dialog
-- only ever shows "the most recent attempt failed, and here is what Discord
-- said". A success clears it.
--
-- Not in the `settings` JSONB, deliberately, for two reasons. It is the server
-- reporting on ITSELF, never something the client sends — and `settings` is
-- exactly what `PUT /api/settings` writes and `/api/export` carries, so a
-- diagnostic living there would end up in backups and in the round-trip
-- suites. And `channelConfigured` stays the only authority on whether a
-- destination CAN deliver; this says only whether it DID.

CREATE TABLE IF NOT EXISTS notify_status (
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'discord', etc. Per channel, because a working webhook must not vouch for
  -- a broken bot.
  channel   TEXT   NOT NULL,
  ok        BOOLEAN NOT NULL,
  status    INTEGER,
  -- The prose the sender already produced. Re-inventing the wording in the UI
  -- is how the dialog and the log come to say different things about one 404.
  error     TEXT   NOT NULL DEFAULT '',
  permanent BOOLEAN NOT NULL DEFAULT false,
  mode      TEXT   NOT NULL DEFAULT '',
  date      TEXT   NOT NULL DEFAULT '',
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, channel)
);

ALTER TABLE notify_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify_status FORCE ROW LEVEL SECURITY;

-- The ordinary owner policy. Unlike notify_log this key already leads with
-- user_id, so the invisible-row conflict that migration 008 guards against
-- cannot arise: one user's row can never occupy another's slot.
DROP POLICY IF EXISTS notify_status_owner ON notify_status;
CREATE POLICY notify_status_owner ON notify_status
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

-- UPDATE as well as INSERT: the row is upserted in place, because only the last
-- outcome is kept. No DELETE — nothing removes one, and a channel that has
-- never been attempted simply has no row.
GRANT SELECT, INSERT, UPDATE ON notify_status TO habiterall_app;
