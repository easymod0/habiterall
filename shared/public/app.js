import {
  scoreChart, calendarChart, historyChart, weekdayChart, frequencyChart,
  streakChart,
} from '/shared/charts.js';
import {
  enqueue, flush, pendingCount, watchConnectivity,
} from '/shared/offline.js';
import {
  iso, datesEndingOn, freqLabel, targetLabel, todayISO, addDaysISO,
} from '/shared/ui/dates.js';
import { initTheme, toggleTheme } from '/shared/ui/theme.js';
import * as settings from '/shared/ui/settings.js';

/**
 * Auth adapter, injected by the edition's entry point (app-personal.js or
 * app-cloud.js). Everything else in this file is identical across editions;
 * sign-in is the only genuine difference between them.
 */
let auth = null;

const UNSET = 0;
const YES = 2;
const SKIP = 3;

const GRID_DAYS = 14;         // most columns we will ever show
const GRID_DAYS_NARROW = 7;   // phone layout: fewer, wider columns
const GRID_DAYS_MEDIUM = 10;  // tablets, where 14 would crush the habit name

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
const STREAK_LIMIT = 5;    // longest streaks listed on the detail view
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const $ = (sel) => document.querySelector(sel);

const els = {
  grid: $('#grid'),
  empty: $('#empty'),
  viewList: $('#view-list'),
  viewDetail: $('#view-detail'),
  dialog: $('#habit-dialog'),
  form: $('#habit-form'),
  dialogTitle: $('#dialog-title'),
  dialogDelete: $('#dialog-delete'),
  dayDialog: $('#day-dialog'),
  dayTitle: $('#day-title'),
  daySub: $('#day-sub'),
  dayBoolean: $('#day-boolean'),
  dayNumeric: $('#day-numeric'),
  dayNumericLabel: $('#day-numeric-label'),
  dayValue: $('#day-value'),
  dayNotes: $('#day-notes'),
  daySkip: $('#day-skip'),
  dayClear: $('#day-clear'),
  daySave: $('#day-save'),
  starters: $('#starters'),
  emptyArchived: $('#empty-archived'),
  // querySelectorAll yields Element, which has no `hidden`; these are all
  // HTMLElements in practice.
  emptyOnboarding: /** @type {HTMLElement[]} */ ([...document.querySelectorAll(
    '.empty-title, .empty-sub:not(#empty-archived), #starters, .empty-actions, .empty-note'
  )]),
  listHead: $('#list-head'),
  gridHead: $('#grid-head'),
  settingsDialog: $('#settings-dialog'),
  settingsBody: $('#settings-body'),
  toggleArchived: $('#toggle-archived'),
  archivedWrap: $('#archived-wrap'),
  dataDialog: $('#data-dialog'),
  importFile: $('#import-file'),
  importRun: $('#import-run'),
  importResult: $('#import-result'),
  toast: $('#toast'),
  offlineBar: $('#offline-bar'),
  pendingCount: $('#pending-count'),
};

let state = {
  habits: [],
  editingId: null,
  openHabitId: null,   // habit shown in the detail view, null on the dashboard
  granularity: 'day',
  historyMode: 'percent',
  calEnd: null,        // last date shown in the calendar; null = today
  dayEdit: null,       // { habitId, date, type } while the day dialog is open
  showArchived: false, // dashboard is showing the archive rather than active
  hasArchived: false,  // any archived habits exist at all
  gridEnd: null,       // last day column shown; null = today
  offline: false,      // showing cached data / writes are being queued
  pending: 0,          // writes waiting in the outbox
};

/* ---------- api ---------- */

async function api(path, options = {}) {
  const url = `/api${path}`;
  const method = (options.method ?? 'GET').toUpperCase();

  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options,
    });
  } catch (networkError) {
    // Offline. Queue writes for replay; reads have nothing to fall back on
    // beyond whatever the service worker already cached.
    if (method !== 'GET') {
      await enqueue({ url, method, body: options.body ?? null });
      await refreshOfflineBadge();
      throw Object.assign(
        new Error('Saved offline — will sync when you reconnect'),
        { queued: true }
      );
    }
    throw new Error('You are offline');
  }

  // The service worker marks responses it served from its cache.
  if (res.headers.get('X-Habiterall-Offline') === '1') setOffline(true);

  // An expired session is the adapter's business; without auth a 401 is a bug
  // and falls through to the normal error path.
  if (res.status === 401 && auth?.onUnauthorized()) {
    state.habits = [];
    throw new Error('Your session has expired. Please sign in again.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // A 503 from the service worker means the request never left the device.
    if (res.status === 503 && body.offline && method !== 'GET') {
      await enqueue({ url, method, body: options.body ?? null });
      await refreshOfflineBadge();
      throw Object.assign(
        new Error('Saved offline — will sync when you reconnect'),
        { queued: true }
      );
    }
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

/* ---------- offline state ---------- */

/** Show or hide the offline banner. */
function setOffline(offline) {
  if (state.offline === offline) return;
  state.offline = offline;
  els.offlineBar.hidden = !offline;
}

/** Reflect the number of queued writes in the banner. */
async function refreshOfflineBadge() {
  const n = await pendingCount();
  state.pending = n;
  els.pendingCount.textContent = n
    ? `${n} change${n === 1 ? '' : 's'} waiting to sync`
    : '';
  els.pendingCount.hidden = n === 0;
}

/**
 * Replay whatever is queued, then refresh the view so the server's version
 * of the truth wins.
 */
async function syncNow() {
  const before = await pendingCount();
  if (!before) return;

  const { sent, failed, remaining } = await flush();
  await refreshOfflineBadge();

  if (sent) {
    await loadDashboard();
    toast(`Synced ${sent} change${sent === 1 ? '' : 's'}`);
  }
  if (failed.length) {
    toast(`${failed.length} change${failed.length === 1 ? '' : 's'} could not be synced`);
  }
  if (remaining === 0) setOffline(false);
}

let toastTimer;

/**
 * Show a transient message. Pass `actionLabel`/`onAction` for an inline
 * button (e.g. Undo), which gets a longer timeout so it can be read and hit.
 */
function toast(message, { actionLabel = null, onAction = null } = {}) {
  els.toast.replaceChildren();

  const text = document.createElement('span');
  text.textContent = message;
  els.toast.append(text);

  if (actionLabel && onAction) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.type = 'button';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      clearTimeout(toastTimer);
      els.toast.hidden = true;
      onAction();
    });
    els.toast.append(btn);
  }

  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; },
    actionLabel ? 9000 : 2600);
}

/* ---------- dashboard ---------- */

async function loadDashboard() {
  // Always fetch the wide window so a rotation to landscape needs no refetch.
  const data = await api(
    `/overview?days=${GRID_DAYS}${state.showArchived ? '&archived=true' : ''}`
  );
  state.habits = data.habits;

  // The archive toggle is pointless until something has been archived.
  const archived = await api('/habits?archived=true');
  state.hasArchived = archived.length > 0;

  renderDashboard();
}

function renderDashboard() {
  state.openHabitId = null;
  els.viewDetail.hidden = true;
  els.viewList.hidden = false;
  els.grid.replaceChildren();

  els.listHead.hidden = !state.hasArchived;
  els.toggleArchived.textContent = state.showArchived ? 'Show active' : 'Show archived';
  els.toggleArchived.setAttribute('aria-pressed', String(state.showArchived));

  // The onboarding panel is only for a genuinely empty tracker; an empty
  // archive view just needs a line of text.
  const isEmpty = state.habits.length === 0;
  els.empty.hidden = !isEmpty;
  els.emptyArchived.hidden = !(isEmpty && state.showArchived);
  for (const el of els.emptyOnboarding) el.hidden = !(isEmpty && !state.showArchived);

  if (isEmpty && !state.showArchived) renderStarters();

  const todayIso = todayISO();
  // datesEndingOn always returns oldest-first; flip it when the user wants
  // today on the left. Everything downstream just walks the array.
  const dates = datesEndingOn(gridDays(), state.gridEnd ?? todayIso);
  if (settings.get('dayOrder') === 'newest-left') dates.reverse();
  renderGridHeader(dates, todayIso);

  for (const habit of state.habits) {
    const row = document.createElement('div');
    row.className = 'habit-row' + (habit.archived ? ' archived' : '');
    row.dataset.habitId = String(habit.id);

    // Drag handle. Reordering only makes sense in the active list, and only
    // when there is more than one habit to move.
    const reorderable = !state.showArchived && state.habits.length > 1;
    if (reorderable) {
      const handle = document.createElement('button');
      handle.className = 'drag-handle';
      handle.type = 'button';
      handle.draggable = true;
      handle.textContent = '⠿';
      handle.title = 'Drag to reorder — or focus and use ↑ / ↓';
      handle.setAttribute('aria-label', `Reorder ${habit.name}. Use arrow up or arrow down.`);
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
    meta.addEventListener('click', () => showDetail(habit.id));
    meta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(habit.id); }
    });

    const checks = document.createElement('div');
    checks.className = 'checks';

    for (const d of dates) {
      const date = iso(d);
      const value = habit.entries[date];
      const btn = document.createElement('button');
      btn.className = 'check' + (date === todayIso ? ' today' : '');
      btn.title = `${habit.name} — ${date}`;

      const box = document.createElement('span');
      box.className = 'check-box';
      paintCheckbox(box, habit, value);

      const day = document.createElement('span');
      day.className = 'check-day';
      day.textContent = DAY_LETTERS[d.getDay()];

      btn.append(box, day);
      btn.addEventListener('click', () => onCheckClick(habit, date));
      checks.append(btn);
    }

    row.append(meta, checks);
    els.grid.append(row);
  }
}

/**
 * Column header: the month/day above each column, plus navigation.
 *
 * Without this the grid showed only weekday letters, so there was no way to
 * tell which column was which date — or to look at any day but the most
 * recent fortnight.
 */
function renderGridHeader(dates, todayIso) {
  els.gridHead.replaceChildren();
  if (!state.habits.length) { els.gridHead.hidden = true; return; }
  els.gridHead.hidden = false;

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

  const mk = (text, aria, delta, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm';
    b.textContent = text;
    b.setAttribute('aria-label', aria);
    b.disabled = disabled;
    b.addEventListener('click', () => shiftGrid(delta));
    return b;
  };

  // Never scroll past today: there is nothing to record in the future.
  const atToday = (state.gridEnd ?? todayIso) >= todayIso;

  // Order the buttons so they read left-to-right in the direction they move.
  const older = mk(olderGlyph, `Previous ${step} days`, -step);
  const newer = mk(newerGlyph, `Next ${step} days`, step, atToday);
  nav.append(...(newestLeft ? [newer, older] : [older, newer]));

  if (!atToday) {
    const today = document.createElement('button');
    today.type = 'button';
    today.className = 'btn btn-sm';
    today.textContent = 'Today';
    today.addEventListener('click', () => { state.gridEnd = null; renderDashboard(); });
    nav.append(today);
  }

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

  els.gridHead.append(label, nav, cols);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
  renderDashboard();
}

/* ---------- settings ---------- */

/**
 * Build the settings dialog from the registry, so adding an option needs no
 * changes here — only a new entry in SETTINGS.
 */
function openSettings() {
  els.settingsBody.replaceChildren();
  const current = settings.load();

  for (const section of settings.sections()) {
    const group = document.createElement('section');
    group.className = 'data-section';

    const heading = document.createElement('h3');
    heading.textContent = section;
    group.append(heading);

    for (const [key, def] of Object.entries(settings.SETTINGS)) {
      if ((def.section ?? 'General') !== section) continue;

      const label = document.createElement('label');
      label.className = def.type === 'toggle' ? 'checkbox' : '';

      if (def.type === 'select') {
        const text = document.createElement('span');
        text.textContent = def.label;
        const select = document.createElement('select');
        for (const opt of def.options) {
          const o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.label;
          o.selected = current[key] === opt.value;
          select.append(o);
        }
        select.addEventListener('change', () => applySetting(key, select.value));
        label.append(text, select);
      } else {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!current[key];
        box.addEventListener('change', () => applySetting(key, box.checked));
        const text = document.createElement('span');
        text.textContent = def.label;
        label.append(box, text);
      }

      group.append(label);

      if (def.help) {
        const help = document.createElement('p');
        help.className = 'hint setting-help';
        help.textContent = def.help;
        group.append(help);
      }
    }
    els.settingsBody.append(group);
  }

  els.settingsDialog.showModal();
}

/** Persist a setting and re-render whatever it affects. */
function applySetting(key, value) {
  if (!settings.set(key, value)) return;
  renderDashboard();
  if (state.openHabitId != null) showDetail(state.openHabitId);
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
  els.starters.replaceChildren();

  for (const preset of STARTERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'starter';

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
        await loadDashboard();
        toast(`Added "${preset.name}"`);
      } catch (e) {
        btn.disabled = false;
        toast(e.message);
      }
    });
    els.starters.append(btn);
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
    for (const r of els.grid.children) r.classList.remove('drop-above', 'drop-below');
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

/** Shift a habit one slot up or down, keeping keyboard focus on its handle. */
function nudgeHabit(habitId, delta) {
  const order = state.habits.map((h) => h.id);
  const from = order.indexOf(habitId);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= order.length) return;

  order.splice(to, 0, ...order.splice(from, 1));
  persistOrder(order, habitId);
}

/**
 * Reorder optimistically so the list never appears to lag, then save.
 * `focusId` restores keyboard focus to the moved habit's handle.
 */
async function persistOrder(order, focusId = null) {
  const byId = new Map(state.habits.map((h) => [h.id, h]));
  const previous = state.habits;
  state.habits = order.map((id) => byId.get(id)).filter(Boolean);
  renderDashboard();

  if (focusId != null) {
    const row = els.grid.querySelector(`[data-habit-id="${focusId}"] .drag-handle`);
    row?.focus();
  }

  try {
    await api('/habits/reorder', {
      method: 'POST',
      body: JSON.stringify({ order }),
    });
  } catch (e) {
    state.habits = previous; // put it back rather than lie about the order
    renderDashboard();
    toast(e.message);
  }
}

function paintCheckbox(box, habit, value) {
  box.textContent = '';
  box.style.background = 'var(--grid-empty)';
  box.style.color = '#fff';

  if (value == null) return;

  if (value === SKIP) {
    box.style.background = 'var(--surface-2)';
    box.style.color = 'var(--text-dim)';
    box.textContent = '–';
    return;
  }

  if (habit.type === 'boolean') {
    if (value === YES) {
      box.style.background = habit.color;
      box.textContent = '✓';
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

async function onCheckClick(habit, date) {
  try {
    let next;
    if (habit.type === 'boolean') {
      // cycle: unset -> yes -> skip -> unset
      const cur = habit.entries[date] ?? UNSET;
      next = cur === UNSET ? YES : cur === YES ? SKIP : UNSET;
    } else {
      // A skipped day has no numeric value to prefill. For numerical habits
      // the SKIP wire value is only meaningful when the day is actually
      // flagged as a skip — 3 is otherwise a legitimate amount.
      const cur = habit.entries[date];
      const skipped = habit.skips?.includes(date);
      const raw = prompt(
        `${habit.name} — ${date}\nEnter value${habit.unit ? ` (${habit.unit})` : ''}:`,
        cur != null && !skipped ? String(cur) : ''
      );
      if (raw === null) return;
      if (raw.trim() === '') {
        await api(`/habits/${habit.id}/entries/${date}`, { method: 'DELETE' });
        delete habit.entries[date];
        renderDashboard();
        return;
      }
      next = Number(raw);
      if (!Number.isFinite(next) || next < 0) return toast('Enter a non-negative number');
    }

    await api(`/habits/${habit.id}/entries/${date}`, {
      method: 'PUT',
      body: JSON.stringify({ value: next }),
    });

    if (next === UNSET) delete habit.entries[date];
    else habit.entries[date] = next;

    // Re-fetch so score and streak reflect the change.
    await loadDashboard();
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- detail view ---------- */

async function showDetail(id) {
  try {
    const stats = await api(`/habits/${id}/stats?granularity=${state.granularity}`);
    const entries = await api(`/habits/${id}/entries`);
    renderDetail(stats, entries);
  } catch (e) {
    toast(e.message);
  }
}

function renderDetail(stats, entries) {
  const habit = stats.habit;
  const color = habit.color;
  state.openHabitId = habit.id;
  els.viewList.hidden = true;
  els.viewDetail.hidden = false;
  els.viewDetail.replaceChildren();

  const entriesByDate = Object.fromEntries(entries.map((e) => [e.date, e.value]));

  /* header */
  const head = document.createElement('div');
  head.className = 'detail-head';

  const back = document.createElement('button');
  back.className = 'btn btn-sm';
  back.textContent = '← Back';
  back.addEventListener('click', loadDashboard);

  const titleWrap = document.createElement('div');
  titleWrap.style.flex = '1';
  const h2 = document.createElement('h2');
  h2.textContent = habit.name;
  const sub = document.createElement('div');
  sub.className = 'habit-sub';
  sub.textContent = [habit.description, freqLabel(habit), targetLabel(habit)]
    .filter(Boolean).join(' · ');
  titleWrap.append(h2, sub);

  const edit = document.createElement('button');
  edit.className = 'btn btn-sm';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => openDialog(habit));

  head.append(back, titleWrap, edit);
  els.viewDetail.append(head);

  /* stat tiles */
  const tiles = document.createElement('div');
  tiles.className = 'stat-row';
  const stat = (value, label) => {
    const t = document.createElement('div');
    t.className = 'stat-tile';
    const v = document.createElement('div');
    v.className = 'stat-value';
    v.textContent = value;
    v.style.color = color;
    const l = document.createElement('div');
    l.className = 'stat-label';
    l.textContent = label;
    t.append(v, l);
    return t;
  };
  tiles.append(
    stat(`${Math.round(stats.score * 100)}%`, 'Strength'),
    stat(stats.currentStreak, 'Current streak'),
    stat(stats.bestStreak, 'Best streak'),
    stat(stats.totalCompleted, 'Total done'),
  );
  els.viewDetail.append(tiles);

  /* score */
  els.viewDetail.append(
    card('Habit strength', scoreChart(stats.scores, color))
  );

  /* best streaks */
  els.viewDetail.append(
    card('Best streaks', streakChart(stats.streaks, color, { limit: STREAK_LIMIT }))
  );

  /* calendar — clickable, with navigation back through history */
  const calCard = card('Calendar', null);
  const calHead = calCard.querySelector('.card-head');

  const nav = document.createElement('div');
  nav.className = 'cal-nav';
  const navLabel = document.createElement('span');
  navLabel.className = 'cal-range';

  const mkNav = (text, label, fn) => {
    const b = document.createElement('button');
    b.className = 'btn btn-sm';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', fn);
    return b;
  };

  const CAL_WEEKS = 27; // ~6 months per page, readable without scrolling far
  const shift = (weeks) => {
    state.calEnd = addDaysISO(state.calEnd ?? todayISO(), weeks * 7);
    if (state.calEnd > todayISO()) state.calEnd = todayISO();
    showDetail(habit.id);
  };

  nav.append(
    mkNav('‹ Earlier', 'Show earlier months', () => shift(-CAL_WEEKS)),
    navLabel,
    mkNav('Later ›', 'Show later months', () => shift(CAL_WEEKS)),
    mkNav('Today', 'Jump to today', () => { state.calEnd = null; showDetail(habit.id); }),
  );
  calHead.append(nav);

  const calEnd = state.calEnd ?? todayISO();
  const calStart = addDaysISO(calEnd, -(CAL_WEEKS * 7 - 1));
  navLabel.textContent = `${calStart} → ${calEnd}`;

  const skipSet = new Set(entries.filter((e) => e.status === 'skip').map((e) => e.date));
  const notesByDate = Object.fromEntries(
    entries.filter((e) => e.notes).map((e) => [e.date, e.notes])
  );

  const calScroll = document.createElement('div');
  calScroll.className = 'chart-scroll';
  calScroll.append(calendarChart(entriesByDate, color, habit, {
    weeks: CAL_WEEKS,
    endDate: calEnd,
    skips: skipSet,
    onPick: (date) => openDayDialog(
      habit, date, entriesByDate[date], skipSet.has(date), notesByDate[date]
    ),
  }));
  calCard.append(calScroll);

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.append(document.createTextNode('Less'));
  for (const t of [0.2, 0.45, 0.7, 1]) {
    const sw = document.createElement('span');
    sw.className = 'legend-swatch';
    sw.style.background = color;
    sw.style.opacity = String(t);
    legend.append(sw);
  }
  legend.append(document.createTextNode('More'));
  calCard.append(legend);
  els.viewDetail.append(calCard);

  /* history with granularity toggle */
  const histCard = card('History', null);
  const histHead = histCard.querySelector('.card-head');

  const gran = segmented(
    ['day', 'week', 'month', 'quarter', 'year'],
    state.granularity,
    async (g) => { state.granularity = g; await showDetail(habit.id); }
  );
  const mode = segmented(
    ['percent', 'count'],
    state.historyMode,
    async (m) => { state.historyMode = m; await showDetail(habit.id); }
  );
  const toggles = document.createElement('div');
  toggles.style.display = 'flex';
  toggles.style.gap = '8px';
  toggles.style.flexWrap = 'wrap';
  toggles.append(gran, mode);
  histHead.append(toggles);

  const histScroll = document.createElement('div');
  histScroll.className = 'chart-scroll';
  histScroll.append(historyChart(stats.history, color, {
    showPercent: state.historyMode === 'percent',
  }));
  histCard.append(histScroll);
  els.viewDetail.append(histCard);

  /* weekday */
  els.viewDetail.append(card('By day of week', weekdayChart(stats.weekdays, color)));

  /* frequency */
  if (stats.frequency.length) {
    const freqScroll = document.createElement('div');
    freqScroll.className = 'chart-scroll';
    freqScroll.append(frequencyChart(stats.frequency, color));
    const fc = card('Times per week', null);
    fc.append(freqScroll);
    els.viewDetail.append(fc);
  }
}

function card(titleText, content) {
  const c = document.createElement('div');
  c.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = titleText;
  head.append(t);
  c.append(head);
  if (content) c.append(content);
  return c;
}

function segmented(options, active, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'seg';
  for (const opt of options) {
    const b = document.createElement('button');
    b.textContent = opt;
    b.setAttribute('aria-pressed', String(opt === active));
    b.addEventListener('click', () => onChange(opt));
    wrap.append(b);
  }
  return wrap;
}

/* ---------- habit dialog ---------- */

function openDialog(habit = null) {
  state.editingId = habit?.id ?? null;
  els.dialogTitle.textContent = habit ? 'Edit habit' : 'New habit';
  els.dialogDelete.hidden = !habit;

  const f = els.form;
  f.name.value = habit?.name ?? '';
  f.description.value = habit?.description ?? '';
  f.type.value = habit?.type ?? 'boolean';
  f.unit.value = habit?.unit ?? '';
  f.target_value.value = habit?.target_value ?? 1;
  f.target_type.value = habit?.target_type ?? 'at_least';
  f.freq_numerator.value = habit?.freq_numerator ?? 1;
  f.freq_denominator.value = habit?.freq_denominator ?? 1;
  f.color.value = habit?.color ?? '#3b82f6';
  f.archived.checked = !!habit?.archived;
  els.archivedWrap.hidden = !habit; // only meaningful for an existing habit

  syncTypeFields();
  els.dialog.showModal();
  f.name.focus();
}

function syncTypeFields() {
  const numerical = els.form.type.value === 'numerical';
  els.form.querySelector('.numerical-only').hidden = !numerical;
}

async function saveHabit(e) {
  e.preventDefault();
  const f = els.form;

  const payload = {
    name: f.name.value,
    description: f.description.value,
    type: f.type.value,
    unit: f.unit.value,
    target_value: Number(f.target_value.value) || 0,
    target_type: f.target_type.value,
    freq_numerator: Number(f.freq_numerator.value) || 1,
    freq_denominator: Number(f.freq_denominator.value) || 1,
    color: f.color.value,
    archived: f.archived.checked,
  };

  try {
    if (state.editingId) {
      await api(`/habits/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Habit updated');
    } else {
      await api('/habits', { method: 'POST', body: JSON.stringify(payload) });
      toast('Habit created');
    }
    els.dialog.close();
    await loadDashboard();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteHabit() {
  if (!state.editingId) return;
  const id = state.editingId;

  try {
    // Snapshot the habit and its history first, so the delete can be undone
    // without a soft-delete column or a server-side trash.
    const habit = await api(`/habits/${id}`);
    const entries = await api(`/habits/${id}/entries`);

    // The delete is undoable from the toast that follows, so the confirm is
    // a preference rather than a safety requirement.
    if (settings.get('confirmDelete') && !confirm(
      `Delete "${habit.name}" and its ${entries.length} recorded ` +
      `${entries.length === 1 ? 'day' : 'days'}?`
    )) return;

    await api(`/habits/${id}`, { method: 'DELETE' });
    els.dialog.close();
    await loadDashboard();

    toast(`Deleted "${habit.name}"`, {
      actionLabel: 'Undo',
      onAction: () => restoreHabit(habit, entries),
    });
  } catch (e) {
    toast(e.message);
  }
}

/** Recreate a deleted habit and replay its entries. */
async function restoreHabit(habit, entries) {
  try {
    const created = await api('/habits', {
      method: 'POST',
      body: JSON.stringify(habit),
    });

    // Restore history in one import rather than a request per day.
    if (entries.length) {
      const payload = { habits: [{ ...created, entries }] };
      const res = await fetch('/api/import?mode=merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'could not restore history');
      }
    }

    await loadDashboard();
    toast(`Restored "${habit.name}"`);
  } catch (e) {
    toast(`Could not undo: ${e.message}`);
  }
}

/* ---------- day editor ---------- */


/**
 * Edit a single day from the calendar. Works for any date up to today, which
 * is what makes correcting old history possible.
 */
function openDayDialog(habit, date, value, isSkip, notes = '') {
  state.dayEdit = { habitId: habit.id, date, type: habit.type };
  els.dayNotes.value = notes ?? '';

  // A measurable habit gets a number field; a yes/no habit gets exactly two
  // buttons. Only one of the two controls is ever present.
  const numeric = habit.type === 'numerical';
  els.dayTitle.textContent = habit.name;

  const [y, m, d] = date.split('-').map(Number);
  const pretty = new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  // Say what's being edited, and against what goal, so the input is unambiguous.
  const goal = numeric
    ? `${habit.target_type === 'at_most' ? 'at most' : 'at least'} ${habit.target_value}` +
      (habit.unit ? ` ${habit.unit}` : '')
    : '';
  els.daySub.textContent = goal ? `${pretty} · target ${goal}` : pretty;

  els.dayBoolean.hidden = numeric;
  els.dayNumeric.hidden = !numeric;
  els.daySave.hidden = !numeric; // boolean saves happen on the choice buttons

  if (numeric) {
    els.dayNumericLabel.textContent = habit.unit ? `Amount (${habit.unit})` : 'Amount';
    els.dayValue.value = value != null && !isSkip ? String(value) : '';
    els.dayValue.placeholder = isSkip ? 'skipped' : 'leave empty to clear';
  } else {
    // Highlight whichever state the day is currently in.
    for (const b of els.dayBoolean.querySelectorAll('.day-choice')) {
      const isDone = b.dataset.action === 'done';
      const active = !isSkip && (isDone ? value === YES : value == null || value === UNSET);
      b.setAttribute('aria-pressed', String(active));
    }
  }

  // "Clear" only means something when there's an entry to remove.
  els.dayClear.hidden = value == null && !isSkip;
  els.daySkip.setAttribute('aria-pressed', String(!!isSkip));
  els.daySkip.textContent = isSkip ? 'Unskip' : 'Skip day';

  els.dayDialog.showModal();
  if (numeric) els.dayValue.focus();
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
        body: JSON.stringify({ notes: els.dayNotes.value.trim(), ...body }),
      });
    }
    els.dayDialog.close();
    await showDetail(habitId);
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- backup / restore ---------- */

function openDataDialog() {
  els.importResult.hidden = true;
  els.importResult.classList.remove('error');
  els.importFile.value = '';
  els.importRun.disabled = true;
  els.dataDialog.showModal();
}

function download(path, fallbackName) {
  // Let the browser handle the download so large exports never hit memory.
  const a = document.createElement('a');
  a.href = path;
  a.download = fallbackName;
  document.body.append(a);
  a.click();
  a.remove();
}

async function runImport() {
  const file = els.importFile.files?.[0];
  if (!file) return;

  const mode = els.dataDialog.querySelector('input[name="import-mode"]:checked').value;

  if (mode === 'replace' &&
      !confirm('Replace mode deletes every existing habit and all history before importing. Continue?')) {
    return;
  }

  els.importRun.disabled = true;
  els.importRun.textContent = 'Importing…';
  els.importResult.hidden = true;
  els.importResult.classList.remove('error');

  try {
    const res = await fetch(`/api/import?mode=${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file, // sent as raw bytes; the server sniffs the format
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `import failed (${res.status})`);

    const parts = [
      `${body.habitsCreated} habit(s) created`,
      body.habitsMerged ? `${body.habitsMerged} merged` : '',
      `${body.entriesImported} entries imported`,
    ].filter(Boolean);

    els.importResult.textContent = parts.join(' · ');
    if (body.skipped?.length) {
      const ul = document.createElement('ul');
      for (const s of body.skipped.slice(0, 8)) {
        const li = document.createElement('li');
        li.textContent = s;
        ul.append(li);
      }
      if (body.skipped.length > 8) {
        const li = document.createElement('li');
        li.textContent = `…and ${body.skipped.length - 8} more`;
        ul.append(li);
      }
      els.importResult.append(ul);
    }
    els.importResult.hidden = false;

    await loadDashboard();
    toast('Import complete');
  } catch (e) {
    els.importResult.textContent = e.message;
    els.importResult.classList.add('error');
    els.importResult.hidden = false;
  } finally {
    els.importRun.disabled = false;
    els.importRun.textContent = 'Import';
  }
}

/* ---------- wire up ---------- */

$('#btn-new').addEventListener('click', () => openDialog());
$('#btn-settings').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', () => els.settingsDialog.close());
$('#settings-reset').addEventListener('click', async () => {
  await settings.reset();
  openSettings();          // redraw the controls at their defaults
  renderDashboard();
});
$('#empty-new').addEventListener('click', () => openDialog());
$('#empty-import').addEventListener('click', openDataDialog);
els.toggleArchived.addEventListener('click', () => {
  state.showArchived = !state.showArchived;
  loadDashboard().catch((e) => toast(e.message));
});
$('#btn-data').addEventListener('click', openDataDialog);
$('#btn-theme').addEventListener('click', () => toggleTheme(() => {
  // Charts read theme colours at draw time, so redraw whatever is on screen.
  if (state.openHabitId != null) showDetail(state.openHabitId);
}));
$('#data-close').addEventListener('click', () => els.dataDialog.close());
$('#export-json').addEventListener('click',
  () => download('/api/export?download=true', 'habiterall-backup.json'));
$('#export-csv').addEventListener('click',
  () => download('/api/export.csv', 'habiterall-checkmarks.csv'));
$('#export-loop').addEventListener('click',
  () => download('/api/export-loop.db', 'Loop Habits Backup.db'));
els.importFile.addEventListener('change',
  () => { els.importRun.disabled = !els.importFile.files?.length; });
els.importRun.addEventListener('click', runImport);

/* day editor */
$('#day-cancel').addEventListener('click', () => els.dayDialog.close());
els.daySkip.addEventListener('click', () => {
  // Toggles: skipping an already-skipped day removes the skip.
  const wasSkipped = els.daySkip.getAttribute('aria-pressed') === 'true';
  saveDay(wasSkipped ? null : { status: 'skip' });
});
els.dayClear.addEventListener('click', () => saveDay(null));
els.daySave.addEventListener('click', () => {
  const raw = els.dayValue.value.trim();
  if (raw === '') return saveDay(null); // empty means "no entry"
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return toast('Enter a non-negative number');
  saveDay({ value: n });
});
for (const b of els.dayBoolean.querySelectorAll('.day-choice')) {
  b.addEventListener('click', () => {
    if (b.dataset.action === 'done') return saveDay({ value: YES });
    // "Not done" is stored as the absence of a row, so a note would have
    // nowhere to live — keep an explicit 0 row when one was written.
    const note = els.dayNotes.value.trim();
    saveDay(note ? { value: UNSET, notes: note } : null);
  });
}
els.dayValue.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); els.daySave.click(); }
});
$('#dialog-cancel').addEventListener('click', () => els.dialog.close());
els.dialogDelete.addEventListener('click', deleteHabit);
els.form.addEventListener('submit', saveHabit);
els.form.type.addEventListener('change', syncTypeFields);

// Reflow the day grid when crossing the narrow/wide breakpoint (rotation,
// window resize) so the column count always matches the available width.
window.matchMedia('(max-width: 640px)').addEventListener('change', () => {
  if (state.openHabitId == null && state.habits.length) renderDashboard();
});

$('#btn-sync').addEventListener('click', () => {
  syncNow().catch((e) => toast(e.message));
});

/* ---------- progressive web app ---------- */

if ('serviceWorker' in navigator) {
  // Registered at the origin root so its scope covers the whole app.
  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .catch((e) => console.warn('service worker registration failed', e));
}

// Reconnecting is the moment to drain the outbox.
watchConnectivity(async (online) => {
  setOffline(!online);
  await refreshOfflineBadge();
  if (online) await syncNow().catch(() => {});
});

// Returning to the app after it was backgrounded is also a good moment.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncNow().catch(() => {});
});

/**
 * App shortcuts (long-press the launcher icon) arrive as a query parameter.
 * Strip it afterwards so a refresh doesn't reopen the dialog.
 */
function handleLaunchAction() {
  const action = new URLSearchParams(location.search).get('action');
  if (!action) return;
  history.replaceState({}, '', location.pathname);
  if (action === 'new') openDialog();
}

/**
 * Boot the app with an edition-specific auth adapter.
 * @param {object} adapter  see auth-none.js / auth-oidc.js
 */
export async function start(adapter) {
  auth = adapter;

  const logout = $('#btn-logout');
  if (logout) logout.addEventListener('click', () => auth.signOut());

  initTheme();
  refreshOfflineBadge();

  try {
    // Resolve the session before fetching anything user-scoped.
    const user = await auth.load();
    auth.render(user);
    if (!user) return;            // signed out: the sign-in view is showing

    // Preferences are server-side, so they must arrive before the first
    // render or the dashboard paints with the wrong day order and flips.
    await settings.init();

    await loadDashboard();
    handleLaunchAction();
  } catch (e) {
    toast(e.message);
  }
}
