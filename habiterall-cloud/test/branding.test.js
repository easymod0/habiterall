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
const bootstrap = read(CLOUD, 'scripts', 'bootstrap-authentik.mjs');

/**
 * The read-only mounts a compose service declares, as `target -> source`.
 *
 * Per service, not per file, and that is the point: the server is what serves
 * `/static/…` and the worker is what lists the blueprint directory, so a mount
 * present on one and missing from the other breaks half of this with
 * everything still looking mounted.
 */
const mountsOf = (service) => {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${service}:`);
  assert.notEqual(start, -1, `docker-compose.yml has no ${service} service`);
  const indent = lines[start].search(/\S/);

  const mounts = new Map();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    const m = line.trim().match(/^-\s*(\S+):(\S+?):ro$/);
    if (m) mounts.set(m[2], m[1]);
  }
  return mounts;
};

const AUTHENTIK_SERVICES = ['authentik-server', 'authentik-worker'];

/**
 * `/static/dist/assets/<kind>/<dir>/<file>` is served by Authentik out of
 * `/web/dist/assets/<kind>/<dir>/<file>` in its container, and compose is what
 * puts our directory there. Resolve the URL back to a path on this disk,
 * insisting that every Authentik container has it.
 */
const sourceFor = (url) => {
  const target = url.replace('/static/dist/', '/web/dist/');
  const dir = target.slice(0, target.lastIndexOf('/'));
  const file = target.slice(target.lastIndexOf('/') + 1);

  const sources = AUTHENTIK_SERVICES.map((service) => {
    const source = mountsOf(service).get(dir);
    assert.ok(source, `${service} mounts nothing at ${dir} (for ${url})`);
    return source;
  });
  assert.equal(new Set(sources).size, 1, `${dir} is mounted from different places`);

  return join(CLOUD, sources[0], file);
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

// The other silent mismatch this change rests on. The script names blueprints
// by the path Authentik reports them under, which is their path relative to
// /blueprints — so it is the compose mount that decides whether
// 'custom/self-signup.yaml' resolves to anything at all, and a rename on
// either side fails only at runtime, on the endpoint that validates the path.
test('the blueprint paths the bootstrap asks for are the paths compose mounts', () => {
  const asked = [...bootstrap.matchAll(/'(custom\/[a-z-]+\.yaml)'/g)].map((m) => m[1]);
  assert.ok(asked.length >= 2, 'expected the self-signup and branding blueprints');

  for (const service of AUTHENTIK_SERVICES) {
    const mounts = mountsOf(service);
    for (const path of asked) {
      const [dir, file] = [path.slice(0, path.indexOf('/')), path.slice(path.indexOf('/') + 1)];
      const source = mounts.get(`/blueprints/${dir}`);
      assert.ok(source, `${service} mounts nothing at /blueprints/${dir} (for ${path})`);
      assert.ok(
        existsSync(join(CLOUD, source, file)),
        `${path} would resolve to ${join(source, file)}, which does not exist`,
      );
    }
  }
});

test('the shared logo is reached from the repo root, not copied here', () => {
  // The mark belongs to the app; the login page borrows it. A copy would be a
  // second one to update.
  assert.match(compose, /\.\.\/shared\/public\/icons:/);
  assert.ok(existsSync(join(REPO, 'shared', 'public', 'icons', 'logo.svg')));
});
