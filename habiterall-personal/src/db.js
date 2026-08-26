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
    -- one grapheme, decided by parseIcon; '' = none
    icon          TEXT    NOT NULL DEFAULT '',
    -- which of this account's categories the habit belongs to, or none.
    -- Uncategorised is category_id IS NULL, never a category of its own; see
    -- categories below. A habit PUT replaces this field along with every
    -- other, so an omitted category_id is a stated clear (validate.js).
    category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
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

  -- A user's own habit groupings. Never seeded — an account starts with none,
  -- and the six suggestion chips in the picker create one only when tapped
  -- (LIMITS.categories caps how many, chip-created or typed, an account may
  -- hold). Uncategorised is a STATE (habits.category_id IS NULL), not a row
  -- here, so there is deliberately no "Other" category.
  --
  -- UNIQUE folds ASCII case only (SQLite NOCASE); the Unicode-aware check that
  -- keeps 'Élan' and 'élan' one category in both editions is a route-level
  -- lookup through foldCategoryName (validate.js — plain toLowerCase(), not
  -- toLocaleLowerCase(), which would tailor the fold to whichever locale this
  -- host happens to be running rather than matching this NOCASE and
  -- Postgres's lower() consistently). This constraint stays only as a
  -- backstop for a race the route check missed, or a fold that disagrees
  -- with SQLite's ASCII-only NOCASE — see isCategoryNameConflict below, which
  -- is what turns hitting it into a 409 rather than a 500.
  CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    color      TEXT    NOT NULL DEFAULT '#3b82f6',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(name COLLATE NOCASE)
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

  -- What the last client to check in said its clock was, for 'auto'.
  --
  -- Its own table for the same reason notify_status has one: this is an
  -- OBSERVATION, not a preference. It arrives on a header rather than through
  -- PUT /api/settings, it must never travel in a backup — restoring on a
  -- laptop in another country should not move your reminders — and it has to
  -- stay tellable apart from a zone the user CHOSE, or 'auto' becomes a
  -- one-way door. resolveTimeZone reads it only when the setting says 'auto'.
  -- (No backticks in here: this whole schema is one template literal.)
  --
  -- One row, because this edition has one account; the CHECK pins it.
  CREATE TABLE IF NOT EXISTS device_clock (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    time_zone TEXT NOT NULL DEFAULT '',
    at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
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
if (!habitColumns.has('icon')) {
  db.exec(`ALTER TABLE habits ADD COLUMN icon TEXT NOT NULL DEFAULT ''`);
  console.log('migrated habits: added icon');
}
if (!habitColumns.has('category_id')) {
  // SQLite requires an added column to default NULL when it carries a foreign
  // key — which is exactly what every pre-existing habit should become:
  // uncategorised, not a category that has to be invented for it.
  db.exec(
    `ALTER TABLE habits ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL`
  );
  console.log('migrated habits: added category_id');
}

// Indexed because `habits.category_id` is the REFERENCING side of a foreign
// key with `ON DELETE SET NULL`: deleting a category obliges SQLite to find
// every habit pointing at it, and without an index that is a full scan of
// `habits`. Deletes are rare and this table is one account's, so this is
// cheap insurance rather than a measured win — but the cost of the index is
// smaller still, since nothing writes `category_id` in bulk.
//
// Declared HERE and not beside the other `CREATE INDEX` lines in the schema
// above, and that placement is the whole point: those run in the same `exec`
// as the `CREATE TABLE`s, which is BEFORE the `PRAGMA table_info` guard that
// adds this column to a database that predates it. An index on a column that
// does not exist yet throws, so it would have taken out every upgrade while
// passing on every fresh install.
db.exec(`CREATE INDEX IF NOT EXISTS idx_habits_category ON habits(category_id)`);

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

/**
 * Whether ERR is node:sqlite reporting the categories table's own
 * `UNIQUE(name COLLATE NOCASE)` constraint (above) refusing an INSERT or
 * UPDATE — the DB-level backstop firing on a race the route's own
 * `categoryNameTaken` check missed, or on a name whose only difference from
 * an existing one is outside ASCII case, which this constraint cannot fold
 * the way `foldCategoryName` does.
 *
 * Matched on the SQLite constraint-violation code AND the column named at
 * the END of the message, not on the message alone: `errcode` narrows to a
 * UNIQUE violation of any kind, and anchoring the column name to the end
 * narrows it to a violation whose LAST (here, only) column is this table's
 * own `name` — so a caller cannot mistake some other table's collision for a
 * duplicate category name. It does NOT, on its own, distinguish every
 * possible future second constraint on this table: node:sqlite lists every
 * column a compound UNIQUE names, in order, so a hypothetical
 * `UNIQUE(name, position)` violation would read
 * `"... categories.name, categories.position"` — caught by an unanchored
 * match, correctly excluded by this one, because `position` and not `name`
 * is the column actually named last. A compound constraint whose LAST column
 * happened to be `name` would still match; there is no such constraint on
 * this table today, so this is a bound on what this check happens to answer
 * for a message shaped like SQLite's own, not a proof that it always will.
 *
 * @param {any} err
 * @returns {boolean}
 */
export function isCategoryNameConflict(err) {
  return err?.code === 'ERR_SQLITE_ERROR' && err.errcode === 2067 &&
    /categories\.name$/.test(String(err?.message ?? ''));
}

export default db;
