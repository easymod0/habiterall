/**
 * Where to get it: the hosted app, the Docker images, and the Android APK.
 *
 * The version, the APK's filename, its size and its URL all come from the
 * latest release rather than from anything written here, which is the only way
 * this page cannot be pointing at a version that no longer exists.
 *
 * The sideloading warning is the one on every release, and it is here because
 * this is where someone downloads the file: Android reports a signature
 * mismatch as a bare "App not installed", which reads as a broken download
 * rather than as a previous build that has to be uninstalled first.
 */
import { SITE } from '../config.js';
import { escapeAttr, escapeHtml } from '../render.mjs';
import { url, hostedCta } from './layout.mjs';
import { releaseDate } from './changelog.mjs';

/** @param {number} bytes */
export function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * @param {object} ctx
 * @param {import('../releases.mjs').Download | null} ctx.download
 * @returns {string}
 */
export function downloads({ download }) {
  const cta = hostedCta();

  const apks = download?.apks.length
    ? download.apks.map((apk) => `<li>
          <a class="button secondary" href="${escapeAttr(apk.url)}" rel="noopener">Download APK</a>
          <span class="dim"><code>${escapeHtml(apk.name)}</code> · ${escapeHtml(megabytes(apk.size))}</span>
        </li>`).join('\n        ')
    : `<li class="dim">No APK is attached to the latest release. <a href="${SITE.repo}/releases" rel="noopener">Check the releases page.</a></li>`;

  const images = download
    ? download.images.map((image) => `<div class="image-tag">
          <h3>${escapeHtml(image.label)}</h3>
          <pre><code>docker pull ${escapeHtml(image.ref)}</code></pre>
        </div>`).join('\n        ')
    : '';

  return `
<div class="wrap downloads">
  <header class="page-head">
    <h1>Downloads</h1>
    <p class="lead">
      ${download
        ? `Latest release <strong>${escapeHtml(download.tag)}</strong>, published ${escapeHtml(releaseDate(download.publishedAt))}.`
        : 'Every release carries both Docker images and the native Android APK.'}
      ${download ? `<a href="${escapeAttr(download.url)}" rel="noopener">Release notes</a> · <a href="${url('changelog/')}">Full changelog</a>` : ''}
    </p>
  </header>

  <section class="download-block">
    <h2>Use the hosted app</h2>
    <p>Nothing to install. The cloud edition, run for you.</p>
    <p><a class="button" href="${SITE.app}" rel="noopener">${escapeHtml(cta.label)}</a></p>
    ${cta.note ? `<p class="dim">${escapeHtml(cta.note)}</p>` : ''}
  </section>

  <section class="download-block">
    <h2>Run it yourself — Docker</h2>
    <p>
      Both editions ship as published images for <code>linux/amd64</code> and
      <code>linux/arm64</code>, so there is nothing to clone and nothing to
      build on your server.
    </p>
    <div class="grid two">
      ${images || `<p class="dim">Image tags are listed on <a href="${SITE.repo}/releases" rel="noopener">each release</a>.</p>`}
    </div>
    <p>
      <a class="button secondary" href="${url('wiki/install/personal/')}">Install personal</a>
      <a class="button secondary" href="${url('wiki/install/cloud/')}">Install cloud</a>
    </p>
  </section>

  <section class="download-block">
    <h2>Android</h2>
    <p>
      The native client — reminders that arrive in the notification shade, and
      answer buttons that record the day without opening the app.
    </p>
    <ul class="apk-list">
        ${apks}
    </ul>
    <p class="dim">
      Sideloading needs <em>Install unknown apps</em> enabled for whichever app
      you open the file with. If a previous build is installed and was signed
      with a different key — a debug build, for instance — uninstall it first:
      Android refuses the update, reporting only <em>App not installed</em>.
    </p>
    <p>
      Or skip the APK entirely and
      <a href="${url('wiki/phone/')}">add the web app to your home screen</a> —
      it installs, works offline, and updates itself.
    </p>
  </section>
</div>
`;
}
