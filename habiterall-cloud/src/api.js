/**
 * REST API. Every handler runs inside `withUser`, so Row-Level Security
 * scopes each query to the session's user. Note that the queries below still
 * carry explicit `user_id` predicates where it aids the planner — RLS is the
 * guarantee, not the only line of defence.
 */

import express from 'express';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withUser } from './db/pool.js';
import { applyImport } from './apply-import.js';
import { unzip } from '@habiterall/shared/unzip.js';
import { writeLoopDatabase } from '@habiterall/shared/export-loop.js';
import { buildCsvArchive } from '@habiterall/shared/export-csv.js';
import {
  parseHabiterallJSON, parseLoopDatabase,
  parseLoopCheckmarksCSV, parseLoopHabitsCSV,
} from '@habiterall/shared/import.js';
import { UNSET, YES, SKIP } from '@habiterall/shared/constants.js';
import {
  parseHabit, parseEntry, parseSettings, assertDate, assertNotFuture, DATE_RE,
} from '@habiterall/shared/validate.js';
import {
  computeStats, computeStreaks, bestStreak, isCompleted,
  today, addDays, daysBetween, MAX_RANGE_DAYS,
} from '@habiterall/shared/stats.js';

export const api = express.Router();

const SUMMARY_WINDOW_DAYS = 400;

/** Per-user ceilings. Cheap insurance against one account exhausting the box. */
const MAX_HABITS_PER_USER = Number(process.env.MAX_HABITS_PER_USER) || 200;

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

const uid = (req) => req.session.user.id;

/** Wrap an async handler so rejections reach the error middleware. */
const route = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/* ---------- habits ---------- */

api.get('/habits', route(async (req, res) => {
  const archived = req.query.archived === 'true';
  const rows = await withUser(uid(req), (db) =>
    db.query(
      `SELECT * FROM habits WHERE archived = $1 ORDER BY position, id`,
      [archived]
    ).then((r) => r.rows)
  );
  res.json(rows);
}));

api.post('/habits', route(async (req, res) => {
  const h = parseHabit(req.body);

  const created = await withUser(uid(req), async (db) => {
    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM habits`
    );
    if (count >= MAX_HABITS_PER_USER) {
      throw httpError(403, `habit limit reached (${MAX_HABITS_PER_USER})`);
    }

    const { rows } = await db.query(
      `INSERT INTO habits (user_id, name, description, type, unit, target_value,
                           target_type, freq_numerator, freq_denominator, color,
                           reminder_time, archived, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               COALESCE((SELECT MAX(position) + 1 FROM habits), 0))
       RETURNING *`,
      [uid(req), h.name, h.description, h.type, h.unit, h.target_value,
       h.target_type, h.freq_numerator, h.freq_denominator, h.color,
       h.reminder_time, h.archived]
    );
    return rows[0];
  });

  res.status(201).json(created);
}));

api.get('/habits/:id', route(async (req, res) => {
  const habit = await getHabit(req);
  res.json(habit);
}));

api.put('/habits/:id', route(async (req, res) => {
  const h = parseHabit(req.body);
  const id = Number(req.params.id);

  const updated = await withUser(uid(req), async (db) => {
    const { rows } = await db.query(
      `UPDATE habits SET name=$1, description=$2, type=$3, unit=$4,
              target_value=$5, target_type=$6, freq_numerator=$7,
              freq_denominator=$8, color=$9, reminder_time=$10, archived=$11
       WHERE id = $12 RETURNING *`,
      [h.name, h.description, h.type, h.unit, h.target_value, h.target_type,
       h.freq_numerator, h.freq_denominator, h.color, h.reminder_time,
       h.archived, id]
    );
    return rows[0];
  });

  if (!updated) throw httpError(404, 'habit not found');
  res.json(updated);
}));

api.delete('/habits/:id', route(async (req, res) => {
  const id = Number(req.params.id);
  const gone = await withUser(uid(req), (db) =>
    db.query(`DELETE FROM habits WHERE id = $1 RETURNING id`, [id])
      .then((r) => r.rowCount > 0)
  );
  if (!gone) throw httpError(404, 'habit not found');
  res.status(204).end();
}));

api.post('/habits/reorder', route(async (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order) || order.some((n) => !Number.isInteger(Number(n)))) {
    throw httpError(400, 'order must be an array of habit ids');
  }

  const rows = await withUser(uid(req), async (db) => {
    // RLS confines these updates to the caller's own habits, so an id
    // belonging to someone else simply matches nothing.
    for (const [i, id] of order.entries()) {
      await db.query(`UPDATE habits SET position = $1 WHERE id = $2`, [i, Number(id)]);
    }
    return db.query(
      `SELECT * FROM habits WHERE archived = false ORDER BY position, id`
    ).then((r) => r.rows);
  });

  res.json(rows);
}));

/* ---------- entries ---------- */

api.get('/habits/:id/entries', route(async (req, res) => {
  await getHabit(req); // 404s if it is not the caller's
  const rows = await withUser(uid(req), (db) =>
    db.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, value, status, notes
       FROM entries WHERE habit_id = $1 ORDER BY date`,
      [Number(req.params.id)]
    ).then((r) => r.rows)
  );
  res.json(rows);
}));

api.put('/habits/:id/entries/:date', route(async (req, res) => {
  const habit = await getHabit(req);
  const date = req.params.date;

  assertDate(date);
  assertNotFuture(date, today());

  const { value, status, notes } = parseEntry(habit, req.body, { UNSET, YES, SKIP });

  const result = await withUser(uid(req), async (db) => {
    if (status === 'skip') {
      await upsertEntry(db, uid(req), habit.id, date, 0, 'skip', notes);
      return { habit_id: habit.id, date, value: SKIP, status: 'skip', notes };
    }

    // "Not done" is the absence of a row — unless a note needs somewhere to live.
    if (habit.type === 'boolean' && value === UNSET) {
      if (notes) {
        await upsertEntry(db, uid(req), habit.id, date, UNSET, '', notes);
        return { habit_id: habit.id, date, value: UNSET, notes };
      }
      await db.query(`DELETE FROM entries WHERE habit_id = $1 AND date = $2`,
        [habit.id, date]);
      return { habit_id: habit.id, date, value: UNSET, notes: '' };
    }

    await upsertEntry(db, uid(req), habit.id, date, value, '', notes);
    return { habit_id: habit.id, date, value, notes };
  });

  res.json(result);
}));

api.delete('/habits/:id/entries/:date', route(async (req, res) => {
  await getHabit(req);
  if (!DATE_RE.test(req.params.date)) throw httpError(400, 'date must be YYYY-MM-DD');

  await withUser(uid(req), (db) =>
    db.query(`DELETE FROM entries WHERE habit_id = $1 AND date = $2`,
      [Number(req.params.id), req.params.date])
  );
  res.status(204).end();
}));

function upsertEntry(db, userId, habitId, date, value, status, notes) {
  return db.query(
    `INSERT INTO entries (habit_id, user_id, date, value, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (habit_id, date) DO UPDATE
       SET value = EXCLUDED.value,
           status = EXCLUDED.status,
           notes = EXCLUDED.notes`,
    [habitId, userId, date, value, status, notes]
  );
}

/* ---------- stats ---------- */

api.get('/habits/:id/stats', route(async (req, res) => {
  const habit = await getHabit(req);

  const requestedEnd = DATE_RE.test(req.query.end ?? '') ? req.query.end : today();
  const end = requestedEnd > today() ? today() : requestedEnd;

  const start = DATE_RE.test(req.query.start ?? '') ? req.query.start : undefined;
  if (start) {
    if (start > end) throw httpError(400, 'start must not be after end');
    if (daysBetween(start, end) > MAX_RANGE_DAYS) {
      throw httpError(400, `range must not exceed ${MAX_RANGE_DAYS} days`);
    }
  }

  const { entries, weekStart } = await withUser(uid(req), async (db) => {
    const { rows } = await db.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, value, status, notes
       FROM entries WHERE habit_id = $1 ORDER BY date`,
      [habit.id]
    );
    // The week boundary is a user preference, so history and the
    // times-per-week chart must be bucketed the way they read their calendar.
    const { rows: [u] } = await db.query(
      `SELECT settings ->> 'weekStart' AS week_start FROM users WHERE id = $1`,
      [uid(req)]
    );
    const weekStart = /** @type {'monday'|'sunday'} */ (
      u?.week_start === 'sunday' ? 'sunday' : 'monday');
    return { entries: rows, weekStart };
  });

  res.json({
    habit,
    ...computeStats(habit, entries, {
      start, end, granularity: req.query.granularity ?? 'day', weekStart,
    }),
  });
}));

api.get('/overview', route(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

  // The dashboard can page back through history, so it asks for the window it
  // is actually showing. Without this the grid rendered empty cells for any
  // day outside the most recent fortnight — the entries were never fetched.
  const requestedEnd = DATE_RE.test(req.query.end ?? '') ? req.query.end : today();
  const end = requestedEnd > today() ? today() : requestedEnd;
  const start = addDays(end, -(days - 1));
  const archived = req.query.archived === 'true';

  const payload = await withUser(uid(req), async (db) => {
    const { rows: habits } = await db.query(
      `SELECT * FROM habits WHERE archived = $1 ORDER BY position, id`,
      [archived]
    );
    if (!habits.length) return { start, end, habits: [] };

    const ids = habits.map((h) => h.id);

    // One query for the grid window, one for the lifetime figures, rather
    // than two per habit.
    const { rows: windowRows } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
       FROM entries WHERE habit_id = ANY($1) AND date BETWEEN $2 AND $3
       ORDER BY date`,
      [ids, start, end]
    );
    const { rows: allRows } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
       FROM entries WHERE habit_id = ANY($1) ORDER BY date`,
      [ids]
    );

    const grid = new Map(ids.map((id) => [id, {}]));
    const skips = new Map(ids.map((id) => [id, []]));
    for (const r of windowRows) {
      if (r.status === 'skip') {
        grid.get(r.habit_id)[r.date] = SKIP;
        skips.get(r.habit_id).push(r.date);
      } else {
        grid.get(r.habit_id)[r.date] = r.value;
      }
    }

    const byHabit = new Map(ids.map((id) => [id, []]));
    for (const r of allRows) byHabit.get(r.habit_id).push(r);

    const cutoff = addDays(end, -SUMMARY_WINDOW_DAYS);

    return {
      start,
      end,
      habits: habits.map((h) => {
        const all = byHabit.get(h.id) ?? [];
        const recent = all.filter((e) => e.date >= cutoff);
        const stats = computeStats(h, recent, { end });

        let totalCompleted = 0;
        for (const e of all) if (isCompleted(h, e) === true) totalCompleted++;

        const streaks = computeStreaks(
          h,
          new Map(all.map((e) => [e.date, { value: e.value, status: e.status }])),
          all.length ? all[0].date : end,
          end
        );

        return {
          ...h,
          entries: grid.get(h.id) ?? {},
          skips: skips.get(h.id) ?? [],
          score: stats.score,
          currentStreak: stats.currentStreak,
          bestStreak: bestStreak(streaks),
          totalCompleted,
        };
      }),
    };
  });

  res.json(payload);
}));

/* ---------- settings ---------- */

/**
 * Preferences follow the account rather than the device, so a choice made on
 * a laptop applies on a phone. Stored as JSONB on the user row; the existing
 * users_select_self / users_update_self policies scope both queries.
 */
api.get('/settings', route(async (req, res) => {
  const settings = await withUser(uid(req), (db) =>
    db.query(`SELECT settings FROM users WHERE id = $1`, [uid(req)])
      .then((r) => r.rows[0]?.settings ?? {})
  );
  res.json(settings);
}));

/** Merge a patch. Unknown or invalid keys are dropped, not rejected. */
api.put('/settings', route(async (req, res) => {
  const { accepted, rejected } = parseSettings(req.body);

  const merged = await withUser(uid(req), (db) =>
    // Merge server-side so two devices racing cannot clobber each other's
    // unrelated keys.
    db.query(
      `UPDATE users SET settings = settings || $1::jsonb
       WHERE id = $2 RETURNING settings`,
      [JSON.stringify(accepted), uid(req)]
    ).then((r) => r.rows[0]?.settings ?? {})
  );

  res.json({ settings: merged, ignored: rejected });
}));

api.delete('/settings', route(async (req, res) => {
  await withUser(uid(req), (db) =>
    db.query(`UPDATE users SET settings = '{}'::jsonb WHERE id = $1`, [uid(req)])
  );
  res.json({});
}));

/* ---------- export ---------- */

api.get('/export', route(async (req, res) => {
  const data = await withUser(uid(req), async (db) => {
    const { rows: habits } = await db.query(
      `SELECT * FROM habits ORDER BY archived, position, id`
    );
    const { rows: entries } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status, notes
       FROM entries ORDER BY habit_id, date`
    );
    const byHabit = new Map(habits.map((h) => [h.id, []]));
    for (const e of entries) {
      const { habit_id, ...rest } = e;
      byHabit.get(habit_id)?.push(rest);
    }
    return habits.map((h) => ({ ...h, entries: byHabit.get(h.id) ?? [] }));
  });

  if (req.query.download === 'true') {
    res.setHeader('Content-Disposition',
      `attachment; filename="habiterall-backup-${today()}.json"`);
  }
  res.json({
    version: 1,
    app: 'habiterall',
    exported_at: new Date().toISOString(),
    habits: data,
  });
}));

/** All checkmarks as a single Loop-shaped CSV. */
api.get('/export.csv', route(async (req, res) => {
  const { habits, entries } = await withUser(uid(req), async (db) => {
    const { rows: habits } = await db.query(
      `SELECT * FROM habits ORDER BY archived, position, id`);
    const { rows: entries } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
       FROM entries ORDER BY date`);
    return { habits, entries };
  });

  const byHabit = new Map(habits.map((h) => [h.id, []]));
  for (const e of entries) byHabit.get(e.habit_id)?.push(e);

  const body = buildCsvArchive(habits, (id) => byHabit.get(id) ?? []);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename="habiterall-csv-${today()}.zip"`);
  res.send(body);
}));

/** A Loop Habit Tracker .db backup of this user's data. */
api.get('/export-loop.db', route(async (req, res) => {
  const { habits, byHabit } = await withUser(uid(req), async (db) => {
    const { rows: habits } = await db.query(
      `SELECT * FROM habits ORDER BY archived, position, id`);
    const { rows: entries } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status, notes
       FROM entries ORDER BY habit_id, date`);
    const byHabit = new Map(habits.map((h) => [h.id, []]));
    for (const e of entries) byHabit.get(e.habit_id)?.push(e);
    return { habits, byHabit };
  });

  const path = join(tmpdir(), `habiterall-loop-${randomUUID()}.db`);
  try {
    await writeLoopDatabase(path, habits, (id) => byHabit.get(id) ?? []);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `attachment; filename="Loop Habits Backup ${today()}.db"`);
    res.send(readFileSync(path));
  } finally {
    try { unlinkSync(path); } catch { /* best effort */ }
  }
}));

/* ---------- import ---------- */

const MODES = new Set(['merge', 'replace']);

/**
 * Import a backup into the CALLER'S OWN account.
 *
 * The uploaded file is treated as untrusted data: ids inside it are ignored
 * entirely, and every row written carries the session's user_id. See
 * src/apply-import.js for the three layers of tenancy enforcement.
 */
api.post('/import', route(async (req, res) => {
  const mode = MODES.has(req.query.mode) ? req.query.mode : 'merge';
  const buf = req.body;

  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw httpError(400, 'request body must be the file to import');
  }

  const habits = await parseUpload(buf);
  if (!habits.length) throw httpError(400, 'no habits found in the uploaded file');

  const result = await applyImport(uid(req), habits, mode);
  res.json({ mode, ...result });
}));

/** Sniff the format by magic bytes, then structure. */
async function parseUpload(buf) {
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'PK\x03\x04') {
    const files = unzip(buf);
    const find = (suffix) => {
      for (const [name, contents] of files) {
        if (name.toLowerCase().endsWith(suffix)) return contents.toString('utf8');
      }
      return null;
    };
    const checkmarks = find('checkmarks.csv');
    if (!checkmarks) throw httpError(400, 'zip does not contain a Checkmarks.csv');
    const habitsCsv = find('habits.csv');
    return parseLoopCheckmarksCSV(
      checkmarks, habitsCsv ? parseLoopHabitsCSV(habitsCsv) : new Map()
    );
  }

  if (buf.length >= 16 && buf.toString('latin1', 0, 15) === 'SQLite format 3') {
    // node:sqlite can only open a path, so stage the upload on disk under a
    // name that cannot collide between concurrent users.
    const path = join(tmpdir(), `habiterall-import-${randomUUID()}.db`);
    writeFileSync(path, buf, { mode: 0o600 });
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

/* ---------- helpers ---------- */

/** Fetch a habit, 404ing if it does not exist OR is not the caller's. */
async function getHabit(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'invalid habit id');

  const habit = await withUser(uid(req), (db) =>
    db.query(`SELECT * FROM habits WHERE id = $1`, [id]).then((r) => r.rows[0])
  );
  // RLS makes another user's habit indistinguishable from a missing one,
  // which is what we want: no existence oracle.
  if (!habit) throw httpError(404, 'habit not found');
  return habit;
}

export default api;
