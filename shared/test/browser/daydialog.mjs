
import { fileURLToPath as _f2u } from 'node:url';
import { dirname as _dn, join as _jn } from 'node:path';
import { pathToFileURL as _p2u } from 'node:url';
/** Resolve a module in shared/public relative to this file, not the cwd. */
const sharedPublic = (name) =>
  _p2u(_jn(_dn(_f2u(import.meta.url)), '..', '..', 'public', name)).href;
// Verify the day-editor dialog shows the right controls per habit type by
// replaying openDayDialog's logic against a fake DOM.
import { readFileSync } from 'node:fs';

const src = readFileSync(_jn(_dn(_f2u(import.meta.url)),'..','..','public','app.js'),'utf8');

// Extract openDayDialog and run it in isolation with stub elements.
const start = src.indexOf('function openDayDialog');
const end = src.indexOf('\nasync function saveDay');
const body = src.slice(start, end);

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

function run(habit, date, value, isSkip) {
  const els = {
    dayTitle: mkEl(), daySub: mkEl(), dayBoolean: mkEl(), dayNumeric: mkEl(),
    dayNumericLabel: mkEl(), dayValue: mkEl(), dayNotes: mkEl(), daySkip: mkEl(),
    dayClear: mkEl(), daySave: mkEl(), dayDialog: { showModal(){ this.open = true; } },
  };
  const doneBtn = { dataset: { action: 'done' }, _attrs: {},
    setAttribute(k,v){ this._attrs[k]=String(v); }, getAttribute(k){ return this._attrs[k]; } };
  const notBtn  = { dataset: { action: 'not-done' }, _attrs: {},
    setAttribute(k,v){ this._attrs[k]=String(v); }, getAttribute(k){ return this._attrs[k]; } };
  els.dayBoolean._choices = [doneBtn, notBtn];

  const state = {};
  const YES = 2, UNSET = 0;
  const fn = new Function('els','state','YES','UNSET','habit','date','value','isSkip',
    `${body}; openDayDialog(habit, date, value, isSkip); return {els, state};`);
  const out = fn(els, state, YES, UNSET, habit, date, value, isSkip);
  return { ...out, doneBtn, notBtn };
}

const boolHabit = { id: 1, name: 'Meditate', type: 'boolean', unit: '', target_value: 0, target_type: 'at_least' };
const numHabit  = { id: 2, name: 'Water', type: 'numerical', unit: 'glasses', target_value: 8, target_type: 'at_least' };
const atMost    = { id: 3, name: 'Cigarettes', type: 'numerical', unit: 'cigs', target_value: 0, target_type: 'at_most' };

console.log('--- boolean habit, currently done ---');
let r = run(boolHabit, '2026-03-15', 2, false);
check('boolean: choice buttons shown', r.els.dayBoolean.hidden === false);
check('boolean: number field hidden', r.els.dayNumeric.hidden === true);
check('boolean: Save hidden (buttons save directly)', r.els.daySave.hidden === true);
check('boolean: "Done" marked active', r.doneBtn.getAttribute('aria-pressed') === 'true');
check('boolean: "Not done" not active', r.notBtn.getAttribute('aria-pressed') === 'false');
check('boolean: no target text in subtitle', !r.els.daySub.textContent.includes('target'),
  r.els.daySub.textContent);
check('boolean: Clear shown (entry exists)', r.els.dayClear.hidden === false);

console.log('--- boolean habit, no entry ---');
r = run(boolHabit, '2026-03-16', undefined, false);
check('boolean: "Not done" active when empty', r.notBtn.getAttribute('aria-pressed') === 'true');
check('boolean: Clear hidden when nothing to clear', r.els.dayClear.hidden === true);

console.log('--- numerical habit with a value ---');
r = run(numHabit, '2026-03-15', 6, false);
check('numerical: number field shown', r.els.dayNumeric.hidden === false);
check('numerical: choice buttons hidden', r.els.dayBoolean.hidden === true);
check('numerical: Save shown', r.els.daySave.hidden === false);
check('numerical: value prefilled', r.els.dayValue.value === '6', r.els.dayValue.value);
check('numerical: unit in label', r.els.dayNumericLabel.textContent === 'Amount (glasses)',
  r.els.dayNumericLabel.textContent);
check('numerical: target in subtitle', r.els.daySub.textContent.includes('at least 8 glasses'),
  r.els.daySub.textContent);

console.log('--- at-most habit ---');
r = run(atMost, '2026-03-15', 3, false);
check('at_most: subtitle says "at most"', r.els.daySub.textContent.includes('at most 0 cigs'),
  r.els.daySub.textContent);
check('at_most: value 3 prefilled (not treated as skip)', r.els.dayValue.value === '3',
  r.els.dayValue.value);

console.log('--- skipped day ---');
r = run(numHabit, '2026-03-17', 0, true);
check('skip: value field left empty', r.els.dayValue.value === '', r.els.dayValue.value);
check('skip: placeholder says skipped', r.els.dayValue.placeholder === 'skipped',
  r.els.dayValue.placeholder);
check('skip: button reads Unskip', r.els.daySkip.textContent === 'Unskip', r.els.daySkip.textContent);
check('skip: button marked pressed', r.els.daySkip.getAttribute('aria-pressed') === 'true');

r = run(boolHabit, '2026-03-18', 2, false);
check('non-skip: button reads Skip day', r.els.daySkip.textContent === 'Skip day', r.els.daySkip.textContent);

console.log('--- state tracking ---');
r = run(numHabit, '2026-04-01', 5, false);
check('state records habit + date', r.state.dayEdit?.habitId === 2 && r.state.dayEdit?.date === '2026-04-01',
  JSON.stringify(r.state.dayEdit));

console.log(fails === 0 ? '\nALL DIALOG CHECKS PASSED' : `\n${fails} DIALOG CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
