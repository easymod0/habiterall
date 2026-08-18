-- A habit's icon: at most one grapheme, decided by parseIcon (shared/src/
-- validate.js) — a Zalgo stack of combining marks is one grapheme, so the
-- bound below is a LENGTH, not a "one character" rule; "one grapheme" is not
-- expressible as a SQL constraint. '' means none.
--
-- This is NOT a mirror of LIMITS.icon, unlike 012's CHECK. `char_length`
-- counts codepoints and LIMITS.icon (32) counts UTF-16 units, so this bound is
-- looser by up to a factor of two for an astral-heavy grapheme — a value that
-- clears this CHECK can still be past the JS rule. It stays at 32 anyway: a
-- codepoint count is a perfectly good backstop, it is just a different number
-- from the one it resembles. Every write path calls parseIcon first, so this
-- is unreachable through any client and exists only against a write that
-- bypasses it — a future migration or an admin script direct against the row.

ALTER TABLE habits ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT '';

ALTER TABLE habits DROP CONSTRAINT IF EXISTS habits_icon_length;
ALTER TABLE habits ADD CONSTRAINT habits_icon_length CHECK (char_length(icon) <= 32);
