-- What the last client to check in said its clock was, for `notifyTimezone: 'auto'`.
--
-- A column on `users` rather than a table: it is exactly one value per account,
-- upserted in place, and it has no lifecycle of its own.
--
-- NOT in the `settings` JSONB, and that is the whole design decision. This is an
-- OBSERVATION the server makes from a request header, where everything in
-- `settings` is a DECISION the user sent through `PUT /api/settings`. Keeping
-- them apart is what makes `auto` reversible: fold the detected zone into
-- `notifyTimezone` and the first client to check in turns "follow my device"
-- into a chosen value, after which nothing can get back to automatic and a
-- stale detection outlives the trip that caused it. It is the same distinction
-- `theme: 'system'` and `at_most_unlogged: 'default'` already draw.
--
-- It also keeps it out of `/api/export`, which carries `portableSettings(...)`:
-- restoring your backup on a laptop in another country must not move when your
-- reminders arrive.
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_time_zone TEXT NOT NULL DEFAULT '';

-- Covered by the existing users_select_self / users_update_self policies, like
-- `settings` — no new policy is needed, and deliberately no new one is added.
--
-- The app role has column-level UPDATE on `users` and cannot touch
-- `idp_subject` or `blocked`; this adds exactly one more column to that list.
GRANT UPDATE (device_time_zone) ON users TO habiterall_app;
