/**
 * A write that cannot reach the server: what the app does, and how long it
 * waits before doing it.
 *
 * The failure this pins is not "the network is down" — that one rejects in
 * about 3ms and has always worked. It is the server that ACCEPTS the connection
 * and never answers: a stale tunnel, a container that has stopped serving, a
 * captive portal. Chrome puts no ceiling on that (measured still pending at
 * 300s), so the check-off lived in a promise, the outbox stayed empty, and the
 * app went on looking connected for as long as the tab stayed open.
 *
 * CDP `Fetch.requestPaused`, held and never continued, is the only way to
 * reproduce it. Devtools offline throttling does NOT: that is connection
 * refused, the fast case, and a suite written against it passes on a build with
 * none of this in it.
 *
 *   node shared/test/browser/hangcheck.mjs
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = 9256;

// The bound in ui/api.js, plus room for a slow machine to notice it.
const BOUND_MS = 10_000;
const SLACK_MS = 8_000;

const profile = mkdtempSync(join(tmpdir(), 'habhang-'));
const chrome = launchChrome(PORT, profile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (l, c, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' :: ' + e : ''}`);
  if (!c) fails++;
};

let ws, nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

/** Requests currently held open. Nothing ever continues them. */
const held = [];

try {
  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (evt) => {
    const m = JSON.parse(evt.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    if (m.method === 'Fetch.requestPaused') held.push(m.params.request);
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

  /** What the user can see, and what is actually stored. */
  const look = () => ev(`(async()=>{
    const outbox = await new Promise((res)=>{
      const r = indexedDB.open('habiterall-offline', 1);
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('outbox')) return res([]);
        const g = db.transaction('outbox','readonly').objectStore('outbox').getAll();
        g.onsuccess = () => res(g.result.map(i => i.method + ' ' + i.url));
        g.onerror = () => res([]);
      };
      r.onerror = () => res([]);
    });
    const vis = (id) => !!document.getElementById(id)?.offsetParent;
    return {
      outbox,
      bar: vis('offline-bar'),
      message: vis('offline-message'),
      badge: vis('pending-count'),
      badgeText: document.getElementById('pending-count').textContent,
    };
  })()`);

  await send('Page.navigate', { url: APP }, sessionId);
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
    await sleep(250);
  }
  const rows = await ev(`document.querySelectorAll('#grid .habit-row').length`);
  check('the dashboard loaded before anything was held', rows > 0, `rows=${rows}`);

  const before = await look();
  check('nothing queued and no strip to start with',
    before.outbox.length === 0 && !before.bar, JSON.stringify(before));

  /* ---- 1. a tap while the server accepts and never answers ---- */
  console.log('--- a write that hangs ---');

  // Everything the page asks for from here on is swallowed, including the
  // connectivity probe: this is a server that is up, listening, and mute.
  await send('Fetch.enable', {
    patterns: [
      { urlPattern: '*/api/*', requestStage: 'Request' },
      { urlPattern: '*/healthz*', requestStage: 'Request' },
    ],
  }, sessionId);

  await ev(`(()=>{
    const cells = [...document.querySelectorAll('.habit-row:first-child .check')];
    cells[cells.length - 1].click();
    return true;
  })()`);

  // While it is in flight nothing is durable — the bounded half of this issue.
  await sleep(2000);
  const during = await look();
  check('the write is still only a promise while the fetch is in flight',
    during.outbox.length === 0, JSON.stringify(during));

  await sleep(BOUND_MS + SLACK_MS - 2000);
  const after = await look();
  const write = held.find((r) => r.method === 'PUT');

  check('the attempt was given up on rather than waited out',
    after.outbox.length === 1, JSON.stringify(after.outbox));
  check('the check-off is in the outbox, so closing the tab cannot lose it',
    after.outbox[0]?.startsWith('PUT /api/habits/'), String(after.outbox[0]));
  check('the app says it is offline', after.bar && after.message,
    JSON.stringify({ bar: after.bar, message: after.message }));
  check('the queued-write count is visible, not hidden inside the banner',
    after.badge && /1 change/.test(after.badgeText), JSON.stringify(after.badgeText));
  check('the request really was held, not refused',
    !!write, `held: ${held.map((r) => r.method + ' ' + new URL(r.url).pathname).join(', ')}`);

  /* ---- 2. creating a habit is not abandoned ---- */
  console.log('--- POST /habits is exempt ---');

  // The one non-idempotent call on this path: aborting a create the server has
  // already begun, then replaying it from the outbox, is two habits. It is
  // driven through the app's own api() rather than a bare fetch, or the bound
  // under test would not be in the way at all.
  await ev(`(()=>{
    window.__create = 'pending';
    import('/shared/ui/api.js')
      .then((m) => m.api('/habits', {
        method: 'POST',
        body: JSON.stringify({ name: 'Held create', type: 'boolean' }),
      }))
      .then(() => { window.__create = 'resolved'; },
            (e) => { window.__create = 'rejected: ' + e.message; });
    return true;
  })()`);

  await sleep(BOUND_MS + SLACK_MS);
  const createState = await ev(`window.__create`);
  const afterCreate = await look();
  check('a create is left in flight rather than abandoned at the bound',
    createState === 'pending', String(createState));
  check('and so cannot be replayed into a second habit',
    !afterCreate.outbox.some((i) => i.startsWith('POST')),
    JSON.stringify(afterCreate.outbox));

  /* ---- 3. the server comes back ---- */
  console.log('--- recovery ---');

  // Disabling the domain releases everything held, so the server is simply
  // reachable again — no event fires, exactly as when a router recovers.
  await send('Fetch.disable', {}, sessionId);

  let recovered = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    recovered = await look();
    if (recovered.outbox.length === 0 && !recovered.bar) break;
  }
  check('the outbox drained on its own', recovered.outbox.length === 0,
    JSON.stringify(recovered.outbox));
  check('and the strip went away with it', !recovered.bar, JSON.stringify(recovered));

  // The whole point: the answer the user gave survived and reached the server.
  const [, , , habitId, , date] = new URL(write.url).pathname.split('/');
  const stored = await fetch(`${APP}/api/habits/${habitId}/entries`)
    .then((r) => r.json()).catch(() => []);
  check('the check-off that was held is now recorded on the server',
    stored.some?.((e) => e.date === date), `${habitId} ${date}`);
} finally {
  await closeChrome({ chrome, port: PORT, profile });
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
