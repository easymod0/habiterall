/**
 * The URL names the view, and the view can be reached from the URL.
 *
 * Four things about a habit, and only a real browser can check any of them:
 * opening one writes `#/habit/<id>`; loading that fragment cold lands on the
 * habit rather than the dashboard; Back leaves it; and the detail view's own
 * controls — which all re-enter `open()` — do not each leave a history entry
 * behind.
 *
 * The last one is the reason this suite exists. `detail.open()` is called
 * again for every zoom, page and granularity press, so a naive "write the URL
 * when the view renders" turns one habit into a dozen history entries and
 * Back walks through all of them before it goes anywhere.
 *
 * Two more about the category comparison (#65), which is the second fragment
 * route and the reason the first four are not enough on their own: `ourEntry`
 * in `ui/routes.js` is a single BOOLEAN and `go(LIST)` unwinds with one
 * `history.back()`, so the app is only ever one of our entries deep. That
 * holds because the comparison pushes exactly one entry AND cannot be opened
 * over a habit — the two checks below — not because anything in `go()`
 * enforces it. What the figures on that view SAY is `comparecheck.mjs`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome, waitUntil } from './chrome.mjs';
import { seedCategorySpread } from './fixtures.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9312);
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
  // The category comparison is a second fragment route, and its top-bar entry
  // point is shown only for an account that HAS a category — so the fixtures
  // it needs are laid down before the browser is pointed at anything. The
  // habits it adds go on the end of the list, so the "click the first row"
  // checks below still open the same habit they always did.
  await seedCategorySpread({ base: APP });

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

  /* ---------- the comparison is one entry, and Back unwinds it ---------- */

  // `ui/routes.js` keeps `ourEntry` as a single BOOLEAN and `go(LIST)` reaches
  // the dashboard with one `history.back()`, so the whole app is exactly one
  // fragment entry deep at all times. A second pushing route is the change
  // that could break that, and both halves are asserted: the push is one entry
  // and not none — a `replaceState` here leaves the entry underneath it as
  // whatever preceded the app, so the next Back walks out of it.
  //
  // A tab of its own, for the reason the deep-link cases below need theirs:
  // the tab above has a FORWARD entry (the habit it went Back from), and a
  // `pushState` prunes it, so `history.length` there is 3 before the push and 3
  // after — a count that reads identical to no push at all. Starting from a tab
  // created straight at the app is the only way this number means anything.
  const cmpTab = await send('Target.createTarget', { url: APP });
  const cmpSession = (await send('Target.attachToTarget',
    { targetId: cmpTab.targetId, flatten: true })).sessionId;
  const cmpEv = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, cmpSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  // The Compare button visible, not merely the grid populated: it is shown
  // only for an account that HAS a category and `dashboard.paint()` is what
  // decides that, so this is the weakest predicate the click below depends on.
  await waitUntil(cmpEv,
    `!!document.querySelector('#grid .habit-row')
       && document.getElementById('btn-compare').hidden === false`,
    { what: 'the dashboard, with its Compare button' });

  const beforeCompare = await cmpEv(`history.length`);
  await cmpEv(`document.getElementById('btn-compare').click()`);
  // The view unhidden AND a card with a real box in it. Counting
  // `.compare-card` alone is satisfied by a previous render's nodes, which
  // survive in the container until `replaceChildren()` runs — see the same
  // wait in `comparecheck.mjs`.
  await waitUntil(cmpEv, `(() => {
    const view = document.getElementById('view-categories');
    const first = view && !view.hidden && view.querySelector('.compare-card');
    return !!first && first.getBoundingClientRect().width > 0;
  })()`, { what: 'the comparison to render' });

  const compared = await cmpEv(`(() => ({
    compare: !document.getElementById('view-categories').hidden,
    list: !document.getElementById('view-list').hidden,
    hash: location.hash,
    length: history.length,
  }))()`);
  ck('the comparison replaces the dashboard and names itself in the URL',
    compared.compare && !compared.list && compared.hash === '#/categories',
    JSON.stringify(compared));
  ck('and it pushes exactly one history entry',
    compared.length === beforeCompare + 1, `${beforeCompare} -> ${compared.length}`);

  // A settle rather than a `waitUntil`, matching the Back check above it: the
  // thing being asserted is WHERE Back landed, and one wrong answer is "it did
  // not move at all" — which a poll on the dashboard cannot observe, it can
  // only time out somewhere else and report a page that never loaded.
  await cmpEv(`history.back()`);
  await sleep(1200);
  const backFromCompare = await cmpEv(`(() => ({
    compare: !document.getElementById('view-categories').hidden,
    list: !document.getElementById('view-list').hidden,
    hash: location.hash,
  }))()`);
  ck('Back from the comparison returns to the dashboard',
    backFromCompare.list && !backFromCompare.compare && backFromCompare.hash === '',
    JSON.stringify(backFromCompare));

  /* ---------- and it cannot be entered from a habit ---------- */

  // The other half of the same invariant, and it is not a tidiness rule: with
  // the button reachable from a habit's own page, `dashboard -> habit ->
  // categories` is two of our entries, and one `history.back()` from a habit
  // that a link out of the comparison had opened would land on `#/categories`
  // with the dashboard painted underneath it. `android-native/CLAUDE.md`'s
  // back-stack section states the assumption that breaks.
  await cmpEv(`document.querySelector('#grid .habit-row .habit-meta, #grid .habit-row .habit-name')
    ?.click()`);
  await waitUntil(cmpEv,
    `!document.getElementById('view-detail').hidden
       && !!document.querySelector('#view-detail h2')`,
    { what: 'the habit to open again' });
  const buttonOverHabit = await cmpEv(`(() => {
    const b = document.getElementById('btn-compare');
    return { hidden: b.hidden, visible: !!b.offsetParent };
  })()`);
  ck('the Compare button is absent while a habit is open',
    buttonOverHabit.hidden === true && buttonOverHabit.visible === false,
    JSON.stringify(buttonOverHabit));

  // `dashboard.paint()` calls `syncEntry` before it shows the list, so the
  // list being visible is downstream of the decision being asserted — the wait
  // is on the view and the check is on the button, rather than the wait
  // quietly being the check.
  await cmpEv(`history.back()`);
  await waitUntil(cmpEv,
    `!document.getElementById('view-list').hidden && location.hash === ''`,
    { what: 'the dashboard after leaving the habit' });
  const buttonBack = await cmpEv(`(() => {
    const b = document.getElementById('btn-compare');
    return { hidden: b.hidden, visible: !!b.offsetParent };
  })()`);
  ck('and it comes back once the habit is closed',
    buttonBack.hidden === false && buttonBack.visible === true,
    JSON.stringify(buttonBack));

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

  /* ---------- and the dashboard is never painted on the way ---------- */

  // The boot used to load and paint the dashboard and only THEN open the
  // habit, so a deep link showed a full grid of every habit for as long as the
  // stats request took and then replaced it. Nothing was broken by it and no
  // other check here could see it: it is a flash of the wrong screen, on the
  // Android client's most-used path into the app.
  //
  // A third tab, because catching this needs a watcher installed before the
  // app's first line runs and that means navigating a tab that already exists
  // — which leaves the initial about:blank in the history and would break the
  // count asserted above. Each tab measures one thing.
  //
  // Watched from inside the page rather than polled from here: the flash lasts
  // one request, which on localhost is a few milliseconds — less than a
  // devtools round trip, so a poll would report "no flash" on a page that
  // flashed.
  const flashTab = await send('Target.createTarget', { url: 'about:blank' });
  const flashSession = (await send('Target.attachToTarget',
    { targetId: flashTab.targetId, flatten: true })).sessionId;
  const flashEv = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, flashSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send('Page.enable', {}, flashSession);
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__listFlash = false;
      new MutationObserver(() => {
        const grid = document.getElementById('grid');
        const detail = document.getElementById('view-detail');
        // Rows in the dashboard's grid while the habit view is still hidden:
        // the user is looking at the list they did not ask for.
        if (grid && grid.childElementCount > 0 && detail && detail.hidden) {
          window.__listFlash = true;
        }
      }).observe(document, { childList: true, subtree: true, attributes: true });
    `,
  }, flashSession);
  await send('Page.navigate', { url: `${APP}/#/habit/${habit.id}` }, flashSession);
  for (let i = 0; i < 80; i++) {
    if (await flashEv(`!!document.querySelector('#view-detail h2')`).catch(() => 0)) break;
    await sleep(200);
  }
  await sleep(400);

  const flashed = await flashEv(`window.__listFlash`);
  ck('a cold deep link never paints the dashboard on the way',
    flashed === false, `__listFlash=${flashed}`);

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
