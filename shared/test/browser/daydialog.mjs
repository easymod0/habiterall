
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
    _attrs: {}, _children: [],
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k]; },
    querySelectorAll() { return this._choices ?? []; },
    focus() { this.focused = true; },
    // #66: `title` gains these two calls once the icon can precede the name.
    // `append` takes a bare string as well as a node — real `Element.append`
    // does too, which is what let `openDayDialog` avoid `document.createTextNode`
    // (this fake DOM has no `document` to call it on).
    replaceChildren() { this._children = []; this.textContent = ''; },
    append(...args) {
      for (const a of args) {
        if (typeof a === 'string') this.textContent += a;
        else this._children.push(a);
      }
    },
  };
}

// #66: `habitIcon` calls `document.createElement`, which this fake DOM has no
// `document` to provide, so it is stubbed rather than imported for real — the
// same null-when-absent contract `ui/components.js`'s real one has, returning
// a fake element `mkEl`'s `append` can hold as a child and `getAttribute` can
// read `aria-hidden` off.
const fakeHabitIcon = (habit) => {
  if (!habit?.icon) return null;
  const span = mkEl();
  span.textContent = habit.icon;
  span.setAttribute('aria-hidden', 'true');
  return span;
};

/**
 * The module-level names openDayDialog reads, in one place.
 *
 * `dayHost` is not an element and is not read by anything this suite asserts —
 * it is the opening page's own day model, which `saveDay` uses to repaint after
 * a QUEUED write. That is covered in a real browser, where there is an outbox,
 * by `calcheck.mjs`'s "the day editor, offline" block; not `stripcheck.mjs`,
 * which owns the STRIP's own offline tap (#230) and is the fleet's longest
 * suite. It is here because `openDayDialog` ASSIGNS it, and a free identifier
 * the harness does not hand in is a `ReferenceError` out of `new Function` for
 * every case below.
 */
const BINDINGS = [
  'title', 'sub', 'booleanBlock', 'numericBlock',
  'notes', 'notesWrap', 'skip', 'clear', 'save', 'dialog', 'dayCountField', 'habitIcon',
  'dayHost',
  // Assigned by `openDayDialog`, like `dayHost` above, and unlike it this one
  // IS asserted here: it is what decides whether `saveDay` states the note at
  // all. A function parameter is assignable, so the slice sets it exactly as
  // the module's own `let` would.
  'noteKnown',
  // How this account spells an amount. Handed in for the reason every other
  // name here is — the harness evals the function's SOURCE — and it cannot be
  // the module's own, since that one is `formatAmount` bound to `convention()`
  // and `ui/count-field.js` reaches for `document` at import time. `run` builds
  // it from the REAL `formatAmount` over a convention the case chooses, so
  // nothing here restates the formatting rule.
  'showAmount',
];

// The real rule, not a stub: `ui/toggle.js` is dependency-free precisely so it
// can be imported with no browser, and a stub here would let the dialog and the
// grid drift about what a habit shown as "avoid" even is.
const { isAvoided } = await import('../../public/ui/toggle.js');
// The harness evals the function's SOURCE, so every free identifier it names
// has to be handed in — a miss is a loud ReferenceError from `new Function`,
// not a silent pass. The real implementations rather than stubs, though note
// nothing here ASSERTS the formatted heading: a stub returning '' would pass
// these checks identically.
const { formatDateLong, fromISOLocal } = await import('../../public/ui/dates.js');
// The real formatter, not a stand-in: it is what `ui/day-dialog.js`'s own
// `showAmount` closes over, and `ui/amount.js` has no imports at all, so it runs
// under Node exactly as `ui/toggle.js` above does.
const { formatAmount } = await import('../../public/ui/amount.js');

/**
 * @param prefs the settings the dialog reads. Both default off, as the server
 *   does — this is the fake `ui/settings.js` for the sliced-out function.
 * @param format which character this account's decimal point is, standing in
 *   for `convention()`. `point` for every case that predates the goal being
 *   spelled through the formatter at all.
 * @param noteText what the opener knows about the day's note — a string, or
 *   `null` for "could not find out". DEFAULTED to `undefined` rather than to
 *   `''`, so every case below goes through `openDayDialog`'s OWN default. That
 *   default is the load-bearing half of the three-answer split (see the
 *   comment at `noteKnown =` in the module): it is what keeps an absent
 *   argument meaning "no note", and a harness that supplied `''` itself would
 *   pass against a version with the default deleted.
 */
function run(habit, date, value, isSkip, prefs = {}, format = 'point', noteText = undefined) {
  const els = Object.fromEntries(BINDINGS.map((k) => [k, mkEl()]));
  els.dialog = { showModal() { this.open = true; } };
  // The amount control is a module of its own now (ui/count-field.js), so what
  // this suite can see is what the dialog ASKS it to show — which is the whole
  // of the dialog's part in it. What the control then does with a number is
  // `test/amount.test.js`'s, and it needs no DOM either.
  els.dayCountField = {
    shown: undefined, forHabit: undefined, focused: false,
    set(forHabit, value) { this.forHabit = forHabit; this.shown = value; },
    focus() { this.focused = true; },
  };
  els.habitIcon = fakeHabitIcon;
  els.showAmount = (n) => formatAmount(n, format);

  const doneBtn = { dataset: { action: 'done' }, _attrs: {},
    setAttribute(k,v){ this._attrs[k]=String(v); }, getAttribute(k){ return this._attrs[k]; } };
  const notBtn  = { dataset: { action: 'not-done' }, _attrs: {},
    setAttribute(k,v){ this._attrs[k]=String(v); }, getAttribute(k){ return this._attrs[k]; } };
  els.booleanBlock._choices = [doneBtn, notBtn];

  const state = {};
  const YES = 2, UNSET = 0;
  const settings = { get: (key) => prefs[key] ?? false };
  // `noteKnown` comes back out of the eval rather than off `els`, because it is
  // a module-level BINDING and the slice receives it as a parameter — an
  // assignment to one of those is invisible to this scope. Returned explicitly,
  // which is the only way a harness built on `new Function` can read a value
  // the function under test merely reassigns.
  const fn = new Function(...BINDINGS, 'state', 'YES', 'UNSET', 'settings',
    'isAvoided', 'formatDateLong', 'fromISOLocal',
    'habit', 'date', 'value', 'isSkip', 'noteText',
    `${body}; openDayDialog(habit, date, value, isSkip, noteText);
     return { state, noteKnown };`);
  const out = fn(...BINDINGS.map((k) => els[k]), state, YES, UNSET, settings,
    isAvoided, formatDateLong, fromISOLocal, habit, date, value, isSkip, noteText);
  return { els, state: out.state, noteKnown: out.noteKnown, doneBtn, notBtn };
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

console.log('--- question marks: an unanswered day is neither answer ---');
// With the setting on, a day with no row is its own state. "Not done" claiming
// it would undo the only distinction the setting draws.
r = run(boolHabit, '2026-03-16', undefined, false, { questionMarks: true });
check('marks on: "Not done" not active for an unanswered day',
  r.notBtn.getAttribute('aria-pressed') === 'false');
check('marks on: "Done" not active either',
  r.doneBtn.getAttribute('aria-pressed') === 'false');
// A stored 0 IS an answer, and stays one whatever the setting says.
r = run(boolHabit, '2026-03-16', 0, false, { questionMarks: true });
check('marks on: a stated lapse still marks "Not done"',
  r.notBtn.getAttribute('aria-pressed') === 'true');
check('marks on: and offers Clear, the only way back to unanswered',
  r.els.clear.hidden === false);

console.log('--- skip days: the control follows the setting ---');
r = run(boolHabit, '2026-03-15', 2, false);
check('skips off: the Skip control is hidden', r.els.skip.hidden === true);
r = run(boolHabit, '2026-03-15', 2, false, { skipDays: true });
check('skips on: the Skip control is shown', r.els.skip.hidden === false);
// An imported Loop history has skips in it whether or not this account creates
// new ones, and "Unskip" is the only way to undo one.
r = run(boolHabit, '2026-03-15', 0, true);
check('skips off: Unskip stays reachable on a day that already is one',
  r.els.skip.hidden === false && r.els.skip.textContent === 'Unskip',
  `${r.els.skip.hidden} ${r.els.skip.textContent}`);

console.log('--- numerical habit with a value ---');
r = run(numHabit, '2026-03-15', 6, false);
check('numerical: number field shown', r.els.numericBlock.hidden === false);
check('numerical: choice buttons hidden', r.els.booleanBlock.hidden === true);
check('numerical: Save shown', r.els.save.hidden === false);
check('numerical: value handed to the amount field', r.els.dayCountField.shown === 6,
  String(r.els.dayCountField.shown));
check('numerical: and the habit with it, which is where the unit and step come from',
  r.els.dayCountField.forHabit === numHabit);
// The label itself moved into ui/count-field.js and is asserted where it is
// now built — test/browser/flowcheck.mjs reads `#day-count`'s legend in a real
// browser. Restating it here would only re-check this file's own literal.

check('numerical: target in subtitle', r.els.sub.textContent.includes('at least 8 glasses'),
  r.els.sub.textContent);

console.log('--- at-most habit ---');
r = run(atMost, '2026-03-15', 3, false);
check('at_most: subtitle says "at most"', r.els.sub.textContent.includes('at most 0 cigs'),
  r.els.sub.textContent);
check('at_most: value 3 prefilled (not treated as skip)', r.els.dayCountField.shown === 3,
  String(r.els.dayCountField.shown));

console.log('--- the goal is spelled the way this account spells an amount ---');
/*
 * The fourth surface of the same rule, and the one `targetLabel` could not
 * reach: this subtitle is not a `targetLabel` caller — it says the direction in
 * words rather than as `≤`, because it is a sentence about the day being edited
 * — so on a comma account it read `at most 8.5` while `dayCountField.set`
 * filled the box directly under it with `8,5`, through `formatAmount`.
 *
 * Two conventions over ONE habit, and only the second can fail: with the goal
 * back to a raw `${habit.target_value}` the point case is still `8.5` and passes
 * on itself, which is why the fractional comma case is here rather than a
 * whole-number one. That is also why every case above needed no new expectation
 * — `8` and `0` are spelled identically under both conventions, so the
 * fixture's own literals (`at least 8 glasses`, `at most 0 cigs`) are as true
 * through the formatter as they were beside it.
 */
const fraction = { id: 6, name: 'Reading', type: 'numerical', unit: 'pages',
  target_value: 8.5, target_type: 'at_least' };
r = run(fraction, '2026-03-15', 4, false, {}, 'point');
check('point: the goal is spelled with a dot',
  r.els.sub.textContent.includes('at least 8.5 pages'), r.els.sub.textContent);
r = run(fraction, '2026-03-15', 4, false, {}, 'comma');
check('comma: the same goal is spelled with a comma, as the box under it is',
  r.els.sub.textContent.includes('at least 8,5 pages'), r.els.sub.textContent);

console.log('--- skipped day ---');
r = run(numHabit, '2026-03-17', 0, true);
// null, not 0: a skipped day has no amount, and for a measurable habit 0 is a
// real one — a stated lapse. Handing 0 here would prefill the box with an
// answer nobody gave.
check('skip: no amount handed to the field', r.els.dayCountField.shown === null,
  String(r.els.dayCountField.shown));
check('skip: button reads Unskip', r.els.skip.textContent === 'Unskip', r.els.skip.textContent);
check('skip: button marked pressed', r.els.skip.getAttribute('aria-pressed') === 'true');

r = run(boolHabit, '2026-03-18', 2, false);
check('non-skip: button reads Skip day', r.els.skip.textContent === 'Skip day', r.els.skip.textContent);

console.log('--- shown as something to avoid ---');
// Stored as what it is — a measurable habit with an at-most target — and shown
// the other way up. The dialog is the surface where that has to be legible:
// "Done" on a habit you are trying not to do reads as the opposite of what
// pressing it records.
const avoid = { id: 4, name: 'Smoking', type: 'numerical', unit: '',
  target_value: 0, target_type: 'at_most', show_as: 'avoid' };

r = run(avoid, '2026-03-15', 0, false);
const labels = () => r.els.booleanBlock._choices.map((b) => b.textContent);
check('avoid: the two choices are shown, not the bare amount box',
  r.els.booleanBlock.hidden === false, String(r.els.booleanBlock.hidden));
check('avoid: and the amount box stays, for an exact count',
  r.els.numericBlock.hidden === false, String(r.els.numericBlock.hidden));
check('avoid: the buttons say what they record',
  labels()[0] === '✓ Clean day' && labels()[1] === '✗ Slipped', JSON.stringify(labels()));
check('avoid: a day of 0 is the CLEAN one, which is the inversion',
  r.doneBtn.getAttribute('aria-pressed') === 'true' &&
  r.notBtn.getAttribute('aria-pressed') === 'false',
  `${r.doneBtn.getAttribute('aria-pressed')} / ${r.notBtn.getAttribute('aria-pressed')}`);

r = run(avoid, '2026-03-15', 1, false);
check('avoid: a day of 1 is the slip',
  r.notBtn.getAttribute('aria-pressed') === 'true' &&
  r.doneBtn.getAttribute('aria-pressed') === 'false',
  `${r.doneBtn.getAttribute('aria-pressed')} / ${r.notBtn.getAttribute('aria-pressed')}`);

// A limit of two: anything at or under it is clean, and over is the slip.
const limit = { ...avoid, id: 5, name: 'Coffee', unit: 'cups', target_value: 2 };
r = run(limit, '2026-03-15', 2, false);
check('avoid: at the limit is still clean', r.doneBtn.getAttribute('aria-pressed') === 'true');
r = run(limit, '2026-03-15', 3, false);
check('avoid: over it is the slip', r.notBtn.getAttribute('aria-pressed') === 'true');

// The same habit read as an amount keeps the amount box and loses the buttons.
r = run({ ...avoid, show_as: 'amount' }, '2026-03-15', 0, false);
check('amount: no choice buttons', r.els.booleanBlock.hidden === true);

console.log('--- state tracking ---');
r = run(numHabit, '2026-04-01', 5, false);
check('state records habit + date', r.state.dayEdit?.habitId === 2 && r.state.dayEdit?.date === '2026-04-01',
  JSON.stringify(r.state.dayEdit));

console.log('--- #66: a habit icon reaches the title ---');
r = run({ ...boolHabit, icon: '🧘' }, '2026-03-15', 2, false);
check('icon: the title holds one child, the icon span',
  r.els.title._children.length === 1, String(r.els.title._children.length));
check('icon: the icon span is aria-hidden',
  r.els.title._children[0]?.getAttribute('aria-hidden') === 'true',
  String(r.els.title._children[0]?.getAttribute('aria-hidden')));
check('icon: the title still carries the habit name',
  r.els.title.textContent.includes('Meditate'), r.els.title.textContent);

// The regression this whole block exists to catch: a habit with no icon must
// not grow a phantom child, and the title must be exactly the name, no
// leading space left over from a skipped `title.append(icon, ' ')`.
r = run(boolHabit, '2026-03-15', 2, false);
check('no icon: the title has no icon child',
  r.els.title._children.length === 0, String(r.els.title._children.length));
check('no icon: the title is exactly the name',
  r.els.title.textContent === 'Meditate', JSON.stringify(r.els.title.textContent));

/*
 * The note has THREE answers, not two, and the third is what lets the dashboard
 * open this dialog at all.
 *
 * `saveDay` states the note on every save, so an empty box over a day that has
 * one destroys it (#224) — the reason the list used to navigate to the habit's
 * own page instead. `null` is the opener saying it could not find out: the box
 * is hidden and `noteKnown` goes false, which is what makes `saveDay` leave
 * `notes` out of the body entirely and `PUT /entries/:date` preserve what is
 * stored.
 *
 * Each case asserts BOTH halves — what is on screen and the flag the write
 * turns on — because they are set by two different lines and a version that
 * hid the box without moving the flag would still destroy the note, silently
 * and with nothing on screen to show for it.
 */
console.log('\n--- #297/#224: the note has three answers ---');

r = run(boolHabit, '2026-03-15', 2, false, {}, 'point', 'felt easy today');
check('note: a stated note fills the box',
  r.els.notes.value === 'felt easy today', JSON.stringify(r.els.notes.value));
check('note: ...and the box is shown', r.els.notesWrap.hidden === false,
  String(r.els.notesWrap.hidden));
check('note: ...and the write may state it', r.noteKnown === true, String(r.noteKnown));

r = run(boolHabit, '2026-03-15', 2, false, {}, 'point', '');
check('no note: the box is empty', r.els.notes.value === '', JSON.stringify(r.els.notes.value));
check('no note: ...and still SHOWN — a day with no note is a day you can write one on',
  r.els.notesWrap.hidden === false, String(r.els.notesWrap.hidden));
check('no note: ...and the write states the empty string, which is a stated clear',
  r.noteKnown === true, String(r.noteKnown));

// The default path, which every case above this block takes. Pinned explicitly
// rather than left implied: `undefined` must go on meaning "no note" and not
// become the third answer by accident.
r = run(boolHabit, '2026-03-15', 2, false);
check('an absent argument is "no note", never "unknown"',
  r.noteKnown === true && r.els.notesWrap.hidden === false && r.els.notes.value === '',
  `${r.noteKnown} / ${r.els.notesWrap.hidden} / ${JSON.stringify(r.els.notes.value)}`);

r = run(boolHabit, '2026-03-15', 2, false, {}, 'point', null);
check('unknown note: the box is HIDDEN, never shown empty',
  r.els.notesWrap.hidden === true, String(r.els.notesWrap.hidden));
check('unknown note: ...and the write must not state one',
  r.noteKnown === false, String(r.noteKnown));

console.log(fails === 0 ? '\nALL DIALOG CHECKS PASSED' : `\n${fails} DIALOG CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
