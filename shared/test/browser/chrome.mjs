/**
 * Locate a Chrome binary on whatever platform this is running on.
 *
 * The suites originally hardcoded a Windows path, which meant they could
 * never run in CI. `CHROME_PATH` overrides everything, matching the
 * convention Puppeteer and friends use.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:process';

const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
};

/** @returns {string} path to a usable Chrome/Chromium binary */
export function findChrome() {
  const override = process.env.CHROME_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CHROME_PATH is set but does not exist: ${override}`);
    }
    return override;
  }

  for (const candidate of CANDIDATES[platform] ?? []) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `No Chrome found for platform "${platform}". ` +
    'Install Chrome or set CHROME_PATH to its location.'
  );
}

export const CHROME = findChrome();


/**
 * Wait for the browser to expose a DevTools endpoint, and say so plainly if it
 * never does.
 *
 * Every suite had its own copy of this poll, and every copy failed the same
 * unhelpful way: the loop gave up, left `url` undefined, and the next line —
 * `new WebSocket(undefined)` — threw **TypeError: Invalid URL**. A release run
 * failed with exactly that, and the message says nothing about the actual
 * problem, which is that Chrome had not finished starting.
 *
 * Fifteen seconds was also thin. A cold browser here takes ~300ms and the loop
 * exits as soon as it answers, so a longer ceiling costs nothing on a healthy
 * machine and removes a whole class of flake on a loaded CI runner.
 *
 * @param {number} port  the --remote-debugging-port the browser was given
 * @param {import('node:child_process').ChildProcess} [chrome] to report an early exit
 * @param {number} [timeoutMs]
 * @returns {Promise<string>} the browser's WebSocket debugger URL
 */
export async function devtoolsUrl(port, chrome, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';

  while (Date.now() < deadline) {
    // A browser that died is never going to answer, so stop waiting for it.
    if (chrome?.exitCode !== null && chrome?.exitCode !== undefined) {
      throw new Error(
        `the browser exited with code ${chrome.exitCode} before opening a ` +
        `DevTools port. Check CHROME_PATH (${CHROME}).`
      );
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      const { webSocketDebuggerUrl } = await res.json();
      if (webSocketDebuggerUrl) return webSocketDebuggerUrl;
      lastError = 'answered, but with no webSocketDebuggerUrl';
    } catch (err) {
      lastError = err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  throw new Error(
    `the browser did not expose a DevTools endpoint on port ${port} within ` +
    `${timeoutMs / 1000}s (last attempt: ${lastError}). ` +
    `CHROME_PATH is ${CHROME}.`
  );
}

/**
 * Shut a suite's browser down for real.
 *
 * `chrome.kill()` — what all sixteen suites used to do — kills the process node
 * spawned, and that is frequently not the browser. Any wrapper counts: a distro
 * shell script, and in particular a Flatpak install, where the spawned process
 * is `flatpak run` and the browser lives in a sandbox behind it. Measured on
 * one such install: a launch creates ~20 processes, and `kill()` (SIGTERM *or*
 * SIGKILL) removes none of them.
 *
 * That is not a tidiness problem. The leaked browsers keep their ports and
 * their memory, so by the fifth suite the machine is running a hundred of them
 * and later suites stall for minutes on a launch that normally takes 300ms —
 * which reads exactly like a hanging test, and was the reason a full run
 * appeared to take forever.
 *
 * Two mechanisms, because either can be defeated on its own:
 *
 *   1. `Browser.close` over the DevTools socket. The request reaches the real
 *      browser however many wrappers are in between, and it shuts down its own
 *      children properly. This is the one that actually works.
 *   2. A SIGKILL to the process *group*, which needs `detached: true` at spawn
 *      (hence `launchArgs` below). This is the backstop for a browser whose
 *      socket is wedged, or that never got far enough to have one.
 *
 * Measured on the same install: 14 processes -> 14 with `kill()`, -> 2 with the
 * group kill, -> 1 with `Browser.close`, -> 0 with both.
 *
 * @param {{chrome: import('node:child_process').ChildProcess, port: number,
 *          profile?: string}} suite
 */
export async function closeChrome({ chrome, port, profile }) {
  await askBrowserToClose(port).catch(() => {});

  // Give it a moment to go on its own before insisting.
  await new Promise((r) => setTimeout(r, 300));

  try {
    // Negative pid = the whole process group. POSIX only; on Windows the
    // spawned process is the browser, so the ordinary kill is correct there.
    if (process.platform !== 'win32' && chrome?.pid) process.kill(-chrome.pid, 'SIGKILL');
    else chrome?.kill('SIGKILL');
  } catch {
    // Already gone, which is the outcome we wanted.
  }

  if (profile) {
    try {
      const { rmSync } = await import('node:fs');
      rmSync(profile, { recursive: true, force: true });
    } catch { /* a leftover temp dir is not worth failing a suite over */ }
  }
}

/** Ask the browser itself to exit, over its own DevTools socket. */
async function askBrowserToClose(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(2000),
  });
  const { webSocketDebuggerUrl } = await res.json();
  if (!webSocketDebuggerUrl) return;

  const ws = new globalThis.WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  // The socket dies as the browser goes; that is the acknowledgement.
  await new Promise((resolve) => {
    ws.onclose = resolve;
    setTimeout(resolve, 1500);
  });
}

/**
 * The spawn options every suite needs.
 *
 * `detached: true` is the part that matters: it puts the browser and everything
 * it forks in their own process group, which is what makes the group kill in
 * `closeChrome` able to reach them.
 */
export const LAUNCH_OPTS = { stdio: 'ignore', detached: true };

/**
 * Launch a browser for a suite, and guarantee it dies with the suite.
 *
 * The guarantee is the point. `closeChrome` in a `finally` covers a suite that
 * finishes — but a suite that *stalls* on a DevTools call never finishes: node
 * exits when the event loop drains ("unsettled top-level await"), and a
 * `finally` after that await never runs. The browser is then orphaned, and the
 * next suite starts on a machine with one more of them. That cascade is why a
 * single stalled suite used to be followed by a run of failures, and why the
 * same suite passed when run on its own.
 *
 * An `exit` handler closes that hole: node fires it on the unsettled-await
 * path, on an uncaught throw, and on `process.exit`. It must be synchronous,
 * which a group kill is.
 *
 * @param {number} port  DevTools port
 * @param {string} profile  a throwaway --user-data-dir
 */
export function launchChrome(port, profile) {
  const chrome = spawn(CHROME, LAUNCH_ARGS(port, profile), LAUNCH_OPTS);

  process.on('exit', () => {
    try {
      if (process.platform !== 'win32' && chrome.pid) process.kill(-chrome.pid, 'SIGKILL');
      else chrome.kill('SIGKILL');
    } catch { /* the suite's own teardown got there first */ }
  });

  return chrome;
}

/**
 * The command line every suite launches with. One list, so a flag that has to
 * be added for one environment does not have to be added sixteen times.
 *
 * `--disable-dev-shm-usage` is deliberately NOT here, which is worth a note
 * because it is the reflexive fix for the symptom these suites do sometimes
 * show — a renderer that dies while the browser stays up, so the DevTools
 * socket accepts requests and never answers them, which reads as a hang on a
 * plain DOM read with no error anywhere. Adding it made things measurably
 * *worse* on a Flatpak install (a suite that passed reliably began stalling
 * two thirds of the way through, and passed again the moment it was removed).
 * The flag moves shared memory from /dev/shm to a temp file, and a Flatpak
 * sandbox has a small private /tmp to put it in. If you meet the symptom in a
 * container, add it there rather than here.
 *
 * @param {number} port  DevTools port
 * @param {string} profile  a throwaway --user-data-dir
 */
export const LAUNCH_ARGS = (port, profile) => [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--disable-gpu',
  'about:blank',
];
