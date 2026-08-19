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
 * How long a shared-frontend asset may be reused without asking the server.
 *
 * Minutes, and deliberately not a year. Nothing under `shared/public/` carries
 * a content hash in its URL — there is no build step to put one there — so this
 * number is a promise that cannot be revoked once a browser has it. It also
 * COMPOUNDS with the service worker: `shellFirst` revalidates with a plain
 * `fetch(request)` in the default cache mode, so whatever is set here is added
 * to how long an installed client goes on running the module it already has.
 *
 * Five minutes is long enough that a reload does not re-ask for thirty-odd
 * modules and short enough that a bad deploy is over before anyone has finished
 * reporting it. The bandwidth this trades away is worth approximately nothing:
 * the service worker is already serving scripts from Cache Storage, so what
 * this bounds is mostly conditional requests, not transfers.
 */
export const STATIC_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * The four files that must never be held past a deploy.
 *
 * `sw.js` is how every OTHER file is ever replaced, so a stale copy of it pins
 * a stale shell for as long as it lives. `index.html` and `style.css` are the
 * two the service worker fetches NETWORK-first (`revalidateFirst` in
 * `shared/public/sw.js`, on `request.mode === 'navigate'` and
 * `destination === 'style'`) precisely so that a deploy appears in one load
 * rather than two, with no window where new HTML renders against old CSS —
 * caching them here would hand that fetch a disk copy and take the property
 * back. `manifest.json` names the icons below, which outlive everything.
 */
const ALWAYS_REVALIDATE = /(?:^|\/)(?:index\.html|style\.css|sw\.js|manifest\.json)$/;

/**
 * The icons, which are the one safe long cache here: they are referenced by
 * name from `manifest.json` and `index.html`, they are the only assets that do
 * not compress, and they have changed twice in the life of the project.
 *
 * `immutable` is what makes this a real saving rather than a conditional
 * request — but it also means a CHANGED icon must be a RENAMED icon. There is
 * no revalidation to catch it otherwise.
 */
const IMMUTABLE = /(?:^|\/)icons\//;

/**
 * `express.static` options for the shared frontend, for both editions to spread
 * into every mount that serves `shared/public/`.
 *
 * Here for the same reason the CSP is: what file may be held, and for how long,
 * is a statement about `shared/public/` rather than about an edition, and both
 * editions serve those files from the same directory. Two copies would be two
 * chances to give the service worker a stale shell in exactly one edition.
 *
 * Matching is on the FILESYSTEM path express resolved, not on the URL, which is
 * what makes one rule cover a file reachable at two URLs — `manifest.json` is
 * served both from the root mount and under `/shared`, and it must revalidate
 * either way.
 */
export const STATIC_CACHE = {
  maxAge: STATIC_MAX_AGE_MS,
  /**
   * @param {{ setHeader: (name: string, value: string) => void }} res
   * @param {string} filePath absolute path of the file being sent
   */
  setHeaders(res, filePath) {
    const path = String(filePath).replace(/\\/g, '/');
    if (ALWAYS_REVALIDATE.test(path)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (IMMUTABLE.test(path)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
};

/**
 * Session cookie shape, minus `secure` — which each edition decides for itself,
 * because a `Secure` cookie over plaintext HTTP is dropped silently and login
 * then breaks with no error on either side. Cloud reads its one public URL;
 * personal says `'auto'` and lets express-session answer per request, because
 * that edition is commonly reachable over both schemes at once.
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
  /**
   * The ntfy answer route (`NTFY_ANSWER_PATH`) takes no session at all — it is
   * reached by ntfy's own device, not by the app — so this is the only bound
   * standing between an internet-reachable, unauthenticated endpoint and
   * someone trying codes against it. 30/minute is a human pressing buttons;
   * both editions mount this inline with `rateLimit(...)`, never through a
   * helper that can become a pass-through, for the same reason the credential
   * limiter is never switchable — see the comment beside each mount.
   */
  ntfyAnswer: {
    windowMs: 60 * 1000, limit: 30,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'too many attempts, try again later' },
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
  // Canonicalised through the URL parser rather than trimmed with a regex.
  // `/\/+$/` against a header an attacker writes is a polynomial match on a
  // string of slashes — a denial of service in the middleware whose whole job
  // is to make requests safer. `URL.origin` is already normal form and carries
  // no trailing slash, so there is nothing to strip.
  const allowed = new Set(allow.map(canonicalOrigin).filter(Boolean));

  return function originGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.headers?.origin;
    if (!origin) return next();          // not a browser — see above

    const parsed = parseOrigin(origin);
    if (parsed) {
      // `req.host` is Express's trust-proxy-aware answer: it consults
      // `X-Forwarded-Host` only when the app is configured to trust a proxy,
      // and includes the port. Reading the raw header instead — which is what
      // this did — let any client that can set a header name its own origin and
      // walk past the guard, and it did so most readily on a directly exposed
      // instance, where no forwarded header should be believed at all.
      const host = req.host ?? req.headers?.host;
      if (parsed.host === String(host)) return next();
      if (allowed.has(parsed.origin)) return next();
    }

    onReject?.(req, origin);
    return res.status(403).json({ error: 'cross-origin request refused' });
  };
}

/** @returns {URL|null} null for anything that is not a parseable absolute URL */
function parseOrigin(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

/** @returns {string|null} the canonical `scheme://host[:port]`, or null */
function canonicalOrigin(value) {
  return parseOrigin(value)?.origin ?? null;
}

/**
 * Say once, if a proxy appears to be in front that this app does not trust.
 *
 * The counterpart to `trustProxy` below, and the reason its safe default is
 * safe to ship. Getting that setting wrong is a security bug in one direction
 * and an availability bug in the other, and only the second one is recoverable
 * by noticing — so it had better be noticeable. It was not: trusting no proxy
 * while standing behind one makes every caller share the proxy's address, so all
 * the rate limits collapse into a single bucket, and the only symptom is a 429
 * nobody can explain.
 *
 * `X-Forwarded-For` arriving while nothing is trusted is exactly that state.
 * Once per process, because a warning repeated per request is a warning nobody
 * reads — the same cadence `notify-send.js` uses for the two silences worth
 * breaking. A client can forge the header and trigger this spuriously; the cost
 * of that is one log line for the life of the process.
 *
 * @param {{trusted: number|false, warn: (fields: object) => void}} options
 * @returns Express-shaped middleware
 */
export function warnOnUntrustedProxy({ trusted, warn }) {
  if (trusted !== false && trusted !== 0) {
    return function proxyTrusted(req, res, next) { next(); };
  }

  let said = false;
  return function untrustedProxy(req, res, next) {
    if (!said && req.headers?.['x-forwarded-for']) {
      said = true;
      warn({
        reason: 'a request arrived with X-Forwarded-For but TRUST_PROXY is 0',
        // Three sinks, not one. The limiters were the reason this warning was
        // written, but `req.ip` is not the only trust-proxy-aware value the app
        // reads: `sameOriginOnly` compares `req.host`, which ignores
        // X-Forwarded-Host while nothing is trusted — so a proxy that rewrites
        // Host refuses every write with a 403 — and the session cookie's
        // `secure: 'auto'` reads `req.protocol`, which cannot see the TLS the
        // proxy terminated.
        consequence: 'every caller keys on the proxy address, so one client can '
          + 'exhaust the rate limits for everyone; writes may be refused as '
          + 'cross-origin, and session cookies cannot be marked Secure',
        fix: 'set TRUST_PROXY to the number of proxies in front (usually 1)',
      });
    }
    next();
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
 * The DEFAULT is the caller's, because the two editions ship into different
 * shapes. Cloud's documented deployment puts TLS termination in front, so one
 * hop is right there. The personal edition's quickstart is `npm start` on a LAN
 * with nothing in front of it — and defaulting to 1 there meant `req.ip` came
 * from a client-supplied `X-Forwarded-For`, which is the rate limiters' only
 * key. Forty guesses at the single shared password went through a limit of
 * twenty, by adding one header.
 *
 * @param {string|undefined} value raw `process.env.TRUST_PROXY`
 * @param {number} fallback hops to trust when the variable is unset
 * @returns {number|false} ready for `app.set('trust proxy', ...)`
 */
export function trustProxy(value, fallback = 1) {
  const hops = value === undefined ? fallback : Number(value);

  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`TRUST_PROXY must be a non-negative integer (got ${value})`);
  }
  // `false` rather than 0: Express treats the number 0 as "trust nothing" too,
  // but false is the documented form and reads unambiguously.
  return hops === 0 ? false : hops;
}
