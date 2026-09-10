/**
 * View state, and the one channel views hear about changes on.
 *
 * Before this existed, every mutation was followed by a hand-written call to
 * `renderDashboard()` or `showDetail()`, which meant the day editor had to
 * know the detail view existed and the settings dialog had to know about both.
 * Split into modules that becomes a circular import; kept as one file it
 * becomes 2,000 lines. The store is the seam: mutators announce, views listen.
 *
 * Three events. The first two are what a mutator wants; the third is what a
 * WRITER of one shared field owes the views of it that are not on screen:
 *
 *   'change'  the data behind the *currently visible* view moved — repaint it.
 *             Each view decides whether it is the one showing, and whether
 *             repainting means redrawing from `state` or refetching.
 *   'reload'  go to the dashboard and load it from the server. This is what
 *             saving, deleting, importing and syncing all want: the list, as
 *             the server now has it.
 *   'categories'
 *             `state.categories` has just been assigned. Emitted by `load()`
 *             (`ui/dashboard.js`) alone, because that is the field's one
 *             writer outside `ui/habit-dialog.js` — the four in there repaint
 *             both controls themselves, having the list in front of them.
 *
 * The third is deliberately not `'change'`. `'change'` means the VISIBLE view
 * moved and every listener asks whether it is the one showing; the habit
 * dialog is a modal that can be open over any of them, and what it needs told
 * is that one FIELD moved. It is not `'reload'` either, which is emitted
 * BEFORE anything has been fetched — a repaint there would redraw the stale
 * order it exists to replace, and look like a fix. See the listener in
 * `ui/habit-dialog.js`'s `init()` for what the disagreement costs a press.
 *
 * Nothing here touches the DOM, so it is importable from anywhere.
 */

export const state = {
  habits: [],
  // The account's own categories, `{id, name, color, position}[]`. Kept
  // alongside `habits` for the same reason: `/overview` already reads it for
  // the dashboard's (future, behind `groupByCategory`) sections, and the habit
  // dialog's picker needs the same list rather than a fetch of its own.
  categories: [],
  // Which read of `categories` is the CURRENT one. Bumped by everything that
  // starts a read of the list (`refreshCategoryPicker` in `ui/habit-dialog.js`,
  // `load()` in `ui/dashboard.js`) and by the one thing that changes its order
  // without one (`moveCategory`'s optimistic splice); an answer may only be
  // INSTALLED while it still holds the number it took.
  //
  // It lives here rather than beside either reader because the field it
  // protects has readers in two modules and no single owner. `/overview` and
  // `GET /categories` both answer with the whole list, so the last reply to
  // arrive used to win regardless of which was freshest — and once a section
  // can be REORDERED that is not merely a repaint of the same thing: a reply
  // issued before a move, delivered after it, puts the pre-move order back in
  // the store, the next press computes its payload from that, and the SERVER
  // takes the regression. The manage list is not repainted by `load()`, so
  // nothing on screen says it happened.
  //
  // A counter and not a timestamp: `Date.now()` has no ordering guarantee
  // finer than a millisecond, and two of these can start in the same one.
  //
  // **Two other tickets now use this SHAPE, and neither may use this
  // COUNTER.** `loadSeq` (`ui/dashboard.js`) covers the rest of what a
  // `/overview` load installs, and `openSeq` (`ui/detail.js`) covers the
  // `/stats` payload a habit's page renders from. One mechanism — take a
  // number before the request, install only while you still hold it — asked of
  // three different questions, because three writers bump THIS one while
  // saying nothing about a habit's stats or the dashboard's grid:
  // `refreshCategoryPicker`, `moveCategory`'s splice and the queued DELETE's
  // optimistic removal. Sharing the counter would throw a habit's page or a
  // dashboard load away because somebody opened the habit dialog. They live at
  // module scope in the files that write them, which is this field's own
  // placement rule applied the other way round: the two of them have one owner
  // each, and this one has none.
  //
  // What that changes about the note below: `habits` and `categorySummaries`
  // are still not guarded by THIS counter, and are no longer unguarded — see
  // `loadSeq`.
  categoryReadSeq: 0,
  editingId: null,
  openHabitId: null,   // habit shown in the detail view, null on the dashboard
  // The category comparison is showing. It is a THIRD answer to the question
  // `openHabitId == null` used to settle on its own — "is the dashboard what
  // the user is looking at?" — which several guards ask before repainting or
  // reloading the list. Left out, opening Settings from the comparison and
  // pressing Done emits a 'change' the dashboard answers by painting itself
  // over a view nobody had left. **Read it through `dashboardShowing()` below,
  // never as a second hand-written conjunction** — that is the whole reason the
  // predicate exists.
  openCategories: false,
  // null means "use the saved setting". The per-habit toggles set these for
  // the session, so trying a different view does not rewrite your default —
  // same arrangement as calZoom below.
  granularity: null,
  historyMode: null,
  scoreGranularity: null,  // resolution of the strength chart; null = default
  // Paging position per windowed chart, keyed by chart. Columns back from the
  // most recent, so 0 is always "now" — survives the re-render each page
  // button triggers.
  chartOffsets: {},
  calEnd: null,        // last date shown in the calendar; null = today
  calZoom: null,       // overrides the saved zoom for this session; null = use the setting
  dayEdit: null,       // { habitId, date, type } while the day dialog is open
  dragId: null,        // habit being dragged, while a reorder is in flight
  // What the dashboard's search box holds. Session-only and deliberately NOT a
  // setting: a filter is something you are doing right now, and one that
  // followed you to another device — or survived a reload — would be a list
  // silently missing habits with no memory of why.
  query: '',
  showArchived: false, // dashboard is showing the archive rather than active
  hasArchived: false,  // any archived habits exist at all
  gridEnd: null,       // last day column shown; null = today
  // The window `/overview` actually ANSWERED with, `{start, end}`, or null
  // before anything has been loaded. `gridEnd` is what was ASKED for and says
  // nothing about what came back: the server clamps a future `end` to the
  // caller's own today, and a failed request leaves the previous habits in
  // place. Anything reading `habit.entries` for a date needs this, because
  // outside the range a missing key means "never fetched" — a FIFTH state,
  // not one of the four. `outstanding` in ui/nudge.js refuses to judge a day
  // outside it.
  gridLoaded: null,
  // The RESOLVED sort `/overview` applied to `habits`, from the SAME reply —
  // never a separately fetched setting, which can disagree with the order
  // that actually arrived (issue #200 review). `'manual'` until the first
  // load answers, which is also what an absent key on the payload means: a
  // server with no sort feature at all, whose list is already in `position`
  // order. `canReorder` (`ui/dashboard.js`) gates on this field, not on
  // `settings.get('habitSort')`.
  habitSort: 'manual',
  offline: false,      // showing cached data / writes are being queued
  pending: 0,          // writes waiting in the outbox
};

/**
 * Whether the DASHBOARD is the view the user is looking at.
 *
 * **One question, one predicate, and it is here because it has already been
 * copied wrong.** Six places need it — `app.js` twice (which view a traversal
 * lands on, and whether the browser reminder may reload the list),
 * `dashboard.js` twice (the `'change'` listener and the breakpoint reflow),
 * `settings-dialog.js` once and `habit-dialog.js` five times — and until
 * `#/categories` existed they could all spell it `state.openHabitId == null`
 * and be right. Adding a second full-page view made that spelling wrong at
 * every one of them at once, and the two that were missed on the first pass
 * failed in exactly the way this file's comment on `openCategories` predicts:
 * the breakpoint reflow painted the dashboard over the comparison on a phone
 * ROTATION, and the habit dialog's `'reload'` did the same on Save. Neither is
 * a `routes.js` question — the URL is already right — it is only ever "is the
 * list what is on screen".
 *
 * A function rather than a getter on `state`, so it cannot be spread, cached
 * into a local at render time, or serialised into a payload by accident.
 *
 * A THIRD view means editing this and nothing else. That is the point.
 */
export function dashboardShowing() {
  return state.openHabitId == null && !state.openCategories;
}

/** Fold case and strip the accents, so "cafe" finds "Café". */
const fold = (s) => String(s ?? '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/**
 * Whether a query is actually filtering — i.e. has something left after the
 * same fold+trim `matchesQuery` runs, not just whitespace or combining marks.
 *
 * A query of only combining accents (say a stray U+0300) is empty once folded,
 * so `matchesQuery` matches everything with it; the dashboard's old
 * `!!state.query.trim()` still saw it as live and lit the indicator for a
 * filter that was doing nothing. Asking the question here keeps the two
 * callers — `matchesQuery` and the dashboard's "filter live" flag — on one
 * definition of "active", so they cannot drift again.
 *
 * @param {string} [query]  defaults to the live one
 */
export function isQueryActive(query = state.query) {
  return !!fold(query).trim();
}

/**
 * Whether a habit is one the dashboard's filter is currently showing.
 *
 * It lives beside `query` rather than in `dashboard.js` because two modules
 * ask it and only one of them paints: `habit-dialog` has to know whether the
 * habit it just saved would be visible before deciding whether to clear the
 * box, and `dashboard` imports `habit-dialog` already. This file touches no
 * DOM and imports nothing, so both can have it.
 *
 * Name AND description, exactly as the list does — a habit called "Gym" whose
 * description says "swimming Tuesdays" is one people look for by the second,
 * which is also why editing only the description can move a row out of a
 * filtered list. An empty query matches everything, so a caller asking about a
 * list nobody is filtering gets `true` and needs no special case.
 *
 * @param {{name?: string, description?: string}} habit
 * @param {string} [query]  defaults to the live one
 */
export function matchesQuery(habit, query = state.query) {
  const q = fold(query).trim();
  if (!isQueryActive(query)) return true;
  return fold(habit.name).includes(q) || fold(habit.description).includes(q);
}

/**
 * Whether a habit would be on the dashboard as it is currently set up.
 *
 * This is the question a MUTATOR has to ask, and it is deliberately wider than
 * the filter. `load()` fetches the active habits or the archived ones and never
 * both, so the **Archived** checkbox — which `openDialog` renders for every
 * existing habit — takes a row off the list without touching either field the
 * filter reads. Asking `matchesQuery` alone left "No habits match that." over an
 * archive that had just succeeded: the very sentence the rename case exists to
 * prevent, arriving by the one route that predicate cannot see.
 *
 * It is also why `deleteHabit` clears unconditionally rather than asking. For a
 * habit that no longer exists this is false however the account is set up, so
 * the constant there IS this rule, resolved in advance.
 *
 * @param {{name?: string, description?: string, archived?: unknown}} habit
 */
export function staysOnList(habit) {
  return !!habit.archived === state.showArchived && matchesQuery(habit);
}

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

/**
 * Listen for an event. Returns an unsubscribe function, which nothing needs
 * yet — the views live as long as the page does — but a listener you cannot
 * remove is the kind of thing that is painful to add later.
 *
 * A listener may take one argument, `what` — see `emit`. Every listener that
 * does must still be correct with `undefined`, because most emitters send
 * nothing at all.
 *
 * @param {'change'|'reload'|'categories'} event
 * @param {(what?: any) => void} fn
 */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

/**
 * Announce an event. Listeners are called in registration order, and a throw
 * from one must not silence the rest: a failed repaint of one view is a bug,
 * but leaving the others stale on top of it is a worse one.
 *
 * **`what` is the thing the mutator already HAS, never a description of what
 * changed.** It stays a hand-off and does not become a second channel: an
 * emitter may pass the object the server just accepted, and a listener may use
 * it to paint before its own refetch answers. Nothing is stored here — a
 * payload that outlived the emit would be a second source of truth for the
 * state above, which is the drift this file exists to prevent — and every
 * listener has to be right when it is absent, because most emitters send
 * nothing.
 *
 * The one emitter today is `habit-dialog.js`'s `announce`, handing on the reply
 * to `PUT /habits/:id`, so that a habit's own page can redraw its head from the
 * habit that was actually stored instead of showing the pre-save one for the
 * length of two round trips. Its listener is `ui/detail.js`'s.
 *
 * @param {'change'|'reload'|'categories'} event
 * @param {any} [what] the mutator's own copy of what it just wrote
 */
export function emit(event, what) {
  for (const fn of listeners.get(event) ?? []) {
    try {
      fn(what);
    } catch (e) {
      console.error(`listener for "${event}" failed`, e);
    }
  }
}

/**
 * Merge a patch into the state and announce it.
 *
 * Only for changes a view should react to. Bookkeeping that no view renders
 * — `editingId`, `dayEdit` — is assigned directly, because firing 'change'
 * for it would repaint the page behind an open dialog for no reason.
 *
 * @param {Partial<typeof state>} patch
 */
export function set(patch) {
  Object.assign(state, patch);
  emit('change');
}
