/**
 * Locate a Chrome binary on whatever platform this is running on.
 *
 * The suites originally hardcoded a Windows path, which meant they could
 * never run in CI. `CHROME_PATH` overrides everything, matching the
 * convention Puppeteer and friends use.
 */

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
