/**
 * Answering from an ntfy button, over the real route.
 *
 * The tenancy question — a code minted for one account cannot reach another's
 * habit — is answered in notify.integration.mjs, beside the rest of that
 * file's `withUser` checks, since only Postgres can prove it. What this file
 * proves is everything only a booted `src/server.js` can show: that the route
 * is mounted where an unauthenticated request reaches it, that the origin
 * guard mounted above it applies here too, and that its own inline limiter
 * bites. Pinning the decision is not pinning the wiring, so this drives the
 * real HTTP surface rather than calling `handleNtfyAnswer` in process.
 *
 * Cloud's `server.js` has no `isEntryPoint` guard — importing it starts
 * listening — so the real server is booted as a child process, the same way
 * `healthz.integration.mjs` does, complete with a fake OIDC issuer so
 * `initAuth` can complete without a real one.
 *
 *   DATABASE_URL=... ADMIN_URL=... node test/ntfy-answer.integration.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

process.env.ADMIN_URL ??= 'postgres://owner:testpw@localhost:5432/habiterall';
process.env.DATABASE_URL ??= 'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';

const SECRET = 'ntfy-answer-integration-secret';

const { withUser } = await import('../src/db/pool.js');
const { signNtfyAnswer, NTFY_ANSWER_PATH } = await import('@habiterall/shared/ntfy-answer.js');
const { MAX_ANSWER_AGE_DAYS } = await import('@habiterall/shared/discord.js');
const { RATE_LIMITS } = await import('@habiterall/shared/security.js');

const pg = (await import('pg')).default;
const admin = new pg.Client({ connectionString: process.env.ADMIN_URL });

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

/** Minimal OIDC discovery, so `initAuth` can complete without a real IdP. */
async function fakeIssuer() {
  let base;
  const srv = createServer((req, res) => {
    if (req.url.startsWith('/.well-known/openid-configuration')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/auth`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  base = `http://127.0.0.1:${srv.address().port}`;
  return { srv, base };
}

const idle = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(issuer, port) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port),
      SESSION_SECRET: SECRET,
      PUBLIC_URL: `http://localhost:${port}`,
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: 'test-client',
      OIDC_CLIENT_SECRET: 'test-secret',
      ALLOW_INSECURE_OIDC: 'true',
      HABITERALL_NOTIFY: 'off',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => {
    const s = String(b);
    if (!s.includes('oidc.insecure')) process.stderr.write(`  [server] ${s}`);
  });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { child, base };
    } catch { /* not listening yet */ }
    await idle(100);
  }
  throw new Error('server never became ready');
}

const { srv, base: issuer } = await fakeIssuer();
const port = 3600 + (process.pid % 200);
const { child, base } = await boot(issuer, port);

try {
  await admin.connect();
  await admin.query('DELETE FROM entries');
  await admin.query('DELETE FROM habits');
  await admin.query(`DELETE FROM users WHERE idp_subject = 'sub-ntfy-http'`);

  const userId = (await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, display_name, settings)
     VALUES ('sub-ntfy-http', 'https://idp', 'ntfy http test', '{}'::jsonb) RETURNING id`
  )).rows[0].id;

  const mkHabit = async (name) => withUser(userId, (db) =>
    db.query(
      `INSERT INTO habits (user_id, name, type) VALUES ($1, $2, 'boolean') RETURNING id`,
      [userId, name]
    ).then((r) => r.rows[0].id));

  const entriesFor = async (habitId) => withUser(userId, (db) =>
    db.query(`SELECT date, value, status FROM entries WHERE habit_id = $1`, [habitId])
      .then((r) => r.rows));

  const day = new Date().toISOString().slice(0, 10);
  let ntfyRequests = 0;
  const postNtfy = async (code, { origin } = {}) => {
    ntfyRequests++;
    const headers = {};
    if (origin !== undefined) headers.Origin = origin;
    const res = await fetch(
      `${base}${NTFY_ANSWER_PATH}?c=${encodeURIComponent(code)}`,
      { method: 'POST', headers }
    );
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body };
  };
  const ntfyCode = (fields) => signNtfyAnswer({ secret: SECRET, account: String(userId), ...fields });
  const shiftDay = (delta) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  };

  console.log('--- answering from an ntfy button, over the real route ---');

  const happyId = await mkHabit('ntfy happy path');
  const happy = await postNtfy(ntfyCode({ habitId: happyId, date: day, action: 'yes' }));
  ck('a signed ntfy press is accepted', happy.status === 200, JSON.stringify(happy));
  const afterHappy = await entriesFor(happyId);
  ck('and the entry is recorded, read back from storage',
    afterHappy.some((e) => e.date === day && Number(e.value) === 2),
    JSON.stringify(afterHappy));

  // Flipping the LAST base64url character of a 16-byte MAC is not safe: the
  // final character carries only 2 significant bits, the rest padding, so
  // some flips are a no-op about 1 time in 64. Flip a whole byte in the
  // middle of the decoded MAC instead, which always changes the value.
  const forgedId = await mkHabit('ntfy forged');
  const validForForgery = ntfyCode({ habitId: forgedId, date: day, action: 'yes' });
  const [version, payloadB64, macB64] = validForForgery.split('.');
  const macBytes = Buffer.from(macB64, 'base64url');
  macBytes[0] ^= 0xff;
  const tamperedMac = `${version}.${payloadB64}.${macBytes.toString('base64url')}`;
  const forged = await postNtfy(tamperedMac);
  ck('a forged code is refused with 403', forged.status === 403, JSON.stringify(forged));
  ck('and nothing was written for it', (await entriesFor(forgedId)).length === 0);

  const unknownId = await mkHabit('ntfy unknown account');
  const unknownAccountCode = signNtfyAnswer({
    secret: SECRET, account: '999999999', habitId: unknownId, date: day, action: 'yes',
  });
  const unknownAccount = await postNtfy(unknownAccountCode);
  ck('an unknown account reference is refused with the identical 403 shape',
    unknownAccount.status === 403
      && JSON.stringify(unknownAccount.body) === JSON.stringify(forged.body),
    JSON.stringify(unknownAccount));
  ck('and nothing was written for it either', (await entriesFor(unknownId)).length === 0);

  const deletedId = await mkHabit('ntfy deleted');
  await withUser(userId, (db) => db.query('DELETE FROM habits WHERE id = $1', [deletedId]));
  const deletedNtfy = await postNtfy(ntfyCode({ habitId: deletedId, date: day, action: 'yes' }));
  ck('a deleted habit is refused, not recorded',
    deletedNtfy.status === 400 && /no longer exists/i.test(deletedNtfy.body?.error ?? ''),
    JSON.stringify(deletedNtfy));

  const staleId = await mkHabit('ntfy stale');
  const staleDate = shiftDay(-(MAX_ANSWER_AGE_DAYS + 1));
  const staleNtfy = await postNtfy(ntfyCode({ habitId: staleId, date: staleDate, action: 'yes' }));
  ck('a stale reminder answers 410', staleNtfy.status === 410, JSON.stringify(staleNtfy));
  ck('and nothing was written for a stale press', (await entriesFor(staleId)).length === 0);

  const futureId = await mkHabit('ntfy future');
  const futureDate = shiftDay(1);
  const futureNtfy = await postNtfy(ntfyCode({ habitId: futureId, date: futureDate, action: 'yes' }));
  ck('a future-dated reminder answers 400', futureNtfy.status === 400, JSON.stringify(futureNtfy));
  ck('and nothing was written for a future press', (await entriesFor(futureId)).length === 0);

  const testId = await mkHabit('ntfy test-code target');
  const testNtfy = await postNtfy(ntfyCode({ habitId: testId, date: day, action: 'yes', test: true }));
  ck('a test code is accepted', testNtfy.status === 200, JSON.stringify(testNtfy));
  ck('and a test code writes nothing', (await entriesFor(testId)).length === 0);

  const noOriginId = await mkHabit('ntfy no origin');
  const noOrigin = await postNtfy(ntfyCode({ habitId: noOriginId, date: day, action: 'yes' }));
  ck('no Origin header is accepted', noOrigin.status === 200, JSON.stringify(noOrigin));

  const foreignId = await mkHabit('ntfy foreign origin');
  const foreignOrigin = await postNtfy(
    ntfyCode({ habitId: foreignId, date: day, action: 'yes' }),
    { origin: 'https://evil.example' }
  );
  ck('a foreign Origin is refused, even with an otherwise-valid code',
    foreignOrigin.status === 403 && /cross-origin/i.test(foreignOrigin.body?.error ?? ''),
    JSON.stringify(foreignOrigin));
  ck('and nothing was written for the cross-origin attempt',
    (await entriesFor(foreignId)).length === 0);

  // The limiter is written inline at the route, keyed on IP, and there is no
  // env switch in this edition that turns it off (unlike personal's
  // HABITERALL_RATE_LIMIT=off) — it simply bites, full stop, for every
  // caller of this route including this test's own traffic.
  const junkCode = 'v1.notarealtoken.notarealmac12345678';
  let saw429 = false;
  const budget = RATE_LIMITS.ntfyAnswer.limit + 20 - ntfyRequests;
  for (let i = 0; i < budget && !saw429; i++) {
    const r = await postNtfy(junkCode);
    if (r.status === 429) saw429 = true;
  }
  ck('the ntfy-answer limiter bites, with no off-switch to defeat',
    saw429, `sent ${ntfyRequests} requests total, limit is ${RATE_LIMITS.ntfyAnswer.limit}/min`);

  console.log(`\n${fails === 0 ? 'ALL NTFY-ANSWER HTTP CHECKS PASSED' : `${fails} FAILED`}`);
} finally {
  await admin.query(`DELETE FROM users WHERE idp_subject = 'sub-ntfy-http'`).catch(() => {});
  await admin.end().catch(() => {});
  child.kill('SIGKILL');
  srv.close();
}

process.exit(fails === 0 ? 0 : 1);
