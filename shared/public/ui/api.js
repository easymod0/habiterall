/**
 * Every request the app makes, and what to do when one cannot be made.
 *
 * Owns no markup. The offline paths report through `connectivity.js` rather
 * than touching the banner themselves.
 */

import { enqueue } from '/shared/offline.js';
import {
  refreshOfflineBadge, reportUnreachable, setOffline,
} from '/shared/ui/connectivity.js';
import { state } from '/shared/ui/store.js';

/**
 * How long a request may take before it counts as unreachable.
 *
 * Taken from `Api.kt`'s `connectTimeout` rather than invented, so the two
 * clients do not hold two opinions about how long a server may take. Chrome
 * imposes no ceiling of its own on a response that never arrives — measured
 * still-pending at 300s against a server that accepts the connection and goes
 * quiet, which is what a stale tunnel or a stopped container looks like — so
 * without this the write below sits in a promise and is lost with the tab.
 *
 * It is generous on purpose. A merely slow server (a cold Postgres pool under
 * a burst) must not be read as an absent one, or the app banners itself
 * offline, diverts writes to the outbox and replays them into the same slow
 * server: the self-feeding shape `/healthz` is memoised to avoid.
 */
const TIMEOUT_MS = 10_000;

/**
 * Whether this request may be abandoned, and it is one question about
 * replaying rather than about latency.
 *
 * Aborting does not recall a request the server has already begun, so anything
 * bounded here has to be safe to arrive twice: once from the attempt and again
 * from the outbox. Every call on this path is — an entry PUT is an upsert keyed
 * on habit and date, DELETE and PUT /habits and /settings all state a final
 * value — except `POST /habits`, which yields a second habit. It is also a
 * deliberate act in a dialog rather than a tap, so leaving it unbounded costs a
 * dialog that hangs, not a check-off that disappears.
 *
 * Import, export and the notify test do not come through here at all (raw
 * `fetch`, and a plain `<a download>`), so nothing legitimately long is at risk
 * of being cut off.
 */
const bounded = (method, path) => !(method === 'POST' && path === '/habits');

/**
 * Auth adapter, injected by the edition's entry point via `start()`. The API
 * layer needs it for exactly one thing — deciding whether a 401 is a expired
 * session or a bug — so it is held here rather than threaded through calls.
 */
let auth = null;

/** @param adapter see auth-session.js */
export function setAuth(adapter) {
  auth = adapter;
}

export async function api(path, options = {}) {
  const url = `/api${path}`;
  const method = (options.method ?? 'GET').toUpperCase();

  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options,
      // A timeout rejects the fetch, so it lands in the same `catch` as a
      // refused connection and needs no branch of its own: a request that
      // never answered and one that could not be made are the same news.
      signal: options.signal ??
        (bounded(method, path) ? AbortSignal.timeout(TIMEOUT_MS) : undefined),
    });
  } catch (networkError) {
    // Offline. Queue writes for replay; reads have nothing to fall back on
    // beyond whatever the service worker already cached.
    if (method !== 'GET') {
      await enqueue({ url, method, body: options.body ?? null });
      // Now say so. Nothing else can: the watcher makes no requests while it
      // believes it is online, so before this the app went on looking connected
      // through an entire outage and the badge — a child of the banner — was
      // hidden along with it.
      reportUnreachable();
      await refreshOfflineBadge();
      throw Object.assign(
        new Error('Saved offline — will sync when you reconnect'),
        { queued: true }
      );
    }
    throw new Error('You are offline');
  }

  // The service worker marks responses it served from its cache.
  if (res.headers.get('X-Habiterall-Offline') === '1') setOffline(true);

  // An expired session is the adapter's business; without auth a 401 is a bug
  // and falls through to the normal error path.
  if (res.status === 401 && auth?.onUnauthorized()) {
    state.habits = [];
    throw new Error('Your session has expired. Please sign in again.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // A second queue-on-503 branch stood here, for the synthetic
    // `{offline: true}` the worker answers an unreachable API with. It was
    // unreachable itself — `sw.js` returns early for every non-GET, so a write
    // is never seen by the worker — and it read as evidence that the worker had
    // been thought about on the write path, which is the opposite of true.
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}
