/** Drives the archive and notes flows in a real browser, end to end. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor,
} from './chrome.mjs';
const BASE = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9227);

const profile = mkdtempSync(join(tmpdir(), 'habflow-'));
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
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send('Page.enable', {}, sessionId);

  const reload = async () => {
    await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
      reload: () => send('Page.navigate', { url: BASE }, sessionId),
      what: 'the dashboard',
    });
  };

  // State is seeded over HTTP by the caller before this script runs.
  await reload();

  console.log('--- archive toggle ---');
  check('archive toggle hidden when nothing archived',
    await ev(`document.getElementById('list-head').hidden === true`));

  // archive via the edit dialog
  await ev(`(()=>{
    const rows=[...document.querySelectorAll('#grid .habit-row')];
    const names=rows.map(r=>r.querySelector('.habit-name').textContent);
    const i=names.findIndex(n=>n.includes('Meditate'));
    rows[i].querySelector('.habit-meta').click();
  })()`);
  await sleep(600);
  await ev(`[...document.querySelectorAll('#view-detail .btn')].find(b=>b.textContent==='Edit').click()`);
  await sleep(300);
  check('archived checkbox visible when editing',
    await ev(`getComputedStyle(document.getElementById('archived-wrap')).display !== 'none'`));

  await ev(`(()=>{
    document.querySelector('#habit-dialog input[name=archived]').checked = true;
    document.getElementById('habit-form').requestSubmit();
  })()`);
  await sleep(900);

  // Saving an edit started from a habit's own page leaves you on that page.
  // It used to drop back to the dashboard, which loses your place for no
  // reason — you were reading this habit, not the list.
  check('saving an edit stays on the habit being edited',
    await ev(`!document.getElementById('view-detail').hidden`) === true);
  check('and the page reloaded rather than going stale',
    await ev(`document.querySelector('#view-detail h2')?.textContent`) === 'Meditate',
    await ev(`document.querySelector('#view-detail h2')?.textContent`));

  // Back to the list, which is where the rest of this section looks.
  await ev(`document.getElementById('btn-home').click()`);
  await sleep(800);

  const afterArchive = await ev(`(()=>({
    rows: [...document.querySelectorAll('#grid .habit-row .habit-name')].map(n=>n.textContent),
    toggleShown: !document.getElementById('list-head').hidden,
    toggleLabel: document.getElementById('toggle-archived').textContent.trim(),
  }))()`);
  check('archived habit disappears from the dashboard',
    !afterArchive.rows.some(r => r.includes('Meditate')), JSON.stringify(afterArchive.rows));
  check('archive toggle appears once something is archived', afterArchive.toggleShown === true);
  check('toggle reads "Show archived"', afterArchive.toggleLabel === 'Show archived', afterArchive.toggleLabel);

  await ev(`document.getElementById('toggle-archived').click()`);
  await sleep(800);
  const inArchive = await ev(`(()=>({
    rows: [...document.querySelectorAll('#grid .habit-row .habit-name')].map(n=>n.textContent),
    dimmed: !!document.querySelector('.habit-row.archived'),
    label: document.getElementById('toggle-archived').textContent.trim(),
  }))()`);
  check('archived view lists the archived habit',
    inArchive.rows.some(r => r.includes('Meditate')), JSON.stringify(inArchive.rows));
  check('archived rows are visually marked', inArchive.dimmed === true);
  check('toggle flips to "Show active"', inArchive.label === 'Show active', inArchive.label);

  await ev(`document.getElementById('toggle-archived').click()`);
  await sleep(800);

  console.log('--- notes via the calendar ---');
  // The archive test left Meditate archived and may have left the dashboard
  // on the archived view; unarchive and return to the active list so the
  // habit lookup below is unambiguous.
  await ev(`(async()=>{
    const arch = await (await fetch('/api/habits?archived=true')).json();
    for (const h of arch) {
      await fetch('/api/habits/'+h.id, {method:'PUT',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({...h, archived:false})});
    }
  })()`);
  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate', { url: BASE }, sessionId),
    what: 'the dashboard',
  });
  await ev(`(()=>{
    const rows=[...document.querySelectorAll('#grid .habit-row')];
    const names=rows.map(r=>r.querySelector('.habit-name').textContent);
    const i=names.findIndex(n=>n.includes('Read'));
    rows[i].querySelector('.habit-meta').click();
  })()`);
  for (let i = 0; i < 60; i++) {
    if (await ev(`!!document.querySelector('#view-detail svg[aria-label="Completion calendar"] rect[cursor="pointer"]')`)) break;
    await sleep(200);
  }
  const pickedDate = await ev(`(()=>{
    const cells=[...document.querySelectorAll('#view-detail svg[aria-label="Completion calendar"] rect[cursor="pointer"]')];
    const c=cells[cells.length-3];
    const d=c.getAttribute('data-date');   // stable key; the title is human copy
    c.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    return d;
  })()`);
  await sleep(400);

  check('notes field is visible in the day editor',
    await ev(`getComputedStyle(document.getElementById('day-notes-wrap')).display !== 'none'`));

  // The amount control's own label, which names the unit. It moved out of the
  // day dialog into ui/count-field.js when the number input became a control,
  // and `daydialog.mjs` can no longer see it — that suite builds a fake DOM and
  // stubs the control, so the only place this can be read is a real browser.
  // Without it, `Amount (pages)` could become `Amount` for every measurable
  // habit and nothing would fail.
  check('the amount field is labelled with the habit\'s unit',
    await ev(`document.querySelector('#day-count legend').textContent`) === 'Amount (pages)',
    await ev(`document.querySelector('#day-count legend').textContent`));

  const clickInfo = await ev(`(()=>{
    // The amount is a control now, not a bare number input — the box inside it
    // is what is read, which is the rule ui/count-field.js is built on.
    const v=document.getElementById('day-count-typed');
    const n=document.getElementById('day-notes');
    const s=document.getElementById('day-save');
    v.value='7'; n.value='short on time';
    const info={ valueVisible:getComputedStyle(document.getElementById('day-numeric')).display!=='none',
                 saveHidden:s.hidden, saveDisplay:getComputedStyle(s).display,
                 title:document.getElementById('day-title').textContent };
    s.click();
    return info;
  })()`);
  console.log('    dialog state at save:', JSON.stringify(clickInfo));
  // Wait for the dialog to close, which the app only does after the save
  // resolves. A fixed sleep raced the request on a loaded machine.
  for (let i = 0; i < 40; i++) {
    if (await ev(`!document.getElementById('day-dialog').open`)) break;
    await sleep(200);
  }
  await sleep(400);

  const saved = await ev(`(async()=>{
    const hs=await (await fetch('/api/habits')).json();
    const h=hs.find(x=>x.name==='Read');
    const es=await (await fetch('/api/habits/'+h.id+'/entries')).json();
    return es.find(e=>e.date==='${pickedDate}');
  })()`);
  check('value saved from the calendar', saved?.value === 7, JSON.stringify(saved));
  check('note saved alongside the value', saved?.notes === 'short on time', JSON.stringify(saved));

  // reopen: the note must be prefilled
  await ev(`(()=>{
    const cells=[...document.querySelectorAll('#view-detail svg[aria-label="Completion calendar"] rect[cursor="pointer"]')];
    cells[cells.length-3].dispatchEvent(new MouseEvent('click',{bubbles:true}));
  })()`);
  await sleep(400);
  check('existing note is prefilled on reopen',
    await ev(`document.getElementById('day-notes').value`) === 'short on time',
    await ev(`document.getElementById('day-notes').value`));

  console.log(fails === 0 ? '\nALL FLOW CHECKS PASSED' : `\n${fails} FLOW CHECK(S) FAILED`);
} catch (e) {
  console.error('ERROR:', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
