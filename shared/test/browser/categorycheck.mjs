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

  // Works from either view. A category mutation's `emit('reload')` runs
  // `dashboard.load()` in the background, which ends in `paint()` and so in
  // `views.showList()` — even while this suite is still on the habit's own
  // page behind an open dialog. `.habit-meta`'s row is a real DOM node
  // either way, and `.click()` fires its listener whether or not `#grid` is
  // currently the visible view, so re-navigating through it is what settles
  // that race rather than waiting on a view that may or may not still be the
  // one left standing.
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
