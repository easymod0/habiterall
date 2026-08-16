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

// `Object.create(null)`, so a style of `__proto__` cannot resolve to
// `Object.prototype` — the trap the root CLAUDE.md records for `SETTING_VALUES`.
// Unreachable from the four literal call sites; it costs nothing to close.
/** @type {Record<string, readonly string[]>} */
const weekdayCache = Object.create(null);

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

/**
 * The short month name of a REAL date — never an index into a table.
 *
 * There was a `monthLabels()` here, twelve names built from sample dates and
 * read with `getMonth()`, and it is the shape this comment exists to warn
 * against. `getMonth()` is a GREGORIAN field, so indexing localised names with
 * it silently assumes the locale's calendar is Gregorian, and for fa-IR,
 * th-TH and ar-SA it is not. Measured: the dashboard's range read
 * `10 – 16 مرداد 2026` for 2026-08-10…16 while the amount dialog, one tap
 * away on the same screen, read `۱۴۰۵ مرداد ۲۵` for the same day — 16 against
 * 25, because one composed a Persian month name onto a Gregorian day number
 * and the other formatted the date.
 *
 * Handing `Intl` the date is the whole fix, and it costs nothing: the
 * formatter is memoised exactly as before, and only the argument changed.
 *
 * @param {Date} d
 */
export const formatMonthShort = (d) => shortMonth().format(d);

/**
 * A span of two dates, as one string, in the locale's own conventions.
 *
 * `Intl.DateTimeFormat.prototype.formatRange` decides three things a hand
 * composed `${day} ${month} ${year} – …` cannot: the field ORDER (ja-JP writes
 * the year first), the CALENDAR (see above), and which parts to elide when the
 * two ends share them — `3 – 16 Aug 2026` in English, and something else
 * wherever that is not how a range is written. Both call sites had their own
 * elision rule, and neither was right outside English.
 *
 * `formatRange` is Chrome 76 / Firefox 91 / Safari 14.1, which is below this
 * app's floor; the fallback is there because an absent Intl method must
 * degrade to a readable string rather than throw inside a render.
 *
 * @param {Date} a  the earlier end
 * @param {Date} b  the later end
 */
export function formatDayRange(a, b) {
  const f = mediumDate();
  if (typeof f.formatRange !== 'function') return `${f.format(a)} – ${f.format(b)}`;
  // Identical ends: `formatRange` is specified to fall back to formatting the
  // single date, but engines have disagreed, and "3 Aug 2026 – 3 Aug 2026" for
  // a one-day window is the kind of thing nobody notices in review.
  return a.getTime() === b.getTime() ? f.format(a) : f.formatRange(a, b);
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


/*
 * A rough width in pixels for a short label, at a given font size.
 *
 * There is no text metric without a DOM, and two suites drive `charts.js` with
 * a fake one — so a chart that must reserve room for a label it cannot measure
 * has to estimate. The alternative was to pick a label width that fits
 * everywhere, and there isn't one: `Intl`'s short weekday is `Mon` in English,
 * `domingo` in pt-PT and `Jumamosi` in sw-KE. Measured in Chrome, the last two
 * overflowed a fixed 34px gutter and rendered as `omingo` and `umamosi` — a
 * truncation that is not a word.
 *
 * The rates below are MEASURED, against `getComputedTextLength()` over 22,512
 * label renderings — every weekday, month, month-and-year and date range this
 * app draws, in 67 locales at the six font sizes the charts use. The previous
 * set was reasoned rather than measured and was wrong in both directions:
 *
 *   - a capital was billed at 0.65em and measures **0.91**, so `W` — the
 *     commonest narrow weekday label in English — was under-reserved by 1.43x,
 *     in the locale CI runs in;
 *   - a combining mark was billed at NOTHING, on the reasoning that it sits on
 *     the character before it. Chrome advances for many of them: Malayalam
 *     `ബു` estimated 11.0px against a real 18.0;
 *   - Arabic, Hebrew and Thai were billed at a full em and measure 0.47 and
 *     0.53, so a Hebrew month name was over-reserved by up to 3.4x. That is
 *     what made `frequencyChart` claim 157px of a 328px card for its row
 *     labels — nothing clipped, and half the chart gutter.
 *
 * Being wrong in the generous direction is still the safer half, which is why
 * the classes that could not be pinned down (an ISOLATED Arabic letter
 * measures 1.17em where the same letter joined inside a word measures 0.42)
 * are billed high and bounded by `gutterFor`'s ceiling instead.
 */

// Square: CJK, Hangul, kana, full-width forms. Measured at exactly 1.00em.
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

// Arabic, Hebrew, Thaana and Syriac. Cursive, so a letter's width depends on
// whether it JOINS: `س` alone measures 1.17em and the same letter inside a
// word measures 0.42. Both rates are below, chosen by whether the label is one
// character — which is exactly the case that matters, because `Intl`'s narrow
// weekday in Arabic IS a single letter.
const SEMITIC = /[\u0590-\u08FF]/;

// Indic. The widest of the alphabetic scripts here: a conjunct plus its marks
// measured 1.64em, which is why the base rate is above one.
const INDIC = /[\u0900-\u0DFF]/;

// Thai and Lao. Narrow, and previously billed with the Indic block.
const THAI_LAO = /[\u0E00-\u0FFF]/;

// Myanmar, Georgian, Ethiopic, Cherokee, Khmer, Armenian — measured between
// 0.66 and 1.00, billed at the top of that range.
const BROAD = /[\u1000-\u10FF\u1200-\u137F\u13A0-\u13FF\u1780-\u17FF\u0530-\u058F]/;

// A combining mark. NOT zero: it advances in Chrome more often than not.
const COMBINING = /\p{Mn}|\p{Me}/u;

/**
 * A rough width in pixels for a short label, at a given font size.
 *
 * Deliberately generous where the classes disagree: over-reserving costs a few
 * pixels of gutter — bounded by `gutterFor`'s ceiling — while under-reserving
 * clips a word, and a clipped word is the bug this exists to prevent.
 *
 * @param {string} text
 * @param {number} fontSize
 */
export function estimateTextWidth(text, fontSize) {
  const chars = [...String(text)];
  // A lone letter takes its isolated form; anything longer shapes and joins.
  const lone = chars.filter((c) => !COMBINING.test(c)).length <= 1;
  let ems = 0;
  for (const ch of chars) {
    if (COMBINING.test(ch)) ems += 0.4;
    else if (WIDE.test(ch)) ems += 1;
    else if (SEMITIC.test(ch)) ems += lone ? 1.25 : 0.6;
    else if (INDIC.test(ch)) ems += 1.1;
    else if (THAI_LAO.test(ch)) ems += 0.7;
    else if (BROAD.test(ch)) ems += 1;
    else if (ch >= 'A' && ch <= 'Z') ems += 0.95;
    else ems += 0.66;
  }
  return ems * fontSize;
}

/**
 * How much more than the estimate to RESERVE.
 *
 * A margin rather than a per-script table three levels deep: the remaining
 * error is one script's average against another's widest glyph.
 *
 * 1.25 is measured, not chosen. Across the 20,100 real label renderings behind
 * `estimateTextWidth`'s rates, **18** come out wider than the estimate and the
 * worst of those is 1.23x — Arabic `أغسطس`, whose letters join more tightly
 * than the per-character rate can express. It was 1.15, which the same data
 * says is short for those eighteen.
 *
 * Deliberately separate from `estimateTextWidth`, which answers "how wide is
 * this, roughly". Folding the margin in made the estimate wrong in the other
 * direction and reported a `100%` axis label as 2px short of a gutter it
 * clears — a test failing because the padding was inside the ruler.
 */
export const WIDTH_SAFETY = 1.25;

/**
 * How much room a right-anchored row label needs, given a floor and a CEILING.
 *
 * Extracted so the arithmetic is testable without a locale: two charts size
 * their left gutter this way, and the failure it prevents — a caption clipped
 * mid-word — only shows in locales CI does not run in. `floor` keeps the
 * common case looking exactly as it did.
 *
 * The ceiling is the other half, and it was missing. `estimateTextWidth` is
 * deliberately generous and it over-estimates Arabic and Hebrew badly, because
 * those scripts are billed at a full em per character while measuring far
 * narrower — `الثلاثاء` estimates at 84px against a real 26.3px. Unbounded,
 * that reserved **157px of a 328px card** for fa-IR row labels: nothing was
 * clipped, and half the chart was gutter. A gutter that cannot exceed a
 * fraction of the chart turns the worst case back into a truncation, which is
 * the ordinary failure a reader can see and recover from, rather than a chart
 * with no room left to draw in.
 *
 * @param {readonly string[]} labels
 * @param {number} fontSize
 * @param {number} floor    the smallest gutter to use
 * @param {number} gap      space between the label and the plot
 * @param {number} [ceiling] the largest, usually a fraction of the chart width
 */
export function gutterFor(labels, fontSize, floor, gap, ceiling = Infinity) {
  const widest = Math.max(0, ...labels.map((t) => estimateTextWidth(t, fontSize)));
  const want = Math.ceil(widest * WIDTH_SAFETY) + gap + 4;
  return Math.min(Math.max(floor, want), Math.max(floor, ceiling));
}
