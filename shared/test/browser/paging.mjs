/**
 * Paging back through the dashboard must bring the recorded history with it.
 *
 * Regression: /overview always returned the last N days ending today, so the
 * arrows re-rendered an empty grid — every past day looked unrecorded even
 * though the stats view showed the data.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor, waitUntil,
} from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9306);
const profile = mkdtempSync(join(tmpdir(), 'habpage-'));
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

/**
 * Every `/overview` reply CDP has stopped and is holding, oldest first.
 *
 * `Fetch.requestPaused` is an EVENT and carries no `id`, so the dispatcher
 * below would otherwise drop it. The last block needs the requestIds to
 * release two replies in a chosen ORDER, which is what turns "the loads
 * raced" into "the older one lost". The same four lines `countcheck.mjs`
 * carries, and its own note says why they are not a shared helper yet: three
 * suites pause a request and no two do the same thing with one, so what is
 * duplicated is the dispatcher branch, which cannot move on its own — it
 * lives inside a per-suite `ws.onmessage` and `chrome.mjs` owns no socket.
 * This is the second file to release in a chosen order, which is the trigger
 * that note names for making the move; it is deliberately not made here,
 * because it is three suites edited and a new export in a file all 34 import,
 * and this change is not that change.
 */
const paused = [];

try {
  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    // See `paused` above: an event, so it has no `id` to answer.
    if (m.method === 'Fetch.requestPaused') paused.push(m.params);
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send('Page.enable', {}, sessionId);
  await reloadAndWaitFor(ev, `!!document.querySelector('#grid .habit-row')`, {
    reload: () => send('Page.navigate', { url: APP }, sessionId),
    what: 'the dashboard',
  });
  await sleep(600);

  /**
   * What the grid is showing, cell by cell: `{'check:<habit>:<date>': shown}`,
   * plus the range label and the counts.
   *
   * **This replaces a `filled()` that could not fail, and the repair is a
   * DELETION.** That function asked whether a cell was "tinted or shows a
   * number/glyph", and its tinted half compared
   * `getComputedStyle(box).backgroundColor` — an `rgb(35, 40, 48)` — against
   * `getPropertyValue('--grid-empty')`, which is the custom property's RAW
   * text, `#232830`-shaped. The two can never be equal, so `tinted` was true
   * for every non-transparent cell and `marked` was always `total`. Measured
   * against the unfixed `load()` in the last block of this file: the first row
   * painted four ticks and six blanks and `filled()` reported `marked: 40` of
   * 40. Three checks rested on it, and each of them was `marked > 0`.
   *
   * **The glyph is the whole answer, and the background test was never needed
   * — that is a property of `paintCheckbox` (`ui/day-strip.js`) rather than a
   * simplification.** Every branch that tints also writes a glyph (a tick, a
   * number, an `–` for a skip), and the two branches that write a glyph
   * WITHOUT tinting — the ghost tick, and `?` under `questionMarks` — are ones
   * a background test gets wrong in the other direction. So no cell is tinted
   * and empty, which is asserted below rather than assumed, because if that
   * ever stops being true this measure needs the other half back and should
   * say so by name.
   *
   * One function, and this is the one. The `agree` block that used to sit
   * below carried an inline copy of the same broken predicate scoped to the
   * first row; it is gone, its API half folded into the checks here.
   */
  const gridMarks = () => ev(`(() => {
    const cells = [...document.querySelectorAll('#grid .check[data-date]')];
    const shown = {};
    for (const btn of cells) {
      const box = btn.querySelector('.check-box');
      shown[btn.dataset.focusKey] = (box.textContent || '').trim() !== '';
    }
    return {
      range: document.querySelector('.grid-range')?.textContent ?? '',
      cells: cells.length,
      answered: Object.values(shown).filter(Boolean).length,
      shown,
    };})()`);

  /**
   * Every `(habit, date)` the account actually has a row for, keyed the way the
   * cells are.
   *
   * Read from `/habits/:id/entries`, which is unwindowed, so this is the whole
   * history and not a second copy of the window arithmetic under test.
   */
  const recorded = () => ev(`(async () => {
    const rows = {};
    for (const h of await (await fetch('/api/habits')).json()) {
      for (const e of await (await fetch('/api/habits/' + h.id + '/entries')).json()) {
        rows['check:' + h.id + ':' + e.date] = true;
      }
    }
    return rows;})()`);

  /**
   * Where the grid and the account's own rows disagree about a day.
   *
   * **A mark means a stored row, exactly, and that is a fact about THESE
   * fixtures rather than a rule copied out of `paintCheckbox`.** `reset()`
   * (`fixtures.mjs`) clears the settings first, so `questionMarks` is off and
   * `atMostUnlogged` is `miss` — no `?` and no ghost tick — and it writes only
   * three shapes: a boolean row of `2` (drawn as a tick), a numerical amount
   * of 10-30 (drawn as itself) and an at-most amount of 0-2 (drawn as itself,
   * 0 included). There is no boolean row of 0 and no skip anywhere in it,
   * which is the one case that would break the correspondence — with question
   * marks off a stored 0 on a boolean habit paints identically to no row at
   * all (the root `CLAUDE.md`'s reason for `unknowncheck.mjs`). If a future
   * fixture adds one, these checks fail and name the day, which is the right
   * failure rather than a wrong measure.
   */
  const disagreements = (grid, rows) => Object.entries(grid.shown)
    .filter(([key, on]) => on !== !!rows[key])
    .map(([key, on]) => `${key} is ${on ? 'marked with no row' : 'blank but has a row'}`);

  const rows = await recorded();

  // The measure's own premise, asserted once: nothing is tinted without a
  // glyph, so counting glyphs is counting marks. `--grid-empty` is resolved
  // through a probe rather than read as text — that difference in FORM is the
  // whole of what made the predicate this replaces vacuous, so it is worth
  // spelling out where somebody would otherwise write the same comparison
  // again.
  const tintedBlanks = await ev(`(() => {
    const probe = document.createElement('span');
    probe.style.background = 'var(--grid-empty)';
    document.body.append(probe);
    const empty = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [...document.querySelectorAll('#grid .check-box')]
      .filter(b => (b.textContent || '').trim() === '')
      .map(b => getComputedStyle(b).backgroundColor)
      .filter(bg => bg !== empty && bg !== 'rgba(0, 0, 0, 0)');})()`);
  ck('no cell is tinted without a glyph, so counting glyphs counts marks',
    tintedBlanks.length === 0, `${tintedBlanks.length}: ${JSON.stringify(tintedBlanks)}`);

  const now = await gridMarks();
  // **The grid must hold BOTH kinds of day, or agreement is satisfied by a
  // uniform one.** Structural rather than hopeful: `Gym` is seeded on Monday,
  // Wednesday and Friday only, so any run of ten consecutive columns leaves at
  // least four of its cells blank, while `Read` and `No late-night snacks`
  // carry a row on every one of the sixty days. This is what the mutation
  // (`answered: cells`) fails first, and it fails by naming the count.
  const spread = (g) => g.answered > 0 && g.answered < g.cells;
  ck('the current window marks exactly the days the account has recorded',
    spread(now) && disagreements(now, rows).length === 0,
    `${now.answered}/${now.cells} marked in ${now.range}; `
    + `${JSON.stringify(disagreements(now, rows).slice(0, 4))}`);

  // page back three windows; the fixtures cover 60 days, so history exists
  for (let i = 0; i < 3; i++) {
    await ev(`[...document.querySelectorAll('.grid-nav button')]
      .find(b => b.getAttribute('aria-label')?.startsWith('Previous')).click()`);
    await sleep(900);
  }
  const past = await gridMarks();
  // The regression this suite was written for, said as what it actually
  // claims: `/overview` used to answer the last N days ending today whatever
  // `end` asked for, so a paged window drew every past day unrecorded. The old
  // `marked > 0` could not see that — nor could it see the opposite failure,
  // a window drawing marks on days the account never answered.
  ck('a past window marks exactly the days the account has recorded there',
    spread(past) && disagreements(past, rows).length === 0,
    `${past.answered}/${past.cells} marked in ${past.range}; `
    + `${JSON.stringify(disagreements(past, rows).slice(0, 4))}`);
  ck('the window actually moved', past.range !== now.range, `${now.range} -> ${past.range}`);

  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b => b.textContent.trim() === 'Today')?.click()`);
  await sleep(900);
  const back = await gridMarks();
  ck('Today returns to the current window', back.range === now.range, `${back.range}`);
  ck('...and marks exactly the days the account has recorded there',
    spread(back) && disagreements(back, rows).length === 0,
    `${back.answered}/${back.cells} marked in ${back.range}; `
    + `${JSON.stringify(disagreements(back, rows).slice(0, 4))}`);
  // Cell for cell, and against the window it came back to: `range` alone says
  // the label changed back and nothing about what is under it. Kept BESIDE the
  // agreement above rather than instead of it — an equality is satisfied by any
  // two grids that are wrong the same way, which is exactly what a measure
  // reporting every cell as marked produces.
  ck('...cell for cell, the same grid it left',
    JSON.stringify(back.shown) === JSON.stringify(now.shown),
    `${back.answered}/${back.cells} marked, was ${now.answered}/${now.cells}`);

  console.log('\n--- two loads, and the OLDER window landing last ---');
  /*
   * `load()` (`ui/dashboard.js`) installs whatever reply lands LAST, and two
   * loads overlapping is ordinary rather than exotic: every press of these
   * arrows is one, and so is the midnight watch, the `'reload'` a save emits,
   * a check-off's `host.refresh()` and the browser reminder's own refresh.
   *
   * Two presses of ‹ inside one round trip put two `/overview` requests in
   * flight for DIFFERENT windows — the second press computes its `end` from
   * the `state.gridEnd` the first already moved, so at fourteen columns the
   * two windows do not even overlap. The older reply landing last used to
   * assign `state.habits` from it, while `paint()` — which runs from the
   * CURRENT `state.gridEnd` — went on drawing the newer window's columns. So
   * every cell on screen asks a habit map that was never fetched for those
   * days: a grid of blanks over a range label naming days the account has
   * answered, plus a `state.gridLoaded` saying so (which is what `ui/nudge.js`
   * judges a day by) and a `loadedDay` that disarms both midnight triggers for
   * the next 24 hours.
   *
   * `requestStage: 'Response'` for the reason `countcheck.mjs` records at
   * length: paused at the Request stage the server has not answered yet, so
   * releasing late just asks it the question again and the held reply is
   * FRESH. Held at the Response stage it is the answer to the window that was
   * actually asked for.
   *
   * The two are told apart by the requestId of the FIRST one, taken before the
   * second press exists, rather than by arrival order — nothing promises the
   * server answers two `/overview`s in the order it was asked.
   */
  const takePaused = async (want, ms = 8000) => {
    for (let i = 0; i < Math.ceil(ms / 100); i++) {
      if (paused.length >= want) return true;
      await sleep(100);
    }
    return false;
  };
  const release = (p) => send(
    p.responseStatusCode === undefined ? 'Fetch.continueRequest' : 'Fetch.continueResponse',
    { requestId: p.requestId }, sessionId
  ).catch(() => {});
  const pressOlder = () => ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b => b.getAttribute('aria-label')?.startsWith('Previous')).click()`);

  // One `childList` batch on `#grid` is one `paint()`: it opens with
  // `replaceChildren()` and fills synchronously, and nothing else in the app
  // touches that node's direct children. Counted so the release of the older
  // reply can be waited on by what it DID rather than by a duration — a
  // superseded load still paints, so there is a predicate here to poll.
  await ev(`(()=>{ window.__paints = 0;
    new MutationObserver(() => { window.__paints += 1; })
      .observe(document.getElementById('grid'), { childList: true });
    return true;})()`);
  const paints = () => ev(`window.__paints`);

  await send('Network.enable', {}, sessionId);
  await send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
  await ev(`performance.clearResourceTimings(); true`);
  await send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/overview*', requestStage: 'Response' }],
  }, sessionId);

  await pressOlder();
  ck('the first window back is held', await takePaused(1), `${paused.length} paused`);
  // Taken now, while it is the only one: this is the OLDER window's reply, and
  // the block turns on releasing it last.
  const older = paused[0];
  // The grid has not repainted — the first reply is still held — so this is
  // the same button, still on screen, being pressed a second time.
  await pressOlder();
  ck('...and the second is held beside it, so two windows are outstanding',
    await takePaused(2), `${paused.length} paused`);
  const newer = paused.find((p) => p.requestId !== older.requestId);

  const beforeRelease = await paints();
  await release(newer);
  await waitUntil(ev, `window.__paints > ${beforeRelease}`,
    { what: 'the newer window to paint' });
  const settled = await gridMarks();
  // The guard the comparison below needs: a grid of blanks compares equal to a
  // grid of blanks, so the newer window has to have marked something first —
  // and `spread` is the stronger form of that, since a grid the mutation has
  // reported as uniformly marked compares equal to itself just as readily.
  ck('the newer window painted, and marks its own recorded days',
    spread(settled) && settled.range !== back.range
    && disagreements(settled, rows).length === 0,
    `${settled.answered}/${settled.cells} marked in ${settled.range}; `
    + `${JSON.stringify(disagreements(settled, rows).slice(0, 4))}`);

  const beforeStale = await paints();
  await release(older);
  // A superseded load still `paint()`s — from state a newer load has already
  // moved, which can only re-confirm what is there — so this waits for that
  // paint rather than sleeping past it. It is also what proves the reply
  // ARRIVED: the check below would pass for free against a reply abandoned by
  // `api()`'s ten-second bound.
  await waitUntil(ev, `window.__paints > ${beforeStale}`,
    { what: 'the superseded load to repaint' });
  const afterStale = await gridMarks();

  await send('Fetch.disable', {}, sessionId);
  await send('Network.setBypassServiceWorker', { bypass: false }, sessionId);

  const loadsLanded = await ev(`performance.getEntriesByType('resource')
    .filter(e => e.name.includes('/overview')).length`);
  ck('both windows actually answered, so the interleaving was real',
    loadsLanded >= 2, `${loadsLanded} landed`);
  ck('the older window is DISCARDED rather than installed under the newer '
    + "window's columns",
    JSON.stringify(afterStale.shown) === JSON.stringify(settled.shown)
    && afterStale.range === settled.range,
    `${settled.answered}/${settled.cells} in ${settled.range} -> `
    + `${afterStale.answered}/${afterStale.cells} in ${afterStale.range}`);

  console.log(fails === 0 ? '\nALL PAGING CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
