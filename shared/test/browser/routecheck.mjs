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
 *
 * And the same set again for `#/category/<id>` (#259), the THIRD fragment
 * route — one category's own page, opened from the dashboard's grouped section
 * header. A third pushing route is exactly the change that could leave the app
 * two of our entries deep, so the depth is asserted from its side too: the
 * push is one entry, Back lands on the dashboard and the dashboard is what is
 * VISIBLE, and `#btn-compare` is gone while the page is open (which is what
 * makes `dashboard → category → categories` unreachable). What that page's
 * figures and its member roster SAY is `comparecheck.mjs`, as before.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor, waitUntil,
} from './chrome.mjs';
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
  //
  // The return value is kept for the #259 block at the bottom, which needs a
  // category's real id to build the fragment it asserts: reading one back out
  // of the DOM would take the id from the markup under test and then compare
  // the URL against it, which pins nothing.
  const spread = await seedCategorySpread({ base: APP });

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

  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate', { url: APP }, sessionId),
    what: 'the dashboard',
  });
  await sleep(400);   // `waitFor`'s own post-action settle, kept

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

  /* ---------- a habit reached from OUTSIDE the app closes the comparison ---------- */

  // The two constraints above close every route the app itself offers into
  // `dashboard -> categories -> habit`, and they cannot close a same-document
  // FRAGMENT navigation made from outside it. The app ships one: `appLink` in
  // `shared/src/notify.js` builds `#/habit/42` for the ntfy `click` and the
  // Discord `embed.url`, and the address bar reaches it too. `location.hash` is
  // that navigation exactly — no reload, so `routes.init`'s listener is what
  // opens the habit, which is the path a notification tap takes.
  //
  // With `state.openCategories` left true by `detail.js`, Back from that habit
  // fires `onRoute({view: 'categories'})`, `app.js`'s `!state.openCategories`
  // guard is false, `categories.open()` is skipped — and the app sits with
  // `#/categories` in the address bar and the habit still rendered.
  await cmpEv(`document.getElementById('btn-compare').click()`);
  await waitUntil(cmpEv, `(() => {
    const view = document.getElementById('view-categories');
    const first = view && !view.hidden && view.querySelector('.compare-card');
    return !!first && first.getBoundingClientRect().width > 0;
  })()`, { what: 'the comparison to render again' });

  await cmpEv(`location.hash = '#/habit/${habit.id}'`);
  await waitUntil(cmpEv,
    `!document.getElementById('view-detail').hidden
       && document.getElementById('view-categories').hidden
       && !!document.querySelector('#view-detail h2')`,
    { what: 'the habit the fragment names' });

  // A settle rather than a poll, for the reason the two Back checks above use
  // one: the wrong answer is "nothing moved at all", which has no predicate to
  // wait on — a poll on the comparison could only ever time out.
  await cmpEv(`history.back()`);
  await sleep(1200);
  const backToCompare = await cmpEv(`(() => ({
    compare: !document.getElementById('view-categories').hidden,
    detail: !document.getElementById('view-detail').hidden,
    hash: location.hash,
    cards: document.querySelectorAll('#view-categories .compare-card').length,
  }))()`);
  ck('Back from a habit opened by its fragment returns to the comparison, not to '
     + 'the comparison\'s URL over the habit',
    backToCompare.compare && !backToCompare.detail
    && backToCompare.hash === '#/categories' && backToCompare.cards > 0,
    JSON.stringify(backToCompare));

  // ...and leave the tab on the dashboard, where the deep-link blocks below
  // would otherwise inherit a comparison nobody asked them about.
  await cmpEv(`history.back()`);
  await waitUntil(cmpEv,
    `!document.getElementById('view-list').hidden && location.hash === ''`,
    { what: 'the dashboard after leaving the comparison' });

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
  // `flashEv`, not `ev` — the marker and the predicate have to be evaluated in
  // the tab being navigated, and this one is the flash tab's.
  await reloadAndWaitFor(flashEv, `!!document.querySelector('#view-detail h2')`, {
    reload: () => send('Page.navigate', { url: `${APP}/#/habit/${habit.id}` }, flashSession),
    what: 'the deep-linked habit view',
  });
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

  /* ---------- #259: one category's own page, the third fragment route ---------- */

  // The same two claims the comparison makes above, for the same reason, plus
  // the three only this route can make. `ourEntry` is a single boolean and
  // `go(LIST)` is a single `history.back()`, so the app is exactly one of our
  // entries deep at all times and nothing in `routes.js` enforces it — the
  // views do, and this page is now one of them.
  //
  // The way in is the dashboard's grouped section header, which `paint()`
  // draws only while `groupByCategory` is on. Written HERE rather than from
  // inside the tab below: `settings.init()` runs once per page load and
  // `paint()` reads the answer it cached, so a setting written after that boot
  // is not seen until the next one.
  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupByCategory: true }) })`);

  const CATEGORY_ID = spread.wellbeing.id;
  const CATEGORY_NAME = spread.wellbeing.name;
  const CATEGORY_HASH = `#/category/${CATEGORY_ID}`;

  /**
   * **The view unhidden, with a card that is NOT a comparison card and has a
   * real box.**
   *
   * `render()` and `renderOne()` share `#view-categories` — that is decision 3
   * of the brief — and the loser's nodes survive in that container until the
   * winner's `replaceChildren()` runs. So "a card is present" is satisfied by
   * the comparison this page is replacing, and "the view is unhidden" by the
   * comparison alone; `:not(.compare-card)` is what makes this predicate about
   * THIS render, and the box is what makes it about a render that has laid
   * out. Same reasoning as the comparison's own wait above.
   */
  const CATEGORY_READY = `(() => {
    const view = document.getElementById('view-categories');
    if (!view || view.hidden) return false;
    if (view.querySelector('.compare-card')) return false;
    const c = view.querySelector('.card');
    return !!c && c.getBoundingClientRect().width > 0;
  })()`;

  // A tab of its own, for the reason the comparison's block needed one: the
  // main tab carries forward entries from everything above, and a `pushState`
  // prunes them — so `history.length` there reads the same before and after a
  // push that really happened.
  const catTab = await send('Target.createTarget', { url: APP });
  const catSession = (await send('Target.attachToTarget',
    { targetId: catTab.targetId, flatten: true })).sessionId;
  const catEv = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, catSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };

  // The section header BUTTON for this category, not merely a grid with rows
  // in it: whether the list is grouped at all is `paint()`'s decision, and the
  // control this block clicks is what that decision draws. The Compare button
  // is waited for as well, because its going away is asserted below and a
  // button that was never shown would satisfy that vacuously.
  const headerSelector =
    `#grid button.category-section-header[data-category-id="${CATEGORY_ID}"]`;
  await waitUntil(catEv,
    `!!document.querySelector('${headerSelector}')
       && document.getElementById('btn-compare').hidden === false`,
    { what: `the grouped dashboard, with ${CATEGORY_NAME} as a way in` });

  const beforeCategory = await catEv(`history.length`);
  await catEv(`document.querySelector('${headerSelector}').click()`);
  await waitUntil(catEv, CATEGORY_READY, { what: "the category's own page to render" });

  const onCategory = await catEv(`(() => ({
    category: !document.getElementById('view-categories').hidden,
    list: !document.getElementById('view-list').hidden,
    detail: !document.getElementById('view-detail').hidden,
    hash: location.hash,
    length: history.length,
    title: document.querySelector('#view-categories h2')?.textContent ?? '',
    compareHidden: document.getElementById('btn-compare').hidden,
    compareVisible: !!document.getElementById('btn-compare').offsetParent,
  }))()`);
  ck('the section header opens that category and names it in the URL',
    onCategory.category && !onCategory.list && !onCategory.detail
    && onCategory.hash === CATEGORY_HASH, JSON.stringify(onCategory));
  ck('and it is the category whose header was pressed',
    onCategory.title.includes(CATEGORY_NAME),
    `${JSON.stringify(onCategory.title)} for ${CATEGORY_NAME}`);
  // Both halves, as for the comparison: one entry and not none. A
  // `replaceState` here leaves whatever preceded the app underneath, so the
  // next Back walks out of it.
  ck('and it pushes exactly one history entry',
    onCategory.length === beforeCategory + 1,
    `${beforeCategory} -> ${onCategory.length}`);
  // THE depth check from the new side. With this button reachable from here,
  // `dashboard → category → categories` is two of our entries, and one
  // `history.back()` out of the comparison would land on `#/category/N` with
  // the dashboard painted under it — the same hole the habit clause closes
  // from its own side, above.
  ck('the Compare button is absent while a category page is open',
    onCategory.compareHidden === true && onCategory.compareVisible === false,
    JSON.stringify(onCategory));

  /* ---------- and redrawing it does not stack history ---------- */

  // `renderOne` re-enters `routes.go({view:'category'})` on every redraw — the
  // `'change'` refetch is the reachable one — so the same claim the detail
  // view's zoom presses make above has to hold here. Three, because one could
  // pass by luck if the write were skipped for some other reason.
  const beforeRedraw = await catEv(`history.length`);
  await catEv(`(async () => {
    const m = await import('/shared/ui/categories.js');
    await m.openCategory(${CATEGORY_ID});
    await m.openCategory(${CATEGORY_ID});
    await m.openCategory(${CATEGORY_ID});
  })()`);
  await waitUntil(catEv, CATEGORY_READY, { what: 'the redrawn category page' });
  const afterRedraw = await catEv(`(() => ({
    length: history.length, hash: location.hash,
  }))()`);
  ck('redrawing the category page adds no history entries',
    afterRedraw.length === beforeRedraw, `${beforeRedraw} -> ${afterRedraw.length}`);
  ck('and the URL still names it', afterRedraw.hash === CATEGORY_HASH, afterRedraw.hash);

  /* ---------- Back lands on the dashboard, and the dashboard is VISIBLE ---------- */

  // A settle rather than a poll, matching the two Back checks above: one wrong
  // answer is "it did not move at all", which has no predicate to wait on.
  //
  // The URL **and** the visible view, because those come apart:
  // `categorycheck.mjs` records the case where asserting only the view passed
  // against the unfixed code, with `#view-detail` still showing and the
  // fragment the only thing that gave it away.
  await catEv(`history.back()`);
  await sleep(1200);
  const backFromCategory = await catEv(`(() => ({
    category: !document.getElementById('view-categories').hidden,
    detail: !document.getElementById('view-detail').hidden,
    list: !document.getElementById('view-list').hidden,
    hash: location.hash,
    rows: document.querySelectorAll('#grid .habit-row').length,
    compareHidden: document.getElementById('btn-compare').hidden,
  }))()`);
  ck('Back from a category page returns to the dashboard, in the URL and on screen',
    backFromCategory.list && !backFromCategory.category && !backFromCategory.detail
    && backFromCategory.hash === '' && backFromCategory.rows > 0,
    JSON.stringify(backFromCategory));
  ck('and the Compare button comes back with it',
    backFromCategory.compareHidden === false, JSON.stringify(backFromCategory));

  /* ---------- a cold load of the fragment lands on that category ---------- */

  // Its own tab, with no history of its own, for the reason the habit's cold
  // deep link needed one: the check below is about what a FIRST page load
  // leaves behind, and in a reused tab `history.back()` has somewhere to go
  // regardless.
  const coldCat = await send('Target.createTarget',
    { url: `${APP}/${CATEGORY_HASH}` });
  const coldCatSession = (await send('Target.attachToTarget',
    { targetId: coldCat.targetId, flatten: true })).sessionId;
  const coldCatEv = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, coldCatSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await waitUntil(coldCatEv, CATEGORY_READY,
    { what: 'the deep-linked category page' });

  const deepCat = await coldCatEv(`(() => ({
    category: !document.getElementById('view-categories').hidden,
    list: !document.getElementById('view-list').hidden,
    title: document.querySelector('#view-categories h2')?.textContent ?? '',
    hash: location.hash,
    length: history.length,
  }))()`);
  ck('loading the category fragment cold opens that category, not the dashboard',
    deepCat.category && !deepCat.list && deepCat.title.includes(CATEGORY_NAME)
    && deepCat.hash === CATEGORY_HASH, JSON.stringify(deepCat));
  // Exactly two, the same count and the same reasoning as the habit's cold
  // deep link above: the load itself, replaced in place by `routes.go(LIST)`,
  // and the category pushed on top. Asserting the count is what catches the
  // opposite regression — a boot that STACKS entries — which "Back reached the
  // dashboard" alone would pass through. The Android WebView deliberately
  // behaves differently here; this is the browser's half.
  ck('a cold category deep link leaves exactly one entry to go back to',
    deepCat.length === 2, `history.length=${deepCat.length}`);

  await coldCatEv(`history.back()`);
  await sleep(1200);
  const afterColdBack = await coldCatEv(`(() => ({
    category: !document.getElementById('view-categories').hidden,
    list: !document.getElementById('view-list').hidden,
    hash: location.hash,
  }))()`);
  ck('Back from a cold category deep link reaches the dashboard',
    afterColdBack.list && !afterColdBack.category && afterColdBack.hash === '',
    JSON.stringify(afterColdBack));

  /* ---------- and a category that is gone is the dashboard, with a reason ---------- */

  // A bookmark, or a link somebody was sent, naming a category this account
  // has since deleted. `openCategory` reports that as a refusal and the boot
  // falls back to `dashboard.load()`; the failure this guards is a blank page,
  // which the same fragment produces if the refusal is left to render nothing.
  const goneId = await ev(`(async () => {
    const cats = await (await fetch('/api/categories')).json();
    return Math.max(0, ...cats.map(c => c.id)) + 1000;
  })()`);

  // Watched from inside the page rather than read afterwards: the strip clears
  // itself 2.6s after it appears, which is well inside the boot being waited
  // for here — so a read taken after the wait would report no toast on a page
  // that showed one. Same technique as the flash watcher above, and a tab of
  // its own for the same reason: the script has to be installed before the
  // app's first line runs.
  const goneTab = await send('Target.createTarget', { url: 'about:blank' });
  const goneSession = (await send('Target.attachToTarget',
    { targetId: goneTab.targetId, flatten: true })).sessionId;
  const goneEv = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, goneSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send('Page.enable', {}, goneSession);
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__toasts = [];
      new MutationObserver(() => {
        const t = document.getElementById('toast');
        if (t && !t.hidden && t.textContent) window.__toasts.push(t.textContent);
      }).observe(document, { childList: true, subtree: true, attributes: true });
    `,
  }, goneSession);
  await reloadAndWaitFor(goneEv,
    `location.hash === '' && !document.getElementById('view-list').hidden
       && !!document.querySelector('#grid .habit-row')`,
    {
      reload: () => send('Page.navigate', { url: `${APP}/#/category/${goneId}` }, goneSession),
      what: 'the dashboard a missing category falls back to',
    });
  await sleep(400);

  const gone = await goneEv(`(() => ({
    list: !document.getElementById('view-list').hidden,
    category: !document.getElementById('view-categories').hidden,
    detail: !document.getElementById('view-detail').hidden,
    hash: location.hash,
    rows: document.querySelectorAll('#grid .habit-row').length,
    toasts: window.__toasts || [],
  }))()`);
  ck('a category that no longer exists falls back to the dashboard, not a blank page',
    gone.list && !gone.category && !gone.detail && gone.hash === '' && gone.rows > 0,
    JSON.stringify(gone));
  ck('...and says so, rather than leaving the fallback unexplained',
    gone.toasts.some((t) => t.includes('no longer exists')),
    JSON.stringify(gone.toasts));

  /* ---------- two headers inside one flight are still ONE entry ---------- */

  /* **The depth invariant under a race, which every check above asks only of a
     settled app.** `routes.go`'s push branch pushes for any non-empty hash and
     has no `ourEntry` guard on it, so what keeps two of our entries off the
     stack is that only one reply may still render when it lands — and what is
     pinned here is that rule WITHIN `ui/categories.js`, which is the scope
     `openSeq` has. It is deliberately not the whole claim: `ui/detail.js`
     bumps a counter of its own, so a category reply landing after a HABIT has
     opened is not discarded by anything, and still pushes. That case is
     pre-existing — `#btn-compare` has it on master — and closing it needs one
     counter above both views, which is issue #348's, not this block's. The
     three rules in `syncEntry` and `go()` bound what a user can NAVIGATE into;
     a request already in flight is the other question.
     `openCategory` does nothing synchronous before its `await` and
     `/categories/stats` is the heaviest route in the app, so the dashboard
     stays interactive for the whole flight: two section headers pressed in
     that interval are two replies, and an older one still allowed to render
     pushes `#/category/A` UNDER `#/category/B`. One `history.back()` out of
     that lands on a category page with the dashboard painted beneath it.

     `openSeq` in `ui/categories.js` is what discards the older reply.
     Mutation target: delete the `if (ticket !== openSeq) return true;` line in
     `openCategory` (or the `++openSeq` above it) and this block reports two
     entries where it wants one.

     Held in the page rather than with CDP `Fetch`, the same technique
     `categorycheck.mjs` uses for its own two-dialog races — the request has to
     be held BY URL while everything else the page does goes through. The hold
     is released within a second or so on purpose: `ui/api.js` bounds a request
     at 10s and the signal is armed when the app calls `fetch`, not when this
     wrapper passes it on. */

  const RACE_A = { id: spread.wellbeing.id, name: spread.wellbeing.name };
  const RACE_B = { id: spread.reading.id, name: spread.reading.name };

  // Its own tab, for the reason the two blocks above needed one: this block
  // counts history entries, and a tab carrying forward entries from the
  // navigations above reads the same length before and after a push that
  // really happened.
  const raceTab = await send('Target.createTarget', { url: APP });
  const raceSession = (await send('Target.attachToTarget',
    { targetId: raceTab.targetId, flatten: true })).sessionId;
  const raceEv = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, raceSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };

  const headerFor = (id) =>
    `#grid button.category-section-header[data-category-id="${id}"]`;
  await waitUntil(raceEv,
    `!!document.querySelector('${headerFor(RACE_A.id)}')
       && !!document.querySelector('${headerFor(RACE_B.id)}')`,
    { what: 'the grouped dashboard, with both section headers to press' });

  await raceEv(`(() => {
    window.__realFetch = window.__realFetch || window.fetch;
    const realFetch = window.__realFetch;
    window.__held = 0;
    window.__landed = 0;
    window.__release = null;
    const gate = new Promise((r) => { window.__release = r; });
    window.fetch = (url, opts) => {
      // Only this one route, or the page could not finish booting at all and
      // there would be no header to press.
      if (String(url).includes('/api/categories/stats')) {
        window.__held++;
        return gate
          .then(() => realFetch(url, opts))
          .then((res) => { window.__landed++; return res; });
      }
      return realFetch(url, opts);
    };
    return true;
  })()`);

  await raceEv(`document.querySelector('${headerFor(RACE_A.id)}').click()`);
  await waitUntil(raceEv, `window.__held === 1`,
    { what: `the first header's own /categories/stats to be fired and held` });
  await raceEv(`document.querySelector('${headerFor(RACE_B.id)}').click()`);
  await waitUntil(raceEv, `window.__held === 2`,
    { what: `a second header pressed while the first reply is still in flight` });

  // Read with both replies still held, so every entry counted below was
  // pushed by one of the two renders this block is about.
  const beforeRace = await raceEv(`history.length`);
  const stillList = await raceEv(`!document.getElementById('view-list').hidden`);
  ck('sanity: the dashboard is still showing while both replies are held',
    stillList === true, `list showing: ${stillList}`);

  await raceEv(`window.__release()`);
  await waitUntil(raceEv, `window.__landed === 2`,
    { what: 'both held replies to land' });
  // A settle rather than a poll: what this asserts is that a SECOND push did
  // not happen, which has no predicate to wait on. Both renders are one
  // `res.json()` and a few microtasks behind the responses counted above.
  await sleep(1200);

  const race = await raceEv(`(() => ({
    length: history.length,
    hash: location.hash,
    title: document.querySelector('#view-categories h2')
      ? document.querySelector('#view-categories h2').textContent : '',
    category: !document.getElementById('view-categories').hidden,
  }))()`);
  ck('two section headers pressed inside one flight push exactly one entry',
    race.length === beforeRace + 1,
    `${beforeRace} -> ${race.length}, hash ${race.hash}`);
  ck('...and the page left showing is the second one pressed',
    race.category && race.hash === `#/category/${RACE_B.id}`
    && race.title.includes(RACE_B.name),
    JSON.stringify(race));

  // Left as it was found. `fixtures.reset()` clears settings before the next
  // suite the runner starts, but a standalone run of this file has no such
  // reset and would otherwise leave the account grouped.
  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupByCategory: false }) })`);

  console.log(fails === 0 ? '\nALL ROUTE CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
