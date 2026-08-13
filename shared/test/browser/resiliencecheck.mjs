/**
 * The "Bouncing back" card: recovery rate, lapse lengths, survival curve.
 *
 * Also pins the detail-view card order — the calendar is what people come to
 * this page to look at and edit, so it belongs directly under the score
 * rather than below the analysis cards.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000', PORT = 9305;
const profile = mkdtempSync(join(tmpdir(), 'habresil-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ck = (l, c, e = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + l + (e ? ' :: ' + e : '')); if (!c) fails++; };
let ws, nid = 1; const pend = new Map(); const jsErrors = [];
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

try {
  let url;
  for (let i = 0; i < 60; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; if (url) break; } catch {}
    await sleep(250);
  }
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

    // The recovery tile is a percentage or an em dash — never NaN or "null".
    const rec = daily.tiles.find((t) => /Back next day|No misses/.test(t.label));
    ck('the recovery value is a percentage or a dash',
      /^(\d{1,3}%|—)$/.test(rec.value), rec.value);

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

  // For a 3x/week habit the four off-days are not failures, so day-level
  // recovery would report a perfectly-kept habit as lapsing every week.
  // Showing nothing is correct; showing a wrong number is not.
  let checkedNonDaily = false;
  for (let i = 0; i < habits.length; i++) {
    await back();
    await open(i);
    const isDaily = await ev(`(()=>{
      const sub=document.querySelector('.detail-head .habit-sub')?.textContent ?? '';
      return !/per week|times a week|\\/ *week|x *\\/ *7/i.test(sub);})()`);
    if (isDaily) continue;

    const r = await readCard();
    ck(`"${r.habit}" (non-daily) has no resilience card`, r.card === false,
      r.order.join(' > '));
    checkedNonDaily = true;
    break;
  }
  if (!checkedNonDaily) {
    console.log('SKIP  no non-daily habit in the fixtures to check');
  }

  ck('no JavaScript errors', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));

} catch (err) {
  console.log('FAIL  harness error :: ' + err.message);
  fails++;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fails === 0 ? 'all resilience checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
