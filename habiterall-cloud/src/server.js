import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { pool, closePool } from './db/pool.js';
import { initAuth, beginLogin, completeLogin, logoutUrl, requireAuth } from './auth.js';
import { api } from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

// A `Secure` cookie is discarded by the browser over plaintext HTTP, which
// would silently break login. Derive it from the scheme actually in use
// rather than from NODE_ENV, so an http:// test stack still works while any
// https:// deployment gets Secure cookies automatically.
const publicIsHttps = (process.env.PUBLIC_URL ?? '').startsWith('https://');

if (isProd && !publicIsHttps) {
  console.warn(
    'WARNING: PUBLIC_URL is not https — session cookies will NOT be marked ' +
    'Secure. Use this only for local testing; put TLS in front in production.'
  );
}

for (const required of ['DATABASE_URL', 'SESSION_SECRET', 'PUBLIC_URL']) {
  if (!process.env[required]) {
    console.error(`${required} must be set`);
    process.exit(1);
  }
}

const app = express();

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
app.use('/api', requireAuth, apiLimiter, api);

/* ---------- static ---------- */

app.get('/healthz', async (req, res) => {
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

// Digital Asset Links, verifying the Android TWA against this origin. Express
// skips dotfiles by default, so `.well-known` needs an explicit mount or the
// app shows a URL bar with no obvious cause. This must sit outside the auth
// gate: Google fetches it unauthenticated.
app.use('/.well-known', express.static(join(SHARED_PUBLIC, '.well-known'), {
  dotfiles: 'allow',
  setHeaders: (res) => res.type('application/json'),
}));

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
  if (status >= 500) console.error(err);
  // Never leak internals to the client.
  res.status(status).json({
    error: status >= 500 ? 'internal error' : (err.message ?? 'request failed'),
  });
});

const server = await start();

async function start() {
  await initAuth();
  const s = app.listen(PORT, '0.0.0.0', () => {
    console.log(`habiterall-cloud listening on :${PORT}`);
  });
  return s;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}
