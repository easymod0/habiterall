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
 * There is a second hole, and it is earlier: the signal that arrives before
 * anything is listening at all. Node is PID 1 in both images (exec-form `CMD`,
 * no init), and for PID 1 a signal with DEFAULT disposition is *discarded* — so
 * between process start and `installShutdown` a `docker stop` does nothing
 * whatever and the operator waits the full grace for a SIGKILL. The window is
 * real in both editions and cloud's is the long one: `await initAuth()` there
 * is OIDC discovery, which is BOUNDED — openid-client 6.8.5's
 * `performDiscovery` is `options?.timeout ?? 30` and neither call site passes
 * one, so an IdP that accepts the connection and never answers aborts the boot
 * with a `TimeoutError` at ~30s rather than holding it open indefinitely. That
 * is still three times the shipped `stop_grace_period: 10s`, so a `docker stop`
 * landing anywhere in it waits out the whole grace and is SIGKILLed regardless.
 * `armShutdown` closes it — a bare handler installed before the first `await`,
 * which `installShutdown` then ADOPTS rather than replaces, so there is never an
 * instant with no listener and a signal that landed during boot is not lost.
 *
 * What it covers is from the entry point's module BODY onward. ES modules
 * evaluate every import first, so the express/helmet/session import cost and —
 * on personal — `db.js`'s schema and its one-time `entries.status` migration run
 * ahead of any arm placed in a module body. `docs/decisions/connectivity.md`
 * says what that leaves open and why closing it is a different change.
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
 * Take the signals NOW, before there is a server to drain.
 *
 * Called at the very top of an entry point's module body, ahead of every
 * `await`, and it is the only thing standing between a boot-window `docker
 * stop` and the SIGKILL at the end of the grace period. It cannot drain
 * anything — nothing has been accepted yet — so it closes whatever HAS been
 * opened (the SQLite handle, the Postgres pool) and leaves.
 *
 * `installShutdown` calls `adopt` once the server exists. From that instant the
 * listener registered here dispatches into the drain handler instead, which is
 * why this is an adoption rather than a `process.off` + `process.on` pair: the
 * pair has a gap between the two calls, however small, and this has none.
 *
 * Every option defaults the way `installShutdown`'s own does, and `exit` /
 * `onSignal` are injected for the same one reason — they are how the unit test
 * observes the sequence without ending the test process or installing real
 * handlers in it. Nothing in production passes them.
 *
 * @param {object} [options]
 * @param {{info: Function, warn: Function, error: Function}} [options.log] the edition's logger
 * @param {() => (void | Promise<void>)} [options.cleanup] storage teardown — whatever the module body already opened
 * @param {number} [options.deadlineMs]
 * @param {string[]} [options.signals]
 * @param {(code: number) => void} [options.exit] injected for the test only
 * @param {(signal: string, handler: () => void) => void} [options.onSignal] injected for the test only
 * @returns {{adopt: (handler: (signal: string) => void) => boolean}}
 */
export function armShutdown(options = {}) {
  const log = options.log ?? console;
  const cleanup = options.cleanup ?? (() => {});
  const deadlineMs = options.deadlineMs ?? DRAIN_DEADLINE_MS;
  const signals = options.signals ?? ['SIGINT', 'SIGTERM'];
  const exit = options.exit ?? ((code) => process.exit(code));
  const onSignal = options.onSignal ?? ((signal, handler) => process.on(signal, handler));

  /** @type {string | null} */
  let arrived = null;
  /** @type {((signal: string) => void) | null} */
  let adopted = null;

  for (const signal of signals) {
    onSignal(signal, () => {
      if (adopted) {
        // The server exists and owns everything from here, including its own
        // second-signal guard. Nothing below this line runs again.
        adopted(signal);
        return;
      }
      if (arrived) {
        // The same guard `installShutdown` has, for the same reason: without it
        // a second signal re-runs `cleanup` and races two exits.
        log.warn('shutdown.forced', { signal });
        exit(1);
        return;
      }
      arrived = signal;
      const startedAt = Date.now();
      // The explicit chain, not `Promise.resolve(cleanup())`, for the reason
      // written at the drain's own chain: personal's `db.close()` throws
      // synchronously where cloud's `closePool()` rejects, and only this form
      // catches both.
      Promise.resolve()
        .then(() => cleanup())
        .then(() => {
          // Exit 0, and the distinction is the operator's: nothing had been
          // accepted, so nothing was dropped — it was asked to stop and it
          // stopped on its own terms. 1 stays reserved for the two failures
          // below, which is what a status beside an event has to tell apart.
          //
          // After `cleanup`, never before it, exactly as `shutdown.drained` is:
          // a suite spawning the real server has no other observable for
          // "cleanup ran".
          log.info('shutdown.early', {
            signal,
            ms: Date.now() - startedAt,
            reason: 'signal arrived before the server was listening',
          });
          exit(0);
        })
        .catch((err) => {
          // The same event as the drain path's, because it means the same
          // thing here: nothing was dropped, only the teardown failed.
          log.error('shutdown.cleanup_failed', { signal, ms: Date.now() - startedAt }, err);
          exit(1);
        });
      // A cleanup that hangs during boot must still lose to the ceiling.
      // `.unref()` so the deadline is never itself what keeps the process up.
      setTimeout(() => {
        log.error('shutdown.deadline', { signal, deadline_ms: deadlineMs });
        exit(1);
      }, deadlineMs).unref();
    });
  }

  // One line per process start, and the only observable that says this process
  // could be stopped cleanly from this instant. Both drain suites wait on it,
  // which is what lets them signal INSIDE the boot window rather than after a
  // sleep and hope.
  log.info('shutdown.armed', { signals });

  return {
    /**
     * @param {(signal: string) => void} handler
     * @returns {boolean} false if a signal already arrived and the early exit owns it
     */
    adopt(handler) {
      if (arrived) return false;
      adopted = handler;
      return true;
    },
  };
}

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
 * @param {{adopt: (handler: (signal: string) => void) => boolean}} [options.arm] the boot-window handler to adopt, from `armShutdown`. It already owns the registration, so it owns `signals` and `onSignal` too: both are ignored whenever this is passed.
 * @param {(code: number) => void} [options.exit] injected for the test only
 * @param {(signal: string, handler: () => void) => void} [options.onSignal] injected for the test only
 */
export function installShutdown(server, options = {}) {
  const log = options.log ?? console;
  const beforeClose = options.beforeClose ?? (() => {});
  const cleanup = options.cleanup ?? (() => {});
  const deadlineMs = options.deadlineMs ?? DRAIN_DEADLINE_MS;
  const signals = options.signals ?? ['SIGINT', 'SIGTERM'];
  const arm = options.arm ?? null;
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

  /** @param {string} signal */
  const drain = (signal) => {
    const startedAt = Date.now();
    if (draining) {
      // Also the idempotency guard, not only an impatient operator's escape
      // hatch: without it a second signal re-runs the whole sequence — a
      // spurious `shutdown` line, two exits racing, and `closePool()` called
      // a second time to report its own teardown as failed.
      log.warn('shutdown.forced', { signal });
      exit(1);
      return;
    }
    draining = true;
    log.info('shutdown', { signal });
    beforeClose();
    server.close(() => {
      // An explicit chain rather than an `async` callback, because nothing
      // would be there to catch that one's rejection.
      Promise.resolve()
        .then(() => cleanup())
        .then(() => {
          // After `cleanup`, never before it, and for two readers. An
          // operator gets one line saying the drain completed and how long it
          // took; and a suite that spawns the real server has no other
          // observable for "cleanup ran" — `db.close()` / `closePool()` are
          // closures a child process cannot be watched calling.
          log.info('shutdown.drained', { signal, ms: Date.now() - startedAt });
          exit(0);
        })
        .catch((err) => {
          // A third exit, and its own event on purpose. The drain SUCCEEDED
          // here — every accepted response was finished — and only the
          // storage teardown failed, which is a different thing from
          // `shutdown.deadline`, where something was still stuck. Reachable:
          // `pool.end()` rejects when a client errors during end and throws
          // if anything else already ended it, and `db.close()` throws
          // `ERR_INVALID_STATE` on an already-closed handle. Left
          // uncaught it would be an unhandled rejection, which under Node's
          // default kills the process with a raw stack and no line at all —
          // reporting a completed drain as a crash.
          log.error('shutdown.cleanup_failed', { signal, ms: Date.now() - startedAt }, err);
          exit(1);
        });
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
  };

  if (arm) {
    // Adoption, and deliberately NOT `onSignal` as well: the arm's listener is
    // already on every signal, so registering a second one here would run both
    // sequences on one press. What `adopt` answers is whether the boot window
    // stayed quiet.
    //
    // Both branches below return, so `signals` and `onSignal` are dead once an
    // arm is passed — the arm took the registration, so it owns which signals
    // were taken and how. Stated rather than enforced: a throw here would be a
    // new failure mode for a combination no caller passes (both editions take
    // the defaults in both places), and the arm defaults `signals` identically.
    if (arm.adopt(drain)) return;
    // It did not: a signal landed while this process was still booting and the
    // early exit already owns the exit. All this brand-new listener can
    // usefully do is stop accepting on its way out.
    //
    // One line, because an operator whose stop landed here otherwise sees a
    // listener torn down at birth with nothing saying why. No `signal` field:
    // `adopt` answers a boolean, and the arm has already named the signal on
    // its own line.
    log.info('shutdown.adoption_refused', {
      reason: 'a signal arrived before this server was listening; the early exit owns the exit',
    });
    beforeClose();
    server.close();
    // The same pair as the drain path, for the same reason written there: the
    // sweep hooked to `request` above is this call, and reading one without the
    // other invites deleting both.
    //
    // Nothing can be idle here today, and it is worth saying what that rests
    // on, because nothing else states it. In both editions the stretch from
    // `app.listen` to this function contains no MACROTASK — personal's is
    // straight-line, and cloud's crosses only `await start()`, which resumes on
    // a microtask off an already-resolved promise — so the loop never turns and
    // no connection can be accepted in between. Put one piece of real async
    // work between the two in either entry point and THIS CALL becomes live.
    //
    // The LINE above it rests on something else entirely, and conflating the
    // two is how it gets deleted as dead. Reaching this branch at all needs the
    // boot to resume after a signal, and today it cannot: the arm's early path
    // reaches `process.exit(0)` without ever turning the loop, because
    // personal's `db.close()` is synchronous and `pool.end()` on a pool nothing
    // has borrowed from calls its end callback inline, so the whole
    // cleanup-then-exit chain drains in microtasks. That is a LIBRARY internal,
    // not a property of this file: give cloud one query before the server
    // exists — a readiness `SELECT 1`, `createTableIfMissing`, a boot-time
    // migration check — and `pool.end()` has a client to remove, the loop
    // turns, boot resumes, and this branch runs with the sweep still finding
    // nothing.
    server.closeIdleConnections();
    return;
  }

  for (const signal of signals) {
    onSignal(signal, () => drain(signal));
  }
}
