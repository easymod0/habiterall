/**
 * Validation and normalisation of user input, shared by both editions.
 *
 * These rules previously lived twice — once per edition — and had already
 * drifted: the cloud copy capped name/description/unit lengths and the
 * frequency denominator, the personal copy did not. Divergence in validation
 * is the worst kind, because it means data accepted by one edition can be
 * rejected (or silently truncated) by the other on import.
 *
 * Storage differences stay at the call site: SQLite has no boolean type, so
 * the personal edition maps `archived` to 0/1 itself.
 */

import { TIME_RE } from './constants.js';
import {
  parseChannelList, parseDiscordWebhook, parseSnowflake, parseTimeZone,
} from './notify.js';

export const HABIT_TYPES = new Set(['boolean', 'numerical']);
export const TARGET_TYPES = new Set(['at_least', 'at_most']);

export const LIMITS = {
  name: 100,
  description: 500,
  unit: 20,
  notes: 500,
  /**
   * The prompt a reminder asks. Capped below Discord's 256-character embed
   * title so it is never truncated on the way out, and short enough to fit an
   * Android notification's one line.
   */
  reminderMessage: 200,
  /** A frequency period longer than a year is not a habit. */
  freqDenominator: 365,
};

export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DEFAULT_COLOR = '#3b82f6';

/**
 * 24-hour local wall time, e.g. '08:30'. Empty means "no reminder".
 * Defined in constants.js so notify.js can share it without importing this
 * file, which imports notify.js — re-exported here because this is where
 * every caller expects to find it.
 */
export { TIME_RE };

/**
 * A validation failure carrying the HTTP status the API should return, so
 * callers can rethrow it directly without re-wrapping.
 */
export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

/**
 * Validate and normalise a habit payload.
 *
 * Returns a plain object with every field present and coerced. Throws
 * ValidationError for input that cannot be repaired; silently clamps input
 * that can (over-long text, unknown enum values).
 *
 * @param {Record<string, any>} [body]
 * @returns {import('./types.js').Habit}
 */
export function parseHabit(body = {}) {
  const name = String(body.name ?? '').trim();
  if (!name) throw new ValidationError('name is required');
  if (name.length > LIMITS.name) {
    throw new ValidationError(`name must be ${LIMITS.name} characters or fewer`);
  }

  const num = Number(body.freq_numerator ?? 1);
  const den = Number(body.freq_denominator ?? 1);
  if (!Number.isInteger(num) || !Number.isInteger(den) ||
      num < 1 || den < 1 || num > den || den > LIMITS.freqDenominator) {
    throw new ValidationError(
      `frequency must be integers with 1 <= numerator <= denominator <= ${LIMITS.freqDenominator}`
    );
  }

  const target = Number(body.target_value ?? 0);
  if (!Number.isFinite(target) || target < 0) {
    throw new ValidationError('target_value must be a non-negative number');
  }

  return {
    name,
    description: String(body.description ?? '').trim().slice(0, LIMITS.description),
    type: HABIT_TYPES.has(body.type) ? body.type : 'boolean',
    unit: String(body.unit ?? '').trim().slice(0, LIMITS.unit),
    target_value: target,
    target_type: TARGET_TYPES.has(body.target_type) ? body.target_type : 'at_least',
    freq_numerator: num,
    freq_denominator: den,
    color: COLOR_RE.test(body.color ?? '') ? body.color : DEFAULT_COLOR,
    // Local wall time the native app schedules a reminder for. Stored on the
    // habit so it follows the account to a new device, and so the web UI can
    // set it too. '' means no reminder.
    reminder_time: TIME_RE.test(body.reminder_time ?? '') ? body.reminder_time : '',
    // What the reminder asks — 'Did you exercise today?' rather than the habit
    // name. Newlines are flattened: this is a one-line prompt in a
    // notification, and the Android reminder cache is line-delimited, so a
    // newline here would corrupt the record it is stored in.
    reminder_message: String(body.reminder_message ?? '')
      .replace(/[\r\n]+/g, ' ').trim().slice(0, LIMITS.reminderMessage),
    archived: !!body.archived,
  };
}

/**
 * Validate an entry write.
 *
 * `habit` supplies the type, because a boolean habit accepts only the
 * sentinel values while a numerical one accepts any non-negative amount.
 * Returns `{ value, status, notes }`; a skip always carries value 0, since
 * skips are stored out of band and must never alias a real amount.
 *
 * @param {import('./types.js').Habit} habit
 * @param {{value?: unknown, status?: string, notes?: unknown}} body
 * @param {{UNSET: number, YES: number, SKIP: number}} sentinels from constants.js
 * @returns {{value: number, status: import('./types.js').EntryStatus, notes: string}}
 */
export function parseEntry(habit, body = {}, { UNSET, YES, SKIP }) {
  const notes = String(body.notes ?? '').slice(0, LIMITS.notes);

  // A skip may be requested explicitly, or (for boolean habits only) by the
  // legacy SKIP wire value. On a numerical habit 3 is a real amount.
  const wantsSkip = body.status === 'skip' ||
    (habit.type === 'boolean' && Number(body.value) === SKIP);

  if (wantsSkip) return { value: 0, status: 'skip', notes };

  const value = Number(body.value);
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError('value must be a non-negative number');
  }
  if (habit.type === 'boolean' && ![UNSET, YES].includes(value)) {
    throw new ValidationError(`boolean habits accept ${UNSET}, ${YES} or ${SKIP}`);
  }

  return { value, status: '', notes };
}

/**
 * What writing an entry actually does to storage.
 *
 * Both editions' PUT routes had this rule inline, and now a Discord button can
 * record an entry too — three copies of a rule with two exceptions in it is
 * how "not done" quietly starts meaning different things in different places.
 *
 * The rule:
 *   - a skip is stored as a row with `status = 'skip'` and value 0, never as a
 *     magic value, because a numerical habit may legitimately record 3;
 *   - anything else WRITES A ROW, including `value = 0`. A row is an answer,
 *     and 0 is the answer "no".
 *
 * That second clause used to read "not done on a yes/no habit is the absence of
 * a row, so clearing a checkmark deletes it — unless a note is attached, which
 * needs a row to live on". The note exception is what gave it away: the row was
 * already the difference between a day the user answered and a day nothing is
 * known about, but only a note could bring one into being. Nothing could then
 * offer Loop's "show question marks for missing data", because the two states it
 * differentiates were one state here — and a Loop backup's explicit `NO` rows
 * had to be discarded on import for the same reason. `DELETE` is how a day goes
 * back to unknown now, which is the verb it always was.
 *
 * The cost, paid once and knowingly: `PUT {value: 0}` used to mean "clear this
 * day" to every client, and now means "record a lapse". Anything old still
 * sending it writes a row where it meant to write nothing — invisible while
 * question marks are off, since a lapse and an unknown day paint identically,
 * and never wrong in what it claims: the user did answer no.
 *
 * @param {import('./types.js').Habit} habit
 * @param {{value: number, status: string, notes: string}} parsed from parseEntry
 * @param {{UNSET: number, SKIP: number}} sentinels
 * @returns {{op: 'upsert'|'delete', value: number, status: string, notes: string,
 *            reply: {value: number, status?: string, notes: string}}}
 *   `reply` is what the API echoes back: it reports a skip with the SKIP wire
 *   value even though 0 is what gets stored. `op` keeps its union — the callers
 *   switch on it — but nothing returns 'delete' any more; clearing a day is the
 *   DELETE route's own business.
 */
export function entryWrite(habit, parsed, { UNSET, SKIP }) {
  const { value, status, notes } = parsed;

  if (status === 'skip') {
    return {
      op: 'upsert', value: 0, status: 'skip', notes,
      reply: { value: SKIP, status: 'skip', notes },
    };
  }

  return { op: 'upsert', value, status: '', notes, reply: { value, notes } };
}

/**
 * The settable preferences and what each accepts.
 *
 * Duplicated deliberately from the browser's ui/settings.js registry: the
 * server must never trust the client's idea of what is valid, and this file
 * cannot import browser code. The two lists are kept honest by
 * test/settings.test.js, which fails if they drift.
 *
 * A rule is either:
 *
 *   - an ARRAY of the permitted values, for anything enumerable; or
 *   - a NORMALISER `(value) => stored | undefined`, for anything that is not
 *     — a URL, a time zone name, a list of channels. It returns the value to
 *     store (which need not be the value sent: a webhook URL is canonicalised
 *     and a channel list is deduped and ordered) or `undefined` to reject.
 *
 * The second form exists because notification settings are not a menu. Do not
 * be tempted to widen the array form to "any string" instead — the whole
 * value of this table is that `parseSettings` is the only thing that has to be
 * trusted, and a normaliser keeps it that way.
 */
export const SETTING_VALUES = {
  dayOrder: ['newest-right', 'newest-left'],
  weekStart: ['monday', 'sunday'],
  confirmDelete: [true, false],
  // Calendar zoom: the *name* of a level, not a cell size in pixels. Storing
  // the level keeps the rendering free to retune the sizes later without
  // stranding a saved number that no longer means anything.
  calendarZoom: ['closest', 'close', 'default', 'wide'],
  // Which bucket the history chart opens on. Must stay in step with
  // BUCKETERS in stats.js — a value the aggregator does not know silently
  // falls back to 'day', so the setting would appear to do nothing.
  historyGranularity: ['day', 'week', 'month', 'quarter', 'year'],
  historyMode: ['percent', 'count'],

  /* --- what a tap can record: Loop's two, with Loop's defaults --- */

  // `pref_skip_enabled`. Whether the tap cycle offers "not applicable today".
  // Off by default, as in Loop: three states are what most people want, and a
  // skip that keeps a streak alive is a thing to opt into knowingly. Turning it
  // off hides the control and takes the step out of the cycle; it never touches
  // a skip already recorded, so an imported Loop history still reads correctly.
  skipDays: [true, false],
  // `pref_unknown_enabled`. Whether a day with no row is drawn as `?` rather
  // than as a plain miss — which is only meaningful because a lapse is now a
  // row of its own; see `entryWrite` above.
  questionMarks: [true, false],
  // What a day with NO ROW is worth on a habit with an at-most target, which is
  // the one kind where the question has two defensible answers: zero is under
  // the limit, so silence reads as success. `'miss'` by default and the rule
  // itself is `unansweredCounts` in stats.js — this list is only what may be
  // stored. Not Loop's: Loop has no such preference, and no Loop file can set
  // one (its backup carries no preferences at all), so this travels in
  // habiterall's own JSON backup and nowhere else.
  atMostUnlogged: ['miss', 'success'],
  // Resolution of the strength chart. Display only — the score is always
  // computed daily, since it is an EWMA and skipping days would change the
  // value rather than the resolution.
  scoreGranularity: ['day', 'week', 'month', 'quarter', 'year'],

  /* --- notifications: see notify.js for what each of these means --- */

  // Which destinations reminders go to. A list, because they are not
  // mutually exclusive: the phone alarm and a Discord ping are useful at once.
  notifyChannels: parseChannelList,
  // Host-restricted on purpose — the SERVER fetches this URL.
  discordWebhook: parseDiscordWebhook,
  // Bot mode: the channel to post in. Only useful when the instance has a
  // DISCORD_BOT_TOKEN — which is an operator credential and deliberately NOT a
  // setting, since these are handed to the browser by GET /api/settings.
  discordChannelId: parseSnowflake,
  // Optional: lock the buttons to one Discord account. Without it, anyone who
  // can see the channel can answer the reminders in it.
  discordUserId: parseSnowflake,
  // Which zone a habit's 'HH:MM' reminder means. '' = the server's own zone,
  // which is right for a self-hosted single user and wrong for anyone whose
  // cloud account lives on a box in another country.
  notifyTimezone: parseTimeZone,
};

/**
 * The settings a BACKUP may carry, in and out.
 *
 * An allowlist rather than "everything except the notification keys", so a
 * setting added later travels only once someone has decided it should — the
 * safe default being that it does not. `test/settings.test.js` fails on a key
 * that is in neither list, which is what forces the decision to be made.
 *
 * The notification keys are deliberately absent, and it is not a hedge. A
 * backup file is a document people email to themselves, sync to a cloud drive
 * and attach to bug reports, while `discordWebhook` is a bearer capability:
 * whoever holds the URL can post into that channel. Exporting it puts it in
 * every copy of the file, and importing it means a "starter habits" JSON someone
 * shares can silently repoint the victim's reminders at a channel the ATTACKER
 * reads — habit names and reminder prompts included. That is the same reasoning
 * that keeps DISCORD_BOT_TOKEN out of the settings table altogether, one step
 * further out.
 *
 * What is left is what a restore actually needs: how the app is displayed, and —
 * the reason any of this exists — what the rows in the same file MEAN.
 */
export const PORTABLE_SETTINGS = Object.freeze([
  'dayOrder',
  'weekStart',
  'confirmDelete',
  'calendarZoom',
  'historyGranularity',
  'historyMode',
  'scoreGranularity',
  'skipDays',
  'questionMarks',
  // Portable for the reason the two above are, and more so: it does not change
  // how a row is drawn, it changes what the DAYS WITH NO ROW in the same file
  // count as. Restore the entries without it and the streaks and the strength
  // come back different from the ones that were exported.
  'atMostUnlogged',
]);

/**
 * Keys deliberately kept out of a backup. Declared rather than implied, so the
 * test can tell "excluded on purpose" from "nobody has looked at it yet".
 */
export const UNPORTABLE_SETTINGS = Object.freeze([
  'notifyChannels',
  'discordWebhook',
  'discordChannelId',
  'discordUserId',
  'notifyTimezone',
]);

/**
 * Keep only what a backup may carry.
 *
 * Used on the way OUT by both editions' `/export` and on the way IN by both
 * `/import` routes — one function, because an asymmetry between them is either a
 * leak or a setting that cannot be restored.
 *
 * @param {Record<string, any>} [settings]
 * @returns {Record<string, any>}
 */
export function portableSettings(settings = {}) {
  const out = {};
  for (const key of PORTABLE_SETTINGS) {
    if (Object.hasOwn(settings, key)) out[key] = settings[key];
  }
  return out;
}

/**
 * Validate a settings patch, dropping anything unknown or out of range.
 *
 * Returns only the accepted keys, so a caller can merge the result without
 * re-checking. Unknown keys are ignored rather than rejected, so an older
 * server tolerates a newer client.
 *
 * @param {Record<string, any>} patch
 * @returns {{accepted: Record<string, any>, rejected: string[]}}
 */
export function parseSettings(patch = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError('settings must be an object');
  }

  const accepted = {};
  const rejected = [];

  for (const [key, value] of Object.entries(patch)) {
    // Own-property check, not a plain lookup: SETTING_VALUES['__proto__']
    // resolves to Object.prototype, which is truthy and has no .includes —
    // so a `__proto__` key in the payload would throw and 500 the request.
    if (!Object.hasOwn(SETTING_VALUES, key)) { rejected.push(key); continue; }

    const rule = SETTING_VALUES[key];

    if (typeof rule === 'function') {
      // A normaliser returns what to store, so the accepted value may differ
      // from what arrived — deliberately, since this is where a webhook URL
      // loses its query string and a channel list is put in order.
      const normalised = rule(value);
      if (normalised === undefined) { rejected.push(key); continue; }
      accepted[key] = normalised;
      continue;
    }

    if (!rule.includes(value)) { rejected.push(key); continue; }
    accepted[key] = value;
  }
  return { accepted, rejected };
}

/** Reject anything that is not a 'YYYY-MM-DD' calendar date. */
export function assertDate(date) {
  if (!DATE_RE.test(date ?? '')) {
    throw new ValidationError('date must be YYYY-MM-DD');
  }

  // The shape being right does not make the date real. `2026-02-30` and
  // `2026-13-45` both match the pattern, and the two editions then failed
  // differently: Postgres rejected them with a 22008 that surfaced as an
  // unhandled 500, while SQLite stored the string verbatim — an entry filed
  // under a day that does not exist, invisible to every range query.
  //
  // Round-tripping through Date is what catches it: JS rolls invalid
  // components over (13-45 becomes the following February), so a mismatch
  // means the input was not a real calendar date.
  const [y, m, d] = date.split('-').map(Number);
  const probe = new Date(y, m - 1, d);
  if (
    probe.getFullYear() !== y ||
    probe.getMonth() !== m - 1 ||
    probe.getDate() !== d
  ) {
    throw new ValidationError(`${date} is not a real calendar date`);
  }

  return date;
}

/** Reject a date in the future, using the caller's notion of today. */
export function assertNotFuture(date, today) {
  if (date > today) {
    throw new ValidationError('cannot record entries in the future');
  }
  return date;
}
