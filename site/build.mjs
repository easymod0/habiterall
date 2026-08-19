#!/usr/bin/env node
/**
 * Build habiterall.ca into `site/dist/`.
 *
 *   npm run site:build              everything, including the changelog
 *   npm run site:build -- --offline the network is not available; skip it
 *   npm run site:serve              preview what was built
 *
 * The site has three sources and writes none of them:
 *
 *   README.md            -> the wiki, sliced by site/pages.js
 *   docs/screenshots/    -> the gallery and every figure, captioned by the README
 *   GitHub Releases API  -> the changelog and the downloads page
 *
 * Only the landing page is written by hand, and it is the only page on which a
 * fact can go stale. `buildSite()` is exported so `shared/test/site.test.js`
 * runs the whole thing in-process — the same arrangement as
 * `scripts/sync-compose-docs.mjs` and `shared/test/examples.test.js`, and for
 * the same reason: a check that only CI performs is a check that fails after
 * the mistake has been pushed.
 *
 * `--offline` exists so the site can be worked on without a network. It is NOT
 * a fallback: a publishing build that cannot reach the API FAILS, because a
 * changelog that silently deploys empty is worse than one that does not deploy.
 */
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SITE, COPIED_ASSETS } from './config.js';
import { PAGES } from './pages.js';
import {
  anchorIndex,
  pageAnchorId,
  pageMarkdown,
  renderMarkdown,
  screenshotAlts,
  splitHeadings,
  SCREENSHOT_DIR,
} from './render.mjs';
import { fetchReleases, latestDownload, linkifyNotes, withoutInstall } from './releases.mjs';
import { layout } from './templates/layout.mjs';
import { home } from './templates/home.mjs';
import { wikiPage, wikiIndex } from './templates/wiki.mjs';
import { changelog } from './templates/changelog.mjs';
import { downloads } from './templates/downloads.mjs';
import { gallery } from './templates/gallery.mjs';

export const SITE_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(SITE_DIR, '..');

/**
 * Build the whole site.
 *
 * @param {object} [options]
 * @param {string} [options.out] output directory, default `site/dist`
 * @param {boolean} [options.offline] skip the Releases API
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{ pages: Map<string, string>, warnings: string[] }>}
 *   every path written, keyed by its path inside the output
 */
export async function buildSite({ out = join(SITE_DIR, 'dist'), offline = false, log = () => {} } = {}) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, string>} */
  const written = new Map();

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const blocks = splitHeadings(readme);
  const anchors = anchorIndex(blocks);
  const shots = screenshotAlts(readme);

  /** @type {Array<{ t: string, b: string, u: string, p: string }>} */
  const searchIndex = [];

  /** @type {Array<{ path: string, changed: string }>} */
  const sitemap = [];

  const write = (path, html) => {
    written.set(path, html);
    const file = join(out, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  };

  const page = (path, html) => {
    write(path === '' ? 'index.html' : `${path}index.html`, html);
    sitemap.push({ path, changed: '' });
  };

  // ---------------------------------------------------------------- releases
  const releases = await fetchReleases({ offline });
  const download = latestDownload(releases);
  if (offline) {
    warnings.push(
      'OFFLINE: the changelog and downloads pages were NOT built. ' +
        'They are the two pages that come from the GitHub API. Do not deploy this.',
    );
  }

  // ------------------------------------------------------------------- clean
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // ------------------------------------------------------------------ assets
  cpSync(join(SITE_DIR, 'static'), out, { recursive: true });

  const screenshots = readdirSync(join(ROOT, 'docs', 'screenshots'))
    .filter((f) => f.endsWith('.png'))
    .sort();
  mkdirSync(join(out, SCREENSHOT_DIR), { recursive: true });
  for (const file of screenshots) {
    cpSync(join(ROOT, 'docs', 'screenshots', file), join(out, SCREENSHOT_DIR, file));
  }

  for (const [from, to] of COPIED_ASSETS) {
    cpSync(join(ROOT, from), join(out, to));
  }

  // ---------------------------------------------------------------- the wiki
  for (const wiki of PAGES) {
    /** @type {Array<{ level: number, text: string, id: string }>} */
    const headings = [];
    const html = renderMarkdown(pageMarkdown(wiki, blocks), {
      anchors,
      root: ROOT,
      headings,
      expand: wiki.expand,
    });
    const path = `wiki/${wiki.slug}/`;

    page(
      path,
      layout({
        title: wiki.title,
        description: wiki.blurb,
        path,
        body: wikiPage({ page: wiki, html, anchorId: pageAnchorId(wiki), headings }),
      }),
    );

    // One search record per section rather than one per page: a 300-line
    // configuration page matching "ntfy" and landing the reader at its top has
    // technically found it and practically has not.
    // The page's own record carries its whole text, not just its blurb. Several
    // pages — Security, Backup, Loop import — claim a single README section and
    // so have no h2 under them to index; with the blurb alone, searching for
    // any phrase in the body of one of those found nothing at all.
    searchIndex.push({
      t: wiki.title,
      b: `${wiki.blurb} ${stripHtml(html)}`.slice(0, 600),
      u: SITE.basePath + path,
      p: wiki.title,
    });
    for (const heading of headings) {
      if (heading.level > 3) continue;
      searchIndex.push({
        t: heading.text,
        b: sectionText(html, heading.id),
        u: `${SITE.basePath}${path}#${heading.id}`,
        p: wiki.title,
      });
    }

    log(`wiki/${wiki.slug}`);
  }

  page(
    'wiki/',
    layout({
      title: 'Wiki',
      description:
        "Deployment, configuration, reminders, the API and the security model — generated from the project's README.",
      path: 'wiki/',
      body: wikiIndex(),
    }),
  );

  // --------------------------------------------------------------- the rest
  page(
    '',
    layout({
      title: SITE.name,
      description:
        'A self-hosted habit tracker with the statistics of Loop Habit Tracker — in your browser, on your server, with your data.',
      path: '',
      bodyClass: 'home',
      body: home({ shots, download }),
    }),
  );

  page(
    'screenshots/',
    layout({
      title: 'Screenshots',
      description: 'Every screen of habiterall, captured from the real app with sample data.',
      path: 'screenshots/',
      body: gallery({ files: screenshots, shots }),
    }),
  );

  if (releases) {
    page(
      'changelog/',
      layout({
        title: 'Changelog',
        description: `Every release of habiterall, newest first — ${releases.length} of them, generated from the project's GitHub releases.`,
        path: 'changelog/',
        body: changelog({
          releases: releases.map((release) => ({
            ...release,
            notes: renderMarkdown(linkifyNotes(withoutInstall(release.body)), {
              anchors,
              root: ROOT,
              lenient: true,
            }),
          })),
        }),
      }),
    );

    page(
      'downloads/',
      layout({
        title: 'Downloads',
        description: `Docker images for both editions and the native Android APK — habiterall ${download?.tag ?? ''}.`,
        path: 'downloads/',
        body: downloads({ download }),
      }),
    );
  }

  // ------------------------------------------------------------- index files
  writeFileSync(join(out, 'search-index.json'), JSON.stringify(searchIndex));
  writeFileSync(join(out, 'sitemap.xml'), sitemapXml(sitemap));

  // The custom domain, and the crawler's copy of it. Both DERIVED from
  // `SITE.baseUrl` rather than written out, because all three have to name the
  // same host and each disagrees in its own quiet way: a `CNAME` naming a host
  // the pages do not link to makes every internal link a redirect, and a
  // `robots.txt` pointing at a sitemap on another host is simply ignored.
  //
  // `CNAME` in particular is a file GitHub reads and nothing else does. If it
  // stops being published, Pages drops the custom domain on the very next
  // deploy — no error, no warning, the site just answers on github.io instead.
  // `shared/test/site.test.js` asserts it, for exactly that reason.
  const host = new URL(SITE.baseUrl).hostname;
  writeFileSync(join(out, 'CNAME'), `${host}\n`);
  writeFileSync(
    join(out, 'robots.txt'),
    [
      '# Everything here is public documentation and meant to be indexed.',
      'User-agent: *',
      'Allow: /',
      '',
      `Sitemap: ${SITE.baseUrl}${SITE.basePath}sitemap.xml`,
      '',
    ].join('\n'),
  );

  // GitHub Pages serves this for any path it does not have. Without it a typo'd
  // URL gets Pages' own 404, which is a page belonging to no site at all.
  write('404.html', layout({
    title: 'Not found',
    description: 'That page is not here.',
    path: '404.html',
    body: `<div class="wrap page-head">
  <h1>Not found</h1>
  <p class="lead">That page is not here. It may have moved when the manual was reorganised.</p>
  <p><a class="button" href="${SITE.basePath}">Home</a>
     <a class="button secondary" href="${SITE.basePath}wiki/">Browse the wiki</a></p>
</div>`,
  }));

  return { pages: written, warnings };
}

/**
 * The text under one heading in the rendered HTML, for the search index.
 *
 * Taken from the HTML rather than from the markdown because the markdown still
 * contains the table pipes, the link syntax and the raw `<img>` tags — a search
 * excerpt reading `[Published images](#published-images)` is worse than none.
 *
 * @param {string} html
 * @param {string} id
 * @returns {string}
 */
export function sectionText(html, id) {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) return '';

  // Past the CLOSING tag of the heading, not its opening one. Starting after
  // `<h3 id="ntfy">` swept up the heading's own text and the `#` of its
  // permalink, so every excerpt began by repeating the title it was shown
  // under, followed by a stray hash.
  const close = html.indexOf('</h', start);
  const from = close < 0 ? html.indexOf('>', start) + 1 : html.indexOf('>', close) + 1;

  const next = /<h[1-6] /.exec(html.slice(from));
  return stripHtml(html.slice(from, next ? from + next.index : from + 4000)).slice(0, 600);
}

/**
 * HTML reduced to the words in it, for the search index.
 *
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  let previous;
  let text = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ');

  // To a fixed point, for the reason spelled out over `withoutTags` in
  // render.mjs: one pass over `<scr<script>ipt>` reintroduces what it removed.
  //
  // This is NOT a sanitizer and must not start being treated as one — its
  // output is search-index text, and `site.js` puts it on the page through
  // `textContent`, which cannot interpret markup however mangled it is. The
  // loop is here so the function is not a worked example of the wrong pattern
  // sitting one directory from the right one.
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, ' ');
  } while (text !== previous);

  return text
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {Array<{ path: string }>} entries
 * @returns {string}
 */
export function sitemapXml(entries) {
  const urls = entries
    .map((entry) => `  <url><loc>${SITE.baseUrl}${SITE.basePath}${entry.path}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

/* -------------------------------------------------------------------- cli */

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const offline = process.argv.includes('--offline');
  const quiet = process.argv.includes('--quiet');

  try {
    const started = process.hrtime.bigint();
    const { pages, warnings } = await buildSite({
      offline,
      log: quiet ? () => {} : (message) => process.stdout.write(`  ${message}\n`),
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    process.stdout.write(`\n${pages.size} pages in ${ms.toFixed(0)}ms -> site/dist\n`);
    for (const warning of warnings) process.stdout.write(`\n⚠ ${warning}\n`);
    process.stdout.write('\nPreview it with: npm run site:serve\n');
  } catch (error) {
    // The message is the whole point of every throw in render.mjs — it names
    // the link, the heading or the file that has to change. A stack trace on
    // top of it buries that under twelve frames of `marked`.
    process.stderr.write(`\nSite build failed.\n\n  ${error.message}\n\n`);
    process.exitCode = 1;
  }
}
