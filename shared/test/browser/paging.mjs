/**
 * Paging back through the dashboard must bring the recorded history with it.
 *
 * Regression: /overview always returned the last N days ending today, so the
 * arrows re-rendered an empty grid — every past day looked unrecorded even
 * though the stats view showed the data.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = 9306;
const profile = mkdtempSync(join(tmpdir(), 'habpage-'));
const chrome = launchChrome(PORT, profile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ck = (l, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' :: ' + e : ''}`); if (!c) fails++; };
let ws, nid = 1;
const pend = new Map();
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
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: APP }, sessionId);
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
    await sleep(200);
  }
  await sleep(600);

  /** How many day cells across all rows show a recorded value. */
  const filled = () => ev(`(() => {
    const boxes = [...document.querySelectorAll('.check-box')];
    const marked = boxes.filter(b => {
      const cs = getComputedStyle(b);
      // A recorded day is either tinted or shows a number/glyph.
      const tinted = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                     cs.backgroundColor !== getComputedStyle(document.documentElement)
                       .getPropertyValue('--grid-empty').trim();
      return tinted || (b.textContent || '').trim() !== '';
    });
    return { total: boxes.length, marked: marked.length,
             range: document.querySelector('.grid-range')?.textContent };
  })()`);

  const now = await filled();
  ck('current window shows recorded days', now.marked > 0, JSON.stringify(now));

  // page back three windows; the fixtures cover 60 days, so history exists
  for (let i = 0; i < 3; i++) {
    await ev(`[...document.querySelectorAll('.grid-nav button')]
      .find(b => b.getAttribute('aria-label')?.startsWith('Previous')).click()`);
    await sleep(900);
  }
  const past = await filled();
  ck('a past window still shows recorded days', past.marked > 0, JSON.stringify(past));
  ck('the window actually moved', past.range !== now.range, `${now.range} -> ${past.range}`);

  // and the data must match what the API holds for that range
  const agree = await ev(`(async () => {
    const label = document.querySelector('.grid-range').textContent;
    const cells = [...document.querySelectorAll('.grid-date')].length;
    const habits = await (await fetch('/api/habits')).json();
    const entries = await (await fetch('/api/habits/' + habits[0].id + '/entries')).json();
    const shown = [...document.querySelectorAll('.habit-row:first-child .check')]
      .filter(c => (c.querySelector('.check-box').textContent || '').trim() !== '' ||
                   getComputedStyle(c.querySelector('.check-box')).backgroundColor !==
                     getComputedStyle(document.documentElement).getPropertyValue('--grid-empty').trim())
      .length;
    return { cells, storedEntries: entries.length, shown };
  })()`);
  ck('the first habit renders some of its stored history',
    agree.storedEntries > 0 && agree.shown > 0, JSON.stringify(agree));

  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b => b.textContent.trim() === 'Today')?.click()`);
  await sleep(900);
  const back = await filled();
  ck('Today returns to the current window', back.range === now.range, `${back.range}`);
  ck('and it still shows recorded days', back.marked > 0, JSON.stringify(back));

  console.log(fails === 0 ? '\nALL PAGING CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
