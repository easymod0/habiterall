/**
 * Runs the browser-based UI suites against a live server.
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
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://localhost:3000';

/** Suites that need no server (pure rendering against a fake DOM). */
const OFFLINE_SUITES = new Set(['rendercheck', 'daydialog']);

const requested = process.argv.slice(2);
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

// Fail fast with a clear message rather than a wall of Chrome errors.
if (suites.some((s) => !OFFLINE_SUITES.has(s))) {
  try {
    const res = await fetch(`${BASE}/healthz`);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    console.error(`No server responding at ${BASE}.`);
    console.error('Start one first, or set BASE to a running instance.');
    process.exit(2);
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
 * Run one suite, killing it — and the browser it launched — if it overruns.
 *
 * `detached: true` puts the suite in its own process group, so the kill below
 * reaches the browser it spawned as well. A suite that times out has no chance
 * to run its own teardown, and a leaked browser would slow every suite after it.
 */
function runSuite(suite) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, `${suite}.mjs`)], {
      stdio: 'inherit',
      env: { ...process.env, BASE },
      detached: process.platform !== 'win32',
    });

    const timer = setTimeout(() => {
      console.error(`  TIMEOUT after ${SUITE_TIMEOUT_MS / 1000}s — killing ${suite}`);
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill();
      } catch { /* already gone */ }
    }, SUITE_TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

const results = [];

for (const suite of suites) {
  // Reset to known fixtures before each server-backed suite. Without this the
  // suites contaminate each other and a genuine regression is
  // indistinguishable from leftover state.
  if (!OFFLINE_SUITES.has(suite)) {
    try {
      const { reset, useBase } = await import('./fixtures.mjs');
      useBase(BASE);
      await reset();
    } catch (e) {
      console.error(`  could not reset fixtures: ${e.message}`);
      results.push({ suite, ok: false });
      continue;
    }
  }

  process.stdout.write(`\n=== ${suite} ===\n`);
  const started = Date.now();
  const code = await runSuite(suite);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`    (${seconds}s)\n`);
  results.push({ suite, ok: code === 0, seconds });
}

console.log('\n──────── summary ────────');
for (const { suite, ok, seconds } of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${suite.padEnd(16)} ${seconds}s`);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} suite(s) failed` : '\nall suites passed');
process.exit(failed.length ? 1 : 0);
