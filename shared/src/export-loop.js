/**
 * Export a habiterall database as a Loop Habit Tracker backup (.db), so the
 * data can be restored into the Loop Android app.
 *
 * This is the exact inverse of the import in src/import.js, against the same
 * schema confirmed from iSoron/uhabits @ dev:
 *
 *   Habits      (id, name, description, question, freq_num, freq_den, color,
 *                position, reminder_hour, reminder_min, reminder_days,
 *                highlight, archived, type, target_value, target_type, unit, uuid)
 *   Repetitions (id, habit, timestamp, value, notes)
 *
 *   - timestamp: epoch MILLISECONDS at UTC midnight
 *   - boolean entries: NO = 0, YES_MANUAL = 2, SKIP = 3 (absent = UNKNOWN,
 *     which is a day nobody has answered rather than a day answered "no")
 *   - numerical entries and targets: scaled by 1000
 *   - type: 0 = YES_NO, 1 = NUMERICAL;  target_type: 0 = AT_LEAST, 1 = AT_MOST
 */

import { randomUUID } from 'node:crypto';
import { LOOP_ALL_DAYS } from './import.js';

const MILLIS_PER_DAY = 86_400_000;
const LOOP_NUMERIC_SCALE = 1000;

const LOOP_NO = 0;
const LOOP_YES_MANUAL = 2;
const LOOP_SKIP = 3;

/** Loop's database version, written into user_version / the Metadata table. */
const LOOP_DB_VERSION = 25;

/**
 * The palette habiterall maps Loop colour indices onto when importing.
 * Reversing it keeps a round trip visually stable.
 */
const LOOP_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#78716c',
  '#64748b', '#475569',
];

/** Nearest palette index for a hex colour, by squared RGB distance. */
export function colorToLoopIndex(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return 10; // blue
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  let best = 10;
  let bestDist = Infinity;
  LOOP_PALETTE.forEach((p, i) => {
    const pr = parseInt(p.slice(1, 3), 16);
    const pg = parseInt(p.slice(3, 5), 16);
    const pb = parseInt(p.slice(5, 7), 16);
    const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (dist < bestDist) { bestDist = dist; best = i; }
  });
  return best;
}

/**
 * 'HH:MM' -> Loop's two integer columns, and `[null, null]` for no reminder.
 *
 * The inverse of `loopReminderToTime` in import.js. Anything that is not the
 * stored form is no reminder: `reminder_time` is already normalised against
 * TIME_RE by both `parseHabit` and `normaliseImportedHabit`, so a value that
 * fails here came from somewhere that had no business writing one.
 */
export function timeToLoopReminder(time) {
  if (typeof time !== 'string') return [null, null];
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!m) return [null, null];
  return [Number(m[1]), Number(m[2])];
}

/** 'YYYY-MM-DD' -> epoch millis at UTC midnight, matching Loop's storage. */
export function isoToLoopTimestamp(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Loop's sentinel band: NO(0), YES_AUTO(1), YES_MANUAL(2), SKIP(3).
 *
 * On a numerical habit these are ALSO valid scaled amounts — 3 means both
 * "skipped" and "0.003 units" — and Loop itself resolves the ambiguity in
 * favour of the sentinel. The collision is inherent to the format, so the
 * only place it can be avoided is here, on the way out.
 */
const LOOP_SENTINEL_MAX = 3;

/**
 * Translate one habiterall entry into Loop's encoding.
 * Returns null for rows Loop has no representation for.
 */
export function toLoopEntry(habit, entry) {
  if (entry.status === 'skip') return LOOP_SKIP;

  if (habit.type === 'numerical') {
    const n = Number(entry.value);
    if (!Number.isFinite(n)) return null;

    const scaled = Math.round(n * LOOP_NUMERIC_SCALE);

    // A tiny non-zero amount scales into the sentinel band and would be read
    // back as a SKIP — destroying the recorded amount AND turning a failure
    // into a skipped day, which bridges streaks and inflates scores. Rounding
    // up to 4 (0.004 units) is a rounding error at a scale nothing tracks;
    // silently converting the day to a skip is data loss.
    if (scaled > 0 && scaled <= LOOP_SENTINEL_MAX) return LOOP_SENTINEL_MAX + 1;

    return scaled;
  }

  // Boolean. A row exists, so the day was answered: YES_MANUAL or Loop's own
  // explicit NO. Only the days habiterall has no row for are left out, and Loop
  // reads a missing day as UNKNOWN — which is what they are. Writing `null`
  // here for a stated "no" was lossless while the two were one state; now it
  // would quietly turn every lapse into "never answered" on the way out.
  return Number(entry.value) === 2 ? LOOP_YES_MANUAL : LOOP_NO;
}

/**
 * Build a Loop-compatible SQLite database at `path`.
 *
 * @param {string} path            destination file (must not already exist)
 * @param {Array}  habits          habiterall habit rows
 * @param {Function} entriesFor    (habitId) => [{date, value, status, notes}]
 */
export async function writeLoopDatabase(path, habits, entriesFor) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);

  try {
    db.exec(`
      CREATE TABLE Habits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        archived INTEGER,
        color INTEGER,
        description TEXT,
        freq_den INTEGER,
        freq_num INTEGER,
        highlight INTEGER,
        name TEXT,
        position INTEGER,
        reminder_hour INTEGER,
        reminder_min INTEGER,
        reminder_days INTEGER NOT NULL DEFAULT 127,
        type INTEGER NOT NULL DEFAULT 0,
        target_type INTEGER NOT NULL DEFAULT 0,
        target_value REAL NOT NULL DEFAULT 0,
        unit TEXT NOT NULL DEFAULT "",
        question TEXT,
        uuid TEXT
      );

      CREATE TABLE Repetitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        habit INTEGER REFERENCES Habits(id),
        timestamp INTEGER,
        value INTEGER,
        notes TEXT
      );

      CREATE UNIQUE INDEX idx_repetitions_habit_timestamp
        ON Repetitions(habit, timestamp);

      CREATE TABLE Metadata (version INTEGER NOT NULL DEFAULT 0);
    `);

    db.exec(`PRAGMA user_version = ${LOOP_DB_VERSION}`);
    db.prepare(`INSERT INTO Metadata (version) VALUES (?)`).run(LOOP_DB_VERSION);

    const insertHabit = db.prepare(`
      INSERT INTO Habits (id, archived, color, description, freq_den, freq_num,
                          highlight, name, position, reminder_hour, reminder_min,
                          reminder_days, type, target_type, target_value, unit,
                          question, uuid)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRep = db.prepare(`
      INSERT INTO Repetitions (habit, timestamp, value, notes) VALUES (?, ?, ?, ?)
    `);

    let written = 0;

    habits.forEach((h, position) => {
      const isNumerical = h.type === 'numerical';
      // habiterall has no per-weekday reminder concept, so a reminder it does
      // have is an all-days one: 127, every bit of Loop's weekday mask. A habit
      // with NO reminder gets 0, which is what Loop's own writer stores
      // (`reminder?.days?.toInteger() ?: 0`) — Loop never reads the mask unless
      // both hour and minute are non-null, so this is fidelity rather than
      // function. When per-weekday reminders land, this is where they go.
      const [reminderHour, reminderMin] = timeToLoopReminder(h.reminder_time);
      const reminderDays = reminderHour === null ? 0 : LOOP_ALL_DAYS;

      insertHabit.run(
        h.id,
        h.archived ? 1 : 0,
        colorToLoopIndex(h.color),
        h.description ?? '',
        Math.max(1, Number(h.freq_denominator) || 1),
        Math.max(1, Number(h.freq_numerator) || 1),
        h.name,
        position,
        reminderHour,
        reminderMin,
        reminderDays,
        isNumerical ? 1 : 0,
        h.target_type === 'at_most' ? 1 : 0,
        // Targets are stored UNSCALED in Loop's Habits table, unlike entry
        // values in Repetitions. Multiplying here would make a target of 2
        // import back as 2000 in the Loop app.
        isNumerical ? Number(h.target_value ?? 0) : 0,
        h.unit ?? '',
        // question: Loop's prompt for the reminder, which is what
        // reminder_message is. Written as '' here for years, with a comment
        // saying there was no equivalent field — true when it was written.
        h.reminder_message ?? '',
        randomUUID().replace(/-/g, '')
      );

      for (const e of entriesFor(h.id)) {
        const value = toLoopEntry(h, e);
        if (value === null) continue;
        insertRep.run(h.id, isoToLoopTimestamp(e.date), value, e.notes ?? '');
        written++;
      }
    });

    return { habits: habits.length, entries: written };
  } finally {
    db.close();
  }
}
