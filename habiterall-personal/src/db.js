import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// A plain static import: node:sqlite no longer emits an ExperimentalWarning
// on Node 26, which is the floor `engines` now states. Under Node 22 it did,
// and this was a dynamic import wrapped in a `process.emitWarning` patch to
// keep one line out of every container log — restore that, not the import,
// if the floor ever goes back down.
import { DatabaseSync } from 'node:sqlite';

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
    -- local 'HH:MM' the mobile app schedules a reminder for; '' = none
    reminder_time TEXT    NOT NULL DEFAULT '',
    -- what the reminder asks ('Did you exercise today?'); '' = a sentence
    -- built from the habit's own name and goal
    reminder_message TEXT NOT NULL DEFAULT '',
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

  -- What the server has already sent, so a reminder goes out once.
  --
  -- Keyed on the LOCAL date the reminder was for, not on a timestamp: the
  -- question being asked is "has today's 08:00 nudge gone yet", and a
  -- timestamp would need re-deriving the day boundary in the user's zone
  -- every time it was read. The channel is part of the key so switching on a
  -- new destination is not silenced for its first day by a send to another.
  --
  -- On-device channels (the Android alarm) never appear here; the phone owns
  -- its own schedule and works with the server unreachable.
  CREATE TABLE IF NOT EXISTS notify_log (
    habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    channel  TEXT    NOT NULL,
    date     TEXT    NOT NULL,
    sent_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (habit_id, channel, date)
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
const habitColumns = new Set(
  db.prepare(`PRAGMA table_info(habits)`).all().map((c) => c.name)
);
if (!habitColumns.has('reminder_time')) {
  db.exec(`ALTER TABLE habits ADD COLUMN reminder_time TEXT NOT NULL DEFAULT ''`);
  console.log('migrated habits: added reminder_time');
}
if (!habitColumns.has('reminder_message')) {
  db.exec(`ALTER TABLE habits ADD COLUMN reminder_message TEXT NOT NULL DEFAULT ''`);
  console.log('migrated habits: added reminder_message');
}

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
