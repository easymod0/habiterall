/**
 * What may be held, for how long, and where the rule is mounted.
 *
 * Both halves of a cache bug that reached production and was read off it:
 * every asset went out `Cache-Control: public, max-age=0` (express.static's
 * answer when nothing sets `maxAge`) and, in the cloud edition, carrying a
 * `Set-Cookie` — because the static mounts sat BELOW `app.use(session(...))`
 * and `rolling: true` re-stamps the cookie on every response it reaches. Either
 * one alone is enough for a CDN to refuse the response: both showed up as
 * `cf-cache-status: BYPASS` on the whole frontend.
 *
 * This file pins the DECISION. The wiring — that a server actually passes these
 * options to `express.static`, and that no session middleware runs above it —
 * is `habiterall-personal/test/static-cache.integration.mjs`, over real HTTP
 * with a real signed-in cookie.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATIC_CACHE, STATIC_MAX_AGE_MS } from '../src/security.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');
const ROOT = join(HERE, '..', '..');

/**
 * Ask the policy about a real file, the way express.static does: with the
 * absolute FILESYSTEM path it resolved, not the URL it was asked for.
 *
 * `null` is a meaningful answer — it means the policy declined to override, so
 * express.static's own `maxAge` supplies the header.
 */
function headerFor(...parts) {
  let value = null;
  const res = { setHeader: (n, v) => { if (n === 'Cache-Control') value = v; } };
  STATIC_CACHE.setHeaders(res, join(PUBLIC, ...parts));
  return value;
}

test('the ceiling is minutes, and the literal is the point', () => {
  // Written out rather than imported-and-compared: a test that asserts
  // `STATIC_MAX_AGE_MS === STATIC_MAX_AGE_MS` pins the name and nothing else.
  assert.equal(STATIC_MAX_AGE_MS, 5 * 60 * 1000);

  // The bound that carries the reasoning. No URL under shared/public carries a
  // content hash — there is no build step to put one there — so this number is
  // a promise that cannot be revoked, and it is ADDED to the service worker's
  // own staleness, because `shellFirst` revalidates with a default-cache-mode
  // `fetch`. Raising it past a quarter hour makes a bad deploy unrecallable
  // for longer than it takes to notice one.
  assert.ok(STATIC_MAX_AGE_MS <= 15 * 60 * 1000,
    `a ${STATIC_MAX_AGE_MS}ms ceiling on unhashed URLs outlives the deploy that fixes them`);
});

test('the four files a deploy must always replace revalidate', () => {
  // Each is asserted to EXIST first. The policy matches on filename, so a
  // rename would silently stop matching and every check below would go on
  // passing against a file that no longer exists.
  for (const file of ['index.html', 'style.css', 'sw.js', 'manifest.json']) {
    assert.ok(existsSync(join(PUBLIC, file)), `shared/public/${file} has been renamed or moved`);
    assert.equal(headerFor(file), 'no-cache', file);
  }
});

test('an ordinary module defers to the shared ceiling', () => {
  // null, not a header: express.static answers these with `maxAge`.
  assert.equal(headerFor('ui', 'settings.js'), null);
  assert.equal(headerFor('app.js'), null);
});

test('the revalidate list is anchored to whole filenames', () => {
  // `sub-index.html` is not `index.html`. Without the `(?:^|\/)` anchor every
  // file whose name merely ENDS in one of the four would be exempted from the
  // cache, which fails in the safe direction and so would never be noticed.
  assert.equal(headerFor('ui', 'sub-index.html'), null);
  assert.equal(headerFor('ui', 'not-sw.js'), null);
});

test('the icons are the one long cache, and they are really there', () => {
  const icons = readdirSync(join(PUBLIC, 'icons'));
  assert.ok(icons.length > 0, 'shared/public/icons is empty');

  for (const icon of icons) {
    assert.equal(headerFor('icons', icon), 'public, max-age=31536000, immutable', icon);
  }

  // `immutable` means no revalidation at all, so a changed icon MUST be a
  // renamed icon. Nothing can enforce that here; it is written in security.js
  // beside the rule.
  assert.ok(icons.includes('icon-192.png'), 'the manifest names icon-192.png');
});

test('both editions mount static ABOVE the session middleware', () => {
  /*
   * This one reads SOURCE TEXT, and is kept for exactly what that can catch: a
   * static mount that has drifted back below the session middleware, which is
   * the shape the cloud edition shipped. It cannot see a session installed
   * under another name, or an options object passed and then ignored — the
   * integration suite is what covers those, by asking a running server.
   *
   * The cloud edition cannot be booted in this process (Postgres and an
   * identity provider), which is why the ordering is pinned here at all.
   */
  for (const edition of ['habiterall-personal', 'habiterall-cloud']) {
    const src = readFileSync(join(ROOT, edition, 'src', 'server.js'), 'utf8');

    // Anchored to the line start so the prose ABOVE each mount — which says
    // "mounted below `app.use(session)`" in both files — is not what matches.
    const staticAt = src.search(/^app\.use\((?:'\/shared', )?express\.static\(/m);
    const sessionAt = src.search(/^app\.use\(session\(/m);

    assert.ok(staticAt >= 0, `${edition}: no express.static mount found at all`);
    assert.ok(sessionAt >= 0, `${edition}: no session middleware found at all`);
    assert.ok(staticAt < sessionAt,
      `${edition}: static is mounted below session, so every asset a signed-in `
      + 'browser fetches comes back with Set-Cookie and no shared cache will store it');
  }
});
