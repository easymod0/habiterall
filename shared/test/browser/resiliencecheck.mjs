/**
 * The "Bouncing back" card: recovery rate, lapse lengths, survival curve.
 *
 * Also pins the detail-view card order — the calendar is what people come to
 * this page to look at and edit, so it belongs directly under the score
 * rather than below the analysis cards.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor,
} from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000', PORT = devtoolsPort(9305);
const profile = mkdtempSync(join(tmpdir(), 'habresil-'));
const chrome = launchChrome(PORT, profile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ck = (l, c, e = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + l + (e ? ' :: ' + e : '')); if (!c) fails++; };
let ws, nid = 1; const pend = new Map(); const jsErrors = [];
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
    if (m.method === 'Runtime.exceptionThrown') {
      jsErrors.push(m.params.exceptionDetails?.exception?.description ?? 'unknown');
    }
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
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);

  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate', { url: APP }, sessionId),
    what: 'the dashboard',
  });
  await sleep(400);

  const open = async (i) => {
    await ev(`[...document.querySelectorAll('.habit-row .habit-name, .habit-row .name')][${i}]?.click()`);
    for (let k = 0; k < 40; k++) {
      if (await ev(`!!document.querySelector('[aria-label="Completion calendar"]')`).catch(() => 0)) break;
      await sleep(200);
    }
    await sleep(400);
  };
  const back = async () => {
    await ev(`document.querySelector('.detail-head button')?.click()`);
    await sleep(350);
  };

  /** Everything the card is showing, or {card:false} when it is absent. */
  const readCard = () => ev(`(()=>{
    const cards=[...document.querySelectorAll('#view-detail > .card')];
    const order=cards.map(c=>c.querySelector('.card-title')?.textContent.trim());
    const card=cards.find(c=>c.querySelector('.card-title')?.textContent.trim()==='Bouncing back');
    const habit=document.querySelector('.detail-head h2')?.textContent.trim();
    if(!card) return {habit, order, card:false};
    const cw=card.getBoundingClientRect().width;
    return {habit, order, card:true,
      tiles:[...card.querySelectorAll('.stat-tile')].map(t=>({
        value:t.querySelector('.stat-value').textContent.trim(),
        label:t.querySelector('.stat-label').textContent.trim()})),
      subheads:[...card.querySelectorAll('.card-subhead')].map(h=>h.textContent.trim()),
      hints:[...card.querySelectorAll('.hint')].map(h=>h.textContent.trim()),
      charts:[...card.querySelectorAll('svg')].map(s=>({
        label:s.getAttribute('aria-label'),
        w:Math.round(s.getBoundingClientRect().width),
        h:Math.round(s.getBoundingClientRect().height)})),
      overflows:[...card.querySelectorAll('svg')].some(s=>s.getBoundingClientRect().width > cw+1),
    };})()`);

  const habits = await ev(
    `[...document.querySelectorAll('.habit-row .habit-name, .habit-row .name')].map(n=>n.textContent.trim())`);
  ck('the dashboard has habits to inspect', habits.length > 0, habits.join(', '));

  /* ---------- card order ---------- */

  console.log('\n--- card order ---');

  await open(0);
  const first = await readCard();

  const iCal = first.order.indexOf('Calendar');
  const iStreaks = first.order.indexOf('Best streaks');
  const iScore = first.order.indexOf('Habit strength');

  ck('the calendar comes before best streaks', iCal < iStreaks,
    first.order.join(' > '));
  ck('the calendar sits directly under habit strength', iCal === iScore + 1,
    first.order.join(' > '));

  /* ---------- the card itself ---------- */

  console.log('\n--- the card ---');

  // Find a daily habit — a non-daily one has no card by design.
  let daily = null;
  for (let i = 0; i < habits.length; i++) {
    if (i > 0) { await back(); await open(i); }
    const r = await readCard();
    if (r.card) { daily = r; break; }
  }

  ck('at least one habit shows the card', daily != null,
    daily ? daily.habit : 'none of ' + habits.join(', '));

  if (daily) {
    const iResil = daily.order.indexOf('Bouncing back');
    ck('the card follows best streaks',
      iResil === daily.order.indexOf('Best streaks') + 1, daily.order.join(' > '));

    const labels = daily.tiles.map((t) => t.label);
    ck('a recovery figure is shown',
      labels.some((l) => /Back next day|No misses/.test(l)), labels.join(', '));
    ck('the longest lapse is shown', labels.includes('Longest lapse'), labels.join(', '));
    ck('the average lapse is shown', labels.includes('Average lapse'), labels.join(', '));

    // The recovery tile is a percentage or an em dash — never NaN or "null".
    const rec = daily.tiles.find((t) => /Back next day|No misses/.test(t.label));
    ck('the recovery value is a percentage or a dash',
      /^(\d{1,3}%|—)$/.test(rec.value), rec.value);

    // A one-decimal figure with a trailing "d", or an em dash — never NaN,
    // an integer with no decimal, or "null".
    const avg = daily.tiles.find((t) => t.label === 'Average lapse');
    ck('the average lapse value is a one-decimal figure or a dash',
      /^(\d+\.\dd|—)$/.test(avg.value), avg.value);

    // Agreement with the payload the page was actually drawn from — the same
    // `/api/habits/:id/stats` call `detail.js` made, read from the page so
    // the id in the URL is the habit that is actually open. Both values are
    // printed unconditionally: a comparison whose operands are not in the
    // output is one a reader cannot check, and if this fixture habit happens
    // to have `averageLength === null` the check would otherwise be vacuous.
    const payloadAvg = await ev(
      "(async function(){ var id=(location.hash.match(/#\\/habit\\/(\\d+)/)||[])[1];" +
      " var s=await (await fetch('/api/habits/'+id+'/stats')).json();" +
      ' return s.resilience.recovery.averageLength; })()'
    );
    const expectedTile = payloadAvg == null ? '—' : payloadAvg.toFixed(1) + 'd';
    ck('the tile agrees with the stats payload',
      avg.value === expectedTile,
      'payload averageLength=' + JSON.stringify(payloadAvg) + ' (expects ' + expectedTile +
      '), tile shows ' + avg.value);

    ck('both sections are present',
      daily.subheads.includes('How long lapses last') &&
      daily.subheads.includes('How far streaks get'),
      daily.subheads.join(' | '));

    ck('both charts rendered', daily.charts.length === 2,
      daily.charts.map((c) => c.label).join(' | '));
    ck('the charts fill the card without overflowing', daily.overflows === false,
      daily.charts.map((c) => `${c.w}px`).join(' '));
    ck('neither chart collapsed to zero height',
      daily.charts.every((c) => c.h > 20), daily.charts.map((c) => c.h).join(' '));

    ck('the lead explains what the card adds',
      daily.hints.some((h) => h.includes('after a miss')), daily.hints[0] ?? '');
    ck('no placeholder values leaked into the text',
      !daily.hints.some((h) => /NaN|undefined|null|Infinity/.test(h)),
      daily.hints.join(' | '));
  }

  /* ---------- non-daily habits ---------- */

  console.log('\n--- non-daily habits ---');

  // This card used to be withheld from non-daily habits, because a miss meant
  // "a day it was not done" and a 3x/week habit has four of those every week —
  // a perfectly-kept habit would have read as lapsing continuously. A miss is
  // now a day the habit fell below its RATE, which is a real failure at any
  // frequency, so the card belongs here too.
  let checkedNonDaily = false;
  for (let i = 0; i < habits.length; i++) {
    await back();
    await open(i);
    const isDaily = await ev(`(()=>{
      const sub=document.querySelector('.detail-head .habit-sub')?.textContent ?? '';
      return !/per week|times a week|\\/ *week|x *\\/ *7/i.test(sub);})()`);
    if (isDaily) continue;

    const r = await readCard();
    ck(`"${r.habit}" (non-daily) shows the resilience card`, r.card === true,
      r.order.join(' > '));
    ck('and it sits in the same place as on a daily habit',
      r.order.indexOf('Bouncing back') === r.order.indexOf('Best streaks') + 1,
      r.order.join(' > '));
    ck('with real figures, not placeholders',
      !r.hints.some((h) => /NaN|undefined|null|Infinity/.test(h)),
      r.hints.join(' | '));

    // The same two checks the daily block runs, now against a NON-daily
    // habit: the tile's shape, and its agreement with the payload the page
    // was drawn from. Both hold whichever value Gym has on the day they run,
    // which is exactly why they are the two that belong here — see the note
    // below for what deliberately is not pinned on this habit.
    const avgTile = r.tiles.find((t) => t.label === 'Average lapse');
    ck('its average lapse value is a one-decimal figure or a dash',
      /^(\d+\.\dd|—)$/.test(avgTile?.value ?? ''), avgTile?.value ?? '(missing)');

    // Agreement with the payload the page was actually drawn from, the same
    // shape as the daily block above: fetch the same `/api/habits/:id/stats`
    // call `detail.js` made, for the habit currently open (its id read out of
    // the URL, not assumed).
    const payloadAvg = await ev(
      "(async function(){ var id=(location.hash.match(/#\\/habit\\/(\\d+)/)||[])[1];" +
      " var s=await (await fetch('/api/habits/'+id+'/stats')).json();" +
      ' return s.resilience.recovery.averageLength; })()'
    );
    const expectedTile = payloadAvg == null ? '—' : payloadAvg.toFixed(1) + 'd';
    ck('the tile agrees with the stats payload',
      avgTile?.value === expectedTile,
      'payload averageLength=' + JSON.stringify(payloadAvg) + ' (expects ' + expectedTile +
      '), tile shows ' + (avgTile?.value ?? '(missing)'));

    // The shape check above accepts EITHER a figure or a dash, so on its own
    // it cannot tell whether this fixture is exercising the null branch. It
    // cannot be pinned here: Gym is 3/7, and `onPaceSeries` pro-rates the
    // requirement over its first `den - 1` days, so whether Gym carries a
    // closed lapse depends on which weekday the window opens on — a habit
    // whose lapse structure depends on the calendar cannot carry that
    // assertion. The null branch is pinned instead on a purpose-built daily
    // habit in the seeded section at the end, which has no pro-rating window
    // and so no weekday dependence; do not re-add a calendar-dependent
    // assertion here.

    checkedNonDaily = true;
    break;
  }
  if (!checkedNonDaily) {
    console.log('SKIP  no non-daily habit in the fixtures to check');
  }

  /* ---------- average lapse: the DECISION, not merely its presence ---------- */

  console.log('\n--- average lapse (mean vs median) ---');

  // None of the standing fixtures can tell a mean from a median apart:
  // Meditate misses every 9th day, so every lapse is exactly one day and
  // mean = median = 1. Built here instead, at the end so it cannot perturb
  // any assertion above — a habit created through the API lands last by
  // `position`, so `open(0)` and the habit loops above are unaffected.
  // Closed lapses [1, 1, 1, 1, 10]: mean 2.8, median 1, longest 10, rate 4/5.
  const AVG_NAME = 'resiliencecheck average lapse';
  const isoDate = (d) =>
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  const daysAgo = (n) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return isoDate(d);
  };

  // Habits created in this section, tracked outside the `try` so the
  // `finally` below can delete whichever of them actually got created even
  // when a later step throws — a throw here used to unwind straight past
  // the DELETE at the bottom, leaking the habit for the rest of a
  // standalone run (`run.mjs`'s `fixtures.reset()` sweeps it between
  // suites, so the leak is invisible there and only bites a hand run).
  let avgHabitId = null;
  let nullHabitId = null;

  try {
    const createExpr =
      "(async function(){ var res = await fetch('/api/habits', { method: 'POST'," +
      " headers: { 'Content-Type': 'application/json' }," +
      ' body: JSON.stringify({ name: ' + JSON.stringify(AVG_NAME) + ", type: 'boolean' }) });" +
      " if (!res.ok) return { error: 'create failed: ' + res.status + ' ' + (await res.text()) };" +
      ' var h = await res.json(); return { id: h.id }; })()';
    const created = await ev(createExpr);
    if (created.error) throw new Error(created.error);
    avgHabitId = created.id;

    // x.x.x.x.x..........x, oldest day first at daysAgo(19), newest at
    // daysAgo(0) — only the 'x' days get a PUT, a '.' day gets no row at all.
    const PATTERN = 'x.x.x.x.x..........x';
    for (let i = 0; i < PATTERN.length; i++) {
      if (PATTERN[i] !== 'x') continue;
      const date = daysAgo(PATTERN.length - 1 - i);
      const putExpr =
        "fetch('/api/habits/" + avgHabitId + '/entries/' + date + "', " +
        "{ method: 'PUT', headers: { 'Content-Type': 'application/json' }," +
        ' body: JSON.stringify({ value: 2 }) }).then(function(r){ return r.ok; })';
      const ok = await ev(putExpr);
      if (!ok) throw new Error('seeding ' + date + ' failed');
    }

    await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
      reload: () => send('Page.navigate', { url: APP }, sessionId),
      what: 'the dashboard, after seeding the average-lapse habit',
    });
    await sleep(400);

    const findAvgIdx =
      "[].slice.call(document.querySelectorAll('.habit-row .habit-name, .habit-row .name'))" +
      '.findIndex(function(n){ return n.textContent.trim() === ' + JSON.stringify(AVG_NAME) + '; })';
    const avgIdx = await ev(findAvgIdx);
    ck('the average-lapse habit is on the dashboard', avgIdx >= 0, 'index ' + avgIdx);

    if (avgIdx >= 0) {
      await open(avgIdx);
      const avgCard = await readCard();
      ck('its card is present', avgCard.card === true, JSON.stringify(avgCard.order));

      if (avgCard.card) {
        const tileVal = (label) => avgCard.tiles.find((t) => t.label === label)?.value;
        // Three literals, worth the twenty lines of setup: 2.8d fails under a
        // median implementation (1.0d), under Math.round (3d), and if the
        // tile were wired to worstLapse/longest instead (10d).
        ck('Back next day is 80%', tileVal('Back next day') === '80%',
          String(tileVal('Back next day')));
        ck('Longest lapse is 10d', tileVal('Longest lapse') === '10d',
          String(tileVal('Longest lapse')));
        ck('Average lapse is 2.8d', tileVal('Average lapse') === '2.8d',
          String(tileVal('Average lapse')));
      }
    }

    /* ---------- average lapse: the null case ---------- */

    console.log('\n--- average lapse: the null case ---');

    // The non-daily block above can only ever check the SHAPE of the null
    // case, because Gym (3/7) has `onPaceSeries` pro-rating its requirement
    // over the first `den - 1` days of the window, so whether it carries a
    // closed lapse depends on which weekday the window opens on. A daily
    // habit (num >= den) has no pro-rating window at all, so it is built
    // here instead: five completed days then today left unlogged is an OPEN
    // lapse and no closed one, so `recovery.averageLength` is null on every
    // day of the week. It lands after the average-lapse habit for the same
    // reason that one lands last — created through the API, by `position`,
    // so nothing above is perturbed.
    const NULL_NAME = 'resiliencecheck null lapse';
    const createNullExpr =
      "(async function(){ var res = await fetch('/api/habits', { method: 'POST'," +
      " headers: { 'Content-Type': 'application/json' }," +
      ' body: JSON.stringify({ name: ' + JSON.stringify(NULL_NAME) + ", type: 'boolean' }) });" +
      " if (!res.ok) return { error: 'create failed: ' + res.status + ' ' + (await res.text()) };" +
      ' var h = await res.json(); return { id: h.id }; })()';
    const createdNull = await ev(createNullExpr);
    if (createdNull.error) throw new Error(createdNull.error);
    nullHabitId = createdNull.id;

    // xxxxx., oldest day first at daysAgo(5), newest (today) at daysAgo(0) —
    // today gets no PUT at all, so it is unlogged rather than a stated miss.
    const NULL_PATTERN = 'xxxxx.';
    for (let i = 0; i < NULL_PATTERN.length; i++) {
      if (NULL_PATTERN[i] !== 'x') continue;
      const date = daysAgo(NULL_PATTERN.length - 1 - i);
      const putExpr =
        "fetch('/api/habits/" + nullHabitId + '/entries/' + date + "', " +
        "{ method: 'PUT', headers: { 'Content-Type': 'application/json' }," +
        ' body: JSON.stringify({ value: 2 }) }).then(function(r){ return r.ok; })';
      const ok = await ev(putExpr);
      if (!ok) throw new Error('seeding ' + date + ' failed');
    }

    await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
      reload: () => send('Page.navigate', { url: APP }, sessionId),
      what: 'the dashboard, after seeding the null-lapse habit',
    });
    await sleep(400);

    const findNullIdx =
      "[].slice.call(document.querySelectorAll('.habit-row .habit-name, .habit-row .name'))" +
      '.findIndex(function(n){ return n.textContent.trim() === ' + JSON.stringify(NULL_NAME) + '; })';
    const nullIdx = await ev(findNullIdx);
    ck('the null-lapse habit is on the dashboard', nullIdx >= 0, 'index ' + nullIdx);

    if (nullIdx >= 0) {
      await open(nullIdx);
      const nullCard = await readCard();
      // `buildResilienceCard` needs `hasLapses || hasStreaks`; `hasLapses` is
      // true here because `openRun > 0` even with no closed lapse.
      ck('its card is present', nullCard.card === true, JSON.stringify(nullCard.order));

      if (nullCard.card) {
        const tileVal = (label) => nullCard.tiles.find((t) => t.label === label)?.value;
        ck('Average lapse is the dash, not a figure',
          tileVal('Average lapse') === '—', String(tileVal('Average lapse')));
        // Deliberate, not a bug this change introduces: `worstLapse` counts
        // the OPEN run (see `shared/CLAUDE.md`) while `recovery.averageLength`
        // does not, so this habit shows a 1d longest lapse beside a dashed
        // average — the exact pair the issue describes as reading oddly.
        ck('Longest lapse counts the open run',
          tileVal('Longest lapse') === '1d', String(tileVal('Longest lapse')));

        const payloadAvg = await ev(
          "(async function(){ var id=(location.hash.match(/#\\/habit\\/(\\d+)/)||[])[1];" +
          " var s=await (await fetch('/api/habits/'+id+'/stats')).json();" +
          ' return s.resilience.recovery.averageLength; })()'
        );
        ck('and the payload states the same null denominator',
          payloadAvg === null,
          'payload averageLength=' + JSON.stringify(payloadAvg));
      }
    }
  } finally {
    // Cleanup is not what this suite is testing, so a failed DELETE is
    // reported rather than turned into a `ck` failure — but reported, not
    // discarded, since a silent leak is exactly finding 2's hazard.
    //
    // Each delete is guarded on its OWN, because a throw in here would
    // REPLACE whatever the block above threw: `ev` raises on a CDP
    // `exceptionDetails`, which is what a rejected in-page `fetch` produces,
    // so the one condition likeliest to break the seeding — a degraded server
    // or connection — is also the one likeliest to break the cleanup. The run
    // still fails either way, but the diagnostic naming WHICH seed step failed
    // is the thing worth keeping.
    for (const [id, what] of [[avgHabitId, 'average-lapse'], [nullHabitId, 'null-lapse']]) {
      if (id == null) continue;
      const where = 'cleanup: DELETE /api/habits/' + id + ' (' + what + ' habit)';
      try {
        const ok = await ev(
          "fetch('/api/habits/" + id + "', { method: 'DELETE' })" +
          '.then(function(r){ return r.ok; })');
        if (!ok) console.log(where + ' did not come back ok');
      } catch (err) {
        console.log(where + ' threw :: ' + err.message);
      }
    }
  }

  ck('no JavaScript errors', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));

} catch (err) {
  console.log('FAIL  harness error :: ' + err.message);
  fails++;
} finally {
  try { ws?.close(); } catch {}
  await closeChrome({ chrome, port: PORT, profile });
}

console.log(`\n${fails === 0 ? 'all resilience checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
