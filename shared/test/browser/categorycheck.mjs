/**
 * The category picker inside the habit dialog, and inline management of the
 * account's categories — issue #65, phase 1+2's browser half.
 *
 * A unit test can pin `parseCategory` and `resolveCategoryId`; only a real
 * browser can catch the FORM disagreeing with the server about what a save
 * means. The one this suite exists for: `parseHabit` REPLACES, so a payload
 * that forgot `category_id` reads as a stated clear — and the picker has to
 * carry it on every save, not only the one where it changed.
 *
 * `fixtures.reset()` now clears the `categories` table too (it did not, at
 * first — they piled up across every suite that shared an instance, which is
 * why `categorycheck` alone showed up in a non-deterministic failing set
 * after step 6). This suite still clears them itself at the top as well,
 * because `reset()` only runs before a suite launched through `run.mjs` — a
 * standalone run gets no such reset, and would otherwise trip on whatever
 * this same suite left behind last time.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome, waitUntil } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9325);
const profile = mkdtempSync(join(tmpdir(), 'habcat-'));
const chrome = launchChrome(PORT, profile);

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

/**
 * A post-action settle, for the one shape `waitUntil` cannot express: asserting
 * that something did NOT happen has no predicate to poll — plus the settles
 * that follow one of those, where the poll has already told us the answer is
 * in flight. Every other wait in this file is a `waitUntil`.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

const HABIT_NAME = 'Zzz Category Habit';

try {
  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };

  // `Accessibility.getPartialAXTree` needs the DOM domain enabled first (per
  // CDP's own docs on `Accessibility.enable`), so both are turned on once,
  // here, for the block below that reads the computed accessible name AND
  // ROLE rather than the `aria-label` attribute and the source markup.
  await send('DOM.enable', {}, sessionId);
  await send('Accessibility.enable', {}, sessionId);

  /**
   * The COMPUTED role and accessible name of the one element `selector`
   * matches, read from the browser's own accessibility tree over CDP rather
   * than off the `aria-label` attribute or the markup's `role=` — `getAttribute`
   * cannot see what a real assistive technology is actually handed.
   *
   * Measured directly against this Chrome build (`/tmp/debug-ax.mjs`, kept out
   * of the repo): a bare `<div>` with an `aria-label` still reports a computed
   * NAME equal to that label — this Chromium does not enforce "generic" role's
   * ARIA-specified name prohibition for an author-supplied `aria-label` the way
   * it does for a name read off child content (a header with no `aria-label` at
   * all reports an EMPTY computed name while generic, confirmed below). So the
   * name alone does not discriminate `role="heading"` from no role at all for a
   * header that carries a summary — the ROLE does: `generic` vs `heading`, with
   * `aria-level` only reported as a property at all once the role is `heading`.
   * Both are asserted below for that reason, and it is the ROLE assertion that
   * is load-bearing for the mutation this fix's test exists to catch.
   */
  const axInfo = async (selector) => {
    const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId);
    if (!nodeId) return null;
    const { nodes } = await send('Accessibility.getPartialAXTree',
      { nodeId, fetchRelatives: false }, sessionId);
    const node = nodes[0];
    if (!node) return null;
    return {
      role: node.role?.value ?? null,
      level: node.properties?.find((p) => p.name === 'level')?.value?.value ?? null,
      name: node.name?.value ?? '',
    };
  };

  // `DOM.querySelector` takes a CSS selector, which cannot match on text
  // content — so this reads a header's own `data-category-id` (set by
  // `sectionHeader`) via `Runtime.evaluate` first, and builds an attribute
  // selector CDP's DOM domain can actually resolve.
  const headerSelectorByName = async (name) => {
    const found = await ev(`(()=>{
      const headers = [...document.querySelectorAll('#grid .category-section-header')];
      const h = headers.find(x => x.querySelector('.category-section-name')?.textContent === ${JSON.stringify(name)});
      return h ? { categoryId: h.dataset.categoryId, uncategorised: h.classList.contains('uncategorised') } : null;
    })()`);
    if (!found) return null;
    return found.uncategorised
      ? '.category-section-header.uncategorised'
      : `.category-section-header[data-category-id="${found.categoryId}"]`;
  };

  await send('Page.navigate', { url: APP }, sessionId);
  // `!!document.querySelector('#grid .habit-row')` returns the instant the
  // grid holds ANY row — including one left behind by whatever loaded before
  // this navigation settled. 'Meditate' is a fixture habit `reset()` always
  // creates, so its presence means the grid is showing this account's real,
  // freshly painted list rather than a stale one.
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-row .habit-name')].some(n => n.textContent.trim() === 'Meditate')`,
    { what: 'the dashboard to load' });

  // Leftovers from a previous, standalone run of this same suite — not from
  // any other suite, which never touches categories.
  await ev(`(async()=>{
    for (const c of await (await fetch('/api/categories')).json()) {
      await fetch('/api/categories/' + c.id, { method: 'DELETE' });
    }
    for (const h of await (await fetch('/api/habits')).json()) {
      if (h.name === ${JSON.stringify(HABIT_NAME)}) {
        await fetch('/api/habits/' + h.id, { method: 'DELETE' });
      }
    }
  })()`);
  // The cleanup above went straight through the API, so `state.categories` —
  // read once at the boot that already happened — still holds whatever a
  // previous run left. Reload so the dialog's picker renders the account as
  // it actually is now, not the one the page loaded with.
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-row .habit-name')].some(n => n.textContent.trim() === 'Meditate')`,
    { what: 'the dashboard after cleanup' });

  const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})]
    .find(el => el.textContent.trim() === ${JSON.stringify(text)})`;

  // Works from either view, and it has to: this suite calls it from the
  // dashboard and from a habit's own page, and a `'reload'` reaching the
  // dashboard from anywhere ends in `paint()` and so in `views.showList()`.
  // `.habit-meta`'s row is a real DOM node either way, and `.click()` fires
  // its listener whether or not `#grid` is currently the visible view, so
  // re-navigating through it is what settles that rather than waiting on a
  // view that may or may not still be the one left standing.
  //
  // A category mutation used to be one of those emitters and is no longer —
  // see the "adding a category while editing a habit stays on that habit"
  // block below, which is what that costs and what it is worth.
  const openHabitByName = async (name) => {
    await ev(`(()=>{
      const row = [...document.querySelectorAll('#grid .habit-row')]
        .find(r => r.querySelector('.habit-name').textContent.trim() === ${JSON.stringify(name)});
      row.querySelector('.habit-meta').click();
    })()`);
    // The habit's own NAME, not merely "a detail view with an Edit button on
    // it" — this helper is called from a detail view as well as from the
    // dashboard, and that weaker predicate was already satisfied by the page
    // this click is leaving. It returned instantly, Edit reopened the dialog
    // for the PREVIOUS habit, and the block below then asked its question of
    // the wrong form. Caught by that block on its first run; every earlier
    // caller navigates first, which is why nothing had tripped on it yet.
    await waitUntil(ev,
      `!document.getElementById('view-detail').hidden`
      + ` && document.querySelector('#view-detail h2')?.textContent.includes(${JSON.stringify(name)})`
      + ` && !!${byText('#view-detail button', 'Edit')}`,
      { what: `${name}'s own page` });
    await ev(`${byText('#view-detail button', 'Edit')}.click()`);
    await waitUntil(ev, `document.getElementById('habit-dialog').open === true`,
      { what: 'the habit dialog to open' });
  };

  const fetchHabit = (name) => ev(`(async()=>{
    const list = await (await fetch('/api/habits')).json();
    return list.find(h => h.name === ${JSON.stringify(name)}) ?? null;
  })()`);

  const selectedCategoryOption = () => ev(`(()=>{
    const select = document.querySelector('#habit-form [name=category_id]');
    const opt = select.options[select.selectedIndex];
    return { value: select.value, text: opt ? opt.textContent : null };
  })()`);

  /* ---------- a cold deep link must not clear the category on save (issue #65 fix round, item 1) ----------
   *
   * The bug: `app.js`'s boot never runs `dashboard.load()` on a deep link
   * straight to `#/habit/<id>` — only `detail.open()` — so `state.categories`
   * is still its boot default of `[]` the moment `openDialog` first renders
   * the picker. Pressing Save with nothing changed used to send
   * `category_id: null`, and `PUT /habits/:id` REPLACES: the category was
   * gone, silently.
   *
   * This has to boot AT the deep link with no dashboard visit first —
   * `openHabitByName` above cannot be used, because clicking a `.habit-row`
   * IS a dashboard visit, precisely the path that already worked. Less
   * obviously, `Page.navigate`-ing the MAIN tab to a URL differing only by
   * its fragment is not that either: the app's own `hashchange` listener
   * (`ui/routes.js`) handles it as an in-page route change, same document,
   * same `state` — nothing reloads and `state.categories` keeps whatever the
   * main tab's own dashboard visit above already put there. A cold boot needs
   * a target that has never loaded this origin at all, so this opens a BRAND
   * NEW tab straight at the deep link, exactly as `routecheck.mjs` does for
   * the same reason, and leaves the main tab and its dashboard untouched.
   *
   * Proving the guard specifically needs the picker's OWN refetch to
   * provably not have landed yet — and a real network hold (CDP `Fetch`)
   * cannot promise that here: this app registers a service worker, and
   * `sw.js`'s `/api/*` handler fetches from INSIDE the worker's own target,
   * invisible to a `Fetch` domain enabled on the page's session alone (see
   * `hangcheck.mjs` for the technique that DOES reach it, at the cost of
   * attaching to that second target — more machinery than this needs). JS's
   * own execution model gives the same guarantee for free: `fetch()` cannot
   * possibly resolve before control returns to the event loop, so reading the
   * select and pressing Save inside ONE synchronous script — no `await`
   * between the click that starts `openDialog`'s refetch and the submit —
   * proves the picker's own network answer had no opportunity to land,
   * regardless of how fast the network or the worker actually is.
   */
  console.log('--- a cold deep link keeps its category (issue #65 fix round, item 1) ---');

  const deepLinkCategory = await ev(`(async()=>{
    const r = await fetch('/api/categories', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Zzz Deep Link Category', color: '#7c3aed' }) });
    return r.json();
  })()`);
  const deepLinkHabit = await ev(`(async()=>{
    const r = await fetch('/api/habits', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Zzz Deep Link Habit', type: 'boolean',
        category_id: ${JSON.stringify(deepLinkCategory.id)} }) });
    return r.json();
  })()`);
  ck('fixture habit carries the fixture category to start',
    deepLinkHabit.category_id === deepLinkCategory.id, JSON.stringify(deepLinkHabit));

  // A fresh target: nothing has ever loaded this origin in it, so its boot is
  // genuinely cold — no dashboard visit, and `state.categories` starts `[]`.
  const { targetId: coldTargetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: coldSessionId } =
    await send('Target.attachToTarget', { targetId: coldTargetId, flatten: true });
  await send('Page.enable', {}, coldSessionId);
  const coldEv = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, coldSessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };

  await send('Page.navigate', { url: `${APP}/#/habit/${deepLinkHabit.id}` }, coldSessionId);
  await waitUntil(coldEv,
    `!document.getElementById('view-detail').hidden && ${byText('#view-detail button', 'Edit')} &&
     document.querySelector('.detail-head h2')?.textContent.includes('Zzz Deep Link Habit')`,
    { what: "the deep-linked habit's own page, with no dashboard ever painted" });

  // The whole premise of the bug: no dashboard load happened on the way here.
  const gridPainted = await coldEv(`!!document.getElementById('grid').children.length`);
  ck('…and, provably, the dashboard grid never painted at all', !gridPainted, String(gridPainted));

  // Click Edit and press Save in the SAME synchronous script, with no
  // `await` anywhere between them — see the comment above for why that is
  // what makes the timing airtight rather than merely likely. The select's
  // value is read in the same breath, right after the click and right before
  // the submit, so it reports exactly what `openDialog` rendered before its
  // own `refreshCategoryPicker` fetch could possibly have answered.
  const pickedBeforeFetch = await coldEv(`(()=>{
    ${byText('#view-detail button', 'Edit')}.click();
    const select = document.querySelector('#habit-form [name=category_id]');
    const picked = { value: select.value, text: select.options[select.selectedIndex]?.textContent };
    document.getElementById('habit-form').requestSubmit();
    return picked;
  })()`);
  ck('the guard keeps the real category selected, before the picker\'s own fetch could possibly land',
    pickedBeforeFetch.value === String(deepLinkCategory.id),
    JSON.stringify(pickedBeforeFetch));

  await waitUntil(coldEv, `document.getElementById('habit-dialog').open === false`,
    { what: 'the no-op edit to save' });

  const afterColdSave = await coldEv(`(async()=>{
    const r = await fetch('/api/habits/${deepLinkHabit.id}');
    return r.json();
  })()`);
  ck('THE assertion: saving with nothing changed did not clear the category',
    afterColdSave.category_id === deepLinkCategory.id, JSON.stringify(afterColdSave));

  // Second half: given ordinary time to land (nothing is held now — the
  // dialog is closed, but the select this ran against is still in the DOM),
  // `openDialog`'s own refetch replaces the placeholder with the real name.
  // Without that refetch ever having been driven, `state.categories` would
  // still be `[]` and this would time out rather than ever seeing the name.
  await waitUntil(coldEv, `(()=>{
    const select = document.querySelector('#habit-form [name=category_id]');
    const opt = [...select.options].find(o => o.value === ${JSON.stringify(String(deepLinkCategory.id))});
    return opt?.textContent === 'Zzz Deep Link Category';
  })()`, { what: "openDialog's own refetch to land and replace the placeholder with the real name" });

  await coldEv(`(async()=>{
    await fetch('/api/habits/${deepLinkHabit.id}', { method: 'DELETE' });
    await fetch('/api/categories/${deepLinkCategory.id}', { method: 'DELETE' });
  })()`);
  await send('Target.closeTarget', { targetId: coldTargetId });

  /* ---------- a late refetch from a CLOSED dialog must not write its stale
     category into a DIFFERENT habit (fix round 2, item 1) ----------
   *
   * The bug the round-1 fix above introduced: `openDialog`'s fire-and-forget
   * `refreshCategoryPicker` call used to capture `habit?.category_id ?? null`
   * EAGERLY at fire time. Its continuation runs whenever the GET happens to
   * land, with no check that the dialog it started from is still open, still
   * for the same habit, or untouched since — `renderCategorySelect` sets
   * `select.value` UNCONDITIONALLY for a non-null `wanted`. Edit habit A,
   * close it, edit a DIFFERENTLY categorised habit B, and A's late answer
   * forces the live select back to A's category. `saveHabit` reads that
   * value SYNCHRONOUSLY at submit, so Save commits the wrong `category_id`
   * with nothing on screen to say so — the shape of commit `2f456f5` (#244):
   * a rollback belongs to the write it was made for, not to whichever habit
   * is open when it runs.
   *
   * Reproducing this needs A's own refetch to still be unresolved once B's
   * dialog is showing its own value, and needs it to resolve again — not
   * before, not never — while B is open. Real network timing cannot promise
   * either half, and CDP's `Fetch` domain cannot reach this specific GET at
   * all: it intercepts at the network layer, and this app's `GET /api/*`
   * traffic is answered by the SERVICE WORKER's `networkFirst`, running
   * inside the worker's own target, invisible to `Fetch` enabled on the page
   * session alone (see the cold-deep-link comment above, which hits the same
   * wall for the opposite reason). Replacing the PAGE's own `window.fetch`
   * intercepts the call before the browser routes it anywhere, worker
   * included, and releases it on a signal this script controls rather than
   * the clock — matching only the one GET behind `openDialog`'s own refetch
   * for A, by method and path, so B's own refetch and every other request
   * still goes straight to the real network.
   */
  console.log('--- a late refetch from a closed dialog does not write into a different habit (fix round 2, item 1) ---');

  const raceCatA = await ev(`(async()=>{
    const r = await fetch('/api/categories', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Zzz Race Category A', color: '#f43f5e' }) });
    return r.json();
  })()`);
  const raceCatB = await ev(`(async()=>{
    const r = await fetch('/api/categories', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Zzz Race Category B', color: '#22c55e' }) });
    return r.json();
  })()`);
  const raceHabitA = await ev(`(async()=>{
    const r = await fetch('/api/habits', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Zzz Race Habit A', type: 'boolean',
        category_id: ${JSON.stringify(raceCatA.id)} }) });
    return r.json();
  })()`);
  const raceHabitB = await ev(`(async()=>{
    const r = await fetch('/api/habits', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Zzz Race Habit B', type: 'boolean',
        category_id: ${JSON.stringify(raceCatB.id)} }) });
    return r.json();
  })()`);

  // A real reload, not a route change: `state.categories` has to come from a
  // genuine `dashboard.load()` holding both fixtures before the exploit
  // below runs — deliberately NOT the cold-boot case above, so each dialog's
  // own synchronous render resolves straight to the real name, no
  // placeholder in play, and the only thing left to race is the LATE
  // continuation this block is about.
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-row .habit-name')].some(n => n.textContent.trim() === 'Zzz Race Habit B')`,
    { what: 'the dashboard to load with both race fixtures' });

  const picked = await ev(`(()=>{
    const realFetch = window.fetch.bind(window);
    window.__realFetch = realFetch;
    window.__raceGetLanded = false;
    let capturedA = false;
    const held = new Promise((res) => { window.__releaseA = res; });
    // Matches only the GET behind A's own refetch, by method and path — B's
    // own refetch (fired below) is a second, unheld call to the same path and
    // must resolve normally, since it is not what this is testing.
    window.fetch = (url, opts) => {
      const isCategoriesGet = String(url).endsWith('/api/categories') &&
        (!opts || (opts.method ?? 'GET').toUpperCase() === 'GET');
      if (isCategoriesGet && !capturedA) {
        capturedA = true;
        return held.then(() => realFetch(url, opts)).then((res) => {
          // Set on the SAME chain \`api()\`'s own \`await fetch(...)\` resolves
          // through, so observing this true from Node means that resolution
          // has already been scheduled — the render it leads to is a
          // synchronous continuation of it, and every later poll in this
          // suite is itself a further CDP round trip, which is far longer
          // than the microtasks between the two.
          window.__raceGetLanded = true;
          return res;
        });
      }
      return realFetch(url, opts);
    };
    return (async () => {
      const hd = await import('/shared/ui/habit-dialog.js');
      // A's own picker refetch fires here and is held above, unresolved.
      hd.openDialog(${JSON.stringify(raceHabitA)});
      document.getElementById('dialog-cancel').click();
      // B's own picker refetch fires here too — a second, unheld GET.
      hd.openDialog(${JSON.stringify(raceHabitB)});
      const select = document.querySelector('#habit-form [name=category_id]');
      return { value: select.value, text: select.options[select.selectedIndex]?.textContent };
    })();
  })()`);
  ck("opening B shows B's own category, not a placeholder",
    picked.text === 'Zzz Race Category B', JSON.stringify(picked));

  // Release A's held GET now that B's dialog is the one open and showing its
  // own value — this is the exact moment the round-1 bug clobbers it.
  await ev(`window.__releaseA()`);
  await waitUntil(ev, `window.__raceGetLanded === true`,
    { what: "A's held categories GET to actually land" });

  const afterRace = await ev(`(()=>{
    const select = document.querySelector('#habit-form [name=category_id]');
    return { value: select.value, text: select.options[select.selectedIndex]?.textContent };
  })()`);
  ck("THE assertion: A's late-landing refetch did not overwrite B's live selection with A's category",
    afterRace.value === String(raceCatB.id), JSON.stringify(afterRace));

  await ev(`window.fetch = window.__realFetch;
    document.getElementById('habit-form').requestSubmit(); true`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the no-op edit on B to save' });

  const afterRaceSave = await ev(`(async()=>{
    const r = await fetch('/api/habits/${raceHabitB.id}');
    return r.json();
  })()`);
  ck('THE assertion: B kept its OWN category after saving with nothing changed',
    afterRaceSave.category_id === raceCatB.id, JSON.stringify(afterRaceSave));

  await ev(`(async()=>{
    await fetch('/api/habits/${raceHabitA.id}', { method: 'DELETE' });
    await fetch('/api/habits/${raceHabitB.id}', { method: 'DELETE' });
    await fetch('/api/categories/${raceCatA.id}', { method: 'DELETE' });
    await fetch('/api/categories/${raceCatB.id}', { method: 'DELETE' });
  })()`);
  // The cleanup above went straight through the API, same as the top-of-suite
  // one: `state.categories` still holds the two race fixtures until something
  // re-fetches it, and the next block's "no category exists yet" check reads
  // that state, not the server, through `renderCategoryManage`.
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-row .habit-name')].some(n => n.textContent.trim() === 'Meditate')`,
    { what: 'the dashboard after the race block\'s cleanup' });

  /* ---------- create a category from a chip, and assign it to a habit ---------- */

  await ev(`document.getElementById('btn-new').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === true`,
    { what: 'the create dialog to open' });

  ck('the six suggestion chips are there to start from',
    await ev(`document.querySelectorAll('#category-chips button').length`) === 6);
  ck('and no category exists yet, so the manage list is empty',
    await ev(`document.querySelectorAll('#category-manage .category-manage-row').length`) === 0);

  await ev(`${byText('#category-chips button', 'Health')}.click()`);
  await waitUntil(ev, `document.getElementById('category-hint').textContent.includes('Added "Health"')`,
    { what: 'the chip to create "Health"' });

  /* ---------- e: a single category draws no move arrows (issue #65 step 1) ----------
   *
   * The one moment in this whole suite with EXACTLY one category on the
   * account — Health, just created, nothing else yet — so this is the
   * natural place to ask the question, rather than staging a throwaway
   * account state later on. `renderCategoryManage`'s `canReorder` gate is
   * `state.categories.length > 1`.
   *
   * Mutation target: render the arrows unconditionally, ignoring
   * `state.categories.length < 2` — this must FAIL.
   */
  const singleCategoryManage = await ev(`(()=>({
    rows: document.querySelectorAll('#category-manage .category-manage-row').length,
    arrows: document.querySelectorAll(
      '#category-manage .category-move-up, #category-manage .category-move-down').length,
  }))()`);
  ck('e: with a single category, no move arrows are rendered at all',
    singleCategoryManage.rows === 1 && singleCategoryManage.arrows === 0,
    JSON.stringify(singleCategoryManage));

  ck('the chip did not assign it on its own — that is a separate, deliberate step',
    (await selectedCategoryOption()).value === '');

  const healthId = await ev(`(()=>{
    const select = document.querySelector('#habit-form [name=category_id]');
    const opt = [...select.options].find(o => o.textContent === 'Health');
    select.value = opt.value;
    return opt.value;
  })()`);
  ck('and picking it in the select now offers "Health"', !!healthId, String(healthId));

  await ev(`document.querySelector('#habit-form [name=name]').value = ${JSON.stringify(HABIT_NAME)}`);
  await ev(`document.getElementById('habit-form').requestSubmit()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the create to finish' });
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-row .habit-name')].some(n => n.textContent.trim() === ${JSON.stringify(HABIT_NAME)})`,
    { what: 'the new habit on the list' });

  const created = await fetchHabit(HABIT_NAME);
  ck('the created habit carries the category chosen from the picker',
    created && String(created.category_id) === healthId,
    JSON.stringify({ category_id: created?.category_id, healthId }));

  /* ---------- a reload keeps the assignment ---------- */

  await send('Page.navigate', { url: APP }, sessionId);
  // `openHabitByName` below finds its row with no wait of its own, so this
  // has to hold for the row it is about to look for — not merely "a" row.
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-row .habit-name')].some(n => n.textContent.trim() === ${JSON.stringify(HABIT_NAME)})`,
    { what: 'the dashboard after reload' });
  await openHabitByName(HABIT_NAME);

  const afterReload = await selectedCategoryOption();
  ck('after a reload the dialog still shows the assigned category selected',
    afterReload.text === 'Health', JSON.stringify(afterReload));

  /* ---------- renaming the category: the habit follows by id, not by name ---------- */

  await ev(`(()=>{
    const row = [...document.querySelectorAll('#category-manage .category-manage-row')]
      .find(r => r.querySelector('.category-manage-name')?.textContent === 'Health');
    row.querySelector('.category-edit').click();
  })()`);
  await waitUntil(ev, `!!document.querySelector('#category-manage .category-edit-name')`,
    { what: 'the rename controls' });
  await ev(`document.querySelector('#category-manage .category-edit-name').value = 'Zzz Renamed Category'`);
  await ev(`${byText('#category-manage button', 'Save')}.click()`);
  await waitUntil(ev,
    `[...document.querySelectorAll('#category-manage .category-manage-name')].some(n => n.textContent === 'Zzz Renamed Category')`,
    { what: 'the rename to land in the manage list' });

  const afterRenameSelect = await selectedCategoryOption();
  ck('the open form\'s own select follows the rename',
    afterRenameSelect.text === 'Zzz Renamed Category', JSON.stringify(afterRenameSelect));

  const afterRenameApi = await ev(`(async()=>{
    const cats = await (await fetch('/api/categories')).json();
    return cats.find(c => String(c.id) === ${JSON.stringify(healthId)});
  })()`);
  ck('the rename is the same category, by id, not a new one',
    afterRenameApi?.name === 'Zzz Renamed Category', JSON.stringify(afterRenameApi));

  /* ---------- editing the habit without touching the picker keeps the category ---------- */
  //
  // THE assertion this suite exists for: `parseHabit` REPLACES, so a payload
  // built without `category_id` reads as a stated clear. Mutation target:
  // drop `category_id` from `saveHabit`'s payload in habit-dialog.js.

  await ev(`document.querySelector('#habit-form [name=color]').value = '#654321'`);
  await ev(`document.getElementById('habit-form').requestSubmit()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the colour-only edit to save' });

  const afterColorEdit = await fetchHabit(HABIT_NAME);
  ck('a colour-only edit through the real form still carries the category (the replace rule)',
    afterColorEdit && String(afterColorEdit.category_id) === healthId
      && afterColorEdit.color === '#654321',
    JSON.stringify(afterColorEdit));

  /* ---------- deleting the category leaves the habit uncategorised ---------- */

  await openHabitByName(HABIT_NAME);
  await ev(`(()=>{
    const row = [...document.querySelectorAll('#category-manage .category-manage-row')]
      .find(r => r.querySelector('.category-manage-name')?.textContent === 'Zzz Renamed Category');
    row.querySelector('.category-delete').click();
  })()`);
  await waitUntil(ev, `document.querySelectorAll('#category-manage .category-manage-row').length === 0`,
    { what: 'the category to leave the manage list' });

  const selectAfterDelete = await ev(`document.querySelector('#habit-form [name=category_id]').value`);
  ck('the open form itself falls back to "(none)" when its own category is deleted',
    selectAfterDelete === '', JSON.stringify(selectAfterDelete));

  const afterCategoryDelete = await fetchHabit(HABIT_NAME);
  ck('the habit survives a category delete, uncategorised (ON DELETE SET NULL, never CASCADE)',
    afterCategoryDelete && afterCategoryDelete.category_id === null,
    JSON.stringify(afterCategoryDelete));

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the dialog to close' });

  /* ---------- deleting the HABIT and undoing it brings its category back ---------- */

  await openHabitByName(HABIT_NAME);
  await ev(`${byText('#category-chips button', 'Work')}.click()`);
  await waitUntil(ev, `document.getElementById('category-hint').textContent.includes('Added "Work"')`,
    { what: 'the chip to create "Work"' });
  const workId = await ev(`(()=>{
    const select = document.querySelector('#habit-form [name=category_id]');
    const opt = [...select.options].find(o => o.textContent === 'Work');
    select.value = opt.value;
    return opt.value;
  })()`);
  await ev(`document.getElementById('habit-form').requestSubmit()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'assigning "Work" to save' });

  // Re-navigate rather than wait on whichever view the chip's own `reload`
  // and this save's `change` happen to leave standing — see the comment on
  // `openHabitByName` above.
  await openHabitByName(HABIT_NAME);

  // The confirm is a preference (confirmDelete, on by default), not the claim
  // this block is making, and a real modal one would hang this evaluation.
  await ev(`window.confirm = () => true; true`);
  await ev(`document.getElementById('dialog-delete').click()`);
  await waitUntil(ev,
    `!document.getElementById('view-list').hidden && !!document.querySelector('#toast .toast-action')`,
    { what: 'the delete to land with an undo toast' });

  const afterHabitDelete = await ev(`(async()=>{
    const habits = await (await fetch('/api/habits')).json();
    const cats = await (await fetch('/api/categories')).json();
    return {
      habitGone: !habits.some(h => h.name === ${JSON.stringify(HABIT_NAME)}),
      workStillThere: cats.some(c => c.name === 'Work'),
    };
  })()`);
  ck('deleting the habit leaves its category alone',
    afterHabitDelete.habitGone && afterHabitDelete.workStillThere,
    JSON.stringify(afterHabitDelete));

  await ev(`document.querySelector('#toast .toast-action').click()`);
  await waitUntil(ev, `document.getElementById('toast').textContent.includes('Restored')`,
    { what: 'the restore to report' });
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-row .habit-name')].some(n => n.textContent.trim() === ${JSON.stringify(HABIT_NAME)})`,
    { what: 'the restored habit back on the list' });

  const restored = await fetchHabit(HABIT_NAME);
  // restoreHabit POSTs the GET /habits/:id snapshot (habit-dialog.js), which
  // already carries category_id — this asserts that rather than assuming it.
  ck('undoing the delete brings the category back with it',
    restored && String(restored.category_id) === workId,
    JSON.stringify({ category_id: restored?.category_id, workId }));

  /* ---------- grouping the dashboard by category (step 7) ---------- */

  // A second category, assigned to a different habit — so ordering and
  // "every habit drawn exactly once" are real questions rather than
  // vacuously true with only one category in the account. `Work` (from the
  // block above) sits at the lower `position`, having been created first, so
  // its section must draw before `Fitness`'s.
  await openHabitByName('Meditate');
  await ev(`${byText('#category-chips button', 'Fitness')}.click()`);
  await waitUntil(ev, `document.getElementById('category-hint').textContent.includes('Added "Fitness"')`,
    { what: 'the chip to create "Fitness"' });
  await ev(`(()=>{
    const select = document.querySelector('#habit-form [name=category_id]');
    const opt = [...select.options].find(o => o.textContent === 'Fitness');
    select.value = opt.value;
  })()`);
  await ev(`document.getElementById('habit-form').requestSubmit()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'assigning "Fitness" to Meditate to save' });

  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupByCategory: true }) })`);
  await send('Page.navigate', { url: APP }, sessionId);
  // Five habits total: the four fixtures plus this suite's own — a plain "a
  // row exists" predicate would pass on a grid still showing the PREVIOUS
  // (flat) paint from before this navigation settled.
  await waitUntil(ev, `document.querySelectorAll('#grid .habit-row').length === 5`,
    { what: 'the grouped dashboard to load with all five habits' });

  const grouping = await ev(`(()=>{
    const headers = [...document.querySelectorAll('#grid .category-section-header')];
    const last = headers.at(-1);
    return {
      headerNames: headers.map(h => h.querySelector('.category-section-name').textContent),
      lastIsUncategorised: last ? last.classList.contains('uncategorised') : false,
      uncategorisedCount: last ? last.querySelector('.category-section-count').textContent : null,
      dragHandles: document.querySelectorAll('#grid .drag-handle').length,
      rows: document.querySelectorAll('#grid .habit-row').length,
    };
  })()`);
  ck('one header per category, in position order (Work before Fitness)',
    grouping.headerNames[0] === 'Work' && grouping.headerNames[1] === 'Fitness',
    JSON.stringify(grouping.headerNames));
  // The three fixture habits with no category of their own: Gym, Read, and
  // "No late-night snacks" — Meditate just moved into Fitness above.
  ck('the Uncategorised section is last, and its count is visible',
    grouping.lastIsUncategorised === true && grouping.uncategorisedCount === '3',
    JSON.stringify(grouping));
  ck('every habit is drawn exactly once across the grouped sections',
    grouping.rows === 5, String(grouping.rows));
  // Mutation target: remove `&& !grouped` from `reorderable` in dashboard.js —
  // `position` is one flat order and a drag while grouped would clump habits
  // by category permanently, from an action that never said it would.
  ck('no drag handle while grouped',
    grouping.dragHandles === 0, String(grouping.dragHandles));

  /* ---------- summarising each section (issue #65 step 4) ----------

     Still the same load: `Work` holds only `HABIT_NAME`, created moments ago
     and never logged; `Fitness` holds only `Meditate`, which the fixture
     seed logs on every day but every ninth. That gives one category whose
     mean is null (`—`) and one with a real percentage, from a single real
     `/overview` response rather than anything staged. */

  const figures = await ev(`(()=>{
    const byName = Object.fromEntries(
      [...document.querySelectorAll('#grid .category-section-header')]
        .map(h => [h.querySelector('.category-section-name').textContent, h]));
    const read = (name) => {
      const header = byName[name];
      const figure = header?.querySelector('.category-section-figure');
      return {
        ariaLabel: header ? header.getAttribute('aria-label') : null,
        mean: figure ? figure.querySelector('.category-section-mean').textContent : null,
        spread: figure?.querySelector('.category-section-spread')
          ? figure.querySelector('.category-section-spread').textContent : null,
        title: figure ? figure.title : null,
      };
    };
    return { work: read('Work'), fitness: read('Fitness') };
  })()`);
  ck('a never-logged category draws an em dash for its mean, not a percentage',
    figures.work.mean === '—', JSON.stringify(figures.work));
  ck('its title reuses the never-logged wording ui/categories.js already settled on',
    figures.work.title != null && figures.work.title.includes('never logged'),
    JSON.stringify(figures.work));
  // THE assertion for fix round 1, item 2: `header.getAttribute('aria-label')`
  // is true of a string no assistive technology is guaranteed to read — a bare
  // `<div>` maps to `role="generic"`, which ARIA marks name-prohibited. This
  // reads the COMPUTED role and name instead, out of the browser's own
  // accessibility tree over CDP (`Accessibility.getPartialAXTree`).
  // Mutation target: remove the `role="heading"` `sectionHeader` sets, leaving
  // the `aria-label` in place. The ROLE assertion is the one that is load
  // bearing here: measured directly against this Chrome build, the computed
  // NAME still comes back as the `aria-label` text even with no role at all —
  // this Chromium does not withhold an author-supplied name from a generic
  // element the way it withholds a CONTENT-derived one (see the no-summary
  // case below, where the mutation does empty the name) — so asserting the
  // name alone would pass against the unfixed markup. The computed ROLE does
  // not: it reports `generic`, not `heading`, with no `level` property at all,
  // until `role="heading"` is restored.
  const workHeaderSelector = await headerSelectorByName('Work');
  const workAx = await axInfo(workHeaderSelector);
  ck('THE assertion: the header is exposed to the accessibility tree as a HEADING, level 2 — not a generic div',
    workAx?.role === 'heading' && workAx?.level === 2,
    JSON.stringify({ workAx }));
  ck('and its computed accessible name (not just the aria-label attribute) carries the same reason',
    workAx?.name != null && workAx.name.includes('Work') && workAx.name.includes('never logged'),
    JSON.stringify({ workAx, ariaLabelAttribute: figures.work.ariaLabel }));
  ck('a category with a logged member draws a real mean percentage',
    figures.fitness.mean != null && /^\d+%$/.test(figures.fitness.mean),
    JSON.stringify(figures.fitness));
  // Fitness holds exactly one member (Meditate), so `best === worst`
  // (`summariseMembers`'s tie rule) and the spread must be that ONE number,
  // never `NN–NN%`.
  ck('a one-member category draws one spread number, not a range',
    figures.fitness.spread === figures.fitness.mean, JSON.stringify(figures.fitness));

  // The Uncategorised section has three members (Gym, Read, "No late-night
  // snacks") with different scores, so it is the one that can actually catch
  // `best` and `worst` swapped in the spread. The expected string is built
  // from a fresh, independent `/overview` fetch — not from anything
  // `dashboard.js` itself computed — so a swap in the RENDERER still shows up
  // even though the arithmetic behind `mean`/`best`/`worst` is out of scope
  // for this suite (that is `stats.test.js`'s job).
  // Mutation target: swap `best` and `worst` in `sectionHeader`'s spread.
  const overview = await ev(`(async()=>(await (await fetch('/api/overview?days=7')).json()))()`);
  const uncategorised = overview.categorySummaries.find((s) => s.id === null);
  const pctOf = (v) => `${Math.round(v * 100)}%`;
  const expectedSpread = uncategorised.best.score === uncategorised.worst.score
    ? pctOf(uncategorised.best.score)
    : `${pctOf(uncategorised.worst.score)}–${pctOf(uncategorised.best.score)}`;
  const uncategorisedFigure = await ev(`(()=>{
    const headers = [...document.querySelectorAll('#grid .category-section-header')];
    const header = headers.find(h => h.classList.contains('uncategorised'));
    const figure = header?.querySelector('.category-section-figure');
    return {
      mean: figure ? figure.querySelector('.category-section-mean').textContent : null,
      spread: figure ? figure.querySelector('.category-section-spread').textContent : null,
    };
  })()`);
  ck('the Uncategorised spread reads worst–best, matching a fresh /overview fetch',
    uncategorisedFigure.spread === expectedSpread,
    JSON.stringify({ uncategorisedFigure, expectedSpread, uncategorised }));
  ck('and its mean matches the same fetch',
    uncategorisedFigure.mean === pctOf(uncategorised.mean),
    JSON.stringify({ uncategorisedFigure, uncategorised }));

  /* ---------- fix round 1, item 1: a category whose members are all
     archived is not "empty" ----------

     `Work` holds exactly one habit, `HABIT_NAME` — never logged, from the
     block above. `/overview` without `?archived=true` fetches only ACTIVE
     habits while `categories` is fetched whole, so archiving that one habit
     makes `Work` arrive with `members: 0`, indistinguishable on the payload
     from a category nobody has ever put anything in — the shape
     `ui/categories.js` already refuses to say "No habits in this category
     yet." about (its own `archivedExcluded` count, ~line 268-279).

     Mutation target: restore the `summary.members === 0` branch in
     `sectionHeader` that draws the em dash and that sentence again — this
     block's assertions must FAIL, naming the string. */

  const workHabit = await fetchHabit(HABIT_NAME);
  await ev(`fetch('/api/habits/${workHabit.id}', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(${JSON.stringify({ ...workHabit, archived: true })}),
  })`);
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev, `document.querySelectorAll('#grid .habit-row').length === 4`,
    { what: 'the dashboard to reload with the archived habit dropped from the active list' });

  const archivedOut = await ev(`(()=>{
    const headers = [...document.querySelectorAll('#grid .category-section-header')];
    const work = headers.find(h => h.querySelector('.category-section-name')?.textContent === 'Work');
    return {
      workPresent: !!work,
      workCount: work ? work.querySelector('.category-section-count').textContent : null,
      workHasFigure: work ? !!work.querySelector('.category-section-figure') : null,
      workAriaLabel: work ? work.getAttribute('aria-label') : undefined,
      // The false sentence, anywhere on the page — a title on ANY figure or
      // an aria-label on ANY header, not only Work's, since a members-0
      // category could in principle draw it from either place.
      falseSentenceAnywhere: document.getElementById('grid').innerHTML
        .includes('No habits in this category yet'),
    };
  })()`);
  ck('a category whose only member is now archived still draws its header',
    archivedOut.workPresent === true, JSON.stringify(archivedOut));
  ck('its count still reads 0, the true figure `/overview` has for it',
    archivedOut.workCount === '0', JSON.stringify(archivedOut));
  ck('THE assertion: it draws NO figure at all — not a different sentence',
    archivedOut.workHasFigure === false, JSON.stringify(archivedOut));
  ck('THE assertion: and so no aria-label either, on this or any header',
    archivedOut.workAriaLabel === undefined || archivedOut.workAriaLabel === null,
    JSON.stringify(archivedOut));
  ck('THE assertion: the false "No habits in this category yet." sentence ' +
     'appears nowhere on the page, in a title or an aria-label',
    archivedOut.falseSentenceAnywhere === false, JSON.stringify(archivedOut));

  // Restored before the rest of the suite, which assumes `HABIT_NAME` is on
  // the active list under `Work` with a real (never-logged) summary.
  await ev(`fetch('/api/habits/${workHabit.id}', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(${JSON.stringify({ ...workHabit, archived: false })}),
  })`);
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev, `document.querySelectorAll('#grid .habit-row').length === 5`,
    { what: 'the dashboard to reload with the habit un-archived again' });

  // A query that matches only Meditate — Fitness still draws a header with a
  // real count (1), so this is unlike the no-match case below: the headers
  // stay, and it is the FIGURES that must vanish, because a mean drawn over
  // the unfiltered category would disagree with the count sitting right
  // beside it. Mutation target: drop `!filtering` from `summarised`.
  await ev(`(async()=>{
    const { state } = await import('/shared/ui/store.js');
    const dash = await import('/shared/ui/dashboard.js');
    state.query = 'Meditate';
    dash.paint();
    return true;
  })()`);
  const whileFiltering = await ev(`(()=>({
    headers: document.querySelectorAll('#grid .category-section-header').length,
    figures: document.querySelectorAll('#grid .category-section-figure').length,
  }))()`);
  ck('section headers stay while filtering, but every figure disappears',
    whileFiltering.headers > 0 && whileFiltering.figures === 0,
    JSON.stringify(whileFiltering));

  // Fitness draws no figure here (no `aria-label` at all — `summarised` is
  // false while filtering), which is the other half of the fix: `role` and
  // `aria-level` are set UNCONDITIONALLY, so a header with nothing to
  // summarise is still exposed as a heading with a usable name, read off its
  // own child text (name + count) rather than left silent for want of an
  // `aria-label`. THE mutation-catching half for this case, confirmed
  // directly against this Chrome build: with no `role="heading"`, a generic
  // element's computed name from CONTENT (as opposed to an `aria-label`) comes
  // back genuinely EMPTY, so this one assertion alone would already fail the
  // mutation — the role check is added anyway, for the same reason as above.
  const fitnessAx = await axInfo(await headerSelectorByName('Fitness'));
  ck('THE assertion: a header with no summary is still exposed as a HEADING, level 2',
    fitnessAx?.role === 'heading' && fitnessAx?.level === 2,
    JSON.stringify({ fitnessAx }));
  ck('and it still has a usable accessible name, from its own text',
    fitnessAx?.name != null && fitnessAx.name.length > 0 && fitnessAx.name.includes('Fitness'),
    JSON.stringify({ fitnessAx }));

  // Same figures, same real `categorySummaries` still sitting in `state` —
  // only the client-side archived flag changes, exactly as `reorderable`
  // reads `state.showArchived` for its own guard. No refetch: `paint()`
  // alone is enough to prove the guard, and cheaper than restaging an
  // archived habit through the API.
  await ev(`(async()=>{
    const { state } = await import('/shared/ui/store.js');
    const dash = await import('/shared/ui/dashboard.js');
    state.query = '';
    state.showArchived = true;
    dash.paint();
    return true;
  })()`);
  const whileArchivedShown = await ev(`(()=>({
    headers: document.querySelectorAll('#grid .category-section-header').length,
    figures: document.querySelectorAll('#grid .category-section-figure').length,
  }))()`);
  ck('and every figure disappears while archived habits are shown, too',
    whileArchivedShown.headers > 0 && whileArchivedShown.figures === 0,
    JSON.stringify(whileArchivedShown));

  // Restored before the next block, which makes its own assumptions about
  // `state.query` and `state.showArchived` starting clean.
  await ev(`(async()=>{
    const { state } = await import('/shared/ui/store.js');
    const dash = await import('/shared/ui/dashboard.js');
    state.showArchived = false;
    dash.paint();
    return true;
  })()`);

  /* ---------- no section headers over the empty state or a no-match search
     (fix round item 5) — grouping is still on from the block above ---------- */

  // A search that matches nothing. The box itself may be hidden below
  // SEARCH_FROM habits, but `state.query` is what `paint()` reads regardless
  // — setting it directly through the running module rather than the DOM
  // control is what lets this run at any habit count.
  await ev(`(async()=>{
    const { state } = await import('/shared/ui/store.js');
    const dash = await import('/shared/ui/dashboard.js');
    state.query = 'zzz-nothing-here-matches-this';
    dash.paint();
    return true;
  })()`);
  const noMatchGrouped = await ev(`(()=>({
    headers: document.querySelectorAll('#grid .category-section-header').length,
    sentenceVisible: !document.getElementById('empty-nomatch').hidden,
  }))()`);
  ck('grouped, searching past every result: no section headers, just the sentence',
    noMatchGrouped.headers === 0 && noMatchGrouped.sentenceVisible,
    JSON.stringify(noMatchGrouped));

  // An empty ACCOUNT, without touching any fixture: switching to the archived
  // list is an account with zero habits on it, since nothing here is
  // archived, and it is still `groupByCategory: true`.
  await ev(`(async()=>{
    const { state } = await import('/shared/ui/store.js');
    const dash = await import('/shared/ui/dashboard.js');
    state.query = '';
    state.showArchived = true;
    await dash.load();
    return true;
  })()`);
  const emptyGrouped = await ev(`(()=>({
    headers: document.querySelectorAll('#grid .category-section-header').length,
    archivedEmptyVisible: !document.getElementById('empty-archived').hidden,
  }))()`);
  ck('grouped, and the account (the archived list) is empty: no section headers either',
    emptyGrouped.headers === 0 && emptyGrouped.archivedEmptyVisible,
    JSON.stringify(emptyGrouped));

  // Back to the active list — the next block's own navigation would reset
  // this anyway, but leaving it set is not this test's to risk.
  await ev(`(async()=>{
    const { state } = await import('/shared/ui/store.js');
    const dash = await import('/shared/ui/dashboard.js');
    state.showArchived = false;
    await dash.load();
    return true;
  })()`);

  /* ---------- turning the setting back off restores the flat list ---------- */

  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupByCategory: false }) })`);
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev, `document.querySelectorAll('#grid .habit-row').length === 5`,
    { what: 'the flat dashboard to load again' });

  const flat = await ev(`(()=>({
    headers: document.querySelectorAll('#grid .category-section-header').length,
    dragHandles: document.querySelectorAll('#grid .drag-handle').length,
  }))()`);
  ck('with the setting off there are no section headers',
    flat.headers === 0, JSON.stringify(flat));
  ck('and the drag handle is back',
    flat.dragHandles > 0, JSON.stringify(flat));

  /* ---------- review round 3: one dialog must not inherit the last one's
     category ----------

     The third defect on this `<select>`, and the first that needs no race at
     all. `openDialog` renders the picker as
     `renderCategorySelect(habit?.category_id ?? null)`, so an UNCATEGORISED
     habit — and every create — arrives as `null`; written `!= null`, that is
     the same branch as the absent argument, which deliberately keeps whatever
     the control is already showing. The `<select>` is one persistent element
     in `index.html`, `<dialog>.close()` does not reset a form and this module
     has no `form.reset()`, so what it kept was the PREVIOUS dialog's value.

     Neither of the two blocks above can see it: the race block gives BOTH its
     habits a category, so `wanted` is a number on either open, and the create
     block earlier in this suite is preceded by a `Page.navigate` that throws
     the stale value away. This block deliberately never navigates.

     Mutation target: `wanted !== undefined && wanted !== null` back to
     `wanted != null` in `renderCategorySelect` (habit-dialog.js). */

  // `Work` is this suite's own habit's category, from the undo block above.
  await openHabitByName(HABIT_NAME);

  // While a categorised dialog is open: the chip for a category the account
  // ALREADY holds. The 409 is the server's answer and not the user's problem,
  // so it reads as an ordinary hint rather than an error — and it must not
  // disturb the selection this form arrived with.
  // Mutation target: the `category already exists` branch in the chip handler.
  await ev(`${byText('#category-chips button', 'Work')}.click()`);
  await waitUntil(ev, `document.getElementById('category-hint').textContent.includes('already exists')`,
    { what: 'the chip to report the category it could not create again' });
  const dupHint = await ev(`(()=>{
    const hint = document.getElementById('category-hint');
    return { text: hint.textContent, isError: hint.classList.contains('error') };
  })()`);
  ck('a chip for a category that already exists says so, and not in the error class',
    dupHint.isError === false && dupHint.text.includes('pick it above'),
    JSON.stringify(dupHint));

  const carriedFrom = await selectedCategoryOption();
  ck('sanity: the categorised habit is showing its OWN category, so there is ' +
     'a real value here for the next dialog to inherit',
    carriedFrom.text === 'Work', JSON.stringify(carriedFrom));

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the categorised habit\'s dialog to close' });

  // No navigation between the two opens — that is the whole point.
  await ev(`document.getElementById('btn-new').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === true`,
    { what: 'the create dialog to open' });
  const createPicker = await selectedCategoryOption();
  ck('THE assertion: "New habit" opens on "(none)", not on the category the ' +
     'habit edited just before it was in',
    createPicker.value === '', JSON.stringify(createPicker));

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the create dialog to close' });

  // Re-arm the control with a real category, then open an UNCATEGORISED
  // habit — the case that ends in a committed wrong value rather than a
  // visibly odd create form, because `PUT /habits/:id` REPLACES.
  await openHabitByName(HABIT_NAME);
  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the categorised habit\'s dialog to close again' });

  await openHabitByName('Gym');
  const uncategorisedPicker = await selectedCategoryOption();
  ck('THE assertion: an uncategorised habit opens on "(none)" after a ' +
     'categorised one, with no reload in between',
    uncategorisedPicker.value === '', JSON.stringify(uncategorisedPicker));

  await ev(`document.getElementById('habit-form').requestSubmit()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the no-op edit on the uncategorised habit to save' });
  const gymAfterSave = await fetchHabit('Gym');
  ck('THE assertion: saving it with nothing changed leaves it uncategorised',
    gymAfterSave && gymAfterSave.category_id === null, JSON.stringify(gymAfterSave));

  /* ---------- review round 4: the SAME late-answer bug as round 2, at the
     four call sites round 2 did not touch ----------

     Round 2 fixed `openDialog`'s own `refreshCategoryPicker()` by passing NO
     argument, so the render reads `select.value` live instead of forcing an
     id captured before the fetch. The block above (:261) pins that one call.
     It is not the only one: `refreshCategoryPicker` has its own internal
     `await api('/categories')`, and the rename-Save, delete, chip and
     new-name handlers all call it with an EAGERLY EVALUATED
     `currentCategoryId()`. That id is read from whichever dialog is open at
     the click, and forced onto whichever dialog is open when the GET lands —
     which need not be the same one.

     This drives the chip handler because it is one click, but the shape is
     shared by all four. Held with the same technique as round 2's block:
     patch `window.fetch`, hold exactly the GET the chip's own refresh fires,
     and let every other request through so the second dialog can open
     normally.

     Mutation target: put `currentCategoryId()` back as the argument to any of
     the four `refreshCategoryPicker()` calls in habit-dialog.js. */

  await openHabitByName(HABIT_NAME);
  const raceHostBefore = await selectedCategoryOption();
  ck('sanity: the dialog the chip is clicked from is showing its own category',
    raceHostBefore.text === 'Work', JSON.stringify(raceHostBefore));

  await ev(`(()=>{
    window.__realFetch = window.__realFetch || window.fetch;
    const realFetch = window.__realFetch;
    window.__holdNext = false;
    window.__heldLanded = false;
    window.__releaseHeld = null;
    window.__held = new Promise((r) => { window.__releaseHeld = r; });
    window.fetch = (url, opts) => {
      const isCategoriesGet = String(url).endsWith('/api/categories') &&
        (!opts || (opts.method ?? 'GET').toUpperCase() === 'GET');
      // Only the ONE GET fired while the flag is up — the chip handler's own
      // refresh. Every other request, including the second dialog's own
      // opening fetch, goes straight through, or the second dialog could not
      // render at all and this would be testing nothing.
      if (isCategoriesGet && window.__holdNext) {
        window.__holdNext = false;
        return window.__held.then(() => realFetch(url, opts)).then((res) => {
          window.__heldLanded = true;
          return res;
        });
      }
      return realFetch(url, opts);
    };
    return true;
  })()`);

  // Arm, then click a chip for a category the account does not have yet: the
  // POST lands, and the refresh that follows it is the request now held.
  await ev(`window.__holdNext = true; ${byText('#category-chips button', 'Mind')}.click(); true`);
  await waitUntil(ev, `window.__holdNext === false`,
    { what: "the chip's own categories refetch to be fired and held" });

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: "the chip's own dialog to close while its refresh is still in flight" });

  // A DIFFERENT habit, with a DIFFERENT category of its own — so a clobber
  // shows up as a wrong value rather than as an empty one.
  await openHabitByName('Meditate');
  const otherDialog = await selectedCategoryOption();
  ck('the second dialog opens on its own category, before the held answer lands',
    otherDialog.text === 'Fitness', JSON.stringify(otherDialog));

  await ev(`window.__releaseHeld()`);
  // `__heldLanded` is set when the RESPONSE resolves, which is one `res.json()`
  // and two microtasks before `state.categories` is assigned and the picker is
  // re-rendered — so waiting on it alone returns before the clobber this block
  // is looking for could have happened, and the block would then be pinning the
  // CDP round trip rather than the fix. The rendered option list is the effect
  // itself: "Mind" is the category the chip above created, so it can only be in
  // the `<select>` once the held answer has been rendered into it.
  await waitUntil(ev,
    `window.__heldLanded === true && [...document.querySelectorAll(
      '#habit-form [name=category_id] option')].some(o => o.textContent === 'Mind')`,
    { what: "the held categories GET to land AND be rendered into the dialog it did not come from" });

  const afterHeldLanded = await selectedCategoryOption();
  ck('THE assertion: a category mutation made from ANOTHER habit\'s dialog does ' +
     'not stamp that habit\'s category onto this one',
    afterHeldLanded.text === 'Fitness', JSON.stringify(afterHeldLanded));

  await ev(`window.fetch = window.__realFetch;
    document.getElementById('habit-form').requestSubmit(); true`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the no-op edit on the second habit to save' });
  const meditateAfter = await fetchHabit('Meditate');
  const fitness = await ev(`(async()=>{
    const cats = await (await fetch('/api/categories')).json();
    return cats.find(c => c.name === 'Fitness') ?? null;
  })()`);
  ck('THE assertion: and saving it with nothing changed keeps its OWN category',
    meditateAfter && fitness && meditateAfter.category_id === fitness.id,
    JSON.stringify({ saved: meditateAfter?.category_id, fitness: fitness?.id }));

  /* ---------- review round 6: Enter inside a category box is that box's own
     action, never the habit form's Save ----------

     Both category text controls live INSIDE `#habit-form` — the picker manages
     the account's categories in place rather than on a screen of its own — and
     that form has a `type="submit"` Save button. So Enter in either of them was
     an implicit submission: the dialog closed, the HABIT was written, and the
     category just typed was never created (or, from the rename box, never
     sent). On the create path used below it wrote a whole habit out of the
     form's defaults. Nothing reported it, because `saveHabit` succeeds on its
     own terms and `#category-hint` is only ever written by the category
     handlers — the one surface that could have said something stayed blank.

     A REAL key event (`Input.dispatchKeyEvent`), not a synthesised one: implicit
     submission is the browser's own behaviour on a trusted keypress, and a
     `new KeyboardEvent('keydown')` dispatched from script does not trigger it —
     so a script-made event passes against the unguarded build and pins nothing.

     The wait afterwards is a predicate satisfied in BOTH worlds — the hint
     filling in (guarded) OR the dialog closing (unguarded) — so a regression
     fails the checks below BY NAME rather than timing out inside `waitUntil`.

     Mutation target: either `enterPresses(...)` call in `habit-dialog.js`. The
     `#category-new-name` one fails checks 1-3, the rename one fails 4-6. */

  const ENTER_CATEGORY = 'Zzz Enter Category';
  const ENTER_RENAMED = 'Zzz Enter Renamed';
  const ENTER_HABIT = 'Zzz Enter Habit';

  const pressEnter = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        ...(type === 'keyDown' ? { text: '\r' } : {}),
      }, sessionId);
    }
  };
  const habitNames = () => ev(`(async()=>
    (await (await fetch('/api/habits')).json()).map(h => h.name))()`);
  const categoryNames = () => ev(`(async()=>
    (await (await fetch('/api/categories')).json()).map(c => c.name))()`);

  // The CREATE dialog, because that is where the unguarded submit is loudest:
  // there is no habit yet, so Enter did not merely re-save one, it invented a
  // whole habit from the form's defaults.
  await ev(`document.getElementById('btn-new').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === true`,
    { what: 'the create dialog to open for the Enter checks' });

  const habitsBeforeEnter = await habitNames();
  await ev(`(()=>{
    const f = document.getElementById('habit-form');
    f.name.value = ${JSON.stringify(ENTER_HABIT)};
    const box = document.getElementById('category-new-name');
    box.value = ${JSON.stringify(ENTER_CATEGORY)};
    box.focus();
    return true;
  })()`);
  await pressEnter();
  await waitUntil(ev,
    `document.getElementById('category-hint').textContent.includes('Added')
     || document.getElementById('habit-dialog').open === false`,
    { what: "the Add to answer, or the form to submit if the key was not caught" });

  const afterNewEnter = await ev(`(()=>({
    open: document.getElementById('habit-dialog').open,
    typedStillThere: document.getElementById('category-new-name').value,
    hint: document.getElementById('category-hint').textContent,
  }))()`);
  ck('THE assertion: Enter in the "New category" box does not submit the habit form',
    afterNewEnter.open === true, JSON.stringify(afterNewEnter));
  ck('…and it presses Add, so the category the user typed is actually created',
    (await categoryNames()).includes(ENTER_CATEGORY),
    JSON.stringify(await categoryNames()));
  ck('…and no habit was written behind it',
    !(await habitNames()).includes(ENTER_HABIT),
    JSON.stringify({ before: habitsBeforeEnter, after: await habitNames() }));

  // The rename box, built fresh by `renderCategoryManage` on every ✎, which is
  // why its guard cannot be wired once at `init` the way the box above is.
  await waitUntil(ev,
    `[...document.querySelectorAll('.category-manage-name')]
       .some(n => n.textContent.trim() === ${JSON.stringify(ENTER_CATEGORY)})`,
    { what: 'the new category to appear in the manage list' });
  await ev(`(()=>{
    const row = [...document.querySelectorAll('.category-manage-row')]
      .find(r => r.querySelector('.category-manage-name')
        ?.textContent.trim() === ${JSON.stringify(ENTER_CATEGORY)});
    row.querySelector('.category-edit').click();
    return true;
  })()`);
  await waitUntil(ev, `!!document.querySelector('.category-edit-name')`,
    { what: 'the rename row to open for the Enter check' });
  await ev(`(()=>{
    const box = document.querySelector('.category-edit-name');
    box.value = ${JSON.stringify(ENTER_RENAMED)};
    box.focus();
    // Blanked so the wait below is about THIS keypress and not the "Added"
    // sentence the block above left behind — the same stale-hint trap the
    // queued-rename block further down documents.
    document.getElementById('category-hint').textContent = '';
    return true;
  })()`);
  await pressEnter();
  await waitUntil(ev,
    `!document.querySelector('.category-edit-name')
     || document.getElementById('habit-dialog').open === false`,
    { what: 'the rename to answer, or the form to submit if the key was not caught' });

  const afterRenameEnter = await ev(
    `document.getElementById('habit-dialog').open`);
  ck('THE assertion: Enter in the rename box does not submit the habit form either',
    afterRenameEnter === true, `open=${afterRenameEnter}`);
  ck('…and it presses that row\'s own Save, so the rename really lands',
    (await categoryNames()).includes(ENTER_RENAMED)
      && !(await categoryNames()).includes(ENTER_CATEGORY),
    JSON.stringify(await categoryNames()));
  ck('…and still no habit was written behind it',
    !(await habitNames()).includes(ENTER_HABIT),
    JSON.stringify(await habitNames()));

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the create dialog to close after the Enter checks' });

  /* ---------- adding a category while editing a habit stays on that habit ----
   *
   * Reported from use: open a habit, press Edit, add a category, and the app is
   * back on the dashboard with the habit's page gone.
   *
   * The four category mutations this dialog makes in place — rename, delete, a
   * suggestion chip and the New category box — all ended in an unconditional
   * `emit('reload')`, which means "go to the dashboard and load it from the
   * server" (`ui/store.js`). That is right when the dashboard is what is
   * showing and is a navigation nobody asked for from anywhere else, and it is
   * exactly the rule `saveHabit` already had one line of its own for. It is
   * `announce()` in `ui/habit-dialog.js` now, over `dashboardShowing()`.
   *
   * The dialog is MODAL and repaints nothing behind it, so the view that gets
   * pulled out from under it is only visible once the dialog closes — which is
   * why this survived a suite that opens and closes it a dozen times: every
   * earlier block re-navigates before it looks at anything.
   *
   * This drives the "New category" BOX, which is one of the four; the other
   * three go through the same `announce()`, so the mutation to make is that
   * function or this call site — reverting the CHIP handler alone would not
   * fail here, and the block above already drives the chip for its own reason.
   *
   * Mutation target: `announce()` back to `emit('reload')` at
   * `#category-new-add` in `ui/habit-dialog.js`. Measured: the app landed on
   * `#/habit/9` — ANOTHER habit's page — because `paint()`'s `go(LIST)` is a
   * `history.back()` from here and the entry underneath was whatever this suite
   * pushed last. So `#view-detail` was still showing, and the URL is what says
   * a navigation happened. Both are asserted.
   */

  const STAY_CATEGORY = 'Zzz Stay Put';
  // Opens the habit's own page and presses its Edit — so the dialog below is
  // modal over `#view-detail`, which is the state the report is about.
  await openHabitByName('Meditate');
  const stayingOn = await ev(`(() => ({
    heading: document.querySelector('#view-detail h2')?.textContent.trim() ?? null,
    detail: !document.getElementById('view-detail').hidden,
    hash: location.hash,
  }))()`);
  ck('sanity: the dialog is open over the habit\'s own page, not over the list',
    stayingOn.heading === 'Meditate' && stayingOn.detail === true
    && /^#\/habit\/\d+$/.test(stayingOn.hash),
    JSON.stringify(stayingOn));

  await ev(`document.getElementById('category-new-name').value = ${JSON.stringify(STAY_CATEGORY)}`);
  await ev(`document.getElementById('category-new-add').click()`);
  // The category landing, which is what makes the emit below have happened —
  // and it is read off the DIALOG's own picker rather than the network, so this
  // waits for the whole handler rather than for its POST.
  await waitUntil(ev, `[...document.querySelectorAll(
    '#habit-form [name=category_id] option')].some(o => o.textContent === ${JSON.stringify(STAY_CATEGORY)})`,
  { what: 'the new category to reach the picker' });
  // `emit('reload')` is `dashboard.load()`, which is a round trip before it
  // paints — so the wrong answer arrives LATER than the right one and a read
  // taken here would pass against the unfixed code. A settle is the only shape
  // available: what is asserted is that a navigation did not happen.
  await sleep(1200);

  const stayed = await ev(`(() => ({
    dialog: document.getElementById('habit-dialog').open,
    detail: !document.getElementById('view-detail').hidden,
    list: !document.getElementById('view-list').hidden,
    hash: location.hash,
    heading: document.querySelector('#view-detail h2')?.textContent.trim() ?? null,
  }))()`);
  ck('THE assertion: adding a category from the edit dialog leaves the habit\'s ' +
     'own page showing, not the dashboard',
    stayed.detail === true && stayed.list === false && stayed.heading === 'Meditate',
    JSON.stringify(stayed));
  // The SAME fragment, not merely a habit-shaped one. `'reload'` ends in
  // `paint()`, which calls `go(LIST)` — and with `ourEntry` set that is a
  // `history.back()`, which lands on whatever this suite pushed before rather
  // than reliably on the dashboard. Measured against the unfixed code: it
  // arrived on ANOTHER habit's page, so `#view-detail` was still showing and a
  // check that only asked "is the detail view up" would have passed a
  // navigation that plainly happened.
  ck('…and the URL still names THAT habit, so Back has not been walked either',
    stayed.hash === stayingOn.hash,
    `${stayingOn.hash} -> ${stayed.hash}`);
  ck('…and the dialog it was added from is still open, mid-edit',
    stayed.dialog === true, `open=${stayed.dialog}`);

  // The habit is saved from the dialog that is still open, with the new
  // category picked — which is what the user was doing when they hit this, and
  // it proves the edit was not abandoned by whatever ran behind the modal.
  await ev(`(() => {
    const select = document.querySelector('#habit-form [name=category_id]');
    const opt = [...select.options].find(o => o.textContent === ${JSON.stringify(STAY_CATEGORY)});
    select.value = opt.value;
    document.getElementById('habit-form').requestSubmit();
  })()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the edit to save' });

  const stayedSaved = await fetchHabit('Meditate');
  const stayCat = await ev(`(async()=>{
    const cats = await (await fetch('/api/categories')).json();
    return cats.find(c => c.name === ${JSON.stringify(STAY_CATEGORY)}) ?? null;
  })()`);
  ck('…and the category added mid-edit is the one the habit is saved into',
    !!stayCat && stayedSaved?.category_id === stayCat.id,
    JSON.stringify({ saved: stayedSaved?.category_id, added: stayCat?.id }));

  // Put the account back the way the blocks below expect to find it: they
  // enumerate categories by name and count them.
  await ev(`(async () => {
    const habits = await (await fetch('/api/habits')).json();
    const m = habits.find(h => h.name === 'Meditate');
    if (m) await fetch('/api/habits/' + m.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...m, category_id: null }),
    });
    const cats = await (await fetch('/api/categories')).json();
    const c = cats.find(x => x.name === ${JSON.stringify(STAY_CATEGORY)});
    if (c) await fetch('/api/categories/' + c.id, { method: 'DELETE' });
  })()`);
  // **And this block does NOT return to the dashboard**, which is worth the
  // paragraph because two ways of doing so were tried and both were wrong.
  //
  // `Page.navigate` to the same origin is a full document RELOAD, and the
  // block below opens a dialog whose `openDialog` fires a `GET /categories` it
  // does not await. Against a cold boot's own requests that GET lands late —
  // after the queued delete there has optimistically removed a row — and puts
  // the row back. Measured: 1 failure in 20 runs of this suite with a navigate
  // here, 0 in 20 without, and the failure was on THAT block's assertion, never
  // on any of this one's. The race is its own weak wait (it polls the hint
  // text, which the handler writes AFTER the repaint, so a later-landing
  // refresh is invisible to it); this block simply has no business widening it.
  //
  // The app's own '← Back' is worse and fails 20 times in 20: it emits
  // 'reload', whose `paint()` calls `go(LIST)`, which with `ourEntry` set is a
  // `history.back()` — and by here this suite's history holds several habit
  // entries, so it lands on ANOTHER habit's page rather than the list. That is
  // the same one-entry-deep assumption `ui/routes.js` documents, met from the
  // test side.
  //
  // Nothing needs the dashboard: `openHabitByName` works from either view, by
  // design, and the round-3 block above already calls it from a detail page.
  // `state.categories` is left holding the category deleted just above, which
  // the next `openDialog`'s own refetch corrects, and no assertion below reads
  // it before then.

  /* ---------- reordering categories, a/b/c/d/f (issue #65 step 1) ----------
   *
   * Run over the account as everything above it left it — Work (on
   * `HABIT_NAME`), Fitness, Mind and "Zzz Enter Renamed" all survive to here
   * — rather than a staged fixture, so this is a real account with more than
   * one category to move. `readManage` is used again for `g`, at the very
   * end of the suite.
   */
  console.log('--- reordering categories, a/b/c/d/f (issue #65 step 1) ---');

  const readManage = () => ev(`(()=>({
    names: [...document.querySelectorAll('#category-manage .category-manage-name')]
      .map(n => n.textContent.trim()),
    upDisabled: [...document.querySelectorAll('#category-manage .category-move-up')]
      .map(b => b.disabled),
    downDisabled: [...document.querySelectorAll('#category-manage .category-move-down')]
      .map(b => b.disabled),
  }))()`);

  await openHabitByName(HABIT_NAME);
  // The comment just above this block's own opening says so: `state.categories`
  // still holds "Zzz Stay Put", deleted through the API rather than the UI, and
  // this dialog's synchronous first render draws from whatever it already had.
  // Wait for its own refetch to land before reading the manage list, or this
  // reads the stale five rather than the real four.
  await waitUntil(ev,
    `![...document.querySelectorAll('#category-manage .category-manage-name')]
       .some(n => n.textContent.trim() === ${JSON.stringify(STAY_CATEGORY)})`,
    { what: "the dialog's own refetch to land, dropping the category deleted just above" });
  const beforeMove = await readManage();
  ck('sanity: more than one category, so there is something to move',
    beforeMove.names.length > 1, JSON.stringify(beforeMove));

  // d: the boundary rows are the ones that cannot move any further, and only
  // those — a blanket disable would also pass an unguarded middle row.
  // Mutation target: drop `disabled` from the boundary arrows in
  // `renderCategoryManage` — this must FAIL.
  ck('d: the first row’s ↑ and the last row’s ↓ are disabled, and no other arrow is',
    beforeMove.upDisabled[0] === true
      && beforeMove.downDisabled.at(-1) === true
      && beforeMove.upDisabled.slice(1).every((d) => d === false)
      && beforeMove.downDisabled.slice(0, -1).every((d) => d === false),
    JSON.stringify(beforeMove));

  // a: pressing the first row's own ↓ moves it down one.
  const [firstName, secondName] = beforeMove.names;
  await ev(`document.querySelector(
    '#category-manage .category-manage-row .category-move-down').click()`);
  await waitUntil(ev,
    `document.querySelectorAll(
      '#category-manage .category-manage-name')[0]?.textContent.trim() === ${JSON.stringify(secondName)}`,
    { what: 'the first row to move down one' });

  const afterMove = await readManage();
  ck('a: pressing ↓ on the first category moves it down one in the manage list',
    afterMove.names[0] === secondName && afterMove.names[1] === firstName,
    JSON.stringify({ before: beforeMove.names, after: afterMove.names }));

  // b: it reached the server — reload the page, reopen the dialog, the order
  // holds. Mutation target: delete the `await api('/categories/reorder', …)`
  // line in `moveCategory`, keeping only the optimistic splice — this must
  // FAIL, because a reload reads nothing but the server's own answer.
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-row .habit-name')].some(n => n.textContent.trim() === 'Meditate')`,
    { what: 'the dashboard to reload after the reorder' });
  await openHabitByName(HABIT_NAME);

  const afterReloadManage = await readManage();
  ck('b: the new order reached the server and survives a reload',
    afterReloadManage.names[0] === secondName && afterReloadManage.names[1] === firstName,
    JSON.stringify(afterReloadManage.names));

  const orderOnServer = await ev(
    `(async()=>(await (await fetch('/api/categories')).json()).map(c => c.name))()`);
  ck('…confirmed straight off the API, not only what the dialog happens to show',
    orderOnServer[0] === secondName && orderOnServer[1] === firstName,
    JSON.stringify(orderOnServer));

  // c: with `groupByCategory` on, the dashboard's own section order follows.
  // Both editions already read `ORDER BY position, id` for every list — this
  // confirms the premise the brief states rather than protecting anything new
  // in `dashboard.js`.
  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the dialog to close before checking the grouped dashboard' });
  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupByCategory: true }) })`);
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev, `document.querySelectorAll('#grid .habit-row').length === 5`,
    { what: 'the grouped dashboard to reload after the reorder' });

  const sectionOrder = await ev(`[...document.querySelectorAll(
    '#grid .category-section-header:not(.uncategorised) .category-section-name')]
    .map(n => n.textContent)`);
  ck('c: the dashboard’s own section order follows the new position',
    sectionOrder[0] === secondName && sectionOrder[1] === firstName,
    JSON.stringify({ sectionOrder, expected: [secondName, firstName] }));

  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupByCategory: false }) })`);
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev, `document.querySelectorAll('#grid .habit-row').length === 5`,
    { what: 'the flat dashboard to load again after the section-order check' });

  // f: every arrow on every row is disabled while a row is mid-rename —
  // `repaintCategories` refuses to rebuild this list while
  // `editingCategoryId != null`, so a press then would send a write and
  // repaint nothing. Mutation target: drop the `editingCategoryId != null`
  // disable in `renderCategoryManage` — this must FAIL.
  await openHabitByName(HABIT_NAME);
  await ev(`(()=>{
    const row = [...document.querySelectorAll('#category-manage .category-manage-row')][0];
    row.querySelector('.category-edit').click();
  })()`);
  await waitUntil(ev, `!!document.querySelector('#category-manage .category-edit-name')`,
    { what: 'the rename controls to open' });

  const whileEditing = await ev(`(()=>({
    arrows: document.querySelectorAll(
      '#category-manage .category-move-up, #category-manage .category-move-down').length,
    allDisabled: [...document.querySelectorAll(
      '#category-manage .category-move-up, #category-manage .category-move-down')]
      .every(b => b.disabled),
  }))()`);
  ck('f: every arrow on every row is disabled while a row is mid-rename',
    whileEditing.arrows > 0 && whileEditing.allDisabled === true,
    JSON.stringify(whileEditing));

  await ev(`${byText('#category-manage button', 'Cancel')}.click()`);
  await waitUntil(ev, `!document.querySelector('#category-manage .category-edit-name')`,
    { what: 'the rename to cancel' });
  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the dialog to close after the reorder checks' });

  /* ---------- h: a reorder emits 'change', not 'reload' (issue #65 step 2,
     review finding 1) ----------
   *
   * `openHabitByName`, which every case above uses, always opens the dialog
   * over the HABIT'S OWN PAGE — `dashboardShowing()` answers false there, so
   * `announce()` was already taking the `'change'` branch and none of a–f
   * above ever exercised the dashboard one. This block opens the dialog with
   * `#btn-new` instead, reachable straight from the (grouped) dashboard, and
   * uses two fresh, habit-less categories so it owns its own order rather
   * than depending on where the cases above left the account's others.
   *
   * Two things follow from `moveCategory` ending in a bare `emit('change')`:
   * no `/overview` request at all, and the dashboard's own section order
   * moving with no page reload. Mutation target for the first: put
   * `announce()` back in place of `emit('change')` — this must FAIL, because
   * `dashboardShowing()` is true here and `'reload'` fires `dashboard.js`'s
   * `load()`, which fetches `/overview`. Mutation target for the second:
   * delete the `emit('change')` call entirely — this must FAIL, because
   * nothing then tells the dashboard to redraw and the section order this
   * block reads after closing the dialog is the one from BEFORE the press.
   */
  console.log("--- h: a reorder emits 'change', not 'reload' (issue #65 step 2, review finding 1) ---");

  await ev(`(async()=>{
    await fetch('/api/categories', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Zzz Reorder A', color: '#0ea5e9' }) });
    await fetch('/api/categories', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Zzz Reorder B', color: '#f97316' }) });
    await fetch('/api/settings', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupByCategory: true }) });
  })()`);
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-row .habit-name')].some(n => n.textContent.trim() === 'Meditate')`,
    { what: 'the grouped dashboard to load for h' });

  await ev(`document.getElementById('btn-new').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === true`,
    { what: 'the New-habit dialog to open from the dashboard for h' });
  await waitUntil(ev,
    `[...document.querySelectorAll('#category-manage .category-manage-name')]
      .some(n => n.textContent.trim() === 'Zzz Reorder B')`,
    { what: "the New-habit dialog's own category-manage refetch to include the two fresh categories" });

  const beforeH = (await readManage()).names;
  const aStart = beforeH.indexOf('Zzz Reorder A');
  ck('h sanity: the two fresh categories are adjacent, A directly before B',
    aStart >= 0 && beforeH[aStart + 1] === 'Zzz Reorder B', JSON.stringify(beforeH));

  const sectionsBeforeH = await ev(`[...document.querySelectorAll(
    '#grid .category-section-header:not(.uncategorised) .category-section-name')]
    .map(n => n.textContent)`);

  // Record every request from here on — attached to `window` because each
  // `ev()` call is its own `Runtime.evaluate` and shares nothing but the page.
  await ev(`(()=>{
    window.__hOrigFetch = window.fetch;
    window.__hRequests = [];
    window.fetch = (input, init) => {
      window.__hRequests.push(typeof input === 'string' ? input : input.url);
      return window.__hOrigFetch(input, init);
    };
    return true;
  })()`);

  await ev(`(()=>{
    const row = [...document.querySelectorAll('#category-manage .category-manage-row')]
      .find(r => r.querySelector('.category-manage-name').textContent.trim() === 'Zzz Reorder A');
    row.querySelector('.category-move-down').click();
  })()`);
  await waitUntil(ev,
    `(() => {
      const names = [...document.querySelectorAll('#category-manage .category-manage-name')]
        .map(n => n.textContent.trim());
      return names.indexOf('Zzz Reorder B') === names.indexOf('Zzz Reorder A') - 1;
    })()`,
    { what: 'A to move below B in the manage list' });
  // A post-action settle, not a poll: the assertion below is about what did
  // NOT happen, which is exactly the shape `sleep` exists for in this file —
  // long enough for the reorder POST, `refreshCategoryPicker`'s own GET, and
  // (under the mutation) a `'reload'`-triggered `/overview` to all have had
  // time to fire.
  await sleep(500);

  const requestsH = await ev('window.__hRequests');
  await ev(`window.fetch = window.__hOrigFetch; true`);
  ck('h: a reorder makes no /overview request',
    Array.isArray(requestsH) && !requestsH.some((u) => u.includes('/api/overview')),
    JSON.stringify(requestsH));

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the dialog to close after h' });

  const sectionsAfterH = await ev(`[...document.querySelectorAll(
    '#grid .category-section-header:not(.uncategorised) .category-section-name')]
    .map(n => n.textContent)`);
  const bAfterH = sectionsAfterH.indexOf('Zzz Reorder B');
  const aAfterH = sectionsAfterH.indexOf('Zzz Reorder A');
  ck('h: the dashboard’s own section order follows the press with no page reload',
    bAfterH >= 0 && aAfterH >= 0 && bAfterH === aAfterH - 1,
    JSON.stringify({ before: sectionsBeforeH, after: sectionsAfterH }));

  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupByCategory: false }) })`);
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev, `document.querySelectorAll('#grid .habit-row').length === 5`,
    { what: 'the flat dashboard to load again after h' });

  /* ---------- i: a refetch that fails AFTER a committed reorder must not
     revert it, and must not paint the hint as an error (review round 2,
     finding 1) ----------
   *
   * `moveCategory`'s `try` used to wrap both `POST /categories/reorder` and
   * the `await refreshCategoryPicker()` right after it — a plain
   * `GET /categories` — so a POST the server had already accepted, followed
   * by a GET that failed for any of several ordinary reasons (a dropped
   * connection, a restart, the service worker's own synthetic 503, the read
   * limiter's 429 — a separate bucket from the write limiter,
   * `shared/src/security.js`), took the SAME catch as a failed WRITE: the
   * optimistic order snapped back and `#category-hint` painted the failure in
   * the error class, while the server had already committed the move — reload
   * and the order just reported as failed is there.
   *
   * Reproduced by letting the POST reach the real server and failing only the
   * ONE `GET /api/categories` that follows it, once — every other request,
   * including the reorder POST itself and this block's own final read, goes
   * straight to the real network, so this is testing the second request's own
   * failure and nothing about the first.
   *
   * There is no predicate to poll for "the revert did not happen" — this is
   * the shape `sleep` exists for in this file (see its own comment at the
   * top) — so the wait below is a settle long enough for the POST, the failed
   * GET and `moveCategory`'s own continuation to have all run, the same
   * margin `h` above gives its own "no /overview request" check.
   *
   * Mutation target: put the refetch back inside the `try` (equivalently,
   * delete the early `return` from the catch above it) — all three
   * assertions below must FAIL.
   */
  console.log("--- i: a refetch failure after a committed reorder does not revert it (review round 2, finding 1) ---");

  // `openDialog`'s own fire-and-forget `refreshCategoryPicker()` (see its
  // docstring) can land at any point after the dialog opens — the same
  // hazard `2a` below documents at length. Armed too early, THIS block's own
  // interceptor could catch and reject that GET instead of the one it is
  // actually testing (the reorder's own refetch). Count in-flight fetches and
  // wait for that opening refetch to finish arriving first, exactly as `2a`
  // does, before touching `window.fetch` again below.
  await ev(`(()=>{
    window.__iPending = 0;
    window.__iRealFetch = window.__iRealFetch || window.fetch;
    const real = window.__iRealFetch;
    window.fetch = (...args) => {
      window.__iPending++;
      return real(...args).finally(() => { window.__iPending--; });
    };
    return true;
  })()`);
  await openHabitByName(HABIT_NAME);
  await waitUntil(ev, `window.__iPending === 0`,
    { what: "openDialog's own fire-and-forget refetch to finish arriving" });
  await sleep(300);

  const beforeI = await readManage();
  ck('sanity: more than one category is left to move for i',
    beforeI.names.length > 1, JSON.stringify(beforeI));
  const [iFirst, iSecond] = beforeI.names;

  // Swap the counting wrapper above for one that also rejects the NEXT
  // categories GET while a flag is up — the reorder's own POST, and every
  // other request, still goes to the real network underneath it.
  await ev(`(()=>{
    const real = window.__iRealFetch;
    window.__iRejectNextGet = false;
    window.fetch = (url, opts) => {
      const isCategoriesGet = String(url).endsWith('/api/categories') &&
        (!opts || (opts.method ?? 'GET').toUpperCase() === 'GET');
      // Only the ONE GET fired while the flag is up — moveCategory's own
      // refetch, right after its POST resolves. The POST itself, and every
      // other request (including this block's own later read), goes straight
      // to the real network.
      if (isCategoriesGet && window.__iRejectNextGet) {
        window.__iRejectNextGet = false;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return real(url, opts);
    };
    return true;
  })()`);

  // Blanked in the same evaluate as the click, for the reason the offline
  // block below (`g`) already gives: an earlier block's own hint text could
  // otherwise still be sitting there, making the "not in the error class"
  // check below pass on a sentence this press never wrote.
  await ev(`window.__iRejectNextGet = true;
    document.getElementById('category-hint').textContent = '';
    document.getElementById('category-hint').classList.remove('error');
    document.querySelector('#category-manage .category-manage-row .category-move-down').click();
    true`);
  await waitUntil(ev, `window.__iRejectNextGet === false`,
    { what: "the interceptor to see the refetch's own GET and fail it" });
  await sleep(500);

  await ev(`window.fetch = window.__iRealFetch; true`);

  const afterI = await readManage();
  ck('i: the manage list still shows the MOVED order, not a reverted one',
    afterI.names[0] === iSecond && afterI.names[1] === iFirst,
    JSON.stringify({ before: beforeI.names, after: afterI.names }));

  const iHint = await ev(`(()=>({
    text: document.getElementById('category-hint').textContent,
    error: document.getElementById('category-hint').classList.contains('error'),
  }))()`);
  ck('i: #category-hint is not painted as an error over a write the server accepted',
    iHint.error === false, JSON.stringify(iHint));

  // THE assertion this block exists for: the server's own answer, read with
  // the real `fetch` restored above — not merely what the dialog happens to
  // show, which the two checks above already cover.
  const iServerOrder = await ev(
    `(async()=>(await (await fetch('/api/categories')).json()).map(c => c.name))()`);
  ck('i: THE assertion: the server really did keep the move, not only the DOM',
    iServerOrder[0] === iSecond && iServerOrder[1] === iFirst,
    JSON.stringify({ iServerOrder, expected: [iSecond, iFirst] }));

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the dialog to close after i' });

  /* ---------- j: a category read that is answered before a LATER press's
     write must not install its answer over the newer one (review round 3,
     finding 1) ----------
   *
   * The arrows are deliberately not disabled while a write is in flight, so
   * two `moveCategory` calls overlapping is the ordinary gesture for moving a
   * category more than one slot. Each press was independent end to end: its
   * own POST, then its OWN `GET /categories`, whose reply was assigned to
   * `state.categories` unconditionally. Nothing sequenced the two, so a GET
   * the server answered BEFORE a later press's POST committed — but which was
   * delivered to the client after that later press's own GET — silently
   * installed an order the server had already moved past, with no error, no
   * hint and no repaint anybody would read as a failure.
   *
   * It compounds, which is the half that reaches storage: the next press
   * computes its whole payload from `state.categories` as it stands, so it
   * POSTs the regressed order back and the SERVER's order is wrong too, not
   * merely the display. The second assertion below is that half, read off
   * `GET /api/categories` rather than off the DOM.
   *
   * `persistOrder` (dashboard.js) does NOT have this: it never refetches after
   * its own write, so it cannot race a second call's READ. The per-press GET
   * is a mechanism the habit list has no counterpart for.
   *
   * Reproduced deterministically rather than by racing the network. The
   * interceptor fires press A's refetch against the real server AT THE MOMENT
   * `moveCategory` asks for it — so the captured body is the order as of A's
   * own POST, which is exactly the stale reading — and then holds the
   * RESPONSE until this script releases it, after press B has been made and
   * B's own refetch has landed. Every other request, B's included, goes
   * straight to the real network.
   *
   * Mutation target: drop the `mine === categoryReadSeq` guard in
   * `refreshCategoryPicker` (equivalently, the `categoryReadSeq++` in
   * `moveCategory`) — BOTH assertions below must FAIL.
   */
  console.log('--- j: a superseded category read does not install its stale order (review round 3, finding 1) ---');

  // `openDialog`'s own fire-and-forget refetch has to be out of the way before
  // the holding wrapper is armed, or it — rather than press A's — is the GET
  // that gets held. Same count-in-flight wait `i` and `2a` use.
  await ev(`(()=>{
    window.__jPending = 0;
    window.__jRealFetch = window.__jRealFetch || window.fetch;
    const real = window.__jRealFetch;
    window.fetch = (...args) => {
      window.__jPending++;
      return real(...args).finally(() => { window.__jPending--; });
    };
    return true;
  })()`);
  await openHabitByName(HABIT_NAME);
  await waitUntil(ev, `window.__jPending === 0`,
    { what: "openDialog's own fire-and-forget refetch to finish arriving" });
  await sleep(300);

  const beforeJ = await readManage();
  ck('sanity: three or more categories, so two presses reach three distinct orders',
    beforeJ.names.length >= 3, JSON.stringify(beforeJ));
  const [j0, j1, j2] = beforeJ.names;

  await ev(`(()=>{
    const real = window.__jRealFetch;
    window.__jHeld = false;
    window.__jDelivered = false;
    window.__jLanded = 0;
    let captured = false;
    const held = new Promise((res) => { window.__jRelease = res; });
    window.fetch = (url, opts) => {
      const isCategoriesGet = String(url).endsWith('/api/categories') &&
        (!opts || (opts.method ?? 'GET').toUpperCase() === 'GET');
      if (isCategoriesGet && !captured) {
        captured = true;
        // Fired NOW against the real server — the body is the order as of
        // press A's own POST, which is the stale reading this block is about
        // — and delivered only once this script releases it. The response
        // body is not consumed here, so \`api()\`'s own \`res.json()\` still
        // reads the snapshot taken at this moment.
        const inFlight = real(url, opts);
        window.__jHeld = true;
        return held.then(() => inFlight).then((res) => {
          window.__jDelivered = true;
          return res;
        });
      }
      if (isCategoriesGet) {
        return real(url, opts).then((res) => { window.__jLanded++; return res; });
      }
      return real(url, opts);
    };
    return true;
  })()`);

  // Press A: the first row's ↓. Its POST goes to the real server; its refetch
  // is the one held above.
  await ev(`document.querySelector(
    '#category-manage .category-manage-row .category-move-down').click(); true`);
  await waitUntil(ev, `window.__jHeld === true`,
    { what: "press A's own refetch to be captured and held" });
  await waitUntil(ev,
    `document.querySelectorAll(
      '#category-manage .category-manage-name')[0]?.textContent.trim() === ${JSON.stringify(j1)}`,
    { what: "press A's optimistic move to paint" });

  // Press B, while A's read is still out: the SECOND row's ↓, which moves the
  // category A just displaced further down again. B's own POST and refetch go
  // to the real network, so when its reply lands the list — and the server —
  // both read [j1, j2, j0, …].
  await ev(`[...document.querySelectorAll(
    '#category-manage .category-manage-row')][1]
    .querySelector('.category-move-down').click(); true`);
  await waitUntil(ev, `window.__jLanded >= 1`,
    { what: "press B's own refetch to land unheld" });
  await waitUntil(ev,
    `[...document.querySelectorAll('#category-manage .category-manage-name')]
       .slice(0, 3).map(n => n.textContent.trim()).join('|') ===
       ${JSON.stringify([j1, j2, j0].join('|'))}`,
    { what: "press B's own answer to install the newer order" });

  // Release A's stale reply now — the exact moment the unguarded code paints
  // it over B's. There is no predicate for "the stale order did not install",
  // so the settle after delivery is the shape `sleep` exists for here.
  await ev(`window.__jRelease(); true`);
  await waitUntil(ev, `window.__jDelivered === true`,
    { what: "press A's held reply to be delivered to api()" });
  await sleep(500);

  const afterJ = await readManage();
  ck('j: the stale reply from the earlier press did not install its order over the newer one',
    afterJ.names.slice(0, 3).join('|') === [j1, j2, j0].join('|'),
    JSON.stringify({ before: beforeJ.names, after: afterJ.names,
      expected: [j1, j2, j0] }));

  // THE assertion: the compounding half. A third press computes its payload
  // from `state.categories` as it stands, so if the stale reply had installed
  // itself the order this writes is a regression the SERVER then holds.
  //
  // The wait is on the press's own refetch LANDING — counted by the wrapper,
  // which is still installed and now passes everything through — rather than
  // on the order it paints. A wait on the order would be a `waitUntil` that
  // THROWS under the mutation this block exists to catch, aborting the suite
  // where the two `ck`s below are what should report it.
  await ev(`document.querySelector(
    '#category-manage .category-manage-row .category-move-down').click(); true`);
  await waitUntil(ev, `window.__jLanded >= 2`,
    { what: "the third press's own refetch to land" });
  await sleep(300);
  await ev(`window.fetch = window.__jRealFetch; true`);

  const jServerOrder = await ev(
    `(async()=>(await (await fetch('/api/categories')).json()).map(c => c.name))()`);
  ck('j: THE assertion: the next press wrote the newer order to the server, not a regressed one',
    jServerOrder.slice(0, 3).join('|') === [j2, j1, j0].join('|'),
    JSON.stringify({ jServerOrder, expected: [j2, j1, j0] }));

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the dialog to close after j' });

  /* ---------- k: a press RETIRES the reads already in flight, including the
     one `openDialog` fired before the press existed (review round 3,
     finding 1, second half) ----------
   *
   * `j` above covers two presses racing each other's reads, where the newer
   * press's own refetch is what supersedes the older one. This is the case
   * that guard alone does NOT answer: the read in flight is `openDialog`'s
   * fire-and-forget `refreshCategoryPicker()`, fired before any press existed,
   * and the press's own read has not STARTED yet because its POST is still
   * out. Nothing newer has taken a ticket, so an unbumped counter lets that
   * read install the PRE-move order straight over the optimistic splice.
   *
   * Needs no response reordering at all — only the dialog's own GET being
   * slower than the first press on it, which is an ordinary open-and-press.
   * It self-heals a round trip later when the press's own refetch lands, so
   * the DOM check below is only half of it; the assertion that lasts is what a
   * press made INSIDE that window writes, since it computes its payload from
   * the reverted list and the server then holds the regression.
   *
   * Both requests are fired against the real server at the moment the app asks
   * for them and only their RESPONSES are held, so the server genuinely
   * commits press A's reorder and this stays a test about what the client does
   * with the answers rather than about the network.
   *
   * Mutation target: delete the `categoryReadSeq++` in `moveCategory` — both
   * assertions below must FAIL. (The `mine === categoryReadSeq` guard in
   * `refreshCategoryPicker` is the other half and is `j`'s.)
   */
  console.log("--- k: a press retires openDialog's own in-flight read (review round 3, finding 1, second half) ---");

  await ev(`(()=>{
    const real = window.__jRealFetch;
    window.__kRealFetch = real;
    window.__kHeldGet = false;
    window.__kHeldPost = false;
    window.__kGetDelivered = false;
    let capturedGet = false;
    let capturedPost = false;
    const heldGet = new Promise((res) => { window.__kReleaseGet = res; });
    const heldPost = new Promise((res) => { window.__kReleasePost = res; });
    window.fetch = (url, opts) => {
      const path = String(url);
      const method = (opts?.method ?? 'GET').toUpperCase();
      // openDialog's own fire-and-forget refetch: fired for real NOW, so its
      // body is the order BEFORE the press below, and delivered only once
      // this script releases it.
      if (!capturedGet && path.endsWith('/api/categories') && method === 'GET') {
        capturedGet = true;
        const inFlight = real(url, opts);
        window.__kHeldGet = true;
        return heldGet.then(() => inFlight).then((res) => {
          window.__kGetDelivered = true;
          return res;
        });
      }
      // Press A's own write: it really reaches the server, but its ANSWER is
      // held, so moveCategory is parked before its own refetch can start —
      // which is the whole point. Nothing newer has taken a read ticket while
      // the stale one lands.
      if (!capturedPost && path.endsWith('/api/categories/reorder') && method === 'POST') {
        capturedPost = true;
        const inFlight = real(url, opts);
        window.__kHeldPost = true;
        return heldPost.then(() => inFlight);
      }
      // Every later reorder write goes straight through, counted so the block
      // below can wait for the second press's own POST to settle without
      // polling the ORDER it paints — a predicate on the order would be a
      // waitUntil that THROWS under the mutation this block exists to
      // catch, aborting the suite before its checks can report it.
      if (path.endsWith('/api/categories/reorder') && method === 'POST') {
        return real(url, opts).then((res) => { window.__kPosts++; return res; });
      }
      return real(url, opts);
    };
    window.__kPosts = 0;
    return true;
  })()`);

  await openHabitByName(HABIT_NAME);
  await waitUntil(ev, `window.__kHeldGet === true`,
    { what: "openDialog's own refetch to be captured and held" });

  // The manage list is drawn synchronously by `openDialog` from
  // `state.categories` as the dashboard left it, so there is a real order here
  // to move even with the dialog's own read still out.
  const beforeK = await readManage();
  ck('sanity: three or more categories with the dialog’s own read still in flight',
    beforeK.names.length >= 3, JSON.stringify(beforeK));
  const [k0, k1, k2] = beforeK.names;

  await ev(`document.querySelector(
    '#category-manage .category-manage-row .category-move-down').click(); true`);
  await waitUntil(ev, `window.__kHeldPost === true`,
    { what: "press A's write to reach the server and have its answer held" });
  await waitUntil(ev,
    `document.querySelectorAll(
      '#category-manage .category-manage-name')[0]?.textContent.trim() === ${JSON.stringify(k1)}`,
    { what: "press A's optimistic move to paint" });

  // Deliver the dialog's own pre-move answer, now — with press A parked on its
  // held POST, so no newer read exists to supersede this one.
  await ev(`window.__kReleaseGet(); true`);
  await waitUntil(ev, `window.__kGetDelivered === true`,
    { what: "openDialog's held reply to be delivered to api()" });
  await sleep(500);

  const afterK = await readManage();
  ck("k: the dialog's own pre-move read did not paint the optimistic move away",
    afterK.names.slice(0, 3).join('|') === [k1, k0, k2].join('|'),
    JSON.stringify({ before: beforeK.names, after: afterK.names,
      expected: [k1, k0, k2] }));

  // THE assertion: a press made inside that window computes its payload from
  // whatever the list now holds, so a reverted list is written back to the
  // server and outlives the self-heal. The SECOND row's ↓, which reaches a
  // different order from each of the two candidate lists.
  await ev(`[...document.querySelectorAll(
    '#category-manage .category-manage-row')][1]
    .querySelector('.category-move-down').click(); true`);
  await waitUntil(ev, `window.__kPosts >= 1`,
    { what: "the second press's own write to reach the server" });
  await ev(`window.__kReleasePost(); true`);
  await sleep(800);
  await ev(`window.fetch = window.__kRealFetch; true`);

  const kServerOrder = await ev(
    `(async()=>(await (await fetch('/api/categories')).json()).map(c => c.name))()`);
  ck('k: THE assertion: the press made in that window wrote the moved order, not the reverted one',
    kServerOrder.slice(0, 3).join('|') === [k1, k2, k0].join('|'),
    JSON.stringify({ kServerOrder, expected: [k1, k2, k0] }));

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the dialog to close after k' });

  /* Move a name one slot in a list of names, the way `moveCategory` does.
     Shared by l and m below, which each have to say what THREE different
     candidate orders would be — the fixed one, the one the mutation installs,
     and what a further press writes from each. */
  const moveBy = (names, name, delta) => {
    const out = names.slice();
    const i = out.indexOf(name);
    out.splice(i + delta, 0, ...out.splice(i, 1));
    return out;
  };

  /* ---------- l: `/overview` is a category READ too, and a press retires it
     (review round 4, finding 1) ----------
   *
   * `j` and `k` cover the two reads this file starts itself. The third writer
   * of `state.categories` lives in another module and had no ticket at all:
   * `load()` (ui/dashboard.js) assigns `data.categories` from `/overview`, and
   * `announce()` sends every category mutation in this dialog EXCEPT
   * `moveCategory` through `'reload'`, which is exactly what calls `load()`.
   *
   * The gesture is ordinary rather than contrived, and that is the point of
   * building the block this way round. A category is created at
   * `MAX(position) + 1`, so a fresh one lands at the BOTTOM of the manage list
   * — which is precisely where you then press ↑. That press falls inside the
   * round trip the Add's own `announce()` started, and `/overview` computes
   * every habit's window plus `categorySummaries` against a reorder's few
   * `UPDATE`s, so it is the one likely to lose the race.
   *
   * `load()` repaints the DASHBOARD and not the manage list, so under the
   * unfixed code nothing on screen contradicts the move — the manage list goes
   * on showing it while the store no longer does. Both halves are asserted:
   * the dashboard's own section order, which is drawn straight from
   * `state.categories` (hence `groupByCategory`, switched on for this block
   * and back off after it, as `h` does), and then what the NEXT press writes
   * to the server, which is the half that outlives the self-heal.
   *
   * Mutation target: drop the `categoryRead === state.categoryReadSeq` guard
   * on `state.categories = data.categories` in `dashboard.js`'s `load()` —
   * both assertions below must FAIL.
   */
  console.log("--- l: /overview is a category read too, and a press retires it (review round 4, finding 1) ---");

  const L_NEW = 'Zzz Reorder L';

  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupByCategory: true }) })`);
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .category-section-header')].length > 0`,
    { what: 'the grouped dashboard to load for l' });

  // Count in flight before opening, so the wait below catches `openDialog`'s
  // own fire-and-forget refetch rather than a page that merely has content —
  // same reason `j` and `2a` install theirs first.
  await ev(`(()=>{
    window.__lPending = 0;
    window.__lRealFetch = window.fetch;
    const real = window.__lRealFetch;
    window.fetch = (...args) => {
      window.__lPending++;
      return real(...args).finally(() => { window.__lPending--; });
    };
    return true;
  })()`);
  // `#btn-new` and not `openHabitByName`: `announce()` only reaches `'reload'`
  // — and so `load()` — while `dashboardShowing()` is true, which it is not
  // over a habit's own page.
  await ev(`document.getElementById('btn-new').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === true`,
    { what: 'the New-habit dialog to open from the dashboard for l' });
  await waitUntil(ev, `window.__lPending === 0`,
    { what: "openDialog's own fire-and-forget refetch to finish arriving for l" });
  await sleep(300);

  const beforeL = (await readManage()).names;
  ck('sanity: two or more categories before l adds its own',
    beforeL.length >= 2, JSON.stringify(beforeL));

  // The hold, armed on the FIRST `/overview` only: fired for real at the
  // moment `load()` asks for it, so its body is the order as of the Add and
  // knows nothing of the press below, and delivered only once this script
  // releases it. Reorder writes and category reads are counted so the waits
  // below can be on request settlement rather than on a painted order — a
  // `waitUntil` on the EXPECTED order THROWS under the mutation this block
  // exists to catch, aborting the suite before its own `ck`s can report it.
  await ev(`(()=>{
    const real = window.__lRealFetch;
    window.__lHeld = false;
    window.__lDelivered = false;
    window.__lPosts = 0;
    window.__lGets = 0;
    let captured = false;
    const held = new Promise((res) => { window.__lRelease = res; });
    window.fetch = (url, opts) => {
      const path = String(url);
      const method = (opts?.method ?? 'GET').toUpperCase();
      if (!captured && path.includes('/api/overview')) {
        captured = true;
        const inFlight = real(url, opts);
        window.__lHeld = true;
        return held.then(() => inFlight).then((res) => {
          window.__lDelivered = true;
          return res;
        });
      }
      if (path.endsWith('/api/categories/reorder') && method === 'POST') {
        return real(url, opts).then((res) => { window.__lPosts++; return res; });
      }
      if (path.endsWith('/api/categories') && method === 'GET') {
        return real(url, opts).then((res) => { window.__lGets++; return res; });
      }
      return real(url, opts);
    };
    return true;
  })()`);

  // Add a category. Its handler awaits its own `refreshCategoryPicker()` and
  // THEN calls `announce()`, so by the time the `/overview` is captured the
  // new row is already in the list and the arrows are live.
  await ev(`(()=>{
    document.getElementById('category-new-name').value = ${JSON.stringify(L_NEW)};
    document.getElementById('category-new-add').click();
    return true;
  })()`);
  await waitUntil(ev, `window.__lHeld === true`,
    { what: "the Add's own announce() to put /overview on the wire, and that request to be held" });
  await waitUntil(ev,
    `[...document.querySelectorAll('#category-manage .category-manage-name')]
       .map(n => n.textContent.trim()).at(-1) === ${JSON.stringify(L_NEW)}`,
    { what: 'the new category to arrive at the bottom of the manage list' });

  const addedL = [...beforeL, L_NEW];
  const movedL = moveBy(addedL, L_NEW, -1);

  await ev(`window.__lGets = 0; true`);
  // ↑ on the last row — the new one. The ordinary next thing to do with a
  // category that was just created at the bottom.
  await ev(`(()=>{
    const rows = [...document.querySelectorAll('#category-manage .category-manage-row')];
    rows[rows.length - 1].querySelector('.category-move-up').click();
    return true;
  })()`);
  await waitUntil(ev, `window.__lPosts >= 1`,
    { what: "the press's own write to reach the server" });
  await waitUntil(ev, `window.__lGets >= 1`,
    { what: "the press's own refetch to land" });

  // Deliver the pre-move `/overview` now — the exact moment the unguarded code
  // paints its categories over the press's.
  await ev(`window.__lRelease(); true`);
  await waitUntil(ev, `window.__lDelivered === true`,
    { what: 'the held /overview reply to be delivered to load()' });
  await sleep(600);

  const sectionsAfterL = await ev(`[...document.querySelectorAll(
    '#grid .category-section-header:not(.uncategorised) .category-section-name')]
    .map(n => n.textContent.trim())`);
  ck('l: the stale /overview did not install its pre-move order over the press',
    sectionsAfterL.join('|') === movedL.join('|'),
    JSON.stringify({ sectionsAfterL, expected: movedL, wouldBeStale: addedL }));

  // THE assertion: the compounding half, and the one that outlives the
  // self-heal. A further press computes its payload from `state.categories` as
  // it stands, so a stale store is written straight back to the server. The
  // row is found by NAME rather than by index, because the manage list — which
  // `load()` never rebuilt — shows the moved order under either outcome, and
  // the whole question is what the STORE behind it holds.
  await ev(`(()=>{
    const row = [...document.querySelectorAll('#category-manage .category-manage-row')]
      .find(r => r.querySelector('.category-manage-name').textContent.trim() === ${JSON.stringify(L_NEW)});
    row.querySelector('.category-move-up').click();
    return true;
  })()`);
  await waitUntil(ev, `window.__lPosts >= 2`,
    { what: "the second press's own write to reach the server" });
  await sleep(400);
  await ev(`window.fetch = window.__lRealFetch; true`);

  const expectedServerL = moveBy(movedL, L_NEW, -1);
  const lServerOrder = await categoryNames();
  ck('l: THE assertion: the next press wrote the newer order to the server, not a regressed one',
    lServerOrder.join('|') === expectedServerL.join('|'),
    JSON.stringify({ lServerOrder, expected: expectedServerL, wouldBeStale: movedL }));

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the dialog to close after l' });
  // Back to where `h` left the account, so nothing below inherits l's grouping.
  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupByCategory: false }) })`);
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-row .habit-name')].length > 0
      && document.querySelectorAll('#grid .category-section-header').length === 0`,
    { what: 'the ungrouped dashboard to come back after l' });

  /* ---------- 2b: a boundary press must not hand the keyboard the arrow that
     UNDOES it (review round 4, finding 2) ----------
   *
   * The arrows exist because drag is "unreachable by keyboard"
   * (`attachDragHandlers`), so the keyboard is this control's headline path,
   * and `restoreFocus`'s generic fallback is the wrong answer on exactly this
   * row. It hands focus to the first still-operable `[data-focus-key]` in the
   * same parent — right for `Today`, whose neighbour does something unrelated,
   * and wrong here, where ↑ and ↓ are the row's ONLY two focus keys and each
   * is the other's undo. The press that lands a category at row 0 disables its
   * ↑ and moved focus one button right onto its ↓; the next Enter sent it back
   * down, and a held Enter ping-ponged the row between the two ends with a
   * `POST /categories/reorder` per step.
   *
   * Both halves are asserted, because the second is the one that reaches
   * storage: where focus went, and then what a further Enter actually does.
   * The Enter is a REAL key event for the reason the implicit-submission block
   * above gives — a script-made `KeyboardEvent` does not activate a button,
   * so a test built on one passes against the unfixed code.
   *
   * Two mutation targets, because the two halves fail differently. Put
   * `restoreFocus($('#category-manage'), focused)` back in place of
   * `restoreArrowFocus(list, focused)` in `moveCategory`: the "not the ↓" check
   * and BOTH of the Enter checks must fail, while "focus stays inside the list"
   * still passes — that one is not about this bug and says so. Then instead
   * drop the `list.focus(...)` fallback from `restoreArrowFocus`, leaving a
   * boundary with nothing to restore to: that one check, and only it, must
   * fail.
   */
  console.log('--- 2b: a boundary press does not hand the keyboard the arrow that undoes it (review round 4, finding 2) ---');

  await ev(`(()=>{
    window.__bPending = 0;
    window.__bRealFetch = window.fetch;
    const real = window.__bRealFetch;
    window.fetch = (...args) => {
      window.__bPending++;
      return real(...args).finally(() => { window.__bPending--; });
    };
    return true;
  })()`);
  await openHabitByName(HABIT_NAME);
  await waitUntil(ev, `window.__bPending === 0`,
    { what: "openDialog's own fire-and-forget refetch to finish arriving for 2b" });
  await sleep(300);

  const beforeB = (await readManage()).names;
  ck('sanity: two or more categories, so a row can be walked to the top boundary',
    beforeB.length >= 2, JSON.stringify(beforeB));

  // The row at index 1: one press of its ↑ lands it at index 0, where that very
  // ↑ disables itself. Focus, click and the read of where focus ended up all
  // inside ONE `Runtime.evaluate`, for the reason `2a` gives — a separate call
  // between them hands anything else a whole CDP round trip to move focus
  // first. `moveCategory`'s synchronous prefix (splice, repaint, its own focus
  // restore) has completed by the time `.click()` returns.
  const pressedB = await ev(`(()=>{
    const rows = [...document.querySelectorAll('#category-manage .category-manage-row')];
    const row = rows[1];
    const name = row.querySelector('.category-manage-name').textContent.trim();
    const upKey = row.querySelector('.category-move-up').dataset.focusKey;
    const downKey = row.querySelector('.category-move-down').dataset.focusKey;
    row.querySelector('.category-move-up').focus();
    row.querySelector('.category-move-up').click();
    const el = document.activeElement;
    const list = document.getElementById('category-manage');
    return {
      name, upKey, downKey,
      focusKey: el && el.dataset ? el.dataset.focusKey ?? null : null,
      onBody: el == null || el === document.body,
      inList: !!el && list.contains(el),
    };
  })()`);

  ck('2b: the press that disables ↑ does not move focus onto the ↓ that would undo it',
    pressedB.focusKey !== pressedB.downKey, JSON.stringify(pressedB));
  ck('…and focus stays inside the manage list rather than dropping to <body>',
    pressedB.onBody === false && pressedB.inList === true, JSON.stringify(pressedB));

  // Let the press's own POST and refetch settle first, so the SECOND focus
  // restore has had its chance too: under the unfixed code its
  // `activeElement === document.body` guard sees focus sitting on the ↓ and
  // leaves it there, which is the state a held Enter then acts on.
  await waitUntil(ev, `window.__bPending === 0`,
    { what: "the boundary press's own write and refetch to settle" });
  await sleep(300);

  const afterPressB = (await readManage()).names;
  ck('2b sanity: the press did move the row to the top',
    afterPressB[0] === pressedB.name,
    JSON.stringify({ beforeB, afterPressB, moved: pressedB.name }));

  await pressEnter();
  await sleep(700);

  ck('2b sanity: Enter did not submit the habit form out from under the list',
    (await ev(`document.getElementById('habit-dialog').open`)) === true);

  const afterEnterB = (await readManage()).names;
  ck('2b: THE assertion: one more Enter does not walk the category straight back down',
    afterEnterB.join('|') === afterPressB.join('|'),
    JSON.stringify({ afterPressB, afterEnterB, wouldBeReversed: beforeB }));

  await ev(`window.fetch = window.__bRealFetch; true`);
  const bServerOrder = await categoryNames();
  ck('…and no reversal was written to the server either',
    bServerOrder.join('|') === afterPressB.join('|'),
    JSON.stringify({ bServerOrder, expected: afterPressB }));

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the dialog to close after 2b' });

  /* ---------- m: a press whose write FAILED must not revert over a newer one
     (review round 4, finding 3) ----------
   *
   * `moveCategory` captures `previous` before its own splice, so the revert in
   * its catch is a writer of `state.categories` exactly as stale as the
   * refetch `j` covers — and until this it asked none of the same questions.
   * Two presses overlap, the EARLIER one fails and resolves LAST (a 5xx, a
   * dropped connection, or the write limiter's 429, which is what a held arrow
   * key reaches), and an order two presses old goes back into the store with
   * nothing left in flight to correct it.
   *
   * Press A's write is answered with a 500 that never reaches the server, so
   * the only order the server holds is press B's — which, its payload having
   * been computed after A's splice, already carries A's move. That is what
   * makes NOT reverting the accurate answer here as well as the safe one.
   *
   * Mutation target: drop the `mine === state.categoryReadSeq` half of the
   * revert guard in `moveCategory`'s catch — both assertions below must FAIL.
   */
  console.log('--- m: a failed press does not revert over a newer one (review round 4, finding 3) ---');

  await ev(`(()=>{
    window.__mPending = 0;
    window.__mRealFetch = window.fetch;
    const real = window.__mRealFetch;
    window.fetch = (...args) => {
      window.__mPending++;
      return real(...args).finally(() => { window.__mPending--; });
    };
    return true;
  })()`);
  await openHabitByName(HABIT_NAME);
  await waitUntil(ev, `window.__mPending === 0`,
    { what: "openDialog's own fire-and-forget refetch to finish arriving for m" });
  await sleep(300);

  await ev(`(()=>{
    const real = window.__mRealFetch;
    window.__mHeld = false;
    window.__mDelivered = false;
    window.__mPosts = 0;
    window.__mGets = 0;
    let captured = false;
    const held = new Promise((res) => { window.__mRelease = res; });
    window.fetch = (url, opts) => {
      const path = String(url);
      const method = (opts?.method ?? 'GET').toUpperCase();
      // Press A's write: refused, never sent, and the refusal held until B has
      // finished. A real status rather than a rejection, so \`api()\` throws a
      // plain Error with no \`queued\` on it — the branch under test.
      if (!captured && path.endsWith('/api/categories/reorder') && method === 'POST') {
        captured = true;
        window.__mHeld = true;
        return held.then(() => {
          window.__mDelivered = true;
          return new Response(JSON.stringify({ error: 'reorder refused' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } });
        });
      }
      if (path.endsWith('/api/categories/reorder') && method === 'POST') {
        return real(url, opts).then((res) => { window.__mPosts++; return res; });
      }
      if (path.endsWith('/api/categories') && method === 'GET') {
        return real(url, opts).then((res) => { window.__mGets++; return res; });
      }
      return real(url, opts);
    };
    return true;
  })()`);

  const beforeM = (await readManage()).names;
  ck('sanity: three or more categories, so two presses reach three distinct orders for m',
    beforeM.length >= 3, JSON.stringify(beforeM));
  const afterAM = moveBy(beforeM, beforeM[0], 1);
  const afterBM = moveBy(afterAM, beforeM[0], 1);

  // Press A: the first row's ↓.
  await ev(`document.querySelector(
    '#category-manage .category-manage-row .category-move-down').click(); true`);
  await waitUntil(ev, `window.__mHeld === true`,
    { what: "press A's write to be captured and refused" });
  await waitUntil(ev,
    `document.querySelectorAll(
      '#category-manage .category-manage-name')[0]?.textContent.trim() === ${JSON.stringify(beforeM[1])}`,
    { what: "press A's optimistic move to paint" });

  // Press B, while A is still parked: the SECOND row's ↓, which is the
  // category A just displaced. Its payload therefore carries A's move, and it
  // commits for real.
  await ev(`[...document.querySelectorAll(
    '#category-manage .category-manage-row')][1]
    .querySelector('.category-move-down').click(); true`);
  await waitUntil(ev, `window.__mPosts >= 1`,
    { what: "press B's own write to reach the server" });
  await waitUntil(ev, `window.__mGets >= 1`,
    { what: "press B's own refetch to install the server's order" });

  await ev(`window.__mRelease(); true`);
  await waitUntil(ev, `window.__mDelivered === true`,
    { what: "press A's held refusal to be delivered to api()" });
  await sleep(500);

  const afterM = (await readManage()).names;
  ck('m: a press whose write failed does not revert over the order a newer press installed',
    afterM.join('|') === afterBM.join('|'),
    JSON.stringify({ beforeM, afterM, expected: afterBM, wouldBeReverted: beforeM }));

  // THE assertion, the same compounding half `j` and `l` end on: a further
  // press computes its payload from the store, so a reverted store is written
  // back and the SERVER holds the regression.
  await ev(`document.querySelector(
    '#category-manage .category-manage-row .category-move-down').click(); true`);
  await waitUntil(ev, `window.__mPosts >= 2`,
    { what: "the third press's own write to reach the server" });
  await sleep(400);
  await ev(`window.fetch = window.__mRealFetch; true`);

  const expectedServerM = moveBy(afterBM, afterBM[0], 1);
  const mServerOrder = await categoryNames();
  ck('m: THE assertion: the next press wrote the newer order to the server, not the reverted one',
    mServerOrder.join('|') === expectedServerM.join('|'),
    JSON.stringify({ mServerOrder, expected: expectedServerM,
      wouldBeStale: moveBy(beforeM, beforeM[0], 1) }));

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the dialog to close after m' });

  /* ---------- 2a: focus survives the SECOND repaint too, not only the
     optimistic one (issue #65 step 2) ----------
   *
   * `moveCategory` restores focus after its own optimistic `repaintCategories()`
   * — that is `d`/`a` above, implicitly — but `refreshCategoryPicker`'s GET runs
   * a SECOND `repaintCategories()` from the server's answer, whose
   * `renderCategoryManage` does `list.replaceChildren()` and drops focus to
   * `<body>` with nothing to restore it. At a human pace (press, wait, look,
   * press again) a keyboard user loses focus on every single press, which is
   * the exact defect the optimistic restore claims to have fixed.
   *
   * Waiting only for the OPTIMISTIC repaint (a `waitUntil` on the manage list's
   * order, as `a` above does) would pass against the unfixed code, because that
   * repaint's own restore is the one thing step 1 already got right. The
   * button's `data-focus-key` is identical before and after the refetch, so the
   * only way to tell the two repaints apart from outside is NODE IDENTITY: stash
   * a reference to the button focus landed on right after the click (the
   * optimistic generation) and poll for a DIFFERENT node under the same key
   * (the refetch's generation) before reading `document.activeElement`.
   *
   * Mutation target: delete the post-refetch `restoreFocus` call in
   * `moveCategory` — this must FAIL, because a fresh node exists but nothing
   * ever calls `.focus()` on it, so focus stays on the stale, now-detached
   * optimistic node (or wherever the detach sends it).
   */
  console.log('--- 2a: focus survives the post-refetch repaint too (issue #65 step 2) ---');

  // `openDialog`'s own fire-and-forget `refreshCategoryPicker()` call (see its
  // docstring above `refreshCategoryPicker`) can land at any point after the
  // dialog opens and rebuilds `#category-manage` on its own — tearing out
  // whatever this block focuses next if it races it, exactly the hazard `a`–`f`
  // above already wait out before touching the list. Watching for the SETTLED
  // CONTENT (as `a`–`f` do) is not enough here specifically, because nothing
  // else in this account has changed since `f` left it — the dialog's own
  // SYNCHRONOUS first render already shows the settled order before that
  // fetch has even landed, so a content check passes vacuously and the fetch
  // can still land later, mid-interaction. Count in-flight fetches instead —
  // installed fresh right before opening the dialog, so it catches exactly
  // the one this open triggers — and wait for the count to reach zero, with a
  // settle afterwards for the synchronous repaint that follows the fetch by a
  // tick.
  await ev(`(()=>{
    window.__catPending = 0;
    window.__catRealFetch = window.__catRealFetch || window.fetch;
    const real = window.__catRealFetch;
    window.fetch = (...args) => {
      window.__catPending++;
      return real(...args).finally(() => { window.__catPending--; });
    };
    return true;
  })()`);
  await openHabitByName(HABIT_NAME);
  await waitUntil(ev, `window.__catPending === 0`,
    { what: "openDialog's own fire-and-forget refetch to finish arriving" });
  await sleep(300);

  // Focus, click and the generation-one capture all happen inside ONE
  // `Runtime.evaluate` — a separate `ev()` call between `.focus()` and
  // `.click()` gave the dialog's own settling (or anything else) a whole CDP
  // round trip to steal focus back to `<body>` before the click ever landed,
  // which read at `moveCategory`'s own entry as `focused: null` and made the
  // rest of this block meaningless. `.click()` is synchronous and does not
  // itself move focus, so this also still captures the OPTIMISTIC node:
  // moveCategory's synchronous prefix (splice, optimistic repaint, its own
  // `restoreFocus`) has already completed by the time `.click()` returns, and
  // nothing async can run until this whole script yields.
  const downTarget = await ev(`(()=>{
    const btn = [...document.querySelectorAll('#category-manage .category-move-down')]
      .find(b => !b.disabled);
    const key = btn.dataset.focusKey;
    btn.focus();
    btn.click();
    window.__catmoveGen1 = document.querySelector('[data-focus-key=' + JSON.stringify(key) + ']');
    return key;
  })()`);

  // Poll for the REFETCH's own repaint — a THIRD `list.replaceChildren()`
  // since the click, distinguishable from the optimistic one only by node
  // identity, since every attribute including `data-focus-key` is the same.
  await waitUntil(ev,
    `(()=>{
      const btn = document.querySelector('[data-focus-key=${JSON.stringify(downTarget)}]');
      return !!btn && btn !== window.__catmoveGen1;
    })()`,
    { what: "refreshCategoryPicker's own repaint (a fresh node under the same focus key)" });

  const focusAfterRefetch = await ev(`(()=>{
    const el = document.activeElement;
    return el && el.dataset ? el.dataset.focusKey ?? null : null;
  })()`);
  ck('2a: focus is restored again after the post-move refetch, not only the optimistic repaint',
    focusAfterRefetch === downTarget,
    JSON.stringify({ expected: downTarget, focusAfterRefetch }));

  // …and the guard on that second restore actually guards: by the time the GET
  // lands the user may have deliberately moved focus elsewhere, and the restore
  // above must not steal it back. Same shape as above — click, capture the
  // optimistic generation's node — except focus is moved to Cancel immediately
  // after the click returns, which is still before the network round trip the
  // refetch needs, and held there until a fresh (refetch) node is confirmed to
  // exist under the moved arrow's own key.
  //
  // Mutation target: make the post-refetch restore in `moveCategory`
  // unconditional (drop the `activeElement == null || … === document.body`
  // guard) — this must FAIL, because an unconditional restore pulls focus back
  // from Cancel onto the arrow the moment the refetch's repaint runs.
  // Focus, click and the deliberate focus-steal to Cancel all happen inside
  // ONE `Runtime.evaluate`, for the same reason `downTarget` above does: a
  // separate call between `.focus()` and `.click()` gives anything else —
  // including the app itself — a whole CDP round trip to move focus first,
  // and moveCategory's synchronous prefix (splice, optimistic repaint, its
  // own `restoreFocus`) completes before `.click()` returns, so this is also
  // guaranteed to land before the network round trip the refetch needs.
  const upTarget = await ev(`(()=>{
    const btn = [...document.querySelectorAll('#category-manage .category-move-up')]
      .find(b => !b.disabled);
    const key = btn.dataset.focusKey;
    btn.focus();
    btn.click();
    window.__catmoveGen1b = document.querySelector('[data-focus-key=' + JSON.stringify(key) + ']');
    document.getElementById('dialog-cancel').focus();
    return key;
  })()`);
  await waitUntil(ev,
    `(()=>{
      const btn = document.querySelector('[data-focus-key=${JSON.stringify(upTarget)}]');
      return !!btn && btn !== window.__catmoveGen1b;
    })()`,
    { what: "the refetch's own repaint to land, with focus deliberately parked on Cancel" });

  const focusAfterDeliberateMove = await ev(
    `document.activeElement === document.getElementById('dialog-cancel')`);
  ck('…and does not steal focus back once the user has deliberately moved it elsewhere',
    focusAfterDeliberateMove === true, JSON.stringify({ focusAfterDeliberateMove }));

  await ev(`document.getElementById('dialog-cancel').click()`);
  await waitUntil(ev, `document.getElementById('habit-dialog').open === false`,
    { what: 'the dialog to close after the focus-restore checks' });

  /* ---------- review round 5: a QUEUED category write is DURABLE, so the two
     controls have to move with it ----------

     Round 4 established that `PUT` and `DELETE /categories/:id` are
     `replayable()` and recoloured their hint accordingly. That is half of it.
     `api()` stages a replayable write BEFORE it attempts it ("Durable BEFORE
     the attempt", ui/api.js) and nothing dequeues on a later click, so a queued
     category write WILL land — while both handlers went on painting the world
     as it was before it.

     The delete half is a data loss rather than a display bug, and it needs no
     race:

       1. offline, press ✕ on the category THIS form is pointed at. The DELETE
          is staged; the hint says "Saved offline".
       2. the picker still offers that category, so `saveHabit` reads its id
          through `currentCategoryId()` and the habit's own PUT is staged
          BEHIND the delete.
       3. on reconnect the outbox replays in seq order: the delete lands, then
          the PUT reaches `resolveCategoryId`, which answers 400 — and
          `offline.js` drops every 4xx as permanently inapplicable.
       4. `PUT /habits/:id` REPLACES, so the whole habit edit is gone, behind a
          "1 change could not be synced" toast that names neither the habit nor
          the field.

     Offline here is a rejecting `window.fetch` rather than CDP throttling,
     because that is what `api()` actually sees: the first refusal flips
     `state.offline` through `reportUnreachable()`, so every write after it
     takes the pre-empt branch exactly as it would in a real outage. It also
     leaves this suite's own bookkeeping `fetch`es (below) able to run by
     flipping one flag.

     Mutation target: delete either `if (err.queued) { … }` block in
     `habit-dialog.js`. The delete one fails checks 3-6 here with the habit
     written away as Work's id and then dropped; the rename one fails checks
     7-8 with the row still in edit mode. */

  const RENAMED_HABIT = 'Zzz Category Habit R5';

  await ev(`(()=>{
    window.__realFetch = window.__realFetch || window.fetch;
    const realFetch = window.__realFetch;
    window.__offline = false;
    window.fetch = (url, opts) => window.__offline
      ? Promise.reject(new TypeError('Failed to fetch'))
      : realFetch(url, opts);
    return true;
  })()`);
  // A clean outbox, so every assertion below is about writes this block made.
  await ev(`(async()=>{
    const { clearAll } = await import('/shared/offline.js');
    await clearAll();
    return true;
  })()`);

  await openHabitByName(HABIT_NAME);
  const beforeOutage = await selectedCategoryOption();
  ck('sanity: the form is pointed at the category it is about to delete',
    beforeOutage.text === 'Work', JSON.stringify(beforeOutage));

  // The ✕ that belongs to Work's OWN row — every row has one, so it is found
  // through the row rather than by the glyph.
  await ev(`window.__offline = true; true`);
  await ev(`(()=>{
    const row = [...document.querySelectorAll('.category-manage-row')]
      .find(r => r.querySelector('.category-manage-name').textContent.trim() === 'Work');
    row.querySelector('.category-delete').click();
    return true;
  })()`);
  await waitUntil(ev,
    `document.getElementById('category-hint').textContent.includes('Saved offline')`,
    { what: 'the delete to be staged in the outbox and reported as queued' });

  const hintClass = await ev(
    `document.getElementById('category-hint').classList.contains('error')`);
  ck('a queued delete is not painted as an error (round 4, still holding)',
    hintClass === false, `error=${hintClass}`);

  const afterQueuedDelete = await ev(`(()=>{
    const select = document.querySelector('#habit-form [name=category_id]');
    const opt = select.options[select.selectedIndex];
    return {
      value: select.value,
      text: opt ? opt.textContent : null,
      stillOffered: [...select.options].some(o => o.textContent === 'Work'),
      stillManaged: [...document.querySelectorAll('.category-manage-name')]
        .some(n => n.textContent.trim() === 'Work'),
    };
  })()`);
  ck('THE assertion: a queued delete takes the category out of the picker, so ' +
     'Save cannot submit an id the replay is about to destroy',
    afterQueuedDelete.value === '' && afterQueuedDelete.stillOffered === false,
    JSON.stringify(afterQueuedDelete));
  ck('…and out of the manage list beside it',
    afterQueuedDelete.stillManaged === false, JSON.stringify(afterQueuedDelete));

  // A real edit, so what a dropped replay costs is visible rather than
  // inferred: this name is the thing that survives or does not.
  await ev(`(()=>{
    const f = document.getElementById('habit-form');
    f.name.value = ${JSON.stringify(RENAMED_HABIT)};
    f.requestSubmit();
    return true;
  })()`);
  await waitUntil(ev, `(async()=>{
    const { pending } = await import('/shared/offline.js');
    return (await pending()).some(i => i.method === 'PUT' && i.url.startsWith('/api/habits/'));
  })()`, { what: 'the habit edit to be staged behind the delete' });

  const queued = await ev(`(async()=>{
    const { pending } = await import('/shared/offline.js');
    return (await pending()).sort((a, b) => a.seq - b.seq)
      .map(i => ({ url: i.url, method: i.method, body: i.body }));
  })()`);
  const putIndex = queued.findIndex((i) => i.method === 'PUT' && i.url.startsWith('/api/habits/'));
  const delIndex = queued.findIndex((i) => i.method === 'DELETE' && i.url.startsWith('/api/categories/'));
  const habitPut = queued[putIndex];
  ck('the mechanism: the delete replays BEFORE the habit write that follows it',
    delIndex !== -1 && putIndex > delIndex, JSON.stringify(queued.map((i) => i.method + ' ' + i.url)));
  ck('THE assertion: the queued habit write carries no category id at all',
    !!habitPut && JSON.parse(habitPut.body).category_id === null,
    habitPut ? habitPut.body : 'no habit PUT queued');

  /* The rename half: the row used to stay in edit mode beside a Cancel button
     that only resets local state — an undo that does not exist, since the PUT
     is already staged and nothing dequeues on a click. */
  await ev(`(()=>{
    const row = [...document.querySelectorAll('.category-manage-row')]
      .find(r => r.querySelector('.category-manage-name').textContent.trim() === 'Fitness');
    row.querySelector('.category-edit').click();
    return true;
  })()`);
  await waitUntil(ev, `!!document.querySelector('.category-edit-name')`,
    { what: 'the rename row to open' });
  await ev(`(()=>{
    const row = [...document.querySelectorAll('.category-manage-row')]
      .find(r => r.querySelector('.category-edit-name'));
    row.querySelector('.category-edit-name').value = 'Wellness';
    // Blanked in the SAME evaluate as the click, because the hint still reads
    // "Saved offline" from the queued DELETE above: nothing between there and
    // here clears it (\`categoryHint('')\` runs in \`openDialog\` alone, and no
    // dialog is reopened in between), so the wait below was a predicate that
    // was ALREADY TRUE — it returned on its first poll and the read after it
    // raced the handler rather than waiting for it. Offline, \`api()\` never
    // reaches \`fetch\`: it pre-empts, stages to IndexedDB and throws, so the
    // continuation that closes the row arrives on an IDB completion TASK, and
    // a loaded box can schedule that after the next CDP command. This is the
    // CI failure exactly — \`stillEditing: true\` beside a rename that then
    // landed on replay — reproduced locally by deferring that one task.
    //
    // \`categoryHint\` is the LAST statement in the queued branch, after
    // \`editingCategoryId = null\` and \`repaintCategories()\`, so the sentence
    // appearing again means the row is already closed. That ordering is what
    // keeps this a wait rather than a second copy of the assertion: delete the
    // \`if (err.queued)\` block and the hint is still set, so the checks below
    // fail BY NAME instead of hanging in \`waitUntil\`.
    document.getElementById('category-hint').textContent = '';
    [...row.querySelectorAll('button')].find(b => b.textContent === 'Save').click();
    return true;
  })()`);
  await waitUntil(ev,
    `document.getElementById('category-hint').textContent.includes('Saved offline')`,
    { what: 'the rename to be staged and reported as queued' });

  const afterQueuedRename = await ev(`(()=>({
    stillEditing: !!document.querySelector('.category-edit-name'),
    names: [...document.querySelectorAll('.category-manage-name')].map(n => n.textContent.trim()),
    error: document.getElementById('category-hint').classList.contains('error'),
  }))()`);
  ck('THE assertion: a queued rename closes its row, so no Cancel is offered ' +
     'for a write that is already committed to the outbox',
    afterQueuedRename.stillEditing === false, JSON.stringify(afterQueuedRename));
  ck('…and the list shows the name that was typed rather than the one it replaced',
    afterQueuedRename.names.includes('Wellness') && !afterQueuedRename.names.includes('Fitness'),
    JSON.stringify(afterQueuedRename.names));

  /* Reconnect and drain. `flush()` is called directly rather than through the
     watcher because the watcher is a poll with a backoff and this suite has no
     business waiting on one; the replay path it exercises is the same. */
  await ev(`window.__offline = false; true`);
  const flushed = await ev(`(async()=>{
    const { flush } = await import('/shared/offline.js');
    const r = await flush();
    return { sent: r.sent, failed: r.failed.map(f => f.status), remaining: r.remaining };
  })()`);
  ck('THE assertion: nothing in the outbox is refused on replay',
    flushed.failed.length === 0 && flushed.remaining === 0, JSON.stringify(flushed));

  const survivor = await fetchHabit(RENAMED_HABIT);
  ck('THE assertion: the habit edit made behind the queued delete survives it',
    !!survivor && survivor.category_id === null,
    JSON.stringify({ found: !!survivor, category_id: survivor?.category_id }));

  const renamedOnServer = await ev(`(async()=>{
    const cats = await (await fetch('/api/categories')).json();
    return { names: cats.map(c => c.name), work: cats.some(c => c.name === 'Work') };
  })()`);
  ck('…and both queued category writes actually landed',
    renamedOnServer.names.includes('Wellness') && renamedOnServer.work === false,
    JSON.stringify(renamedOnServer));

  /* ---------- g: an offline reorder keeps its order (issue #65 step 1) ----------
   *
   * The very end of the suite, reusing round 5's already-installed
   * `window.__offline` fetch stub rather than a second one, over the dialog
   * round 5 left open (`RENAMED_HABIT`'s own, mid-edit) and the account round
   * 5 left it — Work deleted, Fitness renamed to Wellness — which is a known
   * state with more than one category still on it.
   *
   * Mutation target: change `moveCategory`'s catch to
   * `state.categories = previous; repaintCategories();` unconditionally —
   * the same mistake `persistOrder` (dashboard.js) makes for the habit list —
   * this must FAIL.
   */
  console.log('--- g: an offline reorder keeps its order (issue #65 step 1) ---');

  await ev(`(async()=>{
    const { clearAll } = await import('/shared/offline.js');
    await clearAll();
    return true;
  })()`);

  const beforeOffline = await readManage();
  ck('sanity: more than one category is left to move, in the dialog round 5 left open',
    beforeOffline.names.length > 1, JSON.stringify(beforeOffline));

  await ev(`window.__offline = true; true`);
  const [offlineFirst, offlineSecond] = beforeOffline.names;
  // Blanked in the SAME evaluate as the click, for the reason the queued-rename
  // block above is: round 5's queued delete/rename left `#category-hint`
  // reading "Saved offline" and nothing between there and here clears it, so
  // the wait below would otherwise be a predicate that was ALREADY TRUE — it
  // could resolve on its first poll, before `moveCategory`'s catch has run,
  // and `readManage()` would then read the optimistic splice from BEFORE the
  // `try` rather than the outcome of the catch. `categoryHint` is the LAST
  // statement in `moveCategory`'s catch, after the conditional revert, so the
  // sentence appearing again means that decision has already been made.
  await ev(`(()=>{
    document.getElementById('category-hint').textContent = '';
    document.querySelector(
      '#category-manage .category-manage-row .category-move-down').click();
    return true;
  })()`);
  await waitUntil(ev,
    `document.getElementById('category-hint').textContent.includes('Saved offline')`,
    { what: 'the offline reorder to be staged and reported as queued' });

  const afterOffline = await readManage();
  const offlineHint = await ev(`(()=>({
    text: document.getElementById('category-hint').textContent,
    error: document.getElementById('category-hint').classList.contains('error'),
  }))()`);
  ck('g: THE assertion: an offline press keeps the new order rather than reverting it',
    afterOffline.names[0] === offlineSecond && afterOffline.names[1] === offlineFirst,
    JSON.stringify({ before: beforeOffline.names, after: afterOffline.names }));
  ck('…and reports it as saved offline, not as an error',
    offlineHint.text.includes('Saved offline') && offlineHint.error === false,
    JSON.stringify(offlineHint));

  await ev(`window.__offline = false; true`);

  console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CATEGORY CHECKS PASSED');
} catch (e) {
  console.log('ERROR:', e.message);
  fails++;
} finally {
  ws?.close();
  // `closeChrome` already removes `profile` itself, inside its own try/catch
  // ("a leftover temp dir is not worth failing a suite over" — chrome.mjs). A
  // second, unguarded removal here raced it under load: Windows had not
  // always released its handle on the directory `closeChrome` had just torn
  // down, so this line's own EPERM crashed the process — reported as a
  // categorycheck FAILURE — after every check above had already printed PASS.
  await closeChrome({ chrome, port: PORT, profile });
}

process.exit(fails ? 1 : 0);
