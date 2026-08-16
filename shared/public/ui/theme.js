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

/**
 * Where the button goes next.
 *
 * A fixed `['system', 'light', 'dark']` looks right and has a dead press in it:
 * from `system` on a device that prefers light, the next value IS light, so the
 * button does nothing visible and reads as broken. Found in CI, where a fresh
 * profile starts at `system` and Chrome prefers light — `themecheck`'s
 * "the theme actually switched" caught it, which is what that assertion is for.
 *
 * So the first step is always the OPPOSITE of what the device is showing, and
 * the order is device-relative: system -> the other one -> the device's own ->
 * system. All three are reachable and the first press — the common one — always
 * changes what is on screen.
 *
 * The last step is the one that cannot change the pixels: returning to `system`
 * from a value that matches the device is the same appearance by definition.
 * That is what the label is for, and why there is one.
 */
function nextChoice() {
  const current = choice();
  const deviceDark = prefersDark().matches;
  const differs = deviceDark ? 'light' : 'dark';
  const matches = deviceDark ? 'dark' : 'light';
  if (current === 'system') return differs;
  if (current === differs) return matches;
  return 'system';
}

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

/**
 * Whether the server has answered yet — which is the only thing that can tell a
 * stored `theme` from the default one.
 *
 * `ui/settings.js` deliberately cannot: `load()` goes through `sanitise`, which
 * starts from `defaults()`, so `get('theme')` is `'system'` for an account that
 * has never had one AND for an account set to follow the device. Before the
 * answer, the legacy key is the better guess about this device; after it, the
 * account wins even if this device still holds a stale one — another device may
 * have migrated already, and that is the more recent decision.
 */
let serverAnswered = false;

/** The setting's value, with the pre-setting answer standing in for it. */
function choice() {
  if (!serverAnswered) {
    const legacy = legacyChoice();
    if (legacy) return legacy;
  }
  return get('theme') ?? 'system';
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
  onApply(() => apply(choice()));

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
  // From here on the account is authoritative, whatever happens below.
  serverAnswered = true;
  if (!legacy) return;

  // `GET /api/settings` and not `get('theme')`, and this is the whole of it:
  // `ui/settings.js` fills gaps from `defaults()`, so `get('theme')` answers
  // `'system'` for an account that has never had one — a guard written against
  // it can never fire. The route returns only the keys that have been STORED,
  // which is the one place the difference exists. An earlier version of this
  // asked the cache, so it never saved and deleted the key anyway: every user
  // who had pressed the old toggle lost their choice on the first load after
  // upgrading, silently.
  let stored;
  try {
    const res = await fetch('/api/settings', { credentials: 'same-origin' });
    if (!res.ok) return;                       // try again next boot
    stored = await res.json();
  } catch {
    return;                                    // offline: the key stays put
  }
  if (typeof stored !== 'object' || stored === null) return;

  if (!Object.hasOwn(stored, 'theme')) {
    const result = await save('theme', legacy);
    // Nothing is deleted that was not stored. `save` queues when offline and
    // reports `{ok: false}` when the server refuses, and either way the local
    // key is the only copy of the answer left.
    if (!result?.ok) return;
  }
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* nothing to clean up */ }
  apply(choice());
}

/** Walk to the next of the three and remember it. */
export function toggleTheme() {
  const next = nextChoice();
  // Paint first: `save` waits for the server and queues when offline, and a
  // press that does nothing for a second reads as broken.
  apply(next);
  return save('theme', next);
}
