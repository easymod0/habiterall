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
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { db } from './db.js';
import { log } from '@habiterall/shared/log.js';
import {
  authEnabled, authFlagMisread, envCredentials, hashPassword, verifyPassword,
} from '@habiterall/shared/password.js';
import { RATE_LIMITS } from '@habiterall/shared/security.js';

/**
 * The limiter on the credential routes, built HERE rather than handed in.
 *
 * It was a parameter, which made it invisible: the caller could pass anything,
 * including the pass-through `HABITERALL_RATE_LIMIT=off` produces — and it did,
 * so the one bound on guesses at a single shared password could be switched off
 * by a variable named for throttling reads. CodeQL flagged the route as
 * unlimited for the same reason a reader would miss it, which is the useful
 * part: a limit you cannot see at the route it protects is a limit nobody can
 * check.
 *
 * `ipKeyGenerator` normalises IPv6 to its /56, so a whole residential
 * allocation shares one bucket. Without it every address in that allocation is
 * its own bucket with twenty guesses in it.
 */
const credentialLimiter = rateLimit({
  ...RATE_LIMITS.login,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
});

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
/**
 * Claim the single credential row, or do nothing if it is already taken.
 *
 * `DO NOTHING` rather than `DO UPDATE`: an upsert here is a password reset for
 * whoever reaches it, and the only caller is the route that claims an
 * *unclaimed* instance. `changes` is how that caller learns it lost the race.
 */
const claimRow = db.prepare(
  `INSERT INTO auth_credentials (id, username, hash) VALUES (1, ?, ?)
     ON CONFLICT(id) DO NOTHING`
);

/**
 * The same row, written unconditionally. Only `adoptEnvCredential` may use it —
 * an upsert reachable from a route is a password reset for whoever reaches it,
 * which is the whole reason `claimRow` above says DO NOTHING.
 */
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

/**
 * The plaintext `HABITERALL_PASSWORD`, when one was supplied.
 *
 * Held only so `syncCredential` can ask scrypt whether it still matches the
 * stored hash — a fresh hash of it differs on every boot, so string equality
 * cannot answer that question.
 * @type {string|null}
 */
let envPlaintext = null;

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
    // Both password variables set. The hash wins — see `envCredentials` — and
    // that is worth a line, because the losing plaintext is the one an operator
    // is more likely to have just edited.
    if (env.ambiguous) {
      log.warn('auth.env_password_ambiguous', {
        reason: 'HABITERALL_PASSWORD and HABITERALL_PASSWORD_HASH are both set',
        consequence: 'the HASH is the password; the plaintext is ignored entirely',
        fix: 'unset whichever of the two is not the one you meant',
      });
    }
    envPlaintext = env.plain;
    fromEnv = {
      username: env.username,
      hash: env.hash ?? await hashPassword(env.plain),
    };
    state.managed = true;
    await adoptEnvCredential();
    await syncCredential();
    if (!env.hash) {
      // Worth one line: a plaintext password is visible to `docker inspect`
      // and to anything that dumps the environment.
      log.info('auth.env_password_hashed', {
        hint: 'set HABITERALL_PASSWORD_HASH instead to keep plaintext out of the environment',
      });
    }
    return;
  }

  await syncCredential();

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

/**
 * Write the environment's credential into the database row it masks.
 *
 * `credentials()` prefers the environment, which is enough to refuse a stale
 * password *while the variables are set* — and that turned out to be the shorter
 * half of the documented remedy. A stranger who claims an unguarded instance
 * leaves their username and hash in `auth_credentials` forever; setting
 * HABITERALL_USERNAME and HABITERALL_PASSWORD only masked it, so the day the
 * variables went away — a compose edit, a `docker run` without `--env-file`, the
 * volume restored somewhere else — `credentials()` fell back to the stranger's
 * row and their password worked again. Silently, and with no control anywhere
 * that could have removed it.
 *
 * So the environment OVERWRITES rather than shadows. Deleting the row instead
 * would close the same hole and open a worse one: with no credential at all,
 * dropping the variables reopens the unguarded setup window on an instance that
 * had an account, and anyone who can reach the port claims it. Overwriting
 * leaves the operator's own credential behind, which is the answer that costs
 * nothing when the masking ends.
 *
 * Written only when it differs, or a plaintext password — re-salted on every
 * boot — would rewrite the row at every start. That comparison is a second
 * scrypt per boot beside `syncCredential`'s, about thirty milliseconds, once,
 * before the server listens.
 */
async function adoptEnvCredential() {
  if (!fromEnv) return;

  const row = readRow.get();
  const stored = row ? { username: String(row.username), hash: String(row.hash) } : null;

  if (stored?.username === fromEnv.username) {
    // For a plaintext, ask scrypt — string equality cannot answer it. For a
    // supplied hash, the string IS the credential and equality is exact.
    const same = envPlaintext
      ? await verifyPassword(envPlaintext, stored.hash)
      : stored.hash === fromEnv.hash;
    if (same) return;
  }

  writeRow.run(fromEnv.username, fromEnv.hash);

  if (stored) {
    log.warn('auth.env_credential_adopted', {
      reason: 'HABITERALL_USERNAME/HABITERALL_PASSWORD differ from the stored account',
      consequence: `the database account "${stored.username}" was replaced and can no longer sign in`,
    });
  }
}

/**
 * A random token that changes whenever the active credential does.
 *
 * A session carries the epoch it was created under; `requireAuth` compares it,
 * and `syncCredential` mints a new one — dropping every session — the moment the
 * credential stops matching what was last seen. Without that, a session outlives
 * the credential that authorised it: the documented remedy for the unguarded
 * setup route ("set HABITERALL_USERNAME and HABITERALL_PASSWORD to close it")
 * refused the stranger's PASSWORD while their COOKIE kept full read and write
 * for another fourteen days.
 *
 * An opaque random token rather than a digest of the credential, and that is the
 * second attempt. The first fingerprinted the credential's source material,
 * which for `HABITERALL_PASSWORD` is the plaintext — an unsalted, fast digest of
 * a password sitting in the database beside the key it was made with, which is
 * exactly the offline-guessing shortcut scrypt exists to deny. Nothing derived
 * from the password appears here now.
 *
 * @returns {string} '' before the first sync
 */
function credentialEpoch() {
  return String(readSecret(EPOCH_KEY) ?? '');
}

/**
 * Notice a changed credential, and evict every session when it has.
 *
 * The comparison cannot be `hash === storedHash` for a plaintext password: it is
 * re-salted on every boot, so that reported a change at every restart and logged
 * everybody out for nothing. `verifyPassword` against the stored hash is the
 * right question — the same scrypt the login route runs, once per start.
 *
 * Credentials only change across a restart (the environment) or once, at setup,
 * so this runs at exactly those two moments. It is deliberately blunt: there is
 * one account here, so "some sessions survive" is not a state worth keeping.
 */
async function syncCredential() {
  const active = credentials();
  const stored = String(readSecret(CRED_KEY) ?? '');
  const [storedUser, storedHash] = splitStored(stored);

  let unchanged;
  if (!active) {
    unchanged = stored === '';
  } else if (storedUser !== active.username || !storedHash) {
    unchanged = false;
  } else if (envPlaintext) {
    unchanged = await verifyPassword(envPlaintext, storedHash);
  } else {
    unchanged = storedHash === active.hash;
  }
  if (unchanged) return;

  writeSecret(CRED_KEY, active ? `${active.username}\u0000${active.hash}` : '');
  writeSecret(EPOCH_KEY, randomBytes(16).toString('base64url'));

  const { changes } = db.prepare('DELETE FROM sessions').run();
  if (stored !== '' && changes > 0) {
    log.warn('auth.sessions_evicted', {
      reason: 'the active credential changed since the last start',
      sessions: changes,
    });
  }
}

/** `username\0hash` -> the two halves, or empty strings. */
function splitStored(value) {
  const at = value.indexOf('\u0000');
  return at === -1 ? ['', ''] : [value.slice(0, at), value.slice(at + 1)];
}

const CRED_KEY = 'credential';
const EPOCH_KEY = 'credential_epoch';

const readSecretStmt = db.prepare('SELECT value FROM server_secrets WHERE key = ?');
const writeSecretStmt = db.prepare(
  `INSERT INTO server_secrets (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

const readSecret = (key) => readSecretStmt.get(key)?.value ?? null;
const writeSecret = (key, value) => writeSecretStmt.run(key, value);


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

  const user = req.session?.user;
  if (user) {
    // A session is only valid against the credential it was created under.
    // `evictStaleSessions` already clears the store when that changes across a
    // restart; this is the same rule enforced per request, so a session cannot
    // outlive its credential inside one process either.
    if (user.cred === credentialEpoch()) return next();
    return req.session.destroy(() => res.status(401).json({
      error: 'authentication required', mode: mode(),
    }));
  }

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
 * @param {import('express').RequestHandler} readLimiter guards /api/me, which
 *   is answerable without a session and reads the database to decide the mode
 */
export function mountAuth(app, readLimiter) {
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
    // The same two questions `requireAuth` asks, and for the same reason. This
    // route sits ABOVE the /api mount, so it is the one place a session is read
    // without that middleware — and it used to check only that one existed.
    // A session revoked by a credential change therefore got a 200 here naming
    // the account it no longer had, while every other route 401'd: `load()`
    // returned a user, `start()` painted the signed-in shell, and the first
    // dashboard fetch threw it away again. It also handed the previous
    // account's username back to a cookie that had just been revoked.
    const user = req.session?.user;
    if (!user) {
      return res.status(401).json({ error: 'authentication required', mode: current });
    }
    if (user.cred !== credentialEpoch()) {
      return req.session.destroy(() => res.status(401).json({
        error: 'authentication required', mode: current,
      }));
    }
    return res.json({
      id: 0,
      name: user.username,
      email: '',
      mode: current,
      // Whether the environment owns the credential. There is no
      // change-password control yet — this said there was — but the fact is
      // worth reporting either way: when it is true, the password can only be
      // changed by editing the environment and restarting, and a control that
      // wrote to the database would be silently undone by that restart.
      managed: state.managed,
    });
  });

  app.post('/auth/login', credentialLimiter, async (req, res, next) => {
    try {
      if (!state.enabled) return res.status(404).json({ error: 'authentication is disabled' });

      const creds = credentials();
      if (!creds) return res.status(409).json({ error: 'this instance has no account yet' });

      const { username = '', password = '' } = req.body ?? {};

      // Both halves are checked BEFORE they are combined. `&&` short-circuits,
      // so a wrong username used to skip scrypt entirely and answer in about a
      // millisecond where a wrong password took thirty — telling a stranger the
      // username was right just as loudly as a different message would have,
      // and making the claim below true only of the words.
      const passwordOk = await verifyPassword(password, creds.hash);
      const ok = username === creds.username && passwordOk;

      if (!ok) {
        // One message for both halves: telling a stranger the username was
        // right narrows their search to the password alone.
        log.warn('auth.login_failed', { ip: req.ip });
        return res.status(401).json({ error: 'Incorrect username or password.' });
      }

      // Prevent session fixation: a brand-new id for the authenticated session.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.user = { username: creds.username, cred: credentialEpoch() };
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
  app.post('/auth/setup', credentialLimiter, async (req, res, next) => {
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

      // Hash FIRST, then let the insert itself decide who won.
      //
      // This was a check-then-write with an upsert, and `await hashPassword` sat
      // between the two — about 30ms of event loop during which a second request
      // passed the same check. Both wrote; the later one won; the legitimate
      // owner was locked out of their own instance with a 200 in hand. The
      // window is only reachable on an unclaimed instance, which is exactly the
      // state the setup route exists for.
      //
      // `DO NOTHING` and `changes` make the claim atomic: node:sqlite is
      // synchronous, so between the hash and the insert there is no await for
      // anyone else to run in. Whoever gets there second is told so.
      const hash = await hashPassword(password);
      const claimed = claimRow.run(name, hash);

      if (claimed.changes === 0) {
        return res.status(409).json({ error: 'this instance already has an account' });
      }
      await syncCredential();
      log.info('auth.setup_complete', { user: name });

      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.user = { username: name, cred: credentialEpoch() };
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
