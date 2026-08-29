/**
 * Calendar: today must be visible, and the zoom controls must work.
 *
 * The missing-today bug was pure date arithmetic, and calendar.test.js pins
 * that. This checks the thing a unit test cannot: that the square is actually
 * drawn, in the DOM, on the page the user sees — the same reason the CSS
 * `hidden` regression needed a real browser.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000', PORT = devtoolsPort(9294);
const profile = mkdtempSync(join(tmpdir(), 'habcal-'));
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
    const dated=[...svg.querySelectorAll('rect')].filter(x=>x.dataset.date);
    // A dated cell, not svg.querySelector('rect'): hovering moves the active
    // cell to the end of its parent, so "the first rect" is not reliably a
    // calendar square once anything has been hovered.
    const r=dated[0] ?? svg.querySelector('rect');
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
  const scrollToCalendar = () => ev(`(()=>{
    const cal=document.querySelector('[aria-label="Completion calendar"]');
    const y=Math.round(cal.getBoundingClientRect().top + window.scrollY - 80);
    window.scrollTo(0, y);
    return Math.round(window.scrollY);})()`);

  const scrollTo = await scrollToCalendar();
  await sleep(300);

  ck('the page can scroll down to the calendar', scrollTo > 100, `y=${scrollTo}`);

  // Which value a card's granularity control is showing, scoped to that card by
  // title. Both the History and the Habit strength cards render
  // `segmented(['day','week','month','quarter','year'], …)`, so the pressed
  // option names that card's own state and no other's — which is what lets the
  // two checks after the loop say WHICH card the third selector reached, rather
  // than trusting that the selector reached the one its label claims.
  const GRAN = "['day','week','month','quarter','year']";
  const pressedGran = (title) => ev(`(()=>{
    const c=[...document.querySelectorAll('#view-detail .card')]
      .find(c=>c.querySelector('.card-title')?.textContent==='${title}');
    const b=[...(c?.querySelectorAll('.seg button') ?? [])]
      .find(b=>b.getAttribute('aria-pressed')==='true'
        && ${GRAN}.includes(b.textContent.trim()));
    return b?.textContent.trim() ?? null;})()`);

  const granBefore = await pressedGran('History');
  const scoreBefore = await pressedGran('Habit strength');

  // Two of these three are scoped to their card BY TITLE, and the reason is
  // that a detail card's controls are not unique on the page — `DETAIL_CARDS`
  // (`shared/src/validate.js`) draws `recentDays, strength, calendar, streaks,
  // resilience, awards, history, …`, all on by default, and this suite never
  // touches `detailCards`. Position is not the scoping rule either: matching by
  // title survives a reorder, which a `[n]` index does not.
  for (const [label, sel] of [
    // '+' not '−': the calendar is at the widest level here, so '−' is
    // disabled and clicking it would prove nothing. Genuinely unambiguous —
    // `git grep "'+'"` under `shared/public` hits only the calendar's `zoomIn`.
    ['zoom', `[...document.querySelectorAll('.cal-nav button')].find(b=>b.textContent.trim()==='+')`],
    // Scoped to the CALENDAR card. `.cal-nav` is `windowedChart`'s class and
    // the Recent days strip pages through the same component, so an unscoped
    // `find('Earlier')` picks the STRIP's button — that card is FIRST on the
    // page and the calendar is THIRD, with `strength` between them. 'Earlier'
    // was never unambiguous, and this only ever pressed the calendar's by
    // accident of what the strip's did. It stopped being an accident that
    // worked when the strip started redrawing itself instead of refetching the
    // whole page (#245): the marked calendar node then survives the press and
    // this check reports the wrong card. Same rule as the `.cal-range` note in
    // `shared/public/CLAUDE.md`.
    ['calendar paging', `[...(([...document.querySelectorAll('#view-detail .card')]
      .find(c=>c.querySelector('.card-title')?.textContent==='Calendar')
      ?.querySelectorAll('.cal-nav button')) ?? [])]
      .find(b=>b.textContent.includes('Earlier'))`],
    // Scoped to the HISTORY card for exactly the same reason, and this one had
    // the same defect for as long as it has existed: `buildStrengthCard` puts
    // `segmented(['day','week','month','quarter','year'], …)` in its own
    // `.card-head` and sits SECOND, so the first `.card button` reading 'week'
    // in document order was the strength card's score-resolution button. It
    // stayed green because that card's `onChange` is also
    // `state.scoreGranularity = g; open(habit.id)` — a full re-render, which is
    // all this loop measures — so `buildHistoryCard`'s granularity control had
    // no coverage here at all.
    //
    // 'month' rather than 'week' on purpose: History OPENS on 'week'
    // (`historyGranularity`'s default in ui/settings.js), and re-pressing the
    // option that is already pressed asserts nothing about which control was
    // reached. 'month' moves `state.granularity`, which is what the two checks
    // after the loop read back — and it is unique inside this card, whose other
    // segmented control offers 'percent' and 'count'.
    ['history granularity', `[...(([...document.querySelectorAll('#view-detail .card')]
      .find(c=>c.querySelector('.card-title')?.textContent==='History')
      ?.querySelectorAll('.seg button')) ?? [])]
      .find(b=>b.textContent.trim()==='month')`],
  ]) {
    // Scroll back down FIRST, so each control is judged on its own. Reading
    // `before` from wherever the last iteration left the page made the second
    // and third vacuous the moment the first failed: at 0, `0 -> 0` passes.
    // Mutation-tested — with the restore in detail.js removed, all three fail
    // now where only the first did.
    const before = await scrollToCalendar();
    // Stamp a node so the re-render can be SEEN rather than waited out:
    // `replaceChildren()` drops it, so its absence is the rebuild having
    // happened. Without this, polling for a settled scroll can return before
    // the collapse even starts and pass against an app that never restores.
    await ev(`(()=>{document.querySelector('[aria-label="Completion calendar"]')
      ?.setAttribute('data-rerender','1'); return true;})()`);
    await ev(`${sel}?.click()`);
    // Bounded rather than `waitUntil`, at the same 20s ceiling: a throw here is
    // caught, but it leaves the loop, so a control whose re-render regresses
    // would take the other two controls' coverage and the persistence checks
    // with it — the three used to be judged independently, however weakly, by
    // the flat sleep this replaced. Mutation-tested: with `open()` dropped from
    // `changeZoom`, the throw stopped the suite at `zoom` and the paging,
    // granularity and persistence checks — one of which catches that same
    // regression by name — never ran.
    //
    // The ceiling is then JUDGED rather than merely spent, because spending it
    // in silence is worse than the sleep was: a view that never rebuilds never
    // moves the scroll either, so `534 -> 534` below passes for the one reason
    // that should fail it. This is the check that the marker was stamped for.
    let rerendered = false;
    for (let i = 0; i < 400; i++) {
      if (await ev(`!document.querySelector('[data-rerender="1"]')`)
        .catch(() => false)) { rerendered = true; break; }
      await sleep(50);
    }
    ck(`${label} re-renders the detail view`, rerendered,
      rerendered ? '' : 'the marked node survived 20s');

    // Wait for the restore, BOUNDED — and let the assertion below judge it.
    //
    // There is no predicate that separates "the restore has not happened yet"
    // from "this build never restores", so anything cleverer is either vacuous
    // or flaky, and both were tried: a plain stability poll reported `534 -> 0`
    // because scrollY sits at 0 and is perfectly stable between the collapse
    // and the rebuild, and gating on the page being tall enough first fixed
    // `zoom` and left `calendar paging` failing the same way.
    //
    // So the claim this makes is "restored within the ceiling". A build that
    // never restores spends the ceiling and then fails on the position it
    // actually settled at, which is the same failure the 600ms sleep gave and
    // the same message. What it buys is that a restore taking 700ms under load
    // is no longer a failure — the flake at sixteen workers — and that the NEXT
    // iteration reads its `before` after this one has settled, which is where
    // the cascading `0 -> 534` came from.
    for (let i = 0; i < 60; i++) {
      if (Math.abs(await ev(`Math.round(window.scrollY)`) - before) < 120) break;
      await sleep(50);
    }
    const after = await ev(`Math.round(window.scrollY)`);
    ck(`${label} keeps the scroll position`, Math.abs(after - before) < 120,
      `${before} -> ${after}`);
  }

  // What proves the third selector is scoped rather than merely written as
  // though it were. The unscoped version pressed the Habit strength card, which
  // moves `scoreGranularity` and leaves History exactly where it opened — so
  // against it the first of these is red and the second is red too, and between
  // them they NAME the card that was reached. `granBefore !== 'month'` is there
  // so the first cannot pass by History having already been on 'month':
  // `fixtures.reset()` sends `DELETE /settings`, so it opens on 'week'.
  const granAfter = await pressedGran('History');
  const scoreAfter = await pressedGran('Habit strength');
  ck('the granularity press reached the History card',
    granAfter === 'month' && granBefore !== 'month',
    `History ${granBefore} -> ${granAfter}`);
  ck('...and left the Habit strength card above it alone',
    scoreAfter === scoreBefore, `strength ${scoreBefore} -> ${scoreAfter}`);

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
  await closeChrome({ chrome, port: PORT, profile });
}

console.log(`\n${fails === 0 ? 'all calendar checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
