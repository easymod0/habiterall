import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PRINTED, NOT_PRINTED, exampleFiles, render } from '../../scripts/sync-compose-docs.mjs';

/**
 * What the README shows about `examples/`, and what those files must contain.
 *
 * The copies exist twice on purpose: a reader wants to see the file without
 * following a link, and an operator wants a file they can run. What is not
 * acceptable is the two drifting — a README snippet that no longer works is
 * worse than no snippet, because it is tried before it is doubted.
 *
 * This used to compare them. It now runs the GENERATOR and asserts it would
 * change nothing, which is the same check with the copy-and-paste job removed:
 * a failure here is fixed by `npm run docs:compose`, not by hand.
 *
 * What the compose files must SAY — every variable the server reads — is
 * `compose.test.js`, because that question is about the source rather than
 * about the README.
 *
 * This lives in `shared/test` for the dull reason that `npm test` only reaches
 * workspaces, and there is precedent: settings.test.js reads a file by path to
 * keep two copies of the settings registry honest.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const README = readFileSync(join(root, 'README.md'), 'utf8');

test('the README blocks are what the example files say', () => {
  const { changed } = render();
  assert.deepEqual(changed, [],
    'README.md has drifted from ' + changed.map((f) => `examples/${f}`).join(', ') +
    '. Run `npm run docs:compose` and commit the result.');
});

test('every file in examples/ is printed in the README', () => {
  // The generator works from an explicit list, so a new example file would
  // otherwise be shipped with nothing showing it — the same silence this whole
  // check exists to end, one level up.
  const printed = new Set(PRINTED.map((p) => p.file));
  const unprinted = exampleFiles().filter((f) => !printed.has(f));
  assert.deepEqual(unprinted, [],
    `examples/${unprinted.join(', ')} is in the repository but in no README block. ` +
    'Add it to PRINTED in scripts/sync-compose-docs.mjs, with a marker pair in ' +
    'README.md.');
});

test('every excuse in NOT_PRINTED still names a file that is there', () => {
  // An exclusion that outlives its file is a decision about nothing, and it
  // silently widens: the next file to take that name inherits the excuse. Same
  // rule as ELSEWHERE in compose.test.js and notMirrored on the Android side.
  const present = new Set(readdirSync(join(root, 'examples')));
  const stale = Object.keys(NOT_PRINTED).filter((f) => !present.has(f));
  assert.deepEqual(stale, [],
    `NOT_PRINTED excuses examples/${stale.join(', ')}, which no longer exists. ` +
    'Remove it from scripts/sync-compose-docs.mjs.');
});

test('the examples pull the published images, not a local build', () => {
  // A `build:` here would send a reader to clone the repository, which is the
  // one thing these files exist to avoid.
  for (const name of ['docker-compose.personal.yml', 'docker-compose.cloud.yml']) {
    const text = readFileSync(join(root, 'examples', name), 'utf8');
    assert.ok(!/^\s*build:/m.test(text), `examples/${name} builds instead of pulling`);
    assert.match(text, /image: ghcr\.io\/[a-z0-9._-]+\/habiterall-(personal|cloud)/,
      `examples/${name} names no habiterall image`);
  }
});

test('the personal example keeps the database on a volume', () => {
  // The image declares VOLUME /data, so without this the entire history lives
  // in the container's writable layer and a `docker compose down` takes it.
  const text = readFileSync(join(root, 'examples', 'docker-compose.personal.yml'), 'utf8');
  assert.match(text, /:\/data\b/, 'nothing is mounted at /data');
  assert.match(text, /HABITERALL_DB: \/data\//, 'the database is not pointed into /data');
});

test('the cloud example runs migrations as a separate credential', () => {
  // The app role cannot change the schema — that is the point of it. If the
  // example gave the app DATABASE_URL_ADMIN, it would be teaching the opposite
  // of what the security model relies on.
  const text = readFileSync(join(root, 'examples', 'docker-compose.cloud.yml'), 'utf8');
  assert.match(text, /command: \['node', 'src\/db\/migrate\.js'\]/,
    'no migrate step — the schema would never be created');
  assert.match(text, /service_completed_successfully/,
    'the app does not wait for migrations to finish');

  const appBlock = text.slice(text.indexOf('  app:'));
  assert.ok(!appBlock.includes('DATABASE_URL_ADMIN'),
    'the app must not hold the admin credential');
  assert.match(appBlock, /habiterall_app:/, 'the app must connect as the restricted role');
});

test('the proxy example forwards what the app needs', () => {
  // X-Forwarded-Proto is what makes the session cookie Secure, and
  // X-Forwarded-For is what the rate limiter keys on. Caddy sends both by
  // default; nginx does not, so the nginx example must say so explicitly.
  const nginx = README.slice(README.indexOf('```nginx'));
  assert.match(nginx, /X-Forwarded-Proto/);
  assert.match(nginx, /X-Forwarded-For/);
});

test('the reverse-proxy guidance covers TRUST_PROXY once, outside the folds', () => {
  // It applies to every proxy, so it must not sit inside one proxy's <details>
  // — that is how it came to be read as an nginx-only setting.
  const section = README.slice(README.indexOf('### Put HTTPS in front'),
    README.indexOf('## Features'));
  const after = section.slice(section.lastIndexOf('</details>'));
  assert.match(after, /TRUST_PROXY=1/,
    'TRUST_PROXY is not explained after the last collapsed proxy example');
});

