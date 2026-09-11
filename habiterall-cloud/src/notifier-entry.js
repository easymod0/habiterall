/**
 * The reminder tick, the Discord gateway and the scheduled dump — and nothing
 * a request needs. No Express, no session store, no static mounts, no
 * `./api.js`, no `./auth.js`, no rate limiters.
 *
 * This is a second process rather than a second thing `server.js` does,
 * because the tick was sharing three things with request serving that it has
 * no business sharing:
 *
 * - **The event loop.** A tick's per-account transactions and the reminder
 *   text run synchronously between whatever request handlers happen to be in
 *   flight; splitting it out is one fewer thing blocking somebody's tap.
 * - **The pg pool.** `PG_POOL_MAX` is sized against request traffic
 *   (`/healthz`'s memo, `/overview`'s cost) — a tick competing for the same
 *   ten connections is a cost nobody who tuned that number was asked to pay.
 * - **The process lifecycle**, and this is the one that is not a performance
 *   argument: under replicas, every replica ran its own tick — N× the full
 *   sequential `users` scan every minute, N× the per-account transactions,
 *   and **N Discord gateway sockets racing to answer the same button press**.
 *   A bot only needs one open connection per deployment; a second one racing
 *   the first to `DEFER_UPDATE` a press is how the OTHER one loses and Discord
 *   shows "This interaction failed" on a press that was, in fact, handled.
 *
 * That last one is not solved by `replicas: 1` on its own. Kubernetes'
 * default `Deployment` strategy is `RollingUpdate`, which starts the new pod
 * before terminating the old one — so every deploy has a window with TWO
 * gateways open, both able to answer the same three-second defer. A
 * `Deployment` for this container needs `strategy: { type: Recreate }`, which
 * is one line nobody writes unless they already know why. The app is the
 * service an operator scales; this one is never scaled, and is never run more
 * than once.
 */

import { closePool, poolGauge, poolTimeouts } from './db/pool.js';
import { start as startNotifier } from './notifier.js';
import {
  backupConfig, reportBackupConfig, backupTask, preflight as backupPreflight,
} from './backup.js';
import { notifierConfig } from '@habiterall/shared/notify-send.js';
import { log } from '@habiterall/shared/log.js';
import { logStartup, watchRuntime } from '@habiterall/shared/observe.js';
import { armShutdown } from '@habiterall/shared/shutdown.js';

// Take the signals NOW, ahead of every await below and ahead of the
// `config_missing` check — the same reasoning `server.js` states at its own
// arm: Node is PID 1 in the image (exec-form `CMD`, no init), and for PID 1 a
// signal with default disposition is *discarded* rather than fatal, so until
// something installs a handler a `docker stop` does nothing at all and the
// operator waits out the full grace for a SIGKILL.
//
// `cleanup` is a mutable binding rather than a fixed closure: at arm time
// there is neither a notifier nor a runtime watcher to stop, so it starts as
// "close whatever has been opened" (the pool) and is reassigned once both
// exist, below.
//
// This IS the whole of this process's shutdown path — there is no server for
// `installShutdown` to drain and nothing here ever adopts this arm — which is
// exactly the case `reason` exists for: the default string in
// `shared/src/shutdown.js` claims a server was about to listen, and that
// sentence is false here on every single run.
// The returned handle is deliberately not kept. `server.js` keeps its `arm` to
// hand to `installShutdown`, which ADOPTS it once the server is listening;
// there is no server here and nothing to adopt it, so the handle has no
// caller — and a binding held for a call that cannot exist reads as a missing
// line rather than as an absent one.
let cleanup = () => closePool();
armShutdown({
  log,
  cleanup: () => cleanup(),
  reason: 'this process runs no server; this is its only shutdown path',
});

// Read through a variable key, for the same reason `server.js` marks its own:
// so a fourth name added to the list cannot go unseen by the source walk in
// `shared/test/compose.test.js`.
//
// `DATABASE_URL` is listed for the same reason it is in `server.js` and is
// just as unreachable here: `db/pool.js` asserts it at module scope, and that
// import is evaluated before this body runs, so a missing or malformed one
// throws during import — above this line, in microseconds, with no window an
// arm could cover.
//
// `SESSION_SECRET` is genuinely required here, and it is not the obvious one.
// This process signs every ntfy answer code with it (`signAnswer`,
// `notifier.js`), and the app's `POST /notify/ntfy/answer` route verifies the
// signature with its own copy of the same variable — so the two processes
// MUST hold the identical value, or every ntfy button silently fails closed
// with nothing in either log naming why.
//
// No `PUBLIC_URL` check: an unset one already surfaces on `notify.starting`
// below as `app_url: '(unset)'` and `ntfy_answers: 'off'`, which is exactly
// what an operator who left it out needs to see.
//
// @env DATABASE_URL SESSION_SECRET
for (const required of ['DATABASE_URL', 'SESSION_SECRET']) {
  if (!process.env[required]) {
    log.error('config_missing', { variable: required });
    process.exit(1);
  }
}

// The backup block, moved here verbatim in spirit from `server.js`. The
// property the old comment there claimed — "started here rather than at
// import time so the test suites, which import `api.js`, never post to a real
// webhook" — is now structural rather than a convention: the start is in a
// module none of those suites import at all.
//
// `null` unless `HABITERALL_BACKUP_DIR` is set — the opt-in.
const backupCfg = backupConfig(process.env);
// Once, at boot, whether or not backups end up enabled — never per request.
// `GET /backup/status` (api.js, on the APP process) calls `backupEnabled()` ->
// `backupConfig()` on every hit, and `backupConfig` is pure for exactly that
// reason: what it found wrong used to be logged as a side effect of that
// call, so any one of N tenants opening the "Backup and restore" dialog could
// drive an error-level line into the operator's log at the read limiter's
// rate — in exactly the state this feature ships deliberately (a backup
// directory set before `DATABASE_URL_ADMIN` is added). Calling the reporter
// here, unconditionally, is what still gets that line logged loudly at boot.
reportBackupConfig(backupCfg);
const backup = backupTask(process.env);   // null unless HABITERALL_BACKUP_DIR is set
if (backup) {
  // dir, schedule and keep are fine in this process's own log — only the
  // operator reads it, and they are the one who set the directory in their
  // own compose file in the first place. It is the API response
  // (`GET /backup/status`, served by the APP process) that must never carry
  // any of them.
  log.info('backup.starting', {
    dir: backupCfg.dir, schedule: backupCfg.schedule, keep: backupCfg.keep,
  });
  backupPreflight(backupCfg);
}

// Byte-identical to the call that used to leave `server.js`: same env, same
// hook shape, same edition-agnostic contract `habiterall-personal`'s own
// `start()` call takes.
const notifier = startNotifier(process.env, backup ? { onTick: backup } : {});

// `start()` returns `null` only when `HABITERALL_NOTIFY=off` AND there is no
// backup hook — it has already logged `notify.disabled` itself. There is
// nothing left for this container to do: no tick, no gateway, no dump.
if (!notifier) {
  log.info('notifier.nothing_to_run', {
    consequence: 'reminders are off and no backup directory is configured; stop running this container',
  });
  await closePool();
  // 0: nothing was dropped, nothing was ever accepted. This is what pairs
  // with `restart: on-failure` in the compose files — `unless-stopped` here
  // would restart a container that intends to exit cleanly, forever.
  process.exit(0);
}

logStartup(log, {
  edition: 'cloud-notifier',
  // No `port`: this process listens on nothing, and a `port` field here would
  // read as a claim that something else could connect to it.
  pg_pool_max: Number(process.env.PG_POOL_MAX) || 10,
  ...poolTimeouts(),
  notify: (process.env.HABITERALL_NOTIFY ?? 'on').toLowerCase(),
  discord_bot: !!process.env.DISCORD_BOT_TOKEN,
  notify_interval_ms: notifierConfig(process.env).intervalMs,
  backup: !!backup,
  log_level: log.level,
});

// One line a minute, the same signal `server.js` graphs — event-loop lag is
// what a heavy tick looks like from outside it, and pool exhaustion is what a
// replica count that outgrew Postgres looks like. No `overviewMemoGauge`, no
// `sessionStore.touchStats()`: neither exists in this process.
const runtime = watchRuntime(log, {
  extra: () => poolGauge(),
});

// Assigned only now that both exist, which is what the mutable binding at the
// top of this file is for: a signal landing before this line still closes the
// pool; one landing after it also stops the tick and the runtime watcher.
cleanup = async () => {
  runtime.stop();
  notifier.stop();
  await closePool();
};
