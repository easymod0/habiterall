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

/**
 * What THIS DEVICE last said about the theme, while the server does not have
 * it yet. One durable record, and the only thing `choice()` prefers over the
 * account.
 *
 * There were three carriers here — a `serverAnswered` flag, a `userChose`
 * flag, and this key holding the pre-setting value — with `choice()`
 * arbitrating between them at render time. Every fix on this branch added a
 * guard to that set and each one bought the next defect, because the durable
 * member of the three held the OLDEST answer: a press was remembered in
 * memory, so a reload preferred the stale key over the choice just made and
 * quietly undid it. One record, holding the NEWEST answer, is the fix; the
 * flags are gone rather than joined by a fourth.
 *
 * It carries two kinds of answer and says which, because they are retired by
 * different events and a record that cannot tell them apart has to guess:
 *
 *   `light`         a bare value is what the PRE-SETTING build wrote here, and
 *                   reading it is the whole of the migration. Another device
 *                   may have set the account since, and that is the more
 *                   recent decision, so this is discarded the moment the
 *                   server names any theme at all.
 *   `press:light`   this device's own press, not yet confirmed. The account
 *                   naming something else does NOT retire it: the write may
 *                   still be sitting in the outbox, and the account is then
 *                   the older answer of the two.
 *
 * A press writes `system` here as well as the other two, which the bare
 * spelling never could — "follow this device" is a state, and a state you
 * cannot record is one a reload loses.
 */
const DEVICE_KEY = 'habiterall-theme';
const PRESS = 'press:';
const CHOICES = ['system', 'light', 'dark'];

/** @returns {{value: string, pressed: boolean} | null} */
function deviceRecord() {
  let raw;
  try {
    raw = localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;                 // private browsing; nothing is remembered
  }
  if (!raw) return null;
  if (raw.startsWith(PRESS)) {
    const value = raw.slice(PRESS.length);
    return CHOICES.includes(value) ? { value, pressed: true } : null;
  }
  // The pre-setting build only ever wrote these two.
  return raw === 'light' || raw === 'dark' ? { value: raw, pressed: false } : null;
}

/** Remember a press, durably, BEFORE anything is attempted over the network. */
function remember(value) {
  try {
    localStorage.setItem(DEVICE_KEY, PRESS + value);
  } catch { /* private browsing: the press lasts this session only */ }
}

/** The server has it, or has overruled it. Either way this device is done. */
function forget() {
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch { /* nothing to clean up */ }
}

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

/**
 * The setting's value: this device's own unconfirmed answer if it has one, and
 * the account's otherwise.
 *
 * `ui/settings.js` cannot make this distinction for us — `load()` goes through
 * `sanitise`, which starts from `defaults()`, so `get('theme')` is `'system'`
 * both for an account that has never had one and for an account set to follow
 * the device. The record is what covers the gap, and it covers it durably.
 */
function choice() {
  return deviceRecord()?.value ?? get('theme') ?? 'system';
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
  onApply((values, meta) => {
    // `meta.stored` is present only when this update came from the server's
    // own reply, and it is the ONLY thing that can retire the device record.
    // Putting it here rather than in `toggleTheme` is what makes the settings
    // dialog work too: it writes through `saveAll`, which never told this
    // module anything, so a theme picked there was stored by the server and
    // then painted over by a record nobody had cleared.
    if (meta?.stored) reconcile(meta.stored);
    apply(choice());
  });

  // `system` means live, not "whatever it was at boot". Without this, a laptop
  // that switches at sunset needs a reload to catch up — which is most of what
  // the setting is for.
  prefersDark().addEventListener('change', () => {
    if (choice() === 'system') apply('system');
  });
}

/**
 * The server has said what it holds. Decide what becomes of this device's
 * record, and push it if the account has nothing.
 *
 * This replaced a `migrateTheme()` that ran a `GET /api/settings` of its own
 * after boot, held its promise so a press could queue behind it, and needed
 * two flags to describe where it had got to. All of that was recovering an
 * answer the boot had already been given: `settings.init()` reads the same
 * route, and `adopt` now passes what it read. So there is no second request,
 * no promise, and nothing for a press to wait on — which is what removes the
 * case where a press waited on a request that never came back and was lost
 * with the tab.
 *
 * @param {Record<string, unknown>} stored the keys the server says it HOLDS —
 *   not the sanitised view, which fills the gaps and so can never answer
 *   "does this account have a theme at all".
 */
function reconcile(stored) {
  const record = deviceRecord();
  if (!record) return;

  // The server has this device's answer. Done — and this is the ordinary end
  // of a press, since `save()` adopts the reply it gets.
  if (stored.theme === record.value) { forget(); return; }

  // The account has no theme, so this device's answer becomes the account's.
  if (!Object.hasOwn(stored, 'theme')) { push(record.value); return; }

  // The account holds something ELSE, and what that means depends on which
  // kind of record this is. A pre-setting leftover is superseded: another
  // device has migrated since, and that is the more recent decision.
  if (!record.pressed) { forget(); return; }

  // A press is not superseded — the account is the older of the two answers,
  // and the write this device owes has not landed. Sending it again is what
  // makes the whole arrangement self-healing: a press whose write was lost
  // (the tab closed before it went out, a 500, or a stale write from this
  // same boot landing after it) is re-sent on the next reconcile rather than
  // sitting on this device forever, invisible on every other one.
  push(record.value);
}

/**
 * Give the account this device's answer.
 *
 * Fire and forget: the record is durable, so a failure costs nothing but a
 * retry on the next boot. The guard is re-entrancy and not state — `save`
 * adopts the reply, which runs the applier, which lands back in `reconcile`.
 * That second pass is how the record gets cleared, and it must not start a
 * second write on the way through.
 */
let pushing = false;

function push(value) {
  if (pushing) return;
  pushing = true;
  serialise(() => save('theme', value))
    .catch(() => {})
    .finally(() => { pushing = false; });
}

/**
 * Theme writes go out ONE AT A TIME, in the order they were made.
 *
 * Two writers of one key cannot be ordered by hoping. The reconcile above may
 * have a PUT of the pre-setting value in flight when the user presses the
 * button, and if the two arrive at the server in the other order the account
 * keeps the value the user just changed away from — measured, and the reason
 * an earlier version had `toggleTheme` await the migration's promise. That
 * version was right about the ordering and wrong about the mechanism: it
 * awaited an UNBOUNDED request, so a PUT that was accepted and never answered
 * left the press waiting forever and lost it with the tab.
 *
 * A queue is the ordering without the hazard, and it is only safe because
 * `settings.save` is bounded now — every link settles. The press still PAINTS
 * before joining it, and the record is already durable by then, so what is
 * queued is the write and never the answer.
 */
/** @type {Promise<any>} */
let writes = Promise.resolve();

/**
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
function serialise(fn) {
  // `then(fn, fn)` rather than `then(fn)`: a failed write must not stop the
  // ones behind it, and a rejected chain that nothing catches is an unhandled
  // rejection at boot.
  const next = writes.then(fn, fn);
  writes = next.catch(() => {});
  return next;
}

/**
 * Walk to the next of the three and remember it.
 *
 * @returns {Promise<{ok: boolean, error?: string}>} so the caller can say when
 *   it did not stick. `save` queues on a network error but DROPS a 429, a 500
 *   or a 403 — and the button used to write localStorage and could not fail at
 *   all, so silently reverting at some arbitrary later cache write is new.
 */
export async function toggleTheme() {
  const next = nextChoice();

  // Durable FIRST, before anything is attempted over the network. This is the
  // whole of the offline fix: the press used to be remembered in a variable,
  // so reopening the app while still offline preferred the older record on
  // disk and painted the theme the user had just changed away from — with the
  // write sitting in the outbox saying otherwise.
  remember(next);

  // Then paint: everything below waits on the network, and a press that does
  // nothing for a second reads as broken.
  apply(next);

  const result = await serialise(() => save('theme', next))
    .catch(() => ({ ok: false, error: 'could not save' }));

  // Nothing to clear on success: `save` adopted the server's reply, which ran
  // the applier, which reconciled. What is left is the refusal — a 429, a 500,
  // a value the server would not have. That is not "not yet", it is "no", so
  // the record goes and the screen returns to what is actually stored.
  //
  // A refusal is NOT the offline answer. `save` reports that as
  // `{ok: true, offline: true}`, having written the cache and queued the PUT,
  // and the record has to survive it — that write is still owed.
  if (!result?.ok) {
    forget();
    apply(choice());
  }
  return result;
}
