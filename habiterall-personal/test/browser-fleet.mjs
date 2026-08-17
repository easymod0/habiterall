/**
 * Starts a fleet of throwaway personal-edition servers and runs the browser
 * suites across them in parallel.
 *
 *   npm run test:browser                  # from the repo root, or here
 *   npm run test:browser -- themecheck    # a subset, same names as the runner
 *   HABITERALL_BROWSER_JOBS=8 npm run test:browser
 *
 * The shared runner deliberately knows nothing about either edition — it takes
 * `--bases` and shards across them, and cloud is pointed at the same way. This
 * script is the personal edition's half: it decides how many instances there
 * are, gives each one its own port and its own database, and cleans both up.
 *
 * **Every worker gets a FRESH database, and that is not just tidiness.** A
 * browser suite against a reused database is not the run CI makes: `themecheck`
 * passed locally and failed in CI because a `/tmp` database carried a theme from
 * an earlier probe, so the tap cycle did not start where a fresh profile starts
 * it. A run that begins by creating the file cannot have that class of failure.
 *
 * Both auth and the rate limiter are off, for the reasons the CI workflow gives:
 * these suites drive the app rather than the login, and twenty-nine of them
 * resetting fixtures from one address pass the read limit long before they find
 * a bug. The sign-in flow and the limits have their own jobs.
 */

import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const personal = resolve(here, '..');
const runner = resolve(personal, '../shared/test/browser/run.mjs');

const argv = process.argv.slice(2);
const jobsFlag = argv.indexOf('-j');
if (jobsFlag !== -1) argv.splice(jobsFlag, 2);

/**
 * How many instances to run.
 *
 * Four by DEFAULT rather than one-per-core: each worker is a node server plus a
 * headless Chrome, so the processes already outnumber the cores, and the ceiling
 * on what more of them buys is the longest suite rather than the core count.
 * The default is clamped to the core count for that reason.
 *
 * An EXPLICIT `-j` or `HABITERALL_BROWSER_JOBS` is honoured as given, and is
 * deliberately allowed above it. The clamp is a guard on a value nobody chose;
 * silently rewriting one somebody did choose makes the setting untestable —
 * asking for 6 on a 4-core box and being handed 4 looks like "6 was no faster".
 */
const asked = Number(jobsFlag !== -1 ? process.argv[jobsFlag + 1] : 0)
  || Number(process.env.HABITERALL_BROWSER_JOBS)
  || 0;
const jobs = Math.max(1, asked || Math.min(4, availableParallelism()));

// Not :3000 — a dev server or a stale one from an earlier session squatting
// there is a thing that has actually happened here, and the failure it produces
// is a suite testing somebody else's data rather than a bind error.
const PORT_BASE = Number(process.env.HABITERALL_BROWSER_PORT_BASE) || 3200;

const dataDir = mkdtempSync(join(tmpdir(), 'habiterall-browser-'));
const servers = [];

/** Kill the fleet, and everything it forked. Synchronous, so `exit` can use it. */
function stopFleet() {
  for (const s of servers) {
    try {
      if (process.platform !== 'win32' && s.pid) process.kill(-s.pid, 'SIGKILL');
      else s.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* not worth failing over */ }
}

// A server outliving the run holds its port and its database, and the next run
// then either fails to bind or — worse — passes against the old one. `exit`
// covers the throw and the unsettled-await paths; the signals cover a Ctrl-C,
// which is how anybody stops a run they can see is going wrong.
process.on('exit', stopFleet);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopFleet(); process.exit(130); });
}

const bases = [];
for (let i = 0; i < jobs; i++) {
  const port = PORT_BASE + i;
  bases.push(`http://localhost:${port}`);
  servers.push(spawn(process.execPath, ['src/server.js'], {
    cwd: personal,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      PORT: String(port),
      HABITERALL_DB: join(dataDir, `w${i}.db`),
      HABITERALL_AUTH: 'off',
      HABITERALL_RATE_LIMIT: 'off',
    },
  }));
}

/** Wait for one instance to answer, and say which one did not. */
async function waitFor(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response yet';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${base} never became healthy within ${timeoutMs / 1000}s (${last})`);
}

try {
  await Promise.all(bases.map((b) => waitFor(b)));
} catch (err) {
  console.error(`could not start the fleet: ${err.message}`);
  process.exit(2);
}

console.log(`${jobs} instance${jobs > 1 ? 's' : ''} on ${PORT_BASE}–${PORT_BASE + jobs - 1}`
  + ` (${availableParallelism()} cores), databases under ${dataDir}`);

const run = spawn(process.execPath, [runner, '--bases', bases.join(','), ...argv], {
  stdio: 'inherit',
  env: { ...process.env, BASE: '', BASES: '' },
});

run.on('exit', (code, signal) => {
  stopFleet();
  // A runner killed by a signal has not reported a pass, so it must not look
  // like one: node reports `code === null` there.
  process.exit(code ?? (signal ? 1 : 1));
});
