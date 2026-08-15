/**
 * The three auth modes, end to end against the real server.
 *
 * Each mode needs its own server process, because auth resolves once at startup
 * from the environment — so this file re-execs itself with a different env per
 * mode rather than trying to reconfigure a running app. `MODE` selects which.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = fileURLToPath(import.meta.url);
const MODE = process.env.MODE;

let failures = 0;
const pass = (name, detail = '') => console.log(`PASS  ${name}${detail ? ` :: ${detail}` : ''}`);
const fail = (name, detail) => { failures++; console.log(`FAIL  ${name} :: ${detail}`); };
const check = (name, cond, detail = '') => (cond ? pass(name, detail) : fail(name, detail));

/* ---------- parent: run each mode in its own process ---------- */

if (!MODE) {
  const workdir = mkdtempSync(join(tmpdir(), 'habiterall-auth-'));
  const modes = [
    ['off', { HABITERALL_AUTH: 'off' }],
    ['env', { HABITERALL_USERNAME: 'mark', HABITERALL_PASSWORD: 'a-good-long-password' }],
    ['setup', {}],
    ['misread', { HABITERALL_AUTH: 'false', HABITERALL_USERNAME: 'm', HABITERALL_PASSWORD: 'a-good-long-password' }],
    ['bruteforce', {
      HABITERALL_USERNAME: 'mark', HABITERALL_PASSWORD: 'a-good-long-password',
      HABITERALL_RATE_LIMIT: 'off',
    }],
    ['spoof', { HABITERALL_USERNAME: 'mark', HABITERALL_PASSWORD: 'a-good-long-password' }],
    ['race', {}],
    ['preauth', { HABITERALL_USERNAME: 'mark', HABITERALL_PASSWORD: 'a-good-long-password' }],
  ];

  let bad = 0;
  for (const [name, env] of modes) {
    console.log(`\n--- mode: ${name} ---`);
    const code = await new Promise((resolve) => {
      spawn(process.execPath, [here], {
        stdio: 'inherit',
        env: {
          ...process.env,
          MODE: name,
          // A fresh database per mode: 'setup' must find no credentials, and
          // 'env' must not be able to fall back to a row another mode wrote.
          HABITERALL_DB: join(workdir, `${name}.db`),
          HABITERALL_NOTIFY: 'off',
          LOG_LEVEL: 'error',
          ...env,
        },
      }).on('exit', resolve);
    });
    if (code !== 0) bad++;
  }

  rmSync(workdir, { recursive: true, force: true });
  console.log(bad ? `\n${bad} mode(s) failed` : '\nall auth checks passed');
  process.exit(bad ? 1 : 0);
}

/* ---------- child: one mode ---------- */

const { app } = await import('../src/server.js');
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

/** fetch that carries a cookie jar, because a session is the thing under test. */
let cookie = '';
async function call(path, options = {}) {
  const res = await fetch(base + path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers,
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) cookie = c.split(';')[0];
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

if (MODE === 'off') {
  const me = await call('/api/me');
  check('auth off: /api/me answers without a session', me.status === 200, JSON.stringify(me.body));
  check('auth off: mode is "none"', me.body.mode === 'none', me.body.mode);

  const habits = await call('/api/habits');
  check('auth off: the API is open, exactly as before', habits.status === 200, `status=${habits.status}`);

  const login = await call('/auth/login', { method: 'POST', body: JSON.stringify({ username: 'x', password: 'y' }) });
  check('auth off: there is no login route to attack', login.status === 404, `status=${login.status}`);
}

if (MODE === 'env' || MODE === 'misread') {
  // 'misread' sets HABITERALL_AUTH=false, which must NOT disable auth.
  const me = await call('/api/me');
  check('signed out: /api/me is 401', me.status === 401, `status=${me.status}`);
  check('signed out: the 401 carries the mode', me.body.mode === 'password', me.body.mode);

  const closed = await call('/api/habits');
  check('signed out: the API is closed', closed.status === 401, `status=${closed.status}`);

  const user = MODE === 'env' ? 'mark' : 'm';
  const wrong = await call('/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password: 'nope' }) });
  check('a wrong password is refused', wrong.status === 401, `status=${wrong.status}`);

  // The property that matters is that the two failures are INDISTINGUISHABLE.
  // Telling a stranger the username was right narrows their search to the
  // password alone, so both halves must answer with the same status and the
  // same words.
  const wrongUser = await call('/auth/login', { method: 'POST', body: JSON.stringify({ username: 'nobody', password: 'a-good-long-password' }) });
  check('a wrong username is refused identically',
    wrongUser.status === wrong.status && wrongUser.body.error === wrong.body.error,
    `${wrongUser.status} ${wrongUser.body.error}`);

  const ok = await call('/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password: 'a-good-long-password' }) });
  check('the right password signs in', ok.status === 200, `status=${ok.status}`);

  const open = await call('/api/habits');
  check('signed in: the API opens', open.status === 200, `status=${open.status}`);

  const meIn = await call('/api/me');
  check('signed in: /api/me reports the username', meIn.body.name === user, meIn.body.name);
  check('signed in: env credentials are reported as managed', meIn.body.managed === true, String(meIn.body.managed));

  // Setup must be closed forever once credentials exist, or it is a password reset.
  const setup = await call('/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'attacker', password: 'aaaaaaaaaa' }) });
  check('setup is closed once an account exists', setup.status === 409, `status=${setup.status}`);

  // Cross-site forgery: the session is a cookie, so a form on another site
  // could otherwise POST here and have the browser attach it.
  const forged = await call('/api/habits', {
    method: 'POST',
    body: JSON.stringify({ name: 'planted' }),
    headers: { Origin: 'https://evil.example.com' },
  });
  check('a cross-origin write is refused', forged.status === 403, `status=${forged.status}`);

  const sameSite = await call('/api/habits', {
    method: 'POST',
    body: JSON.stringify({ name: 'from the app' }),
    headers: { Origin: base },
  });
  check('a same-origin write is not', sameSite.status < 400, `status=${sameSite.status}`);

  await call('/auth/logout', { method: 'POST' });
  const after = await call('/api/habits');
  check('signing out revokes the session', after.status === 401, `status=${after.status}`);
}

if (MODE === 'bruteforce') {
  // HABITERALL_RATE_LIMIT=off must NOT reach the credential limiter: it exists
  // so tests are not throttled on reads, not to remove the only thing bounding
  // guesses at a single shared password.
  let limited = 0, refused = 0;
  for (let i = 0; i < 40; i++) {
    const r = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'mark', password: `guess-${i}` }),
    });
    if (r.status === 429) limited++;
    if (r.status === 401) refused++;
  }
  check('the login limiter survives HABITERALL_RATE_LIMIT=off',
    limited > 0, `${refused} refused, ${limited} rate-limited`);
  check('and it bites at the shared limit', refused === 20, `${refused} got through`);
}

if (MODE === 'spoof') {
  // The limiters key on req.ip, and with `trust proxy` on that comes from a
  // header the caller writes. Forty guesses went through a limit of twenty by
  // rotating one. TRUST_PROXY is unset here, which is the shipped default.
  let through = 0;
  for (let i = 0; i < 40; i++) {
    const r = await call('/auth/login', {
      method: 'POST',
      headers: { 'X-Forwarded-For': `203.0.113.${i}` },
      body: JSON.stringify({ username: 'mark', password: `guess-${i}` }),
    });
    if (r.status === 401) through++;
  }
  check('a forged X-Forwarded-For cannot buy more login attempts',
    through === 20, `${through} reached the password check`);
}

if (MODE === 'preauth') {
  // The raw body parser used to sit above requireAuth, so an unauthenticated
  // POST was buffered to its limit and only then refused — 413 rather than 401,
  // with the whole body in memory and no limiter having run.
  const big = 'a'.repeat(20 * 1024 * 1024);
  const res = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: big,
  });
  check('an oversized unauthenticated import is refused, not buffered',
    res.status === 401, `status=${res.status}`);
}

if (MODE === 'race') {
  // Setup was a check-then-write with an upsert and ~30ms of scrypt in between,
  // so two concurrent claims both wrote and the later one won — locking the
  // legitimate owner out of their own instance.
  const claim = (username, password) => fetch(`${base}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then((r) => r.status);

  const first = claim('owner', 'owner-good-password');
  await new Promise((r) => setTimeout(r, 15));
  const second = claim('attacker', 'attacker-password');
  const [a, b] = await Promise.all([first, second]);

  check('exactly one concurrent claim succeeds',
    [a, b].filter((s) => s === 200).length === 1, `statuses ${a}/${b}`);
  check('the loser is told the instance is taken',
    [a, b].includes(409), `statuses ${a}/${b}`);

  const login = (u, p) => fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  }).then((r) => r.status);
  const owner = await login('owner', 'owner-good-password');
  const attacker = await login('attacker', 'attacker-password');
  check('the winner owns the credential and the loser owns nothing',
    [owner, attacker].filter((s) => s === 200).length === 1,
    `owner=${owner} attacker=${attacker}`);
}

if (MODE === 'setup') {
  const me = await call('/api/me');
  check('unclaimed: mode is "setup"', me.status === 401 && me.body.mode === 'setup', me.body.mode);

  const closed = await call('/api/habits');
  check('unclaimed: the API is still closed', closed.status === 401, `status=${closed.status}`);

  const short = await call('/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'mark', password: 'short' }) });
  check('a short password is rejected', short.status === 400, short.body.error);

  const blank = await call('/auth/setup', { method: 'POST', body: JSON.stringify({ username: '   ', password: 'a-good-long-password' }) });
  check('a blank username is rejected', blank.status === 400, blank.body.error);

  const made = await call('/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'mark', password: 'a-good-long-password' }) });
  check('setup creates the account and signs in', made.status === 200, `status=${made.status}`);

  const open = await call('/api/habits');
  check('the API opens straight after setup', open.status === 200, `status=${open.status}`);

  const again = await call('/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'attacker', password: 'aaaaaaaaaa' }) });
  check('setup cannot be run twice', again.status === 409, `status=${again.status}`);

  // The credential must survive a restart — it is in the database, not memory.
  await call('/auth/logout', { method: 'POST' });
  const back = await call('/auth/login', { method: 'POST', body: JSON.stringify({ username: 'mark', password: 'a-good-long-password' }) });
  check('the password set at setup works afterwards', back.status === 200, `status=${back.status}`);
}

server.close();
process.exit(failures ? 1 : 0);
