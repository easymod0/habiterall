/**
 * The sign-in view, in a real browser.
 *
 * It lives here rather than in shared/test/browser/ because it needs a server
 * configured a particular way — auth ON, and for the first half with no account
 * yet — while every suite in the shared runner points at one already-running
 * instance. This one starts and stops its own.
 *
 * What only a browser can catch here: whether the form and the link actually
 * swap (a `display` rule beating the `hidden` attribute is a bug this codebase
 * has already paid for once), and whether the whole flow works under the CSP
 * that the personal edition only just gained.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closeChrome, devtoolsUrl, launchChrome } from '@habiterall/shared/test/chrome.mjs';

const PORT = 3399, CDP = 9294;
const workdir = mkdtempSync(join(tmpdir(), 'habsignin-'));
const profile = mkdtempSync(join(tmpdir(), 'habsignin-chrome-'));
const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ck = (l, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ` :: ${e}` : ''}`); if (!c) fails++; };

const server = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HABITERALL_DB: join(workdir, 'signin.db'),
    HABITERALL_NOTIFY: 'off',
    LOG_LEVEL: 'error',
    // No credentials: the instance starts unclaimed, in `setup` mode.
    HABITERALL_AUTH: '',
  },
  stdio: 'ignore',
});

for (let i = 0; i < 60; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok).catch(() => false)) break;
  await sleep(250);
}

const chrome = launchChrome(CDP, profile);
let ws, nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

try {
  ws = new globalThis.WebSocket(await devtoolsUrl(CDP, chrome));
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
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  /**
   * Is this selector actually PAINTED?
   *
   * Prefixed onto every evaluation rather than installed once, because
   * `Page.navigate` and the reload after a successful sign-in both discard the
   * JS context — install it once and it is gone by the second assertion.
   * Assigned to `window` rather than declared, so re-running it in the same
   * context is not a redeclaration.
   */
  const SHOWN = `window.__shown = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    // COMPUTED STYLE ONLY. Consulting el.hidden first — which the first version
    // of this helper did — makes the whole thing equivalent to the assertion it
    // replaced: the attribute is exactly what a stray \`display\` rule beats
    // while leaving set. offsetParent covers an ancestor hiding it.
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return el.offsetParent !== null || cs.position === 'fixed';
  };`;

  const ev = async (e) => {
    // The helper first, the caller's expression last: Runtime.evaluate returns
    // the completion value of the script, which is still the caller's.
    const r = await send('Runtime.evaluate',
      { expression: `${SHOWN}\n${e}`, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };

  const go = async () => {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sessionId);
    await sleep(1200);
  };

  /* ---------- setup mode ---------- */

  await go();
  const setup = JSON.parse(await ev(`JSON.stringify({
    signinShown: __shown('#view-signin'),
    title: document.getElementById('signin-title').textContent.trim(),
    formShown: __shown('#signin-form'),
    linkShown: __shown('#signin-oidc'),
    confirmShown: __shown('#signin-confirm-row'),
    submit: document.getElementById('signin-submit').textContent.trim(),
    listShown: __shown('#view-list'),
    newBtn: __shown('#btn-new')
  })`));

  ck('setup: the sign-in view is showing', setup.signinShown);
  ck('setup: it says so', /create/i.test(setup.title), setup.title);
  ck('setup: the form is visible', setup.formShown);
  // The documented trap: a `display` rule silently beats [hidden].
  ck('setup: the OIDC link is really hidden', !setup.linkShown);
  ck('setup: a new account confirms its password', setup.confirmShown);
  ck('setup: the button says what it does', /create/i.test(setup.submit), setup.submit);
  ck('setup: the habit list is hidden', !setup.listShown);
  ck('setup: signed-out chrome is hidden', !setup.newBtn);

  const mismatch = await ev(`(async () => {
    document.getElementById('signin-user').value = 'mark';
    document.getElementById('signin-pass').value = 'a-good-long-password';
    document.getElementById('signin-confirm').value = 'something-else';
    document.getElementById('signin-form').requestSubmit();
    await new Promise(r => setTimeout(r, 400));
    const e = document.getElementById('signin-error');
    return JSON.stringify({ shown: __shown('#signin-error'), text: e.textContent.trim() });
  })()`);
  const mm = JSON.parse(mismatch);
  ck('setup: mismatched passwords are caught in the page', mm.shown && /match/i.test(mm.text), mm.text);

  // Submitting succeeds and the adapter reloads the page, so the wait has to
  // happen in Node: an await inside the page dies with the navigation.
  await ev(`document.getElementById('signin-confirm').value = 'a-good-long-password';
            document.getElementById('signin-form').requestSubmit(); 1`);
  await sleep(3000);

  const after = JSON.parse(await ev(`JSON.stringify({
    signinShown: __shown('#view-signin'),
    listShown: __shown('#view-list'),
    newBtn: __shown('#btn-new')
  })`));
  ck('setup: creating the account signs in', !after.signinShown && after.listShown,
    JSON.stringify(after));
  ck('setup: the signed-in chrome comes back', after.newBtn);

  /* ---------- password mode, after signing out ---------- */

  await ev(`fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(() => 1)`);
  await sleep(500);
  await go();

  const pw = JSON.parse(await ev(`JSON.stringify({
    title: document.getElementById('signin-title').textContent.trim(),
    formShown: __shown('#signin-form'),
    confirmShown: __shown('#signin-confirm-row'),
    submit: document.getElementById('signin-submit').textContent.trim()
  })`));
  ck('password: the form is shown, not the setup copy', pw.formShown && /sign in/i.test(pw.title), pw.title);
  // Confirming a password you already have is a field that can only be wrong.
  ck('password: the confirm field is gone', !pw.confirmShown);
  ck('password: the button says Sign in', /sign in/i.test(pw.submit), pw.submit);

  const wrong = await ev(`(async () => {
    document.getElementById('signin-user').value = 'mark';
    document.getElementById('signin-pass').value = 'wrong-password';
    document.getElementById('signin-form').requestSubmit();
    await new Promise(r => setTimeout(r, 800));
    const e = document.getElementById('signin-error');
    return JSON.stringify({ shown: __shown('#signin-error'), text: e.textContent.trim() });
  })()`);
  const w = JSON.parse(wrong);
  ck('password: a wrong password is reported in the form', w.shown && w.text.length > 0, w.text);

  await ev(`document.getElementById('signin-pass').value = 'a-good-long-password';
            document.getElementById('signin-form').requestSubmit(); 1`);
  await sleep(3000);

  const signedIn = JSON.parse(await ev(`JSON.stringify({
    signinShown: __shown('#view-signin'),
    listShown: __shown('#view-list'),
    user: document.getElementById('user-name')?.textContent.trim()
  })`));
  ck('password: the right password signs in', !signedIn.signinShown && signedIn.listShown,
    JSON.stringify(signedIn));
  ck('password: the chip shows who is signed in', signedIn.user === 'mark', signedIn.user);

  /* ---------- a 200 that is not a session ---------- */
  //
  // The whole app boots on `/api/me`, and `load()` degraded a body it could not
  // parse to `{}` — which is truthy, so a reverse proxy with an SPA fallback
  // (`try_files $uri /index.html`) or a captive portal answering 200 with HTML
  // produced a signed-IN shell: the chip, New habit, Settings, and — because
  // an absent `mode` falls back to `oidc` — a Sign out control on an instance
  // that may have no sign-in at all. `Auth.read` on the phone has had this
  // guard since it shipped the same bug; the web never got it.
  //
  // Only a browser can show this: the app's boot is what turns the answer into
  // a painted shell, and `[hidden]` versus a computed style is exactly what
  // `__shown` exists for.
  // The service worker first, or there is nothing to intercept: `/api/me` goes
  // through `networkFirst`, and a fetch the WORKER makes is not paused by the
  // page's Fetch domain. Without this the app simply gets the real 200 and the
  // suite passes against the unfixed code, which is the trap this whole file
  // exists to avoid.
  await ev(`(async()=>{
    const rs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(rs.map(r => r.unregister()));
    for (const k of await caches.keys()) await caches.delete(k);
    return rs.length;
  })()`);

  await send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/me', requestStage: 'Request' }],
  }, sessionId);
  const onPaused = (m) => {
    if (m.method !== 'Fetch.requestPaused' || m.sessionId !== sessionId) return;
    send('Fetch.fulfillRequest', {
      requestId: m.params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      body: Buffer.from('<!doctype html><title>Wi-Fi login</title>').toString('base64'),
    }, sessionId).catch(() => {});
  };
  const priorOnMessage = ws.onmessage;
  ws.onmessage = (ev) => { onPaused(JSON.parse(ev.data)); priorOnMessage(ev); };

  await go();
  await sleep(1500);

  const portal = JSON.parse(await ev(`JSON.stringify({
    errorShown: __shown('#view-error'),
    listShown: __shown('#view-list'),
    signinShown: __shown('#view-signin'),
    newBtn: __shown('#btn-new'),
    settingsBtn: __shown('#btn-settings')
  })`));
  ck('a 200 that is not a session does not paint a signed-in app',
    !portal.listShown && !portal.newBtn && !portal.settingsBtn, JSON.stringify(portal));
  ck('it reaches the boot-error view instead', portal.errorShown, JSON.stringify(portal));

  ws.onmessage = priorOnMessage;
  await send('Fetch.disable', {}, sessionId);

  console.log(fails ? `\n${fails} check(s) failed` : '\nALL SIGN-IN CHECKS PASSED');
} finally {
  try { ws?.close(); } catch { /* already gone */ }
  await closeChrome({ chrome, port: CDP, profile });
  server.kill('SIGTERM');
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(fails ? 1 : 0);
