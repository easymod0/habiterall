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
import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor, waitUntil,
} from './chrome.mjs';

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
  await send('Page.navigate', { url: APP }, sessionId); // navigate-unjoined: a bare sleep follows, with no predicate to join
  await sleep(800);
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({calendarZoom:'default'})}).then(r=>r.ok)`);
  await ev(`localStorage.removeItem('habiterall-settings')`).catch(() => {});
  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate', { url: APP }, sessionId),
    what: 'the dashboard',
  });
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
    // The calendar's own ‹ Earlier used to be checked here too, scoped to the
    // Calendar card for exactly the reason 'history granularity' below is
    // scoped to History: `.cal-nav` is `windowedChart`'s class and the Recent
    // days strip — FIRST on the page — pages through the same component, so
    // an unscoped `find('Earlier')` would reach the strip's button instead.
    // It no longer belongs in a loop whose label is "re-renders the detail
    // view": after #274 the calendar's ‹ Earlier redraws itself locally, the
    // same shape #245 gave the strip, so a press that correctly leaves the
    // rest of the page alone would fail a check asserting the opposite. Its
    // own coverage is the "paging redraws the card" block below, which reads
    // the range readout and `state.calEnd` instead of a re-render marker.
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

  /* ---------- paging redraws the card (#274) ---------- */

  console.log('\n--- paging redraws the card ---');
  // Scoped to the Calendar card BY TITLE, never a bare `.cal-nav` / `.cal-range`
  // query: `windowedChart` gives Recent days' own nav and range readout the
  // same two class names (`shared/public/CLAUDE.md`), and Recent days sits
  // FIRST on the page — an unscoped selector would press and read the strip's
  // controls instead. Modelled on the `['calendar paging', …]` selector
  // deleted from the re-render loop above.
  const calCardSel = `[...document.querySelectorAll('#view-detail .card')]
    .find(c=>c.querySelector('.card-title')?.textContent==='Calendar')`;
  const calRange = () => ev(`(() => {
    const c = ${calCardSel};
    return c?.querySelector('.cal-range')?.textContent ?? '';})()`);
  const calNav = (text) => ev(`(() => {
    const c = ${calCardSel};
    const b = [...(c?.querySelectorAll('.cal-nav button') ?? [])]
      .find(b => b.textContent.includes(${JSON.stringify(text)}));
    if (!b || b.disabled) return false;
    b.click(); return true;})()`);
  const calEndState = () =>
    ev(`(async () => (await import('/shared/ui/store.js')).state.calEnd ?? null)()`);
  // The page's own notion of today, read the same way `calEndState` reads
  // `state.calEnd` — used only to guard the online/offline comparison below
  // against a run that crosses local midnight in the gap between the two
  // presses, not to derive any of the values being compared.
  const pageTodayISO = () =>
    ev(`(async () => (await import('/shared/ui/dates.js')).todayISO())()`);
  const calSvgCount = () => ev(`(() => {
    const c = ${calCardSel};
    return c ? c.querySelectorAll('[aria-label="Completion calendar"]').length : 0;})()`);
  const legendCount = () => ev(`(() => {
    const c = ${calCardSel};
    return c ? c.querySelectorAll('.legend').length : 0;})()`);

  // Bounded rather than `waitUntil`, at the same 20s ceiling and for the exact
  // reason given above the re-render loop's own bounded poll: a throw here
  // would leave the try block and take the rest of the suite with it, so a
  // regression in ONE of these five presses would cost the other four their
  // own named failure and the persistence checks their run entirely —
  // mutation-tested below, where `shift` and `Today` reverted to `open()` each
  // surfaced as `FAIL harness error :: timed out …` before this existed. Every
  // caller compares an ABSOLUTE value afterwards (`onlineAfter !==
  // onlineBefore`, `offlineAfterEarlier === onlineAfter`, `calEnd === null`),
  // so a poll that times out just leaves the readout unchanged and that
  // comparison fails BY NAME — the ceiling is judged, not merely spent.
  const settled = async (expr, ms = 20_000) => {
    for (let i = 0; i < Math.ceil(ms / 50); i++) {
      if (await ev(expr).catch(() => false)) return true;
      await sleep(50);
    }
    return false;
  };

  // A full navigation, not the in-app back button: `state.calEnd` is cleared
  // by neither reopening the same habit nor a different one (nothing on the
  // dashboard->reopen path touches it, which is why #274 outlasted #245), so
  // only a fresh document is guaranteed to start with it unset.
  const openFirstHabit = async () => {
    await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
      reload: () => send('Page.navigate', { url: APP }, sessionId),
      what: 'the dashboard grid',
    });
    await sleep(500);
    await ev(`document.querySelector('.habit-row .habit-name, .habit-row .name')?.click()`);
    await waitUntil(ev, `!!document.querySelector('[aria-label="Completion calendar"]')`,
      { what: 'the calendar card' });
    await sleep(400);
  };

  /* ----- the reference press, online ----- */

  const todayAtOnlinePress = await pageTodayISO();
  const onlineBefore = await calRange();
  ck('the calendar has a range readout', onlineBefore !== '', onlineBefore);

  const pressedOnline = await calNav('Earlier');
  await settled(
    `(${calCardSel})?.querySelector('.cal-range')?.textContent !== ${JSON.stringify(onlineBefore)}`);
  const onlineAfter = await calRange();
  const onlineCalEnd = await calEndState();
  const onlineSvgCount = await calSvgCount();
  const onlineLegendCount = await legendCount();

  ck('the online ‹ Earlier press was made at all', pressedOnline === true);
  ck('‹ Earlier moves the range readout', onlineAfter !== onlineBefore,
    `${onlineBefore} -> ${onlineAfter}`);
  ck('...and stores a non-null calEnd', onlineCalEnd !== null, String(onlineCalEnd));
  // Catches a `draw()` that appends its new pair without removing the old one.
  ck('...and leaves exactly one calendar and one legend',
    onlineSvgCount === 1 && onlineLegendCount === 1,
    `svg=${onlineSvgCount} legend=${onlineLegendCount}`);

  /* ----- the scroll does not move ----- */

  // A local redraw collapses no page height, so this is stronger than the
  // restore-within-tolerance check the re-render loop above asserts.
  // `scrollToCalendar` is the one declared above, for the "scroll position"
  // section — the calendar's `[aria-label="Completion calendar"]` is unique on
  // the page, so it needs no card-title scoping of its own.
  const scrollBefore = await scrollToCalendar();
  await sleep(300);
  const rangeBeforeScrollPress = await calRange();
  const pressedForScroll = await calNav('Earlier');
  await settled(
    `(${calCardSel})?.querySelector('.cal-range')?.textContent !== `
    + `${JSON.stringify(rangeBeforeScrollPress)}`);
  const scrollAfter = await ev(`Math.round(window.scrollY)`);
  ck('paging the calendar does not move the scroll position',
    pressedForScroll === true && scrollAfter === scrollBefore,
    `${scrollBefore} -> ${scrollAfter}`);

  /* ----- offline ----- */

  console.log('--- calendar paging, offline ---');
  // A fresh document, so this run's own presses above are not still sitting in
  // `state.calEnd` when the network goes down.
  await openFirstHabit();
  // `onlineAfter` / `onlineCalEnd` above and `offlineAfterEarlier` /
  // `offlineCalEndAfterEarlier` below are compared for equality further down,
  // but they are derived from `todayISO()` calls on either side of a full
  // `Page.navigate` — a run that crosses local midnight in that gap would
  // fail both conjuncts and print four dates naming nothing. This says so by
  // name instead of leaving that comparison to fail as if it were a
  // regression.
  const todayAfterNav = await pageTodayISO();
  ck('the run did not cross local midnight between the online and offline presses',
    todayAfterNav === todayAtOnlinePress, `${todayAtOnlinePress} -> ${todayAfterNav}`);
  const offlineAtNow = await calRange();
  ck('the calendar starts at today on a fresh document', offlineAtNow !== '', offlineAtNow);

  await send('Network.enable', {}, sessionId);
  // `Network.setBypassServiceWorker` is load-bearing, for the reason
  // stripcheck.mjs's own offline block records having measured: devtools
  // network emulation does not reach the WORKER's own fetches, so with the
  // worker in front `open()`'s two GETs answer out of `DATA_CACHE`
  // (`CACHEABLE_API`, sw.js), `open()` succeeds, and every check below would
  // pass against the unfixed code.
  await send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
  await send('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);

  const pressedOffline = await calNav('Earlier');
  await settled(
    `(${calCardSel})?.querySelector('.cal-range')?.textContent !== ${JSON.stringify(offlineAtNow)}`);
  const offlineAfterEarlier = await calRange();
  const offlineCalEndAfterEarlier = await calEndState();

  ck('the offline ‹ Earlier press was made at all', pressedOffline === true);
  // Absolute conjuncts, not "different from before" alone: a comparison
  // against the reference press alone is satisfied by two windows that both
  // stayed put.
  ck('offline, ‹ Earlier moves the range and lands on the same page the '
    + 'online press landed on, with the same calEnd',
    offlineAfterEarlier !== offlineAtNow && offlineAfterEarlier === onlineAfter
      && offlineCalEndAfterEarlier === onlineCalEnd,
    `range ${offlineAtNow} -> ${offlineAfterEarlier} (online ${onlineAfter}), `
    + `calEnd ${offlineCalEndAfterEarlier} (online ${onlineCalEnd})`);

  const pressedToday = await calNav('Today');
  await settled(
    `(${calCardSel})?.querySelector('.cal-range')?.textContent !== `
    + `${JSON.stringify(offlineAfterEarlier)}`);
  const offlineAfterToday = await calRange();
  const offlineCalEndAfterToday = await calEndState();

  ck('the offline Today press was made at all', pressedToday === true);
  ck('offline, Today returns to the at-now readout and clears calEnd',
    offlineAfterToday === offlineAtNow && offlineCalEndAfterToday === null,
    `range ${offlineAfterToday} (expected ${offlineAtNow}), calEnd ${offlineCalEndAfterToday}`);

  await send('Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
  await send('Network.setBypassServiceWorker', { bypass: false }, sessionId);
  await sleep(500);

  /* ---------- the zoom choice persists ---------- */

  console.log('\n--- persistence ---');

  const saved = await ev(`fetch('/api/settings',{credentials:'same-origin'})
    .then(r=>r.json()).then(s=>s.calendarZoom)`);
  ck('the zoom level was saved to the server', saved === 'wide', String(saved));

  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate', { url: APP }, sessionId),
    what: 'the dashboard',
  });
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

  /* ---------- reopening a habit resets the paged position (#274) ---------- */

  // Placed here rather than beside the "paging redraws the card" block above:
  // it must not disturb the persistence checks just run (which assert the
  // zoom was left at 'wide' and reload to prove it) or the restoring PUT
  // below. It runs at whatever zoom the persistence block left the page on —
  // 'wide', per the check just above — which the in-page-redraw check further
  // down verifies rather than assumes.
  console.log('\n--- reopening a habit resets calEnd ---');

  // `.detail-head button` (as used at `:385`) plus a fresh row click — the
  // in-app path, not `openFirstHabit`'s `Page.navigate`, because a full
  // navigation would reset `state.calEnd` for a reason that has nothing to do
  // with `!redraw` and prove nothing about it.
  const backToDashboard = async () => {
    await ev(`document.querySelector('.detail-head button')?.click()`);
    await waitUntil(ev, `!!document.querySelector('#grid .habit-row')`,
      { what: 'the dashboard grid' });
    await sleep(400);
  };
  // Opens by INDEX rather than by name: the fixtures give four habits
  // (Meditate, Gym, Read, No late-night snacks — fixtures.mjs), and index 1
  // (Gym) only has to be "a different habit from index 0", not any specific
  // one.
  const openHabitByIndex = async (i) => {
    await ev(`[...document.querySelectorAll('.habit-row .habit-name, .habit-row .name')]
      [${i}]?.click()`);
    await waitUntil(ev, `!!document.querySelector('[aria-label="Completion calendar"]')`,
      { what: 'the calendar card' });
    await sleep(400);
  };

  // The reload just above left habit 1 open on a brand new document, so
  // `state.calEnd` is null there and this is the at-now readout every check
  // below compares against — captured once rather than re-derived per check,
  // which is what keeps a local-midnight crossing from producing three
  // different "at-now" strings that quietly still agree with each other.
  const atNowReadout = await calRange();
  ck('the calendar has a range readout to compare against',
    atNowReadout !== '', atNowReadout);
  const freshCalEnd = await calEndState();
  ck('...and calEnd is null on this freshly reloaded page',
    freshCalEnd === null, String(freshCalEnd));

  /* ----- 1: opening a DIFFERENT habit resets calEnd — the case Mark called not in question ----- */

  const pagedHabit1 = await calNav('Earlier');
  await settled(
    `(${calCardSel})?.querySelector('.cal-range')?.textContent !== ${JSON.stringify(atNowReadout)}`);
  const habit1PagedEnd = await calEndState();
  const habit1PagedRange = await calRange();
  ck('paging habit 1 sets a non-null calEnd',
    pagedHabit1 === true && habit1PagedEnd !== null,
    `pressed=${pagedHabit1} calEnd=${habit1PagedEnd}`);
  ck('...and moves the range off the at-now readout',
    habit1PagedRange !== atNowReadout, `${atNowReadout} -> ${habit1PagedRange}`);

  await backToDashboard();
  await openHabitByIndex(1); // a different habit (Gym)
  const crossHabitCalEnd = await calEndState();
  const crossHabitRange = await calRange();
  ck('opening a DIFFERENT habit resets calEnd to null',
    crossHabitCalEnd === null, String(crossHabitCalEnd));
  ck("...and habit 2 opens at the at-now readout, not habit 1's paged window",
    crossHabitRange === atNowReadout,
    `${crossHabitRange} (expected ${atNowReadout}; habit 1 was showing ${habit1PagedRange})`);

  /* ----- 2: reopening the SAME habit ALSO resets calEnd — the decision, not the bug ----- */

  await backToDashboard();
  await openHabitByIndex(0); // habit 1 again
  const pagedAgain = await calNav('Earlier');
  await settled(
    `(${calCardSel})?.querySelector('.cal-range')?.textContent !== ${JSON.stringify(atNowReadout)}`);
  const habit1PagedEnd2 = await calEndState();
  ck('paging habit 1 (again) sets a non-null calEnd',
    pagedAgain === true && habit1PagedEnd2 !== null,
    `pressed=${pagedAgain} calEnd=${habit1PagedEnd2}`);

  await backToDashboard();
  // Reopen the SAME habit: `dashboard.paint()` nulls `state.openHabitId` on
  // the way back, so `open()`'s `redraw` reads false here exactly as it does
  // for a different habit — this is the half the "cross-habit" check above
  // cannot exercise, and it must be its own named check.
  await openHabitByIndex(0);
  const sameHabitCalEnd = await calEndState();
  const sameHabitRange = await calRange();
  ck('reopening the SAME habit resets calEnd to null too',
    sameHabitCalEnd === null, String(sameHabitCalEnd));
  ck('...and it opens at the at-now readout',
    sameHabitRange === atNowReadout, `${sameHabitRange} (expected ${atNowReadout})`);

  /* ----- 3: an in-page redraw (a zoom press) KEEPS the position ----- */

  const pagedForZoom = await calNav('Earlier');
  await settled(
    `(${calCardSel})?.querySelector('.cal-range')?.textContent !== ${JSON.stringify(atNowReadout)}`);
  const beforeZoomCalEnd = await calEndState();
  ck('paging before the redraw check sets a non-null calEnd',
    pagedForZoom === true && beforeZoomCalEnd !== null,
    `pressed=${pagedForZoom} calEnd=${beforeZoomCalEnd}`);

  // Verify which zoom direction is live rather than assume '+': the suite
  // leaves the calendar at 'wide' by the time this block runs (the
  // persistence check just above confirms it), where zooming further OUT is
  // already disabled.
  const zoomBefore = await measure();
  ck('exactly one zoom direction is live before the redraw check',
    zoomBefore.zoomIn !== zoomBefore.zoomOut, JSON.stringify(zoomBefore));
  const liveZoomLabel = zoomBefore.zoomIn ? '−' : '+';

  const zoomPressed = await calNav(liveZoomLabel);
  // A zoom press is `redraw === true` (same habit) and legitimately changes
  // `CAL_WEEKS`, so settle on the cell size moving rather than on the range
  // readout — asserting the readout stayed put would be asserting the zoom
  // did nothing, not that the position survived it.
  await settled(`(()=>{
    const svg=document.querySelector('[aria-label="Completion calendar"]');
    const r=[...svg.querySelectorAll('rect')].find(x=>x.dataset.date) ?? svg.querySelector('rect');
    return Math.round(r.getBoundingClientRect().width) !== ${zoomBefore.cell};})()`);
  const afterZoomCalEnd = await calEndState();
  ck('an in-page redraw (a zoom press) keeps the paged position instead of resetting it',
    zoomPressed === true && afterZoomCalEnd === beforeZoomCalEnd && afterZoomCalEnd !== null,
    `calEnd ${beforeZoomCalEnd} -> ${afterZoomCalEnd}`);

  // This press moves the stored zoom off 'wide'; the restoring PUT just below
  // sets `calendarZoom` back to 'default' regardless, so nothing here needs
  // its own cleanup.

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
