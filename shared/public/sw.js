/**
 * habiterall service worker.
 *
 * Two jobs:
 *   1. Keep the app shell available offline (cache-first, revalidated).
 *   2. Serve the last-known API data when the network is unavailable, so the
 *      dashboard still renders on a train.
 *
 * Writes are NOT handled here — they go through the outbox in app.js, which
 * owns retry ordering and the optimistic UI. A service worker replaying POSTs
 * blindly would reorder them and lose the user-visible state.
 *
 * Bump CACHE_VERSION whenever the shell assets change; old caches are dropped
 * on activate so a deploy cannot strand users on stale JS.
 */

/**
 * `self` in a service worker is a ServiceWorkerGlobalScope, not a Window;
 * without this the checker rejects skipWaiting() and clients.claim().
 * @type {ServiceWorkerGlobalScope & typeof globalThis}
 */
// @ts-ignore -- redeclaring the global for type purposes only
const sw = self;

// v17: the browser's own reminder. `ui/nudge.js` is a new shell asset that
// `app.js` imports STATICALLY, and it is BOTH earlier cases at once — this note
// has now been written wrong in each direction, so both halves are set out.
//
// It is v9's: a brand-new module an installed PWA would otherwise fetch on
// first use, which is to say be offline for at exactly the moment a nudge needs
// it.
//
// And it is v14's after all, which a rewrite of this note wrongly denied on the
// grounds that an old shell serving the old app.js links fine. It does — but
// that is not the state the window produces. `shellFirst` is
// stale-while-revalidate and it writes into the RUNNING worker's SHELL_CACHE,
// so while a v16 worker is still in control (the v17 install fetches every
// asset first), a request for `/shared/app.js` serves the old file and stores
// the NEW one into `habiterall-shell-v16`, which has no nudge.js. Offline in
// that window the static import is a module link error before `start()` — so
// outside the `#view-error` surface, which is a blank page. That is the v14
// note further below, verbatim: the revalidate is per request and not atomic.
//
// What the bump does about it is worth stating exactly, because it is not what
// it looks like. `install` re-runs `SHELL.map(cache.add)` on any change to this
// file, into whichever cache is NAMED — so unbumped, nudge.js would land in the
// v16 shell sooner and with the data cache intact. The bump's actual effect is
// that the new shell is built under a name of its own and the old one is
// dropped on `activate`, so no request can mix the two. Note it is atomic at
// the CACHE level and not at the asset level: `install` uses
// `Promise.allSettled`, so a partly populated new shell is a normal outcome and
// the old one is deleted regardless. It costs every installed client its data
// cache, which is why the first offline boot afterwards gets the synthetic 503
// that `#view-error` exists for. Nothing in index.html or style.css moved.
//
// v16: the search filter's predicate moved to ui/store.js, so dashboard.js and
// habit-dialog.js both IMPORT `matchesQuery` from it — the v14 case exactly,
// one module over. A shell holding the new dashboard.js and the old store.js
// is a link error rather than a wrong answer, and it happens before `start()`.
// Nothing about the markup moved, which is what makes this bump about the
// atomicity of the swap and nothing else.
//
// v15: `ui/amount.js` gained `amountComplaint`, and then `resolveNumberFormat`
// and `deviceDecimalSeparator` with the decimal-separator setting;
// `ui/count-field.js` imports all three, and `ui/settings.js` for the account's
// answer. Both are shell assets and both are SCRIPTS, which `shellFirst` serves
// cache-first while revalidating per request — so the swap is not atomic and
// the two can land a load apart. New count-field.js over a cached old
// amount.js is a module LINK error: no such export, so count-field.js never
// evaluates, app-entry.js never evaluates, and the app boots to nothing. That
// is v14's case with the arrow the other way round, and the precache is again
// what makes it all-or-nothing. It self-heals on the load after, since the
// broken boot still revalidates amount.js — which is a reason to bump rather
// than a reason not to: being wrong costs a blank screen, and the bump costs
// one refetch of data the client is about to refetch anyway.
// v13: the habit search. `index.html` grew `#search-row`, `#habit-search`,
// `#search-count` and `#empty-nomatch`, and dashboard.js looks all four up at
// module scope and dereferences them in `paint()` — so a stale v12 shell with
// the new script is the v11 and v12 failure mode again, verbatim.
// v12: the amount field. `index.html` grew a second dialog and the
// day editor's number input became a control, so a stale shell with
// new scripts has no `#day-count` to bind and throws at module scope —
// before `start()`, which is outside the `#view-error` surface.
// v11: the offline strip gained `#offline-message`, because the queued-write
// count stopped being a child of the banner. connectivity.js looks that element
// up at module load and paints through it, so a cached v10 index.html would
// hand it `null` and throw on the first render — on the write path, which is
// where the app now says it is offline. index.html and style.css are both shell
// assets; either one served stale is the v6 case again.
//
// v9: the day grid and the day editor started importing ui/toggle.js, which is
// a new shell asset. An installed PWA holding the old shell would fetch it on
// first use — and be offline exactly when a tap needs it.
//
// v7: app.js was split into one module per view and dialog, so an installed
// PWA holding the old single file alongside the new index.html would boot a
// shell whose scripts no longer exist.
//
// v10: sign-in. index.html gained the form, style.css its rules, and the two
// auth adapters became one — so a cached shell served `app-entry.js` importing
// `/shared/auth-none.js`, which is deleted from disk but still resident in the
// v9 cache. `activate` drops caches by NAME, so without a bump the old module
// survives the upgrade: the no-auth adapter, whose `onUnauthorized()` returns
// false, running against a server where auth now defaults ON. An empty
// dashboard, an error toast, and no sign-in form to fix it with. The v9 DATA
// cache also holds `/api/me` answers from before `mode` existed, which the
// adapter would read as "this instance has no auth".
//
// v14: the theme became a setting, which moved app.js, ui/settings.js and
// ui/theme.js together — and ui/theme.js now IMPORTS `onApply` from
// ui/settings.js. That makes the bump load bearing rather than tidy: the only
// refresh a stale shell gets otherwise is `shellFirst`'s revalidate, which is
// per request and not atomic, so a shell holding the new theme.js and the old
// settings.js is a module LINK error — `onApply` is not an export of that file
// — and app-entry.js never evaluates. An installed PWA boots to a blank page.
// The precache stops a request mixing the two, because the new shell is built
// under its own name. (This line used to read "makes the swap all-or-nothing",
// which overstates it: `install` uses `Promise.allSettled`, so a partly
// populated new shell is a normal outcome and `activate` deletes the old one
// either way. Atomic at the cache NAME, not at the asset.)
//
// v6: the habit dialog gained the reminder time picker and the "what the
// reminder asks" field. index.html is a shell asset, so without a bump an
// already-installed PWA would keep serving the old markup — and app.js, which
// builds the picker from those elements at load, would find nothing there.
//
// v5: new logo (the bar-checkmark). The icons are shell assets, so without a
// bump an already-installed PWA would keep serving the old ones from cache.
//
// v18: `detailCards` changed SHAPE (#163) — a stored array of ids became an
// array of `{id, on}` objects carrying order as well as visibility, read by
// THREE shell modules: `ui/settings.js` (the registry default and its
// `normalise`), `ui/settings-dialog.js` (the `ordered-multi` control, which
// has no branch at all for the old shape) and `ui/detail.js` (the stored-order
// draw). The same review round added a fourth export to `ui/settings.js`,
// `storedShapeIsStale` — covered by this bump rather than one of its own —
// which is what lets `applyDraft` migrate a legacy value on Save instead of
// only ever reading it. `settings-dialog.js` reaches it through the namespace
// import already in place (`import * as settings`), so a stale shell missing
// it is a property miss at runtime rather than a v14-style link error; it
// does not change what this bump is FOR. No new FILE was added — but
// `shellFirst` is stale-while-revalidate and writes into the RUNNING worker's
// cache, so a shell could hold a new settings.js over a cached old
// settings-dialog.js: the dialog's generic `else` branch would render one
// bogus checkbox with no `-<value>` suffix, and a tick on it would stage a
// value the server then refuses. The same mismatch in detail.js is a blank
// card region below the stat tiles rather than a link error, which is the
// quieter and worse failure — nothing throws to reach `#view-error`.
//
// v19: a habit's icon (#66). `ui/components.js` gained a new export,
// `habitIcon`, read by `ui/dashboard.js`, `ui/detail.js` and `ui/day-dialog.js`
// — no new FILE, but `shellFirst` is stale-while-revalidate and writes into
// the RUNNING worker's cache, so a shell could hold a new `dashboard.js` over
// a cached old `components.js` with no `habitIcon` at all: a module link
// error before `start()` runs, and so outside `#view-error`.
//
// v20: `ui/store.js` gained an EXPORT, `isQueryActive` (#180), and
// `ui/dashboard.js` imports it STATICALLY. This is v16 again with the same two
// modules — that bump was `matchesQuery` moving INTO store.js, this one is a
// second export out of it — and the failure is identical: both are shell
// assets, `shellFirst` is stale-while-revalidate writing into the RUNNING
// worker's cache, so a shell can hold the new dashboard.js over a cached old
// store.js. Module instantiation resolves a named import before any of it
// runs, so that pairing is a v14-style LINK error rather than v19's or v18's
// property miss: `app.js`'s static import of dashboard.js throws with "does
// not provide an export named 'isQueryActive'" BEFORE `start()`, and therefore
// outside `#view-error`. A blank page, and a reload serves the same pair.
// One new export across two shell modules is the whole reason for this bump;
// no new file was added, and nothing in index.html or style.css moved.
// v21: the day cells moved out of `ui/dashboard.js` into a new module,
// `ui/day-strip.js`, so a habit's own page can draw the same control (#…). This
// bump is owed THREE times over, which is worth noting because any one of them
// alone would have earned it. A new FILE, which a cold shell has never fetched.
// Two new EXPORTS on `ui/components.js` — `focusKeyOf` and `restoreFocus`,
// moved off dashboard.js and imported statically by both it and `ui/detail.js`
// — which is v20's failure exactly: a shell holding the new dashboard.js over a
// cached old components.js throws "does not provide an export named
// 'focusKeyOf'" at module link time, BEFORE `start()` runs and therefore
// outside `#view-error`. And `#count-*` changed owner, so a cached old
// dashboard.js paired with a new app.js would wire the amount dialog twice.
// v22: an unlogged day that counts as kept is now drawn, not only computed —
// `charts.js`'s calendar block, `ui/day-strip.js`'s checkbox and `ui/detail.js`'s
// legend all read the same new `unlogged_is_success` field together. No new
// file, but `shellFirst` is stale-while-revalidate into the running worker's
// cache, so without the bump a shell could hold the new `ui/detail.js` — whose
// legend now claims a "Kept, unlogged" swatch — over a cached old `charts.js`
// that never paints the block the legend is describing.
// v23: a run of 3+ days now reads as one band over the days inside it nobody
// ever logged (#176), on both the calendar and the "Recent days" strip.
// `charts.js` gains two EXPORTS — `MIN_STREAK` and `streakDates` — and three
// shell modules move together: `ui/day-strip.js`'s checkbox gains the faint
// tick, `ui/detail.js` imports both new exports and computes the run set its
// legend and its strip both read. Stale-while-revalidate could serve the new
// legend, which now claims an "In a run" swatch, over a cached old `charts.js`
// that never draws the stroke it describes — or a cached old `day-strip.js`
// that never draws the tick — same failure shape as v22, one export further
// upstream.
// v24: a habit gained a category (#65 phases 1+2). No new FILE — the picker
// lives inside the existing `ui/habit-dialog.js` — but `index.html` IS in
// `SHELL`, and it now carries the `<select name="category_id">` the form
// reads. `shellFirst`'s stale-while-revalidate could serve the OLD
// `index.html`, with no such control, alongside the NEW `habit-dialog.js`
// that reads `form.category_id` unconditionally: `currentCategoryId()` throws
// on the missing element the moment the dialog opens, before any save is
// attempted. The reverse pairing is silent rather than loud — a new
// `index.html` with the select, held against an old `habit-dialog.js` that
// never populates or reads it — which is exactly why this is a version bump
// and not a "the new file will just 404 and get refetched" shrug.
// v25: the category comparison (#65 phase 3). This is BOTH shapes of bump at
// once, which is why it is one version and not an argument about whether it
// needs to be.
//
// It is v9's and v17's: `ui/categories.js` is a brand-new shell asset that
// `app.js` imports STATICALLY, so an installed PWA would otherwise first fetch
// it at the moment somebody presses the button — and offline that is a module
// link error before `start()`, outside `#view-error`, which is a blank page
// rather than a view that says something.
//
// And it is v13's and v24's: `index.html` is in `SHELL` and now carries
// `#btn-compare` and `#view-categories`. `ui/categories.js` looks the button
// up at module scope and dereferences it in `syncEntry`, and `ui/views.js`
// puts `#view-categories` in `all` and sets `.hidden` on it — so a stale v24
// `index.html` served alongside the new scripts throws on the first paint of
// the dashboard, which is the one path every boot takes.
//
// The reverse pairing is the silent one, as it was at v24: a new
// `index.html` with a top-bar button that no cached script ever wires or
// reveals. `shellFirst` is stale-while-revalidate and writes into the RUNNING
// worker's cache, so both pairings are reachable in the window between
// installs; naming the new shell separately is what makes the swap atomic at
// the cache level. It costs every installed client its data cache.
//
// `ui/routes.js`, `ui/dashboard.js`, `ui/settings-dialog.js`, `ui/detail.js`,
// `ui/habit-dialog.js` and `auth-session.js` moved with it — `dashboard.js`
// imports `syncEntry` from the new module, which is v16's case exactly and
// covered by the same bump. `ui/store.js` adds an EXPORT of its own,
// `dashboardShowing`, which four of those files import: that is v9's case
// again in miniature, and the reason it is named here rather than left to the
// list above is that an export is the half a reader checking "did anything new
// appear?" would otherwise miss. `style.css` is a shell asset too and gained
// this view's rules.
// v26 adds no file and no export, and is a bump for the OTHER half of the rule
// in `shared/public/CLAUDE.md`: the shape of a value read by more than one
// shell module. `state` (`ui/store.js`) gains `categoryReadSeq`, the ticket
// that decides which answer may install `state.categories`, and BOTH
// `ui/habit-dialog.js` and `ui/dashboard.js` now take one.
//
// The dangerous pairing is a new `ui/dashboard.js` over a cached v25
// `ui/store.js`, which is exactly what `shellFirst`'s stale-while-revalidate
// can serve in the window between installs. There is no such field, so
// `++state.categoryReadSeq` is **NaN**, `NaN === NaN` is false, and every
// guarded assignment is skipped forever: `state.categories` stays `[]` through
// every `/overview` and every `GET /categories`, so the grouped dashboard
// draws no sections and the habit dialog's picker offers no category. Not a
// throw, not a link error — a working-looking app with the account's
// categories silently gone. This is #163's case (`detailCards`) again, and the
// reason that clause is in the rule at all.
// v27: the habit dialog's Target box became a text box read through
// `parseAmount` (#156), and `ui/count-field.js` gained an EXPORT — `convention`,
// the one declaration of which character a decimal point is — which
// `ui/habit-dialog.js` now imports STATICALLY. That is v20's case: a shell
// holding the new `habit-dialog.js` over a cached v26 `count-field.js` throws
// "does not provide an export named 'convention'" at module LINK time, before
// `start()` runs and so outside `#view-error`.
//
// And it is v24's, on `index.html`, which is in `SHELL`: the target input lost
// `type="number"` and gained `#target-hint`, the element a refusal is written
// into. A cached v26 `index.html` under the new `habit-dialog.js` is a number
// input that still eats the comma this change is about, beside a
// `targetHint()` dereferencing an element that is not there — so the refusal
// throws instead of being shown. The reverse pairing is the quiet one: a new
// `index.html` whose text box accepts "8,5" held against a cached
// `habit-dialog.js` that still reads it with `Number(...) || 0`, which is 85.
// No new FILE, so `SHELL` is unchanged — `/index.html`, `/shared/ui/amount.js`,
// `/shared/ui/count-field.js` and `/shared/ui/habit-dialog.js` are all already
// in it.
// v29 REMOVES two exports rather than adding any, and that is the same event
// for the same reason (#192): `offline.js` no longer exports `noteWrite` or
// `freshnessHeader`, the freshness header having been replaced by
// `users.data_version` in cloud's `/overview` memo key. The dangerous pairing
// is the reverse of v20's and just as loud — a shell holding a cached v28
// `ui/api.js`, which imports both by name, against the new `offline.js` that
// declares neither: "does not provide an export named 'freshnessHeader'" at
// module LINK time, before `start()` runs and so outside `#view-error`.
// No file is added or removed, so `SHELL` is unchanged.
// v30: a new FILE under `shared/public/`, `ui/icon-field.js` (the emoji
// picker, #182), imported STATICALLY by `ui/habit-dialog.js`. That is v20's
// case again: `shellFirst` is stale-while-revalidate and writes into the
// running worker's cache, so without this bump a shell can hold the new
// `habit-dialog.js` over a cache with no `icon-field.js` in it at all — a
// module link error before `start()` runs, and so outside `#view-error`.
const CACHE_VERSION = 'v30';
const SHELL_CACHE = `habiterall-shell-${CACHE_VERSION}`;
const DATA_CACHE = `habiterall-data-${CACHE_VERSION}`;

/**
 * Everything a cold install needs before it can run offline.
 *
 * `shellFirst` also caches whatever it fetches, so a file missing from here
 * still works — right up until someone installs the app and loses connectivity
 * before that module has ever been requested. `test/ui-modules.test.js` walks
 * the imports from the entry point and fails if this list has fallen behind.
 */
const SHELL = [
  '/',
  '/index.html',
  '/app-entry.js',      // per-edition: picks the auth adapter
  '/style.css',
  '/shared/manifest.json',

  // The UI, identical across editions. Both auth adapters are listed because
  // one service worker serves both editions and each imports a different one.
  '/shared/app.js',
  '/shared/auth-session.js',
  '/shared/charts.js',
  '/shared/offline.js',
  '/shared/ui/amount.js',
  '/shared/ui/api.js',
  '/shared/ui/calendar.js',
  '/shared/ui/categories.js',
  '/shared/ui/components.js',
  '/shared/ui/connectivity.js',
  '/shared/ui/count-field.js',
  '/shared/ui/dashboard.js',
  '/shared/ui/data-dialog.js',
  '/shared/ui/dates.js',
  '/shared/ui/day-dialog.js',
  '/shared/ui/day-strip.js',
  '/shared/ui/detail.js',
  '/shared/ui/habit-dialog.js',
  '/shared/ui/icon-field.js',
  '/shared/ui/nudge.js',
  '/shared/ui/reminder-field.js',
  '/shared/ui/resample.js',
  '/shared/ui/routes.js',
  '/shared/ui/settings-dialog.js',
  '/shared/ui/settings.js',
  '/shared/ui/store.js',
  '/shared/ui/theme.js',
  '/shared/ui/time.js',
  '/shared/ui/toast.js',
  '/shared/ui/toggle.js',
  '/shared/ui/values.js',
  '/shared/ui/views.js',
  '/shared/ui/window.js',
];

/** GET endpoints worth keeping a copy of for offline rendering. */
const CACHEABLE_API = [/^\/api\/overview/, /^\/api\/habits/, /^\/api\/me$/];

/**
 * An abort signal bounding one request, falling back to `AbortController` +
 * `setTimeout` below `AbortSignal.timeout`'s availability (Chrome 103 /
 * Firefox 100 / Safari 16). Calling `AbortSignal.timeout` unguarded THROWS
 * there, and inside an `async` function that throw is a rejected promise —
 * `event.respondWith(<rejected>)` is a network error, on every request that
 * reaches the call, on exactly the browsers old enough to need the bound
 * most. `ui/settings.js`'s `bound()` and `offline.js`'s `isReachable` already
 * hand-roll this same fallback; this is a third copy rather than a fourth
 * unguarded call, which is the drift that put an unguarded
 * `AbortSignal.timeout(10_000)` in `networkFirst` (below, unguarded since
 * #93) and then again in `shellFirst` in the very commit meant to fix the
 * second one.
 *
 * The `setTimeout` below is left uncleared, matching `ui/settings.js`'s
 * `bound()`: both call sites here pass the signal straight into `fetch`'s
 * `init` with no handle back to the timer, and threading one through would
 * restructure both functions to save one harmless 10s timer in a worker that
 * outlives neither.
 *
 * A third path, below `AbortController`'s own availability, answers
 * `undefined` — the request then goes out UNBOUNDED, which is #87's own hang,
 * reopened on exactly the runtime old enough to need the bound most (Chrome
 * <40, Firefox <44). Accepted rather than closed: a runtime with no
 * `AbortController` at all predates every browser this file is otherwise
 * written for, and there is nothing better to hand `fetch` in its place. The
 * same path also means `{signal: undefined}` — EMPTY per WebIDL, not merely
 * unbounded — so at the `shellFirst` call site the navigate→same-origin
 * downgrade described there does not occur on this path either.
 */
function boundedSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return AbortSignal.timeout(ms);
  }
  if (typeof AbortController === 'undefined') return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
  return controller.signal;
}

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // Individual failures must not abort the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => sw.skipWaiting())
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith('habiterall-') &&
                         k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;          // writes are the outbox's job

  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;

  // Auth endpoints must always hit the network: a cached redirect or a stale
  // session response would break login in confusing ways.
  if (url.pathname.startsWith('/auth/')) return;

  // Neither may the connectivity probe be answered from here, and this one is
  // worse than stale — it is a lie about the present. `/healthz` is not under
  // `/api/`, so it fell to `shellFirst`, which cached the first 200 and then
  // served it cache-first forever: measured with the server killed outright,
  // `isReachable()` still answered true out of the shell cache. Every input
  // the app has about connectivity runs through that call, so an installed PWA
  // could not notice an outage at all, and could not notice the recovery
  // either. Read once as "the probe is fine, the watcher is broken".
  if (url.pathname === '/healthz') return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, url));
    return;
  }

  event.respondWith(shellFirst(request));
});

/**
 * API: try the network, fall back to the last good copy. The fallback is
 * tagged so the page can tell the user what it is showing.
 */
async function networkFirst(request, url) {
  try {
    // `cache: 'no-store'` keeps the browser's HTTP cache out of the way. Without
    // it a revalidated 304 can satisfy this fetch even with no connectivity, so
    // the offline branch never runs and the page cannot tell it has stale data.
    //
    // The bound is the same 10s the page uses (ui/api.js, from `Api.kt`), and
    // it matters more here than there because the answer is already on the
    // device: a server that accepts the connection and never replies left this
    // waiting forever with a perfectly good cached dashboard three lines below.
    // The PWA's cold boot runs two of these in sequence, so an unbounded hang
    // here is an app that opens to nothing at all. Only GETs reach the worker,
    // so there is nothing here that a retry could duplicate.
    const response = await fetch(request, {
      cache: 'no-store', signal: boundedSignal(10_000),
    });
    // The REQUEST is the key, here and in the `caches.match` below, and both
    // select using the stored response's `Vary`. So a route this list covers
    // may not vary on a header the page sends only SOMETIMES — see
    // `CLAUDE.md`. Measured in Chrome with cloud's `X-Habiterall-Fresh`, which
    // #192 has since deleted — the rule outlived the header that found it, and
    // this is the measurement rather than a description of a live request: the
    // put made from a request carrying it replaced the entry stored from one
    // without, and the survivor then matched neither `cache.match` nor
    // `caches.match` for any ordinary request, so the fallback below fell
    // through to the synthetic 503 and the installed app opened offline to
    // nothing. `Vary: X-Habiterall-Timezone` is safe in the same place because
    // a device sends one zone on every request.
    if (response.ok && CACHEABLE_API.some((re) => re.test(url.pathname))) {
      const cache = await caches.open(DATA_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      // Mark it so the UI can show an "offline — showing saved data" banner.
      const headers = new Headers(cached.headers);
      headers.set('X-Habiterall-Offline', '1');
      return new Response(await cached.blob(), {
        status: cached.status, statusText: cached.statusText, headers,
      });
    }
    return new Response(
      JSON.stringify({ error: 'offline', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Shell: serve from cache immediately, refresh in the background so the next
 * load has the newer version.
 */
async function shellFirst(request) {
  const cached = await caches.match(request);

  // Navigations and stylesheets go network-first when we are online: serving
  // them stale means a deploy (or a local edit) needs two loads to appear,
  // and the first one renders with mismatched HTML and CSS. Scripts and
  // everything else stay cache-first for speed.
  const revalidateFirst = request.mode === 'navigate' ||
    request.destination === 'style' ||
    request.destination === 'document';

  // Bounded for the same reason as `networkFirst` above, and more urgently:
  // the cached copy is one line below, and `revalidateFirst` awaits this
  // BEFORE consulting it, so a server that accepts the connection and never
  // replies leaves an installed PWA awaiting the network forever with a
  // perfectly good `/index.html` or `/style.css` already on the device — an
  // app that opens to nothing at all. Aborting means the cache is not
  // refreshed on this load, so a genuinely slow-but-working server keeps
  // serving a stale shell for one more load; 10s is generous for either file,
  // and it is the same tradeoff `networkFirst` already made for API data.
  //
  // Passing a non-empty `init` here downgrades a `navigate`-mode `Request` to
  // `same-origin` per the Fetch spec's Request constructor — benign, since
  // everything reaching this line is already same-origin (the handler above
  // returns early on a cross-origin `url.origin`). The same spec step also
  // sets the request's referrer to "client" and its referrer policy to the
  // empty string, so the `Referer` sent can change from the referring
  // document to the worker's own scope URL — nothing in this repo reads it,
  // but say it accurately rather than name only `Sec-Fetch-Mode` (which does
  // flip, from `navigate` to `same-origin`). `redirect` genuinely does
  // survive untouched: it is copied from the input `Request` and only an
  // explicit `init.redirect` would override it, which this passes none of —
  // and an opaque redirect answer comes back with `ok === false`, so the
  // `if (response.ok)` guard just below never caches it. `networkFirst`
  // already passes an init the same way.
  const network = fetch(request, { signal: boundedSignal(10_000) })
    .then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (revalidateFirst) {
    const fresh = await network;
    if (fresh) return fresh;
    if (cached) return cached;       // offline: stale is better than nothing
  } else if (cached) {
    return cached;                   // fast path; the fetch above refreshes it
  }

  const fresh = await network;
  if (fresh) return fresh;

  // A navigation with nothing cached: fall back to the shell if we have it.
  if (request.mode === 'navigate') {
    const shell = await caches.match('/index.html');
    if (shell) return shell;
  }
  return new Response('Offline', { status: 503 });
}
