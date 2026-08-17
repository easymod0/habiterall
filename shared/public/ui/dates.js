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
const dayOnly = fmt({ day: 'numeric' });
const longDate = fmt({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const monthAndYear = fmt({ year: 'numeric', month: 'short' });
const yearOnly = fmt({ year: 'numeric' });
const mediumDate = fmt({ year: 'numeric', month: 'short', day: 'numeric' });
const numericDate = fmt({ year: 'numeric', month: 'numeric', day: 'numeric' });

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
 * The day-of-month of a REAL date, in this locale's calendar AND its digits.
 *
 * `String(d.getDate())` is the same defect as `monthLabels()` one field over,
 * and the dashboard's own header is where it showed: `rangeLabel` was
 * localised and the column captions under it were not, so fa-IR read
 * `۱۹ تا ۲۵ مرداد ۱۴۰۵` above columns numbered `10 11 12 13 14 15 16`. That is
 * "16 against 25 for the same day" — the comparison `formatMonthShort` exists
 * to prevent — inside ONE header row rather than one tap apart. ar-EG is the
 * same defect in digits alone: `١٠` above, `10` below.
 *
 * `getDate()` is a Gregorian field, and in a Persian or Hijri calendar the day
 * number genuinely differs; even where the calendars agree, the DIGITS need
 * not. `Intl` answers both at once.
 *
 * @param {Date} d
 */
export const formatDayNumber = (d) => dayOnly().format(d);

/**
 * The year of a REAL date, as this locale's calendar numbers it.
 *
 * The same rule as `formatMonthShort` and it exists for the same reason: a
 * chart that captions a column `مرداد` and then writes `2026` underneath is
 * naming one column in two calendars, and the two disagree by 621 years. The
 * Gregorian year is not a label, it is a field of the date — hand it to `Intl`
 * like the rest of it.
 *
 * Note the CHANGE of year has to be read from this string too, not from the
 * Gregorian one: a Persian year turns at Farvardin, not at January, so a
 * caption placed where `yy` increments appears in the wrong column even once
 * the number itself is right.
 *
 * @param {Date} d
 */
export const formatYear = (d) => yearOnly().format(d);

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
 * `style` picks how much room it may take. `short` is the all-numeric form,
 * for a label that has to fit a phone: lv-LV's medium range is
 * `2025. gada 28. dec. – 2026. gada 4. janv.`, which no type size makes fit
 * beside a bar on a 328px card, and shrinking it to something that does is
 * worse than writing the same dates in digits. Which one a caller wants is a
 * question about ITS layout, so it is a parameter rather than a rule here.
 *
 * @param {Date} a  the earlier end
 * @param {Date} b  the later end
 * @param {'medium'|'short'} [style]
 */
export function formatDayRange(a, b, style = 'medium') {
  const f = style === 'short' ? numericDate() : mediumDate();
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

/*
 * The character classes, and two rates for each.
 *
 * A per-character model has to answer one question it cannot: a glyph is wider
 * on its own than it is inside a word. `س` alone measures 1.17em and the same
 * letter joined measures 0.42; `ma` averages 0.75em a character where `Monday`
 * averages 0.53. Shaping is part of it and kerning and the absence of
 * neighbours are the rest, and it is true of every script rather than only the
 * cursive ones. So there are two tables and the label's LENGTH picks between
 * them — short labels (a narrow weekday, an Arabic letter) take the wide rates,
 * everything longer takes the rates a word actually averages.
 *
 * A single table cost the app something real. Billing every class at its
 * isolated width made `Dec 28, 2025 – Jan 4, 2026` estimate 207px against a
 * measured 139.3 — 1.49x — and `streakChart` reads that estimate to decide
 * whether its date range fits. So English fell back to `12/28/2025 – 1/4/2026`
 * on a card where the words fitted with 20px to spare, in the locale CI runs
 * in, in 36 of 50 locales measured. Over-reserving a gutter costs pixels;
 * over-reserving a decision costs the better label.
 */

// Square: CJK, Hangul, kana, full-width forms. Measured at exactly 1.00em.
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

// Arabic, Hebrew, Thaana, Syriac — cursive, and NARROW once joined.
const SEMITIC = /[\u0590-\u08FF]/;

// Indic. The widest of the alphabetic scripts here.
const INDIC = /[\u0900-\u0DFF]/;

// Thai and Lao, which are narrow and used to be billed with the Indic block.
const THAI_LAO = /[\u0E00-\u0FFF]/;

// Myanmar, Georgian, Ethiopic, Cherokee, Khmer, Armenian.
const BROAD = /[\u1000-\u10FF\u1200-\u137F\u13A0-\u13FF\u1780-\u17FF\u0530-\u058F]/;

// A combining mark. NOT zero: it advances in Chrome more often than not.
const COMBINING = /\p{Mn}|\p{Me}/u;

const SPACE = /\s/;

/**
 * Digits, in every numbering system `Intl` can hand a date formatter — and
 * they are TWO classes, because their widths do not agree.
 *
 * `/[0-9]/` was ASCII-only and sat BELOW the script tests, so a Devanagari or
 * Bengali digit was billed at its script's LETTER rate: `२०२६-०४-२१ – २०२६-०५-१८`
 * came out at 232.9px against 131.7px for the identical ASCII string, 1.77x
 * for the same information. That is what put ne-NP and as-IN streak labels at
 * a 7.5px font while en-US kept 11.5, and it is why the floor was dropped from
 * 8 to 7 — the "two pixels of real overflow" was this, not overflow.
 *
 * But one digit rate would be wrong the other way. Measured per glyph, at
 * three sizes, against `getComputedTextLength()`:
 *
 *   arab .459  guru .564  mymr .562  deva .566  gujr .579  ascii .572
 *   tibt .596  orya .627  knda .678  khmr .683  beng .689  telu .757
 *   thai .757  taml .800  mlym .849
 *
 * Malayalam is 1.85x Arabic. Billing them alike either clips the wide half or
 * hands the narrow half a gutter half again too big, so there are two rates
 * and the split is where the measurements leave a gap.
 *
 * The narrow list is EXPLICIT and everything else decimal falls to the wide
 * rate, which is the safe direction for a script nobody has measured: this
 * file's own rule is that unknowns are billed high and bounded by
 * `gutterFor`'s ceiling. Tibetan is in the wide half on the strength of its
 * LONE glyph (.734), not its joined one.
 */
const DIGIT = /\p{Nd}/u;
const NARROW_DIGIT =
  /[0-9\u0660-\u0669\u06F0-\u06F9\u0966-\u096F\u0A66-\u0A6F\u0AE6-\u0AEF\u1040-\u1049]/;
// Split out from the letters because they are half their width and a date is
// full of them: lumping `28.12.2025` in with lowercase is most of why a Latin
// range was over-billed.
const PUNCT = /[.,:;'\u2019\-\u2013\u2014/()]/;
const UPPER = /[A-Z]/;

/** Rates for a label of one or two characters, where every glyph stands alone. */
const LONE = {
  wide: 1, semitic: 1.25, indic: 1.7, thaiLao: 0.7, broad: 1,
  mark: 0.5, space: 0.3, digit: 0.7, wideDigit: 0.96, punct: 0.4,
  upper: 0.95, other: 0.8,
};

/** Rates inside a word, where glyphs shape, join and kern. */
const JOINED = {
  wide: 1, semitic: 0.62, indic: 1.15, thaiLao: 0.55, broad: 0.95,
  mark: 0.35, space: 0.3, digit: 0.6, wideDigit: 0.88, punct: 0.25,
  upper: 0.95, other: 0.58,
};

function classOf(ch) {
  if (COMBINING.test(ch)) return 'mark';
  // BEFORE the script tests. Every non-Latin digit block sits inside one of
  // them — Devanagari's are in INDIC's range, Thai's in THAI_LAO's, Khmer's in
  // BROAD's — so asking about the script first bills a numeral as a letter.
  if (DIGIT.test(ch)) return NARROW_DIGIT.test(ch) ? 'digit' : 'wideDigit';
  if (WIDE.test(ch)) return 'wide';
  if (SEMITIC.test(ch)) return 'semitic';
  if (INDIC.test(ch)) return 'indic';
  if (THAI_LAO.test(ch)) return 'thaiLao';
  if (BROAD.test(ch)) return 'broad';
  if (SPACE.test(ch)) return 'space';
  if (PUNCT.test(ch)) return 'punct';
  if (UPPER.test(ch)) return 'upper';
  return 'other';
}

/**
 * A rough width in pixels for a short label, at a given font size.
 *
 * There is no text metric without a DOM, and two suites drive `charts.js` with
 * a fake one — so a chart that must reserve room for a label it cannot measure
 * has to estimate. The alternative was a label width that fits everywhere, and
 * there isn't one: `Intl`'s short weekday is `Mon` in English, `domingo` in
 * pt-PT and `Jumamosi` in sw-KE, and the last two overflowed a fixed 34px
 * gutter and rendered as `omingo` and `umamosi`.
 *
 * The rates are MEASURED, against `getComputedTextLength()` over 22,512 label
 * renderings — every weekday, month, month-and-year and range this app draws,
 * in 67 locales at the six sizes the charts use. Across the 20,100 that are
 * real labels rather than probes, none is under-estimated by more than
 * `WIDTH_SAFETY`.
 *
 * @param {string} text
 * @param {number} fontSize
 */
export function estimateTextWidth(text, fontSize) {
  const chars = [...String(text)];
  // Marks do not count toward the length: `ബു` is one letter wearing a vowel
  // sign, and reads as a lone glyph however many code points it takes.
  const solid = chars.filter((ch) => !COMBINING.test(ch)).length;
  const rate = solid <= 2 ? LONE : JOINED;
  let ems = 0;
  for (const ch of chars) ems += rate[classOf(ch)];
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
