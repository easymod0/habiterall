/**
 * The offline banner, the outbox badge, and the reconnect handling behind
 * them. Owns `#offline-bar`, `#offline-message`, `#pending-count` and
 * `#btn-sync`.
 *
 * Split from `api.js` on purpose: the API layer needs to *report* that a
 * request was served from cache or queued, but it has no business knowing
 * what the banner looks like.
 */

import { flush, pendingCount, watchConnectivity } from '/shared/offline.js';
import { emit, state } from '/shared/ui/store.js';
import { toast } from '/shared/ui/toast.js';

const $ = (sel) => document.querySelector(sel);

const bar = $('#offline-bar');
const message = $('#offline-message');
const badge = $('#pending-count');
const retry = $('#btn-sync');

/**
 * Paint the strip from `state`.
 *
 * The strip has two independent reasons to exist and used to have one. Being
 * offline is the obvious one; having writes waiting is the other, and the badge
 * that says so was a CHILD of a bar shown only when offline — so the count of
 * queued writes was hidden in exactly the situation that produces queued
 * writes. Either reason shows it now, and the offline half hides itself when
 * the only news is a queue: "2 changes waiting to sync" with a Retry beside it
 * is true whether or not the app currently believes the server is gone.
 */
function render() {
  const pending = state.pending > 0;
  bar.hidden = !state.offline && !pending;
  message.hidden = !state.offline;
  badge.hidden = !pending;
}

/** Show or hide the offline banner. */
export function setOffline(offline) {
  if (state.offline === offline) return;
  state.offline = offline;
  render();
}

/** Reflect the number of queued writes in the banner. */
export async function refreshOfflineBadge() {
  const n = await pendingCount();
  state.pending = n;
  badge.textContent = n
    ? `${n} change${n === 1 ? '' : 's'} waiting to sync`
    : '';
  render();
}

/** @type {(() => void) | null} the running watcher's offline entry point */
let reportOffline = null;

/**
 * A request of ours could not reach the server.
 *
 * The write path is the only thing that ever finds this out first: the watcher
 * makes no requests while it believes it is online, and no browser event fires
 * when the interface is up and the route is dead. So a queued write is
 * first-hand evidence — better than a probe, because it is the actual traffic —
 * and it goes to `reportOffline` rather than `setOffline` because only the
 * watcher can also start polling for the recovery. See offline.js.
 *
 * The FIRST failure is trusted, deliberately. Waiting for a second means the
 * tap that started the outage still hangs with nothing on screen, which is the
 * reported bug; and confirming with a `/healthz` probe is what that endpoint's
 * notes forbid — four callers, self-feeding, one bucket per NAT. A blip that
 * raises the banner for a moment costs nothing, because the backoff poll this
 * arms takes it down again a second or two later.
 */
export function reportUnreachable() {
  // Before `init()` — a write cannot get here first today, but a banner is
  // still better than silence if the boot order ever changes.
  if (reportOffline) reportOffline();
  else setOffline(true);
}

/**
 * Replay whatever is queued, then refresh the view so the server's version
 * of the truth wins.
 */
export async function syncNow() {
  const before = await pendingCount();
  if (!before) return;

  const { sent, failed, remaining } = await flush();
  await refreshOfflineBadge();

  // Repaint if anything LEFT the queue, not only if something succeeded. The
  // refused write is the case that needs it most: `recordValue` painted the day
  // before awaiting and `api()` let that paint STAND because the write was
  // queued — "Saved offline, will sync when you reconnect" — so a refetch is
  // the only thing that can take it back down again. Conditioning the reload on
  // `sent` meant a flush where every write was refused left the grid claiming
  // days the server never accepted, indefinitely, with the score and streak
  // beside them computed without those days, behind a toast that cleared itself
  // in 2.6 seconds.
  if (sent || failed.length) emit('reload');
  if (sent) {
    toast(`Synced ${sent} change${sent === 1 ? '' : 's'}`);
  }
  if (failed.length) {
    toast(`${failed.length} change${failed.length === 1 ? '' : 's'} could not be synced`);
  }
  if (remaining === 0) setOffline(false);
}

/**
 * Reconnecting is the moment to drain the outbox and refresh.
 *
 * `watchConnectivity` only calls back on a real transition, so this runs once
 * per outage rather than on every poll. It also re-probes when the tab becomes
 * visible and polls while offline, which is what recovers the app when the
 * *server* comes back but the network never dropped — a restarted server used
 * to leave the page stuck offline until a manual reload.
 */
export function init() {
  retry.addEventListener('click', () => {
    syncNow().catch((e) => toast(e.message));
  });

  let wasOffline = false;
  ({ reportOffline } = watchConnectivity(async (online) => {
    setOffline(!online);
    await refreshOfflineBadge();
    if (!online) { wasOffline = true; return; }

    await syncNow().catch(() => {});

    // Whatever was on screen was rendered from cache, and the server may have
    // changed under it — from another device, or from this one before the
    // outage. syncNow only reloads when the queue actually moved, and an
    // outage that queued nothing does not move it.
    if (wasOffline) {
      wasOffline = false;
      emit('reload');
    }
  }));

  // Coming back to a backgrounded tab, independently of any connectivity
  // transition: the watcher's callback only fires when online/offline actually
  // flips, so a tab that never went offline but has a queue left over from a
  // flush that failed part-way still needs a nudge.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.offline) {
      syncNow().catch(() => {});
    }
  });
}
