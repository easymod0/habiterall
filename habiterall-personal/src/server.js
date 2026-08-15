import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { api } from './api.js';
import { db } from './db.js';
import { SqliteStore } from './session-store.js';
import {
  initAuth, mountAuth, requireAuth, mode, sessionSecret, state as authState,
} from './auth.js';
import { start as startNotifier } from './notifier.js';
import { log } from '@habiterall/shared/log.js';
import { logStartup, requestLog, watchRuntime } from '@habiterall/shared/observe.js';
import {
  cspDirectives, HSTS, SESSION_NAME, SESSION_COOKIE, RATE_LIMITS, trustProxy,
  sameOriginOnly,
} from '@habiterall/shared/security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

// A `Secure` cookie is discarded by the browser over plaintext HTTP, which
// would silently break login. Derive it from the scheme actually in use rather
// than from NODE_ENV, so an http:// LAN instance still works while any https://
// deployment gets Secure cookies automatically.
//
// Both names, in the order `notify-send.js` already reads them: this edition's
// own variable is HABITERALL_PUBLIC_URL, and PUBLIC_URL is cloud's. Reading only
// the latter here would mean an operator who set the documented one got a
// non-Secure cookie behind TLS — which fails as "login does not work", with the
// reason nowhere in sight.
const publicUrl = process.env.HABITERALL_PUBLIC_URL ?? process.env.PUBLIC_URL ?? '';
const publicIsHttps = publicUrl.startsWith('https://');

// Opt-in, not derived. `upgrade-insecure-requests` tells the browser to rewrite
// every http request to https, which is right for an instance that is only ever
// reached over TLS and fatal for one that is not — and this process cannot tell
// which it is. A self-hosted box is commonly both: https from outside, plain
// http from the LAN, with the same database behind them. Guessing from
// PUBLIC_URL would break the LAN half of exactly that setup, so it is off unless
// asked for.
const upgradeInsecure = (process.env.HABITERALL_UPGRADE_INSECURE ?? '')
  .trim().toLowerCase() === 'on';

const app = express();

// First, so every later line can carry the request id and every response
// carries it back.
app.use(requestLog(log));

// How many reverse proxies sit in front of the app — see `trustProxy` in
// shared/src/security.js for why getting this wrong is a security bug in both
// directions. It matters more here than it looks: with one shared account the
// rate limiters key on IP alone, so a wrong setting either collapses every
// caller into one bucket or lets a header spoof the login limit away.
app.set('trust proxy', trustProxy(process.env.TRUST_PROXY));

app.use(helmet({
  contentSecurityPolicy: { directives: cspDirectives(upgradeInsecure) },
  hsts: isProd ? HSTS : false,
}));

// Imports arrive as raw bytes (JSON backup, SQLite file, or zip), so this must
// be registered before the JSON parser to keep the body unparsed.
app.use('/api/import', express.raw({ type: '*/*', limit: '64mb' }));

app.use(express.json({ limit: '1mb' }));
const SHARED_PUBLIC = join(__dirname, '..', '..', 'shared', 'public');

// This edition's own files (just the entry point) take precedence, then the
// shared UI — index.html, style.css, app.js, charts, the PWA assets. The
// whole interface lives in shared/ so a fix lands in both editions at once.
app.use(express.static(join(__dirname, '..', 'public')));
app.use(express.static(SHARED_PUBLIC));
app.use('/shared', express.static(SHARED_PUBLIC));

// A service worker may only control pages at or below its own path, so it has
// to be served from the origin root even though it lives in shared/.
app.get('/sw.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-cache');   // always revalidate the SW itself
  res.sendFile(join(SHARED_PUBLIC, 'sw.js'));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

/* ---------- rate limits ---------- */

// One shared account, so there is no per-user key to fall back FROM: every
// limiter here is keyed on the caller's address. `ipKeyGenerator` normalises
// IPv6 to its /64 — without it each address in a residential prefix is its own
// bucket, and a limit of 20 login attempts per 15 minutes is 20 per address
// across 2^64 of them.
const byIp = (req) => ipKeyGenerator(req.ip);

/**
 * Rate limiting is on unless explicitly switched off.
 *
 * It applies whether or not auth is on. An earlier version mounted these only
 * alongside auth, reasoning that a limiter behind `requireAuth` never sees an
 * unauthenticated caller anyway — but that gets the personal edition backwards:
 * with auth off there is nothing else in front of the API at all, so the
 * limiter is the only thing standing between an open instance and a client
 * hammering a synchronous SQLite database until the event loop stops.
 *
 * The switch exists because the browser suites reset fixtures across
 * twenty-two runs from one address and pass 300/minute long before they find a
 * bug. It is a testing and trusted-LAN knob, and the startup log says when it
 * is off.
 */
const rateLimitsOff = (process.env.HABITERALL_RATE_LIMIT ?? '')
  .trim().toLowerCase() === 'off';

if (rateLimitsOff) {
  log.warn('rate_limits_disabled', {
    reason: 'HABITERALL_RATE_LIMIT=off',
    consequence: 'one client can exhaust this server; intended for tests and trusted networks',
  });
}

/** A limiter, or a pass-through when they are switched off. */
const limit = (options) =>
  (rateLimitsOff ? (req, res, next) => next() : rateLimit({ ...options, keyGenerator: byIp }));

/**
 * The credential limiter is NOT switchable, and that is the whole point of it.
 *
 * `HABITERALL_RATE_LIMIT=off` exists so a test run or a trusted LAN is not
 * throttled on ordinary reads. Letting it reach this one turned it into "and
 * also remove the only thing standing between a stranger and an unlimited guess
 * rate at a single shared password" — which no amount of trusting your own
 * network makes reasonable, and which nothing in the name suggests. The browser
 * suites never touch /auth/login, so there is nothing to trade away either.
 */
const credentialLimiter = rateLimit({ ...RATE_LIMITS.login, keyGenerator: byIp });

const apiLimiter = limit(RATE_LIMITS.api);
const notifyTestLimiter = limit(RATE_LIMITS.notifyTest);
const importLimiter = limit(RATE_LIMITS.import);

/* ---------- auth ---------- */

// Top-level await, so importing this module yields an app whose auth is already
// resolved. Unlike `listen` and the notifier below, this has no side effect
// worth deferring: it reads the environment, may hash a supplied password, and
// warns about what it found. A test that imported the app and got a
// half-initialised auth state would be the worse trade.
await initAuth();

app.use(session({
  store: new SqliteStore(db),
  name: SESSION_NAME,
  // A missing secret must not silently produce forgeable sessions, so this
  // fails at startup rather than defaulting to something guessable.
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    ...SESSION_COOKIE,
    secure: publicIsHttps,           // set whenever the site is actually served over TLS
  },
}));

// Cross-site forgery, stated at the routes rather than left to the cookie's
// SameSite attribute alone. Mounted after the session so a refusal is about a
// request that would otherwise have carried one, and before every route that
// can write. See `sameOriginOnly` for why a missing Origin is allowed.
app.use(sameOriginOnly({
  allow: publicUrl ? [new URL(publicUrl).origin] : [],
  onReject: (req, origin) => log.warn('csrf.refused', { path: req.path, origin }),
}));

mountAuth(app, credentialLimiter, apiLimiter);

// Everything below needs a session — unless auth is off, in which case
// `requireAuth` is a pass-through and this edition behaves exactly as it always
// has. The limiters run after it, matching the cloud edition: an unauthenticated
// caller is rejected before it can consume anyone's allowance.
app.use('/api/import', requireAuth, importLimiter);
app.use('/api/notify/test', requireAuth, notifyTestLimiter);
app.use('/api', requireAuth, apiLimiter, api);

// Express 4 needs errors from sync route handlers funnelled through here.
app.use((err, req, res, next) => {
  const status = err.status ?? 500;
  // The stack, with the id the response also carries; requestLog reports the
  // status separately, so this line exists purely to say what threw.
  if (status >= 500) (req.log ?? log).error('unhandled', { path: req.path }, err);
  res.status(status).json({ error: err.message ?? 'internal error' });
});

// Exported so tests can mount the real app on an ephemeral port. Importing
// this module must not start listening, or every test that touches it would
// fight over port 3000 — hence the entry-point check below.
export { app };

const isEntryPoint = process.argv[1] != null &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isEntryPoint) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logStartup(log, {
      edition: 'personal',
      port: PORT,
      db: process.env.HABITERALL_DB ?? './data/habiterall.db',
      notify: (process.env.HABITERALL_NOTIFY ?? 'on').toLowerCase(),
      // Which of the three states auth resolved to, every start. "I thought I
      // turned that on" should be answerable from one line of the log, and
      // `setup` means the account is still unclaimed and anyone may take it.
      auth: mode(),
      configured_by: authState.managed ? 'environment' : 'database',
      // Both of these are off-by-default hardening the operator can turn on or
      // off, so the log says which way they landed rather than leaving it to be
      // inferred from a response header.
      rate_limits: rateLimitsOff ? 'off' : 'on',
      upgrade_insecure: upgradeInsecure ? 'on' : 'off',
      // Whether buttons are possible at all, without printing the token.
      discord_bot: !!process.env.DISCORD_BOT_TOKEN,
      log_level: log.level,
    });
  });

  const runtime = watchRuntime(log);

  // Only from the entry point, exactly like `listen`: a test that imports this
  // module for its routes must not start posting real reminders to whatever
  // webhook the developer's own database happens to hold.
  const notifier = startNotifier();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log.info('shutdown', { signal });
      runtime.stop();
      notifier?.stop();
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}
