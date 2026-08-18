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

/**
 * Two sessions, because the two halves must not poison each other.
 *
 * The throttle's bookkeeping is per sid and lives in the server's memory, where
 * this test cannot reach it: once a request has touched a sid, every touch on
 * it is suppressed for an hour. So a half that needs a touch to be POSSIBLE has
 * to be handed a row nothing else has used. Sharing one sid is what made the
 * `expire` check below stop discriminating.
 */
const SID = 'healthzintegrationsid0001';
const SID_TOUCH = 'healthzintegrationsid0002';
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

  // Sessions that exist, so the store has something real to find. `expire` is
  // seeded with millisecond precision on purpose: connect-pg-simple writes
  // `to_timestamp(ceil(ms / 1000))`, a whole second, and a touch always happens
  // strictly later than this insert — so a written value can never coincide
  // with a seeded one, and "the column did not move" cannot be a rounding
  // accident.
  const seed = async (sid) => {
    await admin.query(
      `INSERT INTO session (sid, sess, expire) VALUES ($1, $2, $3)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
      [sid, JSON.stringify({
        cookie: { originalMaxAge: 6048e5, httpOnly: true, path: '/', sameSite: 'lax' },
        user: { id: 1, email: 'a@b.c', name: 'a', blocked: false },
      }), new Date(Date.now() + 7 * 864e5)],
    );
    return `habiterall.sid=${signed(sid, SECRET)}`;
  };

  const expireOf = async (sid) =>
    (await admin.query('SELECT expire FROM session WHERE sid = $1', [sid]))
      .rows[0].expire.getTime();

  const cookie = await seed(SID);
  const cookieTouch = await seed(SID_TOUCH);
  const hz = (opts = {}) => fetch(`${base}/healthz`, opts);

  console.log('--- the touch UPDATE: rolling must not slide this session ---');
  // This MUST be the first request in the file that carries a cookie, and that
  // is load bearing rather than tidy. The throttle suppresses every touch on a
  // sid for an hour after the first, so ANY earlier cookie'd request would have
  // paid the interval here and left this probe unable to write the column
  // whichever side of the session middleware it was mounted — the check would
  // then pass against the very ordering it exists to catch. There used to be
  // such a request (a `200 with a session cookie` smoke check, which `boot()`
  // had already proved anyway), and this check only failed against the unfixed
  // ordering because that request's un-awaited UPDATE happened to land between
  // the two SELECTs. Green by timing is not green.
  const expireBefore = await expireOf(SID);
  const probe = await hz({ headers: { cookie } });
  ck('200 with a session cookie', probe.status === 200, `-> ${probe.status}`);
  // The touch is fired without being awaited, so this waits to see that
  // something did NOT happen — there is no predicate to poll for an absence.
  await idle(750);
  const expireAfter = await expireOf(SID);
  ck('a probe did not slide `expire`', expireBefore === expireAfter,
    `before=${new Date(expireBefore).toISOString()} after=${new Date(expireAfter).toISOString()}`);

  console.log('\n--- the SELECT: with the store unreachable, the probe still answers ---');
  await admin.query('ALTER TABLE session RENAME TO session_hidden');
  try {
    // Control first. If the rename did not actually break the store, every
    // assertion below would pass for the wrong reason.
    //
    // It asserts 500 EXACTLY, and the exactness is the whole check. `!== 200`
    // was the first version and it could not fail: the session names `user.id`
    // 1, nothing in this suite creates that user, and `api.integration.mjs`
    // deletes every account it made immediately before this file runs in the
    // same CI job — so `isBlocked` reads a vanished user as blocked and
    // `/api/me` answers 403 with the session table entirely INTACT. Measured:
    // replacing both `ALTER TABLE`s with `SELECT 1` left this control green and
    // every assertion under it green, against a server whose store was never
    // touched. A 500 is the only answer that means the store is unreachable;
    // 401 and 403 are answers about the user, which is a different question.
    const control = await fetch(`${base}/api/me`, { headers: { cookie } });
    ck('control: an authenticated route DOES break without the table',
      control.status === 500,
      `/api/me -> ${control.status}${control.status === 403 || control.status === 401
        ? ' — the rename did not bite; this is an answer about the user, not the store'
        : ''}`);

    const cold = await hz({ headers: { cookie } });
    ck('200 with a cookie and no session table', cold.status === 200,
      `-> ${cold.status}`);
    ck('still reports healthy', (await cold.json()).ok === true);
    ck('200 with no cookie and no session table',
      (await hz()).status === 200);
  } finally {
    await admin.query('ALTER TABLE session_hidden RENAME TO session');
  }

  console.log('\n--- the touch throttle, through the real server ---');
  // A route BELOW the session middleware, so it does touch: the static shell.
  // Not /api/*, which would need a provisioned user, and not /healthz, which is
  // now above the middleware and would pass this without a throttle at all.
  // Its own sid, untouched by anything above, so the throttle is guaranteed to
  // let the first write through and the control below is a real question.
  const shell = () => fetch(`${base}/`, { headers: { cookie: cookieTouch } });

  // The control comes first, and it is the half that was missing: without it,
  // "the column did not move" is also what a `/` that never reached the session
  // middleware at all would say, and the assertion below would hold for a
  // server with no session handling whatsoever.
  const seeded = await expireOf(SID_TOUCH);
  await shell();                      // whatever the interval owes, pay it here
  await idle(1300);
  const before = await expireOf(SID_TOUCH);
  ck('control: a request below the session middleware DOES write the row',
    before !== seeded, `expire moved by ${before - seeded}ms on the first request`);

  // The requests MUST be spaced over a second apart, and that is not padding.
  // `expire` has one-second resolution, so an unthrottled burst inside a single
  // second writes the same value every time and leaves the column unchanged —
  // this check passed against a server with the throttle removed until the
  // spacing was added, which is the whole "a fixture that compares equal to
  // itself" shape.
  for (let i = 0; i < 3; i++) {
    await shell();
    await idle(1300);
  }
  const after = await expireOf(SID_TOUCH);

  ck('requests below the session middleware write the row at most once per interval',
    after === before, `expire moved by ${after - before}ms across 3 spaced requests`);

  console.log(`\n${fails === 0 ? 'all checks passed' : `${fails} FAILED`}`);
} finally {
  await admin.query('DELETE FROM session WHERE sid = ANY($1)', [[SID, SID_TOUCH]])
    .catch(() => {});
  await admin.end().catch(() => {});
  child.kill('SIGKILL');
  srv.close();
}

process.exit(fails === 0 ? 0 : 1);
