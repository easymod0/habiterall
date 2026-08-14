/**
 * Edit a single day from the calendar. Works for any date up to today, which
 * is what makes correcting old history possible.
 *
 * Owns `#day-dialog` and its controls. It is opened by the detail view and
 * announces `'change'` when it saves — it does not import the detail view,
 * which is what stops the two from depending on each other.
 */

import { api } from '/shared/ui/api.js';
import * as settings from '/shared/ui/settings.js';
import { emit, state } from '/shared/ui/store.js';
import { toast } from '/shared/ui/toast.js';
import { UNSET, YES } from '/shared/ui/values.js';

const $ = (sel) => document.querySelector(sel);

const dialog = $('#day-dialog');
const title = $('#day-title');
const sub = $('#day-sub');
const booleanBlock = $('#day-boolean');
const numericBlock = $('#day-numeric');
const numericLabel = $('#day-numeric-label');
const valueInput = $('#day-value');
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
  state.dayEdit = { habitId: habit.id, date, type: habit.type };
  notes.value = noteText ?? '';

  // A measurable habit gets a number field; a yes/no habit gets exactly two
  // buttons. Only one of the two controls is ever present.
  const numeric = habit.type === 'numerical';
  title.textContent = habit.name;

  const [y, m, d] = date.split('-').map(Number);
  const pretty = new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  // Say what's being edited, and against what goal, so the input is unambiguous.
  const goal = numeric
    ? `${habit.target_type === 'at_most' ? 'at most' : 'at least'} ${habit.target_value}` +
      (habit.unit ? ` ${habit.unit}` : '')
    : '';
  sub.textContent = goal ? `${pretty} · target ${goal}` : pretty;

  booleanBlock.hidden = numeric;
  numericBlock.hidden = !numeric;
  save.hidden = !numeric; // boolean saves happen on the choice buttons

  if (numeric) {
    numericLabel.textContent = habit.unit ? `Amount (${habit.unit})` : 'Amount';
    valueInput.value = value != null && !isSkip ? String(value) : '';
    valueInput.placeholder = isSkip ? 'skipped' : 'leave empty to clear';
  } else {
    // Highlight whichever state the day is currently in. With question marks on,
    // a day with no row is in NEITHER state — that is the state the setting
    // exists to show — so "Not done" must stop claiming it. With them off the
    // two are one thing and it goes on claiming it, as it always has.
    const unanswered = value == null;
    for (const b of booleanBlock.querySelectorAll('.day-choice')) {
      const isDone = b.dataset.action === 'done';
      const active = !isSkip && (isDone
        ? value === YES
        : value === UNSET || (unanswered && !settings.get('questionMarks')));
      b.setAttribute('aria-pressed', String(active));
    }
  }

  // "Clear" only means something when there's an entry to remove. It is also
  // the only way back to "no data" while question marks are off, since the
  // grid's cycle then never returns there — Loop's behaviour, deliberately.
  clear.hidden = value == null && !isSkip;
  // Skips switched off hide the control, but never on a day that already is
  // one: an imported Loop history has skips in it, and "Unskip" must stay
  // reachable or they cannot be undone at all.
  skip.hidden = !settings.get('skipDays') && !isSkip;
  skip.setAttribute('aria-pressed', String(!!isSkip));
  skip.textContent = isSkip ? 'Unskip' : 'Skip day';

  dialog.showModal();
  if (numeric) valueInput.focus();
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
    const raw = valueInput.value.trim();
    if (raw === '') return saveDay(null); // empty means "no entry"
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return toast('Enter a non-negative number');
    saveDay({ value: n });
  });

  for (const b of booleanBlock.querySelectorAll('.day-choice')) {
    b.addEventListener('click', () => {
      // Both buttons write a row. "Not done" used to delete one unless a note
      // came with it, which made the note the only way to state a lapse; it is
      // an answer either way, and Clear is what means "nothing is known".
      const value = b.dataset.action === 'done' ? YES : UNSET;
      saveDay({ value });
    });
  }

  valueInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save.click(); }
  });
}
