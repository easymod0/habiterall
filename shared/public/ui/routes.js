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
 * **A habit is pushed, the list replaces.** The list is home: Back already
 * goes there, so giving it its own entry only adds a step that looks like it
 * did nothing. Pushing the habit is what makes Back leave it — which in the
 * Android WebView is the system back gesture, walking the page history before
 * it leaves the screen.
 *
 * @param {Route} route
 */
export function go(route) {
  const hash = hashFor(route);
  if (location.hash === hash) return;

  // For the list: the path without a fragment, rather than a bare '#', which
  // is a URL that survives a copy-paste looking like a mistake.
  const url = hash || location.pathname + location.search;
  if (route?.view === 'habit') history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

/**
 * Call `onRoute` whenever the user moves through history.
 *
 * Both events, because they do not agree across browsers: a fragment typed
 * into the address bar fires `hashchange`, while traversing entries this
 * module pushed fires `popstate`. Listening to one of them leaves the Back
 * button dead in some browsers and not others, and `go()` above means a
 * duplicate call costs nothing.
 *
 * @param {(route: Route) => void} onRoute
 */
export function init(onRoute) {
  const fire = () => onRoute(current());
  window.addEventListener('hashchange', fire);
  window.addEventListener('popstate', fire);
}
