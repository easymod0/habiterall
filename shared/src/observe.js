/**
 * The three things worth logging that are not about habits.
 *
 * `logStartup` answers "what is this process actually configured as", once.
 * `requestLog` reports the requests that went wrong or took too long.
 * `watchRuntime` reports the one number that predicts trouble here: how long
 * the event loop is blocked.
 *
 * Neither edition's version of any of this may differ, so it lives here. Note
 * `requestLog` returns an Express-shaped middleware without importing Express —
 * it only touches `req.method`, `req.originalUrl` and `res.on('finish')`, which
 * are Node's own or plain properties. That keeps the rule this directory lives
 * by (no HTTP framework, no database, no DOM) while still letting both editions
 * share one definition of a request worth mentioning.
 */

import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * One line saying what this process is.
 *
 * Deliberately dull, and the most useful line in the log: half of "why did it
 * not do X" is answered by the configuration it started with. `tz` and `zone`
 * are printed as a pair because they disagree in the case that matters — a
 * container has no timezone, so `TZ` unset means `zone` is UTC whatever the
 * host's clock says, and every reminder is judged against that.
 *
 * @param {{info: Function}} log
 * @param {Record<string, any>} [fields] edition-specific configuration
 */
export function logStartup(log, fields = {}) {
  log.info('startup', {
    node: process.version,
    pid: process.pid,
    tz: process.env.TZ ?? '(unset)',
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...fields,
  });
}

/**
 * Request logging, for the requests that are worth a line.
 *
 * NOT one line per request. An access log is the reverse proxy's job, it is
 * where the TLS and the real client address already are, and a line per request
 * in the application log means the interesting ones — the 500, the slow one —
 * arrive buried in thousands of 200s. `LOG_REQUESTS=true` turns them all on for
 * when that is what you want.
 *
 * What always gets a line:
 *
 * - **5xx** at error, with the request id, so the report "it broke at 14:03"
 *   can be tied to a stack trace.
 * - **401 / 403** at warn: someone is being turned away, which is either a
 *   suspended account or an attempt worth seeing.
 * - **429** at warn: a rate limit fired. This is read from the *response*
 *   rather than hooked into the limiter, so every limiter is covered by
 *   construction and a new one cannot forget to report itself.
 * - **slow** at warn, over `slowMs`. On a single-threaded server a slow request
 *   is not one user's problem — the event loop is blocked for everybody, which
 *   is why this is a warning and not a curiosity.
 *
 * The id is echoed as `X-Request-Id` so a user can quote it, and an id the proxy
 * already generated is preferred over inventing a second one for the same
 * request.
 *
 * @param {{info: Function, warn: Function, error: Function, child?: Function}} log
 * @param {{slowMs?: number, all?: boolean}} [options]
 */
export function requestLog(log, options = {}) {
  const slowMs = options.slowMs ?? (Number(process.env.LOG_SLOW_MS) || 1000);
  const all = options.all ?? (process.env.LOG_REQUESTS === 'true');

  return function requestLogger(req, res, next) {
    const startedAt = process.hrtime.bigint();
    const header = req.headers?.['x-request-id'];
    const id = typeof header === 'string' && header.length <= 64
      ? header
      : randomUUID().slice(0, 8);

    req.logId = id;
    // Set before the handler runs: a 500 must still carry the id the log used.
    res.setHeader?.('X-Request-Id', id);
    // A child logger so a handler can add lines that join up with this one.
    req.log = log.child ? log.child({ req: id }) : log;

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields = {
        req: id,
        method: req.method,
        // The path without its query string: a query can carry a date range or
        // a mode, and none of it is worth the cardinality.
        path: String(req.originalUrl ?? req.url ?? '').split('?')[0],
        status: res.statusCode,
        ms: Math.round(ms),
        user: req.session?.user?.id,
      };

      if (res.statusCode >= 500) log.error('http.error', fields);
      else if (res.statusCode === 429) log.warn('http.rate_limited', fields);
      else if (res.statusCode === 401 || res.statusCode === 403) {
        log.warn('http.denied', fields);
      } else if (ms > slowMs) {
        log.warn('http.slow', { ...fields, slow_ms: slowMs });
      } else if (all) log.info('http', fields);
    });

    next();
  };
}

/**
 * Once a minute, how the process is doing.
 *
 * Event-loop delay is the number to watch, and it is the one a request duration
 * hides: this server computes a dashboard's streaks and scores synchronously, so
 * a heavy account's request blocks *every* other tenant for its duration. The
 * symptom is that all latencies rise together while CPU still looks fine, and
 * lag is what shows it. It is also the signal that says "add a replica" rather
 * than "tune a query" — the work is in Node, not in the database.
 *
 * Emitted as one info line per interval so it can be graphed from the logs with
 * no metrics endpoint to scrape, and re-emitted as a warning when p99 crosses
 * `lagWarnMs` so it can be alerted on without a query.
 *
 * @param {{info: Function, warn: Function}} log
 * @param {object} [options]
 * @param {number} [options.intervalMs]
 * @param {number} [options.lagWarnMs]
 * @param {() => Record<string, any>} [options.extra] e.g. connection-pool gauges
 * @returns {{stop: () => void}}
 */
export function watchRuntime(log, options = {}) {
  const intervalMs = options.intervalMs ?? (Number(process.env.LOG_RUNTIME_MS) || 60_000);
  const lagWarnMs = options.lagWarnMs ?? (Number(process.env.LOG_LAG_WARN_MS) || 200);

  // The histogram records the WHOLE interval between the intended and the actual
  // firing, so an idle loop reports its own sampling resolution — 20ms of
  // "lag" on a server doing nothing, which is a baseline nobody can interpret
  // and an alert threshold nobody can set. Subtracting the resolution is what
  // makes idle read as 0. Measured, not assumed: at resolution 10 an idle loop
  // reports 10.1ms and a real 300ms block reports 307.8ms.
  const RESOLUTION_MS = 10;
  const loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  loop.enable();

  /** Nanoseconds from the histogram to milliseconds of actual delay. */
  const lag = (ns) => Math.max(0, Math.round(ns / 1e6 - RESOLUTION_MS));

  const tick = () => {
    const mem = process.memoryUsage();
    const gauge = {
      rss_mb: Math.round(mem.rss / 1e6),
      heap_mb: Math.round(mem.heapUsed / 1e6),
      loop_p50_ms: lag(loop.percentile(50)),
      loop_p99_ms: lag(loop.percentile(99)),
      loop_max_ms: lag(loop.max),
      uptime_s: Math.round(process.uptime()),
      ...(options.extra?.() ?? {}),
    };

    log.info('runtime', gauge);
    if (gauge.loop_p99_ms > lagWarnMs) {
      log.warn('runtime.loop_blocked', {
        ...gauge,
        warn_over_ms: lagWarnMs,
      });
    }
    // Per interval, not since boot: a spike an hour ago must not keep the
    // warning latched on, and a max that only ever grows cannot be graphed.
    loop.reset();
  };

  const timer = setInterval(tick, intervalMs);
  // This is telemetry. It must never be the reason a process stays alive.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      loop.disable();
    },
  };
}
