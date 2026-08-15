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
import { DATE_RE } from './validate.js';

const MILLIS_PER_DAY = 86_400_000;
const LOOP_NUMERIC_SCALE = 1000;

const LOOP_NO = 0;
const LOOP_YES_MANUAL = 2;
const LOOP_SKIP = 3;

/** Loop's database version, written into user_version / the Metadata table. */
const LOOP_DB_VERSION = 25;

/**
 * How many rows the export left out, on the response that carries the file.
 *
 * A COUNT and nothing else. The obvious improvement is to name the rows here
 * too, and it is a header-injection primitive: a habit name is free text, a
 * `\r\n` in one splits the response, and Node's rejection of the invalid
 * header would throw inside the route — re-creating the 500 this whole change
 * exists to remove. The detail belongs in the log, which has an encoder.
 *
 * Declared here rather than in each edition's routes so the two cannot drift;
 * both editions send it, and `0` is never sent, so its presence is the signal.
 */
export const EXPORT_SKIPPED_HEADER = 'X-Habiterall-Export-Skipped';

/** How many skipped rows one log line names before it stops listing them. */
const MAX_LOGGED_SKIPS = 20;

/**
 * The skip report as a single log FIELD: `7@2026-02-30=bad_date`.
 *
 * Handing `log.warn` the array itself renders as `[1 items]` — `log.js` does
 * that to every array on purpose, so a stray payload cannot turn one event into
 * ten thousand lines — which says that something was dropped and not what, and
 * *what* is the only part the user could act on. So it is flattened here, once,
 * rather than in each edition's route.
 *
 * Only ids, dates and reasons, which is the whole of what the README permits a
 * log to hold; the habit's name is deliberately not in the structure to begin
 * with. The tail is counted rather than left to `MAX_FIELD`, whose truncation
 * would land mid-token and read as a date.
 */
export function skipsForLog(skipped) {
  const head = skipped.slice(0, MAX_LOGGED_SKIPS)
    .map((s) => `${s.habit}@${s.date}=${s.reason}`).join(' ');
  const rest = skipped.length - MAX_LOGGED_SKIPS;
  return rest > 0 ? `${head} +${rest} more` : head;
}

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
 * Does this date survive the trip into Loop's encoding and back as itself?
 *
 * `Date.UTC` rolls over rather than refusing, so `isoToLoopTimestamp` answers
 * for dates that do not exist: `2026-02-30` comes back as 2026-03-02 and
 * `2026-13-45` as 2027-02-14. The API has never accepted either — `assertDate`
 * refuses both — but an import writer checking only `DATE_RE` let them into
 * storage, and from there the export had no good answer. It wrote the rolled-over
 * day, filing an entry under a date the user never chose; and when the day it
 * rolled onto was a REAL row, the UNIQUE index on (habit, timestamp) rejected
 * the insert and the whole request became a 500. Permanently, for as long as the
 * row existed, naming neither the habit nor the date at fault.
 *
 * The question asked here is the EXPORTER's, not the calendar's: is the
 * timestamp about to be written one that reads back as the day it came from?
 * That is deliberately narrower than `assertDate`, which also rejects years
 * 1-99 as a side effect of the same legacy two-digit mapping it exists to
 * catch. And it is self-correcting — the day `isoToLoopTimestamp` learns to
 * encode a date faithfully, this stops objecting to it, with nothing here to
 * remember to update.
 *
 * The shape check is `DATE_RE` rather than a third opinion about what a date
 * looks like, because `2026-1-1` encodes to the same instant as `2026-01-01`
 * and only the string says they are different days.
 */
export function isLoopEncodableDate(iso) {
  if (!DATE_RE.test(iso ?? '')) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const back = new Date(isoToLoopTimestamp(iso));
  return back.getUTCFullYear() === y
    && back.getUTCMonth() === m - 1
    && back.getUTCDate() === d;
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
 * A row Loop cannot be told about is left out and NAMED, never dropped
 * quietly — that is the same news `applyImport` reports as `skipped` on the way
 * in, and the reason this returns it rather than throwing.
 *
 * It is `{habit, date, reason}` rather than `applyImport`'s sentence, and the
 * difference is the consumer. That report is rendered into the import dialog,
 * so it can say `bad date on "Water"`; this one's only reader is a server log,
 * where the README's rule is that habit names, notes and values never appear —
 * `habit=7 date=2026-02-30` is the whole of what may be written down. Structured
 * also survives a UI later formatting its own sentence, which a string does not.
 *
 * @param {string} path            destination file (must not already exist)
 * @param {Array}  habits          habiterall habit rows
 * @param {Function} entriesFor    (habitId) => [{date, value, status, notes}]
 * @returns {Promise<{habits: number, entries: number,
 *                    skipped: Array<{habit: any, date: string, reason: string}>}>}
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
    const skipped = [];

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

      // One habit's worth, because the UNIQUE index is on (habit, timestamp).
      const claimed = new Set();

      for (const e of entriesFor(h.id)) {
        const value = toLoopEntry(h, e);
        if (value === null) continue;

        if (!isLoopEncodableDate(e.date)) {
          skipped.push({ habit: h.id, date: String(e.date), reason: 'bad_date' });
          continue;
        }

        const ts = isoToLoopTimestamp(e.date);

        // A backstop, and it should never fire: distinct encodable dates give
        // distinct UTC midnights, and neither edition can store two rows for
        // one habit and day. But `entriesFor` is a callback this module cannot
        // audit, and the cost of being wrong about that was the whole export —
        // one insert throwing takes every habit down with it, and the caller is
        // handed a 500 with nothing to act on. A named skip is the smaller loss.
        if (claimed.has(ts)) {
          skipped.push({ habit: h.id, date: String(e.date), reason: 'duplicate_day' });
          continue;
        }
        claimed.add(ts);

        insertRep.run(h.id, ts, value, e.notes ?? '');
        written++;
      }
    });

    return { habits: habits.length, entries: written, skipped };
  } finally {
    db.close();
  }
}
