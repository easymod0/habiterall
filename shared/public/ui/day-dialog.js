/**
 * Edit a single day from the calendar. Works for any date up to today, which
 * is what makes correcting old history possible.
 *
 * Owns `#day-dialog` and its controls. It is opened by the detail view and
 * announces `'change'` when it saves — it does not import the detail view,
 * which is what stops the two from depending on each other.
 */

import { formatAmount } from '/shared/ui/amount.js';
import { api } from '/shared/ui/api.js';
import { habitIcon } from '/shared/ui/components.js';
import { convention, dayCountField } from '/shared/ui/count-field.js';
import { formatDateLong, fromISOLocal } from '/shared/ui/dates.js';
import * as settings from '/shared/ui/settings.js';
import { emit, state } from '/shared/ui/store.js';
import { toast } from '/shared/ui/toast.js';
import { DAY, isAvoided, valueForState } from '/shared/ui/toggle.js';
import { UNSET, YES } from '/shared/ui/values.js';

const $ = (sel) => document.querySelector(sel);

/**
 * How this account spells an amount, for the subtitle's goal.
 *
 * The same one line `ui/detail.js` and `ui/dashboard.js` declare, for the same
 * reason and with the same rule about when it is asked: never held, because the
 * setting is a fact about the ACCOUNT and `auto` is a question about the DEVICE
 * and either can change while this module is loaded (`convention`,
 * `ui/count-field.js`). A third declaration rather than a new export from one of
 * them, since an export under `shared/public/` costs every installed client its
 * data cache.
 *
 * This subtitle is the FOURTH surface of the same rule and the one `targetLabel`
 * could not reach: it is not a `targetLabel` caller — it spells the direction in
 * words (`at most 8,5 cigs`, not `≤ 8,5 cigs`) because it is a sentence about
 * the day being edited rather than a label — so a comma account read
 * `at most 8.5` here while the box directly under it, filled by
 * `dayCountField.set` through `formatAmount`, held `8,5`.
 */
const showAmount = (n) => formatAmount(n, convention());

const dialog = $('#day-dialog');
const title = $('#day-title');
const sub = $('#day-sub');
const booleanBlock = $('#day-boolean');
const numericBlock = $('#day-numeric');
const notes = $('#day-notes');
const notesWrap = $('#day-notes-wrap');
const skip = $('#day-skip');
const clear = $('#day-clear');
const save = $('#day-save');

/**
 * Which page's own model an answer here has to be applied to, while the dialog
 * is open — `null` for a caller that has none.
 *
 * The same shape (and the same reason) as `counting.host` in
 * `ui/day-strip.js`: two surfaces could open a day editor and only the one
 * that opened it knows where the answer goes. It is a module-level binding
 * rather than a key on `state.dayEdit`, because that object is view state a
 * refetch may replace and this is a callback table belonging to the render
 * that opened the dialog.
 *
 * Read by `saveDay` on ONE path — a write that could not be sent and is
 * therefore sitting in the outbox. Everything else ends in `emit('change')`,
 * which the page answers with a refetch that needs nothing from here.
 *
 * @type {import('/shared/ui/day-strip.js').StripHost | null}
 */
let dayHost = null;

/**
 * Whether the note box is showing the day's REAL note, for as long as it is
 * open — `false` when the opener could not find out what the note says.
 *
 * `saveDay` STATES the note on every save, which is what makes the dialog safe
 * to open from a surface holding the text and unsafe from one that does not: an
 * empty box over a day that has a note destroys it on the next Save (#224).
 * There is a third answer, and it is this one: `PUT
 * /habits/:id/entries/:date` PRESERVES a `notes` it was not asked to change
 * (see `entryWrite`, `shared/src/validate.js`), so a dialog that does not know
 * the note can simply not mention it — the day is still fully editable and the
 * note is untouched, which is strictly better than refusing to open.
 *
 * The one surface that reaches it is `ui/dashboard.js`'s `editDay`, whose
 * `GET /habits/:id/entries` failed — offline, with nothing in the worker's
 * cache for that habit. The box is hidden rather than disabled, because a
 * disabled empty box says "this day has no note", which is the one thing that
 * cannot be known here.
 */
let noteKnown = true;

/**
 * The same write, in the vocabulary `StripHost.edit` speaks.
 *
 * One expression rather than a branch at the call site: `'clear'|'skip'|number`
 * is the union the method and body below already switch on, so there is nothing
 * to keep in step — the same argument `writeDay` (`ui/day-strip.js`) makes for
 * having one function for all three writes.
 */
const asEdit = (body) => {
  if (body === null) return 'clear';
  if (body.status === 'skip') return 'skip';
  return body.value;
};

/**
 * @param habit    the habit whose day is being edited
 * @param date     ISO date being edited
 * @param value    what is recorded, if anything
 * @param isSkip   whether the day is flagged as a skip
 * @param noteText the note attached to the day — a string, `''` for a day with
 *   none, or **`null`** for a caller that could not find out. See `noteKnown`:
 *   `null` hides the box and leaves `notes` out of the write entirely, which is
 *   the one honest answer for a surface that does not hold the text.
 * @param host     the opening page's own day model, for a queued write
 */
export function openDayDialog(habit, date, value, isSkip, noteText = '', host = null) {
  // Assigned unconditionally, so a caller with no host can never inherit the
  // previous opener's.
  dayHost = host;
  // The encoding fields travel with the edit rather than the habit object, for
  // the reason the grid's own dialog holds an id: a refetch replaces every
  // habit in `state.habits` and can do it while a modal is open.
  state.dayEdit = {
    habitId: habit.id, date, type: habit.type,
    show_as: habit.show_as, target_type: habit.target_type,
    target_value: habit.target_value,
  };
  // The parameter's own `= ''` default is what keeps `undefined` out of this
  // comparison, so a caller passing nothing — every call site that predates the
  // third answer, including `ui/detail.js`'s `notesByDate[date]` for a day with
  // no note — lands on "no note" rather than on "unknown". That makes `!==
  // null` and `!= null` equivalent HERE, and the default is the load-bearing
  // half: remove it and an absent argument starts suppressing the box.
  noteKnown = noteText !== null;
  notes.value = noteKnown ? noteText : '';
  notesWrap.hidden = !noteKnown;

  // A measurable habit gets a number field; a yes/no habit gets exactly two
  // buttons. Only one of the two controls is ever present.
  const numeric = habit.type === 'numerical';
  // Shown as something to avoid: the two buttons are the fast answer — a clean
  // day is one tap, which is the whole reward — and the amount box stays,
  // because "three coffees" is a thing someone may want to record exactly and
  // a limit of two has no other way to say it.
  const avoided = isAvoided(habit);
  title.replaceChildren();
  const dayIcon = habitIcon(habit);
  // `.append` takes a bare string as well as a node — this avoids
  // `document.createTextNode`, which `daydialog.mjs`'s fake DOM (this function
  // is sliced out and run through `new Function`) has no `document` to call.
  if (dayIcon) title.append(dayIcon, ' ', habit.name);
  else title.append(habit.name);

  const pretty = formatDateLong(fromISOLocal(date));

  // Say what's being edited, and against what goal, so the input is unambiguous.
  const goal = numeric
    ? `${habit.target_type === 'at_most' ? 'at most' : 'at least'} ${showAmount(habit.target_value)}` +
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

/**
 * Send what the dialog holds, and then say what happened — including when the
 * answer is "it is in the outbox".
 *
 * **The queued path used to tell the user three untrue things at once.**
 * `dialog.close()` and `emit('change')` were both after the `await`, and
 * offline `api()` stages the write and THROWS (with `queued: true`) — so the
 * only other branch was `toast(e.message)`. The toast said *Saved offline —
 * will sync when you reconnect*, and behind it the dialog stayed OPEN on the
 * old value while both grids went on painting the pre-edit day, for a write
 * that really was going to land. The write was correct and durable throughout;
 * the three contradictions of it were the bug.
 *
 * So a queued write closes the dialog and repaints, which is what the strip's
 * own tap path has always done — `host.edit` then `host.repaint`, and after
 * #230 that repaint redraws the calendar beside the cells. Unlike `writeDay`
 * this edits AFTER the await rather than before it, and so never needs the undo
 * it hands back: `writeDay` paints first because a TAP has to show the next
 * state of the cycle immediately and roll back if the write turns out to have
 * failed, while here the dialog is modal, nothing can read the maps in
 * between, and by this point the answer is already known.
 *
 * `emit('change')` is deliberately NOT reached on that path. It is a refetch,
 * which offline cannot answer — it would toast a second failure and, worse,
 * could rebuild the page from the service worker's cached `/stats` and paint
 * the queued write straight back out. The same reason `writeDay` never reaches
 * `host.refresh()` for a queued tap.
 *
 * A GENUINE failure — anything ANSWERED, since only an unsent request carries
 * `queued` — leaves the dialog open on the value the server still holds and
 * says so, which is the one case the old code got right.
 */
async function saveDay(body) {
  const { habitId, date } = state.dayEdit ?? {};
  if (!habitId) return;
  // Read before the await: the box is what the user typed, and this is the same
  // string the request carries. `null` where the note is not known — the box is
  // hidden and holds nothing to read, and stating `''` from it would be the
  // #224 destruction this whole path exists to avoid. See `noteKnown`.
  const noteText = noteKnown ? notes.value.trim() : null;

  try {
    if (body === null) {
      await api(`/habits/${habitId}/entries/${date}`, { method: 'DELETE' });
    } else {
      // Notes ride along with whatever the day is being set to — unless this
      // dialog never learnt what the note says, where the key is OMITTED and
      // `entryWrite` preserves whatever is stored.
      await api(`/habits/${habitId}/entries/${date}`, {
        method: 'PUT',
        body: JSON.stringify(
          noteText === null ? { ...body } : { notes: noteText, ...body }),
      });
    }
  } catch (e) {
    toast(e.message);
    if (!e.queued) return;
    // The note goes with the value and the skip, which is what makes this
    // different from #230's tap: that one had nothing to plumb because a tap
    // states nothing about a note, and this dialog states all three — except
    // where it states two, and then `note` is left off for the same reason the
    // body above leaves it off. `undefined` is `StripHost.edit`'s own "this
    // write says nothing about the note", so the host's copy is not moved
    // either.
    dayHost?.edit(habitId, date, asEdit(body), noteText ?? undefined);
    dayHost?.repaint();
    dialog.close();
    return;
  }

  dialog.close();
  emit('change');
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
