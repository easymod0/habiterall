import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor, waitUntil } from './chrome.mjs';
const APP=process.env.BASE??'http://localhost:3000', PORT = devtoolsPort(9290);
const profile=mkdtempSync(join(tmpdir(),'habgrid-'));
const chrome=launchChrome(PORT, profile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const ck=(l,c,e='')=>{console.log((c?'PASS':'FAIL')+'  '+l+(e?' :: '+e:''));if(!c)fails++;};
let ws,nid=1;const pend=new Map();
const send=(m,p={},s)=>new Promise((res,rej)=>{const id=nid++;pend.set(id,{res,rej});
 ws.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});
try{
  const url = await devtoolsUrl(PORT, chrome);
  ws=new globalThis.WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);
    if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};
  const{targetId}=await send('Target.createTarget',{url:'about:blank'});
  const{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true},sessionId);
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description);return r.result.value;};
  await send('Page.enable',{},sessionId); await send('Network.enable',{},sessionId);

  for (const [label,w,h] of [['desktop',1440,900],['phone',390,844]]) {
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:w<500},sessionId);
    await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
      reload: () => send('Page.navigate',{url:APP},sessionId),
      what: 'the dashboard',
    });
    await sleep(600);
    console.log(`\n--- ${label} (${w}px) ---`);

    const r = await ev(`(()=>{
      const head=document.getElementById('grid-head');
      const dates=[...document.querySelectorAll('.grid-date')];
      const checks=[...document.querySelectorAll('.habit-row:first-child .check')];
      const cx=el=>{const b=el.getBoundingClientRect();return Math.round(b.left+b.width/2);};
      return {
        headerVisible: head && !head.hidden,
        range: document.querySelector('.grid-range')?.textContent,
        dateCols: dates.length,
        checkCols: checks.length,
        dateCentres: dates.map(cx),
        checkCentres: checks.map(cx),
        todayInHeader: dates.filter(d=>d.classList.contains('is-today')).length,
        todayInRow: document.querySelectorAll('.habit-row:first-child .check.today').length,
        navButtons: [...document.querySelectorAll('.grid-nav button')].map(b=>b.textContent.trim()),
        nextDisabled: [...document.querySelectorAll('.grid-nav button')].find(b=>b.getAttribute('aria-label')?.startsWith('Next'))?.disabled,
      };})()`);

    ck(`${label}: header visible`, r.headerVisible===true);
    ck(`${label}: range label present`, !!r.range, r.range);
    ck(`${label}: one date column per checkbox`, r.dateCols===r.checkCols, `${r.dateCols} vs ${r.checkCols}`);
    const maxOff = Math.max(...r.dateCentres.map((c,i)=>Math.abs(c-r.checkCentres[i])));
    ck(`${label}: columns aligned (max offset ${maxOff}px)`, maxOff<=2, `offsets ok`);
    ck(`${label}: today marked in header`, r.todayInHeader===1, String(r.todayInHeader));
    ck(`${label}: today marked in the row`, r.todayInRow===1, String(r.todayInRow));
    ck(`${label}: next disabled at today`, r.nextDisabled===true, String(r.nextDisabled));
  }

  // --- arrows must not move when Today appears ---
  console.log('--- arrow stability ---');
  const arrowX = () => ev(`(()=>{
    const b=[...document.querySelectorAll('.grid-nav button')]
      .find(b=>b.getAttribute('aria-label')?.startsWith('Previous'));
    return b ? Math.round(b.getBoundingClientRect().left) : null;})()`);
  const beforeX = await arrowX();
  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b=>b.getAttribute('aria-label')?.startsWith('Previous')).click()`);
  await sleep(900);
  const afterX = await arrowX();
  ck('the back arrow stays put when Today appears', beforeX === afterX,
     `${beforeX}px -> ${afterX}px`);
  ck('Today is now clickable',
     await ev(`(()=>{const b=[...document.querySelectorAll('.grid-nav button')]
       .find(b=>b.textContent.trim()==='Today');
       return !!b && !b.disabled && getComputedStyle(b).visibility==='visible';})()`) === true);
  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b=>b.textContent.trim()==='Today').click()`);
  await sleep(900);
  ck('and the arrow is still in the same place after returning',
     await arrowX() === beforeX, `${await arrowX()}px`);

  // --- alignment in the reversed order too ---
  console.log('--- reversed day order ---');
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({dayOrder:'newest-left'})})`);
  await sleep(400);
  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate',{url:APP},sessionId),
    what: 'the dashboard',
  });
  await sleep(600);
  const rev = await ev(`(()=>{const cx=el=>{const b=el.getBoundingClientRect();return b.left+b.width/2;};
    const d=[...document.querySelectorAll('.grid-date')].map(cx);
    const c=[...document.querySelectorAll('.habit-row:first-child .check')].map(cx);
    return {max:Math.round(Math.max(...d.map((v,i)=>Math.abs(v-c[i])))),
            todayFirst:document.querySelector('.grid-date').classList.contains('is-today')};})()`);
  ck('reversed: columns still aligned', rev.max<=2, `${rev.max}px`);
  ck('reversed: today is the first column', rev.todayFirst===true);
  await ev(`fetch('/api/settings',{method:'DELETE',credentials:'same-origin'})`);
  await sleep(300);

  // --- navigation ---
  console.log('\n--- navigation ---');
  const before = await ev(`document.querySelector('.grid-range').textContent`);
  await ev(`[...document.querySelectorAll('.grid-nav button')].find(b=>b.getAttribute('aria-label')?.startsWith('Previous')).click()`);
  await sleep(500);
  const after = await ev(`document.querySelector('.grid-range').textContent`);
  ck('back arrow moves the window', before!==after, `${before} -> ${after}`);
  ck('Today button appears once moved',
     await ev(`[...document.querySelectorAll('.grid-nav button')].some(b=>b.textContent.trim()==='Today')`));
  const noToday = await ev(`document.querySelectorAll('.grid-date.is-today').length`);
  ck('no today marker in a past window', noToday===0, String(noToday));

  await ev(`[...document.querySelectorAll('.grid-nav button')].find(b=>b.textContent.trim()==='Today').click()`);
  await sleep(500);
  ck('Today returns to the current window',
     await ev(`document.querySelector('.grid-range').textContent`)===before);
  ck('cannot navigate past today',
     await ev(`[...document.querySelectorAll('.grid-nav button')].find(b=>b.getAttribute('aria-label')?.startsWith('Next')).disabled`)===true);

  // --- keyboard focus survives a repaint ---
  //
  // Every one of these rebuilds the grid with replaceChildren(), which
  // destroys the focused element. Before paint() restored focus by
  // data-focus-key, tabbing to a checkbox and pressing Enter dropped focus to
  // <body> and the next Tab started from the top of the document.
  console.log('\n--- keyboard focus ---');

  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b=>b.getAttribute('aria-label')?.startsWith('Previous')).focus()`);
  await ev(`document.activeElement.click()`);
  await sleep(700);
  ck('focus stays on the paging arrow',
     await ev(`document.activeElement?.dataset?.focusKey`)==='nav:older',
     await ev(`document.activeElement?.dataset?.focusKey ?? document.activeElement?.tagName`));

  // Today disables itself once it has nowhere to jump to, and .focus() on a
  // disabled button is a no-op — so this is the case that needs the fallback
  // to a working neighbour rather than a plain restore.
  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b=>b.textContent.trim()==='Today').focus()`);
  await ev(`document.activeElement.click()`);
  await sleep(700);
  const afterToday = await ev(`({key:document.activeElement?.dataset?.focusKey??null,
                                 tag:document.activeElement?.tagName})`);
  ck('Today hands focus to a working neighbour rather than dropping it',
     afterToday.key!==null && afterToday.tag!=='BODY', JSON.stringify(afterToday));

  // A check-off repaints twice — optimistically, then again after the refetch
  // that brings the new score and streak. Both have to keep focus.
  // `prompt` is stubbed so this works whichever habit type sits in row one; a
  // measurable habit would otherwise block headless Chrome on the dialog.
  await ev(`window.prompt = () => '1'; true`);
  const checkKey = await ev(`(()=>{
    const c=document.querySelector('.habit-row:first-child .check');
    c.focus(); return c.dataset.focusKey;
  })()`);
  ck('checkboxes carry a focus key', !!checkKey, String(checkKey));
  await ev(`document.activeElement.click()`);
  await sleep(1200);
  const afterCheck = await ev(`document.activeElement?.dataset?.focusKey ?? null`);
  ck('focus stays on the checkbox across a check-off',
     afterCheck===checkKey, `${checkKey} -> ${afterCheck}`);

  // --- 3 is an amount for a measurable habit, and a skip only for a yes/no one
  //
  // /overview flattens a skip onto the SKIP wire value so the grid has
  // something paintable, AND lists the date in `skips`. Painting from the
  // value alone made "3 pages" and "3 cigarettes" render as skipped days while
  // the score behind them counted the 3 — the cell disagreeing with every
  // figure computed from it. Only a browser sees what was painted.
  const seeded = await ev(`(async () => {
    const habits = await (await fetch('/api/habits')).json();
    const read = habits.find(h => h.type === 'numerical');
    const yesno = habits.find(h => h.type === 'boolean');
    const d = (n) => {
      const x = new Date(); x.setHours(12,0,0,0); x.setDate(x.getDate() - n);
      return x.getFullYear() + '-' +
             String(x.getMonth()+1).padStart(2,'0') + '-' +
             String(x.getDate()).padStart(2,'0');
    };
    const put = (id, date, body) => fetch('/api/habits/' + id + '/entries/' + date, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await put(read.id, d(1), { value: 3 });         // three pages, genuinely
    await put(read.id, d(2), { status: 'skip' });   // an actual skipped day
    await put(yesno.id, d(3), { status: 'skip' });  // one to clear, offline, below
    return { read: read.id, yesno: yesno.id, amount: d(1), skip: d(2), clearMe: d(3) };
  })()`);

  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate',{url:APP},sessionId),
    what: 'the dashboard',
  });
  await sleep(600);

  const painted = await ev(`(() => {
    const s = ${JSON.stringify(seeded)};
    const box = (habit, date) => {
      const el = document.querySelector('[data-focus-key="check:' + habit + ':' + date + '"] .check-box');
      return el ? (el.textContent || '').trim() : null;
    };
    return { amount: box(s.read, s.amount), skip: box(s.read, s.skip),
             toClear: box(s.yesno, s.clearMe) };
  })()`);

  ck('a measurable 3 paints as the amount, not as a skip',
     painted.amount === '3', JSON.stringify(painted));
  ck('a real skip still paints as one', painted.skip === '–', JSON.stringify(painted));
  ck('a skipped yes/no day paints as one too', painted.toClear === '–',
     JSON.stringify(painted));

  // --- clearing a skip repaints the cell, with no server to ask
  //
  // The optimistic paths edit `habit.entries`; the cell is painted from
  // `habit.skips`. Edit one without the other and the cell keeps asserting the
  // old state until a refetch corrects it — which offline never happens, since
  // `api()` queues the write and throws. Emulating offline is what makes this
  // deterministic: online the refetch hides the bug behind a repaint.
  await send('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);

  await ev(`document.querySelector(
    '[data-focus-key="check:${seeded.yesno}:${seeded.clearMe}"]')?.click()`);
  await sleep(1200);

  const cleared = await ev(`(() => {
    const el = document.querySelector('[data-focus-key="check:${seeded.yesno}:${seeded.clearMe}"] .check-box');
    return el ? (el.textContent || '').trim() : null;
  })()`);
  ck('clearing a skip while offline repaints the cell', cleared === '',
     `cell reads "${cleared}" after the tap`);

  await send('Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);

  /* ---------- the grid is fetched for ONE local day ---------- */

  console.log('\n--- local midnight ---');
  /*
   * The dashboard's version of the detail view's #313 item 5, and it is a
   * different defect with the same cause. This page holds only the fortnight it
   * ASKED the server for, so a tab left open across local midnight is not merely
   * drawn for yesterday — the new day's column is one `/overview` has never been
   * asked about, and `state.gridLoaded` says so. Nothing else in the app cures
   * it: the browser reminder's refresh runs only with the `web` channel on and
   * declines a paged grid, and `'reload'` fires on an offline→online transition
   * or on coming BACK to the list, neither of which is a tab that just stayed
   * here.
   *
   * **The clock is moved with `Emulation.setTimezoneOverride`** — it changes the
   * renderer's zone, so `new Date()`'s local fields move with it, which is
   * exactly what `todayISO()` reads and exactly the question this page renders
   * from (the browser's own calendar day, never a named zone;
   * `docs/decisions/timezones.md`). The two extremes are 26 hours apart, so
   * their calendar dates always differ from each other and at least one differs
   * from this machine's — verified in the page rather than assumed. The second
   * move below goes BACKWARD, which is a flight west and is why the watch
   * compares the date rather than testing that it advanced.
   *
   * **One page load serves both triggers**, unlike `calcheck.mjs`, because the
   * timer probe is installed before the only navigation this block makes. The
   * two halves stay independently pinned: `visibilitychange` is dispatched for
   * the first and never for the second, and the second invokes only the
   * callbacks recorded before either move.
   */
  const settled = async (expr, ms = 15_000) => {
    for (let i = 0; i < Math.ceil(ms / 50); i++) {
      if (await ev(expr).catch(() => false)) return true;
      await sleep(50);
    }
    return false;
  };

  /*
   * `window.setTimeout` wrapped from a new-document script, exactly as
   * `calcheck.mjs` does it and `themesync.mjs` wraps `fetch`: the recorded
   * callback is the same function the platform would have invoked, invoked at a
   * moment this suite chooses. `Emulation.setTimezoneOverride` moves the date
   * but fires nothing and does not re-arm a pending `setTimeout`, and there is
   * no zone in which "a few seconds before midnight" can be asked for. No
   * production seam, and an app that stopped arming a timer at all fails the
   * behavioural check below by name.
   */
  const timerProbe = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.setTimeout;
      window.__armed = [];
      window.setTimeout = function (fn, ms, ...rest) {
        if (typeof fn === 'function' && Number(ms) >= 1000) {
          window.__armed.push({ ms: Number(ms), at: Date.now(), fn });
        }
        return real.call(window, fn, ms, ...rest);
      };
    })();`,
  }, sessionId);

  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate',{url:APP},sessionId),
    what: 'the dashboard with the timer probe installed',
  });
  // The block above tapped a cell offline, so a write is in the outbox and the
  // reconnect that replays it ends in a `'reload'`. Waited out rather than slept
  // past: a `load()` landing after the zone move below would refresh the grid
  // and the staleness this block is about would never be observable.
  await settled(`(async () => (await import('/shared/ui/store.js')).state.pending === 0)()`);
  await sleep(400);

  const zoneDay = () => ev(`(async () => {
    const dates = await import('/shared/ui/dates.js');
    return dates.todayISO();})()`);
  // Sorted rather than taken in DOM order: `dayOrder` can draw the row
  // newest-first, and which end today sits at is not what this block is about.
  const lastColumn = () => ev(`(() => {
    const cells = [...document.querySelectorAll('#grid .habit-row .check[data-date]')];
    return cells.map(c => c.getAttribute('data-date')).sort().at(-1) ?? null;})()`);
  // The window the SERVER answered with, which is the half a repaint cannot
  // move. Without it a "fix" that only repainted would pass every check here:
  // `paint()` resolves `todayISO()` itself, so the columns would walk on to the
  // new day over a fortnight whose newest column has no data in it.
  const loadedEnd = () => ev(
    `(async () => (await import('/shared/ui/store.js')).state.gridLoaded?.end ?? null)()`);

  const drawnFor = await zoneDay();
  const drawnColumn = await lastColumn();
  const drawnEnd = await loadedEnd();
  ck('the grid is drawn for, and fetched for, the day the page loaded on',
    drawnColumn === drawnFor && drawnEnd === drawnFor,
    `columns end ${drawnColumn}, window ends ${drawnEnd} (loaded on ${drawnFor})`);

  /*
   * Which timers were armed for the next local midnight, computed BEFORE any
   * zone move — `remaining` is read from the local clock, so asking after the
   * override would compare timers armed for one zone's midnight against
   * another's.
   *
   * Compared as an ABSOLUTE instant (`at + ms` against `now + remaining`), so
   * the seconds between arming and reading cancel. The expectation is built
   * from the clock fields rather than by calling `setHours(24, 0, 0, 0)`, which
   * is the implementation's own expression: what this pins is that the arming
   * targets local MIDNIGHT rather than a fixed 24 hours, since `+ 86400000`
   * answers ~86.4e6 whatever the time of day.
   *
   * TWO views arm one of these — `app.js` calls `dashboard.init()` and
   * `detail.init()` whichever view is booting, and each watch declines unless
   * its own view is the one showing — so this check is CONTEXT and not the
   * biting one: with the dashboard's arming deleted the detail view's timer is
   * still here and this still passes. Every match is fired below and the
   * REBUILD is what bites, because the detail view's callback returns at
   * `state.openHabitId == null`. Attributing a timer to a module by its
   * position in the list would be a dependence on the order `app.js` inits its
   * views, which is not a thing this suite should be able to break.
   */
  const midnightTimers = () => ev(`(() => {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const remaining = ((24 * 60 - mins) * 60 - now.getSeconds()) * 1000
      - now.getMilliseconds();
    const wanted = Date.now() + remaining + 1000;
    const armed = (window.__armed ?? []);
    const hits = [];
    armed.forEach((t, i) => {
      if (Math.abs((t.at + t.ms) - wanted) <= 4000) hits.push({ i, off: (t.at + t.ms) - wanted });
    });
    return { hits, remaining, delays: armed.map(t => t.ms) };})()`);

  const armed = await midnightTimers();
  ck('a timer is armed for the next local midnight',
    armed.hits.length >= 1,
    `${JSON.stringify(armed)} (wanted one firing in about ${armed.remaining}ms)`);

  // Whichever extreme is not this machine's own calendar day, and then the
  // other one for the timer half.
  const ZONES = ['Pacific/Kiritimati', 'Etc/GMT+12'];
  let first = null;
  for (const zone of ZONES) {
    await send('Emulation.setTimezoneOverride', { timezoneId: zone }, sessionId);
    if (await zoneDay() !== drawnFor) { first = zone; break; }
  }
  const nextDay = await zoneDay();
  ck('the browser can be put on a different local date at all',
    first !== null && nextDay !== drawnFor,
    `${drawnFor} -> ${nextDay} (${first ?? 'neither zone moved it'})`);

  // Nothing has told the page yet, and that is the state a tab left open
  // overnight is in: LOOKING at it is what fixes it.
  const stale = { columns: await lastColumn(), end: await loadedEnd() };
  ck('...and the grid on screen is still the one fetched for the day before',
    stale.columns === drawnFor && stale.end === drawnFor,
    `${JSON.stringify(stale)} (the clock now says ${nextDay})`);

  await ev(`document.dispatchEvent(new Event('visibilitychange')); true`);
  const caughtByTab = await settled(`(async () => {
    const store = await import('/shared/ui/store.js');
    return store.state.gridLoaded?.end === ${JSON.stringify(nextDay)};})()`);
  const byTab = {
    columns: await lastColumn(),
    end: await loadedEnd(),
    today: await ev(`document.querySelectorAll('.grid-date.is-today').length`),
    listShowing: await ev(`!document.getElementById('view-list').hidden`),
  };
  ck('coming back to the tab refetches the grid for the new local day',
    caughtByTab === true && byTab.columns === nextDay && byTab.end === nextDay,
    `${JSON.stringify(byTab)} expected ${nextDay}`);
  ck('...with the header still marking exactly one column as today, and the '
    + 'list still the view that is showing',
    byTab.today === 1 && byTab.listShowing === true, JSON.stringify(byTab));

  /* ----- the OTHER trigger: the timer, with no tab switch behind it ----- */

  const second = ZONES.find((z) => z !== first);
  await send('Emulation.setTimezoneOverride', { timezoneId: second }, sessionId);
  const timerDay = await zoneDay();
  ck('the clock moved again for the timer half', timerDay !== nextDay,
    `${nextDay} -> ${timerDay} (${second})`);

  // The second move is BACKWARD — the other extreme is the day the page
  // originally loaded on — so this half can only observe anything if the half
  // above really did move the page off it. Asked rather than assumed: with the
  // `visibilitychange` listener deleted the page is still on `timerDay`, and a
  // timer check that merely compared against it would pass having watched
  // nothing happen. ANDed into the check below for the same reason.
  const staleForTimer = { columns: await lastColumn(), end: await loadedEnd() };
  ck('the grid is stale again, so the timer has something to be observed doing',
    staleForTimer.end === nextDay && staleForTimer.columns === nextDay,
    `${JSON.stringify(staleForTimer)} expected the page still on ${nextDay}, `
    + `with the clock now saying ${timerDay}`);

  // The callbacks the platform would have run, run now — every one recorded
  // before either move, since which module armed which is not knowable from
  // here. Guarded on there BEING one, for the reason `settled` is bounded
  // rather than throwing: with nothing armed — precisely the mutation this
  // exists to fail on — indexing into the list would throw out of the try
  // block and cost every check below its own named failure and the
  // `Emulation` override its reset.
  if (armed.hits.length) {
    await ev(`(() => { for (const i of ${JSON.stringify(armed.hits.map((h) => h.i))})
      window.__armed[i].fn(); return true; })()`);
  }
  const caughtByTimer = armed.hits.length > 0 && await settled(`(async () => {
    const store = await import('/shared/ui/store.js');
    return store.state.gridLoaded?.end === ${JSON.stringify(timerDay)};})()`);
  const byTimer = { columns: await lastColumn(), end: await loadedEnd() };
  ck('the timer alone refetches the grid for the new local day, with no tab '
    + 'switch behind it',
    staleForTimer.end === nextDay
    && caughtByTimer === true && byTimer.columns === timerDay && byTimer.end === timerDay,
    `${JSON.stringify(byTimer)} expected ${timerDay}`
    + (armed.hits.length ? '' : ' (no timer was armed to fire)')
    + (staleForTimer.end === nextDay ? ''
      : ` (and the page was already on ${staleForTimer.end} before it fired, so this`
        + ' could not have observed the timer either way)'));

  /* ----- a CACHED answer must not disarm either trigger ----- */

  /*
   * The record of which day the grid was fetched for is installed on the
   * strength of `api()` not throwing, and a cached answer does not throw.
   * `networkFirst` (`sw.js`) catches a failed or timed-out fetch and returns the
   * last stored `/overview` as an ordinary 200 carrying
   * `X-Habiterall-Offline: 1`; `ui/api.js` answers that header with
   * `setOffline(true)` and then resolves with the payload like any other. Taken
   * as an answer, that records "current for today" beside a `state.gridLoaded`
   * that ends yesterday — and both triggers then compare equal and return, so
   * neither the timer nor a tab switch acts again for 24 hours. One failed
   * request buys that: a woken laptop whose Wi-Fi has not reassociated at the
   * instant `visibilitychange` fires.
   *
   * It does not reliably heal, which is why this is a check and not a comment.
   * `api()` calls `setOffline` directly rather than through the watcher, and
   * `ui/connectivity.js` says at `reportOffline` what that costs: the watcher's
   * own `last` stays true, so a later successful probe is not a TRANSITION and
   * the `'reload'` that would have refetched is never emitted. Nothing here
   * touches `/healthz`, so that is exactly the state this block runs in.
   *
   * **The real worker and the real cache, and the network is cut on the
   * WORKER's own target.** A page under a service worker makes no network
   * request of its own — `Fetch` or `Network` on this page's session sees
   * nothing, measured: with `Fetch.enable` on `*` and a page-side `api()` call,
   * zero `requestPaused` events arrive. The worker is a target of its own, and
   * cutting ITS network is what makes `networkFirst` take the branch this block
   * is about, with the header and the body it really produces rather than a
   * canned imitation of them.
   *
   * **The warm-up is what makes the cached read possible at all, and it is a
   * fact about this suite rather than about the app.** Every `/api` response
   * carries `Vary: X-Habiterall-Timezone` and `caches.match` selects on it, so
   * a stored body is served only to a request sending the zone it was stored
   * under. In life that always holds — the day moves because time passes, with
   * the zone fixed — but the only way to move the day HERE is to move the zone,
   * which leaves the cache holding entries for a zone nothing will ask for
   * again. So both cacheable reads `load()` makes are warmed under the zone now
   * in force, through the app's own `api()` so the url, the headers and the
   * Vary key are the ones `load()` would have produced. It touches no view
   * state: `loadedDay` is `load()`'s to move, and nothing here calls it.
   *
   * Two guards keep this from passing vacuously: after the trigger the page
   * must report itself offline, and it must be holding the list from BEFORE the
   * probe habit was created. Between them they say the cached branch really ran.
   */
  console.log('\n--- a cached answer is not a fresh one ---');
  await send('Emulation.setTimezoneOverride', { timezoneId: first }, sessionId);
  const cacheDay = await zoneDay();
  ck('the clock moved once more, so there is something for the watch to do',
    cacheDay === nextDay && cacheDay !== timerDay,
    `${timerDay} -> ${cacheDay}`);

  // Both of `load()`'s cacheable reads, under the zone now in force. `/habits`
  // is in `CACHEABLE_API` too and `load()` asks it FIRST, so leaving it cold
  // would throw out of `load()` before `/overview` was ever reached — the
  // ordinary offline path, and not the one this block is about.
  const warmed = await ev(`(async () => {
    const { GRID_DAYS } = await import('/shared/ui/window.js');
    const { api } = await import('/shared/ui/api.js');
    await api('/habits?archived=true');
    await api('/overview?' + new URLSearchParams({ days: String(GRID_DAYS) }));
    return !!navigator.serviceWorker.controller;})()`);

  // Created AFTER the warm-up, so the cached copy and a live one are
  // distinguishable by something the page shows.
  const PROBE = 'Cached-answer probe';
  const probeId = await ev(`(async () => {
    const r = await fetch('/api/habits', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ${JSON.stringify(PROBE)}, type: 'boolean' }) });
    return (await r.json()).id;})()`);

  const targets = await send('Target.getTargets', {});
  const worker = targets.targetInfos.find(
    (t) => t.type === 'service_worker' && t.url.startsWith(APP));
  ck('the page is under its service worker, which is what makes this reachable',
    warmed === true && !!worker,
    `controller ${warmed}, worker target ${worker?.url ?? 'not found'}`);

  let cached = { offline: null, hasProbe: null };
  let refetched = { hasProbe: null, end: null };
  let healed = false;
  if (worker) {
    const { sessionId: swSid } =
      await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    await send('Network.enable', {}, swSid);
    await send('Network.emulateNetworkConditions',
      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, swSid);

    await ev(`document.dispatchEvent(new Event('visibilitychange')); true`);
    await settled(`(async () => (await import(
      '/shared/ui/store.js')).state.offline === true)()`);
    cached = await ev(`(async () => {
      const { state } = await import('/shared/ui/store.js');
      return { offline: state.offline,
        hasProbe: state.habits.some(h => h.name === ${JSON.stringify(PROBE)}) };})()`);

    await send('Network.emulateNetworkConditions',
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, swSid);

    // Nothing else can refetch here: the connectivity watcher emits `'reload'`
    // only on a TRANSITION it observed, and it observed none — `api()` set the
    // flag behind its back, its `last` is still true, and `/healthz` never
    // stopped answering, the worker declining to cache it for exactly this
    // class of reason. So the habit appearing is this watch, and only this
    // watch, having stayed armed.
    await ev(`document.dispatchEvent(new Event('visibilitychange')); true`);
    healed = await settled(`(async () => (await import(
      '/shared/ui/store.js')).state.habits.some(
        h => h.name === ${JSON.stringify(PROBE)}))()`);
    refetched = await ev(`(async () => {
      const { state } = await import('/shared/ui/store.js');
      return { hasProbe: state.habits.some(h => h.name === ${JSON.stringify(PROBE)}),
        end: state.gridLoaded?.end ?? null };})()`);
  }

  ck('the worker answered from its cache, and the page took it as an answer',
    cached.offline === true && cached.hasProbe === false,
    `${JSON.stringify(cached)} (a live answer would carry ${JSON.stringify(PROBE)})`);
  ck('...and a cached answer does not disarm the watch: the next look refetches',
    cached.hasProbe === false && healed === true && refetched.hasProbe === true,
    `${JSON.stringify(refetched)} (expected the page to pick up `
    + `${JSON.stringify(PROBE)}, created while it was showing the saved copy)`);

  await ev(`fetch('/api/habits/' + ${probeId}, { method: 'DELETE' })`);

  await send('Emulation.setTimezoneOverride', { timezoneId: '' }, sessionId);
  await send('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: timerProbe.identifier }, sessionId);

  /* ---------- issue #200: a re-sort must not lose the roving focus ---------- */
  //
  // `paint()` restores focus by `data-focus-key`, which names WHAT a control
  // is rather than where it sat — see the module comment above `habitRow` in
  // ui/dashboard.js. `habitSort` is the first setting able to move a habit's
  // ROW to a different index without any row being added, removed or dragged,
  // so it is the case that actually exercises "identified by the habit, not
  // the index" rather than merely asserting a mechanism that happens to be
  // shared with drag-and-drop.
  console.log('\n--- habitSort keeps focus on the HABIT through a re-sort ---');

  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate',{url:APP},sessionId),
    what: 'the dashboard',
  });
  await sleep(600);

  const rowNames = () => ev(`[...document.querySelectorAll('#grid .habit-row .habit-name')]
    .map(n=>n.textContent.trim())`);
  const manualNames = await rowNames();

  // A control INSIDE the row, not the row itself — `data-focus-key` names the
  // checkbox (`check:<habit>:<date>`), not the `.habit-row`.
  const focused = await ev(`(() => {
    const row = document.querySelector('.habit-row:first-child');
    const box = row.querySelector('.check[data-focus-key]');
    box.focus();
    return { key: box.dataset.focusKey,
      name: row.querySelector('.habit-name').textContent.trim() };
  })()`);
  ck('a habit\'s own checkbox took focus ahead of the re-sort',
    !!focused.key, JSON.stringify(focused));

  const nameOrder = [...manualNames].sort((a,b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }));

  // NOT the settings dialog here — dragtest.mjs already drives that end to
  // end, and `<dialog>.showModal()` moves focus into the dialog the instant
  // it opens (to the pressed button, or the dialog itself), which would
  // steal focus from the checkbox before the re-sort this block is about
  // ever happens. `settings.save` is the same server round trip the dialog's
  // Done button makes, and `emit('reload')` is the exact call
  // `applyDraft` makes for a `SERVER_COMPUTED` key — both real app
  // machinery, invoked directly so nothing here touches the DOM outside the
  // grid before the assertion.
  await ev(`(async () => {
    const settings = await import('/shared/ui/settings.js');
    await settings.save('habitSort', 'name');
    const { emit } = await import('/shared/ui/store.js');
    emit('reload');
  })()`);

  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-name')].map(n=>n.textContent.trim())
      .join('|') === ${JSON.stringify(nameOrder.join('|'))}`,
    { what: 'the dashboard to redraw in name order' });

  const afterNames = await rowNames();
  const wasAt = manualNames.indexOf(focused.name);
  const nowAt = afterNames.indexOf(focused.name);
  ck('the focused habit\'s index really moved — or this proves nothing',
    wasAt !== -1 && nowAt !== -1 && wasAt !== nowAt,
    `${focused.name}: index ${wasAt} -> ${nowAt} (${JSON.stringify(manualNames)} -> ${JSON.stringify(afterNames)})`);

  const stillFocused = await ev(`({
    key: document.activeElement?.dataset?.focusKey ?? null,
    name: document.activeElement?.closest('.habit-row')
      ?.querySelector('.habit-name')?.textContent?.trim() ?? null,
  })`);
  ck('focus stayed on the same HABIT\'s control, identified by the habit and not by the index',
    stillFocused.key === focused.key && stillFocused.name === focused.name,
    `${JSON.stringify(focused)} -> ${JSON.stringify(stillFocused)}`);

  // Leave the account back on manual order — the next suite's own
  // `fixtures.reset()` would clear this anyway, but a suite run standalone
  // twice in a row should not depend on that.
  await ev(`(async () => {
    const settings = await import('/shared/ui/settings.js');
    await settings.save('habitSort', 'manual');
    const { emit } = await import('/shared/ui/store.js');
    emit('reload');
  })()`);
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-name')].map(n=>n.textContent.trim())
      .join('|') === ${JSON.stringify(manualNames.join('|'))}`,
    { what: 'the dashboard to redraw back in manual order' });

  /* ---------- notes: the mark, and the secondary affordance routes through
     the habit's own page (#297) ---------- */
  console.log('\n--- notes ---');
  const notesSeed = await ev(`(async () => {
    const habits = await (await fetch('/api/habits')).json();
    const h = habits.find(x => !x.archived);
    const iso = n => { const d = new Date(); d.setDate(d.getDate() - n);
      return d.toISOString().slice(0, 10); };
    const noted = iso(1), plain = iso(2);
    const noteText = 'grid probe note, kept honest';
    await fetch('/api/habits/' + h.id + '/entries/' + noted, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 2, notes: noteText }) });
    await fetch('/api/habits/' + h.id + '/entries/' + plain, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 2 }) });
    return { id: h.id, noted, plain, noteText };
  })()`);
  ck('a habit exists to seed the notes probe onto', !!notesSeed?.id, JSON.stringify(notesSeed));

  if (notesSeed?.id) {
    await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
      reload: () => send('Page.navigate',{url:APP},sessionId),
      what: 'the dashboard, reloaded to pick up the seeded notes',
    });
    await sleep(600);

    const boxSel = (date) => `[data-focus-key="check:${notesSeed.id}:${date}"] .check-box`;
    const hasNoteMark = (date) => ev(
      `document.querySelector('${boxSel(date)}')?.classList.contains('has-note') ?? null`);
    ck('the note-bearing day carries the mark on the dashboard grid',
       await hasNoteMark(notesSeed.noted) === true);
    ck('a day with an entry and no note does not',
       await hasNoteMark(notesSeed.plain) === false);

    // The CLASS alone is not the mark — `.check-box.has-note::after` is what
    // actually draws it, and a check reading only `classList` stays green with
    // that whole rule deleted from the stylesheet (review round). Read what is
    // RENDERED, on the pseudo-element itself: `content` must not be `'none'`
    // (no box generated at all) and the box drawn must have real width.
    const notePseudo = (date) => ev(`(() => {
      const el = document.querySelector('${boxSel(date)}');
      if (!el) return null;
      const cs = getComputedStyle(el, '::after');
      return { content: cs.content, width: parseFloat(cs.width),
               bg: cs.backgroundColor, ring: cs.boxShadow };
    })()`);
    const notedPseudo = await notePseudo(notesSeed.noted);
    // A generated box of real width is not yet a VISIBLE dot: the mark is
    // carried by `background: var(--surface)` plus the `box-shadow` ring, and
    // dropping either leaves an invisible 6x6 box that `content`/`width`
    // alone still pass (review round 2). Both are read here.
    ck("the note-bearing day's dot is actually DRAWN, not merely classed",
       !!notedPseudo && notedPseudo.content !== 'none' && notedPseudo.width > 0
         && notedPseudo.bg !== 'rgba(0, 0, 0, 0)' && notedPseudo.ring !== 'none',
       JSON.stringify(notedPseudo));
    const plainPseudo = await notePseudo(notesSeed.plain);
    // The negative half, and the one that stops a rule drawing a dot on EVERY
    // cell from passing the check above too.
    ck('...and the note-free day draws no pseudo-element at all',
       !!plainPseudo && plainPseudo.content === 'none', JSON.stringify(plainPseudo));

    const cellCentre = (date) => ev(`(() => {
      const el = document.querySelector('[data-focus-key="check:${notesSeed.id}:${date}"]');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    // A REAL right-click, dispatched over CDP — a scripted `.click()`
    // dispatches no `pointerdown` and proves nothing about the gesture a
    // desktop right-click (or an Android long-press, which fires the same
    // `contextmenu` event on a `<button>`) actually arrives as.
    const rightClick = async (x, y) => {
      await send('Input.dispatchMouseEvent',
        { type: 'mousePressed', x, y, button: 'right', clickCount: 1 }, sessionId);
      await send('Input.dispatchMouseEvent',
        { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 }, sessionId);
    };

    const notedCentre = await cellCentre(notesSeed.noted);
    ck('the note-bearing cell is on screen to be right-clicked', !!notedCentre,
       JSON.stringify(notedCentre));

    const leftClick = async (x, y) => {
      await send('Input.dispatchMouseEvent',
        { type: 'mouseMoved', x, y, button: 'none' }, sessionId);
      await send('Input.dispatchMouseEvent',
        { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
      await send('Input.dispatchMouseEvent',
        { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
    };
    const editorState = () => ev(`({
      open: document.getElementById('day-dialog')?.open === true,
      hash: location.hash,
      listShowing: !document.getElementById('view-list').hidden,
      detailShowing: !document.getElementById('view-detail').hidden,
      notes: document.getElementById('day-notes').value,
      notesHidden: document.getElementById('day-notes-wrap').hidden === true,
    })`);

    if (notedCentre) {
      await rightClick(notedCentre.x, notedCentre.y);
      /*
       * The secondary affordance opens the editor IN PLACE, over the list.
       *
       * It used to navigate to the habit's own page (#297) for one reason
       * only: this list holds which dates hold a note and never the TEXT, so
       * a dialog opened here would have seeded an empty box over a day that
       * has a real note — and `saveDay` STATES the note on every save, which
       * destroys it on the next Save (#224). The trip was the workaround, not
       * the feature. `editDayOverList` (`ui/dashboard.js`) fetches that
       * habit's entries for the text instead, which is strictly less work
       * than the navigation it replaces — that fetched the same request AND
       * `/habits/:id/stats`, then rebuilt a page of SVG.
       *
       * So what is asserted is the whole of it: the dialog is open, the LIST
       * is still what is showing, the URL has not moved — and the box holds
       * the real note. That last one is the #224 proof and is the check that
       * fails if the fetch is ever dropped for a cheaper guess.
       */
      await waitUntil(ev, `document.getElementById('day-dialog')?.open === true`,
        { what: 'the day editor to open over the list' });
      await sleep(300);
      const landed = await editorState();
      ck('the secondary affordance opens the day editor over the LIST, without '
         + 'navigating anywhere',
         landed.listShowing === true && landed.detailShowing === false
           && landed.hash !== `#/habit/${notesSeed.id}`,
         JSON.stringify(landed));
      ck('...and #day-notes holds the REAL note, not an empty box',
         landed.notes === notesSeed.noteText, JSON.stringify(landed));
      ck('...and the note box is SHOWN, so the note is editable rather than '
         + 'merely preserved',
         landed.notesHidden === false, JSON.stringify(landed));
      await ev(`document.getElementById('day-cancel').click()`);
      await sleep(300);
    }

    /* ---------- `dayTap`: what a PLAIN tap does ---------- */
    console.log('\n--- dayTap ---');
    /*
     * The default is `'cycle'`, and the negative half is asserted FIRST and
     * against the same cell the positive half uses. Without it, "the editor
     * opened" says nothing — a build that opened the editor on every tap
     * whatever the setting said would pass the positive check alone, and that
     * build is exactly the one that takes one-tap answering away from every
     * account that never touched this setting.
     */
    const setTap = async (value) => {
      await ev(`(async () => {
        const settings = await import('/shared/ui/settings.js');
        await settings.save('dayTap', ${JSON.stringify(value)});
      })()`);
      // Read back from the SERVER, not from the cache the line above just
      // wrote: `SETTING_VALUES` is what actually decides, and a key it refuses
      // leaves the local cache asserting a value no tap will ever see.
      return ev(`(async () => (await (await fetch('/api/settings',
        { credentials: 'same-origin' })).json()).dayTap)()`);
    };

    const cycleCell = notesSeed.plain;
    const cycleSel = `[data-focus-key="check:${notesSeed.id}:${cycleCell}"]`;
    const centreOf = (sel) => ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    const storedValue = (date) => ev(`(async () => {
      const rows = await (await fetch('/api/habits/${notesSeed.id}/entries',
        { credentials: 'same-origin' })).json();
      const row = rows.find(r => r.date === ${JSON.stringify(date)});
      return row ? { value: row.value, status: row.status, notes: row.notes } : null;
    })()`);

    ck('the setting stores as `cycle`', await setTap('cycle') === 'cycle');
    const before = await storedValue(cycleCell);
    let at = await centreOf(cycleSel);
    ck('the cycle cell is on screen', !!at, JSON.stringify(at));
    await leftClick(at.x, at.y);
    await sleep(700);
    const afterCycle = await editorState();
    ck('under `cycle`, a plain tap opens NO dialog', afterCycle.open === false,
       JSON.stringify(afterCycle));
    const cycled = await storedValue(cycleCell);
    ck('...and it recorded the next state of the cycle instead',
       JSON.stringify(cycled) !== JSON.stringify(before),
       `${JSON.stringify(before)} -> ${JSON.stringify(cycled)}`);

    ck('the setting stores as `editor`', await setTap('editor') === 'editor');
    // A settings change reaches the grid through `settings.get` at TAP time,
    // not through a rebuild — so no reload is needed here, and needing one
    // would itself be the defect (the cells are already built).
    const notedSel = `[data-focus-key="check:${notesSeed.id}:${notesSeed.noted}"]`;
    at = await centreOf(notedSel);
    ck('the noted cell is on screen for the editor tap', !!at, JSON.stringify(at));
    await leftClick(at.x, at.y);
    await waitUntil(ev, `document.getElementById('day-dialog')?.open === true`,
      { what: 'the day editor to open from a plain tap under `dayTap: editor`' });
    const afterEditor = await editorState();
    ck('under `editor`, a plain tap opens the day editor over the list',
       afterEditor.open === true && afterEditor.listShowing === true,
       JSON.stringify(afterEditor));
    ck('...seeded with the real note, which is the whole point of the setting',
       afterEditor.notes === notesSeed.noteText, JSON.stringify(afterEditor));

    // ...and a save from there states the note, so it round-trips through the
    // surface that could not write one before. A CHANGED note, not the same
    // one: a save that wrote nothing at all would compare equal to itself.
    const newNote = notesSeed.noteText + ' — edited from the dashboard';
    await ev(`(() => {
      const box = document.getElementById('day-notes');
      box.value = ${JSON.stringify(newNote)};
      [...document.querySelectorAll('#day-boolean .day-choice')]
        .find(b => b.dataset.action === 'done').click();
    })()`);
    await waitUntil(ev, `document.getElementById('day-dialog')?.open !== true`,
      { what: 'the day editor to close after saving' });
    await sleep(500);
    const saved = await storedValue(notesSeed.noted);
    ck('a save from the dashboard editor writes the note',
       saved?.notes === newNote, JSON.stringify(saved));

    ck('the setting is put back', await setTap('cycle') === 'cycle');
  }

  console.log(fails===0?'\nALL GRID CHECKS PASSED':`\n${fails} FAILED`);
}catch(e){console.error('ERR',e.message);fails++;}
finally{await closeChrome({ chrome, port: PORT, profile });process.exit(fails?1:0);}
