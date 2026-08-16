/**
 * Light, dark, or whatever the device says — a preference like every other.
 *
 * It used to live in localStorage alone, which cost two things. It did not
 * follow the account, which is the exact property `ui/settings.js`'s own header
 * claims for preferences ("set 'today on the left' on a laptop and a phone
 * agrees"). And `initTheme` read `saved ?? (prefersDark ? 'dark' : 'light')`
 * while `toggleTheme` wrote one of two values, so once the button had been
 * pressed there was no way back: a machine that goes dark at sunset stopped
 * doing so, with no control that said why. "Follow this device" is a state, not
 * the absence of one.
 *
 * The setting is `theme`, defaulting to `system`, and the localStorage that
 * remains is `ui/settings.js`'s own cache — which is what keeps the first paint
 * instant. Same arrangement as every other preference, not a new one.
 *
 * Switching it repaints everything by itself, and this module does not tell
 * anybody it happened. The charts emit `var(…)` and `color-mix()` rather than
 * resolving their colours at draw time, so the cascade does the work; a redraw
 * in the detail view is a REFETCH, which is why `toggleTheme` must never grow a
 * callback again. See `themed` in charts.js.
 */

import { get, onApply, save } from '/shared/ui/settings.js';

/** Where the two-state version kept its answer, before this was a setting. */
const LEGACY_KEY = 'habiterall-theme';

/** What the button walks through. `system` is in it, or it is unreachable. */
const CYCLE = ['system', 'light', 'dark'];

const LABEL = {
  system: 'Theme: following this device',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

const prefersDark = () => matchMedia('(prefers-color-scheme: dark)');

/** The two-state value the old toggle stored here, if it is still around. */
function legacyChoice() {
  try {
    const saved = localStorage.getItem(LEGACY_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;                 // private browsing; nothing to migrate
  }
}

/** The setting's value, with the pre-setting answer standing in for it. */
function choice() {
  return get('theme') ?? legacyChoice() ?? 'system';
}

/**
 * What the button should say it will do next, given where the cycle is.
 *
 * Returned rather than written, because `#btn-theme` belongs to `app.js` and
 * `test/ui-modules.test.js` fails when two modules reach for one id. Note this
 * is NOT the redraw callback the header refuses: it says a sentence, and
 * nothing repaints on the strength of it.
 */
/** @type {(text: string) => void} */
let announce = () => {};

/** Paint it, resolving `system` against the device. */
function apply(value) {
  document.documentElement.dataset.theme =
    value === 'light' || value === 'dark'
      ? value
      : (prefersDark().matches ? 'dark' : 'light');
  announce(LABEL[value] ?? LABEL.system);
}

/**
 * Follow the setting, and start following the device while it says to.
 *
 * Called before the first paint, so it reads `ui/settings.js`'s cache rather
 * than waiting for a request — `onApply` hands over the cached values
 * immediately and again every time they move, which covers all six paths the
 * cache changes by.
 *
 * @param {{onLabel?: (text: string) => void}} [opts] told what the control
 *   should now say. The control itself is `app.js`'s.
 */
export function initTheme({ onLabel } = {}) {
  if (onLabel) announce = onLabel;
  onApply((values) => apply(values.theme ?? legacyChoice() ?? 'system'));

  // `system` means live, not "whatever it was at boot". Without this, a laptop
  // that switches at sunset needs a reload to catch up — which is most of what
  // the setting is for.
  prefersDark().addEventListener('change', () => {
    if (choice() === 'system') apply('system');
  });
}

/**
 * Adopt the pre-setting choice, once, so it follows the account from now on.
 *
 * Called after `settings.init()` and not before: it is a WRITE, and writing
 * from the cached values would race the answer and could overwrite a `theme`
 * this account already has. Reading the legacy key is safe at any time, which
 * is why `apply` may use it while this has not run yet — the alternative is a
 * dialog showing "Follow this device" over a page the user had set to dark,
 * which is the `historyGranularity` trap in another costume.
 */
export async function migrateTheme() {
  const legacy = legacyChoice();
  if (!legacy) return;
  // Only if the account has never had one. Somebody else's device already
  // deciding is the more recent answer.
  if (get('theme') === undefined) await save('theme', legacy);
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* nothing to clean up */ }
}

/** Walk to the next of the three and remember it. */
export function toggleTheme() {
  const next = CYCLE[(CYCLE.indexOf(choice()) + 1) % CYCLE.length];
  // Paint first: `save` waits for the server and queues when offline, and a
  // press that does nothing for a second reads as broken.
  apply(next);
  return save('theme', next);
}
