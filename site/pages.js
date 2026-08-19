/**
 * Which README section becomes which wiki page.
 *
 * The wiki is GENERATED from `README.md`. Nothing here is prose — the manual is
 * written once, in the file people already read on GitHub, and this decides how
 * it is sliced for the web. That is the same argument as `PRINTED` in
 * `scripts/sync-compose-docs.mjs`: the configuration reference existing twice is
 * how it comes to be wrong in one of them.
 *
 * **The map is EXPLICIT, and a test fails on a heading it does not name.**
 * Slicing mechanically at `##` was tried first and produces one 1055-line page,
 * because `## Quick start` is half the README — it embeds the whole generated
 * compose and env listings. The obvious repair, "split at `###` when a section
 * is over N lines", is worse than it looks: it is an implicit rule, so adding a
 * paragraph silently re-splits a page and changes the URL of everything under
 * it. Naming the headings costs one line when a section is added and is caught
 * by `shared/test/site.test.js` when it is forgotten.
 *
 * @typedef {object} Page
 * @property {string} slug     path under /wiki/, may contain a `/`
 * @property {string} title    the page's <h1>, and its label in the nav
 * @property {string} blurb    one line, for the wiki index and <meta description>
 * @property {string[]} claims README heading TEXT, exactly as written, in order
 * @property {boolean} [expand] open this page's <details> blocks — see the API page
 */

/**
 * @type {Page[]}
 *
 * Order is the nav's order, and it is the order someone reads it in: what this
 * is, then how to run it, then how to live with it, then the reference.
 *
 * A page's FIRST claim is special — its body becomes the page's opening prose
 * and its heading is replaced by `title`, so `## Quick start`'s six lines of
 * lead-in survive rather than being orphaned. Its ANCHOR survives too, on the
 * <h1>, which is what keeps `README.md`'s own `(#quick-start)` links working
 * once they point at the site.
 */
export const PAGES = [
  {
    slug: 'editions',
    title: 'Which edition do I want?',
    blurb: 'personal is one person and one SQLite file. cloud is many people, each isolated.',
    claims: ['Which edition do I want?'],
  },
  {
    slug: 'features',
    title: 'Features',
    blurb: 'Habit types, frequencies, skips, the statistics, and the awards.',
    claims: ['Features', 'Statistics', 'Bouncing back', 'Awards'],
  },
  {
    slug: 'install/personal',
    title: 'Install — personal edition',
    blurb: 'One file, one command: single user, SQLite, optional password.',
    claims: ['Quick start', 'personal edition'],
  },
  {
    slug: 'install/cloud',
    title: 'Install — cloud edition',
    blurb: 'Docker Compose and an identity provider: many users, Postgres, OIDC.',
    claims: ['cloud edition', 'Filling in the `.env`'],
  },
  {
    slug: 'install/https',
    title: 'HTTPS and the guards',
    blurb: 'Why TLS is load-bearing here, and which protections can be turned off.',
    claims: ['Put HTTPS in front', 'Turning the guards off'],
  },
  {
    slug: 'reminders',
    title: 'Reminders and notifications',
    blurb: 'Android, Discord with buttons, ntfy — and what the reminder asks.',
    claims: [
      'Reminders and notifications',
      'What the reminder asks',
      'Discord with buttons (recommended)',
      'Discord without a bot',
      'ntfy',
    ],
  },
  {
    slug: 'phone',
    title: 'Install on a phone',
    blurb: 'Add to Home Screen, or the native Android app.',
    claims: ['Install on a phone', 'Add to Home Screen', 'The Android app'],
  },
  {
    slug: 'loop-import',
    title: 'Coming from Loop Habit Tracker',
    blurb: 'Bring your history across — and take it back out again.',
    claims: ['Coming from Loop Habit Tracker'],
  },
  {
    slug: 'backup',
    title: 'Backup and restore',
    blurb: 'Every export format, and what merge and replace each do.',
    claims: ['Backup and restore'],
  },
  {
    slug: 'upgrading',
    title: 'Upgrading and releases',
    blurb: 'How to move to a new version, and what a release carries.',
    claims: ['Upgrading', 'Releases'],
  },
  {
    slug: 'configuration',
    title: 'Configuration',
    blurb: 'Every environment variable, both editions, plus the in-app settings.',
    claims: [
      'Configuration',
      'personal',
      'cloud',
      'Limits on an import',
      'Published images',
      'Both editions: the reminder scheduler',
      'Logs',
      'In-app settings',
    ],
  },
  {
    slug: 'api',
    title: 'API',
    blurb: '20 endpoints, identical in both editions.',
    claims: ['API'],
    // The README puts this entire section inside a collapsed <details>, which is
    // right THERE — it is one section of fifteen and the table is twenty rows.
    // Here it is the whole page, and a page titled "API" whose body is a closed
    // box reading "Full reference" has nothing on it.
    //
    // Per-page rather than global, because the other eight <details> in the
    // README are genuine asides: three of them are entire env templates, and
    // opening those would put 200 lines of INI in front of somebody trying to
    // read the install steps wrapped around it.
    expand: true,
  },
  {
    slug: 'security',
    title: 'Security',
    blurb: 'Sessions, the origin check, row-level security, and what is verified adversarially.',
    claims: ['Security'],
  },
  {
    slug: 'development',
    title: 'Architecture and development',
    blurb: 'How the two editions share one core, and how to run the test suites.',
    claims: ['Architecture', 'Development'],
  },
];

/**
 * How the sidebar groups those pages.
 *
 * A separate list rather than a `group` field on each page, because it is a
 * separate decision: the order above is the order someone READS the manual
 * front to back, and the order here is what a sidebar has to look like to be
 * scannable. Keeping them apart means changing one does not silently reorder
 * the other.
 *
 * `shared/test/site.test.js` fails if a page is in no group or in two, so a
 * page added above cannot quietly vanish from the nav — which is the failure
 * mode of every hand-maintained sidebar there has ever been.
 *
 * @type {Array<{ name: string, slugs: string[] }>}
 */
export const GROUPS = [
  { name: 'Start here', slugs: ['editions', 'features'] },
  { name: 'Install', slugs: ['install/personal', 'install/cloud', 'install/https'] },
  {
    name: 'Living with it',
    slugs: ['reminders', 'phone', 'loop-import', 'backup', 'upgrading'],
  },
  { name: 'Reference', slugs: ['configuration', 'api', 'security', 'development'] },
];

/**
 * README headings that are deliberately NOT on the wiki, each with its reason.
 *
 * A map rather than a set, for the same reason `notMirrored` is one in
 * `shared/public/ui/settings.js`: an unexplained exclusion list is indistinguish-
 * able from an oversight, and the next person to read it deletes an entry to
 * see what breaks.
 *
 * @type {Record<string, string>}
 */
export const NOT_ON_THE_WIKI = {
  habiterall:
    "the README's own title — the site has a landing page instead",
  Contents:
    'becomes the wiki nav, which is generated from PAGES above',
  License:
    'a footer link on every page; a whole page for two sentences reads as filler',
};
