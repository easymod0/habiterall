-- A habit's icon: at most one grapheme, decided by parseIcon (shared/src/
-- validate.js) — a Zalgo stack of combining marks is one grapheme, so the
-- bound below is a LENGTH, not a "one character" rule; "one grapheme" is not
-- expressible as a SQL constraint. '' means none.
--
-- The CHECK is here as well as in validate.js for the reason 012's is: the
-- importer reaches this table too, and a value outside the bound would be
-- truncated silently by whatever read it next rather than rejected here.

ALTER TABLE habits ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT '';

ALTER TABLE habits DROP CONSTRAINT IF EXISTS habits_icon_length;
ALTER TABLE habits ADD CONSTRAINT habits_icon_length CHECK (char_length(icon) <= 32);
