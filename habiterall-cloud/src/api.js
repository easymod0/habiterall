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
import { sendTest } from './notifier.js';
import { writeLoopDatabase } from '@habiterall/shared/export-loop.js';
import { buildCsvArchive } from '@habiterall/shared/export-csv.js';
// Format sniffing and every parser live in shared: the two editions had
// separate copies of the sniffing, and they had drifted.
import { backupSettings, parseUpload } from '@habiterall/shared/import.js';
import { UNSET, YES, SKIP } from '@habiterall/shared/constants.js';
import {
  parseHabit, parseEntry, parseSettings, entryWrite, assertDate, assertNotFuture,
  DATE_RE,
} from '@habiterall/shared/validate.js';
import {
  computeStats, computeStreaks, bestStreak, isCompleted,
  today, addDays, daysBetween, MAX_RANGE_DAYS,
} from '@habiterall/shared/stats.js';

export const api = express.Router();

const SUMMARY_WINDOW_DAYS = 400;

/**
 * How far back the dashboard's streak scan reads.
 *
 * The scan used to be unbounded, so a long history meant hundreds of
 * thousands of rows shipped to Node and ~850ms of synchronous CPU per
 * request — on a single-threaded server that stalls every tenant, and one
 * account could saturate the process within its rate limit.
 *
 * Five years bounds the work while being far beyond any streak a person will
 * actually run. `bestStreak` is therefore "best in the last five years",
 * which is the honest reading of a dashboard summary anyway.
 */
const STREAK_HISTORY_DAYS = 1830;

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
                           reminder_time, reminder_message, archived, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               COALESCE((SELECT MAX(position) + 1 FROM habits), 0))
       RETURNING *`,
      [uid(req), h.name, h.description, h.type, h.unit, h.target_value,
       h.target_type, h.freq_numerator, h.freq_denominator, h.color,
       h.reminder_time, h.reminder_message, h.archived]
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
  const id = habitId(req);

  const updated = await withUser(uid(req), async (db) => {
    const { rows } = await db.query(
      `UPDATE habits SET name=$1, description=$2, type=$3, unit=$4,
              target_value=$5, target_type=$6, freq_numerator=$7,
              freq_denominator=$8, color=$9, reminder_time=$10,
              reminder_message=$11, archived=$12
       WHERE id = $13 RETURNING *`,
      [h.name, h.description, h.type, h.unit, h.target_value, h.target_type,
       h.freq_numerator, h.freq_denominator, h.color, h.reminder_time,
       h.reminder_message, h.archived, id]
    );
    return rows[0];
  });

  if (!updated) throw httpError(404, 'habit not found');
  res.json(updated);
}));

api.delete('/habits/:id', route(async (req, res) => {
  const id = habitId(req);
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
  // The array length was unvalidated and drove a serial UPDATE loop inside one
  // transaction, so a single legal request could hold a pool connection for
  // minutes — a 1MB body fits ~500,000 ids, and duplicates pass validation, so
  // no habits even had to exist. One caller could stall every tenant.
  if (order.length > MAX_HABITS_PER_USER) {
    throw httpError(400, `order may not exceed ${MAX_HABITS_PER_USER} ids`);
  }

  const rows = await withUser(uid(req), async (db) => {
    // One statement instead of a round trip per id. RLS still confines the
    // update to the caller's own habits, so an id belonging to someone else
    // simply matches nothing.
    const ids = order.map((id) => Number(id));
    if (ids.length) {
      await db.query(
        `UPDATE habits SET position = v.position
           FROM (SELECT * FROM unnest($1::bigint[], $2::int[]) AS t(id, position)) AS v
          WHERE habits.id = v.id`,
        [ids, ids.map((_, i) => i)]
      );
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
      [habitId(req)]
    ).then((r) => r.rows)
  );
  res.json(rows);
}));

api.put('/habits/:id/entries/:date', route(async (req, res) => {
  const habit = await getHabit(req);
  const date = req.params.date;

  assertDate(date);
  assertNotFuture(date, today());

  const parsed = parseEntry(habit, req.body, { UNSET, YES, SKIP });

  // The rule — a skip is out of band, and "not done" is the absence of a row
  // unless a note needs one — lives in shared/validate.js, because the personal
  // edition and the Discord button handler have to apply exactly the same one.
  const write = entryWrite(habit, parsed, { UNSET, SKIP });

  await withUser(uid(req), async (db) => {
    if (write.op === 'delete') {
      await db.query(`DELETE FROM entries WHERE habit_id = $1 AND date = $2`,
        [habit.id, date]);
      return;
    }
    await upsertEntry(db, uid(req), habit.id, date, write.value, write.status, write.notes);
  });

  res.json({ habit_id: habit.id, date, ...write.reply });
}));

api.delete('/habits/:id/entries/:date', route(async (req, res) => {
  await getHabit(req);
  if (!DATE_RE.test(req.params.date)) throw httpError(400, 'date must be YYYY-MM-DD');

  await withUser(uid(req), (db) =>
    db.query(`DELETE FROM entries WHERE habit_id = $1 AND date = $2`,
      [habitId(req), req.params.date])
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
    // Bounded, NOT lifetime. This query had no date predicate, so an account
    // with years of history shipped every row to Node and then spent ~850ms
    // of SYNCHRONOUS CPU per request in computeStreaks — blocking the event
    // loop for every other tenant. `boundedRange` caps the date SPAN, not the
    // row count, so it was no help here.
    //
    // STREAK_HISTORY_DAYS bounds what the streak scan reads. A streak longer
    // than this reports as capped rather than reading the whole table; the
    // count below is done in SQL instead of in JS.
    const streakFrom = addDays(end, -STREAK_HISTORY_DAYS);
    const { rows: allRows } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status
       FROM entries WHERE habit_id = ANY($1) AND date >= $2 ORDER BY date`,
      [ids, streakFrom]
    );

    // Lifetime totals in the database, where counting is what it is for.
    // Postgres applies the same completion rule the shared code does; the
    // status check keeps skips out, matching isCompleted returning null.
    const { rows: totalRows } = await db.query(
      `SELECT e.habit_id,
              COUNT(*) FILTER (
                WHERE COALESCE(e.status, '') <> 'skip'
                  AND CASE
                        WHEN h.type = 'boolean' THEN e.value = 2
                        WHEN h.target_type = 'at_most' THEN e.value <= h.target_value
                        ELSE e.value >= h.target_value
                      END
              )::int AS completed
         FROM entries e JOIN habits h ON h.id = e.habit_id
        WHERE e.habit_id = ANY($1)
        GROUP BY e.habit_id`,
      [ids]
    );
    const totals = new Map(totalRows.map((r) => [r.habit_id, r.completed]));

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

        const totalCompleted = totals.get(h.id) ?? 0;

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

/* ---------- notifications ---------- */

/**
 * Post a test message to every configured server-delivered destination.
 *
 * Without it, a wrong webhook URL is only discoverable by waiting for a
 * reminder that never comes and then reading a log the user has no access to.
 * The reply carries each channel's own outcome.
 *
 * The settings are re-read here rather than taken from the request: the URL the
 * server will fetch must be one it has already validated and stored, or this
 * endpoint would be a way to make the server fetch an arbitrary body.
 */
api.post('/notify/test', route(async (req, res) => {
  const settings = await withUser(uid(req), (db) =>
    db.query(`SELECT settings FROM users WHERE id = $1`, [uid(req)])
      .then((r) => r.rows[0]?.settings ?? {})
  );
  res.json({ results: await sendTest(uid(req), settings) });
}));

/* ---------- export ---------- */

api.get('/export', route(async (req, res) => {
  const { data, settings } = await withUser(uid(req), async (db) => {
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
    // Read inside the same transaction as the habits, so the backup is one
    // consistent picture of the account rather than two reads with a write
    // possible between them.
    const { rows } = await db.query(`SELECT settings FROM users WHERE id = $1`, [uid(req)]);
    return {
      data: habits.map((h) => ({ ...h, entries: byHabit.get(h.id) ?? [] })),
      settings: rows[0]?.settings ?? {},
    };
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
    // Part of the account, and two of them now decide what the rows MEAN — see
    // the personal edition's export for the whole reasoning.
    settings,
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

  // Replace mode only — "make this account look like the file". A merge adds
  // habits to what is already here and must not rewrite the rest of the
  // account's preferences. Through parseSettings, so an uploaded file cannot
  // store a value the API itself would refuse; and through withUser, so it is
  // the caller's own row and no one else's that RLS will let it reach.
  let settings = 0;
  if (mode === 'replace') {
    const raw = backupSettings(buf);
    const { accepted } = raw ? parseSettings(raw) : { accepted: {} };
    if (Object.keys(accepted).length) {
      await withUser(uid(req), (db) => db.query(
        `UPDATE users SET settings = settings || $1::jsonb WHERE id = $2`,
        [JSON.stringify(accepted), uid(req)]
      ));
      settings = Object.keys(accepted).length;
    }
  }

  res.json({ mode, ...result, settings });
}));

/* ---------- helpers ---------- */

/** Fetch a habit, 404ing if it does not exist OR is not the caller's. */
/**
 * A habit id from the URL, validated.
 *
 * `Number(req.params.id)` alone let `/api/habits/abc` reach Postgres as NaN
 * and `/api/habits/1e30` as a float, both of which came back as a 22P02
 * "invalid input syntax for bigint" — an unhandled 500 and a logged stack
 * trace for what is plainly a client error.
 */
function habitId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'invalid habit id');
  return id;
}

async function getHabit(req) {
  const id = habitId(req);

  const habit = await withUser(uid(req), (db) =>
    db.query(`SELECT * FROM habits WHERE id = $1`, [id]).then((r) => r.rows[0])
  );
  // RLS makes another user's habit indistinguishable from a missing one,
  // which is what we want: no existence oracle.
  if (!habit) throw httpError(404, 'habit not found');
  return habit;
}

export default api;
