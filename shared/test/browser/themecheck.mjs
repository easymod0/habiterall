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
 * resolved by the cascade, which the offline suites' fake DOM does not have.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = 9317;
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

  const habits = await (await fetch(`${APP}/api/habits`)).json();
  const habit = habits[0];

  await send('Page.navigate', { url: `${APP}/#/habit/${habit.id}` }, sessionId);
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!document.querySelector('.cal-cell')`).catch(() => 0)) break;
    await sleep(200);
  }
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

  /* ---------- the theme is a preference, and `system` is one of three ---------- */
  //
  // It used to live in localStorage under `habiterall-theme`, so it did not
  // follow the account — and `toggleTheme` wrote one of two values, which made
  // the first press irreversible: nothing could get back to following the
  // device. Both halves are checked here rather than in a unit test, because
  // what is being asserted is that the SERVER ends up holding it and that the
  // page paints from it on the next load.
  const cycled = await ev(`(async()=>{
    const theme = await import('/shared/ui/theme.js');
    const out = [];
    // Three presses from wherever it is: the cycle must return to its start,
    // which is what "there is a way back to the system" means.
    for (let i = 0; i < 4; i++) {
      out.push(await (await fetch('/api/settings',
        { credentials: 'same-origin' })).json().then(s => s.theme ?? null));
      await theme.toggleTheme();
    }
    return out;
  })()`);
  ck('pressing the control stores the theme on the SERVER',
    cycled.slice(1).every((v) => v !== null), JSON.stringify(cycled));
  ck('and the cycle includes a way back to following the device',
    cycled.includes('system'), JSON.stringify(cycled));
  ck('the three states are all reachable',
    new Set(cycled.filter(Boolean)).size >= 3, JSON.stringify(cycled));

  // Land on an explicit value, reload, and see it survive with no localStorage
  // theme key in play.
  await ev(`(async()=>{
    const { save } = await import('/shared/ui/settings.js');
    localStorage.removeItem('habiterall-theme');
    await save('theme', 'dark');
    return 1;
  })()`);
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(2500);
  const survived = await ev(`document.documentElement.dataset.theme`);
  ck('a stored theme survives a reload', survived === 'dark', String(survived));

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

  /* ---------- the upgrade path ---------- */
  //
  // The half with no test, and the one that matters most: everyone using the
  // app today has their theme in `localStorage['habiterall-theme']` and nowhere
  // else. An earlier version of `migrateTheme` asked `settings.get('theme')`
  // whether the account had one — which cannot answer, because `ui/settings.js`
  // fills gaps from `defaults()` — so it never saved and deleted the key anyway.
  // Every user who had pressed the old toggle lost their choice on the first
  // load after upgrading, silently.
  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
    localStorage.removeItem('habiterall-settings');
    localStorage.setItem('habiterall-theme', 'dark');
    return 1;
  })()`);
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(3000);

  const migrated = await ev(`(async()=>{
    const stored = await (await fetch('/api/settings',
      { credentials: 'same-origin' })).json();
    return {
      serverTheme: stored.theme ?? null,
      legacyKey: localStorage.getItem('habiterall-theme'),
      painted: document.documentElement.dataset.theme,
    };
  })()`);
  ck('the pre-setting choice is carried up to the account',
    migrated.serverTheme === 'dark', JSON.stringify(migrated));
  ck('the old key is cleared only once it has been', migrated.legacyKey === null,
    JSON.stringify(migrated));
  ck('and the page is painted with it, not with the default',
    migrated.painted === 'dark', JSON.stringify(migrated));

  /* ---------- a boot whose settings read FAILS ---------- */
  //
  // The migration's fallback path, which is the half its own fix nearly broke.
  // `serverAnswered` says "the account is authoritative from here"; setting it
  // before the read meant every failure — offline, a 429 from the read limiter
  // (this edition keys it on IP), a proxy's 502 — left it true with the legacy
  // key still on disk and nothing stored. `choice()` then answered 'system'
  // while the page was painted dark, so the next unrelated cache write flipped
  // the theme mid-session and it reverted on reload. Silent, both ways.
  //
  // The stub is installed BEFORE the document so it is in place for the boot,
  // and it fails only `/api/settings` — everything else loads normally, which
  // is what makes this the shape of a rate-limited read rather than an outage.
  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
    localStorage.removeItem('habiterall-settings');
    localStorage.setItem('habiterall-theme', 'dark');
    return 1;
  })()`);
  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.fetch;
      window.fetch = (input, init) => {
        const url = String(typeof input === 'string' ? input : input?.url ?? '');
        if (url.includes('/api/settings') && (init?.method ?? 'GET') === 'GET') {
          return Promise.resolve(new Response('{}', { status: 429 }));
        }
        return real(input, init);
      };
    })();`,
  }, sessionId);
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(3000);

  const refused = await ev(`(async()=>{
    const painted = document.documentElement.dataset.theme;
    // Any unrelated preference write — the in-place calendar zoom the detail
    // view offers — which goes through the same writeCache chokepoint the theme
    // listens on. (No backticks in here: this block is one template literal.)
    const { set } = await import('/shared/ui/settings.js');
    set('calendarZoom', 'wide');
    await new Promise((r) => setTimeout(r, 400));
    return { painted, after: document.documentElement.dataset.theme,
             legacy: localStorage.getItem('habiterall-theme') };
  })()`);
  ck('a failed settings read still paints the pre-setting choice',
    refused.painted === 'dark', JSON.stringify(refused));
  ck('and an unrelated write does not flip it out from under the user',
    refused.after === 'dark', JSON.stringify(refused));
  // Kept on the device, or already carried up — but never simply gone. The
  // unrelated write above goes to the server and comes back naming the keys
  // the account holds, and that reply is what the theme reconciles against, so
  // a read refused with a 429 no longer means waiting for the next boot to
  // migrate. Either answer is durable; losing both is the failure.
  // Read from NODE, not from the page: the stub above refuses every
  // `/api/settings` GET the document makes, including one a check would make
  // to look at the account, which reported "nothing stored" for a value that
  // was stored perfectly well.
  const account = await (await fetch(`${APP}/api/settings`)).json().catch(() => ({}));
  ck('the pre-setting choice survives a refused read',
    refused.legacy === 'dark' || account.theme === 'dark',
    `${JSON.stringify(refused)} account=${JSON.stringify(account)}`);

  // ...and a PRESS in that state must not destroy the choice it is painting.
  //
  // This is the loss the migration exists to prevent, reached through the door
  // it left open. `choice()` preferred the legacy key while the server had not
  // answered — right for painting — and `nextChoice()` and the applier read the
  // same thing, so a press wrote the OPPOSITE of the stored choice to the
  // account and then repainted the legacy value over it. The button appeared
  // dead, which invites more presses, and the next clean boot adopted the
  // account's value and deleted the key. Silent and irreversible.
  const pressed = await ev(`(async()=>{
    const { toggleTheme } = await import('/shared/ui/theme.js');
    // Writing the record is the first thing a press does; this makes the
    // store fail, as private browsing and a full quota do, so what is under
    // test is that a press still changes the theme when nothing about it can
    // be remembered.
    const realRemove = localStorage.removeItem.bind(localStorage);
    const realSet = localStorage.setItem.bind(localStorage);
    localStorage.removeItem = (k) => {
      if (k === 'habiterall-theme') throw new Error('quota');
      return realRemove(k);
    };
    localStorage.setItem = (k, v) => {
      if (k === 'habiterall-theme') throw new Error('quota');
      return realSet(k, v);
    };
    const before = document.documentElement.dataset.theme;
    await toggleTheme();
    await new Promise((r) => setTimeout(r, 400));
    const out = { before, painted: document.documentElement.dataset.theme,
                  legacy: localStorage.getItem('habiterall-theme') };
    localStorage.removeItem = realRemove;
    localStorage.setItem = realSet;
    localStorage.removeItem('habiterall-theme');
    return out;
  })()`);
  ck('a press during a failed read actually changes the theme',
    pressed.painted !== pressed.before, JSON.stringify(pressed));
  // The record cannot be written OR deleted here, so the press has nothing
  // durable to lean on — and must still paint what was asked for rather than
  // snapping back to the value it could not retire.
  ck('even when nothing about the press can be remembered',
    pressed.painted !== pressed.before && pressed.painted !== null,
    JSON.stringify(pressed));

  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId);

  /* ---------- a boot whose settings WRITE fails ---------- */
  //
  // The other branch of the same function. An earlier fix moved
  // `serverAnswered` below the read's failure returns and left it above the
  // write's, so with the GET succeeding and the PUT refused the flag went true
  // with the legacy key correctly kept and nothing stored — and `choice()` then
  // answered 'system' over a page painted dark.
  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
    localStorage.removeItem('habiterall-settings');
    localStorage.setItem('habiterall-theme', 'dark');
    return 1;
  })()`);
  const putStub = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.fetch;
      window.fetch = (input, init) => {
        const url = String(typeof input === 'string' ? input : input?.url ?? '');
        if (url.includes('/api/settings') && (init?.method ?? 'GET') !== 'GET') {
          return Promise.resolve(new Response('{}', { status: 429 }));
        }
        return real(input, init);
      };
    })();`,
  }, sessionId);
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(3000);

  const refusedWrite = await ev(`(async()=>{
    const painted = document.documentElement.dataset.theme;
    const { set } = await import('/shared/ui/settings.js');
    set('calendarZoom', 'close');
    await new Promise((r) => setTimeout(r, 400));
    return { painted, after: document.documentElement.dataset.theme,
             legacy: localStorage.getItem('habiterall-theme') };
  })()`);
  ck('a refused WRITE keeps the pre-setting key', refusedWrite.legacy === 'dark',
    JSON.stringify(refusedWrite));
  ck('and does not flip the theme out from under the user',
    refusedWrite.painted === 'dark' && refusedWrite.after === 'dark',
    JSON.stringify(refusedWrite));

  await send('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: putStub.identifier }, sessionId);

  /* ---------- a press while the migration is still writing ---------- */
  //
  // The window a guard could not close: `migrateTheme` checks `userChose` and
  // then issues its OWN `save`, so a press landing inside that await was a
  // second writer on one key. Measured both ways before this — the press
  // landing in the account while the screen and the settings cache still held
  // the old value, and the press discarded outright — and `toggleTheme`
  // answered `{ok: true}` for both, so nothing was said.
  //
  // The fix is not a fourth flag: `toggleTheme` awaits the migration's promise,
  // so there is one writer at a time. The press still paints immediately.
  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
    localStorage.removeItem('habiterall-settings');
    localStorage.setItem('habiterall-theme', 'dark');
    return 1;
  })()`);
  const slowPut = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.fetch;
      // Only the FIRST write is held — the migration's. Delaying both equally
      // made the test unable to discriminate: the press's own PUT was slowed by
      // the same 2s, so it landed last and the account read correctly whether
      // or not toggleTheme waited for anything. (No backticks: template literal.)
      let held = false;
      window.fetch = (input, init) => {
        const url = String(typeof input === 'string' ? input : input?.url ?? '');
        if (url.includes('/api/settings') && (init?.method ?? 'GET') !== 'GET' && !held) {
          held = true;
          return new Promise((r) => setTimeout(() => r(real(input, init)), 2000));
        }
        return real(input, init);
      };
    })();`,
  }, sessionId);
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(1200);        // inside the migration's held PUT

  const raced = await ev(`(async()=>{
    const { toggleTheme } = await import('/shared/ui/theme.js');
    const before = document.documentElement.dataset.theme;
    const painted = [];
    const r = await toggleTheme();
    painted.push(document.documentElement.dataset.theme);
    await new Promise((res) => setTimeout(res, 2500));   // let the migration land
    const stored = await (await fetch('/api/settings',
      { credentials: 'same-origin' })).json();
    return { before, result: r, afterPress: painted[0],
             settled: document.documentElement.dataset.theme,
             account: stored.theme ?? null };
  })()`);
  ck('a press during the migration\'s write is the one that wins',
    raced.account === raced.settled && raced.account !== 'dark',
    JSON.stringify(raced));
  ck('and the screen agrees with the account afterwards',
    raced.settled === raced.account, JSON.stringify(raced));

  await send('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: slowPut.identifier }, sessionId);

  /* ---------- a press that only reached the outbox keeps the key ---------- */
  //
  // `save` answers `{ok: true, offline: true}` having written the settings
  // cache and queued the PUT — which is NOT two durable homes for the answer:
  // the cache is replaced wholesale by the next `init()`, and the outbox drops
  // a replayed 4xx other than 401/403, which includes a 429 from the write
  // limiter. So deleting the key on an offline save can lose the pre-setting
  // choice for good, through two ordinary failures in sequence.
  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
    localStorage.removeItem('habiterall-settings');
    localStorage.setItem('habiterall-theme', 'dark');
    return 1;
  })()`);
  // The read is refused too, so the migration bails and the key is still there
  // to be protected — otherwise it has already migrated legitimately and there
  // is nothing left for the press to lose, which is how a first version of this
  // check tested nothing.
  const offlineStub = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.fetch;
      window.fetch = (input, init) => {
        const url = String(typeof input === 'string' ? input : input?.url ?? '');
        if (!url.includes('/api/settings')) return real(input, init);
        return (init?.method ?? 'GET') === 'GET'
          ? Promise.resolve(new Response('{}', { status: 429 }))
          : Promise.reject(new TypeError('Failed to fetch'));
      };
    })();`,
  }, sessionId);
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(2500);

  const offlinePress = await ev(`(async()=>{
    const { toggleTheme } = await import('/shared/ui/theme.js');
    const before = localStorage.getItem('habiterall-theme');
    const r = await toggleTheme();
    return { before, result: r, legacy: localStorage.getItem('habiterall-theme') };
  })()`);
  // The record now holds the PRESS, not the value it replaced. That is the
  // whole of the offline fix: the durable note has to be the newest answer,
  // because it is what a reload reads. Holding `dark` here — the pre-setting
  // value — is precisely how reopening the app while still offline undid a
  // press the outbox was still carrying.
  ck('a press that only reached the outbox is what the device remembers',
    offlinePress.before === 'dark' && offlinePress.legacy === 'press:light',
    JSON.stringify(offlinePress));

  await send('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: offlineStub.identifier }, sessionId);

  /* ---------- an offline press survives a reload made while offline ---------- */
  //
  // The loss this whole model is arranged around. A press is durable the
  // instant it is made, because a reload reads the DEVICE's note and that note
  // has to hold the newest answer. It held the OLDEST — the value the press
  // replaced — so reopening the app while still offline painted the theme the
  // user had just changed away from, with the write sitting in the outbox
  // saying otherwise and the settings cache agreeing with the outbox.
  // A clean document first: removing an `addScriptToEvaluateOnNewDocument`
  // registration does not undo the stub already installed in the page that is
  // showing, and the setup below needs a working `fetch`.
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(1200);
  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
    localStorage.removeItem('habiterall-settings');
    localStorage.setItem('habiterall-theme', 'dark');
    return 1;
  })()`);
  const cutOff = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.fetch;
      window.fetch = (input, init) => {
        const url = String(typeof input === 'string' ? input : input?.url ?? '');
        return url.includes('/api/settings')
          ? Promise.reject(new TypeError('Failed to fetch'))
          : real(input, init);
      };
    })();`,
  }, sessionId);

  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(2500);
  const offBefore = await ev(`(async()=>{
    const { toggleTheme } = await import('/shared/ui/theme.js');
    const before = document.documentElement.dataset.theme;
    const r = await toggleTheme();
    return { before, result: r, painted: document.documentElement.dataset.theme,
             note: localStorage.getItem('habiterall-theme') };
  })()`);
  // Reload, still offline. Nothing has reached the server.
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(2500);
  const offAfter = await ev(`document.documentElement.dataset.theme`);
  ck('an offline press survives a reload made while still offline',
    offBefore.painted !== offBefore.before && offAfter === offBefore.painted,
    `pressed ${offBefore.before} -> ${offBefore.painted}, reloaded as ${offAfter} `
    + `(note ${offBefore.note})`);

  await send('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: cutOff.identifier }, sessionId);

  /* ---------- a press is never lost to a write that never answers ---------- */
  //
  // A settings write had no bound at all — it does not go through `ui/api.js`,
  // and a non-GET is never seen by the service worker either — so a PUT that
  // was accepted and never answered left the caller pending indefinitely.
  // Anything waiting on it waited with it, and the press reached neither the
  // server nor the outbox: closing the tab lost it outright. What must hold is
  // that the press is remembered BEFORE any of that, so the answer survives a
  // request that never comes back.
  // A clean document first: removing an `addScriptToEvaluateOnNewDocument`
  // registration does not undo the stub already installed in the page that is
  // showing, and the setup below needs a working `fetch`.
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(1200);
  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
    localStorage.removeItem('habiterall-settings');
    // No pre-setting note here, deliberately: with one, the reconcile has a
    // write of its own in flight and the press waits behind it, so the wait
    // below would be two bounds rather than one. The press is the only writer
    // in this block, which is what makes the timing mean something.
    localStorage.removeItem('habiterall-theme');
    return 1;
  })()`);
  const blackHole = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.fetch;
      window.fetch = (input, init) => {
        const url = String(typeof input === 'string' ? input : input?.url ?? '');
        if (url.includes('/api/settings') && (init?.method ?? 'GET') !== 'GET') {
          // Accepted and never answered — but the signal is HONOURED, because
          // a real fetch honours it and a stub that does not would pass with
          // no bound in the code at all. That is the shape of the fake
          // AbortController in connectivity.test.js, recorded in
          // shared/CLAUDE.md as a test that pinned nothing.
          return new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return real(input, init);
      };
    })();`,
  }, sessionId);
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(2500);
  const hung = await ev(`(async()=>{
    const { toggleTheme } = await import('/shared/ui/theme.js');
    const before = document.documentElement.dataset.theme;
    let settled = 0;
    const started = Date.now();
    toggleTheme().then(() => { settled = Date.now() - started; },
                       () => { settled = Date.now() - started; });
    await new Promise((r) => setTimeout(r, 600));
    const early = { painted: document.documentElement.dataset.theme,
                    note: localStorage.getItem('habiterall-theme'), settled };
    // ...and then long enough for the bound to bite. 13s against a 10s
    // ceiling, because the point of the check is that there IS one.
    await new Promise((r) => setTimeout(r, 13000));
    return { before, ...early, settledBy: settled };
  })()`);
  ck('a press whose write never answers is still on the device',
    hung.painted !== hung.before && String(hung.note ?? '').endsWith(hung.painted),
    JSON.stringify(hung));
  // The bound itself. A settings write does not go through `ui/api.js`, so it
  // had none — and anything awaiting one waited with it. Unpinned, this is a
  // one-word regression: drop the `signal` and everything else here still
  // passes.
  ck('and the write it is waiting on gives up rather than hanging forever',
    hung.settledBy > 0 && hung.settledBy < 13000, JSON.stringify(hung));

  await send('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: blackHole.identifier }, sessionId);

  /* ---------- the settings DIALOG's write retires the note too ---------- */
  //
  // The dialog writes through `saveAll`, which never told this module
  // anything. So with a pre-setting note still on the device — an offline
  // boot, or a 429 from the IP-keyed read limiter — the user could pick Light,
  // press Done, have the server store it, and watch the page stay dark with no
  // control that would move it this session.
  // A clean document first: removing an `addScriptToEvaluateOnNewDocument`
  // registration does not undo the stub already installed in the page that is
  // showing, and the setup below needs a working `fetch`.
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(1200);
  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
    localStorage.removeItem('habiterall-settings');
    localStorage.setItem('habiterall-theme', 'dark');
    return 1;
  })()`);
  const noRead = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.fetch;
      window.fetch = (input, init) => {
        const url = String(typeof input === 'string' ? input : input?.url ?? '');
        return url.includes('/api/settings') && (init?.method ?? 'GET') === 'GET'
          ? Promise.resolve(new Response('{}', { status: 429 }))
          : real(input, init);
      };
    })();`,
  }, sessionId);
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(2500);
  const viaDialog = await ev(`(async()=>{
    const { saveAll } = await import('/shared/ui/settings.js');
    const before = document.documentElement.dataset.theme;
    const r = await saveAll({ theme: 'light' });
    await new Promise((x) => setTimeout(x, 400));
    return { before, r, painted: document.documentElement.dataset.theme,
             note: localStorage.getItem('habiterall-theme') };
  })()`);
  ck('the settings dialog can set the theme over a pre-setting note',
    viaDialog.before === 'dark' && viaDialog.painted === 'light',
    JSON.stringify(viaDialog));

  await send('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: noRead.identifier }, sessionId);

  /* ---------- a press the server never got is sent again ---------- */
  //
  // The self-healing half, and the reason a press is recorded as a press
  // rather than as a bare value. A write can be lost outright — the tab closed
  // before it went out, a 500, or a stale write from the same boot landing
  // after it — and the account then holds something this device disagrees
  // with. A bare note cannot tell that from "another device has set the theme
  // since", so it would have to guess; a press is known to be owed, and is
  // re-sent on the next reconcile. Without this a press that missed once is
  // stranded on one device forever, invisible everywhere else.
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(1200);
  await fetch(`${APP}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'dark' }),
  });
  await ev(`(async()=>{
    localStorage.removeItem('habiterall-settings');
    localStorage.setItem('habiterall-theme', 'press:light');
    return 1;
  })()`);
  await send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(2600);
  const healed = await (await fetch(`${APP}/api/settings`)).json().catch(() => ({}));
  const healedPaint = await ev(`document.documentElement.dataset.theme`);
  ck('a press the account never received is sent again',
    healed.theme === 'light' && healedPaint === 'light',
    `account=${JSON.stringify(healed)} painted=${healedPaint}`);

  /* ---------- an applier that throws must not break a save ---------- */
  const applierThrew = await ev(`(async()=>{
    const s = await import('/shared/ui/settings.js');
    s.onApply(() => { throw new Error('applier boom'); });
    const r = await s.save('dayOrder', 'newest-right').catch((e) => ({ threw: e.message }));
    return r;
  })()`);
  ck('a throwing applier does not reject the write it followed',
    applierThrew?.threw === undefined, JSON.stringify(applierThrew));

  console.log(fails === 0 ? '\nALL THEME CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
