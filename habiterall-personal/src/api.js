import express from 'express';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { db, UNSET, YES, SKIP } from './db.js';
import {
  computeStats, computeStreaks, bestStreak, isCompleted, UNLOGGED_DEFAULT,
  today, addDays, daysBetween, MAX_RANGE_DAYS,
} from '@habiterall/shared/stats.js';

/** Lookback used for the dashboard's score/current-streak summary. */
const SUMMARY_WINDOW_DAYS = 400;

/**
 * How far back the dashboard's streak scan reads. Five years — far beyond
 * any streak a person will run, and it keeps the dashboard O(window) per
 * habit instead of O(lifetime). Matches the cloud edition.
 */
const STREAK_HISTORY_DAYS = 1830;
// Format sniffing and every parser live in shared: the two editions had
// separate copies of the sniffing, and they had drifted.
import { backupSettings, parseUpload } from '@habiterall/shared/import.js';
import { applyImport } from './apply-import.js';
import { deliveryStatus, sendTest } from './notifier.js';
import {
  parseHabit, parseEntry, parseSettings, portableSettings, entryWrite, assertDate,
  assertNotFuture,
  DATE_RE,
} from '@habiterall/shared/validate.js';
import {
  writeLoopDatabase, EXPORT_SKIPPED_HEADER, skipsForLog,
} from '@habiterall/shared/export-loop.js';
import { buildCsvArchive } from '@habiterall/shared/export-csv.js';
import { log } from '@habiterall/shared/log.js';

export const api = express.Router();

/* ---------- statements ---------- */

const q = {
  allHabits: db.prepare(
    `SELECT * FROM habits WHERE archived = ? ORDER BY position, id`
  ),
  habitById: db.prepare(`SELECT * FROM habits WHERE id = ?`),
  insertHabit: db.prepare(`
    INSERT INTO habits (name, description, type, unit, target_value, target_type,
                        freq_numerator, freq_denominator, color, reminder_time,
                        reminder_message, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            COALESCE((SELECT MAX(position) + 1 FROM habits), 0))
  `),
  updateHabit: db.prepare(`
    UPDATE habits SET name = ?, description = ?, type = ?, unit = ?,
      target_value = ?, target_type = ?, freq_numerator = ?,
      freq_denominator = ?, color = ?, reminder_time = ?, reminder_message = ?,
      archived = ?
    WHERE id = ?
  `),
  deleteHabit: db.prepare(`DELETE FROM habits WHERE id = ?`),
  setPosition: db.prepare(`UPDATE habits SET position = ? WHERE id = ?`),
  // `status` is carried alongside `value` rather than folded into it: a
  // numerical habit may legitimately record 3, which must never be mistaken
  // for the SKIP sentinel.
  entriesFor: db.prepare(`
    SELECT date, value, status, notes
    FROM entries WHERE habit_id = ? ORDER BY date
  `),
  /**
   * Lifetime completion count, done in SQLite instead of by walking every
   * row in JS. The CASE mirrors `isCompleted` exactly — a skip is never a
   * completion, whatever its value.
   */
  countCompleted: db.prepare(`
    SELECT COUNT(*) AS n FROM entries
     WHERE habit_id = ?
       AND COALESCE(status, '') <> 'skip'
       AND CASE
             WHEN ? = 'boolean'  THEN value = 2
             WHEN ? = 'at_most'  THEN value <= ?
             ELSE value >= ?
           END
  `),
  entriesInRange: db.prepare(`
    SELECT habit_id, date, value, status
    FROM entries WHERE date >= ? AND date <= ? ORDER BY date
  `),
  entriesForSince: db.prepare(`
    SELECT date, value, status, notes
    FROM entries WHERE habit_id = ? AND date >= ? ORDER BY date
  `),
  upsertEntry: db.prepare(`
    INSERT INTO entries (habit_id, date, value, status, notes) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(habit_id, date) DO UPDATE SET value = excluded.value,
                                              status = excluded.status,
                                              notes = excluded.notes
  `),
  deleteEntry: db.prepare(`DELETE FROM entries WHERE habit_id = ? AND date = ?`),
  allSettings: db.prepare(`SELECT key, value FROM settings`),
  putSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  clearSettings: db.prepare(`DELETE FROM settings`),
};

/* ---------- validation ---------- */

// Habit and entry rules live in @habiterall/shared/validate.js so both
// editions enforce exactly the same limits. SQLite has no boolean type, so
// `archived` is mapped to 0/1 at the call sites below.

/** Shared validation, with `archived` mapped to SQLite's 0/1. */
function habitRow(body) {
  const h = parseHabit(body);
  return { ...h, archived: h.archived ? 1 : 0 };
}

/**
 * A habit row on its way OUT to a client.
 *
 * SQLite has no boolean type, so `archived` comes back as 0 or 1 while the
 * cloud edition's Postgres BOOLEAN returns true/false — the same endpoint
 * describing the same habit with two different JSON types. The web UI happens
 * to survive it (0 and false are both falsy), but the native Android client
 * declares `archived: Boolean` and refuses to deserialise:
 *
 *   Expected valid boolean literal prefix, but had '0'
 *
 * The API contract is a boolean. Convert here, at the single boundary, rather
 * than teaching every client to accept both.
 */
function toApiHabit(row) {
  if (!row) return row;
  return { ...row, archived: Boolean(row.archived) };
}

/**
 * An Error carrying the HTTP status the API should return.
 * @param {number} status
 * @param {string} message
 * @returns {Error & {status: number}}
 */
function httpError(status, message) {
  const err = /** @type {Error & {status: number}} */ (new Error(message));
  err.status = status;
  return err;
}

/**
 * node:sqlite returns loosely-typed rows; this is the one place we assert the
 * shape our own schema guarantees.
 * @param {unknown} row
 * @returns {import('@habiterall/shared/types.js').Habit}
 */
const asHabit = (row) => /** @type {any} */ (row);

/* ---------- habits ---------- */

api.get('/habits', (req, res) => {
  const archived = req.query.archived === 'true' ? 1 : 0;
  res.json(q.allHabits.all(archived).map(toApiHabit));
});

api.post('/habits', (req, res) => {
  const h = habitRow(req.body);
  const info = q.insertHabit.run(
    h.name, h.description, h.type, h.unit, h.target_value,
    h.target_type, h.freq_numerator, h.freq_denominator, h.color, h.reminder_time,
    h.reminder_message
  );
  res.status(201).json(toApiHabit(q.habitById.get(info.lastInsertRowid)));
});

api.get('/habits/:id', (req, res) => {
  const habit = asHabit(q.habitById.get(Number(req.params.id)));
  if (!habit) throw httpError(404, 'habit not found');
  res.json(toApiHabit(habit));
});

api.put('/habits/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!q.habitById.get(id)) throw httpError(404, 'habit not found');

  const h = habitRow(req.body);
  q.updateHabit.run(
    h.name, h.description, h.type, h.unit, h.target_value, h.target_type,
    h.freq_numerator, h.freq_denominator, h.color, h.reminder_time,
    h.reminder_message, h.archived, id
  );
  res.json(toApiHabit(q.habitById.get(id)));
});

api.delete('/habits/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!q.habitById.get(id)) throw httpError(404, 'habit not found');
  q.deleteHabit.run(id);
  res.status(204).end();
});

/**
 * Ceiling on a reorder request.
 *
 * The array length was unvalidated and drove one UPDATE per element inside a
 * transaction, so a 1MB body — roughly 500,000 ids — could hold the database
 * for minutes. Duplicates pass validation too, so no habits even had to
 * exist. This edition has no rate limiter, which makes the bound matter more
 * here than in cloud, not less.
 */
const MAX_REORDER_IDS = 1000;

api.post('/habits/reorder', (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order)) throw httpError(400, 'order must be an array of habit ids');
  if (order.length > MAX_REORDER_IDS) {
    throw httpError(400, `order may not exceed ${MAX_REORDER_IDS} ids`);
  }
  if (order.some((n) => !Number.isFinite(Number(n)))) {
    throw httpError(400, 'order must contain only habit ids');
  }
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    order.forEach((id, i) => q.setPosition.run(i, Number(id)));
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  res.json(q.allHabits.all(0).map(toApiHabit));
});

/* ---------- entries ---------- */

api.get('/habits/:id/entries', (req, res) => {
  const id = Number(req.params.id);
  if (!q.habitById.get(id)) throw httpError(404, 'habit not found');
  res.json(q.entriesFor.all(id));
});

api.put('/habits/:id/entries/:date', (req, res) => {
  const id = Number(req.params.id);
  const date = req.params.date;
  const habit = asHabit(q.habitById.get(id));

  if (!habit) throw httpError(404, 'habit not found');
  assertDate(date);
  assertNotFuture(date, today());

  const parsed = parseEntry(habit, req.body, { UNSET, YES, SKIP });

  // The rule — a skip is out of band, and every other write is a ROW, including
  // value 0, which is the answer "no" — lives in shared/validate.js, because the
  // other edition and the Discord button handler have to apply exactly the same
  // one. Clearing a day is the DELETE route below, not a PUT of zero.
  const write = entryWrite(habit, parsed, { UNSET, SKIP });

  if (write.op === 'delete') q.deleteEntry.run(id, date);
  else q.upsertEntry.run(id, date, write.value, write.status, write.notes);

  res.json({ habit_id: id, date, ...write.reply });
});

api.delete('/habits/:id/entries/:date', (req, res) => {
  const id = Number(req.params.id);
  if (!q.habitById.get(id)) throw httpError(404, 'habit not found');
  if (!DATE_RE.test(req.params.date)) throw httpError(400, 'date must be YYYY-MM-DD');

  q.deleteEntry.run(id, req.params.date);
  res.status(204).end();
});

/* ---------- stats ---------- */

api.get('/habits/:id/stats', (req, res) => {
  const id = Number(req.params.id);
  const habit = asHabit(q.habitById.get(id));
  if (!habit) throw httpError(404, 'habit not found');

  // Never compute past today, and never span more than MAX_RANGE_DAYS: the
  // stats passes allocate one element per day, so an unbounded range is a
  // trivial denial of service.
  const requestedEnd = DATE_RE.test(req.query.end ?? '') ? req.query.end : today();
  const end = requestedEnd > today() ? today() : requestedEnd;

  let start = DATE_RE.test(req.query.start ?? '') ? req.query.start : undefined;
  if (start) {
    if (start > end) throw httpError(400, 'start must not be after end');
    if (daysBetween(start, end) > MAX_RANGE_DAYS) {
      throw httpError(400, `range must not exceed ${MAX_RANGE_DAYS} days`);
    }
  }

  const granularity = req.query.granularity ?? 'day';

  const entries = /** @type {any} */ (q.entriesFor.all(id));
  res.json({
    habit,
    ...computeStats(habit, entries,
      { start, end, granularity, weekStart: storedWeekStart(),
        unlogged: storedUnlogged() }),
  });
});

/**
 * The main grid: every active habit plus its entries for the last N days,
 * in one round trip so the dashboard renders without a request per habit.
 */
api.get('/overview', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

  // The dashboard can page back through history, so it asks for the window it
  // is actually showing. Without this the grid rendered empty cells for any
  // day outside the most recent fortnight — the entries were never fetched.
  const now = today();
  const requestedEnd = DATE_RE.test(req.query.end ?? '') ? req.query.end : now;
  const end = requestedEnd > now ? now : requestedEnd;
  const start = addDays(end, -(days - 1));

  // ...and `end` decides the GRID window only. The row summary — strength,
  // current streak, best streak — is a statement about the habit now, so it is
  // anchored on today whatever window is on screen. They shared one date, and
  // paging back a month restated the summary as of that month: "43%" with
  // nothing on the row to say it was not today's. The detail view is the
  // surface that answers "as of when", and it has its own range controls.
  const summaryEnd = now;

  // Archived habits are hidden by default but can be requested explicitly.
  const habits = /** @type {any[]} */ (req.query.archived === 'true'
    ? q.allHabits.all(1)
    : q.allHabits.all(0));
  const rows = q.entriesInRange.all(start, end);

  // Read once for the whole payload rather than per habit: it is one answer
  // for the account, and this loop already runs once per habit on the
  // dashboard's hot path.
  const unlogged = storedUnlogged();

  // For the grid the frontend only needs something paintable, so skips are
  // flattened onto the SKIP wire value here. Scoring never uses this map.
  // `skips` lists the skipped dates separately, so a numerical habit that
  // legitimately recorded 3 is never mistaken for a skipped day.
  const byHabit = new Map(habits.map((h) => [h.id, {}]));
  const skipsByHabit = new Map(habits.map((h) => [h.id, []]));
  for (const r of rows) {
    const bucket = byHabit.get(r.habit_id);
    if (!bucket) continue;
    if (r.status === 'skip') {
      bucket[/** @type {string} */ (r.date)] = SKIP;
      skipsByHabit.get(r.habit_id).push(/** @type {string} */ (r.date));
    } else {
      bucket[/** @type {string} */ (r.date)] = r.value;
    }
  }

  res.json({
    start,
    end,
    habits: habits.map((h) => {
      // The dashboard summary only needs a bounded lookback: with a 30-day
      // half-life the score has long since converged, and streaks that matter
      // here are recent. This keeps the dashboard O(window) rather than
      // O(lifetime) per habit.
      // Bounded, not lifetime. Reading every entry per habit made the
      // dashboard O(lifetime x habits) and, worse, fed an unbounded array
      // into computeStreaks — hundreds of thousands of iterations of
      // synchronous work on a single-threaded server.
      //
      // Both lookbacks count back from `summaryEnd`, not from the grid's
      // `end`: these three figures describe the habit today.
      const entries = /** @type {any} */ (
        q.entriesForSince.all(h.id, addDays(summaryEnd, -STREAK_HISTORY_DAYS))
      );
      const windowed = /** @type {any} */ (
        q.entriesForSince.all(h.id, addDays(summaryEnd, -SUMMARY_WINDOW_DAYS))
      );
      const stats = computeStats(h, windowed, { end: summaryEnd, unlogged });

      // Counted in SQLite rather than by walking every row in JS. The
      // expression mirrors isCompleted exactly, including that a skip is
      // "not applicable" and never a completion — passing `e.value` instead
      // of the whole row is what made this edition count skips as done on
      // at_most habits while cloud did not.
      const totalCompleted = /** @type {any} */ (
        q.countCompleted.get(
          h.id, h.type, h.target_type, h.target_value, h.target_value
        )
      ).n;

      const allStreaks = computeStreaks(
        h,
        new Map(entries.map((e) => [e.date, { value: e.value, status: e.status }])),
        entries.length ? entries[0].date : summaryEnd,
        summaryEnd,
        unlogged
      );

      return {
        ...toApiHabit(h),
        entries: byHabit.get(h.id) ?? {},
        skips: skipsByHabit.get(h.id) ?? [],
        score: stats.score,
        currentStreak: stats.currentStreak,
        bestStreak: bestStreak(allStreaks),
        totalCompleted,
      };
    }),
  });
});

/** One stored setting, decoded, or null if it is absent or unreadable. */
function storedSetting(key) {
  const row = q.allSettings.all().find((r) => r.key === key);
  try {
    return row ? JSON.parse(String(row.value)) : null;
  } catch {
    return null;
  }
}

/** The user's week-start preference, defaulting to ISO (Monday). */
function storedWeekStart() {
  return storedSetting('weekStart') === 'sunday' ? 'sunday' : 'monday';
}

/**
 * What a day with no row counts as on an at-most habit.
 *
 * Read here and handed to `computeStats` rather than looked up inside it: the
 * shared code takes no database, which is the whole reason it can serve both
 * editions. Anything but the stored word is the default, exactly as
 * `storedWeekStart` treats its own.
 */
function storedUnlogged() {
  return storedSetting('atMostUnlogged') === 'success' ? 'success' : UNLOGGED_DEFAULT;
}

/* ---------- settings ---------- */

/**
 * Preferences live server-side so they survive a browser reset and are
 * captured by the same backup as the habits. Values are stored as JSON text
 * because SQLite has no boolean.
 */
function readSettings() {
  const out = {};
  for (const { key, value } of q.allSettings.all()) {
    // node:sqlite returns loosely-typed columns; both are TEXT by schema.
    try { out[String(key)] = JSON.parse(String(value)); }
    catch { /* skip a corrupt row rather than fail the whole request */ }
  }
  return out;
}

api.get('/settings', (req, res) => {
  res.json(readSettings());
});

/** Merge a patch. Unknown or invalid keys are dropped, not rejected. */
api.put('/settings', (req, res) => {
  const { accepted, rejected } = parseSettings(req.body);
  for (const [key, value] of Object.entries(accepted)) {
    q.putSetting.run(key, JSON.stringify(value));
  }
  res.json({ settings: accepted, ignored: rejected });
});

api.delete('/settings', (req, res) => {
  q.clearSettings.run();
  res.json({});
});

/* ---------- notifications ---------- */

/**
 * Post a test message to every configured server-delivered destination.
 *
 * Without this a wrong webhook URL is only discoverable by waiting for a
 * reminder that never arrives and then reading the server log. The reply
 * carries each channel's own outcome, because "it failed" is not useful when
 * two destinations are configured.
 */
api.post('/notify/test', (req, res, next) => {
  sendTest()
    .then((results) => res.json({ results }))
    .catch(next);
});

/**
 * How each destination last behaved.
 *
 * The test button above is the other half of this and has one flaw: it has to
 * be PRESSED, and nothing suggests pressing it. A webhook deleted in April
 * stops the reminders while the habit, its time and the destination toggle all
 * go on looking correct — so this reports what the notifier already learned at
 * 08:00, and the settings dialog shows it without being asked.
 *
 * Only the last outcome per channel, and only for channels something has
 * actually been attempted for. It is deliberately NOT a statement about
 * configuration: `channelConfigured` stays the authority on whether a
 * destination can deliver, and this says only whether it did.
 */
api.get('/notify/status', (req, res) => {
  res.json({ channels: deliveryStatus() });
});

/* ---------- export / import ---------- */

api.get('/export', (req, res) => {
  const habits = q.allHabits.all(0).concat(q.allHabits.all(1));
  const payload = {
    version: 1,
    app: 'habiterall',
    exported_at: new Date().toISOString(),
    habits: habits.map((h) => ({ ...toApiHabit(h), entries: q.entriesFor.all(h.id) })),
    // Preferences travel with the data. They are the account, not the device —
    // and two of them (skipDays, questionMarks) now decide what the same rows
    // MEAN, so a backup that dropped them restored a history the app then read
    // differently. Only a replace-mode import applies them; see the route.
    //
    // `portableSettings`, not the whole table: a backup is a file people email
    // to themselves, and `discordWebhook` is a bearer capability for a channel.
    settings: portableSettings(readSettings()),
  };

  if (req.query.download === 'true') {
    const stamp = today();
    res.setHeader('Content-Disposition',
      `attachment; filename="habiterall-backup-${stamp}.json"`);
  }
  res.json(payload);
});

/**
 * Export as a zip of Habits.csv + Checkmarks.csv, the same shape Loop
 * produces. Both files are needed: Checkmarks.csv alone has no habit types,
 * so a measurable habit's 3 would be read back as Loop's SKIP sentinel.
 *
 * The route keeps its `.csv` name for existing bookmarks; the payload is a zip.
 */
api.get('/export.csv', (req, res) => {
  const habits = q.allHabits.all(0).concat(q.allHabits.all(1));
  const body = buildCsvArchive(habits, (id) => q.entriesFor.all(id));

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename="habiterall-csv-${today()}.zip"`);
  res.send(body);
});

/**
 * Export everything as a Loop Habit Tracker .db backup, so the data can be
 * restored into the Loop Android app.
 *
 * A row Loop cannot carry is left out rather than taking the request down with
 * it, and `writeLoopDatabase` says which. Both surfaces are here because
 * neither reaches everybody: the header is for a client that made the request
 * itself — curl or devtools — and the log is for the one that did not, since
 * the browser downloads this through an `<a download>`, which reads no headers.
 *
 * Not `Api.kt`, despite the shape of that sentence: the Android client makes no
 * export request at all, and its one response accessor keeps a status and a
 * body and no headers. If it ever does export, this is where its surface has to
 * be reconsidered rather than assumed.
 *
 * SQLite makes this edition the EASIER one to reach — `2026-02-30` is stored as
 * the string it was given, so an import writer checking only the shape of a
 * date left the row sitting there. But cloud is reachable too, which is why the
 * same code is there and not merely for symmetry: Postgres accepts any year
 * 1–99 as a DATE, `to_char` hands back `0050-03-15`, and that is a date this
 * exporter cannot encode either.
 */
api.get('/export-loop.db', (req, res, next) => {
  const habits = q.allHabits.all(0).concat(q.allHabits.all(1));
  // A random name, matching the cloud edition: a predictable one in a shared
  // /tmp is a file another local user can wait for, and this one holds every
  // habit and entry.
  const path = join(tmpdir(), `habiterall-loop-${randomUUID()}.db`);

  writeLoopDatabase(path, habits, (id) => q.entriesFor.all(id))
    .then(({ skipped }) => {
      const body = readFileSync(path);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition',
        `attachment; filename="Loop Habits Backup ${today()}.db"`);
      if (skipped.length) {
        res.setHeader(EXPORT_SKIPPED_HEADER, String(skipped.length));
        // Ids and dates only — see the README's rule on what a log may hold.
        (req.log ?? log).warn('export.rows_skipped',
          { format: 'loop_db', skipped: skipped.length, rows: skipsForLog(skipped) });
      }
      res.send(body);
    })
    .catch(next)
    .finally(() => { try { unlinkSync(path); } catch { /* best effort */ } });
});

/* ---------- import ---------- */

const MODES = new Set(['merge', 'replace']);

/**
 * Import a habiterall JSON backup, a Loop .db backup, or a Loop CSV export
 * (zip or a single Checkmarks.csv). The body is the raw file; the format is
 * sniffed from its contents rather than trusted from the client.
 */
api.post('/import', (req, res, next) => {
  const mode = MODES.has(req.query.mode) ? req.query.mode : 'merge';
  const buf = req.body;

  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw httpError(400, 'request body must be the file to import');
  }

  // Express 4 does not catch rejections from async handlers, so forward them.
  parseUpload(buf)
    .then((habits) => {
      if (!habits.length) throw httpError(400, 'no habits found in the uploaded file');
      const result = applyImport(habits, mode);

      // Replace mode only: it means "make this account look like the file", and
      // the file's preferences are part of that. A merge is "add these habits to
      // what I have" and has no business rewriting how the rest of the account
      // is displayed. Through parseSettings, so a hand-edited backup cannot
      // store a value the API would refuse.
      let settings = 0;
      if (mode === 'replace') {
        const raw = backupSettings(buf);
        if (raw) {
          // Filtered BEFORE the validator, so a file cannot set a notification
          // destination however well-formed its value is: a shared "starter
          // habits" backup would otherwise repoint the reminders of everyone who
          // restored it at a channel its author reads.
          const { accepted } = parseSettings(portableSettings(raw));
          for (const [key, value] of Object.entries(accepted)) {
            q.putSetting.run(key, JSON.stringify(value));
          }
          settings = Object.keys(accepted).length;
        }
      }

      res.json({ mode, ...result, settings });
    })
    .catch(next);
});

export default api;
