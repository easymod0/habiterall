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

  /* ---------- a list that is REPLACED clears the query ---------- */
  //
  // The same surprise the archive toggle is protected from, on the two other
  // paths that replace the list. Measured before the fix: 8 habits, query
  // "wombat", create one — the toast says "Habit created" and the list it lands
  // in does not contain it. A restore was worse: "No habits match that." over a
  // freshly imported account.
  await ev(`(() => { const i = document.getElementById('habit-search');
    i.value = 'wombat'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  const created = await ev(`(async()=>{
    // Through the real dialog, not by emitting 'reload' by hand: the claim is
    // about what CREATING a habit does, and a hand-fired event would stay green
    // backticks in here: the whole block is one template literal.)
    // if habit-dialog switched to change or stopped clearing the query. (No
    document.getElementById('btn-new').click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('#habit-form [name=name]').value = 'Zzz Newly made';
    document.getElementById('habit-form').requestSubmit();
    await new Promise((r) => setTimeout(r, 1800));
    return {
      value: document.getElementById('habit-search').value,
      rows: [...document.querySelectorAll('#grid .habit-row .habit-name')]
        .map((n) => n.textContent.trim()),
    };
  })()`);
  ck('creating a habit clears the filter it would be invisible behind',
    created.value === '', created.value);
  ck('and the new habit is on screen',
    created.rows.includes('Zzz Newly made'), JSON.stringify(created.rows.length));

  /* ---------- ...but Back from a habit does NOT ---------- */
  //
  // The other half, and the one that made clearing on every 'reload' wrong:
  // finding a habit, opening it and coming back is the search feature's main
  // workflow, and `detail.js` reaches the dashboard by emitting the same
  // 'reload'. Clearing there cost a re-type every time.
  const roundTrip = await ev(`(async()=>{
    const i = document.getElementById('habit-search');
    i.value = 'wombat'; i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const before = document.querySelectorAll('#grid .habit-row').length;
    document.querySelector('#grid .habit-row .habit-meta').click();
    await new Promise((r) => setTimeout(r, 1500));
    const onDetail = !document.getElementById('view-detail').hidden;
    history.back();
    await new Promise((r) => setTimeout(r, 1800));
    return { before, onDetail,
      value: document.getElementById('habit-search').value,
      rows: document.querySelectorAll('#grid .habit-row').length };
  })()`);
  ck('opening a habit from a filtered list works', roundTrip.onDetail === true,
    JSON.stringify(roundTrip));
  ck('and coming back KEEPS the filter you were using',
    roundTrip.value === 'wombat' && roundTrip.rows === roundTrip.before,
    JSON.stringify(roundTrip));

  /* ---------- editing a habit from its own page (#128) ---------- */
  //
  // The same workflow one step further in — find, open, EDIT, come back — and
  // the one place the rule is decided by what changed rather than by which
  // mutator ran. The save has to reach `habit-dialog`'s real submit handler
  // and the box has to be read after a REPAINT: on the detail view nothing
  // repaints the dashboard, so `#habit-search` still shows the old text
  // whatever `state.query` holds, and an assertion taken there passes either
  // way.
  //
  // Reaching the dashboard by the app's own Back button rather than
  // `history.back()`, because that is the button the report describes.
  const editFrom = (mutate) => ev(`(async()=>{
    const i = document.getElementById('habit-search');
    i.value = 'wombat'; i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('#grid .habit-row .habit-meta').click();
    await new Promise((r) => setTimeout(r, 1500));
    const edit = [...document.querySelectorAll('#view-detail button')]
      .find((b) => b.textContent === 'Edit');
    if (!edit) return { error: 'no Edit button' };
    edit.click();
    await new Promise((r) => setTimeout(r, 400));
    const f = document.getElementById('habit-form');
    ${mutate}
    f.requestSubmit();
    await new Promise((r) => setTimeout(r, 1500));
    const stayed = !document.getElementById('view-detail').hidden;
    [...document.querySelectorAll('#view-detail button')]
      .find((b) => b.textContent.includes('Back')).click();
    await new Promise((r) => setTimeout(r, 1800));
    return { stayed,
      value: document.getElementById('habit-search').value,
      rows: [...document.querySelectorAll('#grid .habit-row .habit-name')]
        .map((n) => n.textContent.trim()) };
  })()`);

  // Mark's reproduction, verbatim: change ONLY the colour. Nothing was added to
  // or removed from the list, so a cleared box is a filter wiped by something
  // that replaced nothing — the failure #74 was written to avoid, arriving from
  // the code written to avoid it.
  const recoloured = await editFrom(`f.color.value = '#654321';`);
  ck('editing a habit from its own page stays on that page',
    recoloured.stayed === true, JSON.stringify(recoloured));
  ck('and changing only the colour KEEPS the filter',
    recoloured.value === 'wombat' && recoloured.rows.length === 1,
    JSON.stringify(recoloured));

  // The other side of it, and the reason "this was a create" is the wrong rule:
  // the habit you were looking at no longer matches, so leaving the box alone
  // would report "No habits match that." over the rename that just succeeded.
  const renamed = await editFrom(`f.name.value = 'Zzz Numbat';`);
  ck('but a rename that moves the row OUT clears it',
    renamed.value === '', JSON.stringify(renamed));
  ck('and the renamed habit is on screen',
    renamed.rows.includes('Zzz Numbat'), JSON.stringify(renamed.rows));

  // The case a "did the name change" test cannot see. `visibleHabits` matches
  // the description too — that is what "Plain jogging" is in the fixtures for —
  // so an edit that touches only that field moves the row out just as a rename
  // does.
  const rewritten = await ev(`(async()=>{
    const i = document.getElementById('habit-search');
    i.value = 'quokka'; i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const before = [...document.querySelectorAll('#grid .habit-row .habit-name')]
      .map((n) => n.textContent.trim());
    const row = [...document.querySelectorAll('#grid .habit-row')]
      .find((r) => r.querySelector('.habit-name').textContent.includes('jogging'));
    if (!row) return { error: 'no jogging row', before };
    row.querySelector('.habit-meta').click();
    await new Promise((r) => setTimeout(r, 1500));
    [...document.querySelectorAll('#view-detail button')]
      .find((b) => b.textContent === 'Edit').click();
    await new Promise((r) => setTimeout(r, 400));
    const f = document.getElementById('habit-form');
    f.description.value = 'no longer mentions any marsupial';
    f.requestSubmit();
    await new Promise((r) => setTimeout(r, 1500));
    [...document.querySelectorAll('#view-detail button')]
      .find((b) => b.textContent.includes('Back')).click();
    await new Promise((r) => setTimeout(r, 1800));
    return { before,
      value: document.getElementById('habit-search').value,
      rows: document.querySelectorAll('#grid .habit-row').length };
  })()`);
  ck('the row was found by its DESCRIPTION to begin with',
    rewritten.before?.includes('Plain jogging'), JSON.stringify(rewritten));
  ck('and rewriting that description clears the filter too',
    rewritten.value === '', JSON.stringify(rewritten));

  /* ---------- deleting the habit you filtered down to ---------- */
  //
  // Unasserted until #128: the clear in `deleteHabit` could be deleted and the
  // whole suite stayed green. Without it the account is left reading "No habits
  // match that." over the one row the query had, which is the empty-result
  // screen standing in for a successful delete.
  const removed = await ev(`(async()=>{
    // The confirm is a preference (settings.confirmDelete), not the claim being
    // made here, and a modal one would hang this evaluation outright.
    window.confirm = () => true;
    const i = document.getElementById('habit-search');
    i.value = 'newly'; i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const before = document.querySelectorAll('#grid .habit-row').length;
    document.querySelector('#grid .habit-row .habit-meta').click();
    await new Promise((r) => setTimeout(r, 1500));
    [...document.querySelectorAll('#view-detail button')]
      .find((b) => b.textContent === 'Edit').click();
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('dialog-delete').click();
    await new Promise((r) => setTimeout(r, 2000));
    return { before,
      value: document.getElementById('habit-search').value,
      rows: [...document.querySelectorAll('#grid .habit-row .habit-name')]
        .map((n) => n.textContent.trim()),
      undo: !!document.querySelector('#toast .toast-action') };
  })()`);
  ck('the filter found exactly the habit to delete', removed.before === 1,
    JSON.stringify(removed));
  ck('deleting it clears the filter it emptied',
    removed.value === '' && !removed.rows.includes('Zzz Newly made'),
    JSON.stringify(removed));

  /* ---------- and undoing that delete ---------- */
  //
  // `restoreHabit` puts the habit back through a create and an import, so it
  // replaces the list exactly as the create above does — and it runs from a
  // toast, minutes-old context, against whatever query is in the box by then.
  // Filtered to something else, the undo would otherwise land off screen.
  const undone = await ev(`(async()=>{
    const i = document.getElementById('habit-search');
    i.value = 'numbat'; i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const action = document.querySelector('#toast .toast-action');
    if (!action) return { error: 'the undo toast is gone' };
    action.click();
    await new Promise((r) => setTimeout(r, 2500));
    return { value: document.getElementById('habit-search').value,
      rows: [...document.querySelectorAll('#grid .habit-row .habit-name')]
        .map((n) => n.textContent.trim()) };
  })()`);
  ck('undoing a delete clears the filter that was in the box by then',
    undone.value === '', JSON.stringify(undone));
  ck('and the restored habit is on screen',
    undone.rows?.includes('Zzz Newly made'), JSON.stringify(undone));

  /* ---------- a restore replaces every habit ---------- */
  //
  // The one the comment above calls the worse of the two, and the one that was
  // deletable in silence: "No habits match that." over a freshly imported
  // account. Driven through the real dialog — the file input is fed a Blob via
  // DataTransfer rather than a path, so this needs no CDP file plumbing — for
  // the same reason the create is: a hand-fired 'reload' would stay green with
  // `data-dialog`'s clear removed.
  const imported = await ev(`(async()=>{
    const backup = await (await fetch('/api/export')).json();
    const i = document.getElementById('habit-search');
    i.value = 'numbat'; i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const before = document.querySelectorAll('#grid .habit-row').length;

    document.getElementById('btn-settings').click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('settings-backup').click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('input[name=import-mode][value=merge]').checked = true;
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(backup)], 'backup.json',
      { type: 'application/json' }));
    const f = document.getElementById('import-file');
    f.files = dt.files;
    f.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('import-run').click();
    await new Promise((r) => setTimeout(r, 4000));
    const report = document.getElementById('import-result').textContent;
    [...document.querySelectorAll('dialog[open]')].reverse().forEach((d) => d.close());
    await new Promise((r) => setTimeout(r, 300));
    return { before, report,
      value: document.getElementById('habit-search').value,
      rows: document.querySelectorAll('#grid .habit-row').length };
  })()`);
  ck('the import ran', /merged|created/.test(String(imported.report)),
    JSON.stringify(imported));
  ck('a restore clears the filter the imported habits would hide behind',
    imported.value === '', JSON.stringify(imported));
  ck('and the whole account is on screen', imported.rows > imported.before,
    JSON.stringify(imported));

  console.log(fails === 0 ? '\nALL SEARCH CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
