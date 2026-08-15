/**
 * Every request the app makes, and what to do when one cannot be made.
 *
 * Owns no markup. The offline paths report through `connectivity.js` rather
 * than touching the banner themselves.
 */

import { enqueue, unstage } from '/shared/offline.js';
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

/**
 * Queue a write, say so, and hand the caller the one error shape it knows.
 *
 * Shared by the two ways a write ends up in the outbox — the attempt that
 * failed, and the attempt not made at all — because a caller must not be able
 * to tell them apart. Both are "saved on this device"; only the latency differs.
 */
async function queueWrite(url, method, options) {
  await enqueue({ url, method, body: options.body ?? null });
  return announceQueued();
}

/**
 * Say a write is queued, and hand back the error the caller expects.
 *
 * Separate from the enqueue because with staging the write is often ALREADY in
 * the queue by the time we get here — the announcement is the only part left.
 * Callers must not be able to tell the three routes in apart: pre-empted
 * because we knew, staged and then failed, or failed and queued on the spot.
 */
async function announceQueued() {
  // Nothing else can say it: the watcher makes no requests while it believes it
  // is online, so before this the app went on looking connected through an
  // entire outage, with the badge hidden inside the hidden banner.
  reportUnreachable();
  await refreshOfflineBadge();
  return Object.assign(
    new Error('Saved offline — will sync when you reconnect'),
    { queued: true }
  );
}

export async function api(path, options = {}) {
  const url = `/api${path}`;
  const method = (options.method ?? 'GET').toUpperCase();

  // Already known to be offline: queue it without spending the timeout.
  //
  // This is the second tap onward. The first is what discovers the outage —
  // there is no cheaper way to learn it, and probing `/healthz` on every write
  // is what that endpoint's four callers make expensive — so tap one pays the
  // bound and every tap after it is free. Before the watcher was fed by a
  // failed write, this branch could never be reached: the app never came to
  // believe it was offline, so "when it already believes" described no state.
  //
  // Writes only. A GET has somewhere to fall back to — the service worker may
  // hold a cached copy, and skipping the request would throw that away and
  // leave the app blank rather than stale.
  //
  // `POST /habits` is exempt, by the same predicate as the timeout rather than
  // a second opinion about the same call. Pre-empting it would in fact be safe
  // — nothing is sent, so nothing can arrive twice — but the two rules would
  // then disagree about which call is special, and the next person to change
  // one would have to find the other. The call that is never abandoned
  // mid-flight is also the one never pre-empted; offline it fails and reaches
  // the outbox by the ordinary path, exactly as it did before this branch.
  if (method !== 'GET' && bounded(method, path) && state.offline) {
    throw await queueWrite(url, method, options);
  }

  // Durable BEFORE the attempt, not after it.
  //
  // The queue used to hold writes that had already failed, which meant that
  // between the tap and the fetch settling a check-off existed only in a
  // promise: close the tab in that window and it was gone, from the outbox and
  // from the server alike. The bound above caps that window at 10s; staging
  // here closes it.
  //
  // Only for calls safe to arrive twice, which is what `bounded()` already
  // names. A staged write can be picked up by a concurrent `flush()` and sent
  // while the live attempt is in flight — two identical upserts, keyed on habit
  // and date, and the second changes nothing. `POST /habits` is the call that
  // would become two habits, so it is not staged, exactly as it is not bounded
  // and not pre-empted: one predicate, three uses, no way to change one and
  // miss the others.
  const staged = method !== 'GET' && bounded(method, path)
    ? await enqueue({ url, method, body: options.body ?? null })
    : null;

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
      // Already staged, unless this is the one call that is not. Either way it
      // is in the queue now, so only the announcement is left to make.
      if (staged === null) await enqueue({ url, method, body: options.body ?? null });
      throw await announceQueued();
    }
    throw new Error('You are offline');
  }

  // An answer arrived — any answer. The tab-close window is over, so the staged
  // copy has done its job and comes back out before the status is even looked
  // at. Leaving it in on a 5xx would turn every failed write into a silent
  // retry, which is a larger change than this one and not obviously wanted:
  // the caller is told, and the caller decides.
  if (staged !== null) await unstage(staged);

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
