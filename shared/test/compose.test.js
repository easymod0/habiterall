import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Every environment variable the server reads is documented in the compose
 * file that ships it.
 *
 * The compose files were maintained by hand in two places and kept drifting:
 * #54 added ten variables to `habiterall-personal/docker-compose.yml` and none
 * of them reached `examples/docker-compose.personal.yml`, with every test still
 * green — because the only check compared the examples against the README, and
 * the two stale copies agreed with each other.
 *
 * The fix has two halves. The structural one is in the compose files: each
 * edition's own file now `include:`s the published example rather than
 * repeating it, so there is one environment block per edition. This is the
 * other half, and it is what makes the claim testable: the block is checked
 * against the SOURCE, so a variable that is read and documented nowhere fails
 * here rather than being discovered by someone deploying.
 *
 * Two things would quietly defeat a naive version of this, and both are why
 * the discovery below walks the module graph rather than grepping:
 *
 *   - `HABITERALL_USERNAME`, `HABITERALL_PASSWORD` and `HABITERALL_PASSWORD_HASH`
 *     are read off an INJECTED `env` object in `shared/src/password.js`, never
 *     as `process.env.…`. Those are exactly the three #54 added, so a
 *     `process.env` grep would pass while missing the case that motivated it.
 *     `sees a variable read off an injected env object` below pins that.
 *   - `shared/src/` is shared, so attributing its reads to an edition by file
 *     path is wrong: `password.js` is personal's and `notify-send.js` is both
 *     editions'. Which modules a server actually imports is the only honest
 *     answer, and it needs no list to maintain.
 *
 * What this does NOT check is whether a documented default or comment is still
 * TRUE. Nothing short of booting a container catches that.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The compose files that claim to describe a whole deployment, and the
 * processes each one starts.
 *
 * The two files under `habiterall-personal/` and `habiterall-cloud/` are
 * deliberately absent: they `include:` these, which
 * `each edition's compose file includes its published example` asserts, so
 * they inherit whatever is here.
 */
const COMPOSE = [
  {
    file: 'examples/docker-compose.personal.yml',
    entries: ['habiterall-personal/src/server.js'],
  },
  {
    file: 'examples/docker-compose.cloud.yml',
    entries: [
      'habiterall-cloud/src/server.js',
      'habiterall-cloud/src/db/migrate.js',
    ],
  },
  {
    file: 'examples/docker-compose.cloud-authentik.yml',
    entries: [
      'habiterall-cloud/src/server.js',
      'habiterall-cloud/src/db/migrate.js',
      // The one process the other cloud file does not run, and the reason its
      // AUTHENTIK_* variables are required here and nowhere else.
      'habiterall-cloud/scripts/bootstrap-authentik.mjs',
    ],
  },
];

/**
 * Variables a quickstart is not expected to carry, each with the reason.
 *
 * This list is the decision of what an operator is expected to TUNE, so it is
 * the part of this test worth arguing about — and `nothing is opted out that
 * the server no longer reads` keeps it from silently outliving its entries.
 */
const ELSEWHERE = new Map([
  ['PORT', 'fixed at 3000 inside the container by the image and the published ' +
    'port mapping; APP_PORT is the host-side knob and is in every file'],
  ['NODE_ENV', 'set to production by both Dockerfiles; the README documents ' +
    'leaving it unset, which is a `docker run` decision rather than a line here'],
  ['LOG_LEVEL', 'README → Logs'],
  ['LOG_FORMAT', 'README → Logs'],
  ['LOG_REQUESTS', 'README → Logs'],
  ['LOG_SLOW_MS', 'README → Logs'],
  ['LOG_RUNTIME_MS', 'README → Logs'],
  ['LOG_LAG_WARN_MS', 'README → Logs'],
  ['MAX_UPLOAD_MB', 'a limit, not a deployment setting — README and .env.example'],
  ['MAX_HABITS_PER_USER', 'a limit — README and .env.example'],
  ['MAX_HABITS_PER_IMPORT', 'a limit — README and .env.example'],
  ['MAX_ENTRIES_PER_IMPORT', 'a limit — README and .env.example'],
  ['PG_POOL_MAX', 'pool tuning; the default of 10 is what the health memo is ' +
    'sized against, so raising it is a considered change, not a quickstart one'],
  ['PGSSL', 'for a managed Postgres reached over TLS; every compose file here ' +
    'puts the database on the same private network'],
]);

/**
 * Names that mean the same thing, so documenting either satisfies both.
 *
 * `notify-send.js` reads `HABITERALL_PUBLIC_URL ?? PUBLIC_URL`, which makes
 * both names visible to both editions. Personal's own variable is the first
 * and cloud's is the second; neither edition should document the other's.
 */
const ALIASES = [['HABITERALL_PUBLIC_URL', 'PUBLIC_URL']];

/** @param {string} name @returns {string[]} the alias group `name` is in */
const aliasesOf = (name) => ALIASES.find((g) => g.includes(name)) ?? [name];

/**
 * Where an import specifier points, or `null` when it leaves this repository.
 *
 * A third-party module's own environment variables are not ours to document.
 *
 * @param {string} spec @param {string} from absolute path of the importer
 */
function resolveSpec(spec, from) {
  if (spec.startsWith('.')) return join(dirname(from), spec);
  if (!spec.startsWith('@habiterall/shared/')) return null;

  // The workspace's export map is mostly `./src/…`, with `charts.js` and the
  // test helpers pointing elsewhere. Try both roots rather than restating it.
  const rest = spec.slice('@habiterall/shared/'.length);
  for (const base of ['src', 'public']) {
    const path = join(ROOT, 'shared', base, rest);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Every file in this repository that the given entry points can reach.
 *
 * @param {string[]} entries repo-relative paths
 * @returns {Set<string>} absolute paths
 */
function moduleGraph(entries) {
  const seen = new Set();
  const queue = entries.map((e) => join(ROOT, e));

  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.pop());
    if (seen.has(file)) continue;
    assert.ok(existsSync(file), `${file} does not exist — an entry point moved`);
    seen.add(file);

    const text = readFileSync(file, 'utf8');
    const specs = [
      ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ];
    for (const [, spec] of specs) {
      const path = resolveSpec(spec, file);
      if (path && existsSync(path)) queue.push(path);
    }
  }
  return seen;
}

/**
 * The environment variables read by a set of files.
 *
 * Three forms, because the code uses three: `process.env.X` and an injected
 * `env.X` (one pattern — `process.env` ends in `env`), a bracket lookup, and
 * destructuring, which is how `habiterall-cloud/src/auth.js` takes the OIDC
 * triple.
 *
 * @param {Set<string>} files @returns {Set<string>}
 */
function envNames(files) {
  const names = new Set();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [, n] of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) names.add(n);
    for (const [, n] of text.matchAll(/\benv\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) names.add(n);
    for (const [, block] of text.matchAll(/\{([^{}]*)\}\s*=\s*(?:process\.)?env\b/gs)) {
      for (const [n] of block.matchAll(/\b[A-Z][A-Z0-9_]*\b/g)) names.add(n);
    }
  }
  return names;
}

/**
 * The variables a compose file gives a value to: an environment key in either
 * syntax (`NAME: v` or `- NAME=v`), or an interpolation of one.
 *
 * Deliberately not "the name appears somewhere in the file" — prose in a
 * header comment is not a setting an operator can find and change.
 *
 * @param {string} text @returns {Set<string>}
 */
function documented(text) {
  const names = new Set();
  for (const [, n] of text.matchAll(/^\s*-?\s*([A-Z][A-Z0-9_]*)\s*[:=]/gm)) names.add(n);
  for (const [, n] of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) names.add(n);
  return names;
}

for (const { file, entries } of COMPOSE) {
  test(`${file} documents every variable its processes read`, () => {
    const read = envNames(moduleGraph(entries));
    assert.ok(read.size > 5, `only found ${read.size} variables — discovery is broken`);

    const have = documented(readFileSync(join(ROOT, file), 'utf8'));
    const missing = [...read]
      .filter((name) => !ELSEWHERE.has(name))
      .filter((name) => !aliasesOf(name).some((a) => have.has(a)))
      .sort();

    assert.deepEqual(missing, [],
      `${file} never mentions ${missing.join(', ')}, which the server reads. ` +
      'Add it there — the edition\'s own compose file includes that one, so ' +
      'this is the only place it has to go. If it is not something an operator ' +
      'should set, add it to ELSEWHERE in this file with the reason.');
  });
}

test('nothing is opted out that the server no longer reads', () => {
  // An opt-out is a decision about a real variable. Left behind after the
  // variable goes, it is a claim about the code that is no longer true, and
  // the next person reads it as one.
  const read = new Set();
  for (const { entries } of COMPOSE) {
    for (const name of envNames(moduleGraph(entries))) read.add(name);
  }
  const dead = [...ELSEWHERE.keys()].filter((name) => !read.has(name)).sort();
  assert.deepEqual(dead, [],
    `ELSEWHERE opts out ${dead.join(', ')}, which nothing reads any more`);
});

test('discovery sees a variable read off an injected env object', () => {
  // The case that motivated all of this. `shared/src/password.js` takes an
  // `env` argument and reads three names off it, so they never appear as
  // `process.env.…` anywhere — and they are precisely the three the drift was
  // about. If this ever fails because the discovery was simplified back to a
  // `process.env` grep, the test above stops covering the bug it exists for.
  const source = readFileSync(join(ROOT, 'shared', 'src', 'password.js'), 'utf8');
  assert.ok(!source.includes('process.env.HABITERALL_USERNAME'),
    'password.js now reads process.env directly, so this no longer proves anything');

  const read = envNames(moduleGraph(['habiterall-personal/src/server.js']));
  for (const name of ['HABITERALL_USERNAME', 'HABITERALL_PASSWORD', 'HABITERALL_PASSWORD_HASH']) {
    assert.ok(read.has(name), `${name} was not discovered`);
  }
});

test('discovery attributes a shared module to the editions that import it', () => {
  // The other half of the same point: `shared/src/` cannot be split by path.
  const personal = envNames(moduleGraph(['habiterall-personal/src/server.js']));
  const cloud = envNames(moduleGraph(['habiterall-cloud/src/server.js']));

  // Both import notify-send.js.
  assert.ok(personal.has('HABITERALL_NOTIFY') && cloud.has('HABITERALL_NOTIFY'));
  // Only personal imports password.js; only cloud has an OIDC client.
  assert.ok(personal.has('HABITERALL_AUTH') && !cloud.has('HABITERALL_AUTH'));
  assert.ok(cloud.has('OIDC_ISSUER') && !personal.has('OIDC_ISSUER'));
});

test("each edition's compose file extends its published example", () => {
  // This is what lets the checks above look at three files instead of five.
  // Write an `environment:` block into either of these and the drift starts
  // again, with nothing to notice it.
  const pairs = [
    ['habiterall-personal/docker-compose.yml', '../examples/docker-compose.personal.yml'],
    ['habiterall-cloud/docker-compose.yml', '../examples/docker-compose.cloud.yml'],
  ];

  for (const [file, source] of pairs) {
    const text = readFileSync(join(ROOT, file), 'utf8');

    // `extends`, not `include`. The two look interchangeable: include loads
    // another file's services alongside this one's and warns rather than
    // merging when a name appears in both, so the same shape written with it
    // yields a container that has this file's `build:` and NONE of the
    // environment — which starts, and looks fine. Only `extends` merges.
    assert.ok(!/^include:/m.test(text),
      `${file} uses include:, which does not merge a service declared in both files`);
    assert.ok(text.includes(`file: ${source}`),
      `${file} must extend ${source}, or its environment is a second copy`);
  }

  // The personal file has one service and no reason to configure anything: an
  // `environment:` key in it is the copy coming back. The cloud one is not
  // checked this way because it legitimately has several — the identity
  // provider's containers, which the published file does not run at all.
  const personal = readFileSync(join(ROOT, 'habiterall-personal/docker-compose.yml'), 'utf8');
  assert.ok(!/^\s+environment:/m.test(personal),
    'habiterall-personal/docker-compose.yml has an environment block again; it ' +
    'belongs in examples/docker-compose.personal.yml, which this file extends');
});
