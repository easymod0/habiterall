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
} catch (e) {
  ck('suite ran to completion', false, e.message);
} finally {
  closeChrome(chrome);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL DAY-STRIP CHECKS PASSED');
process.exit(fails ? 1 : 0);
