/**
 * The offline banner, the outbox badge, and the reconnect handling behind
 * them. Owns `#offline-bar`, `#pending-count` and `#btn-sync`.
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
const badge = $('#pending-count');
const retry = $('#btn-sync');

/** Show or hide the offline banner. */
export function setOffline(offline) {
  if (state.offline === offline) return;
  state.offline = offline;
  bar.hidden = !offline;
}

/** Reflect the number of queued writes in the banner. */
export async function refreshOfflineBadge() {
  const n = await pendingCount();
  state.pending = n;
  badge.textContent = n
    ? `${n} change${n === 1 ? '' : 's'} waiting to sync`
    : '';
  badge.hidden = n === 0;
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

  if (sent) {
    emit('reload');
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
  watchConnectivity(async (online) => {
    setOffline(!online);
    await refreshOfflineBadge();
    if (!online) { wasOffline = true; return; }

    await syncNow().catch(() => {});

    // Whatever was on screen was rendered from cache, and the server may have
    // changed under it — from another device, or from this one before the
    // outage. syncNow only reloads when it actually sent something.
    if (wasOffline) {
      wasOffline = false;
      emit('reload');
    }
  });

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
