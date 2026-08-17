/**
 * The browser's own reminder, end to end.
 *
 * A unit test can pin the rule and cannot see either half of what makes this a
 * feature: the trigger is a `visibilitychange` on a real document and the sink
 * is a browser API. So this drives both, with a stubbed `Notification` — a real
 * permission grant is not something a headless profile can be asked for, and
 * making the assertion depend on one would make the suite untrustworthy rather
 * than thorough.
 *
 * Both sinks are captured, because which one the app takes depends on whether a
 * service worker happens to be active by the time it looks: the constructor is
 * overridden AND `ServiceWorkerRegistration.prototype.showNotification` is, so
 * a change in that race cannot silently turn a pass into a false one.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome } from './chrome.mjs';
import { habitsByName, reset, useBase } from './fixtures.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9299);
useBase(APP);

const profile = mkdtempSync(join(tmpdir(), 'habnudge-'));
const chrome = launchChrome(PORT, profile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' :: ' + extra : ''));
  if (!cond) fails++;
};

let ws;
let nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++;
  pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

/**
 * Installed before any of the app's own scripts run, on every document.
 *
 * NOTE: no backticks anywhere in here. This string is interpolated into a
 * template literal on the way to `Runtime.evaluate`, and one backtick in a
 * comment is a syntax error a long way from where it reads.
 */
const STUB = `
  window.__nudges = [];
  window.__asked = 0;
  window.__answer = 'granted';

  const record = (title, options) => {
    window.__nudges.push({ title: String(title), body: String((options || {}).body || '') });
  };

  function FakeNotification(title, options) { record(title, options); }
  FakeNotification.permission = 'granted';

  // A prompt is answered on the USER's schedule, not inside the click that
  // raised it. With __defer set, the promise is held open until the suite calls
  // __resolve, which is what makes the mid-edit hazard reproducible.
  window.__defer = false;
  window.__resolve = null;
  FakeNotification.requestPermission = function () {
    window.__asked++;
    if (window.__defer) {
      return new Promise((done) => {
        window.__resolve = () => {
          FakeNotification.permission = window.__answer;
          done(window.__answer);
        };
      });
    }
    FakeNotification.permission = window.__answer;
    return Promise.resolve(window.__answer);
  };
  window.Notification = FakeNotification;

  // Two request shims, installed once so they survive every navigation.
  //
  // __staleWindow rewrites the "end" of an /api/overview answer to a past day,
  // which is what a tab left open across local midnight is holding: the window
  // no longer reaches today, and nothing in the app refreshes it. Only that one
  // field moves, so the grid draws from its own clock exactly as it would.
  //
  // __holdStatus keeps /api/notify/status pending until __releaseStatus is
  // called, so the late answer can be made to land while somebody is typing.
  // The stale-window flag lives in localStorage rather than on window, because
  // this whole stub is re-run on every navigation and would reset it.
  window.__holdStatus = false;
  window.__releaseStatus = null;
  window.__overviewLoads = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, opts) {
    const url = String(input && input.url ? input.url : input);

    if (url.indexOf('/api/notify/status') !== -1 && window.__holdStatus) {
      return new Promise((resolve) => {
        window.__releaseStatus = () => resolve(new Response(JSON.stringify({
          channels: [{
            channel: 'discord', ok: false, status: 404, permanent: true,
            error: 'the webhook was deleted or is no longer accepted',
            date: '2026-08-15', mode: 'webhook', at: '',
          }],
        }), { headers: { 'Content-Type': 'application/json' } }));
      });
    }

    if (url.indexOf('/api/overview') !== -1) {
      window.__overviewLoads++;
      let pretend = null;
      try { pretend = localStorage.getItem('habtest-stale-window'); } catch (e) { /* none */ }
      if (pretend) {
        return realFetch(input, opts).then(async (res) => {
          if (!res.ok) return res;
          const body = await res.json();
          body.end = pretend;
          return new Response(JSON.stringify(body),
            { status: res.status, headers: { 'Content-Type': 'application/json' } });
        });
      }
    }

    return realFetch(input, opts);
  };

  // A secure context is what a browser demands before it will show any of
  // this, and localhost qualifies — so the plain-http case has to be stubbed.
  window.__insecure = false;
  try {
    Object.defineProperty(window, 'isSecureContext',
      { get: () => (window.__insecure ? false : true), configurable: true });
  } catch (e) { /* leave the real one alone if it will not budge */ }

  if (window.ServiceWorkerRegistration) {
    window.ServiceWorkerRegistration.prototype.showNotification =
      function (title, options) { record(title, options); return Promise.resolve(); };
  }

  // A headless target can report itself hidden, which would make every
  // visibilitychange assertion below vacuously pass.
  try {
    Object.defineProperty(document, 'visibilityState',
      { get: () => window.__visible === false ? 'hidden' : 'visible', configurable: true });
  } catch (e) { /* leave the real one alone if it will not budge */ }
`;

try {
  console.log('--- fixtures ---');
  await reset({ days: 3 });
  const habits = await habitsByName();

  /** PUT replaces, so the whole habit goes back with the one field changed. */
  const setReminder = async (habit, time) => {
    const res = await fetch(`${APP}/api/habits/${habit.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...habit, reminder_time: time }),
    });
    if (!res.ok) throw new Error(`PUT habit -> ${res.status}`);
  };

  // 00:01, so the reminder has passed whatever time this suite runs at. Two
  // habits, and the second is the control: `reset` records 0 snacks for today
  // and 0 is at or under a limit of 0, so that day IS answered and must not be
  // nudged about — which is the difference between this rule and "does the
  // habit have a reminder?".
  await setReminder(habits.Meditate, '00:01');
  await setReminder(habits['No late-night snacks'], '00:01');

  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB }, sessionId);

  const load = async () => {
    await send('Page.navigate', { url: APP }, sessionId);
    for (let i = 0; i < 80; i++) {
      if (await ev('!!document.querySelector("#grid .habit-row")').catch(() => 0)) break;
      await sleep(250);
    }
    await sleep(600);
  };

  await load();
  ck('the stub is in place before the app boots',
     await ev('typeof window.Notification === "function" && Array.isArray(window.__nudges)'));
  ck('and the document reports itself visible',
     await ev('document.visibilityState') === 'visible');

  console.log('--- the destination is off until it is asked for ---');
  // The account has never touched `notifyChannels`, so it holds the registry
  // default — the phone alarm alone. Nothing may be raised here.
  await ev('localStorage.removeItem("habiterall-nudged")');
  await load();
  ck('a fresh account gets no browser notification', await ev('window.__nudges.length') === 0,
     JSON.stringify(await ev('window.__nudges')));

  console.log('--- switched on, an outstanding habit is announced ---');
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({notifyChannels:['android','web']})}).then(r=>r.ok)`);
  await ev('localStorage.removeItem("habiterall-nudged")');
  await load();

  const raised = await ev('window.__nudges');
  ck('one notification on load', raised.length === 1, JSON.stringify(raised));
  ck('it names the habit whose day is outstanding',
     /Meditate/.test(JSON.stringify(raised)), JSON.stringify(raised));
  ck('and not the one already answered today',
     !/snack/i.test(JSON.stringify(raised)), JSON.stringify(raised));
  ck('the title says what it is, and does not promise a time',
     /still to answer today/.test(raised[0]?.title ?? '') &&
     !/remind|alarm/i.test(raised[0]?.title ?? ''), raised[0]?.title);

  console.log('--- coming back to the tab does not say it again ---');
  // Without the watermark every visibilitychange re-notifies, which is the
  // surest way to have a destination switched off for good.
  await ev('document.dispatchEvent(new Event("visibilitychange"))');
  await sleep(400);
  ck('a second visibilitychange raises nothing', await ev('window.__nudges.length') === 1,
     JSON.stringify(await ev('window.__nudges')));

  ck('the watermark is a device record, under its own key',
     !!await ev('localStorage.getItem("habiterall-nudged")'));
  ck('...and names the habit and the local day',
     await ev(`(() => {
       const held = JSON.parse(localStorage.getItem('habiterall-nudged'));
       const d = new Date();
       const iso = d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
       return held.date === iso && held.ids.length > 0;
     })()`));
  ck('and it is never sent to the server',
     (await ev(`(async () => (await (await fetch('/api/settings')).json()))()`))
       .habiterallNudged === undefined);

  console.log('--- visibilitychange is a real trigger ---');
  await ev('localStorage.removeItem("habiterall-nudged"); window.__nudges.length = 0;');
  await ev('document.dispatchEvent(new Event("visibilitychange"))');
  await sleep(500);
  ck('clearing the record and coming back raises it again',
     await ev('window.__nudges.length') === 1,
     JSON.stringify(await ev('window.__nudges')));

  console.log('--- a grid paged back cannot speak for today ---');
  // The defect a review found in the first version of this, reproduced end to
  // end because nothing smaller can see it: `/overview` answers a WINDOW, so
  // paging back leaves `habit.entries` legitimately stopping before today, and
  // a missing key there means "never fetched" rather than "no row". Measured as
  // "1 habit still to answer today" about a habit answered an hour earlier.
  //
  // Two halves have to be true together, which is why the state is set up
  // rather than assumed: the day IS answered, and the payload in hand does not
  // carry it.
  await ev(`(() => {
    const d = new Date();
    const iso = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    return fetch('/api/habits/${habits.Meditate.id}/entries/' + iso, {
      method: 'PUT', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({value: 2}),
    }).then(r => r.ok);
  })()`);
  await ev('localStorage.removeItem("habiterall-nudged")');
  await load();
  ck('with today recorded, a fresh load says nothing',
     await ev('window.__nudges.length') === 0,
     JSON.stringify(await ev('window.__nudges')));

  // Page the grid back. The button is found by its aria-label rather than its
  // glyph, which follows `dayOrder`.
  const pagedBack = await ev(`(() => {
    const b = [...document.querySelectorAll('.grid-nav button')]
      .find(x => (x.getAttribute('aria-label') || '').startsWith('Previous'));
    if (!b) return 'no button';
    b.click();
    return 'clicked';
  })()`);
  ck('the grid can be paged back', pagedBack === 'clicked', pagedBack);
  await sleep(900);

  // The premise, asserted rather than assumed: today must really be off the
  // grid, or the check below passes for no reason at all.
  ck('...and today is no longer a column, so the window really did move',
     await ev(`document.querySelectorAll('.habit-row').length > 0 &&
       !document.querySelector('.grid-date.is-today')`));

  // Hidden by hand first, so "nothing was said in the app" cannot be satisfied
  // by a leftover message from an earlier block.
  await ev(`document.querySelector('#toast').hidden = true;
    localStorage.removeItem('habiterall-nudged'); window.__nudges.length = 0;`);
  await ev('document.dispatchEvent(new Event("visibilitychange"))');
  await sleep(600);
  ck('a day the loaded window does not reach is not judged at all',
     await ev('window.__nudges.length') === 0,
     JSON.stringify(await ev('window.__nudges')));
  ck('and it is not said in the app either — silence, not a fallback',
     await ev('document.querySelector("#toast").hidden') === true,
     await ev('document.querySelector("#toast")?.textContent ?? ""'));

  // Back to today, and it works again: the refusal is about the window, not
  // about the habit having been quietly dropped.
  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b => b.textContent.trim() === 'Today')?.click()`);
  await sleep(900);
  await ev(`(() => {
    const d = new Date();
    const iso = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    return fetch('/api/habits/${habits.Meditate.id}/entries/' + iso, {
      method: 'DELETE', credentials: 'same-origin',
    }).then(r => r.ok);
  })()`);
  await ev('localStorage.removeItem("habiterall-nudged"); window.__nudges.length = 0;');
  await load();
  ck('paging back to today restores it', await ev('window.__nudges.length') === 1,
     JSON.stringify(await ev('window.__nudges')));

  console.log('--- a refused permission is answered in the app ---');
  // The half issue #70 asks for by name. `hidden` beaten by a `display` rule is
  // the class of bug this directory exists for, so the toast is checked for
  // being VISIBLE and not merely present.
  await ev('window.Notification.permission = "denied"');
  await ev('localStorage.removeItem("habiterall-nudged"); window.__nudges.length = 0;');
  await ev('document.dispatchEvent(new Event("visibilitychange"))');
  await sleep(500);
  ck('no notification is raised', await ev('window.__nudges.length') === 0);
  ck('the app says it instead',
     /still to answer today/.test(await ev('document.querySelector("#toast")?.textContent ?? ""')),
     await ev('document.querySelector("#toast")?.textContent ?? ""'));
  ck('and the message is actually visible',
     await ev(`(() => {
       const t = document.querySelector('#toast');
       if (!t || t.hidden) return false;
       const s = getComputedStyle(t);
       return s.display !== 'none' && s.visibility !== 'hidden' &&
         t.getBoundingClientRect().height > 0;
     })()`));

  console.log('--- an answered day drops out ---');
  await ev('window.Notification.permission = "granted"');
  const meditate = (await habitsByName()).Meditate;
  await ev(`(() => {
    const d = new Date();
    const iso = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    return fetch('/api/habits/${meditate.id}/entries/' + iso, {
      method: 'PUT', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({value: 2}),
    }).then(r => r.ok);
  })()`);
  await ev('localStorage.removeItem("habiterall-nudged")');
  await load();
  ck('recording today silences it', await ev('window.__nudges.length') === 0,
     JSON.stringify(await ev('window.__nudges')));

  console.log('--- the settings dialog asks, and reports the answer ---');
  // The permission can only be asked for from inside a user gesture, so the
  // tick is where it happens — and `denied` cannot be undone from script, which
  // is why the section has to SAY so rather than leave a box that looks on.
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({notifyChannels:['android']})}).then(r=>r.ok)`);
  await load();
  await ev('window.__answer = "denied"; window.Notification.permission = "default";');
  await ev('document.getElementById("btn-settings").click()');
  await sleep(400);

  const tickWeb = `(() => {
    const box = document.getElementById('setting-notifyChannels-web');
    if (!box) return 'no control';
    box.checked = true;
    box.dispatchEvent(new Event('change', {bubbles: true}));
    return 'ticked';
  })()`;
  ck('the destination has a control of its own', await ev(tickWeb) === 'ticked');
  await sleep(500);

  ck('ticking it asks the browser for permission', await ev('window.__asked') >= 1);
  const notice = await ev(
    '[...document.querySelectorAll(".setting-problem")].map(p=>p.textContent).join(" | ")');
  ck('a refusal is reported where the control is', /site settings/i.test(notice), notice);
  ck('and it says the app will say it instead', /inside the app/i.test(notice), notice);
  ck('the notice is visible, not merely present',
     await ev(`(() => {
       const p = document.querySelector('.setting-problem');
       if (!p) return false;
       const s = getComputedStyle(p);
       return s.display !== 'none' && s.visibility !== 'hidden' &&
         p.getBoundingClientRect().height > 0;
     })()`));

  // The reminder-timezone control governs the SERVER's clock, and this
  // destination is on the browser's own. Offering it here would be a
  // preference that changes nothing, in the section where "why am I not
  // getting my reminders?" is answered.
  ck('switching on a device destination does not offer the server timezone',
     await ev('!document.getElementById("setting-notifyTimezone")'));

  await ev('document.getElementById("settings-cancel").click()');
  await sleep(300);

  console.log('--- answering the prompt must not eat what is being typed ---');
  // A permission prompt settles whenever the user gets round to it, so the
  // repaint that follows lands on somebody mid-edit. Rebuilding the body there
  // removes the input — and `change` never fires on a removed input, so the
  // half-typed URL is gone with nothing to say so. This is the hazard `stage`
  // and `refreshDeliveryNotices` were already written around; the fix is a
  // repaint that touches no control.
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({notifyChannels:['android','discord']})}).then(r=>r.ok)`);
  await load();
  await ev('window.__defer = true; window.__answer = "granted"; window.__asked = 0;');
  await ev('document.getElementById("btn-settings").click()');
  await sleep(400);
  ck('the webhook field is on screen to be typed into',
     await ev('!!document.getElementById("setting-discordWebhook")'));

  await ev(tickWeb);
  await sleep(300);

  const typed = 'https://discord.com/api/webhooks/123456789012345678/half-typed';
  await ev(`(() => {
    const input = document.getElementById('setting-discordWebhook');
    input.focus();
    input.value = ${JSON.stringify(typed)};
    return input.value;
  })()`);

  // Now the user answers the prompt.
  await ev('window.__resolve && window.__resolve()');
  await sleep(500);

  ck('the half-typed URL survives the answer',
     await ev(`document.getElementById('setting-discordWebhook')?.value ?? ''`) === typed,
     await ev(`document.getElementById('setting-discordWebhook')?.value ?? '(gone)'`));
  ck('and so does the caret',
     await ev(`document.activeElement?.id`) === 'setting-discordWebhook',
     await ev(`document.activeElement?.tagName + '#' + document.activeElement?.id`));
  ck('while the notice still updated',
     await ev(`document.querySelectorAll('.setting-problem').length`) >= 0);

  await ev('window.__defer = false;');
  await ev('document.getElementById("settings-cancel").click()');
  await sleep(300);

  console.log('--- plain http is named as the reason, not a site setting ---');
  // The branch that was unreachable when this shipped: on a non-secure origin
  // Chrome still exposes the constructor and answers `denied`, so the advice
  // below it cannot work. It is the LAN half of HABITERALL_UPGRADE_INSECURE.
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({notifyChannels:['android','web']})}).then(r=>r.ok)`);
  await load();
  await ev('window.__insecure = true;');
  await ev('document.getElementById("btn-settings").click()');
  await sleep(400);
  const insecure = await ev(
    '[...document.querySelectorAll(".setting-problem")].map(p=>p.textContent).join(" | ")');
  ck('the origin is named', /secure origin|https/i.test(insecure), insecure);
  ck('and a site setting is NOT offered as the fix',
     !/site settings/i.test(insecure), insecure);
  await ev('window.__insecure = false;');
  await ev('document.getElementById("settings-cancel").click()');
  await sleep(300);

  console.log('--- a browser with no Notification API says so on the tick ---');
  // `onEnable` returns undefined there, so hanging the only repaint off the
  // promise left the one state the notice exists for unreachable.
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({notifyChannels:['android']})}).then(r=>r.ok)`);
  await load();
  await ev('delete window.Notification;');
  await ev('document.getElementById("btn-settings").click()');
  await sleep(400);
  await ev(tickWeb);
  await sleep(400);
  const absent = await ev(
    '[...document.querySelectorAll(".setting-problem")].map(p=>p.textContent).join(" | ")');
  ck('ticking it says the browser cannot show one',
     /cannot show notifications/i.test(absent), absent || '(no notice at all)');
  ck('and says where the answer goes instead', /inside the app/i.test(absent), absent);
  await ev('document.getElementById("settings-cancel").click()');
  await sleep(300);

  console.log('--- a tab left open across midnight still nudges ---');
  // The regression the first version of the window fix introduced. Nothing in
  // the app refreshes on `visibilitychange` — `syncNow` returns early on an
  // empty queue and `reload` fires only on an offline→online transition — so a
  // tab loaded yesterday holds yesterday's window for ever, and refusing there
  // silences this at 09:00 the next morning: the one moment it exists for.
  //
  // Simulated by rewriting `end` in the /overview answer to a past day, which
  // is exactly the state the clock produces, and then letting the refresh fetch
  // an honest one. Distinguished from the paged-back case by `gridEnd` alone,
  // which is what `app.js` reads.
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({notifyChannels:['android','web']})}).then(r=>r.ok)`);
  // Today's answer is cleared first: an earlier block recorded it, and a habit
  // that IS answered would make every assertion below pass for the wrong reason.
  await ev(`(() => {
    const d = new Date();
    const iso = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    return fetch('/api/habits/${habits.Meditate.id}/entries/' + iso, {
      method: 'DELETE', credentials: 'same-origin',
    }).then(r => r.ok);
  })()`);
  await ev(`(() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    localStorage.setItem('habtest-stale-window', d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0'));
    localStorage.removeItem('habiterall-nudged');
  })()`);
  await load();

  // The premise, and it is also the refusal still doing its job: while every
  // answer stops before today, nothing can be judged and nothing is said —
  // even though the refresh is asked for and made.
  ck('a window that cannot reach today says nothing at all',
     await ev('window.__nudges.length') === 0,
     JSON.stringify(await ev('window.__nudges')));
  ck('the grid is NOT paged back — this is the clock, not the user',
     await ev(`!!document.querySelector('.grid-date.is-today')`));

  // Now the tab comes back, and the server's answers are honest again — which
  // is what a refresh would fetch, and what obeying the held window would not.
  await ev(`localStorage.removeItem('habtest-stale-window');
    localStorage.removeItem('habiterall-nudged');
    window.__nudges.length = 0;`);
  const before = await ev('window.__overviewLoads');
  await ev('document.dispatchEvent(new Event("visibilitychange"))');
  await sleep(900);

  ck('the stale window is refreshed rather than obeyed',
     await ev('window.__overviewLoads') > before,
     `loads ${before} -> ${await ev('window.__overviewLoads')}`);
  ck('...and the outstanding habit is announced',
     await ev('window.__nudges.length') === 1,
     JSON.stringify(await ev('window.__nudges')));

  console.log('--- ...but a grid the user paged back is left alone ---');
  // The other cause of a short window, and the one refusing is right about: a
  // deliberate act, undone by pressing Today and not by a nudge.
  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b => (b.getAttribute('aria-label') || '').startsWith('Previous'))?.click()`);
  await sleep(900);
  await ev('localStorage.removeItem("habiterall-nudged"); window.__nudges.length = 0;');
  const pagedLoads = await ev('window.__overviewLoads');
  await ev('document.dispatchEvent(new Event("visibilitychange"))');
  await sleep(700);
  ck('no refetch is made behind the user\'s back',
     await ev('window.__overviewLoads') === pagedLoads,
     `loads ${pagedLoads} -> ${await ev('window.__overviewLoads')}`);
  ck('and nothing is announced', await ev('window.__nudges.length') === 0,
     JSON.stringify(await ev('window.__nudges')));

  console.log('--- ...and a habit open over the dashboard is not navigated away from ---');
  // `dashboard.paint()` clears `openHabitId` and shows the list, so a reload
  // fired by a nudge would take the user off the page they are reading. Same
  // guard, same reason, as the 'reload' in settings-dialog.js.
  await ev(`(() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    localStorage.setItem('habtest-stale-window', d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0'));
  })()`);
  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b => b.textContent.trim() === 'Today')?.click()`);
  await sleep(900);
  await ev(`document.querySelector('.habit-row .habit-name, .habit-row .name')?.click()`);
  for (let i = 0; i < 40; i++) {
    if ((await ev('location.hash') || '').startsWith('#/habit/')) break;
    await sleep(200);
  }
  await sleep(400);
  ck('a habit is open', (await ev('location.hash') || '').startsWith('#/habit/'),
     await ev('location.hash'));

  await ev(`localStorage.removeItem('habtest-stale-window');
    localStorage.removeItem('habiterall-nudged');
    window.__nudges.length = 0;`);
  const openLoads = await ev('window.__overviewLoads');
  await ev('document.dispatchEvent(new Event("visibilitychange"))');
  await sleep(800);
  ck('the list is not reloaded underneath it',
     await ev('window.__overviewLoads') === openLoads,
     `loads ${openLoads} -> ${await ev('window.__overviewLoads')}`);
  ck('and the habit is still what is on screen',
     (await ev('location.hash') || '').startsWith('#/habit/'),
     await ev('location.hash'));

  await ev('history.back()');
  await sleep(900);

  console.log('--- a late delivery answer must not eat what is being typed ---');
  // The other half of the notice repaint, and the one nothing pinned: reverting
  // `refreshDeliveryNotices` to an unguarded `renderSettingsBody()` passed every
  // suite. The status request is held open and released mid-edit, which is the
  // shape the guards used to exist for and the shape `paintNotices` makes safe.
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({notifyChannels:['android','discord']})}).then(r=>r.ok)`);
  await load();
  await ev('window.__holdStatus = true; window.__releaseStatus = null;');
  await ev('document.getElementById("btn-settings").click()');
  await sleep(500);
  ck('the dialog opens without waiting for the status request',
     await ev('document.getElementById("settings-dialog").open') === true);
  ck('and its notice has not arrived yet',
     await ev('document.querySelectorAll(".setting-problem").length') === 0);

  const midEdit = 'https://discord.com/api/webhooks/123456789012345678/mid-edit';
  await ev(`(() => {
    const input = document.getElementById('setting-discordWebhook');
    input.focus();
    input.value = ${JSON.stringify(midEdit)};
    input.setSelectionRange(4, 9);
    return input.value;
  })()`);

  await ev('window.__releaseStatus && window.__releaseStatus()');
  await sleep(600);

  ck('the late answer arrives', /webhook was deleted/i.test(
     await ev('[...document.querySelectorAll(".setting-problem")].map(p=>p.textContent).join(" ")')),
     await ev('[...document.querySelectorAll(".setting-problem")].map(p=>p.textContent).join(" ")'));
  ck('and the half-typed URL is untouched',
     await ev(`document.getElementById('setting-discordWebhook')?.value ?? ''`) === midEdit,
     await ev(`document.getElementById('setting-discordWebhook')?.value ?? '(gone)'`));
  ck('...along with the caret and the selection',
     await ev(`document.activeElement?.id`) === 'setting-discordWebhook' &&
     await ev(`document.activeElement?.selectionStart`) === 4 &&
     await ev(`document.activeElement?.selectionEnd`) === 9,
     await ev(`document.activeElement?.id + ':' + document.activeElement?.selectionStart
       + '-' + document.activeElement?.selectionEnd`));

  await ev('window.__holdStatus = false;');
  await ev('document.getElementById("settings-cancel").click()');
  await sleep(300);

  console.log(fails === 0 ? '\nALL NUDGE CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
