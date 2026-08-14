/**
 * Which view the URL names, and how the URL is kept in step with it.
 *
 * The app had no routing at all: the dashboard and the detail view were
 * toggled by `views.js` and the address bar never moved, so a habit could not
 * be linked to, bookmarked, or reopened after a reload. The native Android
 * client is what forced the question — tapping a habit there has to land on
 * that habit's stats, not on the dashboard with the habit to find again.
 *
 * **A fragment, not a path.** `#/habit/42` is never sent to the server, so
 * neither edition's static serving changes, the service worker's navigation
 * fallback still matches the shell it already caches, and there is no build
 * step to teach about rewrites. A real path would need all three taught, in
 * both editions, to reach the same place.
 *
 * DOM-free at import time, so the parsing below is unit-tested in Node —
 * the same arrangement `window.js` and `calendar.js` already use. The three
 * functions that touch `location` and `history` are only ever called from a
 * browser.
 */

/**
 * @typedef {{view: 'list'} | {view: 'habit', id: number}} Route
 */

/** The dashboard: the route with no fragment. @type {Route} */
export const LIST = { view: 'list' };

/**
 * `#/habit/<id>`, and nothing else.
 *
 * Anchored at both ends and digits only. This is the one string in the app
 * that arrives from outside — a bookmark, a shared link, whatever someone
 * typed — so it is matched rather than picked apart.
 */
const HABIT_RE = /^#?\/habit\/(\d+)$/;

/**
 * The route a fragment names.
 *
 * Never throws and never returns null: anything unrecognised is the list,
 * because the alternative is an error screen for a typo in a URL.
 *
 * @param {string} [hash]  `location.hash`, with or without its leading '#'
 * @returns {Route}
 */
export function parseRoute(hash = '') {
  const match = HABIT_RE.exec(String(hash).trim());
  if (!match) return LIST;

  const id = Number(match[1]);
  // A 30-digit id parses to a float, which is not an id and would be sent to
  // the server as one. `\d+` alone does not bound what Number() can produce.
  if (!Number.isSafeInteger(id) || id <= 0) return LIST;

  return { view: 'habit', id };
}

/**
 * The fragment that names a route — '' for the list, since the dashboard is
 * the app with nothing after the '#'.
 *
 * @param {Route} [route]
 * @returns {string}
 */
export function hashFor(route) {
  return route?.view === 'habit' ? `#/habit/${route.id}` : '';
}

/** The route the address bar currently names. @returns {Route} */
export function current() {
  return parseRoute(location.hash);
}

/**
 * The fragment this module last acted on, and whether the entry showing is one
 * it pushed.
 *
 * Both exist because a fragment traversal fires `popstate` *and* `hashchange`,
 * and because an entry that was pushed has to be unwound rather than written
 * over. Read the two functions below together; neither makes sense alone.
 */
let handled = null;
let ourEntry = false;

/**
 * Point the URL at a route, without navigating.
 *
 * Two rules, each paid for by a different problem:
 *
 * **Nothing happens when the URL already says this.** `detail.open()` is
 * re-entered by every control in the detail view — the zoom buttons, calendar
 * paging, the granularity toggles — so writing the URL on each of those would
 * stack a history entry per button press and leave Back walking through a
 * dozen redraws of one habit.
 *
 * **A habit is pushed, and going back to the list UNWINDS that push.** The
 * habit needs an entry of its own, or Back cannot leave it — in the Android
 * WebView that is the system back gesture, walking the page history before it
 * leaves the screen. But returning to the list used to `replaceState` over
 * that entry rather than pop it, which left a duplicate behind: after five
 * habits the user pressed Back six times, five of them changing nothing, and
 * in the TWA that reads as an app refusing to close. `history.back()` is
 * therefore how the list is reached whenever the entry showing is one we
 * pushed; `replaceState` remains for every other case, including the first
 * paint of a cold deep link, where there is nothing of ours to unwind.
 *
 * @param {Route} route
 */
export function go(route) {
  const hash = hashFor(route);
  if (location.hash === hash) return;

  if (route?.view === 'habit') {
    history.pushState(null, '', hash);
    handled = hash;
    ourEntry = true;
    return;
  }

  if (ourEntry) {
    // Unwind. The traversal fires the listener below, which sees the view has
    // already changed and does nothing — this is a URL correction, not a
    // navigation the app still has to carry out.
    ourEntry = false;
    handled = '';
    history.back();
    return;
  }

  // The path without a fragment, rather than a bare '#', which is a URL that
  // survives a copy-paste looking like a mistake.
  handled = '';
  history.replaceState(null, '', location.pathname + location.search);
}

/**
 * Call `onRoute` whenever the user moves through history.
 *
 * Both events are listened for, because they do not agree across browsers: a
 * fragment typed into the address bar fires `hashchange`, while traversing an
 * entry this module pushed fires `popstate`. Chrome fires BOTH for one Back
 * press — measured — and the fragment is what identifies a navigation, so the
 * second event is dropped by comparing against the last one acted on. Without
 * that, one Back press ran the whole route change twice: two dashboard loads,
 * four requests. Do not reach for a "call it twice, it is idempotent"
 * argument here; the second call is a refetch, and the guard in app.js reads
 * state that the first call has not finished updating.
 *
 * @param {(route: Route) => void} onRoute
 */
export function init(onRoute) {
  handled = location.hash;
  // Nothing showing is ours yet, even when the URL already names a habit: a
  // cold deep link is the *first* entry, and unwinding it would leave the site
  // entirely. The first paint replaces it, and opening the habit pushes a real
  // one — see `go`.
  ourEntry = false;
  const fire = () => {
    if (location.hash === handled) return;
    handled = location.hash;
    // Landing on a habit means that entry is one we pushed — nothing else
    // creates one — so it stays unwindable after a Forward as well as a Back.
    ourEntry = parseRoute(location.hash).view === 'habit';
    onRoute(current());
  };
  window.addEventListener('hashchange', fire);
  window.addEventListener('popstate', fire);
}
