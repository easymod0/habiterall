/**
 * The URL names the view, and the view can be reached from the URL.
 *
 * Four things, and only a real browser can check any of them: opening a habit
 * writes `#/habit/<id>`; loading that fragment cold lands on the habit rather
 * than the dashboard; Back leaves it; and the detail view's own controls —
 * which all re-enter `open()` — do not each leave a history entry behind.
 *
 * The last one is the reason this suite exists. `detail.open()` is called
 * again for every zoom, page and granularity press, so a naive "write the URL
 * when the view renders" turns one habit into a dozen history entries and
 * Back walks through all of them before it goes anywhere.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = 9312;
const profile = mkdtempSync(join(tmpdir(), 'habroute-'));
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

  /** Wait for a selector to match, then settle. */
  const waitFor = async (sel, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`).catch(() => 0)) break;
      await sleep(200);
    }
    await sleep(400);
  };

  /** Which view is showing, and what the address bar says about it. */
  const where = () => ev(`(() => ({
    list: !document.querySelector('#view-list').hidden,
    detail: !document.querySelector('#view-detail').hidden,
    hash: location.hash,
    title: document.querySelector('#view-detail h2')?.textContent ?? '',
  }))()`);

  /* ---------- the dashboard has no fragment ---------- */

  await send('Page.navigate', { url: APP }, sessionId);
  await waitFor('#grid .habit-row');

  const start = await where();
  ck('the dashboard is showing', start.list && !start.detail, JSON.stringify(start));
  ck('and it names no habit in the URL', start.hash === '', `hash=${start.hash}`);

  const habit = await ev(`(async () => {
    const hs = await (await fetch('/api/habits')).json();
    return { id: hs[0].id, name: hs[0].name };
  })()`);

  /* ---------- opening a habit writes the URL ---------- */

  await ev(`document.querySelector('#grid .habit-row .habit-meta, #grid .habit-row .habit-name')
    ?.click()`);
  await waitFor('#view-detail h2');

  const opened = await where();
  ck('clicking a habit opens the detail view', opened.detail && !opened.list,
    JSON.stringify(opened));
  ck('and the URL names that habit', opened.hash === `#/habit/${habit.id}`,
    `${opened.hash} for habit ${habit.id}`);

  /* ---------- redrawing it does not stack history ---------- */

  const before = await ev(`history.length`);
  // Every one of these re-enters detail.open(). Three presses, because one
  // could pass by luck if the write happened to be skipped for another reason.
  for (const label of ['week', 'month', 'year']) {
    await ev(`[...document.querySelectorAll('#view-detail .seg button')]
      .find(b => b.textContent.trim() === ${JSON.stringify(label)})?.click()`);
    await sleep(700);
  }
  const after = await ev(`history.length`);
  const redrawn = await where();
  ck('redrawing the habit adds no history entries', after === before,
    `${before} -> ${after}`);
  ck('and the URL still names it', redrawn.hash === `#/habit/${habit.id}`,
    redrawn.hash);

  /* ---------- Back leaves the habit ---------- */

  await ev(`history.back()`);
  await sleep(1200);
  const backed = await where();
  ck('Back returns to the dashboard', backed.list && !backed.detail,
    JSON.stringify(backed));
  ck('and clears the fragment', backed.hash === '', `hash=${backed.hash}`);

  /* ---------- a cold load of the fragment lands on the habit ---------- */

  // A tab of its own, with no history of its own. Reusing the one above would
  // measure the suite's own navigations rather than the deep link's — the
  // check below is about what a *first* page load leaves behind, and in a
  // reused tab `history.back()` has somewhere to go regardless.
  const cold = await send('Target.createTarget', { url: `${APP}/#/habit/${habit.id}` });
  const coldSession = (await send('Target.attachToTarget',
    { targetId: cold.targetId, flatten: true })).sessionId;
  const coldEv = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, coldSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  for (let i = 0; i < 80; i++) {
    if (await coldEv(`!!document.querySelector('#view-detail h2')`).catch(() => 0)) break;
    await sleep(200);
  }
  await sleep(400);

  const deep = await coldEv(`(() => ({
    detail: !document.querySelector('#view-detail').hidden,
    title: document.querySelector('#view-detail h2')?.textContent ?? '',
    hash: location.hash,
  }))()`);
  ck('loading the fragment cold opens the habit', deep.detail, JSON.stringify(deep));
  ck('and it is the right habit', deep.title === habit.name,
    `${deep.title} != ${habit.name}`);

  // Booting into a habit leaves a dashboard behind it to go back to: the first
  // paint replaces the fragment with the list, and opening the habit pushes it
  // again. In a browser that is what you want — Back from a shared link goes
  // to the app rather than out of it.
  //
  // The Android WebView does NOT behave this way, and deliberately is not made
  // to: there, the same sequence closes the screen and returns to the native
  // habit list, because WebView's own back skips an entry that a script pushed
  // with no user gesture behind it. Both are the right answer where they
  // happen — Back should leave a screen you arrived at from the native list —
  // so this asserts the browser's half, and the app's half is checked on a
  // device.
  const coldEntries = await coldEv(`history.length`);
  // Exactly two: the load itself, replaced in place by the first paint, and the
  // habit pushed on top. Asserting the count is what catches the opposite
  // regression — a boot that *stacks* entries — which "Back reached the
  // dashboard" alone would still pass through.
  ck('a cold deep link leaves exactly one entry to go back to',
    coldEntries === 2, `history.length=${coldEntries}`);

  await coldEv(`history.back()`);
  await sleep(1200);
  const afterBack = await coldEv(`(() => ({
    detail: !document.querySelector('#view-detail').hidden,
    list: !document.querySelector('#view-list').hidden,
    length: history.length,
  }))()`);
  ck('Back from a cold deep link reaches the dashboard',
    afterBack.list && !afterBack.detail, JSON.stringify(afterBack));

  /* ---------- and junk is the dashboard, not an error ---------- */

  // Its own tab, for the reason the deep-link case above needed one and this
  // case previously did not have one: navigating a tab that is already at
  // `APP` to `APP/#/junk` changes only the fragment, so the page never reloads
  // and `parseRoute` is never asked anything. The check passed because the
  // dashboard was already showing — it proved nothing. The give-away was in its
  // own output: the fragment was still `#/habit/does-not-exist` afterwards,
  // where a real boot would have cleared it on the first paint.
  const junkTab = await send('Target.createTarget',
    { url: `${APP}/#/habit/does-not-exist` });
  const junkSession = (await send('Target.attachToTarget',
    { targetId: junkTab.targetId, flatten: true })).sessionId;
  const junkEv = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, junkSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  for (let i = 0; i < 80; i++) {
    if (await junkEv(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
    await sleep(200);
  }
  await sleep(400);

  const junk = await junkEv(`(() => ({
    list: !document.querySelector('#view-list').hidden,
    detail: !document.querySelector('#view-detail').hidden,
    hash: location.hash,
  }))()`);
  ck('an unparseable fragment falls back to the dashboard', junk.list && !junk.detail,
    JSON.stringify(junk));
  ck('and the fragment is cleared, proving the page really booted',
    junk.hash === '', `hash=${junk.hash}`);

  console.log(fails === 0 ? '\nALL ROUTE CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
