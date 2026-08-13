-- Tie an entry's habit to its owner, at the database level.
--
-- The `entries_owner` policy checked only `user_id = app_current_user_id()`.
-- Nothing connected `habit_id` to the same owner, and the foreign key to
-- `habits(id)` is evaluated with RLS bypassed — so a row carrying the
-- ATTACKER's user_id and the VICTIM's habit_id satisfied every check.
--
-- The consequence was not a data leak but a denial of service, and a
-- permanent one. `entries` is keyed on (habit_id, date), so the planted row
-- occupies that slot: the victim's own upsert hits ON CONFLICT DO UPDATE
-- against a row their USING clause cannot see and fails outright, and their
-- DELETE matches nothing. They cannot clear it, and it surfaces as a 500 with
-- no way to self-remedy.
--
-- No shipped route could reach it — every one resolves the habit through an
-- RLS-scoped query first — so this was a defence-in-depth failure rather than
-- a live breach. It mattered because CLAUDE.md promises "a query that forgets
-- its WHERE clause returns nothing; the isolation fails closed", and that
-- promise is exactly what licenses future routes to lean on RLS.

-- A composite key is what lets a foreign key carry the owner across.
ALTER TABLE habits
  ADD CONSTRAINT habits_id_user_key UNIQUE (id, user_id);

-- Now the FK itself enforces that an entry's habit belongs to the same user.
-- Unlike an RLS predicate this is checked even when RLS is bypassed, so it
-- holds for the migration role and any future admin path too.
ALTER TABLE entries
  ADD CONSTRAINT entries_habit_same_owner
  FOREIGN KEY (habit_id, user_id) REFERENCES habits (id, user_id)
  ON DELETE CASCADE;

-- Belt and braces: state it in the policy as well, so an attempted write is
-- rejected by RLS rather than surfacing as a foreign-key violation. The two
-- fail differently — a policy denial is a 403-shaped "not yours", an FK error
-- is a 500 — and the former is the honest answer.
DROP POLICY IF EXISTS entries_owner ON entries;
CREATE POLICY entries_owner ON entries
  USING (user_id = app_current_user_id())
  WITH CHECK (
    user_id = app_current_user_id()
    AND EXISTS (
      SELECT 1 FROM habits h
       WHERE h.id = entries.habit_id
         AND h.user_id = app_current_user_id()
    )
  );
