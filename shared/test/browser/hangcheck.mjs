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

import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome, waitUntil } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9256);

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

  /* ---- 0. ui/api.js's own guard, against a healthy and untampered server ---- */
  console.log('--- a write with no AbortSignal.timeout on the page (#87 round 3) ---');

  // #276 bounded the worker's two fetch sites (`shellFirst`, `networkFirst`)
  // with a feature detect; review found `ui/api.js`'s own call to
  // `AbortSignal.timeout` still unguarded. This block is the opposite shape
  // from every other one below: nothing is HELD here, the server answers
  // normally, and the only thing wrong with the world is that the page has no
  // `AbortSignal.timeout`. A Node unit test cannot reach this — `ui/api.js`
  // imports absolute `/shared/...` paths and the assertion is about what the
  // PLATFORM did with a real fetch — so it has to live here, before the first
  // `Fetch.enable` below, while the server is still healthy and nothing is
  // intercepted.
  //
  // The deletion happens AFTER the app has booted, not before. Both the
  // guarded `boundedSignal` and the unguarded call it replaces look
  // `AbortSignal.timeout` up on the global at CALL TIME — a property read,
  // not a reference captured at module load — so deleting it once the page
  // has already booted still reaches every `api()` call made from here on,
  // including the tap below, and isolates the WRITE path. Deleting it before
  // boot also kills the dashboard's own `/overview` fetch, since that GET
  // goes through the same `api()`: the block would die at the boot wait
  // instead of proving anything about the write, which is what an earlier
  // version of this block did.
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev, `!!document.querySelector('#grid .habit-row')`,
    { what: 'the dashboard to load, before the guard tap' });

  await ev(`(()=>{ delete AbortSignal.timeout; return true; })()`);

  // The control assertion. Without it a Chrome that reasserts the static, or
  // a typo in the deletion above, would make every check below pass
  // vacuously, having tested nothing.
  const timeoutType = await ev(`typeof AbortSignal.timeout`);
  check('the control: AbortSignal.timeout is actually absent from the page',
    timeoutType === 'undefined', `typeof AbortSignal.timeout is "${timeoutType}"`);

  const guardBefore = await look();
  check('nothing queued and no strip before the guard tap',
    guardBefore.outbox.length === 0 && !guardBefore.bar, JSON.stringify(guardBefore));

  // The first habit row's SECOND-TO-LAST cell: a date neither block 1 nor 1b
  // below ever taps (they use the LAST cell of rows one and two), so nothing
  // here can be confused with what follows, whichever way this block comes
  // out. Read-only — the tap itself happens below, after the server's PRIOR
  // value for this date is known, because `reset()` seeds ~60 days of history
  // and this date already carries a fixture value: "a row exists" is true
  // whether or not the tap's own write ever reaches the server, so presence
  // alone cannot be the load-bearing check.
  const guardKey = await ev(`(()=>{
    const cells = [...document.querySelectorAll('.habit-row:first-child .check')];
    return cells[cells.length - 2].dataset.focusKey;
  })()`);
  const [, guardHabitId, guardDate] = guardKey?.split(':') ?? [];
  check('a habit and date were found to tap',
    /^\d+$/.test(guardHabitId ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(guardDate ?? ''),
    String(guardKey));

  const guardValueBefore = await fetch(`${APP}/api/habits/${guardHabitId}/entries`)
    .then((r) => r.json()).catch(() => [])
    .then((rows) => rows.find?.((e) => e.date === guardDate)?.value);

  // A sticky recorder, installed BEFORE the tap, of the one thing that tells
  // "sent directly" apart from "queued, and healed by a mechanism that has
  // nothing to do with whether this bug is fixed" — see the note below the
  // tap for what that second mechanism is. The direct and the queued paths
  // diverge the instant `api()` decides which one it is on, not at whatever
  // moment a poll happens to sample afterwards: on the broken path
  // `announceQueued` (ui/api.js) calls `reportUnreachable` IMMEDIATELY, which
  // raises `#offline-bar` and fires the "Saved offline" toast synchronously
  // with the failed attempt. A `MutationObserver` latches the first time
  // either happens and keeps it latched, so nothing about how long the write
  // then takes — a fast direct send, a slow one, or a queued one healed
  // seconds later — can make the sample miss it. Selectors confirmed against
  // `index.html`/`connectivity.js`/`toast.js`: `#offline-bar` and `#toast`
  // both carry a plain boolean `hidden` attribute, toggled via the `.hidden`
  // IDL property, which is what `attributeFilter` below is watching for.
  await ev(`(()=>{
    window.__guardSaw = { announced: false, bar: false };
    window.__guardObs = new MutationObserver(() => {
      const bar = document.getElementById('offline-bar');
      if (bar && !bar.hidden) window.__guardSaw.bar = true;
      const t = document.getElementById('toast');
      if (t && /Saved offline/.test(t.textContent || '')) window.__guardSaw.announced = true;
    });
    window.__guardObs.observe(document.body, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['hidden'],
    });
    return true;
  })()`);

  // The same selector and index used to read the key above, re-run rather
  // than a saved element reference — nothing between the two `ev` calls
  // touches the DOM, so this is the same cell.
  await ev(`(()=>{
    const cells = [...document.querySelectorAll('.habit-row:first-child .check')];
    cells[cells.length - 2].click();
    return true;
  })()`);

  // The row changing on the server is still the load-bearing evidence that
  // the write actually landed — but the ceiling here can be as generous as
  // the write's own 10s bound, and no longer has to race anything, because
  // the recorder above is what tells the two paths apart now. A queued write
  // does not stay queued forever even with the bug fully in place:
  // `announceQueued` calls `reportUnreachable`, which arms `offline.js`'s
  // connectivity watcher, and that watcher's own recovery poll
  // (`initialDelayMs`, 2000ms by default) calls `isReachable()` and then
  // `flush()` — BOTH of which build their own `AbortController` directly and
  // never touch `AbortSignal.timeout` at all. So a couple of seconds after
  // the tap, completely independently of whether `ui/api.js`'s bug is fixed,
  // the watcher notices the server is healthy and resends the queued PUT
  // through `flush()`'s plain, unbounded `fetch()` — and the row changes
  // anyway. A bare "did the value change" check racing that timer is exactly
  // how this masking was first found: it passed with the bug fully in place,
  // just a couple of seconds slower. The recorder is what actually
  // distinguishes them now; this poll only has to confirm the write landed
  // at all, eventually, so it can wait as long as the write itself may.
  const guardDeadline = Date.now() + BOUND_MS;
  let guardValueAfter;
  for (;;) {
    guardValueAfter = await fetch(`${APP}/api/habits/${guardHabitId}/entries`)
      .then((r) => r.json()).catch(() => [])
      .then((rows) => rows.find?.((e) => e.date === guardDate)?.value);
    if (guardValueAfter !== guardValueBefore) break;
    if (Date.now() > guardDeadline) {
      throw new Error(
        `the tapped check-off never reached the server at all within ${BOUND_MS}ms ` +
        `(still ${JSON.stringify(guardValueBefore)}): ui/api.js threw building its abort ` +
        'signal and queued the write instead of sending it, and nothing ever flushed it'
      );
    }
    await sleep(100);
  }
  check('the check-off that was tapped changed the server row',
    true, `${guardHabitId} ${guardDate}: ${JSON.stringify(guardValueBefore)} -> ${JSON.stringify(guardValueAfter)}`);

  // The load-bearing checks: what the recorder latched from the instant of
  // the tap, immune to when this line happens to run.
  const guardSaw = await ev(`window.__guardSaw`);
  await ev(`window.__guardObs.disconnect(); delete window.__guardObs; true`);
  check('the write was never announced as queued, from the instant of the tap',
    guardSaw?.announced === false, JSON.stringify(guardSaw));
  check('the offline strip never went up, from the instant of the tap',
    guardSaw?.bar === false, JSON.stringify(guardSaw));

  // A settle, and a legitimate one this time — waiting to see something did
  // NOT happen (the bookkeeping below) has no predicate to poll for. `unstage`
  // runs on the client a beat AFTER the server has already answered, which the
  // predicate above just confirmed it did, so this covers only that lag and
  // not the request itself. This is supplementary to the latched checks
  // above, not a replacement: it is the CURRENT state rather than "was it
  // ever true", and reads naturally alongside them in the log.
  await sleep(250);
  const guardAfter = await look();
  const guardToast = await ev(`(document.getElementById('toast')?.textContent || '')`);
  check('the write reached the server directly: nothing queued',
    guardAfter.outbox.length === 0, JSON.stringify(guardAfter.outbox));
  check('the offline strip never appeared',
    !guardAfter.bar && !guardAfter.message, JSON.stringify(guardAfter));
  check('no "Saved offline" toast appeared',
    !/Saved offline/.test(guardToast), JSON.stringify(guardToast));

  // No explicit restore call is needed: deleting a property on THIS
  // document's `AbortSignal` cannot outlive the document, and the navigate
  // immediately below — which boots the app fresh for block 1 onward — hands
  // back the native static along with everything else a fresh load resets.
  // The rest of this file never drives an interception whose TIMING depends
  // on which of `AbortSignal.timeout` or the `AbortController` fallback is
  // bounding the request — both bound at the same 10s — so nothing past this
  // point would have cared even if the deletion had somehow persisted.
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

  // The write is durable WHILE the fetch is in flight, which is the whole of
  // the data-loss half. It used to be queued only in the `catch`, so for the
  // length of the attempt — unbounded, before the timeout landed — a check-off
  // existed only in a promise, and closing the tab lost it from the outbox and
  // the server alike. It is staged before the socket opens now.
  await sleep(2000);
  const during = await look();
  check('the write is already durable while the fetch is still in flight',
    during.outbox.length === 1, JSON.stringify(during));
  check('and it is the check-off, not something else',
    during.outbox[0]?.startsWith('PUT /api/habits/'), String(during.outbox[0]));

  // Wait for the BOUND to fire, not for the slack to elapse. The offline bar is
  // what appears when the attempt is abandoned, so it is the event itself; the
  // ceiling is what the fixed sleep used to be, so a bound that never fires
  // still spends it and then fails on the checks below.
  //
  // A bounded poll rather than `waitUntil`, because this file's `try` has no
  // `catch`: a throw here runs `finally`, closes Chrome, and leaves the module
  // — past the itemised checks, past the create-abandon half, and past the
  // whole recovery section, whose last check is the one that proves the held
  // write reached the server. That is precisely the run where the diagnosis
  // matters, since a missing bound in `ui/api.js` is what this suite exists to
  // catch. The three checks below already judge this wait's outcome, so it does
  // not need to judge it itself: an expired ceiling reports the elapsed time
  // against the bound, and the bar and message as absent.
  const gaveUpAt = Date.now();
  const reportedOffline = `(()=>{
    const vis = (id) => !!document.getElementById(id)?.offsetParent;
    return vis('offline-bar') && vis('offline-message');})()`;
  const offlineBy = gaveUpAt + BOUND_MS + SLACK_MS - 2000;
  while (Date.now() < offlineBy) {
    if (await ev(reportedOffline).catch(() => false)) break;
    await sleep(100);
  }
  const gaveUp = Date.now() - gaveUpAt + 2000;
  const after = await look();
  const write = held.find((r) => r.method === 'PUT');

  // The sleep could not say this: it waited past the bound either way, so a
  // build whose bound was 17s — or absent, with the browser's own socket
  // timeout arriving eventually — read the same as one at 10s.
  // The window is the BOUND plus tolerance, deliberately NOT the ceiling above:
  // with `BOUND_MS + SLACK_MS` as the upper limit this passed against a build
  // whose bound was 16s, which is the whole thing it exists to notice. Measured
  // idle at 10045ms and under an eight-worker run at 10s-and-change — the timer
  // is an AbortSignal, so contention delays it by milliseconds, not seconds.
  check('and it gave up AT the bound, not merely eventually',
    gaveUp >= BOUND_MS * 0.5 && gaveUp < BOUND_MS * 1.4,
    `${gaveUp}ms against a ${BOUND_MS}ms bound`);

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

  /* ---- 1b. the next tap does not pay the bound again ---- */
  console.log('--- once it knows, it stops asking ---');

  // Tap one is what discovers the outage and there is no cheaper way to learn
  // it. Tap two should cost nothing: the app already believes it is offline, so
  // the write goes straight to the outbox without a socket. Before the watcher
  // was fed by a failed write this branch was unreachable — the app never came
  // to believe anything — so this is the half of the old issue that only became
  // real once the state did.
  const t0 = Date.now();
  await ev(`(()=>{
    const cells = [...document.querySelectorAll('.habit-row:nth-child(2) .check')];
    cells[cells.length - 1].click();
    return true;
  })()`);

  // Generously under the bound: if the attempt were still being made this
  // could not finish inside it.
  let second = null;
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    second = await look();
    if (second.outbox.length >= 2) break;
  }
  const took = Date.now() - t0;

  check('the second tap is queued without waiting for a timeout',
    second.outbox.length === 2, JSON.stringify(second.outbox));
  check('and it took a fraction of the bound, not the whole of it',
    took < BOUND_MS / 2, `${took}ms against a ${BOUND_MS}ms bound`);
  check('nothing was sent for it — the socket was never opened',
    held.filter((r) => r.method === 'PUT').length === 1,
    `${held.filter((r) => r.method === 'PUT').length} PUT(s) held`);

  /* ---- 2. creating a habit fails honestly rather than hanging ---- */
  console.log('--- POST /habits is bounded but never queued ---');

  // The one non-idempotent call on this path: aborting a create the server has
  // already begun does not recall it, and replaying it from the outbox is two
  // habits. It used to be left UNBOUNDED for that reason, which did not avoid
  // the duplicate — it just made the dialog spin until the OS gave up while the
  // create may or may not have landed. Bounded and not queued is the honest
  // shape: abandoned, not replayed, and reported as indeterminate. Driven
  // through the app's own api() rather than a bare fetch, or the bound under
  // test would not be in the way at all.
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

  // Again the settling, not the slack: `__create` leaves 'pending' when the
  // bound fires. Same ceiling as the sleep it replaces, and bounded-poll rather
  // than `waitUntil` for the reason given above — a create that hangs forever
  // has to reach the three checks below, which say so by name, rather than
  // throw out of a file that has no `catch`.
  const createdBy = Date.now() + BOUND_MS + SLACK_MS;
  while (Date.now() < createdBy) {
    if (await ev(`window.__create !== 'pending'`).catch(() => false)) break;
    await sleep(100);
  }
  const createState = await ev(`window.__create`);
  const afterCreate = await look();
  check('a create is abandoned at the bound rather than hanging forever',
    String(createState).startsWith('rejected:'), String(createState));
  check('and it says the outcome is unknown, not that it was saved',
    /did not answer/.test(String(createState)) &&
    !/Saved offline/.test(String(createState)), String(createState));
  check('and it is never queued, so it cannot be replayed into a second habit',
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
  //
  // Both parts are checked against their own shape before going back into a
  // URL. They come out of a request this test intercepted, which is a value
  // from outside the test even though the test is what caused it — and
  // interpolating that into a fetch is the request-forgery shape, which CodeQL
  // is right to flag whatever the origin. Asserting them also means a change
  // to the route's path fails here loudly rather than quietly requesting
  // something else and finding no entry.
  const [, , , habitId, , date] = new URL(write.url).pathname.split('/');
  if (!/^\d+$/.test(habitId ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
    throw new Error(`held write has an unexpected path: ${new URL(write.url).pathname}`);
  }
  const stored = await fetch(`${APP}/api/habits/${Number(habitId)}/entries`)
    .then((r) => r.json()).catch(() => []);
  check('the check-off that was held is now recorded on the server',
    stored.some?.((e) => e.date === date), `${habitId} ${date}`);
} finally {
  await closeChrome({ chrome, port: PORT, profile });
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
