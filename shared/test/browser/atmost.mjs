
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

console.log(fails===0?'\nALL AT-MOST CHECKS PASSED':`\n${fails} FAILED`);
process.exit(fails===0?0:1);
