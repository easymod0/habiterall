/**
 * The theme as a DURABLE, SYNCED preference — which is what most of this is
 * about, and why it is not in `themecheck.mjs`.
 *
 * Almost nothing here concerns colour. The theme is simply the one setting that
 * has both a pre-setting home on the device (`localStorage[\'habiterall-theme\']`)
 * and a record of an unconfirmed PRESS, so it is the only place the whole
 * settings-durability model is reachable: the migration off that key, the
 * reconcile that decides between this device and the account, the precedence of
 * a dialog choice over a press, the outbox, and a write that never answers.
 * Rename the setting and every block below is unchanged.
 *
 * Each block names the regression it exists for. They are deliberately NOT
 * merged into shared setups: several look like near-duplicates and pin
 * different halves — the record\'s FORMAT against the behaviour a reload shows,
 * a write abandoned against a write refused. Every one of them has a version
 * that passes while the other fails.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome, waitUntil } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9320);
const profile = mkdtempSync(join(tmpdir(), 'habthemesync-'));
const chrome = launchChrome(PORT, profile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ck = (l, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' :: ' + e : ''}`); if (!c) fails++; };
let ws, nid = 1;
const pend = new Map();
// Every request the page makes, for the "a Done that touches nothing still
// migrates a legacy detailCards reply" block below — the only place in this
// file that needs to see the WRITE rather than merely stub an answer to it.
// `settingscheck.mjs` reads the same event for the same reason.
const netReqs = [];
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
    } else if (m.method === 'Network.requestWillBeSent') {
      netReqs.push(m.params.request);
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

  /** Load the app and wait for it, in place of a fixed sleep. */
  const boot = async (url = `${APP}/`, until = READY) => {
    await send('Page.navigate', { url }, sessionId);
    await waitUntil(ev, until, { what: `the app to boot at ${url}` });
  };
  /**
   * A loaded page and a KNOWN device preference, both of which this half used to
   * inherit from the rendering checks that ran above it in one file.
   *
   * The preference is pinned for the same reason it was pinned there: with a
   * fixed `['system','light','dark']` cycle, `system` resolving to dark or to
   * light decides what a press paints, and this machine's headless Chrome
   * prefers dark while CI's may not. Nothing below should depend on it — every
   * block seeds an explicit value — but inheriting it silently is how the
   * rendering half passed against the exact regression it was written for.
   */
  await send('Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
  await boot();

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
  await boot();

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
  await boot();

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
  await boot();

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
  // Ready in ~55ms, which is well inside the migration's 2s held PUT — the
  // window the press below has to land in for this to test anything. The fixed
  // 1200ms this replaces had 800ms of margin; the poll has nearly all of it.
  await boot();

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
  await boot();

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
  await boot();
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

  await boot();
  const offBefore = await ev(`(async()=>{
    const { toggleTheme } = await import('/shared/ui/theme.js');
    const before = document.documentElement.dataset.theme;
    const r = await toggleTheme();
    return { before, result: r, painted: document.documentElement.dataset.theme,
             note: localStorage.getItem('habiterall-theme') };
  })()`);
  // Reload, still offline. Nothing has reached the server.
  await boot();
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
  await boot();
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
  await boot();
  const hung = await ev(`(async()=>{
    const { toggleTheme } = await import('/shared/ui/theme.js');
    const before = document.documentElement.dataset.theme;
    let settled = 0;
    const started = Date.now();
    let answer = null;
    toggleTheme().then((r) => { settled = Date.now() - started; answer = r; },
                       () => { settled = Date.now() - started; });
    await new Promise((r) => setTimeout(r, 600));
    const early = { painted: document.documentElement.dataset.theme,
                    note: localStorage.getItem('habiterall-theme') };
    // ...and then long enough for the bound to bite. 13s against a 10s
    // ceiling, because the point of the check is that there IS one.
    //
    // EVERY reading an assertion wants is taken AFTER this sleep. Sampled at
    // 600ms and returned at 13s, the record reads as present because the code
    // had not yet reached the line that deleted it — which is how a check
    // written to pin exactly this passed against a build that threw the answer
    // away and reverted the theme ten seconds after the press.
    await new Promise((r) => setTimeout(r, 13000));
    return {
      before,
      early,
      painted: document.documentElement.dataset.theme,
      note: localStorage.getItem('habiterall-theme'),
      settledBy: settled,
      indeterminate: !!(answer && answer.indeterminate === true),
      ok: !!(answer && answer.ok === true),
    };
  })()`);
  ck('a press paints before the write is answered',
    hung.early.painted !== hung.before, JSON.stringify(hung.early));
  ck('a press whose write never answers is still on the device',
    String(hung.note ?? '').endsWith(hung.painted), JSON.stringify(hung));
  // The half the sampling hid. A write that ran out of time is of UNKNOWN
  // outcome — it may have landed — so there is no verdict to revert to, and
  // deleting the record is the one move that makes the answer unrecoverable:
  // the write may not have arrived AND the device no longer knows what was
  // pressed. Reverting the paint on top of that is the app undoing a
  // deliberate act by itself, ten seconds later, under a toast.
  ck('...and the theme it painted is still the one on screen',
    hung.painted !== hung.before, JSON.stringify(hung));
  ck('...and the caller is told it is a silence, not a refusal',
    hung.indeterminate === true && hung.ok === false, JSON.stringify(hung));
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
  await boot();
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
  await boot();
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
  await boot();
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
  await boot();
  const healed = await (await fetch(`${APP}/api/settings`)).json().catch(() => ({}));
  const healedPaint = await ev(`document.documentElement.dataset.theme`);
  ck('a press the account never received is sent again',
    healed.theme === 'light' && healedPaint === 'light',
    `account=${JSON.stringify(healed)} painted=${healedPaint}`);

  /* ---------- an unrelated write must not push this device's note ---------- */
  //
  // The case every other check here misses, because they all DELETE the
  // account's settings first. Here the account ALREADY holds a theme — set on
  // another device — while this one still carries a pre-setting note and its
  // own settings read has been refused.
  //
  // The personal edition answers a write with the accepted PATCH, so the reply
  // to a calendar-zoom write names no theme. Read as "the account has none",
  // that made this device push its stale note over the theme the user set on
  // their phone yesterday, on a write about something else entirely. Cloud
  // returns the whole blob and was unaffected, which is worse rather than
  // better: an edition deciding a correctness rule is the bug.
  await boot();
  await fetch(`${APP}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'light' }),
  });
  await ev(`(async()=>{
    localStorage.removeItem('habiterall-settings');
    localStorage.setItem('habiterall-theme', 'dark');
    return 1;
  })()`);
  const noGet = await send('Page.addScriptToEvaluateOnNewDocument', {
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
  await boot();
  await ev(`(async()=>{
    const { set } = await import('/shared/ui/settings.js');
    set('calendarZoom', 'wide');
    await new Promise((r) => setTimeout(r, 800));
    return 1;
  })()`);
  const kept = await (await fetch(`${APP}/api/settings`)).json().catch(() => ({}));
  ck('an unrelated write does not push a stale note over the account',
    kept.theme === 'light', `account=${JSON.stringify(kept)}`);

  await send('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: noGet.identifier }, sessionId);

  /* ---------- a write that ran out of time is not filed as offline ---------- */
  //
  // Bounding the request created a second way to lose a press. `save`'s catch
  // means "offline", which caches the value and QUEUES it — and an abandoned
  // write is of unknown outcome, so replaying it later means writing it over
  // whatever the user has done since. Measured: a press whose write was
  // black-holed, then a second press that succeeded, and the next boot painted
  // the FIRST value because the outbox replayed it. Both presses had answered
  // `{ok: true}`, so nothing was ever said.
  await boot();
  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
    localStorage.removeItem('habiterall-settings');
    localStorage.removeItem('habiterall-theme');
    return 1;
  })()`);
  const swallow = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.fetch;
      let once = false;
      window.fetch = (input, init) => {
        const url = String(typeof input === 'string' ? input : input?.url ?? '');
        if (url.includes('/api/settings') && (init?.method ?? 'GET') !== 'GET' && !once) {
          once = true;
          return new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return real(input, init);
      };
    })();`,
  }, sessionId);
  await boot();
  const timedOut = await ev(`(async()=>{
    const { toggleTheme } = await import('/shared/ui/theme.js');
    const first = await toggleTheme();
    const { pending } = await import('/shared/offline.js');
    return { first, queued: (await pending()).length };
  })()`);
  ck('a write that ran out of time is not queued for replay',
    timedOut.first?.ok === false && timedOut.queued === 0,
    JSON.stringify(timedOut));

  await send('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: swallow.identifier }, sessionId);

  /* ---------- a choice made HERE beats a press made here ---------- */
  //
  // The other half of "the dialog's write retires the note", and the half the
  // check above cannot reach: it seeds a BARE note, which is retired by the
  // account naming anything at all. A press is deliberately tougher — the
  // account disagreeing does not retire it, because the write may still be in
  // the outbox and the account is then the older answer of the two.
  //
  // Against a choice made on this same device afterwards, that toughness was
  // wrong. Press to dark offline, reconnect, open Settings, pick Light, press
  // Done: the reply reached `reconcile`, the press was still on the device, and
  // it was pushed straight back over the choice with nothing said. The rule is
  // `wrote`, not `stored`: cloud answers every write with the whole blob, so a
  // reply naming `theme` cannot say whether this write was about it.
  //
  // Be exact about what that closes, because an earlier version of this
  // comment said "then again when the outbox replayed the queued press" as
  // though the replay were covered too. It is not. `forget()` retires the
  // RECORD and does not reach into the outbox, so a press queued while offline
  // still replays: pick Light in the dialog before the flush runs and the
  // flush lands dark. The window is narrow — the boot `watchConnectivity` emit
  // flushes early — and it is not specific to the theme, since the outbox has
  // always been last-write-wins by submission order for every setting.
  //
  // The read is refused for the whole block, which is what keeps the press
  // UNCONFIRMED — the state the bug needs and the state the real report is in.
  // Without it the boot GET reconciles first: the account holds no theme, so
  // the record is pushed and then retired by its own reply, and the dialog
  // then writes over an account with nothing left to argue with. Every wrong
  // version of `reconcile` passes that, because there is no record by the time
  // the dialog runs. Offline is how it happens for real (the press is in the
  // outbox), and a 429 from the IP-keyed read limiter is how it happens on a
  // household behind one NAT.
  await boot();
  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
    localStorage.removeItem('habiterall-settings');
    localStorage.setItem('habiterall-theme', 'press:dark');
    return 1;
  })()`);
  const noReadPress = await send('Page.addScriptToEvaluateOnNewDocument', {
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
  await boot();
  const overPress = await ev(`(async()=>{
    const { saveAll } = await import('/shared/ui/settings.js');
    const before = document.documentElement.dataset.theme;
    await saveAll({ theme: 'light' });
    // Long enough that a push, if one were started, would have landed — so
    // "the account holds the choice" is a real answer rather than a race the
    // assertion happened to win.
    await new Promise((x) => setTimeout(x, 900));
    return { before, painted: document.documentElement.dataset.theme,
             note: localStorage.getItem('habiterall-theme') };
  })()`);
  const overPressAccount =
    await (await fetch(`${APP}/api/settings`)).json().catch(() => ({}));
  ck('a dialog choice wins over this device\'s own unconfirmed press',
    overPress.before === 'dark' && overPress.painted === 'light',
    JSON.stringify(overPress));
  ck('...and the account is left holding the choice, not the press',
    overPressAccount.theme === 'light', JSON.stringify(overPressAccount));

  // Not "the note is gone", which reads as the obvious companion assertion and
  // cannot fail: a version that pushes the press instead has that push's own
  // reply retire the record, so the key is null either way. What distinguishes
  // them is where the account ENDS UP, here and after a reload.
  await send('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: noReadPress.identifier }, sessionId);
  await boot();
  const overPressLater =
    await (await fetch(`${APP}/api/settings`)).json().catch(() => ({}));
  ck('...and a reload does not hand the press a second chance at it',
    overPressLater.theme === 'light', JSON.stringify(overPressLater));

  /* ---------- Restore defaults reaches the theme too ---------- */
  //
  // `reset()` was the one write path that passed no meta, so nothing
  // reconciled and the device record outlived it. With a record outstanding —
  // an un-migrated pre-setting key, or a press made offline — Restore defaults
  // reset every setting except the theme, and the next boot then PUSHED the
  // record back onto the account it had just been cleared from. The setting
  // the user had explicitly asked to forget was the one that came back.
  // The read is refused here too, and for the same reason: a boot GET that
  // succeeds retires the record before Restore defaults is ever pressed, so
  // every wrong version passes.
  await boot();
  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
    localStorage.removeItem('habiterall-settings');
    localStorage.setItem('habiterall-theme', 'press:dark');
    return 1;
  })()`);
  const noReadReset = await send('Page.addScriptToEvaluateOnNewDocument', {
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
  await boot();
  const afterReset = await ev(`(async()=>{
    const { reset } = await import('/shared/ui/settings.js');
    await reset();
    await new Promise((x) => setTimeout(x, 500));
    return { note: localStorage.getItem('habiterall-theme') };
  })()`);
  ck('Restore defaults forgets this device\'s theme record',
    afterReset.note === null, JSON.stringify(afterReset));

  // And it stays forgotten. The stub comes off first, because the next boot's
  // GET is exactly where the push would have happened: the account now names
  // no theme, and a surviving record reads that as "send mine".
  await send('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: noReadReset.identifier }, sessionId);
  await boot();
  const resetAccount =
    await (await fetch(`${APP}/api/settings`)).json().catch(() => ({}));
  ck('...and the next boot does not put it back on the account',
    resetAccount.theme === undefined, JSON.stringify(resetAccount));

  /* ---------- an applier that throws must not break a save ---------- */
  const applierThrew = await ev(`(async()=>{
    const s = await import('/shared/ui/settings.js');
    s.onApply(() => { throw new Error('applier boom'); });
    const r = await s.save('dayOrder', 'newest-right').catch((e) => ({ threw: e.message }));
    return r;
  })()`);
  ck('a throwing applier does not reject the write it followed',
    applierThrew?.threw === undefined, JSON.stringify(applierThrew));

  /* ---------- a Done that touches nothing still migrates detailCards ---------- */
  //
  // A second setting reached through the same durability model this whole
  // file is about — not the theme, but the same shape: a value with a
  // pre-current home (a legacy bare-string `detailCards`) and a migration that
  // only a deliberate act performs. #163 review round 1 added
  // `storedShapeIsStale` plus a second pass in `applyDraft` so that pressing
  // Done, even with nothing touched, rewrites a legacy value — because
  // `draft` and `settings.load()` are both already the NORMALISED cache and
  // never differ on their own. Nothing anywhere asserted the WIRING actually
  // runs: delete that second pass and every other test in this repo still
  // passes, while the README's migration instruction quietly becomes untrue
  // again.
  //
  // The gap the first pass at this hit and reported honestly: no HTTP write
  // path can leave a bare-string `detailCards` in the SERVER's real store,
  // because both editions run `parseSettings`/`parseCardList` on every write
  // — `putSetting`, and `POST /import` in replace mode, both normalise before
  // a byte is stored. But `storedShapeIsStale` reads `ApplyMeta.stored`, which
  // is the BODY of the `GET /api/settings` reply, not a database row — so
  // what has to be legacy is what the client is TOLD the account holds. A
  // real upgrading account looks exactly like a fabricated reply to the
  // browser, whatever wrote the row underneath it, which is why patching
  // `window.fetch` for this one route — the same shape this file already
  // uses for a rate-limited read or a refused write — is an honest way to
  // reach it and putting a legacy value on the server through `putSetting` is
  // not.
  await boot();
  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
    localStorage.removeItem('habiterall-settings');
    return 1;
  })()`);
  const legacyCardsGet = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.fetch;
      window.fetch = (input, init) => {
        const url = String(typeof input === 'string' ? input : input?.url ?? '');
        if (url.includes('/api/settings') && (init?.method ?? 'GET') === 'GET') {
          // Everything else is the real server's answer; only the ONE field
          // this block is about is overwritten, and in the LEGACY shape — a
          // bare array of the ids that are on, nothing said about the other
          // seven and nothing about order.
          return real(input, init).then(async (r) => {
            const body = await r.clone().json().catch(() => ({}));
            body.detailCards = ['calendar', 'history'];
            return new Response(JSON.stringify(body),
              { status: r.status, headers: { 'Content-Type': 'application/json' } });
          });
        }
        return real(input, init);
      };
    })();`,
  }, sessionId);
  await boot();

  // The canonical order, read from the running app rather than hard-coded
  // here — `options` is unchanged by #163 (only the default and the type
  // moved), so this is the same order `DETAIL_CARDS` declares.
  const canonicalCards = await ev(`(async()=>{
    const { SETTINGS } = await import('/shared/ui/settings.js');
    return SETTINGS.detailCards.options.map((o) => o.value);
  })()`);

  await ev(`document.getElementById('btn-settings').click()`);
  await waitUntil(ev, `document.getElementById('settings-dialog').open === true`,
    { what: 'the settings dialog to open, over the legacy detailCards reply' });
  const beforeDone = netReqs.length;
  // Done, with nothing touched — the exact press the README says migrates a
  // legacy value.
  await ev(`document.getElementById('settings-close').click()`);
  await waitUntil(ev, `document.getElementById('settings-dialog').open === false`,
    { what: 'the dialog to close after a Done that touched nothing' });

  const migratingPuts = netReqs.slice(beforeDone)
    .filter((r) => r.method === 'PUT' && r.url.endsWith('/api/settings'));
  const cardsBody = migratingPuts
    .map((r) => { try { return JSON.parse(r.postData ?? ''); } catch { return null; } })
    .find((b) => b && Object.hasOwn(b, 'detailCards'));
  ck('a Done that touches nothing still issues a PUT carrying detailCards',
    migratingPuts.length > 0 && !!cardsBody,
    JSON.stringify(migratingPuts.map((r) => r.postData)));

  // The legacy rule changed in this same fix round: a bare list is read for
  // MEMBERSHIP only, in canonical order — not "mentioned ids first" — so the
  // expected shape below is all nine cards, calendar and history on, in the
  // order `SETTINGS.detailCards.options` declares.
  const expectedCards = canonicalCards.map((id) =>
    ({ id, on: id === 'calendar' || id === 'history' }));
  ck('...and the write carries the NEW {id,on}[] shape, in canonical order',
    JSON.stringify(cardsBody?.detailCards) === JSON.stringify(expectedCards),
    `got ${JSON.stringify(cardsBody?.detailCards)}, expected ${JSON.stringify(expectedCards)}`);

  await send('Page.removeScriptToEvaluateOnNewDocument',
    { identifier: legacyCardsGet.identifier }, sessionId);

  console.log(fails === 0 ? '\nALL THEME SYNC CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
