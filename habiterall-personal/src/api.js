import express from 'express';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, UNSET, YES, SKIP } from './db.js';
import {
  computeStats, computeStreaks, bestStreak, isCompleted,
  today, addDays, daysBetween, MAX_RANGE_DAYS,
} from '@habiterall/shared/stats.js';

/** Lookback used for the dashboard's score/current-streak summary. */
const SUMMARY_WINDOW_DAYS = 400;
import {
  parseHabiterallJSON, parseLoopDatabase,
  parseLoopCheckmarksCSV, parseLoopHabitsCSV,
} from '@habiterall/shared/import.js';
import { applyImport } from './apply-import.js';
import {
  parseHabit, parseEntry, parseSettings, assertDate, assertNotFuture, DATE_RE,
} from '@habiterall/shared/validate.js';
import { unzip } from '@habiterall/shared/unzip.js';
import { writeLoopDatabase } from '@habiterall/shared/export-loop.js';

export const api = express.Router();

/* ---------- statements ---------- */

const q = {
  allHabits: db.prepare(
    `SELECT * FROM habits WHERE archived = ? ORDER BY position, id`
  ),
  habitById: db.prepare(`SELECT * FROM habits WHERE id = ?`),
  insertHabit: db.prepare(`
    INSERT INTO habits (name, description, type, unit, target_value, target_type,
                        freq_numerator, freq_denominator, color, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
            COALESCE((SELECT MAX(position) + 1 FROM habits), 0))
  `),
  updateHabit: db.prepare(`
    UPDATE habits SET name = ?, description = ?, type = ?, unit = ?,
      target_value = ?, target_type = ?, freq_numerator = ?,
      freq_denominator = ?, color = ?, archived = ?
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
  res.json(q.allHabits.all(archived));
});

api.post('/habits', (req, res) => {
  const h = habitRow(req.body);
  const info = q.insertHabit.run(
    h.name, h.description, h.type, h.unit, h.target_value,
    h.target_type, h.freq_numerator, h.freq_denominator, h.color
  );
  res.status(201).json(q.habitById.get(info.lastInsertRowid));
});

api.get('/habits/:id', (req, res) => {
  const habit = asHabit(q.habitById.get(Number(req.params.id)));
  if (!habit) throw httpError(404, 'habit not found');
  res.json(habit);
});

api.put('/habits/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!q.habitById.get(id)) throw httpError(404, 'habit not found');

  const h = habitRow(req.body);
  q.updateHabit.run(
    h.name, h.description, h.type, h.unit, h.target_value, h.target_type,
    h.freq_numerator, h.freq_denominator, h.color, h.archived, id
  );
  res.json(q.habitById.get(id));
});

api.delete('/habits/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!q.habitById.get(id)) throw httpError(404, 'habit not found');
  q.deleteHabit.run(id);
  res.status(204).end();
});

api.post('/habits/reorder', (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order)) throw httpError(400, 'order must be an array of habit ids');
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    order.forEach((id, i) => q.setPosition.run(i, Number(id)));
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  res.json(q.allHabits.all(0));
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

  const { value, status, notes } = parseEntry(habit, req.body, { UNSET, YES, SKIP });

  if (status === 'skip') {
    q.upsertEntry.run(id, date, 0, 'skip', notes);
    return res.json({ habit_id: id, date, value: SKIP, status: 'skip', notes });
  }

  // Clearing a checkmark removes the row rather than storing a zero, keeping
  // "never recorded" and "recorded as zero" distinct for numerical habits.
  // A note is the exception: it needs a row to live on, so an explicit
  // "not done, and here's why" is preserved.
  if (habit.type === 'boolean' && value === UNSET) {
    if (notes) {
      q.upsertEntry.run(id, date, UNSET, '', notes);
      return res.json({ habit_id: id, date, value: UNSET, notes });
    }
    q.deleteEntry.run(id, date);
    return res.json({ habit_id: id, date, value: UNSET, notes: '' });
  }

  q.upsertEntry.run(id, date, value, '', notes);
  res.json({ habit_id: id, date, value, notes });
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
      { start, end, granularity, weekStart: storedWeekStart() }),
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
  const requestedEnd = DATE_RE.test(req.query.end ?? '') ? req.query.end : today();
  const end = requestedEnd > today() ? today() : requestedEnd;
  const start = addDays(end, -(days - 1));

  // Archived habits are hidden by default but can be requested explicitly.
  const habits = /** @type {any[]} */ (req.query.archived === 'true'
    ? q.allHabits.all(1)
    : q.allHabits.all(0));
  const rows = q.entriesInRange.all(start, end);

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
      const entries = /** @type {any} */ (q.entriesFor.all(h.id));
      const windowed = /** @type {any} */ (q.entriesForSince.all(h.id, addDays(end, -SUMMARY_WINDOW_DAYS)));
      const stats = computeStats(h, windowed, { end });

      // Lifetime figures still need every entry, but a single pass is cheap
      // next to the five aggregation passes computeStats would run.
      let totalCompleted = 0;
      for (const e of entries) {
        if (isCompleted(h, e.value) === true) totalCompleted++;
      }
      const allStreaks = computeStreaks(
        h,
        new Map(entries.map((e) => [e.date, { value: e.value, status: e.status }])),
        entries.length ? entries[0].date : end,
        end
      );

      return {
        ...h,
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

/** The user's week-start preference, defaulting to ISO (Monday). */
function storedWeekStart() {
  const row = q.allSettings.all().find((r) => r.key === 'weekStart');
  try {
    const value = row ? JSON.parse(String(row.value)) : null;
    return value === 'sunday' ? 'sunday' : 'monday';
  } catch {
    return 'monday';
  }
}

/* ---------- settings ---------- */

/**
 * Preferences live server-side so they survive a browser reset and are
 * captured by the same backup as the habits. Values are stored as JSON text
 * because SQLite has no boolean.
 */
api.get('/settings', (req, res) => {
  const out = {};
  for (const { key, value } of q.allSettings.all()) {
    // node:sqlite returns loosely-typed columns; both are TEXT by schema.
    try { out[String(key)] = JSON.parse(String(value)); }
    catch { /* skip a corrupt row rather than fail the whole request */ }
  }
  res.json(out);
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

/* ---------- export / import ---------- */

api.get('/export', (req, res) => {
  const habits = q.allHabits.all(0).concat(q.allHabits.all(1));
  const payload = {
    version: 1,
    app: 'habiterall',
    exported_at: new Date().toISOString(),
    habits: habits.map((h) => ({ ...h, entries: q.entriesFor.all(h.id) })),
  };

  if (req.query.download === 'true') {
    const stamp = today();
    res.setHeader('Content-Disposition',
      `attachment; filename="habiterall-backup-${stamp}.json"`);
  }
  res.json(payload);
});

/**
 * Export every habit's checkmarks as a single CSV, in the same shape as
 * Loop's Checkmarks.csv (Date column, then one column per habit).
 */
api.get('/export.csv', (req, res) => {
  const habits = q.allHabits.all(0).concat(q.allHabits.all(1));

  const byHabit = habits.map((h) => ({
    habit: h,
    entries: new Map(q.entriesFor.all(h.id).map((e) => [e.date, e])),
  }));

  const allDates = [...new Set(byHabit.flatMap((b) => [...b.entries.keys()]))].sort();

  const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [['Date', ...habits.map((h) => esc(h.name))].join(',')];

  for (const date of allDates) {
    const row = [date];
    for (const b of byHabit) {
      const e = b.entries.get(date);
      if (e == null) row.push('');
      else if (e.status === 'skip') row.push('SKIP');
      else if (b.habit.type === 'boolean') row.push(e.value === YES ? 'YES_MANUAL' : '');
      else row.push(String(e.value));
    }
    lines.push(row.join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="habiterall-checkmarks-${today()}.csv"`);
  res.send(lines.join('\n') + '\n');
});

/**
 * Export everything as a Loop Habit Tracker .db backup, so the data can be
 * restored into the Loop Android app.
 */
api.get('/export-loop.db', (req, res, next) => {
  const habits = q.allHabits.all(0).concat(q.allHabits.all(1));
  const path = join(tmpdir(), `habiterall-loop-${process.pid}-${Date.now()}.db`);

  writeLoopDatabase(path, habits, (id) => q.entriesFor.all(id))
    .then(() => {
      const body = readFileSync(path);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition',
        `attachment; filename="Loop Habits Backup ${today()}.db"`);
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
      res.json({ mode, ...applyImport(habits, mode) });
    })
    .catch(next);
});

/**
 * Sniff the upload format by magic bytes, then structure.
 *   PK\x03\x04            -> zip (Loop CSV export)
 *   "SQLite format 3\0"   -> Loop .db backup
 *   otherwise             -> text: habiterall JSON or a bare CSV
 */
async function parseUpload(buf) {
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'PK\x03\x04') {
    return parseZipExport(buf);
  }

  if (buf.length >= 16 && buf.toString('latin1', 0, 15) === 'SQLite format 3') {
    // node:sqlite can only open a path, so stage the upload on disk.
    const path = join(tmpdir(), `habiterall-import-${process.pid}-${Date.now()}.db`);
    writeFileSync(path, buf);
    try {
      return await parseLoopDatabase(path);
    } finally {
      try { unlinkSync(path); } catch { /* best effort */ }
    }
  }

  const text = buf.toString('utf8').replace(/^﻿/, '');
  const head = text.trimStart();

  if (head.startsWith('{') || head.startsWith('[')) {
    return parseHabiterallJSON(head.startsWith('[') ? { habits: JSON.parse(head) } : text);
  }

  if (/^"?date"?\s*,/i.test(head)) return parseLoopCheckmarksCSV(text);

  throw httpError(400,
    'unrecognized file: expected a habiterall JSON backup, a Loop .db backup, or a Loop CSV export');
}

/** Pull Habits.csv + Checkmarks.csv out of a Loop CSV export zip. */
function parseZipExport(buf) {
  const files = unzip(buf);

  const find = (suffix) => {
    for (const [name, contents] of files) {
      if (name.toLowerCase().endsWith(suffix)) return contents.toString('utf8');
    }
    return null;
  };

  const habitsCsv = find('habits.csv');
  const checkmarksCsv = find('checkmarks.csv');

  if (!checkmarksCsv) {
    throw httpError(400, 'zip does not contain a Checkmarks.csv');
  }

  const meta = habitsCsv ? parseLoopHabitsCSV(habitsCsv) : new Map();
  return parseLoopCheckmarksCSV(checkmarksCsv, meta);
}

export default api;
