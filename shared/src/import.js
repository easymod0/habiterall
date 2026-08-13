/**
 * Importers for habiterall's own JSON backups and for Loop Habit Tracker
 * exports (both the .db backup and the CSV zip).
 *
 * Loop's on-disk format, confirmed against iSoron/uhabits @ dev:
 *   Habits      (id, name, description, question, freq_num, freq_den, color,
 *                position, archived, type, target_value, target_type, unit, uuid)
 *   Repetitions (habit, timestamp, value, notes)
 *
 *   - timestamp is epoch MILLISECONDS aligned to UTC midnight
 *     (DateUtils.getStartOfDay: (t / 86400000) * 86400000)
 *   - entry values 0..3 and -1 are boolean sentinels:
 *       NO=0, YES_AUTO=1, YES_MANUAL=2, SKIP=3, UNKNOWN=-1
 *     any other value is a numerical amount scaled by 1000 (7.5 -> 7500)
 *   - habit type: 0 = boolean ("YES_NO"), 1 = numerical
 *   - target_type: 0 = at least, 1 = at most
 */

import { UNSET, YES, SKIP } from './constants.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* Loop entry sentinels. */
const LOOP_UNKNOWN = -1;
const LOOP_NO = 0;
const LOOP_YES_AUTO = 1;
const LOOP_YES_MANUAL = 2;
const LOOP_SKIP = 3;

/** Loop scales numerical entry values and targets by 1000. */
const LOOP_NUMERIC_SCALE = 1000;

const MILLIS_PER_DAY = 86_400_000;

/* ---------- shared helpers ---------- */

/**
 * Loop timestamps are UTC-midnight-aligned epoch millis. Read them back with
 * UTC getters so a local timezone west of UTC doesn't shift every date back
 * by one day.
 */
export function loopTimestampToISO(millis) {
  const n = Number(millis);
  if (!Number.isFinite(n)) return null;
  const days = Math.floor(n / MILLIS_PER_DAY);
  const d = new Date(days * MILLIS_PER_DAY);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Translate a Loop entry value into habiterall's encoding.
 *
 * Returns `{ value, status }`, or null when the entry carries no information
 * and should be dropped. Skips are reported via `status`, never as the number
 * 3: on a numerical habit the raw value 3000 is a legitimate "3 units" and
 * must not alias Loop's SKIP sentinel.
 */
export function convertLoopValue(raw, isNumerical) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;

  if (isNumerical) {
    // On numerical habits only the small sentinel band is reserved; every
    // other value is a real amount scaled by 1000.
    if (v === LOOP_SKIP) return { value: 0, status: 'skip' };
    if (v === LOOP_UNKNOWN) return null;
    return { value: v / LOOP_NUMERIC_SCALE, status: '' };
  }

  switch (v) {
    case LOOP_YES_MANUAL:
    case LOOP_YES_AUTO:   // counted as done; Loop auto-fills these on non-daily habits
      return { value: YES, status: '' };
    case LOOP_SKIP:
      return { value: 0, status: 'skip' };
    case LOOP_NO:
    case LOOP_UNKNOWN:
      return null;        // "not done" is stored as absence in habiterall
    default:
      return null;
  }
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Loop stores colors as a palette index, not a hex string. Map the common
 * indices onto a comparable palette; fall back to blue.
 */
const LOOP_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#78716c',
  '#64748b', '#475569',
];

export function normalizeColor(value) {
  if (typeof value === 'string' && COLOR_RE.test(value)) return value;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0) return LOOP_PALETTE[n % LOOP_PALETTE.length];
  return '#3b82f6';
}

/* ---------- habiterall JSON ---------- */

export function parseHabiterallJSON(payload) {
  let data;
  try {
    data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    // A truncated download is a client problem, not a server fault.
    throw Object.assign(new Error('file is not valid JSON'), { status: 400 });
  }

  if (!data || !Array.isArray(data.habits)) {
    throw Object.assign(new Error('not a habiterall export: missing "habits" array'), { status: 400 });
  }

  return data.habits
    .filter((h) => h && typeof h === 'object' && !Array.isArray(h))
    .map((h) => ({
      ...h,
      entries: Array.isArray(h.entries) ? h.entries : [],
    }));
}

/* ---------- Loop .db backup ---------- */

/**
 * Read a Loop SQLite backup. `path` must point at a file on disk; node:sqlite
 * cannot open a database from a buffer.
 */
export async function parseLoopDatabase(path) {
  const { DatabaseSync } = await import('node:sqlite');

  let src;
  try {
    src = new DatabaseSync(path, { readOnly: true });
  } catch {
    throw Object.assign(new Error('file is not a readable SQLite database'), { status: 400 });
  }

  try {
    // Loop's own validation: both tables must be present. A file with a valid
    // SQLite header but a corrupt body throws from here, so the whole read is
    // wrapped and re-tagged as a client error below.
    const check = src
      .prepare(`SELECT COUNT(*) AS n FROM SQLITE_MASTER WHERE name IN ('Habits','Repetitions')`)
      .get();
    if (check.n !== 2) {
      throw Object.assign(
        new Error('not a Loop database: expected Habits and Repetitions tables'),
        { status: 400 }
      );
    }

    const cols = new Set(
      src.prepare(`PRAGMA table_info(Habits)`).all().map((c) => c.name)
    );
    // `question`, `unit`, `target_type` and friends arrived in later schema
    // versions; select only what this backup actually has.
    const pick = (name, fallback) => (cols.has(name) ? name : `${fallback} AS ${name}`);
    const sql = `SELECT id, name,
                        ${pick('description', "''")},
                        ${pick('freq_num', '1')},
                        ${pick('freq_den', '1')},
                        ${pick('color', '11')},
                        ${pick('position', '0')},
                        ${pick('archived', '0')},
                        ${pick('type', '0')},
                        ${pick('target_value', '0')},
                        ${pick('target_type', '0')},
                        ${pick('unit', "''")}
                 FROM Habits ORDER BY position, id`;

    const rows = src.prepare(sql).all();
    const repCols = new Set(
      src.prepare(`PRAGMA table_info(Repetitions)`).all().map((c) => c.name)
    );
    const notesCol = repCols.has('notes') ? 'notes' : `'' AS notes`;
    const reps = src.prepare(
      `SELECT habit, timestamp, value, ${notesCol} FROM Repetitions WHERE habit = ? ORDER BY timestamp`
    );

    return rows.map((r) => {
      const isNumerical = Number(r.type) === 1;
      const entries = [];

      for (const rep of reps.all(r.id)) {
        const date = loopTimestampToISO(rep.timestamp);
        if (!date) continue;
        const converted = convertLoopValue(rep.value, isNumerical);
        if (converted === null) continue;
        entries.push({
          date,
          value: converted.value,
          status: converted.status,
          notes: String(rep.notes ?? ''),
        });
      }

      return {
        name: String(r.name ?? '').trim(),
        description: String(r.description ?? ''),
        type: isNumerical ? 'numerical' : 'boolean',
        unit: String(r.unit ?? ''),
        // Targets are stored UNSCALED, unlike entry values. Verified against a
        // real Loop backup: "brush teeth at most 2 times" has
        // Habits.target_value = 2 while its Repetitions carry value = 2000.
        // Dividing the target here turned it into 0.002.
        target_value: isNumerical ? Number(r.target_value ?? 0) : 0,
        target_type: Number(r.target_type) === 1 ? 'at_most' : 'at_least',
        freq_numerator: Math.max(1, Number(r.freq_num) || 1),
        freq_denominator: Math.max(1, Number(r.freq_den) || 1),
        color: normalizeColor(r.color),
        archived: Number(r.archived) ? 1 : 0,
        entries,
      };
    });
  } catch (err) {
    // Anything thrown while reading a file we already accepted as SQLite is a
    // problem with the upload, not with the server.
    if (!err.status) err.status = 400;
    throw err;
  } finally {
    src.close();
  }
}

/* ---------- CSV ---------- */

/** Minimal RFC-4180 parser: handles quoted fields, embedded commas, and "" escapes. */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const src = text.replace(/^﻿/, ''); // strip BOM

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') { quoted = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* handled by \n */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/**
 * Parse Loop's Checkmarks.csv, whose shape is:
 *   Date,Habit A,Habit B,...
 *   2026-01-01,YES_MANUAL,3,...
 *
 * `habitMeta` optionally supplies type/target info parsed from Habits.csv so
 * numerical columns are interpreted correctly.
 */
export function parseLoopCheckmarksCSV(text, habitMeta = new Map()) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.trim());
  if (!/^date$/i.test(header[0])) {
    throw Object.assign(
      new Error('Checkmarks.csv must start with a "Date" column'),
      { status: 400 }
    );
  }

  // Keep each habit's ORIGINAL column index. Filtering the names first
  // compacted the array while the row was still read at `i + 1`, so every
  // habit after a blank column silently received its neighbour's cell — a
  // `Date,A,,B` header gave B the blank column's value and never read B's own.
  // Wrong data, not a dropped row, which is the worse failure.
  const columns = header
    .map((name, index) => ({ name, index }))
    .slice(1)
    .filter((c) => c.name !== '');

  const habits = columns.map(({ name }) => {
    const meta = habitMeta.get(name) ?? {};
    return {
      name,
      description: meta.description ?? '',
      type: meta.type ?? 'boolean',
      unit: meta.unit ?? '',
      target_value: meta.target_value ?? 0,
      target_type: meta.target_type ?? 'at_least',
      freq_numerator: meta.freq_numerator ?? 1,
      freq_denominator: meta.freq_denominator ?? 1,
      color: meta.color ?? '#3b82f6',
      archived: meta.archived ?? 0,
      entries: [],
    };
  });

  for (const row of rows.slice(1)) {
    const date = (row[0] ?? '').trim();
    if (!DATE_RE.test(date)) continue;

    habits.forEach((habit, i) => {
      // columns[i].index, not i + 1 — see the note where `columns` is built.
      const cell = (row[columns[i].index] ?? '').trim();
      if (cell === '' || cell === '-') return;

      const isNumerical = habit.type === 'numerical';
      let value;
      let status = '';

      // Loop writes symbolic names for boolean entries.
      switch (cell.toUpperCase()) {
        case 'YES_MANUAL':
        case 'YES_AUTO':
        case 'YES':
          value = YES; break;
        case 'SKIP':
          value = 0; status = 'skip'; break;
        case 'NO':
        case 'UNKNOWN':
          return;
        default: {
          const n = Number(cell);
          if (!Number.isFinite(n) || n < 0) return;
          // Numerical columns in the CSV are already human-scale, so they are
          // taken verbatim and never run through the sentinel mapping.
          if (isNumerical) {
            value = n;
          } else {
            const converted = convertLoopValue(n, false);
            if (converted === null) return;
            value = converted.value;
            status = converted.status;
          }
        }
      }
      habit.entries.push({ date, value, status, notes: '' });
    });
  }

  return habits;
}

/**
 * Parse Loop's Habits.csv header row:
 *   Position,Name,Type,Question,Description,FrequencyNumerator,
 *   FrequencyDenominator,Color,Unit,Target Type,Target Value,Archived?
 */
export function parseLoopHabitsCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return new Map();

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (...aliases) => {
    for (const a of aliases) {
      const i = header.indexOf(a);
      if (i !== -1) return i;
    }
    return -1;
  };

  const cName = idx('name');
  if (cName === -1) return new Map();

  const cType = idx('type');
  const cDesc = idx('description', 'question');
  // Loop's own Habits.csv labels these NumRepetitions/Interval; other exports
  // (and older versions) spell them out. Accept both, or a 3-times-a-week
  // habit silently comes back as daily.
  const cNum = idx('frequencynumerator', 'frequency numerator', 'numrepetitions');
  const cDen = idx('frequencydenominator', 'frequency denominator', 'interval');
  const cColor = idx('color');
  const cUnit = idx('unit');
  const cTType = idx('target type', 'targettype');
  const cTVal = idx('target value', 'targetvalue');
  const cArch = idx('archived?', 'archived');

  const out = new Map();
  for (const row of rows.slice(1)) {
    const name = (row[cName] ?? '').trim();
    if (!name) continue;

    // Loop writes the enum name (NUMERICAL / YES_NO); older or localized
    // exports may use a human-readable label such as "Measurable".
    const rawType = (row[cType] ?? '').trim().toLowerCase();
    const isNumerical =
      rawType === '1' ||
      rawType.includes('numer') ||
      rawType.includes('measur');
    const rawArch = (row[cArch] ?? '').trim().toLowerCase();

    out.set(name, {
      description: cDesc === -1 ? '' : (row[cDesc] ?? '').trim(),
      type: isNumerical ? 'numerical' : 'boolean',
      unit: cUnit === -1 ? '' : (row[cUnit] ?? '').trim(),
      target_value: cTVal === -1 ? 0 : Number(row[cTVal]) || 0,
      target_type:
        cTType !== -1 && (row[cTType] ?? '').toLowerCase().includes('most')
          ? 'at_most'
          : 'at_least',
      freq_numerator: cNum === -1 ? 1 : Math.max(1, Number(row[cNum]) || 1),
      freq_denominator: cDen === -1 ? 1 : Math.max(1, Number(row[cDen]) || 1),
      color: normalizeColor(cColor === -1 ? undefined : (row[cColor] ?? '').trim()),
      archived: rawArch === 'true' || rawArch === '1' ? 1 : 0,
    });
  }
  return out;
}
