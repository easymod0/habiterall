/**
 * Calendar: today must be visible, and the zoom controls must work.
 *
 * The missing-today bug was pure date arithmetic, and calendar.test.js pins
 * that. This checks the thing a unit test cannot: that the square is actually
 * drawn, in the DOM, on the page the user sees — the same reason the CSS
 * `hidden` regression needed a real browser.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000', PORT = 9294;
const profile = mkdtempSync(join(tmpdir(), 'habcal-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ck = (l, c, e = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + l + (e ? ' :: ' + e : '')); if (!c) fails++; };
let ws, nid = 1; const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

try {
  let url;
  for (let i = 0; i < 60; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; if (url) break; } catch {}
    await sleep(250);
  }
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

  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

  // Start from a known zoom. The checks below are relative ("bigger than
  // before"), so inheriting whatever the account was left on makes them
  // assert nothing — or fail at an end stop that is already disabled.
  await send('Page.navigate', { url: APP }, sessionId);
  await sleep(800);
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({calendarZoom:'default'})}).then(r=>r.ok)`);
  await ev(`localStorage.removeItem('habiterall-settings')`).catch(() => {});
  await send('Page.navigate', { url: APP }, sessionId);
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
    await sleep(250);
  }
  await sleep(500);

  // Open the first habit's detail view, where the calendar lives.
  await ev(`document.querySelector('.habit-row .habit-name, .habit-row .name')?.click()`);
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!document.querySelector('[aria-label="Completion calendar"]')`).catch(() => 0)) break;
    await sleep(250);
  }
  await sleep(400);

  /* ---------- the regression: today must be drawn ---------- */

  console.log('\n--- today is visible ---');

  const cal = await ev(`(()=>{
    const svg=document.querySelector('[aria-label="Completion calendar"]');
    if(!svg) return {missing:true};
    const rects=[...svg.querySelectorAll('rect')];
    const dated=rects.filter(r=>r.dataset.date);
    const d=new Date(); d.setHours(0,0,0,0);
    const iso=\`\${d.getFullYear()}-\${String(d.getMonth()+1).padStart(2,'0')}-\${String(d.getDate()).padStart(2,'0')}\`;
    const today=dated.find(r=>r.dataset.date===iso);
    const box=svg.getBoundingClientRect();
    const tb=today?.getBoundingClientRect();
    return {
      todayISO: iso,
      weekday: d.getDay(),
      totalRects: rects.length,
      clickable: dated.length,
      hasToday: !!today,
      // Present in the DOM is not enough — it must be inside the drawn area.
      todayInsideSvg: tb ? (tb.right <= box.right + 1 && tb.left >= box.left - 1) : false,
      todayWidth: tb ? Math.round(tb.width) : 0,
      lastDate: dated.map(r=>r.dataset.date).sort().at(-1),
    };})()`);

  ck('the calendar rendered', !cal.missing);
  ck("today's square exists", cal.hasToday === true,
    `today=${cal.todayISO} weekday=${cal.weekday} lastDrawn=${cal.lastDate}`);
  ck("today's square is inside the drawn area", cal.todayInsideSvg === true,
    `width=${cal.todayWidth}px`);
  ck('the last drawn date is today or later', cal.lastDate >= cal.todayISO,
    `${cal.lastDate} vs ${cal.todayISO}`);

  /* ---------- the grid fills the card ---------- */

  console.log('\n--- width ---');

  const fit = await ev(`(()=>{
    const svg=document.querySelector('[aria-label="Completion calendar"]');
    const scroll=svg.closest('.chart-scroll');
    const sw=svg.getBoundingClientRect().width;
    const cw=scroll.getBoundingClientRect().width;
    return {svg:Math.round(sw), container:Math.round(cw),
            used:Math.round(sw/cw*100), overflows: sw > cw + 1};})()`);

  // It used to render at a fixed 454px inside a ~1026px card, using 44% of it.
  ck('the calendar fills most of the card width', fit.used >= 90,
    `${fit.svg}px of ${fit.container}px (${fit.used}%)`);
  ck('the calendar does not overflow its container', fit.overflows === false,
    `${fit.svg}px vs ${fit.container}px`);

  // An SVG wider than its container gets scaled down by `max-width: 100%`, so
  // the cells render fractionally smaller than the zoom level asked for.
  const crisp = await ev(`(()=>{
    const svg=document.querySelector('[aria-label="Completion calendar"]');
    const attr=parseFloat(svg.getAttribute('width'));
    const actual=svg.getBoundingClientRect().width;
    const cell=svg.querySelector('rect[data-date]').getBoundingClientRect().width;
    return {attr, actual:Math.round(actual), cell:+cell.toFixed(2),
            scaled: Math.abs(attr-actual) > 1};})()`);

  ck('the calendar is not scaled down by max-width', crisp.scaled === false,
    `attr=${crisp.attr} rendered=${crisp.actual}`);
  ck('cells render at their exact zoom size',
    Number.isInteger(crisp.cell), `${crisp.cell}px`);

  /* ---------- the other charts fill the width too ---------- */

  const others = await ev(`(()=>{
    const out={};
    for (const card of document.querySelectorAll('.card')) {
      const h=card.querySelector('.card-head, h3')?.textContent?.trim();
      const svg=card.querySelector('svg.chart, svg');
      if(!h||!svg) continue;
      const holder=svg.closest('.chart-scroll')||card;
      const cw=holder.getBoundingClientRect().width
        - (holder===card ? 32 : 0);
      out[h.split('\\n')[0].trim()] =
        Math.round(svg.getBoundingClientRect().width/cw*100);
    }
    return out;})()`);

  for (const [name, pct] of Object.entries(others)) {
    ck(`"${name}" fills its card`, pct >= 90, `${pct}%`);
  }

  /* ---------- zoom ---------- */

  console.log('\n--- zoom ---');

  const measure = () => ev(`(()=>{
    const svg=document.querySelector('[aria-label="Completion calendar"]');
    const r=svg.querySelector('rect');
    const dated=[...svg.querySelectorAll('rect')].filter(x=>x.dataset.date);
    const dates=dated.map(x=>x.dataset.date).sort();
    const btns=[...document.querySelectorAll('.cal-nav button')];
    return {
      cell: Math.round(r.getBoundingClientRect().width),
      columns: Math.round(parseFloat(svg.getAttribute('width'))),
      span: dates.length,
      first: dates[0], last: dates.at(-1),
      zoomIn: btns.find(b=>b.textContent.trim()==='+')?.disabled,
      zoomOut: btns.find(b=>b.textContent.trim()==='−')?.disabled,
    };})()`);

  const atDefault = await measure();
  ck('the zoom buttons are present',
    atDefault.zoomIn !== undefined && atDefault.zoomOut !== undefined,
    JSON.stringify({ inDisabled: atDefault.zoomIn, outDisabled: atDefault.zoomOut }));

  const click = async (label) => {
    await ev(`[...document.querySelectorAll('.cal-nav button')]
      .find(b=>b.textContent.trim()===${JSON.stringify(label)})?.click()`);
    await sleep(450);
  };

  // Zoom in one step: bigger squares, less history.
  await click('+');
  const zoomedIn = await measure();

  ck('zooming in makes the squares bigger',
    zoomedIn.cell > atDefault.cell, `${atDefault.cell}px -> ${zoomedIn.cell}px`);
  ck('zooming in shows less history',
    zoomedIn.span < atDefault.span, `${atDefault.span} days -> ${zoomedIn.span} days`);
  ck('today is still visible after zooming in',
    zoomedIn.last >= cal.todayISO, `last=${zoomedIn.last}`);

  // One more step reaches the closest level, where + must disable.
  await click('+');
  const closest = await measure();
  ck('there is a level closer than "close"',
    closest.cell > zoomedIn.cell, `${zoomedIn.cell}px -> ${closest.cell}px`);
  ck('the zoom-in button disables at the closest level',
    closest.zoomIn === true, `disabled=${closest.zoomIn}`);
  ck('today is still visible at the closest zoom',
    closest.last >= cal.todayISO, `last=${closest.last}`);

  // Zoom all the way back out.
  await click('−'); await click('−'); await click('−');
  const zoomedOut = await measure();

  ck('zooming out makes the squares smaller',
    zoomedOut.cell < atDefault.cell, `${atDefault.cell}px -> ${zoomedOut.cell}px`);
  ck('zooming out shows more history',
    zoomedOut.span > atDefault.span, `${atDefault.span} days -> ${zoomedOut.span} days`);
  ck('today is still visible after zooming out',
    zoomedOut.last >= cal.todayISO, `last=${zoomedOut.last}`);
  ck('the zoom-out button disables at the widest level',
    zoomedOut.zoomOut === true, `disabled=${zoomedOut.zoomOut}`);

  /* ---------- the page does not jump to the top ---------- */

  console.log('\n--- scroll position ---');

  // Every control in the detail view re-renders it, and replaceChildren()
  // collapses the page height, which scrolls the window back to the top.
  // Pressing a button should leave you looking at the button you pressed.
  const scrollTo = await ev(`(()=>{
    const cal=document.querySelector('[aria-label="Completion calendar"]');
    const y=Math.round(cal.getBoundingClientRect().top + window.scrollY - 80);
    window.scrollTo(0, y);
    return Math.round(window.scrollY);})()`);
  await sleep(300);

  ck('the page can scroll down to the calendar', scrollTo > 100, `y=${scrollTo}`);

  for (const [label, sel] of [
    // '+' not '−': the calendar is at the widest level here, so '−' is
    // disabled and clicking it would prove nothing.
    ['zoom', `[...document.querySelectorAll('.cal-nav button')].find(b=>b.textContent.trim()==='+')`],
    ['calendar paging', `[...document.querySelectorAll('.cal-nav button')].find(b=>b.textContent.includes('Earlier'))`],
    ['history granularity', `[...document.querySelectorAll('.card button')].find(b=>b.textContent.trim()==='week')`],
  ]) {
    const before = await ev(`Math.round(window.scrollY)`);
    await ev(`${sel}?.click()`);
    await sleep(600);
    const after = await ev(`Math.round(window.scrollY)`);
    ck(`${label} keeps the scroll position`, Math.abs(after - before) < 120,
      `${before} -> ${after}`);
  }

  // Put the zoom back where the persistence checks below expect it.
  await click('−');

  // Opening a habit fresh should still start at the top, like any new page.
  await ev(`document.querySelector('.detail-head button')?.click()`);
  await sleep(500);
  await ev(`window.scrollTo(0, 400)`);
  await sleep(200);
  await ev(`document.querySelector('.habit-row .habit-name, .habit-row .name')?.click()`);
  await sleep(700);
  const onOpen = await ev(`Math.round(window.scrollY)`);
  ck('opening a habit starts at the top', onOpen < 60, `y=${onOpen}`);

  /* ---------- the zoom choice persists ---------- */

  console.log('\n--- persistence ---');

  const saved = await ev(`fetch('/api/settings',{credentials:'same-origin'})
    .then(r=>r.json()).then(s=>s.calendarZoom)`);
  ck('the zoom level was saved to the server', saved === 'wide', String(saved));

  await send('Page.navigate', { url: APP }, sessionId);
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
    await sleep(250);
  }
  await sleep(500);
  await ev(`document.querySelector('.habit-row .habit-name, .habit-row .name')?.click()`);
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!document.querySelector('[aria-label="Completion calendar"]')`).catch(() => 0)) break;
    await sleep(250);
  }
  await sleep(400);
  const afterReload = await measure();

  ck('the zoom level survives a reload',
    afterReload.cell === zoomedOut.cell && afterReload.span === zoomedOut.span,
    `cell=${afterReload.cell}px span=${afterReload.span}`);
  ck('today is visible after a reload',
    afterReload.last >= cal.todayISO, `last=${afterReload.last}`);

  // Leave the account as it was found.
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({calendarZoom:'default'})}).then(r=>r.ok)`);

} catch (err) {
  console.log('FAIL  harness error :: ' + err.message);
  fails++;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fails === 0 ? 'all calendar checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
