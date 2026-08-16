
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

const { streakChart } = await import(sharedPublic('charts.js'));

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

const rowDates = texts.filter(t => /\d{4}$/.test(t));
const endOf = (label) => label.split(/\s+[–-]\s+/).pop();   // "5 Aug 2026"
const asTime = (s) => Date.parse(s);
check('rows are ordered newest first',
  rowDates.every((d, i) => i === 0 || asTime(endOf(d)) <= asTime(endOf(rowDates[i-1]))),
  rowDates.join(' | '));

// 3. date ranges present and formatted
check('date range collapses repeated year',
  texts.includes('21 Apr – 18 May 2026'),
  texts.find(t => t.includes('Apr')) ?? 'none');

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
check('single-day streak shows one date', oneTexts.includes('9 Feb 2026'), oneTexts.join('|'));

const spanning = streakChart([{ start: '2026-12-28', end: '2027-01-04', length: 8 }], '#8b5cf6');
const spanTexts = [];
spanning.walk(n => { if (n.name === 'text') spanTexts.push(n.text); });
check('year-spanning range shows both years',
  spanTexts.some(t => t.includes('2026') && t.includes('2027')), spanTexts.join('|'));

const fewer = streakChart(streaks.slice(0, 2), '#8b5cf6', { limit: 5 });
check('fewer streaks than limit renders only what exists',
  Number(fewer.attrs.height) === 6 + 2*30 + 6, fewer.attrs.height);

console.log('\n--- sample SVG (top rows) ---');
console.log(svg.toXML().split('\n').slice(0, 14).join('\n'));

console.log(fails === 0 ? '\nALL RENDER CHECKS PASSED' : `\n${fails} RENDER CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
