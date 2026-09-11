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
 *  - Offline, a tap on a cell moves the CALENDAR card for the same day (#230).
 *    Invisible online for the same reason: `host.refresh()` rebuilds the whole
 *    page, so the earlier '...and so does the calendar card' check passes
 *    against a build whose `detailHost.repaint` never touches the calendar.
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
import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor, waitUntil,
} from './chrome.mjs';

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
  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate', { url: APP }, sessionId),
    what: 'the dashboard',
  });

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
    // That query is also what makes the JOINED wait below sound. The marker
    // `reloadAndWaitFor` sets cannot survive a document load, which is the
    // point of it — but it survives a SAME-document one, where the wait would
    // then never return. The unique query keeps every open cross-document.
    const url = `${APP}/?open=${++opens}#/habit/${id}`;
    await reloadAndWaitFor(ev, `!!document.querySelector('#view-detail ${expect}')`, {
      reload: () => send('Page.navigate', { url }, sessionId),
      what: `the detail page (${expect})`,
    });
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

  /**
   * How many writes are sitting in the outbox.
   *
   * Declared up here beside the other page readers rather than in the #230
   * block below, because both offline blocks guard on it now and a `const`
   * declared in the second is in its temporal dead zone in the first.
   */
  const queued = () => ev(
    `(async () => (await import('/shared/ui/store.js')).state.pending ?? 0)()`);

  /**
   * Come back online, and wait for the app to have NOTICED and to have DRAINED.
   *
   * This replaces `sleep(2500)` / a `navigator.onLine` read whose value was
   * thrown away / `sleep(2500)`, at both of the two places this suite
   * reconnects — five seconds of wall clock each, in the suite that is the
   * fleet's floor. Neither sleep was the post-action settle the root
   * CLAUDE.md exempts: that carve-out is for waiting to see something did NOT
   * happen, which has no predicate to poll, and both of these were waiting for
   * something to happen. The first was waiting for the app to notice the
   * network was back and the second for the outbox to empty, and each has one.
   *
   * ONE predicate covers both, because the second cannot be true before the
   * first: `watchConnectivity`'s `online` listener probes `/healthz`, reports
   * the transition, and `syncNow` then flushes the outbox and refreshes the
   * badge — so `state.pending === 0`, on a page that is holding a queued
   * write, is that whole sequence having run. `navigator.onLine` stays as the
   * first conjunct because it is what the discarded read was looking at, and
   * because it tells a failed emulation apart from a failed flush in the
   * message.
   *
   * A timeout is REPORTED rather than thrown, which is the one place this
   * departs from `waitUntil`'s usual shape. Throwing is right where the wait
   * is a precondition for the block after it; here the very next line is the
   * check this wait exists to make honest, and this file's `catch` turns any
   * throw into a single `suite ran to completion` FAIL — so a slow flush would
   * cost the paging blocks, the #245 offline paging block and every #176
   * ghost-tick check their own verdicts on a run that is already going to be
   * red. The message goes into that check's evidence instead, so the wait
   * still names what it wanted and nothing is swallowed.
   *
   * @returns {Promise<string>} '' when it drained, else why it did not
   */
  const reconnectAndDrain = () => send('Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId)
    .then(() => waitUntil(ev, `(async () => navigator.onLine === true
      && ((await import('/shared/ui/store.js')).state.pending ?? 0) === 0)()`,
      { what: 'the reconnect to be noticed and the outbox to drain' }))
    .then(() => '', (e) => ` — ${e.message}`);

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
  // The same guard the #230 block below already carries, for the same reason:
  // if the emulation ever fails open, both taps reach the server, the cycle is
  // advanced by two ordinary online writes and the check below passes having
  // tested nothing it claims to. Unreachable today — `Network.enable` and the
  // offline conditions are both set eight lines up — which is why this is one
  // line and not a block.
  const offlineQueued = await queued();
  ck('the two offline taps were queued rather than sent', offlineQueued >= 1,
     `${offlineQueued} in the outbox`);
  const drainedDay1 = await reconnectAndDrain();
  const afterFlush = await stored(seeded.day1);
  ck('two offline taps advance the cycle, rather than queueing the first twice',
     afterFlush !== null && afterFlush.value === 0,
     `cell showed ${JSON.stringify(offlineBox)}, server holds `
     + `${JSON.stringify(afterFlush)}${drainedDay1}`);

  /* ---------- offline, the calendar agrees with the strip (#230) ---------- */

  console.log('--- offline, the calendar follows the tap ---');
  // The strip and the Calendar card are two drawings of ONE pair of maps
  // (`entriesByDate` / `skipSet`, ui/detail.js), and a tap moves them before it
  // writes. Online nothing said so: `writeDay` ends in `host.refresh()`, a
  // refetch and a full rebuild, so the calendar caught up whether or not
  // `detailHost.repaint` had ever touched it — which is exactly what the
  // '...and so does the calendar card' check further up passes on. Offline
  // `api()` enqueues and THROWS, so that refetch is never reached, and the
  // grid went on painting the pre-tap day beside a strip cell for the same
  // date that had already flipped.
  //
  // Only a real browser can see it: the write has to reach `api()`'s offline
  // path, the tap is a real listener, and the assertion is the `fill` on an SVG
  // cell of a page the app rendered. The fake-DOM suites drive `charts.js`
  // directly and never run `ui/detail.js` at all.
  await ev(`fetch('/api/habits/${seeded.habit}/entries/${seeded.day3}',
    { method: 'DELETE' })`);
  await openHabit();

  // Scoped to the Calendar card by TITLE, never `document`: `windowedChart`
  // gives every paging card the same `.cal-nav` and `.cal-range` classes the
  // calendar uses, and Recent days is FIRST on the page — an unscoped query
  // finds the strip's nav and reports it as the calendar's.
  const calCard = `[...document.querySelectorAll('#view-detail .card')]
    .find(c => c.querySelector('.card-title')?.textContent === 'Calendar')`;
  const calFill = (date) => ev(`(() => {
    const r = ${calCard}?.querySelector('.cal-cell[data-date="${date}"]');
    return r ? (r.getAttribute('fill') ?? '') : null;})()`);
  const calRange = () => ev(
    `(${calCard}?.querySelector('.cal-range')?.textContent ?? '')`);
  const calPageBack = () => ev(`(() => {
    const b = [...(${calCard}?.querySelectorAll('.cal-nav button') ?? [])]
      .find(b => b.textContent.includes('Earlier'));
    if (!b || b.disabled) return false;
    b.click(); return true;})()`);
  // `state.calEnd` is where the card keeps its position, and #274 was this same
  // card committing one around a redraw that could fail. Read from the store
  // rather than inferred from the readout, because "did not move" and "was
  // never written" are the two halves of that bug and only one of them shows.
  const calEnd = () => ev(
    `(async () => (await import('/shared/ui/store.js')).state.calEnd ?? null)()`);

  // The habit's OWN colour, read from the API. A done day on a boolean habit is
  // `shade(color, 1)`, and `shade` returns its argument unchanged at `t >= 1` —
  // so this string is the whole expected fill, and asserting it is what makes
  // the check below about the two grids AGREEING rather than about the cell
  // being non-empty. Deliberately not `shade(habit.color, 1)` imported into the
  // page: `shade` is the function `charts.js` paints the cell with, so calling
  // it here would compare the implementation against itself and stay green if
  // its `t >= 1` branch ever changed. The four wrong answers this tells apart
  // are all reachable — `var(--surface-2)` (skip), `var(--danger)` (slipped),
  // `var(--grid-empty)` (untouched) and any `color-mix(...)` partial shade.
  const habitColor = await ev(`(async () => {
    const rows = await (await fetch('/api/habits')).json();
    return rows.find(h => h.id === ${seeded.habit})?.color ?? null;
  })()`);
  ck('the habit under test has a colour to expect in the grid',
     typeof habitColor === 'string' && habitColor.startsWith('#'),
     JSON.stringify(habitColor));

  const emptyBefore = await calFill(seeded.day3);
  const rangeBefore = await calRange();
  ck('the calendar draws the untouched day as an empty cell to start from',
     emptyBefore === 'var(--grid-empty)', JSON.stringify(emptyBefore));

  await send('Network.enable', {}, sessionId);
  await send('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);
  await tap(seeded.day3, 1500);

  const agreed = {
    strip: await box(seeded.day3),
    cal: await calFill(seeded.day3),
    outbox: await queued(),
    calEnd: await calEnd(),
    range: await calRange(),
  };

  // The guard that makes the next check mean what it claims. If the write had
  // reached the server, `host.refresh()` would have rebuilt the whole page and
  // the calendar would be right for a reason this block is not about — it
  // would then pass against a build with no calendar redraw in it at all. A
  // write sitting in the OUTBOX is what says the redraw was local.
  ck('the offline tap was queued rather than sent', agreed.outbox >= 1,
     JSON.stringify(agreed));
  ck('the strip cell flips, as it always did', agreed.strip === '✓',
     JSON.stringify(agreed));
  // The exact fill, not "something other than empty". The claim is that the two
  // grids AGREE about the day, and a cell painted the skip grey or the slipped
  // red disagrees with a strip cell reading ✓ just as loudly as an empty one —
  // so a change making `edit` add the date to `skipSet` alongside a plain done,
  // which is exactly the pair of structures moving together that this block
  // exists to protect, must not be able to sit green here. Same reasoning as
  // the #176 ghost-tick checks below, which tell two ✓ glyphs apart by colour
  // rather than accepting either.
  ck('...and offline the calendar cell for the SAME day flips with it, to the '
     + "habit's own colour",
     agreed.cal === habitColor,
     `${JSON.stringify(agreed)} expected ${JSON.stringify(habitColor)}`);
  ck('...having committed no calendar position of its own',
     agreed.calEnd === null && agreed.range === rangeBefore,
     `${JSON.stringify(agreed)} range before ${JSON.stringify(rangeBefore)}`);

  // The other half of the #274 trap, and it is a REGRESSION guard rather than
  // the biting check: unfixed there is no redraw, so nothing can move the
  // window and this passes either way. It is here because the cheap wrong fix
  // — redraw at `todayISO()` rather than at the STORED position — is invisible
  // in the block above, where there is no stored position and `draw` resolves
  // today anyway. Paging offline is local (#274), so the press needs no
  // network of its own, and it is what puts a position there to preserve.
  const calPaged = await calPageBack();
  await sleep(700);
  const pagedRange = await calRange();
  const pagedEnd = await calEnd();
  ck('the calendar pages back with no network, as #274 left it',
     calPaged === true && pagedRange !== rangeBefore && pagedEnd !== null,
     `${rangeBefore} -> ${pagedRange} (calEnd ${JSON.stringify(pagedEnd)})`);

  await tap(seeded.day2, 1500);
  const heldRange = await calRange();
  const heldEnd = await calEnd();
  ck('...and a tap redraws the STORED position rather than resetting it to '
     + 'today or committing a new one',
     heldRange === pagedRange && heldEnd === pagedEnd,
     `range ${pagedRange} -> ${heldRange}, calEnd `
     + `${JSON.stringify(pagedEnd)} -> ${JSON.stringify(heldEnd)}`);

  const drainedDay3 = await reconnectAndDrain();
  // The optimistic redraw is only honest if the write it drew actually lands,
  // which is the `unknowncheck.mjs` model this suite already follows: ask the
  // API what the row says rather than believing the cell.
  const day3Flushed = await stored(seeded.day3);
  ck('and the queued write lands on reconnect, so the redraw told the truth',
     day3Flushed !== null && day3Flushed.value === 2,
     `${JSON.stringify(day3Flushed)}${drainedDay3}`);

  /* ---------- offline, the notes card redraws with the tap (#297, review round) ---------- */

  console.log('--- offline, the notes card follows the note ---');
  // A dedicated probe with TWO notes already stored, so the card exists before
  // this block goes offline and stays up throughout — clearing one of the two
  // must not be confused with the card never having been built at all. Dates
  // ten-plus days back, untouched by any tap elsewhere in this file.
  const notesRedrawProbe = await ev(`(async () => {
    const h = await (await fetch('/api/habits', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Strip notes redraw probe', type: 'boolean',
        color: '#0ea5e9' }),
    })).json();
    const iso = n => { const d = new Date(); d.setDate(d.getDate() - n);
      return d.toISOString().slice(0, 10); };
    const kept = iso(10), toClear = iso(11), toAdd = iso(12);
    // YES is 2, and a boolean habit accepts ONLY 0, 2 or 3 (parseEntry) -- a
    // 1 here is a 400 and no row at all, which is a seed that fails in
    // silence and takes every assertion below with it. Hence the ok array: a
    // fixture this block's whole claim rests on has to say that it landed.
    // (No backticks in here: this whole source is a template literal.)
    const put = (date, body) => fetch('/api/habits/' + h.id + '/entries/' + date, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) }).then(r => r.ok);
    const ok = [
      await put(kept, { value: 2, notes: 'kept note' }),
      await put(toClear, { value: 2, notes: 'note to clear' }),
      await put(toAdd, { value: 2 }),
    ];
    return { id: h.id, kept, toClear, toAdd, seeded: ok.every(Boolean) };
  })()`);
  ck('the notes-redraw probe habit was created', !!notesRedrawProbe?.id,
     JSON.stringify(notesRedrawProbe));
  ck('...and all three of its seed rows actually landed',
     notesRedrawProbe?.seeded === true, JSON.stringify(notesRedrawProbe));

  if (notesRedrawProbe?.id) {
    await openHabit(notesRedrawProbe.id);

    const noteRowTexts = () => ev(`[...document.querySelectorAll(
      '#view-detail .notes-list .note-text')].map(e => e.textContent)`);
    const hasNoteMark = (date) => ev(
      `document.querySelector('${cellSel(date)} .check-box')`
      + `?.classList.contains('has-note') ?? null`);

    const beforeRows = await noteRowTexts();
    ck('the card starts with both notes, so it exists throughout this block',
       beforeRows.includes('kept note') && beforeRows.includes('note to clear'),
       JSON.stringify(beforeRows));

    await send('Network.enable', {}, sessionId);
    await send('Network.emulateNetworkConditions',
      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);

    /* ---------- clearing a note offline drops its row from the card ---------- */

    // Opened through the card's own row — a real click, since each row is a
    // `<button>` calling `detailHost.editDay` directly (#297), not a shortcut.
    await ev(`[...document.querySelectorAll('#view-detail .notes-list .note-row')]
      .find(r => r.querySelector('.note-text')?.textContent === 'note to clear')?.click()`);
    await sleep(600);
    const clearOpened = await ev(`document.getElementById('day-dialog').open`);
    ck('the day editor opens on the note to clear', clearOpened === true);
    await ev(`document.getElementById('day-notes').value = ''`);
    // Re-answers the day's own state (this habit is boolean, so "Done" is what
    // is already stored) — the same PUT a plain tap would make, with the note
    // now stated as cleared rather than left alone.
    await ev(`document.querySelector('#day-boolean .day-choice[data-action="done"]').click()`);
    await sleep(700);

    const afterClear = {
      rows: await noteRowTexts(),
      dot: await hasNoteMark(notesRedrawProbe.toClear),
      outbox: await queued(),
    };
    ck('the cleared note was queued rather than sent', afterClear.outbox >= 1,
       JSON.stringify(afterClear));
    ck('...and its row is gone from the notes card in the SAME repaint that '
       + "drops its dot from the strip — not left showing the old text",
       !afterClear.rows.includes('note to clear') && afterClear.dot === false,
       JSON.stringify(afterClear));
    ck('...while the OTHER note stays, which is the proof the card was '
       + 'REDRAWN rather than emptied outright',
       afterClear.rows.includes('kept note'), JSON.stringify(afterClear));

    /* ---------- adding a note offline, to a day that had none, draws a row ---------- */

    const addCentre = await ev(`(() => {
      const el = document.querySelector('${cellSel(notesRedrawProbe.toAdd)}');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    ck('the day with no note is on screen to be right-clicked', !!addCentre,
       JSON.stringify(addCentre));
    if (addCentre) {
      // A REAL right-click over CDP, not a scripted `dispatchEvent` — see the
      // note beside the later `rightClick` helper for why a synthetic one
      // proves nothing about the gesture this handler exists for.
      await send('Input.dispatchMouseEvent', { type: 'mousePressed',
        x: addCentre.x, y: addCentre.y, button: 'right', clickCount: 1 }, sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased',
        x: addCentre.x, y: addCentre.y, button: 'right', clickCount: 1 }, sessionId);
      await sleep(600);
      const addOpened = await ev(`document.getElementById('day-dialog').open`);
      ck('a contextmenu on the noteless day opens the day editor', addOpened === true);
      await ev(`document.getElementById('day-notes').value = 'a fresh offline note'`);
      await ev(`document.querySelector('#day-boolean .day-choice[data-action="done"]').click()`);
      await sleep(700);

      const afterAdd = {
        rows: await noteRowTexts(),
        dot: await hasNoteMark(notesRedrawProbe.toAdd),
        outbox: await queued(),
      };
      ck('the added note was queued rather than sent', afterAdd.outbox >= 1,
         JSON.stringify(afterAdd));
      ck('...and a row for it appears in the notes card, in the same repaint '
         + 'that lights its dot',
         afterAdd.rows.includes('a fresh offline note') && afterAdd.dot === true,
         JSON.stringify(afterAdd));
    }

    await reconnectAndDrain();
  }

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

  /* ---------- notes: the mark, and the two secondary ways into the editor (#297) ---------- */

  console.log('--- notes ---');
  // A dedicated probe habit rather than reusing `seeded.habit` — every block
  // above has already tapped and untapped it, and this needs a day whose NOTE
  // TEXT survives intact to be checked against, which no earlier state here
  // promises.
  const notesProbe = await ev(`(async () => {
    const h = await (await fetch('/api/habits', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Strip notes probe', type: 'boolean', color: '#22c55e' }),
    })).json();
    const iso = n => { const d = new Date(); d.setDate(d.getDate() - n);
      return d.toISOString().slice(0, 10); };
    const noted = iso(1), plain = iso(2);
    const noteText = 'left half a glass, felt fine';
    await fetch('/api/habits/' + h.id + '/entries/' + noted, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 2, notes: noteText }) });
    await fetch('/api/habits/' + h.id + '/entries/' + plain, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 2 }) });
    return { id: h.id, noted, plain, noteText };
  })()`);
  ck('the notes probe habit was created', !!notesProbe?.id, JSON.stringify(notesProbe));

  if (notesProbe?.id) {
    await openHabit(notesProbe.id);

    /* ---------- the mark ---------- */

    const cellHasNote = (date) => ev(
      `document.querySelector('#view-detail .day-strip .check[data-date="${date}"] .check-box')`
      + `?.classList.contains('has-note') ?? null`);
    ck('a note-bearing day carries the mark',
       await cellHasNote(notesProbe.noted) === true);
    ck('a day with an entry and no note does not',
       await cellHasNote(notesProbe.plain) === false);

    // The class alone is not the mark — `.check-box.has-note::after` draws it,
    // and a check reading only `classList` stays green with that whole rule
    // deleted (review round). Read the pseudo-element itself: `content` must
    // not be `'none'` and the drawn box must have real width.
    const notePseudo = (date) => ev(`(() => {
      const el = document.querySelector(
        '#view-detail .day-strip .check[data-date="${date}"] .check-box');
      if (!el) return null;
      const cs = getComputedStyle(el, '::after');
      return { content: cs.content, width: parseFloat(cs.width) };
    })()`);
    const notedPseudo = await notePseudo(notesProbe.noted);
    ck("the note-bearing day's dot is actually DRAWN, not merely classed",
       !!notedPseudo && notedPseudo.content !== 'none' && notedPseudo.width > 0,
       JSON.stringify(notedPseudo));
    const plainPseudo = await notePseudo(notesProbe.plain);
    // The negative half — what stops a rule drawing a dot on every cell from
    // passing the check above too.
    ck('...and the note-free day draws no pseudo-element at all',
       !!plainPseudo && plainPseudo.content === 'none', JSON.stringify(plainPseudo));

    /* ---------- the secondary affordance: contextmenu opens the editor, seeded truthfully ---------- */

    const cellCentre = (date) => ev(`(() => {
      const el = document.querySelector(
        '#view-detail .day-strip .check[data-date="${date}"]');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    // A REAL right-click, dispatched over CDP: a scripted `.click()` (or a
    // scripted `dispatchEvent(new MouseEvent('contextmenu'))`) proves nothing
    // about the gesture Android's long-press and a desktop right-click both
    // arrive as — see `shared/public/CLAUDE.md`'s note on `.click()` not
    // dispatching `pointerdown`, the same class of gap.
    const rightClick = async (x, y) => {
      await send('Input.dispatchMouseEvent',
        { type: 'mousePressed', x, y, button: 'right', clickCount: 1 }, sessionId);
      await send('Input.dispatchMouseEvent',
        { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 }, sessionId);
    };

    const notedCentre = await cellCentre(notesProbe.noted);
    ck('the note-bearing cell is on screen to be right-clicked', !!notedCentre,
       JSON.stringify(notedCentre));
    if (notedCentre) {
      // `e.preventDefault()` in the handler suppresses the browser's native
      // context menu, and a suppressed menu leaves no DOM signal of its own —
      // there is nothing to query afterwards that says "the native menu did
      // not open". A bubble-phase listener on `document`, installed BEFORE the
      // press, stands in for it: the button's own `contextmenu` handler runs
      // at the TARGET phase and calls `preventDefault()` there, so by the time
      // this listener sees the event in bubble phase, `e.defaultPrevented`
      // already reflects that call — `true` on a correct build, `false`
      // without it (measured by the lead removing the call; not a data
      // defect, but an unpinned claim of the same shape as #297's other one).
      await ev(`(() => {
        window.__ctxDefaultPrevented = null;
        document.addEventListener('contextmenu', (e) => {
          window.__ctxDefaultPrevented = e.defaultPrevented;
        }, false);
        return true;
      })()`);
      await rightClick(notedCentre.x, notedCentre.y);
      const ctxPrevented = await ev(`window.__ctxDefaultPrevented`);
      ck("the contextmenu's native menu was suppressed — the bubble-phase "
         + 'listener saw e.defaultPrevented === true',
         ctxPrevented === true, JSON.stringify(ctxPrevented));
      await sleep(600);
      const opened = await ev(`({
        open: document.getElementById('day-dialog').open,
        notes: document.getElementById('day-notes').value,
      })`);
      ck('a contextmenu on a note-bearing cell opens the day editor, with '
         + "#day-notes holding that day's real text",
         opened.open === true && opened.notes === notesProbe.noteText, JSON.stringify(opened));
      await ev(`document.getElementById('day-cancel').click()`);
      await sleep(400);
    }

    /* ---------- the secondary affordance: Shift+Enter, and it must not steal the cycle ---------- */

    // A REAL key event, dispatched by CDP rather than scripted from the page.
    // A `<button>`'s Enter activation is the browser's own behaviour on a
    // TRUSTED press, and suppressing it is exactly what the handler's
    // `preventDefault()` exists for — a `new KeyboardEvent('keydown')` fired
    // from script triggers no activation at all, so a check built on one would
    // pass against a build with no `preventDefault()` in it. Same trap, same
    // fix, as `categorycheck.mjs`'s Enter-inside-a-sub-form check.
    //
    // What the activation actually does, measured rather than reasoned: by the
    // time it runs, `showModal()` has moved focus into the dialog, so the
    // keypress lands on the day editor's own first `.day-choice` button and
    // clicks it — the editor is answered and dismissed by the same press that
    // opened it. That is what the `.day-choice` recorder below pins. The cell
    // underneath is behind a modal by then and never cycles, which is why the
    // stored-value check further down does NOT bite this mutation.
    const pressShiftEnter = async () => {
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', {
          type, key: 'Enter', code: 'Enter', modifiers: 8, // Shift
          windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          ...(type === 'keyDown' ? { text: '\r' } : {}),
        }, sessionId);
      }
    };

    const beforeShift = await stored(notesProbe.plain, notesProbe.id);
    // Record any click that reaches one of the day editor's own answer
    // buttons. Capture phase and on `document`, so it sees the press whether
    // or not the dialog is still open by the time anything is read back — the
    // failure mode is precisely that the dialog is gone again.
    await ev(`(() => {
      window.__choiceClicks = [];
      document.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('.day-choice'))
          window.__choiceClicks.push(e.target.textContent + ' trusted=' + e.isTrusted);
      }, true);
      return true; })()`);
    await ev(`document.querySelector(
      '#view-detail .day-strip .check[data-date="${notesProbe.plain}"]').focus()`);
    await pressShiftEnter();
    await sleep(600);
    const shiftOpened = await ev(`document.getElementById('day-dialog').open`);
    ck('Shift+Enter on a focused cell opens the day editor', shiftOpened === true);
    // THE mechanism assertion, and the one that names why `preventDefault` is
    // there. Without it the press falls through into the dialog it just
    // opened: focus is already inside by the time the browser runs the
    // button's Enter activation, so the keypress clicks the editor's first
    // answer button, saves and closes — one press, one unseen save, and
    // `saveDay` states the note on every save.
    const choiceClicks = await ev(`window.__choiceClicks`);
    ck('...and the same press does NOT fall through onto the editor\'s own '
       + 'answer buttons — no .day-choice was clicked',
       Array.isArray(choiceClicks) && choiceClicks.length === 0,
       JSON.stringify(choiceClicks));
    await sleep(800);
    const afterShift = await stored(notesProbe.plain, notesProbe.id);
    // A guard on a DIFFERENT regression from the one above, and it is worth
    // saying which: this does not bite a missing `preventDefault()`, because
    // the cell is behind a modal by the time the activation runs and so never
    // cycles (measured). What it does bite is `editDay` being wired onto the
    // plain click path, or the handler calling `onCheckClick` as well.
    ck("...and the day's stored value is UNCHANGED — the proof the secondary "
       + 'affordance did not also cycle the day underneath it',
       JSON.stringify(afterShift) === JSON.stringify(beforeShift),
       `${JSON.stringify(beforeShift)} -> ${JSON.stringify(afterShift)}`);
    await ev(`document.getElementById('day-cancel').click()`);
    await sleep(400);
  }
} catch (e) {
  ck('suite ran to completion', false, e.message);
} finally {
  // The whole shape `closeChrome` destructures, and awaited — this was the one
  // call site in the repo passing the ChildProcess on its own. Destructured
  // from that, `port` and `profile` are `undefined`: `askBrowserToClose` asks
  // `http://127.0.0.1:undefined/json/version` and its failure is swallowed by
  // design, `chrome?.pid` is undefined so the group kill never fires, and the
  // `--user-data-dir` is never removed. Only `launchChrome`'s `exit` handler
  // was actually killing this suite's browser, and nothing at all was removing
  // its profile — 11MB and 442 files, every run, measured.
  await closeChrome({ chrome, port: PORT, profile });
}

console.log(fails ? `\n${fails} FAILED` : '\nALL DAY-STRIP CHECKS PASSED');
process.exit(fails ? 1 : 0);
