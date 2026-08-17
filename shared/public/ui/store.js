/**
 * View state, and the one channel views hear about changes on.
 *
 * Before this existed, every mutation was followed by a hand-written call to
 * `renderDashboard()` or `showDetail()`, which meant the day editor had to
 * know the detail view existed and the settings dialog had to know about both.
 * Split into modules that becomes a circular import; kept as one file it
 * becomes 2,000 lines. The store is the seam: mutators announce, views listen.
 *
 * Two events, because there are only two things a mutator ever wants:
 *
 *   'change'  the data behind the *currently visible* view moved — repaint it.
 *             Each view decides whether it is the one showing, and whether
 *             repainting means redrawing from `state` or refetching.
 *   'reload'  go to the dashboard and load it from the server. This is what
 *             saving, deleting, importing and syncing all want: the list, as
 *             the server now has it.
 *
 * Nothing here touches the DOM, so it is importable from anywhere.
 */

export const state = {
  habits: [],
  editingId: null,
  openHabitId: null,   // habit shown in the detail view, null on the dashboard
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
  offline: false,      // showing cached data / writes are being queued
  pending: 0,          // writes waiting in the outbox
};

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

/**
 * Listen for an event. Returns an unsubscribe function, which nothing needs
 * yet — the views live as long as the page does — but a listener you cannot
 * remove is the kind of thing that is painful to add later.
 *
 * @param {'change'|'reload'} event
 * @param {() => void} fn
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
 * @param {'change'|'reload'} event
 */
export function emit(event) {
  for (const fn of listeners.get(event) ?? []) {
    try {
      fn();
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
