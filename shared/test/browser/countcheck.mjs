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
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3000', PORT = 9236;
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

  /** Tap today's cell for that habit, and wait for the dialog. */
  const openToday = async () => {
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
  await ev(`(async()=>{ location.reload(); })()`);
  for (let i = 0; i < 60; i++) {
    if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
    await sleep(250);
  }
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
