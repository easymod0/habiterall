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
import { log } from '@habiterall/shared/log.js';

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
    // A warning, every start, on purpose: this is a development-only override
    // and an instance that has it on in production must be noisy about it.
    log.warn('oidc.insecure', {
      reason: 'ALLOW_INSECURE_OIDC is set — plaintext issuer accepted',
      production_safe: false,
    });
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
 * Pick what the chip shows: `name` -> `preferred_username` -> `email`.
 *
 * `name` is an optional claim of the `profile` scope, and Authentik only
 * emits it when the account's Name field has been filled in — a bootstrapped
 * admin, for instance, ships with no Name and no `name` claim at all.
 * `preferred_username` is the claim carrying what the personal edition calls
 * a username, and unlike `name` an IdP has one for every account, so it goes
 * ahead of email: cloud should read `mark` where personal would rather than
 * `mark@example.com`. A blank string counts as absent, hence the `.trim()`
 * check rather than a bare truthiness test.
 *
 * Not exported: the only thing that proves this chain actually reached the
 * chip is `GET /api/me`, not a unit test that pins the ordering and nothing
 * about the wiring that uses it.
 */
const displayName = (claims) => {
  for (const claim of ['name', 'preferred_username', 'email']) {
    const v = claims?.[claim];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};

/**
 * Complete login: exchange the code, validate the ID token, then map the
 * IdP subject onto a local user row.
 *
 * Returns the ID TOKEN alongside the user, because signing out needs it back.
 * `id_token_hint` is how the IdP knows whose session to end, and it is the only
 * copy we will ever be given — so the caller stores it on the session. Nothing
 * reads a claim out of it afterwards; it is carried, not trusted.
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

  const user = await upsertUser({
    subject: claims.sub,
    issuer: claims.iss,
    email: typeof claims.email === 'string' ? claims.email : null,
    name: displayName(claims),
  });

  // The issuer, never the subject or the email: identity here is
  // (issuer, subject) and the subject is a stable handle on a person. An
  // account id is enough to follow a session through the rest of the log.
  log.info('auth.login', { user: user.id, issuer: claims.iss, blocked: !!user.blocked });
  return { user, idToken: tokens.id_token ?? null };
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

/**
 * Build the IdP logout URL, so signing out here also ends the IdP session.
 *
 * The hint is not optional in practice, though the signature tolerates its
 * absence. Authentik's `EndSessionView` validates `id_token_hint` BEFORE it
 * plans the invalidation flow, so once a logout redirect URI is registered a
 * missing hint is an `id_token_hint_missing` error page — where before it was
 * merely a redirect that went nowhere. The two halves of that fix have to ship
 * together; see the redirect_uris comment in scripts/bootstrap-authentik.mjs.
 */
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
    // snapshot, which is the behaviour we had before this check existed. Worth a
    // line, though: it means suspensions are not being enforced right now.
    log.warn('auth.block_check_failed', { user: userId, fell_back_to: 'session snapshot' });
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
      // `mode` rides the 401 because a signed-OUT client needs it to know
      // whether to draw a form or a link, and this is the only response it can
      // get. Constant here; the personal edition's varies.
      return res.status(401).json({ error: 'authentication required', mode: 'oidc' });
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
      log.warn('auth.suspended', { user: user.id });
      req.session.destroy(() => {
        res.status(403).json({ error: 'account suspended' });
      });
    })
    .catch(next);
}
