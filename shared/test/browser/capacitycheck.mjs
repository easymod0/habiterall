/**
 * #285's WIRING, in a real browser under a locale override.
 *
 * `weekcheck.mjs` (offline, a fake DOM) proves `weekdayMonthReserve` is the
 * right number for the chart it describes. It cannot prove `detail.js` ever
 * calls it, or that `windowedChart` forwards what it is handed — "Pinning the
 * DECISION is not pinning the WIRING … assert the output that reached the
 * platform" (root CLAUDE.md). Neither `detail.js`'s card builders nor
 * `components.js`'s `windowedChart` are reachable from a fake DOM, so this
 * needs a server and a real Chrome.
 *
 * The locale is `pt-PT`, not the runner's own: its short weekday names
 * (`dom.`, `seg.`, `ter.`, …) measure a ~66px gutter against the shared 46px
 * default, which puts every width this suite tries under `MIN_SLOT.circle`
 * on the unfixed wiring — so this cannot be fragile about which 8px band a
 * viewport happens to land in, the way an en-US-only version of this would
 * be. `Emulation.setLocaleOverride` is set on a fresh target BEFORE anything
 * navigates, because `ui/dates.js` memoises its `Intl` formatters at first
 * call, and is verified to have actually taken — ICU falls back silently for
 * a name it does not know, which is exactly how a locale sweep comes to
 * prove nothing (`locales.mjs`'s own comment, and `label-widths.mjs`).
 *
 * The habit is seeded here, by Node `fetch` against `BASE`
 * (`responsive.mjs`'s `seedForSearch` shape) — never by growing
 * `fixtures.mjs`, which several suites assert counts or index rows against
 * positionally. One boolean daily habit, two entries ~1500 days apart:
 * `computeWeekdayByMonth` buckets every month the window spans, and every
 * weekday in every one of those months has `total > 0` (a rate of 0 still
 * draws an empty ring, `charts.js`'s `if (!d?.total) return;`), so the
 * "Weekday consistency" card has enough months to page through that its
 * column count is decided by CAPACITY, not by how much history exists.
 *
 * Needs a server, so it is NOT in `run.mjs`'s `OFFLINE_SUITES` — the runner
 * auto-discovers it with no registration needed.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor, waitUntil,
} from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
// Unused by any other suite — checked by grep before this was picked.
const PORT = devtoolsPort(9310);

/** Long enough weekday names to be wrong under every width this suite tries. */
const LOCALE = 'pt-PT';

const HABIT_NAME = 'capacitycheck seeded habit';

/** phone / phone / tablet / desktop — the same four `responsive.mjs` covers. */
const VIEWPORTS = [
  { label: 'small phone', w: 360, h: 740, mobile: true },
  { label: 'phone', w: 390, h: 844, mobile: true },
  { label: 'tablet', w: 768, h: 1024, mobile: true },
  { label: 'desktop', w: 1440, h: 900, mobile: false },
];

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const daysAgo = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return iso(d);
};

/**
 * One boolean daily habit, two answered days ~1500 days apart. That is all
 * that is needed: the window opens at the first entry, so it spans roughly
 * fifty months, and every weekday of every one of them has `total > 0`.
 *
 * Returns the number of month buckets the habit's own `/stats` reports, so
 * the "the window was saturated" check below has a real denominator rather
 * than a guessed one.
 */
async function seedHabit() {
  const created = await fetch(`${APP}/api/habits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: HABIT_NAME, type: 'boolean' }),
  });
  if (!created.ok) {
    throw new Error(`seeding the habit failed: ${created.status} ${await created.text()}`);
  }
  const habit = await created.json();

  for (const date of [daysAgo(1500), daysAgo(0)]) {
    const put = await fetch(`${APP}/api/habits/${habit.id}/entries/${date}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 2 }),   // YES
    });
    if (!put.ok) {
      throw new Error(`seeding the entry for ${date} failed: ${put.status} ${await put.text()}`);
    }
  }

  const stats = await (await fetch(`${APP}/api/habits/${habit.id}/stats`)).json();
  return { id: habit.id, monthCount: stats.weekdayByMonth?.length ?? 0 };
}

const profile = mkdtempSync(join(tmpdir(), 'habcap-'));
const chrome = launchChrome(PORT, profile);

let fails = 0;
const ck = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
  if (!cond) fails++;
};

let ws, nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

let targetId, sessionId;

/**
 * Every page-side string below is built with `+`, never a template literal —
 * a backtick anywhere in one, including inside a `//` comment, ends the
 * string early and leaves valid host code behind, which fails at runtime
 * naming an identifier that appears nowhere in the app rather than at
 * `node --check` time. See root CLAUDE.md and `docs/decisions/testing.md`.
 */
const findHabitRow =
  "[].slice.call(document.querySelectorAll('#grid .habit-row'))" +
  '.some(function(r){ return r.textContent.indexOf(' + JSON.stringify(HABIT_NAME) + ') !== -1; })';

const clickHabitRow =
  "(function(){ var rows=[].slice.call(document.querySelectorAll('#grid .habit-row'));" +
  ' var row=rows.find(function(r){ return r.textContent.indexOf(' + JSON.stringify(HABIT_NAME) + ') !== -1; });' +
  " if(!row) return false; var meta=row.querySelector('.habit-meta'); if(!meta) return false;" +
  ' meta.click(); return true; })()';

/** Scoped BY TITLE — `windowedChart` gives every paging card the same
 * `.cal-nav`/`.cal-range`, so an unscoped query reads whichever card is
 * highest on the page. */
const findCard =
  "var cards=[].slice.call(document.querySelectorAll('#view-detail .card'));" +
  " var card=null; for (var i=0;i<cards.length;i++){ var t=cards[i].querySelector('.card-title');" +
  " if (t && t.textContent==='Weekday consistency'){ card=cards[i]; break; } }";

const cardReady =
  '(function(){ ' + findCard +
  " if(!card) return false; var circles=[].slice.call(card.querySelectorAll('circle'));" +
  " var seen={}; var n=0; for (var j=0;j<circles.length;j++){ var v=circles[j].getAttribute('cx');" +
  ' if(!seen[v]){ seen[v]=true; n++; } } return n>=2; })()';

const readCard =
  '(function(){ ' + findCard +
  " if(!card) return null; var svg=card.querySelector('svg');" +
  " var circles=[].slice.call(card.querySelectorAll('circle'));" +
  ' var seen={}; var xs=[];' +
  " for (var j=0;j<circles.length;j++){ var v=circles[j].getAttribute('cx');" +
  ' if(!seen[v]){ seen[v]=true; xs.push(Number(v)); } }' +
  ' xs.sort(function(a,b){ return a-b; });' +
  " return { width: Number(svg.getAttribute('width')), cxs: xs, count: xs.length }; })()";

try {
  const { monthCount } = await seedHabit();
  ck('the seeded habit produced enough month buckets to page through',
    monthCount >= 2, `monthCount=${monthCount}`);

  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (msg) => {
    const m = JSON.parse(msg.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };

  ({ targetId } = await send('Target.createTarget', { url: 'about:blank' }));
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  const ev = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };

  // Set BEFORE anything navigates: `ui/dates.js` memoises its `Intl`
  // formatters at first call, and a fresh target has made no such call yet.
  await send('Emulation.setLocaleOverride', { locale: LOCALE }, sessionId);
  const resolvedLocale = await ev('new Intl.DateTimeFormat().resolvedOptions().locale');
  const localeTook = resolvedLocale === LOCALE;
  ck(`the locale override actually took (asked for ${LOCALE})`,
    localeTook, `resolved to ${resolvedLocale}`);

  if (!localeTook) {
    console.log('skipping the viewport checks: the locale did not take, so they would prove nothing '
      + '(ICU falls back silently for a name it does not know)');
  } else {
    await send('Page.enable', {}, sessionId);
    await send('Network.enable', {}, sessionId);
    await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);

    for (const vp of VIEWPORTS) {
      await send('Emulation.setDeviceMetricsOverride',
        { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile }, sessionId);

      await reloadAndWaitFor(ev, findHabitRow, {
        reload: () => send('Page.navigate', { url: APP }, sessionId),
        what: `the dashboard showing "${HABIT_NAME}" at ${vp.label}`,
      });

      const opened = await ev(clickHabitRow);
      if (!opened) {
        ck(`${vp.label}: the seeded habit's row was found and opened`, false);
        continue;
      }

      await waitUntil(ev, cardReady, {
        what: `the Weekday consistency card's circles, at ${vp.label}`,
      });

      const read = await ev(readCard);
      if (!read) {
        ck(`${vp.label}: the Weekday consistency card rendered`, false);
        continue;
      }

      const { width, cxs, count } = read;
      const deltas = cxs.slice(1).map((x, i) => x - cxs[i]);
      const colW = deltas.length ? Math.min(...deltas) : NaN;

      // The literal 22 (`MIN_SLOT.circle`), not the imported constant — a
      // test importing the constant it checks pins the name and nothing
      // else (root CLAUDE.md; see `weekcheck.mjs`'s own Check A).
      ck(`${vp.label} (pt-PT, ${width}px svg): the pitch clears MIN_SLOT.circle (22)`,
        count > 1 && colW >= 22,
        `colW=${Number.isFinite(colW) ? colW.toFixed(2) : colW}, count=${count}, cxs=${cxs.join(',')}`);

      // The denominator: if every seeded month drew its own column, the
      // window was never capacity-limited and the check above proves
      // nothing about this chart's reserve at all — an empty offender list
      // means nothing until the denominator is known (root CLAUDE.md).
      ck(`${vp.label}: the window was capacity-saturated, so the pitch check above is not vacuous`,
        count < monthCount,
        `drew ${count} columns of ${monthCount} seeded months`);
    }
  }

  console.log(fails === 0 ? '\nALL CAPACITY CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  try { if (sessionId) await send('Emulation.setLocaleOverride', {}, sessionId); } catch { /* best effort */ }
  try { if (targetId) await send('Target.closeTarget', { targetId }); } catch { /* best effort */ }
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
