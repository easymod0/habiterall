/**
 * A row of tappable day cells, and everything a tap on one means.
 *
 * This was the dashboard's, and only the dashboard's, until a habit's own page
 * wanted the same control — arriving there from a reminder, the only way to
 * record the day was the calendar card and the day editor behind it. The two
 * surfaces cannot share it by importing one another: `dashboard.js` already
 * imports `detail.js` (to open a habit), so the reverse is the cycle
 * `ui/store.js` exists to break. Hence a third module, which imports neither.
 *
 * **What lives here is the part that would otherwise be written twice**, and
 * four of its rules are here because a wrong version shipped: the avoided
 * inversion in `paintCheckbox`, asking whether the map HOLDS a date rather than
 * what it holds, the SKIP sentinel counting only for a boolean habit, and the
 * optimistic paint happening BEFORE the await. A second copy of any of them in
 * the same client is not the offline mirror the root `CLAUDE.md` licenses —
 * that rule costs a mirror and asks for it to be earned, and this one cannot
 * be. The amount dialog could not have been copied at all: it is built on ids
 * that must have exactly one owner, and this module is now it.
 *
 * **What deliberately does NOT live here is paging.** The dashboard pages by
 * asking for a different window (`state.gridEnd` → `/overview?end=`), because
 * it holds only the fortnight it requested; a habit's own page holds its whole
 * history already and pages by slicing memory through `windowedChart`. Two
 * mechanisms — and note it is what each ASKS FOR that differs, not whether
 * either touches the network, since the detail page's `redraw` refetches like
 * every other card on it. Each host keeps its own.
 *
 * ## The host
 *
 * Everything storage-shaped is the caller's, because the two surfaces hold the
 * same days in different shapes: `/overview` gives `{date: value}` plus a
 * `skips` ARRAY and flattens a skip onto the SKIP wire value, while
 * `/habits/:id/entries` gives rows carrying `status` separately. A host
 * therefore answers what a day currently is, applies a change to its own model
 * and hands back an undo, and says how to repaint and how to reload.
 *
 * A host is a module-level SINGLETON, never built per render. The amount dialog
 * outlives a rebuild — that is why `counting` below holds a habit id rather
 * than the habit — and a host captured in a closure would answer from maps a
 * rebuild has since orphaned.
 *
 * @typedef {{value: number|undefined, isSkip: boolean}} DayCell
 *   `value: undefined` means NO ROW, which is a different day from a stored 0.
 *
 * @typedef {object} StripHost
 * @property {(habitId: number) => any|null} habit  as this host holds it NOW
 * @property {(habitId: number, date: string) => DayCell} read
 * @property {(habitId: number, date: string, to: 'clear'|'skip'|number)
 *   => (() => void)} edit  apply to the host's own model; return an undo
 * @property {() => void} repaint            cheap and local
 * @property {() => Promise<void>} refresh   authoritative reload
 */

import { api } from '/shared/ui/api.js';
import { habitIcon } from '/shared/ui/components.js';
import { gridCountField } from '/shared/ui/count-field.js';
import {
  formatDateLong, formatDayNumber, formatMonthShort, fromISOLocal, iso,
  weekdayLetters,
} from '/shared/ui/dates.js';
import * as settings from '/shared/ui/settings.js';
import {
  DAY, dayStateOf, isAvoided, nextDayState, valueForState,
} from '/shared/ui/toggle.js';
import { toast } from '/shared/ui/toast.js';
import { SKIP, YES } from '/shared/ui/values.js';

const $ = (sel) => document.querySelector(sel);

/* ---------- painting one cell ---------- */

/**
 * Paint one checkbox for a habit's day.
 *
 * @param box          the `.check-box` span
 * @param habit
 * @param value        what the entries map HELD, or `undefined` for no row
 * @param isSkip       whether the host reports this date as a skip
 * @param showUnknown  the `questionMarks` setting: draw `?` where there is no row
 *
 * The skip flag is why this takes more than three arguments. `/overview`
 * flattens a skip onto the SKIP wire value so the grid has something paintable,
 * *and* lists the date in `skips` — and the second is the only one that can be
 * trusted, because 3 is a legitimate amount for a measurable habit. Reading the
 * sentinel alone painted "3 pages" and "3 cigarettes" as skipped days, while the
 * score behind them counted the 3: the cell disagreed with every figure computed
 * from it. The bare sentinel still counts for a *boolean* habit, where it cannot
 * mean anything else and is what an imported Loop history carries — the same
 * rule as `normalizeEntry` in shared/src/stats.js.
 */
function paintCheckbox(box, habit, value, isSkip = false, showUnknown = false) {
  box.textContent = '';
  box.style.background = 'var(--grid-empty)';
  box.style.color = '#fff';
  // Reset the two properties the branches below set conditionally. Harmless
  // when this builds a fresh span, load bearing when `repaintCells` re-runs it
  // over a cell that is already painted: a day going from 3 to done kept the
  // 9.5px type and the faded opacity of the number it used to show.
  box.style.opacity = '';
  box.style.fontSize = '';

  if (isSkip || (habit.type === 'boolean' && value === SKIP)) {
    box.style.background = 'var(--surface-2)';
    box.style.color = 'var(--text-dim)';
    box.textContent = '–';
    return;
  }

  // No row at all. Identical to a stated "no" unless question marks are on —
  // except on a habit whose unlogged days already count as kept, where a "no"
  // is a real miss and this is not: `unlogged_is_success` is server-resolved
  // (`unansweredCounts`), so this checkbox never recomputes the precedence
  // itself. The ghost tick replaces the `?` rather than sitting beside it —
  // one glyph, one slot, the same rule `charts.js`'s calendar block follows.
  if (value == null) {
    if (habit.unlogged_is_success) {
      box.style.color = habit.color;
      box.style.opacity = '0.45';
      box.textContent = '✓';
    } else if (showUnknown) {
      box.style.color = 'var(--text-dim)';
      box.textContent = '?';
    }
    return;
  }

  if (habit.type === 'boolean') {
    if (value === YES) {
      box.style.background = habit.color;
      box.textContent = '✓';
    }
    return;
  }

  // Shown as something to avoid: a clean day is the achievement and a slip is
  // the thing to see, so the colours are the other way round. Painting a slip
  // in the habit's own colour — which is what the at-most branch below does,
  // correctly, for a habit read as an amount — reads as having done well.
  if (isAvoided(habit)) {
    const target = Number(habit.target_value) || 0;
    if (value <= target) {
      box.style.background = habit.color;
      box.textContent = '✓';
    } else {
      // The count, because how far over matters on a limit of two coffees and
      // is the whole answer on a limit of none.
      box.style.background = 'var(--danger)';
      box.style.color = '#fff';
      box.textContent = target === 0 && value === 1
        ? '✗'
        : (value % 1 === 0 ? String(value) : value.toFixed(1));
      box.style.fontSize = '9.5px';
    }
    return;
  }

  // numerical: shade by progress toward target, show the raw number.
  // For an "at most" habit a low number is the good outcome, so 0 is a full
  // success and must be painted, not left blank.
  if (habit.target_type === 'at_most') {
    const target = habit.target_value;
    // Fade gradually past the target; scale by 3 when the target is 0 so
    // small overages remain distinguishable.
    const scale = Math.max(target, 3);
    const ratio = value <= target
      ? 1
      : Math.max(0.2, 1 - (value - target) / scale);
    box.style.background = habit.color;
    box.style.opacity = String(ratio);
  } else {
    const target = habit.target_value || 1;
    const ratio = Math.min(1, value / target);
    if (value > 0) {
      box.style.background = habit.color;
      box.style.opacity = String(Math.max(0.28, ratio));
    }
  }
  box.textContent = value % 1 === 0 ? String(value) : value.toFixed(1);
  box.style.fontSize = '9.5px';
}

/* ---------- building the row ---------- */

/**
 * The tappable cells for one habit over a run of dates.
 *
 * @param {StripHost} host
 * @param {any} habit
 * @param {Date[]} dates  in the order they are to be drawn
 * @param {string} todayIso
 * @returns {HTMLElement} a `.checks` element
 */
export function dayCells(host, habit, dates, todayIso) {
  const checks = document.createElement('div');
  checks.className = 'checks';

  for (const d of dates) {
    const date = iso(d);
    const { value, isSkip } = host.read(habit.id, date);
    const btn = document.createElement('button');
    btn.className = 'check' + (date === todayIso ? ' today' : '');
    btn.title = `${habit.name} — ${date}`;
    btn.dataset.focusKey = `check:${habit.id}:${date}`;
    // Read back by `repaintCells`, which needs to know which day a cell is
    // about without re-deriving it from the focus key — that key is an
    // identity for the focus restore and must stay free to change shape.
    btn.dataset.date = date;

    const box = document.createElement('span');
    box.className = 'check-box';
    paintCheckbox(box, habit, value, isSkip, settings.get('questionMarks'));

    const day = document.createElement('span');
    day.className = 'check-day';
    day.textContent = weekdayLetters()[d.getDay()];

    btn.append(box, day);
    btn.addEventListener('click', () => onCheckClick(host, habit.id, date));
    checks.append(btn);
  }

  return checks;
}

/**
 * The date captions above a run of cells.
 *
 * @param {Date[]} dates
 * @param {string} todayIso
 * @returns {HTMLElement} a `.grid-dates` element
 */
export function dateColumns(dates, todayIso) {
  const cols = document.createElement('div');
  cols.className = 'grid-dates';
  for (const [i, d] of dates.entries()) {
    const cell = document.createElement('div');
    const dIso = iso(d);
    cell.className = 'grid-date' + (dIso === todayIso ? ' is-today' : '');
    // Only show the month on the first column and when it CHANGES, so the row
    // stays readable at seven columns on a phone.
    //
    // The change is read from the month NAME, not from `getDate() === 1`.
    // The first of the Gregorian month is not where a Persian or Hijri month
    // turns, so keying the caption on it put `مرداد` about nine days into the
    // month it names — the same mistake `formatYear`'s comment records for the
    // year caption, which was fixed there and left here.
    const dayNum = document.createElement('span');
    dayNum.className = 'grid-date-num';
    dayNum.textContent = formatDayNumber(d);
    const mon = document.createElement('span');
    mon.className = 'grid-date-mon';
    const monthText = formatMonthShort(d);
    const prev = dates[i - 1];
    mon.textContent = !prev || formatMonthShort(prev) !== monthText ? monthText : '';
    cell.append(mon, dayNum);
    cols.append(cell);
  }
  return cols;
}

/**
 * Re-run the paint over cells that already exist, replacing no DOM at all.
 *
 * The cheap repaint, for a host whose full rebuild is expensive. The dashboard
 * does not use it — `paint()` also redraws each row's score and streak line —
 * but a habit's own page rebuilds through a refetch and up to ten cards of SVG,
 * which is far too much to spend on a tap. Touching no nodes also means the
 * button the user just pressed is still the same element, so keyboard focus
 * survives the optimistic step without anyone restoring it.
 *
 * @param {ParentNode} root  the element the cells were appended under
 * @param {StripHost} host
 * @param {any} habit
 */
export function repaintCells(root, host, habit) {
  const showUnknown = settings.get('questionMarks');
  for (const btn of root.querySelectorAll('.check[data-date]')) {
    const date = /** @type {HTMLElement} */ (btn).dataset.date;
    const box = btn.querySelector('.check-box');
    if (!box) continue;
    const { value, isSkip } = host.read(habit.id, date);
    paintCheckbox(/** @type {HTMLElement} */ (box), habit, value, isSkip, showUnknown);
  }
}

/* ---------- what a tap does ---------- */

/**
 * Write one day, paint it before the request, and put it back if the request
 * turns out not to have been made.
 *
 * One function for all three writes — clear, skip, and an amount — because
 * every line of it is a rule that must not exist in only some of them. The
 * `'clear' | 'skip' | number` union is the same vocabulary the method and body
 * below switch on, so there is nothing to keep in step.
 *
 * The optimistic edit happens BEFORE the await, and that ordering is the whole
 * point. Offline, `api()` enqueues the write and then throws, so anything after
 * the await is skipped — which used to leave the host's model stale. The next
 * tap then recomputed the cycle from the same starting value and queued another
 * identical write: three offline taps meaning "clear this day" all queued
 * `value: 2`, and the day synced as DONE, with the cell blank the whole time so
 * nothing hinted anything was wrong.
 *
 * @param {StripHost} host
 * @param {any} habit
 * @param {string} date
 * @param {'clear'|'skip'|number} to
 */
async function writeDay(host, habit, date, to) {
  const undo = host.edit(habit.id, date, to);
  host.repaint();

  try {
    await api(`/habits/${habit.id}/entries/${date}`, to === 'clear'
      ? { method: 'DELETE' }
      : {
        method: 'PUT',
        // A skip is the status column, never a value. Writing the SKIP
        // sentinel works for a yes/no habit — `parseEntry` reads 3 as a skip
        // there — and silently stores three of the thing on a measurable one,
        // which is what an avoided habit is underneath.
        body: JSON.stringify(to === 'skip' ? { status: 'skip' } : { value: to }),
      });
  } catch (e) {
    // A queued write will still land, so the optimistic state is correct and
    // must stand. Any other failure did not reach the server, so roll back
    // rather than leave the UI asserting something untrue.
    if (!e.queued) {
      undo();
      host.repaint();
    }
    throw e;
  }

  // Re-read, so everything computed from this day moves with it.
  await host.refresh();
}

/**
 * The tap cycle, or the amount dialog.
 *
 * Takes a habit ID rather than the habit for the reason `counting` does: a
 * refetch can replace every habit object between the cell being built and the
 * cell being pressed, and writing against an orphan leaves the repaint drawing
 * the old value.
 */
async function onCheckClick(host, habitId, date) {
  const habit = host.habit(habitId);
  if (!habit) return;

  try {
    // A habit shown as something to avoid CYCLES rather than asking for a
    // number, which is the whole of what the rendering buys: the answer is
    // yes-or-no, and typing an amount to say "none today" is the friction it
    // exists to remove. `valueForState` is what makes the same four states
    // record different values — see ui/toggle.js.
    if (habit.type !== 'boolean' && !isAvoided(habit)) {
      // A measurable day is asked for rather than cycled to, and the answer
      // comes back through `saveCount` into the very same `writeDay`.
      return openCountDialog(host, habit, date);
    }

    // Loop's cycle, and both of its switches — `ui/toggle.js` owns it and the
    // native client mirrors it. Note what the host is asked for: whether a row
    // EXISTS, not what it holds. `entries[date] ?? UNSET` was fine while a
    // lapse and an unanswered day were one state; now it would report every
    // untouched day as an answered "no" and start the cycle in the wrong place.
    const { value, isSkip } = host.read(habit.id, date);
    const current = dayStateOf({
      value,
      isSkip: isSkip || (habit.type === 'boolean' && value === SKIP),
      // What counts as done differs: `YES` for a yes/no habit, and being at
      // or under the limit for one being avoided, where 0 is the goal.
      done: isAvoided(habit) ? value <= (Number(habit.target_value) || 0) : value === YES,
    });
    const to = nextDayState(current, {
      skipDays: settings.get('skipDays'),
      questionMarks: settings.get('questionMarks'),
    });

    if (to === DAY.UNKNOWN) return await writeDay(host, habit, date, 'clear');
    if (to === DAY.SKIP) return await writeDay(host, habit, date, 'skip');
    await writeDay(host, habit, date, valueForState(habit, to));
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- recording an amount ---------- */

const countDialog = $('#count-dialog');
const countTitle = $('#count-title');
const countSub = $('#count-sub');
const countClear = $('#count-clear');

/**
 * Which host, habit and day the dialog is editing, while it is open.
 *
 * The habit's ID rather than the habit, which is the shape `day-dialog.js`
 * already uses and for a reason that bites here: a refetch REPLACES every habit
 * object, and it can run while this dialog is open — a reconnect flush emits
 * `'reload'`, and so does the visibility sync. Holding the object meant the
 * optimistic write landed on an orphan and the repaint, which reads the host's
 * own model, went on drawing the old cell. Online the trailing refetch hides
 * it; offline there is no refetch, so the grid asserts one amount while a
 * different one sits in the outbox — precisely what the comment on `writeDay`
 * exists to prevent, arriving through the door the synchronous `prompt()` used
 * to hold shut.
 *
 * The HOST is held too, because two surfaces can open this dialog and only the
 * one that opened it knows where the answer goes.
 */
let counting = null;

/**
 * Ask for an amount, over a strip.
 *
 * This is a dialog rather than the day editor, which also has an amount field:
 * the day editor writes through its own `saveDay`, which awaits the request and
 * then announces, while a check-off from a strip has to go through `writeDay`
 * above — optimistic paint first, because offline `api()` queues the write and
 * THEN throws, so anything after the await is skipped. Routing a strip's writes
 * through the other path would undo the whole comment on `writeDay`.
 */
function openCountDialog(host, habit, date) {
  // A skipped day has no amount to prefill: for a measurable habit the SKIP
  // wire value is a legitimate amount, so the skip is what says the day has no
  // number rather than the value doing it.
  const { value, isSkip } = host.read(habit.id, date);
  const current = isSkip ? null : value;

  counting = { host, habitId: habit.id, date };
  countTitle.replaceChildren();
  const countIcon = habitIcon(habit);
  if (countIcon) countTitle.append(countIcon, ' ');
  countTitle.append(document.createTextNode(habit.name));
  // The date in words. A grid cell is a square in a row of squares, so the
  // dialog has to say which day it is about — the ISO string reads as a serial
  // number, and the whole risk of an editable history is fixing the wrong one.
  countSub.textContent = formatDateLong(fromISOLocal(date))
    + (habit.unit ? ` · ${habit.unit}` : '');
  // Whether a ROW exists, not whether there is an amount to show. A skipped
  // day has a row and `current` is nulled above so the SKIP sentinel is not
  // prefilled as an amount — deriving the button from that hid Clear on the
  // one kind of day that most needs it, since this dialog has no Unskip.
  countClear.hidden = !isSkip && value == null;
  gridCountField.set(habit, current);
  countDialog.showModal();
  gridCountField.focus();
}

async function saveCount() {
  if (!counting) return;
  // Three answers and two of them are falsy, so `===` is load bearing — see
  // the day editor, which had this collapsed and deleted days because of it.
  const amount = gridCountField.value();
  if (amount === null) return gridCountField.complain();

  const { host, date } = counting;
  const habit = host.habit(counting.habitId);
  countDialog.close();
  counting = null;
  // Deleted, or archived out of the list, while the dialog was open. Said out
  // loud: the dialog has already closed, so returning quietly is a Save that
  // looks exactly like one that worked.
  if (!habit) return toast('That habit is no longer on the list — nothing was saved.');

  try {
    await writeDay(host, habit, date, amount === '' ? 'clear' : amount);
  } catch (e) {
    // Toasted whatever it is, exactly as the boolean tap does. A QUEUED write
    // throws too, carrying "Saved offline — will sync when you reconnect", and
    // swallowing that took the confirmation away from the one path where the
    // user had just filled in a form and pressed Save.
    toast(e.message);
  }
}

export function init() {
  $('#count-cancel').addEventListener('click', () => { countDialog.close(); counting = null; });
  $('#count-save').addEventListener('click', saveCount);
  countClear.addEventListener('click', async () => {
    // Clearing takes the day back to having no row at all, which is the one
    // thing an empty box also does — but a button says so, where an empty box
    // is something you have to know. Both go through `writeDay(…, 'clear')`.
    if (!counting) return;
    const { host, date } = counting;
    const habit = host.habit(counting.habitId);
    countDialog.close();
    counting = null;
    if (!habit) return toast('That habit is no longer on the list — nothing was cleared.');
    try {
      await writeDay(host, habit, date, 'clear');
    } catch (e) {
      toast(e.message);
    }
  });
  gridCountField.onEnter(saveCount);
}
