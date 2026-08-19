import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { PAGES, GROUPS, NOT_ON_THE_WIKI } from '../../site/pages.js';
import { SITE } from '../../site/config.js';
import {
  githubSlug,
  splitHeadings,
  anchorIndex,
  dropTrailingRule,
  pageMarkdown,
  renderMarkdown,
  withoutTags,
} from '../../site/render.mjs';
import { withoutInstall, linkifyNotes, nextPage, latestDownload } from '../../site/releases.mjs';
import { buildSite, sectionText, stripHtml } from '../../site/build.mjs';
import { hostedCta } from '../../site/templates/layout.mjs';
import { home } from '../../site/templates/home.mjs';
import { screenshotAlts } from '../../site/render.mjs';

/**
 * habiterall.ca, which is GENERATED from the files this repository already
 * keeps: `README.md` for the wiki, `docs/screenshots/` for the figures, and the
 * GitHub Releases API for the changelog.
 *
 * That is the whole reason this file exists. A generated site fails in one
 * direction — silently, into a 404 that only a visitor finds — and every check
 * below is aimed at that: a heading that no page claims, a link that resolves to
 * nothing, an image that was never copied. The build throws on most of them, and
 * these run the build, so `npm test` fails on a bad README rather than the
 * deploy doing it twenty minutes later.
 *
 * Lives in `shared/test` for the same dull reason as `examples.test.js` and
 * `readme-assets.test.js`: `npm test` only reaches workspaces, and `site/` is
 * not one.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = readFileSync(join(root, 'README.md'), 'utf8');

/** Built once, offline, into a throwaway directory. */
let out = '';
/** @type {Map<string, string>} */
let built = new Map();
/** @type {Error | null} */
let buildError = null;

before(async () => {
  out = mkdtempSync(join(tmpdir(), 'habiterall-site-'));
  try {
    // Offline: this suite must not need a network, and the two pages it skips —
    // changelog and downloads — are covered by unit checks on their inputs below.
    ({ pages: built } = await buildSite({ out, offline: true }));
  } catch (error) {
    // CAUGHT, not thrown. The build refuses an unresolvable link by design, and
    // a `before` hook that throws takes every test in the file down with it —
    // so renaming one README heading reported twenty-one failures, none of
    // which said which heading. Held here instead, so the checks that need no
    // build still run and name the actual fault; `built` is empty, so the ones
    // that do fail on the assertion below.
    buildError = /** @type {Error} */ (error);
  }
});

/** For the tests that read the output: fail with the build's own message. */
function requireBuild() {
  assert.equal(buildError, null, `the site did not build: ${buildError?.message}`);
}

test('the site builds', () => {
  requireBuild();
  assert.ok(built.size > 15, `only ${built.size} files were written`);
});

after(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ slugs */

test('githubSlug matches the anchors README.md already links to', () => {
  // LITERALS, not `githubSlug(...)` compared against itself, and not a table
  // generated from the README. These four strings are the actual anchors in
  // circulation — in the README's own Contents block, and in every link anyone
  // has shared to a section of it on GitHub — so this is the contract.
  assert.equal(githubSlug('Which edition do I want?'), 'which-edition-do-i-want');
  assert.equal(githubSlug('Both editions: the reminder scheduler'), 'both-editions-the-reminder-scheduler');
  assert.equal(githubSlug('Filling in the `.env`'), 'filling-in-the-env');
  assert.equal(githubSlug('Discord with buttons (recommended)'), 'discord-with-buttons-recommended');
  assert.equal(githubSlug('Coming from Loop Habit Tracker'), 'coming-from-loop-habit-tracker');
});

test('stripping tags cannot reintroduce the tag it stripped', () => {
  // CodeQL's `js/incomplete-multi-character-sanitization`, raised against two
  // single-pass `<[^>]*>` replaces here.
  //
  // What this pins is the PROPERTY — nothing matching `<…>` survives — and not
  // the loop that currently delivers it. Making `withoutTags` a single pass
  // again leaves this green, because against a GLOBAL pattern one pass already
  // reaches the fixed point. Dropping the `g` does not: it leaves `</script>`
  // in the output, and that is the mutation this test is really for. See the
  // note over `withoutTags`.
  //
  // The invariant is a FIXED POINT — no `<…>` survives — and not "the output is
  // empty". Worth being exact, because the obvious expectation is wrong and was
  // written here first: one pass over `<scr<script>ipt>` matches from the FIRST
  // `<` to the first `>`, so it removes `<scr<script>` and leaves `ipt>`. That
  // trailing text is harmless and is not a tag; what matters is that no second
  // pass finds anything, which is exactly what a reintroduction would be.
  for (const nasty of [
    '<scr<script>ipt>',
    '<<a>b>hello',
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<<<div>>>',
  ]) {
    const cleaned = withoutTags(nasty);
    assert.doesNotMatch(cleaned, /<[^>]*>/, `a tag survived stripping ${nasty}: ${cleaned}`);
    assert.ok(!cleaned.includes('<script'), `stripping ${nasty} produced ${cleaned}`);
  }

  // `stripHtml` drops the CONTENT of a script/style element as well as its
  // tags, so a malformed nesting can take neighbouring text with it — here the
  // whole thing reduces to nothing rather than to "x". That is the safe
  // direction and it costs only search-index text, over a README that contains
  // no such construct; the assertion is the invariant, not the leftovers.
  assert.doesNotMatch(stripHtml('<div><scr<script>ipt>x</scr</script>ipt></div>'), /[<>]/);

  // What it does on the real thing: the words, and none of the markup.
  assert.equal(
    stripHtml('<p>Reminders go to an <code>ntfy</code> topic.</p>'),
    'Reminders go to an ntfy topic.',
  );

  // And an ordinary heading still slugs the way it always did, which is the
  // thing this function is actually for.
  assert.equal(githubSlug('<b>Full</b> reference'), 'full-reference');
});

test('a heading anchor and its collected text are taken from tokens, not from HTML', () => {
  // The structural half of the same finding: `tokenText` DROPS `html` tokens
  // rather than pattern-matching them out, so nesting has nothing to defeat.
  //
  // Note what is NOT claimed. `marked` passes raw HTML through, deliberately and
  // necessarily — README.md's screenshots are raw `<img>` inside
  // `<div align="center">` and its API reference is a `<details>`, so a renderer
  // that dropped inline HTML would delete half the manual. README.md is ours and
  // arrives through review; this is the same trust model GitHub renders it under.
  //
  // What IS claimed is that the two values DERIVED from a heading — the `id`
  // that becomes a URL fragment, and the text that reaches the contents column
  // and the search index — carry no markup, whatever the heading contains.
  const anchors = anchorIndex(splitHeadings(README));
  /** @type {Array<{ level: number, text: string, id: string }>} */
  const headings = [];

  const html = renderMarkdown('## <scr<script>ipt>Danger</scr</script>ipt> here\n\ntext\n', {
    anchors,
    root,
    headings,
    lenient: true,
  });

  assert.match(html, /id="danger-here"/, `the anchor was poisoned: ${html}`);
  assert.deepEqual(headings.map((h) => h.text), ['Danger here']);
  assert.doesNotMatch(headings[0].text, /[<>]/);
  assert.doesNotMatch(headings[0].id, /[<>]/);
});

/* ---------------------------------------------------------- the page map */

test('every README heading is claimed by exactly one wiki page', () => {
  const claimed = new Map();
  for (const page of PAGES) {
    for (const heading of page.claims) {
      const already = claimed.get(heading);
      assert.equal(
        already,
        undefined,
        `"${heading}" is claimed by both ${already} and ${page.slug} in site/pages.js`,
      );
      claimed.set(heading, page.slug);
    }
  }

  const unclaimed = splitHeadings(README)
    .filter((block) => block.level > 1)
    .map((block) => block.text)
    .filter((text) => !claimed.has(text) && !(text in NOT_ON_THE_WIKI));

  assert.deepEqual(
    unclaimed,
    [],
    'README.md has headings that appear on no wiki page and are not listed as ' +
      'deliberately excluded. Add each to a page\'s `claims` in site/pages.js, or ' +
      'to NOT_ON_THE_WIKI with the reason: ' + unclaimed.join(', '),
  );
});

test('every page claims a heading README.md actually has', () => {
  const blocks = splitHeadings(README);
  for (const page of PAGES) {
    // pageMarkdown throws by name on a claim the README lost, which is the
    // other direction of the check above: a heading renamed rather than added.
    assert.doesNotThrow(() => pageMarkdown(page, blocks), `page "${page.slug}"`);
  }
});

test('every wiki page is in exactly one sidebar group', () => {
  const grouped = GROUPS.flatMap((group) => group.slugs);
  const duplicated = grouped.filter((slug, i) => grouped.indexOf(slug) !== i);
  assert.deepEqual(duplicated, [], 'these pages are in two GROUPS: ' + duplicated.join(', '));

  const missing = PAGES.map((p) => p.slug).filter((slug) => !grouped.includes(slug));
  assert.deepEqual(
    missing,
    [],
    'these pages are in PAGES but in no group, so they are on no sidebar: ' + missing.join(', '),
  );

  const unknown = grouped.filter((slug) => !PAGES.some((p) => p.slug === slug));
  assert.deepEqual(unknown, [], 'GROUPS names pages that do not exist: ' + unknown.join(', '));
});

/* ---------------------------------------------------------------- links */

test('every anchor link in README.md resolves to a page on the site', () => {
  const anchors = anchorIndex(splitHeadings(README));

  const linked = [...README.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(linked.length > 20, `expected the README to link to its own sections; found ${linked.length}`);

  const broken = [...new Set(linked)].filter((anchor) => !anchors.has(anchor));
  assert.deepEqual(
    broken,
    [],
    'README.md links to anchors that are on no wiki page: ' + broken.join(', '),
  );
});

test('no repo-relative link survives into the built HTML', () => {
  requireBuild();
  // `(LICENSE)` and `(examples/personal.env.example)` are correct in a README
  // and are nothing at all on a website. Every one has to have become an
  // absolute github.com URL.
  const offenders = [];

  for (const [path, html] of built) {
    if (!path.endsWith('.html')) continue;
    for (const match of html.matchAll(/(?:href|src|srcset)="([^"]*)"/g)) {
      const value = match[1];
      if (/^(https?:|mailto:|#|\/)/.test(value)) continue;
      offenders.push(`${path}: ${value}`);
    }
  }

  assert.deepEqual(offenders, [], 'unresolved relative links in the output: ' + offenders.join(', '));
});

test('every image in the built HTML was actually copied into the output', () => {
  requireBuild();
  const missing = [];

  // `srcset` as well as `src`. A `<picture>` whose `<source>` points at a file
  // that was never published does not show a broken image — it falls back to
  // the `<img>` and looks perfect, so the phone-sized dashboard capture on the
  // landing page would silently stop being used and nobody on a desktop would
  // ever see it.
  for (const [path, html] of built) {
    if (!path.endsWith('.html')) continue;
    for (const match of html.matchAll(/<(?:img|source)[^>]*(?:src|srcset)="([^"]*)"/g)) {
      const src = match[1];
      if (/^https?:/.test(src)) continue;
      if (!existsSync(join(out, src.replace(/^\//, '')))) missing.push(`${path}: ${src}`);
    }
  }

  assert.deepEqual(missing, [], 'the site shows images it did not publish: ' + missing.join(', '));
  assert.ok(
    [...built.values()].some((html) => html.includes('<source media=')),
    'no <picture> source was rendered, so this check is passing over nothing',
  );
});

/* ----------------------------------------------------------- screenshots */

test('the gallery shows every screenshot in the repository', () => {
  requireBuild();
  const files = readdirSync(join(root, 'docs', 'screenshots')).filter((f) => f.endsWith('.png'));
  assert.ok(files.length > 5, 'expected docs/screenshots to hold the capture set');

  const html = built.get('screenshots/index.html');
  assert.ok(html, 'the gallery page was not built');

  const absent = files.filter((file) => !html.includes(`/assets/screenshots/${file}`));
  assert.deepEqual(absent, [], 'screenshots missing from the gallery: ' + absent.join(', '));
});

test('the gallery captions every screenshot with the README\'s own alt text', () => {
  requireBuild();
  // The gallery writes no prose. If a capture is added to docs/screenshots/ and
  // not to the README, it has no description — and `readme-assets.test.js`
  // requires the README's to be over 40 characters, which is the guarantee the
  // gallery is borrowing.
  //
  // Asserted on the `alt` ATTRIBUTE of each <img>, not on the page text. The
  // first version of this looked for the description anywhere in the HTML,
  // which the visible caption satisfies on its own — so replacing every alt
  // with the word "screenshot" left it passing on eleven images that had just
  // become invisible to a screen reader, which is the one reader this borrowed
  // guarantee exists for.
  const shots = screenshotAlts(README);
  const html = /** @type {string} */ (built.get('screenshots/index.html'));

  /** @type {Map<string, string>} */
  const rendered = new Map();
  for (const tag of html.matchAll(/<img[^>]*src="[^"]*\/([^"/]+\.png)"[^>]*>/g)) {
    rendered.set(tag[1], /alt="([^"]*)"/.exec(tag[0])?.[1] ?? '');
  }

  assert.equal(rendered.size, shots.size, 'the gallery shows a different number of images');

  for (const [file, meta] of shots) {
    const alt = rendered.get(file);
    assert.ok(alt, `${file} is on the gallery with no alt attribute at all`);
    assert.equal(
      alt,
      meta.alt.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      `${file}'s alt text on the gallery is not the README's description of it`,
    );
  }
});

/* ------------------------------------------------------- the hosted CTA */

test('the hero copy follows hostedSignups, in both states', () => {
  // The FLAG is not what is asserted — the rendered HTML is. A test that read
  // `SITE.hostedSignups` would pass just as well against a template that never
  // consulted it, which is the failure this project keeps finding one line
  // below a correct pure function.
  const shots = screenshotAlts(README);
  const original = SITE.hostedSignups;

  try {
    SITE.hostedSignups = false;
    const closed = home({ shots, download: null });
    assert.match(closed, />Sign in</, 'closed signups should offer "Sign in"');
    assert.match(closed, /opening soon/, 'closed signups should say so');
    assert.doesNotMatch(closed, /Create a free account/);
    assert.equal(hostedCta().label, 'Sign in');

    SITE.hostedSignups = true;
    const open = home({ shots, download: null });
    assert.match(open, />Create a free account</, 'open signups should invite registration');
    assert.doesNotMatch(open, /opening soon/, 'the coming-soon note must go when signups open');
    assert.equal(hostedCta().label, 'Create a free account');
  } finally {
    SITE.hostedSignups = original;
  }
});

test('the landing page only shows screenshots the README describes', () => {
  const original = SITE.hostedSignups;
  try {
    // An image the README does not carry has no alt text, so `home()` refuses
    // it rather than shipping a figure that is invisible to a screen reader.
    assert.throws(() => home({ shots: new Map(), download: null }), /README does not/);
  } finally {
    SITE.hostedSignups = original;
  }
});

/* ------------------------------------------------------- release notes */

test('the changelog drops the install block every release repeats', () => {
  const body = [
    '## What changed since v1.1.3',
    '',
    '### Fixes',
    '- fix(export): something (`292027d`)',
    '',
    '### Install',
    '',
    '**Docker** — `linux/amd64`:',
    '```bash',
    'docker pull ghcr.io/easymod0/habiterall-personal:1.1.4',
    '```',
  ].join('\n');

  const trimmed = withoutInstall(body);
  assert.match(trimmed, /fix\(export\)/, 'the actual changes must survive');
  assert.doesNotMatch(trimmed, /docker pull/, 'the install block must go');
  assert.doesNotMatch(trimmed, /### Install/);

  // A release with no install section is returned untouched, which is what
  // makes this safe against a hand-written note.
  assert.equal(withoutInstall('### Fixes\n- one'), '### Fixes\n- one');
});

test('release notes get their commits and pull requests linked', () => {
  const linked = linkifyNotes('- fix(export): a thing (#232) (`292027d`)');
  assert.match(linked, /\(\[#232\]\(https:\/\/github\.com\/easymod0\/habiterall\/pull\/232\)\)/);
  assert.match(linked, /commit\/292027d/);

  // Not every parenthesised backtick is a commit. `off` and `latest` appear
  // that way throughout the notes and must be left alone.
  assert.equal(linkifyNotes('set it to (`off`)'), 'set it to (`off`)');
});

test('the downloads page reads a real release, and skips prereleases', () => {
  const releases = [
    { tag: 'v1.2.0-rc1', prerelease: true, publishedAt: '2026-08-19T00:00:00Z', url: 'u', name: '', body: '', assets: [] },
    {
      tag: 'v1.1.4',
      prerelease: false,
      publishedAt: '2026-08-19T21:20:10Z',
      url: 'https://example.invalid/v1.1.4',
      name: '',
      body: '',
      assets: [
        { name: 'habiterall-native-1.1.4.apk', size: 1_887_436, url: 'https://example.invalid/apk' },
        { name: 'notes.txt', size: 10, url: 'https://example.invalid/notes' },
      ],
    },
  ];

  const download = latestDownload(releases);
  assert.equal(download.version, '1.1.4', 'a release candidate must not be what Download offers');
  assert.deepEqual(download.apks.map((a) => a.name), ['habiterall-native-1.1.4.apk']);
  assert.ok(download.images.some((i) => i.ref === 'ghcr.io/easymod0/habiterall-cloud:1.1.4'));
});

test('paginating the releases API follows rel=next and stops', () => {
  assert.equal(
    nextPage('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'),
    'https://api.github.com/x?page=2',
  );
  assert.equal(nextPage('<https://api.github.com/x?page=8>; rel="prev"'), '');
  assert.equal(nextPage(null), '');
});

/* ------------------------------------------------------------- slicing */

test('a section-closing rule is dropped, and one in the middle is not', () => {
  assert.equal(dropTrailingRule('Some prose.\n\n---'), 'Some prose.');
  assert.equal(dropTrailingRule('Some prose.\n\n---\n'), 'Some prose.');
  assert.equal(
    dropTrailingRule('One thing.\n\n---\n\nAnother thing.'),
    'One thing.\n\n---\n\nAnother thing.',
    'a thematic break inside a section is the author separating two things',
  );
});

test('headings inside fenced code do not slice the README', () => {
  // The env templates the README embeds are full of `# ---- sign-in ----`
  // banners. Treating one as a heading would cut a page in half through the
  // middle of a YAML file.
  const blocks = splitHeadings(
    ['## Real', 'body', '```bash', '# ---- not a heading ----', '## also not', '```', 'more'].join('\n'),
  );

  assert.deepEqual(blocks.map((b) => b.text), ['Real']);
  assert.match(blocks[0].body, /## also not/);
});

test('a search excerpt starts after the heading, not inside it', () => {
  const html = '<h3 id="ntfy">ntfy<a class="anchor" href="#ntfy">#</a></h3>\n<p>ntfy asks least of you.</p>';
  const text = sectionText(html, 'ntfy');

  assert.match(text, /ntfy asks least of you/);
  assert.ok(
    !text.startsWith('ntfy #'),
    `the excerpt repeated its own heading and permalink: ${JSON.stringify(text)}`,
  );
});

/* ---------------------------------------------------------- the output */

test('the build produces a page for every wiki page, plus the fixed ones', () => {
  requireBuild();
  for (const page of PAGES) {
    assert.ok(built.has(`wiki/${page.slug}/index.html`), `wiki/${page.slug} was not built`);
  }
  for (const path of ['index.html', 'wiki/index.html', 'screenshots/index.html', '404.html']) {
    assert.ok(built.has(path), `${path} was not built`);
  }
});

test('the custom domain is published, and it is the one the pages link to', () => {
  requireBuild();
  // A CNAME file that stops being published does not break the build, break a
  // link, or look wrong in review: GitHub simply drops the custom domain on the
  // next deploy and the site answers on github.io instead.
  //
  // The LITERAL, not `new URL(SITE.baseUrl).hostname` — deriving the expectation
  // from the same constant the code derives it from is a test that passes
  // against any hostname at all, including the apex, which is not the domain
  // Pages is configured with. `www` and the apex are different hosts to Pages:
  // whichever the CNAME names is canonical, and the other is at best a redirect.
  assert.equal(readFileSync(join(out, 'CNAME'), 'utf8').trim(), 'www.habiterall.ca');
  assert.equal(SITE.baseUrl, 'https://www.habiterall.ca');

  // …and the generated robots.txt points at a sitemap on that same host. On any
  // other one it is silently ignored.
  const robots = readFileSync(join(out, 'robots.txt'), 'utf8');
  assert.match(robots, /^Sitemap: https:\/\/www\.habiterall\.ca\/sitemap\.xml$/m);
});

test('every page carries a canonical URL and a link-preview image', () => {
  requireBuild();
  for (const [path, html] of built) {
    if (!path.endsWith('.html')) continue;
    assert.match(html, /<link rel="canonical" href="https:\/\/www\.habiterall\.ca\//, path);
    assert.match(html, /<meta property="og:image" content="https:\/\/www\.habiterall\.ca\/assets\//, path);
  }
});
