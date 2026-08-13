/**
 * End-to-end login against the real Authentik stack, in a real browser.
 * Signs in as testuser, then exercises the authenticated app.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHROME } from '../../../shared/test/browser/chrome.mjs';
const APP = 'http://localhost:3100';
const PORT = 9240;

const profile = mkdtempSync(join(tmpdir(), 'habcloud-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu',
  '--ignore-certificate-errors', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (l, c, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' :: ' + e : ''}`);
  if (!c) fails++;
};

let ws, nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

try {
  let url;
  for (let i = 0; i < 60; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; if (url) break; } catch {}
    await sleep(250);
  }
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send('Page.enable', {}, sessionId);

  const goto = async (u) => {
    await send('Page.navigate', { url: u }, sessionId);
    await sleep(1500);
  };
  const href = () => ev('location.href');

  /* ---- 1. signed out ---- */
  console.log('--- signed out ---');
  await goto(APP);
  await sleep(800);
  check('sign-in screen shown when signed out',
    await ev(`!document.getElementById('view-signin').hidden`));
  check('habit list hidden when signed out',
    await ev(`document.getElementById('view-list').hidden === true`));
  check('New habit button hidden when signed out',
    await ev(`document.getElementById('btn-new').hidden === true`));

  /* ---- 2. log in through Authentik ---- */
  console.log('--- logging in via Authentik ---');
  await goto(`${APP}/auth/login`);
  await sleep(2500);
  const atIdp = await href();
  check('redirected to the identity provider', atIdp.includes('localhost:9000'), atIdp);

  // Authentik's login is a web-component flow; fill whatever input is present.
  for (let attempt = 0; attempt < 12; attempt++) {
    const done = await ev(`(() => {
      const deep = (root, out=[]) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) deep(el.shadowRoot, out);
          if (el.tagName === 'INPUT') out.push(el);
        }
        return out;
      };
      const inputs = deep(document);
      const user = inputs.find(i => i.name === 'uidField' || i.type === 'text' || i.type === 'email');
      const pass = inputs.find(i => i.type === 'password');
      if (pass && pass.offsetParent !== null) {
        pass.value = 'TestPassw0rd!123';
        pass.dispatchEvent(new Event('input', {bubbles:true}));
        const f = pass.closest('form'); if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); return 'password'; }
      }
      if (user && user.offsetParent !== null) {
        user.value = 'testuser';
        user.dispatchEvent(new Event('input', {bubbles:true}));
        const f = user.closest('form'); if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); return 'username'; }
      }
      return null;
    })()`);
    if (done) console.log(`    submitted ${done} step`);
    await sleep(1800);
    if ((await href()).startsWith(APP)) break;
  }

  await sleep(2000);
  const back = await href();
  check('returned to the application after login', back.startsWith(APP), back);

  /* ---- 3. authenticated session ---- */
  console.log('--- authenticated ---');
  const me = await ev(`(async()=>{
    const r = await fetch('/api/me', {credentials:'same-origin'});
    return r.ok ? await r.json() : {status:r.status};
  })()`);
  check('/api/me returns the signed-in user', !!me?.id, JSON.stringify(me));
  check('user is the test account', me?.email === 'testuser@example.com', JSON.stringify(me));

  await goto(APP);
  await sleep(1500);
  check('app view shown after login',
    await ev(`document.getElementById('view-signin').hidden === true`));
  check('user chip shows the signed-in name',
    (await ev(`document.getElementById('user-name').textContent`))?.length > 0,
    await ev(`document.getElementById('user-name').textContent`));

  /* ---- 4. create data as this user ---- */
  const created = await ev(`(async()=>{
    const r = await fetch('/api/habits', {method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name:'Cloud Habit', type:'numerical', unit:'reps', target_value:10})});
    return r.ok ? await r.json() : {status:r.status, body: await r.text()};
  })()`);
  check('can create a habit', created?.id > 0, JSON.stringify(created).slice(0, 120));

  const entry = await ev(`(async()=>{
    const r = await fetch('/api/habits/${created.id}/entries/2026-08-01', {
      method:'PUT', credentials:'same-origin',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({value: 12, notes: 'from the cloud'})});
    return r.ok ? await r.json() : {status:r.status};
  })()`);
  check('can record an entry', entry?.value === 12, JSON.stringify(entry));

  const overview = await ev(`(async()=>(await (await fetch('/api/overview?days=7',{credentials:'same-origin'})).json()))()`);
  check('overview returns the habit', overview?.habits?.length === 1,
    JSON.stringify(overview?.habits?.map(h=>h.name)));
  check('stats computed for the habit', typeof overview?.habits?.[0]?.score === 'number',
    String(overview?.habits?.[0]?.score));

  const exported = await ev(`(async()=>(await (await fetch('/api/export',{credentials:'same-origin'})).json()))()`);
  check('export works and includes the habit',
    exported?.habits?.length === 1 && exported.habits[0].entries.length === 1,
    JSON.stringify(exported?.habits?.map(h=>h.name)));

  /* ---- 5. sign out ---- */
  console.log('--- sign out ---');
  await ev(`fetch('/auth/logout',{method:'POST',credentials:'same-origin'})`);
  await sleep(1200);
  const afterLogout = await ev(`(async()=>{
    const r = await fetch('/api/me',{credentials:'same-origin'}); return r.status;
  })()`);
  check('session is invalidated after logout', afterLogout === 401, String(afterLogout));

  console.log(fails === 0 ? '\nALL CLOUD LOGIN CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
} catch (e) {
  console.error('ERROR:', e.message); fails++;
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(fails ? 1 : 0);
}
