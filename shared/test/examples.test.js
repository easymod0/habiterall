import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The compose examples in README.md must match the files in examples/.
 *
 * They exist twice on purpose: a reader wants to see the file without following
 * a link, and an operator wants a file they can run. What is not acceptable is
 * the two drifting — a README snippet that no longer works is worse than no
 * snippet, because it is tried before it is doubted.
 *
 * This lives in `shared/test` for the dull reason that `npm test` only reaches
 * workspaces, and there is precedent: settings.test.js reads a file by path to
 * keep two copies of the settings registry honest.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const README = readFileSync(join(root, 'README.md'), 'utf8');

/** The fenced yaml blocks, in order of appearance. */
const yamlBlocks = [...README.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);

/** An example file, minus its leading comment header. */
function exampleBody(name) {
  const text = readFileSync(join(root, 'examples', name), 'utf8');
  const lines = text.split('\n');
  // Drop the header: every line up to and including the first blank one.
  const start = lines.findIndex((line) => line.trim() === '');
  return lines.slice(start + 1).join('\n');
}

test('the README shows exactly the compose files that are in the repo', () => {
  assert.equal(yamlBlocks.length, 2,
    'expected the personal and cloud compose examples in README.md');

  const expected = [
    'docker-compose.personal.yml',
    'docker-compose.cloud.yml',
  ];

  expected.forEach((name, i) => {
    assert.equal(
      yamlBlocks[i].trimEnd(),
      exampleBody(name).trimEnd(),
      `README.md's yaml block ${i + 1} has drifted from examples/${name}. ` +
      'Edit the file, then copy it into the README — not the other way round.'
    );
  });
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
