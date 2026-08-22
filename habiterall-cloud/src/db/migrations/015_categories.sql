-- A user's own habit groupings, never seeded — an account starts with none,
-- and the six suggestion chips in the picker create one only when tapped.
-- `LIMITS.categories` (validate.js) caps how many an account may hold,
-- chip-created or typed, checked by the route inside the same transaction as
-- the insert. Uncategorised is a STATE (habits.category_id IS NULL), not a
-- row here — there is deliberately no "Other" category.
--
-- `ON DELETE CASCADE` here is right for THIS reference (a deleted account
-- takes its categories with it), unlike habits.category_id below, where the
-- opposite call was made: deleting a category must not destroy the habits
-- that wore it.
--
-- A unique index on (user_id, lower(name)), not an inline table-level UNIQUE:
-- Postgres's table-constraint UNIQUE(...) only ever takes column names, never
-- an expression, and lower(name) is one — the same reason migration 004 built
-- `users_idp_identity_key` as a separate CREATE UNIQUE INDEX rather than a
-- constraint on the CREATE TABLE. lower() is Postgres's Unicode-aware fold —
-- 'Élan' and 'élan' collide here where SQLite's ASCII-only NOCASE would treat
-- them as different categories. That divergence is exactly why the uniqueness
-- check a request gets 409'd by is the route-level `foldCategoryName`
-- (shared/src/validate.js — plain toLowerCase(), which is ALREADY full
-- Unicode case folding and so is the closer match to this lower(), not
-- toLocaleLowerCase(), which would tailor the fold to whichever locale the
-- APP's host happens to be running instead), not this index: this stays a
-- backstop for a race or a fold disagreement, caught in the route
-- (`isCategoryNameConflict`, db/pool.js) and mapped to 409 rather than left
-- to surface as this constraint's own 500. The shared function draws the
-- SAME line as this lower() for every input the two constraints can tell
-- apart — not for every input, full stop: U+0130 (İ) is the known
-- divergence, where JS's toLowerCase() answers 'i' plus a combining dot and
-- glibc's lower() answers a bare 'i', so 'İstanbul' imported into an account
-- already holding 'Istanbul' skips the category here and creates a second
-- one in the personal edition (docs/decisions/categories.md).
CREATE TABLE IF NOT EXISTS categories (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  color      TEXT        NOT NULL DEFAULT '#3b82f6'
               CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  position   INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS categories_user_name_key
  ON categories (user_id, lower(name));

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;

-- The ordinary owner policy — the key leads with user_id, so the invisible-row
-- squat migrations 007/008 guard against cannot arise here.
DROP POLICY IF EXISTS categories_owner ON categories;
CREATE POLICY categories_owner ON categories
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

-- DELETE is the difference from notify_status's grant: that table is upserted
-- in place and nothing ever removes a row, where a category is a label a user
-- creates and later disbands (DELETE /categories/:id), and the account must be
-- able to do that itself rather than accumulate labels forever.
--
-- No grant on the backing sequence: migration 002 already runs
-- `ALTER DEFAULT PRIVILEGES ... GRANT USAGE, SELECT ON SEQUENCES` for
-- habiterall_app, and `GENERATED ALWAYS AS IDENTITY` uses that same
-- mechanism, so a new table's identity sequence needs no explicit grant here.
GRANT SELECT, INSERT, UPDATE, DELETE ON categories TO habiterall_app;

-- Which of this account's categories the habit belongs to, or none.
-- `ON DELETE SET NULL`, never CASCADE: deleting a category is tidying up a
-- label, not a request to destroy every habit that wore it — that habit and
-- every entry on it survive, uncategorised. A habit PUT REPLACES this field
-- along with every other, so an omitted category_id is a stated clear
-- (validate.js's parseHabit, same rule icon's comment already states).
ALTER TABLE habits ADD COLUMN IF NOT EXISTS category_id BIGINT
  REFERENCES categories(id) ON DELETE SET NULL;

-- Postgres does NOT index the referencing side of a foreign key for you — only
-- the referenced side, via the primary key. `ON DELETE SET NULL` above obliges
-- it to find every habit pointing at a category being deleted, so without this
-- index that delete is a sequential scan of `habits`.
--
-- It matters more here than in the personal edition, for a reason that is easy
-- to miss: `habits` holds EVERY tenant's rows in one table, and a foreign-key
-- check runs internally with RLS not applied to it — the same property that
-- makes this FK not a tenancy boundary. So one account deleting one category
-- scans every account's habits, not its own.
--
-- Not a measured bottleneck: habits are capped per user and category deletes
-- are rare. It is cheap insurance, and the index costs less than the scan it
-- removes because nothing writes `category_id` in bulk.
CREATE INDEX IF NOT EXISTS habits_category_id_idx ON habits (category_id);
