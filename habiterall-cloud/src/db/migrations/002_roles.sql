-- Privilege separation.
--
-- The application connects as `habiterall_app`, a role that is NOT the table
-- owner and has no BYPASSRLS. Even if application code forgets a WHERE
-- clause, or an injection attempt slips a query through, the Row-Level
-- Security policies still apply.
--
-- Migrations run as the owner/superuser from DATABASE_URL_ADMIN, which is a
-- separate credential the running app never holds.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'habiterall_app') THEN
    -- Password is set separately by the migration runner so it never
    -- appears in a checked-in file.
    CREATE ROLE habiterall_app LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO habiterall_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON users, habits, entries TO habiterall_app;

-- Identity columns need sequence access for INSERT.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO habiterall_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO habiterall_app;

-- Explicitly ensure the app role can never bypass RLS.
ALTER ROLE habiterall_app NOBYPASSRLS;

-- The session store is cross-user by nature and is not RLS-protected;
-- it holds only opaque session ids and their payloads.
CREATE TABLE IF NOT EXISTS session (
  sid    TEXT PRIMARY KEY,
  sess   JSON        NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);
GRANT SELECT, INSERT, UPDATE, DELETE ON session TO habiterall_app;
