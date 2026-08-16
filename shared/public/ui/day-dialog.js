/**
 * Edit a single day from the calendar. Works for any date up to today, which
 * is what makes correcting old history possible.
 *
 * Owns `#day-dialog` and its controls. It is opened by the detail view and
 * announces `'change'` when it saves — it does not import the detail view,
 * which is what stops the two from depending on each other.
 */

import { api } from '/shared/ui/api.js';
import { dayCountField } from '/shared/ui/count-field.js';
import { formatDateLong, fromISOLocal } from '/shared/ui/dates.js';
import * as settings from '/shared/ui/settings.js';
import { emit, state } from '/shared/ui/store.js';
import { toast } from '/shared/ui/toast.js';
import { DAY, isAvoided, valueForState } from '/shared/ui/toggle.js';
import { UNSET, YES } from '/shared/ui/values.js';

const $ = (sel) => document.querySelector(sel);

const dialog = $('#day-dialog');
const title = $('#day-title');
const sub = $('#day-sub');
const booleanBlock = $('#day-boolean');
const numericBlock = $('#day-numeric');
const notes = $('#day-notes');
const skip = $('#day-skip');
const clear = $('#day-clear');
const save = $('#day-save');

/**
 * @param habit    the habit whose day is being edited
 * @param date     ISO date being edited
 * @param value    what is recorded, if anything
 * @param isSkip   whether the day is flagged as a skip
 * @param noteText the note attached to the day, if any
 */
export function openDayDialog(habit, date, value, isSkip, noteText = '') {
  // The encoding fields travel with the edit rather than the habit object, for
  // the reason the grid's own dialog holds an id: a refetch replaces every
  // habit in `state.habits` and can do it while a modal is open.
  state.dayEdit = {
    habitId: habit.id, date, type: habit.type,
    show_as: habit.show_as, target_type: habit.target_type,
    target_value: habit.target_value,
  };
  notes.value = noteText ?? '';

  // A measurable habit gets a number field; a yes/no habit gets exactly two
  // buttons. Only one of the two controls is ever present.
  const numeric = habit.type === 'numerical';
  // Shown as something to avoid: the two buttons are the fast answer — a clean
  // day is one tap, which is the whole reward — and the amount box stays,
  // because "three coffees" is a thing someone may want to record exactly and
  // a limit of two has no other way to say it.
  const avoided = isAvoided(habit);
  title.textContent = habit.name;

  const pretty = formatDateLong(fromISOLocal(date));

  // Say what's being edited, and against what goal, so the input is unambiguous.
  const goal = numeric
    ? `${habit.target_type === 'at_most' ? 'at most' : 'at least'} ${habit.target_value}` +
      (habit.unit ? ` ${habit.unit}` : '')
    : '';
  sub.textContent = goal ? `${pretty} · target ${goal}` : pretty;

  booleanBlock.hidden = numeric && !avoided;
  numericBlock.hidden = !numeric;
  save.hidden = !numeric; // boolean saves happen on the choice buttons

  // The same two buttons, saying what they mean here. "Done" on a habit you
  // are trying not to do reads as the opposite of what pressing it records.
  for (const b of booleanBlock.querySelectorAll('.day-choice')) {
    const isDone = b.dataset.action === 'done';
    b.textContent = avoided
      ? (isDone ? '✓ Clean day' : '✗ Slipped')
      : (isDone ? '✓ Done' : '✕ Not done');
  }

  if (numeric) {
    // A skipped day has no amount to prefill: for a measurable habit the SKIP
    // wire value is a legitimate amount, so the skip is what says the day has
    // no number rather than the value doing it.
    dayCountField.set(habit, isSkip ? null : value);
  }
  if (!numeric || avoided) {
    // Highlight whichever state the day is currently in. With question marks on,
    // a day with no row is in NEITHER state — that is the state the setting
    // exists to show — so "Not done" must stop claiming it. With them off the
    // two are one thing and it goes on claiming it, as it always has.
    const unanswered = value == null;
    const limit = Number(habit.target_value) || 0;
    for (const b of booleanBlock.querySelectorAll('.day-choice')) {
      const isDone = b.dataset.action === 'done';
      // What "done" looks like differs: `YES` for a yes/no habit, and being at
      // or under the limit for one being avoided, where 0 is the goal. A day
      // over the limit is the second button, whatever the number is.
      const isClean = avoided ? value <= limit : value === YES;
      const isMiss = avoided ? value > limit : value === UNSET;
      const active = !isSkip && !unanswered && (isDone ? isClean : isMiss);
      b.setAttribute('aria-pressed', String(
        active || (!isDone && unanswered && !isSkip && !settings.get('questionMarks'))
      ));
    }
  }

  // "Clear" only means something when there's an entry to remove. It is also
  // the only way back to "no data" while question marks are off, since the
  // grid's cycle then never returns there — Loop's behaviour, deliberately.
  //
  // Hidden on a skipped day, where "Unskip" below issues the same write: both
  // take the day back to having no row, and two differently-labelled buttons
  // doing one thing reads as one of them doing something else.
  clear.hidden = isSkip || value == null;
  // Skips switched off hide the control, but never on a day that already is
  // one: an imported Loop history has skips in it, and "Unskip" must stay
  // reachable or they cannot be undone at all.
  skip.hidden = !settings.get('skipDays') && !isSkip;
  skip.setAttribute('aria-pressed', String(!!isSkip));
  skip.textContent = isSkip ? 'Unskip' : 'Skip day';

  dialog.showModal();
  if (numeric) dayCountField.focus();
}

async function saveDay(body) {
  const { habitId, date } = state.dayEdit ?? {};
  if (!habitId) return;

  try {
    if (body === null) {
      await api(`/habits/${habitId}/entries/${date}`, { method: 'DELETE' });
    } else {
      // Notes ride along with whatever the day is being set to.
      await api(`/habits/${habitId}/entries/${date}`, {
        method: 'PUT',
        body: JSON.stringify({ notes: notes.value.trim(), ...body }),
      });
    }
    dialog.close();
    emit('change');
  } catch (e) {
    toast(e.message);
  }
}

export function init() {
  $('#day-cancel').addEventListener('click', () => dialog.close());

  skip.addEventListener('click', () => {
    // Toggles: skipping an already-skipped day removes the skip.
    const wasSkipped = skip.getAttribute('aria-pressed') === 'true';
    saveDay(wasSkipped ? null : { status: 'skip' });
  });

  clear.addEventListener('click', () => saveDay(null));

  save.addEventListener('click', () => {
    // Three answers, and two of them are falsy — `===` is load bearing. An
    // EMPTY box is "nothing is known about this day", which is a delete; an
    // UNREADABLE one is a mistake to report, and used to be indistinguishable
    // from empty because `<input type="number">` handed back `''` for it and
    // this deleted the day. `0` is the third and is a real answer.
    const amount = dayCountField.value();
    if (amount === '') return saveDay(null);
    if (amount === null) return dayCountField.complain();
    saveDay({ value: amount });
  });

  for (const b of booleanBlock.querySelectorAll('.day-choice')) {
    b.addEventListener('click', () => {
      // Both buttons write a row. "Not done" used to delete one unless a note
      // came with it, which made the note the only way to state a lapse; it is
      // an answer either way, and Clear is what means "nothing is known".
      //
      // The VALUE comes from ui/toggle.js, which is the one place that knows a
      // clean day on an avoided habit is 0 and a slip is the smallest amount
      // over the limit. The grid's tap reads the same function.
      const value = valueForState(
        state.dayEdit ?? {},
        b.dataset.action === 'done' ? DAY.DONE : DAY.NO
      );
      saveDay({ value });
    });
  }

  dayCountField.onEnter(() => save.click());
}
