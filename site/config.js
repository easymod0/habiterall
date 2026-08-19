/**
 * Everything about the site that is a decision rather than content.
 *
 * Kept apart from `pages.js` because these are the values a human changes on
 * purpose — the domain, whether the hosted edition takes signups — while the
 * page map changes only when README.md grows a section.
 */

/**
 * Where the site is served from, and what it links out to.
 *
 * `baseUrl` is the origin only, with no trailing slash, and `basePath` is the
 * prefix every internal link carries. At a domain root that prefix is `/`, so
 * nothing needs prefixing — but it is threaded through `url()` in
 * `templates/layout.mjs` anyway, because moving to
 * `easymod0.github.io/habiterall` would otherwise break every link on the site
 * at once and only in production, which is the classic way to lose an afternoon
 * to GitHub Pages.
 *
 * **`www`, not the apex.** That is the domain GitHub Pages is configured with,
 * and the two are not interchangeable to it: whichever one the `CNAME` file
 * names is the canonical host, and the other is at best a redirect. Serving
 * pages that link to the apex while Pages is set up for `www` means every
 * internal link takes a redirect, and the canonical URLs point somewhere the
 * site is not. The `CNAME` file is GENERATED from this value for that reason —
 * see `build.mjs` — so the two cannot disagree.
 */
export const SITE = {
  name: 'habiterall',
  tagline: 'A self-hosted habit tracker with real statistics.',
  baseUrl: 'https://www.habiterall.ca',
  basePath: '/',

  /** The hosted cloud edition — where a user of the hosted service signs in. */
  app: 'https://app.habiterall.ca',

  repo: 'https://github.com/easymod0/habiterall',
  owner: 'easymod0',
  name_repo: 'habiterall',

  /** The branch repo-relative links resolve against. */
  branch: 'master',

  /**
   * Whether `app.habiterall.ca` is open to public registration.
   *
   * FALSE today: the hosted edition runs, accounts exist, but nobody can create
   * one. So the hero's primary button reads "Sign in" and carries a note saying
   * signups are coming, rather than a "Get started free" that leads to a wall.
   *
   * Flip this to `true` when registration opens and the copy changes with it —
   * the button becomes "Create a free account" and the note disappears. One
   * line, and `shared/test/site.test.js` asserts BOTH states against the
   * rendered HTML, so this cannot be a constant nothing reads.
   */
  hostedSignups: false,
};

/**
 * The image a link preview shows — Slack, Discord, iMessage, every social card.
 *
 * A real screenshot rather than a logo on a field of colour: the thing being
 * previewed is an app, and the dashboard is what it looks like. Its alt text
 * comes from the README, like every other screenshot on this site.
 */
export const OG_IMAGE = 'docs/screenshots/dashboard.png';

/**
 * Assets copied out of the app into the site, as `[from, to]` inside `dist/`.
 *
 * The logo is the app's own mark, not a copy of it — a second SVG would drift
 * from the one the PWA installs with, and the two appear side by side the
 * moment somebody adds the site to a home screen.
 */
export const COPIED_ASSETS = [
  ['shared/public/icons/logo.svg', 'logo.svg'],
  ['shared/public/icons/icon-192.png', 'icon-192.png'],
  ['shared/public/icons/icon-512.png', 'icon-512.png'],
];
