/**
 * Every release, newest first, exactly as `release.yml` published it.
 *
 * The notes are not reformatted or summarised here. They are already grouped —
 * Fixes, Features, Web app, Android, Server, Tests and CI, Docs, and an `Other`
 * bucket that exists so a commit whose subject matched no prefix is still
 * listed. A changelog that silently drops commits is worse than an untidy one,
 * and that decision was already taken in the release workflow; re-taking it here
 * would mean two answers to one question.
 */
import { SITE } from '../config.js';
import { escapeAttr, escapeHtml } from '../render.mjs';
import { url } from './layout.mjs';

/**
 * A published date, as a date and nothing else.
 *
 * `en-CA` and an explicit UTC zone, so the string is the same wherever the build
 * runs. A build machine in another zone would otherwise move dates by a day, and
 * a changelog whose dates change between two builds of the same commit is a
 * diff nobody can review.
 *
 * @param {string} iso
 * @returns {string}
 */
export function releaseDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * @param {object} ctx
 * @param {Array<{ tag: string, name: string, publishedAt: string, url: string,
 *                 prerelease: boolean, notes: string }>} ctx.releases  notes pre-rendered
 * @returns {string}
 */
export function changelog({ releases }) {
  const entries = releases.map((release) => `<article class="release" id="${escapeAttr(release.tag)}">
      <header class="release-head">
        <h2>
          <a href="#${escapeAttr(release.tag)}">${escapeHtml(release.tag)}</a>
          ${release.prerelease ? '<span class="tag">pre-release</span>' : ''}
        </h2>
        <p class="dim">
          <time datetime="${escapeAttr(release.publishedAt)}">${escapeHtml(releaseDate(release.publishedAt))}</time>
          · <a href="${escapeAttr(release.url)}" rel="noopener">on GitHub</a>
        </p>
      </header>
      <div class="prose release-notes">
        ${release.notes || '<p class="dim">No notes were published with this release.</p>'}
      </div>
    </article>`).join('\n    ');

  return `
<div class="wrap changelog">
  <header class="page-head">
    <h1>Changelog</h1>
    <p class="lead">
      Every release of habiterall, newest first — generated from the project's
      GitHub releases, so this page cannot fall behind the tags.
    </p>
    <p class="dim">
      ${releases.length} releases · <a href="${SITE.repo}/releases" rel="noopener">on GitHub</a>
      · <a href="${url('downloads/')}">Downloads</a>
    </p>
  </header>

  <div class="releases">
    ${entries}
  </div>
</div>
`;
}
