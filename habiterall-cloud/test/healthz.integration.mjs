/**
 * `/healthz` must answer without consulting the session store.
 *
 * This boots the REAL `src/server.js`, because the thing under test is where a
 * route sits in that file's middleware chain and nothing else can see it — an
 * assertion built on a hand-rolled express app in a test would be a copy of the
 * ordering, and would pass whatever server.js does. Pinning the decision is not
 * pinning the wiring.
 *
 * The observation is behavioural rather than a source read: the `session` table
 * is renamed out from under the running server, so any request that reaches
 * connect-pg-simple fails. A `/healthz` mounted above the session middleware
 * still answers 200; one mounted below answers 500. A control asserts the
 * rename actually bit, so the test cannot pass because the sabotage silently
 * did nothing.
 *
 * Two round trips are at stake and they fail differently, so both are checked:
 * the SELECT for the cookie (the 500 above) and the touch UPDATE that
 * `rolling: true` adds (the `expire` column, below).
 *
 *   DATABASE_URL=... ADMIN_URL=... node test/healthz.integration.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import pg from 'pg';

process.env.ADMIN_URL ??= 'postgres://owner:testpw@localhost:5432/habiterall';
process.env.DATABASE_URL ??= 'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';

const SECRET = 'healthz-integration-secret';
const SID = 'healthzintegrationsid0001';
const admin = new pg.Client({ connectionString: process.env.ADMIN_URL });

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

/** express-session's cookie format: s:<sid>.<base64 hmac, unpadded>. */
const signed = (sid, secret) =>
  `s%3A${sid}.${encodeURIComponent(
    createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, ''))}`;

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
const port = 3400 + (process.pid % 200);
const { child, base } = await boot(issuer, port);

try {
  await admin.connect();

  // A session that exists, so the store has something real to find.
  const expire = new Date(Date.now() + 7 * 864e5);
  await admin.query(
    `INSERT INTO session (sid, sess, expire) VALUES ($1, $2, $3)
     ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
    [SID, JSON.stringify({
      cookie: { originalMaxAge: 6048e5, httpOnly: true, path: '/', sameSite: 'lax' },
      user: { id: 1, email: 'a@b.c', name: 'a', blocked: false },
    }), expire],
  );
  const cookie = `habiterall.sid=${signed(SID, SECRET)}`;
  const hz = (opts = {}) => fetch(`${base}/healthz`, opts);

  console.log('--- the route answers at all ---');
  ck('200 with no cookie', (await hz()).status === 200);
  ck('200 with a session cookie', (await hz({ headers: { cookie } })).status === 200);

  console.log('\n--- the touch UPDATE: rolling must not slide this session ---');
  const expireBefore = (await admin.query('SELECT expire FROM session WHERE sid = $1', [SID]))
    .rows[0].expire.getTime();
  await hz({ headers: { cookie } });
  // The touch is fired without being awaited, so this waits to see that
  // something did NOT happen — there is no predicate to poll for an absence.
  await idle(750);
  const expireAfter = (await admin.query('SELECT expire FROM session WHERE sid = $1', [SID]))
    .rows[0].expire.getTime();
  ck('a probe did not slide `expire`', expireBefore === expireAfter,
    `before=${new Date(expireBefore).toISOString()} after=${new Date(expireAfter).toISOString()}`);

  console.log('\n--- the SELECT: with the store unreachable, the probe still answers ---');
  await admin.query('ALTER TABLE session RENAME TO session_hidden');
  try {
    // Control first. If the rename did not actually break the store, every
    // assertion below would pass for the wrong reason.
    const control = await fetch(`${base}/api/me`, { headers: { cookie } });
    ck('control: an authenticated route DOES break without the table',
      control.status !== 200, `/api/me -> ${control.status}`);

    const cold = await hz({ headers: { cookie } });
    ck('200 with a cookie and no session table', cold.status === 200,
      `-> ${cold.status}`);
    ck('still reports healthy', (await cold.json()).ok === true);
    ck('200 with no cookie and no session table',
      (await hz()).status === 200);
  } finally {
    await admin.query('ALTER TABLE session_hidden RENAME TO session');
  }

  console.log(`\n${fails === 0 ? 'all checks passed' : `${fails} FAILED`}`);
} finally {
  await admin.query('DELETE FROM session WHERE sid = $1', [SID]).catch(() => {});
  await admin.end().catch(() => {});
  child.kill('SIGKILL');
  srv.close();
}

process.exit(fails === 0 ? 0 : 1);
