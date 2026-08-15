/**
 * Optional password auth for the single-user edition.
 *
 * This edition shipped with no authentication at all, on the reasoning that it
 * belongs on your own machine or a LAN. It still runs that way — but "put it
 * behind your reverse proxy" turned out to be a poor answer for anyone using
 * the Android client, which speaks to the API directly and cannot fill in a
 * login form. So sign-in lives here, and the phone rides the same session
 * cookie the web UI does.
 *
 * Three states, resolved once at startup:
 *
 *   none      HABITERALL_AUTH=off. Every route is open, exactly as before.
 *   password  credentials exist, from the environment or the database.
 *   setup     auth is on and nobody has claimed the instance yet.
 *
 * **The default is ON.** `authEnabled` in shared/src/password.js treats
 * anything that is not exactly `off` as on, including every typo of it. The
 * failure being designed against is an instance put on the public internet with
 * a disable flag that did not take, whose only symptom is that everything works
 * for everyone.
 */

import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { log } from '@habiterall/shared/log.js';
import {
  authEnabled, authFlagMisread, envCredentials, hashPassword, verifyPassword,
} from '@habiterall/shared/password.js';

/* ---------- session secret ---------- */

/**
 * The key sessions are signed with.
 *
 * The cloud edition demands `SESSION_SECRET` and exits without it, which is
 * right for a multi-tenant deployment that already has a dozen variables to
 * set. Here it would be a config step standing between someone and a habit
 * tracker on their own machine — and the likeliest response to a startup error
 * about an unset secret is to paste in a guessable one.
 *
 * So it is generated and kept in the database. `HABITERALL_SESSION_SECRET`
 * still wins where an operator wants to hold it, which is what makes sessions
 * survive a database being restored onto a fresh instance.
 *
 * @returns {string}
 */
export function sessionSecret() {
  const supplied = (process.env.HABITERALL_SESSION_SECRET ?? '').trim();
  if (supplied) return supplied;

  const row = db.prepare("SELECT value FROM server_secrets WHERE key = 'session'").get();
  // node:sqlite types every column as SQLOutputValue; the schema says TEXT.
  if (row?.value) return String(row.value);

  const generated = randomBytes(32).toString('base64');
  db.prepare("INSERT INTO server_secrets (key, value) VALUES ('session', ?)").run(generated);
  log.info('auth.session_secret_generated', {
    stored_in: 'the database',
    hint: 'set HABITERALL_SESSION_SECRET to keep sessions valid across a rebuild',
  });
  return generated;
}

/* ---------- credential resolution ---------- */

const readRow = db.prepare('SELECT username, hash FROM auth_credentials WHERE id = 1');
const writeRow = db.prepare(
  `INSERT INTO auth_credentials (id, username, hash) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET username = excluded.username, hash = excluded.hash`
);

/**
 * Credentials from the environment, hashed if they arrived as plaintext.
 * Resolved once: hashing on every login attempt would be pointless work, and
 * the value cannot change without a restart anyway.
 * @type {{username: string, hash: string}|null}
 */
let fromEnv = null;

/** Whether auth is on at all, and whether the environment owns the password. */
export const state = {
  enabled: authEnabled(process.env.HABITERALL_AUTH),
  /** True when credentials come from the environment, so the UI cannot change them. */
  managed: false,
};

/**
 * Resolve credentials. Called once at startup, before the server listens.
 *
 * The environment WINS over the database. Two sources of truth for one
 * credential is how an operator changes a password in the UI, redeploys the
 * container, and silently gets the old one back — with no error anywhere.
 */
export async function initAuth() {
  if (!state.enabled) {
    log.warn('auth.disabled', {
      reason: 'HABITERALL_AUTH=off',
      consequence: 'every API route is open to anyone who can reach this port',
    });
    return;
  }

  // A value that was clearly meant to disable auth but is not the one accepted
  // word. Failing safe silently is correct and undebuggable; say so.
  if (authFlagMisread(process.env.HABITERALL_AUTH)) {
    log.warn('auth.flag_not_understood', {
      given: process.env.HABITERALL_AUTH,
      consequence: 'authentication stayed ON — the only value that disables it is "off"',
    });
  }

  const env = envCredentials(process.env);
  if (env) {
    fromEnv = {
      username: env.username,
      hash: env.hash ?? await hashPassword(env.plain),
    };
    state.managed = true;
    if (!env.hash) {
      // Worth one line: a plaintext password is visible to `docker inspect`
      // and to anything that dumps the environment.
      log.info('auth.env_password_hashed', {
        hint: 'set HABITERALL_PASSWORD_HASH instead to keep plaintext out of the environment',
      });
    }
    return;
  }

  if (!credentials()) {
    // Deliberately unguarded, at the operator's request: the first person to
    // reach the setup form claims the instance. Say it loudly and every start,
    // because the window is open until someone closes it.
    log.warn('auth.setup_pending', {
      reason: 'no credentials in the environment or the database',
      consequence: 'ANYONE who can reach this server can claim the account at /auth/setup',
      fix: 'complete setup now, or set HABITERALL_USERNAME and HABITERALL_PASSWORD',
    });
  }
}

/** The active credentials, environment first. @returns {{username,hash}|null} */
function credentials() {
  if (fromEnv) return fromEnv;
  const row = readRow.get();
  return row ? { username: String(row.username), hash: String(row.hash) } : null;
}

/**
 * Which of the four modes the frontend should render.
 * @returns {'none'|'password'|'setup'}
 */
export function mode() {
  if (!state.enabled) return 'none';
  return credentials() ? 'password' : 'setup';
}

/* ---------- middleware ---------- */

/**
 * Reject anything without a session, unless auth is off.
 *
 * Mirrors the cloud edition's `requireAuth`, including the rule that anything
 * under /api gets a 401 it can act on rather than a redirect: the browser's
 * fetch sends an Accept header that matches anything, so content negotiation
 * alone would send an XHR to a login page and hand HTML to a JSON parser. The Android client depends on
 * the same 401 — it is what tells it to prompt for sign-in rather than to
 * report the server as broken.
 *
 * The body carries `mode`, because a signed-out client needs to know whether to
 * draw a form or a link, and this is the only response it can get.
 */
export function requireAuth(req, res, next) {
  if (!state.enabled) return next();
  if (req.session?.user) return next();

  if (req.path.startsWith('/api') || req.originalUrl.startsWith('/api')) {
    return res.status(401).json({ error: 'authentication required', mode: mode() });
  }
  return res.redirect('/');
}

/* ---------- routes ---------- */

/**
 * Mount the auth routes.
 *
 * @param {import('express').Express} app
 * @param {import('express').RequestHandler} limiter guards the credential paths
 * @param {import('express').RequestHandler} readLimiter guards /api/me, which
 *   is answerable without a session and reads the database to decide the mode
 */
export function mountAuth(app, limiter, readLimiter) {
  /**
   * Who am I, and what mode is this instance in?
   *
   * Answers WITHOUT a session when auth is off — that is the whole point of the
   * endpoint, and it is what lets one frontend adapter serve every mode.
   */
  // `readLimiter` because this route sits ABOVE the /api mount and would
  // otherwise be the one API path with no limit at all — answerable with no
  // session, and reading the credentials table on every call to decide the mode.
  app.get('/api/me', readLimiter, (req, res) => {
    const current = mode();
    if (current === 'none') {
      // The same implicit user the edition has always had.
      return res.json({ id: 0, name: '', email: '', mode: current });
    }
    if (!req.session?.user) {
      return res.status(401).json({ error: 'authentication required', mode: current });
    }
    return res.json({
      id: 0,
      name: req.session.user.username,
      email: '',
      mode: current,
      // The settings dialog hides the change-password control when the
      // environment owns the credential, rather than offering a change that
      // would be silently undone by the next restart.
      managed: state.managed,
    });
  });

  app.post('/auth/login', limiter, async (req, res, next) => {
    try {
      if (!state.enabled) return res.status(404).json({ error: 'authentication is disabled' });

      const creds = credentials();
      if (!creds) return res.status(409).json({ error: 'this instance has no account yet' });

      const { username = '', password = '' } = req.body ?? {};
      const ok = username === creds.username && await verifyPassword(password, creds.hash);

      if (!ok) {
        // One message for both halves: telling a stranger the username was
        // right narrows their search to the password alone.
        log.warn('auth.login_failed', { ip: req.ip });
        return res.status(401).json({ error: 'Incorrect username or password.' });
      }

      // Prevent session fixation: a brand-new id for the authenticated session.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.user = { username: creds.username };
        req.session.save((err2) => {
          if (err2) return next(err2);
          log.info('auth.login', { user: creds.username });
          res.json({ ok: true });
        });
      });
    } catch (e) { next(e); }
  });

  /**
   * Claim an unconfigured instance.
   *
   * Unguarded by design — no setup token, no source-address check — so whoever
   * reaches it first owns the account. It closes the moment credentials exist,
   * and `initAuth` warns at every startup while it is open.
   */
  app.post('/auth/setup', limiter, async (req, res, next) => {
    try {
      if (!state.enabled) return res.status(404).json({ error: 'authentication is disabled' });
      if (credentials()) {
        return res.status(409).json({ error: 'this instance already has an account' });
      }

      const { username = '', password = '' } = req.body ?? {};
      const name = String(username).trim();

      if (name.length < 1 || name.length > 64) {
        return res.status(400).json({ error: 'Choose a username of 1 to 64 characters.' });
      }
      if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Choose a password of at least 8 characters.' });
      }

      writeRow.run(name, await hashPassword(password));
      log.info('auth.setup_complete', { user: name });

      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.user = { username: name };
        req.session.save((err2) => (err2 ? next(err2) : res.json({ ok: true })));
      });
    } catch (e) { next(e); }
  });

  app.post('/auth/logout', (req, res) => {
    // `redirect` so one frontend handles both editions: the cloud edition
    // returns the IdP's end-session URL here, and this one has nowhere to go.
    if (!req.session) return res.json({ redirect: '/' });
    req.session.destroy(() => res.json({ redirect: '/' }));
  });
}
