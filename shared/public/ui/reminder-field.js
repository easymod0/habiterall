/**
 * The reminder picker: two dropdowns and a text box, over one value.
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

import {
  COMMON_TIMES, describe as describeTime, hourOptions, minuteOptions,
  parseTimeInput, split as splitTime,
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
