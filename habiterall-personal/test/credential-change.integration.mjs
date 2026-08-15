/**
 * A session must not outlive the credential that authorised it.
 *
 * This needs its own file because it needs a RESTART, and every other auth
 * suite runs inside one process. That is exactly why the bug it pins survived
 * review: `habiterall-personal/CLAUDE.md` told operators to close the unguarded
 * setup window by setting HABITERALL_USERNAME and HABITERALL_PASSWORD, and doing
 * so left the stranger who had already claimed the instance with a working
 * cookie for another fourteen days — their password refused, their session not.
 *
 * Both halves are checked here: the credential changing, and the credential
 * being REMOVED again, which used to bring an older database row — and every
 * session raised against it — back to life.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3391;
const base = `http://127.0.0.1:${PORT}`;
const workdir = mkdtempSync(join(tmpdir(), 'habiterall-cred-'));
const DB = join(workdir, 'cred.db');
const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot a server with the given extra environment, and wait for it to answer. */
async function boot(env) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HABITERALL_DB: DB,
      HABITERALL_NOTIFY: 'off',
      LOG_LEVEL: 'error',
      // Cleared explicitly: these are the documented way to configure this app,
      // so an ambient value in the developer's shell would silently reconfigure
      // the very thing under test.
      HABITERALL_AUTH: '',
      HABITERALL_USERNAME: '',
      HABITERALL_PASSWORD: '',
      HABITERALL_PASSWORD_HASH: '',
      ...env,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) return child;
    await sleep(250);
  }
  throw new Error('server did not start');
}

async function stop(child) {
  child.kill('SIGTERM');
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    await sleep(100);
  }
  await sleep(250);   // let the port clear
}

const withCookie = (cookie, path, options = {}) => fetch(base + path, {
  ...options,
  headers: {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.body ? { Origin: base } : {}),
    Cookie: cookie,
    ...options.headers,
  },
});

try {
  /* ---------- 1. a stranger claims an unclaimed instance ---------- */

  let server = await boot({});
  const claimed = await fetch(`${base}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'stranger', password: 'stranger-password' }),
  });
  const cookie = (claimed.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';
  check('a stranger can claim an unclaimed instance', claimed.status === 200 && !!cookie,
    `status=${claimed.status}`);
  check('and the claim gives them a working session',
    (await withCookie(cookie, '/api/habits')).status === 200);
  await stop(server);

  /* ---------- 2. the operator does what the docs say ---------- */

  server = await boot({
    HABITERALL_USERNAME: 'owner',
    HABITERALL_PASSWORD: 'a-good-long-password',
  });

  const read = await withCookie(cookie, '/api/habits');
  check("the stranger's session no longer reads", read.status === 401, `status=${read.status}`);

  const write = await withCookie(cookie, '/api/habits', {
    method: 'POST', body: JSON.stringify({ name: 'planted' }),
  });
  check("the stranger's session no longer writes", write.status === 401, `status=${write.status}`);

  const theirLogin = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'stranger', password: 'stranger-password' }),
  });
  check("the stranger's password is refused", theirLogin.status === 401,
    `status=${theirLogin.status}`);

  const ownerLogin = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'owner', password: 'a-good-long-password' }),
  });
  const ownerCookie = (ownerLogin.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';
  check('the operator can sign in', ownerLogin.status === 200 && !!ownerCookie,
    `status=${ownerLogin.status}`);
  await stop(server);

  /* ---------- 3. the environment credentials are taken away again ---------- */

  server = await boot({});
  const revived = await withCookie(cookie, '/api/habits');
  check("removing the env credentials does not revive the stranger's session",
    revived.status === 401, `status=${revived.status}`);

  const ownerAfter = await withCookie(ownerCookie, '/api/habits');
  check("nor does it leave the operator's session valid against a different credential",
    ownerAfter.status === 401, `status=${ownerAfter.status}`);
  await stop(server);

  /* ---------- 4. an unchanged credential must NOT log everyone out ---------- */

  server = await boot({
    HABITERALL_USERNAME: 'owner',
    HABITERALL_PASSWORD: 'a-good-long-password',
  });
  const fresh = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'owner', password: 'a-good-long-password' }),
  });
  const freshCookie = (fresh.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';
  await stop(server);

  server = await boot({
    HABITERALL_USERNAME: 'owner',
    HABITERALL_PASSWORD: 'a-good-long-password',
  });
  const survived = await withCookie(freshCookie, '/api/habits');
  check('a session survives a restart that changes nothing', survived.status === 200,
    `status=${survived.status}`);
  await stop(server);

  console.log(failures ? `\n${failures} check(s) failed` : '\nall credential-change checks passed');
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
