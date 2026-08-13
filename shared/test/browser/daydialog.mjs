
import { fileURLToPath as _f2u } from 'node:url';
import { dirname as _dn, join as _jn } from 'node:path';
// Verify the day-editor dialog shows the right controls per habit type by
// replaying openDayDialog's logic against a fake DOM.
//
// The function is sliced out of its module and run with stub elements bound to
// the names it closes over, rather than imported: importing ui/day-dialog.js
// would pull in `document` at module load, and the point of this suite is that
// it needs no browser at all.
import { readFileSync } from 'node:fs';

const src = readFileSync(
  _jn(_dn(_f2u(import.meta.url)), '..', '..', 'public', 'ui', 'day-dialog.js'), 'utf8');

const start = src.indexOf('export function openDayDialog');
const end = src.indexOf('\nasync function saveDay');
// `export` is a module-only keyword and this body is compiled as a function.
const body = src.slice(start, end).replace('export function', 'function');

let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

function mkEl() {
  return {
    hidden: false, textContent: '', value: '', placeholder: '',
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k]; },
    querySelectorAll() { return this._choices ?? []; },
    focus() { this.focused = true; },
  };
}

/** The module-level names openDayDialog reads, in one place. */
const BINDINGS = [
  'title', 'sub', 'booleanBlock', 'numericBlock', 'numericLabel',
  'valueInput', 'notes', 'skip', 'clear', 'save', 'dialog',
];

function run(habit, date, value, isSkip) {
  const els = Object.fromEntries(BINDINGS.map((k) => [k, mkEl()]));
  els.dialog = { showModal() { this.open = true; } };

  const doneBtn = { dataset: { action: 'done' }, _attrs: {},
    setAttribute(k,v){ this._attrs[k]=String(v); }, getAttribute(k){ return this._attrs[k]; } };
  const notBtn  = { dataset: { action: 'not-done' }, _attrs: {},
    setAttribute(k,v){ this._attrs[k]=String(v); }, getAttribute(k){ return this._attrs[k]; } };
  els.booleanBlock._choices = [doneBtn, notBtn];

  const state = {};
  const YES = 2, UNSET = 0;
  const fn = new Function(...BINDINGS, 'state', 'YES', 'UNSET',
    'habit', 'date', 'value', 'isSkip',
    `${body}; openDayDialog(habit, date, value, isSkip); return state;`);
  const out = fn(...BINDINGS.map((k) => els[k]), state, YES, UNSET,
    habit, date, value, isSkip);
  return { els, state: out, doneBtn, notBtn };
}

const boolHabit = { id: 1, name: 'Meditate', type: 'boolean', unit: '', target_value: 0, target_type: 'at_least' };
const numHabit  = { id: 2, name: 'Water', type: 'numerical', unit: 'glasses', target_value: 8, target_type: 'at_least' };
const atMost    = { id: 3, name: 'Cigarettes', type: 'numerical', unit: 'cigs', target_value: 0, target_type: 'at_most' };

console.log('--- boolean habit, currently done ---');
let r = run(boolHabit, '2026-03-15', 2, false);
check('boolean: choice buttons shown', r.els.booleanBlock.hidden === false);
check('boolean: number field hidden', r.els.numericBlock.hidden === true);
check('boolean: Save hidden (buttons save directly)', r.els.save.hidden === true);
check('boolean: "Done" marked active', r.doneBtn.getAttribute('aria-pressed') === 'true');
check('boolean: "Not done" not active', r.notBtn.getAttribute('aria-pressed') === 'false');
check('boolean: no target text in subtitle', !r.els.sub.textContent.includes('target'),
  r.els.sub.textContent);
check('boolean: Clear shown (entry exists)', r.els.clear.hidden === false);

console.log('--- boolean habit, no entry ---');
r = run(boolHabit, '2026-03-16', undefined, false);
check('boolean: "Not done" active when empty', r.notBtn.getAttribute('aria-pressed') === 'true');
check('boolean: Clear hidden when nothing to clear', r.els.clear.hidden === true);

console.log('--- numerical habit with a value ---');
r = run(numHabit, '2026-03-15', 6, false);
check('numerical: number field shown', r.els.numericBlock.hidden === false);
check('numerical: choice buttons hidden', r.els.booleanBlock.hidden === true);
check('numerical: Save shown', r.els.save.hidden === false);
check('numerical: value prefilled', r.els.valueInput.value === '6', r.els.valueInput.value);
check('numerical: unit in label', r.els.numericLabel.textContent === 'Amount (glasses)',
  r.els.numericLabel.textContent);
check('numerical: target in subtitle', r.els.sub.textContent.includes('at least 8 glasses'),
  r.els.sub.textContent);

console.log('--- at-most habit ---');
r = run(atMost, '2026-03-15', 3, false);
check('at_most: subtitle says "at most"', r.els.sub.textContent.includes('at most 0 cigs'),
  r.els.sub.textContent);
check('at_most: value 3 prefilled (not treated as skip)', r.els.valueInput.value === '3',
  r.els.valueInput.value);

console.log('--- skipped day ---');
r = run(numHabit, '2026-03-17', 0, true);
check('skip: value field left empty', r.els.valueInput.value === '', r.els.valueInput.value);
check('skip: placeholder says skipped', r.els.valueInput.placeholder === 'skipped',
  r.els.valueInput.placeholder);
check('skip: button reads Unskip', r.els.skip.textContent === 'Unskip', r.els.skip.textContent);
check('skip: button marked pressed', r.els.skip.getAttribute('aria-pressed') === 'true');

r = run(boolHabit, '2026-03-18', 2, false);
check('non-skip: button reads Skip day', r.els.skip.textContent === 'Skip day', r.els.skip.textContent);

console.log('--- state tracking ---');
r = run(numHabit, '2026-04-01', 5, false);
check('state records habit + date', r.state.dayEdit?.habitId === 2 && r.state.dayEdit?.date === '2026-04-01',
  JSON.stringify(r.state.dayEdit));

console.log(fails === 0 ? '\nALL DIALOG CHECKS PASSED' : `\n${fails} DIALOG CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
