import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The README's screenshots: present, referenced, and described.
 *
 * A broken image is worse in a README than anywhere else — it is the first
 * thing a reader sees, and GitHub renders it as a placeholder that reads as
 * neglect. Renaming a file under `docs/screenshots/` is exactly how that
 * happens, so the two directions are checked against each other here rather
 * than by eye.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = readFileSync(join(root, 'README.md'), 'utf8');

/** Every `<img src="docs/screenshots/…">` tag in the README, with its alt. */
const tags = [...README.matchAll(/<img\s+([^>]*?)>/gs)].map((m) => {
  const attrs = m[1];
  return {
    src: /src="([^"]+)"/.exec(attrs)?.[1] ?? '',
    alt: /alt="([^"]*)"/s.exec(attrs)?.[1] ?? null,
  };
}).filter((t) => t.src.startsWith('docs/screenshots/'));

const files = readdirSync(join(root, 'docs', 'screenshots'))
  .filter((f) => f.endsWith('.png'))
  .sort();

test('every screenshot in the repo is shown in the README', () => {
  // An unreferenced capture is either a rename that half-landed or dead weight
  // in the clone — both worth being told about.
  const unused = files.filter((f) => !tags.some((t) => t.src === `docs/screenshots/${f}`));
  assert.deepEqual(unused, [],
    'these screenshots are in docs/screenshots/ but not in README.md: ' + unused.join(', '));
});

test('every screenshot the README shows exists', () => {
  assert.ok(tags.length > 0, 'the README no longer references any screenshot');

  const missing = tags
    .map((t) => t.src)
    .filter((src) => !files.includes(src.slice('docs/screenshots/'.length)))
    .sort();
  assert.deepEqual(missing, [],
    'README.md points at screenshots that are not in the repo: ' + missing.join(', '));
});

test('every screenshot has real alt text', () => {
  // These images carry information the prose does not repeat — what the reminder
  // notification actually looks like, what the picker offers. Without alt text
  // that content simply does not exist for a screen reader.
  for (const { src, alt } of tags) {
    assert.ok(alt, `${src} has no alt attribute`);
    assert.ok(alt.length > 40,
      `${src}'s alt text is too short to describe it: ${JSON.stringify(alt)}`);
  }
});
