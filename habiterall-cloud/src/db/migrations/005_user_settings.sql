-- Per-user preferences.
--
-- Stored on the user row rather than in a separate table: settings are a
-- small, bounded set read on every page load, always for exactly one user,
-- and never queried across users. A JSONB column keeps the schema stable as
-- options are added — a new setting needs no migration.
--
-- The existing users_select_self / users_update_self policies already scope
-- this to the owning user, so no new RLS is required.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Bound the size so a client cannot use it as free storage. The whole set is
-- a handful of short keys; 4 KB is generous.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_settings_size;
ALTER TABLE users
  ADD CONSTRAINT users_settings_size
  CHECK (pg_column_size(settings) <= 4096);

-- The app role may now write this column. It was deliberately restricted to
-- email/display_name/last_seen_at in migration 004 so a compromised session
-- could not repoint `idp_subject` or clear `blocked`; settings are safe to
-- add to that list.
GRANT UPDATE (settings) ON users TO habiterall_app;
