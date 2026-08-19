/**
 * The shell every page is poured into: head, header, footer.
 *
 * Kept in one place because the parts that are easy to get wrong are the parts
 * nobody looks at — the canonical URL, the Open Graph tags a link preview
 * reads, and the theme script. A page-by-page copy of this drifts into one page
 * with the wrong `og:image` and nobody notices until it is pasted into a chat.
 */
import { SITE, OG_IMAGE } from '../config.js';
import { escapeAttr, escapeHtml, SCREENSHOT_DIR } from '../render.mjs';

/** An absolute path on the site, from a path with no leading slash. */
export const url = (path = '') => `${SITE.basePath}${path}`;

/** The same, absolute including the origin — for canonical and OG tags. */
export const absolute = (path = '') => `${SITE.baseUrl}${url(path)}`;

/**
 * The top-level nav. Deliberately five items: past that a header becomes a menu,
 * and a menu is a thing people have to open before they can decide.
 */
const NAV = [
  { href: 'wiki/features/', label: 'Features' },
  { href: 'wiki/', label: 'Wiki' },
  { href: 'screenshots/', label: 'Screenshots' },
  { href: 'downloads/', label: 'Downloads' },
  { href: 'changelog/', label: 'Changelog' },
];

/**
 * What the hosted edition's button says.
 *
 * Two states, because `app.habiterall.ca` runs and takes sign-ins but is not yet
 * open to registration. Offering "Create a free account" today would send every
 * first-time visitor to a wall — so the flag in `config.js` decides, and
 * `shared/test/site.test.js` asserts BOTH renderings rather than the flag,
 * because a constant that no template reads still passes a test that reads the
 * constant.
 *
 * @returns {{ label: string, note: string }}
 */
export function hostedCta() {
  return SITE.hostedSignups
    ? { label: 'Create a free account', note: '' }
    : { label: 'Sign in', note: 'Public signups are opening soon.' };
}

/**
 * @param {object} page
 * @param {string} page.title      the <title>, without the site name
 * @param {string} page.description one sentence, for search results and previews
 * @param {string} page.path       this page's path, no leading slash, trailing slash
 * @param {string} page.body       the page's HTML
 * @param {string} [page.bodyClass]
 * @param {string} [page.head]     extra tags
 * @returns {string}
 */
export function layout({ title, description, path, body, bodyClass = '', head = '' }) {
  const full = path === '' ? `${SITE.name} — ${SITE.tagline}` : `${title} · ${SITE.name}`;

  return `<!doctype html>
<html lang="en" data-base="${escapeAttr(SITE.basePath)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(full)}</title>
<meta name="description" content="${escapeAttr(description)}">
<link rel="canonical" href="${absolute(path)}">
<link rel="icon" href="${url('logo.svg')}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${url('icon-192.png')}">
<meta name="theme-color" content="#3b82f6">

<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeAttr(SITE.name)}">
<meta property="og:title" content="${escapeAttr(full)}">
<meta property="og:description" content="${escapeAttr(description)}">
<meta property="og:url" content="${absolute(path)}">
<meta property="og:image" content="${absolute(`${SCREENSHOT_DIR}/${OG_IMAGE.split('/').pop()}`)}">
<meta name="twitter:card" content="summary_large_image">

<link rel="stylesheet" href="${url('site.css')}">
${head}
<script>
/*
 * Inline and BEFORE the stylesheet's first paint, which is the whole reason it
 * is not in site.js: a theme applied after first paint is a white flash on a
 * dark-themed page, on every navigation. Same trick, same reason, as the app's
 * own boot. Wrapped in try/catch because a locked-down browser THROWS on
 * localStorage rather than returning null, and an error thrown here stops the
 * page before anything else runs.
 *
 * Careful editing this: it is inside a template literal, so a backtick anywhere
 * in it -- a comment included -- ends the string and the module stops parsing.
 */
try {
  var t = localStorage.getItem('habiterall-site-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
</script>
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">Skip to content</a>

<header class="topbar">
  <div class="wrap topbar-inner">
    <a class="brand" href="${url()}">
      <img src="${url('logo.svg')}" alt="" width="28" height="28">
      <span>${escapeHtml(SITE.name)}</span>
    </a>

    <nav class="nav" aria-label="Main">
      ${NAV.map((item) => `<a href="${url(item.href)}">${escapeHtml(item.label)}</a>`).join('\n      ')}
    </nav>

    <div class="topbar-actions">
      <button class="theme-toggle" type="button" aria-label="Change theme" title="Change theme"></button>
      <a class="ghost" href="${SITE.repo}" rel="noopener">GitHub</a>
      <a class="button small" href="${SITE.app}" rel="noopener">${escapeHtml(hostedCta().label)}</a>
    </div>
  </div>
</header>

<main id="main">
${body}
</main>

<footer class="footer">
  <div class="wrap footer-inner">
    <div>
      <a class="brand" href="${url()}">
        <img src="${url('logo.svg')}" alt="" width="24" height="24">
        <span>${escapeHtml(SITE.name)}</span>
      </a>
      <p class="dim">${escapeHtml(SITE.tagline)}</p>
    </div>

    <nav aria-label="Footer">
      <h2>Docs</h2>
      <a href="${url('wiki/install/personal/')}">Install</a>
      <a href="${url('wiki/configuration/')}">Configuration</a>
      <a href="${url('wiki/api/')}">API</a>
      <a href="${url('wiki/security/')}">Security</a>
    </nav>

    <nav aria-label="Project">
      <h2>Project</h2>
      <a href="${SITE.repo}" rel="noopener">Source</a>
      <a href="${SITE.repo}/releases" rel="noopener">Releases</a>
      <a href="${SITE.repo}/issues" rel="noopener">Issues</a>
      <a href="${SITE.repo}/blob/${SITE.branch}/LICENSE" rel="noopener">GPLv3</a>
    </nav>

    <nav aria-label="App">
      <h2>App</h2>
      <a href="${SITE.app}" rel="noopener">${escapeHtml(hostedCta().label)}</a>
      <a href="${url('downloads/')}">Android APK</a>
      <a href="${url('wiki/phone/')}">Add to Home Screen</a>
    </nav>
  </div>

  <div class="wrap footer-legal dim">
    <p>
      Free software under the
      <a href="${SITE.repo}/blob/${SITE.branch}/LICENSE" rel="noopener">GNU GPL v3</a>.
      Statistics modelled on
      <a href="https://github.com/iSoron/uhabits" rel="noopener">Loop Habit Tracker</a>.
      Every screenshot is the real app.
    </p>
  </div>
</footer>

<script src="${url('site.js')}" defer></script>
</body>
</html>
`;
}
