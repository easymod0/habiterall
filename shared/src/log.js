/**
 * Structured logging.
 *
 * The transport is a pod's stdout, and the reader is a log aggregator, so the
 * design follows from that rather than from what looks nice in a terminal:
 *
 * **One event per line, always.** A stack trace is a *field*, not extra lines.
 * A multi-line record is ingested as one entry per line, which scatters the
 * trace across timestamps and leaves the first line — the one naming the error —
 * indistinguishable from an unrelated message.
 *
 * **One stream.** Everything goes to stdout with the level as a field, rather
 * than warnings and errors to stderr. Two streams are two pipes, and their
 * interleaving is not ordered, so an error and the line explaining it can arrive
 * the wrong way round. `level` is a label to filter on; a file descriptor is not.
 *
 * **No personal data, ever.** Habit names, notes, entry values and email
 * addresses are the private content of this application — a log shipped to a
 * third-party aggregator must not carry them. Log ids: `habit=7 user=3`. The
 * redaction below is a backstop for a mistake, not the policy.
 *
 * **Bounded.** An error carrying an HTTP body, or a field holding an uploaded
 * file, produces a line an aggregator will silently drop for exceeding its limit
 * — losing exactly the record someone is looking for.
 *
 * It stays console-shaped (`debug`/`info`/`warn`/`error`, and `log` as an alias
 * for `info`) because `shared/src` already injects a logger as `ctx.log ??
 * console`, and every one of those call sites should keep working unchanged.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** Longer than this and the aggregator is the one deciding what you keep. */
const MAX_LINE = 8_000;
const MAX_FIELD = 1_000;
const MAX_STACK = 2_000;

/**
 * Keys whose values never belong in a log, matched case-insensitively as a
 * substring — so `botToken`, `DISCORD_BOT_TOKEN` and `token` are all caught.
 *
 * A bot token can post to every channel the bot is in and a session cookie is
 * a live credential; either one in a log is a leak that outlives the request,
 * because logs are retained, indexed, and read by more people than the process.
 */
const SECRET_KEY = /token|secret|password|passwd|cookie|authorization|auth_|credential|webhook|session|email|dsn|connectionstring|database_url/i;

/** Values that identify a person rather than a record. Ids only, by policy. */
const PII_KEY = /^(name|habit_name|notes|note|description|display_name|value|unit|reminder_message)$/i;

const REDACTED = '[redacted]';

/**
 * Cap a value's size and shape. Objects are summarised rather than walked: a
 * log field is a scalar or it is a mistake.
 */
function scalar(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') {
    return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…[${value.length}]` : value;
  }
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value instanceof Error) return serialiseError(value);
  // A Set or Map logged by accident stringifies to '{}' and looks like a bug in
  // the logger rather than in the call site.
  if (value instanceof Set || value instanceof Map) return `[${value.constructor.name} ${value.size}]`;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return String(value);
    return json.length > MAX_FIELD ? `${json.slice(0, MAX_FIELD)}…[${json.length}]` : json;
  } catch {
    return '[unserialisable]';
  }
}

/**
 * An Error as fields.
 *
 * The stack is kept — it is the reason to log an error at all — but truncated,
 * and a `cause` chain is flattened to its messages rather than nested, because a
 * nested object cannot be queried in a log browser.
 */
function serialiseError(err) {
  if (!(err instanceof Error)) return scalar(err);

  const out = {
    err: err.message || err.name,
    err_type: err.name,
  };
  if (typeof err.stack === 'string') {
    out.stack = err.stack.length > MAX_STACK ? `${err.stack.slice(0, MAX_STACK)}…` : err.stack;
  }
  // Carried by our own httpError, and by pg for a failed query.
  for (const key of ['status', 'code', 'constraint', 'table', 'routine']) {
    if (err[key] !== undefined) out[`err_${key}`] = scalar(err[key]);
  }
  const causes = [];
  for (let cause = /** @type {any} */ (err).cause, depth = 0;
    cause && depth < 4; cause = cause.cause, depth++) {
    causes.push(cause instanceof Error ? cause.message : String(cause));
  }
  if (causes.length) out.err_cause = causes.join(' <- ');
  return out;
}

/** Apply the redaction rules to one field. */
function clean(key, value) {
  if (SECRET_KEY.test(key)) return value === undefined || value === null ? value : REDACTED;
  if (PII_KEY.test(key)) return REDACTED;
  return scalar(value);
}

/**
 * Turn console-style arguments into `{msg, fields}`.
 *
 * Both forms have to work, because the existing call sites in `shared/src` use
 * the printf-ish one and new ones should be structured:
 *
 *   log.warn('notify: send failed', err)
 *   log.info('notify.sent', { channel: 'discord', habit: 7 })
 */
function normalise(args) {
  const parts = [];
  let fields = {};

  for (const arg of args) {
    if (arg instanceof Error) {
      fields = { ...fields, ...serialiseError(arg) };
    } else if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      fields = { ...fields, ...arg };
    } else {
      parts.push(typeof arg === 'string' ? arg : scalar(arg));
    }
  }

  return { msg: parts.join(' '), fields };
}

/** `key=value` for a human at a terminal; quoted only when it has to be. */
function pair(key, value) {
  const text = String(value);
  return `${key}=${/[\s"]/.test(text) ? JSON.stringify(text) : text}`;
}

/**
 * @param {object} [options]
 * @param {string} [options.level] one of debug/info/warn/error/silent
 * @param {'json'|'pretty'} [options.format] defaults to pretty on a TTY
 * @param {Record<string, any>} [options.base] fields added to every line
 * @param {(line: string) => void} [options.write] for tests
 * @param {() => string} [options.now] for tests
 */
export function createLogger(options = {}) {
  const threshold = LEVELS[options.level ?? 'info'] ?? LEVELS.info;
  const format = options.format ?? (process.stdout?.isTTY ? 'pretty' : 'json');
  const base = options.base ?? {};
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date().toISOString());

  const emit = (level, args) => {
    if (LEVELS[level] < threshold) return;

    const { msg, fields } = normalise(args);
    const record = { t: now(), level, msg };
    for (const [key, value] of Object.entries({ ...base, ...fields })) {
      if (value === undefined) continue;
      record[key] = clean(key, value);
    }

    let line;
    if (format === 'pretty') {
      const rest = Object.entries(record)
        .filter(([k]) => !['t', 'level', 'msg', 'stack'].includes(k))
        .map(([k, v]) => pair(k, v));
      line = `${record.t.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${msg}` +
        `${rest.length ? ` ${rest.join(' ')}` : ''}` +
        // A stack is unreadable on one line for a human, and this format is only
        // ever a terminal — so here, and only here, it may span lines.
        `${record.stack ? `\n${record.stack}` : ''}`;
    } else {
      line = JSON.stringify(record);
      if (line.length > MAX_LINE) {
        line = JSON.stringify({
          t: record.t, level, msg,
          log_truncated: line.length,
          ...(record.err ? { err: scalar(record.err) } : {}),
        });
      }
    }
    write(line);
  };

  const logger = {
    level: options.level ?? 'info',
    format,
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    /** `console.log` is an info-level alias, so an injected console still works. */
    log: (...args) => emit('info', args),
    /** Is this level being emitted? For skipping work a disabled line would do. */
    enabled: (level) => (LEVELS[level] ?? LEVELS.info) >= threshold,
    /** A logger with extra fields on every line — a request id, an account. */
    child: (fields) => createLogger({ ...options, format, base: { ...base, ...fields } }),
  };

  return logger;
}

/**
 * The process-wide logger, configured from the environment.
 *
 * `LOG_LEVEL=debug` is the switch to reach for when a reminder did not arrive:
 * the notifier explains every habit it decided to skip, and why, at that level.
 */
export const log = createLogger({
  level: process.env.LOG_LEVEL,
  format: process.env.LOG_FORMAT === 'json' ? 'json'
    : process.env.LOG_FORMAT === 'pretty' ? 'pretty' : undefined,
});

export { LEVELS, serialiseError };
