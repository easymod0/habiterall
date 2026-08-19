/**
 * The wiki: its index, and the shell around each generated page.
 *
 * Three columns at desktop width — nav, content, contents-of-this-page — and one
 * at phone width, where both navs become `<details>`. `<details>` rather than a
 * button and a class toggle because a collapsed nav that needs JavaScript is a
 * nav that is missing while the page is still loading, and this is a
 * documentation site people arrive at from a search result on a phone.
 */
import { PAGES, GROUPS } from '../pages.js';
import { escapeAttr, escapeHtml } from '../render.mjs';
import { url } from './layout.mjs';

/**
 * The sidebar, with the current page marked.
 *
 * @param {string} [currentSlug]
 * @returns {string}
 */
export function sidebar(currentSlug) {
  const bySlug = new Map(PAGES.map((p) => [p.slug, p]));

  const groups = GROUPS.map((group) => {
    const items = group.slugs.map((slug) => {
      const page = bySlug.get(slug);
      if (!page) {
        throw new Error(
          `site/pages.js: GROUPS names the page "${slug}", which is not in PAGES.`,
        );
      }
      const here = slug === currentSlug;
      return `<li><a href="${url(`wiki/${slug}/`)}"${here ? ' aria-current="page"' : ''}>${escapeHtml(page.title)}</a></li>`;
    }).join('\n        ');

    return `<div class="nav-group">
      <h2>${escapeHtml(group.name)}</h2>
      <ul>
        ${items}
      </ul>
    </div>`;
  }).join('\n    ');

  return `<nav class="wiki-nav" aria-label="Wiki">
    <a class="wiki-nav-home" href="${url('wiki/')}"${currentSlug === undefined ? ' aria-current="page"' : ''}>All pages</a>
    ${groups}
  </nav>`;
}

/**
 * The search box. Its results are built in `site.js` from `search-index.json`,
 * which the build emits — but the input is here, and it is a real `<form>`
 * pointing at the wiki index, so that with JavaScript off or still loading it
 * degrades to a link to the page listing every section rather than to a control
 * that does nothing when typed into.
 */
function searchBox() {
  return `<form class="search" role="search" action="${url('wiki/')}">
    <label class="visually-hidden" for="wiki-search">Search the wiki</label>
    <input id="wiki-search" name="q" type="search" placeholder="Search the wiki…"
           autocomplete="off" spellcheck="false">
    <div class="search-results" hidden></div>
  </form>`;
}

/**
 * One generated wiki page.
 *
 * @param {object} ctx
 * @param {import('../pages.js').Page} ctx.page
 * @param {string} ctx.html      the rendered README slice
 * @param {string} ctx.anchorId  the id its <h1> carries — the README's own anchor
 * @param {Array<{ level: number, text: string, id: string }>} ctx.headings
 * @returns {string}
 */
export function wikiPage({ page, html, anchorId, headings }) {
  // Only h2 and h3: an on-page contents that lists every level is a second copy
  // of the page, and the README nests to four.
  const toc = headings.filter((h) => h.level === 2 || h.level === 3);

  const contents = toc.length > 1
    ? `<aside class="wiki-toc" aria-label="On this page">
    <h2>On this page</h2>
    <ul>
      ${toc.map((h) => `<li class="lvl-${h.level}"><a href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a></li>`).join('\n      ')}
    </ul>
  </aside>`
    : '';

  const index = PAGES.findIndex((p) => p.slug === page.slug);
  const previous = PAGES[index - 1];
  const next = PAGES[index + 1];

  return `
<div class="wrap wiki">
  <details class="wiki-nav-mobile">
    <summary>Wiki contents</summary>
    ${sidebar(page.slug)}
  </details>

  <div class="wiki-side">
    ${searchBox()}
    ${sidebar(page.slug)}
  </div>

  <article class="wiki-body prose">
    <h1 id="${escapeAttr(anchorId)}">${escapeHtml(page.title)}</h1>
    ${html}

    <nav class="wiki-seq" aria-label="Pagination">
      ${previous ? `<a class="prev" href="${url(`wiki/${previous.slug}/`)}"><span>Previous</span>${escapeHtml(previous.title)}</a>` : '<span></span>'}
      ${next ? `<a class="next" href="${url(`wiki/${next.slug}/`)}"><span>Next</span>${escapeHtml(next.title)}</a>` : '<span></span>'}
    </nav>
  </article>

  ${contents}
</div>
`;
}

/**
 * The wiki's front page: every page, grouped, with its one-line blurb.
 *
 * @returns {string}
 */
export function wikiIndex() {
  const bySlug = new Map(PAGES.map((p) => [p.slug, p]));

  const groups = GROUPS.map((group) => `<section class="index-group">
      <h2>${escapeHtml(group.name)}</h2>
      <div class="grid">
        ${group.slugs.map((slug) => {
          const page = /** @type {import('../pages.js').Page} */ (bySlug.get(slug));
          return `<a class="card link-card" href="${url(`wiki/${slug}/`)}">
          <h3>${escapeHtml(page.title)}</h3>
          <p>${escapeHtml(page.blurb)}</p>
        </a>`;
        }).join('\n        ')}
      </div>
    </section>`).join('\n    ');

  return `
<div class="wrap wiki-index">
  <header class="page-head">
    <h1>Wiki</h1>
    <p class="lead">
      Deployment, configuration, reminders, the API and the security model.
      Every page here is generated from the project's README, so it is the same
      manual the repository ships — never a stale copy of it.
    </p>
    ${searchBox()}
  </header>

  ${groups}
</div>
`;
}
