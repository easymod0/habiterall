import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

/** Every browser module, as `<relative path>` → source. */
function browserModules() {
  const files = [
    ...readdirSync(pub).filter((f) => f.endsWith('.js')).map((f) => f),
    ...readdirSync(join(pub, 'ui')).filter((f) => f.endsWith('.js'))
      .map((f) => join('ui', f)),
  ];
  return new Map(files.map((f) => [f, readFileSync(join(pub, f), 'utf8')]));
}

/* ---------- one owner per element ---------- */

test('no element id is reached for by two modules', () => {
  // The frontend was one 2,100-line file with a central `els` map, so any
  // function could reach any element. Split into modules that becomes a
  // convention, and conventions rot: the point of the split is that a module
  // owns its subtree, and this is what makes that a rule rather than a habit.
  //
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  const declared = new Set(
    [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
  );
  assert.ok(declared.size > 0, 'failed to parse any ids from index.html');

  /** @type {Map<string, string[]>} id → the modules naming it */
  const owners = new Map();
  /** @type {string[]} references to markup that is not there */
  const dangling = [];

  for (const [file, rawSrc] of browserModules()) {
    // Comments first: prose mentions elements without touching them, and
    // "owns the `#reminder-*` controls" is a sentence, not a lookup.
    const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // Ids named anywhere in a selector: `$('#grid')` and
    // `.empty-sub:not(#empty-archived)` both count as naming one.
    const named = new Set(
      [...src.matchAll(/#([A-Za-z][\w-]*)/g)].map((m) => m[1])
    );
    for (const id of named) {
      if (declared.has(id)) {
        if (!owners.has(id)) owners.set(id, []);
        owners.get(id).push(file);
        continue;
      }
      // `#f59e0b` and `#fff` are colours, not elements, and they are the only
      // other thing in this codebase that follows a hash. Anything else that
      // is not in index.html is a lookup that will return null at runtime and
      // fail somewhere far from here.
      if (!/^[0-9a-fA-F]{3,8}$/.test(id)) dangling.push(`#${id}: ${file}`);
    }
  }

  assert.deepEqual(dangling, [],
    'these modules look up an element index.html does not declare — the ' +
    'lookup returns null and the failure surfaces somewhere else entirely');

  const shared = [...owners].filter(([, files]) => files.length > 1);
  assert.deepEqual(
    shared.map(([id, files]) => `#${id}: ${files.join(', ')}`),
    [],
    'each of these ids is touched by more than one module — move the element ' +
    'under a single owner, or expose it through that owner (see ui/views.js)'
  );
});

/* ---------- the service worker must know about every module ---------- */

test('every browser module reachable from the entry point is precached', () => {
  // `SHELL` is hand-maintained, and `shellFirst` caches opportunistically, so
  // a missing file is invisible until someone installs the PWA and goes
  // offline before the module has ever been fetched. Splitting app.js into
  // fourteen files made that list much easier to get wrong.
  const sw = readFileSync(join(pub, 'sw.js'), 'utf8');
  const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(shellBlock, 'failed to find the SHELL array in sw.js');
  const precached = new Set(
    [...shellBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  );

  // Both auth adapters are entry points: each edition's app-entry.js imports
  // one of them, and the two editions share this service worker.
  const seen = new Set();
  const queue = ['app.js', 'auth-session.js'];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    const src = readFileSync(join(pub, file), 'utf8');
    for (const [, spec] of src.matchAll(/from\s+'(\/shared\/[^']+)'/g)) {
      queue.push(spec.replace('/shared/', ''));
    }
  }

  const missing = [...seen]
    .map((f) => `/shared/${f}`)
    .filter((url) => !precached.has(url))
    .sort();

  assert.deepEqual(missing, [], 'add these to SHELL in sw.js, and bump CACHE_VERSION');
});

/* ---------- the wire values are declared twice on purpose ---------- */

test('ui/values.js matches src/constants.js', () => {
  // `shared/src` is not served to the browser, so the entry sentinels are
  // declared in both places — the same arrangement SETTING_VALUES and the
  // settings registry already use, and pinned the same way.
  const server = readFileSync(join(root, 'src', 'constants.js'), 'utf8');
  const browser = readFileSync(join(pub, 'ui', 'values.js'), 'utf8');

  const values = (src) => Object.fromEntries(
    [...src.matchAll(/^export const (UNSET|YES|SKIP) = (\d+);$/gm)]
      .map((m) => [m[1], Number(m[2])])
  );

  const fromServer = values(server);
  assert.deepEqual(Object.keys(fromServer).sort(), ['SKIP', 'UNSET', 'YES']);
  assert.deepEqual(values(browser), fromServer);
});
