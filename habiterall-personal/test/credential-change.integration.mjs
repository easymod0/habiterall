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
 * session raised against it — back to life. The second half needs two rules to
 * hold at once, which is why it is several checks rather than one: the stale
 * row must not outlive the masking, and what replaces it must not be *nothing*,
 * or dropping the variables reopens the setup window instead.
 *
 * The last mode covers the other direction — a restart that changes nothing
 * must not evict anybody, including the ambiguous case where both password
 * variables are set and only one of them is the credential.
 */

import { spawn } from 'node:child_process';
import { hashPassword } from '@habiterall/shared/password.js';
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

  // /api/me sits ABOVE the /api mount, so it is the one route that reads a
  // session without `requireAuth` — and it used to check only that one existed.
  // A revoked cookie got a 200 naming the account it no longer had, which is
  // what `auth.load()` boots from: the app painted its whole signed-in shell
  // and then threw it away on the first dashboard fetch.
  const me = await withCookie(cookie, '/api/me');
  check("nor does it satisfy /api/me", me.status === 401, `status=${me.status}`);
  const meBody = await me.json().catch(() => ({}));
  check("and /api/me does not hand back the revoked account's username",
    meBody.name === undefined, JSON.stringify(meBody));

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

  // The half that made the documented remedy a suspension rather than a
  // revocation. Environment credentials used only to MASK the database row, so
  // the stranger's username and hash sat in `auth_credentials` untouched and
  // the day the variables went away — a compose edit, a `docker run` without
  // `--env-file`, the volume restored elsewhere — their password worked again.
  // `adoptEnvCredential` writes the environment's credential into that row, so
  // what is left behind is the operator's, not the stranger's.
  server = await boot({});
  const revived = await withCookie(cookie, '/api/habits');
  check("removing the env credentials does not revive the stranger's session",
    revived.status === 401, `status=${revived.status}`);

  const strangerAgain = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'stranger', password: 'stranger-password' }),
  });
  check("nor their password", strangerAgain.status === 401, `status=${strangerAgain.status}`);

  // The instance must NOT fall back to having no account at all: that would
  // reopen the unguarded setup window on an instance that has an owner, which
  // is a worse failure than the one being fixed.
  const stillOwned = await fetch(`${base}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'opportunist', password: 'a-good-long-password' }),
  });
  check('the instance cannot be claimed again', stillOwned.status === 409,
    `status=${stillOwned.status}`);

  // The credential did not change — the environment was only ever a copy of
  // what is now in the row — so the operator's session is still good. That is a
  // deliberate reversal of what this file used to assert, and the epoch is why
  // it is safe: it moves when the credential does, and here it did not.
  const ownerAfter = await withCookie(ownerCookie, '/api/habits');
  check("and the operator's own session is not collateral damage",
    ownerAfter.status === 200, `status=${ownerAfter.status}`);

  const ownerLoginAfter = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'owner', password: 'a-good-long-password' }),
  });
  check("nor is the operator's password", ownerLoginAfter.status === 200,
    `status=${ownerLoginAfter.status}`);
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

  /* ---------- 5. …including when BOTH password variables are set ---------- */

  // The hash wins and the plaintext is ignored, which is `envCredentials`'
  // decision — but `syncCredential` was asking scrypt whether the ignored
  // PLAINTEXT matched the stored hash. It never did, so every restart looked
  // like a credential change: a new epoch, `DELETE FROM sessions`, and a warning
  // about an eviction nothing had asked for. A deliberately unrelated plaintext
  // here, because a matching one would pass either way.
  const bothVars = {
    HABITERALL_USERNAME: 'owner',
    HABITERALL_PASSWORD: 'a-different-password-entirely',
    HABITERALL_PASSWORD_HASH: await hashPassword('the-real-one'),
  };

  server = await boot(bothVars);
  const byHash = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'owner', password: 'the-real-one' }),
  });
  const hashCookie = (byHash.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';
  check('the hash is the password when both are set', byHash.status === 200 && !!hashCookie,
    `status=${byHash.status}`);

  const byPlain = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'owner', password: 'a-different-password-entirely' }),
  });
  check('and the losing plaintext is not a second one', byPlain.status === 401,
    `status=${byPlain.status}`);
  await stop(server);

  server = await boot(bothVars);
  const notEvicted = await withCookie(hashCookie, '/api/habits');
  check('a restart with both variables set does not empty the session table',
    notEvicted.status === 200, `status=${notEvicted.status}`);
  await stop(server);

  console.log(failures ? `\n${failures} check(s) failed` : '\nall credential-change checks passed');
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
