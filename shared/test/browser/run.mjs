/**
 * Runs the browser-based UI suites against one or more live servers.
 *
 * These are separate from `npm test` because they need Chrome and a running
 * instance. They are the only tests that catch a whole class of bug the unit
 * suite structurally cannot — notably a CSS `display` rule silently defeating
 * the `hidden` attribute, which shipped once and made the day editor show
 * both habit types' controls at the same time.
 *
 *   node shared/test/browser/run.mjs                    # against :3000
 *   BASE=http://localhost:3100 node .../run.mjs         # against the cloud app
 *   node shared/test/browser/run.mjs pwatest browsercheck
 *   node .../run.mjs --bases http://localhost:3000,http://localhost:3001
 *
 * **A worker OWNS the instance it points at.** `fixtures.reset()` runs before
 * every suite and DELETEs every habit in it, so two suites sharing one server
 * destroy each other's data mid-run — and nothing in the output says so.
 * Observed in a server log while two processes shared a port:
 *
 *     PUT    /api/habits/283/entries/2026-08-16   200   <- suite's first tap
 *     DELETE /api/settings                        200   \  the other runner's
 *     DELETE /api/habits/279 … /283               204   /  fixtures.reset()
 *     GET    /api/habits/283/entries              404   {"error":"habit not found"}
 *
 * What a suite reports is a row that has vanished — historically a bare
 * `Cannot read properties of undefined`, which is also exactly what a wait too
 * weak to see its own row produces (see `reloadAndWaitForRow` in chrome.mjs). Two
 * causes, one signature, and only one of them is in the code.
 *
 * That is why **the parallelism here is the number of BASES and cannot be set
 * separately.** One worker per instance, no flag that can put two workers on
 * one server. Starting the fleet is the caller's job — the runner stays
 * edition-agnostic, because cloud is pointed at with the same command — and
 * `habiterall-personal`'s `npm run test:browser` is what does it for the
 * ordinary case: N servers, N throwaway SQLite files, N bases handed here.
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Suites that need no server (pure rendering against a fake DOM). */
const OFFLINE_SUITES = new Set(['rendercheck', 'daydialog', 'atmost', 'weekcheck']);

/**
 * A scheduling HINT, not a contract: the run is correct in any order, because
 * every suite resets fixtures before it starts and none reads another's state.
 *
 * It exists because the tail of a parallel run is one long suite finishing
 * alone. Handing the slowest out first keeps the workers busy to the end —
 * a suite that takes a third of the run and starts last adds most of itself to
 * the wall clock. A name that no longer exists here costs nothing; a new slow
 * suite missing from it costs a few seconds of packing, never a failure.
 */
const SLOW_FIRST = [
  'settingscheck', 'hangcheck', 'themesync', 'nudgecheck', 'stripcheck',
  'unknowncheck', 'responsive', 'searchcheck', 'notifycheck', 'pwatest',
  'gridcheck',
];

const argv = process.argv.slice(2);

/** `--bases a,b` / `--bases a --bases b`, else `BASES`, else the single `BASE`. */
const basesFlag = [];
const requested = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--bases') basesFlag.push(...(argv[++i] ?? '').split(','));
  else requested.push(argv[i]);
}

const BASES = (basesFlag.length
  ? basesFlag
  : (process.env.BASES?.split(',') ?? [process.env.BASE ?? 'http://localhost:3000']))
  .map((b) => b.trim().replace(/\/$/, ''))
  .filter(Boolean);

if (!BASES.length) {
  console.error('no bases given: pass --bases, or set BASE / BASES');
  process.exit(2);
}

// Two workers on one instance is the data-destroying shape above, and a repeated
// base is the quiet way to ask for it — so it is refused rather than deduped.
const repeated = BASES.filter((b, i) => BASES.indexOf(b) !== i);
if (repeated.length) {
  console.error(`the same instance was given twice: ${[...new Set(repeated)].join(', ')}`);
  console.error('each worker must own its own server — see the header of this file.');
  process.exit(2);
}

const all = readdirSync(here)
  // fixtures.mjs is a helper, not a suite.
  .filter((f) => f.endsWith('.mjs') && !['run.mjs', 'fixtures.mjs', 'chrome.mjs'].includes(f))
  .map((f) => f.replace(/\.mjs$/, ''));

const suites = requested.length
  ? requested.map((r) => r.replace(/\.mjs$/, ''))
  : all;

const unknown = suites.filter((s) => !all.includes(s));
if (unknown.length) {
  console.error(`unknown suite(s): ${unknown.join(', ')}`);
  console.error(`available: ${all.join(', ')}`);
  process.exit(2);
}

// Fail fast with a clear message rather than a wall of Chrome errors — and per
// base, because a fleet with one dead member otherwise fails a third of the
// suites for a reason none of their output mentions.
if (suites.some((s) => !OFFLINE_SUITES.has(s))) {
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      console.error(`No server responding at ${base}.`);
      console.error('Start one first, or set BASE to a running instance.');
      process.exit(2);
    }
  }
}

/**
 * How long any one suite may take.
 *
 * On a healthy machine they run in two to ten seconds each, so a minute means
 * something is stuck — a browser that never came up, or a wedged DevTools
 * connection. Without this the whole run simply stops there, which is how a
 * broken environment came to look like "the browser tests take forever".
 */
const SUITE_TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_MS) || 120_000;

/**
 * The exceptions, and each one is a suite that WAITS on a real bound rather
 * than on a machine.
 *
 * `themesync` blocks a settings write and then sleeps past `ui/settings.js`'s
 * ten-second ceiling — twice, because the write that is abandoned and the
 * write that is refused are different answers and both have to be seen. That
 * is 25 seconds of deliberate waiting in a suite measured at 34, which leaves
 * no margin under the shared limit: the kill would land on a healthy run, and
 * a suite killed mid-flight reads as a failure with no output to say why.
 *
 * The override follows the WAIT, not the name. It sat on `themecheck` until
 * that file was split and the deliberate half went to `themesync`; leaving it
 * behind would have put a 180s ceiling on a 3.7s suite and a 120s one on the
 * suite that spends 25s waiting on purpose.
 *
 * Raising the shared default instead would buy that margin by removing it from
 * every other suite, which is the wrong way round — a stuck browser in
 * `gridcheck` should still be noticed inside a minute.
 */
const SUITE_TIMEOUT_OVERRIDES = { themesync: 180_000 };

const timeoutFor = (suite) =>
  Number(process.env.SUITE_TIMEOUT_MS) || SUITE_TIMEOUT_OVERRIDES[suite] ||
  SUITE_TIMEOUT_MS;

/**
 * A DevTools port for each suite, never repeated within a run.
 *
 * Reusing one across suites on the same worker would be sound in principle —
 * the previous browser is dead by then — but only if it is dead all the way
 * down, and `closeChrome`'s own notes are about how often that is not true.
 * A fresh number costs nothing and takes the question off the table.
 * `DEVTOOLS_PORT_BASE` is the escape hatch for a machine with something already
 * sitting on 94xx.
 */
const PORT_BASE = Number(process.env.DEVTOOLS_PORT_BASE) || 9400;
let nextPort = 0;

const parallel = BASES.length > 1;

/**
 * Run one suite, killing it — and the browser it launched — if it overruns.
 *
 * `detached: true` puts the suite in its own process group, so the kill below
 * reaches the browser it spawned as well. A suite that times out has no chance
 * to run its own teardown, and a leaked browser would slow every suite after it.
 *
 * Output is piped and held when workers run in parallel, then printed as one
 * block: three suites interleaving line by line is unreadable, and the failure
 * lines are what anybody runs this for. Serially it stays inherited, so a suite
 * being debugged still prints live.
 */
function runSuite(suite, base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, `${suite}.mjs`)], {
      stdio: parallel ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: {
        ...process.env,
        BASE: base,
        BASES: '',
        DEVTOOLS_PORT: String(PORT_BASE + nextPort++),
      },
      detached: process.platform !== 'win32',
    });

    let output = '';
    child.stdout?.on('data', (d) => { output += d; });
    child.stderr?.on('data', (d) => { output += d; });

    const limit = timeoutFor(suite);
    const timer = setTimeout(() => {
      output += `  TIMEOUT after ${limit / 1000}s — killing ${suite}\n`;
      if (!parallel) console.error(`  TIMEOUT after ${limit / 1000}s — killing ${suite}`);
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill();
      } catch { /* already gone */ }
    }, limit);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

/**
 * The queue is shared and workers take from it as they free up, rather than the
 * suites being dealt out in advance. Static shards are only as fast as their
 * unluckiest member — one drawing both `settingscheck` and `hangcheck` is 83s
 * against a 40s average while another finishes early and idles.
 */
const queue = [...suites].sort(
  (a, b) => (SLOW_FIRST.indexOf(a) + 1 || Infinity) - (SLOW_FIRST.indexOf(b) + 1 || Infinity)
);

const results = [];

async function worker(base) {
  for (;;) {
    const suite = queue.shift();
    if (!suite) return;

    // Reset to known fixtures before each server-backed suite. Without this the
    // suites contaminate each other and a genuine regression is
    // indistinguishable from leftover state.
    if (!OFFLINE_SUITES.has(suite)) {
      try {
        // `reset({base})`, never `useBase` — see that function's note. The
        // instance has to be pinned per CALL, or one worker's reset finishes
        // against whichever base another worker set while it was awaiting.
        const { reset } = await import('./fixtures.mjs');
        await reset({ base });
      } catch (e) {
        console.error(`\n=== ${suite} ===\n  could not reset fixtures: ${e.message}`);
        results.push({ suite, ok: false, seconds: '0.0' });
        continue;
      }
    }

    if (!parallel) process.stdout.write(`\n=== ${suite} ===\n`);
    const started = Date.now();
    const { code, output } = await runSuite(suite, base);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (parallel) process.stdout.write(`\n=== ${suite} === (${seconds}s)\n${output}`);
    else process.stdout.write(`    (${seconds}s)\n`);
    results.push({ suite, ok: code === 0, seconds });
  }
}

const wallStart = Date.now();
await Promise.all(BASES.map((base) => worker(base)));
const wall = ((Date.now() - wallStart) / 1000).toFixed(1);

console.log('\n──────── summary ────────');
for (const { suite, ok, seconds } of results.sort((a, b) => a.suite.localeCompare(b.suite))) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${suite.padEnd(16)} ${seconds}s`);
}

const cpu = results.reduce((s, r) => s + Number(r.seconds), 0).toFixed(1);
console.log(`\n  ${results.length} suites, ${cpu}s of suite time in ${wall}s`
  + ` across ${BASES.length} instance${BASES.length > 1 ? 's' : ''}`);

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} suite(s) failed` : '\nall suites passed');
process.exit(failed.length ? 1 : 0);
