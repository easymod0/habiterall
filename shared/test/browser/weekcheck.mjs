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

const { weekdayChart, weekdayMonthChart } = await import(sharedPublic('charts.js'));
const { calendarWindow, weekdayIndex } = await import(sharedPublic('ui/calendar.js'));

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

  // The captions, left to right.
  const labels = nodes.filter((n) => n.name === 'text' && /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/.test(n.text ?? ''))
    .map((n) => ({ x: Number(n.attrs.x), label: n.text }))
    .sort((a, b) => a.x - b.x);

  // The tooltips, which carry the weekday NAME and the count together — so a
  // caption that rotated without its data shows up as a mismatch here.
  const titles = nodes.filter((n) => n.name === 'title')
    .map((n) => n.text);

  const expected = weekStart === 'monday'
    ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  check(`${weekStart}: the captions run in the account's week order`,
    labels.map((l) => l.label).join(',') === expected.join(','),
    labels.map((l) => l.label).join(','));

  // Sunday's bar carries 0 completions, Monday's 1, and so on. If the labels
  // rotated and the bars did not, this is where it shows.
  const FULL = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
    Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
  const N = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const paired = expected.every((short, i) => {
    const full = FULL[short];
    return titles[i] === `${full}: ${N[full]}/6`;
  });
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

  const order = weekStart === 'monday'
    ? ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // The NAME and the NUMBER together. Checking the name alone passes when the
  // rows keep their captions and read their data positionally — which is one
  // of the mutations this suite exists to catch, and it slipped through the
  // first version of this check.
  const N = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const ok = order.every((name, r) => {
    const n = N[name];
    // A rate of 0 draws the empty ring, whose title carries no percentage.
    const want = n === 0
      ? `2026-08 ${name}: 0 of 6`
      : `2026-08 ${name}: ${n} of 6 (${Math.round((n / 6) * 100)}%)`;
    return titles[r] === want;
  });
  check(`${weekStart}: each row carries ITS OWN weekday's number`, ok,
    titles.join(' | '));
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

for (const [weekStart, want] of [['sunday', ['S', 'T']], ['monday', ['M', 'W']]]) {
  const svg = calendarChart({}, '#3b82f6',
    { type: 'boolean', target_type: 'at_least', target_value: 0 },
    { weeks: 4, endDate: '2026-08-12', weekStart });

  // The row captions are the only single-letter texts at x=0.
  const labels = collect(svg)
    .filter((n) => n.name === 'text' && n.attrs.x === '0' && (n.text ?? '').length === 1)
    .map((n) => n.text);

  check(`${weekStart}: the calendar's row labels name the rows drawn`,
    labels.join(',') === want.join(','), `${labels.join(',')} (want ${want.join(',')})`);
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL WEEK CHECKS PASSED');
process.exit(fails ? 1 : 0);
