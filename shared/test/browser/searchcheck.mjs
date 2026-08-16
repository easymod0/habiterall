/**
 * The dashboard's habit search, in a real browser.
 *
 * #74's cheapest useful version is a client-side filter over `state.habits`, and
 * the two things it names are both interactions rather than arithmetic — so a
 * unit test could not see either of them:
 *
 *   - `paint()` rebuilds the grid with `replaceChildren()` on every keystroke.
 *     A control INSIDE that subtree would lose focus mid-word; the search box is
 *     deliberately outside it, and this is what proves that rather than assumes
 *     it. Typing a word and still having the caret is the assertion.
 *   - dragging only means something in the list's REAL order, so the handle has
 *     to go while a filter is on. A drop against a subset computes a position
 *     from neighbours that are not the habit's neighbours.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = 9296;
const profile = mkdtempSync(join(tmpdir(), 'habsearch-'));
const chrome = launchChrome(PORT, profile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ck = (l, c, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' :: ' + e : ''}`);
  if (!c) fails++;
};
let ws, nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

try {
  ws = new globalThis.WebSocket(await devtoolsUrl(PORT, chrome));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  const keys = async (text) => {
    for (const ch of text) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch }, sessionId);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch }, sessionId);
      await sleep(60);
    }
  };

  await send('Page.navigate', { url: APP }, sessionId);
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
    await sleep(250);
  }
  await sleep(600);

  // The fixtures are a handful of habits; the box only earns its place past a
  // threshold, so seed enough to cross it and reload. Named so the filter has
  // something unambiguous to find, and one with the word only in its
  // DESCRIPTION — a habit called "Gym" whose description says "swimming" is one
  // people look for by the second.
  const seeded = await ev(`(async()=>{
    const before = (await (await fetch('/api/habits')).json()).length;
    const extra = [
      { name: 'Zzz Quokka', description: 'nothing to do with the rest' },
      { name: 'Zzz Wombat', description: 'marsupial' },
      { name: 'Café au lait', description: 'accented, to check folding' },
      { name: 'Plain jogging', description: 'contains the word quokka' },
    ];
    for (const h of extra) {
      await fetch('/api/habits', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'boolean', ...h }) });
    }
    return before + extra.length;
  })()`);
  await send('Page.navigate', { url: APP }, sessionId);
  for (let i = 0; i < 80; i++) {
    if (await ev(`document.querySelectorAll('#grid .habit-row').length >= ${seeded}`)
      .catch(() => 0)) break;
    await sleep(250);
  }
  await sleep(500);

  const shown = () => ev(`(() => ({
    rows: [...document.querySelectorAll('#grid .habit-row .habit-name')]
      .map((n) => n.textContent.trim()),
    boxShown: !document.getElementById('search-row').hidden,
    count: document.getElementById('search-count').textContent,
    handles: document.querySelectorAll('#grid .drag-handle').length,
    noMatch: !document.getElementById('empty-nomatch').hidden,
    onboarding: !document.querySelector('.empty-title').hidden,
    focused: document.activeElement?.id ?? null,
    value: document.getElementById('habit-search').value,
  }))()`);

  const start = await shown();
  ck('the box appears once there are enough habits to lose one in',
    start.boxShown, JSON.stringify({ rows: start.rows.length }));
  ck('and says nothing while it is empty', start.count === '', start.count);
  ck('the drag handles are there to begin with', start.handles > 1,
    String(start.handles));

  /* ---------- typing ---------- */
  await ev(`document.getElementById('habit-search').focus()`);
  await keys('quokka');
  await sleep(300);
  const typed = await shown();

  // THE assertion this suite exists for. `paint()` runs on every keystroke and
  // rebuilds `#grid` wholesale; if the box were inside it, the caret would be
  // gone after the first letter and the value would read 'q'.
  ck('typing does not lose the caret, though the grid rebuilt six times',
    typed.focused === 'habit-search', String(typed.focused));
  ck('and every letter arrived', typed.value === 'quokka', typed.value);

  ck('the list is filtered to what matches',
    typed.rows.length === 2, JSON.stringify(typed.rows));
  ck('a match on the DESCRIPTION counts',
    typed.rows.includes('Plain jogging'), JSON.stringify(typed.rows));
  ck('and the count says what was hidden',
    /\b2 of \d+/.test(typed.count), typed.count);

  // #74: "dragging only means something in manual order". A drop against a
  // subset computes a position from the wrong neighbours.
  ck('the drag handles are gone while a filter is on',
    typed.handles === 0, String(typed.handles));

  /* ---------- an empty result is not an empty account ---------- */
  await ev(`(() => { const i = document.getElementById('habit-search');
    i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await ev(`document.getElementById('habit-search').focus()`);
  await keys('zzzznothing');
  await sleep(300);
  const none = await shown();
  ck('no match says so', none.noMatch && none.rows.length === 0,
    JSON.stringify({ noMatch: none.noMatch, rows: none.rows.length }));
  ck('and does NOT offer to create your first habit',
    !none.onboarding, String(none.onboarding));

  /* ---------- folding ---------- */
  await ev(`(() => { const i = document.getElementById('habit-search');
    i.value = 'cafe'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  const folded = await shown();
  ck('an unaccented query finds an accented name',
    folded.rows.some((r) => r.startsWith('Café')), JSON.stringify(folded.rows));

  /* ---------- Escape clears ---------- */
  await ev(`document.getElementById('habit-search').focus()`);
  await send('Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await send('Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await sleep(300);
  const cleared = await shown();
  ck('Escape clears the query', cleared.value === '', cleared.value);
  ck('and the whole list comes back', cleared.rows.length >= seeded,
    `${cleared.rows.length} of ${seeded}`);
  ck('with the drag handles', cleared.handles > 1, String(cleared.handles));

  /* ---------- a check-off still works through a filter ---------- */
  //
  // `paint()` runs twice per check-off — optimistically, then after the refetch
  // — and `data-focus-key` restores the control. A filtered list is exactly the
  // case where a key might no longer match, so this proves the tap still lands
  // and the row stays put rather than assuming it.
  await ev(`(() => { const i = document.getElementById('habit-search');
    i.value = 'wombat'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  const ticked = await ev(`(async()=>{
    const box = document.querySelector('#grid .habit-row .check');
    if (!box) return { error: 'no checkbox' };
    box.focus();
    box.click();
    await new Promise((r) => setTimeout(r, 1800));
    return {
      rows: document.querySelectorAll('#grid .habit-row').length,
      focusKey: document.activeElement?.dataset?.focusKey ?? null,
      value: document.getElementById('habit-search').value,
    };
  })()`);
  ck('a check-off inside a filtered list still repaints one row',
    ticked.rows === 1, JSON.stringify(ticked));
  ck('the query survives the refetch', ticked.value === 'wombat', ticked.value);
  ck('and focus is restored to the cell that was tapped',
    /^check:/.test(String(ticked.focusKey)), String(ticked.focusKey));

  console.log(fails === 0 ? '\nALL SEARCH CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
