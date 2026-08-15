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

  const ev = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
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
    signinShown: !document.getElementById('view-signin').hidden,
    title: document.getElementById('signin-title').textContent.trim(),
    formShown: !document.getElementById('signin-form').hidden,
    linkShown: !document.getElementById('signin-oidc').hidden,
    confirmShown: !document.getElementById('signin-confirm-row').hidden,
    submit: document.getElementById('signin-submit').textContent.trim(),
    listShown: !document.getElementById('view-list').hidden,
    newBtn: !document.getElementById('btn-new').hidden
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
    return JSON.stringify({ shown: !e.hidden, text: e.textContent.trim() });
  })()`);
  const mm = JSON.parse(mismatch);
  ck('setup: mismatched passwords are caught in the page', mm.shown && /match/i.test(mm.text), mm.text);

  // Submitting succeeds and the adapter reloads the page, so the wait has to
  // happen in Node: an await inside the page dies with the navigation.
  await ev(`document.getElementById('signin-confirm').value = 'a-good-long-password';
            document.getElementById('signin-form').requestSubmit(); 1`);
  await sleep(3000);

  const after = JSON.parse(await ev(`JSON.stringify({
    signinShown: !document.getElementById('view-signin').hidden,
    listShown: !document.getElementById('view-list').hidden,
    newBtn: !document.getElementById('btn-new').hidden
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
    formShown: !document.getElementById('signin-form').hidden,
    confirmShown: !document.getElementById('signin-confirm-row').hidden,
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
    return JSON.stringify({ shown: !e.hidden, text: e.textContent.trim() });
  })()`);
  const w = JSON.parse(wrong);
  ck('password: a wrong password is reported in the form', w.shown && w.text.length > 0, w.text);

  await ev(`document.getElementById('signin-pass').value = 'a-good-long-password';
            document.getElementById('signin-form').requestSubmit(); 1`);
  await sleep(3000);

  const signedIn = JSON.parse(await ev(`JSON.stringify({
    signinShown: !document.getElementById('view-signin').hidden,
    listShown: !document.getElementById('view-list').hidden,
    user: document.getElementById('user-name')?.textContent.trim()
  })`));
  ck('password: the right password signs in', !signedIn.signinShown && signedIn.listShown,
    JSON.stringify(signedIn));
  ck('password: the chip shows who is signed in', signedIn.user === 'mark', signedIn.user);

  console.log(fails ? `\n${fails} check(s) failed` : '\nALL SIGN-IN CHECKS PASSED');
} finally {
  try { ws?.close(); } catch { /* already gone */ }
  await closeChrome({ chrome, port: CDP, profile });
  server.kill('SIGTERM');
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(fails ? 1 : 0);
