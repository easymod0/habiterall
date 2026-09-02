/** Browser checks for empty state, starters, reorder, undo, and calendar keys. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor, waitUntil,
} from './chrome.mjs';
const BASE = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9229);

const profile = mkdtempSync(join(tmpdir(), 'habfeat-'));
const chrome = launchChrome(PORT, profile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (l, c, e = '') => {
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
  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') console.log('  [PAGE ERROR]', m.params.exceptionDetails.exception?.description?.split('\n')[0]);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);

  const wipe = () => ev(`(async()=>{
    for (const q of ['','?archived=true'])
      for (const h of await (await fetch('/api/habits'+q)).json())
        await fetch('/api/habits/'+h.id,{method:'DELETE'});
  })()`);

  const reload = async (waitForRows = true) => {
    await reloadAndWaitFor(ev, waitForRows
      ? `!!document.querySelector('#grid .habit-row')`
      : `!document.getElementById('empty').hidden || !!document.querySelector('#grid .habit-row')`,
    {
      reload: () => send('Page.navigate', { url: BASE }, sessionId),
      what: waitForRows ? 'a habit row' : 'the dashboard, empty or not',
    });
  };

  /* ---------- 1. empty state ---------- */
  console.log('--- empty state ---');
  await send('Page.navigate', { url: BASE }, sessionId); // navigate-unjoined: a bare sleep follows, with no predicate to join
  await sleep(1200);
  await wipe();
  await reload(false);

  const empty = await ev(`(()=>{
    const vis=id=>{const e=document.getElementById(id); return e && !e.hidden && getComputedStyle(e).display!=='none';};
    return {
      panel: vis('empty'),
      starters: document.querySelectorAll('.starter').length,
      newBtn: vis('empty-new'),
      importBtn: vis('empty-import'),
      archivedMsg: vis('empty-archived'),
      title: document.querySelector('.empty-title')?.textContent?.trim(),
    };})()`);
  check('empty panel shown', empty.panel === true, JSON.stringify(empty));
  check('starter presets offered', empty.starters === 4, String(empty.starters));
  check('create + import buttons shown', empty.newBtn && empty.importBtn);
  check('archived message hidden on the active view', empty.archivedMsg === false);
  check('title reads as onboarding', empty.title === 'Nothing tracked yet', empty.title);

  // click a starter
  await ev(`[...document.querySelectorAll('.starter')].find(b=>b.textContent.includes('Meditate')).click()`);
  await sleep(900);
  const afterStarter = await ev(`(async()=>{
    const hs=await (await fetch('/api/habits')).json();
    return {count:hs.length, name:hs[0]?.name, emptyHidden: document.getElementById('empty').hidden};
  })()`);
  check('starter creates the habit', afterStarter.count === 1 && afterStarter.name === 'Meditate',
    JSON.stringify(afterStarter));
  check('empty panel disappears once a habit exists', afterStarter.emptyHidden === true);

  /* ---------- 2. reorder ---------- */
  console.log('--- reorder ---');
  await ev(`(async()=>{
    for (const b of [{name:'Bravo',type:'boolean'},{name:'Charlie',type:'boolean'}])
      await fetch('/api/habits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
  })()`);
  await reload();

  const names = () => ev(`[...document.querySelectorAll('#grid .habit-row .habit-name')].map(n=>n.textContent.trim())`);
  const before = await names();
  check('three habits listed', before.length === 3, JSON.stringify(before));
  check('drag handles rendered', await ev(`document.querySelectorAll('.drag-handle').length`) === 3);

  // keyboard: move the first habit down one
  await ev(`(()=>{const h=document.querySelectorAll('.drag-handle')[0]; h.focus();
    h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));})()`);
  await sleep(800);
  const afterDown = await names();
  check('ArrowDown moves a habit down',
    afterDown[0] === before[1] && afterDown[1] === before[0],
    `${JSON.stringify(before)} -> ${JSON.stringify(afterDown)}`);

  const persisted = await ev(`(async()=>(await (await fetch('/api/habits')).json()).map(h=>h.name))()`);
  check('new order persisted to the server',
    JSON.stringify(persisted) === JSON.stringify(afterDown.map(n => n.trim())),
    JSON.stringify(persisted));

  check('focus stays on the moved handle',
    await ev(`document.activeElement?.classList.contains('drag-handle')`) === true);

  // move it back up
  await ev(`(()=>{const h=document.activeElement; h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));})()`);
  await sleep(800);
  check('ArrowUp restores the original order',
    JSON.stringify(await names()) === JSON.stringify(before),
    JSON.stringify(await names()));

  /* ---------- 3. undo delete ---------- */
  console.log('--- undo delete ---');
  await ev(`(async()=>{
    const hs=await (await fetch('/api/habits')).json();
    const h=hs.find(x=>x.name==='Meditate');
    for (const d of ['2026-06-01','2026-06-02'])
      await fetch('/api/habits/'+h.id+'/entries/'+d,{method:'PUT',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({value:2,notes:'kept'})});
  })()`);
  await reload();

  await ev(`window.confirm = () => true`);
  await ev(`(()=>{
    const rows=[...document.querySelectorAll('#grid .habit-row')];
    const i=rows.findIndex(r=>r.querySelector('.habit-name').textContent.includes('Meditate'));
    rows[i].querySelector('.habit-meta').click();})()`);
  await sleep(700);

  // #66: the icon is set through the real Edit dialog, not a raw fetch — this
  // is what makes the block sensitive to `saveHabit`'s payload rather than to
  // the server alone, since a raw PUT would prove nothing about the form.
  await ev(`[...document.querySelectorAll('#view-detail .btn')].find(b=>b.textContent==='Edit').click()`);
  await sleep(300);
  await ev(`document.getElementById('habit-form').icon.value = '🧘'`);
  await ev(`document.getElementById('habit-form').requestSubmit()`);
  await sleep(700);

  await ev(`[...document.querySelectorAll('#view-detail .btn')].find(b=>b.textContent==='Edit').click()`);
  await sleep(300);
  await ev(`document.getElementById('dialog-delete').click()`);
  await sleep(1000);

  const afterDelete = await ev(`(async()=>({
    names: (await (await fetch('/api/habits')).json()).map(h=>h.name),
    toast: document.getElementById('toast').textContent,
    undoShown: !!document.querySelector('.toast-action'),
  }))()`);
  check('habit deleted', !afterDelete.names.includes('Meditate'), JSON.stringify(afterDelete.names));
  check('undo action offered in the toast', afterDelete.undoShown === true, afterDelete.toast);

  await ev(`document.querySelector('.toast-action').click()`);
  await sleep(1500);
  const afterUndo = await ev(`(async()=>{
    const hs=await (await fetch('/api/habits')).json();
    const h=hs.find(x=>x.name==='Meditate');
    const es=h ? await (await fetch('/api/habits/'+h.id+'/entries')).json() : [];
    return {restored: !!h, entries: es.length, notes: es[0]?.notes, icon: h?.icon};
  })()`);
  check('undo restores the habit', afterUndo.restored === true, JSON.stringify(afterUndo));
  check('undo restores its history', afterUndo.entries === 2, String(afterUndo.entries));
  check('undo restores notes too', afterUndo.notes === 'kept', String(afterUndo.notes));
  check('undo restores its icon too', afterUndo.icon === '🧘', String(afterUndo.icon));

  /* ---------- 4. calendar keyboard nav ---------- */
  console.log('--- calendar keys ---');
  await reload();
  await ev(`(()=>{
    const rows=[...document.querySelectorAll('#grid .habit-row')];
    const i=rows.findIndex(r=>r.querySelector('.habit-name').textContent.includes('Meditate'));
    rows[i].querySelector('.habit-meta').click();})()`);
  for (let i = 0; i < 60; i++) {
    if (await ev(`!!document.querySelector('rect[role="gridcell"]')`)) break;
    await sleep(200);
  }

  const tabStops = await ev(`document.querySelectorAll('rect[role="gridcell"][tabindex="0"]').length`);
  check('exactly one calendar tab stop (roving tabindex)', tabStops === 1, String(tabStops));

  const nav = await ev(`(()=>{
    const cells=[...document.querySelectorAll('rect[role="gridcell"]')];
    const start=cells.find(c=>c.getAttribute('tabindex')==='0');
    start.focus();
    const from=document.activeElement.dataset.date;
    const key=k=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));
    key('ArrowUp');   const up=document.activeElement.dataset.date;
    key('ArrowDown'); const back=document.activeElement.dataset.date;
    key('ArrowLeft'); const left=document.activeElement.dataset.date;
    return {from, up, back, left};
  })()`);
  const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  check('ArrowUp moves back one day', dayDiff(nav.up, nav.from) === 1, JSON.stringify(nav));
  check('ArrowDown returns to the start', nav.back === nav.from, JSON.stringify(nav));
  check('ArrowLeft moves back one week', dayDiff(nav.left, nav.from) === 7, JSON.stringify(nav));

  // Home and End go to the ends of the WEEK AS DRAWN, which depends on the
  // account's `weekStart`. They read `getDay()` once — Sunday-based — so on a
  // Monday-start grid Home jumped to the Sunday in the PREVIOUS column, where
  // `byDate` finds nothing and the key silently does nothing at all.
  //
  // Checked in a real browser because it is the only place it can be: the
  // handler is reached through a `keydown` listener attached only when the
  // calendar is interactive, and it reads `dataset`, which the offline fake DOM
  // in weekcheck.mjs does not have. That suite covers the labels and the data
  // pairing; this covers the keys.
  for (const weekStart of ['monday', 'sunday']) {
    await ev(`(async()=>{ await fetch('/api/settings', { method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ weekStart: ${JSON.stringify(weekStart)} }) }); })()`);
    // The same route into the calendar this section already uses: `reload()`
    // waits for the dashboard, and the habit is opened by name rather than by
    // position, because a filter or a reorder would move it.
    await reload();
    await ev(`(()=>{
      const rows=[...document.querySelectorAll('#grid .habit-row')];
      const i=rows.findIndex(r=>r.querySelector('.habit-name').textContent.includes('Meditate'));
      rows[i].querySelector('.habit-meta').click();})()`);
    for (let i = 0; i < 60; i++) {
      if (await ev(`!!document.querySelector('rect[role="gridcell"]')`)) break;
      await sleep(200);
    }

    const ends = await ev(`(()=>{
      const cells=[...document.querySelectorAll('rect[role="gridcell"]')];
      // Deliberately MIDWEEK, so Home and End both have somewhere to go. Taking
      // the middle of the list picked the week's opening day for one of the two
      // settings, where Home correctly does nothing — and "did nothing" is the
      // symptom being tested for, so the cell has to be chosen rather than
      // happened upon.
      const opens = ${JSON.stringify(weekStart === 'monday' ? 1 : 0)};
      const midweek = cells.filter(c => {
        const d = new Date(c.dataset.date + 'T00:00:00').getDay();
        return d === (opens + 3) % 7;
      });
      const start = midweek[Math.floor(midweek.length / 2)];
      start.focus();
      const key=k=>document.activeElement.dispatchEvent(
        new KeyboardEvent('keydown',{key:k,bubbles:true}));
      const from=document.activeElement.dataset.date;
      key('Home'); const home=document.activeElement.dataset.date;
      start.focus();
      key('End');  const end=document.activeElement.dataset.date;
      return {from, home, end};})()`);

    // getDay(): 0 is Sunday. The week's first day is Monday (1) or Sunday (0).
    const dow = (iso) => new Date(iso + 'T00:00:00').getDay();
    check(`${weekStart}: Home lands on the day the week opens`,
      dow(ends.home) === (weekStart === 'monday' ? 1 : 0), JSON.stringify(ends));
    check(`${weekStart}: End lands on the day it closes`,
      dow(ends.end) === (weekStart === 'monday' ? 0 : 6), JSON.stringify(ends));
    // And neither walked off the grid — a cell that does not exist leaves focus
    // where it was, which is how this failed silently.
    check(`${weekStart}: Home actually moved`, ends.home !== ends.from, JSON.stringify(ends));
  }
  await ev(`(async()=>{ await fetch('/api/settings', { method:'DELETE' }); })()`);

  const opened = await ev(`(()=>{
    const c=document.querySelector('rect[role="gridcell"][tabindex="0"]')
      ?? document.querySelector('rect[role="gridcell"]');
    c.focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    return document.getElementById('day-dialog').open;})()`);
  check('Enter opens the day editor', opened === true);

  /* ---------- 5. the icon field: picker, preview, and the typed path ---------- */
  console.log('--- icon field ---');

  // Section 4 ends on a habit's own detail page with the day editor open —
  // `announce()` only emits `'reload'` while `dashboardShowing()`, so a habit
  // created from there would never repaint the dashboard grid this section's
  // checks read from. `reload()` (already defined above, joined through
  // `reloadAndWaitFor`) is the return trip; it issues no new bare
  // `Page.navigate` of its own.
  await reload();

  // `#btn-new` (as section 2 already uses for its new habits) rather than
  // section 3's edit route — a fresh create dialog every time keeps each
  // check's icon field starting from a known, empty value. No `Page.navigate`
  // of any kind is issued below; this file's one sanctioned unjoined
  // navigate stays the one in section 1 (`NAVIGATE_UNJOINED['feat4.mjs']`,
  // count: 1) and every wait here is a `waitUntil` predicate on in-page
  // state `saveHabit`/`announce()` already produce.
  const openNewDialog = async () => {
    await ev(`document.getElementById('btn-new').click()`);
    await waitUntil(ev,
      `document.getElementById('habit-dialog').open === true
        && !!document.getElementById('habit-form').icon`,
      { what: 'the new-habit dialog, open with its icon field present' });
  };

  const closeDialog = () => ev(`document.getElementById('habit-dialog').close(); true`);

  // Idempotent rather than a bare click, defensively: `iconField.set()` (which
  // `openDialog` calls on every session) now resets the panel closed before
  // this ever runs — see check h below, and `icon-field.js`'s own `reset()` —
  // so every `openNewDialog()` above already leaves `#icon-picker` hidden. A
  // non-idempotent version would still be correct against today's code, but
  // would toggle the panel CLOSED instead of opening it the moment that
  // ceased to be true.
  const openPicker = async () => {
    const hidden = await ev(`document.getElementById('icon-picker').hidden`);
    if (hidden) await ev(`document.getElementById('icon-picker-toggle').click()`);
    await waitUntil(ev,
      `!document.getElementById('icon-picker').hidden
        && document.querySelectorAll('#icon-grid .icon-cell').length > 0`,
      { what: 'the icon picker panel, open with cells rendered' });
  };

  const iconInputValue = () => ev(`document.getElementById('habit-form').icon.value`);
  const preview = () => ev(`(()=>({
    glyph: document.querySelector('#icon-preview .icon-preview-glyph').textContent,
    caption: document.querySelector('#icon-preview .icon-preview-caption').textContent,
  }))()`);

  /** One printable character, as a keyboard delivers it — `countcheck.mjs`'s own. */
  const typeChar = async (ch) => {
    await send('Input.dispatchKeyEvent',
      { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sessionId);
  };

  /** A named key with no text of its own — `countcheck.mjs`'s `pressKey`. */
  const pressKey = async (key, code, vk) => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type, key, code,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      }, sessionId);
    }
  };
  const pressEscape = () => pressKey('Escape', 'Escape', 27);

  /** `categorycheck.mjs`'s own shape: `text: '\r'` on `keyDown` only. */
  const pressEnterKey = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        ...(type === 'keyDown' ? { text: '\r' } : {}),
      }, sessionId);
    }
  };

  const focusAndSelect = (selector) => ev(`(()=>{
    const el = document.querySelector(${JSON.stringify(selector)});
    el.focus();
    el.select();
  })()`);

  /** Real key events, exactly as `countcheck.mjs` types an amount. */
  const typeInto = async (selector, text) => {
    await focusAndSelect(selector);
    for (const ch of text) await typeChar(ch);
  };

  /**
   * A paste, or an OS emoji picker — CDP `Input.insertText` is what both look
   * like to the page (the brief's own instruction, and the reason no suite
   * used it before this one). Selecting first is what makes this a REPLACE
   * rather than an append, the same as a real paste over an existing value.
   *
   * Verified empirically before relying on it: `Input.insertText` into a
   * plain `#habit-form [name="icon"]` DOES fire the `input` event
   * `icon-field.js`'s `updatePreview` listens on in this Chrome build (the
   * preview updates from a bare `Input.insertText` with nothing else
   * dispatched) — so the `ClipboardEvent`/`DataTransfer` fallback the brief
   * allows for is not needed here.
   */
  const pasteInto = async (selector, text) => {
    await focusAndSelect(selector);
    await send('Input.insertText', { text }, sessionId);
  };

  const submitAndWait = async () => {
    await ev(`document.getElementById('habit-form').requestSubmit()`);
    await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
      { what: 'the habit dialog to close after saving' });
  };

  const habitIcon = (name) => ev(`(async()=>{
    const hs = await (await fetch('/api/habits')).json();
    return hs.find(h => h.name === ${JSON.stringify(name)})?.icon;
  })()`);
  const habitNamesE = () => ev(`(async()=>
    (await (await fetch('/api/habits')).json()).map(h => h.name))()`);

  const openHabitByName = async (name) => {
    await waitUntil(ev,
      `[...document.querySelectorAll('#grid .habit-row .habit-name')]
        .some(n => n.textContent.includes(${JSON.stringify(name)}))`,
      { what: `a row containing "${name}"` });
    await ev(`(()=>{
      const rows=[...document.querySelectorAll('#grid .habit-row')];
      const i=rows.findIndex(r=>r.querySelector('.habit-name').textContent.includes(${JSON.stringify(name)}));
      rows[i].querySelector('.habit-meta').click();
    })()`);
    await waitUntil(ev,
      `[...document.querySelectorAll('#view-detail .btn')].some(b=>b.textContent==='Edit')`,
      { what: 'the habit detail page, with an Edit button' });
  };

  const openEditDialogFor = async (name) => {
    await openHabitByName(name);
    await ev(`[...document.querySelectorAll('#view-detail .btn')].find(b=>b.textContent==='Edit').click()`);
    await waitUntil(ev, `document.getElementById('habit-dialog').open === true`,
      { what: 'the edit dialog to open' });
  };

  console.log('--- a. picking writes the field and saving stores that emoji ---');
  await openNewDialog();
  await openPicker();
  const pickedValue = await ev(`(()=>{
    const cell = [...document.querySelectorAll('#icon-grid .icon-cell')]
      .find(c => c.getAttribute('aria-label') === 'runner');
    cell.click();
    return document.getElementById('habit-form').icon.value;
  })()`);
  check('picking a cell writes the field', pickedValue === '🏃', pickedValue);
  await ev(`document.getElementById('habit-form').name.value = 'Zzz Icon A'`);
  await submitAndWait();
  check('saving stores the picked glyph', await habitIcon('Zzz Icon A') === '🏃',
    String(await habitIcon('Zzz Icon A')));

  console.log('--- b. the picker did NOT take the field over (load-bearing) ---');
  await openNewDialog();
  await openPicker();
  const fieldShape = await ev(`(()=>{
    const el = document.getElementById('habit-form').icon;
    return {
      tag: el.tagName,
      readOnly: el.readOnly,
      disabled: el.disabled,
      type: el.type,
      isNamedInput: el === document.querySelector('input[name="icon"]'),
    };
  })()`);
  check('the field stays a real, editable <input> with the picker open',
    fieldShape.tag === 'INPUT' && fieldShape.readOnly === false
      && fieldShape.disabled === false && fieldShape.type !== 'hidden'
      && fieldShape.isNamedInput === true,
    JSON.stringify(fieldShape));

  // A grapheme no curated list will ever hold — typed, not picked.
  await typeInto('#habit-form [name="icon"]', '運');
  check('typing 運 lands in the field', await iconInputValue() === '運', await iconInputValue());
  await ev(`document.getElementById('habit-form').name.value = 'Zzz Icon B'`);
  await submitAndWait();
  check('the server stored the typed grapheme', await habitIcon('Zzz Icon B') === '運',
    String(await habitIcon('Zzz Icon B')));

  // The paste path, on the SAME habit — reopened for edit, the way section 3
  // already reaches Edit.
  await openEditDialogFor('Zzz Icon B');
  await pasteInto('#habit-form [name="icon"]', '🧘');
  await waitUntil(ev, `document.getElementById('habit-form').icon.value === '🧘'`,
    { what: 'the pasted glyph landing in the field' });
  await submitAndWait();
  check('the server stored the pasted glyph', await habitIcon('Zzz Icon B') === '🧘',
    String(await habitIcon('Zzz Icon B')));

  console.log('--- c. the preview shows the one grapheme the server will keep ---');
  await openNewDialog();
  await pasteInto('#habit-form [name="icon"]', 'ab');
  await waitUntil(ev, `document.querySelector('#icon-preview .icon-preview-glyph').textContent === 'a'`,
    { what: "the preview to read 'a' after pasting 'ab'" });
  const previewAB = await preview();
  check('the preview shows the one grapheme before save', previewAB.glyph === 'a', JSON.stringify(previewAB));
  await ev(`document.getElementById('habit-form').name.value = 'Zzz Icon C'`);
  await submitAndWait();
  check('the server stored that same single grapheme', await habitIcon('Zzz Icon C') === 'a',
    String(await habitIcon('Zzz Icon C')));

  // The ZWJ family — a naive `[...s][0]` shows a lone 👨. Not saved: nothing
  // beyond the preview is being asked about here.
  const ZWJ_FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
  await openNewDialog();
  await pasteInto('#habit-form [name="icon"]', ZWJ_FAMILY);
  await waitUntil(ev,
    `document.querySelector('#icon-preview .icon-preview-glyph').textContent === ${JSON.stringify(ZWJ_FAMILY)}`,
    { what: 'the preview to show the whole ZWJ family as one grapheme' });
  const previewZWJ = await preview();
  check('the ZWJ family previews as one grapheme, not its first member',
    previewZWJ.glyph === ZWJ_FAMILY, JSON.stringify(previewZWJ));
  await closeDialog();

  console.log('--- d. typing after picking overwrites the pick ---');
  await openNewDialog();
  await openPicker();
  await ev(`(()=>{
    const cell = [...document.querySelectorAll('#icon-grid .icon-cell')]
      .find(c => c.getAttribute('aria-label') === 'runner');
    cell.click();
  })()`);
  await waitUntil(ev, `document.getElementById('habit-form').icon.value === '🏃'`,
    { what: 'the picked glyph landing in the field' });
  await typeInto('#habit-form [name="icon"]', 'x');
  check('typing after a pick overwrites it', await iconInputValue() === 'x', await iconInputValue());
  const previewAfterType = await preview();
  check('the preview follows the overwrite', previewAfterType.glyph === 'x', JSON.stringify(previewAfterType));
  await closeDialog();

  console.log("--- e. Enter in the picker's search box does not submit the habit form ---");
  const habitsBeforeE = await habitNamesE();
  await openNewDialog();
  await ev(`document.getElementById('habit-form').name.value = 'Zzz Icon Enter'`);
  await openPicker();
  // 'hydrate' rather than 'water': several entries OUTSIDE the water group
  // (🤽 "water polo") contain "water" itself, so that query's first match
  // would not be the droplet — 'hydrate' is a keyword on exactly one entry.
  await typeInto('#icon-search', 'hydrate');
  await waitUntil(ev, `document.querySelector('#icon-grid .icon-cell')?.getAttribute('aria-label') === 'droplet'`,
    { what: 'the search to filter to the droplet cell alone' });
  await pressEnterKey();
  await waitUntil(ev,
    `document.getElementById('habit-form').icon.value === '💧'
      || document.getElementById('habit-dialog').open === false`,
    { what: 'Enter to pick the first match, or the form to submit if the key was not caught' });
  const afterEnter = await ev(`(()=>({
    dialogOpen: document.getElementById('habit-dialog').open,
    iconValue: document.getElementById('habit-form').icon.value,
  }))()`);
  check('Enter in the search box does not submit the habit form',
    afterEnter.dialogOpen === true, JSON.stringify(afterEnter));
  check('…and it picks the first match instead, so the key does something useful',
    afterEnter.iconValue === '💧', JSON.stringify(afterEnter));
  check('no habit was written behind it',
    !(await habitNamesE()).includes('Zzz Icon Enter'),
    JSON.stringify({ before: habitsBeforeE, after: await habitNamesE() }));
  await closeDialog();

  console.log('--- f. a11y ---');
  await openNewDialog();
  const toggleClosed = await ev(`(()=>{
    const t = document.getElementById('icon-picker-toggle');
    return { expanded: t.getAttribute('aria-expanded'), label: t.getAttribute('aria-label') };
  })()`);
  check('the toggle has a real accessible name', !!toggleClosed.label, JSON.stringify(toggleClosed));
  check('aria-expanded starts false', toggleClosed.expanded === 'false', JSON.stringify(toggleClosed));

  await openPicker();
  check('aria-expanded tracks the panel opening',
    await ev(`document.getElementById('icon-picker-toggle').getAttribute('aria-expanded')`) === 'true');

  const a11yGrid = await ev(`(()=>{
    const cells = [...document.querySelectorAll('#icon-grid .icon-cell')];
    return {
      count: cells.length,
      tabZero: cells.filter(c => c.tabIndex === 0).length,
      everyLabelled: cells.every(c => !!(c.getAttribute('aria-label') || '').trim()),
    };
  })()`);
  check('exactly one cell carries tabindex="0"', a11yGrid.tabZero === 1, JSON.stringify(a11yGrid));
  check('every cell has a non-empty aria-label', a11yGrid.everyLabelled === true, JSON.stringify(a11yGrid));

  const arrowMove = await ev(`(()=>{
    const cells = [...document.querySelectorAll('#icon-grid .icon-cell')];
    const start = cells.find(c => c.tabIndex === 0);
    start.focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    return {
      moved: document.activeElement !== start,
      nowTabZero: document.activeElement.tabIndex === 0,
      previousDroppedOut: start.tabIndex === -1,
    };
  })()`);
  check('ArrowRight moves the roving tab stop', arrowMove.moved === true && arrowMove.nowTabZero === true,
    JSON.stringify(arrowMove));
  check('the previous cell drops out of the tab order', arrowMove.previousDroppedOut === true,
    JSON.stringify(arrowMove));

  await ev(`document.getElementById('icon-picker-toggle').click()`);
  await waitUntil(ev, `document.getElementById('icon-picker').hidden === true`, { what: 'the panel to close' });
  check('aria-expanded tracks the panel closing too',
    await ev(`document.getElementById('icon-picker-toggle').getAttribute('aria-expanded')`) === 'false');
  await closeDialog();

  console.log('--- g. Escape closes the panel and leaves the dialog open; a second closes the dialog ---');
  await openNewDialog();
  await openPicker();
  await ev(`document.getElementById('icon-search').focus()`);
  await pressEscape();
  // Either half of this OR can be what actually happens: the panel alone
  // closing is the intended behaviour, and the dialog closing too is the
  // failure mode under test — waiting on the disjunction is what keeps a
  // failing run fast instead of exhausting `waitUntil`'s 20s timeout.
  await waitUntil(ev,
    `document.getElementById('icon-picker').hidden === true
      || document.getElementById('habit-dialog').open === false`,
    { what: 'the panel to close, or (if Escape reached it) the dialog' });
  const afterFirstEscape = await ev(`(()=>({
    dialogOpen: document.getElementById('habit-dialog').open,
    panelHidden: document.getElementById('icon-picker').hidden,
  }))()`);
  check('the first Escape closes the panel',
    afterFirstEscape.panelHidden === true, JSON.stringify(afterFirstEscape));
  check('the first Escape leaves the dialog open',
    afterFirstEscape.dialogOpen === true, JSON.stringify(afterFirstEscape));

  if (afterFirstEscape.dialogOpen === true) {
    await pressEscape();
    await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
      { what: 'a second Escape to close the dialog' });
    check('a second Escape closes the dialog', true);
  } else {
    // The dialog is already gone — nothing a second Escape could close, and
    // asserting it here would either hang for 20s against a document that
    // no longer has a dialog to open, or pass vacuously. Named rather than
    // silently skipped.
    check('a second Escape closes the dialog', false,
      'skipped: the first Escape already closed the dialog');
  }
  await ev(`document.getElementById('habit-dialog').close()`);

  console.log('--- g2. Escape from the TOGGLE (the mouse-opened path) closes the panel, not the dialog ---');
  // Case g above focuses `#icon-search` before pressing Escape, which is the
  // one path that already worked even with the Escape listener bound to
  // `els.panel`: `#icon-search` is INSIDE `#icon-picker`, so a `keydown`
  // there always reached a panel-scoped listener. `#icon-picker-toggle` is
  // not — it sits in `.icon-field-row` beside the input, and `#icon-picker` is
  // a sibling after the whole `.icon-field` block,
  // and a user who opens the picker with the MOUSE has focus land on the
  // button they pressed, never moved into the panel (`openPanel()`
  // deliberately does not steal it). A user who then immediately presses
  // Escape — without first tabbing or clicking into the panel — has focus
  // outside `#icon-picker` the whole time, so a listener scoped to the panel
  // never runs and the keydown's default action (the `<dialog>`'s own
  // Escape-close) fires instead, discarding whatever had already been typed
  // into Name and Description.
  //
  // `openPicker()`'s `.click()` is a SYNTHETIC activation and does not move
  // focus the way a genuine click does — verified empirically, the assertion
  // below fails against it — so this reproduces the mouse path with a real
  // CDP click instead, at the toggle's own on-screen coordinates.
  await openNewDialog();
  await typeInto('#habit-form [name="name"]', 'Escape from the toggle');
  const toggleBox = await ev(`(()=>{
    const b = document.getElementById('icon-picker-toggle').getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent',
      { type, x: toggleBox.x, y: toggleBox.y, button: 'left', clickCount: 1 }, sessionId);
  }
  await waitUntil(ev,
    `!document.getElementById('icon-picker').hidden
      && document.querySelectorAll('#icon-grid .icon-cell').length > 0`,
    { what: 'the icon picker panel, open with cells rendered (via a real mouse click)' });
  const focusedAfterOpen = await ev(`document.activeElement && document.activeElement.id`);
  check('opening the picker with a real mouse click leaves focus on the toggle',
    focusedAfterOpen === 'icon-picker-toggle', focusedAfterOpen);
  await pressEscape();
  await waitUntil(ev,
    `document.getElementById('icon-picker').hidden === true
      || document.getElementById('habit-dialog').open === false`,
    { what: 'the panel to close, or (if Escape reached the dialog instead) the dialog' });
  const afterToggleEscape = await ev(`(()=>({
    dialogOpen: document.getElementById('habit-dialog').open,
    panelHidden: document.getElementById('icon-picker').hidden,
    name: document.getElementById('habit-form').name.value,
  }))()`);
  check('Escape from the toggle closes the panel',
    afterToggleEscape.panelHidden === true, JSON.stringify(afterToggleEscape));
  check('Escape from the toggle leaves the dialog open, with what was typed still in it',
    afterToggleEscape.dialogOpen === true && afterToggleEscape.name === 'Escape from the toggle',
    JSON.stringify(afterToggleEscape));
  await closeDialog();

  console.log('--- h. reopening the dialog resets the panel and the search ---');
  // `#icon-picker` is static markup wired once by `initIconField()`, so
  // nothing about closing and reopening the habit dialog touches it on its
  // own — a panel left open, filtering on a typed query, would otherwise
  // still be open and still filtering the next time the dialog opens, for a
  // DIFFERENT habit. `iconField.set()` (called from `openDialog`) is the seam
  // that has to reset it instead.
  await openNewDialog();
  await openPicker();
  await typeInto('#icon-search', 'water');
  await waitUntil(ev, `document.getElementById('icon-search').value === 'water'`,
    { what: 'the search query to land in the box' });
  // Closed without picking or saving — the "cancel" the brief asks for; this
  // dialog has `method="dialog"`, and `.close()` with no submitter is exactly
  // what pressing Escape or a Cancel button does.
  await closeDialog();
  await openNewDialog();
  const reopened = await ev(`(()=>({
    panelHidden: document.getElementById('icon-picker').hidden,
    searchValue: document.getElementById('icon-search').value,
    expanded: document.getElementById('icon-picker-toggle').getAttribute('aria-expanded'),
  }))()`);
  check('reopening the dialog leaves the picker panel hidden',
    reopened.panelHidden === true, JSON.stringify(reopened));
  check('reopening the dialog clears the search box',
    reopened.searchValue === '', JSON.stringify(reopened));
  check('reopening the dialog resets aria-expanded to false',
    reopened.expanded === 'false', JSON.stringify(reopened));
  await closeDialog();

  console.log(fails === 0 ? '\nALL FEATURE CHECKS PASSED' : `\n${fails} FEATURE CHECK(S) FAILED`);
} catch (e) {
  console.error('ERROR:', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
