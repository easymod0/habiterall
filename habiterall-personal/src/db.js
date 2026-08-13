import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// node:sqlite is stable in Node 22 but still emits an ExperimentalWarning on
// import. Filter just that warning so it doesn't clutter container logs.
const emit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const name = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (name === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
  return emit.call(process, warning, ...rest);
};

const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emit;

const DB_PATH = process.env.HABITERALL_DB ?? './data/habiterall.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS habits (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    description   TEXT    NOT NULL DEFAULT '',
    -- 'boolean' = yes/no checkmark, 'numerical' = measurable value
    type          TEXT    NOT NULL DEFAULT 'boolean',
    unit          TEXT    NOT NULL DEFAULT '',
    -- numerical habits only: the daily goal
    target_value  REAL    NOT NULL DEFAULT 0,
    -- 'at_least' (drink 8 glasses) or 'at_most' (smoke 0 cigarettes)
    target_type   TEXT    NOT NULL DEFAULT 'at_least',
    -- how many times per freq_denominator days, e.g. 3 per 7 = 3x/week
    freq_numerator   INTEGER NOT NULL DEFAULT 1,
    freq_denominator INTEGER NOT NULL DEFAULT 1,
    color         TEXT    NOT NULL DEFAULT '#3b82f6',
    position      INTEGER NOT NULL DEFAULT 0,
    archived      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS entries (
    habit_id  INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    -- local calendar date, 'YYYY-MM-DD'
    date      TEXT    NOT NULL,
    -- boolean: 2 = yes.  numerical: the raw amount.
    -- Skips live in the status column, NOT here: a numerical habit may
    -- legitimately record the value 3, which must never alias a skip.
    value     REAL    NOT NULL,
    -- '' = a normal recorded value, 'skip' = day excluded from scoring
    status    TEXT    NOT NULL DEFAULT '',
    notes     TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (habit_id, date)
  );

  -- Preferences. A single-row key/value table rather than a users table,
  -- because this edition has exactly one implicit user. Keeping it in the
  -- database (not localStorage) means settings survive a browser reset and
  -- are captured by the same backup as the habits.
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
  CREATE INDEX IF NOT EXISTS idx_habits_pos  ON habits(position, id);
`);

/**
 * Migration: skips used to be stored in-band as the value 3, which collides
 * with a numerical habit legitimately recording 3 units. Move them into
 * `status` and, for numerical habits, drop the ambiguous rows rather than
 * guess — a boolean 3 is unambiguously a skip, a numerical 3 is not.
 */
const entryColumns = new Set(
  db.prepare(`PRAGMA table_info(entries)`).all().map((c) => c.name)
);

if (!entryColumns.has('status')) {
  db.exec(`ALTER TABLE entries ADD COLUMN status TEXT NOT NULL DEFAULT ''`);
  db.exec(`
    UPDATE entries SET status = 'skip', value = 0
    WHERE value = 3
      AND habit_id IN (SELECT id FROM habits WHERE type = 'boolean');
  `);
  console.log('migrated entries: skips moved to the status column');
}

// Entry sentinel values, mirroring Loop Habit Tracker's encoding.
// SKIP is retained only as an API/wire value; it is never stored in
// `entries.value` — see the `status` column.
export const UNSET = 0;
export const YES = 2;
export const SKIP = 3;

export default db;
