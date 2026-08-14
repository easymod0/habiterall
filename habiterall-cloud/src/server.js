import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { pool, closePool, poolGauge } from './db/pool.js';
import { initAuth, beginLogin, completeLogin, logoutUrl, requireAuth } from './auth.js';
import { api } from './api.js';
import { start as startNotifier } from './notifier.js';
import { log } from '@habiterall/shared/log.js';
import { logStartup, requestLog, watchRuntime } from '@habiterall/shared/observe.js';

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

/**
 * How many reverse proxies sit in front of the app.
 *
 * This was hardcoded to 1 while `.env.example` and docker-compose both
 * advertised a `TRUST_PROXY` variable — so an operator running the app
 * directly exposed, and setting `TRUST_PROXY=0` exactly as documented, still
 * got proxy trust. That matters: with it on, a client-supplied
 * `X-Forwarded-For` becomes `req.ip`, and `req.ip` is the rate limiter's key
 * for unauthenticated requests. The login limiter (20 per 15 minutes) is then
 * bypassable by rotating a header.
 *
 * Trusting one hop remains the default, because the documented deployment
 * puts TLS termination in front.
 */
const trustProxy = process.env.TRUST_PROXY === undefined
  ? 1
  : Number(process.env.TRUST_PROXY);

if (!Number.isInteger(trustProxy) || trustProxy < 0) {
  throw new Error(
    `TRUST_PROXY must be a non-negative integer (got ${process.env.TRUST_PROXY})`
  );
}
// `false` rather than 0: Express treats the number 0 as "trust nothing" too,
// but false is the documented form and reads unambiguously.
app.set('trust proxy', trustProxy === 0 ? false : trustProxy);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],      // no inline scripts: the frontend is plain modules
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      // Stated explicitly rather than inherited from default-src, so the PWA
      // keeps working if default-src is ever tightened.
      workerSrc: ["'self'"],      // the service worker
      manifestSrc: ["'self'"],    // the web app manifest
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

const PgStore = connectPgSimple(session);

app.use(session({
  store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
  name: 'habiterall.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,                  // unreadable from JS, so XSS cannot steal it
    secure: publicIsHttps,           // set whenever the site is actually served over TLS
    sameSite: 'lax',                 // blocks cross-site POSTs while allowing the OIDC return
    maxAge: 1000 * 60 * 60 * 24 * 14,
  },
}));

/* ---------- rate limits ---------- */

/**
 * Loopback and the private ranges a container orchestrator probes from —
 * docker's bridge, a kubelet on the node, an IPv6 unique-local address.
 * Anchored and alternation-free per branch, so it cannot backtrack.
 */
const LOCAL_IPS =
  /^(::1|::ffff:127\.|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|f[cd]|fe80:)/i;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many login attempts, try again later' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 300,
  standardHeaders: true, legacyHeaders: false,
  // Limit per authenticated user where possible, falling back to IP.
  keyGenerator: (req) => (req.session?.user?.id ? `u:${req.session.user.id}` : req.ip),
  message: { error: 'rate limit exceeded' },
});

/**
 * The test-notification endpoint makes the server perform an OUTBOUND request,
 * which the general 300-per-minute API limit is far too loose for: it would
 * let one account push 300 posts a minute at its Discord channel and get the
 * server rate-limited (or the webhook deleted) on their behalf.
 */
const notifyTestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 10,
  keyGenerator: (req) => (req.session?.user?.id ? `u:${req.session.user.id}` : req.ip),
  message: { error: 'too many test notifications, try again in a few minutes' },
});

/**
 * `/healthz` is the only unauthenticated route that touches Postgres, which
 * makes it the cheapest way to exhaust a pool sized for the app rather than for
 * a flood: `PG_POOL_MAX` is 10 by default, and every waiting `SELECT 1` is a
 * connection a real request cannot have.
 *
 * `skip` is load bearing. A healthchecker reads 429 as "down" and restarts the
 * container, so the probe that this limit exists to protect must never meet it
 * — and those arrive on the container's own interface, not through the proxy.
 */
const healthLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 60,
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => LOCAL_IPS.test(req.ip ?? ''),
  message: { ok: false, error: 'rate limit exceeded' },
});

const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 20,
  keyGenerator: (req) => (req.session?.user?.id ? `u:${req.session.user.id}` : req.ip),
  message: { error: 'too many imports, try again later' },
});

/* ---------- auth routes ---------- */

app.get('/auth/login', loginLimiter, async (req, res, next) => {
  try {
    res.redirect(await beginLogin(req));
  } catch (e) { next(e); }
});

app.get('/auth/callback', loginLimiter, async (req, res, next) => {
  try {
    const user = await completeLogin(req);
    if (user.blocked) return res.status(403).send('This account is suspended.');

    // Prevent session fixation: a brand-new id for the authenticated session.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = {
        id: user.id, email: user.email,
        name: user.display_name, blocked: user.blocked,
      };
      req.session.save((err2) => (err2 ? next(err2) : res.redirect('/')));
    });
  } catch (e) { next(e); }
});

app.post('/auth/logout', (req, res) => {
  const url = logoutUrl();
  req.session.destroy(() => {
    res.clearCookie('habiterall.sid');
    res.json({ ok: true, redirect: url });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const { id, email, name } = req.session.user;
  res.json({ id, email, name });
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

app.get('/healthz', healthLimiter, async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: 'database unavailable' });
  }
});

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
      trust_proxy: trustProxy,
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
