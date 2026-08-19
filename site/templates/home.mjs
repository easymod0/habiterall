/**
 * The landing page — the one hand-written surface on this site.
 *
 * Everything else is generated from `README.md` or from the Releases API,
 * because a second copy of the configuration reference goes wrong. This page
 * cannot be generated: a manual's opening paragraph and a landing page's are
 * different jobs. What it must NOT do is state a fact that can go stale —
 * a version number, a port, an environment variable, a limit. Those live in the
 * wiki, which is generated, and this page links to them.
 *
 * The screenshots and their captions are not hand-written either: the alt text
 * comes out of the README, where a test already guards it.
 */
import { SITE } from '../config.js';
import { escapeAttr, escapeHtml, SCREENSHOT_DIR } from '../render.mjs';
import { url, hostedCta } from './layout.mjs';

/**
 * Six things the app does, each a claim the README already makes.
 *
 * Six rather than twelve: a feature grid is read by scanning, and past two rows
 * people stop. The rest is one click away on a page that lists all of them.
 */
const FEATURES = [
  {
    icon: '◐',
    title: 'Two kinds of habit',
    body: 'Yes/no checkmarks, and measurable habits with a target — <em>at least</em> 8 glasses, or <em>at most</em> 0 cigarettes. Any frequency: <em>n</em> times per <em>m</em> days.',
  },
  {
    icon: '↗',
    title: 'Statistics that mean something',
    body: 'Strength that decays when you stop and climbs when you keep going, streaks, and a calendar you can page back through. The same model as Loop Habit Tracker.',
  },
  {
    icon: '⊘',
    title: 'Skips, not failures',
    body: 'A skipped day is neither success nor failure. It bridges a streak instead of breaking it and holds your score steady — for illness, or travel.',
  },
  {
    icon: '◉',
    title: 'Reminders where you are',
    body: 'A time on a habit, a question it asks, and a destination: the Android app, a Discord channel with answer buttons, an ntfy topic, or all three.',
  },
  {
    icon: '⇅',
    title: 'Works offline',
    body: 'Check habits off with no signal and they queue on the device, syncing when you reconnect. Installs to a phone home screen as a real app.',
  },
  {
    icon: '⤢',
    title: 'Your data, in and out',
    body: 'Imports directly from Loop Habit Tracker, and exports back to it — plus JSON and CSV. Nothing here is a one-way door.',
  },
];

/**
 * @param {object} ctx
 * @param {Map<string, { alt: string, width: string }>} ctx.shots  from the README
 * @param {{ version: string } | null} ctx.download  latest release, or null offline
 * @returns {string}
 */
export function home({ shots, download }) {
  const cta = hostedCta();

  /** The README's own description of a screenshot, or a refusal naming it. */
  const describe = (file) => {
    const meta = shots.get(file);
    if (!meta) {
      throw new Error(
        `The landing page shows "${file}", which the README does not. ` +
          'Add it to README.md (with alt text) or show a different one — the ' +
          'captions here are the README\'s, so an image it does not carry has none.',
      );
    }
    return meta.alt;
  };

  /** A screenshot with the README's own description of it. */
  const shot = (file, className = '') =>
    `<img class="${className}" src="${url(`${SCREENSHOT_DIR}/${file}`)}" alt="${escapeAttr(describe(file))}" loading="lazy">`;

  /**
   * The same, with a phone-shaped capture swapped in on a phone.
   *
   * The desktop dashboard is captured at 1280px and scales down to a smudge in
   * a 390px column — the very screenshot meant to show what the app looks like,
   * illegible on the device most visitors arrive on. `docs/screenshots/` already
   * holds the 390px capture, so this costs nothing but the `<source>`.
   *
   * The alt text stays on the `<img>`, once: `<source>` takes none, and the
   * two captures are the same screen.
   */
  const responsiveShot = (wide, narrow) => `<picture>
        <source media="(max-width: 620px)" srcset="${url(`${SCREENSHOT_DIR}/${narrow}`)}">
        <img src="${url(`${SCREENSHOT_DIR}/${wide}`)}" alt="${escapeAttr(describe(wide))}" loading="eager">
      </picture>`;

  return `
<section class="hero">
  <div class="wrap hero-inner">
    <div class="hero-copy">
      <p class="eyebrow">Self-hosted habit tracking</p>
      <h1>Build the habit.<br>Keep the data.</h1>
      <p class="lead">
        habiterall tracks daily habits and shows you the statistics behind them —
        strength, streaks, and fourteen months of history at a glance. It runs on
        your hardware, or ours, and it never stops being yours.
      </p>

      <div class="cta-row">
        <a class="button" href="${SITE.app}" rel="noopener">${escapeHtml(cta.label)}</a>
        <a class="button secondary" href="${url('wiki/install/personal/')}">Or run it yourself</a>
      </div>
      ${cta.note ? `<p class="cta-note">${escapeHtml(cta.note)} <a href="${url('wiki/install/personal/')}">Self-hosting works today.</a></p>` : ''}

      <ul class="badges">
        <li>Free software, GPLv3</li>
        <li>Docker, amd64 &amp; arm64</li>
        <li>Android app</li>
        <li>Imports from Loop</li>
      </ul>
    </div>

    <div class="hero-shot">
      ${responsiveShot('dashboard.png', 'dashboard-mobile.png')}
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2 class="section-title">Everything you would expect, and the parts most trackers skip</h2>
    <div class="grid features">
      ${FEATURES.map(
        (f) => `<article class="card">
        <span class="card-icon" aria-hidden="true">${f.icon}</span>
        <h3>${escapeHtml(f.title)}</h3>
        <p>${f.body}</p>
      </article>`,
      ).join('\n      ')}
    </div>
    <p class="section-more"><a href="${url('wiki/features/')}">The full feature list →</a></p>
  </div>
</section>

<section class="section alt">
  <div class="wrap split">
    <div class="split-copy">
      <h2>A day has four states, and the fourth one matters</h2>
      <p>
        Done, skipped, a stated <em>no</em>, and nothing recorded at all. Most
        trackers collapse the last two, which is how a limit nobody logged
        reports an unbroken streak. habiterall keeps them apart everywhere — in
        the score, in the streaks, and in what the calendar paints.
      </p>
      <p>
        The statistics are Loop Habit Tracker's model: strength that decays when
        you stop, a history broken down by day, week, month, quarter or year, and
        a best-streak table you can actually read.
      </p>
      <p class="section-more"><a href="${url('wiki/features/')}#statistics">How the statistics work →</a></p>
    </div>
    <div class="split-shot">${shot('statistics.png')}</div>
  </div>
</section>

<section class="section">
  <div class="wrap split reverse">
    <div class="split-copy">
      <h2>Reminders you can answer without opening anything</h2>
      <p>
        Set a time on a habit and choose what it asks. It arrives in the Android
        app's shade, in a Discord channel with <strong>Yes / No / Skip</strong>
        buttons, or on an ntfy topic — and the answer is recorded from the
        notification itself.
      </p>
      <p>
        Reminders go out at the right hour for wherever the account is, whether
        or not anyone has the app open.
      </p>
      <p class="section-more"><a href="${url('wiki/reminders/')}">Set up reminders →</a></p>
    </div>
    <div class="split-shot">${shot('notifications.png')}</div>
  </div>
</section>

<section class="section alt">
  <div class="wrap">
    <h2 class="section-title">Two editions, one core</h2>
    <div class="grid editions">
      <article class="card edition">
        <h3>personal</h3>
        <p class="dim">One person. One SQLite file. One command.</p>
        <pre><code>curl -o docker-compose.yml \\
  ${escapeHtml(`${SITE.repo.replace('github.com', 'raw.githubusercontent.com')}/${SITE.branch}/examples/docker-compose.personal.yml`)}
docker compose up -d</code></pre>
        <p>Signs you in, so it is fine on a public address. What it does not do is
        keep two people's habits apart.</p>
        <a class="button secondary" href="${url('wiki/install/personal/')}">Install personal</a>
      </article>

      <article class="card edition">
        <h3>cloud</h3>
        <p class="dim">Many people, each isolated. Postgres and OIDC.</p>
        <p>
          Isolation enforced by Postgres <strong>row-level security</strong>
          rather than by application code, so a query that forgets its
          <code>WHERE</code> clause returns nothing rather than leaking. No
          passwords stored — sign-in is delegated to your identity provider.
        </p>
        <p>This is what runs at <a href="${SITE.app}" rel="noopener">app.habiterall.ca</a>.</p>
        <a class="button secondary" href="${url('wiki/install/cloud/')}">Install cloud</a>
      </article>
    </div>
    <p class="section-more"><a href="${url('wiki/editions/')}">Which edition do I want? →</a></p>
  </div>
</section>

<section class="section closing">
  <div class="wrap closing-inner">
    <h2>Start tracking today</h2>
    <p class="lead">
      Use the hosted app, or have your own instance running in about a minute.
      ${download ? `Latest release: <a href="${url('downloads/')}">v${escapeHtml(download.version)}</a>.` : ''}
    </p>
    <div class="cta-row">
      <a class="button" href="${SITE.app}" rel="noopener">${escapeHtml(cta.label)}</a>
      <a class="button secondary" href="${url('wiki/')}">Read the wiki</a>
    </div>
  </div>
</section>
`;
}
