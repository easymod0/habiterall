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
    await waitUntil(ev, `!document.getElementById('view-detail').hidden && ${byText('#view-detail button', 'Edit')}`,
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
