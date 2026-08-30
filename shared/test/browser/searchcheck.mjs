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
import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor,
} from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9296);
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

  /**
   * The in-page half of this file's polling idiom, injected into the blocks
   * below.
   *
   * The loops two hundred lines down poll from node, one `ev` round trip per
   * step, which works because each step is its own evaluation. The #128 blocks
   * are one evaluation each — a whole workflow, not a step — so the loop has to
   * go into the page with them. Fixed sleeps there summed to 28.7 seconds
   * against measured waits of 0-41ms: never flaky on this machine and exactly
   * the class of thing #134 and #135 were both fixed for.
   *
   * Every wait is bounded and every caller checks the answer. `waitFor` resolves
   * to null on a timeout rather than throwing, so a step that never happened is
   * reported as the step it was instead of being read too early and asserted on.
   */
  const WAIT = `
    const waitFor = async (fn, ms = 8000) => {
      const until = Date.now() + ms;
      for (;;) {
        try { const v = fn(); if (v) return v; } catch (err) { /* not there yet */ }
        if (Date.now() > until) return null;
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const byText = (sel, text) => [...document.querySelectorAll(sel)]
      .find((b) => b.textContent.trim() === text);
    const backBtn = () => [...document.querySelectorAll('#view-detail button')]
      .find((b) => b.textContent.trim().endsWith('Back'));
    const names = () => [...document.querySelectorAll('#grid .habit-row .habit-name')]
      .map((n) => n.textContent.trim());
    // paint() runs synchronously inside the input handler, so a filter needs no
    // wait at all: the rows are right by the time dispatchEvent returns.
    const filter = (q) => {
      const i = document.getElementById('habit-search');
      i.value = q; i.dispatchEvent(new Event('input', { bubbles: true }));
      return i;
    };
    // The list is painted, one way or the other — a row, or the sentence that
    // stands in for one. Waiting on rows alone would hang on exactly the
    // failure these blocks are looking for.
    const onList = () => waitFor(() => !document.getElementById('view-list').hidden
      && (document.querySelector('#grid .habit-row')
        || !document.getElementById('empty-nomatch').hidden));
    // Open a row and hand back the Edit button of THAT habit.
    //
    // Three conditions, and each one was a wrong ANSWER rather than a slow one
    // while it was missing. detail.open() fetches before it renders and
    // views.showList() only HIDES the detail view, so between the tap and the
    // render the previous habit's header is still sitting there — Edit button
    // included, carrying the habit it was rendered with. Waiting on the button
    // alone opened the dialog on the habit viewed before this one, and the
    // delete then removed a habit the filter had never matched. Waiting on the
    // heading alone was worse where the previous habit was the SAME one: the
    // stale header matches its own name, so the dialog opened over the
    // DASHBOARD, and the save correctly emitted 'reload' — a real answer to a
    // question the test had no business asking, one run in three.
    //
    // So: a FRESH heading node, naming this habit, in a view that is showing.
    const openHabit = (row) => {
      const name = row.querySelector('.habit-name').textContent.trim();
      const stale = document.querySelector('#view-detail h2');
      row.querySelector('.habit-meta').click();
      return waitFor(() => {
        const h2 = document.querySelector('#view-detail h2');
        return h2 && h2 !== stale && h2.textContent.trim() === name
          && !document.getElementById('view-detail').hidden
          && byText('#view-detail button', 'Edit');
      });
    };`;

  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate', { url: APP }, sessionId),
    what: 'the dashboard',
  });
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
  await reloadAndWaitFor(ev, `document.querySelectorAll('#grid .habit-row').length >= ${seeded}`, {
    reload: () => send('Page.navigate', { url: APP }, sessionId),
    what: `${seeded} habit rows`,
  });
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

  /* ---------- a query that folds to NOTHING is not a filter (#180) ---------- */
  //
  // `matchesQuery` folds BEFORE it trims, so a query of only combining marks is
  // empty to the filter and every habit is shown. The dashboard used to decide
  // "a filter is live" with a second predicate — `!!state.query.trim()`, which a
  // combining mark passes — and then withdrew every drag handle and announced
  // "N of N" over a list that is provably the whole account.
  //
  // This block is here rather than in the unit suite because the defect was
  // never in `store.js`: `matchesQuery` was already right, and the predicate
  // being right is not the same as `paint()` reading it. Mutation-prove by
  // putting `const filtering = !!state.query.trim();` back in dashboard.js —
  // the count and the handles below both fail, and no unit test moves.
  const MARK = String.fromCharCode(0x0301);   // COMBINING ACUTE ACCENT, no base
  await ev(`(() => { const i = document.getElementById('habit-search');
    i.value = String.fromCharCode(0x0301);
    i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  const inert = await shown();
  ck('a query of only combining marks still shows every habit',
    inert.rows.length >= seeded, `${inert.rows.length} of ${seeded}`);
  ck('and the count says nothing, because nothing is being narrowed',
    inert.count === '', JSON.stringify(inert.count));
  // #74's rule is right and is simply being applied to a list that is not a
  // subset: the real order IS on screen, so a drop computes true neighbours.
  ck('and reordering stays available over a list that is the real order',
    inert.handles > 1, String(inert.handles));
  ck('while the box still holds what was typed',
    inert.value === MARK, JSON.stringify(inert.value));

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
  // mutator ran. Two things make these assertions mean anything.
  //
  // The box is read after a REPAINT. On the detail view nothing repaints the
  // dashboard, so `#habit-search` still shows the old text whatever
  // `state.query` holds, and an assertion taken there passes either way. The
  // dashboard is reached by the app's own Back button rather than
  // `history.back()`, because that is the button the report describes.
  //
  // And the habit is read BACK from the API afterwards. `value === 'wombat'
  // && rows === 1` is also what a form that never submitted produces, so
  // without the stored row these would pass against a save that silently did
  // nothing.
  const editFrom = (query, mutate) => ev(`(async()=>{
    ${WAIT}
    filter(${JSON.stringify(query)});
    const row = document.querySelector('#grid .habit-row');
    if (!row) return { error: 'nothing matched ' + ${JSON.stringify(query)} };
    const id = row.dataset.habitId;
    const edit = await openHabit(row);
    if (!edit) return { error: 'the habit never opened' };
    edit.click();
    const dlg = document.getElementById('habit-dialog');
    if (!await waitFor(() => dlg.open)) return { error: 'the dialog never opened' };
    const f = document.getElementById('habit-form');
    ${mutate}
    f.requestSubmit();
    // The dialog closes only once the write has landed, so this waits on the
    // save rather than on a duration.
    if (!await waitFor(() => !dlg.open)) return { error: 'the save never finished' };

    // Which branch of the ternary ran, asked positively so it costs no bounded
    // wait for the expected answer: 'change' re-renders the detail view and
    // replaces the Edit button, 'reload' shows the list. Whichever arrives
    // first is the answer.
    const settled = await waitFor(() => {
      const fresh = byText('#view-detail button', 'Edit');
      return (!document.getElementById('view-list').hidden && 'list')
        || (fresh && fresh !== edit && 'detail');
    });

    const back = await waitFor(() => backBtn());
    if (!back) return { error: 'no Back button', settled };
    back.click();
    if (!await onList()) return { error: 'never got back to the list', settled };
    return { settled,
      stored: await (await fetch('/api/habits/' + id)).json(),
      value: document.getElementById('habit-search').value,
      rows: [...document.querySelectorAll('#grid .habit-row .habit-name')]
        .map((n) => n.textContent.trim()) };
  })()`);

  // Mark's reproduction, verbatim: change ONLY the colour. Nothing was added to
  // or removed from the list, so a cleared box is a filter wiped by something
  // that replaced nothing — the failure #74 was written to avoid, arriving from
  // the code written to avoid it.
  const recoloured = await editFrom('wombat', `f.color.value = '#654321';`);
  ck('editing a habit from its own page stays on that page',
    recoloured.settled === 'detail', JSON.stringify(recoloured.settled));
  ck('and the save really did reach the server',
    recoloured.stored?.color === '#654321', JSON.stringify(recoloured.stored?.color));
  ck('and changing only the colour KEEPS the filter',
    recoloured.value === 'wombat' && recoloured.rows.length === 1,
    JSON.stringify(recoloured));

  // The other side of it, and the reason "this was a create" is the wrong rule:
  // the habit you were looking at no longer matches, so leaving the box alone
  // would report "No habits match that." over the rename that just succeeded.
  const renamed = await editFrom('wombat', `f.name.value = 'Zzz Numbat';`);
  ck('a rename that moves the row OUT clears the filter',
    renamed.value === '' && renamed.stored?.name === 'Zzz Numbat',
    JSON.stringify(renamed));
  ck('and the renamed habit is on screen',
    renamed.rows.includes('Zzz Numbat'), JSON.stringify(renamed.rows));

  // The case a "did the name change" test cannot see. `matchesQuery` reads the
  // description too — that is what "Plain jogging" is in the fixtures for — so
  // an edit touching only that field moves the row out just as a rename does.
  const rewritten = await ev(`(async()=>{
    ${WAIT}
    filter('quokka');
    const before = names();
    const row = [...document.querySelectorAll('#grid .habit-row')]
      .find((r) => r.querySelector('.habit-name').textContent.includes('jogging'));
    if (!row) return { error: 'no jogging row', before };
    const edit = await openHabit(row);
    if (!edit) return { error: 'the habit never opened', before };
    edit.click();
    const dlg = document.getElementById('habit-dialog');
    if (!await waitFor(() => dlg.open)) return { error: 'the dialog never opened', before };
    const f = document.getElementById('habit-form');
    f.description.value = 'no longer mentions any marsupial';
    f.requestSubmit();
    if (!await waitFor(() => !dlg.open)) return { error: 'the save never finished', before };
    const back = await waitFor(() => backBtn());
    if (!back) return { error: 'no Back button', before };
    back.click();
    if (!await onList()) return { error: 'never got back to the list', before };
    return { before,
      value: document.getElementById('habit-search').value,
      rows: document.querySelectorAll('#grid .habit-row').length };
  })()`);
  ck('the row was found by its DESCRIPTION to begin with',
    rewritten.before?.includes('Plain jogging'), JSON.stringify(rewritten));
  ck('and rewriting that description clears the filter too',
    rewritten.value === '', JSON.stringify(rewritten));

  /* ---------- the rule is asked of the ROW, not of the request ---------- */
  //
  // `parseHabit` clamps `description` to `LIMITS.description` (500), so a
  // mention of the query past the cut is in what was SENT and not in what was
  // stored. Asked of the payload, the box survives over a list the habit has
  // just left — the contrived-looking half of a reading this codebase has got
  // wrong before in `applyImport`: the file's word for something instead of what
  // it would mean here. `name` cannot do this (over 100 is a ValidationError,
  // not a clamp) and `.trim()` cannot remove an interior match, so the
  // description is the only reachable instance and this is it.
  const clamped = await editFrom('cafe', `
    f.name.value = 'Zzz Clamped';
    f.description.value = 'x'.repeat(600) + ' cafe';`);
  ck('the stored description really was cut short',
    clamped.stored?.description?.length === 500,
    JSON.stringify(clamped.stored?.description?.length));
  ck('and the filter goes by what was STORED, not by what was sent',
    clamped.value === '', JSON.stringify(clamped));

  /* ---------- ...and so does archiving it ---------- */
  //
  // The route neither the query nor the name can see: `load()` fetches the
  // active habits or the archived ones and never both, so the Archived checkbox
  // takes the row off the list without touching either matched field. Asking
  // `matchesQuery` alone left "No habits match that." over an archive that had
  // just succeeded — which is why the rule is `staysOnList` and not the filter.
  const shelved = await editFrom('numbat', `f.archived.checked = true;`);
  ck('the habit really was archived', !!shelved.stored?.archived,
    JSON.stringify(shelved.stored?.archived));
  ck('and archiving the habit you filtered to clears the filter',
    shelved.value === '' && !shelved.rows.includes('Zzz Numbat'),
    JSON.stringify(shelved));

  /* ---------- deleting the habit you filtered down to ---------- */
  //
  // Unasserted until #128: the clear in `deleteHabit` could be deleted and the
  // whole suite stayed green. Without it the account is left reading "No habits
  // match that." over the one row the query had, which is the empty-result
  // screen standing in for a successful delete.
  const removed = await ev(`(async()=>{
    ${WAIT}
    // The confirm is a preference (settings.confirmDelete), not the claim being
    // made here, and a modal one would hang this evaluation outright.
    window.confirm = () => true;
    filter('newly');
    const row = document.querySelector('#grid .habit-row');
    if (!row) return { error: 'nothing matched newly' };
    const before = document.querySelectorAll('#grid .habit-row').length;
    const edit = await openHabit(row);
    if (!edit) return { error: 'the habit never opened' };
    edit.click();
    const dlg = document.getElementById('habit-dialog');
    if (!await waitFor(() => dlg.open)) return { error: 'the dialog never opened' };
    document.getElementById('dialog-delete').click();
    // The undo toast is the completion signal, and it is posted after the
    // 'reload' — so waiting for both is waiting for the whole path.
    const done = await waitFor(() => !document.getElementById('view-list').hidden
      && document.querySelector('#toast .toast-action'));
    if (!done) return { error: 'the delete never landed' };
    return { before,
      value: document.getElementById('habit-search').value,
      rows: names() };
  })()`);
  ck('the filter found exactly the habit to delete', removed.before === 1,
    JSON.stringify(removed));
  ck('deleting it clears the filter it emptied',
    removed.value === '' && !removed.rows.includes('Zzz Newly made'),
    JSON.stringify(removed));

  /* ---------- and undoing that delete ---------- */
  //
  // `restoreHabit` puts the habit back through a create and an import, so it
  // asks `staysOnList` of the created habit exactly as a save does — and it runs
  // from a toast, against whatever query is in the box by then rather than the
  // one the delete was made under. Filtered to something else, the undo would
  // otherwise land off screen.
  //
  // The one genuinely time-coupled block in this file: an action toast dismisses
  // itself after 9000ms (`ui/toast.js`) and this reaches it about two seconds
  // after the delete. That bound cannot be polled away — it is the app's, not a
  // guess about a machine — but it fails LOUDLY if it is ever exceeded, on the
  // explicit check below rather than by reading a stale value.
  const undone = await ev(`(async()=>{
    ${WAIT}
    filter('numbat');
    const action = document.querySelector('#toast .toast-action');
    if (!action) return { error: 'the undo toast had already dismissed itself' };
    action.click();
    if (!await waitFor(() =>
      document.getElementById('toast').textContent.includes('Restored')))
      return { error: 'the restore never reported' };
    // A timeout here IS the failure this block exists for: with the clear gone
    // the list stays filtered to the one row the query had.
    await waitFor(() => document.querySelectorAll('#grid .habit-row').length > 1);
    return { value: document.getElementById('habit-search').value, rows: names() };
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
    ${WAIT}
    const backup = await (await fetch('/api/export')).json();
    filter('numbat');
    const before = document.querySelectorAll('#grid .habit-row').length;

    document.getElementById('btn-settings').click();
    const backupBtn = await waitFor(() => document.getElementById('settings-backup'));
    if (!backupBtn) return { error: 'no backup button in settings' };
    backupBtn.click();
    const dd = document.getElementById('data-dialog');
    if (!await waitFor(() => dd.open)) return { error: 'the data dialog never opened' };
    document.querySelector('input[name=import-mode][value=merge]').checked = true;
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(backup)], 'backup.json',
      { type: 'application/json' }));
    const f = document.getElementById('import-file');
    f.files = dt.files;
    f.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('import-run').click();
    // The result panel is unhidden when the import answers, whether it worked
    // or not, so this waits on the request and reports what it said.
    if (!await waitFor(() => !document.getElementById('import-result').hidden, 20000))
      return { error: 'the import never answered', before };
    const report = document.getElementById('import-result').textContent;
    [...document.querySelectorAll('dialog[open]')].reverse().forEach((d) => d.close());
    // As above: a timeout here is the failure, not a slow machine.
    await waitFor(() => document.querySelectorAll('#grid .habit-row').length > before);
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
