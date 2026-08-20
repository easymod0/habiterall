/** Drives the archive and notes flows in a real browser, end to end. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome, waitUntil } from './chrome.mjs';
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
    await send('Page.navigate', { url: BASE }, sessionId);
    for (let i = 0; i < 80; i++) {
      if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
      await sleep(200);
    }
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

  // #177. Meditate is the ONLY archived habit, so unarchiving it empties the
  // view we are standing in — and `paint()` hides `#list-head` when nothing is
  // archived, which is where `#toggle-archived` lives. The archive became a
  // room with no door: "No archived habits.", zero controls, and the three
  // roads out all emit 'reload', which re-reads `showArchived` and lands right
  // back here. F5 was the only escape.
  //
  // Driven through the REAL dialog and with no navigation anywhere in it,
  // because both are what make this able to fail: a raw `fetch` plus a
  // `Page.navigate` re-initialises `showArchived` to false and passes against
  // the unfixed build — which is exactly what the section below this one does,
  // and why it carries a comment conceding the dashboard "may have left" the
  // archived view.
  console.log('--- leaving an archive that has just emptied (#177) ---');

  // This section waits for the APP rather than for a duration, which the rest
  // of this file does not yet do. It is the section where it matters most: the
  // suites run sixteen-wide, and a missed sleep budget here would report
  // itself as "unarchiving the last archived habit lands on the active list"
  // failing — a flake wearing the costume of the bug this fixes.
  //
  // The predicates are deliberately NEUTRAL — each one is true in both the
  // fixed and the unfixed build. `paint()` opens with `grid.replaceChildren()`
  // and the detail view's `render()` with `host.replaceChildren()`, so a mark
  // put on what is on screen now cannot survive the next render of it — and
  // "it re-rendered" says nothing about WHICH list was painted. Waiting on the
  // fixed behaviour instead would make every `check()` below it tautological:
  // the wait would time out or the check would pass, and it could never fail.
  const ROWS = '#grid .habit-row';
  const DETAIL = '#view-detail > *';
  const mark = (sel) => ev(`(()=>{
    const kids = [...document.querySelectorAll('${sel}')];
    for (const k of kids) k.dataset.stale = '1';
    return kids.length;
  })()`);
  const gone = (sel) => `!document.querySelector('${sel}[data-stale]')`;
  const repainted = () => waitUntil(ev, gone(ROWS), { what: 'the dashboard to repaint' });

  // First the ordinary way out, from an archive that still has something in
  // it. The app title's tooltip says "Back to your habits" and it could not do
  // that: the archive is a session boolean rather than a route, so 'reload'
  // alone re-read `showArchived` and landed straight back here.
  await mark(ROWS);
  await ev(`document.getElementById('btn-home').click()`);
  await repainted();
  const home = await ev(`(()=>({
    label: document.getElementById('toggle-archived').textContent.trim(),
    rows: [...document.querySelectorAll('#grid .habit-row .habit-name')].map(n=>n.textContent),
  }))()`);
  check('#btn-home leaves the archive it is captioned to leave',
    home.label === 'Show archived', home.label);
  check('...onto the active list', !home.rows.some(r => r.includes('Meditate')),
    JSON.stringify(home.rows));

  // Back into the archive for the trap itself.
  await mark(ROWS);
  await ev(`document.getElementById('toggle-archived').click()`);
  await repainted();
  check('control: back in the archive, with its one habit',
    await ev(`document.getElementById('toggle-archived').textContent.trim()`) === 'Show active');

  await ev(`(()=>{
    const rows=[...document.querySelectorAll('#grid .habit-row')];
    const names=rows.map(r=>r.querySelector('.habit-name').textContent);
    const i=names.findIndex(n=>n.includes('Meditate'));
    rows[i].querySelector('.habit-meta').click();
  })()`);
  await waitUntil(ev,
    `[...document.querySelectorAll('#view-detail .btn')].some(b=>b.textContent==='Edit')`,
    { what: "the habit's own page, with its Edit button" });

  await ev(`[...document.querySelectorAll('#view-detail .btn')].find(b=>b.textContent==='Edit').click()`);
  await waitUntil(ev,
    `document.getElementById('habit-dialog').open === true
      && !!document.querySelector('#habit-dialog input[name=archived]')`,
    { what: 'the edit dialog, with the archived checkbox in it' });

  // Saving from a habit's own page emits 'change', NOT 'reload' — the dialog
  // returns you to where the edit started, so nothing reloads the dashboard
  // here and the grid underneath is still whatever the archive painted. The
  // wait is therefore on the DETAIL view's own rebuild, which `on('change')`
  // reaches through `open()` -> `render()` -> `host.replaceChildren()`, and
  // only once the refetch behind it has answered.
  //
  // That rebuild is also a race the fixed sleep was hiding rather than
  // avoiding: Back is one of the nodes it replaces, so a click that arrives
  // first lands on a detached element and does nothing at all.
  await mark(DETAIL);
  await ev(`(()=>{
    document.querySelector('#habit-dialog input[name=archived]').checked = false;
    document.getElementById('habit-form').requestSubmit();
  })()`);
  await waitUntil(ev,
    `document.getElementById('habit-dialog').open === false && ${gone(DETAIL)}`,
    { what: 'the save to close its dialog and the habit page to rebuild under it' });

  // Saving from a habit's own page leaves you on that page, so Back is the
  // road out — and it is one of the three that used to lead straight back into
  // the archive.
  //
  // Gated on the VIEW switching as well as on the repaint, because against the
  // unfixed build this Back lands on "No archived habits." — no rows, so
  // nothing was marked and the repaint half is vacuously true. That is the
  // case the checks below exist to reach and fail on, so the wait must not
  // depend on it.
  await mark(ROWS);
  await ev(`[...document.querySelectorAll('#view-detail .btn')].find(b=>b.textContent.includes('Back')).click()`);
  await waitUntil(ev,
    `document.getElementById('view-detail').hidden === true && ${gone(ROWS)}`,
    { what: 'Back to leave the habit page and the dashboard to repaint' });

  const escaped = await ev(`(()=>({
    rows: [...document.querySelectorAll('#grid .habit-row .habit-name')].map(n=>n.textContent),
    emptyArchive: !document.getElementById('empty-archived').hidden,
    label: document.getElementById('toggle-archived').textContent.trim(),
  }))()`);
  check('unarchiving the last archived habit lands on the active list',
    escaped.rows.some(r => r.includes('Meditate')), JSON.stringify(escaped.rows));
  check('...and not on "No archived habits."', escaped.emptyArchive === false);
  // The toggle's own label is the tell. Left on the archive it still reads
  // "Show active", over a list with nothing on it and no way to press it.
  check('...with the toggle back to "Show archived"', escaped.label === 'Show archived',
    escaped.label);

  // ...and the app is back in the state it started this section in, rather
  // than in a half-archive: nothing is archived, so the toggle is hidden again
  // exactly as the first check in this file asserts it is on a fresh account.
  check('...and the toggle is hidden again, as on an account with no archive',
    await ev(`document.getElementById('list-head').hidden === true`));

  console.log('--- notes via the calendar ---');
  // The section above ends with everything unarchived and the dashboard on the
  // active list, so this is a belt-and-braces reset rather than a repair: it
  // makes the habit lookup below unambiguous whatever that section leaves
  // behind. Keep it — it is what stops a change up there silently breaking the
  // notes checks instead of the archive ones.
  await ev(`(async()=>{
    const arch = await (await fetch('/api/habits?archived=true')).json();
    for (const h of arch) {
      await fetch('/api/habits/'+h.id, {method:'PUT',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({...h, archived:false})});
    }
  })()`);
  await send('Page.navigate', { url: BASE }, sessionId);
  for (let i = 0; i < 60; i++) {
    if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(()=>0)) break;
    await sleep(200);
  }
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
