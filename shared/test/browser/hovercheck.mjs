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
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000', PORT = 9302;
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
  await send('Page.navigate', { url: APP }, sessionId);
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
    await sleep(250);
  }
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
  await send('Page.navigate', { url: APP }, sessionId);
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
    await sleep(250);
  }
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
  // The last cell's own label, for the reason the check above uses one.
  ck('the popover follows the cursor to the last cell',
    (after.text ?? '') === (neighbours.at(-1).label ?? '\u0000'),
    `${after.text} (expected ${neighbours.at(-1).label})`);
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

  // The re-render check above zoomed in; leave the account as it was found.
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({calendarZoom:'default'})}).then(r=>r.ok)`);

} catch (err) {
  console.log('FAIL  harness error :: ' + err.message);
  fails++;
} finally {
  try { ws?.close(); } catch {}
  await closeChrome({ chrome, port: PORT, profile });
}

console.log(`\n${fails === 0 ? 'all hover checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
