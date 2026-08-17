/**
 * The browser runner's two invariants that a passing suite cannot show you.
 *
 * Both exist because the suites went parallel. Serially a duplicate DevTools
 * port is invisible — the first browser is dead before the second launches —
 * so `searchcheck`/`unknowncheck` (both 9296) and `notifycheck`/`nudgecheck`
 * (both 9297) sat in the tree for as long as they did without ever failing.
 * Run either pair at once and the second suite attaches to the first one's
 * browser; measured, both hung to the 120s suite timeout.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const browserDir = join(dirname(fileURLToPath(import.meta.url)), 'browser');

/**
 * `chrome.mjs` calls `findChrome()` at import time, which throws where there is
 * no browser — and `npm test` must need nothing. `CHROME_PATH` is honoured
 * ahead of every search path, and node's own binary is a file that exists, so
 * this makes the import succeed without asserting anything about it.
 */
process.env.CHROME_PATH = process.execPath;

test('devtoolsPort prefers the runner assignment over the suite literal', async () => {
  delete process.env.DEVTOOLS_PORT;
  const { devtoolsPort } = await import('./browser/chrome.mjs');

  // Standalone: `node shared/test/browser/themecheck.mjs` has no runner, and
  // debugging one suite that way must keep working.
  assert.equal(devtoolsPort(9317), 9317);

  // Under the runner. The literal must LOSE — a helper that preferred it would
  // read as wired up and assign nothing, which is the bug this exists for.
  process.env.DEVTOOLS_PORT = '9407';
  assert.equal(devtoolsPort(9317), 9407);

  // Junk falls back rather than launching Chrome on port NaN.
  process.env.DEVTOOLS_PORT = 'not-a-port';
  assert.equal(devtoolsPort(9317), 9317);
  delete process.env.DEVTOOLS_PORT;
});

test('no two suites share a fallback DevTools port', () => {
  const seen = new Map();
  const clashes = [];

  for (const file of readdirSync(browserDir).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(join(browserDir, file), 'utf8');
    const m = src.match(/PORT\s*=\s*devtoolsPort\((\d+)\)/);
    if (!m) continue;
    const port = Number(m[1]);
    if (seen.has(port)) clashes.push(`${seen.get(port)} and ${file} both use ${port}`);
    else seen.set(port, file);
  }

  // A sanity floor: if the pattern above ever stops matching, this test would
  // pass by finding nothing at all — the shape of dead test this repo ships most.
  assert.ok(seen.size > 20, `only found ${seen.size} suite ports; has the declaration changed?`);
  assert.deepEqual(clashes, []);
});
