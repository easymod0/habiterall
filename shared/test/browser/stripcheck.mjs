/**
 * The "Recent days" card on a habit's own page, end to end in a real browser.
 *
 * What only this layer can prove: that a tap on a cell that is NOT on the
 * dashboard reaches storage, that everything else on the page moves with it,
 * and that the optimistic paint happens before the request rather than after
 * it. The bug class is a cell and a database disagreeing, so every assertion
 * about a write asks the API what the row says rather than reading the cell —
 * the `unknowncheck.mjs` model, and for the same reason.
 *
 * Three things here are reachable from nowhere else in the suite:
 *
 *  - The card is the first thing under the stat tiles on a FRESH account, with
 *    no stored `detailCards` at all. Every other card test PUTs a list first,
 *    which is exactly the state this claim is not about.
 *  - The cell flips BEFORE the server answers. Held open with CDP
 *    `Fetch.requestPaused` (hangcheck.mjs's technique) rather than throttling,
 *    because devtools offline is connection-refused: it rejects in ~3ms and
 *    would pass against a build that painted afterwards.
 *  - Offline, three taps advance the CYCLE rather than queueing the same write
 *    three times. That is the failure `writeDay`'s long comment exists to
 *    prevent, and it is invisible online because the refetch hides it.
 *  - The in-run tick (#176) is asserted with `getComputedStyle`, not by reading
 *    `textContent` alone — the ghost tick and a filled cell can share a glyph
 *    and differ only in colour, opacity and background, none of which the fake
 *    DOM in `atmost.mjs` or `rendercheck.mjs` can see.
 *
 * `--- paging, offline ---` is the only place the card's paging is asked to
 * work with nothing to fetch, and so the only place the position it stores and
 * the window it draws can be caught disagreeing (#245). It needs a real
 * browser twice over: the offset lives in a module the page loaded, and the
 * setup turns on `Network.setBypassServiceWorker`, without which the worker
 * answers both of `open()`'s GETs from its data cache and the app is not
 * offline at all.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome, waitUntil } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000', PORT = devtoolsPort(9321);
const profile = mkdtempSync(join(tmpdir(), 'habstrip-'));
const chrome = launchChrome(PORT, profile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ck = (l, c, e = '') => {
  console.log((c ? 'PASS' : 'FAIL') + '  ' + l + (e ? ' :: ' + e : ''));
  if (!c) fails++;
};
let ws, nid = 1;
const pend = new Map();
const paused = [];
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++;
  pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

try {
  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method === 'Fetch.requestPaused') {
      paused.push(m.params);
    }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

  // Navigate BEFORE seeding: an `about:blank` target has an opaque origin and
  // every fetch from it fails, which is the whole of a "Failed to fetch" here.
  // Same-origin paths below rather than absolute ones, for the same reason
  // every other suite uses them — they follow whichever base this worker owns.
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev, `!!document.querySelector('#grid .habit-row')`,
    { what: 'the dashboard' });

  /** A yes/no habit, and the days around today cleared on each shape. */
  const seeded = await ev(`(async () => {
    const habits = await (await fetch('/api/habits')).json();
    const yesno = habits.find(h => h.type === 'boolean' && !h.archived);
    const num = habits.find(h => h.type === 'numerical' && h.show_as !== 'avoid' && !h.archived);
    // Created here rather than taken from the shared fixtures, which have no
    // avoided habit — and a block that silently skips itself is the defect
    // this repo ships most. Its encoding is the whole point: done is 0 and a
    // slip is target + 1, the opposite way round from every other shape.
    const avoid = await (await fetch('/api/habits', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Strip avoid probe', type: 'numerical',
        target_type: 'at_most', target_value: 2, show_as: 'avoid', unit: 'coffees',
        color: '#ef4444', freq_numerator: 1, freq_denominator: 1 }),
    })).json();
    const iso = n => { const d = new Date(); d.setDate(d.getDate() - n);
      return d.toISOString().slice(0, 10); };
    const day1 = iso(1), day2 = iso(2), day3 = iso(3);
    for (const h of [yesno, num, avoid].filter(Boolean)) {
      for (const date of [day1, day2, day3]) {
        await fetch('/api/habits/' + h.id + '/entries/' + date, { method: 'DELETE' });
      }
    }
    return { habit: yesno.id, num: num?.id ?? null, avoid: avoid?.id ?? null,
             target: num?.target_value ?? 0, avoidTarget: avoid?.target_value ?? 0,
             day1, day2, day3 };
  })()`);

  // A unique query on every open, and it is load bearing twice over.
  //
  // `Page.navigate` to a URL differing only by FRAGMENT is a SAME-DOCUMENT
  // navigation: the app gets a `hashchange` and opens the habit, but nothing
  // reloads and `settings.init()` never re-runs — so a settings write made
  // between two opens is invisible, and the test asserting it reads as a
  // feature bug. And chasing `Page.navigate` with `Page.reload` does not fix
  // it: `navigate` resolves before the navigation commits, so the reload lands
  // on the PREVIOUS url and quietly reopens the previous habit — which, when
  // that habit was the boolean one, made a numerical habit appear to cycle
  // instead of asking for an amount. A query nobody reads is unambiguous.
  let opens = 0;
  const openHabit = async (id = seeded.habit, expect = '.day-strip .check') => {
    await send('Page.navigate',
      { url: `${APP}/?open=${++opens}#/habit/${id}` }, sessionId);
    await waitUntil(ev, `!!document.querySelector('#view-detail ${expect}')`,
      { what: `the detail page (${expect})` });
    await sleep(500);
  };

  /** Scoped to the STRIP, never `document` — the dashboard draws `.check` too. */
  const cellSel = (date) => `#view-detail .day-strip .check[data-date="${date}"]`;
  const box = (date) => ev(
    `(document.querySelector('${cellSel(date)} .check-box')?.textContent ?? '').trim()`);
  const tap = async (date, settle = 1200) => {
    await ev(`document.querySelector('${cellSel(date)}').click()`);
    await sleep(settle);
  };
  const stored = (date, id = seeded.habit) => ev(`(async () => {
    const rows = await (await fetch('/api/habits/${id}/entries')).json();
    const row = rows.find(e => e.date === '${date}');
    return row ? { value: row.value, status: row.status } : null;
  })()`);
  const titles = () => ev(
    `[...document.querySelectorAll('#view-detail .card-title')].map(t=>t.textContent)`);

  /* ---------- where it sits, on an account that has never chosen ---------- */

  console.log('--- the card, by default ---');
  // Deliberately WITHOUT putting a detailCards value first. `parseCardList`
  // inserting a card at its canonical position is unit-tested; that an account
  // with NO stored value gets it first, above Habit strength, is a claim about
  // the registry default reaching the page, and every other card test in this
  // repo PUTs a list before looking.
  await ev(`(async () => {
    await fetch('/api/settings', { method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ detailCards: null }) });
  })()`).catch(() => {});
  await openHabit();
  const shown = await titles();
  ck('Recent days is the first card on the page', shown[0] === 'Recent days',
     JSON.stringify(shown));
  ck('...and it sits above Habit strength',
     shown.indexOf('Recent days') < shown.indexOf('Habit strength'), JSON.stringify(shown));
  // `.stat-tile` is not unique to the summary row (a card builds them too), so
  // this asks the question that matters — the summary comes FIRST — rather than
  // counting them and pinning an unrelated card's internals by accident.
  ck('the summary tiles are still above the first card',
     await ev(`(() => {
       const tile = document.querySelector('#view-detail .stat-tile');
       const card = document.querySelector('#view-detail .card');
       return !!tile && !!card &&
         (tile.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
     })()`) === true);

  // The captions and the squares are built by one module; this is what says
  // they are still registered once that module draws into a CARD rather than
  // into the dashboard's grid header, where `.grid-dates` is right-aligned by
  // a rule that is inert in a grid parent and very much not in a flex one.
  const drift = await ev(`(() => {
    const s = document.querySelector('.day-strip');
    const cells = [...s.querySelectorAll('.check')], dates = [...s.querySelectorAll('.grid-date')];
    if (cells.length !== dates.length || !cells.length) return 9999;
    const mid = el => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    return Math.max(...cells.map((c, i) => Math.abs(Math.round(mid(c) - mid(dates[i])))));
  })()`);
  ck('every date caption is centred over its own cell', drift <= 1, `max drift ${drift}px`);
  ck('and the strip does not overflow into a scrollbar',
     await ev(`(() => { const s = document.querySelector('.day-strip').closest('.chart-scroll');
       return s ? s.scrollWidth - s.clientWidth : 0; })()`) === 0);

  // The `gridDays` setting caps the strip too, so it means one thing on both
  // surfaces. Asserted against the CELLS rather than against `cappedColumns`,
  // which is unit-tested: a correct pure function proves nothing about whether
  // its caller passes the answer on, and this repo has shipped that gap six
  // times.
  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gridDays: '5' }) })`);
  await openHabit();
  ck('gridDays caps the strip, exactly as it caps the dashboard',
     await ev(`document.querySelectorAll('#view-detail .day-strip .check').length`) === 5,
     `${await ev(`document.querySelectorAll('#view-detail .day-strip .check').length`)} cells`);
  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gridDays: 'auto' }) })`);
  await openHabit();

  /* ---------- what a tap writes ---------- */

  console.log('--- the cycle ---');
  ck('the day starts with no row at all', await stored(seeded.day1) === null);

  await tap(seeded.day1);
  ck('one tap on a yes/no habit stores YES',
     JSON.stringify(await stored(seeded.day1)) === JSON.stringify({ value: 2, status: '' }),
     JSON.stringify(await stored(seeded.day1)));
  ck('...and the cell says so', await box(seeded.day1) === '✓');

  await tap(seeded.day1);
  ck('a second tap stores a stated lapse — a 0 ROW, not a delete',
     JSON.stringify(await stored(seeded.day1)) === JSON.stringify({ value: 0, status: '' }),
     JSON.stringify(await stored(seeded.day1)));

  /* ---------- the rest of the page moves with it ---------- */

  console.log('--- a tap refreshes the whole page ---');
  // `writeDay` ends in `host.refresh()`, which is a full refetch. Without it
  // the strip would be right and every figure computed from that day — the
  // Strength tile, the streak, the calendar — would still be showing the state
  // before the tap, with nothing on screen to say so.
  const strengthTile = () => ev(`(() => {
    const t = [...document.querySelectorAll('#view-detail .stat-tile')]
      .find(t => /strength/i.test(t.textContent));
    return t ? t.textContent.match(/\\d+/)?.[0] ?? '' : '';})()`);
  const calendarFilled = () => ev(`(() => {
    const c = [...document.querySelectorAll('#view-detail .card')]
      .find(c => c.querySelector('.card-title')?.textContent === 'Calendar');
    return [...(c?.querySelectorAll('.cal-cell') ?? [])]
      .filter(r => (r.getAttribute('fill') ?? '') !== 'var(--grid-empty)').length;})()`);

  await ev(`fetch('/api/habits/${seeded.habit}/entries/${seeded.day2}',
    { method: 'DELETE' })`);
  await openHabit();
  const beforeStrength = await strengthTile();
  const beforeCal = await calendarFilled();
  await tap(seeded.day2);
  ck('the Strength tile moves after a tap on the strip',
     await strengthTile() !== beforeStrength, `${beforeStrength} -> ${await strengthTile()}`);
  ck('...and so does the calendar card',
     await calendarFilled() > beforeCal, `${beforeCal} -> ${await calendarFilled()}`);

  /* ---------- the paint happens before the request settles ---------- */

  console.log('--- optimistic, not hopeful ---');
  // Held open rather than throttled: devtools offline emulation is
  // connection-refused, which rejects in about 3ms — fast enough that a build
  // painting AFTER the await would still look instant. See hangcheck.mjs.
  await ev(`fetch('/api/habits/${seeded.habit}/entries/${seeded.day3}',
    { method: 'DELETE' })`);
  await openHabit();
  paused.length = 0;
  await send('Fetch.enable',
    { patterns: [{ urlPattern: `*/entries/${seeded.day3}`, requestStage: 'Request' }] },
    sessionId);
  await ev(`document.querySelector('${cellSel(seeded.day3)}').click()`);
  await sleep(700);
  const paintedWhileInFlight = await box(seeded.day3);
  ck('the cell is painted while its request is still in flight',
     paintedWhileInFlight === '✓' && paused.length > 0,
     `box=${JSON.stringify(paintedWhileInFlight)} paused=${paused.length}`);
  for (const p of paused) {
    await send('Fetch.continueRequest', { requestId: p.requestId }, sessionId).catch(() => {});
  }
  await send('Fetch.disable', {}, sessionId);
  await sleep(1200);
  ck('...and it lands once the request is released',
     JSON.stringify(await stored(seeded.day3)) === JSON.stringify({ value: 2, status: '' }),
     JSON.stringify(await stored(seeded.day3)));

  /* ---------- a measurable habit asks, exactly as the dashboard does ---------- */

  if (seeded.num) {
    console.log('--- an amount ---');
    await openHabit(seeded.num);
    await ev(`document.querySelector('${cellSel(seeded.day1)}').click()`);
    await sleep(700);
    ck('a measurable habit opens the amount dialog rather than cycling',
       await ev(`document.getElementById('count-dialog').open`) === true);
    await ev(`(() => { const i = document.getElementById('grid-count-typed');
      i.value = '3'; i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('count-save').click(); })()`);
    await sleep(1400);
    ck('...and Save writes the typed amount',
       (await stored(seeded.day1, seeded.num))?.value === 3,
       JSON.stringify(await stored(seeded.day1, seeded.num)));
  }

  /* ---------- an avoided habit is inverted in the paint, not in the value ---------- */

  console.log('--- avoided ---');
  ck('the avoided probe habit was created', !!seeded.avoid, JSON.stringify(seeded.avoid));
  if (seeded.avoid) {
    await openHabit(seeded.avoid);
    await tap(seeded.day1);
    ck('an avoided habit CYCLES rather than opening the amount box',
       await ev(`document.getElementById('count-dialog').open`) === false);
    ck('...and its first tap stores 0, the clean day',
       (await stored(seeded.day1, seeded.avoid))?.value === 0,
       JSON.stringify(await stored(seeded.day1, seeded.avoid)));
    ck('...painted as a tick, not as a miss', await box(seeded.day1) === '✓');

    await tap(seeded.day1);
    ck('a second tap stores target + 1 — the smallest amount that fails',
       (await stored(seeded.day1, seeded.avoid))?.value === seeded.avoidTarget + 1,
       `target ${seeded.avoidTarget}, stored `
       + JSON.stringify(await stored(seeded.day1, seeded.avoid)));
  }

  /* ---------- a rollback belongs to the write it was made for ---------- */

  console.log('--- the undo, after the page has moved on ---');
  if (seeded.avoid) {
    // `detailHost.edit` hands `writeDay` a closure that puts a day back when its
    // request turns out not to have been made. What it puts back lives in maps
    // that `render()` REPLACES wholesale, so the question is which habit's map
    // the rollback lands in — and the answer used to be "whichever is open when
    // it runs", because the closure named the bindings rather than holding the
    // maps. The id guard in `edit` cannot see this: it has already returned.
    //
    // The navigation is a `location.hash` write and NOT `openHabit()`, which is
    // the whole reason this is reachable. `Page.navigate` is a document load and
    // takes the in-flight write's promise with it, so the `catch` that rolls
    // back never runs and any build passes. A fragment change is same-document
    // — the note above `openHabit` says so — and leaves the request paused, the
    // module state alive, and a different habit on screen.
    //
    // The second habit is the avoided one because it CYCLES, so the corruption
    // has somewhere to show up in storage: from a clean day (0) the next tap is
    // a slip (target + 1), while from a day the map has lost it is `unknown`,
    // whose next tap is the clean day again. Reading a deleted key as unknown is
    // what makes those two differ. Both rest on the same default cycle the
    // offline block below does — no skips, no question marks.
    await ev(`(async () => {
      await fetch('/api/habits/${seeded.habit}/entries/${seeded.day2}', { method: 'DELETE' });
      await fetch('/api/habits/${seeded.avoid}/entries/${seeded.day2}', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 0 }) });
    })()`);
    await openHabit(seeded.habit);

    paused.length = 0;
    await send('Fetch.enable', { patterns: [{
      urlPattern: `*/habits/${seeded.habit}/entries/${seeded.day2}`,
      requestStage: 'Request',
    }] }, sessionId);
    await ev(`document.querySelector('${cellSel(seeded.day2)}').click()`);
    await sleep(700);
    ck('the first habit\'s write is held in flight', paused.length > 0, `paused=${paused.length}`);

    await ev(`location.hash = '#/habit/${seeded.avoid}'`);
    // The HEADING, not a cell: both habits paint this day as a tick — one
    // optimistically, one from its stored clean day — so a cell cannot say which
    // page arrived, and waiting on the wrong thing would pass instantly here.
    await waitUntil(ev, `(() => {
      const h = document.querySelector('#view-detail .detail-head h2');
      return !!h && h.textContent.includes('Strip avoid probe')
        && !!document.querySelector('${cellSel(seeded.day2)}');
    })()`, { what: 'the avoided habit, open over the held write' });

    // ANSWERED, so `api()` throws without `queued` and `writeDay` rolls back —
    // the one path that runs the closure. A dropped connection is queued
    // instead, the optimistic state is kept on purpose, and nothing undoes.
    for (const p of paused) {
      await send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 500,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from('{"error":"refused"}').toString('base64'),
      }, sessionId).catch(() => {});
    }
    await send('Fetch.disable', {}, sessionId);
    await sleep(1500);

    const afterRollback = await box(seeded.day2);
    ck('a failed write does not roll back into the habit now open',
       afterRollback === '✓', `cell reads ${JSON.stringify(afterRollback)}`);

    // The damage the paint only hints at. A corrupted cell is read back by the
    // next tap, which computes the cycle from it — so the wrong value reaches
    // storage for a day this habit's own writes never touched.
    await tap(seeded.day2, 1600);
    ck('...and the next tap on it still cycles from what the server holds',
       (await stored(seeded.day2, seeded.avoid))?.value === seeded.avoidTarget + 1,
       `expected ${seeded.avoidTarget + 1}, stored `
       + JSON.stringify(await stored(seeded.day2, seeded.avoid)));
  }

  /* ---------- offline ---------- */

  console.log('--- offline, the cycle still advances ---');
  await openHabit();
  await ev(`fetch('/api/habits/${seeded.habit}/entries/${seeded.day1}',
    { method: 'DELETE' })`);
  await openHabit();
  await send('Network.enable', {}, sessionId);
  await send('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);

  // TWO taps with no network, and the count is the whole assertion. The cycle
  // from an unanswered day is unknown -> done -> no, so a version that read the
  // optimistic state correctly ends on a stated lapse (0) while one that lost
  // it re-derives `done` from `unknown` and queues the SAME write twice,
  // ending on 2.
  //
  // Three taps cannot see this and the first version of this test used three:
  // the cycle's third step is `done` again, so both the correct and the broken
  // build finish at 2 and the check passes either way. Mutation-testing the
  // rollback rule is what found it.
  for (const _ of [0, 1]) await tap(seeded.day1, 500);
  const offlineBox = await box(seeded.day1);
  await send('Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
  await sleep(2500);
  await ev(`navigator.onLine`);
  await sleep(2500);
  const afterFlush = await stored(seeded.day1);
  ck('two offline taps advance the cycle, rather than queueing the first twice',
     afterFlush !== null && afterFlush.value === 0,
     `cell showed ${JSON.stringify(offlineBox)}, server holds ${JSON.stringify(afterFlush)}`);

  /* ---------- paging, and forgetting where it was ---------- */

  console.log('--- paging ---');
  await openHabit();
  const stripRange = () => ev(`(() => {
    const c = [...document.querySelectorAll('#view-detail .card')]
      .find(c => c.querySelector('.card-title')?.textContent === 'Recent days');
    return c?.querySelector('.cal-range')?.textContent ?? '';})()`);
  const pageBack = () => ev(`(() => {
    const c = [...document.querySelectorAll('#view-detail .card')]
      .find(c => c.querySelector('.card-title')?.textContent === 'Recent days');
    const b = [...(c?.querySelectorAll('.cal-nav button') ?? [])]
      .find(b => b.textContent.includes('Earlier'));
    if (!b || b.disabled) return false;
    b.click(); return true;})()`);

  const atNow = await stripRange();
  ck('the strip has a range readout', atNow !== '', atNow);
  if (await pageBack()) {
    await sleep(900);
    const back = await stripRange();
    ck('‹ Earlier moves the strip back', back !== atNow, `${atNow} -> ${back}`);

    // Hiding the card must forget its position, exactly as the other paging
    // cards do — that is the whole of its `forget` entry in the CARDS map.
    //
    // Driven through the DIALOG, in the page, with no reload between. A
    // navigate would prove nothing: `open()` clears `state.chartOffsets`
    // wholesale whenever it is opening a habit that was not already open, so a
    // reload puts every card back at today whether `forget` exists or not.
    // Mutation-testing found this — dropping the `forget` entry passed a
    // version of this block that reloaded.
    const tickStrip = async (on) => {
      await ev(`document.getElementById('btn-settings').click()`);
      await waitUntil(ev, `document.getElementById('settings-dialog').open === true`,
        { what: 'the settings dialog' });
      await ev(`(() => { const b =
        document.getElementById('setting-detailCards-recentDays');
        b.checked = ${on}; b.dispatchEvent(new Event('change', { bubbles: true }));})()`);
      await ev(`document.getElementById('settings-close').click()`);
      await sleep(1600);
    };

    await tickStrip(false);
    ck('unticking it in the dialog removes it from the open habit',
       await stripRange() === '' && !(await titles()).includes('Recent days'),
       JSON.stringify(await titles()));

    await tickStrip(true);
    await waitUntil(ev, `!!document.querySelector('#view-detail .day-strip .check')`,
      { what: 'the strip to come back' });
    await sleep(500);
    ck('...and ticking it back reopens it at today, not where it was hidden',
       await stripRange() === atNow, `expected ${atNow}, got ${await stripRange()}`);
  } else {
    ck('the strip pages back', false, 'no Earlier button — fixture has too little history');
  }

  /* ---------- paging with nothing to fetch ---------- */

  console.log('--- paging, offline ---');
  // The claim: paging redraws the card from the entries the page already
  // holds, so it needs no request. What makes that visible is a press with
  // nothing to fetch. `page()` (ui/components.js) moves `state.chartOffsets`
  // BEFORE it calls `redraw`, so a `redraw` that refetches has committed the
  // position by the time the GET fails and `open()` toasts without rendering:
  // the strip stays put and the window jumps by a stride whenever something
  // next draws the card (#245).
  //
  // `Network.setBypassServiceWorker` is what makes "offline" mean it here, and
  // it is the load-bearing line of the block. Devtools offline emulation on
  // this session does NOT reach the WORKER's own fetches, so with the worker in
  // front both `/api/habits/:id/stats` and `/api/habits/:id/entries` come back
  // out of DATA_CACHE (`CACHEABLE_API`, sw.js) and `open()` succeeds — measured
  // against the unfixed code, where the strip then pages perfectly well and
  // every check below passes. That is why the offline block further up can get
  // away with the network conditions alone: only its WRITES have to fail, and
  // the worker returns early for every non-GET.
  //
  // Bypassing the worker is not a contrivance for the sake of the test. It is
  // the self-hoster on a plain-`http` LAN address, where `isSecureContext` is
  // false and there is no service worker at all, and it stands in equally for
  // the first offline boot after a `CACHE_VERSION` bump, which drops the data
  // cache and gets the worker's synthetic 503 (root CLAUDE.md).
  await send('Network.enable', {}, sessionId);

  /**
   * Where the card thinks it is, as opposed to what it drew. `page()` writes
   * this and `windowedChart` reads it, so it is one half of the disagreement
   * below; `stripRange()` is the other.
   */
  const stripOffset = () => ev(
    `(async () => (await import('/shared/ui/store.js')).state.chartOffsets.recentDays ?? null)()`);

  // The reference press, made with the network UP on this same page and this
  // same fixture — so the offline press is compared against a window this app
  // actually draws rather than against a date literal that would go stale
  // tomorrow.
  await openHabit();
  const atNowRef = await stripRange();
  await pageBack();
  await sleep(900);
  const pagedOnline = await stripRange();
  const offsetOnline = await stripOffset();
  ck('a reference press with the network up moves the strip one page back',
     pagedOnline !== '' && pagedOnline !== atNowRef && offsetOnline > 0,
     `${atNowRef} -> ${pagedOnline} (offset ${offsetOnline})`);

  // A fresh document, so `state.chartOffsets` starts empty again.
  await openHabit();
  const beforeOffline = await stripRange();
  await send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
  await send('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);

  const pressed = await pageBack();
  await sleep(1500);
  const afterPress = await stripRange();
  const offsetOffline = await stripOffset();
  ck('the offline ‹ Earlier press was made at all', pressed === true);

  // (a) The disagreement itself. Unfixed, the offset moves to exactly where an
  // online press puts it while the drawn window does not move at all — which
  // is the whole of the bug, since the next draw of the card obeys the offset.
  //
  // The first two conjuncts are ABSOLUTE, and they are what let the label above
  // be read as written: a comparison against the reference press alone is
  // satisfied by two windows that both stayed put, so anything breaking BOTH
  // presses equally would leave this green. `beforeOffline` is the readout on
  // THIS document, taken just before the network went — not `atNowRef`, which
  // belongs to the reference document.
  ck('offline, the position and the drawn window land on the same page the '
     + 'network-up press landed on',
     offsetOffline > 0 && afterPress !== beforeOffline
       && offsetOffline === offsetOnline && afterPress === pagedOnline,
     `offset ${offsetOffline} (online ${offsetOnline}), strip ${beforeOffline} `
     + `-> ${afterPress} (online ${pagedOnline})`);

  // (b) The same fault said the way a user meets it.
  ck('...so ‹ Earlier actually moves the strip with no network',
     afterPress !== beforeOffline, `${beforeOffline} -> ${afterPress}`);

  await send('Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
  await send('Network.setBypassServiceWorker', { bypass: false }, sessionId);
  await sleep(1500);

  /* ---------- focus survives the rebuild a tap causes ---------- */

  console.log('--- focus ---');
  await openHabit();
  // Whichever cell the strip is actually showing: the paging block above may
  // have left it scrolled back, and a hardcoded date would then be a null
  // dereference rather than a failed assertion about focus.
  const focusKept = await ev(`(async () => {
    const c = document.querySelector('#view-detail .day-strip .check[data-date]');
    c.focus();
    const before = document.activeElement?.dataset?.focusKey ?? null;
    c.click();
    await new Promise(r => setTimeout(r, 2500));
    return { before, after: document.activeElement?.dataset?.focusKey ?? null };
  })()`);
  ck('keyboard focus is still on the cell after the tap rebuilds the page',
     focusKept.after === focusKept.before && focusKept.before !== null,
     JSON.stringify(focusKept));

  /* ---------- a kept run reads as one band, not scattered ticks (#176) ---------- */

  console.log('--- in-run ticks ---');
  // `seeded.habit` (above) resolves to whichever boolean habit sorts first —
  // Meditate, logged daily — which never has an unlogged day inside its
  // window to test against. Gym is fetched by name for that reason: the
  // fixtures log it Mon/Wed/Fri, so every other weekday in the strip sits
  // inside its long on-pace run with no row of its own.
  const gym = await ev(`(async () => {
    const habits = await (await fetch('/api/habits')).json();
    return habits.find(h => h.name === 'Gym') ?? null;
  })()`);
  ck('the Gym fixture habit is present', !!gym, JSON.stringify(gym));

  if (gym) {
    await openHabit(gym.id);

    // The box's colour and background are CSS values — a hex habit colour,
    // `var(--grid-empty)` — so only the browser's OWN resolution of them is
    // safe to compare against; a literal rgb string is "a constant" the two
    // marks are not compared to.
    const cellStyle = (date) => ev(`(() => {
      const b = document.querySelector('${cellSel(date)} .check-box');
      if (!b) return null;
      const s = getComputedStyle(b);
      return { text: b.textContent.trim(), opacity: s.opacity, color: s.color,
               background: s.backgroundColor };
    })()`);
    const resolved = (cssValue) => ev(`(() => {
      const d = document.createElement('div');
      d.style.color = '${cssValue}';
      document.body.append(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    })()`);
    const gymColor = await resolved(gym.color);
    const emptyColor = await resolved('var(--grid-empty)');

    const visible = await ev(
      `[...document.querySelectorAll('#view-detail .day-strip .check[data-date]')]
        .map(el => el.dataset.date)`);
    const classified = visible.map((date) => (
      { date, dow: new Date(`${date}T12:00:00`).getDay() }));
    const loggedDow = new Set([1, 3, 5]); // Mon/Wed/Fri — fixtures.mjs's Gym schedule
    const logged = classified.filter((d) => loggedDow.has(d.dow));
    const unlogged = classified.filter((d) => !loggedDow.has(d.dow));
    ck('the visible strip holds both logged and unlogged Gym days to compare',
       logged.length >= 1 && unlogged.length >= 3,
       `logged=${logged.length} unlogged=${unlogged.length}`);

    const unloggedInRun = unlogged[0]?.date;
    const tapDate = unlogged[1]?.date;
    const storedZeroDate = unlogged[2]?.date;
    const loggedDay = logged[0]?.date;

    if (unloggedInRun) {
      const ghost = await cellStyle(unloggedInRun);
      ck('an unlogged day inside a kept run gets the faint tick, not a blank cell',
         ghost?.text === '✓', JSON.stringify(ghost));
      ck('...at ghost opacity (0.45)',
         Math.abs(parseFloat(ghost?.opacity ?? '0') - 0.45) < 0.01, JSON.stringify(ghost));
      ck("...in the habit's own colour", ghost?.color === gymColor,
         `${ghost?.color} vs ${gymColor}`);
      ck('...but its background is still the empty cell, not a filled one',
         ghost?.background === emptyColor, `${ghost?.background} vs ${emptyColor}`);

      if (loggedDay) {
        const filled = await cellStyle(loggedDay);
        ck('a logged day in the same strip is a solid tick',
           filled?.text === '✓', JSON.stringify(filled));
        ck("...on a background filled with the habit's colour — told apart from the "
           + 'ghost tick, not each compared to a constant',
           filled?.background === gymColor && filled?.background !== ghost?.background,
           `filled=${filled?.background} ghost=${ghost?.background} habit=${gymColor}`);
      }

      // `questionMarks` restored afterward — fixtures reset settings, but a
      // suite that leaks one poisons the next.
      await ev(`fetch('/api/settings', { method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questionMarks: true }) })`);
      await openHabit(gym.id);
      const withMarks = await cellStyle(unloggedInRun);
      ck('with questionMarks on, that same in-run day still reads the tick, not ?',
         withMarks?.text === '✓', JSON.stringify(withMarks));
      await ev(`fetch('/api/settings', { method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questionMarks: false }) })`);
      await openHabit(gym.id);

      // Decision 4: a STORED lapse (a real 0, not just an absent row) inside a
      // run is still on pace, so it gets the same faint tick — the boolean
      // branch's own `inRun` arm, distinct from the `value == null` one above.
      if (storedZeroDate) {
        await ev(`fetch('/api/habits/${gym.id}/entries/${storedZeroDate}', {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 0 }) })`);
        await openHabit(gym.id);
        const lapse = await cellStyle(storedZeroDate);
        ck('a stored lapse inside the same run still gets the tick, not a blank cell',
           lapse?.text === '✓' && lapse?.background === emptyColor && lapse?.color === gymColor,
           JSON.stringify(lapse));
      }

      // The wiring pin: tap a DIFFERENT unlogged day (adding a completion can
      // only help or preserve on-paceness, never break the run being asserted).
      // The write is held open first — same technique as "optimistic, not
      // hopeful" above — because the paint that draws this tick during a
      // request is `repaintCells`, and it is the ONLY consumer of the run set
      // `render()` computed: reading the cell only after the request settles
      // would pass even with that set dropped on the way in, since `refresh()`
      // rebuilds the card through `dayCells` with a freshly computed run set
      // regardless of what the optimistic paint drew in between.
      if (tapDate) {
        paused.length = 0;
        await send('Fetch.enable',
          { patterns: [{ urlPattern: `*/entries/${tapDate}`, requestStage: 'Request' }] },
          sessionId);
        await ev(`document.querySelector('${cellSel(tapDate)}').click()`);
        await sleep(700);
        const midFlight = await cellStyle(unloggedInRun);
        ck("while a DIFFERENT day's write is held in flight, the untouched in-run cell "
           + 'still reads the optimistic tick, not a blank one',
           paused.length > 0 && midFlight?.text === '✓' && midFlight?.color === gymColor
             && midFlight?.background === emptyColor
             && Math.abs(parseFloat(midFlight?.opacity ?? '0') - 0.45) < 0.01,
           `paused=${paused.length} ${JSON.stringify(midFlight)}`);

        for (const p of paused) {
          await send('Fetch.continueRequest', { requestId: p.requestId }, sessionId).catch(() => {});
        }
        await send('Fetch.disable', {}, sessionId);
        await sleep(1200);

        const stillGhost = await cellStyle(unloggedInRun);
        ck('after a tap settles and the card rebuilds, the in-run tick is still drawn',
           stillGhost?.text === '✓' && stillGhost?.color === gymColor
             && stillGhost?.background === emptyColor,
           JSON.stringify(stillGhost));
      }
    }

    // The `MIN_STREAK` gate: a probe habit with exactly one entry ~12 days ago
    // and a 3/7 frequency makes `onPaceSeries` a run of exactly 2 days (the
    // entry day plus the day after) — one below `MIN_STREAK` — so the day
    // after the entry must draw empty rather than a tick. Verified against
    // `/api/habits/:id/stats` rather than assumed.
    const localISO = (n) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        + `-${String(d.getDate()).padStart(2, '0')}`;
    };
    const probeEntryDate = localISO(12);
    const probeNextDate = localISO(11);
    const probe = await ev(`(async () => {
      const h = await (await fetch('/api/habits', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Strip run-length probe', type: 'boolean',
          freq_numerator: 3, freq_denominator: 7, color: '#3b82f6' }),
      })).json();
      await fetch('/api/habits/' + h.id + '/entries/${probeEntryDate}', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 2 }) });
      return h;
    })()`);
    ck('the run-length probe habit was created', !!probe?.id, JSON.stringify(probe));

    if (probe?.id) {
      const probeStats = await ev(
        `(async () => (await fetch('/api/habits/${probe.id}/stats')).json())()`);
      const streak = (probeStats?.streaks ?? []).find((s) => s.start === probeEntryDate);
      ck('the probe entry produced exactly a 2-day on-pace run, as onPaceSeries predicts',
         streak?.length === 2, JSON.stringify(streak ?? probeStats?.streaks));

      await openHabit(probe.id);
      const afterRun = await cellStyle(probeNextDate);
      ck('the day after a run below MIN_STREAK draws empty, not a tick',
         afterRun?.text === '' && afterRun?.background === emptyColor,
         JSON.stringify(afterRun));
    }

    // The Calendar card's "In a run" legend swatch has to describe THIS
    // window, not the habit's whole history — a run made entirely of LOGGED
    // days has every one of its dates in `streakDates(...)` and no blank
    // cell for the continuation stroke to land on, so a gate reading
    // `inRun.size > 0` shows the swatch over a grid with no marked cell at
    // all. Four consecutive days on a DAILY habit (freq 1/1) is what makes
    // this reachable cheaply: `onPaceSeries`'s trailing window is one day,
    // so nothing inside a daily streak is ever left unlogged — unlike Gym
    // above, whose 3/7 schedule fills its run with the very unlogged days
    // this suite uses to pin the tick itself.
    const closedRunDates = [13, 12, 11, 10].map(localISO); // oldest first
    const closedRun = await ev(`(async () => {
      const h = await (await fetch('/api/habits', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Strip closed-run probe', type: 'boolean',
          freq_numerator: 1, freq_denominator: 1, color: '#f59e0b' }),
      })).json();
      for (const d of ${JSON.stringify(closedRunDates)}) {
        await fetch('/api/habits/' + h.id + '/entries/' + d, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 2 }) });
      }
      return h;
    })()`);
    ck('the closed-run probe habit was created', !!closedRun?.id, JSON.stringify(closedRun));

    if (closedRun?.id) {
      const closedStats = await ev(
        `(async () => (await fetch('/api/habits/${closedRun.id}/stats')).json())()`);
      const closedStreak =
        (closedStats?.streaks ?? []).find((s) => s.start === closedRunDates[0]);
      ck('the four logged days form one streak at or above MIN_STREAK',
         closedStreak?.length >= 3, JSON.stringify(closedStreak ?? closedStats?.streaks));

      await openHabit(closedRun.id);

      // Read straight off the rendered page, not re-derived: `data-run-marks`
      // is the count `calendarChart` itself gave the continuation stroke, and
      // the legend is read the same way a user would — its text content.
      const calProbe = await ev(`(() => {
        const svg = document.querySelector('[aria-label="Completion calendar"]');
        const legend = [...document.querySelectorAll('#view-detail .card')]
          .find((c) => c.querySelector('.card-title')?.textContent === 'Calendar')
          ?.querySelector('.legend');
        return {
          runMarks: svg?.getAttribute('data-run-marks') ?? null,
          legendText: legend?.textContent ?? '',
        };
      })()`);
      ck('an all-logged streak draws zero run marks in this window',
         calProbe.runMarks === '0', JSON.stringify(calProbe));
      ck('...and the legend does not claim an "In a run" mark absent from the grid',
         !/In a run/.test(calProbe.legendText), JSON.stringify(calProbe));
    }
  }
} catch (e) {
  ck('suite ran to completion', false, e.message);
} finally {
  closeChrome(chrome);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL DAY-STRIP CHECKS PASSED');
process.exit(fails ? 1 : 0);
