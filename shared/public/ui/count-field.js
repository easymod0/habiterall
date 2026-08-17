/**
 * The amount field: two steppers, some quick values, and a box to type into.
 *
 * All of them edit one value and **the box is the one that is read**, exactly
 * as `ui/reminder-field.js` states for the time picker. That is the whole
 * reason this is one control rather than a spinner beside a field: with two
 * sources of truth there is a state where the buttons say 8 and the value
 * saved is something else.
 *
 * It replaces two different things that were each wrong in their own way. The
 * dashboard called `window.prompt()` — an OS text box, unstyled, with the habit
 * name crammed into its message, no unit beside the field and no target to aim
 * at, which blocks the event loop while it is open and is suppressed outright
 * by a browser that has decided the page makes too many dialogs, after which
 * tapping a measurable day did nothing at all. The day editor had
 * `<input type="number">`, whose arrows step by 1 whether the habit is "8
 * glasses" or "10,000 steps", and which silently mangles what it cannot read —
 * see `ui/amount.js` for the measurements.
 *
 * Two instances, because there are two places to record an amount and each
 * lives in its own dialog. The rules they share are in `ui/amount.js`, which is
 * DOM-free and unit-tested; nothing here decides anything about a number. What
 * this does supply is the CONVENTION those rules are applied under — the
 * account's `numberFormat` resolved against this device — because the setting
 * and `Intl` are both things a DOM-free module should be handed rather than go
 * looking for.
 *
 * Owns the `#day-count-*` and `#grid-count-*` controls and the `.countfield-*`
 * classes inside them.
 */

import {
  amountComplaint, deviceDecimalSeparator, formatAmount, parseAmount,
  resolveNumberFormat, stepAmount, stepFor,
} from '/shared/ui/amount.js';
import { get } from '/shared/ui/settings.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Which character a decimal point is, for this account on this device.
 *
 * Asked at the moment something is read or written, and never held: `auto` is a
 * question about the DEVICE and the setting is a question about the ACCOUNT, so
 * a value captured at import time would answer with whichever was true first
 * and go on answering that after the dialog changed it. Two instances of this
 * control exist for the life of the page, which is the same span.
 */
const convention = () =>
  resolveNumberFormat(get('numberFormat'), deviceDecimalSeparator());

/**
 * @param {any} root the `.countfield` container
 */
function createCountField(root) {
  if (!root) throw new Error('count field container is missing from index.html');
  const typed = /** @type {HTMLInputElement} */ (root.querySelector('.countfield-typed'));
  const presets = /** @type {HTMLElement} */ (root.querySelector('.countfield-presets'));
  const hintEl = /** @type {HTMLElement} */ (root.querySelector('.countfield-hint'));
  const label = /** @type {HTMLElement} */ (root.querySelector('legend'));

  /** The habit being recorded against — the source of the step and the goal. */
  let habit = null;

  function goal() {
    return Number(habit?.target_value) || 0;
  }

  function defaultHint() {
    if (!habit) return '';
    // A target of 0 is a real goal on a LIMIT — "at most 0 cigarettes" — and
    // testing the number for truthiness dropped the goal line for exactly the
    // habit whose goal is the whole point. It is not a goal on an at-least
    // habit, where 0 is what `parseHabit` stores for "no target" and what
    // `stepFor` reads as one; `target_value == null` never fires at all, since
    // the column is NOT NULL in both editions.
    if (habit.target_type !== 'at_most' && goal() <= 0) {
      return 'Leave empty to clear the day.';
    }
    const direction = habit.target_type === 'at_most' ? 'at most' : 'at least';
    const unit = habit.unit ? ` ${habit.unit}` : '';
    return `Target ${direction} ${formatAmount(goal(), convention())}${unit}. Leave empty to clear.`;
  }

  function hint(message, isError = false) {
    hintEl.textContent = message || defaultHint();
    hintEl.classList.toggle('error', !!isError);
  }

  /** Rebuild the quick values for this habit. */
  function fillPresets() {
    presets.replaceChildren();
    const target = goal();
    // 0 and the goal are the two amounts worth one tap: on an at-least habit
    // the goal is what you are aiming at, and on an at-most habit 0 is. The
    // steppers cover everything between, which is why there is no ladder of
    // buttons here — that is what the spinner was for and it did not scale.
    //
    // 0 is offered whatever the target, and `target > 0 ? [0, target] : []`
    // withheld it from the one habit the sentence above says it is FOR: a
    // limit of zero got no buttons at all, so recording the day it exists to
    // record meant typing. Deduplicated, since on that habit they are the same
    // amount and two identical buttons read as one of them doing something
    // else.
    // Deduplicated and filtered on the LABEL, not the number, because the
    // label is what the button types. Two targets a millionth apart format
    // identically, which produced two buttons that look the same and do the
    // same — the thing the `Set` was there to prevent; and a target outside
    // `parseAmount`'s domain gave a button that fills the box with a value
    // Save then refuses. Neither is reachable with a sane target; both are one
    // expression to rule out.
    const format = convention();
    const labels = [...new Set([0, target].map((n) => formatAmount(n, format)))]
      .filter((label) => typeof parseAmount(label, format) === 'number');
    for (const label of labels) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm';
      button.textContent = label;
      button.addEventListener('click', () => {
        typed.value = label;
        hint('');
        typed.focus();
      });
      presets.append(button);
    }
  }

  for (const button of root.querySelectorAll('.countfield-step')) {
    button.addEventListener('click', () => {
      const format = convention();
      const current = parseAmount(typed.value, format);
      // A box holding something unreadable is not a number to step from, and
      // stepping would throw away what was typed without saying why. Complain
      // and leave it alone — the same thing Save does with it.
      if (current === null) {
        hint(amountComplaint(typed.value, format), true);
        return;
      }
      const direction = Number(button.dataset.step) < 0 ? -1 : 1;
      typed.value = formatAmount(
        stepAmount(current, stepFor(goal()), direction, goal()), format
      );
      hint('');
      typed.focus();
    });
  }

  // While typing, say nothing about a half-typed amount: "8." is on its way to
  // "8.5" and is not a mistake yet. The complaint belongs to Save and to the
  // steppers, which are the moments something is actually being done with it.
  typed.addEventListener('input', () => hint(''));

  return {
    /**
     * Show `value` for `forHabit`. `null`/`undefined` leaves the box empty,
     * which is what "no entry" looks like — not the number 0.
     */
    set(forHabit, value) {
      habit = forHabit;
      label.textContent = forHabit?.unit ? `Amount (${forHabit.unit})` : 'Amount';
      typed.value = value == null ? '' : formatAmount(value, convention());
      fillPresets();
      hint('');
    },
    /** `''` empty, `null` unreadable, or the number. See `parseAmount`. */
    value: () => parseAmount(typed.value, convention()),
    /** Say what is wrong with what is in the box, in one place. */
    complain() {
      hint(amountComplaint(typed.value, convention()), true);
      typed.focus();
    },
    focus: () => typed.focus(),
    /** Enter should save, in whichever dialog this instance sits in. */
    onEnter(handler) {
      typed.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); handler(); }
      });
    },
  };
}

/** The day editor's, inside `#day-dialog`. */
export const dayCountField = createCountField($('#day-count'));

/** The dashboard's, inside `#count-dialog`. */
export const gridCountField = createCountField($('#grid-count'));
