
import { fileURLToPath as _f2u } from 'node:url';
import { dirname as _dn, join as _jn } from 'node:path';
import { pathToFileURL as _p2u } from 'node:url';
/** Resolve a module in shared/public relative to this file, not the cwd. */
const sharedPublic = (name) =>
  _p2u(_jn(_dn(_f2u(import.meta.url)), '..', '..', 'public', name)).href;
// Render streakChart in a minimal fake DOM and inspect the SVG it produces.
// Verifies the chart code actually runs and emits sane geometry/labels.

const NS = 'http://www.w3.org/2000/svg';

class FakeNode {
  constructor(name) { this.name = name; this.attrs = {}; this.children = []; this.text = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
  set textContent(v) { this.text = v; }
  get textContent() { return this.text; }
  toXML(indent = '') {
    const a = Object.entries(this.attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
    const open = `${indent}<${this.name}${a ? ' ' + a : ''}>`;
    if (this.text != null && !this.children.length) return `${open}${this.text}</${this.name}>`;
    if (!this.children.length) return `${open}</${this.name}>`;
    return [open, ...this.children.map(c => c.toXML(indent + '  ')), `${indent}</${this.name}>`].join('\n');
  }
  walk(fn) { fn(this); for (const c of this.children) c.walk(fn); }
}

// Deliberately without `getComputedStyle` or a themed `documentElement`.
// `charts.js` used to read the palette through both and write the answer into
// the SVG, which is the staleness this fake now guards against: reintroduce
// either and this suite crashes rather than quietly passing.
globalThis.document = {
  createElementNS: (ns, name) => new FakeNode(name),
  createElement: (name) => new FakeNode(name),
};

const { streakChart, calendarChart } = await import(sharedPublic('charts.js'));
const { formatDayRange, fromISOLocal } = await import(sharedPublic('ui/dates.js'));

let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

/* --- realistic streak set, unsorted on purpose --- */
const streaks = [
  { start: '2026-03-04', end: '2026-03-20', length: 17 },
  { start: '2026-04-21', end: '2026-05-18', length: 28 },
  { start: '2026-06-03', end: '2026-06-15', length: 13 },
  { start: '2026-07-13', end: '2026-08-01', length: 20 },
  { start: '2026-06-30', end: '2026-07-11', length: 12 },
  { start: '2026-01-02', end: '2026-01-04', length: 3 },
  { start: '2026-02-09', end: '2026-02-09', length: 1 },
];

const svg = streakChart(streaks, '#8b5cf6', { limit: 5 });

const texts = [];
const rects = [];
svg.walk(n => { if (n.name === 'text') texts.push(n.text); if (n.name === 'rect') rects.push(n); });

console.log('--- text content ---');
texts.forEach(t => console.log('   ', JSON.stringify(t)));

// 1. exactly `limit` rows rendered
const lengthLabels = texts.filter(t => /^\d+$/.test(t));
check('renders exactly 5 rows', lengthLabels.length === 5, lengthLabels.join(','));

// 2. selected by length, then listed newest first.
//    Two different questions: which runs to show, and how to order them. A
//    list ordered by length reads as a leaderboard and hides whether the good
//    runs were recent.
check('the five longest were selected',
  JSON.stringify([...lengthLabels].sort((a,b)=>b-a)) === JSON.stringify(['28','20','17','13','12']),
  lengthLabels.join(','));

// The ORDER is the property under test; the label's SHAPE is `Intl`'s
// business. Earlier versions of these checks read the year out of the string
// with `/\d{4}/` and split on a dash — both English assumptions, and both
// wrong where it matters: fa-IR's year is 1405, th-TH's 2569, ar-EG writes its
// digits as `٢٠٢٦`, and ja-JP puts the year first. So the expectation is
// COMPUTED with the same helper the chart uses, and what is asserted is that
// the chart drew those labels in that order.
const wantRows = [...streaks].sort((a, b) => b.length - a.length).slice(0, 5)
  .sort((a, b) => b.end.localeCompare(a.end))
  .map((s) => formatDayRange(fromISOLocal(s.start), fromISOLocal(s.end)));
const rowDates = texts.filter((t) => wantRows.includes(t));
check('rows are ordered newest first',
  JSON.stringify(rowDates) === JSON.stringify(wantRows),
  `${rowDates.join(' | ')}\n     want ${wantRows.join(' | ')}`);

// 3. the range is `Intl`'s to compose. Two earlier versions of this got the
//    property wrong in opposite directions: "strictly SHORTER than both ends
//    written out" is English's behaviour (`Intl` elides nothing in a numeric
//    locale, so pt-PT's `21/04/2026 – 18/05/2026` failed on being right), and
//    "never longer" is Western Europe's — es-MX writes
//    `21 de abr – 18 de may 2026`, which is LONGER than the naive join
//    because `formatRange` adds connectors the plain format omits. It also
//    pinned nothing: hand-composing the range passed it.
//
//    So what is asserted is delegation itself. It is a mirror of one line of
//    the implementation, deliberately — the defect it guards is someone
//    reaching for `${a} – ${b}` again, and no property of the OUTPUT survives
//    contact with 85 locales.
{
  const a = fromISOLocal('2026-04-21');
  const b = fromISOLocal('2026-05-18');
  const f = new Intl.DateTimeFormat(undefined,
    { year: 'numeric', month: 'short', day: 'numeric' });
  const label = formatDayRange(a, b);
  check('a date range is composed by Intl, not by us',
    texts.includes(label) && label === f.formatRange(a, b),
    `${label} vs ${f.formatRange(a, b)}`);
}

// 4. bar widths proportional and within bounds
const bars = rects.filter(r => r.attrs.fill === '#8b5cf6');
check('one bar per row', bars.length === 5, String(bars.length));
const widths = bars.map(b => Number(b.attrs.width));
// Bars scale to the longest row SHOWN, wherever it sits in the list. The
// scale used to come from top[0], which stopped being the longest the moment
// the ordering changed to date order.
const longestIdx = lengthLabels.indexOf(String(Math.max(...lengthLabels.map(Number))));
check('the widest bar is the longest streak',
  Math.max(...widths) === widths[longestIdx],
  widths.map(w=>w.toFixed(0)).join(','));
check('bar widths track streak lengths',
  widths.every((w, i) => {
    const ratio = w / Math.max(...widths);
    const expect = Number(lengthLabels[i]) / Math.max(...lengthLabels.map(Number));
    return Math.abs(ratio - expect) < 0.02;
  }), widths.map(w=>w.toFixed(0)).join(',') + ' vs ' + lengthLabels.join(','));

const W = Number(svg.attrs.width);
check('no bar overflows the canvas',
  bars.every(b => Number(b.attrs.x) + Number(b.attrs.width) <= W), `width=${W}`);
check('no negative geometry',
  rects.every(r => Number(r.attrs.width) >= 0 && Number(r.attrs.height) >= 0));

// 5. height scales to row count
check('height fits 5 rows', Number(svg.attrs.height) === 6 + 5*30 + 6, svg.attrs.height);

// 6. tooltips
const titles = [];
svg.walk(n => { if (n.name === 'title') titles.push(n.text); });
check('every bar has a tooltip', titles.length === 5, String(titles.length));
// The dates are written, not ISO — the row beside them is too, and one card
// showing both conventions is what this change exists to end. Asserted as "it
// names two dates and a length" rather than by matching a locale's format.
check('tooltip names a length and two dates',
  /\d+ days: .+ to .+/.test(titles[0] ?? ''), titles[0] ?? '');

/* --- edge cases --- */
const empty = streakChart([], '#8b5cf6', { limit: 5 });
const emptyTexts = [];
empty.walk(n => { if (n.name === 'text') emptyTexts.push(n.text); });
check('empty state renders a message', emptyTexts.some(t => /No completed streaks/.test(t)),
  emptyTexts.join('|'));
check('empty state has non-zero height', Number(empty.attrs.height) > 0, empty.attrs.height);

const one = streakChart([{ start: '2026-02-09', end: '2026-02-09', length: 1 }], '#8b5cf6');
const oneTexts = [];
one.walk(n => { if (n.name === 'text') oneTexts.push(n.text); });
// One date, not the same date twice with a dash between it.
{
  const want = new Intl.DateTimeFormat(undefined,
    { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(2026, 1, 9));
  check('single-day streak shows one date', oneTexts.includes(want),
    `${oneTexts.join('|')} (want ${want})`);
}

const spanning = streakChart([{ start: '2026-12-28', end: '2027-01-04', length: 8 }], '#8b5cf6');
const spanTexts = [];
spanning.walk(n => { if (n.name === 'text') spanTexts.push(n.text); });
// Both years, whatever the calendar calls them — and only when the calendar
// AGREES that two are involved. `formatToParts` reads the year, because ja-JP
// and zh-CN write it `2026年` and a substring match on `2026` misses it.
//
// The interesting case is fa-IR, where this range does not span two years at
// all: 2026-12-28 and 2027-01-04 both fall inside Persian 1405. "Spanning the
// new year" is a Gregorian claim, so it is asked of the calendar rather than
// assumed, and where the answer is no, what must hold instead is that the
// range still names two different days.
{
  const yearOf = (d) => new Intl.DateTimeFormat(undefined, { year: 'numeric' })
    .formatToParts(d).find((p) => p.type === 'year')?.value ?? '';
  const a = yearOf(fromISOLocal('2026-12-28'));
  const b = yearOf(fromISOLocal('2027-01-04'));
  const label = spanTexts.find((t) => t !== '8') ?? '';
  const oneDay = formatDayRange(fromISOLocal('2026-12-28'), fromISOLocal('2026-12-28'));
  check('year-spanning range shows both years',
    a === b ? label.length > 0 && label !== oneDay
            : label.includes(a) && label.includes(b),
    `${spanTexts.join('|')} (calendar years ${a} / ${b})`);
}

const fewer = streakChart(streaks.slice(0, 2), '#8b5cf6', { limit: 5 });
check('fewer streaks than limit renders only what exists',
  Number(fewer.attrs.height) === 6 + 2*30 + 6, fewer.attrs.height);

/* --- issue #297: the calendar's note dot --- */
{
  const todayN = new Date();
  todayN.setHours(0, 0, 0, 0);
  const isoN = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const agoN = (n) => isoN(new Date(todayN.getTime() - n * 86400000));

  const dNoted = agoN(5);    // has a note
  const dPlain = agoN(6);    // logged, no note
  // `endDate` 5 days ahead of real today, same idiom `atmost.mjs`'s
  // `paintRuns` uses, so the window reaches into the future without moving
  // `dNoted`/`dPlain` — which stay safely inside it — off the grid.
  const dFuture = agoN(-3);  // in the future, and given a note anyway

  const noteHabit = { type: 'boolean', target_value: 0, target_type: 'at_least' };
  const noteEntries = { [dNoted]: 1, [dPlain]: 1 };
  const notes = { [dNoted]: 'went well today', [dFuture]: 'should never draw' };

  const noteSvg = calendarChart(noteEntries, '#10b981', noteHabit, {
    weeks: 4, endDate: agoN(-5), skips: new Set(), notes,
  });

  const noteDots = new Map();
  let notedLabel = null;
  noteSvg.walk((n) => {
    if (n.name === 'circle' && n.attrs['data-note-for']) noteDots.set(n.attrs['data-note-for'], n);
    if (n.name === 'rect' && n.attrs['data-date'] === dNoted) notedLabel = n.attrs['data-label'];
  });

  check('297: a note-bearing date gets a data-note-for mark',
    noteDots.has(dNoted), [...noteDots.keys()].join(','));
  check('297: data-note-marks counts it',
    noteSvg.attrs['data-note-marks'] === '1', noteSvg.attrs['data-note-marks']);
  check('297: a date with an entry and no note gets no mark',
    !noteDots.has(dPlain), [...noteDots.keys()].join(','));
  check('297: a future date with a note gets no mark, even though it is in the map',
    !noteDots.has(dFuture), [...noteDots.keys()].join(','));

  const dot = noteDots.get(dNoted);
  check('297: the mark colours are var(...) strings, never a resolved literal',
    !!dot && /^var\(--/.test(dot.attrs.fill) && /^var\(--/.test(dot.attrs.stroke),
    dot ? `fill=${dot.attrs.fill} stroke=${dot.attrs.stroke}` : 'no dot drawn');
  check('297: the cell label gains the FACT, never the note text',
    notedLabel != null && notedLabel.endsWith(' — has a note') &&
      !notedLabel.includes('went well today'),
    notedLabel);

  // No `notes` option at all: the attribute is still the literal "0", not
  // absent — the same rule `data-run-marks` states, for the same reason (a
  // caller reading a missing attribute as "no notes" cannot tell that apart
  // from an older `charts.js` that never wrote one).
  const bareSvg = calendarChart(noteEntries, '#10b981', noteHabit, { weeks: 4, skips: new Set() });
  check('297: with no notes option, data-note-marks is the literal "0"',
    bareSvg.attrs['data-note-marks'] === '0', bareSvg.attrs['data-note-marks']);
}

console.log('\n--- sample SVG (top rows) ---');
console.log(svg.toXML().split('\n').slice(0, 14).join('\n'));

console.log(fails === 0 ? '\nALL RENDER CHECKS PASSED' : `\n${fails} RENDER CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
