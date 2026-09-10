/**
 * A chart drawn under one theme has to look right under the other.
 *
 * The colours in an SVG used to be read with `getComputedStyle` at draw time
 * and written into `fill` as literals, which freezes the palette the chart was
 * drawn under. Nothing corrects that but a re-render — and the detail view
 * re-renders by REFETCHING, so switching to dark left every unrecorded
 * calendar square holding the light `#e6e9ef`, which against the dark card
 * reads as white. For two requests, and forever if either failed.
 *
 * So the check that matters is not "does it look right after a redraw" — it is
 * "does it look right when a redraw is impossible". Every request the detail
 * view could make is blocked before the theme is switched, and the same DOM
 * nodes are then asked what colour they are painting.
 *
 * Only a real browser can answer that: `var()` in a presentation attribute is
 * resolved by the cascade, which the offline suites\' fake DOM does not have.
 *
 * **This suite is about what a theme LOOKS like.** Whether the choice survives
 * a migration, a refused read, an offline press or another device is
 * `themesync.mjs` — which was the larger half of this file and is not really
 * about colour at all.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor, waitUntil,
} from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9317);
const profile = mkdtempSync(join(tmpdir(), 'habtheme-'));
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
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
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

  /**
   * A boot this suite is ready to act on.
   *
   * Both halves are needed and neither is decoration. `.habit-row` is
   * downstream of `settings.init()` — `start()` awaits it before it renders —
   * so a rendered row means the account's settings have arrived AND the
   * reconcile they drive has run; measured, the migration's own write lands
   * within 7ms of the row appearing. `dataset.theme` is what nearly every
   * assertion below reads, so waiting for the row without it would be a poll
   * that returns before the thing under test exists.
   *
   * It holds under every stub in this file, including the ones that refuse
   * `/api/settings` outright: `init()` catches, boot continues, and the
   * dashboard renders from cache — measured at 49–67ms, faster than the
   * healthy path rather than slower.
   */
  const READY = `!!(document.querySelector('.habit-row')`
    + ` && document.documentElement.dataset.theme)`;

  /**
   * Load the app and wait for it, in place of a fixed sleep.
   *
   * The wait is JOINED to the navigation — `reloadAndWaitFor` marks the
   * outgoing document, so the predicate answers "which document am I in" and
   * not merely "is something painting a row" (#269) — but ONLY when the
   * navigation is genuinely CROSS-document. That condition is the whole care
   * in this helper and it must not be dropped: on a SAME-document (fragment
   * only) navigation the window is never replaced, so `window.__doomed`
   * SURVIVES, `!window.__doomed` is never true, and the wait hangs for its
   * full 20s. Closing a sub-10ms race by buying a guaranteed 20s hang is the
   * wrong trade, so the marker is conditional rather than unconditional.
   *
   * The caller that can reach that case is the deep link below, the only
   * fragment-carrying `boot` in the tree. It is cross-document TODAY only
   * because it is the first navigation in this file and the page is still
   * `about:blank` — move it down, or give it a sibling called from a page
   * already at `${APP}/#/...`, and an unconditional marker would hang there.
   * So the question is asked of the two URLs rather than assumed, and it is
   * asked in the page so the browser's own parser resolves both: a target
   * with no fragment is always a real document load, and a target with one is
   * a real load only if something before the `#` differs too.
   */
  const boot = async (url = `${APP}/`, until = READY) => {
    const what = `the app to boot at ${url}`;
    const sameDocument = await ev(`(u => u.includes('#')
      && new URL(u, location.href).href.split('#')[0] === location.href.split('#')[0]
    )(${JSON.stringify(url)})`);
    if (sameDocument) {
      await send('Page.navigate', { url }, sessionId); // navigate-unjoined: the same-document branch, where the marker would survive and never clear
      await waitUntil(ev, until, { what });
      return;
    }
    await reloadAndWaitFor(ev, until, { reload: () => send('Page.navigate', { url }, sessionId), what });
  };

  const habits = await (await fetch(`${APP}/api/habits`)).json();
  const habit = habits[0];

  // The detail view, so the predicate is its calendar rather than a habit row.
  await boot(`${APP}/#/habit/${habit.id}`, `!!document.querySelector('.cal-cell')`);
  await sleep(400);

  /**
   * The calendar's own account of itself: what it wrote, and what that paints
   * as right now. `marked` is a marker stamped on the nodes so a redraw can be
   * told from a recolour — a rebuilt grid draws fresh nodes and loses it.
   *
   * **The probe only READS the marker.** It used to stamp one too, as
   * `one.dataset.marker = one.dataset.marker || 'stamped'`, and then return
   * what it had just written — which is `'stamped'` whether the node survived
   * the theme press or was replaced outright, so the assertion below could not
   * fail. `stampCells` is the one writer now, called once before the press,
   * and the read is a bare `?? null` (never `undefined`: a key holding it is
   * dropped crossing CDP's `returnByValue`, so the assertion would compare
   * against a missing property rather than against a marker that is gone).
   *
   * **`shouldBe` used to be a value nothing could equal, and now it is the
   * assertion.** It read `getComputedStyle(documentElement)
   * .getPropertyValue('--grid-empty')`, which is the custom property's RAW
   * text (`#e6e9ef`, `#232830`), against a `painted` that is
   * `getComputedStyle(cell).fill` — an `rgb(230, 233, 239)`. Those can never
   * be equal in either theme, in either direction, which is the shape this
   * repo's own CLAUDE.md calls out as unable to fail. Nothing compared them,
   * so nothing passed that should not have; what it cost was a failure
   * message printing two values that will never match, and a reader chasing
   * it. `paging.mjs`'s `filled()` was the same comparison a step further
   * along, where something DID rest on it.
   *
   * The `#182` block ~230 lines below already resolves the property through a
   * scratch element for exactly this reason (`panelLook`'s own probe). This is
   * that, at the block the file is named for, and the same probe SHAPE rather
   * than a second one: an element in the ordinary document flow, so it
   * inherits `--grid-empty` from `:root` the way the palette defines it. Not a
   * sibling inside the same `<svg>`, which would inherit any override scoped
   * to the chart and so agree with the cell about a value neither should hold.
   *
   * `backgroundColor` on the probe against `fill` on the cell: two different
   * properties, one serialisation — Chrome spells both `rgb(r, g, b)` — which
   * is the whole point of resolving rather than reading the literal.
   */
  const look = () => ev(`(() => {
    const cells = [...document.querySelectorAll('.cal-cell')];
    const counts = {};
    for (const c of cells) { const f = c.getAttribute('fill'); counts[f] = (counts[f] || 0) + 1; }
    const [attr] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const one = cells.find((c) => c.getAttribute('fill') === attr);
    const probe = document.createElement('span');
    probe.style.background = 'var(--grid-empty)';
    document.body.append(probe);
    const shouldBe = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      theme: document.documentElement.dataset.theme,
      attr,
      painted: getComputedStyle(one).fill,
      shouldBe,
      marked: one.dataset.marker ?? null,
      cells: cells.length,
    };
  })()`);

  /**
   * Stamp EVERY cell, rather than the one `look()` happens to pick.
   *
   * `look()` picks the first cell carrying the commonest `fill`, which is a
   * choice made afresh on each call — so stamping only that node would tie
   * the check to the two calls agreeing about which cell that is. Marking the
   * whole grid needs no such agreement: after a rebuild NO cell carries the
   * marker, whichever one the second probe reaches for.
   */
  const stampCells = () => ev(`(() => {
    const cells = [...document.querySelectorAll('.cal-cell')];
    for (const c of cells) c.dataset.marker = 'stamped';
    return cells.length;
  })()`);

  // From a KNOWN state, and under a KNOWN device preference.
  //
  // Both halves matter. The stored value, so this does not depend on what a
  // previous suite left behind — and the emulated media, because the property
  // under test is "the first press from `system` changes the appearance", and
  // with a fixed `['system','light','dark']` cycle that is only false when the
  // device prefers LIGHT. Measured: this machine's headless Chrome prefers
  // dark, so the suite passed against the exact regression it was written for
  // until the preference was pinned here, and the only guard was whatever CI's
  // device happened to say.
  await send('Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
  await sleep(200);
  const emulated = await ev(`matchMedia('(prefers-color-scheme: dark)').matches`);
  ck('the device preference is pinned to light for this check', emulated === false,
    `prefers-dark=${emulated}`);
  await ev(`(async()=>{
    const { save } = await import('/shared/ui/settings.js');
    await save('theme', 'system');
    return 1;
  })()`);
  await sleep(400);

  // Stamped BEFORE the first probe, so `before.marked` says the marker is
  // readable where the second probe will look for it. Without that half the
  // post-press read is unfalsifiable in the other direction: a marker nothing
  // ever wrote is absent after the press too, and the check would be failing
  // for a reason that has nothing to do with a re-render.
  const stampedCells = await stampCells();
  const before = await look();
  ck('the calendar has cells to inspect', before.cells > 0, JSON.stringify(before));
  ck('every cell is marked before the theme press',
    stampedCells > 0 && before.marked === 'stamped',
    `${stampedCells} cells, marker=${before.marked}`);
  ck('an unrecorded day defers to the theme rather than naming a colour',
    before.attr === 'var(--grid-empty)', `fill=${before.attr}`);
  ck('and it paints as something', /rgb|color\(/.test(before.painted), before.painted);
  // The claim the block is FOR, and the one `shouldBe` could not make until it
  // was resolved rather than read: not merely that the cell paints a colour,
  // but that it paints THIS theme's `--grid-empty`. Everything above is
  // satisfied by a cell resolving the name against the wrong value — a rule
  // scoping the property to the chart, a palette entry that moved under one
  // theme and not the other — and so is the repaint check below, which only
  // asks that the colour CHANGED.
  ck('...and what it paints is this theme\'s own --grid-empty',
    before.painted === before.shouldBe,
    `painted ${before.painted}, --grid-empty resolves to ${before.shouldBe}`);

  // Nothing the detail view could ask for is available from here on. A redraw
  // is a refetch, so this makes one impossible rather than merely unlikely.
  await send('Network.setBlockedURLs', { urls: ['*/api/habits/*'] }, sessionId);

  await ev(`document.querySelector('#btn-theme').click()`);
  await sleep(1200);

  const after = await look();
  ck('the theme actually switched', after.theme !== before.theme,
    `${before.theme} -> ${after.theme}`);
  ck('nothing re-rendered — the same nodes are still there',
    after.marked === 'stamped', `marker=${after.marked}`);
  ck('and the unrecorded days repainted anyway',
    after.painted !== before.painted, `${before.painted} -> ${after.painted}`);
  // ...to the value the OTHER theme's palette names, which is the half
  // "it changed" cannot make on its own. Asserted in both themes rather than
  // only after the press, because a cell frozen at the light colour and a
  // cell resolving the wrong name are different defects and each passes the
  // other's check.
  ck('...and to the new theme\'s own --grid-empty, not merely to something else',
    after.painted === after.shouldBe,
    `painted ${after.painted}, --grid-empty resolves to ${after.shouldBe}`);
  ck('to the new theme\'s own colour, with no request made',
    after.attr === 'var(--grid-empty)', `fill=${after.attr}`);

  await send('Network.setBlockedURLs', { urls: [] }, sessionId);

  // The same for a partly-complete day, which is a blend rather than a plain
  // colour: the mix used to be computed in JS against the palette of the day it
  // was drawn under, which froze it just as hard. A measurable habit, because a
  // yes/no one only ever paints full strength — asked for by name so this
  // cannot go quietly vacuous if the fixtures are reordered.
  const measurable = habits.find((h) => h.type === 'numerical'
    && h.target_type === 'at_least');
  ck('the fixtures still contain a measurable habit to blend', !!measurable,
    habits.map((h) => `${h.name}:${h.type}`).join(', '));

  if (measurable) {
    // A tab of its own. Pointing this one at another fragment would not reload
    // it — same document — and the reload that does is a race against the
    // checks above; a second target is both simpler and honest about starting
    // from nothing.
    const other = await send('Target.createTarget',
      { url: `${APP}/#/habit/${measurable.id}` });
    const otherSession = (await send('Target.attachToTarget',
      { targetId: other.targetId, flatten: true })).sessionId;
    const otherEv = async (e) => {
      const r = await send('Runtime.evaluate',
        { expression: e, awaitPromise: true, returnByValue: true }, otherSession);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
      return r.result.value;
    };
    for (let i = 0; i < 80; i++) {
      if (await otherEv(`!!document.querySelector('.cal-cell')`).catch(() => 0)) break;
      await sleep(200);
    }
    await sleep(400);

    const blend = await otherEv(`(() => {
      const mixed = [...document.querySelectorAll('.cal-cell')]
        .map((c) => c.getAttribute('fill'))
        .filter((f) => f && f.startsWith('color-mix'));
      return { count: mixed.length, sample: mixed[0] ?? null };
    })()`);
    ck('a short day is drawn as a blend at all', blend.count > 0,
      JSON.stringify(blend));
    ck('and it blends toward the theme, not toward a literal',
      !!blend.sample && /var\(--grid-empty\)/.test(blend.sample), blend.sample);
  }


  // Land on an explicit value, reload, and see it survive with no localStorage
  // theme key in play.
  await ev(`(async()=>{
    const { save } = await import('/shared/ui/settings.js');
    localStorage.removeItem('habiterall-theme');
    await save('theme', 'dark');
    return 1;
  })()`);
  await boot();
  const survived = await ev(`document.documentElement.dataset.theme`);
  ck('a stored theme survives a reload', survived === 'dark', String(survived));

  // The chrome AROUND the app follows it too. index.html keys its two
  // `theme-color` tags on `prefers-color-scheme`, which was only ever wrong
  // after a deliberate toggle — and now that the theme is the ACCOUNT's, an
  // installed PWA set to dark on a light phone is the ordinary state. It drew
  // a light status bar and address bar around a dark app.
  //
  // Asserted against the cascade rather than against a literal, since that is
  // where `apply()` reads it from: a hex pinned here would go stale the day
  // the palette moves, and would pass while the page painted something else.
  const chrome1 = await ev(`(() => {
    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue('--bg').trim();
    const tags = [...document.querySelectorAll('meta[name="theme-color"]')]
      .map((m) => m.getAttribute('content'));
    return { bg, tags, scheme: getComputedStyle(document.documentElement).colorScheme };
  })()`);
  ck('the browser chrome is told which theme the ACCOUNT is on',
    chrome1.tags.length > 0 && chrome1.tags.every((c) => c === chrome1.bg),
    JSON.stringify(chrome1));
  // `color-scheme` is the other half, and it is what native surfaces read:
  // scrollbars, form controls and the caret take no notice of `--bg`.
  ck('...and so are the scrollbars and form controls',
    chrome1.scheme === 'dark', JSON.stringify(chrome1));

  // And `system` paints from the device rather than freezing at whatever the
  // last explicit choice was.
  const followed = await ev(`(async()=>{
    const { save } = await import('/shared/ui/settings.js');
    await save('theme', 'system');
    const wantsDark = matchMedia('(prefers-color-scheme: dark)').matches;
    return { painted: document.documentElement.dataset.theme,
             expected: wantsDark ? 'dark' : 'light' };
  })()`);
  ck('and "follow this device" resolves against the device',
    followed.painted === followed.expected, JSON.stringify(followed));


  /* ---------- #182: the icon picker panel follows the theme too ----------
   *
   * A NEW, separate block, deliberately not folded into any setup above —
   * see the root CLAUDE.md's note on this file: two of its blocks can look
   * like near-duplicates while pinning different halves, and merging this one
   * in would be exactly that. Everything it needs (its own boot, its own
   * `look`-shaped probe, its own theme press) is self-contained here.
   *
   * `#icon-picker` is ordinary CSS, not an SVG attribute, so there is no
   * `fill="var(...)"` text to read the way `look()` reads a calendar cell's
   * `attr` above — the panel's colour only ever exists as a COMPUTED value.
   * `getComputedStyle(...).backgroundColor` resolves to an `rgb(...)` string
   * while `getPropertyValue('--surface-2')` returns the raw literal
   * (`#eef0f4`, `#1f242c`) — so a direct `===` between the two would never be
   * true in either theme, in either direction, which is the shape of test
   * this repo's own CLAUDE.md calls out as unable to fail. `resolvedVar`
   * below runs the custom property through a scratch element first, so both
   * sides of the comparison come out through the same `backgroundColor`
   * serialisation.
   */
  console.log('\n--- #182: the icon picker panel follows the theme too ---');

  // A fresh boot to the dashboard: the blocks above leave the app on a
  // habit's own page (or, for the `measurable` block, a second tab), and
  // `#btn-new` — the toggle this block presses lives only behind it — is a
  // dashboard-only control.
  await boot();
  await ev(`document.getElementById('btn-new').click()`);
  await waitUntil(ev,
    `document.getElementById('habit-dialog').open === true
      && !!document.getElementById('habit-form').icon`,
    { what: 'the new-habit dialog, with its icon field present' });
  await ev(`document.getElementById('icon-picker-toggle').click()`);
  await waitUntil(ev,
    `!document.getElementById('icon-picker').hidden
      && document.querySelectorAll('#icon-grid .icon-cell').length > 0`,
    { what: 'the icon picker panel, open with cells rendered' });

  /**
   * `.icon-picker`'s stylesheet rule reads `background: var(--surface-2)`,
   * not `--surface` — it is a raised, bordered panel over the dialog's own
   * `--surface`, the same relationship `.category-manage`'s scrolling panel
   * has to the dialog around it — so `--surface-2` is the variable this
   * panel's colour can actually be judged against.
   *
   * `marked` is read and never written here, for the reason `look()`'s own
   * comment gives at length: a probe that stamps `marker || 'stamped'` and
   * then returns it reads back what it just wrote, so it answers `'stamped'`
   * whether the panel node survived the theme press or was replaced outright.
   * `stampPanel` is the one writer, called once before the press.
   */
  const panelLook = () => ev(`(() => {
    const panel = document.getElementById('icon-picker');
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--surface-2)';
    document.body.appendChild(probe);
    const shouldBe = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      painted: getComputedStyle(panel).backgroundColor,
      shouldBe,
      marked: panel.dataset.marker ?? null,
    };
  })()`);

  /** The one writer of the panel's marker. Called once, before the press. */
  const stampPanel = () => ev(`(() => {
    const panel = document.getElementById('icon-picker');
    panel.dataset.marker = 'stamped';
    return panel.dataset.marker;
  })()`);

  const panelStamp = await stampPanel();
  const beforePanel = await panelLook();
  ck('the picker panel has a background colour to inspect',
    /rgb|color\(/.test(beforePanel.painted), beforePanel.painted);
  ck('...and it is the current theme\'s --surface-2',
    beforePanel.painted === beforePanel.shouldBe, JSON.stringify(beforePanel));
  ck('the panel is marked before the theme press',
    panelStamp === 'stamped' && beforePanel.marked === 'stamped',
    `wrote=${panelStamp} read=${beforePanel.marked}`);

  await ev(`document.getElementById('btn-theme').click()`);
  await sleep(1200);

  const afterPanel = await panelLook();
  ck('the picker panel colour actually changed with the theme',
    afterPanel.painted !== beforePanel.painted,
    `${beforePanel.painted} -> ${afterPanel.painted}`);
  ck('...to the NEW theme\'s own --surface-2',
    afterPanel.painted === afterPanel.shouldBe, JSON.stringify(afterPanel));
  ck('nothing re-rendered — the same panel node is still there',
    afterPanel.marked === 'stamped', `marker=${afterPanel.marked}`);

  await ev(`document.getElementById('habit-dialog').close()`);

  console.log(fails === 0 ? '\nALL THEME CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
