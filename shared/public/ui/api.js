/**
 * Every request the app makes, and what to do when one cannot be made.
 *
 * Owns no markup. The offline paths report through `connectivity.js` rather
 * than touching the banner themselves.
 */

import { deviceClockHeader, enqueue, unstage } from '/shared/offline.js';
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
 * Whether this write is safe to arrive twice.
 *
 * The one question three rules turn on: what may be STAGED before the attempt,
 * what may be PRE-EMPTED when we already know we are offline, and what may be
 * QUEUED when an attempt fails. All three end with the request being replayed
 * from the outbox, so all three need the same answer.
 *
 * Every write on this path is replayable — an entry PUT is an upsert keyed on
 * habit and date; DELETE, PUT /habits and PUT /settings all state a final value
 * — except `POST /habits`, which yields a second habit.
 *
 * Import, export and the notify test do not come through here at all (raw
 * `fetch`, and a plain `<a download>`), so nothing legitimately long is in
 * scope.
 */
const replayable = (method, path) =>
  method !== 'GET' && !(method === 'POST' && path === '/habits');

/**
 * Every request is bounded, including the one that is not replayable.
 *
 * `POST /habits` used to be left unbounded, on the reasoning that aborting a
 * create the server had already begun and then replaying it is two habits. The
 * first half of that is still true and is why it is not `replayable` above —
 * but the conclusion did not follow. Not bounding it did not avoid the
 * duplicate, it just moved the cost: with no ceiling the dialog span until the
 * OS gave up, showing nothing, while the create may or may not have landed.
 *
 * Bounded and NOT queued is the honest shape. The attempt is abandoned, nothing
 * is replayed, and the user is told the server did not answer and that the
 * habit may exist — which is a worse sentence than a silent recovery and a true
 * one, unlike a spinner that never stops. `data-dialog`'s caller refreshes the
 * list on that error so the answer is one glance away.
 */
const bounded = () => true;

/**
 * An abort signal bounding one request, falling back to `AbortController` +
 * `setTimeout` below `AbortSignal.timeout`'s availability (Chrome 103 /
 * Firefox 100 / Safari 16). Calling `AbortSignal.timeout` unguarded THROWS
 * there, and that throw lands inside the `try` below, in `catch
 * (networkError)` — every write announced as "Saved offline" and every read
 * as a network failure, against a server that answered nothing wrong. This
 * bug shipped once already as an unguarded call at this exact site (#87), and
 * came back a second time inside the very PR that bounded the OTHER two
 * sites (`sw.js`'s `shellFirst` and `networkFirst`) without noticing this one.
 *
 * This is a LOCAL COPY of `sw.js`'s `boundedSignal`, not an import, for two
 * reasons neither of which is fixable by trying harder here. `sw.js` is a
 * classic worker script, registered with no `{type: 'module'}`, so it cannot
 * `import` — no single shared implementation could ever cover all three call
 * sites (this one, `shellFirst`, `networkFirst`) at once. And consolidating
 * just the two module-side copies would mean adding an EXPORT under
 * `shared/public/`, which the root `CLAUDE.md` makes a `CACHE_VERSION`
 * bump — every installed client loses its data cache, for an eight-line
 * feature detect. The repo already carries this duplication on purpose:
 * `ui/settings.js`'s `bound()` and `offline.js`'s `isReachable` both hand-roll
 * the same fallback rather than share it. What holds the three copies
 * together is the tests, one per site, and all three fall away together if
 * the supported-browser floor is ever raised to Safari 16+.
 *
 * A third path, below `AbortController`'s own availability, answers
 * `undefined` and the request goes out UNBOUNDED — which is #87's own hang,
 * reopened on exactly the runtime old enough to need the bound most.
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
  // `POST /habits` is exempt because pre-empting means queueing, and queueing
  // means replaying. Offline it takes the attempt, fails, and is reported as a
  // create that did not happen — which it did not, since nothing was sent.
  if (replayable(method, path) && state.offline) {
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
  // Only for calls safe to arrive twice, which is what `replayable()` names. A
  // staged write can be picked up by a concurrent `flush()` and sent while the
  // live attempt is still out — two identical upserts, keyed on habit and date,
  // and the second changes nothing.
  const staged = replayable(method, path)
    ? await enqueue({ url, method, body: options.body ?? null })
    : null;

  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...deviceClockHeader() },
      credentials: 'same-origin',
      ...options,
      // A timeout rejects the fetch, so it lands in the same `catch` as a
      // refused connection and needs no branch of its own: a request that
      // never answered and one that could not be made are the same news.
      signal: options.signal ??
        (bounded() ? boundedSignal(TIMEOUT_MS) : undefined),
    });
  } catch (networkError) {
    // Offline, or bounded out. Queue what can be replayed; reads have nothing
    // to fall back on beyond whatever the service worker already cached.
    if (replayable(method, path)) {
      // Already staged above, so only the announcement is left to make.
      throw await announceQueued();
    }

    if (method !== 'GET') {
      // The one write that cannot be replayed, and the reason it says something
      // different. Aborting does not recall a create the server may already
      // have committed, so a cheerful "saved offline, will sync" would be a
      // promise to do it AGAIN — and the honest failure is not "it did not
      // happen" either, because nobody here knows. Say what is true and make
      // the answer reachable: the caller refreshes the list on this.
      //
      // Before this the call was simply unbounded, so the dialog span until the
      // OS gave up. That was not safer, only quieter.
      reportUnreachable();
      throw Object.assign(
        new Error('The server did not answer. Check whether the habit was created before trying again.'),
        { indeterminate: true }
      );
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
