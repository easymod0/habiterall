/**
 * Reading and writing a reminder time, and the weekdays it fires on.
 *
 * DOM-free on purpose, like `ui/calendar.js`: the parsing is the part with
 * edge cases in it, so it is unit-tested under `npm test` rather than only in a
 * browser. The controls that use it are built in `app.js`.
 *
 * `<input type="time">` used to be the whole implementation. It is one of the
 * least consistent controls on the web — a spinner in Chrome, a bare text box
 * in Firefox, the OS wheel on a phone — and in its text-box form it silently
 * refuses anything that is not already 'HH:MM', including '8:30'. So the value
 * is kept as a plain string that this module normalises, and the picker is
 * ordinary selects that work identically everywhere.
 */

/** The stored form: a 24-hour 'HH:MM'. Mirrors TIME_RE in shared/src. */
const CANONICAL_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minute granularity of the dropdown. Any minute can still be typed. */
export const MINUTE_STEP = 5;

/**
 * Times worth one tap.
 *
 * Not a "most popular reminder times" claim — they are the round numbers a
 * person reaches for (before work, midday, evening), and the point is that the
 * common case takes one click instead of two dropdowns.
 */
export const COMMON_TIMES = ['07:00', '08:00', '12:00', '18:00', '21:00'];

/**
 * Parse whatever the user typed into 'HH:MM', or null if it is not a time.
 *
 * Accepts, because people type all of these and a reminder field that rejects
 * them is just a puzzle:
 *
 *   '8'        -> 08:00      a bare hour
 *   '8:3'      -> 08:03      a half-typed minute
 *   '8.30'     '8h30'  '8 30'
 *   '830'      -> 08:30      no separator at all
 *   '2030'     -> 20:30
 *   '8:30 pm'  -> 20:30      and 'PM', 'p.m.', '8pm'
 *   '12 am'    -> 00:00      the two cases that are always wrong by 12
 *   '12 pm'    -> 12:00
 *
 * Returns '' for empty input, which means "no reminder" — distinct from null,
 * which means "that is not a time". The caller needs to tell those apart: one
 * clears the reminder, the other is a mistake to report.
 *
 * @param {unknown} raw
 * @returns {string|null} 'HH:MM', '' for cleared, or null if unparseable
 */
export function parseTimeInput(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return '';

  // Pull the meridiem off first, so the numeric part is all that is left.
  let meridiem = null;
  const suffix = /\s*([ap])\.?\s*m\.?$/.exec(text);
  const body = suffix ? text.slice(0, suffix.index).trim() : text;
  if (suffix) meridiem = suffix[1];

  let hour;
  let minute;

  const separated = /^(\d{1,2})\s*[:.h\s]\s*(\d{1,2})$/.exec(body);
  if (separated) {
    hour = Number(separated[1]);
    minute = Number(separated[2]);
  } else if (/^\d{1,2}$/.test(body)) {
    hour = Number(body);
    minute = 0;
  } else if (/^\d{3,4}$/.test(body)) {
    // '830' and '2030': the last two digits are the minutes.
    hour = Number(body.slice(0, body.length - 2));
    minute = Number(body.slice(-2));
  } else {
    return null;
  }

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute > 59) return null;

  if (meridiem) {
    // 12am is 00:00 and 12pm is 12:00 — the one pair that trips every
    // hand-rolled conversion, because 12 is the hour that does not shift by 12.
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'a') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  }

  if (hour > 23) return null;
  return format(hour, minute);
}

/** Zero-pad an hour and minute into the stored form. */
export function format(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Whether a value is already in the stored form. '' counts: no reminder. */
export function isCanonical(value) {
  return value === '' || CANONICAL_RE.test(String(value ?? ''));
}

/** Split 'HH:MM' into numbers, or null for '' / anything unparseable. */
export function split(value) {
  if (!CANONICAL_RE.test(String(value ?? ''))) return null;
  const [h, m] = String(value).split(':');
  return { hour: Number(h), minute: Number(m) };
}

/**
 * The hour options, 00–23.
 *
 * Labelled with the 12-hour reading alongside — '13  (1 pm)' — because the
 * stored value is 24-hour but plenty of people do not think in it, and a
 * dropdown is the one place there is room to say both.
 */
export function hourOptions() {
  return Array.from({ length: 24 }, (_, hour) => ({
    value: String(hour).padStart(2, '0'),
    label: `${String(hour).padStart(2, '0')}  ${twelveHour(hour)}`,
  }));
}

/** Minute options at MINUTE_STEP, plus `extra` if it falls between them. */
export function minuteOptions(extra = null) {
  const minutes = [];
  for (let m = 0; m < 60; m += MINUTE_STEP) minutes.push(m);
  // A time typed as 08:37 must stay selectable in the dropdown, or opening the
  // habit again would silently round it to 08:35.
  if (Number.isInteger(extra) && extra >= 0 && extra < 60 && !minutes.includes(extra)) {
    minutes.push(extra);
    minutes.sort((a, b) => a - b);
  }
  return minutes.map((m) => ({
    value: String(m).padStart(2, '0'),
    label: String(m).padStart(2, '0'),
  }));
}

/** '1 pm' for 13. Used only as a label. */
function twelveHour(hour) {
  const suffix = hour < 12 ? 'am' : 'pm';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `(${h} ${suffix})`;
}

/**
 * How a time reads back to the user: '08:30 (8:30 am)', or '' for none.
 * Used in hints and confirmations, never stored.
 */
export function describe(value) {
  const parts = split(value);
  if (!parts) return '';
  const suffix = parts.hour < 12 ? 'am' : 'pm';
  const h = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  return `${value} (${h}:${String(parts.minute).padStart(2, '0')} ${suffix})`;
}

/* ---------- which weekdays the reminder fires on ---------- */

/**
 * Every day — the default, and what every habit written before this existed
 * means.
 *
 * `reminder_days` is a 7-bit mask in which **bit N is JavaScript's own
 * `getDay()` N**: bit 0 Sunday, bit 1 Monday, … bit 6 Saturday. That is the
 * numbering the rest of this app already thinks in (`weekdayNames` in
 * `ui/dates.js` is indexed by it; `weekOrder` in `charts.js` translates *from*
 * it), which is the whole reason it is ours.
 *
 * It is deliberately NOT Loop's mask, whose bit 0 is SATURDAY — verified from
 * two places in uhabits' own source, `NotificationTray.shouldShowReminderToday`
 * (`(dayOfWeek.daysSinceSunday + 1) % 7`) and `WeekdayPickerDialog`, which
 * labels the raw bit array with `getWeekdaySequence(SATURDAY)`. Storing Loop's
 * spelling would leak a convention nothing else here uses into the schema, the
 * JSON API, the phone and every fixture. The rotation between the two belongs
 * with the code that reads Loop's bytes.
 *
 * `weekStart` has nothing to do with any of this. That setting says what a WEEK
 * is, for aggregation and for display order; which weekday a DATE falls on is
 * absolute, and the stored bit positions are too.
 */
export const ALL_DAYS = 127;

/**
 * Normalise a stored or submitted mask.
 *
 * Anything that is not already an integer in `[0, ALL_DAYS]` — a string, a
 * float, a negative, `null`, a crafted `'__proto__'` — lands on the default of
 * every day, which is the only value that changes nothing for a habit whose
 * owner has never answered this. `typeof` first rather than `Number(raw)`, for
 * the reason `parseCategoryId` (`shared/src/validate.js`) gives: `Number([])`
 * is 0 and `Number(true)` is 1, so coercing would make several spellings of
 * "not a mask" mean "no day at all".
 *
 * **0 is legal and is never repaired to `ALL_DAYS`.** It means the habit
 * reminds on no day, and a scheduler simply never matches a weekday for it —
 * no special case anywhere. A picker MAY snap an emptied set back to all days
 * (Loop's own `EditHabitActivity` does), but that is an affordance of the
 * control and not a rule of the validator: fold the two together and a mask of
 * 0 becomes a daily reminder, which is exactly the defect #78 refused to ship.
 *
 * @param {unknown} raw
 * @returns {number} 0..127
 */
export function parseReminderDays(raw) {
  return Number.isInteger(raw) && /** @type {number} */ (raw) >= 0 &&
    /** @type {number} */ (raw) <= ALL_DAYS ? /** @type {number} */ (raw) : ALL_DAYS;
}

/**
 * Which weekday a 'YYYY-MM-DD' falls on, as `getDay()` numbers them.
 *
 * Pure arithmetic on the string, in UTC, so no zone is involved: the caller has
 * already decided WHOSE day this is (`clock.date` in the notifier,
 * `todayISO()` in the browser) and re-resolving it here against the server's
 * own clock is how a reminder lands on the wrong weekday for anyone east or
 * west of the container.
 *
 * The date is set with one `setUTCFullYear(y, m, d)` rather than built with
 * `Date.UTC(y, m - 1, d)`, because that constructor maps years 0–99 onto
 * 1900–1999 — `Date.UTC(99, …)` silently means 1999, and an imported row dated
 * year 0099 would be read as a weekday nineteen centuries away. Setting all
 * three fields at once also avoids the wrong-year rollover a two-step fix has
 * (29 February of year 0 does not exist in 1900).
 *
 * @param {unknown} isoDate
 * @returns {number|null} 0 = Sunday … 6 = Saturday, or null if unreadable
 */
export function weekdayOf(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? ''));
  if (!m) return null;
  const at = new Date(0);
  at.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return at.getUTCDay();
}

/**
 * Does this habit remind on this date?
 *
 * An unreadable date has no weekday, so no mask can name it and the answer is
 * false. Both callers hand over a date the clock CONSTRUCTED — never one out of
 * a request or a row — so reaching that branch is a bug elsewhere, and the
 * quiet failure it causes is one habit's reminders rather than a mask meaning
 * the opposite of what it says.
 *
 * @param {unknown} mask
 * @param {unknown} isoDate
 * @returns {boolean}
 */
export function remindsOn(mask, isoDate) {
  const weekday = weekdayOf(isoDate);
  if (weekday === null) return false;
  return ((parseReminderDays(mask) >> weekday) & 1) === 1;
}

/**
 * How a mask reads back to the user: 'Every day', 'No days', or the days
 * themselves — 'Mon, Tue, Wed, Thu, Fri'.
 *
 * `names` is REQUIRED and is indexed by `getDay()`, which is what
 * `weekdayNames()` (`ui/dates.js`) answers, so a caller hands that straight
 * over. It is not defaulted to an English list for two reasons that agree: a
 * weekday NAME is locale-dependent and this module has no imports to reach
 * `Intl` with — the same arrangement `targetLabel` has with `showAmount` — and
 * `dates.test.js`'s source guard refuses a seven-item label array anywhere
 * under `shared/public/` precisely so a hardcoded one cannot come back.
 *
 * Listed in bit order, Sunday first, which is what the bits ARE; a picker that
 * wants the account's own week start rotates its own controls and does not ask
 * this. Used in hints and confirmations, never stored.
 *
 * @param {unknown} mask
 * @param {readonly string[]} names weekday names indexed by `getDay()`
 * @returns {string}
 */
export function describeReminderDays(mask, names) {
  const days = parseReminderDays(mask);
  if (days === ALL_DAYS) return 'Every day';
  if (days === 0) return 'No days';
  return names.filter((_, weekday) => ((days >> weekday) & 1) === 1).join(', ');
}
