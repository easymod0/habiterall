/**
 * A day that ends after midnight (#76), in a real browser.
 *
 * `dayEndsAt` moves which DATE the app treats as today while the wall clock is
 * short of it. The rule itself is pinned in `dates.test.js`, `nudge.test.js` and
 * `outbox.test.js`; what only a browser can see is the wiring around it —
 * the last grid column the dashboard actually draws, the date a tap actually
 * PUTs to, the header that really goes out (including on a replayed write), and
 * whether changing the setting repaints a page that is already open.
 *
 * **The clock is moved with `Emulation.setTimezoneOverride`**, as
 * `gridcheck.mjs`'s "local midnight" block does, and for the same reason: it
 * changes the renderer's zone and so what `new Date()` reports, which is the
 * question `todayISO()` asks. No fake timer. A zone whose local hour is 1 to 4
 * is found at run time among the `Etc/GMT` ones — there is always one, since
 * they cover every offset — and VERIFIED in the page, because an override that
 * did not take would put this suite on the calendar day and every check below
 * would pass for the wrong reason.
 *
 * The boundary is 06:00, so any local hour from 1 to 4 is before it with room
 * to spare for the length of the run. The suite prefers hours 2 and 3.
 *
 * **Requests are recorded from the page's own `fetch`**, wrapped in a
 * new-document script, not from the Network domain: the page is under a service
 * worker, and what is being asserted is what the APP sent. The shim keeps no
 * backticks in its source — it is interpolated into a template literal on the
 * way to the browser.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor, waitUntil,
} from './chrome.mjs';
import { LOCAL_ISO_SRC, habitsByName, reset, useBase } from './fixtures.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9331);
useBase(APP);

const profile = mkdtempSync(join(tmpdir(), 'habboundary-'));
const chrome = launchChrome(PORT, profile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' :: ' + extra : ''));
  if (!cond) fails++;
};

let ws;
let nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++;
  pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

const END = '06:00';
const HEADER = 'x-habiterall-day-end';

/**
 * Every `fetch` the page makes, with the headers it was given.
 *
 * NOTE: no backticks anywhere in here, comments included — this string is one
 * template literal.
 */
const RECORDER = `
  window.__reqs = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    const src = (init && init.headers) || (input && input.headers) || {};
    const headers = {};
    if (typeof src.forEach === 'function' && !Array.isArray(src)) {
      src.forEach(function (v, k) { headers[String(k).toLowerCase()] = v; });
    } else {
      Object.keys(src).forEach(function (k) { headers[k.toLowerCase()] = src[k]; });
    }
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    window.__reqs.push({ url: url, method: method, headers: headers });
    return realFetch(input, init);
  };

  // Long timers, recorded as an absolute instant, for the day watches. The
  // callback is the platform's own and is still handed on untouched.
  const realSetTimeout = window.setTimeout;
  window.__armed = [];
  window.setTimeout = function (fn, ms) {
    const rest = Array.prototype.slice.call(arguments, 2);
    if (typeof fn === 'function' && Number(ms) >= 1000) {
      window.__armed.push({ at: Date.now() + Number(ms) });
    }
    return realSetTimeout.apply(window, [fn, ms].concat(rest));
  };
`;

try {
  await reset();
  const named = await habitsByName();
  const meditate = named['Meditate'];
  const gym = named['Gym'];

  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
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
  await send('Network.enable', {}, sessionId);

  /* ---------- put the browser on a clock that is before the boundary ---------- */

  console.log('--- a zone whose local hour is before the boundary ---');

  // `Etc/GMT-5` is UTC+5: the sign is inverted. Zero is left out (it canonicalises
  // to UTC, which tells nobody anything), and the list is every offset the zones
  // have, so some zone is at each hour of the day.
  const candidates = [];
  for (let off = -12; off <= 14; off++) {
    if (off === 0) continue;
    candidates.push(off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`);
  }
  const hourIn = (zone) => Number(new Intl.DateTimeFormat('en-GB',
    { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  // Closest to 02:30 first, so the suite has the most room on both sides.
  const ranked = candidates
    .map((zone) => ({ zone, hour: hourIn(zone) }))
    .filter((c) => c.hour >= 1 && c.hour <= 4)
    .sort((a, b) => Math.abs(a.hour - 2.5) - Math.abs(b.hour - 2.5));

  let zone = null;
  let verified = null;
  for (const c of ranked) {
    await send('Emulation.setTimezoneOverride', { timezoneId: c.zone }, sessionId);
    const seen = await ev(`({ hour: new Date().getHours(),
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone })`);
    if (seen.hour >= 1 && seen.hour <= 4 && seen.zone === c.zone) {
      zone = c.zone;
      verified = seen;
      break;
    }
  }
  ck('a zone was found whose local hour is 1-4, and the page agrees it is',
    zone !== null, zone ? `${zone}, hour ${verified.hour} in the page` : 'none of the Etc/GMT zones took');
  if (!zone) throw new Error('no usable zone; nothing below can mean anything');

  // Calendar today in that zone, and the day before it — which is what the app
  // must call today until 06:00. Both from the page's own clock, on the local
  // calendar, through the one spelling the fixtures share.
  const { calendar, boundaryDay } = await ev(`(() => { ${LOCAL_ISO_SRC}
    return { calendar: iso(0), boundaryDay: iso(1) }; })()`);
  ck('the two days differ, so there is something to tell apart',
    calendar !== boundaryDay && calendar > boundaryDay, `${calendar} / ${boundaryDay}`);

  /* ---------- the app at the default boundary ---------- */

  await send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER }, sessionId);
  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate', { url: APP }, sessionId),
    what: 'the dashboard at the default boundary',
  });

  const lastColumn = () => ev(`(() => {
    const cells = [...document.querySelectorAll('#grid .habit-row .check[data-date]')];
    return cells.map(c => c.getAttribute('data-date')).sort().at(-1) ?? null; })()`);
  const loadedEnd = () => ev(
    `(async () => (await import('/shared/ui/store.js')).state.gridLoaded?.end ?? null)()`);
  const reqs = () => ev('window.__reqs');
  const header = (r) => r.headers[HEADER];

  console.log('\n--- at midnight, nothing moved ---');
  ck('the last column is the calendar date', await lastColumn() === calendar,
    `${await lastColumn()} expected ${calendar}`);
  const firstLoad = (await reqs()).filter((r) => /\/api\/overview/.test(r.url));
  ck('the dashboard load carried the day-end header, at the default too',
    firstLoad.length >= 1 && firstLoad.every((r) => header(r) === '00:00'),
    JSON.stringify(firstLoad.map(header)));

  // The two days this suite taps, cleared first so a tap has somewhere to go
  // that does not depend on what the fixtures happened to seed for them.
  for (const h of [meditate, gym]) {
    await ev(`fetch('/api/habits/${h.id}/entries/${boundaryDay}', { method: 'DELETE' })
      .then(r => r.status)`);
  }

  /* ---------- changing the setting in the dialog, with no reload ---------- */

  console.log('\n--- changing it in the dialog repaints the open page ---');
  // Set BEFORE the change: if the document were replaced the marker would go,
  // and a "repaint" that was really a reload would be counted as one.
  await ev('window.__sameDocument = true; true');

  await ev(`document.getElementById('btn-settings').click()`);
  await waitUntil(ev, `document.getElementById('settings-dialog').open === true`,
    { what: 'the settings dialog to open' });
  const picked = await ev(`(() => {
    const s = [...document.querySelectorAll('#settings-body select')]
      .find((s) => [...s.options].some((o) => o.value === '${END}'));
    if (!s) return false;
    s.value = '${END}';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return s.value; })()`);
  ck('the dialog offers "My day ends at"', picked === END, JSON.stringify(picked));
  await ev(`document.getElementById('settings-close').click()`);

  // The WINDOW the server answered with is the half a repaint cannot move:
  // `paint()` resolves `todayISO()` itself, so the columns would walk on over a
  // fortnight whose newest column the server was never asked about.
  const refetched = await waitUntil(ev, `(async () => {
    const { state } = await import('/shared/ui/store.js');
    return state.gridLoaded?.end === '${boundaryDay}'; })()`,
    { what: 'the grid to be refetched for the previous day', timeoutMs: 10_000 })
    .then(() => true, () => false);
  ck('the grid is refetched for the previous day, not merely repainted',
    refetched === true, `window ends ${await loadedEnd()} expected ${boundaryDay}`);
  ck('...and its last column is that day', await lastColumn() === boundaryDay,
    `${await lastColumn()} expected ${boundaryDay}`);
  ck('...with no reload', await ev('window.__sameDocument === true') === true);
  const afterChange = (await reqs()).filter((r) => /\/api\/overview/.test(r.url)).at(-1);
  ck('the refetch said where the day ends', header(afterChange) === END,
    JSON.stringify(afterChange));

  await waitUntil(ev, `document.getElementById('settings-dialog').open === false`,
    { what: 'the dialog to close' });

  // The day watches re-arm for the NEW boundary: a timer aimed at the next local
  // midnight would fire at the wrong moment for ever, and `visibilitychange` only
  // covers a tab somebody looks at. Compared as an absolute instant against the
  // next 06:00 on the page's own clock (a few seconds either side, since the
  // watches add one).
  const sixAm = await ev(`(() => {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const remaining = ((6 * 60 - mins) * 60 - now.getSeconds()) * 1000
      - now.getMilliseconds();
    const wanted = Date.now() + remaining + 1000;
    const hits = window.__armed.filter((t) => Math.abs(t.at - wanted) <= 4000);
    return { hits: hits.length, remaining, armed: window.__armed.length }; })()`);
  ck('a day watch is armed for the next 06:00, not the next midnight',
    sixAm.hits >= 1, JSON.stringify(sixAm));

  /* ---------- a tap lands on that day ---------- */

  console.log('\n--- the last column is the previous local date, and a tap writes to it ---');
  const mark = (await reqs()).length;
  const cell = (habit) => `[data-focus-key="check:${habit.id}:${boundaryDay}"]`;
  ck('the last column has a cell for each habit',
    await ev(`!!document.querySelector('${cell(meditate)}')`) === true);
  await ev(`document.querySelector('${cell(meditate)}').click()`);
  await waitUntil(ev, `window.__reqs.slice(${mark}).some(r => r.method === 'PUT'
    && r.url.indexOf('/entries/${boundaryDay}') !== -1)`,
  { what: 'the tap to be written' });

  const tap = (await reqs()).slice(mark)
    .find((r) => r.method === 'PUT' && r.url.includes('/entries/'));
  ck('the tap PUTs to the previous local date',
    tap?.url === `/api/habits/${meditate.id}/entries/${boundaryDay}`, JSON.stringify(tap));
  ck('...carrying the boundary on the request', header(tap) === END, JSON.stringify(tap?.headers));
  ck('...and the zone, which the write guard still judges by',
    tap?.headers['x-habiterall-timezone'] === zone, JSON.stringify(tap?.headers));

  const stored = await ev(`(async () => {
    const rows = await (await fetch('/api/habits/${meditate.id}/entries')).json();
    const list = Array.isArray(rows) ? rows : (rows.entries ?? []);
    return list.find((e) => e.date === '${boundaryDay}') ?? null; })()`);
  ck('the server stored it under that day, not refused it as a future one',
    stored !== null && Number(stored.value) > 0, JSON.stringify(stored));

  /* ---------- a write queued offline replays WITH the header ---------- */

  console.log('\n--- a write made offline is replayed with the boundary ---');
  await send('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);
  await ev(`document.querySelector('${cell(gym)}').click()`);
  const queued = await waitUntil(ev, `(async () => {
    const { pendingCount } = await import('/shared/offline.js');
    return (await pendingCount()) >= 1; })()`,
    { what: 'the write to be queued', timeoutMs: 15_000 }).then(() => true, () => false);
  ck('the tap was queued rather than lost', queued === true);

  // Everything before this index is the attempt that failed; everything after
  // it is `flush()`, which rebuilds the request from the queued record and has
  // to add the header itself.
  const replayFrom = (await reqs()).length;
  await send('Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
  await ev(`window.dispatchEvent(new Event('online')); true`);
  const drained = await waitUntil(ev, `(async () => {
    const { pendingCount } = await import('/shared/offline.js');
    return (await pendingCount()) === 0; })()`,
    { what: 'the outbox to drain', timeoutMs: 20_000 }).then(() => true, () => false);
  ck('the outbox drained', drained === true);

  const replayed = (await reqs()).slice(replayFrom)
    .find((r) => r.method === 'PUT' && r.url.includes(`/entries/${boundaryDay}`));
  ck('the replay is a PUT to the previous local date',
    replayed?.url === `/api/habits/${gym.id}/entries/${boundaryDay}`, JSON.stringify(replayed));
  ck('...and carries the boundary', header(replayed) === END, JSON.stringify(replayed?.headers));
  const gymStored = await ev(`(async () => {
    const rows = await (await fetch('/api/habits/${gym.id}/entries')).json();
    const list = Array.isArray(rows) ? rows : (rows.entries ?? []);
    return list.find((e) => e.date === '${boundaryDay}') ?? null; })()`);
  ck('...and the server kept it (a 400 would have dropped it from the queue)',
    gymStored !== null && Number(gymStored.value) > 0, JSON.stringify(gymStored));

  /* ---------- the habit's own page ---------- */

  console.log('\n--- an open habit page follows the setting ---');
  await ev(`document.querySelector('.habit-row .habit-name, .habit-row .name')?.click()`);
  await waitUntil(ev, `!!document.querySelector('#view-detail .card')`,
    { what: 'the habit page to open' });

  // The detail calendar's own idea of today, which is a separate line from the
  // dashboard's (`realToday` in `calendarChart`): it decides which cells are
  // still editable, so a boundary it does not know about leaves the app's
  // today undrawn-as-future, or, worse, draws the calendar's tomorrow as a
  // day somebody can tap. A future cell has no role at all; a pickable one is
  // a gridcell, so the role IS the answer. Found by the date each rect carries.
  const cellRole = (date) => ev(`(() => {
    const svg = document.querySelector('#view-detail [aria-label="Completion calendar"]');
    if (!svg) return 'no calendar';
    const rect = [...svg.querySelectorAll('rect[data-date]')]
      .find((r) => r.getAttribute('data-date') === '${date}');
    return rect ? (rect.getAttribute('role') ?? 'none') : 'not drawn'; })()`);
  await waitUntil(ev, `!!document.querySelector(
    '#view-detail [aria-label="Completion calendar"] rect[data-date]')`,
  { what: 'the detail calendar to be drawn' });
  ck('at 06:00 the calendar date is drawn as a future day, with no gridcell role',
    await cellRole(calendar) === 'none', `${calendar}: ${await cellRole(calendar)}`);
  ck('...and the previous date, which is the app\'s today, is a gridcell',
    await cellRole(boundaryDay) === 'gridcell', `${boundaryDay}: ${await cellRole(boundaryDay)}`);

  const detailMark = (await reqs()).length;

  // Straight through the settings cache, not the dialog: the dialog also emits
  // 'change', which makes this view refetch on its own account and would hide a
  // missing listener. An applier is the only thing that hears this.
  await ev(`(async () => { (await import('/shared/ui/settings.js')).set('dayEndsAt', '00:00'); })()`);
  const rebuilt = await waitUntil(ev, `window.__reqs.slice(${detailMark}).some(
    r => /\\/stats/.test(r.url))`,
  { what: 'the habit page to be refetched', timeoutMs: 10_000 }).then(() => true, () => false);
  ck('ending the day at midnight again makes an open habit page refetch',
    rebuilt === true);
  const stats = (await reqs()).slice(detailMark).find((r) => /\/stats/.test(r.url));
  ck('...saying so on the request', stats !== undefined && header(stats) === '00:00',
    JSON.stringify(stats));

  // And back at midnight the calendar date is today again, so it is a cell
  // somebody can tap. Waited for rather than read, because the page repaints
  // after the refetch above.
  const reopened = await waitUntil(ev, `(() => {
    const svg = document.querySelector('#view-detail [aria-label="Completion calendar"]');
    const rect = svg && [...svg.querySelectorAll('rect[data-date]')]
      .find((r) => r.getAttribute('data-date') === '${calendar}');
    return !!rect && rect.getAttribute('role') === 'gridcell'; })()`,
  { what: 'the calendar date to become a gridcell again', timeoutMs: 10_000 })
    .then(() => true, () => false);
  ck('at 00:00 the calendar date is a gridcell again', reopened === true,
    `${calendar}: ${await cellRole(calendar)}`);

  // Put the account back, for whoever runs next on this instance. `reset()`
  // clears settings too, but a suite that leaves its mark is one that fails
  // somewhere else.
  await ev(`(async () => { (await import('/shared/ui/settings.js')).set('dayEndsAt', '00:00'); })()`);
  await sleep(300);

  console.log(fails === 0 ? '\nALL DAY BOUNDARY CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
