/**
 * Recording an amount from the grid, followed all the way to storage.
 *
 * The model is `unknowncheck.mjs`'s: tap, then ask the API what the row
 * actually says. A unit test can pin `parseAmount`, and only this can catch the
 * control and the database disagreeing about what was typed — which is exactly
 * what `<input type="number">` did, silently, in two different directions.
 *
 * Measured in Chrome before the change, typing into an input with the day
 * editor's own attributes:
 *
 *   typed "8,5"  -> .value "85"   the comma dropped, ten times the amount
 *   typed "abc"  -> .value ""     read as "no entry" — the day DELETED
 *
 * Both are checked here against what the server holds afterwards, because both
 * are states where every visible surface looks like it worked.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitForRow, waitUntil,
} from './chrome.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3000', PORT = devtoolsPort(9236);
const profile = mkdtempSync(join(tmpdir(), 'habcount-'));
const chrome = launchChrome(PORT, profile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (l, c, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' :: ' + e : ''}`);
  if (!c) fails++;
};
let ws, nid = 1; const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

try {
  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: BASE }, sessionId);
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
    await sleep(250);
  }

  /** The measurable habit's id and today's date, from the API itself. */
  const target = await ev(`(async()=>{
    const d = await (await fetch('/api/overview?days=7')).json();
    const h = d.habits.find(x => x.type === 'numerical' && x.target_type !== 'at_most');
    return { id: h.id, name: h.name, unit: h.unit, target: h.target_value, end: d.end };
  })()`);
  console.log(`    habit: ${target.name} (target ${target.target} ${target.unit})`);

  /**
   * Tap today's cell for that habit, and wait for the dialog.
   *
   * The wait for the row is INSIDE here, and it names the habit. Every caller
   * after a reload used to poll for any `#grid .habit-row` and then come
   * straight here, which is a weaker condition than the next line needs: the
   * grid can hold rows while THIS habit's is still to come. What that produced
   * was `row.querySelector` on an undefined `row` — a bare
   * `Cannot read properties of undefined`, which is the same output a suite
   * gives when another runner has deleted its data, and is why run.mjs's header
   * calls it one signature with two causes. Reproduced on a contended CI runner
   * at six workers on four cores; the poll below is the half that was missing.
   */
  const rowReady = (name) => waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-row')]`
    + `.some(r => r.textContent.includes(${JSON.stringify(name)}))`,
    { what: `the "${name}" row` });

  const openToday = async () => {
    await rowReady(target.name);
    await ev(`(()=>{
      const rows = [...document.querySelectorAll('#grid .habit-row')];
      const row = rows.find(r => r.textContent.includes(${JSON.stringify(target.name)}));
      const cell = row.querySelector('.day-cell, .check, button[data-focus-key^="check:"]');
      cell.click(); return true;})()`);
    for (let i = 0; i < 40; i++) {
      if (await ev(`document.getElementById('count-dialog').open === true`)) return true;
      await sleep(100);
    }
    return false;
  };

  /** What the server holds for today, after the dust settles. */
  const stored = async () => ev(`(async()=>{
    const es = await (await fetch('/api/habits/${target.id}/entries')).json();
    const row = es.find(e => e.date === ${JSON.stringify(target.end)});
    return row ? { value: row.value, status: row.status } : null;})()`);

  /**
   * Wait for today's stored amount to BECOME `value`, rather than reading it
   * once and hoping the write has landed.
   *
   * `typeAndSave`'s settle is a duration, and a duration is a guess in both
   * directions — the rule the root CLAUDE.md states. It was long enough here
   * and not on a loaded CI runner: the fixture seeds today at `10 + (i % 21)`,
   * so a read that arrived before the write reported **10** and the failure
   * read `"8,5" is stored as 8.5 :: {"value":10}` — a number the test never
   * typed and which looks like an amount parser dropping a comma rather than
   * like a race. That is the worst shape a flake can take: a wrong answer that
   * implicates the code under test.
   *
   * Only the call sites that expect a CHANGE use this. The refusal cases below
   * assert that the stored row did NOT move, which has no predicate to poll and
   * so keeps its settle — the exception the same rule carves out.
   */
  const storedBecomes = (value) => waitUntil(ev, `(async()=>{
    const es = await (await fetch('/api/habits/${target.id}/entries')).json();
    const row = es.find(e => e.date === ${JSON.stringify(target.end)});
    return !!row && row.value === ${value};})()`,
  { what: `today's stored amount to become ${value}` });

  /** Put text in the box as a person would, then press Save. */
  const typeAndSave = async (text) => {
    await ev(`(()=>{
      const i = document.getElementById('grid-count-typed');
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('count-save').click(); return true;})()`);
    await sleep(700);
  };

  console.log('\n--- the grid asks for an amount in the app, not in an OS prompt ---');
  // `window.prompt` blocks the event loop and is suppressed outright by a
  // browser that decides the page makes too many dialogs, after which tapping a
  // measurable day did nothing at all. Overriding it here proves the app never
  // reaches for it: if it did, this would hang or record nothing.
  await ev(`window.prompt = () => { window.__prompted = true; return null; };
    window.__prompted = false; true`);
  check('tapping a measurable day opens the count dialog', await openToday());
  check('and nothing called window.prompt()', await ev(`window.__prompted === false`));
  check('the dialog names the habit',
    await ev(`document.getElementById('count-title').textContent`) === target.name);
  // The unit belongs beside the number or the box is asking an unstated
  // question — the whole complaint against the prompt(), which crammed the
  // habit name into its message and had nowhere to put this.
  check('and labels the box with the unit',
    await ev(`document.querySelector('#grid-count legend').textContent`)
      === `Amount (${target.unit})`,
    await ev(`document.querySelector('#grid-count legend').textContent`));

  console.log('\n--- a decimal comma is the amount, not ten times it ---');
  await typeAndSave('8,5');
  await storedBecomes(8.5);
  let row = await stored();
  check('"8,5" is stored as 8.5', row?.value === 8.5, JSON.stringify(row));

  console.log('\n--- the steppers move by the goal, not by 1 ---');
  check('reopened', await openToday());
  await ev(`document.querySelector('#grid-count .countfield-step[data-step="1"]').click(); true`);
  const stepped = await ev(`document.getElementById('grid-count-typed').value`);
  // The fixture's target is 20 pages, so an eighth of it snaps to 2.
  check('+ steps by more than 1 on a habit whose goal is bigger',
    Number(stepped) === 10.5, `${stepped} (was 8.5)`);

  console.log('\n--- an unreadable amount is an error, never a deletion ---');
  await typeAndSave('abc');
  row = await stored();
  check('the day is NOT deleted', row !== null, JSON.stringify(row));
  // 8.5, not the 10.5 now in the box: the step was never saved, so what has to
  // survive an unreadable Save is the amount the server already held.
  check('and the amount already stored is untouched', row?.value === 8.5, JSON.stringify(row));
  check('the dialog stays open, saying so',
    await ev(`document.getElementById('count-dialog').open === true`));
  check('with the complaint on screen',
    /not an amount/.test(await ev(
      `document.querySelector('#grid-count .countfield-hint').textContent`)));

  console.log('\n--- an AMBIGUOUS amount is told how to fix itself ---');
  // "10,000" is refused because it could be ten thousand or ten and a half, not
  // because it is nonsense — so "not an amount" is the wrong sentence for it,
  // and it is the sentence somebody gets for typing their step goal the way
  // their own keyboard and country write it. The phone has said the actionable
  // thing since #111; this is the web catching up, followed to the row because
  // the refusal and the non-deletion are one behaviour.
  await typeAndSave('10,000');
  row = await stored();
  check('the ambiguous amount is not stored', row?.value === 8.5, JSON.stringify(row));
  const hint = await ev(
    `document.querySelector('#grid-count .countfield-hint').textContent`);
  check('and the complaint says what to type instead', /10000/.test(hint), hint);
  check('rather than only that it is not a number',
    !/^\"10,000\" is not an amount/.test(hint), hint);

  // ...and the STEPPER says it too. Both refusal sites in `count-field.js` go
  // through `amountComplaint`, and only this one is reachable without saving —
  // a review found the Save site pinned and this one not, which is the "fixed
  // two of three call sites" shape the repo keeps paying for.
  await ev(`(()=>{
    const i = document.getElementById('grid-count-typed');
    i.value = '10,000';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#grid-count .countfield-step[data-step="1"]').click();
    return true;})()`);
  await sleep(300);
  const stepHint = await ev(
    `document.querySelector('#grid-count .countfield-hint').textContent`);
  check('the stepper refuses it with the same sentence',
    /without the thousands separator/.test(stepHint), stepHint);

  console.log('\n--- a limit of zero gets the button its whole point needs ---');
  // Closed first. The section above leaves the dialog open, and clicking a grid
  // cell under it drives `showModal()` on an already-modal dialog — a no-op in
  // Chrome since 2022, so it worked, but it is a state no user can reach and a
  // suite should not depend on.
  // `[0, target]` guarded on `target > 0` withheld the 0 preset from exactly
  // the habit the code's own comment says it is for — an at-most-0 limit, where
  // 0 is the day worth recording — and the goal line vanished from the hint for
  // the same reason. Checked against the fixture's own limit habit.
  await ev(`document.getElementById('count-cancel').click(); true`);
  await sleep(200);
  const limit = await ev(`(async()=>{
    const d = await (await fetch('/api/overview?days=7')).json();
    const h = d.habits.find(x => x.target_type === 'at_most');
    const rows = [...document.querySelectorAll('#grid .habit-row')];
    const row = rows.find(r => r.textContent.includes(h.name));
    row.querySelector('.day-cell, .check, button[data-focus-key^="check:"]').click();
    return { name: h.name, target: h.target_value };})()`);
  await sleep(400);
  console.log(`    limit habit: ${limit.name} (at most ${limit.target})`);
  const presets = await ev(
    `[...document.querySelectorAll('#grid-count .countfield-presets button')].map(b=>b.textContent)`);
  check('a limit of 0 still offers the 0 button', presets.includes('0'), JSON.stringify(presets));
  check('and only one of it', presets.length === 1, JSON.stringify(presets));
  check('the hint still states the goal',
    /at most 0/.test(await ev(
      `document.querySelector('#grid-count .countfield-hint').textContent`)),
    await ev(`document.querySelector('#grid-count .countfield-hint').textContent`));
  await ev(`document.getElementById('count-cancel').click(); true`);
  await sleep(200);

  console.log('\n--- a targetless habit is not told it has a goal of 0 ---');
  // 0 is a real goal on a LIMIT and is what `parseHabit` stores for "no target"
  // on an at-least habit — `stepFor` reads it as the second. Testing the number
  // rather than the kind told every targetless measurable habit it had a target
  // of zero, which is a goal it meets by doing nothing.
  const none = await ev(`(async()=>{
    const r = await fetch('/api/habits', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name:'Pages read', type:'numerical', unit:'pages',
        target_value: 0, target_type:'at_least' }) });
    return (await r.json()).id;})()`);
  // This one finds its row by hand rather than through `openToday`, so the
  // reload and the wait for it are one call. It is a habit created moments
  // ago by a raw `fetch` the page never saw, so "the grid has rows" is
  // emphatically not the same question as "the grid has THIS row".
  await reloadAndWaitForRow(ev, 'Pages read');
  await ev(`(()=>{const rows=[...document.querySelectorAll('#grid .habit-row')];
    const row = rows.find(r => r.textContent.includes('Pages read'));
    row.querySelector('.day-cell, .check, button[data-focus-key^="check:"]').click();
    return true;})()`);
  await sleep(400);
  const noneHint = await ev(
    `document.querySelector('#grid-count .countfield-hint').textContent`);
  check('no target means no goal line', !/Target at least 0/.test(noneHint), noneHint);
  await ev(`document.getElementById('count-cancel').click(); true`);
  await ev(`fetch('/api/habits/' + ${none}, { method:'DELETE' })`);
  await sleep(200);

  console.log('\n--- zero is an answer; empty is not ---');
  // Back to the at-least habit: the section above closed the dialog on a
  // different one, and Save on a closed dialog writes nothing.
  check('reopened', await openToday());
  await typeAndSave('0');
  row = await stored();
  check('0 writes a row — a stated lapse, not a deletion',
    row !== null && row.value === 0, JSON.stringify(row));

  check('reopened', await openToday());
  await typeAndSave('');
  row = await stored();
  check('an empty box clears the day', row === null, JSON.stringify(row));

  console.log('\n--- the habit dialog asks for a GOAL the same way (#156) ---');
  /*
   * The third surface that records an amount, and the last one still holding
   * the control this suite's header measures. `<input type="number">` was the
   * Target box until #156, so "8,5" typed into a habit's goal reached storage
   * as 85 and "abc" as `Number('abc') || 0` — a goal quietly deleted, which
   * every visible surface reports as a save that worked.
   *
   * Followed to storage rather than to the box, exactly as the sections above
   * are, and driven with REAL key events: the whole defect is what the CONTROL
   * does with a keystroke, so assigning `.value` from script bypasses the
   * browser's own filtering and passes against the unfixed build.
   * `categorycheck.mjs` drives `Input.dispatchKeyEvent` for the same reason.
   */

  /** One printable character, as a keyboard delivers it. */
  const typeChar = async (ch) => {
    await send('Input.dispatchKeyEvent',
      { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sessionId);
  };

  /** A named key that types nothing of its own. `modifiers`: 2 is Ctrl. */
  const pressKey = async (key, code, vk, modifiers = 0) => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type, key, code, modifiers,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      }, sessionId);
    }
  };

  const targetBox = `document.querySelector('#habit-form [name=target_value]')`;

  /**
   * Open a habit's own page and press Edit — the habit dialog's edit path, the
   * way `categorycheck.mjs` already reaches it. `#btn-new` is the create path
   * and has no stored target to preserve.
   *
   * The wait is on the dialog being open AND the Target box holding `filled`,
   * because that string is what the next line types over — "the dialog is
   * open" alone returns while `openDialog` may not have filled the box yet,
   * which is the weak-predicate bug this suite's `rowReady` was written for.
   *
   * `filled` is omitted only where what the box was filled WITH is the thing
   * being checked, and then the failure has to be a named check rather than a
   * timeout in here. `.open === true` is enough on its own for that: the fill
   * is synchronous and `openDialog` does it before `showModal()`.
   */
  const openHabitEdit = async (name, filled) => {
    await rowReady(name);
    await ev(`(()=>{
      const row = [...document.querySelectorAll('#grid .habit-row')]
        .find(r => r.querySelector('.habit-name').textContent.trim() === ${JSON.stringify(name)});
      row.querySelector('.habit-meta').click(); return true;})()`);
    await waitUntil(ev,
      `!document.getElementById('view-detail').hidden`
      + ` && document.querySelector('#view-detail h2')?.textContent.includes(${JSON.stringify(name)})`
      + ` && [...document.querySelectorAll('#view-detail button')]`
      + `.some(b => b.textContent.trim() === 'Edit')`,
      { what: `${name}'s own page` });
    await ev(`[...document.querySelectorAll('#view-detail button')]
      .find(b => b.textContent.trim() === 'Edit').click(); true`);
    await waitUntil(ev,
      `document.getElementById('habit-dialog').open === true`
      + (filled === undefined ? '' : ` && ${targetBox}?.value === ${JSON.stringify(filled)}`),
      { what: `the habit dialog${filled === undefined ? '' : ` filled with a target of "${filled}"`}` });
  };

  /** Replace whatever the Target box holds with `text`, as a keyboard would. */
  const typeTarget = async (text) => {
    await ev(`${targetBox}.focus(); true`);
    // Select-all then Backspace rather than `setSelectionRange`, which THROWS
    // on a number input — under the `type="number"` mutation this block has to
    // fail on the assertion, not on an exception from the harness.
    await pressKey('a', 'KeyA', 65, 2);
    await pressKey('Backspace', 'Backspace', 8);
    for (const ch of text) await typeChar(ch);
  };

  const submitDialog = () => ev(`document.getElementById('habit-form').requestSubmit(); true`);
  const dialogClosed = () => waitUntil(ev,
    `document.getElementById('habit-dialog').open === false`,
    { what: 'the habit edit to save' });
  // Satisfied in BOTH worlds — the hint filling in (refused) or the dialog
  // closing (submitted anyway) — so a regression fails the checks below BY
  // NAME rather than timing out inside `waitUntil` with nothing to read.
  // `categorycheck.mjs`'s Enter block is where this shape comes from.
  const settled = () => waitUntil(ev,
    `document.getElementById('target-hint').textContent !== ''`
    + ` || document.getElementById('habit-dialog').open === false`,
    { what: 'the target box to complain, or the dialog to save anyway' });
  const targetHint = () => ev(`document.getElementById('target-hint').textContent`);
  const habitNow = () => ev(`(async()=>{
    const list = await (await fetch('/api/habits')).json();
    const h = list.find(x => x.id === ${target.id});
    return h ? { target_value: h.target_value, color: h.color, type: h.type } : null;})()`);

  // From the dashboard, with nothing else open: the sections above leave the
  // page on whatever they last touched, and the Target box is reached by a
  // real keystroke, which goes to the topmost modal rather than to whichever
  // element a script focused underneath one.
  await send('Page.navigate', { url: BASE }, sessionId);

  await openHabitEdit(target.name, String(target.target));
  await typeTarget('8,5');
  await submitDialog();
  await dialogClosed();
  let habit = await habitNow();
  check('"8,5" typed as a habit\'s TARGET is stored as 8.5, not 85',
    habit?.target_value === 8.5, JSON.stringify(habit));

  await openHabitEdit(target.name, '8.5');
  await typeTarget('10,000');
  await submitDialog();
  await settled();
  let hintText = await targetHint();
  check('an ambiguous target is refused with what to type instead',
    /10000/.test(hintText), hintText);
  check('the habit dialog stays open, saying so',
    await ev(`document.getElementById('habit-dialog').open === true`));
  habit = await habitNow();
  check('and the stored target is untouched', habit?.target_value === 8.5, JSON.stringify(habit));
  // The `.error` colour is scoped per hint in the stylesheet — `.timefield`,
  // `.countfield`, `#category-hint` — so this one needs a rule of its own or a
  // refusal is painted as ordinary help text. Compared against the reminder
  // hint, which is the same class in the same dialog and is not in error.
  const hintPaint = await ev(`(()=>{
    const t = document.getElementById('target-hint');
    return { error: t.classList.contains('error'),
      refused: getComputedStyle(t).color,
      ordinary: getComputedStyle(document.getElementById('reminder-hint')).color };})()`);
  check('and the refusal is painted as one',
    hintPaint.error && hintPaint.refused !== hintPaint.ordinary, JSON.stringify(hintPaint));

  // Still in the same dialog: the refusal above submitted nothing.
  await typeTarget('abc');
  await submitDialog();
  await settled();
  hintText = await targetHint();
  check('"abc" is refused rather than stored as 0', /not an amount/.test(hintText), hintText);
  habit = await habitNow();
  check('and the goal it would have deleted is still there',
    habit?.target_value === 8.5, JSON.stringify(habit));

  // The `input` listener clears `#target-hint` on every keystroke — a
  // refusal should get out of the way as soon as you start retyping, rather
  // than sitting there red under a box you are already fixing. While the
  // "abc" refusal above is still on screen, and before anything is
  // submitted, type one more character and confirm the hint clears and
  // drops its `.error` class immediately, with no Save involved.
  await ev(`${targetBox}.focus(); true`);
  await typeChar('1');
  const clearedOnType = await ev(`(()=>{
    const t = document.getElementById('target-hint');
    return { text: t.textContent, error: t.classList.contains('error') };})()`);
  check('typing over a refusal clears the hint immediately',
    clearedOnType.text === '' && !clearedOnType.error, JSON.stringify(clearedOnType));

  // Re-establish a refusal for the Cancel check below, which needs one on
  // screen — the keystroke just above cleared the one this block started
  // with.
  await typeTarget('abc');
  await submitDialog();
  await settled();

  // `openDialog` calls `targetHint('')` on every open — "or a refusal from
  // the last habit's dialog survives into this one." That is a SEPARATE
  // reset from the keystroke one above: cancel the dialog with the "abc"
  // refusal still on screen, then reopen it and check the hint came back
  // clean.
  hintText = await targetHint();
  check('the refusal is still on screen right before Cancel', hintText !== '', hintText);
  await ev(`document.getElementById('dialog-cancel').click(); true`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the habit dialog to close on Cancel' });
  await openHabitEdit(target.name, '8.5');
  const reopenedHint = await ev(`(()=>{
    const t = document.getElementById('target-hint');
    return { text: t.textContent, error: t.classList.contains('error') };})()`);
  check("a refusal does not survive into the next habit's dialog",
    reopenedHint.text === '' && !reopenedHint.error, JSON.stringify(reopenedHint));

  // Leaves the dialog open on this habit, holding its stored target of "8.5"
  // — exactly what the block below expects to type over.
  await typeTarget('');
  await submitDialog();
  await dialogClosed();
  habit = await habitNow();
  // Deliberately preserved behaviour, not an accident of `|| 0`: an empty
  // Target box is "a habit with no target", and it is asserted here so a later
  // change cannot drop it in silence. It is NOT the day editor's empty box,
  // which is a delete.
  check('an empty Target box still means a habit with no target',
    habit?.target_value === 0, JSON.stringify(habit));

  /* ---------- the whole of the adopted decision: an untouched box submits
     the STORED target verbatim ----------

     A target has never been bounded server-side, so a value `parseAmount`
     refuses can reach a habit from the phone, from any import, or from the
     `type="number"` box this change removes. `PUT /habits/:id` REPLACES, so
     inheriting the day amount's domain would refuse a dialog over a field
     nobody touched. Written through the API with a FULL body for that same
     replace rule. */
  await ev(`(async()=>{
    const list = await (await fetch('/api/habits')).json();
    const h = list.find(x => x.id === ${target.id});
    await fetch('/api/habits/' + ${target.id}, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...h, target_value: 0.0000001 }) });})()`);
  await send('Page.navigate', { url: BASE }, sessionId);

  // 1e-7 is under what `formatAmount` can show, and it renders as its raw self
  // rather than as "0" precisely so this rule has something true to preserve.
  await openHabitEdit(target.name, '1e-7');
  await ev(`(()=>{ document.querySelector('#habit-form [name=color]').value = '#654321';
    return true; })()`);
  await submitDialog();
  await settled();
  check('a colour-only edit is not refused over a field nobody touched',
    await ev(`document.getElementById('habit-dialog').open === false`),
    await targetHint());
  habit = await habitNow();
  check('a colour-only edit leaves an out-of-domain target exactly as it was',
    habit?.target_value === 0.0000001 && habit?.color === '#654321', JSON.stringify(habit));

  // Back to the fixture's own target for the two blocks below.
  await ev(`(async()=>{
    const list = await (await fetch('/api/habits')).json();
    const h = list.find(x => x.id === ${target.id});
    await fetch('/api/habits/' + ${target.id}, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...h, target_value: ${target.target} }) });})()`);
  await send('Page.navigate', { url: BASE }, sessionId);

  /* ---------- a refusal nobody can see is not a refusal ----------

     The Target box and `#target-hint` both live inside `.numerical-only`,
     which `syncTypeFields` hides the moment Type stops being Measurable — and
     `[hidden]` is `display: none !important` in this stylesheet. Mistype the
     target, decide the habit is a Yes / No one after all, press Save: the
     refusal is written into a hidden span and `focus()` on a hidden input is a
     no-op, so the dialog simply stops saving with nothing on screen saying why
     and no control the user can even see to fix. The reading `readTarget` has
     to make is "what does this box mean right now", and hidden it means
     nothing at all. Mutation target: the visibility gate in `readTarget`. */
  await openHabitEdit(target.name, String(target.target));
  await typeTarget('10,000');
  await ev(`(()=>{
    const t = document.querySelector('#habit-form [name=type]');
    t.value = 'boolean';
    t.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#habit-form [name=color]').value = '#abcdef';
    return true; })()`);
  await submitDialog();
  await settled();
  const stranded = await ev(`(()=>{
    const box = document.querySelector('#habit-form [name=target_value]');
    const hint = document.getElementById('target-hint');
    return {
      dialogOpen: document.getElementById('habit-dialog').open,
      hint: hint.textContent,
      hintOnScreen: hint.offsetParent !== null,
      boxOnScreen: box.offsetParent !== null,
      focused: document.activeElement === box
        ? 'the hidden target box' : (document.activeElement?.tagName ?? 'nothing'),
    };})()`);
  console.log(`    after Save: ${JSON.stringify(stranded)}`);
  check('a habit that is no longer Measurable is not refused over its hidden Target box',
    stranded.dialogOpen === false, JSON.stringify(stranded));
  habit = await habitNow();
  // The colour is what proves the save actually landed rather than the
  // assertion above being true of a dialog that closed without writing.
  check('...and the target it cannot show is kept, not zeroed',
    habit?.type === 'boolean' && habit?.color === '#abcdef'
      && habit?.target_value === target.target, JSON.stringify(habit));

  // Measurable again, and back to the dashboard, for the section below — which
  // drives the grid's count field on this same habit.
  await ev(`(async()=>{
    const list = await (await fetch('/api/habits')).json();
    const h = list.find(x => x.id === ${target.id});
    await fetch('/api/habits/' + ${target.id}, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...h, type: 'numerical' }) });})()`);
  await send('Page.navigate', { url: BASE }, sessionId);
  await rowReady(target.name);

  /* ---------- the gate is VISIBILITY, and this is the only check that can
     tell the two readings apart ----------

     The block above hides the box by switching Type, where "the box is
     hidden" and "Type is not Measurable" are the same event — so it passes
     against `readTarget` asking either one. `.numerical-only.hidden` is what
     `syncTypeFields` actually writes and `form.type.value !== 'numerical'` is
     a copy of the expression it writes it from, 750 lines away; they agree
     only while `HABIT_TYPES` has two entries and nothing else touches that
     attribute. This drives them apart by hand — the container hidden with
     Type still reading Measurable, which is what a third habit type, or any
     second reason to hide it, looks like from `readTarget` — and asserts the
     rule the comment states rather than the proxy.

     Mutation target: `readTarget`'s gate. Restore
     `form.type.value !== 'numerical'` and this check goes red on its own,
     while every other check in this suite stays green. */
  await openHabitEdit(target.name, String(target.target));
  await typeTarget('10,000');
  await ev(`(()=>{
    document.querySelector('#habit-form .numerical-only').hidden = true;
    document.querySelector('#habit-form [name=color]').value = '#fedcba';
    return true; })()`);
  await submitDialog();
  await settled();
  const offScreen = await ev(`(()=>{
    const box = document.querySelector('#habit-form [name=target_value]');
    return {
      dialogOpen: document.getElementById('habit-dialog').open,
      type: document.querySelector('#habit-form [name=type]').value,
      hint: document.getElementById('target-hint').textContent,
      boxOnScreen: box.offsetParent !== null,
    };})()`);
  console.log(`    after Save: ${JSON.stringify(offScreen)}`);
  check('a Target box hidden for a reason other than Type refuses nothing either',
    offScreen.dialogOpen === false && offScreen.type === 'numerical'
      && offScreen.boxOnScreen === false, JSON.stringify(offScreen));
  habit = await habitNow();
  check('...and that target is kept too, with the edit beside it landing',
    habit?.color === '#fedcba' && habit?.target_value === target.target,
    JSON.stringify(habit));

  // A clean page for the section below — the dialog above hid a container by
  // hand, and a reload is the cheapest way to put the DOM back.
  await send('Page.navigate', { url: BASE }, sessionId);
  await rowReady(target.name);

  console.log('\n--- a comma account reads and writes the other way round ---');
  // #108's remaining half, followed to the row for the reason the rest of this
  // suite exists: "10.000" is ten to this parser and ten thousand to the reader
  // who typed it, and being wrong there is a stored number rather than a
  // rejected form. The setting belongs to the account, so it is written through
  // the API and the page reloaded — the path a second device would take.
  await ev(`(async()=>{ await fetch('/api/settings', { method:'PUT',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ numberFormat: 'comma' }) }); })()`);
  await reloadAndWaitForRow(ev, target.name);

  check('reopened', await openToday());
  await typeAndSave('10.000');
  row = await stored();
  check('"10.000" is not quietly stored as ten', row === null, JSON.stringify(row));
  const commaHint = await ev(
    `document.querySelector('#grid-count .countfield-hint').textContent`);
  check('and the complaint names the DOT, which is what they are looking at',
    /a dot can separate thousands/.test(commaHint), commaHint);

  // ...and the comma is the decimal point now, both read and written. The
  // second half is what stops the box telling its owner they typed it wrong:
  // it accepted 8,5 and would have redrawn it as 8.5.
  await typeAndSave('8,5');
  await storedBecomes(8.5);
  row = await stored();
  check('"8,5" is stored as 8.5 on a comma account', row?.value === 8.5, JSON.stringify(row));
  check('reopened', await openToday());
  const shown = await ev(`document.getElementById('grid-count-typed').value`);
  check('and the box shows it back with a comma', shown === '8,5', shown);
  await ev(`document.getElementById('count-cancel').click(); true`);

  // ...and so does the habit dialog's Target box, which asks `count-field.js`'s
  // own `convention()` rather than composing a second answer to the same
  // question. Same reason as above: a box that reads "8,5" and writes "8.5"
  // back has told its owner they typed it wrong — and here it would also make
  // an untouched box look touched. The target is set through the API because
  // the account is mid-suite and this is about what the FILL shows.
  await ev(`(async()=>{
    const list = await (await fetch('/api/habits')).json();
    const h = list.find(x => x.id === ${target.id});
    await fetch('/api/habits/' + ${target.id}, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...h, target_value: 8.5 }) });})()`);
  await send('Page.navigate', { url: BASE }, sessionId);
  await openHabitEdit(target.name);
  const shownTarget = await ev(`${targetBox}.value`);
  check('a comma account is shown the stored TARGET in its own spelling too',
    shownTarget === '8,5', shownTarget);
  await ev(`document.getElementById('dialog-cancel').click(); true`);

  await ev(`(async()=>{ await fetch('/api/settings', { method:'PUT',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ numberFormat: 'auto' }) }); })()`);
} catch (e) {
  console.log('ERROR:', e.message);
  fails++;
} finally {
  ws?.close();
  await closeChrome({ chrome, port: PORT, profile });
  rmSync(profile, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL COUNT CHECKS PASSED');
process.exit(fails ? 1 : 0);
