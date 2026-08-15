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

const CLOUD_APP = [
  'habiterall-cloud/src/server.js',
  'habiterall-cloud/src/db/migrate.js',
];
// The one process examples/docker-compose.cloud.yml does not run, and the
// reason its AUTHENTIK_* variables are required in the other two cloud files.
const BOOTSTRAP = 'habiterall-cloud/scripts/bootstrap-authentik.mjs';

/**
 * Every compose file that claims to describe a whole deployment, and the
 * processes each one starts.
 *
 * `also` is the file whose environment this one inherits through `extends`.
 * The checkout files are listed rather than taken on trust, and that is not
 * belt-and-braces: `extends` covers `db` / `migrate` / `app` only, so the
 * Authentik services in `habiterall-cloud/docker-compose.yml` are a hand-kept
 * copy of the ones in the published Authentik file. Leaving that file out
 * would have reproduced #54 exactly, one service over — a new variable in
 * `bootstrap-authentik.mjs` forced into the published copy and reaching the
 * checkout only if someone remembered.
 *
 * `except` is what a particular deployment deliberately does not set, as
 * distinct from ELSEWHERE's "no deployment needs to".
 */
const COMPOSE = [
  {
    file: 'examples/docker-compose.personal.yml',
    entries: ['habiterall-personal/src/server.js'],
  },
  {
    file: 'habiterall-personal/docker-compose.yml',
    also: 'examples/docker-compose.personal.yml',
    entries: ['habiterall-personal/src/server.js'],
  },
  {
    file: 'examples/docker-compose.cloud.yml',
    entries: CLOUD_APP,
  },
  {
    file: 'examples/docker-compose.cloud-authentik.yml',
    entries: [...CLOUD_APP, BOOTSTRAP],
  },
  {
    file: 'habiterall-cloud/docker-compose.yml',
    also: 'examples/docker-compose.cloud.yml',
    entries: [...CLOUD_APP, BOOTSTRAP],
    except: new Map([
      // This stack bind-mounts the blueprints and the branding straight from
      // the checkout, so the bootstrap has nothing to copy OUT of the image —
      // which is the whole reason those three exist, and they are set in the
      // published Authentik file that has no checkout to mount.
      ['AUTHENTIK_BLUEPRINTS_OUT', 'bind-mounted from the checkout instead'],
      ['AUTHENTIK_ICONS_OUT', 'bind-mounted from the checkout instead'],
      ['AUTHENTIK_IMAGES_OUT', 'bind-mounted from the checkout instead'],
    ]),
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
]);

/**
 * The `.env` template each stack ships, and the compose files it serves.
 *
 * These exist because a compose file's `environment:` block is not somewhere an
 * operator edits — the published ones are downloaded and run, and the checkout
 * ones carry no environment at all. A `.env` beside them is the surface, and
 * before this there was one for cloud and none for personal.
 *
 * What the test below asserts is the relationship that actually decides whether
 * a line in `.env` does anything: **compose interpolation**. A `.env` file is
 * read for `${NAME}` substitution and NOTHING else — no service here uses
 * `env_file:`, deliberately, since that would put DB_OWNER_PASSWORD into the
 * app container. So a variable the compose file does not NAME never reaches the
 * process, however plainly the template sets it. The old
 * `habiterall-cloud/.env.example` had four such lines: MAX_HABITS_PER_USER,
 * MAX_HABITS_PER_IMPORT, MAX_ENTRIES_PER_IMPORT and MAX_UPLOAD_MB were set
 * there, interpolated by no cloud compose file, and had been inert since they
 * were written. Nothing failed, because both halves individually looked right.
 *
 * @type {Array<{ file: string, composes: string[] }>}
 */
const ENV_TEMPLATES = [
  {
    file: 'examples/personal.env.example',
    composes: [
      'examples/docker-compose.personal.yml',
      'habiterall-personal/docker-compose.yml',
    ],
  },
  {
    file: 'examples/cloud.env.example',
    composes: [
      'examples/docker-compose.cloud.yml',
      'examples/docker-compose.cloud-authentik.yml',
      'habiterall-cloud/docker-compose.yml',
    ],
  },
];

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

/** A `process.env[…]` whose key is not a literal, so no reader can see it. */
const DYNAMIC = /\benv\[\s*[^'"\s\]]/;

/** An `@env NAME NAME` marker, which is how such a file declares its own. */
const MARKER = /@env\s+([A-Z][A-Z0-9_]*(?:[ ,]+[A-Z][A-Z0-9_]*)*)/g;

/**
 * The environment variables read by a set of files.
 *
 * Four forms, because the code uses four. `process.env.X` and an injected
 * `env.X` are one pattern, since `process.env` ends in `env`. A bracket lookup
 * with a literal key is the second, and destructuring the third — that is how
 * `habiterall-cloud/src/auth.js` takes the OIDC triple.
 *
 * The fourth is a bracket lookup with a VARIABLE key, and it is the one that
 * cannot be read at all: `flag('AUTHENTIK_BRANDING')` in
 * `bootstrap-authentik.mjs` reaches `process.env[name]` a function call away,
 * so the name is nowhere near the read. Three real switches were invisible
 * here until an `@env` marker declared them, which is the same shape of hole
 * as the injected `env` object one function up — and `a file that reads the
 * environment dynamically declares what it reads` is what stops the next one
 * being silent instead of merely undeclared.
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
    for (const [, list] of text.matchAll(MARKER)) {
      for (const [n] of list.matchAll(/[A-Z][A-Z0-9_]*/g)) names.add(n);
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

for (const { file, also, entries, except } of COMPOSE) {
  test(`${file} documents every variable its processes read`, () => {
    const read = envNames(moduleGraph(entries));
    assert.ok(read.size > 5, `only found ${read.size} variables — discovery is broken`);

    const sources = [file, ...(also ? [also] : [])];
    const have = documented(sources.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n'));
    const missing = [...read]
      .filter((name) => !ELSEWHERE.has(name) && !except?.has(name))
      .filter((name) => !aliasesOf(name).some((a) => have.has(a)))
      .sort();

    assert.deepEqual(missing, [],
      `${file} never mentions ${missing.join(', ')}, which the server reads. ` +
      (also
        ? `It extends ${also}, so that is usually where it goes. `
        : 'It is the file this edition is documented in, so this is where it goes. ') +
      'If no deployment should set it, add it to ELSEWHERE with the reason; if ' +
      'only this one should not, add it to that entry\'s `except`.');
  });
}

/**
 * The variables an env template offers, commented-out ones included.
 *
 * `#LOG_LEVEL=info` IS documentation an operator can find and uncomment, which
 * is the whole point of shipping the tuning block that way — so unlike
 * `documented()` above, a leading `#` does not disqualify a line here.
 *
 * @param {string} text @returns {Set<string>}
 */
function offered(text) {
  const names = new Set();
  for (const [, n] of text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)) names.add(n);
  return names;
}

/** Every `${NAME}` a compose file substitutes. @param {string} text */
function interpolated(text) {
  return new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(([, n]) => n));
}

for (const { file, composes } of ENV_TEMPLATES) {
  test(`${file} offers every variable its compose files interpolate`, () => {
    const have = offered(readFileSync(join(ROOT, file), 'utf8'));
    const wanted = new Set();
    for (const c of composes) {
      for (const n of interpolated(readFileSync(join(ROOT, c), 'utf8'))) wanted.add(n);
    }
    assert.ok(wanted.size > 5, `only found ${wanted.size} interpolations — the reader is broken`);

    const missing = [...wanted].filter((n) => !have.has(n)).sort();
    assert.deepEqual(missing, [],
      `${file} never offers ${missing.join(', ')}, which ${composes.join(' / ')} ` +
      'substitute. A variable a compose file names is one an operator can set ' +
      'in .env, so it belongs in the template — commented out if it is tuning.');
  });

  test(`${file} offers nothing that would be inert`, () => {
    // The failure the old habiterall-cloud/.env.example had. A line here that
    // no compose file interpolates is not a setting: `.env` is read for
    // substitution only, so it reaches no process and quietly does nothing.
    const have = offered(readFileSync(join(ROOT, file), 'utf8'));
    const wanted = new Set();
    for (const c of composes) {
      for (const n of interpolated(readFileSync(join(ROOT, c), 'utf8'))) wanted.add(n);
    }

    const inert = [...have].filter((n) => !wanted.has(n)).sort();
    assert.deepEqual(inert, [],
      `${file} offers ${inert.join(', ')}, which none of ${composes.join(' / ')} ` +
      'interpolate — so setting one there does nothing at all. Either name it in ' +
      'the compose file\'s environment block, or take the line out.');
  });
}

test('nothing is opted out that the server no longer reads', () => {
  // An opt-out is a decision about a real variable. Left behind after the
  // variable goes, it is a claim about the code that is no longer true, and
  // the next person reads it as one. Both kinds are checked: ELSEWHERE, and
  // the per-deployment `except` lists.
  const read = new Set();
  for (const { entries } of COMPOSE) {
    for (const name of envNames(moduleGraph(entries))) read.add(name);
  }

  const opted = [
    ...[...ELSEWHERE.keys()].map((name) => ({ name, where: 'ELSEWHERE' })),
    ...COMPOSE.flatMap(({ file, except }) =>
      [...(except?.keys() ?? [])].map((name) => ({ name, where: `${file}'s except` }))),
  ];
  const dead = opted.filter(({ name }) => !read.has(name))
    .map(({ name, where }) => `${name} (${where})`).sort();

  assert.deepEqual(dead, [],
    `${dead.join(', ')} is opted out, and nothing reads it any more`);
});

test('a file that reads the environment dynamically declares what it reads', () => {
  // `process.env[name]` cannot be followed to a name, so a file that does it
  // has to say. Without this the three Authentik switches were read by the
  // bootstrap, absent from the discovery, and therefore free to be missing
  // from a compose file — the exact silence the whole test exists to end, and
  // it took a review to notice because everything was green.
  const files = new Set();
  for (const { entries } of COMPOSE) {
    for (const file of moduleGraph(entries)) files.add(file);
  }

  const undeclared = [...files]
    .filter((file) => {
      const text = readFileSync(file, 'utf8');
      return DYNAMIC.test(text) && !new RegExp(MARKER.source).test(text);
    })
    .map((file) => file.slice(ROOT.length + 1))
    .sort();

  assert.deepEqual(undeclared, [],
    `${undeclared.join(', ')} reads process.env with a computed key and has no ` +
    '`@env NAME NAME` marker, so nothing can tell which variables those are.');
});

test('the marker covers every switch the bootstrap actually reads', () => {
  // A marker is a hand-kept list, so it can go stale the moment a fourth
  // `flag(...)` is added beside it. This is the one helper of that shape in
  // the repository, and its call sites DO name their variable, so they can be
  // checked against what the discovery ended up with.
  const file = join(ROOT, 'habiterall-cloud/scripts/bootstrap-authentik.mjs');
  const source = readFileSync(file, 'utf8');
  const called = [...source.matchAll(/\bflag\(\s*'([A-Z][A-Z0-9_]*)'/g)].map(([, n]) => n);
  assert.ok(called.length >= 3, `only found ${called.length} flag() call sites`);

  const seen = envNames(moduleGraph([BOOTSTRAP]));
  const missed = called.filter((name) => !seen.has(name)).sort();
  assert.deepEqual(missed, [],
    `flag() reads ${missed.join(', ')}, which the @env marker beside it omits`);
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
