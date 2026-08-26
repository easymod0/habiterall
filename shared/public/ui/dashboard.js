/**
 * The habit list: the day grid, its column header and paging, the empty
 * state, drag reordering, and search.
 *
 * Owns `#grid`, `#grid-head`, `#list-head`, `#toggle-archived`, `#empty` and
 * the starter panel inside it.
 *
 * What a checkbox tap MEANS is no longer here: the cells, their painting, the
 * tap cycle, the three writes and the amount dialog moved to `ui/day-strip.js`
 * when a habit's own page grew the same control. That module owns the count
 * dialog's ids now — this file must not name them, or `ui-modules.test.js`
 * fails with two owners. What stayed is everything list-shaped: the window is
 * paged by REFETCHING (`state.gridEnd`), because the dashboard holds only the
 * fortnight it asked for, where a habit's page holds all of its history and
 * pages by slicing memory.
 */

import { api } from '/shared/ui/api.js';
import { focusKeyOf, habitIcon, restoreFocus } from '/shared/ui/components.js';
import { openDataDialog } from '/shared/ui/data-dialog.js';
import { dateColumns, dayCells } from '/shared/ui/day-strip.js';
import {
  addDaysISO, datesEndingOn, freqLabel, iso,
  formatDayRange, targetLabel, todayISO,
} from '/shared/ui/dates.js';
import { openDialog } from '/shared/ui/habit-dialog.js';
import * as routes from '/shared/ui/routes.js';
import * as settings from '/shared/ui/settings.js';
import { dashboardShowing, isQueryActive, matchesQuery, on, state } from '/shared/ui/store.js';
import { toast } from '/shared/ui/toast.js';
import { SKIP } from '/shared/ui/values.js';
import * as views from '/shared/ui/views.js';
import { GRID_DAYS, gridColumns } from '/shared/ui/window.js';
import { open as openHabit } from '/shared/ui/detail.js';
import { syncEntry as syncCompareEntry } from '/shared/ui/categories.js';

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

// Weekday letters and month names come from `ui/dates.js`, which asks `Intl`.
// There were two hardcoded English copies of both — one here and one in
// charts.js — so the grid header and the calendar's captions were English
// whatever the browser was set to, in an app whose amount dialog already used
// the browser's own locale.

/**
 * How many day columns to draw: the account's choice, capped by what fits.
 *
 * The arithmetic and the reasoning are in `ui/window.js`, which is DOM-free and
 * therefore unit testable — the cap is the part worth pinning, and a function
 * reading `window.innerWidth` and the settings cache is not.
 */
function gridDays() {
  return gridColumns(settings.get('gridDays'), window.innerWidth);
}

/* ---------- how the strip reaches this list's data ---------- */

/**
 * Add or remove a date from a habit's `skips`, in place.
 *
 * The optimistic writes edit `habit.entries` and then repaint, and since the
 * grid started reading `skips` to tell a skip from an amount, editing one
 * without the other leaves the cell asserting the old state. Offline that is
 * not a flash before the refetch corrects it: `api()` queues the write and
 * throws, so the refetch never runs and the cell stays wrong while taps
 * accumulate.
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
 * This list, as `ui/day-strip.js` reads and writes it.
 *
 * A module-level singleton rather than something built per paint: the amount
 * dialog outlives a rebuild, and a host captured in a closure would answer from
 * a `state.habits` that `load()` has since replaced wholesale.
 *
 * The encoding here is `/overview`'s: a skip is BOTH the SKIP wire value in
 * `entries` and the date listed in `skips`, because that is what the refetch
 * will return and the optimistic paint has to agree with it. A habit's own page
 * holds the same day in a different shape, which is exactly why this is the
 * host's job and not the strip's.
 *
 * @type {import('/shared/ui/day-strip.js').StripHost}
 */
const listHost = {
  habit: (id) => state.habits.find((h) => h.id === id) ?? null,

  read(id, date) {
    const habit = this.habit(id);
    if (!habit) return { value: undefined, isSkip: false };
    return {
      // Whether the map HOLDS the date, never what it holds — see the ban on
      // `?? UNSET` in the root CLAUDE.md.
      value: Object.hasOwn(habit.entries, date) ? habit.entries[date] : undefined,
      isSkip: habit.skips?.includes(date) ?? false,
    };
  },

  edit(id, date, to) {
    const habit = this.habit(id);
    if (!habit) return () => {};
    const had = Object.hasOwn(habit.entries, date) ? habit.entries[date] : undefined;

    if (to === 'clear') {
      delete habit.entries[date];
    } else {
      // Set, never delete: UNSET is a row now — a stated "no" — and deleting
      // the key would paint the cell as unknown while the server holds an
      // answer, which with question marks on is a visible lie until the
      // refetch.
      habit.entries[date] = to === 'skip' ? SKIP : to;
    }
    const wasSkip = setSkip(habit, date, to === 'skip');

    return () => {
      const back = this.habit(id);
      if (!back) return;
      if (had === undefined) delete back.entries[date];
      else back.entries[date] = had;
      setSkip(back, date, wasSkip);
    };
  },

  repaint: () => paint(),
  refresh: () => load(),
};

export async function load() {
  // Always request the widest column count so a rotation to landscape needs
  // no refetch, and the window the user is actually looking at — paging back
  // must bring its entries with it.
  //
  // GRID_DAYS and not `gridDays()`, which is the whole reason `gridDays` needed
  // no route change in either edition: every value the setting offers is at
  // most this, so the fetched window is still the widest the grid can ever
  // show and changing the setting cannot outrun it. A repaint on 'change' is
  // enough; there is nothing to refetch.
  const params = new URLSearchParams({ days: String(GRID_DAYS) });
  if (state.gridEnd) params.set('end', state.gridEnd);
  if (state.showArchived) params.set('archived', 'true');
  const data = await api(`/overview?${params}`);
  state.habits = data.habits;
  // The habit dialog's category picker reads this rather than fetching its
  // own copy — every load already carries it.
  state.categories = data.categories;
  // Each grouped section's mean/spread, one row per category plus a trailing
  // `id: null` for Uncategorised. `?archived=true` sends no such key at all —
  // that mode has nothing active to average — and an older cached payload
  // (the service worker's stale-while-revalidate) may hold none either, so
  // this is read as `undefined` rather than assumed present; see `summarised`
  // and `sectionHeader` below.
  state.categorySummaries = data.categorySummaries;
  // Recorded beside them, because `habit.entries` means anything only for the
  // days this answer covered and nothing else in the payload says which those
  // are. The SERVER's `start` / `end`, never the request's: `end` is clamped to
  // the caller's own today, so asking is not knowing.
  state.gridLoaded = { start: data.start, end: data.end };

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

/**
 * The habits the list is showing.
 *
 * A filter over what is already in memory — no API change, no schema change,
 * and it works offline, which is what makes this the cheap half of #74. The
 * predicate itself is `store.js`'s, because `habit-dialog` asks the same
 * question of the habit it has just saved; a second copy of it here is how the
 * two come to disagree about whether a row would have been on screen.
 */
function visibleHabits() {
  return state.habits.filter((h) => matchesQuery(h));
}

export function paint() {
  state.openHabitId = null;
  // ...and neither is the comparison, which this paint is about to cover. Set
  // beside `openHabitId` because the two answer one question between them —
  // see the note on the field in `ui/store.js`.
  state.openCategories = false;
  // The top-bar entry point to that comparison, which `ui/categories.js`
  // owns: this is the one place that runs after `state.categories` has been
  // refreshed, and every category mutation ends in a 'reload' that reaches it.
  syncCompareEntry(state.categories.length > 0);
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
  // like it guards a case it cannot reach. The predicate is the same one
  // `matchesQuery` uses, so a query of only combining accents — folded to
  // nothing by the matcher, and previously left "live" by a bare `.trim()` —
  // no longer lights the indicator for a filter that is doing nothing.
  const filtering = isQueryActive();

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

  // `position` is one flat order and `persistOrder` sends a flat id list, so
  // dragging while grouped would clump the habits by category permanently —
  // an action that never said it would. Same reasoning as `!state.showArchived`
  // and `!filtering` just above: dragging only means something in the list's
  // one real order, and grouping is a VIEW of that order, not a second one.
  const grouped = settings.get('groupByCategory');

  // Drag handle. Reordering only makes sense in the active list, only when
  // there is more than one habit to move, only ungrouped (see above), and not
  // while a filter is on. Dragging only means something in the list's real
  // order: a drop against a filtered list computes a `position` from
  // neighbours that are not the habit's actual neighbours, so the write lands
  // somewhere nobody asked for and the rows appear to jump when the query is
  // cleared. The order that goes to the server is the FULL list —
  // `state.habits.map(h => h.id)` — so nothing is dropped from it; what a drop
  // against a subset gets wrong is where in that list the habit lands.
  const reorderable =
    !state.showArchived && !filtering && !grouped && state.habits.length > 1;

  // Same reasoning as `reorderable` just above, and the same two guards:
  // showing archived habits or a filtered subset would draw a mean over a
  // different set than the count sitting right beside it, and a dashboard
  // figure must never include archived habits when `#/categories` excludes
  // them from the very same aggregation. `state.categorySummaries` can still
  // be absent even when this is true — `?archived=true` sends no such key and
  // neither does an older cached payload — and `sectionHeader` treats that the
  // same way, by drawing no figures at all.
  const summarised = grouped && !state.showArchived && !filtering;

  // Sections are drawn over `shown`, which the empty state and the no-match
  // sentence above have already decided there is nothing worth grouping in:
  // an account with no habits gets six empty headers under the onboarding
  // panel, and searching past every result gets "No habits match that."
  // sitting above a full set of headers each reading 0 — a section list
  // answering a question the sentence above it already answered the other
  // way. Neither state has a `shown` to partition in the first place.
  if (grouped && !isEmpty && !noMatch) {
    // Every category in its own `position` order, an empty one still drawing
    // its header (sections may be empty — no collapsing), then an
    // always-present trailing Uncategorised section. `category_id` pointing
    // at a category not in `state.categories` (deleted since this list was
    // fetched) falls into Uncategorised rather than being dropped, so every
    // habit in `shown` is drawn exactly once.
    const byCategory = new Map(state.categories.map((c) => [c.id, []]));
    const uncategorised = [];
    for (const habit of shown) {
      const bucket = habit.category_id != null && byCategory.get(habit.category_id);
      (bucket || uncategorised).push(habit);
    }
    // `null` when `summarised` is false, or when it is true but the payload
    // carries no matching row (or no `categorySummaries` at all) — both read
    // as "nothing to draw" rather than a crash.
    const summaryFor = (id) => (summarised
      ? state.categorySummaries?.find((s) => s.id === id) ?? null
      : null);
    for (const cat of state.categories) {
      grid.append(sectionHeader(
        cat.name, cat.color, byCategory.get(cat.id).length, cat.id, summaryFor(cat.id)));
      for (const habit of byCategory.get(cat.id)) grid.append(habitRow(habit, dates, todayIso, reorderable));
    }
    grid.append(sectionHeader('Uncategorised', null, uncategorised.length, null, summaryFor(null)));
    for (const habit of uncategorised) grid.append(habitRow(habit, dates, todayIso, reorderable));
  } else {
    for (const habit of shown) grid.append(habitRow(habit, dates, todayIso, reorderable));
  }

  restoreFocus(root, focused);
}

/** English plurals — the same trivial rule `ui/categories.js` keeps its own
 * copy of, for the counts this header says out loud. */
const plural = (n, word) => (n === 1 ? word : `${word}s`);

const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * A section header drawn above a category's rows when `groupByCategory` is
 * on. `color` is null for the trailing Uncategorised section, which has none.
 *
 * `summary` is this section's `{members, unloggedExcluded, mean, best, worst}`
 * from `/overview`'s `categorySummaries` (see `summariseMembers`,
 * `shared/src/stats.js`) — or `null`, when there is nothing to draw: while
 * filtering, while showing archived, or when the payload carried no matching
 * row at all. `null` draws exactly what this header always drew, count and
 * all — and so does `summary.members === 0`: `/overview` only fetches
 * active habits, so a category every member of which is archived arrives
 * with `members: 0` too, and is not told apart from an empty one.
 */
function sectionHeader(name, color, count, categoryId, summary) {
  const header = document.createElement('div');
  header.className = 'category-section-header' + (categoryId == null ? ' uncategorised' : '');
  header.dataset.categoryId = categoryId == null ? '' : String(categoryId);
  // A bare `<div>` maps to role="generic", which ARIA specifies as
  // name-prohibited — confirmed against this app's own accessibility tree
  // (CDP `Accessibility.getPartialAXTree`, see `categorycheck.mjs`): a
  // generic element here is never reachable by a screen reader's "next
  // heading" navigation and never reports a `level`, whatever its
  // `aria-label` says. `role="heading"` is the honest fix: this element IS
  // the heading of a section of the list, and it is set unconditionally —
  // for every header, summarised or not — so the markup does not change
  // shape depending on whether a summary happens to be present. Level 2:
  // `#view-list` carries no page-title heading of its own (unlike
  // `#view-categories`'s own `<h2>`), so this is the first heading reached
  // inside it, directly under the app's own `<h1>` in index.html's topbar —
  // level 3 would skip a level.
  header.setAttribute('role', 'heading');
  header.setAttribute('aria-level', '2');
  // Same custom property the category chips set (habit-dialog.js) — a border
  // has to stay legible whatever the category's own colour is, so it is
  // never a filled background.
  if (color) header.style.setProperty('--chip-color', color);

  // Reuses the swatch class the habit dialog's own manage list already
  // defines, rather than a second small coloured dot with its own rule.
  const dot = document.createElement('span');
  dot.className = 'category-swatch';
  if (color) dot.style.background = color;
  header.append(dot);

  const label = document.createElement('span');
  label.className = 'category-section-name';
  label.textContent = name;
  header.append(label);

  const countEl = document.createElement('span');
  countEl.className = 'category-section-count';
  countEl.textContent = String(count);
  header.append(countEl);

  // `summary.members === 0` draws NO figure at all — not a different
  // sentence. `/overview` without `?archived=true` fetches only active
  // habits while `categories` is fetched whole, so a category the user
  // filled and later archived every member of arrives here with
  // `members: 0` too, indistinguishable from one nobody has put anything in
  // — exactly the shape `ui/categories.js` (`sectionCard`, ~line 268-279)
  // already refuses to say "No habits in this category yet." about. The
  // visible `0` beside the name already says everything `/overview` knows;
  // `#/categories` is the surface with the count to explain the rest.
  if (summary && summary.members > 0) {
    const figure = document.createElement('span');
    figure.className = 'category-section-figure';

    const meanEl = document.createElement('span');
    meanEl.className = 'category-section-mean';

    // `title` and the sentence below both use the never-logged sentence
    // `ui/categories.js` already settled on (`sectionCard`, ~line 259-283) —
    // a category with members has members with no strength YET, which is
    // not a strength of zero. `summary.members === 1` reads more obviously
    // than `summary.unloggedExcluded === 1` and is equivalent on this
    // branch: `mean === null` implies `unloggedExcluded === members` here.
    let sentence;
    if (summary.mean === null) {
      meanEl.textContent = '—';
      const reason = `${summary.members} ${plural(summary.members, 'habit')}, `
        + `${summary.members === 1 ? 'never logged' : 'none logged yet'}`
        + ' — no strength to average.';
      figure.title = reason;
      figure.append(meanEl);
      sentence = reason;
    } else {
      meanEl.textContent = pct(summary.mean);
      const spreadEl = document.createElement('span');
      spreadEl.className = 'category-section-spread';
      // A one-member category has `best === worst` by construction
      // (`summariseMembers`), and any tie reads the same way: one number,
      // never `62–62%`.
      const spread = summary.best.score === summary.worst.score
        ? pct(summary.best.score)
        : `${pct(summary.worst.score)}–${pct(summary.best.score)}`;
      spreadEl.textContent = spread;
      const excluded = summary.unloggedExcluded
        ? ` · ${summary.unloggedExcluded} ${plural(summary.unloggedExcluded, 'habit')} never logged, left out`
        : '';
      const detail = `${pct(summary.mean)} average over ${summary.members} `
        + `${plural(summary.members, 'habit')}, spread ${spread}${excluded}`;
      figure.title = detail;
      figure.append(meanEl, spreadEl);
      sentence = detail;
    }
    header.append(figure);
    // The header is not a table row — there is no cell structure an assistive
    // technology could read the figures against — so the whole sentence is
    // named here rather than left to be read off the child text nodes.
    header.setAttribute('aria-label', `${name}, ${sentence}`);
  }

  return header;
}

/** One habit row, built the same way whether the list is flat or grouped. */
function habitRow(habit, dates, todayIso, reorderable) {
  const row = document.createElement('div');
  row.className = 'habit-row' + (habit.archived ? ' archived' : '');
  row.dataset.habitId = String(habit.id);

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
  const nameText = document.createElement('span');
  nameText.className = 'habit-name-text';
  nameText.textContent = habit.name;
  const icon = habitIcon(habit);
  name.append(dot, ...(icon ? [icon] : []), nameText);

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

  row.append(meta, dayCells(listHost, habit, dates, todayIso));
  return row;
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

  // Date row, aligned to the checkbox columns below — built by the same module
  // as the cells, so the captions and the squares cannot disagree about how
  // many columns there are or which one is today.
  gridHead.append(label, nav, dateColumns(dates, todayIso));
}

/** "3 – 16 Aug 2026" — `Intl` decides what the two ends share, and in which order. */
function rangeLabel(dates) {
  // The label always reads oldest to newest, whichever way the row is drawn.
  const [a, b] = dates[0] <= dates[dates.length - 1]
    ? [dates[0], dates[dates.length - 1]]
    : [dates[dates.length - 1], dates[0]];
  // This composed `${day} ${month} ${year}` from a table indexed by
  // `getMonth()` and elided the shared month itself. Both halves were wrong
  // outside a Gregorian, day-first locale — see `formatMonthShort`.
  return formatDayRange(a, b);
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

  $('#empty-new').addEventListener('click', () => openDialog());
  $('#empty-import').addEventListener('click', openDataDialog);

  // Reflow the day grid when crossing the narrow/wide breakpoint (rotation,
  // window resize) so the column count always matches the available width.
  //
  // `dashboardShowing()` and not `openHabitId == null`: `paint()` does not
  // merely reflow, it SHOWS the list and unwinds the fragment. Turning a phone
  // sideways crosses 640px, so with the comparison on screen this used to
  // replace it with the dashboard and fire `history.back()` — a navigation
  // nobody asked for, from a gesture that is not a navigation at all. The
  // reflow is for the grid, and the grid is only on screen when the dashboard
  // is.
  window.matchMedia('(max-width: 640px)').addEventListener('change', () => {
    if (dashboardShowing() && state.habits.length) paint();
  });

  // The dashboard repaints from what it already has; only a 'reload' goes back
  // to the server. Both are ignored while another view is the one showing —
  // painting over it would navigate away from a page nobody had left.
  on('change', () => { if (dashboardShowing()) paint(); });
  on('reload', () => { load().catch((e) => toast(e.message)); });
}
