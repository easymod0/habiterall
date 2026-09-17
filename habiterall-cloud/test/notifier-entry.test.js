import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A structural guard for the one property #194's review surface actually
 * needs one for: that `server.js` no longer imports the tick, and that
 * `notifier-entry.js` imports nothing a request needs.
 *
 * **This reads SOURCE TEXT, so it cannot see a renamed binding** — a
 * `startNotifier` reimported as `boot` would sail through the specifier
 * check below. That gap is exactly what `test/drain.integration.mjs`'s
 * "the booted web server logs no notify.starting" assertion exists to close,
 * behaviourally, over the real process. This file is here for what a source
 * read DOES catch cleanly: a file importing a module it must not.
 *
 * Per the root `CLAUDE.md`'s "check that it SEES the sites it claims" — an
 * empty offender list means nothing until the denominator is known — every
 * case below prints the full specifier list it searched, not only what
 * failed.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every module specifier a file's `import`/`from`/dynamic `import()` names. */
function specifiersOf(text) {
  const specs = [
    ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ];
  return specs.map(([, spec]) => spec);
}

test('server.js keeps ./notifier.js (for ntfyAnswerAdapter) but drops the tick', () => {
  const path = join(ROOT, 'src/server.js');
  assert.ok(existsSync(path), `${path} does not exist`);
  const text = readFileSync(path, 'utf8');
  const specs = specifiersOf(text);
  console.log(`src/server.js imports (${specs.length}): ${specs.join(', ')}`);

  assert.ok(specs.includes('./notifier.js'),
    'src/server.js must still import ./notifier.js, for ntfyAnswerAdapter — '
    + `the ntfy button still posts to the app. Found: ${specs.join(', ')}`);
  assert.ok(!specs.includes('./backup.js'),
    'src/server.js must not import ./backup.js — the backup block moved to '
    + `notifier-entry.js and api.js gets what /backup/status needs on its own. Found: ${specs.join(', ')}`);
  // A source-text check, not an import-specifier one: this is what catches a
  // `startNotifier` re-added under the SAME name (a renamed binding is
  // `drain.integration.mjs`'s job, not this file's).
  assert.ok(!/\bstartNotifier\b/.test(text),
    'src/server.js must not bind startNotifier anywhere in its source — the '
    + 'tick, the gateway and the scheduled dump moved to notifier-entry.js');
});

test('notifier-entry.js imports nothing a request needs', () => {
  const path = join(ROOT, 'src/notifier-entry.js');
  assert.ok(existsSync(path), `${path} does not exist`);
  const text = readFileSync(path, 'utf8');
  const specs = specifiersOf(text);
  console.log(`src/notifier-entry.js imports (${specs.length}): ${specs.join(', ')}`);

  // Every specifier this process must not carry: no Express, no session
  // store, no static mounts, no ./api.js, no ./auth.js, no rate limiters.
  const forbidden = [
    'express', 'express-session', 'connect-pg-simple', 'helmet', 'express-rate-limit',
    './api.js', './auth.js', './session-touch.js', './health.js',
  ];
  const present = forbidden.filter((f) => specs.includes(f));
  assert.deepEqual(present, [],
    `notifier-entry.js must import none of [${forbidden.join(', ')}] — found `
    + `${present.join(', ')} among its actual specifiers: ${specs.join(', ')}`);
});

test('notifier-entry.js exists and parses', () => {
  const path = join(ROOT, 'src/notifier-entry.js');
  assert.ok(existsSync(path), `${path} does not exist`);
  // Throws (with the syntax error on stderr) if the file does not parse —
  // this is the same check STEP 3's mutation proofs run by hand before
  // trusting any failure below it.
  execFileSync(process.execPath, ['--check', path]);
});
