/**
 * Which claim names the account, all the way to `GET /api/me`.
 *
 * This boots the REAL `src/server.js` and drives a real OIDC callback against
 * a fake identity provider, because the thing under test is whether a mapping
 * change inside `completeLogin` actually reaches the response body — a unit
 * test on the mapping function alone would pin the ordering and nothing about
 * the wiring that uses it. See `healthz.integration.mjs`'s header for the
 * fuller version of this argument; its `fakeIssuer()` and `boot()` are what
 * this file extends.
 *
 * The chip falls back through `name -> preferred_username -> email`
 * (`habiterall-cloud/src/auth.js`), because `name` is an optional claim of the
 * `profile` scope that Authentik only emits when the account's Name field is
 * filled, while `preferred_username` exists for every account. Eight cases
 * below walk that chain end to end, through a real login, rather than
 * trusting the function that decides it.
 *
 *   DATABASE_URL=... ADMIN_URL=... node test/login-claims.integration.mjs
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';

process.env.ADMIN_URL ??= 'postgres://owner:testpw@localhost:5432/habiterall';
process.env.DATABASE_URL ??= 'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';

const admin = new pg.Client({ connectionString: process.env.ADMIN_URL });

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

const b64url = (input) => Buffer.from(input).toString('base64url');

/** Sign a JWT with `node:crypto` alone — no dependency on `jose`. */
function signJwt(privateKey, kid, payload) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${head}.${body}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * A fake IdP: discovery document, a JWKS endpoint, and a token endpoint that
 * answers whatever the next `login()` call armed it with. It does not verify
 * the code or PKCE — `openid-client` verifies its own code_verifier against
 * the challenge it sent, so the fake has nothing to check on this side.
 */
async function fakeIssuer() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

  let base;
  let armed = null; // { sub, nonce, extra }

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
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code'],
      }));
    }
    if (req.url.startsWith('/jwks')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    if (req.url.startsWith('/token') && req.method === 'POST') {
      // The code and PKCE verifier are not read: the client validates its own
      // verifier against the challenge it generated, and nothing here can see
      // it. What this test controls is the ID token's claims.
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const now = Math.floor(Date.now() / 1000);
        const idToken = signJwt(privateKey, kid, {
          iss: base,
          aud: 'test-client',
          sub: armed.sub,
          exp: now + 300,
          iat: now,
          nonce: armed.nonce,
          ...armed.extra,
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          access_token: 'test-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        }));
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  base = `http://127.0.0.1:${srv.address().port}`;

  return { srv, base, arm: (sub, extra) => { armed = { sub, nonce: extra.nonce, extra }; } };
}

const idle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Copied from `healthz.integration.mjs`'s `boot()` — same env block, same poll. */
async function boot(issuer, port) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port),
      SESSION_SECRET: 'login-claims-integration-secret',
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
  // Nobody is going to reach the `finally` below for this child: the call site
  // awaits `boot()` above its own try/finally, so a timeout here has to kill
  // what it spawned itself or it leaks a `src/server.js` nobody can reach.
  child.kill('SIGKILL');
  throw new Error('server never became ready');
}

const { srv, base: issuer, arm } = await fakeIssuer();
// healthz uses the 3400+ band and the local dev stack holds 3100; stay clear of both.
const port = 3600 + (process.pid % 200);
// This sits above the try/finally below, so a boot timeout has to close the
// fake issuer itself here or that listening socket outlives the process too.
const { child, base } = await boot(issuer, port).catch((e) => { srv.close(); throw e; });

/**
 * The whole login flow, from `/auth/login` to a decoded `/api/me`.
 *
 * `sub` is the OIDC subject; `extraClaims` is whatever the case wants the ID
 * token to carry besides the mandatory ones (`iss`, `aud`, `sub`, `exp`,
 * `iat`, `nonce`), e.g. `{ name: 'Ada Lovelace' }`.
 */
async function login(sub, extraClaims = {}) {
  const started = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  // Consume the body before reading Set-Cookie: express-session's res.end
  // patch can flush the redirect's headers synchronously, ahead of the
  // session-save callback that actually persists the row to Postgres, so a
  // back-to-back /auth/login -> /auth/callback pair here can race ahead of
  // the store write in a way a real browser's navigation never approaches.
  // Waiting on the full response is what waits on that save.
  await started.text();
  const cookie = started.headers.getSetCookie()[0].split(';')[0];
  const loc = new URL(started.headers.get('location'));
  const state = loc.searchParams.get('state');
  const nonce = loc.searchParams.get('nonce');

  arm(sub, { ...extraClaims, nonce });

  const callback = await fetch(
    `${base}/auth/callback?code=anything&state=${encodeURIComponent(state)}`,
    { headers: { cookie }, redirect: 'manual' },
  );
  if (callback.status !== 302) {
    return { status: callback.status, body: await callback.text().catch(() => '') };
  }
  const cookie2 = callback.headers.getSetCookie()[0].split(';')[0];

  const me = await fetch(`${base}/api/me`, { headers: { cookie: cookie2 } });
  const body = await me.json().catch(() => ({}));
  return { status: me.status, body };
}

try {
  await admin.connect();
  await admin.query(`DELETE FROM users WHERE idp_subject LIKE 'claims-%'`);

  console.log('--- the claim chain, through a real callback ---');

  {
    const { status, body } = await login('claims-name', { name: 'Ada Lovelace' });
    ck('case 1 (name only): 200', status === 200, `-> ${status}`);
    ck('case 1 (name only): the first branch still works',
      body.name === 'Ada Lovelace', `-> ${JSON.stringify(body.name)}`);
  }

  {
    const { status, body } = await login('claims-username', { preferred_username: 'alovelace' });
    ck('case 2 (preferred_username only): 200', status === 200, `-> ${status}`);
    ck('case 2 (preferred_username only): the reported bug',
      body.name === 'alovelace', `-> ${JSON.stringify(body.name)}`);
  }

  {
    const { status, body } = await login('claims-order', {
      name: 'Ada Lovelace',
      preferred_username: 'alovelace',
      email: 'ada.l@example.com',
    });
    ck('case 3 (all three): 200', status === 200, `-> ${status}`);
    ck('case 3 (all three): the order is name -> preferred_username -> email',
      body.name === 'Ada Lovelace', `-> ${JSON.stringify(body.name)}`);
  }

  {
    const { status, body } = await login('claims-email', { email: 'ada.l@example.com' });
    ck('case 4 (email only): 200', status === 200, `-> ${status}`);
    ck('case 4 (email only): the third resort',
      body.name === 'ada.l@example.com', `-> ${JSON.stringify(body.name)}`);
  }

  {
    const { status, body } = await login('claims-none', {});
    ck('case 5 (none of the three): 200', status === 200, `-> ${status}`);
    ck("case 5 (none of the three): the chip's own fallback is what fires",
      body.name === '', `-> ${JSON.stringify(body.name)}`);
  }

  {
    await admin.query(
      `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
       VALUES ('claims-existing', $1, NULL, '')`,
      [issuer],
    );
    const { status, body } = await login('claims-existing', { preferred_username: 'alovelace' });
    ck('case 6 (existing blank row): 200', status === 200, `-> ${status}`);
    ck('case 6 (existing blank row): existing rows self-correct, no backfill',
      body.name === 'alovelace', `-> ${JSON.stringify(body.name)}`);
  }

  {
    const { status, body } = await login('claims-blank-name', {
      name: '   ',
      preferred_username: 'alovelace',
    });
    ck('case 7 (blank name): 200', status === 200, `-> ${status}`);
    ck('case 7 (blank name): a blank claim is an absent claim',
      body.name === 'alovelace', `-> ${JSON.stringify(body.name)}`);
  }

  {
    const { status, body } = await login('claims-username-vs-email', {
      preferred_username: 'alovelace',
      email: 'ada.l@example.com',
    });
    ck('case 8 (username vs email): 200', status === 200, `-> ${status}`);
    ck('case 8 (username vs email): preferred_username outranks the address',
      body.name === 'alovelace', `-> ${JSON.stringify(body.name)}`);
  }

  console.log(`\n${fails === 0 ? 'all checks passed' : `${fails} FAILED`}`);
} finally {
  await admin.query(`DELETE FROM users WHERE idp_subject LIKE 'claims-%'`).catch(() => {});
  await admin.end().catch(() => {});
  child.kill('SIGKILL');
  srv.close();
}

process.exit(fails === 0 ? 0 : 1);
