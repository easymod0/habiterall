/**
 * The habit list: the day grid, its column header and paging, the empty
 * state, drag reordering, and what a checkbox tap does.
 *
 * Owns `#grid`, `#grid-head`, `#list-head`, `#toggle-archived`, `#empty` and
 * the starter panel inside it.
 */

import { api } from '/shared/ui/api.js';
import { openDataDialog } from '/shared/ui/data-dialog.js';
import {
  addDaysISO, datesEndingOn, freqLabel, fromISOLocal, iso, targetLabel, todayISO,
} from '/shared/ui/dates.js';
import { openDialog } from '/shared/ui/habit-dialog.js';
import * as routes from '/shared/ui/routes.js';
import { gridCountField } from '/shared/ui/count-field.js';
import * as settings from '/shared/ui/settings.js';
import { on, state } from '/shared/ui/store.js';
import {
  DAY, dayStateOf, isAvoided, nextDayState, valueForState,
} from '/shared/ui/toggle.js';
import { toast } from '/shared/ui/toast.js';
import { SKIP, UNSET, YES } from '/shared/ui/values.js';
import * as views from '/shared/ui/views.js';
import { open as openHabit } from '/shared/ui/detail.js';

const $ = (sel) => document.querySelector(sel);

const grid = $('#grid');
const gridHead = $('#grid-head');
const listHead = $('#list-head');
const toggleArchived = $('#toggle-archived');
const empty = $('#empty');
const emptyArchived = $('#empty-archived');
const emptyNoMatch = $('#empty-nomatch');
const searchRow = $('#search-row');
const searchInput = /** @type {HTMLInputElement} */ ($('#habit-search'));
const searchCount = $('#search-count');
const starters = $('#starters');
// querySelectorAll yields Element, which has no `hidden`; these are all
// HTMLElements in practice.
const emptyOnboarding = /** @type {HTMLElement[]} */ ([...document.querySelectorAll(
  // Both of the specifically-addressed lines are excluded: they are shown by
  // their own rule, and the onboarding sweep would otherwise fight it.
  '.empty-title, .empty-sub:not(#empty-archived):not(#empty-nomatch),'
  + ' #starters, .empty-actions, .empty-note'
)]);

const GRID_DAYS = 14;         // most columns we will ever show
const GRID_DAYS_NARROW = 7;   // phone layout: fewer, wider columns
const GRID_DAYS_MEDIUM = 10;  // tablets, where 14 would crush the habit name

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * How many day columns fit without squeezing the habit name out of existence.
 *
 * Chosen from the actual viewport width rather than a single breakpoint: at
 * 768px the 14-column desktop layout needed 668px of a 698px row, leaving
 * nothing for the name. Under 640px the CSS switches to flexible columns, so
 * the narrow count applies there.
 */
function gridDays() {
  const w = window.innerWidth;
  if (w <= 640) return GRID_DAYS_NARROW;
  if (w <= 900) return GRID_DAYS_MEDIUM;
  return GRID_DAYS;
}

export async function load() {
  // Always request the widest column count so a rotation to landscape needs
  // no refetch, and the window the user is actually looking at — paging back
  // must bring its entries with it.
  const params = new URLSearchParams({ days: String(GRID_DAYS) });
  if (state.gridEnd) params.set('end', state.gridEnd);
  if (state.showArchived) params.set('archived', 'true');
  const data = await api(`/overview?${params}`);
  state.habits = data.habits;

  // The archive toggle is pointless until something has been archived.
  const archived = await api('/habits?archived=true');
  state.hasArchived = archived.length > 0;

  paint();
}

/**
 * How many habits it takes before a search box earns its place.
 *
 * #74's own framing: "fine at eight habits and unpleasant at thirty". A control
 * above a list of four is clutter, and one that appears at exactly the moment
 * you need it is better than one that is always there. Read from the UNFILTERED
 * count, or the box would vanish under the cursor the moment a query narrowed
 * the list past the threshold.
 */
const SEARCH_FROM = 6;

/** Fold case and strip the accents, so "cafe" finds "Café". */
const fold = (s) => String(s ?? '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/**
 * The habits the list is showing.
 *
 * A filter over what is already in memory — no API change, no schema change,
 * and it works offline, which is what makes this the cheap half of #74. Name
 * and description, because a habit called "Gym" whose description says
 * "swimming Tuesdays" is one people look for by the second.
 */
function visibleHabits() {
  const query = fold(state.query).trim();
  if (!query) return state.habits;
  return state.habits.filter((h) =>
    fold(h.name).includes(query) || fold(h.description).includes(query));
}

export function paint() {
  state.openHabitId = null;
  // The URL follows the view. Cheap to call on every repaint — and this is
  // called on every check-off — because `go` does nothing when the address bar
  // already says this.
  routes.go(routes.LIST);
  const root = views.showList();

  // Everything below is rebuilt from scratch, which destroys whatever had
  // keyboard focus. A check-off repaints twice — optimistically, then again
  // after the refetch — so without this, tabbing to a checkbox and pressing
  // Enter dropped focus to <body> and the next Tab started from the top of
  // the page. Same for the paging arrows, which `shiftGrid` rebuilds.
  const focused = focusKeyOf(document.activeElement);

  grid.replaceChildren();

  listHead.hidden = !state.hasArchived;
  toggleArchived.textContent = state.showArchived ? 'Show active' : 'Show archived';
  toggleArchived.setAttribute('aria-pressed', String(state.showArchived));

  // The onboarding panel is only for a genuinely empty tracker; an empty
  // archive view just needs a line of text.
  const shown = visibleHabits();
  // `shown` can only be shorter when there is a query, so this IS the query —
  // written as the question being asked rather than as a comparison that reads
  // like it guards a case it cannot reach.
  const filtering = !!state.query.trim();

  // The box appears once there are enough habits to lose one in, and never
  // disappears while a query is in it.
  // ...and never while it has the caret. Below the threshold, clearing the
  // query — by Escape, by Chrome's own ×, or by backspacing the last character
  // — would otherwise hide the row out from under the cursor and drop focus to
  // <body>.
  searchRow.hidden = state.habits.length < SEARCH_FROM
    && !state.query
    && document.activeElement !== searchInput;
  if (searchInput.value !== state.query) searchInput.value = state.query;
  searchCount.textContent = filtering
    ? `${shown.length} of ${state.habits.length}`
    : '';

  // An empty ACCOUNT gets the onboarding panel; an empty RESULT gets a
  // sentence. Offering "create your first habit" to someone who has thirty and
  // mistyped one would be the app forgetting what it holds.
  const isEmpty = state.habits.length === 0;
  const noMatch = !isEmpty && shown.length === 0;
  empty.hidden = !isEmpty && !noMatch;
  emptyArchived.hidden = !(isEmpty && state.showArchived);
  emptyNoMatch.hidden = !noMatch;
  for (const el of emptyOnboarding) el.hidden = !(isEmpty && !state.showArchived);

  if (isEmpty && !state.showArchived) renderStarters();

  const todayIso = todayISO();
  // datesEndingOn always returns oldest-first; flip it when the user wants
  // today on the left. Everything downstream just walks the array.
  const dates = datesEndingOn(gridDays(), state.gridEnd ?? todayIso);
  if (settings.get('dayOrder') === 'newest-left') dates.reverse();
  renderGridHeader(dates, todayIso);

  for (const habit of shown) {
    const row = document.createElement('div');
    row.className = 'habit-row' + (habit.archived ? ' archived' : '');
    row.dataset.habitId = String(habit.id);

    // Drag handle. Reordering only makes sense in the active list, and only
    // when there is more than one habit to move.
    // ...and not while a filter is on. Dragging only means something in the
    // list's real order: a drop against a filtered list computes a `position`
    // from neighbours that are not the habit's actual neighbours, so the write
    // lands somewhere nobody asked for and the rows appear to jump when the
    // query is cleared. `persistOrder` sends the rendered order, which is
    // exactly what must not be a subset.
    const reorderable =
      !state.showArchived && !filtering && state.habits.length > 1;
    if (reorderable) {
      const handle = document.createElement('button');
      handle.className = 'drag-handle';
      handle.type = 'button';
      handle.draggable = true;
      handle.textContent = '⠿';
      handle.title = 'Drag to reorder — or focus and use ↑ / ↓';
      handle.setAttribute('aria-label', `Reorder ${habit.name}. Use arrow up or arrow down.`);
      handle.dataset.focusKey = `handle:${habit.id}`;
      attachDragHandlers(handle, row, habit);
      row.append(handle);
    }

    const meta = document.createElement('div');
    meta.className = 'habit-meta';
    meta.setAttribute('role', 'button');
    meta.tabIndex = 0;

    const name = document.createElement('div');
    name.className = 'habit-name';
    const dot = document.createElement('span');
    dot.className = 'habit-dot';
    dot.style.background = habit.color;
    name.append(dot, document.createTextNode(habit.name));

    const sub = document.createElement('div');
    sub.className = 'habit-sub';
    const bits = [
      freqLabel(habit),
      targetLabel(habit),
      `${Math.round(habit.score * 100)}%`,
      habit.currentStreak > 0 ? `🔥 ${habit.currentStreak}` : '',
    ].filter(Boolean);
    sub.textContent = bits.join(' · ');

    meta.append(name, sub);
    meta.addEventListener('click', () => openHabit(habit.id));
    meta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHabit(habit.id); }
    });

    const checks = document.createElement('div');
    checks.className = 'checks';

    for (const d of dates) {
      const date = iso(d);
      const value = habit.entries[date];
      const btn = document.createElement('button');
      btn.className = 'check' + (date === todayIso ? ' today' : '');
      btn.title = `${habit.name} — ${date}`;
      btn.dataset.focusKey = `check:${habit.id}:${date}`;

      const box = document.createElement('span');
      box.className = 'check-box';
      paintCheckbox(box, habit, value, habit.skips?.includes(date) ?? false,
        settings.get('questionMarks'));

      const day = document.createElement('span');
      day.className = 'check-day';
      day.textContent = DAY_LETTERS[d.getDay()];

      btn.append(box, day);
      btn.addEventListener('click', () => onCheckClick(habit, date));
      checks.append(btn);
    }

    row.append(meta, checks);
    grid.append(row);
  }

  restoreFocus(root, focused);
}

/* ---------- keeping focus across a repaint ---------- */

/**
 * The identity of a control that survives being rebuilt.
 *
 * Every focusable thing `paint()` recreates carries a `data-focus-key` that
 * names *what it is* rather than where it sat, so the restore still lands
 * after a reorder moves the row or a refetch rebuilds the grid. A key that no
 * longer exists — the column you were on after paging away — simply does not
 * match, which is the right answer rather than a special case.
 */
function focusKeyOf(el) {
  return el instanceof HTMLElement ? el.dataset.focusKey ?? null : null;
}

function restoreFocus(root, key) {
  if (!key) return;

  // Compared rather than selected: a key carries a habit name or a date, and
  // building a selector out of either needs escaping that is easy to get
  // wrong and pointless here.
  const match = [...root.querySelectorAll('[data-focus-key]')]
    .find((el) => el.dataset.focusKey === key);
  if (!match) return;

  // The control can survive but stop being operable — pressing Today disables
  // it, since there is nowhere left to jump to. `.focus()` on a disabled
  // button is a no-op, so fall back to its nearest working neighbour rather
  // than leaving the keyboard at the top of the document.
  if (!/** @type {HTMLButtonElement} */ (match).disabled) {
    match.focus();
    return;
  }
  const sibling = [...(match.parentElement?.querySelectorAll('[data-focus-key]') ?? [])]
    .find((el) => !(/** @type {HTMLButtonElement} */ (el).disabled));
  /** @type {HTMLElement} */ (sibling)?.focus();
}

/**
 * Column header: the month/day above each column, plus navigation.
 *
 * Without this the grid showed only weekday letters, so there was no way to
 * tell which column was which date — or to look at any day but the most
 * recent fortnight.
 */
function renderGridHeader(dates, todayIso) {
  gridHead.replaceChildren();
  if (!state.habits.length) { gridHead.hidden = true; return; }
  gridHead.hidden = false;

  const label = document.createElement('span');
  label.className = 'grid-range';
  label.textContent = rangeLabel(dates);

  const nav = document.createElement('div');
  nav.className = 'grid-nav';

  const step = gridDays();

  // The arrows follow the layout, not the calendar: when today sits on the
  // left, "back in time" is to the RIGHT, so the glyphs swap. An arrow that
  // points away from the direction the days actually move is worse than no
  // arrow at all.
  const newestLeft = settings.get('dayOrder') === 'newest-left';
  const olderGlyph = newestLeft ? '›' : '‹';
  const newerGlyph = newestLeft ? '‹' : '›';

  const mk = (key, text, aria, delta, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm';
    b.textContent = text;
    b.setAttribute('aria-label', aria);
    b.disabled = disabled;
    b.dataset.focusKey = key;
    b.addEventListener('click', () => shiftGrid(delta));
    return b;
  };

  // Never scroll past today: there is nothing to record in the future.
  const atToday = (state.gridEnd ?? todayIso) >= todayIso;

  // "Today" is rendered FIRST and always present — merely made invisible when
  // it has nothing to do. Appending it conditionally after the arrows shifted
  // them sideways the moment you paged back, so the pointer was no longer over
  // the button it had just clicked.
  const today = document.createElement('button');
  today.type = 'button';
  today.className = 'btn btn-sm';
  today.textContent = 'Today';
  today.dataset.focusKey = 'nav:today';
  today.addEventListener('click', () => {
    state.gridEnd = null;
    load().catch((e) => toast(e.message));
  });
  if (atToday) {
    // visibility, not `hidden`: the slot must keep its width.
    today.style.visibility = 'hidden';
    today.disabled = true;
    today.tabIndex = -1;
    today.setAttribute('aria-hidden', 'true');
  }
  nav.append(today);

  // Order the arrows so they read left-to-right in the direction they move.
  const older = mk('nav:older', olderGlyph, `Previous ${step} days`, -step);
  const newer = mk('nav:newer', newerGlyph, `Next ${step} days`, step, atToday);
  nav.append(...(newestLeft ? [newer, older] : [older, newer]));

  // Date row, aligned to the checkbox columns below.
  const cols = document.createElement('div');
  cols.className = 'grid-dates';
  for (const d of dates) {
    const cell = document.createElement('div');
    const dIso = iso(d);
    cell.className = 'grid-date' + (dIso === todayIso ? ' is-today' : '');
    // Only show the month on the first column and when it changes, so the
    // row stays readable at seven columns on a phone.
    const dayNum = document.createElement('span');
    dayNum.className = 'grid-date-num';
    dayNum.textContent = String(d.getDate());
    const mon = document.createElement('span');
    mon.className = 'grid-date-mon';
    mon.textContent = d.getDate() === 1 || d === dates[0] ? MONTHS[d.getMonth()] : '';
    cell.append(mon, dayNum);
    cols.append(cell);
  }

  gridHead.append(label, nav, cols);
}

/** "3 – 16 Aug 2026", collapsing the repeated month and year. */
function rangeLabel(dates) {
  // The label always reads oldest to newest, whichever way the row is drawn.
  const [a, b] = dates[0] <= dates[dates.length - 1]
    ? [dates[0], dates[dates.length - 1]]
    : [dates[dates.length - 1], dates[0]];
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const left = sameMonth ? String(a.getDate()) : `${a.getDate()} ${MONTHS[a.getMonth()]}`;
  return `${left} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
}

/** Move the visible window, clamped so it never runs past today. */
function shiftGrid(deltaDays) {
  const today = todayISO();
  let next = addDaysISO(state.gridEnd ?? today, deltaDays);
  if (next > today) next = today;
  state.gridEnd = next === today ? null : next;
  // Refetch, not just re-render: the entries for the new window have not been
  // loaded, and re-rendering alone would draw an empty grid.
  load().catch((e) => toast(e.message));
}

/* ---------- empty state ---------- */

/**
 * A few one-click starters covering both habit types and a non-daily
 * frequency, so a new tracker isn't a blank page. Everything stays editable.
 */
const STARTERS = [
  { name: 'Meditate', description: '10 minutes after waking', type: 'boolean',
    color: '#8b5cf6', freq_numerator: 1, freq_denominator: 1 },
  { name: 'Exercise', description: '', type: 'boolean',
    color: '#f59e0b', freq_numerator: 3, freq_denominator: 7 },
  { name: 'Read', description: 'Pages before bed', type: 'numerical',
    unit: 'pages', target_value: 20, target_type: 'at_least', color: '#0ea5e9' },
  { name: 'Drink water', description: '', type: 'numerical',
    unit: 'glasses', target_value: 8, target_type: 'at_least', color: '#3b82f6' },
];

function renderStarters() {
  starters.replaceChildren();

  for (const preset of STARTERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'starter';
    btn.dataset.focusKey = `starter:${preset.name}`;

    const dot = document.createElement('span');
    dot.className = 'habit-dot';
    dot.style.background = preset.color;

    const label = document.createElement('span');
    label.className = 'starter-name';
    label.textContent = preset.name;

    const sub = document.createElement('span');
    sub.className = 'starter-sub';
    sub.textContent = [freqLabel(preset), targetLabel(preset)].filter(Boolean).join(' · ');

    btn.append(dot, label, sub);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('/habits', { method: 'POST', body: JSON.stringify(preset) });
        await load();
        toast(`Added "${preset.name}"`);
      } catch (e) {
        btn.disabled = false;
        toast(e.message);
      }
    });
    starters.append(btn);
  }
}

/* ---------- reordering ---------- */

/**
 * Wire a drag handle for both pointer drag-and-drop and keyboard arrows.
 * Keyboard support matters here: HTML5 drag events are unreachable by
 * keyboard and unreliable on touch.
 */
function attachDragHandlers(handle, row, habit) {
  handle.addEventListener('dragstart', (e) => {
    state.dragId = habit.id;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag without payload.
    e.dataTransfer.setData('text/plain', String(habit.id));
  });

  handle.addEventListener('dragend', () => {
    state.dragId = null;
    row.classList.remove('dragging');
    for (const r of grid.children) r.classList.remove('drop-above', 'drop-below');
  });

  row.addEventListener('dragover', (e) => {
    if (state.dragId == null || state.dragId === habit.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const box = row.getBoundingClientRect();
    const after = e.clientY > box.top + box.height / 2;
    row.classList.toggle('drop-below', after);
    row.classList.toggle('drop-above', !after);
  });

  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-above', 'drop-below');
  });

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    if (state.dragId == null || state.dragId === habit.id) return;
    const after = row.classList.contains('drop-below');
    row.classList.remove('drop-above', 'drop-below');
    moveHabit(state.dragId, habit.id, after);
  });

  handle.addEventListener('keydown', (e) => {
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    nudgeHabit(habit.id, delta);
  });
}

/** Move `dragId` to sit before or after `targetId`, then persist. */
function moveHabit(dragId, targetId, after) {
  const order = state.habits.map((h) => h.id);
  const from = order.indexOf(dragId);
  if (from === -1) return;

  order.splice(from, 1);
  let to = order.indexOf(targetId);
  if (to === -1) return;
  if (after) to += 1;
  order.splice(to, 0, dragId);

  persistOrder(order);
}

/**
 * Shift a habit one slot up or down. Keyboard focus follows the handle to its
 * new position because `paint()` restores it by `data-focus-key`, which names
 * the habit rather than the row it sat in.
 */
function nudgeHabit(habitId, delta) {
  const order = state.habits.map((h) => h.id);
  const from = order.indexOf(habitId);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= order.length) return;

  order.splice(to, 0, ...order.splice(from, 1));
  persistOrder(order);
}

/** Reorder optimistically so the list never appears to lag, then save. */
async function persistOrder(order) {
  const byId = new Map(state.habits.map((h) => [h.id, h]));
  const previous = state.habits;
  state.habits = order.map((id) => byId.get(id)).filter(Boolean);
  paint();

  try {
    await api('/habits/reorder', {
      method: 'POST',
      body: JSON.stringify({ order }),
    });
  } catch (e) {
    state.habits = previous; // put it back rather than lie about the order
    paint();
    toast(e.message);
  }
}

/* ---------- the checkboxes ---------- */

/**
 * @param isSkip       whether `/overview` listed this date in the habit's `skips`
 * @param showUnknown  the `questionMarks` setting: draw `?` where there is no row
 *
 * The skip flag is why this takes more than three arguments. `/overview` flattens
 * a skip onto the SKIP wire value so the grid has something paintable, *and*
 * lists the date in `skips` — and the second is the only one that can be trusted,
 * because 3 is a legitimate amount for a measurable habit. Reading the sentinel
 * alone painted "3 pages" and "3 cigarettes" as skipped days, while the score
 * behind them counted the 3: the cell disagreed with every figure computed from
 * it. The bare sentinel still counts for a *boolean* habit, where it cannot mean
 * anything else and is what an imported Loop history carries — the same rule as
 * `normalizeEntry` in shared/src/stats.js.
 */
function paintCheckbox(box, habit, value, isSkip = false, showUnknown = false) {
  box.textContent = '';
  box.style.background = 'var(--grid-empty)';
  box.style.color = '#fff';

  if (isSkip || (habit.type === 'boolean' && value === SKIP)) {
    box.style.background = 'var(--surface-2)';
    box.style.color = 'var(--text-dim)';
    box.textContent = '–';
    return;
  }

  // No row at all. Identical to a stated "no" unless question marks are on,
  // which is the entire visible difference the setting makes: `value` is
  // `undefined` here and `0` there, and both are a miss to every figure.
  if (value == null) {
    if (showUnknown) {
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

/**
 * Add or remove a date from a habit's `skips`, in place.
 *
 * The optimistic paths below edit `habit.entries` and then repaint, and since
 * the grid started reading `skips` to tell a skip from an amount, editing one
 * without the other leaves the cell asserting the old state. Offline that is
 * not a flash before the refetch corrects it: `api()` queues the write and
 * throws, so the refetch never runs and the cell stays wrong while taps
 * accumulate — the failure the long comment below was written to prevent,
 * arriving by a different door.
 *
 * @returns {boolean} whether the date was a skip before this call
 */
function setSkip(habit, date, on) {
  habit.skips ??= [];
  const was = habit.skips.includes(date);
  if (on && !was) habit.skips.push(date);
  if (!on && was) habit.skips = habit.skips.filter((d) => d !== date);
  return was;
}

/**
 * Take a day back to "unknown": no row at all.
 *
 * The one write that is a DELETE rather than a PUT, since `PUT {value: 0}` now
 * records a stated "no" — see `entryWrite`. Optimistic before the await for the
 * same reason as the writes below: offline, `api()` queues the request and
 * throws, so the cell would otherwise keep asserting a value just cleared.
 */
async function clearDay(habit, date) {
  const had = Object.hasOwn(habit.entries, date) ? habit.entries[date] : undefined;
  delete habit.entries[date];
  const wasSkip = setSkip(habit, date, false);
  paint();
  try {
    await api(`/habits/${habit.id}/entries/${date}`, { method: 'DELETE' });
  } catch (e) {
    if (!e.queued) {
      if (had !== undefined) habit.entries[date] = had;
      setSkip(habit, date, wasSkip);
      paint();
    }
    throw e;
  }
  await load();
}

/* ---------- recording an amount from the grid ---------- */

const countDialog = $('#count-dialog');
const countTitle = $('#count-title');
const countSub = $('#count-sub');
const countClear = $('#count-clear');

/**
 * Which habit and day the dialog is editing, while it is open.
 *
 * The habit's ID rather than the habit, which is the shape `day-dialog.js`
 * already uses and for a reason that bites here: `load()` REPLACES every
 * object in `state.habits`, and it can run while this dialog is open — a
 * reconnect flush emits `'reload'`, and so does the visibility sync. Holding
 * the object meant the optimistic write landed on an orphan and `paint()`,
 * which iterates `state.habits`, went on drawing the old cell. Online the
 * trailing refetch hides it; offline there is no refetch, so the grid asserts
 * one amount while a different one sits in the outbox — precisely what the
 * comment on `recordValue` exists to prevent, arriving through the door the
 * synchronous `prompt()` used to hold shut.
 */
let counting = null;

/**
 * Ask for an amount, over the grid.
 *
 * This is a dialog rather than the day editor, which also has an amount field:
 * the day editor writes through its own `saveDay`, which awaits the request and
 * then announces, while a check-off from the grid has to go through
 * `recordValue` below — optimistic paint first, because offline `api()` queues
 * the write and THEN throws, so anything after the await is skipped. Routing
 * the grid's writes through the other path would undo the whole comment on
 * `recordValue`.
 */
function openCountDialog(habit, date) {
  // A skipped day has no amount to prefill: for a measurable habit the SKIP
  // wire value is a legitimate amount, so the skip is what says the day has no
  // number rather than the value doing it.
  const skipped = habit.skips?.includes(date) ?? false;
  const current = skipped ? null : habit.entries[date];

  counting = { habitId: habit.id, date };
  countTitle.textContent = habit.name;
  // The date in words. A grid cell is a square in a row of squares, so the
  // dialog has to say which day it is about — the ISO string reads as a serial
  // number, and the whole risk of an editable history is fixing the wrong one.
  countSub.textContent = fromISOLocal(date).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  }) + (habit.unit ? ` · ${habit.unit}` : '');
  // Whether a ROW exists, not whether there is an amount to show. A skipped
  // day has a row and `current` is nulled above so the SKIP sentinel is not
  // prefilled as an amount — deriving the button from that hid Clear on the
  // one kind of day that most needs it, since this dialog has no Unskip.
  countClear.hidden = !skipped && habit.entries[date] == null;
  gridCountField.set(habit, current);
  countDialog.showModal();
  gridCountField.focus();
}

/** The habit this dialog is about, as `state.habits` holds it NOW. */
function countingHabit() {
  return state.habits.find((h) => h.id === counting?.habitId) ?? null;
}

async function saveCount() {
  if (!counting) return;
  // Three answers and two of them are falsy, so `===` is load bearing — see
  // the day editor, which had this collapsed and deleted days because of it.
  const amount = gridCountField.value();
  if (amount === null) return gridCountField.complain();

  const habit = countingHabit();
  const { date } = counting;
  countDialog.close();
  counting = null;
  // Deleted, or archived out of the list, while the dialog was open. Said out
  // loud: the dialog has already closed, so returning quietly is a Save that
  // looks exactly like one that worked.
  if (!habit) return toast('That habit is no longer on the list — nothing was saved.');

  try {
    if (amount === '') await clearDay(habit, date);
    else await recordValue(habit, date, amount);
  } catch (e) {
    // Toasted whatever it is, exactly as the boolean tap does. A QUEUED write
    // throws too, carrying "Saved offline — will sync when you reconnect", and
    // swallowing that took the confirmation away from the one path where the
    // user had just filled in a form and pressed Save.
    toast(e.message);
  }
}

async function onCheckClick(habit, date) {
  try {
    let next;
    // A habit shown as something to avoid CYCLES rather than asking for a
    // number, which is the whole of what the rendering buys: the answer is
    // yes-or-no, and typing an amount to say "none today" is the friction it
    // exists to remove. `valueForState` is what makes the same four states
    // record different values — see ui/toggle.js.
    if (habit.type === 'boolean' || isAvoided(habit)) {
      // Loop's cycle, and both of its switches — `ui/toggle.js` owns it and the
      // native client mirrors it. Note what is read here: whether the map HOLDS
      // the date, not what it holds. `habit.entries[date] ?? UNSET` was fine
      // while a lapse and an unanswered day were one state; now it would report
      // every untouched day as an answered "no" and start the cycle in the wrong
      // place.
      const cur = habit.entries[date];
      const current = dayStateOf({
        value: Object.hasOwn(habit.entries, date) ? cur : undefined,
        isSkip: (habit.skips?.includes(date) ?? false) ||
          (habit.type === 'boolean' && cur === SKIP),
        // What counts as done differs: `YES` for a yes/no habit, and being at
        // or under the limit for one being avoided, where 0 is the goal.
        done: isAvoided(habit) ? cur <= (Number(habit.target_value) || 0) : cur === YES,
      });
      const to = nextDayState(current, {
        skipDays: settings.get('skipDays'),
        questionMarks: settings.get('questionMarks'),
      });

      if (to === DAY.UNKNOWN) return await clearDay(habit, date);
      // A skip is the status column, never a value. Writing the SKIP sentinel
      // works for a yes/no habit — `parseEntry` reads 3 as a skip there — and
      // silently stores three of the thing on a measurable one, which is what
      // an avoided habit is underneath.
      if (to === DAY.SKIP) return await recordSkip(habit, date);
      next = valueForState(habit, to);
    } else {
      // A measurable day is asked for rather than cycled to, and the answer
      // comes back through `saveCount` into the very same `recordValue`.
      return openCountDialog(habit, date);
    }

    await recordValue(habit, date, next);
  } catch (e) {
    toast(e.message);
  }
}

/**
 * Mark a day as skipped, on the same optimistic path as `recordValue`.
 *
 * `{status: 'skip'}` rather than a value, which is what the day editor has
 * always sent and what the Android client sends. The grid paints a skip from
 * `habit.skips`, and `entries[date]` is set to the SKIP sentinel alongside it
 * because that is the shape `/overview` returns — so the optimistic paint and
 * the refetch agree.
 */
async function recordSkip(habit, date) {
  const previous = Object.hasOwn(habit.entries, date) ? habit.entries[date] : undefined;
  habit.entries[date] = SKIP;
  const wasSkip = setSkip(habit, date, true);
  paint();

  try {
    await api(`/habits/${habit.id}/entries/${date}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'skip' }),
    });
  } catch (e) {
    if (!e.queued) {
      if (previous === undefined) delete habit.entries[date];
      else habit.entries[date] = previous;
      setSkip(habit, date, wasSkip);
      paint();
    }
    throw e;
  }

  await load();
}

/**
 * Write one day's value, paint it before the request, and put it back if the
 * request turns out not to have been made.
 *
 * One function because there are two ways in — the boolean tap cycle and the
 * amount dialog — and every line of what follows is a rule that must not exist
 * in only one of them.
 */
async function recordValue(habit, date, next) {
  // Apply optimistically BEFORE awaiting the request. Offline, `api()`
  // enqueues the write and then throws, so anything after the await is
  // skipped — which used to leave `habit.entries` stale. The next tap then
  // recomputed the cycle from the same starting value and queued another
  // identical write: three offline taps meaning "clear this day" all queued
  // `value: 2`, and the day synced as DONE. The cell stayed blank the whole
  // time, so there was no hint anything was wrong.
  const previous = Object.hasOwn(habit.entries, date) ? habit.entries[date] : undefined;
  // Set, never delete: UNSET is a row now — a stated "no" — and deleting the
  // key here would paint the cell as unknown while the server holds an
  // answer, which with question marks on is a visible lie until the refetch.
  habit.entries[date] = next;
  // `skips` is what the cell is painted from, so it clears with the value: any
  // amount recorded on a day ends a skip that was on it.
  //
  // Never SETS one. Skips come through `recordSkip` now, which writes the
  // status; the condition here used to be `next === SKIP && type === 'boolean'`
  // and became unsatisfiable when `valueForState` stopped answering for a skip
  // at all. A dead branch is harmless, but a comment claiming a boolean habit
  // "can reach SKIP from here" is the line a future skip change would read.
  const wasSkip = setSkip(habit, date, false);
  paint();

  try {
    await api(`/habits/${habit.id}/entries/${date}`, {
      method: 'PUT',
      body: JSON.stringify({ value: next }),
    });
  } catch (e) {
    // A queued write will still land, so the optimistic state is correct and
    // must stand. Any other failure did not reach the server, so roll back
    // rather than leave the UI asserting something untrue.
    if (!e.queued) {
      if (previous === undefined) delete habit.entries[date];
      else habit.entries[date] = previous;
      setSkip(habit, date, wasSkip);
      paint();
    }
    throw e;
  }

  // Re-fetch so score and streak reflect the change.
  await load();
}

export function init() {
  toggleArchived.addEventListener('click', () => {
    state.showArchived = !state.showArchived;
    // A query is about the list you were looking at, not the one you are
    // switching to — and leaving it on would show an empty archive with no
    // obvious reason why.
    state.query = '';
    load().catch((e) => toast(e.message));
  });

  // `paint()`, not `load()`: the habits are already in memory, which is the
  // whole reason this half of #74 is cheap. No request, and it works offline.
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    paint();
  });

  // Escape clears rather than closing anything, which is what a search box does
  // everywhere else. `type="search"` gives Chrome its own × as well.
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !searchInput.value) return;
    e.stopPropagation();
    searchInput.value = '';
    state.query = '';
    paint();
  });

  $('#count-cancel').addEventListener('click', () => { countDialog.close(); counting = null; });
  $('#count-save').addEventListener('click', saveCount);
  countClear.addEventListener('click', async () => {
    // Clearing takes the day back to having no row at all, which is the one
    // thing an empty box also does — but a button says so, where an empty box
    // is something you have to know. Both go through `clearDay`.
    if (!counting) return;
    const habit = countingHabit();
    const { date } = counting;
    countDialog.close();
    counting = null;
    if (!habit) return toast('That habit is no longer on the list — nothing was cleared.');
    try {
      await clearDay(habit, date);
    } catch (e) {
      toast(e.message);
    }
  });
  gridCountField.onEnter(saveCount);

  $('#empty-new').addEventListener('click', () => openDialog());
  $('#empty-import').addEventListener('click', openDataDialog);

  // Reflow the day grid when crossing the narrow/wide breakpoint (rotation,
  // window resize) so the column count always matches the available width.
  window.matchMedia('(max-width: 640px)').addEventListener('change', () => {
    if (state.openHabitId == null && state.habits.length) paint();
  });

  // The dashboard repaints from what it already has; only a 'reload' goes back
  // to the server. Both are ignored while the detail view is the one showing.
  on('change', () => { if (state.openHabitId == null) paint(); });
  // A 'reload' is "the list you were filtering has been replaced" — a habit
  // created, a backup restored — so the query goes with it, for the reason the
  // archive toggle clears it. Without this, creating a habit while a filter is
  // live toasts "Habit created" over a list the new habit is not in, and a
  // restore reads "No habits match that." over the freshly imported account.
  //
  // Note a check-off does NOT come through here: it ends in `load()` directly,
  // which is why the query survives one and is cleared by this.
  on('reload', () => {
    state.query = '';
    load().catch((e) => toast(e.message));
  });
}
