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

import { formatAmount } from '/shared/ui/amount.js';
import { api } from '/shared/ui/api.js';
import { focusKeyOf, habitIcon, restoreFocus } from '/shared/ui/components.js';
import { convention } from '/shared/ui/count-field.js';
import { openDataDialog } from '/shared/ui/data-dialog.js';
import { dateColumns, dayCells } from '/shared/ui/day-strip.js';
import {
  addDaysISO, datesEndingOn, freqLabel, iso,
  formatDayRange, targetLabel, todayISO,
} from '/shared/ui/dates.js';
import { openDialog } from '/shared/ui/habit-dialog.js';
import * as routes from '/shared/ui/routes.js';
import * as settings from '/shared/ui/settings.js';
import { dashboardShowing, emit, isQueryActive, matchesQuery, on, state } from '/shared/ui/store.js';
import { toast } from '/shared/ui/toast.js';
import { SKIP } from '/shared/ui/values.js';
import * as views from '/shared/ui/views.js';
import { GRID_DAYS, gridColumns } from '/shared/ui/window.js';
import { open as openHabit } from '/shared/ui/detail.js';
import { syncEntry as syncCompareEntry } from '/shared/ui/categories.js';

const $ = (sel) => document.querySelector(sel);

/**
 * How this account spells an amount, for `targetLabel` on a row and on a
 * starter preset. Asked per call rather than held — see the identical
 * declaration in `ui/detail.js`, which has the reason in full.
 */
const showAmount = (n) => formatAmount(n, convention());

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
 * Which dates hold a note, per habit — built in `load()` from `h.notes`,
 * `/overview`'s array of DATES (never the text; see `shared/CLAUDE.md`'s
 * overview payload note on why). A `Set` rather than re-reading `.includes`
 * off the array on every cell paint, and rebuilt wholesale alongside
 * `state.habits` rather than kept in step incrementally: nothing this list's
 * own optimistic writes do ever touches a note (`listHost.edit` sends no
 * `note`, matching `StripHost.edit`'s doc — a plain tap states nothing about
 * one), so the only thing that can move it is a fresh `/overview`.
 *
 * A missing/undefined `h.notes` is read as empty, which is what a stale
 * service-worker-cached `/overview` predating this field sends.
 *
 * @type {Map<number, Set<string>>}
 */
let noteDatesByHabit = new Map();

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
    if (!habit) return { value: undefined, isSkip: false, hasNote: false };
    return {
      // Whether the map HOLDS the date, never what it holds — see the ban on
      // `?? UNSET` in the root CLAUDE.md.
      value: Object.hasOwn(habit.entries, date) ? habit.entries[date] : undefined,
      isSkip: habit.skips?.includes(date) ?? false,
      hasNote: noteDatesByHabit.get(id)?.has(date) ?? false,
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

  // Routed rather than opened in place — see `StripHost.editDay`'s doc
  // (`ui/day-strip.js`) for why: this list holds no note TEXT to seed the
  // dialog with, only which dates hold one, and `saveDay` always STATES the
  // note it holds on save. `openHabit` is this module's own import of
  // `ui/detail.js`'s `open`, already in scope — no new export.
  editDay: (id, date) => { openHabit(id, { editDay: date }); },
};

/**
 * The browser's own local date at the moment the window on screen was FETCHED.
 *
 * The device's calendar day and never a named zone, for the reason
 * `ui/detail.js` gives at its own `renderedDay`: `resolveTimeZone` asks where an
 * ACCOUNT is, so a reminder goes out with nobody present, while every rendering
 * decision here is the question `callerDay` answers for a write
 * (`docs/decisions/timezones.md`).
 *
 * **Recorded at the FETCH and not at the paint, which is where this differs
 * from the detail view's.** There a render is the only way a payload reaches the
 * page; here `paint()` is cheap and runs with no request behind it — a search
 * keystroke, a check-off's optimistic repaint, a `'change'` — and it resolves
 * `todayISO()` itself. So the first keystroke after midnight would move the
 * COLUMNS to the new day while `state.gridLoaded` still ends on the day before,
 * and a record taken at the paint would then report the page as current for a
 * window whose newest column has no data in it at all.
 *
 * Read before the request goes out and installed only when it succeeds, so a
 * load that spans local midnight records the day it ASKED for. That is the safe
 * direction: the watch fires once more and refetches, where recording the day it
 * landed on would leave the page holding the previous day's window and nothing
 * left to say so.
 *
 * **And "it succeeded" is not "it did not throw", which is the whole of the
 * `state.offline` guard below.** A cached answer does not throw: `networkFirst`
 * (`sw.js`) catches a failed or timed-out fetch and returns the last stored
 * `/overview` as an ordinary 200 carrying `X-Habiterall-Offline: 1`, and
 * `ui/api.js` answers that with `setOffline(true)` and then resolves with the
 * payload like any other. Installed on that, this records "current for today"
 * beside a `state.gridLoaded` that ends YESTERDAY — and both triggers then
 * compare equal and return, so the timer will not act again for 24 hours and no
 * tab switch will either, with every row showing yesterday's figures. One failed
 * request is enough: a woken laptop whose Wi-Fi has not reassociated at the
 * instant `visibilitychange` fires, and the tab is wrong until it is reloaded.
 *
 * It does NOT reliably heal itself, which is why this is a guard and not a
 * comment. `api()` calls `setOffline` directly rather than through the watcher,
 * and `ui/connectivity.js` says at `reportOffline` what that costs: the
 * watcher's own `last` stays true, so a later successful probe is not a
 * TRANSITION and the `'reload'` that would have refetched is never emitted.
 *
 * Skipping is the same safe direction as everything above — the page asks again
 * at the next trigger — at the cost of one extra request per tab switch while an
 * account is genuinely offline past midnight, which is the retry that state
 * wants anyway. A boot whose FIRST load answers from cache leaves this null and
 * the watch dormant until a load reaches the server, and that is right too: a
 * page built from a cache of unknown age has no local day to have been drawn
 * for.
 *
 * @type {string | null}
 */
let loadedDay = null;

/**
 * Which `load()` is the current one, and so which reply may still be INSTALLED.
 *
 * `state.categoryReadSeq`'s shape (`ui/store.js`), extended to the rest of what
 * a load writes rather than restated as a second mechanism beside it: take a
 * number before the requests go out, install only while you still hold it.
 * Nothing here is new in kind; what is new is that four more fields are covered
 * by it.
 *
 * **Why it is a second COUNTER and not the same one.** `categoryReadSeq`
 * answers "which view of the category LIST is newest", and three writers bump
 * it that say nothing whatever about this list's habits — `refreshCategoryPicker`
 * (every habit-dialog open), `moveCategory`'s optimistic splice, and the queued
 * DELETE's optimistic removal. Gating `state.habits` on it would throw a
 * dashboard load away because somebody opened a dialog or pressed ↑ on a
 * category, with nothing left to re-issue it. Every `load()` bumps both, so the
 * categories line below needs no second test: a newer load has already retired
 * it through the counter it takes.
 *
 * **What this covers that `categoryReadSeq` deliberately does not.** That
 * counter's own note says `habits` and `categorySummaries` are unticketed
 * because neither has a writer that can be NEWER than the reply — true of a
 * category mutation, and not true of a second `load()`. Two overlapping loads
 * are ordinary: page back and press Today, or press Today while the midnight
 * watch is out, and `/overview` answers two different windows in whatever order
 * it answers them. The older landing last installed a paged window's entries
 * under a grid `paint()` draws from the CURRENT `state.gridEnd` — today's
 * columns, every one of them empty, because those days are outside the window
 * that answered — plus a `state.gridLoaded` that says so and a `loadedDay` that
 * disarms both midnight triggers for the next 24 hours.
 *
 * At module scope rather than on `state` for the reason `categoryReadSeq` gives
 * for the opposite choice: the fields it protects are written in this file
 * alone. A superseded load still `paint()`s, exactly as a superseded category
 * read still repaints — a paint reads current state and can only re-confirm
 * what is there; the ASSIGNMENTS are the half that can be stale.
 */
let loadSeq = 0;

export async function load() {
  // See `loadedDay`: the day this request is asking about, read before it goes
  // out rather than after it lands.
  const askedFor = todayISO();
  // See `loadSeq`. Taken before the first request rather than before
  // `/overview`, because the archive read below installs a field too.
  const ticket = ++loadSeq;

  // The archive toggle is pointless until something has been archived, and this
  // is asked FIRST because the answer can decide which list to fetch below.
  const archived = await api('/habits?archived=true');
  if (ticket === loadSeq) state.hasArchived = archived.length > 0;

  // Unarchiving the last archived habit empties the view you are standing in —
  // and `paint()` hides `#list-head` when nothing is archived, which is where
  // the only control back to the active list lives. So the archive became a
  // room with no door: "No archived habits.", one sentence and zero controls,
  // and the three roads out (`#btn-home`, the detail view's Back, `popstate`)
  // all emit 'reload', which lands here and reads `showArchived` again.
  //
  // Cleared HERE rather than by widening the `hidden` test, because leaving
  // someone on an empty archive with a working toggle answers the trap and not
  // the question: there is nothing left to show, so the active list is where
  // they were going. Ordered before the fetch so the request asks for the list
  // that is about to be painted — clearing it afterwards would draw the
  // onboarding panel over an account that has habits.
  if (state.showArchived && !state.hasArchived) state.showArchived = false;

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
  // This request is also a read of `state.categories`, so it takes a ticket
  // before it goes out — see `categoryReadSeq` in `ui/store.js`.
  const categoryRead = ++state.categoryReadSeq;
  const data = await api(`/overview?${params}`);
  // Everything this reply installs, and nothing this reply does not — see
  // `loadSeq`. A superseded load falls through to the `paint()` below, which
  // redraws from state a newer load has already moved.
  if (ticket === loadSeq) {
    state.habits = data.habits;
    // See `noteDatesByHabit`'s own comment: a missing/undefined `h.notes` —
    // a stale service-worker-cached `/overview` predating the field — reads
    // as empty rather than throwing.
    noteDatesByHabit = new Map(state.habits.map((h) => [h.id, new Set(h.notes ?? [])]));
    // The sort that actually produced `habits` above, from the SAME reply —
    // an absent key means a server with no sort feature at all, whose list
    // is already in `position` order, so `'manual'` is the right answer for
    // it rather than a hedge. See `canReorder`'s `sort` clause and the
    // `habitSort` field's own comment in `ui/store.js`.
    state.habitSort = data.habitSort ?? 'manual';
    // The habit dialog's category picker reads this rather than fetching its
    // own copy — every load already carries it. Installed only while this is
    // still the newest read: `announce()` (ui/habit-dialog.js) sends every OTHER
    // category mutation through `emit('reload')`, which lands here, and a
    // category is created at `MAX(position) + 1` — so "add one, then press ↑ to
    // move it up" puts an arrow press inside this request's own round trip as a
    // matter of course. `/overview` computes every habit's window plus
    // `categorySummaries` against a reorder's few `UPDATE`s, so it is the one
    // likely to lose that race, and its answer knows nothing of the move.
    //
    // Still its own test inside this one, and not folded into it: `loadSeq`
    // says no NEWER LOAD has started, and this says no newer view of the
    // category list has — which a reorder press or a habit-dialog open
    // produces without any load at all. The implication runs one way only
    // (every load bumps both), which is why the categories line keeps the
    // narrower guard and `categorySummaries` beside it does not need one.
    if (categoryRead === state.categoryReadSeq) {
      state.categories = data.categories;
      // ...and say so, because `paint()` below is the DASHBOARD's repaint and
      // the habit dialog's two category controls are views of this same field
      // sitting outside it. This is the one writer of `state.categories` that
      // is not itself in `ui/habit-dialog.js`, and it was the one that told
      // nobody: a reload while the dialog is open left `#category-manage`
      // showing the pre-reload order over a store holding the post-reload one,
      // and `moveCategory` decides from the STORE. See the listener in that
      // file's `init()` for what the disagreement costs a press.
      //
      // Inside the assignment's own guard, so the event means "this field just
      // moved" and not "a load finished": a reply the narrower ticket retired
      // changed nothing here and has nothing to repaint from.
      emit('categories');
    }
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
    // ...and which local day that window was asked for, which is a different
    // question: `end` is the PAGED position when there is one, so it says nothing
    // about whether the clock has moved past what this page was built for.
    //
    // Not when the answer came out of the service worker's cache. `api()` has
    // already set this flag by the time it resolves — a cached answer is a 200,
    // not a throw — and recording a day for a payload that predates it disarms
    // both triggers for the next 24 hours. See `loadedDay`.
    if (!state.offline) loadedDay = askedFor;
  }

  paint();
}

/**
 * The list was fetched for a day that has ended — ask again.
 *
 * `load()` and not `paint()`, and this is the whole reason the dashboard needs
 * its own watch rather than inheriting the detail view's: this page holds only
 * the fortnight it asked for (`shared/public/CLAUDE.md`, "It fetches the window
 * it is showing"), so the new day's column is one the server has never been
 * asked about. A local repaint would draw it empty and then paint every tap on
 * it back out on the next refetch.
 *
 * **Declines while another view is showing, and that is not tidiness.**
 * `load()` ends in `paint()`, which nulls `state.openHabitId`, shows the list
 * and unwinds the fragment — so firing this under an open habit or the category
 * comparison would navigate away from the page somebody is reading, at midnight,
 * with no gesture behind it. It is the same refusal, for the same reason, as the
 * browser reminder's own `refresh` policy (`app.js`) and the `'reload'` guard in
 * `settings-dialog.js`, and it costs nothing: every road back to the list —
 * Back, the Home button, a `popstate` — emits `'reload'`, which lands in
 * `load()` anyway.
 *
 * A PAGED grid is deliberately NOT refused, where the browser reminder refuses
 * it. That refusal is about a window that could not contain today whatever the
 * answer said; this one is about the figures on each row, which both editions'
 * `/overview` anchors on `summaryEnd = today` however far back `end` reaches —
 * so a paged grid goes stale at midnight exactly as an unpaged one does, and
 * `load()` re-sends `state.gridEnd`, so the window the user paged to comes back
 * unchanged.
 */
function refreshIfDayChanged() {
  if (loadedDay === null || loadedDay === todayISO()) return;
  if (!dashboardShowing()) return;
  load().catch((e) => toast(e.message));
}

/**
 * Ask again at the next local midnight — and on the way back to the tab.
 *
 * A restatement of `armDayWatch` in `ui/detail.js` rather than a shared helper,
 * and the reason is the one `showAmount` above is written out in three modules
 * for: a helper either of them could call would be a new export under
 * `shared/public/`, which is a `CACHE_VERSION` bump and so costs every
 * installed client its data cache.
 * Six lines against that is the same trade #313 made. The two watches guard each
 * other's blind spot rather than duplicating work — each one declines unless its
 * own view is the one showing — and both are armed at `init()` whichever view
 * boots, because either can be reached without a reload.
 *
 * **Not a poll.** One timer, armed for the next local midnight and re-armed from
 * the clock each time it fires, so an open page costs one wake-up a day.
 * `setHours(24, 0, 0, 0)` is the start of the next LOCAL day and so is DST-aware
 * — a 23- or 25-hour calendar day gets the right instant, where `+ 86400000`
 * would be an hour out twice a year.
 *
 * **Why the timer alone is not enough, and why the pair is.** A background tab
 * clamps a timer to roughly one a minute, which is harmless — it fires late, and
 * late is still after midnight — but a SUSPENDED device runs no timer at all,
 * and a laptop closed at 23:00 and opened at 09:00 has no promise about when one
 * armed for 00:00 is delivered. `visibilitychange` covers exactly that, and it
 * is the trigger that matters: the staleness costs nothing until somebody LOOKS
 * at the page. Both ask `refreshIfDayChanged`, which compares the date rather
 * than trusting the schedule, so a timer that fires early (or twice) does
 * nothing and neither does a tab switch on the same day — and a zone CHANGE is
 * the same fact arriving by a different route.
 */
let dayTimer = 0;
function armDayWatch() {
  clearTimeout(dayTimer);
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  // A second past the boundary, so the handler cannot read `todayISO()` a
  // millisecond before the day it was armed for has actually ended.
  dayTimer = setTimeout(() => {
    dayTimer = 0;
    refreshIfDayChanged();
    armDayWatch();
  }, Math.max(1000, next.getTime() - Date.now() + 1000));
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

/**
 * Whether dragging is allowed at all.
 *
 * This used to be a four-term `&&` inline at `reorderable`'s own assignment;
 * pulled out and named because `habitSort` (issue #200) is the FIFTH gate and
 * #65 phase 2's grouping work is expected to want a sixth — a growing chain
 * on one line is not where either of those belongs. One clause per line, each
 * with its own one-line reason, so adding a sixth is a line here and nothing
 * at the call site.
 */
function canReorder({ showArchived, filtering, grouped, sort, count }) {
  return (
    // A drop against the archive would compute a `position` from a list this
    // habit is not really a member of.
    !showArchived
    // Same reasoning against a filtered subset: the neighbours a drop
    // computes from are not the habit's actual neighbours, so the write
    // lands somewhere nobody asked for.
    && !filtering
    // `position` is one flat order and `persistOrder` sends a flat id list,
    // so dragging while grouped would clump habits by category permanently —
    // an action that never said it would.
    && !grouped
    // Nothing to drop a lone habit onto.
    && count > 1
    // A drop computes a new `position` from the habit's ON-SCREEN
    // neighbours, and `persistOrder` sends the whole `state.habits.map(h =>
    // h.id)` — which under a sort is the SORTED order, so a single drag
    // would rewrite every habit's stored `position` into the sort's order
    // and destroy the manual order the user is one setting away from
    // returning to. Stored-data corruption, not merely a handle that
    // appears to do nothing — the same hazard the other gates guard.
    && sort === 'manual'
  );
}

export function paint() {
  state.openHabitId = null;
  // ...and neither is the comparison, which this paint is about to cover. Set
  // beside `openHabitId` because the two answer one question between them —
  // see the note on the field in `ui/store.js`.
  state.openCategories = false;
  // The top-bar entry point to that comparison, which `ui/categories.js`
  // owns: this is the one place that runs after `state.categories` has been
  // refreshed. Not every category mutation ends in a 'reload' any more —
  // `moveCategory` (habit-dialog.js) deliberately emits 'change' instead of
  // going through `announce()`, see its own comment — but this still runs
  // after every one of them, because `paint()` is where both events end up.
  // 'reload' reaches it through `load()`, which always ends in a `paint()`
  // (below); 'change' reaches it straight through this file's own listener
  // (`on('change', () => { if (dashboardShowing()) paint(); })`), which is
  // conditional — but that condition is exactly "is this the render this line
  // needs to run for right now", so a 'change' that arrives while some other
  // view is showing costs nothing: `state.categories` is already updated by
  // the time this file's view is next entered, and every path back to it
  // (Back from a habit, from the comparison, on boot) goes through `load()`,
  // which paints from the fresh value regardless of which event got there
  // first.
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

  // Drag handle. See `canReorder` for the gates and their reasons — pulled
  // into its own predicate rather than a growing `&&` chain here, because
  // #65 phase 2 wants a sixth.
  const reorderable = canReorder({
    showArchived: state.showArchived,
    filtering,
    grouped,
    // From the STORE, not `settings.get('habitSort')` — the gate and the
    // order it guards must come from the same `/overview` reply, or a second
    // tab whose settings cache is stale can still see every handle while the
    // list underneath it is sorted (issue #200 review). See the field's own
    // comment in `ui/store.js`.
    sort: state.habitSort,
    count: state.habits.length,
  });

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
    targetLabel(habit, showAmount),
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
    sub.textContent = [freqLabel(preset), targetLabel(preset, showAmount)].filter(Boolean).join(' · ');

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

  // The grid is fetched for ONE local day and nothing else in the app corrects
  // it: the browser reminder's refresh only runs with the `web` channel on and
  // declines a paged grid, and `'reload'` fires on an offline→online transition
  // (`ui/connectivity.js`) or on coming BACK to the list, neither of which is a
  // tab that simply stayed here overnight. See `armDayWatch` for why this is a
  // timer AND a visibility listener rather than either alone.
  armDayWatch();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    refreshIfDayChanged();
  });
}
