/**
 * Every screenshot, with the README's own description of it as the caption.
 *
 * No prose is written here at all. `docs/screenshots/README.md` states that
 * nothing in that directory is a mockup — "if a control is in a screenshot, it
 * works" — and `shared/test/readme-assets.test.js` already fails if a capture
 * is unreferenced, missing, or carries alt text under 40 characters. So the
 * gallery is a listing of that directory joined to that alt text, and it
 * inherits both guarantees: a screenshot cannot appear here undescribed, and
 * one cannot be retaken without its description being reconsidered.
 *
 * The order is `docs/screenshots/`' own, which is alphabetical, with the
 * dashboard pulled to the front — it is the picture of the product.
 */
import { escapeAttr, escapeHtml, SCREENSHOT_DIR } from '../render.mjs';
import { url } from './layout.mjs';

/** Shown first, in this order, because a gallery's first image is its thesis. */
const LEADING = ['dashboard.png', 'statistics.png', 'notifications.png'];

/**
 * @param {string[]} files  every PNG in docs/screenshots/
 * @returns {string[]}
 */
export function galleryOrder(files) {
  const lead = LEADING.filter((f) => files.includes(f));
  return [...lead, ...files.filter((f) => !lead.includes(f)).sort()];
}

/**
 * A filename turned into a heading: `android-list-light.png` -> `Android list light`.
 * Derived rather than listed, so a new capture needs no entry anywhere.
 *
 * @param {string} file
 */
export function caption(file) {
  const words = file.replace(/\.png$/, '').replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * @param {object} ctx
 * @param {string[]} ctx.files
 * @param {Map<string, { alt: string, width: string }>} ctx.shots
 * @returns {string}
 */
export function gallery({ files, shots }) {
  const figures = galleryOrder(files).map((file) => {
    const meta = shots.get(file);
    if (!meta) {
      throw new Error(
        `docs/screenshots/${file} is not shown in README.md, so it has no ` +
          'description to caption it with. Add it to the README, or delete it.',
      );
    }
    return `<figure class="shot">
      <img src="${url(`${SCREENSHOT_DIR}/${file}`)}" alt="${escapeAttr(meta.alt)}" loading="lazy">
      <figcaption>
        <strong>${escapeHtml(caption(file))}</strong>
        <span class="dim">${escapeHtml(meta.alt)}</span>
      </figcaption>
    </figure>`;
  }).join('\n    ');

  return `
<div class="wrap gallery">
  <header class="page-head">
    <h1>Screenshots</h1>
    <p class="lead">
      All of these are the real app with sample data. Nothing here is a mockup,
      a mock, or a redraw — if a control is in a screenshot, it works.
    </p>
  </header>

  <div class="shots">
    ${figures}
  </div>
</div>
`;
}
