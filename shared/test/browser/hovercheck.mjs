/**
 * Calendar cell hover: the square grows, and a popover shows the day.
 *
 * Needs a real browser: the growth is a CSS transform whose origin depends on
 * `transform-box: fill-box`, and getting that wrong sends the cell flying
 * across the grid rather than scaling in place — a fake DOM cannot see it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000', PORT = devtoolsPort(9302);
const profile = mkdtempSync(join(tmpdir(), 'habhover-'));
const chrome = launchChrome(PORT, profile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ck = (l, c, e = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + l + (e ? ' :: ' + e : '')); if (!c) fails++; };
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
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  // Stale service-worker CSS has produced phantom results in this repo before.
  await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);

  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate', { url: APP }, sessionId),
    what: 'the dashboard',
  });
  await sleep(300);
  await ev(`navigator.serviceWorker?.getRegistrations?.().then(rs=>Promise.all(rs.map(r=>r.unregister()))).catch(()=>0)`);
  await ev(`caches?.keys?.().then(k=>Promise.all(k.map(x=>caches.delete(x)))).catch(()=>0)`);
  // Pin the zoom so this suite does not inherit whatever calcheck left behind
  // — cell sizes appear in the output, and a run that reports 20px when the
  // level says 13px looks like a bug in the wrong place.
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({calendarZoom:'default'})}).then(r=>r.ok)`);
  await ev(`localStorage.removeItem('habiterall-settings')`).catch(() => {});
  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate', { url: APP }, sessionId),
    what: 'the dashboard',
  });
  await sleep(400);

  await ev(`document.querySelector('.habit-row .habit-name, .habit-row .name')?.click()`);
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!document.querySelector('[aria-label="Completion calendar"]')`).catch(() => 0)) break;
    await sleep(250);
  }
  await sleep(400);

  console.log('\n--- setup ---');

  const ready = await ev(`(()=>{
    const svg=document.querySelector('[aria-label="Completion calendar"]');
    const cells=[...svg.querySelectorAll('rect.cal-cell[data-date]')];
    return {cells: cells.length, labelled: cells.filter(c=>c.dataset.label).length};})()`);

  ck('the calendar has cells', ready.cells > 0, `${ready.cells}`);
  ck('every cell carries a label', ready.labelled === ready.cells,
    `${ready.labelled}/${ready.cells}`);

  // The native tooltip must be suppressed, or it appears on top of the popover.
  const titleHidden = await ev(`(()=>{
    const t=document.querySelector('.cal-cell > title');
    return t ? getComputedStyle(t).display : 'none';})()`);
  ck('the native <title> tooltip is suppressed', titleHidden === 'none', titleHidden);

  ck('<title> is still in the DOM for screen readers',
    await ev(`!!document.querySelector('.cal-cell > title')?.textContent?.trim()`));
  ck('<title> keeps the "click to edit" affordance',
    await ev(`[...document.querySelectorAll('.cal-cell[data-date] > title')]
      .some(t=>t.textContent.includes('click to edit'))`));

  /* ---------- hovering ---------- */

  console.log('\n--- hover ---');

  // Scroll the calendar into view *first*: the detail page is taller than the
  // viewport, and a synthetic mouse move to a coordinate below the fold lands
  // on nothing at all — no hover, no events, and every check below fails for
  // a reason that has nothing to do with the feature.
  await ev(`document.querySelector('[aria-label="Completion calendar"]')
    .scrollIntoView({block:'center'})`);
  await sleep(400);

  // Pick a cell in the middle, so a popover above it is not clipped.
  const target = await ev(`(()=>{
    const cells=[...document.querySelectorAll('rect.cal-cell[data-date]')];
    const c=cells[Math.floor(cells.length*0.6)];
    const b=c.getBoundingClientRect();
    window.__cell=c;
    return {date:c.dataset.date, label:c.getAttribute('data-label'),
            x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2),
            w:+b.width.toFixed(2), inView: b.top>0 && b.bottom<window.innerHeight};})()`);

  ck('the chosen cell is on screen', target.inView === true,
    `y=${target.y} viewport=900`);

  // `pointerType: 'mouse'` is what makes Chrome synthesise the pointer events
  // the popover listens for; without it only legacy mouse events fire and
  // nothing happens. Two moves because CSS `:hover` settles on the second.
  const move = async (x, y) => {
    for (let i = 0; i < 2; i++) {
      await send('Input.dispatchMouseEvent',
        { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' }, sessionId);
    }
  };

  await move(target.x, target.y);
  await sleep(300);

  const hovered = await ev(`(()=>{
    const c=window.__cell; const b=c.getBoundingClientRect();
    const pop=document.querySelector('.cal-pop');
    const pb=pop?.getBoundingClientRect();
    return {
      w:+b.width.toFixed(2),
      transform:getComputedStyle(c).transform,
      isLast: c.parentNode.lastElementChild === c,
      popText: pop?.textContent ?? null,
      popOpacity: pop ? +getComputedStyle(pop).opacity : 0,
      popPointerEvents: pop ? getComputedStyle(pop).pointerEvents : null,
      popCentred: pb ? Math.abs((pb.left+pb.width/2) - (b.left+b.width/2)) : null,
      popAbove: pb ? pb.bottom <= b.top : null,
      onScreen: pb ? (pb.left >= 0 && pb.right <= window.innerWidth) : null,
    };})()`);

  ck('the hovered square grows', hovered.w > target.w,
    `${target.w}px -> ${hovered.w}px`);
  ck('the growth is a transform, not a layout change',
    hovered.transform !== 'none' && hovered.transform !== '',
    hovered.transform);
  ck('the hovered cell is raised above its neighbours', hovered.isLast === true);

  ck('a popover appeared', hovered.popText != null, String(hovered.popText));
  // Not the ISO date — the popover writes a date for a person now, and
  // asserting the storage key would pin en-US. But not `data-label` either:
  // comparing the popover against the attribute it is BUILT FROM asks nothing
  // about which day it names. Mutated, with every calendar popover shifted a
  // day forward, that version passed seven suites; the master version it
  // replaced failed. So the expectation is computed from the cell's own DATE,
  // through the same helper, which stays locale-free and still moves when the
  // date does.
  const wantLabel = await ev(`(async()=>{
    const { formatDateShort, fromISOLocal } = await import('/shared/ui/dates.js');
    return formatDateShort(fromISOLocal(${JSON.stringify(target.date)}));
  })()`);
  ck('the popover names the day the hovered cell is',
    String(hovered.popText ?? '').includes(wantLabel),
    `${hovered.popText} (expected to contain ${wantLabel})`);
  ck('the popover is fully visible', hovered.popOpacity === 1,
    String(hovered.popOpacity));
  // Deliberately absent: the cursor already says the cell is clickable, and
  // the phrase doubles the width of a bubble that tracks the pointer.
  ck('the popover omits "click to edit"',
    !(hovered.popText ?? '').includes('click to edit'), String(hovered.popText));
  ck('the popover never steals the hover',
    hovered.popPointerEvents === 'none', String(hovered.popPointerEvents));
  ck('the popover is centred on the cell', hovered.popCentred < 3,
    `${hovered.popCentred}px off`);
  ck('the popover sits above the cell', hovered.popAbove === true);
  ck('the popover stays on screen', hovered.onScreen === true);

  /* ---------- leaving ---------- */

  console.log('\n--- leaving ---');

  await move(5, 5);
  await sleep(400);

  const left = await ev(`(()=>{
    const c=window.__cell;
    return {w:+c.getBoundingClientRect().width.toFixed(2),
            pops:document.querySelectorAll('.cal-pop').length,
            open:document.querySelectorAll('.cal-pop.is-open').length};})()`);

  ck('the square returns to its normal size', Math.abs(left.w - target.w) < 0.5,
    `${left.w}px vs ${target.w}px`);
  ck('the popover closes', left.open === 0, `${left.open} open`);

  /* ---------- moving between cells ---------- */

  console.log('\n--- moving across the grid ---');

  // One popover, reused — not one per cell left behind on the page.
  const neighbours = await ev(`(()=>{
    const cells=[...document.querySelectorAll('rect.cal-cell[data-date]')];
    const i=Math.floor(cells.length*0.6);
    return cells.slice(i, i+4).map(c=>{const b=c.getBoundingClientRect();
      return {date:c.dataset.date, label:c.getAttribute('data-label'),
              x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2)};});})()`);

  for (const n of neighbours) {
    await move(n.x, n.y);
    await sleep(140);
  }
  await sleep(250);

  const after = await ev(`(()=>({
    pops:document.querySelectorAll('.cal-pop').length,
    text:document.querySelector('.cal-pop')?.textContent ?? null,
    grown:[...document.querySelectorAll('.cal-cell')]
      .filter(c=>getComputedStyle(c).transform!=='none').length,
  }))()`);

  ck('only one popover exists', after.pops <= 1, `${after.pops}`);
  // Computed from the cell's DATE, exactly as the first popover check is — and
  // its comment says why in full. This one was left comparing against
  // `data-label`, the attribute the popover is built from, under a note
  // claiming it followed that reasoning: it is the same expression on both
  // sides of the assertion, so a popover shifted a day forward passes it. The
  // first check catches that; this one asked nothing.
  const wantLast = await ev(`(async()=>{
    const { formatDateShort, fromISOLocal } = await import('/shared/ui/dates.js');
    return formatDateShort(fromISOLocal(${JSON.stringify(neighbours.at(-1).date)}));
  })()`);
  ck('the popover follows the cursor to the last cell',
    String(after.text ?? '').includes(wantLast),
    `${after.text} (expected to contain ${wantLast})`);
  ck('only one cell is grown at a time', after.grown <= 1, `${after.grown} grown`);

  /* ---------- a re-render must not strand the popover ---------- */

  console.log('\n--- re-render ---');

  await move(neighbours[0].x, neighbours[0].y);
  await sleep(250);
  // Zoom while hovering: the SVG is replaced mid-hover.
  await ev(`[...document.querySelectorAll('.cal-nav button')].find(b=>b.textContent.trim()==='+')?.click()`);
  await sleep(700);

  // STRANDED means "cannot be closed", not merely "open", and the difference is
  // the whole point of `watchDetach` in charts.js: the bug was a popover left
  // over a DETACHED calendar, where no pointer event can fire again and nothing
  // takes it down.
  //
  // Counting open popovers asked a stricter question than that, and one whose
  // answer depends on where the replacement SVG lands — so on the calendar's
  // geometry, so on today's DATE. When it lands under the motionless pointer it
  // fires `pointerover` and opens a popover for the cell now under the cursor,
  // which is a live hover and correct: measured, that cell is `isConnected` and
  // the popover closes as soon as the pointer moves. On 16 August 2026 (UTC)
  // that is what happens, and this suite then failed on MASTER for every pull
  // request opened that day.
  //
  // So the question is ownership. A popover whose active cell is still in the
  // document belongs to a calendar that can close it; one with no connected
  // owner is the stranding this check is named for.
  const orphans = await ev(`(()=>{
    if (!document.querySelector('.cal-pop.is-open')) return 0;
    const owner = document.querySelector('.cal-cell.is-active');
    return owner?.isConnected ? 0 : 1;
  })()`);
  ck('no popover is stranded after a re-render', orphans === 0, `${orphans} left open`);

  /* ---------- keyboard ---------- */

  console.log('\n--- keyboard ---');

  await ev(`(()=>{const c=document.querySelector('rect.cal-cell[tabindex="0"]');
    window.__kb=c; c?.scrollIntoView({block:'center'}); c?.focus(); return !!c;})()`);
  await sleep(400);

  const focused = await ev(`(()=>{
    const c=window.__kb; const pop=document.querySelector('.cal-pop');
    return {transform:getComputedStyle(c).transform,
            popText:pop?.textContent ?? null,
            popOpen:!!document.querySelector('.cal-pop.is-open')};})()`);

  ck('focusing a cell opens the popover too', focused.popOpen === true,
    String(focused.popText));
  ck('the focused cell grows', focused.transform !== 'none', focused.transform);

  /* ---------- issue #297 / STEP 3b: the note dot must not be buried ---------- */

  console.log('\n--- the note dot survives the raise ---');

  /*
   * `raise` moved the hovered cell to the end of its parent and carried only
   * the `?` glyph with it (`[data-mark-for]`) — the note dot
   * (`[data-note-for]`, added by STEP 3) was left behind, buried under the
   * raised cell exactly the way the `?` was before `raise` existed at all.
   * The fix widens the lookup to match both attributes and re-append every
   * match. First proved with a REAL note, written through the API and read
   * back by the app the same way `calcheck.mjs`'s note-mark block does.
   */
  const openId = await ev(
    `(async () => (await import('/shared/ui/store.js')).state.openHabitId)()`);
  ck('a habit is open for the note-dot check', Number.isInteger(openId), String(openId));

  const noteDate = await ev(`(async () => {
    const { addDaysISO, todayISO } = await import('/shared/ui/dates.js');
    return addDaysISO(todayISO(), -21);})()`);
  const NOTE = 'carried by raise';
  const noteWritten = await ev(`fetch('/api/habits/${openId}/entries/${noteDate}', {
    method: 'PUT', credentials: 'same-origin',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({status: 'skip', notes: ${JSON.stringify(NOTE)}})}).then(r => r.ok)`);
  ck('the note write landed', noteWritten === true, String(noteWritten));

  // A fresh, cross-document reload — same reasoning as calcheck.mjs's note-mark
  // block: `notesByDate` is rebuilt from an unwindowed refetch inside `render()`,
  // and reading the in-page state this suite already painted from would prove
  // nothing about the note actually reaching the calendar.
  const hashAfterNote = await ev(`location.hash`);
  await reloadAndWaitFor(ev, `!!document.querySelector('[aria-label="Completion calendar"]')`, {
    reload: () => send('Page.navigate', { url: `${APP}/?open=hovernote${hashAfterNote}` }, sessionId),
    what: 'the detail page, reloaded, to pick up the note',
  });
  await sleep(400);

  const noteCell = await ev(`(()=>{
    const svg=document.querySelector('[aria-label="Completion calendar"]');
    const cell=svg?.querySelector('rect.cal-cell[data-date="${noteDate}"]');
    const dot=svg?.querySelector('[data-note-for="${noteDate}"]');
    if (!cell) return {missing:true};
    cell.scrollIntoView({block:'center'});
    window.__noteCell=cell;
    const b=cell.getBoundingClientRect();
    return {hasDot:!!dot, x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2)};})()`);
  ck('the note-bearing day carries the dot before it is hovered',
    noteCell.hasDot === true, JSON.stringify(noteCell));
  await sleep(300);

  await move(noteCell.x, noteCell.y);
  await sleep(300);

  const noteRaised = await ev(`(()=>{
    const cell=window.__noteCell;
    const dot=cell.parentNode.querySelector('[data-note-for="${noteDate}"]');
    // FOLLOWING, not merely present: the defect this fix closes is the dot
    // staying BEHIND the raised cell, so its position relative to the cell —
    // not merely its continued existence in the DOM — is the claim.
    const dotAfterCell = dot
      ? (cell.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      : false;
    // NOT isLast: raise() appends the cell first and then re-appends every
    // mark belonging to it, so a cell carrying a mark is never its parent's
    // last child -- the mark is. What raise() actually promises for a marked
    // cell is that no OTHER .cal-cell sibling comes after it.
    const siblings = [...cell.parentNode.children];
    const laterSiblings = siblings.slice(siblings.indexOf(cell) + 1);
    const noCellAfter = laterSiblings.every((el) => !el.matches('.cal-cell'));
    return {noCellAfter, hasDot: !!dot, dotAfterCell};})()`);
  ck('the hovered cell is raised above every other cell',
    noteRaised.noCellAfter === true, JSON.stringify(noteRaised));
  ck('...and the note dot is carried along, positioned AFTER the cell',
    noteRaised.hasDot === true && noteRaised.dotAfterCell === true,
    JSON.stringify(noteRaised));

  await move(5, 5);
  await sleep(300);

  /*
   * A day carrying BOTH a `?` and a note cannot occur through the app today —
   * a note always rides on an answered row (`entryWrite`), which is exactly
   * what excludes the `?` (`value == null && !isSkip`). The fix is written
   * for that combination anyway (its own comment: "a day carrying BOTH a `?`
   * and a note would still bury one of them"), so this proves the GENERAL
   * case the single-note check above cannot: a real `?` mark on a genuinely
   * unanswered day, plus a second, injected `[data-note-for]` node at the
   * same date, to prove `raise` carries every match rather than the first
   * one `querySelector` would have found.
   */
  await ev(`fetch('/api/settings', {method:'PUT', credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({questionMarks:true})}).then(r=>r.ok)`);

  const markDate = await ev(`(async () => {
    const { addDaysISO, todayISO } = await import('/shared/ui/dates.js');
    return addDaysISO(todayISO(), -22);})()`);
  await ev(`fetch('/api/habits/${openId}/entries/${markDate}',
    {method:'DELETE', credentials:'same-origin'}).then(()=>true).catch(()=>true)`);

  const hashForMark = await ev(`location.hash`);
  await reloadAndWaitFor(ev, `!!document.querySelector('[aria-label="Completion calendar"]')`, {
    reload: () => send('Page.navigate', { url: `${APP}/?open=hovermark${hashForMark}` }, sessionId),
    what: 'the detail page, reloaded, with question marks on',
  });
  await sleep(400);

  const markCell = await ev(`(()=>{
    const svg=document.querySelector('[aria-label="Completion calendar"]');
    const cell=svg?.querySelector('rect.cal-cell[data-date="${markDate}"]');
    const mark=svg?.querySelector('[data-mark-for="${markDate}"]');
    if (!cell || !mark) return {missing:true, hasMark:!!mark};
    const dot=document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('data-note-for', '${markDate}');
    dot.setAttribute('data-injected-for-test', '1');
    dot.setAttribute('r', '3');
    dot.setAttribute('cx', String(mark.getAttribute('x') ?? 0));
    dot.setAttribute('cy', String(mark.getAttribute('y') ?? 0));
    mark.after(dot);
    window.__markCell=cell;
    cell.scrollIntoView({block:'center'});
    const b=cell.getBoundingClientRect();
    return {hasMark:true, x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2)};})()`);
  ck('the unanswered day shows its "?" (the real half of the combined check)',
    markCell.hasMark === true, JSON.stringify(markCell));
  await sleep(300);

  await move(markCell.x, markCell.y);
  await sleep(300);

  const bothRaised = await ev(`(()=>{
    const cell=window.__markCell;
    const after = (n) => n
      ? (cell.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      : false;
    const mark=cell.parentNode.querySelector('[data-mark-for="${markDate}"]');
    const dot=cell.parentNode.querySelector(
      '[data-note-for="${markDate}"][data-injected-for-test]');
    return {isLast: cell.parentNode.lastElementChild === cell,
            markAfter: after(mark), dotAfter: after(dot)};})()`);
  ck('a day carrying both a "?" and a note carries BOTH marks after the raise',
    bothRaised.markAfter === true && bothRaised.dotAfter === true,
    JSON.stringify(bothRaised));

  await move(5, 5);
  await sleep(300);

  // The re-render check above zoomed in and this block turned question marks
  // on; leave the account as it was found.
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({calendarZoom:'default', questionMarks:false})}).then(r=>r.ok)`);

} catch (err) {
  console.log('FAIL  harness error :: ' + err.message);
  fails++;
} finally {
  try { ws?.close(); } catch {}
  await closeChrome({ chrome, port: PORT, profile });
}

console.log(`\n${fails === 0 ? 'all hover checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
