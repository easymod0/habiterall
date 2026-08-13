import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The API surface, checked three ways against each other.
 *
 * README.md claims a number of endpoints and lists them. That number rots
 * silently — nobody recounts a table when adding a route — and a wrong one is
 * the kind of small dishonesty that makes a reader stop trusting the rest.
 *
 * More usefully: the two editions are supposed to expose the SAME API. That is
 * the whole promise of "identical in both editions", and it is what lets a
 * native client, a script, or a JSON backup move between them. Nothing enforced
 * it. An endpoint added to one and forgotten in the other would be found by
 * whoever hit it first.
 *
 * So: parse the routes each edition registers, and require that the two match
 * each other and the documented table.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The routes an edition registers.
 *
 * Read from the source rather than by mounting the router, because mounting
 * `habiterall-cloud/src/api.js` needs a Postgres pool and `habiterall-personal`
 * writes a database file. A regex over `api.get('/x', …)` is enough: the routes
 * are all declared that way, and the test below fails loudly if that stops
 * being true (an edition with zero routes is not a passing state).
 */
function routesOf(edition) {
  const src = readFileSync(join(root, edition, 'src', 'api.js'), 'utf8');
  const found = new Set();

  for (const m of src.matchAll(/\bapi\.(get|post|put|delete)\(\s*'([^']+)'/g)) {
    found.add(`${m[1].toUpperCase()} ${m[2]}`);
  }

  assert.ok(found.size > 0, `parsed no routes at all from ${edition}/src/api.js`);
  return found;
}

/** The method/path pairs the README's API table claims. */
function documentedRoutes() {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const found = new Set();

  // Rows look like: | `GET` `PUT` | `/habits/:id` | Read, update |
  // and one row lists three paths for a single method.
  for (const line of readme.split('\n')) {
    const row = /^\|\s*((?:`(?:GET|POST|PUT|DELETE)`\s*)+)\|\s*([^|]+)\|/.exec(line);
    if (!row) continue;

    const methods = [...row[1].matchAll(/`(GET|POST|PUT|DELETE)`/g)].map((m) => m[1]);
    const paths = [...row[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]);

    for (const method of methods) {
      for (const path of paths) found.add(`${method} ${path}`);
    }
  }
  return found;
}

const personal = routesOf('habiterall-personal');
const cloud = routesOf('habiterall-cloud');
const documented = documentedRoutes();

test('both editions expose the same API', () => {
  // "Identical in both editions" is what lets the Android client, a script, or a
  // backup move between them. An endpoint in one and not the other is a promise
  // broken silently.
  const onlyPersonal = [...personal].filter((r) => !cloud.has(r)).sort();
  const onlyCloud = [...cloud].filter((r) => !personal.has(r)).sort();

  assert.deepEqual(onlyPersonal, [],
    'personal has routes cloud does not: ' + onlyPersonal.join(', '));
  assert.deepEqual(onlyCloud, [],
    'cloud has routes personal does not: ' + onlyCloud.join(', '));
});

test('every route is in the README, and every documented route exists', () => {
  const undocumented = [...personal].filter((r) => !documented.has(r)).sort();
  const imaginary = [...documented].filter((r) => !personal.has(r)).sort();

  assert.deepEqual(undocumented, [],
    'these routes are not in the README API table: ' + undocumented.join(', '));
  assert.deepEqual(imaginary, [],
    'the README documents routes that do not exist: ' + imaginary.join(', '));
});

test('the endpoint count in the README is the real one', () => {
  // The prose says "N endpoints". Nobody recounts a table when adding a route,
  // so this is the line that keeps it honest.
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const claim = /(\d+) endpoints, identical in both editions/.exec(readme);

  assert.ok(claim, 'the README no longer states an endpoint count in the expected form');
  assert.equal(
    Number(claim[1]),
    personal.size,
    `the README claims ${claim[1]} endpoints; the editions register ${personal.size}. ` +
    'Update the number in README.md.'
  );
});
