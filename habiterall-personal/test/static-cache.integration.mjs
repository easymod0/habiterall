/**
 * What a signed-in browser is actually told about caching, over real HTTP.
 *
 * Two things reached production together and each alone stops a CDN from
 * storing anything: assets went out `Cache-Control: public, max-age=0`, and —
 * in the cloud edition, whose static mounts sat below `app.use(session(...))` —
 * carrying `Set-Cookie`, because `rolling: true` re-stamps the session cookie
 * on every response the middleware reaches. Read off the live instance, every
 * asset came back `cf-cache-status: BYPASS`.
 *
 * `shared/test/static-cache.test.js` pins the header POLICY as a pure decision,
 * and pins the mount order by reading both editions' source. This suite is the
 * half neither of those can do: it signs in, then asks a running server, so it
 * fails if the options object is never passed to `express.static` or if
 * anything that writes a cookie is mounted above the static handler.
 *
 * The cloud edition cannot be booted here (Postgres, and an identity provider
 * for `initAuth`) — but the mount, the options object and the session
 * middleware are the same three lines in both files.
 *
 *   node test/static-cache.integration.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-static-'));

// Auth ON, unlike most suites here: a session is the thing under test, and
// `saveUninitialized: false` means an anonymous request is never sent a cookie
// at all — so every assertion below would pass vacuously against a signed-out
// caller, including against the bug.
process.env.HABITERALL_USERNAME = 'mark';
process.env.HABITERALL_PASSWORD = 'a-good-long-password';
process.env.HABITERALL_RATE_LIMIT = 'off';
process.env.HABITERALL_DB = join(workdir, 'static.db');

const { app } = await import('../src/server.js');
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

/* ---------- sign in ---------- */

const login = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'mark', password: 'a-good-long-password' }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

console.log('--- the session is real ---');
ck('login succeeds', login.status === 200, `status=${login.status}`);
ck('login returns a session cookie', cookie.includes('habiterall.sid'), cookie.slice(0, 24));

const get = (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });

// Load bearing, and the reason this suite cannot quietly stop testing anything.
// Every check below asserts that an ASSET does not set a cookie; this asserts
// that the same cookie, on the same server, still reaches a route that reads
// the session and comes back re-stamped. Without it, a login that silently
// broke would turn the whole file green.
const me = await get('/api/me');
ck('the cookie is accepted by a route that reads the session', me.status === 200,
  `status=${me.status}`);
ck('and that route DOES re-stamp it, so an absent Set-Cookie below means something',
  me.headers.getSetCookie().some((c) => c.startsWith('habiterall.sid=')));

/* ---------- no asset may set a cookie ---------- */

console.log('\n--- assets carry no Set-Cookie ---');

const ASSETS = [
  '/', '/index.html', '/style.css', '/app-entry.js', '/sw.js',
  '/shared/app.js', '/shared/ui/settings.js', '/shared/manifest.json',
  '/shared/icons/icon-192.png',
];

for (const path of ASSETS) {
  const res = await get(path);
  const set = res.headers.getSetCookie();
  ck(`${path} is served without Set-Cookie`, res.status === 200 && set.length === 0,
    `status=${res.status} set-cookie=${set.length}`);
}

/* ---------- and the right ceiling ---------- */

console.log('\n--- Cache-Control, as it reaches the wire ---');

/**
 * Asserted as literal header strings rather than built from the constants the
 * server imports: the value that matters is the one a browser and a CDN parse,
 * and `max-age=0` — the bug — is what an imported-and-formatted expectation
 * would have happily agreed with.
 */
const EXPECTED = [
  // Always revalidate: `sw.js` replaces every other file, `index.html` and
  // `style.css` are what the service worker fetches network-first so a deploy
  // lands in one load, and `manifest.json` names the immutable icons.
  ['/', 'no-cache'],
  ['/index.html', 'no-cache'],
  ['/style.css', 'no-cache'],
  ['/sw.js', 'no-cache'],
  ['/shared/manifest.json', 'no-cache'],

  // The shared ceiling: five minutes, on unhashed URLs.
  ['/app-entry.js', 'public, max-age=300'],
  ['/shared/app.js', 'public, max-age=300'],
  ['/shared/ui/settings.js', 'public, max-age=300'],

  // The one long cache. A changed icon must be a renamed icon.
  ['/shared/icons/icon-192.png', 'public, max-age=31536000, immutable'],
];

for (const [path, expected] of EXPECTED) {
  const res = await get(path);
  const got = res.headers.get('cache-control');
  ck(`${path} -> ${expected}`, got === expected, `got=${got}`);
}

// The same file, reachable at two URLs, must answer the same way — which is
// why the policy matches the resolved filesystem path and not the request URL.
const rootManifest = await get('/manifest.json');
const sharedManifest = await get('/shared/manifest.json');
ck('manifest.json says the same thing under both mounts',
  rootManifest.headers.get('cache-control') === sharedManifest.headers.get('cache-control'),
  `${rootManifest.headers.get('cache-control')} vs ${sharedManifest.headers.get('cache-control')}`);

/* ---------- done ---------- */

server.close();
rmSync(workdir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
