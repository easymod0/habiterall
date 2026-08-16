/**
 * Date helpers for the browser.
 *
 * All dates are local calendar dates as 'YYYY-MM-DD' strings, matching the
 * server. Never build them from toISOString(), which is UTC and shifts the
 * date for anyone west of Greenwich.
 */

export const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * `n` consecutive dates ending on `endDate` (default: today), oldest first.
 * @param {number} n
 * @param {string} [endDate] 'YYYY-MM-DD'
 * @returns {Date[]}
 */
export function datesEndingOn(n, endDate) {
  const end = endDate ? fromISOLocal(endDate) : new Date();
  end.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const c = new Date(end);
    c.setDate(c.getDate() - i);
    out.push(c);
  }
  return out;
}

/** Parse 'YYYY-MM-DD' as a LOCAL date; new Date(str) would treat it as UTC. */
export function fromISOLocal(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function lastNDates(n) {
  const out = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const c = new Date(d);
    c.setDate(c.getDate() - i);
    out.push(c);
  }
  return out;
}

export function freqLabel(h) {
  const { freq_numerator: n, freq_denominator: d } = h;
  if (n === d) return 'Every day';
  if (d === 7) return `${n}× per week`;
  if (d === 30 || d === 31) return `${n}× per month`;
  if (n === 1) return `Every ${d} days`;
  return `${n}× per ${d} days`;
}

export function targetLabel(h) {
  if (h.type !== 'numerical') return '';
  const dir = h.target_type === 'at_most' ? '≤' : '≥';
  return `${dir} ${h.target_value}${h.unit ? ' ' + h.unit : ''}`;
}

/** Today, as a local 'YYYY-MM-DD'. */
export const todayISO = () => iso(new Date());

/** Shift a 'YYYY-MM-DD' by n days, staying in local time. */
export function addDaysISO(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + n);
  return iso(date);
}

/* ---------- how a date is SHOWN ---------- */

/*
 * Storage stays 'YYYY-MM-DD' everywhere — `iso` and `fromISOLocal` above must
 * never grow a format argument. What follows is presentation only.
 *
 * There were three answers to "how do we write a date" and two of them were
 * English whatever the browser was set to: `dashboard.js` and `charts.js` each
 * had their own hardcoded `['S','M','T',…]` and `['Jan','Feb',…]`, the
 * calendar's range label was raw ISO, and the amount dialog used the browser's
 * own locale — with a comment arguing for it, because "the ISO string reads as
 * a serial number, and the whole risk of an editable history is fixing the
 * wrong one". That argument is right, and it is the one everything here
 * follows.
 *
 * Formatters are built once. `Intl.DateTimeFormat` is not cheap, and the grid
 * header asks for a weekday per column on every paint.
 */

const fmt = (opts) => {
  let made = null;
  return () => (made ??= new Intl.DateTimeFormat(undefined, opts));
};

const narrowWeekday = fmt({ weekday: 'narrow' });
const shortWeekday = fmt({ weekday: 'short' });
const longWeekday = fmt({ weekday: 'long' });
const shortMonth = fmt({ month: 'short' });
const longDate = fmt({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const monthAndYear = fmt({ year: 'numeric', month: 'short' });
const mediumDate = fmt({ year: 'numeric', month: 'short', day: 'numeric' });

/** A reference week, so the seven labels can be asked for by `getDay()`. */
const WEEK_SAMPLE = [4, 5, 6, 7, 8, 9, 10].map((d) => new Date(2026, 0, d));
const MONTH_SAMPLE = Array.from({ length: 12 }, (_, m) => new Date(2026, m, 15));

/** @type {Record<string, readonly string[]>} */
const weekdayCache = {};
let monthCache = null;

/**
 * Weekday names in one of `Intl`'s three widths, indexed by `getDay()`.
 *
 * `narrow` is one character in every locale checked (en, de, fr, ru, pl, fi,
 * ja, id), which is what makes it safe for a seven-column header; `short` and
 * `long` are not bounded and their callers have room.
 *
 * There is no two-letter width, which is what `charts.js` used to hardcode for
 * the month grid's rows. Those read `narrow` now — the same letters the
 * calendar heatmap beside them already uses, so the two agree where before one
 * said `Su` and the other `S`.
 *
 * @param {'narrow'|'short'|'long'} [style]
 * @returns {readonly string[]}
 */
export function weekdayNames(style = 'short') {
  if (weekdayCache[style]) return weekdayCache[style];
  const f = style === 'long' ? longWeekday : style === 'narrow' ? narrowWeekday : shortWeekday;
  weekdayCache[style] = Object.freeze(WEEK_SAMPLE.map((d) => f().format(d)));
  return weekdayCache[style];
}

/**
 * One letter per weekday, indexed by `getDay()` — Sunday first, as JavaScript
 * numbers them. Both grids read through `weekOrder` to reach the account's
 * week start; this is only the text.
 */
export function weekdayLetters() {
  return weekdayNames('narrow');
}

/** Short month names, indexed by `getMonth()`. */
/** @returns {readonly string[]} */
export function monthLabels() {
  // Frozen, like the weekday lists: these are handed out by reference and held
  // for the life of the page, so one caller reversing in place would corrupt
  // every chart in the session. `defaults()` in ui/settings.js copies its
  // arrays for the same reason.
  return (monthCache ??= Object.freeze(MONTH_SAMPLE.map((d) => shortMonth().format(d))));
}

/**
 * A date written out in full, for a dialog that is about to change it.
 *
 * The wordiest of the three deliberately: the day editor and the amount dialog
 * are where picking the wrong row is the risk worth spending words on.
 *
 * Both of them still build this formatter inline, per open, with byte-identical
 * options (`ui/day-dialog.js` and `ui/dashboard.js`) — so this is the shape they
 * should adopt rather than a description of what they do. Converting them is a
 * two-line follow-up and it is the per-call cost the memo above argues against;
 * it is out of this change only because nothing else here touches those files.
 * @param {Date} d
 */
export const formatDateLong = (d) => longDate().format(d);

/**
 * A date for a label beside a chart — short, and not a serial number.
 *
 * This is what replaced the raw ISO on the calendar's range label and the
 * strength chart's axis. Not the only ISO left in the app, which an earlier
 * version of this said: `windowedChart`'s own range readout still shows one,
 * and `ui/detail.js` records why that is a separate change.
 * @param {Date} d
 */
export const formatDateShort = (d) => mediumDate().format(d);

/**
 * A bucket key, written for a human.
 *
 * `windowedChart`'s range readout is handed whatever its chart buckets by, and
 * `BUCKETERS` in stats.js produces four shapes: `YYYY-MM-DD` for a day or a
 * week, `YYYY-MM` for a month, `YYYY-Qn` for a quarter and `YYYY` for a year.
 * All four were being shown raw, so the strength card's HEADER read
 * `2026-07-03 → 2026-08-16` above an axis that said `Jul 3, 2026` — one card,
 * two conventions.
 *
 * A quarter has no `Intl` form and is already readable, so it is passed
 * through; so is anything unrecognised, because inventing a format for a key
 * this does not know is how a label starts lying.
 *
 * @param {string} stamp
 */
export function formatStamp(stamp) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(stamp)) return formatDateShort(fromISOLocal(stamp));
  if (/^\d{4}-\d{2}$/.test(stamp)) {
    return monthAndYear().format(new Date(Number(stamp.slice(0, 4)),
                                          Number(stamp.slice(5, 7)) - 1, 15));
  }
  return stamp;                       // 'YYYY', 'YYYY-Qn', or something new
}
