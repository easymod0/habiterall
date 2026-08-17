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
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';
import { habitsByName, reset, useBase } from './fixtures.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = 9297;
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
  FakeNotification.requestPermission = function () {
    window.__asked++;
    FakeNotification.permission = window.__answer;
    return Promise.resolve(window.__answer);
  };
  window.Notification = FakeNotification;

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

  console.log(fails === 0 ? '\nALL NUDGE CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
