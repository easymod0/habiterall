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
const { estimateTextWidth, formatMonthShort, formatStamp, formatYear, gutterFor,
  weekdayNames } =
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

/* ---------- the calendar's month captions name the column they sit over ---------- */

// The sixth appearance of "a localised name indexed by a Gregorian field", and
// the one the new source scanner cannot see: the caption's TEXT comes from
// `Intl` and its POSITION came from `cursor.getMonth() !== lastMonth`, which is
// a comparison rather than a text sink. In en-US the two agree, so this is
// green in the runner's locale and the sweep is what makes it mean anything —
// `locales.mjs` runs this file under fa_IR, where a Persian month does not
// start on the Gregorian first. Measured against the unfixed code over 30
// weeks from 2026-01-04: `بهمن` above week 4 against a real week 2, `اسفند`
// above week 8 against week 6, `فروردین` above week 13 against week 10.
//
// The oracle is the grid itself rather than a table of expected names: a
// caption belongs above the first week column whose opening day `Intl` calls
// by that month name. That phrasing is what makes the check locale-agnostic —
// it asserts the two halves AGREE, which is the failure mode, rather than
// asserting what either one says.
{
  const WEEKS = 30;
  const END = '2026-07-25';
  const weekStart = 'monday';
  const svg = calendarChart({}, '#3b82f6',
    { type: 'boolean', target_type: 'at_least', target_value: 0 },
    { weeks: WEEKS, endDate: END, weekStart });

  // Rebuild the column dates the chart walked, from the same window helper it
  // uses — so this cannot drift from the grid by re-deriving the start.
  const { start } = calendarWindow(END, WEEKS, weekStart);
  const [sy, sm, sd] = start.split('-').map(Number);
  const columnOpens = [];
  for (let wk = 0; wk < WEEKS; wk++) {
    columnOpens.push(new Date(sy, sm - 1, sd + wk * 7));
  }

  // What the captions SHOULD be: walk the columns, and caption one whenever
  // the formatted month name differs from the last one captioned.
  const wanted = [];
  let seen = null;
  columnOpens.forEach((d, wk) => {
    const text = formatMonthShort(d);
    if (text !== seen) { seen = text; wanted.push({ wk, text }); }
  });

  // What was drawn. The month captions are the 9.5px texts on the top line;
  // the row labels sit at x=0 with a different y, and the '?' marks are a
  // different size, so the y is what identifies this row.
  const drawn = collect(svg)
    .filter((n) => n.name === 'text' && n.attrs['font-size'] === '9.5'
      && n.attrs.y === '9')
    .map((n) => n.text);

  check('the calendar captions one column per month name',
    drawn.length === wanted.length,
    `drew ${drawn.length} (${drawn.join(',')}), wanted ${wanted.length} (${wanted.map((w) => w.text).join(',')})`);

  check('and each caption names the month its column opens in',
    drawn.join('|') === wanted.map((w) => w.text).join('|'),
    `${drawn.join(',')} vs ${wanted.map((w) => w.text).join(',')}`);

  // The clamp keeps the last caption inside the viewBox, and must not push it
  // FURTHER than that. `WIDTH_SAFETY` here cost displacement rather than
  // pixels — the same defect `weekdayMonthChart`'s clamp comment records, one
  // chart over — and it is only visible when the clamp actually binds, which
  // is when the final column opens a month. A window is searched for that
  // case rather than assumed, because whether it arises depends on the length
  // of the month names and so on the locale: pinning a fixed `weeks` would
  // pass vacuously wherever it did not bind, which is how a clamp test comes
  // to assert nothing at all.
  // The END is what moves, not `weeks`: the window is anchored on its end, so
  // the final column opens the same week whatever the width — which is also
  // the trap that makes a naive search here find nothing and pass.
  let bound = null;
  for (let off = 0; off < 70 && !bound; off++) {
    const cand = new Date(2026, 0, 5 + off);
    const candISO = `${cand.getFullYear()}-${String(cand.getMonth() + 1).padStart(2, '0')}-${String(cand.getDate()).padStart(2, '0')}`;
    const w2 = calendarWindow(candISO, 12, weekStart);
    const [y2, m2, d2] = w2.start.split('-').map(Number);
    const lastOpen = new Date(y2, m2 - 1, d2 + 11 * 7);
    const prevOpen = new Date(y2, m2 - 1, d2 + 10 * 7);
    if (formatMonthShort(lastOpen) === formatMonthShort(prevOpen)) continue;

    const s2 = calendarChart({}, '#3b82f6',
      { type: 'boolean', target_type: 'at_least', target_value: 0 },
      { weeks: 12, endDate: candISO, weekStart });
    const caps = collect(s2)
      .filter((n) => n.name === 'text' && n.attrs['font-size'] === '9.5'
        && n.attrs.y === '9');
    bound = { endISO: candISO, cap: caps[caps.length - 1], width: Number(s2.attrs.width) };
  }

  if (bound) {
    const w = estimateTextWidth(bound.cap.text, 9.5);
    const edge = bound.width - w;
    // Exactly at the edge. With the margin applied the caption sits a further
    // `w * 0.25` px left of it — for `أغسطس` at 9.5px that is ~7.4px, about
    // half a column, on a caption whose whole job is to name one column.
    check('the last month caption is clamped to the edge, not past it',
      Math.abs(Number(bound.cap.attrs.x) - edge) < 0.51,
      `${bound.cap.text}@${bound.cap.attrs.x}, edge at ${edge.toFixed(1)} (end=${bound.endISO})`);
  } else {
    check('a window was found where the last caption clamps', false,
      'no end date in 70 tried put a month opening on the final column');
  }
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
//
// Two widths, and the narrow one is the point. The charts pass a CEILING of
// `width * 0.32`, and at 700px that is 224 — far above anything a weekday name
// needs, so the argument was simply omitted here and the assertion still
// passed. It was then not the call the chart makes: at 328px the ceiling binds
// in ten locales, and what it does when it binds was pinned by nothing.
for (const width of [700, 328]) {
for (const [name, svg, labels, size, floor] of [
  ['weekday by month', weekdayMonthChart(months, '#3b82f6', { width, weekStart: 'monday' }),
    weekdayNames('short'), 10.5, 42],
  ['times per week', frequencyChart(
    buckets.map((b) => ({ month: b.bucket, counts: { 3: 2 } })), '#3b82f6', { width }),
  buckets.map((b) => formatStamp(b.bucket)), 10.5, 58],
]) {
  const GAP = 8;
  const CEILING = width * 0.32;
  const xs = axisTexts(svg).filter((t) => t.anchor === 'end' && t.size === size)
    .map((t) => t.x);
  check(`${name} at ${width}px: the gutter is the one gutterFor computes`,
    xs.length > 0
      && xs.every((x) => x === gutterFor(labels, size, floor, GAP, CEILING) - GAP),
    `x=${[...new Set(xs)].join(',')} `
    + `want ${gutterFor(labels, size, floor, GAP, CEILING) - GAP}`);
}
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

// ...and it does not give up a name it could have DRAWN. The check above only
// asks that nothing overlaps, which a chart that always fell back to narrow
// would satisfy perfectly while naming no day — `S T Q Q S S D` in pt-PT has
// three S's and two Q's, and an axis you have to count along is what the
// comment above calls the failure. So: wherever the short names fit, they are
// what is drawn.
//
// This is the assertion the `WIDTH_SAFETY` rule turns on, and it is invisible
// in English — `Mon` fits every slot at every width, so the margin changes
// nothing here. It bites in pt-PT, where `segunda` fits from about 360px and
// the margin pushed the crossover to 438: the locale sweep is what runs it
// there, which is why this check lives in a suite that sweep includes.
for (const width of [328, 358, 700, 1100]) {
  const shortNames = weekdayNames('short');
  const svg = weekdayChart(days, '#3b82f6', { width, weekStart: 'monday' });
  const drawn = axisTexts(svg).filter((t) => t.anchor === 'middle');
  const size = drawn[0]?.size ?? 11;

  // The slot the chart itself computes: the plot width over seven. READ off
  // the rendered gridlines rather than re-declared here — a copy of
  // `weekdayChart`'s padding is a mirror that fails quiet, since a change to
  // the real one would leave this computing a slot the chart is not using and
  // the check would either skip itself or assert against the wrong threshold.
  // The gridlines span exactly the plot, which is what `slot` is seven of.
  const rules = collect(svg).filter((n) => n.name === 'line');
  const plot = Math.max(...rules.map((n) => Number(n.attrs.x2) - Number(n.attrs.x1)));
  const slot = plot / 7;
  const shortFits = shortNames.every((t) => estimateTextWidth(t, size) <= slot);

  if (shortFits) {
    check(`weekday axis at ${width}px: the short names are used where they fit`,
      drawn.every((t) => shortNames.includes(t.text)),
      `slot ${slot.toFixed(1)}px, drew ${drawn.map((t) => t.text).join(',')}`);
  }
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

// The fit decision and the paint size are ONE number, not two that happen to
// agree today. `weekdayChart`'s shrink loop (charts.js ~1250-1280) decides
// whether a label fits at the size it is about to draw IN THE SAME CALL —
// `fits(SHORT, labelSize)` — and the comment on `AXIS_SIZE` names the bug that
// shape closes: "measure at 10 and paint at 11" chose a label for text smaller
// than what actually gets drawn, which fits in English regardless and clips
// elsewhere. Importing `AXIS_SIZE` and comparing it to itself would pass with
// the two calls split back onto different literals, because nothing forces a
// caller to use what it imports — so this reaches for the failure itself: a
// slot is picked to sit exactly at the narrow names' width AT FONT-SIZE 10 (it
// fits there, and not at 11), so a build that ever checks fit at a smaller
// size than the one about to be painted draws a caption past the edge of its
// own slot, measurably, in the DOM this produces.
//
// `10` and `11` are `charts.js`'s own literals, mirrored here rather than
// imported — `AXIS_SIZE` is not exported, and the point is to know what the
// chart is SUPPOSED to paint at independent of whatever it actually reads
// internally.
{
  const AXIS_SIZE = 11;
  const narrowNames = weekdayNames('narrow');
  const shortNames = weekdayNames('short');
  const narrowAt10 = Math.max(...narrowNames.map((t) => estimateTextWidth(t, 10)));
  const shortAtAxis = Math.max(...shortNames.map((t) => estimateTextWidth(t, AXIS_SIZE)));

  if (!(shortAtAxis > narrowAt10) || narrowAt10 <= 0) {
    // Not a vacuous pass: say plainly that this locale could not build the
    // boundary, rather than silently skipping it.
    check('a fit-at-10/paint-at-11 boundary could be constructed for this locale',
      false, `short@${AXIS_SIZE}=${shortAtAxis.toFixed(2)} vs narrow@10=${narrowAt10.toFixed(2)}`);
  } else {
    // Just past the narrow names' width at 10 — fits there, not at 11 (10%
    // more, since `estimateTextWidth` is linear in font size).
    const targetSlot = narrowAt10 + 0.01;
    // `weekdayChart`'s own padding (`left: 34, right: 12`) turned into a width
    // that lands this slot — verified below from the chart's OWN gridlines
    // rather than trusted, since a pad change elsewhere would silently move
    // the boundary this test relies on.
    const guessWidth = targetSlot * 7 + 34 + 12;
    const probe = weekdayChart(days, '#3b82f6', { width: guessWidth, weekStart: 'monday' });
    const rules = collect(probe).filter((n) => n.name === 'line');
    const plot = Math.max(...rules.map((n) => Number(n.attrs.x2) - Number(n.attrs.x1)));
    const slot = plot / 7;

    check('the probe width lands the slot at the intended fit/paint boundary',
      Math.abs(slot - targetSlot) < 0.1, `slot=${slot.toFixed(3)} want ${targetSlot.toFixed(3)}`);

    const drawn = axisTexts(probe).filter((t) => t.anchor === 'middle');
    const overflow = drawn.filter((t) => estimateTextWidth(t.text, t.size) > slot + 0.02);
    check('weekday axis: a label is measured at the size it is actually painted',
      drawn.length === 7 && overflow.length === 0,
      overflow.map((t) =>
        `"${t.text}"@${t.size} needs ${estimateTextWidth(t.text, t.size).toFixed(2)}, slot ${slot.toFixed(2)}`
      ).join(' | '));
  }
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

// The NEWEST column keeps its month caption, whatever has to go to make room.
//
// The drop is a left-to-right walk that skips whatever collides with the last
// caption drawn, and at the right-hand edge that is always the newest month —
// the one a reader is looking at. Measured at a 328px card with twelve
// columns, en-US drew `Jan Mar May Jul Sep Nov` and no December, under a
// comment saying "the first and last are the two that orient a reader".
//
// This bites in ENGLISH, which is what makes it worth having here rather than
// only in the locale sweep: the labels are three Latin characters and the
// column is 22px, so the collision is real at every width a phone uses.
{
  const twelveFrom = (year, month) => {
    const out = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(year, month + i, 15);
      out.push({
        month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday, completed: weekday, total: 6, rate: weekday / 6,
        })),
      });
    }
    return out;
  };

  // Two windows, because they ask different questions. A calendar year puts
  // the year caption on the FIRST column, which is never thinned — so it can
  // say nothing about a year left standing over a dropped one. A window across
  // the boundary puts it in the middle, where the thinning reaches it.
  for (const [what, start] of [['a calendar year', [2026, 0]],
                               // August, not July: the year then changes at an ODD
                               // column, which is one the thinning drops at 328px.
                               // Starting in July put January on an even column,
                               // where a year caption survives by luck and the
                               // check below cannot fail.
                               ['a year boundary', [2025, 7]]]) {
  const twelve = twelveFrom(start[0], start[1]);
  const first = new Date(start[0], start[1], 15);
  const last = new Date(start[0], start[1] + 11, 15);
  const lastMonth = formatMonthShort(last);
  const firstMonth = formatMonthShort(first);

  for (const width of [328, 358, 390, 700]) {
    const svg = weekdayMonthChart(twelve, '#3b82f6', { width, weekStart: 'monday' });
    const caps = collect(svg)
      .filter((n) => n.name === 'text' && n.attrs['font-size'] === '9.5')
      .map((n) => n.text);

    check(`month captions at ${width}px over ${what}: the newest month is named`,
      caps[caps.length - 1] === lastMonth,
      `drew ${caps.length}/12, ending ${JSON.stringify(caps[caps.length - 1])}`);
    check(`month captions at ${width}px over ${what}: and so is the oldest`,
      caps[0] === firstMonth, JSON.stringify(caps[0]));

    // Thinning is the point, so it must still thin — a check that only asked
    // for the last caption would pass on a chart that drew all twelve on top
    // of each other.
    const drawn = collect(svg)
      .filter((n) => n.name === 'text' && n.attrs['font-size'] === '9.5');
    const overlaps = drawn.slice(1).filter((n, i) => {
      const prev = drawn[i];
      const prevRight = Number(prev.attrs.x) + estimateTextWidth(prev.text, 9.5) / 2;
      return Number(n.attrs.x) - estimateTextWidth(n.text, 9.5) / 2 < prevRight;
    });
    check(`month captions at ${width}px over ${what}: none overlaps its neighbour`,
      overlaps.length === 0, overlaps.map((n) => n.text).join(','));

    // A year with no month above it labels nothing — it reads as a caption for
    // the column rather than for the run of them.
    const years = collect(svg)
      .filter((n) => n.name === 'text' && n.attrs['font-size'] === '8.5');
    const captionXs = new Set(drawn.map((n) => n.attrs.x));
    check(`month captions at ${width}px over ${what}: no year stands over an unnamed column`,
      years.every((y) => captionXs.has(y.attrs.x)),
      years.map((y) => `${y.text}@${y.attrs.x}`).join(' '));
  }
  }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL WEEK CHECKS PASSED');
process.exit(fails ? 1 : 0);
