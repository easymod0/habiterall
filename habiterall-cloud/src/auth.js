/**
 * OIDC authentication against an external identity provider (Authentik by
 * default, but any OIDC-compliant provider works).
 *
 * Design notes:
 *  - We never see or store passwords. The IdP owns credentials, MFA, and
 *    password resets.
 *  - The browser holds an opaque session cookie, not a JWT. Tokens stay
 *    server-side, so XSS cannot exfiltrate a bearer credential, and sessions
 *    can be revoked instantly by deleting the row.
 *  - The user record is keyed on (issuer, subject), never on email: emails
 *    change and can be reassigned, subjects are stable.
 */

import * as client from 'openid-client';
import { withUser, withoutUser } from './db/pool.js';

const {
  OIDC_ISSUER,
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET,
  PUBLIC_URL,
} = process.env;

let config = null;

/** Discover the IdP's endpoints. Called once at startup. */
export async function initAuth() {
  if (!OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET) {
    throw new Error(
      'OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be set'
    );
  }
  const issuer = new URL(OIDC_ISSUER);

  // openid-client refuses plaintext HTTP issuers, which is the right default:
  // tokens over HTTP are interceptable. Permit it only when the operator has
  // explicitly opted in, which the shipped .env.example never does.
  const optedIn = process.env.ALLOW_INSECURE_OIDC === 'true';
  const allowInsecure = issuer.protocol === 'http:' && optedIn;

  if (issuer.protocol === 'http:' && !allowInsecure) {
    throw new Error(
      `OIDC_ISSUER uses plaintext http (${issuer.origin}), which would expose ` +
      'tokens in transit. Terminate TLS at your reverse proxy and use its ' +
      'https URL. For a local test stack only, set ALLOW_INSECURE_OIDC=true.'
    );
  }

  config = await client.discovery(
    issuer,
    OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET,
    undefined,
    allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined
  );

  if (allowInsecure) {
    console.warn('WARNING: OIDC over plaintext HTTP — development only');
  }
  return config;
}

const redirectUri = () => new URL('/auth/callback', PUBLIC_URL).href;

/**
 * Begin login. PKCE plus a state value defends against interception and
 * CSRF on the callback; both are stashed in the session, never in the URL
 * alone.
 */
export async function beginLogin(req) {
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  req.session.oidc = { codeVerifier, state, nonce };

  return client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    scope: 'openid profile email',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  }).href;
}

/**
 * Complete login: exchange the code, validate the ID token, then map the
 * IdP subject onto a local user row.
 */
export async function completeLogin(req) {
  const pending = req.session.oidc;
  if (!pending) throw Object.assign(new Error('no login in progress'), { status: 400 });

  const currentUrl = new URL(req.originalUrl, PUBLIC_URL);
  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: pending.codeVerifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });

  const claims = tokens.claims();
  delete req.session.oidc;

  // Both halves of the identity must be present. OIDC only guarantees `sub`
  // is unique WITHIN an issuer, so a subject without its issuer is ambiguous
  // and must never be used to look up an account.
  if (!claims?.sub) {
    throw Object.assign(new Error('IdP returned no subject'), { status: 401 });
  }
  if (!claims?.iss) {
    throw Object.assign(new Error('IdP returned no issuer'), { status: 401 });
  }

  return upsertUser({
    subject: claims.sub,
    issuer: claims.iss,
    email: typeof claims.email === 'string' ? claims.email : null,
    name: typeof claims.name === 'string' ? claims.name : '',
  });
}

/**
 * Find or create the local user for an IdP identity.
 *
 * Runs without a user context because we do not yet know the user id — this
 * is one of the few legitimate RLS bypasses, and it only ever touches the
 * single row matching the verified subject.
 */
async function upsertUser({ subject, issuer, email, name }) {
  return withoutUser(async (db) => {
    // provision_user is SECURITY DEFINER and is the only path that may create
    // a user row — see migration 003. The app role holds no INSERT privilege
    // on `users`, so this cannot be worked around from application code.
    const { rows } = await db.query(
      `SELECT * FROM provision_user($1, $2, $3, $4)`,
      [subject, issuer, email, name]
    );
    return rows[0];
  });
}

/** Build the IdP logout URL, so signing out here also ends the IdP session. */
export function logoutUrl(idTokenHint) {
  try {
    return client.buildEndSessionUrl(config, {
      post_logout_redirect_uri: new URL('/', PUBLIC_URL).href,
      ...(idTokenHint ? { id_token_hint: idTokenHint } : {}),
    }).href;
  } catch {
    return new URL('/', PUBLIC_URL).href; // provider has no end-session endpoint
  }
}

/* ---------- middleware ---------- */

/**
 * How long a `blocked` lookup is trusted before being re-read, in ms.
 *
 * Suspension has to actually take effect, but re-reading `users` on every
 * request would add a query to the hot path for a column that changes almost
 * never. A minute bounds the window an abusive account keeps working while
 * keeping the cost negligible.
 */
const BLOCK_CHECK_MS = 60_000;

/** userId -> {blocked, at}. Small and bounded by the number of live users. */
const blockCache = new Map();

/**
 * Is this account suspended, according to the database?
 *
 * `req.session.user.blocked` is a snapshot taken at login, and sessions here
 * are `rolling` with a 14-day lifetime — so a session that renews on every
 * request would keep a suspended user working indefinitely. Setting
 * `blocked = true` did nothing until they chose to log out, which is the one
 * thing that flag exists to prevent.
 */
async function isBlocked(userId) {
  const hit = blockCache.get(userId);
  if (hit && Date.now() - hit.at < BLOCK_CHECK_MS) return hit.blocked;

  try {
    // withUser, NOT withoutUser: the policy on `users` is self-scoped, so
    // clearing `app.user_id` makes the row invisible and the query returns
    // nothing. Reading that as "user vanished" would have locked out every
    // legitimate session — a far worse bug than the one this fixes.
    const { rows } = await withUser(userId, (db) =>
      db.query('SELECT blocked FROM users WHERE id = $1', [userId])
    );
    // A vanished user is not a valid session.
    const blocked = rows.length === 0 ? true : rows[0].blocked === true;
    blockCache.set(userId, { blocked, at: Date.now() });
    return blocked;
  } catch {
    // Database trouble must not lock everyone out; fall back to the session
    // snapshot, which is the behaviour we had before this check existed.
    return hit?.blocked ?? false;
  }
}

/** Drop a cached decision so a suspension takes effect immediately. */
export function forgetBlockState(userId) {
  blockCache.delete(userId);
}

/** Reject anything that is not an authenticated, non-blocked session. */
export function requireAuth(req, res, next) {
  const user = req.session?.user;
  if (!user?.id) {
    // Anything under /api is a programmatic caller and must get a 401 it can
    // act on. Browser fetch() sends `Accept: */*`, so negotiating on the
    // header alone would wrongly redirect an XHR to the login page.
    if (req.path.startsWith('/api') || req.originalUrl.startsWith('/api')) {
      return res.status(401).json({ error: 'authentication required' });
    }
    return res.redirect('/auth/login');
  }
  // The login-time snapshot still short-circuits, so a user blocked at login
  // never reaches the database at all.
  if (user.blocked) {
    return res.status(403).json({ error: 'account suspended' });
  }

  isBlocked(user.id)
    .then((blocked) => {
      if (!blocked) return next();
      // Destroy the session too, so the suspension survives the cache window
      // and the user is not left in a half-authenticated state.
      req.session.destroy(() => {
        res.status(403).json({ error: 'account suspended' });
      });
    })
    .catch(next);
}
