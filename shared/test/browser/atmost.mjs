
import { fileURLToPath as _f2u } from 'node:url';
import { dirname as _dn, join as _jn } from 'node:path';
import { pathToFileURL as _p2u } from 'node:url';
/** Resolve a module in shared/public relative to this file, not the cwd. */
const sharedPublic = (name) =>
  _p2u(_jn(_dn(_f2u(import.meta.url)), '..', '..', 'public', name)).href;
// Verify at_most habits paint 0 as a full success.
class N{constructor(n){this.name=n;this.attrs={};this.children=[];this.text=null;}
 setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k];}
 appendChild(c){this.children.push(c);return c;}addEventListener(){}
 set textContent(v){this.text=v;}get textContent(){return this.text;}
 walk(f){f(this);for(const c of this.children)c.walk(f);}}
// No getComputedStyle, and no theme on documentElement: charts.js must not
// read the palette at draw time. See rendercheck.mjs for the whole story.
globalThis.document={createElementNS:(ns,n)=>new N(n),createElement:(n)=>new N(n)};

const {calendarChart}=await import(sharedPublic('charts.js'));
let fails=0;
const check=(l,c,e='')=>{console.log(`${c?'PASS':'FAIL'}  ${l}${e?' :: '+e:''}`);if(!c)fails++;};

const today=new Date();today.setHours(0,0,0,0);
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const ago=n=>iso(new Date(today.getTime()-n*86400000));
const d0=ago(7), d1=ago(8), d2=ago(9);   // safely inside a 4-week grid

const paint=(entries,color,habit)=>{
  const svg=calendarChart(entries,color,habit,{weeks:4,skips:new Set()});
  const out={};
  // Keyed on `data-date`, which is the cell's stable ISO key, NOT on the
  // <title>'s first colon-separated field. The title is human copy — it reads
  // "Aug 9, 2026: clean" now — and parsing it made this suite depend on the
  // wording and on the runner's locale.
  svg.walk(n=>{ if(n.name!=='rect')return;
    const d=n.attrs['data-date'];
    if(d) out[d]=n.attrs.fill; });
  return out;
};

const snacks={type:'numerical',target_value:0,target_type:'at_most',unit:'snacks'};
const cells=paint({[d0]:0,[d1]:2,[d2]:1},'#10b981',snacks);
// A reference, not a value — the point of the change these pin.
const empty='var(--grid-empty)';

check('0 snacks (perfect) is painted, not blank', cells[d0]&&cells[d0]!==empty, `fill=${cells[d0]}`);
check('0 snacks gets FULL strength colour', cells[d0]==='#10b981', cells[d0]);
check('2 snacks dimmer than 0', cells[d1]!==cells[d0], `fill=${cells[d1]}`);
check('1 vs 2 snacks are distinguishable', cells[d2]!==cells[d1], `1=${cells[d2]} 2=${cells[d1]}`);
check('1 snack still painted', cells[d2]&&cells[d2]!==empty, `fill=${cells[d2]}`);

const water={type:'numerical',target_value:8,target_type:'at_least',unit:'glasses'};
const c2=paint({[d0]:0,[d1]:8,[d2]:4},'#0ea5e9',water);
check('at_least: 0 glasses stays blank', c2[d0]===empty, `fill=${c2[d0]}`);
check('at_least: 8 glasses full colour', c2[d1]==='#0ea5e9', c2[d1]);
check('at_least: 4 glasses partial', c2[d2]!==empty&&c2[d2]!==c2[d1], `fill=${c2[d2]}`);

const bool={type:'boolean',target_value:0,target_type:'at_least'};
const c3=paint({[d0]:2,[d1]:0},'#8b5cf6',bool);
check('boolean: done is full colour', c3[d0]==='#8b5cf6', c3[d0]);
check('boolean: not-done stays blank', c3[d1]===empty, c3[d1]);

// A habit SHOWN as something to avoid. Same rows, opposite reading: the whole
// point of `show_as` is that a slip must not be painted in the habit's own
// colour, because on a limit that reads as having done well. `dashboard.js`
// inverted; `calendarChart` did not, so the two grids over one dataset gave
// opposite verdicts about the same cigarette — red with an ✗ on the dashboard,
// the habit's own green on the detail view three inches away.
const smoking={type:'numerical',target_value:0,target_type:'at_most',
               show_as:'avoid',unit:'cigarettes'};
const c4=paint({[d0]:0,[d1]:1,[d2]:3},'#10b981',smoking);
check('avoid: a clean day is the habit colour', c4[d0]==='#10b981', c4[d0]);
check('avoid: a slip is NOT derived from the habit colour',
  !String(c4[d1]).includes('#10b981'), `1 cigarette = ${c4[d1]}`);
check('avoid: a worse slip is not derived from it either',
  !String(c4[d2]).includes('#10b981'), `3 cigarettes = ${c4[d2]}`);
check('avoid: a slip reads as a failure', c4[d1]==='var(--danger)', c4[d1]);

// The gate is all THREE questions, so a habit that is at_most and numerical but
// still shown as an amount keeps the old shading — and one that is `avoid` on a
// boolean or an at_least habit is not reachable as an inversion either.
// `d1` is OVER the limit, deliberately: with a value at or under it the two
// branches agree and the check passes with the `show_as` clause deleted from
// `isAvoided`. Measured — it did.
const c5=paint({[d0]:0,[d1]:3},'#10b981',
  {...smoking,target_value:2,show_as:'amount'});
check('at_most shown as an amount is unchanged, and still SHADES an overage',
  c5[d1]!=='var(--danger)'&&String(c5[d1]).includes('#10b981'), c5[d1]);

// A limit of two: one is still under it, so it is a clean day.
const c6=paint({[d0]:1,[d1]:3},'#10b981',{...smoking,target_value:2});
check('avoid: under the limit is clean', c6[d0]==='#10b981', c6[d0]);
check('avoid: over the limit is a slip', c6[d1]==='var(--danger)', c6[d1]);

// An unanswered day that already counts as kept (issue #222). One habit
// carries all four kinds of day, so the fills are told apart from each other
// rather than only from `empty`. `at_most_unlogged` is set to a non-default
// value on purpose — a fixture holding a field's default compares equal to
// itself and passes with the field dropped entirely — but the renderer never
// reads it: `unlogged_is_success` is the server-resolved boolean it must go
// by instead, per the flag's own contract.
const dClean=ago(10), dZero=ago(11), dSlip=ago(12), dBare=ago(13);
const kept={type:'numerical',target_value:2,target_type:'at_most',
            at_most_unlogged:'success', unlogged_is_success:true, unit:'coffees'};
const cKept=paint({[dClean]:1,[dZero]:0,[dSlip]:5},'#10b981',kept);
check('logged clean day (value <= target) is full', cKept[dClean]==='#10b981', cKept[dClean]);
check('a stored 0 is also full — a stated lapse is a real success on a limit',
  cKept[dZero]==='#10b981', cKept[dZero]);
check('a logged slip (over target) is on the 0.15-floor ramp',
  cKept[dSlip]==='color-mix(in srgb, #10b981 15%, var(--grid-empty))', cKept[dSlip]);
check('an unanswered day gets the literal 0.07 block — well under the 0.15 floor',
  cKept[dBare]==='color-mix(in srgb, #10b981 7%, var(--grid-empty))', cKept[dBare]);

// The `?` must not draw on the affected cell, and must still draw on the same
// day for a habit resolved to `miss` — same dataset, same date, one flag apart.
const paintMarks=(entries,habit)=>{
  const svg=calendarChart(entries,'#10b981',habit,{weeks:4,skips:new Set(),unknownMark:true});
  const marks=new Set();
  svg.walk(n=>{ if(n.name==='text' && n.attrs['data-mark-for']) marks.add(n.attrs['data-mark-for']); });
  return marks;
};
const missHabit={...kept, at_most_unlogged:'miss', unlogged_is_success:false};
const keptMarks=paintMarks({[dClean]:1},kept);
const missMarks=paintMarks({[dClean]:1},missHabit);
check('unknownMark: absent on the day counted as kept', !keptMarks.has(dBare), [...keptMarks].join(','));
check('unknownMark: still present on the same day resolved to miss',
  missMarks.has(dBare), [...missMarks].join(','));

// --- issue #176: the continuation stroke over a cell painting nothing at all
//
// `streaks` is built directly rather than derived from entries — `streakDates`
// only cares about `{start, end, length}`, and the cell loop separately reads
// `entriesByDate` for what each day actually shows. Building both by hand
// keeps the two independent, which is the point: a day can be IN a run and
// still paint something of its own (logged, a skip), and the stroke must only
// land where the fill would otherwise have been `empty`.
const paintRuns = (entries, skips, streaks, habit, color, opts = {}) => {
  const svg = calendarChart(entries, color, habit, {
    weeks: 10, endDate: ago(-5), skips, streaks, ...opts,
  });
  const cells = {};
  const marks = new Set();
  const links = new Set();
  svg.walk((n) => {
    if (n.name === 'rect' && n.attrs['data-date']) {
      const d = n.attrs['data-date'];
      const t = n.children.find((c) => c.name === 'title');
      cells[d] = {
        fill: n.attrs.fill, stroke: n.attrs.stroke,
        dash: n.attrs['stroke-dasharray'], title: t ? t.textContent : null,
      };
    }
    // A connector rect, not a cell: distinguished by the attribute this
    // change adds rather than by any positional guess.
    if (n.name === 'rect' && n.attrs['data-link-for']) links.add(n.attrs['data-link-for']);
    if (n.name === 'text' && n.attrs['data-mark-for']) marks.add(n.attrs['data-mark-for']);
  });
  // `runMarks`, not just `svg`: the count this window's paint actually
  // stroked, read the same way the legend in detail.js reads it — a plain
  // attribute, so a caller that only wants the count need not also learn the
  // fake DOM's `attrs` shape.
  return { cells, marks, links, runMarks: svg.attrs['data-run-marks'] };
};

const surface2 = 'var(--surface-2)';
const runColor = '#22c55e';
// `shade(runColor, 0.55)` written out, not imported — the point of this
// literal is that the stroke is chosen at half the connector's own weight,
// and importing `shade` to build it would let the ratio drift unnoticed.
const runStroke = `color-mix(in srgb, ${runColor} 55%, var(--grid-empty))`;

// One long run (5 days), holding one of each kind of day the rule has to tell
// apart: unlogged, a stored 0, a logged day, and a skip.
const rD30 = ago(30), rD29 = ago(29), rD28 = ago(28), rD27 = ago(27), rD26 = ago(26);
// A second run of exactly 2 days — under the gate, on purpose.
const rD20 = ago(20), rD19 = ago(19);
// An unlogged day inside no run at all.
const rD10 = ago(10);
// An open run that reaches into the future.
const rD3 = ago(3), rDFuture = ago(-2), rDOpenEnd = ago(-3);

const runEntries = {
  [rD29]: 0,   // stored 0 — a stated lapse, boolean "not done"
  [rD28]: 2,   // logged YES
  [rD27]: 3,   // paired with `skips` below, boolean SKIP sentinel value
};
const runSkips = new Set([rD27]);
// Literal `2`, not `MIN_STREAK`: the row-5 check is about the GATE, which a
// test importing the same constant it is pinning could not catch drifting.
const runStreaks = [
  { start: rD30, end: rD26, length: 5 },
  { start: rD20, end: rD19, length: 2 },
  { start: rD3, end: rDOpenEnd, length: 7 },
];
const runHabit = {
  type: 'boolean', target_value: 0, target_type: 'at_least',
  freq_numerator: 3, freq_denominator: 7,
};

const { cells: rc, links: rlinks, runMarks: rMarksAttr } =
  paintRuns(runEntries, runSkips, runStreaks, runHabit, runColor);

check('1. unlogged day inside a long run: stroke and empty fill',
  rc[rD30].fill === empty && rc[rD30].stroke === runStroke,
  `fill=${rc[rD30].fill} stroke=${rc[rD30].stroke}`);

check('2. a stored 0 inside the same run gets the same pair',
  rc[rD29].fill === empty && rc[rD29].stroke === runStroke,
  `fill=${rc[rD29].fill} stroke=${rc[rD29].stroke}`);

check('3. a logged day inside the run is full colour and carries no run stroke',
  rc[rD28].fill === runColor && rc[rD28].stroke === undefined,
  `fill=${rc[rD28].fill} stroke=${rc[rD28].stroke}`);

check('4. an unlogged day outside every run has no stroke',
  rc[rD10].fill === empty && rc[rD10].stroke === undefined,
  `fill=${rc[rD10].fill} stroke=${rc[rD10].stroke}`);

check('5. neither day of a 2-day run gets a stroke — 3 is the gate, not 2',
  rc[rD20].stroke === undefined && rc[rD19].stroke === undefined,
  `d20=${rc[rD20].stroke} d19=${rc[rD19].stroke}`);

check('6. a skip inside the run keeps its own fill and gets no stroke',
  rc[rD27].fill === surface2 && rc[rD27].stroke === undefined,
  `fill=${rc[rD27].fill} stroke=${rc[rD27].stroke}`);

check('7. a future day inside an open run keeps its OWN dashed stroke, not the continuation colour',
  rc[rDFuture].fill === 'transparent' && rc[rDFuture].dash === '2 2' &&
    rc[rDFuture].stroke === empty,
  `fill=${rc[rDFuture].fill} dash=${rc[rDFuture].dash} stroke=${rc[rDFuture].stroke}`);

check('8. the connector for a run date and the cell for that date are found together',
  rlinks.has(rD30) && rc[rD30].stroke === runStroke,
  `link=${rlinks.has(rD30)} cellStroke=${rc[rD30].stroke}`);

check('9a. the <title> for an unlogged in-run day appends "in a run" to "no entry"',
  /: no entry — in a run$/.test(rc[rD30].title), rc[rD30].title);
check('9b. the <title> for a stored-0 in-run day appends "in a run" to "not done"',
  /: not done — in a run$/.test(rc[rD29].title), rc[rD29].title);

const { cells: rcMarked, marks: rmarks } =
  paintRuns(runEntries, runSkips, runStreaks, runHabit, runColor, { unknownMark: true });
check('10. with unknownMark on, an in-run unlogged day keeps BOTH the stroke and the ?',
  rcMarked[rD30].stroke === runStroke && rmarks.has(rD30),
  `stroke=${rcMarked[rD30].stroke} hasMark=${rmarks.has(rD30)}`);

// --- the legend's source: `data-run-marks` on the returned <svg>, counting
// cells THIS paint actually stroked — not `inStreak.size`, which is the
// habit's whole history and can disagree with what a given window drew.
//
// 11. This window's own cells already carry the stroke on three of them
// (rD30, rD29, rD26 — the fourth and fifth days of run 1, `rD28` logged and
// `rD27` skipped so neither qualifies) plus every unlogged day of the open
// run 3 that has not yet reached the future. Rather than hard-code that
// count, it is recomputed from `rc` — the same cells `check`s 1-10 above
// already read — so the attribute and the grid are asked to agree with each
// other rather than with a number written by hand that could drift from
// either.
const strokedInWindow =
  Object.values(rc).filter((c) => c.stroke === runStroke).length;
check('11. data-run-marks equals the number of cells this paint actually stroked',
  Number(rMarksAttr) === strokedInWindow && strokedInWindow > 0,
  `data-run-marks=${rMarksAttr} counted=${strokedInWindow}`);

// 12. A run that qualifies (well past MIN_STREAK) but sits entirely outside
// the drawn window: `data-run-marks` must be the literal `"0"`, not merely
// falsy — `"0"` is truthy as a string, and a gate that only checked
// truthiness would show the "In a run" swatch for a window with nothing on
// it, which is the exact defect this attribute exists to prevent.
const farStreaks = [{ start: ago(410), end: ago(400), length: 11 }];
const { runMarks: farMarksAttr } =
  paintRuns({}, new Set(), farStreaks, runHabit, runColor);
check('12. a qualifying run entirely outside the window reports the literal "0"',
  farMarksAttr === '0', `data-run-marks=${farMarksAttr}`);

console.log(fails===0?'\nALL AT-MOST CHECKS PASSED':`\n${fails} FAILED`);
process.exit(fails===0?0:1);
