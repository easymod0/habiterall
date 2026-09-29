/**
 * The reminder picker: two dropdowns and a text box over one time, and seven
 * checkboxes over the weekday mask beside it.
 *
 * All three edit the same string, and the text box is the one that is actually
 * submitted (it carries `name="reminder_time"`), so there is a single source of
 * truth and no hidden field to forget. The dropdowns are for picking, the text
 * box for typing — `parseTimeInput` is what makes '8:30 pm' and '2030' as valid
 * as '20:30'.
 *
 * Why not `<input type="time">`: in its text-box form (Firefox, and Safari
 * depending on version) it silently refuses anything that is not already
 * 'HH:MM' — including '8:30' — and there is no way to tell the user why.
 *
 * Owns the `#reminder-*` controls inside the habit dialog.
 */

import { weekdayNames } from '/shared/ui/dates.js';
import * as settings from '/shared/ui/settings.js';
import {
  COMMON_TIMES, describe as describeTime, describeReminderDays, hourOptions,
  minuteOptions, parseReminderDays, parseTimeInput, split as splitTime,
} from '/shared/ui/time.js';

const $ = (sel) => document.querySelector(sel);

function createTimeField(els) {
  /** Rebuild the minute list, keeping an odd typed minute selectable. */
  function fillMinutes(extra) {
    const wanted = els.minute.value;
    els.minute.replaceChildren();
    for (const opt of minuteOptions(extra)) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      els.minute.append(o);
    }
    if (wanted) els.minute.value = wanted;
  }

  for (const opt of hourOptions()) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    els.hour.append(o);
  }
  fillMinutes(null);

  for (const value of COMMON_TIMES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm';
    button.textContent = value;
    button.addEventListener('click', () => set(value, { announce: true }));
    els.presets.append(button);
  }

  /** Reflect a canonical value (or '') into all three controls. */
  function set(value, { announce = false } = {}) {
    const parts = splitTime(value);
    els.typed.value = value;

    if (parts) {
      fillMinutes(parts.minute);
      els.hour.value = String(parts.hour).padStart(2, '0');
      els.minute.value = String(parts.minute).padStart(2, '0');
    }
    // With no reminder the dropdowns keep whatever they showed: they are a
    // starting point for picking one, and resetting them to 00:00 would make
    // "no reminder" look like "midnight".
    els.hour.disabled = false;
    els.minute.disabled = false;

    hint(announce ? describeTime(value) : '', false);
  }

  function hint(message, isError) {
    els.hint.textContent = message ||
      'Optional. Type any time (8:30, 8:30 pm, 2030) or pick one.';
    els.hint.classList.toggle('error', !!isError);
  }

  function fromDropdowns() {
    set(`${els.hour.value}:${els.minute.value}`, { announce: true });
  }

  els.hour.addEventListener('change', fromDropdowns);
  els.minute.addEventListener('change', fromDropdowns);

  // While typing: follow along if it parses, and say nothing if it does not —
  // half-typed input is not a mistake yet.
  els.typed.addEventListener('input', () => {
    const parsed = parseTimeInput(els.typed.value);
    if (parsed === null) return;
    const parts = splitTime(parsed);
    if (!parts) return;
    fillMinutes(parts.minute);
    els.hour.value = String(parts.hour).padStart(2, '0');
    els.minute.value = String(parts.minute).padStart(2, '0');
    hint(describeTime(parsed), false);
  });

  // On leaving the field, commit: normalise what parsed, complain about what
  // did not. Doing this on `input` instead would rewrite '8' to '08:00' under
  // the cursor before the minutes were typed.
  els.typed.addEventListener('change', () => {
    const parsed = parseTimeInput(els.typed.value);
    if (parsed === null) {
      hint(`"${els.typed.value}" is not a time — try 08:30, 8:30 pm or 2030.`, true);
      return;
    }
    set(parsed, { announce: !!parsed });
  });

  els.clear.addEventListener('click', () => {
    set('');
    hint('No reminder — nothing will be sent for this habit.', false);
    els.typed.focus();
  });

  return {
    set: (value) => set(value ?? ''),
    /** The canonical value, or null if what is in the box is not a time. */
    value: () => parseTimeInput(els.typed.value),
    /** Put the cursor where the problem is. */
    focus: () => els.typed.focus(),
    hint,
  };
}

/* ---------- which weekdays the reminder fires on ---------- */

/**
 * The seven weekdays, in the order this account reads a week in.
 *
 * **Display only.** The bit positions the mask stores are absolute — bit N is
 * `getDay()` N, whatever the account's `weekStart` says — and `ALL_DAYS` in
 * `ui/time.js` has the whole argument for why. This decides the order the
 * boxes are appended in and nothing about what a tick is worth, which is why
 * it is read here at open time rather than anywhere near `parseReminderDays`.
 *
 * A rotation rather than the pair of literal arrays `charts.js`'s own
 * `weekOrder` holds: seven quoted items under `shared/public/` is what
 * `dates.test.js`'s source guard refuses, and while a list of NUMBERS would
 * slip past it, restating the same seven in a second module is the drift that
 * guard exists about.
 */
function displayOrder() {
  const first = settings.get('weekStart') === 'sunday' ? 0 : 1;
  return Array.from({ length: 7 }, (_, i) => (i + first) % 7);
}

/**
 * The weekday picker: seven checkboxes over one integer mask.
 *
 * A SIBLING of the time field rather than a widening of it. `createTimeField`
 * is an abstraction over one string with one submitted input; this is seven
 * controls over a number, and the two reach the server as two fields. They
 * share a fieldset because to a reader they are one question — when does this
 * remind me — and for no other reason.
 *
 * The boxes are created ONCE and re-appended in `displayOrder()` on every
 * `set()`: appending an already-attached node moves it, so the listeners
 * survive the reorder, and a `weekStart` changed in another tab is picked up
 * the next time the dialog opens. The captions are re-read then too, because
 * `weekdayNames` drops its memo when the device's UTC offset moves.
 */
function createDaysField(els) {
  /** The seven rows, indexed by `getDay()` — bit N of the mask is `rows[N]`. */
  const rows = Array.from({ length: 7 }, () => {
    const label = document.createElement('label');
    label.className = 'checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    const caption = document.createElement('span');
    label.append(input, caption);
    input.addEventListener('change', () => hint(value()));
    return { label, input, caption };
  });

  /** The mask the boxes currently describe. */
  function value() {
    return rows.reduce(
      (mask, row, weekday) => mask | (row.input.checked ? 1 << weekday : 0), 0);
  }

  /**
   * Say what the mask means, in the account's own locale.
   *
   * `describeReminderDays` lists in BIT order (Sunday first) whatever order the
   * boxes are in — its own comment says so, and the alternative is a second
   * sentence-builder here that could disagree with the one the rest of the app
   * uses. A mask of 0 gets the Clear button's own wording beside it: it is
   * legal, it is stored as it stands, and it is never quietly repaired to every
   * day. Loop's own dialog does repair it, and that remains available as a
   * PICKER affordance — but it would be one here and a validator rule nowhere,
   * so saying plainly that nothing will be sent is the honest half of keeping
   * those two apart (see `parseReminderDays`).
   */
  function hint(mask) {
    const days = parseReminderDays(mask);
    const said = describeReminderDays(days, weekdayNames('short'));
    els.hint.textContent = days === 0
      ? `${said} — nothing will be sent for this habit.`
      : `Reminds on: ${said}.`;
  }

  function set(raw) {
    const days = parseReminderDays(raw);
    const short = weekdayNames('short');
    const long = weekdayNames('long');
    for (const weekday of displayOrder()) {
      const row = rows[weekday];
      row.input.checked = ((days >> weekday) & 1) === 1;
      row.caption.textContent = short[weekday];
      // The wrapping label already names the box from its caption; the long
      // name is what a screen reader should hear, since `Wed` and `Sat` are
      // abbreviations a grid has room for and a spoken list does not.
      row.input.setAttribute('aria-label', long[weekday]);
      // The first open appends; every later one MOVES the same node, which is
      // what keeps the listener taken above alive across a reorder.
      els.boxes.append(row.label);
    }
    hint(days);
  }

  return {
    set,
    /** The mask, 0..127, bit N = `getDay()` N. Always a number. */
    value,
  };
}

/**
 * There is exactly one habit dialog, so exactly one of these. Built at import
 * rather than on first open: the option lists are static, and rebuilding them
 * every time the dialog opened would discard a typed minute.
 */
export const reminderField = createTimeField({
  hour: $('#reminder-hour'),
  minute: $('#reminder-minute'),
  typed: $('#reminder-typed'),
  clear: $('#reminder-clear'),
  presets: $('#reminder-presets'),
  hint: $('#reminder-hint'),
});

/** Its sibling, over the same habit's `reminder_days`. */
export const reminderDaysField = createDaysField({
  boxes: $('#reminder-days'),
  hint: $('#reminder-days-hint'),
});
