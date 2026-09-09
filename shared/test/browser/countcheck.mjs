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
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome,
  reloadAndWaitFor, reloadAndWaitForRow, waitUntil,
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

/**
 * Every `/stats` request CDP has stopped and is holding, oldest first.
 *
 * `Fetch.requestPaused` is an EVENT and carries no `id`, so the dispatcher
 * below would drop it — and the last block in this file needs the requestIds
 * to release them in a chosen ORDER rather than merely to make them wait. That
 * is the difference between holding a gap open (the block before it) and
 * forcing which of two answers lands last.
 *
 * Never drained by the handler: a block asks for what it is holding, releases
 * what it wants and empties this itself, so nothing that arrives between two
 * reads can be missed.
 *
 * **This stays here rather than moving to `chrome.mjs`, and the trigger for
 * moving it is a caller in a SECOND FILE — not a third block in this one.**
 * Three suites now pause a request (`hangcheck`, `stripcheck`, here) and no
 * two of them do the same thing with it: hangcheck keeps `m.params.request`
 * and never continues anything, stripcheck keeps the whole params and answers
 * with `Fetch.fulfillRequest` and a 500, and only this file releases in a
 * chosen order. So there is one duplicated LINE — the `if (m.method ===
 * 'Fetch.requestPaused')` branch — and it is the one part that cannot move on
 * its own: it lives inside a per-suite `ws.onmessage`, and `chrome.mjs` owns
 * no socket, no `pend` map and no `send`. The two parts that could move,
 * `takePaused` and `release`, have exactly one caller each, both in the last
 * block of this file.
 *
 * So the move is not an extraction, it is `chrome.mjs` growing a collector a
 * suite wires into its own dispatcher (`onEvent(m)`) plus a `take`/`release`
 * pair over an injected `send` and `sessionId` — and normalising hangcheck's
 * `.request`-only store on the way past. That is three suites edited and a
 * new export in a file all 33 import, to serve one. Worth it the moment a
 * suite that is not this one needs to release a held reply in an order it
 * chooses; not worth it for a third block here, which would be the fourth
 * caller of two helpers already ten lines from where it would sit.
 */
const paused = [];

try {
  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    // See `paused` above: an event, so it has no `id` to answer.
    if (m.method === 'Fetch.requestPaused') paused.push(m.params);
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
  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate', { url: BASE }, sessionId),
    what: 'the dashboard',
  });

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
   * What the dialog and the server actually hold, for the timeout below.
   *
   * `waitUntil` names what it WANTED and can say nothing whatever about what
   * it got, and both CI sightings of this suite's flake (#305, #289) are that
   * one line with nothing under it — from which a dialog that never opened, a
   * Target box filled from a habit the page had not refetched yet, and a save
   * that never reached storage are indistinguishable. Read in ONE evaluation
   * so the four answers describe one instant, and the stored target read from
   * `/api/habits` beside them so the page and the server can be told apart.
   *
   * Swallowed on its own account: a diagnostic that throws replaces the
   * failure it is describing, which is worse than no diagnostic at all.
   */
  const dialogState = (name) => ev(`(async()=>{
    const box = ${targetBox};
    const list = await (await fetch('/api/habits')).json();
    const h = list.find(x => x.name === ${JSON.stringify(name)});
    return {
      dialogOpen: document.getElementById('habit-dialog').open,
      boxPresent: !!box,
      boxValue: box ? box.value : null,
      storedTarget: h ? h.target_value : null,
    };})()`).catch((e) => ({ unreadable: e.message }));

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
   *
   * The diagnostic hangs off the helper rather than off a call site because
   * every caller reaches this same wait, and the thrown error is rethrown
   * untouched — its sentence is what both issues and the CI logs quote.
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
    try {
      await waitUntil(ev,
        `document.getElementById('habit-dialog').open === true`
        + (filled === undefined ? '' : ` && ${targetBox}?.value === ${JSON.stringify(filled)}`),
        { what: `the habit dialog${filled === undefined ? '' : ` filled with a target of "${filled}"`}` });
    } catch (err) {
      console.log(`    when the wait gave up: ${JSON.stringify(await dialogState(name))}`);
      throw err;
    }
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

  /**
   * The subtitle under the open habit's title, exactly as it reads now.
   *
   * Read BEFORE a submit and handed to `dialogClosed` below, which waits for
   * it to stop reading that way. It throws rather than answering `null` when
   * that page is not showing: a `before` of `null` would make the wait below
   * satisfied by the first poll — a guard that has quietly stopped asserting
   * is the whole failure mode this section is written around.
   */
  const habitSub = async () => {
    const text = await ev(
      `document.querySelector('#view-detail .habit-sub')?.textContent ?? null`);
    if (text === null) {
      throw new Error("no #view-detail .habit-sub to read — is a habit's own page showing?");
    }
    return text;
  };

  /**
   * Wait for a save to land — in the STORE the page is drawing from, not only
   * in `dialog.open`.
   *
   * The two are separate events and only the first used to be waited for.
   * `saveHabit` calls `dialog.close()` and then `announce()`, which from a
   * habit's own page emits `'change'`; `detail.js` answers that with a fresh
   * `/stats` + `/entries` round trip and rebuilds the page from the reply. The
   * Edit button is rebuilt with it, and it CAPTURES the habit it was drawn
   * from — so until that render lands, pressing Edit calls
   * `openDialog(theHabitBeforeTheSave)` and fills the Target box with the old
   * value. Nothing about the dialog says so, and `habitNow()` cannot see it
   * either: that is its own `fetch`, and it correctly reports the new target
   * while the page is still holding the old one.
   *
   * What that produced is #305 / #289 — `openHabitEdit`'s fill wait spending
   * its whole 20s on a string the box was never going to hold, roughly one
   * suite instance in eight at eight `countcheck`s on two cores. This is the
   * corollary the root CLAUDE.md states: a poll on a weak condition is worse
   * than the sleep it replaced, because it returns the instant something
   * unrelated is true.
   *
   * `.habit-sub` is asked rather than the button, because the head's subtitle
   * is drawn from the SAME `habit` object the Edit listener closes over, in
   * the same `render()` — so the page holding new habit data IS the button
   * holding it, with no second thing to keep in step. That node is
   * `[description, freqLabel, targetLabel]` joined (`detail.js`) and nothing
   * else rewrites it, so "it CHANGED" is "a post-save render landed", which
   * is the whole of what this has to establish.
   *
   * **And changed is all it may ask. A wait must not restate what the render
   * is being checked to SAY.** The named check two lines below each call site
   * is what reads the saved value back — `"8,5" ... is stored as 8.5, not
   * 85` — and a wait that encodes 8.5 gets there first: reintroduce #156 and
   * the page draws `≥ 85 pages`, this wait spends its whole 20s on a string
   * the subtitle will never hold, throws to the file's top-level `catch`, and
   * 24 later checks lose their verdicts — all of it reported as a timeout
   * naming a target, where what the reader needs is the one named FAIL
   * quoting the 85 that was stored. That is `settled()`'s
   * rule immediately below — satisfied in BOTH worlds, so a regression fails
   * BY NAME — and this is the same rule at the same distance from the same
   * checks.
   *
   * Comparing against what the node HELD is also what disposes of the
   * boundary problem, and that argument is kept because the value-encoding
   * version is what gets proposed again. A computed label matched with
   * `includes("≥ " + value)` ends nowhere: `dialogClosed(2)` is satisfied by
   * the `≥ 20 pages` that was on screen BEFORE the save, and the wait then
   * collapses to `dialog.open === false` — the guard failing open into
   * exactly the flake it exists to stop. `endsWith`, plus the unit as the
   * number's right-hand boundary, closes that hole and buys it by restating
   * the expected value, which is the dearer of the two. A comparison against
   * the previous text needs no boundary at all: any difference is a render,
   * and no old text is a prefix, a suffix or a substring of ITSELF.
   *
   * The property that costs is the caller's: a save leaving the subtitle
   * byte-identical would hang here for the full 20s. No caller does one —
   * both move the target (20 → 8.5, then 8.5 → 0, which drops the label
   * entirely) — and the colour-only edit further down, which would, goes
   * through `settled()` already. A caller saving something this subtitle does
   * not show needs its own wait on something that DOES move, not a widening
   * of this one.
   *
   * @param {string} before  `.habit-sub`'s text, read before the submit
   */
  const dialogClosed = (before) => waitUntil(ev,
    `(()=>{ const sub = document.querySelector('#view-detail .habit-sub');
      return document.getElementById('habit-dialog').open === false
        && !!sub && sub.textContent !== ${JSON.stringify(before)};})()`,
    { what: 'the habit edit to save, and the page behind it to redraw away from'
      + ` "${before}"` });
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
  await reloadAndWaitForRow(ev, target.name, {
    reload: () => send('Page.navigate', { url: BASE }, sessionId),
  });

  await openHabitEdit(target.name, String(target.target));
  await typeTarget('8,5');
  let subBefore = await habitSub();
  await submitDialog();
  await dialogClosed(subBefore);
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
  subBefore = await habitSub();
  await submitDialog();
  await dialogClosed(subBefore);
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
  await reloadAndWaitForRow(ev, target.name, {
    reload: () => send('Page.navigate', { url: BASE }, sessionId),
  });

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
  await reloadAndWaitForRow(ev, target.name, {
    reload: () => send('Page.navigate', { url: BASE }, sessionId),
  });

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
  await reloadAndWaitForRow(ev, target.name, {
    reload: () => send('Page.navigate', { url: BASE }, sessionId),
  });

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
  await reloadAndWaitForRow(ev, target.name, {
    reload: () => send('Page.navigate', { url: BASE }, sessionId),
  });

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
  await reloadAndWaitForRow(ev, target.name, {
    reload: () => send('Page.navigate', { url: BASE }, sessionId),
  });

  // ...and so does the PROSE beside the number, which is the half that was
  // left out. `targetLabel` (`ui/dates.js`) was a raw template literal, so the
  // dashboard row and the detail head read `≥ 8.5 pages` while the box three
  // lines away in the same render held `8,5` — one number, two spellings, on
  // one screen. Read on the dashboard first because that is what this reload
  // landed on.
  //
  // The negative conjunct is not decoration: `includes('≥ 8,5 pages')` alone
  // would pass on a row that somehow carried both, and the point is that the
  // dot spelling is GONE from a comma account's screen.
  const rowSub = await ev(`(() => [...document.querySelectorAll('#grid .habit-row')]
    .find(r => r.querySelector('.habit-name').textContent.trim()
      === ${JSON.stringify(target.name)})
    ?.querySelector('.habit-sub')?.textContent ?? '')()`);
  check("a comma account's dashboard row states the goal in its own spelling",
    rowSub.includes('≥ 8,5 pages') && !rowSub.includes('8.5'), rowSub);

  await openHabitEdit(target.name);
  const shownTarget = await ev(`${targetBox}.value`);
  check('a comma account is shown the stored TARGET in its own spelling too',
    shownTarget === '8,5', shownTarget);

  // The two surfaces this bug was reported from, read in ONE evaluation and
  // compared with each other rather than each against a literal — a unit test
  // can pin `targetLabel` under both conventions and cannot say that the head
  // and the box behind it AGREE. The head is drawn by `render()` from the same
  // habit `openDialog` filled the box from, and until this change they
  // disagreed about the one number both were describing.
  const bothSurfaces = await ev(`(() => ({
    head: document.querySelector('#view-detail .habit-sub')?.textContent ?? '',
    box: ${targetBox}?.value ?? '',
  }))()`);
  check("the detail head and the Edit box agree about a comma account's target",
    bothSurfaces.head.endsWith('≥ 8,5 pages') && bothSurfaces.box === '8,5',
    JSON.stringify(bothSurfaces));

  // A save from HERE, deliberately: it is what makes `dialogClosed`'s own
  // save under a comma account, which the two above are not. It no longer has
  // to defend the WAIT — `dialogClosed` compares the subtitle against what it
  // previously held, so no expectation is spelled and no account can disagree
  // with it. What it still buys is the assertion below: the page must redraw a
  // retyped `9,5` in this account's own spelling, and the two call sites above
  // sit on a point account and cannot say that.
  const commaSubBefore = await habitSub();
  await typeTarget('9,5');
  await submitDialog();
  await dialogClosed(commaSubBefore);
  habit = await habitNow();
  check('a comma account can retype its target, and the page redraws in its own '
    + 'spelling', habit?.target_value === 9.5, JSON.stringify(habit));
  check('...and that redraw is spelled with a comma, not a point',
    (await habitSub()).includes('9,5'), await habitSub());

  // ...and so does the FOURTH surface, the day editor's subtitle, which is not
  // a `targetLabel` caller at all — it says the direction in words rather than
  // as `≥`, because it is a sentence about the day being edited, so it carried
  // its own template literal and its own copy of this bug.
  //
  // Pinned HERE rather than in `daydialog.mjs`, and the distinction is the one
  // the root `CLAUDE.md` draws between pinning the DECISION and pinning the
  // WIRING. That harness slices `openDayDialog` out of its module and hands
  // every free identifier in, the formatter included, so it can see that the
  // subtitle spells the goal through whatever it is GIVEN and cannot see which
  // one the module asks for: `convention()` replaced by a literal `'point'` in
  // `ui/day-dialog.js` passes there, and fails on the line below.
  //
  // Opened from the calendar because that is the surface that opens this
  // dialog on a habit's own page — a strip tap on a measurable habit opens the
  // amount control instead. The newest editable cell, so no assumption is made
  // about how much history the fixture has.
  await ev(`(() => {
    const cells = [...document.querySelectorAll(
      '#view-detail svg[aria-label="Completion calendar"] rect[cursor="pointer"]')];
    cells.at(-1)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;})()`);
  await sleep(300);
  const daySub = await ev(`(() => ({
    open: document.getElementById('day-dialog').open,
    sub: document.getElementById('day-sub').textContent,
  }))()`);
  // The negative conjunct for the same reason the dashboard row's has one: a
  // subtitle carrying both spellings would satisfy the positive alone, and the
  // claim is that the dot spelling is GONE from a comma account's screen.
  check("a comma account's day editor states the goal in its own spelling too",
    daySub.open === true && daySub.sub.endsWith('at least 9,5 pages')
    && !daySub.sub.includes('9.5'), JSON.stringify(daySub));
  await ev(`document.getElementById('day-cancel').click(); true`);

  await ev(`(async()=>{ await fetch('/api/settings', { method:'PUT',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ numberFormat: 'auto' }) }); })()`);

  console.log('\n--- Edit, in the gap between the save and the refetch ---');
  /*
   * The window #305's flake was the suite noticing, asserted as the bug it is.
   *
   * `saveHabit` closes the dialog and then `announce()`s; from a habit's own
   * page that is `'change'`, which `ui/detail.js` answers with `/stats` and
   * then `/entries` — two sequential round trips, the second unwindowed — and
   * only then a `render()`. The head's Edit button CAPTURES the habit it was
   * drawn from, so in that gap pressing Edit used to open the dialog on the
   * PRE-SAVE habit; press Save without touching anything and, because `PUT
   * /habits/:id` REPLACES, the edit just made is written back out. Two ordinary
   * presses, and the loss is silent.
   *
   * The gap is milliseconds on a healthy machine, so it is HELD OPEN rather
   * than raced: CDP `Fetch` pauses `/stats` and never continues it, which is
   * `hangcheck.mjs`'s mechanism. The service worker is bypassed for the reason
   * `calcheck.mjs` records having measured — network interception does not
   * reach the WORKER's own fetches, and with it in front `networkFirst` would
   * answer `/stats` out of `DATA_CACHE`, the page would rebuild, and every
   * check below would pass against the unfixed code.
   *
   * The page is opened BEFORE the pause: `openHabitEdit` needs the same
   * `/stats` to get there at all.
   */
  await ev(`(async()=>{
    const list = await (await fetch('/api/habits')).json();
    const h = list.find(x => x.id === ${target.id});
    await fetch('/api/habits/' + ${target.id}, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...h, target_value: ${target.target} }) });})()`);
  await reloadAndWaitForRow(ev, target.name, {
    reload: () => send('Page.navigate', { url: BASE }, sessionId),
  });
  await openHabitEdit(target.name, String(target.target));

  await send('Network.enable', {}, sessionId);
  await send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
  await send('Fetch.enable',
    { patterns: [{ urlPattern: '*/api/habits/*/stats*' }] }, sessionId);
  // So the guard below counts THIS save's refetch and not the buffer's history.
  await ev(`performance.clearResourceTimings(); true`);

  await typeTarget('12,5');
  await submitDialog();
  // `dialog.open === false` alone, deliberately NOT `dialogClosed` — that wait
  // now includes the head redrawing, which is half of what this block is
  // testing, so using it here would turn a failure into a 20s timeout with the
  // interesting values never printed.
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the habit dialog to close on Save' });

  const inTheGap = await ev(`(async()=>{
    const list = await (await fetch('/api/habits')).json();
    const h = list.find(x => x.id === ${target.id});
    return {
      // Zero is the guard, and it is what makes the checks below mean anything:
      // if the refetch had landed, the page would be right for a reason this
      // block is not about and would pass with no seeding in the code at all.
      statsLanded: performance.getEntriesByType('resource')
        .filter(e => e.name.includes('/stats')).length,
      stored: h ? h.target_value : null,
      head: document.querySelector('#view-detail .habit-sub')?.textContent ?? '',
    };})()`);
  check('the save reached storage', inTheGap.stored === 12.5, JSON.stringify(inTheGap));
  check('...and the refetch behind it is still out, so nothing has rebuilt from '
    + 'the server', inTheGap.statsLanded === 0, JSON.stringify(inTheGap));
  check('...yet the head already states the target that was saved',
    inTheGap.head.endsWith('≥ 12.5 pages'), JSON.stringify(inTheGap));

  // The check this whole block exists for. Pressing Edit here used to fill the
  // box from the habit the last render captured — `20`, the value typed over —
  // and Save from there reverted the user's own change.
  await ev(`[...document.querySelectorAll('#view-detail button')]
    .find(b => b.textContent.trim() === 'Edit').click(); true`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === true`,
    { what: 'the habit dialog to reopen in the gap' });
  const reopened = await ev(`${targetBox}.value`);
  check('pressing Edit in that gap opens the dialog on the habit that was SAVED',
    reopened === '12.5', `${JSON.stringify(reopened)} (typed 12,5 over `
    + `${target.target}; a reverted edit reads as "${target.target}")`);

  await ev(`document.getElementById('dialog-cancel').click(); true`);
  await send('Fetch.disable', {}, sessionId);
  await send('Network.setBypassServiceWorker', { bypass: false }, sessionId);

  // And the seed is an early paint of the same fact rather than a second
  // source of truth: with the network released, the refetch that follows lands
  // and agrees. Asserted through a reload so the page is built from the server
  // alone, with nothing seeded anywhere in it.
  await reloadAndWaitForRow(ev, target.name, {
    reload: () => send('Page.navigate', { url: BASE }, sessionId),
  });
  await openHabitEdit(target.name, '12.5');
  const afterRefetch = await ev(`(() => ({
    head: document.querySelector('#view-detail .habit-sub')?.textContent ?? '',
    box: ${targetBox}?.value ?? '',
  }))()`);
  check('and a page built from the server alone says the same thing',
    afterRefetch.head.endsWith('≥ 12.5 pages') && afterRefetch.box === '12.5',
    JSON.stringify(afterRefetch));
  await ev(`document.getElementById('dialog-cancel').click(); true`);

  console.log('\n--- two saves, and the OLDER refetch landing last ---');
  /*
   * The same loss as the block above, arriving after the gap instead of inside
   * it — and it is the seed that makes it reachable, because the seed is what
   * lets the second save happen at all.
   *
   * Save once: the page paints the reply and the `'change'` listener starts a
   * refetch. Press Edit inside that refetch — the box now correctly holds the
   * habit that was just stored — and save again. There are now two refetches
   * outstanding against `/stats`, the heaviest computed route in the app, and
   * NOTHING orders their replies: `render()` runs on whichever lands last. If
   * that is the first one, the head is drawn from the pre-second-save habit,
   * the Edit button re-captures it, and one more Edit-then-Save writes the
   * second save back out — `PUT /habits/:id` REPLACES. No further refetch is
   * triggered by anything, so the page STAYS wrong.
   *
   * `refresh` (`ui/detail.js`) is what that listener has to go through, and its
   * own comment is this bug: "a later-started reload can finish first and leave
   * OLDER data on screen". It never runs two, and it remembers a request that
   * arrived mid-flight, so the LAST request is issued after the last write.
   *
   * The ordering is forced rather than raced. CDP `Fetch` holds both replies —
   * the same instrument the block above uses to hold a gap open — and they are
   * released newest-first, one at a time, each one DRAWN before the next is
   * let go, so the older answer is the one that renders last. That is the worst
   * legal interleaving and it is the one this has to survive; a run that merely
   * hoped for it would pass on either version most of the time. Under `refresh`
   * there is only ever ONE outstanding, so "release the older last" is
   * satisfied trivially and the coalesced re-run follows it — which is why
   * `outstanding` is reported beside the answer.
   */
  const takePaused = async (want, ms = 8000) => {
    for (let i = 0; i < Math.ceil(ms / 100); i++) {
      if (paused.length >= want) return true;
      await sleep(100);
    }
    return false;
  };
  const release = async (params) => {
    // A response-stage pause is continued with `continueResponse`; the
    // request-stage one the block above uses takes `continueRequest`. Chosen
    // from what the event actually carried rather than from which pattern this
    // file happens to have enabled last.
    //
    // Swallowed: a request whose page has moved on is already gone, and a
    // throw here would replace the failure being described.
    const how = params.responseStatusCode === undefined
      ? 'Fetch.continueRequest'
      : 'Fetch.continueResponse';
    await send(how, { requestId: params.requestId }, sessionId).catch(() => {});
  };

  await ev(`(async()=>{
    const list = await (await fetch('/api/habits')).json();
    const h = list.find(x => x.id === ${target.id});
    await fetch('/api/habits/' + ${target.id}, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...h, target_value: ${target.target} }) });})()`);
  await reloadAndWaitForRow(ev, target.name, {
    reload: () => send('Page.navigate', { url: BASE }, sessionId),
  });
  await openHabitEdit(target.name, String(target.target));

  /*
   * How many times this page has been REDRAWN, counted from outside it.
   *
   * `render()` (`ui/detail.js`) begins with `replaceChildren()` on
   * `#view-detail` and then fills it synchronously, and nothing else in the app
   * touches that node's direct children — so one `childList` batch on it is one
   * render, and the observer fires once per render rather than once per card.
   *
   * **A COUNT, and deliberately not the head's text.** Every wait below is for
   * an answer to have been drawn, and under the mutation this block exists to
   * catch the first answer drawn is the one computed AFTER the second save —
   * the same `≥ 9.5 pages` the seed has already painted. A wait on the subtitle
   * CHANGING cannot see that render at all: it would spend its whole 20s and
   * turn the named failure two screens down into a timeout with none of the
   * interesting values printed, which is the trap the `dialogClosed` note
   * above is about. What has to be waited for is that a render HAPPENED,
   * whatever it happened to draw.
   *
   * Installed after the reload above, since nothing here navigates again.
   */
  await ev(`(()=>{
    window.__renders = 0;
    new MutationObserver(() => { window.__renders += 1; })
      .observe(document.getElementById('view-detail'), { childList: true });
    return true;})()`);
  const renders = () => ev(`window.__renders`);
  /** Wait for the next redraw after `from`, and answer the count it reached. */
  const drawnAgain = async (from, what) => {
    await waitUntil(ev, `window.__renders > ${from}`, { what });
    return renders();
  };

  await send('Network.enable', {}, sessionId);
  await send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
  paused.length = 0;
  // **`requestStage: 'Response'`, and that is the whole of what makes the older
  // reply actually OLDER.** Paused at the Request stage — which is right for
  // the block above, where the point is that the request never arrives — the
  // server has not seen it yet, so releasing it after the second write answers
  // from the database as it stands and the reply is FRESH. Measured: with a
  // request-stage pause this block passed against the unfixed code, reporting
  // two refetches outstanding and a correct head. Paused at the Response stage
  // the server has already computed the reply, so the held answer is the one
  // computed BEFORE the second save, which is the thing that has to not win.
  await send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/habits/*/stats*', requestStage: 'Response' }],
  }, sessionId);

  // So the guard below can count the replies THIS block let through.
  await ev(`performance.clearResourceTimings(); true`);

  await typeTarget('12,5');
  await submitDialog();
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the first save to close the dialog' });
  check("the first save's refetch is outstanding and held",
    await takePaused(1), `${paused.length} paused`);

  // The press this is all about, and it only reaches the second save because
  // the seed put the stored habit in the box — unseeded it would type over the
  // pre-save target and the two saves would be one.
  await ev(`[...document.querySelectorAll('#view-detail button')]
    .find(b => b.textContent.trim() === 'Edit').click(); true`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === true`,
    { what: 'the habit dialog to reopen between the two saves' });
  const boxBetween = await ev(`${targetBox}.value`);
  check('...and the box it reopens on holds the first save, not the fixture',
    boxBetween === '12.5', JSON.stringify(boxBetween));

  const beforeSecond = await renders();
  await typeTarget('9,5');
  await submitDialog();
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the second save to close the dialog' });
  // The second save's own seed, and the POSITIVE half of the settle below.
  // `announce` → `seed` → the refetch decision is one synchronous task, so a
  // page that has drawn the second seed has already issued whatever refetch it
  // is going to issue. Without this the sleep would be covering the app's
  // reaction as well as the question being asked about it, which is the guess
  // in both directions the root CLAUDE.md forbids.
  const seeded = await drawnAgain(beforeSecond, "the second save's seed to paint");
  // ...and what is LEFT is the exception that rule carves out: establishing
  // that NO second refetch was issued, which has no predicate to poll. Under
  // `refresh` none ever will be. Without it one is already out by the line
  // above, and this is the margin its `Fetch.requestPaused` has to reach the
  // runner over DevTools — too short and the mutation this block exists to
  // catch releases a request nobody knew was held, in the wrong order, and
  // passes with a correct-looking head.
  await sleep(700);
  const outstanding = paused.length;

  /*
   * Release what is held, NEWEST first, and let each answer be drawn before
   * the next is let go — one reply in flight at a time, because two have no
   * order and the order is the whole of what this block forces.
   *
   * The settle is two more renders, and it is two in EITHER world, which is
   * what lets the mutation fail by NAME rather than time out: under `refresh`
   * the held reply draws the pre-second-save habit and the coalesced re-run
   * behind it draws the newest; without it the two independent refetches draw
   * newest and then oldest. Two answers were computed either way, and each is
   * drawn once.
   *
   * **What this replaces, and what it cost.** Both loops used to be durations
   * — a 700ms settle after each release, then a bounded poll with a 500ms
   * sleep in it — and the re-run was issued 16-20ms after the release, INSIDE
   * that first settle, where a `paused.length = 0` written for the loop's own
   * bookkeeping then dropped its requestId unreleased. The poll that followed
   * had nothing to let through, spun its full six seconds, and the reply was
   * finally freed by `Fetch.disable` — so the last two checks were decided by
   * a photo finish between the page's `/entries` round trip and the
   * assertion's own `fetch('/api/habits')`, measured at 3-4ms in the runs it
   * won. That is the ~4% flake this block shipped with, and every failing
   * instance reported the identical `statsLanded` and `outstanding` as a
   * passing one, because the reply had landed and only the render had not.
   */
  let drawn = seeded;
  let released = 0;
  let awaitingRender = false;
  const drainBy = Date.now() + 15_000;
  while (drawn < seeded + 2 && Date.now() < drainBy) {
    if (!awaitingRender && paused.length) {
      await release(paused.pop());
      released++;
      awaitingRender = true;
    }
    await sleep(25);
    const now = await renders();
    if (now > drawn) { drawn = now; awaitingRender = false; }
  }

  await send('Fetch.disable', {}, sessionId);
  await send('Network.setBypassServiceWorker', { bypass: false }, sessionId);

  const settledOn = await ev(`(async()=>{
    const list = await (await fetch('/api/habits')).json();
    const h = list.find(x => x.id === ${target.id});
    return {
      head: document.querySelector('#view-detail .habit-sub')?.textContent ?? '',
      stored: h ? h.target_value : null,
      // Counted before the habits read above can add to it: only the stats
      // route was paused here, and only it is counted.
      statsLanded: performance.getEntriesByType('resource')
        .filter(e => e.name.includes('/stats')).length,
    };})()`);
  check('both saves reached storage, the second one last',
    settledOn.stored === 9.5, JSON.stringify(settledOn));
  // **Every reply this block held has to have LANDED, or the checks below are
  // vacuous.** `api()` abandons a request after ten seconds, and a held one on
  // a loaded fleet can reach that: the older reply then never renders at all,
  // the seeded head is left standing, and the assertion passes for the one
  // reason it must not — the interleaving it exists to survive never happened.
  // A shortfall is a failed GUARD rather than a quiet pass.
  check('...and every held refetch actually answered, so the interleaving was '
    + 'real', settledOn.statsLanded >= outstanding,
    `${settledOn.statsLanded} landed of ${outstanding} held`);
  // The other half of the same guard, and the one the flake needed: a reply
  // can land — the resource timing above says so — with its render still a
  // round trip away, and the check below would then be reading a page that
  // has not finished answering. Two answers are drawn in BOTH worlds, so this
  // is satisfied by the mutation as well and cannot swallow its verdict.
  check('...and both of them were DRAWN, so the page had finished settling '
    + 'before it was read', drawn === seeded + 2,
    `${drawn - seeded} render(s) after the seed, ${released} reply(s) `
    + `released, ${paused.length} still held`);
  check('the page settles on the LAST save even when the older refetch answers '
    + 'after it', settledOn.head.endsWith('≥ 9.5 pages'),
    `${JSON.stringify(settledOn)} (${outstanding} refetch(es) were outstanding, `
    + `${released} released, ${drawn - seeded} drawn)`);

  // The head is the Edit button's own habit — same `render()`, same object —
  // and this is the press that would spend a stale one. Asserted rather than
  // inferred, because it is the loss itself rather than a symptom of it.
  await ev(`[...document.querySelectorAll('#view-detail button')]
    .find(b => b.textContent.trim() === 'Edit').click(); true`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === true`,
    { what: 'the habit dialog to reopen after both saves' });
  const boxAfter = await ev(`${targetBox}.value`);
  check('...so Edit-then-Save from here cannot revert the second one',
    boxAfter === '9.5', `${JSON.stringify(boxAfter)} (a revert reads as "12.5")`);
  await ev(`document.getElementById('dialog-cancel').click(); true`);
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
