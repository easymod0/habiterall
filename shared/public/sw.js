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
// v6: the habit dialog gained the reminder time picker and the "what the
// reminder asks" field. index.html is a shell asset, so without a bump an
// already-installed PWA would keep serving the old markup — and app.js, which
// builds the picker from those elements at load, would find nothing there.
//
// v5: new logo (the bar-checkmark). The icons are shell assets, so without a
// bump an already-installed PWA would keep serving the old ones from cache.
const CACHE_VERSION = 'v11';
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
  '/shared/ui/components.js',
  '/shared/ui/connectivity.js',
  '/shared/ui/count-field.js',
  '/shared/ui/dashboard.js',
  '/shared/ui/data-dialog.js',
  '/shared/ui/dates.js',
  '/shared/ui/day-dialog.js',
  '/shared/ui/detail.js',
  '/shared/ui/habit-dialog.js',
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
      cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
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

  const network = fetch(request)
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
