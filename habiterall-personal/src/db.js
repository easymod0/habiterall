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
    -- what a day with NO ROW is worth on an at-most target: 'miss',
    -- 'success', or 'default' to follow the account's atMostUnlogged
    at_most_unlogged TEXT NOT NULL DEFAULT 'default',
    -- how the habit is SHOWN: 'amount', or 'avoid' for something you are
    -- trying not to do. Presentation only — the verdict comes from
    -- target_type and target_value, which is what lets a Loop file lose it
    -- without losing what the rows mean
    show_as       TEXT    NOT NULL DEFAULT 'amount',
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

  -- How each destination last behaved, so a delivery failure has somewhere to
  -- be SEEN. A deleted webhook or a bot kicked from its channel stops the
  -- reminders while the habit, its time and the destination toggle all go on
  -- looking correct; before this the only record was a line in the log.
  --
  -- One row per channel, holding the LAST outcome and nothing more — a history
  -- would answer a question nobody is asking. Written only when the state
  -- changes, so a working instance writes to this table roughly never.
  --
  -- Not in the settings table, deliberately. This is the server reporting on
  -- itself, not a preference: it is never sent by the client and never included
  -- in a backup, and channelConfigured stays the only authority on whether a
  -- destination CAN deliver. This says only whether it DID.
  CREATE TABLE IF NOT EXISTS notify_status (
    channel   TEXT PRIMARY KEY,
    ok        INTEGER NOT NULL,
    status    INTEGER,
    error     TEXT    NOT NULL DEFAULT '',
    permanent INTEGER NOT NULL DEFAULT 0,
    mode      TEXT    NOT NULL DEFAULT '',
    date      TEXT    NOT NULL DEFAULT '',
    -- ISO 8601 with the Z, matching the cloud edition's TIMESTAMPTZ over the
    -- wire. The neighbouring columns above predate the endpoint that exposes
    -- this one and are not shipped to a client, which is why they differ.
    at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );

  -- The single account's credentials, when this instance has auth on and is
  -- not configured from the environment.
  --
  -- Deliberately NOT a row in 'settings'. That table is handed to the browser
  -- wholesale by GET /api/settings, and it is also captured by the backup that
  -- GET /api/export produces — so a password hash there would travel in every
  -- exported file and be one filter away from being served to a client. This
  -- is the same rule that keeps DISCORD_BOT_TOKEN out of settings (CLAUDE.md).
  --
  -- One row, enforced by the CHECK: there is one user in this edition.
  CREATE TABLE IF NOT EXISTS auth_credentials (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    username   TEXT NOT NULL,
    -- scrypt, formatted by shared/src/password.js — never plaintext
    hash       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Secrets the server generates for itself, when the operator has not supplied
  -- one. Currently just the session-signing key.
  --
  -- A table of its own for the same reason auth_credentials is: 'settings' is
  -- served to the browser by GET /api/settings and copied into every backup by
  -- GET /api/export. A session secret in a backup file signs cookies for the
  -- instance that restores it.
  CREATE TABLE IF NOT EXISTS server_secrets (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Server-side sessions, so signing out can actually revoke one. See
  -- src/session-store.js for why this is not connect-sqlite3.
  CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT    PRIMARY KEY,
    data       TEXT    NOT NULL,
    -- epoch ms, so expiry is a comparison and not a date parse on every read
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
  CREATE INDEX IF NOT EXISTS idx_habits_pos  ON habits(position, id);
  CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
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
if (!habitColumns.has('show_as')) {
  db.exec(`ALTER TABLE habits ADD COLUMN show_as TEXT NOT NULL DEFAULT 'amount'`);
  console.log('migrated habits: added show_as');
}
if (!habitColumns.has('at_most_unlogged')) {
  // 'default' for everything that already exists, which is the one value that
  // changes nothing: the account's answer is what those habits were being
  // scored with a moment before the upgrade.
  db.exec(
    `ALTER TABLE habits ADD COLUMN at_most_unlogged TEXT NOT NULL DEFAULT 'default'`
  );
  console.log('migrated habits: added at_most_unlogged');
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
