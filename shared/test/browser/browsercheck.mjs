/**
 * Drives headless Chrome against the running app via the DevTools Protocol
 * and inspects COMPUTED styles — the thing a fake DOM cannot verify.
 *
 * Verifies the day editor shows exactly one control set per habit type.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeChrome, launchChrome } from './chrome.mjs';
const BASE = process.env.BASE ?? 'http://localhost:3000';
const PORT = 9223;

const profile = mkdtempSync(join(tmpdir(), 'habchrome-'));
const chrome = launchChrome(PORT, profile);

let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await res.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools did not become available');
}

let ws, nextId = 1;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function main() {
  const wsUrl = await getWsUrl();
  const { WebSocket } = await import('node:worker_threads').then(() => import('ws')).catch(() => ({}));

  // Node 22 has a global WebSocket — no dependency needed.
  ws = new globalThis.WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    }
    return r.result.value;
  };

  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: BASE }, sessionId);

  // Wait for the dashboard to finish its first render.
  for (let i = 0; i < 80; i++) {
    const ready = await evaluate(`!!document.querySelector('#grid .habit-row')`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }

  console.log('--- page loaded ---');
  check('dashboard rendered habits',
    await evaluate(`document.querySelectorAll('#grid .habit-row').length > 0`));

  // The CSS guard must exist and actually apply.
  check('[hidden] resolves to display:none', await evaluate(`
    (() => {
      const p = document.createElement('p');
      p.className = 'hint'; p.hidden = true;
      document.body.append(p);
      const d = getComputedStyle(p).display;
      p.remove();
      return d;
    })()
  `) === 'none');

  // Open a MEASURABLE habit and click a calendar cell.
  const openType = async (wantNumeric) => {
    const want = wantNumeric ? 'numerical' : 'boolean';

    // Always start from a closed dialog on the dashboard, so we can never
    // read a stale dialog left open by the previous case.
    await evaluate(`
      (() => {
        const d = document.getElementById('day-dialog');
        if (d.open) d.close();
      })()
    `);
    await send('Page.navigate', { url: BASE }, sessionId);
    for (let i = 0; i < 80; i++) {
      if (await evaluate(`!!document.querySelector('#grid .habit-row')`).catch(() => false)) break;
      await sleep(200);
    }

    const openedName = await evaluate(`
      (async () => {
        const data = await (await fetch('/api/overview?days=7')).json();
        const target = data.habits.find(h => h.type === '${want}');
        const idx = data.habits.findIndex(h => h.id === target.id);
        const rows = [...document.querySelectorAll('#grid .habit-row')];
        rows[idx].querySelector('.habit-meta').click();
        return target.name;
      })()
    `);
    console.log(`    (opened ${want} habit: ${openedName})`);

    for (let i = 0; i < 60; i++) {
      if (await evaluate(`!!document.querySelector('#view-detail svg[aria-label="Completion calendar"] rect[cursor="pointer"]')`)) break;
      await sleep(200);
    }
    // Click a past day in the calendar.
    await evaluate(`
      (() => {
        const cells = [...document.querySelectorAll('#view-detail svg[aria-label="Completion calendar"] rect[cursor="pointer"]')];
        cells[Math.max(0, cells.length - 10)].dispatchEvent(new MouseEvent('click', {bubbles:true}));
      })()
    `);
    await sleep(300);
    return evaluate(`
      (() => {
        const vis = (id) => {
          const el = document.getElementById(id);
          if (!el) return 'missing';
          const cs = getComputedStyle(el);
          return (cs.display !== 'none' && !el.hidden) ? 'visible' : 'hidden';
        };
        return {
          dialogOpen: document.getElementById('day-dialog').open,
          title:   document.getElementById('day-title').textContent,
          boolean: vis('day-boolean'),
          numeric: vis('day-numeric'),
          save:    vis('day-save'),
          sub:     document.getElementById('day-sub').textContent,
        };
      })()
    `);
  };

  console.log('--- measurable habit ---');
  const num = await openType(true);
  check('dialog opened from a calendar click', num.dialogOpen === true, JSON.stringify(num));
  check('measurable: amount field VISIBLE', num.numeric === 'visible', num.numeric);
  check('measurable: Done/Not-done HIDDEN', num.boolean === 'hidden', num.boolean);
  check('measurable: Save visible', num.save === 'visible', num.save);
  check('measurable: target shown in subtitle', /target/.test(num.sub), num.sub);

  console.log('--- yes/no habit ---');
  const bool = await openType(false);
  check('dialog opened from a calendar click', bool.dialogOpen === true, JSON.stringify(bool));
  check('yes/no: Done/Not-done VISIBLE', bool.boolean === 'visible', bool.boolean);
  check('yes/no: amount field HIDDEN', bool.numeric === 'hidden', bool.numeric);
  check('yes/no: Save hidden', bool.save === 'hidden', bool.save);
  check('yes/no: no target in subtitle', !/target/.test(bool.sub), bool.sub);

  console.log(fails === 0 ? '\nALL BROWSER CHECKS PASSED' : `\n${fails} BROWSER CHECK(S) FAILED`);
}

try {
  await main();
} catch (e) {
  console.error('ERROR:', e.message);
  fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails === 0 ? 0 : 1);
}
