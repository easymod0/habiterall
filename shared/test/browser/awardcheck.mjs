/**
 * The awards row on the detail view.
 *
 * The arithmetic is pinned by `shared/test/awards.test.js`; what only a browser
 * can answer is the other half — that the client RENDERS the server's reading
 * and does not hold one of its own. So the checks here read the card and then
 * ask `/api/habits/:id/stats` for the same habit and compare: a label the page
 * shows that the response does not carry is a second opinion, which is the one
 * thing `shared/src/awards.js` exists to prevent.
 *
 * Two shapes only a rendered page has: a `permanent: false` award has to LOOK
 * different from a mark (a claim a future lapse can end must not read as a
 * medal), and the row has to fit a 360px card, which is where a grid of five
 * badges squeezes its labels to nothing.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000', PORT = 9319;
const profile = mkdtempSync(join(tmpdir(), 'habaward-'));
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

  const resize = (w) => send('Emulation.setDeviceMetricsOverride',
    { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 500 }, sessionId);

  await resize(1440);
  await send('Page.navigate', { url: APP }, sessionId);
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
    await sleep(250);
  }
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

  /** The whole card as rendered, plus the order of the cards around it. */
  const readCard = () => ev(`(()=>{
    const cards=[...document.querySelectorAll('#view-detail > .card')];
    const order=cards.map(c=>c.querySelector('.card-title')?.textContent.trim());
    const card=cards.find(c=>c.querySelector('.card-title')?.textContent.trim()==='Awards');
    const habit=document.querySelector('.detail-head h2')?.textContent.trim();
    if(!card) return {habit, order, card:false};
    const cw=card.getBoundingClientRect().width;
    const chips=[...card.querySelectorAll('.award')].map(a=>{
      const cs=getComputedStyle(a);
      return {
        id:a.getAttribute('data-award'),
        // The label's own text, without the "New" marker that shares the line —
        // the marker is a state of the award, not part of its name.
        label:a.querySelector('.award-label')?.firstChild?.textContent.trim(),
        detail:a.querySelector('.award-detail')?.textContent.trim(),
        record:a.classList.contains('is-record'),
        fresh:!!a.querySelector('.award-fresh'),
        accent:cs.borderLeftColor,
        w:Math.round(a.getBoundingClientRect().width),
        right:Math.round(a.getBoundingClientRect().right),
      };});
    return {habit, order, card:true, cw:Math.round(cw),
      right:Math.round(card.getBoundingClientRect().right),
      hints:[...card.querySelectorAll('.hint')].map(h=>h.textContent.trim()),
      chips};})()`);

  /** What the server says about the habit currently open. */
  const readApi = () => ev(`(async()=>{
    const id=location.hash.replace('#/habit/','');
    const r=await fetch('/api/habits/'+id+'/stats');
    const s=await r.json();
    return {id, awards:s.awards, bestStreak:s.bestStreak, score:s.score};})()`);

  const habits = await ev(
    `[...document.querySelectorAll('.habit-row .habit-name, .habit-row .name')].map(n=>n.textContent.trim())`);
  ck('the dashboard has habits to inspect', habits.length > 0, habits.join(', '));

  /* ---------- the card, on every fixture habit ---------- */

  console.log('\n--- the card ---');

  let withRecord = null, withFresh = null, seen = 0;

  for (let i = 0; i < habits.length; i++) {
    if (i > 0) await back();
    await open(i);
    const r = await readCard();
    const api = await readApi();

    if (!api.awards) {
      ck(`"${r.habit}" — the stats response carries an awards list`, false, 'missing');
      continue;
    }
    if (!api.awards.length) {
      ck(`"${r.habit}" earns nothing, so there is no empty card`, r.card === false,
        r.order.join(' > '));
      continue;
    }

    seen++;
    ck(`"${r.habit}" shows the card`, r.card === true, r.order.join(' > '));
    if (!r.card) continue;

    // The client renders the server's reading. Same awards, same order, same
    // words — anything else is a second opinion about the same history.
    ck('  every award the server sent is on the page',
      JSON.stringify(r.chips.map((c) => c.id)) === JSON.stringify(api.awards.map((a) => a.id)),
      r.chips.map((c) => c.id).join(', ') + '  vs  ' + api.awards.map((a) => a.id).join(', '));
    ck('  and it is wearing the server\'s words',
      r.chips.every((c, n) => c.label === api.awards[n].label
        && c.detail === api.awards[n].detail),
      r.chips.map((c) => c.label).join(' | '));

    ck('  no placeholder leaked into any of them',
      !r.chips.some((c) => /NaN|undefined|null|Infinity/.test(c.label + ' ' + c.detail)),
      r.chips.map((c) => c.label).join(' | '));
    ck('  every award has a detail line under its label',
      r.chips.every((c) => c.label && c.detail), JSON.stringify(r.chips.map((c) => c.label)));

    // The card sits UNDER the survival curve, never above it: `computeSurvival`
    // took the position that a probability beats a trophy, and this is the
    // ordering that keeps it.
    const iAwards = r.order.indexOf('Awards');
    const iResil = r.order.indexOf('Bouncing back');
    if (iResil >= 0) {
      ck('  the awards follow the "Bouncing back" card, not precede it',
        iAwards === iResil + 1, r.order.join(' > '));
    }

    ck('  no chip overflows the card', r.chips.every((c) => c.right <= r.right + 1),
      `card ${r.right}, widest chip ${Math.max(...r.chips.map((c) => c.right))}`);

    if (r.chips.some((c) => c.record)) withRecord = r;
    if (r.chips.some((c) => c.fresh)) withFresh = r;
  }

  ck('at least one fixture habit earned something', seen > 0, `${seen} of ${habits.length}`);

  /* ---------- a record is not a medal ---------- */

  console.log('\n--- a record is drawn as a record ---');

  ck('some habit has an award that a future lapse could end', withRecord != null,
    withRecord ? withRecord.habit : 'none');

  if (withRecord) {
    const record = withRecord.chips.find((c) => c.record);
    const mark = withRecord.chips.find((c) => !c.record);
    ck('  it is the one the server marked not permanent',
      record.id === 'lapses:single', record.id);
    ck('  and it does not wear the habit\'s accent',
      mark != null && record.accent !== mark.accent,
      `${record.accent} vs ${mark?.accent}`);
  }

  /* ---------- the one moment pure derivation can offer ---------- */

  console.log('\n--- a fresh comeback ---');

  // The fixtures put a recent one-day lapse on at least one habit. If they ever
  // stop, this says so rather than silently checking nothing.
  ck('a recent comeback is marked as new', withFresh != null,
    withFresh ? withFresh.habit : 'no fixture habit came back this week');

  /* ---------- narrow ---------- */

  console.log('\n--- 360px ---');

  await resize(360);
  await sleep(500);
  await back();
  await open(0);
  const narrow = await readCard();

  if (narrow.card) {
    ck('the row still fits the card on a phone',
      narrow.chips.every((c) => c.right <= narrow.right + 1),
      `card ${narrow.right}, widest ${Math.max(...narrow.chips.map((c) => c.right))}`);
    ck('and no badge was squeezed to nothing',
      narrow.chips.every((c) => c.w >= 120), narrow.chips.map((c) => c.w).join(' '));
  } else {
    console.log('SKIP  the first habit earns nothing at this width');
  }

  ck('no JavaScript errors', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));

} catch (err) {
  console.log('FAIL  harness error :: ' + err.message);
  fails++;
} finally {
  try { ws?.close(); } catch {}
  await closeChrome({ chrome, port: PORT, profile });
}

console.log(`\n${fails === 0 ? 'all award checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
