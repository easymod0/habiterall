/** Browser checks for empty state, starters, reorder, undo, and calendar keys. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';
const BASE = process.env.BASE ?? 'http://localhost:3000';
const PORT = 9229;

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
    await send('Page.navigate', { url: BASE }, sessionId);
    for (let i = 0; i < 80; i++) {
      const ok = await ev(waitForRows
        ? `!!document.querySelector('#grid .habit-row')`
        : `!document.getElementById('empty').hidden || !!document.querySelector('#grid .habit-row')`
      ).catch(() => 0);
      if (ok) break;
      await sleep(200);
    }
  };

  /* ---------- 1. empty state ---------- */
  console.log('--- empty state ---');
  await send('Page.navigate', { url: BASE }, sessionId);
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
    return {restored: !!h, entries: es.length, notes: es[0]?.notes};
  })()`);
  check('undo restores the habit', afterUndo.restored === true, JSON.stringify(afterUndo));
  check('undo restores its history', afterUndo.entries === 2, String(afterUndo.entries));
  check('undo restores notes too', afterUndo.notes === 'kept', String(afterUndo.notes));

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

  console.log(fails === 0 ? '\nALL FEATURE CHECKS PASSED' : `\n${fails} FEATURE CHECK(S) FAILED`);
} catch (e) {
  console.error('ERROR:', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
