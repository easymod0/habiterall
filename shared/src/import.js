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

import { unzip } from './unzip.js';
// The same limits the API enforces, so an import cannot store what a typed-in
// habit could not.
import { LIMITS, AT_MOST_UNLOGGED, SHOW_AS, parseIcon } from './validate.js';
import { TIME_RE } from './constants.js';

/**
 * Loop timestamps are UTC-midnight-aligned epoch millis. Read them back with
 * UTC getters so a local timezone west of UTC doesn't shift every date back
 * by one day.
 *
 * The year is padded to four digits exactly as the month and day are, and that
 * is not cosmetic: a date reaches storage only through `^\d{4}-\d{2}-\d{2}$` in
 * both editions' `applyImport`, so `0100-01-01` came back as `"100-01-01"` and
 * the entry was silently discarded as a bad date — on a timestamp the export
 * half had written correctly. The `boundedRange` note in the root CLAUDE.md
 * cites an entry dated year 0100 as data that has actually turned up here.
 *
 * Anything outside years 1–9999 is `null`, which is what the caller already
 * skips on. Padding alone would have turned year 0 into a plausible-looking
 * `0000-01-01`; a negative year is BCE, which nothing downstream represents;
 * and a timestamp past the ECMAScript range arrives as a NaN year. Refusing
 * all three here rather than leaving them to a regex three files away is what
 * keeps "this reader emits a real date or nothing" true of the function itself.
 *
 * That sentence is only true because the guard below is about the TYPE and not
 * the value. `Number(null)`, `Number('')`, `Number([])` and `Number(false)` are
 * all `0` — and 0 is a perfectly real timestamp, the epoch — so a `Number()`
 * check let an absent column read back as 1970-01-01 while `undefined` and
 * `NaN` were correctly refused. A missing timestamp is not a day in 1970.
 *
 * One cost, and it is the reason this is written down. A row this refuses is
 * dropped by `parseLoopDatabase`'s `if (!date) continue` with no report, where
 * before it reached `applyImport` and came back as `bad date on "X": 0-01-01`.
 * The parser has no `skipped` channel of its own to say it in. That is a real
 * loss of visibility, paid for by the years 1–999 this now RESCUES — those used
 * to be reported-and-discarded and are now imported. Give the parser a report
 * and this trade goes away.
 */
export function loopTimestampToISO(millis) {
  const n = typeof millis === 'number'
    ? millis
    : (typeof millis === 'string' && /^-?\d+$/.test(millis.trim()) ? Number(millis) : NaN);
  if (!Number.isFinite(n)) return null;
  const days = Math.floor(n / MILLIS_PER_DAY);
  const d = new Date(days * MILLIS_PER_DAY);
  const y = d.getUTCFullYear();
  if (!(y >= 1 && y <= 9999)) return null;
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${m}-${day}`;
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

/** Loop's `reminder_days`: all seven bits of the weekday mask set. */
export const LOOP_ALL_DAYS = 127;

/**
 * A column that should hold a whole number, read strictly.
 *
 * The reminder columns are selected as TEXT (see `parseLoopDatabase`), so a
 * real value arrives as `'7'` and anything else as itself. `Number()` alone is
 * far too generous to be the gate: `Number('')` and `Number(' ')` are both `0`,
 * which turned an empty column into a real midnight reminder, and `'0x7'` /
 * `'1e1'` are accepted as 7 and 10. Only digits count.
 */
function wholeNumber(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Loop stores a reminder as two integer columns and NULL for "no reminder";
 * habiterall stores one `HH:MM` string and `''`. Anything that is not a whole
 * hour 0..23 with a whole minute 0..59 is no reminder — a partial row (an hour
 * with a NULL minute) is not a time, and inventing `:00` for it would put a
 * notification on someone's phone that their Loop install never had.
 *
 * Loop's own rule, from `SQLiteHabitList.copyTo`, is a null check on BOTH
 * columns rather than a truthiness test — which is why `0, 0` is a real
 * midnight reminder here and not the absence of one.
 *
 * The inverse lives in export-loop.js as `timeToLoopReminder`, alongside the
 * other half of every conversion in this file.
 */
export function loopReminderToTime(hour, min) {
  const h = wholeNumber(hour);
  const m = wholeNumber(min);
  if (h === null || m === null) return '';
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

  // The third reader, and it needs the same ceilings as the other two. Lower
  // amplification than the zip route — this arrives uncompressed — but the
  // 16MB body limit is not a bound on object count: `{"name":"a","entries":[]}`
  // is 26 bytes, so the allowed body still describes several hundred thousand
  // habits, and the array is materialised by `JSON.parse` before this function
  // is even entered. Bounding here is therefore about what happens NEXT — the
  // per-habit work in `applyImport`, which is a transaction — rather than about
  // the parse itself, which is the one honest difference from the .db case.
  if (data.habits.length > MAX_PARSE_HABITS) throw tooMuch(`${MAX_PARSE_HABITS} habits`);

  let entryBudget = MAX_PARSE_ENTRIES;
  return data.habits
    .filter((h) => h && typeof h === 'object' && !Array.isArray(h))
    .map((h) => {
      const entries = Array.isArray(h.entries) ? h.entries : [];
      // A total across the file, as everywhere else here: one habit with a
      // million days costs the same as a million habits with one.
      entryBudget -= entries.length;
      if (entryBudget < 0) throw tooMuch(`${MAX_PARSE_ENTRIES} entries`);
      return { ...h, entries };
    });
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

/**
 * The repair tail every raw category list gets before it is handed back,
 * regardless of which format supplied it: a nameless entry dropped (the same
 * rule `parseCategory` throws on for a typed-in one — a backup that repairs
 * everything else still has no honest name to give an empty entry, so it is
 * dropped rather than invented), a name trimmed to `LIMITS.name`, a colour
 * failing `COLOR_RE` replaced with the default, a position read as a number
 * and replaced by the index unless it is an integer, and the list capped at
 * `LIMITS.categories`.
 *
 * Both of `backupCategories`'s branches — the JSON backup and a zip's
 * `Categories.csv` — call this rather than repeating it, so the two formats
 * cannot repair one field differently from the other.
 *
 * `diagnostics`, when handed an object, is filled in with `named` — the count
 * that survived the nameless-entry drop, before the `LIMITS.categories`
 * slice — so a caller that needs to know whether the slice actually cut
 * anything does not have to repeat the filter to find out.
 *
 * @param {Array<{name?: any, color?: any, position?: any}>} raw
 * @param {{named?: number}} [diagnostics]
 * @returns {Array<{name: string, color: string, position: number}>}
 */
function normalizeCategories(raw, diagnostics) {
  const named = raw
    .map((c) => {
      // TRIMMED before the test, and that is not cosmetic. `COLOR_RE` is
      // anchored, so one leading space is the difference between a colour
      // restoring and silently becoming the default — and a hand-edited
      // `Categories.csv` written the way people write CSV by hand
      // (`Health, #10b981, 5`) is exactly that. The name has always been
      // trimmed here and `Number` tolerates the space on a position, so the
      // colour was the one field of the three where the whitespace survived
      // to be judged. Trimming here rather than in the CSV row reader is what
      // keeps the promise this function exists for: both formats repair the
      // field the same way.
      const color = String(c.color ?? '').trim();
      // READ AS A NUMBER here, for the same reason the colour is trimmed
      // here: a position arrives as a number from our own JSON backup and as
      // TEXT from `Categories.csv`, and this function is what stops the two
      // formats repairing one field differently. The coercion used to live in
      // the CSV row reader alone, so `{"position": "5"}` in a hand-edited
      // JSON backup — the same hand-edited file the trim above exists for —
      // was not an integer, fell through to the index below, and restored
      // every category in declaration order with nothing in `result.skipped`
      // to say so.
      //
      // A BLANK or nullish position is "no position", never 0. `Number('')`
      // and `Number(null)` are both `0` and `Number.isInteger(0)` is true, so
      // a bare `Number()` here would land every empty `Position` cell and
      // every `"position": null` at 0 — the bug the blank-cell check in
      // `parseCategoriesCsvRows` used to hold on its own, which is why that
      // check moved here rather than being duplicated. Junk text is NaN,
      // which falls through to the index exactly as an absent field does.
      const position = typeof c.position === 'string'
        ? Number(c.position.trim() || NaN)
        : c.position;
      return {
        name: String(c.name ?? '').trim().slice(0, LIMITS.name),
        // The same regex `normalizeColor` below already validates a habit's
        // own colour with — a category's is never a Loop palette index, so
        // `normalizeColor` itself is the wrong tool despite being right there.
        color: COLOR_RE.test(color) ? color : '#3b82f6',
        position,
      };
    })
    .filter((c) => c.name);
  if (diagnostics) diagnostics.named = named.length;
  return named
    .slice(0, LIMITS.categories)
    .map((c, i) => ({ ...c, position: Number.isInteger(c.position) ? c.position : i }));
}

/**
 * CATEGORIES with a one-line explanation of what it lost attached, for the
 * route to append to `result.skipped`.
 *
 * Non-enumerable, so the property cannot reach a response body or a comparison
 * of the list against itself — it is a channel to the caller, not a member.
 *
 * @param {Array<{name: string, color: string, position: number}>} categories
 * @param {string} message
 */
function withSkip(categories, message) {
  Object.defineProperty(categories, 'categorySkip', { value: message });
  return categories;
}

/**
 * ...specifically, that `normalizeCategories` capped the list.
 *
 * Both formats, not just the zip. The cap lives in the shared repair tail, so
 * a habiterall JSON backup declaring more than `LIMITS.categories` is cut in
 * exactly the same silence a zip was — and the reporting used to be the one
 * half of the repair that was NOT shared, which made the message depend on the
 * format rather than on what happened. The nearest thing to a channel on the
 * JSON side was `resolveOrCreateCategory` noticing a habit that named a cut
 * category, which reports the loss only when a cut category was in USE.
 *
 * `source` names the file in the sentence the user reads, since by the time
 * they see it the two formats are the only thing that tells them where to look.
 *
 * @param {Array<{name: string, color: string, position: number}>} categories
 * @param {{named?: number}} diagnostics
 * @param {string} source
 */
function overCapSkip(categories, diagnostics, source) {
  const named = diagnostics.named ?? 0;
  if (named <= LIMITS.categories) return categories;
  return withSkip(categories,
    `${named - LIMITS.categories} of ${named} categories in ${source} `
    + `were dropped: at most ${LIMITS.categories} are allowed`);
}

/**
 * `Categories.csv`'s own header — `Name,Color,Position`, exactly what
 * `buildCategoriesCsv` (export-csv.js) writes — read into the same raw shape
 * `backupCategories`'s JSON branch produces before `normalizeCategories`
 * repairs either. Matched case-insensitively by column NAME rather than
 * position, the way `parseLoopHabitsCSV` reads its own header, so a reordered
 * or partially-absent column degrades rather than misreads.
 *
 * @param {string} text
 * @returns {Array<{name: string, color: string, position: string|undefined}>}
 */
function parseCategoriesCsvRows(text) {
  const rows = parseCSV(text);
  if (rows.length < 1) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const cName = header.indexOf('name');
  if (cName === -1) return [];
  const cColor = header.indexOf('color');
  const cPosition = header.indexOf('position');

  return rows.slice(1).map((row) => ({
    name: row[cName] ?? '',
    color: cColor === -1 ? '' : (row[cColor] ?? ''),
    // Handed over as the RAW cell. `normalizeCategories` is what reads a
    // position as a number, and it has to do that for the JSON branch's
    // values anyway — so the blank-cell rule that used to live here (a blank
    // is "no position" and not a stated 0) moved there with it, rather than
    // being written once per format. An absent COLUMN is `undefined`, which
    // is that same "no position" and the shape the JSON branch produces for
    // a category that declared none.
    position: cPosition === -1 ? undefined : row[cPosition],
  }));
}

/**
 * The categories a habiterall backup carries, if it names any — from the
 * JSON format's own `categories` array, or from a zip's `Categories.csv`
 * (`buildCsvArchive`, export-csv.js) alongside `Habits.csv` and
 * `Checkmarks.csv`.
 *
 * Same shape and guards as `backupSettings` beside it, and the same reason to
 * be separate from `parseHabiterallJSON`'s result rather than a field on it:
 * these do not go where the habits go. They are handed to each edition's
 * `applyImport`, which resolves-or-creates them by `foldCategoryName` before a
 * single habit is written, so a habit naming a category by NAME (see
 * `normaliseImportedHabit` below) has something to resolve against.
 *
 * Returns `null` for every other format, and for a zip carrying no
 * `Categories.csv` — a Loop-produced zip never has one, and that member is
 * optional on our own (`buildCsvArchive` omits it for an account with no
 * categories), so this must stay exactly as inert on either as it always was.
 * Neither Loop `.db` nor Loop's own CSV pair has anywhere to put a category.
 *
 * Capped at `LIMITS.categories`, the same ceiling `POST /categories` enforces,
 * and non-objects are dropped the way `parseHabiterallJSON` filters its own
 * `habits` array — a file is not to be trusted merely for being valid JSON.
 *
 * From a zip's `Categories.csv`, the returned array may carry a non-enumerable
 * `categorySkip` string naming a whole-file failure the caller cannot see any
 * other way — a header with no usable rows, or more rows than the cap allows.
 * Each edition's `/api/import` route pushes it onto `result.skipped`.
 *
 * @param {Buffer} buf the raw request body
 * @returns {(Array<{name: string, color: string, position: number}> &
 *   {categorySkip?: string})|null}
 */
export function backupCategories(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;

  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'PK\x03\x04') {
    // Sniffed the same 4 bytes `parseUpload` sniffs. Any failure to actually
    // read it as a zip is reported by `parseUpload` itself when the real
    // import runs — this reader only ever answers `null` on a doubt, never
    // throws.
    //
    // This is the SECOND `unzip()` of the same buffer on an ordinary import:
    // both routes call `parseUpload(buf)` (whose zip branch decompresses
    // every member to reach `Habits.csv`/`Checkmarks.csv`) and then this
    // function on the identical `buf`, so a large `Checkmarks.csv` is
    // inflated twice, once for no reason a Loop zip can ever satisfy — it has
    // no `Categories.csv` to find. `MAX_TOTAL_BYTES` is a per-call bound, so
    // this doubles the inflate cost a request may spend rather than the
    // memory held at once. The right fix is `parseUpload` returning
    // categories alongside habits from its own single unzip, which is a
    // wider change than a review round should carry — filed as #282 rather
    // than done here.
    let files;
    try {
      files = unzip(buf);
    } catch {
      return null;
    }

    const find = (suffix) => {
      for (const [name, contents] of files) {
        if (name.toLowerCase().endsWith(suffix)) return contents.toString('utf8');
      }
      return null;
    };

    const categoriesCsv = find('categories.csv');
    if (categoriesCsv === null) return null;   // a Loop zip, or one of ours with none

    // Unlike the JSON branch below, a zip's `Categories.csv` is new with this
    // format (#257) and every way it can carry nothing was silent: a header
    // with no `name` column, a header-only file, or more rows than
    // `LIMITS.categories` allows. In every case the import still succeeds —
    // habits still name their categories from `Habits.csv`, and
    // `resolveOrCreateCategory` re-invents each at the default colour — and
    // nothing told the user their file's own colours and positions were
    // dropped. `categorySkip` carries that sentence for the route to add to
    // `result.skipped`, the channel already built for exactly this; a `null`
    // result above (no member, or an unreadable zip) is not this, and never
    // gets one, because there `Categories.csv` was never there to lose.
    const diagnostics = {};
    const categories = normalizeCategories(parseCategoriesCsvRows(categoriesCsv), diagnostics);
    if ((diagnostics.named ?? 0) === 0) {
      // Zip-only, and deliberately: a JSON backup with an empty `categories`
      // array is a legitimate shape that says "this account has none", while a
      // `Categories.csv` member that parsed to nothing is a file that was
      // supposed to carry something.
      return withSkip(categories,
        'Categories.csv carried no usable categories: colours and positions were not restored');
    }
    return overCapSkip(categories, diagnostics, 'Categories.csv');
  }

  const head = buf.toString('utf8').replace(/^﻿/, '').trimStart();
  if (!head.startsWith('{')) return null;      // a bare habits array, or not JSON

  let data;
  try {
    data = JSON.parse(head);
  } catch {
    return null;                               // parseUpload reports the error
  }

  const categories = data?.categories;
  if (!Array.isArray(categories)) return null;

  const diagnostics = {};
  return overCapSkip(
    normalizeCategories(
      categories.filter((c) => c && typeof c === 'object' && !Array.isArray(c)),
      diagnostics
    ),
    diagnostics,
    'the backup'
  );
}

/* ---------- Loop .db backup ---------- */

/**
 * Ceiling on how many habits one uploaded backup may produce.
 *
 * A SQLite file's row count is DECLARED, not stored — `Habits` can be a view
 * over a recursive CTE, or simply a table with more rows than anyone has — so
 * without a ceiling the *file* chooses how much memory this costs. An 8,192-byte
 * upload expanded to 300,000 habits in 3.1s and 474MB here, and five million
 * aborted the process inside `node::sqlite::StatementExecutionHelper::All`. That
 * is a V8 OOM, not an exception: the `try` below never runs, so the one thing
 * this path does well — turning a bad upload into a 400 — was unreachable.
 *
 * 10,000 is a sanity bound on a hostile file, not a product limit. Cloud's
 * `MAX_HABITS_PER_IMPORT` (200) is the product limit, and it is applied to the
 * parsed array, which is far too late to be a defence — this is the bound that
 * has to hold before that array exists. Fifty times cloud's cap, so nothing real
 * comes near it, and a file sitting exactly on it parses in 81ms for 20MB.
 *
 * `PARSE` and not `IMPORT` in the name for exactly that distinction, and to keep
 * a reader from reaching for cloud's similarly-spelled `MAX_HABITS_PER_IMPORT`
 * when they mean this one.
 *
 * Tunable because otherwise it is the personal edition's first cap on anything:
 * that API will create habits all day, so a fixed ceiling here would make the
 * importer stricter than the API it exists to agree with, with no way out for
 * someone who genuinely has more. Cloud's own limits are all env-settable for
 * the same reason. Lowering it is a legitimate hardening choice; raising it
 * trades memory for generosity and the figures above are what to trade against.
 */
export const MAX_PARSE_HABITS = Number(process.env.MAX_PARSE_HABITS) || 10_000;

/**
 * Ceiling on entries, and it is a TOTAL across the import rather than per habit.
 *
 * `unzip.js` records why, one attack over: a per-member cap is not a defence
 * when the number of members is also attacker-chosen, because each one stays
 * legal and the product does not. Per-habit here would be
 * `MAX_PARSE_HABITS × the cap` rows — 10,000 legal habits multiplying out to
 * something no ceiling was ever asked about.
 *
 * 250,000 is past what Loop could physically have produced: it shipped in 2016,
 * so this is ~68 habits answered every single day since. Generous, and still
 * bounded where it matters — a file sitting exactly on it parses in 410ms for
 * 69MB, against 143MB at half a million. Both ceilings together are ~89MB, which
 * a small container survives; the unbounded read did not survive anything.
 */
export const MAX_PARSE_ENTRIES = Number(process.env.MAX_PARSE_ENTRIES) || 250_000;

/**
 * One refusal for every parse path, because there is more than one and they
 * were not all bounded. The `.db` reader got a ceiling first; the CSV reader
 * had none, and it is the cheaper attack — a header is one line, so
 * `Date,a,a,a,…` two million times deflates ~1000:1 and 8KB of zip aborted the
 * process where 8KB of SQLite had been made to answer 400.
 */
const tooMuch = (what) => Object.assign(
  new Error(`backup expands to too much data: more than ${what}`), { status: 400 }
);

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
    // `type IN ('table','view')` because a TRIGGER may share a table's name in
    // SQLite, and keying a Map on name alone let the trigger's row win — so a
    // perfectly good backup carrying one was refused as "Habits is a trigger,
    // not a table". Indexes have the same shape of collision.
    const objects = new Map(
      src.prepare(
        `SELECT name, type FROM SQLITE_MASTER
          WHERE name IN ('Habits','Repetitions') AND type IN ('table','view')`
      ).all().map((r) => [r.name, r.type])
    );
    if (objects.size !== 2) {
      throw Object.assign(
        new Error('not a Loop database: expected Habits and Repetitions tables'),
        { status: 400 }
      );
    }
    // And both must be TABLES. Loop only ever writes tables, so this costs a
    // real backup nothing, and a view is how the row count stops being related
    // to the file: `CREATE VIEW Habits AS WITH RECURSIVE …` is 8KB of upload
    // declaring five million rows. This is defence in depth and not the fix —
    // the ceilings below are, because a plain table under the body limit still
    // holds several hundred thousand rows and amplifies perfectly well.
    //
    // Note it is not a type gate either: `CREATE VIRTUAL TABLE Habits USING
    // fts5(…)` reports `type = 'table'` and walks straight past. That is fine
    // and deliberate — whatever it produces meets the ceiling like anything
    // else — but do not read this check as deciding what a table may contain.
    for (const name of ['Habits', 'Repetitions']) {
      if (objects.get(name) !== 'table') {
        throw Object.assign(
          new Error(`not a Loop database: ${name} is a ${objects.get(name)}, not a table`),
          { status: 400 }
        );
      }
    }

    const cols = new Set(
      src.prepare(`PRAGMA table_info(Habits)`).all().map((c) => c.name)
    );
    // `question`, `unit`, `target_type` and friends arrived in later schema
    // versions; select only what this backup actually has.
    const pick = (name, fallback) => (cols.has(name) ? name : `${fallback} AS ${name}`);
    // The reminder columns come back as TEXT, and `wholeNumber` is what reads
    // them. Selecting them as INTEGER means node:sqlite decodes them, and a
    // value above 2^53 makes the decoder throw for the whole `.all()` — so one
    // garbage cell would reject an entire backup that used to import fine.
    const pickInt = (name, fallback) => (cols.has(name)
      ? `CAST(${name} AS TEXT) AS ${name}`
      : `${fallback} AS ${name}`);
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
                        ${pickInt('reminder_hour', 'NULL')},
                        ${pickInt('reminder_min', 'NULL')},
                        ${pickInt('reminder_days', `'${LOOP_ALL_DAYS}'`)}
                 FROM Habits ORDER BY position, id LIMIT ?`;

    const repCols = new Set(
      src.prepare(`PRAGMA table_info(Repetitions)`).all().map((c) => c.name)
    );
    const notesCol = repCols.has('notes') ? 'notes' : `'' AS notes`;
    // ONE pass over Repetitions, not one per habit.
    //
    // `WHERE habit = ?` inside the habit loop looks like the cheap shape and is
    // the opposite. Loop's own schema indexes `habit`; an uploaded file need
    // not, and then each execution is a full table scan — so the cost is
    // habits x rows, and the entry budget cannot see it because the budget is
    // spent by rows RETURNED and unmatched rows return nothing. Measured on a
    // 6.4MB file with 2,000 habits and 300,000 rows matching no habit: 13.5
    // seconds, 84MB, and zero entries. At the habit ceiling it is minutes, and
    // `DatabaseSync` is synchronous, so nothing else in the process runs.
    //
    // Read once, ordered by habit, and bucket. That is a single scan whatever
    // the file's indexes, every row read is a row billed, and `ORDER BY habit,
    // timestamp` gives each bucket the same per-habit ordering the old query
    // did.
    const reps = src.prepare(
      `SELECT habit, timestamp, value, ${notesCol}
         FROM Repetitions ORDER BY habit, timestamp LIMIT ?`
    );

    const habits = [];
    // The budget is spent by every row READ, not by every entry kept. A file of
    // nothing but UNKNOWN rows is dropped on the floor a line later and still
    // costs the read, which is the work being bounded.
    let entryBudget = MAX_PARSE_ENTRIES;

    // `.iterate()`, not `.all()` — the ceiling has to apply where the rows are
    // PRODUCED. `.all()` materialises the whole result inside node:sqlite before
    // a single line of this function runs, so anything checked afterwards has
    // already spent the memory it was meant to save, and on a big enough file
    // never gets to run at all. The `LIMIT` is the other half: it is what keeps
    // SQLite's own sorter bounded, since `ORDER BY` over an unindexed column
    // would otherwise sort every row before yielding the first.
    // Habits first, so the bucket for each exists before the single entry pass
    // below and an unmatched row can be dropped by a Map miss rather than by a
    // query that never ran.
    const rows = [];
    for (const r of src.prepare(sql).iterate(MAX_PARSE_HABITS + 1)) {
      if (rows.length >= MAX_PARSE_HABITS) throw tooMuch(`${MAX_PARSE_HABITS} habits`);
      rows.push(r);
    }

    const bucket = new Map(rows.map((r) => [r.id, []]));
    const numerical = new Map(rows.map((r) => [r.id, Number(r.type) === 1]));

    for (const rep of reps.iterate(entryBudget + 1)) {
      // Billed before anything else is asked of the row, which is the whole
      // correction: a row belonging to no habit costs a read like any other and
      // must be charged for it.
      if (entryBudget <= 0) throw tooMuch(`${MAX_PARSE_ENTRIES} entries`);
      entryBudget--;
      const into = bucket.get(rep.habit);
      if (!into) continue;                 // a row for a habit this file does not have
      const date = loopTimestampToISO(rep.timestamp);
      if (!date) continue;
      const converted = convertLoopValue(rep.value, numerical.get(rep.habit));
      if (converted === null) continue;
      into.push({
        date,
        value: converted.value,
        status: converted.status,
        notes: String(rep.notes ?? ''),
      });
    }

    for (const r of rows) {
      const isNumerical = numerical.get(r.id);
      const entries = bucket.get(r.id);

      habits.push({
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
        // Only an ALL-DAYS reminder comes across. `reminder_days` is a 7-bit
        // weekday mask and habiterall has no concept of one, so a Monday-only
        // reminder has no faithful form here: importing the time alone turns it
        // into seven notifications a week, and re-exporting writes that widening
        // back into the user's Loop app. A mask of 0 — a reminder that fires on
        // no day at all — would become a daily one, which is exactly what
        // `loopReminderToTime` refuses to do a line above. Missing is the
        // honest answer until habiterall grows the concept.
        reminder_time: wholeNumber(r.reminder_days) === LOOP_ALL_DAYS
          ? loopReminderToTime(r.reminder_hour, r.reminder_min)
          : '',
        archived: Number(r.archived) ? 1 : 0,
        entries,
      });
    }

    return habits;
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
 * One habit as the CSV pair describes it, with no entries on it yet.
 *
 * Both readers of the pair need this exact shape and neither may guess at it:
 * `parseLoopCheckmarksCSV` builds a habit field by field from the metadata map,
 * so a field missing from THIS list is dropped however well Habits.csv parsed
 * it, and `parseZipExport` fills the same shape for a habit Checkmarks.csv
 * never mentioned. Two copies of the list is one place for the next field to be
 * added and one place for it to be forgotten.
 */
function habitFromCsvMeta(name, meta = {}) {
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
    // habiterall's own dialect column, absent from every real Loop export —
    // the same asymmetry every other field on this list does not have to
    // account for, because Loop's Habits.csv has all of them.
    category: meta.category ?? '',
    entries: [],
  };
}

/**
 * Parse Loop's Checkmarks.csv, whose shape is:
 *   Date,Habit A,Habit B,...
 *   2026-01-01,YES_MANUAL,3,...
 *
 * `habitMeta` optionally supplies type/target info parsed from Habits.csv so
 * numerical columns are interpreted correctly.
 *
 * The habits come from the HEADER, and a file with nothing under it still has
 * one. This used to bail on `rows.length < 2` — one row means no entries, which
 * was read as no habits — so an account that backed itself up before recording
 * anything exported two fully described habits and restored none of them, with
 * the API's "no habits found in the uploaded file" 400 on top. The row count
 * says how many days have been answered; only the header says what exists.
 */
export function parseLoopCheckmarksCSV(text, habitMeta = new Map()) {
  const rows = parseCSV(text);
  if (!rows.length) return [];

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

  // The same ceiling the .db reader has, for the same reason and against a
  // cheaper attack. One habit object per header column, and a header is one
  // line: `Date,a,a,a,…` repeated two million times is 7.6MB of CSV that
  // deflates to under 8KB, so the zip route bought a ~1000:1 amplification the
  // .db could not. Measured before this line existed: that upload aborted a
  // 512MB heap inside the map below, uncatchably, exactly as #79's .db bomb did.
  if (columns.length > MAX_PARSE_HABITS) throw tooMuch(`${MAX_PARSE_HABITS} habits`);

  const habits = columns.map(({ name }) => habitFromCsvMeta(name, habitMeta.get(name)));

  // Entries are bounded too, and as a TOTAL rather than per habit — `unzip.js`
  // records why one attack over: a per-item cap is no defence when the number
  // of items is also the attacker's to choose. Rows x columns is the product
  // that matters here, and neither factor is bounded by the body limit alone.
  let entryBudget = MAX_PARSE_ENTRIES;

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
      if (entryBudget-- <= 0) throw tooMuch(`${MAX_PARSE_ENTRIES} entries`);
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
  // — question as a *fallback* for description. `idx` matches on HEADERS, and
  // Loop's Habits.csv always has a `Description` one, so on a real Loop export
  // the fallback never fired and the prompt was simply DROPPED, exactly as the
  // .db path dropped it.
  //
  // The fallback only fired for a file with a `Question` header and no
  // `Description` header, and there it was arguably right: Loop's migration 23
  // is `update Habits set question = description`, so in a backup from a
  // migrated pre-v2 install the user's prose sits in `question` because Loop
  // moved it there. Reading it as a description was true to what they wrote.
  // Loop reclassified that text as the reminder prompt and shows it in the
  // notification, so following Loop is still the right call — but it is a
  // reassignment of existing prose, not purely a bug fix.
  const cDesc = idx('description');
  const cQuestion = idx('question');
  // Loop 2.x spells these out; `NumRepetitions`/`Interval` is the 1.8.x form,
  // and also what habiterall's own export writes. Accept both, or a
  // 3-times-a-week habit silently comes back as daily.
  const cNum = idx('frequencynumerator', 'frequency numerator', 'numrepetitions');
  const cDen = idx('frequencydenominator', 'frequency denominator', 'interval');
  const cColor = idx('color');
  const cUnit = idx('unit');
  const cTType = idx('target type', 'targettype');
  const cTVal = idx('target value', 'targetvalue');
  const cArch = idx('archived?', 'archived');
  // habiterall's own dialect only — no Loop version ever wrote this column, so
  // it is inert for a real Loop export the way every column here is for a file
  // that lacks it.
  const cCategory = idx('category');

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
      category: cCategory === -1 ? '' : (row[cCategory] ?? '').trim(),
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

  // A bare array is wrapped before `parseHabiterallJSON` sees it, so it is the
  // one form that has to be parsed HERE — and the parse sat in the ARGUMENT to
  // that call, outside the try that exists to turn bad JSON into a 400. So a
  // truncated `[{"name":"a"},` escaped as a 500 with a full stack trace at error
  // level, from an endpoint that needs no account on the personal edition, while
  // the identical truncation after a `{` was correctly reported to the person
  // who could fix the file. The sentence is the same one deliberately: the two
  // brackets must not come to say different things about the same bad upload.
  if (head.startsWith('[')) {
    let habits;
    try {
      habits = JSON.parse(head);
    } catch {
      throw fail('file is not valid JSON');
    }
    return parseHabiterallJSON({ habits });
  }

  if (head.startsWith('{')) return parseHabiterallJSON(text);

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
 *
 * Which is why Habits.csv is a source of habits here and not only a lookup
 * table: it names every habit the archive describes, and a habit it names is
 * one the file HAS whether or not a column for it survived. Reading the
 * checkmarks header rather than its rows already covers the case that motivated
 * this — an account with no entries at all — so this union is what the mixed
 * cases need, and what keeps "no habits found in the uploaded file" an honest
 * thing to say about the pair rather than about one of the two files.
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
  const habits = parseLoopCheckmarksCSV(checkmarksCsv, meta);

  // Checkmarks order first, then Habits.csv order for the rest — both are the
  // order those files were written in, so the same archive always restores the
  // same way round.
  const columns = new Set(habits.map((h) => h.name));
  for (const [name, habitMeta] of meta) {
    if (!columns.has(name)) habits.push(habitFromCsvMeta(name, habitMeta));
  }
  return habits;
}

/**
 * What a file's entry says the day held, read strictly. `null` means it said
 * nothing usable, which the writers report in `skipped`.
 *
 * `Number()` alone cannot be the gate, for the reason `loopTimestampToISO` and
 * `wholeNumber` above both record: the check has to be about the TYPE, because
 * `Number(null)`, `Number('')`, `Number([])` and `Number(false)` are all `0` and
 * `0` is a legitimate value here — a row holding zero is a **stated lapse**, one
 * of the four day-states, and not the absence of an answer. So an entry of
 * `{date, value: null}` was written as a day the user told us they had missed,
 * while `{date}` with no `value` key at all was correctly refused as a bad value:
 * two spellings of "the file said nothing" behaving differently, and the one that
 * got through invents an answer nobody gave.
 *
 * On a merge that was harmless, because a bare lapse yields to whatever the
 * account already holds. On a **replace** it is not: a lapse is a stored entry
 * where there was none, so it extends the habit's history window back to its own
 * date — every unknown day after it then reads as a miss — and it turns
 * `recovery.rate === null`, "nothing has ever been missed", into a real lapse.
 *
 * `null` is therefore read as silence rather than as zero. That is the reading
 * the missing key already got, it is what a serialiser writes for a field it has
 * no value for, and it costs no habiterall backup: `entries.value` is NOT NULL in
 * both editions' schemas, so nothing we export can carry one.
 *
 * A decimal string is still accepted, exactly as `Number()` accepted it — a file
 * is often written by hand or by another application, and a quoted `"8"` is a
 * value that was stated. What goes with it is `Number`'s generosity about the
 * *form*: `'0x10'` and `'1e3'` were read as 16 and 1000, and neither is how
 * anyone writes down a number of glasses of water.
 *
 * @param {unknown} raw
 * @returns {number|null} a finite value, or null if the file did not state one
 */
export function entryValue(raw) {
  const n = typeof raw === 'number' ? raw
    : (typeof raw === 'string' && /^-?\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN);
  return Number.isFinite(n) ? n : null;
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
 * A frequency too wide to store is repaired as a **rate**, not by parking the
 * count at a cap it never agreed to: `500 / 1000` becomes `182 / 365` and not
 * `365 / 365`, which would be a daily habit invented out of a lax one. The
 * count rounds DOWN and the period UP throughout, so a repair never asks more
 * of the user than the file did — that rule is what decides every edge here,
 * including the fractional and the unbounded ones.
 *
 * @param {Record<string, any>} h a habit from any parser
 * @returns {import('./types.js').Habit & {archived: boolean, category: string}}
 */
export function normaliseImportedHabit(h) {
  // The whole of parseHabit's frequency rule — integers with
  // 1 <= num <= den <= freqDenominator — and not two thirds of it. The clamps
  // ran in an order that undid themselves: squaring up raised the denominator
  // to the numerator, the cap then lowered it again, and nothing ever bounded
  // the numerator at all, so `1000 / 1` was stored as `1000 / 365` and `2.5 / 7`
  // put a REAL in an INTEGER column. Cloud has
  // `CHECK (freq_numerator <= freq_denominator)`, so the same file that personal
  // stored as nonsense was a 23514 there — a 500 with the whole import rolled
  // back, which is exactly the divergence this function exists to prevent.
  const cap = LIMITS.freqDenominator;
  // A file gives one of THREE answers here and they are not interchangeable:
  // a usable number; nothing usable (NaN, null, a missing key), which means the
  // file did not say and the default stands; and +Infinity, which means the file
  // DID say — "effectively never" — and is a legal JSON literal, since `1e400`
  // parses to it. Folding that third case into the default inverted it: a habit
  // asking for two repetitions per 1e400 days came out as `2 / 2`, due every
  // single day. That is a far larger invention than the `365 / 365` this
  // function's own comment below was written to prevent.
  const stated = (raw) => {
    const n = Number(raw);
    if (n === Infinity) return cap;      // the widest period there is
    return Number.isFinite(n) && n > 0 ? n : 1;
  };
  // Down for the count, up for the period. The columns are INTEGER and there is
  // no honest fractional reading of either, so where the file cannot be
  // expressed the repair asks no MORE of the user than the file did.
  let num = Math.max(1, Math.floor(stated(h.freq_numerator)));
  let den = Math.ceil(stated(h.freq_denominator));
  if (num > den) den = num;          // Loop permits it; the most a rate can be is daily
  if (den > cap) {
    // The count moves with the period rather than being left behind at a cap it
    // never agreed to. "500 times per 1000 days" clamped to `365 / 365` is not a
    // lax habit stored honestly, it is a daily one invented — the same mistake
    // as reading a Loop reminder mask of 0 as "every day".
    //
    // Take the RATE first and scale it, rather than scaling the count and then
    // dividing. `(num * cap) / den` overflows to Infinity for a numerator above
    // ~4.9e305, and `Math.min` then hands back `cap` — turning a one-in-ten-days
    // habit into a daily one at the exact end of the range the clamp exists to
    // handle. `(num / den) * cap` cannot overflow, because the rate is a ratio
    // of two finite numbers, and it gives the same answer everywhere else.
    num = Math.min(cap, Math.max(1, Math.floor((num / den) * cap)));
    den = cap;
  }

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
    // habiterall's own JSON carries this; no Loop format has anywhere to put
    // it, so a Loop file always yields 'default' — which is the account's
    // answer, and the honest one for a file that said nothing.
    at_most_unlogged: AT_MOST_UNLOGGED.has(h.at_most_unlogged)
      ? h.at_most_unlogged : 'default',
    // habiterall's own JSON carries it; no Loop format has anywhere to put a
    // rendering preference, so a Loop file always yields 'amount' — and losing
    // it costs the display, never the meaning. That asymmetry is why this is a
    // display flag and not the judgement-inverting one #64 also considered.
    show_as: SHOW_AS.has(h.show_as) ? h.show_as : 'amount',
    // habiterall's own JSON carries it; no Loop format has anywhere to put an
    // icon, so a Loop file always yields '' — the same asymmetry as
    // at_most_unlogged and show_as above.
    icon: parseIcon(h.icon),
    // habiterall's own JSON and the CSV pair both carry this by NAME — a habit
    // is matched by the name it is stored under, and a category is looked up
    // by `foldCategoryName` the same way (see `shared/CLAUDE.md`) — and
    // `applyImport` resolves the name to a `category_id` after this function
    // has run, creating the category first if the account has none by that
    // name. Loop's .db has no column and no concept of a category at all, so
    // a Loop `.db` file always yields '', the same asymmetry `at_most_unlogged`,
    // `show_as` and `icon` above already have.
    category: String(h.category ?? '').trim().slice(0, LIMITS.name),
    archived: !!h.archived,
  };
}
