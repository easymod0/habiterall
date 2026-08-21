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
  parseChannelList, parseDiscordWebhook, parseNtfyToken, parseNtfyUrl,
  parseSnowflake, parseTimeZone,
} from './notify.js';
// `notify.js` already reaches into `shared/public` for `isAvoided`
// (`notify.js:36`), on the grounds that node can read anything on disk even
// though the browser cannot see `shared/src` — the same grounds this import
// stands on. `validate.js` -> `notify.js` -> `ui/toggle.js` adds no cycle:
// nothing toggle.js imports reaches back here.
import { DAY, valueForState } from '../public/ui/toggle.js';

export const HABIT_TYPES = new Set(['boolean', 'numerical']);
export const TARGET_TYPES = new Set(['at_least', 'at_most']);

/**
 * What a day with NO ROW is worth on THIS habit, overriding the account's
 * `atMostUnlogged`. Read only for an at-most target, where zero is under the
 * limit and silence therefore has two defensible readings — see
 * `unansweredCounts` in stats.js for the whole of it.
 *
 * `'default'` means "whatever the account says", and it is the default because
 * an override has to be asked for: an account that has answered this once
 * should not find one habit quietly disagreeing.
 *
 * Per habit and not only per account, because the two kinds of limit want
 * opposite answers and people keep both. "I didn't smoke today" is worth a tap
 * and is the whole reward; "I had no soda" is not something anyone opens an app
 * for, and the point of tracking it is to record the exception.
 */
export const AT_MOST_UNLOGGED = new Set(['default', 'miss', 'success']);

/**
 * How a habit is SHOWN — as an amount to reach, or as something to avoid.
 *
 * A habit you want to stop is stored as what it is: a measurable habit with an
 * at-most target of 0, which needs no new storage, round-trips through Loop
 * perfectly and is already what `isCompleted` and the score read. What it
 * lacked was an interaction — you answered it by typing a number, a filled
 * cell painted as an achievement, and the wording asked whether you had done
 * the thing you are trying not to do.
 *
 * So this decides the RENDERING and nothing else. That is the whole reason it
 * can exist at all: issue #64's other option was a flag that inverts the
 * JUDGEMENT, and Loop's schema has nowhere to carry one — losing it on a round
 * trip would flip every verdict in the file. Losing this one loses a display
 * preference, and the rows go on meaning exactly what they meant. `YES` still
 * means the thing occurred, `isCompleted` still comes from `target_type` and
 * `target_value`, and the export is untouched.
 *
 * Per habit, because that is the only level it can be: an account holds habits
 * of both kinds at once.
 *
 * `'avoid'` is offered for any at-most target and is only meaningful there —
 * "at least 8 glasses" has nothing to avoid. It is not restricted to a target
 * of 0, because "at most 2 coffees" is also a thing people want to see as a
 * limit rather than as an amount; what the target decides is what a tap
 * RECORDS, not whether the option applies.
 */
export const SHOW_AS = new Set(['amount', 'avoid']);

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
  /**
   * UTF-16 units, not graphemes — a grapheme cluster can be arbitrarily long
   * (a Zalgo stack of combining marks is one grapheme), so this is a length
   * bound on the ONE grapheme `parseIcon` already picked out, not a second
   * segmentation rule. 32 covers a subdivision-flag tag sequence (16 units)
   * and a four-person family with skin tones (19).
   */
  icon: 32,
  /**
   * A user's own categories, per account. Six suggestion chips ship in the
   * picker, but they are not seeded — an account can create at most this many
   * of its own, chip-created or typed. Mark's answer; not derived from
   * anything else here.
   */
  categories: 30,
};

/**
 * Splits on grapheme-cluster boundaries, so a ZWJ family emoji or a
 * skin-toned flag is one segment rather than the several UTF-16 code units it
 * is made of. Module-scoped: constructing one is not free, and every icon in
 * a request goes through the same rule.
 */
const iconSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

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
 * A habit's icon: at most one grapheme, never a second name field.
 *
 * `\p{Cc}` (control characters) and the bidi override block (U+202A–U+202E,
 * U+2066–U+2069) are stripped, but NOT `\p{Cf}` — U+200D ZERO WIDTH JOINER is
 * category `Cf`, and stripping it would destroy every ZWJ emoji sequence,
 * which is the entire reason the grapheme segmenter is used instead of
 * `[...value][0]` or a `.slice`. The bidi override range is named explicitly
 * because a lone U+202E as an icon visually reorders the habit name sitting
 * beside it. U+2028/U+2029 (line/paragraph separator) are named too, even
 * though `.trim()` already removes them at the edges as JS whitespace — an
 * explicit strip means the rule does not depend on that coincidence holding
 * for one in the middle of the string.
 *
 * Any grapheme is accepted, not only `\p{Extended_Pictographic}` — someone
 * will want 運, ✓ or a single letter, and refusing those buys nothing; the
 * length cap is what stops this becoming a second name field.
 *
 * Past `LIMITS.icon` the field is DROPPED to `''`, never sliced: slicing a
 * grapheme cluster is exactly the corruption the segmenter exists to avoid,
 * and this is free text so there is nothing to 400 over — a Loop/JSON import
 * must not fail wholesale on one habit's over-long icon.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function parseIcon(value) {
  const cleaned = String(value ?? '')
    .replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim();
  if (!cleaned) return '';

  const first = iconSegmenter.segment(cleaned)[Symbol.iterator]().next().value;
  const grapheme = first ? first.segment : '';
  return grapheme.length > LIMITS.icon ? '' : grapheme;
}

/**
 * The one rule for whether two category names are the SAME category, so both
 * editions agree. SQLite's `NOCASE` collation folds ASCII only and Postgres's
 * `lower()` is Unicode-aware, so `Élan` and `élan` would be one category in
 * cloud and two in personal if the DB constraint alone decided it — the exact
 * divergence this file exists to prevent. The uniqueness check is therefore a
 * route-level lookup through this function, with the DB constraints kept only
 * as backstops; a duplicate is a 409 from the route, not a 500 from a
 * constraint violation.
 *
 * `toLocaleLowerCase()` (no fixed locale) rather than `toLowerCase()`, for the
 * same Unicode-aware folding Postgres's `lower()` already does.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function foldCategoryName(name) {
  return String(name ?? '').trim().toLocaleLowerCase();
}

/**
 * Validate and normalise a category payload.
 *
 * An EMPTY name throws; an over-long one is capped at `LIMITS.name`. That
 * split is deliberate and it is the one place this disagrees with
 * `parseHabit`, which throws on both: a category is a short label typed into a
 * picker, so trimming a pasted-in essay to 100 characters is what the user
 * meant, while a nameless category is nothing at all. The cap is what the
 * section header can draw; the throw is what has no answer.
 *
 * @param {Record<string, any>} [body]
 * @returns {{name: string, color: string}}
 */
export function parseCategory(body = {}) {
  const name = String(body.name ?? '').trim().slice(0, LIMITS.name);
  if (!name) throw new ValidationError('name is required');

  return {
    name,
    color: COLOR_RE.test(body.color ?? '') ? body.color : DEFAULT_COLOR,
  };
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
    // Only meaningful on an at-most target; stored regardless, so that
    // switching a habit's target type back and forth does not silently discard
    // an answer the user gave. `AT_MOST_UNLOGGED` says why it exists.
    at_most_unlogged: AT_MOST_UNLOGGED.has(body.at_most_unlogged)
      ? body.at_most_unlogged : 'default',
    // Presentation only — see SHOW_AS. Stored regardless of the target type,
    // so switching a habit's goal back and forth does not discard the answer.
    show_as: SHOW_AS.has(body.show_as) ? body.show_as : 'amount',
    // A habit PUT REPLACES, so an omitted icon is a stated clear, not "leave
    // it". See parseIcon for what one grapheme means and why over-long input
    // is dropped rather than sliced.
    icon: parseIcon(body.icon),
    // A habit PUT REPLACES, so an omitted category is a stated clear — the
    // same rule `icon`'s comment states just above. Anything that is not a
    // positive safe integer (a string, a float, 0, a negative id, `true`, a
    // crafted `'__proto__'`) is `null` rather than a 400: whether the id
    // NAMES a category is a question for the route (`resolveCategoryId`),
    // which is where an unknown id becomes a 400. This only decides the
    // SHAPE of what may be stored.
    category_id: Number.isSafeInteger(body.category_id) && body.category_id > 0
      ? body.category_id : null,
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
 * The `parseEntry` body an answered reminder means.
 *
 * A press carries `yes` / `no` / `skip` / `amount`, and both editions' button
 * handlers used to turn those into `{value}` inline, with a fixed BOOLEAN
 * encoding — `yes` -> YES, `no` -> UNSET. That is wrong for an avoided habit
 * (`isAvoided`, `ui/toggle.js`), whose `yes` (labelled "Clean") means the
 * SMALLEST value and whose `no` ("Slipped") means `target + 1`: the inline
 * ternary stored the opposite of what the reply text claimed, silently,
 * because a stored value and a label are two different things and nothing
 * compared them. `valueForState` already has the right encoding for every
 * habit shape and is already unit-tested — this is the one place both
 * editions ask it, so the rule is asked once rather than copied twice with
 * one exception (the avoided case) that only one copy remembered.
 *
 * `skip` returns before `valueForState` is reached on purpose:
 * `valueForState` throws for `DAY.SKIP`, because a skip is the status column
 * and never a value — see the throw's own comment.
 *
 * @param {import('./types.js').Habit} habit
 * @param {{action: 'yes'|'no'|'skip'|'amount', value?: unknown}} answer
 * @returns {{status: 'skip'} | {value: number|unknown}}
 */
export function answerBody(habit, { action, value }) {
  if (action === 'skip') return { status: 'skip' };
  if (action === 'yes') return { value: valueForState(habit, DAY.DONE) };
  if (action === 'no') return { value: valueForState(habit, DAY.NO) };
  return { value };                       // 'amount' — the number is the answer
}

/**
 * The cards the detail view can be asked to draw, in the order it draws them.
 *
 * IDS, not titles. A card carries no id of its own — `card()` in
 * `ui/components.js` sets a class and nothing else, and the detail view
 * deliberately owns none — so these exist purely as setting values, and
 * `ui/detail.js` gates the *append* rather than hiding a node. Keying on the
 * title instead is the version that looks like it works: those are English
 * prose, and #144 is about to make them translatable.
 *
 * Declared here and again as the `multi` options in `ui/settings.js`, for the
 * reason `CHANNELS` and `SETTING_VALUES` are: `shared/src` is not served to the
 * browser. `test/settings.test.js` fails if the two lists drift.
 */
export const DETAIL_CARDS = Object.freeze([
  'recentDays', 'strength', 'calendar', 'streaks', 'resilience', 'awards',
  'history', 'weekdays', 'weekdayMonths', 'frequency',
]);

/**
 * Which detail cards to draw AND in what order, normalised.
 *
 * The stored shape is `{id, on}[]` — every id in `DETAIL_CARDS` exactly once —
 * rather than membership alone, because hiding a card and reordering it are two
 * different decisions and a bare list of ids can only ever record one of them.
 * Two input shapes are read, and which one a given `raw` is decides everything:
 *
 *   - LEGACY (every element a string, or the array is EMPTY): membership meant
 *     visible, and the list carries NO order of its own to honour. Master's own
 *     `parseCardList` was `DETAIL_CARDS.filter((id) => raw.includes(id))`, so
 *     every legacy value that can be in storage is already a canonical-order
 *     subset — reading the order the caller happened to list ids in would
 *     silently rearrange the page the first time a card was re-ticked. Read for
 *     membership alone: all nine ids in `DETAIL_CARDS` order, `on` set by
 *     whether the id was mentioned. `[]` takes this branch on purpose —
 *     unticking everything must still mean nothing visible, and reading it as
 *     the new shape (nothing mentioned, so nothing to hide) would invert that
 *     to everything shown.
 *   - NEW SHAPE (every element an object with a string `id`): the array already
 *     carries both the order and the visibility, so it is kept close to
 *     verbatim — deduped by id first-wins, unknown ids dropped, `on` coerced to
 *     a boolean — and only an id the caller left out entirely is inserted,
 *     `on: true`, immediately after the nearest `DETAIL_CARDS` predecessor that
 *     is present. That is the case for a card that shipped after this account
 *     last saved the setting: it arrives visible, at its canonical position,
 *     rather than needing a migration to appear at all.
 *
 * A mix of the two element shapes returns `undefined` — no legitimate client
 * produces one, and guessing which rule applies is exactly the ambiguity the
 * object shape exists to avoid. Ids are matched with `DETAIL_CARDS.includes`,
 * never an object lookup, so `__proto__` is just another unknown id.
 *
 * @param {unknown} raw
 * @returns {{id: string, on: boolean}[]|undefined}
 */
export function parseCardList(raw) {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length > DETAIL_CARDS.length * 4) return undefined;   // obvious junk

  const isCardObject = (el) => el !== null && typeof el === 'object' &&
    typeof el.id === 'string';

  if (raw.length === 0 || raw.every((el) => typeof el === 'string')) {
    // A legacy value carries no order — see the JSDoc above — so this is
    // membership alone, in DETAIL_CARDS order. `raw.includes` rather than a
    // Set: the array is at most DETAIL_CARDS.length * 4 by the junk cap above,
    // small enough that a second membership test costs nothing, and it means
    // a repeated or unknown id in `raw` needs no separate handling — it simply
    // matches nothing extra.
    return DETAIL_CARDS.map((id) => ({ id, on: raw.includes(id) }));
  }

  if (raw.every(isCardObject)) {
    const seen = new Set();
    const kept = [];
    for (const el of raw) {
      if (DETAIL_CARDS.includes(el.id) && !seen.has(el.id)) {
        seen.add(el.id);
        kept.push({ id: el.id, on: !!el.on });
      }
    }
    // Every id DETAIL_CARDS names and this list omits is inserted right after
    // its canonical predecessor. Walking DETAIL_CARDS in its own order means
    // that predecessor — if it was ALSO missing — has already been inserted
    // by the time it is looked up here, so a run of several consecutive
    // missing ids still lands as a run, in the right place, with one lookup
    // each rather than a search back through DETAIL_CARDS.
    for (const id of DETAIL_CARDS) {
      if (seen.has(id)) continue;
      const predecessorIndex = DETAIL_CARDS.indexOf(id) - 1;
      let insertAt = 0;
      if (predecessorIndex >= 0) {
        const foundAt = kept.findIndex((c) => c.id === DETAIL_CARDS[predecessorIndex]);
        if (foundAt !== -1) insertAt = foundAt + 1;
      }
      kept.splice(insertAt, 0, { id, on: true });
      seen.add(id);
    }
    return kept;
  }

  // Mixed strings and objects (or something that is neither) — refused rather
  // than guessed at.
  return undefined;
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
  // `system` follows the OS, and is the default. It has to be a real value
  // rather than the absence of one: once the toggle had been pressed there was
  // no way back to following the system, so a machine that goes dark at sunset
  // stopped doing so with no control that said why.
  theme: ['system', 'light', 'dark'],
  dayOrder: ['newest-right', 'newest-left'],
  weekStart: ['monday', 'sunday'],
  confirmDelete: [true, false],
  // Whether the dashboard draws one section per category (plus a trailing
  // Uncategorised one) instead of a flat list. Off by default: a fresh
  // account has no categories, and a grouped list with one section — the
  // trailing Uncategorised one, holding everything — is strictly worse than
  // the flat list it would replace.
  groupByCategory: [true, false],
  // How many day columns the dashboard grid shows. A CAP and not an absolute —
  // `gridColumns` in ui/window.js takes the smaller of this and what the
  // viewport fits, because the per-width ladder is the fix for a real layout
  // bug and not a style choice. Strings, as every other enumerated setting is.
  // Nothing above 14, which is the widest the grid has ever drawn: the app's
  // container is capped at 1100px, so a wider monitor buys no room, and an
  // option that always clamped to a number the user did not pick would be an
  // option in name only.
  gridDays: ['auto', '5', '7', '10', '14'],
  // Which cards the detail view draws. See DETAIL_CARDS above for why these are
  // invented ids rather than the titles on screen.
  detailCards: parseCardList,
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
  // Which character a decimal point is, WHERE AN AMOUNT IS TYPED. `auto`
  // resolves against the device at parse time and is a stored value rather than
  // the absence of one, exactly as `theme: 'system'` is: a device fact must not
  // become a stored decision, and the de-DE reader on an en-US work laptop
  // needs something to change. The rule is `resolveNumberFormat` in
  // public/ui/amount.js and this list is only what may be stored. It is not a
  // display preference — it decides whether `10.000` is ten or a refused
  // thousands group — which is why it is portable.
  numberFormat: ['auto', 'point', 'comma'],

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
  // `auto` — follow whichever device last used the account — is the DEFAULT,
  // and `parseTimeZone` accepts it alongside an IANA name and `''` (the
  // server's own clock, chosen deliberately). `resolveTimeZone` in notify.js
  // is what turns the three into one answer; this only decides what may be
  // stored.
  notifyTimezone: parseTimeZone,
  // The topic this instance publishes to. A normaliser and not a list for the
  // reason a webhook URL is one — but the rule it enforces is not this file's
  // and not even this repository's: `parseNtfyUrl` asks the OPERATOR, through
  // `NTFY_ALLOWED_HOSTS`, which hosts the server may be aimed at. So the same
  // value is accepted on one instance and refused on another, deliberately:
  // whose network a server fetches from is not a question the person typing the
  // URL gets to answer, and on the cloud edition they are not the operator.
  ntfyTopicUrl: parseNtfyUrl,
  // Optional: what a protected topic needs. Bounded and header-safe, because it
  // is interpolated into an `Authorization` header on a request this server
  // makes.
  ntfyToken: parseNtfyToken,
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
  'theme',
  'dayOrder',
  'weekStart',
  'confirmDelete',
  'calendarZoom',
  // A display preference carrying no capability, like `theme` — it decides
  // whether the dashboard is drawn in sections or as a flat list, not what any
  // row MEANS. A category referenced by `category_id` on a habit already
  // travels with that habit; this only says how the same data is arranged on
  // screen after the restore.
  'groupByCategory',
  // Both are display preferences carrying no capability, so they travel for the
  // reason `theme` and `calendarZoom` do. Neither changes what a row MEANS —
  // restoring them moves no figure, only how much of the page you are shown.
  'gridDays',
  'detailCards',
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
  // Portable for that reason one step further out: it decides what the NEXT row
  // will be. `10.000` is ten under one convention and a refused group under the
  // other, so restoring a backup onto an account without it hands the same
  // keystrokes a different number. It carries no capability — it is a
  // preference, like `theme` — so nothing about it belongs with the webhook.
  'numberFormat',
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
  // A topic URL is a bearer capability exactly as a webhook is: anyone holding
  // it can publish into that topic, and on a public ntfy anyone holding it can
  // SUBSCRIBE — so a backup carrying one hands over every future reminder, habit
  // names and prompts included. The token is a credential outright.
  'ntfyTopicUrl',
  'ntfyToken',
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
