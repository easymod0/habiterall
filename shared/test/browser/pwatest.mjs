/**
 * Verifies the PWA in a real browser: service worker registration, offline
 * shell, the write outbox, and sync-on-reconnect.
 *
 * Offline is simulated with CDP Network.emulateNetworkConditions, which cuts
 * the browser off from the network exactly as a lost connection would.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';
const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = 9250;

const profile = mkdtempSync(join(tmpdir(), 'habpwa-'));
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
  await send('Network.enable', {}, sessionId);

  const setOffline = (offline) => send('Network.emulateNetworkConditions', {
    offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  }, sessionId);

  const goto = async (u) => { await send('Page.navigate', { url: u }, sessionId); await sleep(1500); };

  /* ---- 1. service worker registers ---- */
  console.log('--- service worker ---');
  await goto(APP);
  await sleep(4000);

  const sw = await ev(`(async()=>{
    const r = await navigator.serviceWorker.getRegistration();
    return { registered: !!r, scope: r?.scope, active: !!r?.active, state: r?.active?.state };
  })()`);
  check('service worker registered', sw.registered === true, JSON.stringify(sw));
  check('scope covers the whole origin', sw.scope?.endsWith('/'), sw.scope);
  check('worker is active', sw.state === 'activated', String(sw.state));

  const manifest = await ev(`(async()=>{
    const link = document.querySelector('link[rel=manifest]');
    if (!link) return null;
    const r = await fetch(link.href);
    return r.ok ? await r.json() : null;
  })()`);
  check('manifest is linked and fetchable', !!manifest?.name, JSON.stringify(manifest?.name));
  check('manifest declares standalone display', manifest?.display === 'standalone', manifest?.display);

  // Wait for the shell to be cached before cutting the network.
  await ev(`(async()=>{ const c = await caches.open('habiterall-shell-v3');
    return (await c.keys()).length; })()`);
  await sleep(1500);
  const cached = await ev(`(async()=>{
    const names = await caches.keys();
    const out = {};
    for (const n of names) out[n] = (await (await caches.open(n)).keys()).map(r=>new URL(r.url).pathname);
    return out;
  })()`);
  console.log('    cached:', JSON.stringify(cached));
  check('app shell is cached', Object.values(cached).flat().some(p => p === '/shared/app.js'),
    JSON.stringify(Object.values(cached).flat().slice(0, 8)));

  /* ---- 2. offline shell loads ---- */
  console.log('--- offline ---');
  await setOffline(true);
  await goto(APP);
  await sleep(2000);

  const offlineLoad = await ev(`(()=>({
    title: document.title,
    hasGrid: !!document.getElementById('grid'),
    scriptsRan: typeof window.fetch === 'function' && !!document.getElementById('toast'),
  }))()`);
  check('app shell loads with no network', offlineLoad.hasGrid === true, JSON.stringify(offlineLoad));

  // NOTE: Chrome's Network.emulateNetworkConditions does NOT apply to
  // service-worker-initiated fetches, so the SW can still reach the server
  // here. The offline API fallback is covered by swreal.mjs, which stops the
  // server outright. What we assert here is that the SHELL works offline.
  const offlineData = await ev(`(async()=>{
    const r = await fetch('/api/overview?days=7');
    return { status: r.status, habits: r.ok ? (await r.json()).habits?.length : null };
  })()`);
  check('dashboard data available offline (cache or SW passthrough)',
    offlineData.status === 200 && offlineData.habits > 0, JSON.stringify(offlineData));

  // Resolve a real habit id rather than assuming 1 exists.
  const HID = await ev(`(async()=>{
    const hs = await (await fetch('/api/habits')).json();
    return hs[0]?.id;
  })()`);

  /* ---- 3. writes queue while offline ---- */
  const queued = await ev(`(async()=>{
    const { enqueue, pendingCount } = await import('/shared/offline.js');
    // Simulate what api() does on a failed write.
    await enqueue({ url:'/api/habits/${HID}/entries/2026-08-09', method:'PUT',
                    body: JSON.stringify({ value: 2 }) });
    return await pendingCount();
  })()`);
  check('a write can be queued offline', queued >= 1, `queued=${queued}`);

  const persisted = await ev(`(async()=>{
    const { pending } = await import('/shared/offline.js');
    const all = await pending();
    return all.map(i => ({ url: i.url, method: i.method }));
  })()`);
  check('queue persists the request details', persisted[0]?.method === 'PUT',
    JSON.stringify(persisted));

  /* ---- 4. reconnect drains the queue ---- */
  console.log('--- reconnect ---');
  await setOffline(false);
  await sleep(500);

  const flushed = await ev(`(async()=>{
    const { flush, pendingCount } = await import('/shared/offline.js');
    const r = await flush();
    return { ...r, remaining: await pendingCount() };
  })()`);
  check('queued writes are sent on reconnect', flushed.sent >= 1, JSON.stringify(flushed));
  check('queue is empty afterwards', flushed.remaining === 0, String(flushed.remaining));

  const applied = await ev(`(async()=>{
    const r = await fetch('/api/habits/${HID}/entries');
    const es = await r.json();
    return es.find(e => e.date === '2026-08-09') ?? null;
  })()`);
  check('the queued write actually reached the server',
    applied?.value === 2, JSON.stringify(applied));

  /* ---- 5. ordering is preserved ---- */
  const ordered = await ev(`(async()=>{
    const { enqueue, flush } = await import('/shared/offline.js');
    await enqueue({ url:'/api/habits/${HID}/entries/2026-08-10', method:'PUT', body: JSON.stringify({ value: 2 }) });
    await enqueue({ url:'/api/habits/${HID}/entries/2026-08-10', method:'PUT', body: JSON.stringify({ status: 'skip' }) });
    await flush();
    const es = await (await fetch('/api/habits/${HID}/entries')).json();
    return es.find(e => e.date === '2026-08-10') ?? null;
  })()`);
  check('writes replay in submission order (last wins)',
    ordered?.status === 'skip', JSON.stringify(ordered));

  /* ---- 6. a REFUSED write takes its optimistic paint down with it ---- */
  //
  // The half `flush()` cannot cover on its own. A queued write was painted
  // before it was attempted and `api()` let that paint STAND, because being
  // queued is not a failure — "Saved offline, will sync when you reconnect".
  // So when the replay is then refused, a refetch is the only thing that can
  // take the day back off the grid. `syncNow` used to emit 'reload' only when
  // something SUCCEEDED, so a flush where every write was refused left the grid
  // claiming days the server had never accepted, indefinitely, with the streak
  // beside them computed without those days.
  //
  // A habit id that does not exist is the cheapest way to make the server
  // refuse a queued write for a reason that is not the network.
  const refused = await ev(`(async()=>{
    const { enqueue } = await import('/shared/offline.js');
    const { on } = await import('/shared/ui/store.js');
    const conn = await import('/shared/ui/connectivity.js');
    let reloads = 0;
    on('reload', () => { reloads++; });
    await enqueue({ url:'/api/habits/999999/entries/2026-08-11', method:'PUT',
                    body: JSON.stringify({ value: 2 }) });
    await conn.syncNow();
    const { pendingCount } = await import('/shared/offline.js');
    return { reloads, remaining: await pendingCount() };
  })()`);
  check('a refused write is dropped from the queue',
    refused.remaining === 0, JSON.stringify(refused));
  check('and the view is refetched, so its optimistic paint cannot survive',
    refused.reloads >= 1, JSON.stringify(refused));

  /* ---- 7. ...and a BLOCKED flush does not reload ---- */
  //
  // The negative half, without which `emit('reload')` unconditionally would
  // pass everything above. The rule is "the queue moved", not "a flush
  // happened": on a 503 nothing left the queue, the optimistic paint is still
  // the app's best guess, and reloading would throw away a detail view the user
  // is reading to tell them nothing. It also matters to `init()`, whose own
  // `emit('reload')` after a reconnect is only needed BECAUSE a blocked flush
  // emits none.
  //
  // `fetch` is stubbed in the page rather than intercepted over CDP: `/api/`
  // goes through the service worker's `networkFirst`, and this suite's own note
  // above records that emulated conditions do not reach a worker's fetches.
  const blocked = await ev(`(async()=>{
    const { enqueue, pendingCount } = await import('/shared/offline.js');
    const { on } = await import('/shared/ui/store.js');
    const conn = await import('/shared/ui/connectivity.js');
    let reloads = 0;
    on('reload', () => { reloads++; });
    await enqueue({ url:'/api/habits/${HID}/entries/2026-08-12', method:'PUT',
                    body: JSON.stringify({ value: 2 }) });
    const real = globalThis.fetch;
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    try { await conn.syncNow(); } finally { globalThis.fetch = real; }
    return { reloads, remaining: await pendingCount() };
  })()`);
  check('a blocked flush keeps its writes', blocked.remaining === 1,
    JSON.stringify(blocked));
  check('and does NOT reload — nothing left the queue', blocked.reloads === 0,
    JSON.stringify(blocked));

  // Drain it, so the queue this suite leaves behind is empty.
  await ev(`(async()=>{ const { clearAll } = await import('/shared/offline.js');
                        await clearAll(); return 1; })()`);

  /* ---- 8. every request says which clock this device is on ---- */
  //
  // `ui/api.js` sets `X-Habiterall-Timezone` at its single fetch chokepoint, so
  // an account following its device costs no extra request. Deleting that one
  // spread left `npm test` and all 26 browser suites green — the server rule
  // was covered and neither client's half was — which is how a reminder would
  // quietly go back to arriving on the container's clock.
  //
  // Read off the wire with CDP rather than from the code: what matters is that
  // the header ARRIVES, and the service worker sits between the two.
  await send('Network.enable', {}, sessionId);
  const seen = [];
  const onRequest = (m) => {
    if (m.method !== 'Network.requestWillBeSent') return;
    const { url, headers } = m.params.request;
    if (url.includes('/api/')) seen.push(headers['X-Habiterall-Timezone'] ?? null);
  };
  const priorHandler = ws.onmessage;
  ws.onmessage = (e) => { try { onRequest(JSON.parse(e.data)); } catch { /* not ours */ } priorHandler(e); };

  await ev(`(async()=>{
    const { api } = await import('/shared/ui/api.js');
    await api('/habits');
    return 1;
  })()`);
  await sleep(400);
  ws.onmessage = priorHandler;

  const zones = seen.filter((z) => z !== null);
  check('an ordinary API request carries this device\'s timezone',
    zones.length > 0, `${seen.length} /api/ requests, ${zones.length} with the header`);
  check('and it is a zone Intl knows, not a placeholder',
    zones.every((z) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } }),
    zones.join(','));

  console.log(fails === 0 ? '\nALL PWA CHECKS PASSED' : `\n${fails} PWA CHECK(S) FAILED`);
} catch (e) {
  console.error('ERROR:', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
