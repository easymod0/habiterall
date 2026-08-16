import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Every weekday axis, against the account's own week start.
//
// This suite exists because a review proved the alternative did not: with the
// week-start plumbing deliberately broken FOUR ways at once — the bars read
// positionally while the captions rotated, the calendar's row labels left
// unrotated, Home/End back on `getDay()`, and the month chart reading its rows
// by index — the entire unit suite and every browser suite still passed. The
// arithmetic in `calendar.test.js` was covered; nothing looked at a rendered
// chart.
//
// The failure that matters is not "the wrong day is first". It is a chart whose
// LABEL and whose DATA move independently, which reads as deliberate and is
// wrong in the one dimension the chart exists to show. So each check below ties
// a caption to the datum drawn beside it.
//
// A fake DOM, like rendercheck.mjs: no browser, no server. `charts.js` must
// survive one, which is a property this file helps hold.

const sharedPublic = (f) =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', f);

class FakeNode {
  constructor(name) { this.name = name; this.attrs = {}; this.children = []; this.text = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
  set textContent(v) { this.text = v; }
  get textContent() { return this.text; }
  walk(fn) { fn(this); for (const c of this.children) c.walk(fn); }
}

globalThis.document = {
  createElementNS: (ns, name) => new FakeNode(name),
  createElement: (name) => new FakeNode(name),
};

const { frequencyChart, historyChart, streakChart, weekdayChart, weekdayMonthChart } =
  await import(sharedPublic('charts.js'));
const { calendarWindow, weekdayIndex } = await import(sharedPublic('ui/calendar.js'));
const { estimateTextWidth, formatStamp, formatYear, gutterFor, weekdayNames } =
  await import(sharedPublic('ui/dates.js'));

let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

const collect = (svg) => { const out = []; svg.walk((n) => out.push(n)); return out; };

/* ---------- by day of week ---------- */

// Each weekday given a distinguishable completion count, indexed by getDay() —
// which is how `computeWeekdays` returns them. Sunday 0 … Saturday 6, so the
// count IS the weekday and a mispaired bar is obvious.
const days = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday, completed: weekday, total: 6,
}));

for (const weekStart of ['sunday', 'monday']) {
  const svg = weekdayChart(days, '#3b82f6', { width: 700, weekStart });
  const nodes = collect(svg);

  // The captions, left to right. Matched against the runtime's OWN short
  // names rather than an English list: `charts.js` emits `Intl` strings now, so
  // an English regex here made this whole suite fail on a non-English machine
  // while passing in CI — the opposite of what reading from `ui/dates.js` was
  // supposed to achieve.
  const shortNames = weekdayNames('short');
  const longNames = weekdayNames('long');
  // Whichever list the chart CHOSE. It prefers short and falls back to narrow
  // when short will not fit the slot, which is a decision that depends on the
  // locale: bn-IN's `বৃহস্পতি` does not fit at any card width, so a filter that
  // only recognised short names found nothing and reported the week order as
  // broken. The order is the invariant; which list carries it is not.
  const drawnNames = nodes.some((n) => n.name === 'text' && shortNames.includes(n.text ?? ''))
    ? shortNames : weekdayNames('narrow');
  const labels = nodes.filter((n) => n.name === 'text' && drawnNames.includes(n.text ?? ''))
    .map((n) => ({ x: Number(n.attrs.x), label: n.text }))
    .sort((a, b) => a.x - b.x);

  // The tooltips, which carry the weekday NAME and the count together — so a
  // caption that rotated without its data shows up as a mismatch here.
  const titles = nodes.filter((n) => n.name === 'title')
    .map((n) => n.text);

  // The ORDER is the oracle and is restated on purpose — it is the thing under
  // test. The NAMES are derived, because they are not.
  const order = weekStart === 'monday' ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  const expected = order.map((wd) => drawnNames[wd]);

  check(`${weekStart}: the captions run in the account's week order`,
    labels.map((l) => l.label).join(',') === expected.join(','),
    labels.map((l) => l.label).join(','));

  // Sunday's bar carries 0 completions, Monday's 1, and so on — the fixture
  // sets `completed = weekday`, so the COUNT is the weekday and a mispaired bar
  // is arithmetic rather than a name lookup. If the labels rotated and the bars
  // did not, this is where it shows.
  const paired = order.every((wd, i) => titles[i] === `${longNames[wd]}: ${wd}/6`);
  check(`${weekStart}: each bar carries ITS OWN weekday's count`, paired,
    titles.join(' | '));
}

/* ---------- by weekday, month by month ---------- */

// One month, each weekday row a different rate, again indexed by getDay().
const months = [{
  month: '2026-08',
  days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday, completed: weekday, total: 6, rate: weekday / 6,
  })),
}];

for (const weekStart of ['sunday', 'monday']) {
  const svg = weekdayMonthChart(months, '#3b82f6', { width: 700, weekStart });
  const titles = collect(svg).filter((n) => n.name === 'title').map((n) => n.text);

  const shortNames = weekdayNames('short');
  const longNames = weekdayNames('long');
  const order = weekStart === 'monday' ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];

  // The NAME and the NUMBER together. Checking the name alone passes when the
  // rows keep their captions and read their data positionally — which is one
  // of the mutations this suite exists to catch, and it slipped through the
  // first version of this check.
  // The month is written the way the chart writes it — `formatStamp`, the same
  // call the card's range readout uses — so this cannot pin one locale either.
  const when = formatStamp('2026-08');
  const ok = order.every((wd, r) => {
    const name = longNames[wd];
    // A rate of 0 draws the empty ring, whose title carries no percentage.
    const want = wd === 0
      ? `${when} ${name}: 0 of 6`
      : `${when} ${name}: ${wd} of 6 (${Math.round((wd / 6) * 100)}%)`;
    return titles[r] === want;
  });
  check(`${weekStart}: each row carries ITS OWN weekday's number`, ok,
    titles.join(' | '));

  // The DRAWN captions as well as the tooltips. They come from a different
  // array — the axis uses SHORT, the tooltip FULL — so checking the tooltips
  // alone leaves the visible labels free to sit beside the wrong rows, which is
  // the exact failure this file exists to catch and the first version of it
  // missed.
  // Read from `ui/dates.js` rather than restated as English literals: the
  // captions are `Intl`'s now, so a literal table would pin en-US and fail
  // anywhere else — and restating what the code says is how a mirror test comes
  // to agree with itself. The two lists are indexed by `getDay()`, which is
  // what lets a full name be turned into the caption that should sit beside it.
  //
  // Selected by POSITION and not by text. Filtering on "is this one of the
  // short weekday names" assumes no other caption on the chart can be one, and
  // in rw-RW `Kan.` is both Thursday and August — so the month caption was
  // collected as an eighth row and the check reported the week order as broken
  // on a chart that was drawing it correctly. The row captions are the
  // right-anchored texts in the left gutter; nothing else on this chart is.
  const axis = collect(svg)
    .filter((n) => n.name === 'text' && n.attrs['text-anchor'] === 'end'
      && (n.text ?? '').trim())
    .map((n) => ({ y: Number(n.attrs.y), label: n.text }))
    .sort((a, b) => a.y - b.y)
    .map((n) => n.label);
  // `order` is weekday NUMBERS, so the caption for row r is simply the short
  // name of the weekday that row is supposed to be. An earlier version kept a
  // long-name-to-short-name map and looked it up with a hardcoded English list,
  // so every lookup was `undefined` and the check compared '' with '' — passing
  // in English and failing everywhere else, for the wrong reason.
  const want = order.map((wd) => shortNames[wd]);
  check(`${weekStart}: the drawn row captions match the rows' own data`,
    axis.join(',') === want.join(','),
    `${axis.join(',')} (want ${want.join(',')})`);
}

/* ---------- the calendar's own agreement ---------- */

// The heatmap's rows are positional — `calendarWindow` decides which day a
// column opens on and the grid fills sequentially — so this asserts the
// property the rows depend on rather than re-deriving them.
for (const weekStart of ['sunday', 'monday']) {
  const { start, end } = calendarWindow('2026-08-12', 6, weekStart);
  const first = new Date(...start.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  const last = new Date(...end.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));

  check(`${weekStart}: the first cell opens the week`,
    weekdayIndex(first, weekStart) === 0, `${start} is index ${weekdayIndex(first, weekStart)}`);
  check(`${weekStart}: the last cell closes it`,
    weekdayIndex(last, weekStart) === 6, `${end} is index ${weekdayIndex(last, weekStart)}`);
}

/* ---------- the calendar's row labels ---------- */

// Two labels, over the first and third rows. They are the only part of the
// heatmap that does NOT follow the week for free — the cells are positional,
// these are not — so a fixed 'S' over row 0 captions Monday on a Monday week
// and nothing else in the suite would notice.
const { calendarChart } = await import(sharedPublic('charts.js'));

// Derived, not the English `['S','T']` / `['M','W']` that stood here: the
// captions are `Intl`'s narrow names now, so a literal pair failed on any
// non-English machine — and narrow is not even one character everywhere
// (fil-PH gives `Lin`, hu-HU `Sz`), which the filter below also has to allow.
// The ROWS are still the oracle: rows 0 and 2 of the account's week.
const narrowNames = weekdayNames('narrow');
for (const [weekStart, rows] of [['sunday', [0, 2]], ['monday', [1, 3]]]) {
  const want = rows.map((wd) => narrowNames[wd]);
  const svg = calendarChart({}, '#3b82f6',
    { type: 'boolean', target_type: 'at_least', target_value: 0 },
    { weeks: 4, endDate: '2026-08-12', weekStart });

  // The row captions are the texts at x=0, and they are whatever `narrow` is
  // in this locale — not necessarily one character.
  const labels = collect(svg)
    .filter((n) => n.name === 'text' && n.attrs.x === '0'
      && narrowNames.includes(n.text ?? ''))
    .map((n) => n.text);

  check(`${weekStart}: the calendar's row labels name the rows drawn`,
    labels.join(',') === want.join(','), `${labels.join(',')} (want ${want.join(',')})`);
}

/* ---------- a label is written for a person, and fits where it is drawn ---------- */

// Two properties a browser measurement caught and no test did.
//
// The FIRST is that an axis must not show a storage key. `detail.js` formats a
// card's range readout, and these draw the same values — so leaving one raw put
// the header and the axis of ONE card into two conventions, which is the
// specific defect this whole change exists to remove.
//
// The SECOND is that the label has to fit. `Intl`'s short weekday is `Mon` in
// English, `domingo` in pt-PT and `Jumamosi` in sw-KE, and a fixed gutter
// clipped the last two mid-word — measured in Chrome, pt-PT rendered `omingo`.
// The charts size their gutter with `estimateTextWidth`, and the invariant is
// simply that the estimate fits: a right-anchored label at `x` needs `x` pixels
// of room to its left.
const RAW_KEY = /^\d{4}(-\d{2}){1,2}$/;

/** The bucket key inside a label or a tooltip, whole or embedded. */
const keyIn = (text) => {
  if (RAW_KEY.test(text)) return text;
  const m = text.match(/(?:^|\s)(\d{4}-\d{2}(?:-\d{2})?)(?=\s|:|$)/);
  return m ? m[1] : null;
};

const axisTexts = (svg) => collect(svg)
  .filter((n) => n.name === 'text' && (n.text ?? '').trim())
  .map((n) => ({
    text: String(n.text),
    x: Number(n.attrs.x),
    anchor: n.attrs['text-anchor'],
    // Read from the node, not assumed: these charts draw at 9.5 and 10.5, and
    // estimating a 9.5px label at 10.5 reported a percentage axis as 4px short
    // when it fits.
    size: Number(n.attrs['font-size']) || 10.5,
  }));

const buckets = ['2026-06', '2026-07', '2026-08'].map((bucket) => ({
  bucket, completed: 2, total: 4, value: 0, skipped: 0,
}));

for (const [name, svg] of [
  ['history', historyChart(buckets, '#3b82f6', { width: 700 })],
  ['times per week', frequencyChart(
    buckets.map((b) => ({ month: b.bucket, counts: { 3: 2 } })), '#3b82f6', { width: 700 })],
  ['weekday by month', weekdayMonthChart(months, '#3b82f6', { width: 700, weekStart: 'monday' })],
]) {
  // `<title>` too, not only `<text>`. A first version looked at drawn labels
  // alone and walked straight past the one tooltip the conversion missed —
  // a bubble reading `2026-06: 2 week(s)…` eight pixels from a row label
  // reading `Jun 2026`.
  const texts = axisTexts(svg);
  const tooltips = collect(svg)
    .filter((n) => n.name === 'title' && (n.text ?? '').trim())
    .map((n) => ({ text: String(n.text) }));
  const raw = [...texts, ...tooltips]
    .map((t) => ({ t, key: keyIn(t.text) }))
    // A text is only a raw key if it CONTAINS one that this locale would have
    // written differently. Both halves matter. `formatStamp` passes through
    // whatever it does not recognise, so excusing any text it maps to itself
    // excuses every multi-word string — which silently retires the embedded
    // branch this check exists for, the one that catches a TOOLTIP reading
    // `2026-06: 2 week(s)`. And in lt-LT `formatStamp('2026-08')` IS `2026-08`,
    // the locale's correct `yMMM`, so the key must be compared with its own
    // formatting rather than assumed to be a storage leak.
    .filter(({ key }) => key !== null && formatStamp(key) !== key)
    .map(({ t }) => t)
    .map((t) => t.text);
  check(`${name}: no label or tooltip shows a raw storage key`,
    raw.length === 0, raw.slice(0, 3).join(' | '));

  // Right-anchored labels are the row gutters; `x` is where they END.
  //
  // NOT filtered on `x > 0`, which is how the first version of this passed
  // vacuously: moving a caption to `x: 0` draws it entirely outside the chart,
  // invisible, and simply removed it from the set being checked. A label at 0
  // needs its whole width and has none, so it fails — which is the answer.
  const tight = texts
    .filter((t) => t.anchor === 'end')
    .filter((t) => estimateTextWidth(t.text, t.size) > t.x)
    .map((t) => `${t.text} needs ${Math.ceil(estimateTextWidth(t.text, t.size))}px `
      + `at ${t.size}px, has ${t.x}`);
  check(`${name}: every row label fits its gutter`, tight.length === 0, tight.join(' | '));
}

// The gutter WIRING, which the fits-its-gutter check cannot see in English:
// `Mon` clears a fixed 42px, so reverting `weekdayMonthChart` to one is
// invisible here and clips in pt-PT. Asserting the drawn position IS what
// `gutterFor` computes pins it in any locale, including the one CI runs in.
for (const [name, svg, labels, size, floor] of [
  ['weekday by month', weekdayMonthChart(months, '#3b82f6', { width: 700, weekStart: 'monday' }),
    weekdayNames('short'), 10.5, 42],
  ['times per week', frequencyChart(
    buckets.map((b) => ({ month: b.bucket, counts: { 3: 2 } })), '#3b82f6', { width: 700 }),
  buckets.map((b) => formatStamp(b.bucket)), 10.5, 58],
]) {
  const GAP = 8;
  const xs = axisTexts(svg).filter((t) => t.anchor === 'end' && t.size === size)
    .map((t) => t.x);
  check(`${name}: the gutter is the one gutterFor computes`,
    xs.length > 0 && xs.every((x) => x === gutterFor(labels, size, floor, GAP) - GAP),
    `x=${[...new Set(xs)].join(',')} want ${gutterFor(labels, size, floor, GAP) - GAP}`);
}

// Seven captions across one card cannot grow to fit, so `weekdayChart` picks a
// label that does — short where it fits, narrow where it does not, and a
// smaller type size where neither does.
//
// The widths are the ones a card is actually rendered at (`responsive.mjs`
// covers 360/390/768/1440 viewports, which give these inner widths). An
// earlier version asserted this at 160px on the reasoning that even `Mon`
// cannot fit a slot there, so the fallback would be exercised in ENGLISH —
// a good instinct that pinned a claim the chart could not meet: at 160px the
// narrow names do not fit EITHER in ca-ES (`dl. dt. dc.`), vi-VN (`T2 T3`),
// fil-PH (`Lin Lun`) or five Indic locales, so it failed in 8 of the 14
// locales it was run in while the product was correct at every width it is
// actually drawn at. Shrinking the type is what the chart was missing, and it
// takes 160px from 8 failing locales to 2 — but ml-IN `\u0D35\u0D4D\u0D2F\u0D3E` and si-LK
// `\u0DB6\u0DCA\u200D\u0DBB` are four-codepoint conjuncts that do not fit a 20px slot at a
// legible size at all, and a 6px caption is not a fix for a 7px one. So the
// no-overlap claim is made at the widths a card is drawn at, and 160px keeps
// the weaker claim below: degrade, but do not drop a day.
for (const width of [328, 358, 700, 1100]) {
  const svg = weekdayChart(days, '#3b82f6', { width, weekStart: 'monday' });
  const drawn = axisTexts(svg)
    .filter((t) => t.anchor === 'middle')
    .sort((a, b) => a.x - b.x);
  const clash = drawn.slice(1).filter((t, i) =>
    t.x - drawn[i].x
      < (estimateTextWidth(t.text, t.size) + estimateTextWidth(drawn[i].text, t.size)) / 2);
  check(`weekday axis at ${width}px: captions do not overlap`,
    drawn.length === 7 && clash.length === 0,
    `${drawn.map((t) => t.text).join(',')} — ${clash.length} clashing`);
}

// The fallback itself: squeezed to a width no card uses, the chart still draws
// all seven captions — a weekday axis that labels four of seven days is one you
// have to count along — and reaches that by shortening the label or shrinking
// the type, whichever this locale needs. In English the narrow names are single
// characters and already fit, so nothing shrinks; that is the point of asserting
// the OUTCOME rather than the mechanism.
{
  const tight = axisTexts(weekdayChart(days, '#3b82f6', { width: 160, weekStart: 'monday' }))
    .filter((t) => t.anchor === 'middle');
  check('weekday axis: all seven captions survive being squeezed',
    tight.length === 7, `${tight.length} captions`);
}

// A long axis label, without needing a locale that has one. `formatStamp`
// passes an unrecognised key through verbatim, so this exercises the branch
// where the history axis's old fixed 62px budget overlapped — measured in
// pt-BR at a phone-width card, and invisible in English.
{
  // Twelve, not three: with only a handful the slots are so wide that no budget
  // can overlap them, and the check passes for the wrong reason. A year of
  // months is what the chart actually draws.
  const wide = Array.from({ length: 12 }, (_, i) => ({
    bucket: `a-very-long-bucket-label-${i}`,
    completed: 1, total: 2, value: 0, skipped: 0,
  }));
  const svg = historyChart(wide, '#3b82f6', { width: 700 });
  const drawn = axisTexts(svg)
    .filter((t) => t.anchor === 'middle' && wide.some((b) => b.bucket === t.text))
    .sort((a, b) => a.x - b.x);
  const overlaps = drawn.slice(1).filter((t, i) =>
    t.x - drawn[i].x < (estimateTextWidth(t.text, t.size) + estimateTextWidth(drawn[i].text, t.size)) / 2);
  check('history: long axis labels are thinned rather than overlapped',
    overlaps.length === 0,
    `${drawn.length} drawn, ${overlaps.length} overlapping`);
}

/* ---------- a year is a field of the date, like the month ---------- */
//
// The month captions went through `Intl` and the YEAR under them did not: it
// was `String(yy)`, the Gregorian number, printed beneath a localised month
// name. In fa-IR that is `\u0645\u0631\u062f\u0627\u062f` above `2026` while this same chart's tooltip
// says `\u0645\u0631\u062f\u0627\u062f \u06f1\u06f4\u06f0\u06f5` — one column, two calendars, 621 years apart, which is
// the defect the whole change is named after, relocated one chart over.
//
// Asserted against `Intl` given the same date, so it holds in every calendar
// rather than in en-US, where a Gregorian number happens to be right.
{
  const months = ['2026-11', '2026-12', '2027-01', '2027-02'].map((month) => ({
    month, days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) =>
      [d, { completed: 1, total: 2 }])),
  }));
  const svg = weekdayMonthChart(months, '#3b82f6', { width: 700, weekStart: 'monday' });
  const wantYears = new Set(months.map((m) =>
    formatYear(new Date(Number(m.month.slice(0, 4)), Number(m.month.slice(5, 7)) - 1, 15))));
  const drawn = collect(svg)
    .filter((n) => n.name === 'text' && n.attrs.y === '22' && (n.text ?? '').trim())
    .map((n) => String(n.text));
  check('the year caption is this calendar\'s year, not the Gregorian one',
    drawn.length > 0 && drawn.every((t) => wantYears.has(t)),
    `${drawn.join(',')} (want one of ${[...wantYears].join(',')})`);
}

/* ---------- a streak's date range fits beside its bar ---------- */
//
// `LABEL_W` was a fixed 168 with the comment `room for "12 Mar \u2013 24 Mar"`,
// written when the label was English. Localised, lv-LV's medium range is
// 223.6px and painted 47.6px across the bar. A first fix asked `gutterFor` for
// the width and was WORSE — its ceiling worked out below its floor on a phone,
// so the measurement was discarded and the gap subtracted, leaving 8px less
// than the fixed number. Nothing caught either, in any locale.
//
// The property is simply that the widest label ends before the bar begins, at
// every width a card is drawn at.
{
  const streaks = [
    { start: '2025-12-28', end: '2026-01-04', length: 8 },
    { start: '2026-04-21', end: '2026-05-18', length: 28 },
  ];
  for (const width of [328, 358, 700, 1100]) {
    const svg = streakChart(streaks, '#8b5cf6', { width });
    const nodes = collect(svg);
    const barX = Math.min(...nodes.filter((n) => n.name === 'rect')
      .map((n) => Number(n.attrs.x)));
    const labels = nodes.filter((n) => n.name === 'text'
      && n.attrs['text-anchor'] !== 'end' && !/^\d+$/.test(n.text ?? ''));
    const left = Math.min(...labels.map((n) => Number(n.attrs.x)));
    const widest = Math.max(0, ...labels.map((n) =>
      estimateTextWidth(String(n.text), Number(n.attrs['font-size']))));
    check(`streaks at ${width}px: the date range ends before the bar starts`,
      labels.length > 0 && left + widest <= barX,
      `label ends ${(left + widest).toFixed(1)}, bar starts ${barX} `
      + `(${labels.length ? JSON.stringify(labels[0].text) : 'none'})`);

    // ...with a GAP, and never in less room than the fixed 168 this replaced.
    //
    // Both are invisible to the check above, which the shrink loop can always
    // satisfy by making the type smaller: deleting the floor gives 148.5px on
    // a phone — 19.5px worse than master, the exact defect this was written
    // for — and it stayed green in 9 of 10 locales. A label butted against its
    // own bar did too.
    check(`streaks at ${width}px: the gutter is at least what it always was`,
      barX - left >= 168, `${barX - left}px`);
    check(`streaks at ${width}px: the label does not butt against the bar`,
      barX - (left + widest) >= 4, `${(barX - left - widest).toFixed(1)}px of gap`);
  }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL WEEK CHECKS PASSED');
process.exit(fails ? 1 : 0);
