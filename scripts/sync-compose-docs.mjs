#!/usr/bin/env node
/**
 * Rewrite the README's copies of `examples/` from the files themselves.
 *
 *   npm run docs:compose             rewrite README.md
 *   npm run docs:compose -- --check  fail if it would change anything
 *
 * The examples exist twice on purpose: a reader wants to see the file without
 * following a link, and an operator wants a file they can run. What is not
 * acceptable is the two drifting — a README snippet that no longer works is
 * worse than no snippet, because it is tried before it is doubted.
 *
 * This replaces a test that only *compared* them. Comparing is enough to catch
 * drift and still leaves the README a place you can forget to edit; the failure
 * then names the right file but hands you a copy-and-paste job. Generating it
 * removes the job.
 *
 * `--check` is what CI runs, and `shared/test/examples.test.js` calls the same
 * function in-process, so `npm test` fails on drift too.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README_PATH = join(ROOT, 'README.md');

/**
 * The example files the README prints, and the fence language for each.
 *
 * An explicit list rather than a directory scan, because not everything in
 * `examples/` has to be printed — and because forgetting to add one here is
 * caught by `examples.test.js`, which walks the directory and fails on a file
 * this list does not mention.
 *
 * @type {Array<{ file: string, lang: string }>}
 */
export const PRINTED = [
  { file: 'docker-compose.personal.yml', lang: 'yaml' },
  { file: 'personal.env.example', lang: 'ini' },
  { file: 'docker-compose.cloud-authentik.yml', lang: 'yaml' },
  { file: 'docker-compose.cloud.yml', lang: 'yaml' },
  { file: 'cloud.env.example', lang: 'ini' },
  { file: 'Caddyfile', lang: 'caddyfile' },
];

/**
 * An example file as the README should show it: without the comment header
 * that explains the file to someone reading it in the repository, since the
 * README has its own prose around it.
 *
 * Only a header at the very TOP is dropped, and only if the file opens with
 * one. The rule this replaces was "everything up to the first blank line",
 * which silently reduced `examples/Caddyfile` — four lines, no header — to the
 * empty string, and `README.includes('')` is true of every README there has
 * ever been. That check had been passing for nothing.
 *
 * @param {string} file name inside `examples/`
 * @returns {string}
 */
export function exampleBody(file) {
  const lines = readFileSync(join(ROOT, 'examples', file), 'utf8').split('\n');
  let i = 0;
  if (lines[0]?.startsWith('#')) {
    while (i < lines.length && lines[i].startsWith('#')) i++;
    while (i < lines.length && lines[i].trim() === '') i++;
  }
  return lines.slice(i).join('\n').trimEnd();
}

/** The HTML comment that opens a generated block, and the one that closes it. */
const OPEN = (file) =>
  `<!-- generated from examples/${file} — edit that file, then \`npm run docs:compose\` -->`;
const CLOSE = '<!-- /generated -->';

/**
 * @param {string} file
 * @returns {RegExp} matches the whole block, capturing the opening marker
 */
function blockOf(file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(<!-- generated from examples/${escaped}[^>]*-->\\n)[\\s\\S]*?\\n${CLOSE}`
  );
}

/**
 * Rebuild every generated block from its source file.
 *
 * @returns {{ text: string, changed: string[] }} the README as it should be,
 *   and the example files whose block was not already that.
 */
export function render() {
  let text = readFileSync(README_PATH, 'utf8');
  const changed = [];

  for (const { file, lang } of PRINTED) {
    const pattern = blockOf(file);
    const found = pattern.exec(text);
    if (!found) {
      throw new Error(
        `README.md has no generated block for examples/${file}. Add one:\n\n` +
        `${OPEN(file)}\n\`\`\`${lang}\n…\n\`\`\`\n${CLOSE}\n`
      );
    }
    const wanted = `${found[1]}\`\`\`${lang}\n${exampleBody(file)}\n\`\`\`\n${CLOSE}`;
    if (found[0] !== wanted) changed.push(file);
    text = text.replace(pattern, () => wanted);
  }

  return { text, changed };
}

/** Every file in `examples/`, for the test that none has been left unprinted. */
export function exampleFiles() {
  return readdirSync(join(ROOT, 'examples')).sort();
}

// ---------------------------------------------------------------------- CLI

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const { text, changed } = render();

  if (changed.length === 0) {
    console.log('README.md is up to date with examples/.');
    process.exit(0);
  }

  if (check) {
    console.error(
      'README.md has drifted from these example files:\n' +
      changed.map((f) => `  examples/${f}`).join('\n') +
      '\n\nRun `npm run docs:compose` and commit the result.'
    );
    process.exit(1);
  }

  writeFileSync(README_PATH, text);
  console.log(
    'Rewrote README.md from:\n' + changed.map((f) => `  examples/${f}`).join('\n')
  );
}
