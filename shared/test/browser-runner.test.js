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
 * Then `reloadAndWaitForRow` (`./browser/chrome.mjs`): a unit test of the
 * helper itself, over a fake `ev` that models a window/document/location well
 * enough to reproduce the doomed-document window it exists to close (see the
 * harness's own comment for why a real browser cannot be the witness here),
 * and a source guard that keeps a bare `location.reload()` — or a
 * free-standing `Page.reload` / `Page.navigate` — from creeping back into a
 * suite.
 *
 * And last, the browser a KILLED suite leaves behind. Those tests use real
 * processes and real directories rather than a fake, because what is being
 * asserted is that a process group is gone and a profile directory with it —
 * there is nothing in that to model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
  const state = { win: {}, rows, reloads: 0, doomedAtReload: undefined, sources: [] };
  // The selector is part of the contract `reloadAndWaitForRow` is pinned on —
  // it evaluates `document.querySelectorAll('#grid .habit-row')` and nothing
  // else — so this fake is the only thing that can hold that string to
  // account: a `querySelectorAll` that answered every selector alike would
  // leave the literal free to drift (or be misspelled) with every test here
  // still green, while the real fleet timed out at 20s on all five call sites.
  const doc = () => ({
    querySelectorAll: (selector) => (
      selector === '#grid .habit-row' ? state.rows.map((t) => ({ textContent: t })) : []
    ),
  });
  // Both a `location.reload()` and an EXTERNAL reload (what a CDP reload is —
  // triggered from outside the page) go through the same commit scheduling;
  // `sources` records which door was used, because a single counter cannot
  // tell "called the callback" apart from "evaluated `location.reload()`
  // anyway", and that distinction is the whole point of `reloadAndWaitFor`'s
  // `reload:` option.
  const commit = (source) => {
    state.reloads++;
    state.sources.push(source);
    state.doomedAtReload = state.win.__doomed;
    if (commitAfterMs === null) return;                  // doomed window, held open
    setTimeout(() => { state.win = {}; }, commitAfterMs); // a fresh document
  };
  const location = { reload() { commit('page'); } };
  const reload = async () => commit('external');
  const ev = async (src) => run(state.win, doc(), location, src);
  return { state, ev, reload };
}

test('reloadAndWaitForRow: the wait cannot be satisfied by the document the reload is destroying', async () => {
  const { reloadAndWaitForRow } = await import('./browser/chrome.mjs');
  const { ev } = fakeBrowser({ rows: ['Meditate'], commitAfterMs: null });

  await assert.rejects(
    reloadAndWaitForRow(ev, 'Meditate', { timeoutMs: 300, intervalMs: 10 }),
    // `err.message.includes('Meditate')` alone is satisfied by `waitUntil`'s
    // FALLBACK message too, since with no `what` it interpolates the
    // expression, which already contains `"Meditate"` via `JSON.stringify`.
    // Requiring the `what` wording as well pins that `reloadAndWaitForRow`
    // actually passes one — dropping or renaming the option cannot pass here.
    (err) => err.message.includes('Meditate') && err.message.includes('in the reloaded page'),
  );
});

test('reloadAndWaitForRow: the marker is already set when the reload fires', async () => {
  const { reloadAndWaitForRow } = await import('./browser/chrome.mjs');
  // Same doomed-forever shape as the test above: what matters here is not
  // whether the call settles but what `location.reload()` observed at the
  // instant it fired.
  const { state, ev } = fakeBrowser({ rows: ['Meditate'], commitAfterMs: null });

  await reloadAndWaitForRow(ev, 'Meditate', { timeoutMs: 300, intervalMs: 10 }).catch(() => {});

  assert.equal(state.reloads, 1);
  // Sampled INSIDE location.reload(), so this pins the ordering: the marker
  // was already set at the instant the reload fired, not sometime after.
  // Splitting the marker and the reload into two separate `ev` calls would
  // still pass this, since the fake hands both the same `state.win` — that
  // same-EVALUATION half is the source guard's job, further down this file.
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
    // `err.message.includes('Meditate')` alone is satisfied by `waitUntil`'s
    // FALLBACK message too, since with no `what` it interpolates the
    // expression, which already contains `"Meditate"` via `JSON.stringify`.
    // Requiring the `what` wording as well pins that `reloadAndWaitForRow`
    // actually passes one — dropping or renaming the option cannot pass here.
    (err) => err.message.includes('Meditate') && err.message.includes('in the reloaded page'),
  );
});

/**
 * `reloadAndWaitFor` is the join `reloadAndWaitForRow` above delegates to.
 * Most of these go through the CDP door (a reload triggered from OUTSIDE the
 * page, via the `reload:` option) specifically, since that is the new half —
 * `reloadAndWaitForRow`'s own tests above already cover the in-page default.
 * Two exceptions, each with its own reason at the test: "the default path
 * still reloads in the page" is about the default itself, and the parens
 * test is about the predicate join, which is shared by both doors and does
 * not care which one is exercised. All pass the same row expression as the
 * predicate, so the fake needs no second content model.
 */
const rowExpr = (name) =>
  `[...document.querySelectorAll('#grid .habit-row')].some(r => r.textContent.includes(${JSON.stringify(name)}))`;

test('reloadAndWaitFor: the wait cannot be satisfied by the document the reload is destroying', async () => {
  const { reloadAndWaitFor } = await import('./browser/chrome.mjs');
  // Through the `reload:` callback — this is the CDP door's own version of
  // the doomed-document window, not a re-run of `reloadAndWaitForRow`'s test
  // through a second entry point.
  const { ev, reload } = fakeBrowser({ rows: ['Meditate'], commitAfterMs: null });

  await assert.rejects(
    reloadAndWaitFor(ev, rowExpr('Meditate'), {
      reload, timeoutMs: 300, intervalMs: 10, what: 'a row containing "Meditate" (fake probe)',
    }),
    // A name-only filter is satisfied by `waitUntil`'s FALLBACK message too,
    // since with no `what` it interpolates the expression, which already
    // contains "Meditate" via `JSON.stringify` — the hole review of #271
    // found. Requiring the `what` wording as well pins that this call
    // actually passed one through.
    (err) => err.message.includes('Meditate') && err.message.includes('fake probe'),
  );
});

test('reloadAndWaitFor: the marker is set before the external reload fires', async () => {
  const { reloadAndWaitFor } = await import('./browser/chrome.mjs');
  // Same doomed-forever shape as above: what matters is what the reload
  // callback observed at the instant it fired, sampled INSIDE it — `await
  // reload()` before the marker evaluation would fail this.
  const { state, ev, reload } = fakeBrowser({ rows: ['Meditate'], commitAfterMs: null });

  await reloadAndWaitFor(ev, rowExpr('Meditate'), { reload, timeoutMs: 300, intervalMs: 10 }).catch(() => {});

  assert.equal(state.doomedAtReload, 1);
});

test('reloadAndWaitFor: the callback replaces the in-page reload, it does not add to it', async () => {
  const { reloadAndWaitFor } = await import('./browser/chrome.mjs');
  const { state, ev, reload } = fakeBrowser({ rows: ['Meditate'], commitAfterMs: 40 });

  await reloadAndWaitFor(ev, rowExpr('Meditate'), { reload, timeoutMs: 2000, intervalMs: 10 });

  // Catches both "reloaded twice" (['external', 'page'] or the reverse) and
  // "ignored the callback" (['page']).
  assert.deepEqual(state.sources, ['external']);
});

test('reloadAndWaitFor: the default path still reloads in the page', async () => {
  const { reloadAndWaitFor } = await import('./browser/chrome.mjs');
  const { state, ev } = fakeBrowser({ rows: ['Meditate'], commitAfterMs: 40 });

  await reloadAndWaitFor(ev, rowExpr('Meditate'), { timeoutMs: 2000, intervalMs: 10 });

  assert.deepEqual(state.sources, ['page']);
});

test('reloadAndWaitFor: it returns once the new document has painted', async () => {
  const { reloadAndWaitFor } = await import('./browser/chrome.mjs');
  const { ev, reload } = fakeBrowser({ rows: ['Meditate'], commitAfterMs: 40 });

  // Without this, a predicate that can NEVER be satisfied would pass the
  // "cannot be satisfied" test above too.
  await reloadAndWaitFor(ev, rowExpr('Meditate'), { reload, timeoutMs: 2000, intervalMs: 10 });
});

test('reloadAndWaitFor: a document that commits without the content is still a failure', async () => {
  const { reloadAndWaitFor } = await import('./browser/chrome.mjs');
  // Through the `reload:` callback, same reason as the test above.
  const { ev, reload } = fakeBrowser({ rows: ['Gym'], commitAfterMs: 40 });

  await assert.rejects(
    reloadAndWaitFor(ev, rowExpr('Meditate'), {
      reload, timeoutMs: 300, intervalMs: 10, what: 'a row containing "Meditate" (fake probe)',
    }),
    (err) => err.message.includes('Meditate') && err.message.includes('fake probe'),
  );
});

test('reloadAndWaitFor: the parentheses around the expression are load-bearing against `||`', async () => {
  const { reloadAndWaitFor } = await import('./browser/chrome.mjs');
  // The doomed window held open forever: a sound predicate can never resolve
  // here. `false || true` is unconditionally true, so if the joined predicate
  // were `!window.__doomed && ${expression}` rather than
  // `!window.__doomed && (${expression})`, it would parse as
  // `(!window.__doomed && false) || true` — always true, and this call would
  // resolve immediately in the very document it is supposed to refuse.
  //
  // Left on the default (in-page) path deliberately: the parens live in the
  // join `waitUntil` is handed, which is shared by both doors, so which one
  // fires the reload is irrelevant to what this test pins.
  const { ev } = fakeBrowser({ rows: [], commitAfterMs: null });

  await assert.rejects(
    reloadAndWaitFor(ev, 'false || true', {
      timeoutMs: 300, intervalMs: 10, what: 'a bare boolean expression containing ||',
    }),
    // `assert.rejects` with no filter passes on ANY rejection, including one
    // from a typo in the expression rather than the timeout this is actually
    // about. Requiring the timeout wording, and the `what` this test passed,
    // pins that it rejected FOR THIS REASON — with the parens dropped the call
    // resolves instead, so this filter is never reached at all.
    (err) => err.message.includes('timed out') && err.message.includes('a bare boolean expression containing ||'),
  );
});

/**
 * The guard below reads source text one line at a time, and that decision is
 * extracted here so the guard's own sanity checks can run a synthetic offender
 * and a synthetic comment through the SAME predicate the scan uses — not
 * through a second copy of it, which would pin a regex nobody reads and leave
 * the one that runs free to be broadened.
 */
const isReloadCallSite = (line) => {
  if (/^\s*(\*|\/\/)/.test(line)) return false;   // a comment mentioning it is not a call site
  // Never sanctioned in a suite, in any position: the default path does the
  // marker and the reload in ONE evaluation, so handing `location.reload()` in
  // as a `reload:` callback would break the property this whole guard is for.
  if (line.includes('location.reload(')) return true;
  // A CDP reload is sanctioned ONLY as `reloadAndWaitFor`'s own argument.
  if (line.includes('Page.reload') && !/\breload:.*Page\.reload/.test(line)) return true;
  // A CDP NAVIGATION is the same race through the same door, so it is
  // sanctioned the same way — plus one thing `Page.reload` has no need of: an
  // annotated opt-out, for the handful of sites where the join is unsound or
  // unwanted. The reason has to be non-empty (`\S`), or `// navigate-unjoined:`
  // becomes a bare token anyone can paste in to silence this.
  //
  // Matched as a QUOTED method name rather than by `includes`, unlike
  // `Page.reload` above, and that is not tidiness: `Page.navigate` is written
  // in PROSE all over these suites, and `categorycheck.mjs` says it inside a
  // `/* … */` block whose continuation lines carry no leading `*` — invisible
  // to a line-based comment skip, and reported as a call site by an `includes`.
  // A CDP call always spells the method as a string literal and prose never
  // does, so the quotes are the one signal that separates them without this
  // guard having to parse across lines. Both quote characters, since either is
  // a legal way to write the call.
  return /['"]Page\.navigate['"]/.test(line)
    && !/\breload:.*Page\.navigate/.test(line)
    && !/navigate-unjoined:\s*\S/.test(line);
};

/**
 * A line whose `Page.navigate` is excused by an annotated reason, which is
 * what `NAVIGATE_UNJOINED` below counts.
 *
 * The structural conditions are re-asked here rather than inferred from
 * `!isReloadCallSite(line)`, and that is the whole care in this predicate.
 * `isReloadCallSite` is false for SEVERAL different reasons — the comment
 * skip, the `reload:` clause, and the marker — so negating it reads as "the
 * guard would have reported this line but for the marker" while actually
 * meaning "the guard did not report this line, for any reason at all". A
 * marker pasted onto a `reload:` argument or into a comment would then be
 * BANKED as an exemption: the count for that file goes up, the `deepEqual`
 * below fails, and the mechanical repair is to register a phantom entry for a
 * line that is not a call site and exempts nothing. The registry is the entire
 * review surface this guard adds, so it must not be able to acquire one.
 *
 * `!isReloadCallSite` is still ANDed in, and now means only what it says: a
 * line that offends for an unrelated reason (a `location.reload(` or a
 * free-standing `Page.reload` sharing it) is reported rather than counted.
 */
const isSanctionedNavigate = (line) =>
  /['"]Page\.navigate['"]/.test(line)
  && /navigate-unjoined:\s*\S/.test(line)
  && !/^\s*(\*|\/\/)/.test(line)
  && !/\breload:.*Page\.navigate/.test(line)
  && !isReloadCallSite(line);

/**
 * Every sanctioned unjoined `Page.navigate` in the tree, per file, with the
 * reason — a map rather than a set for the same reason `notMirrored` is one:
 * an exemption that carries no reason is an exemption nobody can review.
 *
 * The value is a COUNT and not a line number on purpose. A file:line pin goes
 * stale on the next edit above it and gets updated mechanically, which is how a
 * registry stops being read; a count survives a line move and changes only when
 * an exemption is added or removed, which is exactly the reviewed act this
 * table exists to force.
 */
const NAVIGATE_UNJOINED = {
  'calcheck.mjs':      { count: 1, why: 'followed by a bare sleep, with no predicate to join' },
  'feat4.mjs':         { count: 1, why: 'followed by a bare sleep, with no predicate to join' },
  'hangcheck.mjs':     { count: 1, why: 'a bounded poll, so a hang is REPORTED rather than thrown' },
  'notifycheck.mjs':   { count: 1, why: 'followed by a bare sleep, with no predicate to join' },
  'pwatest.mjs':       { count: 1, why: 'one `goto` helper called both online at boot and with the network cut; a sleep plus a check names the failure either way, where a throw would not' },
  'responsive.mjs':    { count: 1, why: 'followed by a bare sleep, with no predicate to join' },
  'settingscheck.mjs': { count: 2, why: 'both followed by a bare sleep, with no predicate to join' },
  'themecheck.mjs':    { count: 1, why: "a TRIPWIRE, not a working path: the same-document branch of `boot`'s conditional is dead today (both callers are cross-document) and would not be a fix if it fired, since its `waitUntil` predicate is already true in the document a fragment change leaves in place — it exists so a line-move cannot silently hand a fragment caller a marker that never clears" },
  'timepicker.mjs':    { count: 2, why: 'one bare sleep, and one about:blank teardown a poll evaluated in the page cannot see' },
};

/**
 * What this guard covers, and what it deliberately still does not.
 *
 * It forbids `location.reload(` anywhere at all, including inside a `reload:`
 * callback — the in-page reload only joins soundly with the marker as ONE
 * evaluation, so handing it in as a callback would recreate the exact bug
 * `reloadAndWaitFor` exists to close. It forbids a free-standing CDP reload
 * (`send('Page.reload', …)`) too — the door #269 opened, since a reload issued
 * over CDP cannot literally share an evaluation with the marker the way the
 * in-page one does — and exempts `Page.reload` ONLY where it is
 * `reloadAndWaitFor`'s own `reload:` argument, which is the join `chrome.mjs`
 * now provides for that case.
 *
 * It forbids a free-standing `Page.navigate` on the same terms — the widened
 * half of #269, and the same race: `Page.navigate` resolves before the new
 * document commits, so a wait written as a separate statement can be answered
 * by the document the navigation is destroying. A fragment-less target is
 * always a cross-document load (HTML's fragment fast-path requires the TARGET
 * url's fragment to be non-null), which is what makes the marker sound at
 * essentially every site in the tree. The sites where it is NOT are in
 * `NAVIGATE_UNJOINED` above, each carrying a `// navigate-unjoined: <reason>`
 * marker at the call site so a reader THERE sees why.
 *
 * That exemption is a SINGLE-LINE match, because this is a line-based guard
 * and stays one: it does not parse across a wrap. Splitting the callback —
 * `reload: () =>` on one line and `send('Page.reload', …)` on the next — makes
 * the guard misread it as a free-standing CDP reload, and drops the
 * "exemption is exercised" floor below to zero at the same time. Keep
 * `reload: () => send('Page.reload', …)` — and the `Page.navigate` form of it —
 * on one physical line.
 */
test('no suite issues a free-standing reload or navigation outside reloadAndWaitFor', () => {
  const offenders = [];
  const unjoined = {};
  let scanned = 0;
  let sanctioned = 0;
  for (const file of readdirSync(browserDir).filter((f) => f.endsWith('.mjs') && f !== 'chrome.mjs')) {
    scanned++;
    const src = readFileSync(join(browserDir, file), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (isReloadCallSite(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      if (line.includes('Page.reload') && /\breload:.*Page\.reload/.test(line)) sanctioned++;
      if (isSanctionedNavigate(line)) unjoined[file] = (unjoined[file] ?? 0) + 1;
    });
  }
  assert.deepEqual(offenders, []);

  // The registry. Adding an exemption has to be a reviewed act rather than a
  // marker quietly appearing in a diff, and removing one has to update the
  // table — so the counts found by the scan must equal the counts declared,
  // in both directions.
  assert.deepEqual(
    unjoined,
    Object.fromEntries(Object.entries(NAVIGATE_UNJOINED).map(([f, e]) => [f, e.count])),
    'the sanctioned `navigate-unjoined:` sites no longer match NAVIGATE_UNJOINED',
  );
  for (const [file, { why }] of Object.entries(NAVIGATE_UNJOINED)) {
    assert.ok(why && why.length > 20, `NAVIGATE_UNJOINED['${file}'] carries no usable reason`);
  }

  // `deepEqual(offenders, [])` is satisfied by an EMPTY SCAN as readily as by a
  // clean tree, which is the shape of dead test this repo ships most — the same
  // hole `seen.size > 20` closes for the port test above. Two things can empty
  // this one silently, so there is a floor for each.
  //
  // The file filter: widen `endsWith('.mjs')`, point `browserDir` a directory
  // wrong, or exclude more than `chrome.mjs`, and nothing is read at all.
  assert.ok(scanned > 25, `only scanned ${scanned} suite files; has the filter or the directory changed?`);

  // A third way to go quiet: the `reload:` exemption could rot into a
  // permanently dead branch — matched by nothing, permitted for nothing —
  // while every assertion above stays green. This is the floor that the
  // exemption is exercised by real source, not only by the synthetic cases
  // below.
  assert.ok(sanctioned > 0,
    'no suite uses the sanctioned `reload: … Page.reload(...)` form; has snackcheck.mjs changed?');

  // The predicate: broadening the comment skip, or losing a literal, disarms
  // the scan while every assertion above still passes. Each line below is run
  // through the SAME predicate the loop just used, in both directions — a table
  // that only listed offenders would be satisfied by a predicate that returned
  // `true` for everything, which reports the whole tree.
  const cases = [
    ['  await ev(`location.reload(); true`);', true, 'a bare call site'],
    ['location.reload();', true, 'an unindented bare call site'],
    // This one is the boundary, and it is why the skip must be a COMMENT-LINE
    // test rather than a leading-slash one: `/^\s*[*\/]/` reads identically,
    // is the obvious "tidy-up" of the regex above, and silently swallows every
    // line whose first non-space character is a slash along with the block
    // comment it was aimed at.
    ['/* a note */ await ev(`location.reload(); true`);', true, 'a call site after a block comment'],
    ['  // location.reload() is what this guard forbids', false, 'a line comment'],
    ['   * `location.reload()` and the wait after it are one call', false, 'a JSDoc line'],
    ['  await reloadAndWaitForRow(ev, "Smoking");', false, 'the helper this guard points everyone at'],
    ["  await send('Page.reload',{},sessionId);", true, 'a free-standing CDP reload'],
    ["    reload: () => send('Page.reload', {}, sessionId),", false, "the helper's own argument"],
    ['  // a note mentioning Page.reload', false, 'a comment naming Page.reload'],
    // The `Page.navigate` half, in BOTH directions. A table listing only the
    // exemptions would be satisfied by a predicate that returned `false` for
    // every navigation, which is the whole widening silently undone.
    ["  await send('Page.navigate', { url: BASE }, sessionId);", true, 'a free-standing Page.navigate'],
    ["    reload: () => send('Page.navigate', { url: BASE }, sessionId),", false, "the helper's own navigate argument"],
    ["  await send('Page.navigate', { url: APP }, sessionId); // navigate-unjoined: a bare sleep follows",
      false, 'an annotated opt-out'],
    // An EMPTY reason must buy nothing, or the marker degenerates into a token
    // to paste in — which is precisely the reviewed act the registry exists to
    // force.
    ["  await send('Page.navigate', { url: APP }, sessionId); // navigate-unjoined:",
      true, 'an opt-out with no reason after it'],
    ["  // a note mentioning send('Page.navigate', …)", false, 'a comment naming Page.navigate'],
    // The shape that made the quoted-method match necessary, from
    // `categorycheck.mjs`: prose inside a `/* … */` block, on a continuation
    // line with no leading `*`, so the comment skip above cannot see it.
    ['     block earlier in this suite is preceded by a `Page.navigate` that throws',
      false, 'prose naming Page.navigate inside a block comment'],
    // And this one pins the asymmetry above: `location.reload(` offends even
    // inside a `reload:` callback, where `Page.reload` alone would not.
    ["  reload: () => ev('location.reload()')", true, 'location.reload( inside a reload: callback'],
  ];
  for (const [line, offends, what] of cases) {
    assert.equal(
      isReloadCallSite(line), offends,
      `the scan misreads ${what}, so it can no longer see what it exists to see: ${line.trim()}`,
    );
  }

  // The registry's OWN predicate, which the table above does not exercise at
  // all — every case there runs through `isReloadCallSite`, and one function
  // proved cannot justify two. What these pin is that a marker only counts
  // where it is doing work: pasted onto a `reload:` argument or into a
  // comment it must buy nothing, or the count for that file rises, the
  // `deepEqual` above fails, and the repair that suggests itself is to
  // register a PHANTOM entry for a line that is not a call site and exempts
  // nothing. The registry is this guard's whole review surface.
  const sanctionedCases = [
    ["  await send('Page.navigate', { url: APP }, sessionId); // navigate-unjoined: a bare sleep follows",
      true, 'a real annotated call site'],
    ["    reload: () => send('Page.navigate', { url: APP }, sessionId), // navigate-unjoined: bogus",
      false, "a marker pasted onto reloadAndWaitFor's own argument"],
    ["  // a note about send('Page.navigate', …) navigate-unjoined: bogus",
      false, 'a marker pasted into a comment'],
    ["  await send('Page.navigate', { url: APP }, sessionId); // navigate-unjoined:",
      false, 'a marker with no reason after it'],
    ["  await send('Page.navigate', { url: APP }, sessionId);",
      false, 'an unmarked free-standing navigate — an offender, not an exemption'],
  ];
  for (const [line, sanctioned, what] of sanctionedCases) {
    assert.equal(
      isSanctionedNavigate(line), sanctioned,
      `the registry miscounts ${what}, so it can acquire an entry that exempts nothing: ${line.trim()}`,
    );
  }

  // And a floor on the one file excluded above: `chrome.mjs` must still hold
  // exactly the join this guard exists to keep everyone else from re-inventing.
  // This is a floor on the SOURCE TEXT only; the BEHAVIOUR (that the wait
  // cannot be satisfied by the doomed document) is pinned by
  // `reloadAndWaitForRow`'s own tests above, not by this one.
  const chromeSrc = readFileSync(join(browserDir, 'chrome.mjs'), 'utf8');
  assert.match(
    chromeSrc,
    /window\.__doomed\s*=\s*1;\s*location\.reload\(\)/,
    "chrome.mjs no longer marks the document in the same evaluation as the reload",
  );
});

/**
 * A suite that overruns is SIGKILLed, and until #317 its browser was not.
 *
 * The chain: `runSuite` (`browser/run.mjs`) kills the suite's process GROUP,
 * `launchChrome` (`browser/chrome.mjs`) spawns Chrome `detached: true` — a
 * group of its own — and the `exit` handler beside that spawn is the one thing
 * a SIGKILL never runs. Measured against the unfixed tree: forcing
 * `categorycheck` past `SUITE_TIMEOUT_MS` left 13 live Chrome processes and its
 * profile directory behind after the runner had exited, and an orphan is a live
 * client that WRITES to the instance the next suite's `fixtures.reset()` is
 * about to assert on.
 *
 * So the suite writes down what it launched (`CHROME_RECORD`) and the runner
 * reaps it. Three properties, and each is checked against real processes:
 * the record round-trips through both halves, the reap kills the whole GROUP
 * and takes the profile with it, and a browser shut down normally is struck
 * off so its pid can never be reaped later.
 *
 * `CHROME` is node's own binary here (see the top of this file), so a browser
 * `launchChrome` actually spawns refuses its Chrome flags and exits at once —
 * which is fine for the two tests about the RECORD, and is why the test about
 * the KILL supplies its own long-lived stand-in instead.
 */

/** A port nothing is listening on, so `Browser.close` is a no-op and the group kill is what is under test. */
const DEAD_PORT = 9099;

/** Does this pid still exist? Signal 0 tests for the process without touching it. */
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const settle = async (predicate, what, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
};

test('launchChrome writes the browser down, and reapBrowsers reads that same record back', async () => {
  const { launchChrome, reapBrowsers } = await import('./browser/chrome.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'habrecord-'));
  const profile = mkdtempSync(join(tmpdir(), 'habrecord-profile-'));
  const record = join(dir, 'weekcheck-9099.json');
  process.env.CHROME_RECORD = record;

  try {
    const chrome = launchChrome(DEAD_PORT, profile);

    // Read back through `reapBrowsers` rather than by parsing the file here:
    // the writer and the reader are the pair that has to agree, and a test that
    // parsed the line itself would keep passing while they drifted apart.
    assert.deepEqual(
      await reapBrowsers(record),
      [{ pid: chrome.pid, port: DEAD_PORT, profile }],
      'the runner cannot find the browser the suite launched',
    );
    assert.equal(existsSync(record), false, 'the reap left its own record behind');
  } finally {
    delete process.env.CHROME_RECORD;
    rmSync(dir, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
});

test('reapBrowsers kills the recorded process GROUP, and takes the profile with it', async () => {
  const { reapBrowsers } = await import('./browser/chrome.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'habrecord-'));
  const profile = mkdtempSync(join(tmpdir(), 'habrecord-profile-'));
  writeFileSync(join(profile, 'Preferences'), '{}');
  const record = join(dir, 'weekcheck-9099.json');
  const kidFile = join(dir, 'kid.pid');

  // A stand-in browser that forks a child of its own, which is what makes this
  // a test of the GROUP kill: a plain `kill(pid)` takes the parent and leaves
  // the child reparented to init and running, exactly as `kill()` leaves a real
  // Chrome's renderers (`closeChrome`'s own note measures that at 14 -> 14).
  const standIn = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(process.argv[1], String(kid.pid));
    setInterval(() => {}, 1000);
  `, kidFile], { detached: true, stdio: 'ignore' });

  let standInExited = false;
  standIn.on('exit', () => { standInExited = true; });

  let kid = 0;
  try {
    await settle(() => existsSync(kidFile) && readFileSync(kidFile, 'utf8').length > 0,
      'the stand-in browser to fork a child');
    kid = Number(readFileSync(kidFile, 'utf8'));
    assert.ok(alive(kid), 'the stand-in never got as far as forking');

    writeFileSync(record, `${JSON.stringify({ pid: standIn.pid, port: DEAD_PORT, profile })}\n`);
    await reapBrowsers(record);

    // The stand-in is a child of THIS process, so a `kill(pid, 0)` on it
    // succeeds for as long as it is a zombie — its own `exit` event is the only
    // honest witness. The grandchild is nobody's child here, so it is reaped by
    // init and `alive` answers for it.
    await settle(() => standInExited, 'the stand-in browser to die');
    await settle(() => !alive(kid), 'the browser\'s child to die with its group');
    assert.equal(existsSync(profile), false, 'the reap left the profile directory behind');
    assert.equal(existsSync(record), false, 'the reap left its own record behind');
  } finally {
    try { process.kill(-standIn.pid, 'SIGKILL'); } catch { /* the reap got it */ }
    if (kid) { try { process.kill(kid, 'SIGKILL'); } catch { /* the reap got it */ } }
    rmSync(dir, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
});

test('closeChrome strikes its browser off, so a later reap cannot kill a recycled pid', async () => {
  const { closeChrome, launchChrome, reapBrowsers } = await import('./browser/chrome.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'habrecord-'));
  const profile = mkdtempSync(join(tmpdir(), 'habrecord-profile-'));
  const record = join(dir, 'weekcheck-9099.json');
  process.env.CHROME_RECORD = record;

  try {
    const chrome = launchChrome(DEAD_PORT, profile);
    await closeChrome({ chrome, port: DEAD_PORT, profile });

    // The record now names a browser that is already gone, and a pid the OS is
    // free to hand to somebody else. Left on the record, the runner's reap
    // after a later timeout would SIGKILL whatever process group had inherited
    // it — which is the reason a browser closed properly comes off again.
    assert.deepEqual(await reapBrowsers(record), [],
      'a browser closed by its own suite is still on the record');
  } finally {
    delete process.env.CHROME_RECORD;
    rmSync(dir, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
});

/**
 * The WIRING, over the real runner in a child process.
 *
 * `weekcheck` is in `OFFLINE_SUITES`, so this needs neither a server nor a
 * browser, and a `SUITE_TIMEOUT_MS` of 1ms kills it during node's own startup —
 * the timeout path, reached without waiting two minutes for it.
 *
 * What it pins is that the timeout path REACHES the reap and AWAITS it before
 * the suite's result is resolved: the note the reap returns is in the runner's
 * own output, which it can only be if it was awaited (it is produced
 * asynchronously, after the `exit` event that used to resolve immediately). It
 * cannot pin that the path handed to the reap is the one the child was told to
 * write to — nothing offline launches a browser — so the assertion below on
 * `run.mjs`'s source covers that half, and the fleet measurement in the pull
 * request covers both together.
 */
test('the runner reaps on the timeout path, and waits for the reap before moving on', () => {
  // `BASES` is DELETED rather than blanked: the runner reads an empty one as
  // "no bases given" and exits 2 before it starts anything.
  const env = { ...process.env, SUITE_TIMEOUT_MS: '1', BASE: 'http://127.0.0.1:1' };
  delete env.BASES;

  const run = spawnSync(process.execPath, [join(browserDir, 'run.mjs'), 'weekcheck'], {
    encoding: 'utf8', env,
  });

  const all = `${run.stdout}${run.stderr}`;
  assert.match(all, /TIMEOUT after 0\.001s — killing weekcheck/,
    `the suite was not killed at all:\n${all}`);
  assert.match(all, /nothing to reap: the suite launched no browser/,
    `the timeout path did not reach the reap:\n${all}`);
  assert.match(run.stdout, /FAIL\s+weekcheck/, `a killed suite did not fail:\n${all}`);
  assert.equal(run.status, 1);
});

/**
 * The half the test above cannot see, and it is a SOURCE guard with all that
 * implies — it cannot see a renamed binding or an inverted comparison. What it
 * does catch is the thing that would make every test above pass while the fleet
 * leaked exactly as before: a runner that reaps a path no suite was ever told
 * to write to, or that starts the reap and does not wait for it. The reap
 * having to complete FIRST is the whole point — the next suite's
 * `fixtures.reset()` runs against that instance the moment this resolves.
 */
test('the runner tells each suite where to record its browser', () => {
  const src = readFileSync(join(browserDir, 'run.mjs'), 'utf8');

  assert.match(src, /CHROME_RECORD:\s*record/,
    'run.mjs no longer tells the suite where to write its browser down');
  assert.match(src, /reaping\s*=\s*reapAfterTimeout\(record\)/,
    'the timeout path no longer reaps the record it handed that suite');
  assert.match(src, /await reaping/,
    'the reap is started and not awaited, so the next suite can race the orphan');
});
