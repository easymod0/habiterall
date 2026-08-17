/**
 * Boot, the top bar, and the progressive-web-app plumbing.
 *
 * The views and dialogs each own their own markup and wiring; this file
 * starts them in order and owns only the chrome that belongs to no single
 * view. `start(authAdapter)` is the entry point both editions call.
 *
 * The UI is auth-agnostic: nothing here mentions sign-in beyond calling the
 * injected adapter, which is what keeps the two editions from drifting apart.
 */

import { setAuth } from '/shared/ui/api.js';
import * as connectivity from '/shared/ui/connectivity.js';
import * as dashboard from '/shared/ui/dashboard.js';
import * as dataDialog from '/shared/ui/data-dialog.js';
import { todayISO } from '/shared/ui/dates.js';
import * as detail from '/shared/ui/detail.js';
import * as dayDialog from '/shared/ui/day-dialog.js';
import * as habitDialog from '/shared/ui/habit-dialog.js';
import * as nudge from '/shared/ui/nudge.js';
import * as routes from '/shared/ui/routes.js';
import * as settingsDialog from '/shared/ui/settings-dialog.js';
import * as settings from '/shared/ui/settings.js';
import { emit, state } from '/shared/ui/store.js';
import { initTheme, toggleTheme } from '/shared/ui/theme.js';
import { toast } from '/shared/ui/toast.js';
import { showError } from '/shared/ui/views.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Boot could not get far enough to show anything. Say so, somewhere that stays.
 *
 * A toast was the whole handling here, and a toast clears itself after two and
 * a half seconds. That was survivable while `#view-list` was visible from the
 * markup; it stopped being so when the list became hidden until the session is
 * known and `adapter.load()` started throwing for every answer that is neither
 * 200 nor 401. A 500, a proxy's 502, or the service worker's synthetic 503 —
 * which is what the first offline boot after a CACHE_VERSION bump gets, since
 * the bump drops the data cache /api/me would have been served from — then
 * left an entirely blank page.
 */
function showBootError(message) {
  showError();
  const text = $('#boot-error');
  if (text) text.textContent = message;

  const retry = $('#boot-retry');
  // A reload rather than re-entering start(): the same reasoning the sign-in
  // form uses after a successful login — one boot path is enough to keep right.
  if (retry) retry.addEventListener('click', () => window.location.reload(), { once: true });
}

function initTopBar() {
  // The app title doubles as "home". Reloads rather than just switching views,
  // so returning from a detail page shows current data.
  $('#btn-home').addEventListener('click', () => emit('reload'));

  // Nothing follows the switch. It used to refetch and redraw the detail view,
  // because the charts had resolved the old palette into their attributes —
  // which made a colour change cost two requests and, when they did not land,
  // leave the old theme's colours on screen. The charts now name the CSS
  // variables instead, so the cascade does this.
  $('#btn-theme').addEventListener('click', () => {
    // Reported, not discarded: `save` drops a 429, a 500 or a 403, and the
    // button used to write localStorage and could not fail at all.
    toggleTheme().then((r) => { if (!r?.ok) toast(r?.error ?? 'Could not save the theme'); });
  });
}

/**
 * Back and Forward, and a fragment typed or pasted into the address bar.
 *
 * The check against what is already showing is what keeps this from fighting
 * the views: opening a habit writes the URL, and without the guard the event
 * that follows would reopen — and refetch — the habit already on screen.
 */
function initRouting() {
  routes.init((route) => {
    if (route.view === 'habit') {
      if (route.id !== state.openHabitId) detail.open(route.id);
    } else if (state.openHabitId != null) {
      // 'reload' rather than a repaint: the dashboard is coming back after a
      // detour, and the entries behind it may have moved since.
      emit('reload');
    }
  });
}

/**
 * App shortcuts (long-press the launcher icon) arrive as a query parameter.
 * Strip it afterwards so a refresh doesn't reopen the dialog.
 */
function handleLaunchAction() {
  const action = new URLSearchParams(location.search).get('action');
  if (!action) return;
  history.replaceState({}, '', location.pathname);
  if (action === 'new') habitDialog.openDialog();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Registered at the origin root so its scope covers the whole app.
  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .catch((e) => console.warn('service worker registration failed', e));
}

/**
 * Boot the app with an edition-specific auth adapter.
 * @param adapter  see auth-session.js
 */
export async function start(adapter) {
  setAuth(adapter);

  const logout = $('#btn-logout');
  if (logout) logout.addEventListener('click', () => adapter.signOut());

  // Wiring first, and synchronously: every listener must be attached before
  // the first `emit`, and the connectivity watcher should be running before
  // the awaits below — those are the requests most likely to find no network.
  initTopBar();
  connectivity.init();
  habitDialog.init();
  dayDialog.init();
  dataDialog.init();
  settingsDialog.init();
  dashboard.init();
  detail.init();
  initRouting();
  registerServiceWorker();

  // The browser's own reminder. Wired here, with the other listeners, because
  // its second trigger is `visibilitychange` and that has to be attached before
  // the awaits below — a tab backgrounded during boot is exactly the case it is
  // for. INJECTED rather than importing what it needs, which is what keeps
  // `ui/nudge.js` free of imports and so testable under Node; every one of
  // these belongs to somebody else.
  nudge.init({
    habits: () => state.habits,
    // ...and the window they came from, which is half of the same answer. A
    // grid paged back a fortnight holds entries that stop before today, where
    // a missing key means "never fetched" and not "no row".
    loaded: () => state.gridLoaded,
    // What to do when that window falls short of today. The POLICY is here and
    // not in `ui/nudge.js`, because it turns on what the user is looking at and
    // that is `state`'s to know.
    //
    // Two refusals, each of them a thing that would otherwise go wrong. A grid
    // the user PAGED back is meant to exclude today, so reloading it would undo
    // a deliberate act — pressing Today is how they undo it themselves. And a
    // habit open over the dashboard must not have the list reloaded underneath
    // it: `dashboard.paint()` clears `openHabitId` and shows the list, so a
    // nudge would navigate away from the page somebody is reading. That is the
    // same guard, for the same reason, as the `'reload'` in settings-dialog.js.
    //
    // What is left is the case with no other cure: a tab open across local
    // midnight, holding a window that ends yesterday because nothing in the app
    // refreshes on `visibilitychange` — `syncNow` returns early on an empty
    // queue, and `'reload'` fires only on an offline→online transition.
    refresh: async () => {
      if (state.gridEnd || state.openHabitId != null) return;
      await dashboard.load();
    },
    enabled: () => settings.get('notifyChannels') ?? [],
    // The browser's own calendar day, from the app's one `iso()`. Never a
    // named zone: this is the question `callerDay` answers for a write.
    today: todayISO,
    fallback: toast,
  });

  // Read before anything paints. `dashboard.load()` below puts the app at the
  // list, which rewrites the fragment — so a link straight to a habit has to
  // be taken now or it is gone by the time there is somewhere to use it.
  const opening = routes.current();

  // The button is this module's, so the label is written here; `theme.js`
  // only says what it should read. Two modules reaching for one id is what
  // `test/ui-modules.test.js` refuses.
  initTheme({
    onLabel: (text, glyph) => {
      const button = $('#btn-theme');
      button.title = text;
      button.setAttribute('aria-label', text);
      // The VISIBLE half, and the only one a phone has: `title` needs a
      // pointer to hover and `aria-label` needs a screen reader. With a
      // static glyph the one press that cannot change the pixels — back to
      // `system` from a value the device already matches — looked like a
      // dead control on the app's primary target.
      button.textContent = glyph;
    },
  });
  connectivity.refreshOfflineBadge();

  try {
    // Resolve the session before fetching anything user-scoped.
    const user = await adapter.load();
    adapter.render(user);
    if (!user) return;            // signed out: the sign-in view is showing

    // Preferences are server-side, so they must arrive before the first
    // render or the dashboard paints with the wrong day order and flips.
    // `ui/theme.js` reconciles itself from the reply this makes: the route
    // says which keys the account actually HOLDS, which is the one question a
    // cached value cannot answer. There used to be a `migrateTheme()` call
    // here that re-asked the same route a second time.
    await settings.init();

    if (opening.view === 'habit') {
      // A link straight to a habit does NOT paint the list on the way. It used
      // to load and render the dashboard first, so every deep link showed a
      // full grid of every habit for as long as the stats request took and
      // then replaced it — the app looked like it had opened the wrong screen,
      // and in the Android client, where tapping a habit is the ordinary way
      // in, that flash was on the path most travelled. Nothing else needs the
      // list: `state.habits` is the dashboard's alone, and Back reloads it.
      //
      // The URL still moves through the list, because that is the entry Back
      // returns to. `paint()` is what normally writes it, and skipping the
      // paint would otherwise mean Back from a deep-linked habit left the site
      // rather than reaching the dashboard.
      routes.go(routes.LIST);
      // Falling back to the list when the habit will not open, or a deleted
      // habit's link leaves the app showing nothing at all.
      if (!await detail.open(opening.id)) await dashboard.load();
    } else {
      await dashboard.load();
    }
  } catch (e) {
    // Everything above this line runs before anything is on screen, so there is
    // no view left for a toast to sit under — see `showBootError`.
    return showBootError(e.message);
  }

  // Outside the guard on purpose: by here the app has painted, so a failure is
  // one action going wrong rather than a boot that did not happen, and
  // replacing the dashboard with an error page would be the larger loss.
  try {
    handleLaunchAction();
  } catch (e) {
    toast(e.message);
  }

  // ...and the same reasoning one step further: the nudge is the last thing
  // boot does, after everything it reads has been painted. A deep link opens
  // one habit and never loads the list, so `state.habits` is empty and this
  // finds nothing — which is honest rather than a gap, and Back reloads the
  // list. `check` swallows its own failures; nothing here depends on it.
  nudge.check().catch(() => {});
}
