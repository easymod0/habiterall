/**
 * What a process does between the signal and the exit.
 *
 * `server.close()` alone is not a drain. On Node 26 it does sweep the
 * connections that are idle at the instant it is called — the case the obvious
 * fix aims at is already handled — but it says nothing about a connection that
 * was IN FLIGHT when the signal landed and goes idle a moment later. Nothing
 * closes that one: it sits until `keepAliveTimeout` (5s) expires, and if the
 * peer is a pooling reverse proxy it is never idle for long enough to expire at
 * all, so the process runs until Docker's SIGKILL. Both were measured against
 * the real personal server; `docs/decisions/connectivity.md` has the numbers.
 *
 * The sequence is identical in both editions — only the cleanup differs
 * (`db.close()` against `await closePool()`) — so it lives here rather than
 * being written out twice. It imports no HTTP framework: it is handed a server
 * and touches only `close`, `closeIdleConnections` and the `request` event,
 * which are Node's own, the same way `observe.js` is Express-shaped without
 * importing Express.
 */

/**
 * How long the drain gets before the process exits on its own terms.
 *
 * 8s, because Docker's default `stop_grace_period` is 10s. At 8 *we* choose the
 * exit and its code, and there is a log line saying the drain ran out; at 10
 * SIGKILL chooses instead, with no line, no cleanup and a status that says only
 * that something killed it. That has to hold for an operator who never sets
 * `stop_grace_period` at all, which is why this is a constant and not an
 * environment variable — nothing has asked for a second value, and a second
 * value costs the whole registry row (both compose files, the `.env` template,
 * `docs:compose`, `compose.test.js`).
 */
export const DRAIN_DEADLINE_MS = 8000;

/**
 * Drain this server on SIGINT/SIGTERM, and bound how long that may take.
 *
 * Every option has a default, so an edition passes only the two that are its
 * own. `exit` and `onSignal` are injected for ONE reason: they are how the unit
 * test observes the sequence without ending the test process or installing real
 * handlers in it. Nothing in production passes them.
 *
 * @param {import('node:http').Server} server the listening server to drain
 * @param {object} [options]
 * @param {{info: Function, warn: Function, error: Function}} [options.log] the edition's logger
 * @param {() => void} [options.beforeClose] sync work before `close` — `runtime.stop()`, `notifier?.stop()`
 * @param {() => (void | Promise<void>)} [options.cleanup] storage teardown, after the last response
 * @param {number} [options.deadlineMs]
 * @param {string[]} [options.signals]
 * @param {(code: number) => void} [options.exit] injected for the test only
 * @param {(signal: string, handler: () => void) => void} [options.onSignal] injected for the test only
 */
export function installShutdown(server, options = {}) {
  const log = options.log ?? console;
  const beforeClose = options.beforeClose ?? (() => {});
  const cleanup = options.cleanup ?? (() => {});
  const deadlineMs = options.deadlineMs ?? DRAIN_DEADLINE_MS;
  const signals = options.signals ?? ['SIGINT', 'SIGTERM'];
  const exit = options.exit ?? ((code) => process.exit(code));
  const onSignal = options.onSignal ?? ((signal, handler) => process.on(signal, handler));

  let draining = false;

  // Attached NOW, before any signal, and that is the whole point of it. A
  // request that was already in flight when the signal arrived had its
  // `request` event long ago, so a hook installed by the signal handler would
  // never see it — and that request is the only case that hangs. Hooking the
  // response's `close` instead of `finish` covers the aborted one too: either
  // way the connection has just gone idle, and idle is what `close` sweeps.
  server.on('request', (_req, res) => {
    res.on('close', () => {
      if (draining) server.closeIdleConnections();
    });
  });

  for (const signal of signals) {
    onSignal(signal, () => {
      const startedAt = Date.now();
      if (draining) {
        // Also the idempotency guard, not only an impatient operator's escape
        // hatch: without it a second signal re-runs the whole sequence, and
        // `closePool()` a second time is an unhandled rejection.
        log.warn('shutdown.forced', { signal });
        exit(1);
        return;
      }
      draining = true;
      log.info('shutdown', { signal });
      beforeClose();
      server.close(async () => {
        await cleanup();
        // After `cleanup`, never before it, and for two readers. An operator
        // gets one line saying the drain completed and how long it took; and a
        // suite that spawns the real server has no other observable for
        // "cleanup ran" — `db.close()` / `closePool()` are closures a child
        // process cannot be watched calling.
        log.info('shutdown.drained', { signal, ms: Date.now() - startedAt });
        exit(0);
      });
      // The connections that are idle at this instant. `close` does this too on
      // Node 26; it is stated here because the sweep above is the same call and
      // reading one without the other invites deleting both.
      server.closeIdleConnections();
      // The only thing that bounds a peer which will not let go. `.unref()` so
      // the deadline is never itself the reason a drained process stays alive,
      // and no `cleanup()` on this path: something is already stuck, and a
      // cleanup that hangs too would lose the exit this just bought.
      setTimeout(() => {
        log.error('shutdown.deadline', { signal, deadline_ms: deadlineMs });
        exit(1);
      }, deadlineMs).unref();
    });
  }
}
