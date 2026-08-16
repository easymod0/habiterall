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

// `Object.create(null)`, so a style of `__proto__` cannot resolve to
// `Object.prototype` — the trap the root CLAUDE.md records for `SETTING_VALUES`.
// Unreachable from the four literal call sites; it costs nothing to close.
/** @type {Record<string, readonly string[]>} */
const weekdayCache = Object.create(null);
let monthCache = null;

/**
 * Weekday names in one of `Intl`'s three widths, indexed by `getDay()`.
 *
 * `narrow` is one character in most locales but NOT all — fil-PH gives
 * `Lin Lun Mar`, ca-ES `dg. dl.`, vi-VN `CN T2`, hu-HU `Sz`. It is never wider
 * than `short`, which is the property the layouts actually rely on; the
 * seven-column grid header is measured at 360px by `responsive.mjs` rather
 * than assumed from a character count.
 *
 * There is no two-letter width, which is what `charts.js` used to hardcode for
 * the month grid's rows. Those read `short`, not `narrow`: that axis is the
 * whole point of its chart and one letter makes S/S and T/T ambiguous — the
 * reason the hardcoded version wrote `Su`/`Mo`. `short` is unbounded in width,
 * so the chart sizes its gutter with `estimateTextWidth` instead of choosing a
 * label that fits a fixed one.
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
 * `ui/day-dialog.js` and `ui/dashboard.js` both call it. They each built this
 * formatter inline, per open, with byte-identical options — which is the
 * per-call cost the memo above argues against.
 * @param {Date} d
 */
export const formatDateLong = (d) => longDate().format(d);

/**
 * A date for a label beside a chart — short, and not a serial number.
 *
 * This is what replaced the raw ISO on the calendar's range label and the
 * strength chart's axis. `formatStamp` below is its counterpart for a bucket
 * key, and between them nothing user-facing in `charts.js` shows a storage
 * string any more — the axes, the tooltips and the calendar's own popover all
 * read through one of the two.
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


/**
 * A rough width in pixels for a short label, at a given font size.
 *
 * There is no text metric without a DOM, and two suites drive `charts.js` with
 * a fake one — so a chart that must reserve room for a label it cannot measure
 * has to estimate. Deliberately generous, and it counts WIDE characters at a
 * full em: `月曜日` is three characters and about as wide as `Monday`.
 *
 * The alternative was to pick a label width that fits everywhere, and there
 * isn't one: `Intl`'s short weekday is `Mon` in English, `domingo` in pt-PT and
 * `Jumamosi` in sw-KE. Measured in Chrome, the last two overflowed a fixed
 * 34px gutter and rendered as `omingo` and `umamosi` — a truncation that is not
 * a word.
 *
 * @param {string} text
 * @param {number} fontSize
 */
// Square: CJK, Hangul, kana, full-width forms.
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

// Broader than Latin per character, and measured rather than guessed. Arabic,
// Hebrew, Thaana, Indic, Thai, Lao, Tibetan, Myanmar, Georgian, Ethiopic,
// Cherokee and Khmer — the last six were silently taking the Latin rate, which
// is where the worst under-estimates were: `ᏉᏅᎯ` (Cherokee) measured 32.5px
// against an estimate of 19.5.
const BROAD =
  /[\u0530-\u058F\u0590-\u08FF\u0900-\u0DFF\u0E00-\u0FFF\u1000-\u109F\u10A0-\u10FF\u1200-\u137F\u13A0-\u13FF\u1780-\u17FF]/;

// Zero advance: a combining mark sits on the character before it. Billing them
// as full characters made Indic gutters 2-3x too wide — `ਸ਼ੁੱ` was estimated at
// 28.8px against a real 7.4.
const COMBINING = /\p{Mn}|\p{Me}/u;

/**
 * A rough width in pixels for a short label, at a given font size.
 *
 * There is no text metric without a DOM, and two suites drive `charts.js` with
 * a fake one — so a chart that must reserve room for a label it cannot measure
 * has to estimate. Deliberately generous: over-reserving costs a few pixels of
 * gutter, under-reserving clips a word, and a clipped word is the bug this
 * exists to prevent.
 *
 * The alternative was to pick a label width that fits everywhere, and there
 * isn't one: `Intl`'s short weekday is `Mon` in English, `domingo` in pt-PT and
 * `Jumamosi` in sw-KE. Measured in Chrome, the last two overflowed a fixed
 * 34px gutter and rendered as `omingo` and `umamosi`.
 *
 * Accuracy was measured against `getBBox()` over ~4,000 label strings from 88
 * locales; the margin below covers what the classes alone do not, including
 * capital-heavy Latin, where 0.62em was slightly mean.
 *
 * @param {string} text
 * @param {number} fontSize
 */
export function estimateTextWidth(text, fontSize) {
  let ems = 0;
  for (const ch of String(text)) {
    if (COMBINING.test(ch)) continue;
    else if (WIDE.test(ch)) ems += 1;
    else if (BROAD.test(ch)) ems += 1;
    else ems += 0.65;
  }
  return ems * fontSize;
}

/**
 * How much more than the estimate to RESERVE.
 *
 * A margin rather than a per-script table three levels deep: the remaining
 * error is one script's average against another's widest glyph, and 15% of a
 * gutter is cheaper than measuring every writing system.
 *
 * Deliberately separate from `estimateTextWidth`, which answers "how wide is
 * this, roughly". Folding the margin in made the estimate wrong in the other
 * direction and reported a `100%` axis label as 2px short of a gutter it
 * clears — a test failing because the padding was inside the ruler.
 */
export const WIDTH_SAFETY = 1.15;

/**
 * How much room a right-anchored row label needs, given a floor.
 *
 * Extracted so the arithmetic is testable without a locale: two charts size
 * their left gutter this way, and the failure it prevents — a caption clipped
 * mid-word — only shows in locales CI does not run in. `floor` keeps the common
 * case looking exactly as it did.
 *
 * @param {readonly string[]} labels
 * @param {number} fontSize
 * @param {number} floor    the smallest gutter to use
 * @param {number} gap      space between the label and the plot
 */
export function gutterFor(labels, fontSize, floor, gap) {
  const widest = Math.max(0, ...labels.map((t) => estimateTextWidth(t, fontSize)));
  return Math.max(floor, Math.ceil(widest * WIDTH_SAFETY) + gap + 4);
}
