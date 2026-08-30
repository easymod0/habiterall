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
   * as right now. `marker` is stamped on a node so a redraw can be told from a
   * recolour — a rebuilt grid loses it.
   */
  const look = () => ev(`(() => {
    const cells = [...document.querySelectorAll('.cal-cell')];
    const counts = {};
    for (const c of cells) { const f = c.getAttribute('fill'); counts[f] = (counts[f] || 0) + 1; }
    const [attr] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const one = cells.find((c) => c.getAttribute('fill') === attr);
    one.dataset.marker = one.dataset.marker || 'stamped';
    return {
      theme: document.documentElement.dataset.theme,
      attr,
      painted: getComputedStyle(one).fill,
      shouldBe: getComputedStyle(document.documentElement)
        .getPropertyValue('--grid-empty').trim(),
      marked: one.dataset.marker,
      cells: cells.length,
    };
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

  const before = await look();
  ck('the calendar has cells to inspect', before.cells > 0, JSON.stringify(before));
  ck('an unrecorded day defers to the theme rather than naming a colour',
    before.attr === 'var(--grid-empty)', `fill=${before.attr}`);
  ck('and it paints as something', /rgb|color\(/.test(before.painted), before.painted);

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


  console.log(fails === 0 ? '\nALL THEME CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
