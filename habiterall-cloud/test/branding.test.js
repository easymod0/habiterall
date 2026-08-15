/**
 * The sign-in page is assembled from three files that never see each other:
 * a blueprint naming URLs, a compose file mounting directories under those
 * URLs, and the images themselves. Nothing at runtime checks that they agree
 * — a broken one is a page that renders, minus a logo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOUD = join(HERE, '..');
const REPO = join(CLOUD, '..');

const read = (...parts) => readFileSync(join(...parts), 'utf8');
const branding = read(CLOUD, 'blueprints', 'branding.yaml');
const compose = read(CLOUD, 'docker-compose.yml');

/**
 * `/static/dist/assets/<kind>/<dir>/<file>` is served by Authentik from
 * `/web/dist/assets/<kind>/<dir>/<file>` in its container, and compose is what
 * puts our directory there. Resolve the URL back to a path on this disk.
 */
const sourceFor = (url) => {
  const target = url.replace('/static/dist/', '/web/dist/');
  const dir = target.slice(0, target.lastIndexOf('/'));
  const file = target.slice(target.lastIndexOf('/') + 1);

  const mount = compose
    .split('\n')
    .map((line) => line.trim().match(/^-\s*(\S+):(\S+?):ro$/))
    .find((m) => m && m[2] === dir);
  assert.ok(mount, `docker-compose.yml mounts nothing at ${dir} (for ${url})`);

  return join(CLOUD, mount[1], file);
};

/**
 * The asset URLs this blueprint SETS — from its settings, not from the prose
 * around them, which mentions the same paths without a file on the end.
 */
const assetUrls = (suffix = '(svg|png|jpe?g)') => {
  const pattern = new RegExp(`^\\s*[a-z_]+:\\s*(/static/dist/assets/\\S+\\.${suffix})$`);
  const urls = branding
    .split('\n')
    .map((line) => line.match(pattern))
    .filter(Boolean)
    .map((m) => m[1]);
  return [...new Set(urls)];
};

test('every image the sign-in page names is mounted and present', () => {
  const urls = assetUrls();
  assert.ok(urls.length >= 2, 'expected at least the logo and the backdrop');

  for (const url of urls) {
    const source = sourceFor(url);
    assert.ok(existsSync(source), `${url} resolves to ${source}, which does not exist`);
  }
});

// The one that has already bitten: an XML comment may not contain '--', and
// every SVG in this repository carries a long prose comment explaining itself.
// A stray double hyphen (a CSS custom property is two of them) makes the whole
// file unparseable, and the failure is silent — the browser paints nothing and
// the page looks like a gradient that was simply too subtle.
test('the SVGs parse — no double hyphen inside an XML comment', () => {
  const urls = assetUrls('svg');
  assert.ok(urls.length > 0);

  for (const url of urls) {
    const svg = readFileSync(sourceFor(url), 'utf8');
    for (const [comment] of svg.matchAll(/<!--[\s\S]*?-->/g)) {
      const body = comment.slice(4, -3);
      assert.ok(
        !body.includes('--'),
        `${url} has a comment containing '--', which ends the comment early ` +
          'and makes the file unparseable',
      );
    }
    assert.match(svg, /<svg[\s>]/, `${url} does not look like an SVG`);
  }
});

test('the shared logo is reached from the repo root, not copied here', () => {
  // The mark belongs to the app; the login page borrows it. A copy would be a
  // second one to update.
  assert.match(compose, /\.\.\/shared\/public\/icons:/);
  assert.ok(existsSync(join(REPO, 'shared', 'public', 'icons', 'logo.svg')));
});
