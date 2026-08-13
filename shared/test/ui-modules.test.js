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
  // Matching against the ids index.html actually declares does double duty —
  // it keeps hex colours ('#f59e0b') out of the results, and it means a
  // reference to an id that no longer exists shows up as a miss below.
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  const declared = new Set(
    [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
  );
  assert.ok(declared.size > 0, 'failed to parse any ids from index.html');

  /** @type {Map<string, string[]>} id → the modules naming it */
  const owners = new Map();

  for (const [file, src] of browserModules()) {
    // Ids named inside a quoted string, anywhere in a selector: `$('#grid')`
    // and `.empty-sub:not(#empty-archived)` both count as naming one.
    const named = new Set(
      [...src.matchAll(/#([A-Za-z][\w-]*)/g)].map((m) => m[1])
        .filter((id) => declared.has(id))
    );
    for (const id of named) {
      if (!owners.has(id)) owners.set(id, []);
      owners.get(id).push(file);
    }
  }

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
  const queue = ['app.js', 'auth-none.js', 'auth-oidc.js'];
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
