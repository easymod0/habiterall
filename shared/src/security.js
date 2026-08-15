/**
 * The hardening both editions apply to the same frontend.
 *
 * This file holds DATA, not middleware. `helmet` and `express-rate-limit` stay
 * in each edition's `server.js`, so this package keeps its one useful property
 * — no npm dependencies at all — and the wiring stays visible where the routes
 * are. `observe.js` draws the same line for a different reason: an
 * Express-shaped middleware that never imports Express.
 *
 * What belongs here is anything that describes `shared/public/` rather than an
 * edition. A CSP is the clearest case: the directives below are a statement
 * about how the shared frontend loads, so two copies of them is two chances to
 * break the PWA in exactly one edition and not notice.
 *
 * What deliberately does NOT belong here is the rate limiters' `keyGenerator`.
 * The cloud edition keys per authenticated user; the personal edition has one
 * shared account, where keying on the user id would put the legitimate user and
 * an attacker in the same bucket. Same limits, different key — so the limits are
 * shared and the key is not.
 */

/**
 * Content-Security-Policy directives for the shared frontend.
 *
 * `connectSrc: 'self'` is load bearing beyond the usual: it is why the browser
 * cannot post to a Discord webhook itself, which is what makes server-sent
 * reminders the server's job. Loosening it changes that design, it does not
 * just relax a header.
 */
export const CSP_DIRECTIVES = {
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
};

/**
 * The directives, with `upgrade-insecure-requests` left to the CALLER.
 *
 * helmet adds that directive by default and it is right for anything behind
 * TLS. On a plain-http origin it is a trap: the browser rewrites every request
 * to https, and since nothing is listening there the app fails to load
 * entirely. It goes unnoticed on `localhost`, which browsers treat as
 * trustworthy and exempt — so the failure appears only on a LAN address.
 *
 * Which is why this is a parameter rather than something derived here. The
 * cloud edition ties it to its own scheme; the personal edition makes it an
 * explicit opt-in and defaults to off, because a self-hosted instance can be
 * reachable over both schemes at once, or over a tunnel, or behind a proxy that
 * terminates TLS somewhere this process cannot see — and in every one of those
 * the guess is wrong in the direction that breaks the app rather than the one
 * that merely fails to harden it.
 *
 * `null` removes a helmet default; `[]` enables a valueless directive.
 *
 * @param {boolean} upgradeInsecure whether to ask browsers to upgrade http
 *   subresource and navigation requests to https
 */
export function cspDirectives(upgradeInsecure) {
  return { ...CSP_DIRECTIVES, upgradeInsecureRequests: upgradeInsecure ? [] : null };
}

/**
 * HSTS options, for the editions to apply only in production.
 *
 * Never unconditionally: a browser that sees this header on a local http stack
 * pins the hostname to https for a year, and `localhost` is a hostname a lot of
 * other things also use.
 */
export const HSTS = { maxAge: 31536000, includeSubDomains: true };

/**
 * Session cookie shape, minus `secure` — which each edition derives from the
 * scheme actually in use, not from NODE_ENV, because a `Secure` cookie over
 * plaintext HTTP is dropped silently and login breaks with no error.
 *
 * The two editions match here on purpose. The Android client reads its session
 * out of the WebView's `CookieManager`, so one cookie name and one `sameSite`
 * is the difference between one code path in `Api.kt` and two.
 */
export const SESSION_NAME = 'habiterall.sid';

/** The `cookie` block itself, spread alongside a per-edition `secure`. */
export const SESSION_COOKIE = {
  httpOnly: true,                  // unreadable from JS, so XSS cannot steal it
  sameSite: 'lax',                 // blocks cross-site POSTs while allowing the OIDC return
  maxAge: 1000 * 60 * 60 * 24 * 14,
};

/**
 * Rate limit parameters, keyed by what they protect. Spread into `rateLimit()`
 * with a `keyGenerator` supplied per edition.
 *
 * `notifyTest` and `import` are much tighter than `api` for the same reason:
 * both make the server do work on the caller's behalf that the caller is not
 * paying for. The test endpoint causes an OUTBOUND request, so the general
 * 300-per-minute allowance would let one account push 300 posts a minute at its
 * own Discord channel and get the server rate-limited — or the webhook deleted —
 * on their behalf.
 */
export const RATE_LIMITS = {
  login: {
    windowMs: 15 * 60 * 1000, limit: 20,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'too many login attempts, try again later' },
  },
  api: {
    windowMs: 60 * 1000, limit: 300,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'rate limit exceeded' },
  },
  notifyTest: {
    windowMs: 10 * 60 * 1000, limit: 10,
    message: { error: 'too many test notifications, try again in a few minutes' },
  },
  import: {
    windowMs: 60 * 60 * 1000, limit: 20,
    message: { error: 'too many imports, try again later' },
  },
};

/** Methods that cannot change state, and so need no origin check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuse a state-changing request that a browser says came from somewhere else.
 *
 * Both editions authenticate with a cookie, which is what makes cross-site
 * request forgery possible at all: a form on another site can POST here and the
 * browser attaches the session. `SameSite=Lax` already stops that in every
 * current browser — it is why the cookie is set that way — but it is a defence
 * written down in one attribute, invisible at the routes it protects, and it
 * fails open on anything that does not implement it.
 *
 * This is the second half, stated where the requests are. Browsers send `Origin`
 * on every state-changing request, so a mismatch is forgery and nothing else.
 *
 * **A missing `Origin` is allowed, deliberately.** That is not a hole: the
 * attack needs a browser, and browsers always send it here. What lacks one is a
 * native client — `Api.kt` posting a check-off from a notification — and
 * refusing those would break the Android client to defend against a request it
 * cannot make. This is also why the defence is an origin check rather than a
 * CSRF token: a token has to be fetched, held and replayed by every client, and
 * the whole point of both editions issuing the same cookie is that the phone
 * needs no special path.
 *
 * The comparison is against the Host the request arrived with, so it follows a
 * reverse proxy without being told the public name — but `trust proxy` decides
 * whether that Host is the client's or the proxy's, which is one more reason
 * `trustProxy` above has to be right. Extra origins can be allowed for a
 * deployment served under more than one name.
 *
 * @param {{allow?: string[], onReject?: (req: any, origin: string) => void}} [options]
 * @returns Express-shaped middleware
 */
export function sameOriginOnly({ allow = [], onReject } = {}) {
  const allowed = new Set(allow.filter(Boolean).map((o) => o.replace(/\/+$/, '')));

  return function originGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.headers?.origin;
    if (!origin) return next();          // not a browser — see above

    const host = req.headers?.['x-forwarded-host'] ?? req.headers?.host;
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === String(host);
    } catch {
      sameHost = false;                  // unparseable Origin is not this one
    }

    if (sameHost || allowed.has(origin.replace(/\/+$/, ''))) return next();

    onReject?.(req, origin);
    return res.status(403).json({ error: 'cross-origin request refused' });
  };
}

/**
 * How many reverse proxies sit in front of the app, as Express wants it.
 *
 * This was hardcoded to 1 in the cloud edition while `.env.example` and
 * docker-compose both advertised a `TRUST_PROXY` variable — so an operator
 * running the app directly exposed, and setting `TRUST_PROXY=0` exactly as
 * documented, still got proxy trust. That matters: with it on, a
 * client-supplied `X-Forwarded-For` becomes `req.ip`, and `req.ip` is the rate
 * limiter's key for unauthenticated requests. The login limiter (20 per 15
 * minutes) is then bypassable by rotating a header.
 *
 * Getting it wrong in the other direction is just as bad and looks like nothing:
 * an app behind a proxy that trusts no hop sees the proxy's address as every
 * caller's, so all four limiters collapse into one bucket and any single client
 * can lock out everyone.
 *
 * Trusting one hop remains the default, because the documented deployment puts
 * TLS termination in front.
 *
 * @param {string|undefined} value raw `process.env.TRUST_PROXY`
 * @returns {number|false} ready for `app.set('trust proxy', ...)`
 */
export function trustProxy(value) {
  const hops = value === undefined ? 1 : Number(value);

  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`TRUST_PROXY must be a non-negative integer (got ${value})`);
  }
  // `false` rather than 0: Express treats the number 0 as "trust nothing" too,
  // but false is the documented form and reads unambiguously.
  return hops === 0 ? false : hops;
}
