/**
 * Importers for habiterall's own JSON backups and for Loop Habit Tracker
 * exports (both the .db backup and the CSV zip).
 *
 * Loop's on-disk format, confirmed against iSoron/uhabits @ dev:
 *   Habits      (id, name, description, question, freq_num, freq_den, color,
 *                position, reminder_hour, reminder_min, reminder_days,
 *                archived, type, target_value, target_type, unit, uuid)
 *   Repetitions (habit, timestamp, value, notes)
 *
 *   - timestamp is epoch MILLISECONDS aligned to UTC midnight
 *     (DateUtils.getStartOfDay: (t / 86400000) * 86400000)
 *   - entry values 0..3 and -1 are boolean sentinels:
 *       NO=0, YES_AUTO=1, YES_MANUAL=2, SKIP=3, UNKNOWN=-1
 *     any other value is a numerical amount scaled by 1000 (7.5 -> 7500)
 *   - habit type: 0 = boolean ("YES_NO"), 1 = numerical
 *   - target_type: 0 = at least, 1 = at most
 *   - question is the prompt a reminder asks, i.e. habiterall's reminder_message
 *   - a reminder is reminder_hour + reminder_min, and NULL for "none"
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
import { unzip } from './unzip.js';
// The same limits the API enforces, so an import cannot store what a typed-in
// habit could not.
import { LIMITS } from './validate.js';
import { TIME_RE } from './constants.js';

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
      // A day the user told Loop they had missed. Kept as a row, which is what
      // habiterall now means by "no" — these used to be dropped, and with them
      // went the only thing that distinguished a lapse from a day never
      // answered. On a backup from someone who does not use Loop's question
      // marks that is most of their history.
      return { value: 0, status: '' };
    case LOOP_UNKNOWN:
      return null;        // nothing is known about the day: no row
    default:
      return null;
  }
}

/**
 * Loop stores a reminder as two integer columns and NULL for "no reminder";
 * habiterall stores one `HH:MM` string and `''`. Anything that is not a whole
 * hour 0..23 with a whole minute 0..59 is no reminder — a partial row (an hour
 * with a NULL minute) is not a time, and inventing `:00` for it would put a
 * notification on someone's phone that their Loop install never had.
 *
 * The inverse lives in export-loop.js as `timeToLoopReminder`, alongside the
 * other half of every conversion in this file.
 */
export function loopReminderToTime(hour, min) {
  if (hour === null || hour === undefined || min === null || min === undefined) return '';
  const h = Number(hour);
  const m = Number(min);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return '';
  if (h < 0 || h > 23 || m < 0 || m > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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

/**
 * The preferences a habiterall JSON backup carries, if it is one.
 *
 * Separate from `parseUpload` rather than part of its result, because these do
 * not go where the habits go: they are written through `parseSettings` and each
 * edition's settings storage, not through `applyImport`. Nothing here is
 * trusted — this only says "the file had an object under `settings`" and the
 * validator decides what any of it means.
 *
 * Returns `null` for every other format. Loop cannot answer this at all: its
 * preferences live in Android's SharedPreferences, not in the backup database,
 * so a Loop import leaves the account's own settings alone — which is also the
 * right answer, since Loop's keys are not these keys.
 *
 * @param {Buffer} buf the raw request body
 * @returns {Record<string, any>|null}
 */
export function backupSettings(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;

  const head = buf.toString('utf8').replace(/^﻿/, '').trimStart();
  if (!head.startsWith('{')) return null;      // a bare habits array, or not JSON

  let data;
  try {
    data = JSON.parse(head);
  } catch {
    return null;                               // parseUpload reports the error
  }

  const settings = data?.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  return settings;
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
                        ${pick('question', "''")},
                        ${pick('freq_num', '1')},
                        ${pick('freq_den', '1')},
                        ${pick('color', '11')},
                        ${pick('position', '0')},
                        ${pick('archived', '0')},
                        ${pick('type', '0')},
                        ${pick('target_value', '0')},
                        ${pick('target_type', '0')},
                        ${pick('unit', "''")},
                        ${pick('reminder_hour', 'NULL')},
                        ${pick('reminder_min', 'NULL')}
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
        // Loop's `question` is the prompt a reminder asks — "Did you meditate
        // today?" rather than the habit's name — which is exactly what
        // `reminder_message` holds. `normaliseImportedHabit` flattens and clamps
        // it, so a Loop file cannot store a prompt the habit dialog could not.
        reminder_message: String(r.question ?? ''),
        reminder_time: loopReminderToTime(r.reminder_hour, r.reminder_min),
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
      reminder_message: meta.reminder_message ?? '',
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
          // A stated lapse, kept as a row — the same change as `LOOP_NO` in
          // convertLoopValue, and for the same reason.
          value = 0; break;
        case 'UNKNOWN':
          return;                      // no row: nothing is known about the day
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
  // `question` and `description` are two different Loop fields and land in two
  // different habiterall ones. This used to read `idx('description', 'question')`
  // — question as a *fallback* for description — so a Loop backup with a prompt
  // and no description imported the prompt as the habit's description, while the
  // .db path dropped it entirely. Re-importing such a file now puts it where it
  // belongs; the old copy in `description` is left alone, since nothing here can
  // tell it from a description the user wrote.
  const cDesc = idx('description');
  const cQuestion = idx('question');
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
      reminder_message: cQuestion === -1 ? '' : (row[cQuestion] ?? '').trim(),
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

/* ---------- what arrived in the request body ---------- */

/**
 * Work out what an uploaded file is, and parse it.
 *
 * Sniffed from the bytes rather than trusted from the client:
 *
 *   PK\x03\x04           -> zip (a Loop CSV export)
 *   "SQLite format 3\0"  -> a Loop .db backup
 *   otherwise            -> text: a habiterall JSON backup, or a bare CSV
 *
 * This lived in both editions' api.js, and the two copies had already drifted in
 * a way worth recording. The staged temp file was named
 * `habiterall-import-${pid}-${Date.now()}.db` with default permissions in the
 * personal edition, and `randomUUID()` with mode 0600 in cloud: a predictable
 * name and a world-readable file, holding somebody's entire habit history, fixed
 * once and never carried back. The safer pair is what survives here.
 *
 * Errors carry `status: 400` — an unreadable upload is the client's problem, and
 * both editions' error middleware reads that field.
 *
 * @param {Buffer} buf the raw request body
 * @returns {Promise<object[]>} normalised habits, ready for applyImport
 */
export async function parseUpload(buf) {
  const fail = (message) => Object.assign(new Error(message), { status: 400 });

  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'PK\x03\x04') {
    return parseZipExport(buf, fail);
  }

  if (buf.length >= 16 && buf.toString('latin1', 0, 15) === 'SQLite format 3') {
    // node:sqlite can only open a path, so the upload has to be staged on disk.
    // A random name because a predictable one in a shared /tmp is a file another
    // local user can wait for, and 0600 because the contents are private.
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomUUID } = await import('node:crypto');

    const path = join(tmpdir(), `habiterall-import-${randomUUID()}.db`);
    writeFileSync(path, buf, { mode: 0o600 });
    try {
      return await parseLoopDatabase(path);
    } finally {
      try { unlinkSync(path); } catch { /* best effort */ }
    }
  }

  // A BOM survives a round trip through Windows editors and would otherwise
  // make `JSON.parse` fail on a file that is perfectly valid.
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const head = text.trimStart();

  if (head.startsWith('{') || head.startsWith('[')) {
    return parseHabiterallJSON(head.startsWith('[') ? { habits: JSON.parse(head) } : text);
  }

  if (/^"?date"?\s*,/i.test(head)) return parseLoopCheckmarksCSV(text);

  throw fail(
    'unrecognized file: expected a habiterall JSON backup, a Loop .db backup, ' +
    'or a Loop CSV export'
  );
}

/**
 * Pull Habits.csv and Checkmarks.csv out of a Loop CSV export.
 *
 * Both are needed. Checkmarks.csv has one column per habit and nothing saying
 * what a habit IS, so parsed alone every column defaults to boolean — and a
 * measurable habit's 3 is then read as Loop's SKIP sentinel.
 */
function parseZipExport(buf, fail) {
  const files = unzip(buf);

  const find = (suffix) => {
    for (const [name, contents] of files) {
      if (name.toLowerCase().endsWith(suffix)) return contents.toString('utf8');
    }
    return null;
  };

  const checkmarksCsv = find('checkmarks.csv');
  if (!checkmarksCsv) throw fail('zip does not contain a Checkmarks.csv');

  const habitsCsv = find('habits.csv');
  const meta = habitsCsv ? parseLoopHabitsCSV(habitsCsv) : new Map();
  return parseLoopCheckmarksCSV(checkmarksCsv, meta);
}

/**
 * Repair one imported habit into something both editions will store.
 *
 * `parseHabit` in validate.js is the sibling of this function and the difference
 * is deliberate: that one REJECTS bad input, because a person is typing it and
 * can be told. This one REPAIRS it, because the input is a file — often written
 * by another application — and refusing the whole import over one over-long
 * description would be the wrong trade.
 *
 * It exists because the two writers had drifted apart on exactly the rules a
 * validator is for:
 *
 *   personal   no length clamps at all, and no cap on the frequency denominator
 *   cloud      description 500, unit 20, denominator 365
 *
 * So the personal edition would accept, through an import, a habit its own API
 * would have refused — and `shared/CLAUDE.md` already says why that is the worst
 * kind of divergence: data one edition accepts and the other silently truncates
 * on the way back in. The limits come from LIMITS rather than being restated, so
 * they cannot drift from the ones the API enforces either.
 *
 * Loop permits shapes our own validation does not (a numerator above the
 * denominator), so those are squared up rather than dropped.
 *
 * @param {Record<string, any>} h a habit from any parser
 * @returns {import('./types.js').Habit & {archived: boolean}}
 */
export function normaliseImportedHabit(h) {
  const num = Math.max(1, Number(h.freq_numerator) || 1);
  let den = Math.max(1, Number(h.freq_denominator) || 1);
  if (num > den) den = num;
  den = Math.min(den, LIMITS.freqDenominator);

  const target = Number(h.target_value);

  return {
    name: String(h.name ?? '').trim().slice(0, LIMITS.name),
    description: String(h.description ?? '').slice(0, LIMITS.description),
    type: h.type === 'numerical' ? 'numerical' : 'boolean',
    unit: String(h.unit ?? '').slice(0, LIMITS.unit),
    target_value: Number.isFinite(target) && target > 0 ? target : 0,
    target_type: h.target_type === 'at_most' ? 'at_most' : 'at_least',
    freq_numerator: num,
    freq_denominator: den,
    color: normalizeColor(h.color),
    reminder_time: TIME_RE.test(h.reminder_time ?? '') ? h.reminder_time : '',
    // One line and capped, the same rule parseHabit applies: an imported prompt
    // ends up in the Android client's line-delimited reminder cache exactly like
    // one typed into the dialog, and a newline there corrupts the record it
    // sits in.
    reminder_message: String(h.reminder_message ?? '')
      .replace(/[\r\n]+/g, ' ').trim().slice(0, LIMITS.reminderMessage),
    archived: !!h.archived,
  };
}
