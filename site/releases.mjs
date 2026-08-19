/**
 * The changelog and the downloads page, from the GitHub Releases API.
 *
 * Neither page is written by hand, and neither is committed. `release.yml`
 * already produces grouped notes — Fixes, Features, Web app, Android, Server,
 * Tests and CI, Docs, Other — by walking `git log` between two tags, and it
 * already attaches the APK and names the image tags. Copying any of that into
 * the repository would create a second changelog that is right until the next
 * release and wrong from then on.
 *
 * So the site reads what the release process actually published. The downloads
 * page in particular takes the APK's real filename, its real size and its real
 * URL from the latest release, which is the only version of those three that
 * cannot be stale.
 */
import { SITE } from './config.js';

const API = 'https://api.github.com';

/**
 * @typedef {object} Release
 * @property {string} tag
 * @property {string} name
 * @property {string} publishedAt   ISO 8601
 * @property {string} body          markdown, as `release.yml` wrote it
 * @property {string} url           the release page on github.com
 * @property {boolean} prerelease
 * @property {Array<{ name: string, size: number, url: string }>} assets
 */

/**
 * Every published release, newest first.
 *
 * Authenticated when `GITHUB_TOKEN` is in the environment, which it is in
 * Actions, and anonymous otherwise — the endpoint is public, and 60 requests an
 * hour is ample for a build that makes one. Drafts are dropped; a draft is by
 * definition not announced yet, and the changelog is an announcement.
 *
 * @param {object} [options]
 * @param {boolean} [options.offline] skip the network and return null
 * @returns {Promise<Release[] | null>}
 */
export async function fetchReleases({ offline = false } = {}) {
  if (offline) return null;

  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': `${SITE.name}-site-build`,
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  /** @type {Release[]} */
  const all = [];
  let url = `${API}/repos/${SITE.owner}/${SITE.name_repo}/releases?per_page=100`;

  // Paginated through the Link header rather than by counting: there are 25
  // releases today and per_page=100 would cover them in one call, which is
  // exactly the kind of thing that is true until it silently is not.
  while (url) {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(
        `GitHub API ${response.status} ${response.statusText} for ${url}. ` +
          (response.status === 403
            ? 'Rate limited — set GITHUB_TOKEN, or build with --offline.'
            : 'Build with --offline to skip the changelog and downloads pages.'),
      );
    }

    const payload = /** @type {any[]} */ (await response.json());
    for (const release of payload) {
      if (release.draft) continue;
      all.push({
        tag: release.tag_name,
        name: release.name || release.tag_name,
        publishedAt: release.published_at,
        body: release.body || '',
        url: release.html_url,
        prerelease: Boolean(release.prerelease),
        assets: (release.assets || []).map((a) => ({
          name: a.name,
          size: a.size,
          url: a.browser_download_url,
        })),
      });
    }

    url = nextPage(response.headers.get('link'));
  }

  if (!all.length) {
    throw new Error(
      `${SITE.owner}/${SITE.name_repo} has no published releases, so there is ` +
        'nothing to build a changelog from. Build with --offline if that is expected.',
    );
  }

  return all;
}

/**
 * The `rel="next"` URL out of a Link header, or `''` when there is no next page.
 *
 * @param {string | null} header
 * @returns {string}
 */
export function nextPage(header) {
  if (!header) return '';
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return '';
}

/**
 * Release notes, with the things `release.yml` writes as plain text turned into
 * links: the `(\`292027d\`)` commit hash every bullet ends with, and the
 * `(#232)` pull-request number in the commit subject itself.
 *
 * Done on the MARKDOWN rather than on the rendered HTML, so the result goes
 * through the same renderer, the same escaping and the same link handling as
 * everything else — rewriting anchors into finished HTML is how a changelog
 * ends up with a `<a>` inside a `<code>` inside another `<a>`.
 *
 * The hash pattern requires 7 to 40 hex characters between backticks inside
 * parentheses, which is the exact shape of that column and not, for instance,
 * an inline `` `off` `` or `` `latest` `` elsewhere in a note.
 *
 * @param {string} body
 * @returns {string} markdown
 */
export function linkifyNotes(body) {
  return body
    .replace(
      /\(`([0-9a-f]{7,40})`\)/g,
      (_, sha) => `([\`${sha}\`](${SITE.repo}/commit/${sha}))`,
    )
    .replace(
      /\(#(\d+)\)/g,
      (_, number) => `([#${number}](${SITE.repo}/pull/${number}))`,
    );
}

/**
 * The heading `release.yml` appends its install instructions under.
 *
 * Named here as a literal because it is a contract with another file: the
 * release job writes `### Install` after the changelog proper, and this is what
 * recognises it. If that wording changes, this stops matching and the install
 * block reappears on the changelog — visible, harmless, and fixed by changing
 * one string. That is the right failure for a cosmetic trim; throwing would
 * make an old release note able to stop a deploy.
 */
export const INSTALL_HEADING = '### Install';

/**
 * A release's notes with the install instructions removed.
 *
 * Every release carries the same three paragraphs — the two `docker pull`
 * lines, the tag list, and the sideloading warning about "App not installed".
 * On a release page that is exactly right; it is what somebody arriving at
 * v1.1.4 needs. On a changelog it is the same block twenty-five times,
 * outweighing the one line per release that actually says what changed.
 *
 * It is not lost: the current version of all of it is on the downloads page,
 * generated from the same API, and each entry links to its own release.
 *
 * @param {string} body
 * @returns {string}
 */
export function withoutInstall(body) {
  const at = body.indexOf(INSTALL_HEADING);
  return at < 0 ? body : body.slice(0, at).trimEnd();
}

/**
 * @typedef {object} Download
 * @property {string} version   the tag with its leading `v` removed
 * @property {string} tag
 * @property {string} publishedAt
 * @property {string} url
 * @property {Array<{ name: string, size: number, url: string }>} apks
 * @property {Array<{ label: string, ref: string }>} images
 */

/**
 * What the downloads page shows, pulled out of the newest non-prerelease.
 *
 * A prerelease is skipped deliberately: `release.yml` can cut one, and the
 * downloads page is where somebody arrives to install the thing for the first
 * time. Pointing them at a release candidate is not what "Download" means.
 *
 * @param {Release[] | null} releases
 * @returns {Download | null}
 */
export function latestDownload(releases) {
  if (!releases?.length) return null;

  const latest = releases.find((r) => !r.prerelease) ?? releases[0];
  const version = latest.tag.replace(/^v/, '');

  return {
    version,
    tag: latest.tag,
    publishedAt: latest.publishedAt,
    url: latest.url,
    apks: latest.assets.filter((a) => a.name.endsWith('.apk')),
    // Must agree with release.yml's Tags step, which drops the moving X.Y tag
    // below 1.0.0 — a `0.4` tag would promise a compatibility the version
    // scheme does not carry.
    images: [
      { label: 'personal', ref: `ghcr.io/${SITE.owner}/habiterall-personal:${version}` },
      { label: 'cloud', ref: `ghcr.io/${SITE.owner}/habiterall-cloud:${version}` },
    ],
  };
}
