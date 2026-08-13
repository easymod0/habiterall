-- habiterall-cloud initial schema.
--
-- Tenancy is enforced by Postgres Row-Level Security, NOT by application
-- code. Every query runs as a role subject to RLS with `app.user_id` set
-- from the session. A forgotten WHERE clause therefore returns nothing
-- rather than leaking another user's data: the isolation fails closed.

CREATE TABLE IF NOT EXISTS users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Stable subject claim from the identity provider. We never store passwords.
  idp_subject    TEXT        NOT NULL UNIQUE,
  idp_issuer     TEXT        NOT NULL,
  email          TEXT,
  display_name   TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft lock for abuse handling; blocked users keep their data.
  blocked        BOOLEAN     NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS habits (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  description      TEXT        NOT NULL DEFAULT '',
  type             TEXT        NOT NULL DEFAULT 'boolean'
                     CHECK (type IN ('boolean', 'numerical')),
  unit             TEXT        NOT NULL DEFAULT '',
  target_value     DOUBLE PRECISION NOT NULL DEFAULT 0
                     CHECK (target_value >= 0),
  target_type      TEXT        NOT NULL DEFAULT 'at_least'
                     CHECK (target_type IN ('at_least', 'at_most')),
  freq_numerator   INTEGER     NOT NULL DEFAULT 1 CHECK (freq_numerator >= 1),
  freq_denominator INTEGER     NOT NULL DEFAULT 1 CHECK (freq_denominator >= 1),
  color            TEXT        NOT NULL DEFAULT '#3b82f6'
                     CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  position         INTEGER     NOT NULL DEFAULT 0,
  archived         BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (freq_numerator <= freq_denominator)
);

CREATE TABLE IF NOT EXISTS entries (
  habit_id  BIGINT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  -- Denormalised so RLS can filter entries without joining habits.
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date      DATE   NOT NULL,
  -- boolean: 2 = yes.  numerical: the raw amount.
  -- Skips live in `status`, never in `value`: a numerical habit may
  -- legitimately record 3, which must not alias a skip sentinel.
  value     DOUBLE PRECISION NOT NULL CHECK (value >= 0),
  status    TEXT   NOT NULL DEFAULT '' CHECK (status IN ('', 'skip')),
  notes     TEXT   NOT NULL DEFAULT '',

  PRIMARY KEY (habit_id, date)
);

CREATE INDEX IF NOT EXISTS idx_habits_user     ON habits(user_id, position, id);
CREATE INDEX IF NOT EXISTS idx_entries_user    ON entries(user_id, date);
CREATE INDEX IF NOT EXISTS idx_entries_habit   ON entries(habit_id, date);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE habits  ENABLE ROW LEVEL SECURITY;
ALTER TABLE entries ENABLE ROW LEVEL SECURITY;

-- FORCE applies RLS even to the table owner, so a misconfigured connection
-- cannot quietly bypass isolation.
ALTER TABLE users   FORCE ROW LEVEL SECURITY;
ALTER TABLE habits  FORCE ROW LEVEL SECURITY;
ALTER TABLE entries FORCE ROW LEVEL SECURITY;

-- current_setting(..., true) returns NULL when unset rather than erroring;
-- NULLIF + the cast means "no user set" matches no rows.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS BIGINT
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::BIGINT $$;

DROP POLICY IF EXISTS users_self ON users;
CREATE POLICY users_self ON users
  USING (id = app_current_user_id())
  WITH CHECK (id = app_current_user_id());

DROP POLICY IF EXISTS habits_owner ON habits;
CREATE POLICY habits_owner ON habits
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

DROP POLICY IF EXISTS entries_owner ON entries;
CREATE POLICY entries_owner ON entries
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
