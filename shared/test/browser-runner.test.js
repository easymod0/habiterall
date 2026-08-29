/**
 * Invariants about the browser runner that a passing suite cannot show you.
 *
 * Two are about the DevTools port assignment. Both exist because the suites
 * went parallel. Serially a duplicate DevTools port is invisible — the first
 * browser is dead before the second launches — so `searchcheck`/`unknowncheck`
 * (both 9296) and `notifycheck`/`nudgecheck` (both 9297) sat in the tree for
 * as long as they did without ever failing. Run either pair at once and the
 * second suite attaches to the first one's browser; measured, both hung to
 * the 120s suite timeout.
 *
 * The rest are about `reloadAndWaitForRow` (`./browser/chrome.mjs`): a unit
 * test of the helper itself, over a fake `ev` that models a window/document/
 * location well enough to reproduce the doomed-document window it exists to
 * close (see the harness's own comment for why a real browser cannot be the
 * witness here), and a source guard that keeps a bare `location.reload()`
 * from creeping back into a suite.
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

/**
 * `reloadAndWaitForRow` (`./browser/chrome.mjs`) takes `ev` as a PARAMETER and
 * touches no browser API of its own: its entire contract is which strings it
 * sends to `ev`, in what order. So a fake `ev` that really evaluates those
 * strings against a modelled window/document/location tests it completely,
 * deterministically, with no Chrome at all — and, unlike a real browser on
 * this machine (see `docs/decisions/testing.md`), it CAN hold the doomed
 * document open, because "the navigation never commits" is a `setTimeout` this
 * fake controls rather than an event a real page fires once and is gone.
 *
 * `eval(src)` inside `run` is a DIRECT eval — a call written literally as
 * `eval(...)`, not aliased — which is what lets it see the `window` /
 * `document` / `location` parameters in scope. That is what makes the
 * helper's own evaluated strings executable against this fake at all.
 */
const run = new Function('window', 'document', 'location', 'src', 'return eval(src)');

function fakeBrowser({ rows, commitAfterMs }) {
  const state = { win: {}, rows, reloads: 0, doomedAtReload: undefined };
  const doc = () => ({
    querySelectorAll: () => state.rows.map((t) => ({ textContent: t })),
  });
  const location = {
    reload() {
      state.reloads++;
      state.doomedAtReload = state.win.__doomed;
      if (commitAfterMs === null) return;                  // doomed window, held open
      setTimeout(() => { state.win = {}; }, commitAfterMs); // a fresh document
    },
  };
  const ev = async (src) => run(state.win, doc(), location, src);
  return { state, ev };
}

test('reloadAndWaitForRow: the wait cannot be satisfied by the document the reload is destroying', async () => {
  const { reloadAndWaitForRow } = await import('./browser/chrome.mjs');
  const { ev } = fakeBrowser({ rows: ['Meditate'], commitAfterMs: null });

  await assert.rejects(
    reloadAndWaitForRow(ev, 'Meditate', { timeoutMs: 300, intervalMs: 10 }),
    (err) => err.message.includes('Meditate'),
  );
});

test('reloadAndWaitForRow: the marker is set in the same evaluation as the reload', async () => {
  const { reloadAndWaitForRow } = await import('./browser/chrome.mjs');
  // Same doomed-forever shape as the test above: what matters here is not
  // whether the call settles but what `location.reload()` observed at the
  // instant it fired.
  const { state, ev } = fakeBrowser({ rows: ['Meditate'], commitAfterMs: null });

  await reloadAndWaitForRow(ev, 'Meditate', { timeoutMs: 300, intervalMs: 10 }).catch(() => {});

  assert.equal(state.reloads, 1);
  // Sampled INSIDE location.reload(), so this pins the ordering: the marker
  // was already set at the instant the reload fired, not sometime after.
  assert.equal(state.doomedAtReload, 1);
});

test('reloadAndWaitForRow: it returns once the new document has painted the row', async () => {
  const { reloadAndWaitForRow } = await import('./browser/chrome.mjs');
  const { ev } = fakeBrowser({ rows: ['Meditate'], commitAfterMs: 40 });

  // Without this test, a predicate that can never be satisfied would pass
  // the "cannot be satisfied" test above too.
  await reloadAndWaitForRow(ev, 'Meditate', { timeoutMs: 2000, intervalMs: 10 });
});

test("reloadAndWaitForRow: a document that commits without this habit's row is still a failure", async () => {
  const { reloadAndWaitForRow } = await import('./browser/chrome.mjs');
  const { ev } = fakeBrowser({ rows: ['Gym'], commitAfterMs: 40 });

  await assert.rejects(
    reloadAndWaitForRow(ev, 'Meditate', { timeoutMs: 300, intervalMs: 10 }),
    (err) => err.message.includes('Meditate'),
  );
});

/**
 * What this guard does NOT cover, said plainly so the next reader does not
 * mistake a green run for a swept directory: it matches the literal text
 * `location.reload(`, so a reload issued over CDP as `send('Page.reload', …)`
 * is invisible to it. `snackcheck.mjs` already does that twice, and the poll
 * after each one waits on a detail view that was open BEFORE the reload — the
 * same doomed-document shape, reached by a different door. That is #154's
 * audit being scoped to `location.reload()`, not this guard failing; it is
 * #269, filed rather than widened into here.
 */
test('no suite calls location.reload() on its own — the reload and the wait after it are one call', () => {
  const offenders = [];
  for (const file of readdirSync(browserDir).filter((f) => f.endsWith('.mjs') && f !== 'chrome.mjs')) {
    const src = readFileSync(join(browserDir, file), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return; // a comment mentioning it is not a call site
      if (line.includes('location.reload(')) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);

  // A sanity floor for the assertion above, so it cannot pass by the pattern
  // silently stopping matching: `chrome.mjs` — the one file excluded above —
  // must still hold exactly the join this guard exists to keep everyone else
  // from re-inventing. This is a floor on the SOURCE TEXT only; the BEHAVIOUR
  // (that the wait cannot be satisfied by the doomed document) is pinned by
  // `reloadAndWaitForRow`'s own tests above, not by this one.
  const chromeSrc = readFileSync(join(browserDir, 'chrome.mjs'), 'utf8');
  assert.match(
    chromeSrc,
    /window\.__doomed\s*=\s*1;\s*location\.reload\(\)/,
    "chrome.mjs no longer marks the document in the same evaluation as the reload",
  );
});
