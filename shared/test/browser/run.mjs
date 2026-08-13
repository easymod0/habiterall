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
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, `${suite}.mjs`)], {
      stdio: 'inherit',
      env: { ...process.env, BASE },
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });
  results.push({ suite, ok: code === 0 });
}

console.log('\n──────── summary ────────');
for (const { suite, ok } of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${suite}`);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} suite(s) failed` : '\nall suites passed');
process.exit(failed.length ? 1 : 0);
