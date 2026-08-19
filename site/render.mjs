/**
 * README.md -> wiki HTML: slicing, slugs, and the link check.
 *
 * The whole site is generated from a file written for GitHub, and the three
 * things that break in that translation all break SILENTLY — into a 404 that
 * only a visitor finds:
 *
 *   1. `(#published-images)` was a same-page anchor and is now cross-page.
 *   2. `(LICENSE)` was repo-relative and is now nothing at all.
 *   3. `<img src="docs/screenshots/…">` pointed into the repository.
 *
 * So every link is RESOLVED rather than copied, and anything that cannot be
 * resolved throws. That is the single check this file exists for: it turns
 * "somebody renamed a README heading" from a broken site into a red pull
 * request, which is the only point at which it is cheap to fix.
 */
import { marked } from 'marked';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SITE } from './config.js';
import { PAGES, NOT_ON_THE_WIKI } from './pages.js';

/** Screenshots land here inside `dist/`, and the README's paths are rewritten to it. */
export const SCREENSHOT_DIR = 'assets/screenshots';

/**
 * GitHub's heading-anchor algorithm, reimplemented.
 *
 * Written out rather than taken from a `marked` plugin because the anchors are
 * not ours to choose: `README.md` already contains 26 links to them, every
 * one of which has to keep working, and so does every link anyone has already
 * shared to a section of the README on GitHub. A plugin that is 95% compatible
 * is a plugin that breaks one of them.
 *
 * Lowercase, drop HTML, drop everything that is not a letter, a number, an
 * underscore, a hyphen or a space, then spaces to hyphens. Note what that does
 * and does not remove: `Filling in the \`.env\`` keeps its letters and loses the
 * backticks and the dot, giving `filling-in-the-env`; `Both editions: the
 * reminder scheduler` loses only the colon. Both are anchors the README links
 * to, and `shared/test/site.test.js` asserts them as LITERALS — a test that
 * imported this function's output as its own expectation would pass against
 * every possible implementation of it.
 *
 * @param {string} text heading text, as written in the markdown
 * @returns {string}
 */
export function githubSlug(text) {
  return withoutTags(text.trim().toLowerCase())
    .replace(/[^\p{L}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

/**
 * `<…>` removed, repeatedly, until removing more changes nothing.
 *
 * The single-pass version CodeQL flagged
 * (`js/incomplete-multi-character-sanitization`) was not, in fact, defeatable —
 * and that is worth writing down rather than implying otherwise. The classic
 * `<scr<script>ipt>` attack works against a replace of a LITERAL, or against a
 * non-global pattern. Against a GLOBAL `<[^>]*>` it does not: the match runs
 * from the first `<` to the first `>`, so it consumes `<scr<script>` whole and
 * leaves the harmless `ipt>`. Fuzzed over 200,000 strings drawn from
 * `< > / a s c r i p t` and a space, one pass and the fixed point never once
 * disagreed.
 *
 * So this loop fixes no live bug, and a mutation test proves as much: making it
 * a single pass leaves every test green. What it changes is WHY the property
 * holds. One pass is correct because of an argument about this exact regex;
 * the loop is correct by construction, for any pattern someone later
 * substitutes. That distinction is not theoretical here — the three
 * combinations behave differently, and there is a test pinning it:
 *
 *   global + one pass    correct (today's argument)
 *   non-global + one pass BROKEN — leaves `</script>` in the output
 *   non-global + loop    correct
 *
 * Dropping the `g` is a one-character edit that no reviewer would question, and
 * the loop is what makes it survivable.
 *
 * Nor could the single pass have produced a vulnerability. `githubSlug` is this
 * function's only caller and follows with an ALLOWLIST keeping letters,
 * numbers, underscores, hyphens and spaces — `<`, `>`, `/` and every quote are
 * gone whatever this returns — and the result only ever becomes an `id` and a
 * URL fragment.
 *
 * @param {string} value
 * @returns {string}
 */
export function withoutTags(value) {
  let previous;
  let current = value;

  do {
    previous = current;
    current = current.replace(/<[^>]*>/g, '');
  } while (current !== previous);

  return current;
}

/**
 * Every heading in the README, with the body that follows it.
 *
 * Split at EVERY heading rather than at `##` only, because `pages.js` claims
 * headings at three different levels — `### cloud edition` is a page and
 * `#### Filling in the \`.env\`` is part of it. Fenced code is skipped: the
 * env templates the README embeds are full of `# ---- sign-in ----` comment
 * banners, and treating one as a heading would slice a page in half through
 * the middle of a YAML file.
 *
 * @param {string} markdown
 * @returns {Array<{ level: number, text: string, body: string, line: number }>}
 */
export function splitHeadings(markdown) {
  const lines = markdown.split('\n');
  /** @type {Array<{ level: number, text: string, body: string, line: number }>} */
  const blocks = [];
  let fenced = false;
  /** @type {string[]} */
  let body = [];

  const flush = () => {
    if (blocks.length) {
      // The trailing `---` is dropped. In the README it separates one section
      // from the next in a single long document; on the site each section IS a
      // page, so all it renders is a rule across the bottom of a page followed
      // by the footer's own rule.
      blocks[blocks.length - 1].body = dropTrailingRule(body.join('\n').trim());
    }
    body = [];
  };

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;

    const heading = fenced ? null : /^(#{1,6}) +(.*?)\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        level: heading[1].length,
        text: heading[2],
        body: '',
        line: i + 1,
      });
      return;
    }
    body.push(line);
  });
  flush();

  return blocks;
}

/**
 * A section's closing `---`, removed.
 *
 * Anchored on the LAST line rather than matched anywhere, because a thematic
 * break in the middle of a section is the author separating two things and has
 * to stay. Only the one at the very end is redundant, and only because the
 * section stopped being a section and became a page.
 *
 * @param {string} body
 * @returns {string}
 */
export function dropTrailingRule(body) {
  const lines = body.split('\n');
  while (lines.length && /^\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n').trimEnd();
}

/**
 * Where each README anchor lives on the site, once the file has been sliced up.
 *
 * A page's first claim resolves to the page itself rather than to a fragment on
 * it: that heading became the `<h1>`, so `#quick-start` should land at the top
 * of the install page and not scroll past its own title.
 *
 * @param {ReturnType<typeof splitHeadings>} blocks
 * @returns {Map<string, string>} anchor (no `#`) -> absolute site path
 */
export function anchorIndex(blocks) {
  /** @type {Map<string, string>} */
  const index = new Map();

  for (const page of PAGES) {
    const url = `${SITE.basePath}wiki/${page.slug}/`;
    page.claims.forEach((text, i) => {
      index.set(githubSlug(text), i === 0 ? url : `${url}#${githubSlug(text)}`);
    });
  }

  // Headings that are on no page still have to resolve, or a link to one dies
  // quietly. There should be none — `site.test.js` fails when a heading is
  // unclaimed — but a build that runs before the test does should say so too.
  for (const block of blocks) {
    if (block.level === 1) continue;
    const slug = githubSlug(block.text);
    if (!index.has(slug) && !(block.text in NOT_ON_THE_WIKI)) {
      throw new Error(
        `README heading "${block.text}" (line ${block.line}) is on no wiki page. ` +
          'Add it to a page\'s `claims` in site/pages.js, or to NOT_ON_THE_WIKI with a reason.',
      );
    }
  }

  return index;
}

/**
 * A repo-relative link as an absolute URL on github.com.
 *
 * Three shapes, and the last one is checked against the disk. A link to a file
 * that has been moved renders perfectly and 404s, which is exactly the failure
 * this whole module exists to make loud.
 *
 * @param {string} href as written in the README
 * @param {string} root repository root, for the existence check
 * @returns {string}
 */
export function repoLink(href, root) {
  // GitHub's own trick for linking out of a file to the repository around it:
  // `../../releases` from a root-level README means the repository's releases.
  if (href.startsWith('../../')) {
    return `${SITE.repo}/${href.slice('../../'.length)}`;
  }

  const [path, fragment] = href.split('#');
  if (!existsSync(join(root, path))) {
    throw new Error(
      `README links to "${href}", which is not in the repository. ` +
        'Fix the link, or the site will ship a 404.',
    );
  }

  const kind = path.endsWith('/') ? 'tree' : 'blob';
  return `${SITE.repo}/${kind}/${SITE.branch}/${path}${fragment ? `#${fragment}` : ''}`;
}

/**
 * Resolve one `href` from the README into one that works on the site.
 *
 * `lenient` is for the changelog, and the difference matters. README links are
 * OURS and CURRENT: an unresolvable one is a mistake, and stopping the build is
 * how it gets fixed. Release notes are neither — they are historical, they are
 * immutable once published, and they may point at a file that existed at that
 * tag and does not exist now. Refusing to deploy the site over a two-year-old
 * release note would be the check doing harm, so unresolvable links there are
 * left exactly as written.
 *
 * @param {string} href
 * @param {object} ctx
 * @param {Map<string, string>} ctx.anchors
 * @param {string} ctx.root
 * @param {boolean} [ctx.lenient]
 * @returns {string}
 */
export function resolveHref(href, { anchors, root, lenient = false }) {
  if (/^(https?:|mailto:|tel:)/.test(href)) return href;

  if (href.startsWith('#')) {
    const target = anchors.get(href.slice(1));
    if (!target) {
      if (lenient) return href;
      throw new Error(
        `README links to "${href}", which matches no heading. ` +
          'A heading was probably renamed — update the link, and its entry in site/pages.js.',
      );
    }
    return target;
  }

  if (lenient) return `${SITE.repo}/blob/${SITE.branch}/${href}`;
  return repoLink(href, root);
}

/**
 * Resolve an image source. Screenshots are copied into the site; nothing else
 * is expected, so anything else is a mistake worth stopping for.
 *
 * @param {string} src
 * @param {string} root
 * @param {boolean} [lenient] see `resolveHref`
 * @returns {string}
 */
export function resolveImage(src, root, lenient = false) {
  if (/^https?:/.test(src)) return src;
  if (src.startsWith('../../')) return `${SITE.repo}/${src.slice('../../'.length)}`;

  if (src.startsWith('docs/screenshots/')) {
    if (!existsSync(join(root, src))) {
      throw new Error(`README shows "${src}", which is not in the repository.`);
    }
    return `${SITE.basePath}${SCREENSHOT_DIR}/${src.slice('docs/screenshots/'.length)}`;
  }

  if (lenient) return `${SITE.repo}/raw/${SITE.branch}/${src}`;

  throw new Error(
    `README shows "${src}", which the site does not know how to publish. ` +
      'Only docs/screenshots/ is copied — put it there, or use an absolute URL.',
  );
}

/**
 * Markdown to HTML, with every link resolved and every heading given its
 * GitHub anchor.
 *
 * `headings` is filled in as a side effect, because the search index and the
 * on-page contents both want the same list and parsing the output HTML back
 * again to get it would be a second, disagreeing implementation.
 *
 * @param {string} markdown
 * @param {object} ctx
 * @param {Map<string, string>} ctx.anchors
 * @param {string} ctx.root
 * @param {Array<{ level: number, text: string, id: string }>} [ctx.headings] collected
 * @param {boolean} [ctx.lenient] see `resolveHref`
 * @param {boolean} [ctx.expand] open `<details>` blocks — see the API page in `pages.js`
 * @returns {string}
 */
export function renderMarkdown(
  markdown,
  { anchors, root, headings, lenient = false, expand = false },
) {
  const renderer = new marked.Renderer();

  renderer.heading = function heading({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    // `withoutTags` on top of `tokenText`, and both are needed. Dropping an
    // `html` token JOINS the text either side of it, which can form a tag that
    // was in neither: `<scr` + `ipt>` is `<script>`. Structure alone does not
    // close this, and neither does the regex alone. There is a test.
    const plain = withoutTags(tokenText(tokens));
    const id = githubSlug(plain);
    headings?.push({ level: depth, text: plain, id });
    // A permalink rather than a bare heading: a wiki page people are told to
    // send each other needs a way to link to a part of it, and the README's
    // own anchors are the ones already in circulation.
    return `<h${depth} id="${id}">${text}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
  };

  renderer.link = function link({ href, title, tokens }) {
    const resolved = resolveHref(href, { anchors, root, lenient });
    const text = this.parser.parseInline(tokens);
    const external = /^https?:/.test(resolved) && !resolved.startsWith(SITE.baseUrl);
    return (
      `<a href="${resolved}"${title ? ` title="${escapeAttr(title)}"` : ''}` +
      `${external ? ' rel="noopener"' : ''}>${text}</a>`
    );
  };

  renderer.image = function image({ href, title, text }) {
    const resolved = resolveImage(href, root, lenient);
    return (
      `<img src="${resolved}" alt="${escapeAttr(text ?? '')}"` +
      `${title ? ` title="${escapeAttr(title)}"` : ''} loading="lazy">`
    );
  };

  // Raw HTML passes through `marked` untouched, and the README's eleven
  // screenshots are raw `<img>` tags inside `<div align="center">` — so without
  // this every screenshot on the wiki points at a path that does not exist here.
  const rewriteHtml = (html) => {
    const withImages = html.replace(/<img\s[^>]*>/gi, (tag) =>
      tag.replace(/src="([^"]*)"/i, (_, src) => `src="${resolveImage(src, root, lenient)}"`),
    );
    return expand ? withImages.replace(/<details>/gi, '<details open>') : withImages;
  };

  renderer.html = ({ text }) => rewriteHtml(text);

  // Wrapped so it can scroll on its own. The API reference is four columns and
  // twenty rows, and the configuration tables are wider; at 360px an unwrapped
  // table either overflows the page — taking the whole layout sideways with it,
  // including the header — or squashes every cell to one word per line. Both
  // read as a broken page rather than as a wide table.
  renderer.table = function table(token) {
    const header = token.header
      .map((cell, i) => `<th${align(token.align[i])}>${this.parser.parseInline(cell.tokens)}</th>`)
      .join('');
    const rows = token.rows
      .map(
        (row) =>
          `<tr>${row
            .map((cell, i) => `<td${align(token.align[i])}>${this.parser.parseInline(cell.tokens)}</td>`)
            .join('')}</tr>`,
      )
      .join('\n');

    return `<div class="table-scroll"><table>\n<thead><tr>${header}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table></div>\n`;
  };

  return /** @type {string} */ (
    marked.parse(markdown, { renderer, gfm: true, breaks: false, async: false })
  );
}

/**
 * One wiki page's markdown, assembled from the README blocks it claims.
 *
 * Two rewrites happen here, and both are about the page reading as a page
 * rather than as an excerpt:
 *
 * - The FIRST claim loses its heading line — `title` from `pages.js` becomes the
 *   `<h1>` instead — but keeps its body, so `## Quick start`'s lead-in prose is
 *   not orphaned when its two halves become separate pages.
 * - Every later heading is shifted so the shallowest lands at `<h2>`, because
 *   `### cloud edition` starting a page at depth three is wrong for a document
 *   whose outline now begins here. `Math.max(2, …)` is what stops
 *   `## Upgrading` + `## Releases` — two claims at the same depth — from
 *   producing two `<h1>`s on one page.
 *
 * @param {import('./pages.js').Page} page
 * @param {ReturnType<typeof splitHeadings>} blocks
 * @returns {string} markdown
 */
export function pageMarkdown(page, blocks) {
  const byText = new Map(blocks.map((b) => [b.text, b]));
  const claimed = page.claims.map((text) => {
    const block = byText.get(text);
    if (!block) {
      throw new Error(
        `site/pages.js: page "${page.slug}" claims the README heading "${text}", ` +
          'which is not in README.md. It was probably renamed.',
      );
    }
    return block;
  });

  const first = claimed[0];
  const parts = [first.body];

  for (const block of claimed.slice(1)) {
    const depth = Math.max(2, block.level - first.level + 1);
    parts.push(`${'#'.repeat(depth)} ${block.text}\n\n${block.body}`);
  }

  return parts.filter(Boolean).join('\n\n');
}

/**
 * Every screenshot the README shows, keyed by filename, with its alt text.
 *
 * The landing page and the gallery both caption screenshots, and NEITHER writes
 * that text: it is lifted from the README, where `shared/test/readme-assets.js`
 * already requires every image to carry alt text over 40 characters describing
 * what is actually in the picture. Writing a second set here would mean two
 * descriptions of one image, one of which is wrong after the next screenshot
 * retake — and the wrong one would be the one only a screen reader ever hears.
 *
 * @param {string} readme
 * @returns {Map<string, { alt: string, width: string }>}
 */
export function screenshotAlts(readme) {
  /** @type {Map<string, { alt: string, width: string }>} */
  const found = new Map();

  for (const match of readme.matchAll(/<img\s+([^>]*?)>/gs)) {
    const attrs = match[1];
    const src = /src="([^"]+)"/.exec(attrs)?.[1] ?? '';
    if (!src.startsWith('docs/screenshots/')) continue;
    found.set(src.slice('docs/screenshots/'.length), {
      alt: (/alt="([^"]*)"/s.exec(attrs)?.[1] ?? '').replace(/\s+/g, ' ').trim(),
      width: /width="([^"]+)"/.exec(attrs)?.[1] ?? '',
    });
  }

  return found;
}

/** The id the page's `<h1>` carries: the anchor its first claim had in the README. */
export function pageAnchorId(page) {
  return githubSlug(page.claims[0]);
}

/** @param {string | null} value a column's alignment from a GFM table */
function align(value) {
  return value ? ` align="${value}"` : '';
}

/**
 * A heading's text, taken from `marked`'s TOKENS rather than from its HTML.
 *
 * This replaced `html.replace(/<[^>]*>/g, '')`, which CodeQL flagged as
 * `js/incomplete-multi-character-sanitization` and was right to: removing every
 * `<…>` in one pass can CREATE one, because `<scr<script>ipt>` loses its inner
 * match and closes up into `<script>`. Nothing here was exploitable — the slug
 * that regex fed runs through an allowlist that deletes `<`, `>` and `/`, and
 * every render site escapes — but a function named for stripping tags that does
 * not reliably strip tags is a trap for whoever reuses it, and CodeQL cannot
 * tell the difference between this one and the next one.
 *
 * Walking the tokens answers most of it structurally: an `html` token is
 * DROPPED, which is the decision the regex was reaching for, and every other
 * token contributes its own text. `<b>Full</b> reference` gives
 * `Full reference`.
 *
 * **It is not sufficient on its own, and the first version of this claimed it
 * was.** Dropping a token JOINS the text either side of it, and those two
 * pieces can form a tag that was in neither — `<scr` and `ipt>` around a
 * dropped `<script>` concatenate straight back into `<script>`. That is the
 * same reintroduction the regex had, arrived at from the other direction. So
 * the caller composes this with `withoutTags`, and the test feeds it exactly
 * that input.
 *
 * @param {any[]} tokens marked's inline tokens
 * @returns {string}
 */
export function tokenText(tokens) {
  let out = '';

  for (const token of tokens ?? []) {
    if (token.type === 'html') continue;
    if (token.type === 'br') out += ' ';
    else if (Array.isArray(token.tokens) && token.tokens.length) out += tokenText(token.tokens);
    else out += token.text ?? '';
  }

  return out;
}

/** @param {string} value */
export function escapeAttr(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** @param {string} value */
export function escapeHtml(value) {
  return escapeAttr(value).replace(/'/g, '&#39;');
}
