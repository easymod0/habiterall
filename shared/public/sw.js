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

// v5: new logo (the bar-checkmark). The icons are shell assets, so without a
// bump an already-installed PWA would keep serving the old ones from cache.
const CACHE_VERSION = 'v5';
const SHELL_CACHE = `habiterall-shell-${CACHE_VERSION}`;
const DATA_CACHE = `habiterall-data-${CACHE_VERSION}`;

const SHELL = [
  '/',
  '/index.html',
  '/app-entry.js',      // per-edition: picks the auth adapter
  '/shared/app.js',     // the UI itself, identical across editions
  '/style.css',
  '/shared/charts.js',
  '/shared/offline.js',
  '/shared/manifest.json',
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
    const response = await fetch(request, { cache: 'no-store' });
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
