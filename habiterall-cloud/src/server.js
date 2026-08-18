import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { pool, closePool, poolGauge } from './db/pool.js';
import { LOCAL_IPS, createHealthProbe, sendHealth } from './health.js';
import { initAuth, beginLogin, completeLogin, logoutUrl, requireAuth } from './auth.js';
import { api } from './api.js';
import { start as startNotifier } from './notifier.js';
import { log } from '@habiterall/shared/log.js';
import { logStartup, requestLog, watchRuntime } from '@habiterall/shared/observe.js';
import {
  cspDirectives, HSTS, SESSION_NAME, SESSION_COOKIE, RATE_LIMITS, trustProxy,
  sameOriginOnly, warnOnUntrustedProxy,
} from '@habiterall/shared/security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

// A `Secure` cookie is discarded by the browser over plaintext HTTP, which
// would silently break login. Derive it from the scheme actually in use
// rather than from NODE_ENV, so an http:// test stack still works while any
// https:// deployment gets Secure cookies automatically.
const publicIsHttps = (process.env.PUBLIC_URL ?? '').startsWith('https://');

if (isProd && !publicIsHttps) {
  log.warn('insecure_cookies', {
    reason: 'PUBLIC_URL is not https',
    consequence: 'session cookies will not be marked Secure; login breaks behind TLS',
  });
}

// Read through a variable key, which is where the source walk in
// `shared/test/compose.test.js` goes blind — hence the marker. All three are
// read directly elsewhere in this file too, so nothing depends on it today;
// it is here so that adding a fourth to the list cannot make it invisible.
//
// @env DATABASE_URL SESSION_SECRET PUBLIC_URL
for (const required of ['DATABASE_URL', 'SESSION_SECRET', 'PUBLIC_URL']) {
  if (!process.env[required]) {
    log.error('config_missing', { variable: required });
    process.exit(1);
  }
}

const app = express();

// Before everything, so a request rejected by a limiter or by helmet still
// carries an id and still gets counted.
app.use(requestLog(log));

// How many reverse proxies sit in front of the app — see `trustProxy` in
// shared/src/security.js for why getting this wrong is a security bug in both
// directions.
// Resolved once and held, because the startup log reports it: `trust_proxy` in
// that line used to be a local number and is now an imported function, so the
// log had been printing the function's source where an operator looks to check
// the one setting that decides whose address the limiters key on.
const trustProxyHops = trustProxy(process.env.TRUST_PROXY);
app.set('trust proxy', trustProxyHops);

// Rarely fires here, since this edition defaults to trusting one hop — but an
// operator who set TRUST_PROXY=0 behind the documented compose stack lands in
// exactly the same silent hole.
app.use(warnOnUntrustedProxy({
  trusted: trustProxyHops,
  warn: (fields) => log.warn('proxy_untrusted', fields),
}));

app.use(helmet({
  contentSecurityPolicy: { directives: cspDirectives(publicIsHttps) },
  hsts: isProd ? HSTS : false,
}));

/* ---------- health ---------- */

/*
 * ABOVE the session middleware, and that placement is the whole point.
 *
 * This route reads no session and never has. Mounted below `app.use(session)`
 * it still paid for one: connect-pg-simple runs a SELECT on `session` for the
 * cookie, and `rolling: true` adds a touch UPDATE on top — two round trips,
 * one of them a WRITE, on the one route whose job is to be cheap. The memo in
 * health.js covers `SELECT 1` and nothing else, so neither was memoised.
 *
 * Measured on a signed-in browser against a production instance, the same
 * route in the same second, with and without the cookie:
 *
 *     with cookie   mean 65ms  p99 130ms  and observed at 2256ms
 *     without       mean 19ms  p99  33ms  max 44ms
 *
 * and refreshing the app repeatedly walked the first number from 22ms to 47ms
 * while the second stayed flat at 14ms. Why it CLIMBS is still unexplained
 * (see the issue; MVCC bloat was measured and is not it) — but nothing about
 * this route ever needed the answer, and above the middleware it cannot be
 * reached by whatever the cause turns out to be.
 *
 * The personal edition has always mounted it here, above its own session
 * middleware, which is why only this edition had the problem.
 *
 * `sameOriginOnly` is below too, and that costs nothing: it returns early for
 * safe methods, so a GET was never gated by it.
 */
const healthProbe = createHealthProbe(() => pool.query('SELECT 1'));

/**
 * `/healthz` is the only unauthenticated route that touches Postgres, but the
 * pool is not what this limit protects — the memo in health.js is, and a per-IP
 * limit is the wrong shape for pool exhaustion anyway, since a distributed
 * flood pays nothing for a fresh bucket. This is the cheaper outer bound on
 * request handling.
 *
 * It must never answer 429, and that is the part worth writing down. `/healthz`
 * has four callers, not two: the container healthcheck, an attacker, the PWA's
 * connectivity probe (`isReachable` in shared/public/offline.js, on every boot
 * and every visibilitychange) and the Android setup screen's. Both clients read
 * anything but a 200 as "the server is unreachable" — so a rate-limited browser
 * banners itself offline and diverts writes to the outbox while the server is
 * perfectly healthy, and it is self-feeding, because going offline starts a
 * backoff poll against the same bucket. Real clients arrive through the proxy,
 * which is exactly the side of `skip` the limit applies to. So over the limit
 * we answer from the memo instead: the same truth as a fresh probe, at no cost
 * at all — which is also what the limit is now for, since the memo already
 * bounds the pool. `cached()` is null only before the first request of the
 * process has landed, and being over a limit of 60 implies 60 that were not.
 *
 * `skip` still matters for the other direction. A healthchecker reads 429 as
 * "down" and restarts the container, and those probes arrive on the container's
 * own interface rather than through the proxy.
 *
 * Not from RATE_LIMITS: this one is inseparable from this edition. It answers
 * from the health memo rather than refusing, and skips the container's own
 * interface — neither of which the personal edition has.
 */
const healthLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 60,
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => LOCAL_IPS.test(req.ip ?? ''),
  handler: async (req, res) => sendHealth(res, healthProbe.cached() ?? await healthProbe()),
});

app.get('/healthz', healthLimiter, async (req, res) => {
  sendHealth(res, await healthProbe());
});

/* ---------- sessions ---------- */

const PgStore = connectPgSimple(session);

app.use(session({
  store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
  name: SESSION_NAME,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    ...SESSION_COOKIE,
    secure: publicIsHttps,           // set whenever the site is actually served over TLS
  },
}));

// Cross-site forgery, stated at the routes rather than left to the cookie's
// SameSite attribute alone — same middleware the personal edition mounts.
// PUBLIC_URL is allowed explicitly because the OIDC round trip returns to it.
app.use(sameOriginOnly({
  allow: [new URL(process.env.PUBLIC_URL).origin],
  onReject: (req, origin) => log.warn('csrf.refused', { path: req.path, origin }),
}));

/* ---------- rate limits ---------- */

// Limit per authenticated user where possible, falling back to IP. This is the
// half of a limiter that does NOT belong in shared/: the personal edition has
// one account, so keying on its id would put the legitimate user and an
// attacker in the same bucket. Same limits there, different key.
//
// The fallback goes through `ipKeyGenerator`, which normalises IPv6 to its /56.
// A bare `req.ip` makes every address in a residential prefix its own bucket —
// 2^72 of them — and express-rate-limit v8 reports that as ERR_ERL_KEY_GEN_IPV6
// at startup rather than failing. Unreachable here today, since `requireAuth`
// runs before every limiter below and no unauthenticated request gets this far,
// but it is one route ordering away from mattering.
const perUser = (req) =>
  (req.session?.user?.id ? `u:${req.session.user.id}` : ipKeyGenerator(req.ip));

const loginLimiter = rateLimit(RATE_LIMITS.login);
const apiLimiter = rateLimit({ ...RATE_LIMITS.api, keyGenerator: perUser });
const notifyTestLimiter = rateLimit({ ...RATE_LIMITS.notifyTest, keyGenerator: perUser });
const importLimiter = rateLimit({ ...RATE_LIMITS.import, keyGenerator: perUser });

/* ---------- auth routes ---------- */

app.get('/auth/login', loginLimiter, async (req, res, next) => {
  try {
    res.redirect(await beginLogin(req));
  } catch (e) { next(e); }
});

app.get('/auth/callback', loginLimiter, async (req, res, next) => {
  try {
    const { user, idToken } = await completeLogin(req);
    if (user.blocked) return res.status(403).send('This account is suspended.');

    // Prevent session fixation: a brand-new id for the authenticated session.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = {
        id: user.id, email: user.email,
        name: user.display_name, blocked: user.blocked,
      };
      // Set INSIDE regenerate, with the user: the hint has to live on the
      // session the browser leaves with, and regenerate discards whatever was
      // on the old one.
      req.session.idToken = idToken;
      req.session.save((err2) => (err2 ? next(err2) : res.redirect('/')));
    });
  } catch (e) { next(e); }
});

app.post('/auth/logout', (req, res) => {
  // Read before destroy — the session object is gone by the callback.
  const url = logoutUrl(req.session?.idToken);
  req.session.destroy(() => {
    res.clearCookie('habiterall.sid');
    res.json({ ok: true, redirect: url });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const { id, email, name } = req.session.user;
  // `mode` tells the shared frontend which sign-in control to draw. This
  // edition is always 'oidc'; the personal edition answers 'none', 'password'
  // or 'setup' here. See shared/public/auth-session.js.
  res.json({ id, email, name, mode: 'oidc' });
});

/* ---------- api ---------- */

// Imports arrive as raw bytes; this must precede the JSON parser.
app.use('/api/import', requireAuth, importLimiter,
  express.raw({ type: '*/*', limit: process.env.MAX_UPLOAD_MB
    ? `${process.env.MAX_UPLOAD_MB}mb` : '16mb' }));

app.use(express.json({ limit: '1mb' }));
// Mounted before the router so the tighter limit applies first.
app.use('/api/notify/test', requireAuth, notifyTestLimiter);
app.use('/api', requireAuth, apiLimiter, api);

/* ---------- static ---------- */

const SHARED_PUBLIC = join(__dirname, '..', '..', 'shared', 'public');

// This edition's own files (just the entry point) take precedence, then the
// shared UI. The whole interface lives in shared/ so a fix lands in both
// editions at once.
app.use(express.static(join(__dirname, '..', 'public')));
app.use(express.static(SHARED_PUBLIC));
app.use('/shared', express.static(SHARED_PUBLIC));

// A service worker may only control pages at or below its own path, so it has
// to be served from the origin root even though it lives in shared/.
app.get('/sw.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(join(SHARED_PUBLIC, 'sw.js'));
});

/* ---------- errors ---------- */

app.use((err, req, res, next) => {
  const status = err.status ?? 500;
  // requestLog reports the status; this is the only place the stack appears.
  if (status >= 500) (req.log ?? log).error('unhandled', { path: req.path }, err);
  // Never leak internals to the client.
  res.status(status).json({
    error: status >= 500 ? 'internal error' : (err.message ?? 'request failed'),
  });
});

const server = await start();

// Reminders the server delivers itself (Discord today). Started here rather
// than at import time so the test suites, which import `api.js`, never post to
// a real webhook. Nothing schedules the Android channel: the phone does that.
const notifier = startNotifier();

// One line a minute, and the one to graph: event-loop lag is what turns a heavy
// dashboard into everybody's latency, and pool exhaustion is what a replica
// count that outgrew Postgres looks like.
const runtime = watchRuntime(log, { extra: poolGauge });

async function start() {
  await initAuth();
  const s = app.listen(PORT, '0.0.0.0', () => {
    logStartup(log, {
      edition: 'cloud',
      port: PORT,
      public_url: process.env.PUBLIC_URL,
      secure_cookies: publicIsHttps,
      trust_proxy: trustProxyHops,
      // The number that decides how many replicas Postgres can carry:
      // max × replicas must stay under the server's max_connections.
      pg_pool_max: Number(process.env.PG_POOL_MAX) || 10,
      notify: (process.env.HABITERALL_NOTIFY ?? 'on').toLowerCase(),
      discord_bot: !!process.env.DISCORD_BOT_TOKEN,
      log_level: log.level,
    });
  });
  return s;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info('shutdown', { signal });
    runtime.stop();
    notifier?.stop();
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}
