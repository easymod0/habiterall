/**
 * Date helpers for the browser.
 *
 * All dates are local calendar dates as 'YYYY-MM-DD' strings, matching the
 * server. Never build them from toISOString(), which is UTC and shifts the
 * date for anyone west of Greenwich.
 */

/**
 * The canonical spelling of a day, and the same one `toISO` in
 * `shared/src/stats.js` produces: four-digit year, two-digit month, two-digit
 * day. The YEAR is padded for the reason the other two fields are — this
 * output is compared LEXICALLY (`dashboard.js`'s
 * `(state.gridEnd ?? todayIso) >= todayIso`) and keys entry lookups against
 * dates the server spelled, and `'999-12-31'` sorts ABOVE `'2016-…'`.
 *
 * Nothing here can reach a year before 1000 today: `todayISO()` is the device
 * clock and `addDaysISO` steps from it a fortnight at a time. That is
 * unreachability, not canonicality — the padding is what makes it true of
 * `iso()` itself rather than of its two current callers, which is the whole
 * argument the server-side copy was fixed on.
 */
export const iso = (d) =>
  `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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
 * #132: this can disagree with `formatDateLong` on the SAME day, in ja-JP and
 * zh-CN — the dashboard's range reads `2026/08/10～2026/08/16` while the day
 * dialog's long date for the 10th reads `2026年8月10日月曜日`. Decided to leave
 * as is: both are `Intl`'s own correct answer to two DIFFERENT questions (a
 * two-ended range, at whatever granularity the two ends share, versus one
 * long date), asked at each surface's own formatter — unlike the
 * Gregorian-field bugs this file exists to avoid, where two readings answered
 * the SAME question and one of them was simply wrong. Overriding one to match
 * the other means hand-picking a format for languages neither of us reads,
 * which is exactly what asking `Intl` here is meant to avoid needing.
 *
 * Two things NOT reachable through this app, so not guarded here: an invalid
 * `Date` makes `formatRange`/`format` throw a `RangeError` rather than
 * returning a string, and every caller builds `a`/`b` from `fromISOLocal` on a
 * string that already passed `assertDate` (or from the device clock), so
 * there is no path that hands this an invalid `Date`.
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
 * Not reachable through this app, so not guarded here: `formatStamp('2026-13')`
 * matches the `YYYY-MM` branch and formats as January 2027 — `new Date`'s own
 * month rollover, since month index `13 - 1 = 12` is the 13th month of 2026,
 * which is the 1st of 2027. `BUCKETERS` (stats.js) never emits a month outside
 * `01`–`12`, so no bucket key this function is actually called with can hit it.
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
 * Why the rates below are what they are.
 *
 * `estimateTextWidth` states what they ARE and how they were measured; this is
 * the part worth keeping out of its signature — what the previous set got
 * wrong, which is what says why a reasoned table is not good enough. It was
 * wrong in both directions:
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

// Greek and Coptic, whole block. Greek Extended (polytonic, ἀ-῿) is
// deliberately excluded: rating it at this class's 0.72 would under-estimate
// it 1.58x, outside WIDTH_SAFETY, so one class cannot serve both. See
// WIDTH_SAFETY below for the measurement — quote that figure and not a ratio
// of the two blocks' maxima, which is a different and easily confused number.
const GREEK = /[\u0370-\u03FF]/;

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
  upper: 0.95, other: 0.8, greek: 0.8,
};

/** Rates inside a word, where glyphs shape, join and kern. */
const JOINED = {
  wide: 1, semitic: 0.62, indic: 1.15, thaiLao: 0.55, broad: 0.95,
  mark: 0.35, space: 0.3, digit: 0.6, wideDigit: 0.88, punct: 0.25,
  upper: 0.95, other: 0.58, greek: 0.72,
};

function classOf(ch) {
  if (COMBINING.test(ch)) return 'mark';
  // BEFORE the script tests. Every non-Latin digit block sits inside one of
  // them — Devanagari's are in INDIC's range, Thai's in THAI_LAO's, Khmer's in
  // BROAD's — so asking about the script first bills a numeral as a letter.
  if (DIGIT.test(ch)) return NARROW_DIGIT.test(ch) ? 'digit' : 'wideDigit';
  if (WIDE.test(ch)) return 'wide';
  // BEFORE SEMITIC: SEMITIC's range starts above Greek's (`֐` vs
  // `Ͱ`), so without this Greek fell through every script test to the
  // generic `other` rate. That was the whole bug (#286).
  if (GREEK.test(ch)) return 'greek';
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
 * The rates are MEASURED, against `getComputedTextLength()` in a real Chrome.
 * **`WIDTH_SAFETY`'s comment below is where the current measurement is
 * recorded, and it is the only one this function is covered by.** Do not
 * restate a coverage figure here: this comment used to carry one — 22,512
 * renderings in 67 locales, "none under-estimated by more than
 * `WIDTH_SAFETY`" — and #132 changed how the sum bills a mark-bearing word,
 * in the UNDER-estimating direction, without that sentence moving. It then
 * read as a current guarantee, over 51 locales nobody re-swept, sitting
 * directly above the loop that had invalidated it and twelve lines above a
 * replacement that says it supersedes nothing. The next reader cites the one
 * attached to the function, so the function carries no number.
 *
 * @param {string} text
 * @param {number} fontSize
 */
export function estimateTextWidth(text, fontSize) {
  const chars = [...String(text)];
  // Marks do not count toward the length: `ബു` is one letter wearing a vowel
  // sign, and reads as a lone glyph however many code points it takes. That
  // used to be true only of the RATE choice below — `solid` excluded marks
  // when picking LONE vs JOINED, but the sum still walked every code point
  // and billed each mark its own rate on top of the base glyph it rides on,
  // so a 3-code-point, 2-cluster word like `बुध` billed as if it were three
  // separate letters (39px at font 10) rather than the two glyphs a reader
  // sees. Summing over `solid` — the same filter, once — bills one rendered
  // cluster per non-mark code point and nothing extra for what rides on it.
  const solid = chars.filter((ch) => !COMBINING.test(ch));
  // A string of NOTHING BUT marks bills as one cluster rather than as zero.
  // Summing over `solid` is what makes a mark free, and free is right when it
  // rides on a base glyph that was billed; with no base glyph at all the same
  // sum answers 0 for a non-empty string, and 0 is not an estimate — it is a
  // label two call sites would treat as occupying no space (`charts.js:524`'s
  // right-edge clamp, and `fits()` at `:1262`). Nothing can reach it today:
  // every argument here is `Intl` output, and no locale's weekday, month or
  // range label is a bare mark. Closed anyway, because it costs one line and
  // the alternative is a comment asserting unreachability about a function
  // whose inputs are chosen by CLDR rather than by this repo.
  const billed = solid.length ? solid : chars.slice(0, 1);
  const rate = solid.length <= 2 ? LONE : JOINED;
  let ems = 0;
  for (const ch of billed) ems += rate[classOf(ch)];
  return ems * fontSize;
}

/**
 * How much more than the estimate to RESERVE.
 *
 * A margin rather than a per-script table three levels deep: the remaining
 * error is one script's average against another's widest glyph.
 *
 * 1.25 is measured, not chosen, and re-measured for #132: that issue changed
 * how `estimateTextWidth` sums a mark-bearing word (by rendered cluster
 * rather than by code point), which makes some estimates SMALLER — the
 * dangerous direction, since under-reserving clips a word — so the margin
 * needed re-deriving rather than inheriting.
 *
 * `shared/test/label-widths.mjs` is the instrument, and everything below is
 * reproducible by running it: `node shared/test/label-widths.mjs`. It measures
 * this file's estimator against `getComputedTextLength()` in a real Chrome,
 * over **17** locales at the six font sizes the charts use, across 49 labels
 * each — every weekday, month, year, month-stamp and range this app draws.
 * Of the 17, 16 have CLDR data in this Chrome build (`ne-NP` resolves but
 * falls back to ASCII names).
 *
 * The locale list is `locales.mjs`'s 10 plus seven. Five (`ml-IN`, `ta-IN`,
 * `te-IN`, `kn-IN`, `gu-IN`) are for this mark-billing change specifically —
 * the original ten's labels carry no combining mark at all, so a sweep of
 * them alone could not have seen the exact case (Malayalam `ബു`, the deleted
 * test's own string) the change reasons about. `he-IL` is breadth: CLDR's
 * Hebrew weekday and month names carry no niqqud either. `el-GR` is the
 * seventh and was added after review, for the reason below.
 *
 * **#286 (Greek): fixed.** `classOf` had no class for Greek at all — Greek
 * (`Ͱ`-`Ͽ`) sits below `SEMITIC`'s `֐`-`ࣿ` and above every other
 * script test, so every Greek code point fell through to the generic `other`
 * rate. A `GREEK` class now sits above `SEMITIC`, tested first for that
 * reason. `Μαρ` at 9.5px is real 20.25px against an estimate of 20.52px —
 * no longer an under-estimate at all.
 *
 * The rates: `JOINED.greek = 0.72`, `LONE.greek = 0.8`, measured with
 * `getComputedTextLength()` over the whole Greek and Coptic block (129
 * letters, non-mark) at the six sizes `charts.js` uses, flat across all six —
 * the per-glyph rate in a UNIFORM three-glyph run (`ch.repeat(3)`, real width
 * / 3 / font size) has p50 0.6042 and max 0.907 at every one of the six, to
 * four figures — so this is a per-em property and not a size artefact. Read
 * every per-glyph figure below as that measurement: a first draft took them
 * from four-letter runs of *differing* letters, which is the max of a per-run
 * AVERAGE and reads a third low at the top of the range.
 *
 * **The rule for choosing the number is "cover the widest label the
 * estimator is actually handed, and no more" — because every increment
 * above that is charged to the three call sites that apply no
 * `WIDTH_SAFETY`.** The widest real el-GR CLDR label is `Μαρ` at 0.711 per
 * glyph, so 0.72 is the smallest round rate that covers it (estimate 20.52px
 * against a real 20.25px at 9.5px). A first draft used 0.74, on the
 * reasoning that unknowns are billed high; that is right for a RESERVATION,
 * where `WIDTH_SAFETY` is applied on top anyway, and wrong here, because
 * `historyChart`'s stride, `weekdayChart`'s `fits` and `streakChart`'s
 * shrink loop all read this number raw and DEGRADE on it. Measured, the two
 * extra hundredths cost one more slot of the weekday axis: at 0.74 the short
 * Greek weekday names are refused at a 24px column, where they really fit at
 * 21.5px. That particular slot is not one a card can produce — see the
 * `weekdayChart` bullet below — but the other two sites lose bands the cards
 * do reach, and 0.74 would widen both.
 *
 * What no single rate can do is span this script's own spread, and that is
 * worth knowing before anyone tunes it again. Measured whole and in
 * isolation — real width / glyphs / font size, which is the only sense in
 * which a WORD has a rate — `Μαρ` is 0.711 and `Τρί` is 0.480: a 1.48x range
 * inside one script, so a per-character rate covering the first necessarily
 * over-estimates the second by half again. `Ιουν` is 0.510 on the same
 * instrument. The 0.472 an earlier draft gave `Ιουν` was not a measurement:
 * it was the label `Ιουν 2026`'s real width with this file's own ESTIMATE
 * rates for the space and the four digits subtracted back out, which makes
 * the estimator one of the instruments measuring itself. See the note below
 * on what this moves.
 *
 * `LONE = 0.8` is deliberately the same number as `other`'s lone rate, and
 * that is a measured result rather than a coincidence: the widest real Greek
 * lone label is Π at 0.731, so 0.8 already covers every one with headroom,
 * and the block's widest glyph (Μ, 0.907) sits at 1.134x, inside the margin.
 * Raising it would worsen every degrade decision above to buy an
 * under-estimate that no CLDR label produces. Do not delete the entry as
 * redundant — `classOf` returning `'greek'` with no `greek` key in the table
 * makes every Greek label `NaN` wide.
 *
 * **The widest per-glyph rates in the span, and what they are and are not
 * safe against.** In a uniform run the block's widest letters are Μ (U+039C)
 * and Ϻ (U+03FA) at 0.907, and the widest of the 14 Coptic letters in the
 * tail (U+03E2-U+03EF) is Ϣ (U+03E2) at 0.892. Against `JOINED.greek = 0.72`
 * those are **1.26x and 1.24x** — the Coptic one inside `WIDTH_SAFETY` and
 * only just, the Greek one marginally outside it — and the three degrade
 * sites apply no margin at all, so neither is covered by 1.25 in the place it
 * would matter. What makes the span safe is not those two numbers: it is that
 * nothing hands this function a uniform run of a block's widest letter. The
 * arguments are CLDR words, and a word's rate is the mean over its letters —
 * the widest real el-GR word is `Μαρ` at 0.711, which 0.72 covers, and the
 * harness's el-GR row measures no Greek under-estimate at all. Coptic is safe
 * for a plainer reason still: no CLDR date label in any locale is Coptic, so
 * the tail is in the class for span tidiness rather than for a caller. The
 * block's 15 non-letter code points all measure narrower than its letters
 * (0.156-0.648 as a uniform run), so including them costs only a slight
 * over-estimate on code points no date label contains.
 *
 * **Greek Extended (`ἀ`-`῿`, polytonic Greek) is deliberately EXCLUDED
 * from `GREEK` and stays on `other`, and re-measuring made that exclusion
 * STRONGER rather than weaker.** Its widest per-glyph rate in a uniform run
 * is 1.138 — Ἧ (U+1F2F) and ᾟ (U+1F9F), a capital eta wearing a rough
 * breathing and an iota subscript — against the base block's 0.907, so one
 * class cannot serve both: rated for the base block at 0.72 it would
 * under-estimate a polytonic glyph **1.58x**, well *outside* `WIDTH_SAFETY`
 * and so a worse defect than the one being fixed; rated for polytonic
 * instead it would over-estimate the real modern-Greek words by 1.60x
 * (`Μαρ`) to 2.37x (`Τρί`). It stays where it was, on `other`, where it
 * under-estimates **1.96x** — pre-existing, and reached by no locale in the
 * sweep, since el-GR CLDR is monotonic and polytonic is `el-polyton`.
 *
 * **Cyrillic has no class either, and this comment's headline number does not
 * cover it.** `classOf` has nothing for U+0400-U+04FF: not `SEMITIC`, whose
 * range starts at U+0590; not `BROAD`; and `UPPER` is ASCII-only — so Cyrillic
 * falls through to `other` exactly as Greek did, and this is the same shape of
 * disclosure as the Greek Extended exclusion above. Measured against real CLDR
 * labels: mn-MN `Ням` **1.201x**, kk-KZ `мам.` 1.187x, ru-RU `май` 1.118x,
 * mk-MK `мар.` 1.106x. The narrow weekday `Ш`, which is CLDR's narrow form for
 * several Cyrillic locales, measures **1.295x against `LONE.other` — outside
 * `WIDTH_SAFETY`** — though no reachable call site was found where it clips,
 * the narrow set being what a chart falls back TO rather than reserves for.
 * `label-widths.mjs`'s `LOCALES` contains no Cyrillic locale at all, so the
 * 1.19x below is the worst case of the SWEEP and a lower bound on the app's.
 * Deliberately not folded in here: a `CYRILLIC` class is the same kind of
 * change this one is, wants its own measurement of what it moves at the three
 * degrade sites, and would move the headline number — so it is left for a
 * separate decision rather than smuggled into Greek's.
 *
 * **With Greek classed, the worst under-estimate THIS HARNESS finds is 1.19x —
 * Arabic `أغسطس` at 8px (real 29.4px, estimate 24.8px)** — and read that as
 * the sweep's worst rather than the app's, for the Cyrillic reason above.
 * Against 1.25 that leaves 4.8% of headroom — `(1.25 - ratio) / 1.25`, the
 * same arithmetic the retired Greek sentence's 1.6% came from, stated here
 * because a reviewer read it as `1.25 / ratio - 1` and got 5.4%: the two
 * readings differ by 0.03 points at 1.23x and by half a point at 1.19x, so
 * they are only indistinguishable at the figure this comment used to carry.
 * el-GR's own worst case is now 1.03x, and it is no
 * longer a Greek string at all: it is `28/1/2026 – 3/2/2026` at 8px, the same
 * ASCII date range that is already the worst case in eight other locales. The
 * cost of the class is on the other side and is priced deliberately — el-GR's
 * worst OVER-estimate rises from 1.44x to ~1.50x (`Τρί`), which is what
 * `LONE.greek` is held at 0.8 and `JOINED.greek` at 0.72 to limit.
 *
 * **What this MOVES, measured, because a wider estimate degrades as well as
 * reserves.** Measured by importing the real `historyChart`, `weekdayChart`
 * and `streakChart` and driving them against the same ~15-line fake DOM
 * `rendercheck.mjs` builds, then COUNTING the `<text>` nodes each emits under
 * `LC_ALL=el_GR.UTF-8` — before and after, "before" being a whole copy of
 * `shared/public/` with `JOINED.greek` set to 0.58. A first version of these
 * bullets transcribed the three charts' arithmetic from prose into a script
 * instead, got two of the formulas wrong, and named a width and a string at
 * which nothing happens. Every reachable `width` here is at least 320, which
 * is `chartWidth`'s floor (`Math.max(320, cardInnerWidth(host))`,
 * `ui/detail.js:492`).
 *
 *   - A REAL LOSS. `historyChart` labels fewer buckets, in one band per
 *     bucket count. The widest axis ESTIMATE at 9.5px moves 47.69px → 53.01px
 *     — both from `Ιουν 2026`, the four-letter month — so the per-caption
 *     budget (`widest + 10`) goes 57.7px → 63.0px, and the count drops wherever
 *     `floor((width - 46) / budget)` crosses. Measured over 320-1440px: 12
 *     buckets go 12 → 6 at 739-802px and 6 → 4 at 393-424px; 16 go 16 → 8 at
 *     970-1054px and 6 → 4 at 393-424px; 10 go 5 → 4 at 335-361px, which is
 *     the phone. Nothing moves at 328px, and nothing moves at 700px for 12
 *     buckets — the retired version of this bullet claimed both. The axis was
 *     NOT overlapping before: the widest real label is `Μαρ 2026` at 44.45px
 *     against that 57.7px budget, so this site is pure loss. It is also
 *     unavoidable at any rate covering `Μαρ` — swept rate by rate against the
 *     real chart, holding each band needs `JOINED.greek` at or below 0.580
 *     (the 739px band), 0.670 (1024px), 0.700 (420px) and 0.710 (360px), and
 *     `Μαρ` really measures 0.711.
 *   - A REAL LOSS. `streakChart` gives up the wordy range label for the
 *     numeric one at EVERY reachable card width below 374px — 320-373px,
 *     which includes 328 and 360 — for one label shape: a cross-year range
 *     whose two ends are both four-letter months, `28 Ιουν 2025 – 4 Ιουλ
 *     2026`. That estimates 165.72px against a 160px budget (`LABEL_W`'s 168
 *     floor less `LABEL_GAP`'s 8) where the words really measure 142.84px, so
 *     17px of real room is thrown away. `labelSize` does not move at any
 *     width; the loss is the format alone. The `28 Δεκ 2025 – 4 Ιαν 2026` the
 *     retired version named does not degrade at ANY width — 149.15px
 *     estimated, inside the same 160px — and neither does the same-year `28
 *     Ιουν – 4 Ιουλ 2026` at 134.66px: the four-letter month has to land at
 *     both ends of a range that also carries two years, which takes a streak
 *     of about a year. This is the same lv-LV case the comment above cites,
 *     arriving in Greek.
 *   - NO CHANGE AT ALL. `weekdayChart` does not move at any width the app
 *     draws, and the retired version of this bullet presented half of what it
 *     does as a defect this fixes — the only item in the list stated as a
 *     gain rather than a trade, and it was not reachable at any width. The
 *     crossover from the short names (`Κυρ Δευ …`) to the narrow ones goes
 *     from a 19.14px column to a 23.76px one, and the real widest short name
 *     is `Παρ` at 21.50px (size 11) — so on paper the fix stops a clipped
 *     short axis between a 19.1 and a 21.5px column, and becomes pessimistic
 *     between 21.5 and 23.8px, choosing the narrow set
 *     (`Κ Δ Τ Τ Π Π Σ`, two pairs of duplicates — exactly the "axis you have
 *     to count along" the `fits` comment argues against) where the short one
 *     fits. Both bands need a 180-212px chart. The floor is 320, whose column
 *     is 39.1px, and both sets fit that on both sides of the change. Kept
 *     rather than deleted because "no reachable width" is the finding.
 *
 * The two real losses are the intra-script spread above, arriving as a UX
 * consequence rather than as an arithmetic one. **It is deliberately NOT
 * fixed here: the stride and the shared reserve are #285, which wants a
 * decision rather than a number.** The fix for it is not a different Greek
 * rate — no single rate spans 0.480 to 0.711 — it is a stride that measures
 * the label it is about to drop.
 *
 * Greek's 1.23x was originally found by extending the harness's locale list by
 * hand and not committing the extension, so the one figure this comment told
 * you to re-run the harness for was the one figure the harness could not
 * produce. `el-GR` is in `LOCALES` now, and re-running the harness reproduces
 * the 1.03x above rather than the 1.23x, which is how this paragraph is
 * checkable at all.
 *
 * **On the Arabic figure, which two records disagree about.** Master's
 * version of this comment names 1.23x — Arabic `أغسطس` as the worst case.
 * This harness measures that same string at **1.19x** (real 29.4, estimate
 * 24.8, at 8px), and the estimate for it is byte-identical before and after
 * #132 — `أغسطس` carries no combining mark, so nothing in this change could
 * have moved it. The two figures are therefore two different INSTRUMENTS, not
 * two states of the code, and master's is the one being retired: it came from
 * a corpus (the 67-locale sweep) that no longer exists in the tree and cannot
 * be re-run. Read every ratio here as this harness's. The two records now
 * agree about which STRING is the worst case and differ only in the figure
 * they give it, which is the cleanest possible statement of the instrument
 * gap: master's corpus said Arabic `أغسطس` at 1.23x, this one says the same
 * string at 1.19x, and #286 is why the title went to Greek and back again in
 * between. Arabic is a genuine near-miss for a reason worth keeping — its
 * letters join more tightly than a per-character rate can express — and it is
 * a rate that would need re-measuring, unlike Greek, which needed a class.
 *
 * The worst case among the five mark-heavy additions is Malayalam's `ബുധൻ`
 * at 1.05x, comfortably inside the margin. `ബു` alone (the deleted test's
 * exact string) is not an under-estimate at all — 18.7px estimated against
 * 18.03px real at font-size 11, a raw 3.7% margin before this 1.25 is
 * applied. That margin is thin only because #131 already re-measured
 * `LONE.indic` up to 1.7 (from a rate the deleted test's own numbers imply
 * was closer to 1.0); freeing the mark on TOP of the old, lower rate is what
 * the deleted test's under-estimate came from, and re-billing it was a
 * workaround for that rate rather than a property of marks.
 *
 * **`formatStamp`'s output is in the sweep, and was not until review.** The
 * harness claimed to measure "every label `charts.js` draws" while omitting
 * the widest strings the estimator is ever handed — `26 de dez. de 2026`,
 * `أغسطس ٢٠٢٦`, `2026 ജൂൺ 15`. That matters at `charts.js:1177`, where
 * `historyChart` budgets its axis with explicitly NO `WIDTH_SAFETY` applied
 * because it decides how many labels to DROP, so no margin absorbs an
 * under-estimate there; and at `:524` / `:891`, where a smaller estimate
 * clamps the month caption LESS. Adding those labels moved `ml-IN`'s own
 * worst case to `2026 ജൂൺ` at 1.07x and did not move the overall worst,
 * which was Greek at the time and is Arabic now that Greek has a class.
 *
 * Re-run the harness and update this comment if a future change to the rates,
 * the classes, or the sum moves any of these numbers.
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
