/**
 * Every request the app makes, and what to do when one cannot be made.
 *
 * Owns no markup. The offline paths report through `connectivity.js` rather
 * than touching the banner themselves.
 */

import { enqueue } from '/shared/offline.js';
import { refreshOfflineBadge, setOffline } from '/shared/ui/connectivity.js';
import { state } from '/shared/ui/store.js';

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
    });
  } catch (networkError) {
    // Offline. Queue writes for replay; reads have nothing to fall back on
    // beyond whatever the service worker already cached.
    if (method !== 'GET') {
      await enqueue({ url, method, body: options.body ?? null });
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
    // A 503 from the service worker means the request never left the device.
    if (res.status === 503 && body.offline && method !== 'GET') {
      await enqueue({ url, method, body: options.body ?? null });
      await refreshOfflineBadge();
      throw Object.assign(
        new Error('Saved offline — will sync when you reconnect'),
        { queued: true }
      );
    }
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}
