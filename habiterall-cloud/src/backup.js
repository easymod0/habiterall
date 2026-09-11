/**
 * The scheduled backup, cloud edition (issue #75): a whole-database
 * `pg_dump`, once a night, regardless of account count.
 *
 * This is deliberately unlike `habiterall-personal/src/backup.js`, which
 * writes a per-account JSON export. Cloud's N accounts live under RLS, and a
 * per-account export path would need to step outside every policy on
 * purpose — a security-shaped decision this phase does not make (see
 * `.claude/work/issue-75/brief-phase2.md`, premise 5 and #75's phase-one
 * decision 1). So the operation here is one process, instance-wide, run as a
 * credential that can BYPASS row-level security: every tenant table is
 * `FORCE ROW LEVEL SECURITY`, which applies RLS to the table owner too, so
 * "dump as the owner" is not sufficient — the role needs superuser or
 * `BYPASSRLS`. `DATABASE_URL_ADMIN` is that credential; the app's ordinary
 * `DATABASE_URL` role (`habiterall_app`) cannot do this at all.
 *
 * `pg_dump` opens its own connection outside `pg`/the pool, so this module
 * needs no helper from `./db/pool.js` and adds none — `db/pool.js`'s export
 * list is swept by `test/tenancy.integration.mjs`, and this feature has no
 * business appearing there.
 *
 * Cloud keeps NO status record at all: not module state, not a table — only
 * an in-memory `lastAttemptDate` used for the day's dedupe. The operator's log
 * is the durable record of how a run went. See the comment above
 * `GET /backup/status` in `api.js` and `habiterall-cloud/CLAUDE.md` for the
 * reasoning (no `data_version` bump on a nightly write, no new lock-order
 * question for `withUserWrite`, and no tenancy case for state no tenant may
 * read anyway).
 */

import { spawn } from 'node:child_process';
import {
  mkdirSync, readdirSync, unlinkSync, renameSync, statSync, existsSync, createWriteStream,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertConnectionString } from './db/url.js';
import { parseBackupSchedule, backupFileName, prunableBackups } from '@habiterall/shared/backup.js';
import { zonedClock } from '@habiterall/shared/notify.js';
import { log } from '@habiterall/shared/log.js';

/** The default `HH:MM`, and its minutes-since-midnight, when nothing valid is set. */
const DEFAULT_SCHEDULE = '03:00';
const DEFAULT_SCHEDULE_MINUTES = 180;
const DEFAULT_KEEP = 7;

/**
 * How long a single `pg_dump` may run before this module kills it.
 *
 * Without a bound, a hung child leaves `inFlight` set forever and the
 * feature silently disables itself for good — the `notify_status` lesson
 * (root `CLAUDE.md`) arriving by a different route. Two hours is long enough
 * that a legitimately large dump is never killed, and short enough that at
 * most one night's backup is lost to it.
 */
const BACKUP_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** SIGTERM first; SIGKILL this much later if the child is still alive. */
const KILL_GRACE_MS = 5_000;

/** A per-row Postgres error can spew; this is plenty to name the cause. */
const STDERR_CAP_BYTES = 8 * 1024;

/**
 * Read the operator's five variables. Every read is a LITERAL member
 * expression (`env.HABITERALL_BACKUP_DIR`, not a destructure or a computed
 * key) so `shared/test/compose.test.js`'s graph walker can see it. Never
 * throws — a bad backup variable must not stop the server booting.
 *
 * PURE — no logging, no side effects (fix-round FIX 3, issue #75).
 * `backupEnabled()` calls this on every `GET /backup/status` request, and
 * this function used to log `backup.admin_url_missing` at ERROR as a side
 * effect of computing `enabled` — so any ONE of N tenants opening the
 * "Backup and restore" dialog drove an error-level line into the operator's
 * log at the read limiter's rate, in exactly the state this feature ships
 * deliberately (a backup directory set before `DATABASE_URL_ADMIN` is
 * added). What WOULD have been logged is carried out on the returned object
 * instead (`scheduleInvalid`/`keepInvalid`/`adminUrlMissing`, plus the raw
 * values the messages need) so `reportBackupConfig` can log it once, at
 * boot, without this function needing to know who is asking.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{dir: string, schedule: string, scheduleMinutes: number,
 *   keep: number, adminUrl: string, pgDump: string, enabled: boolean,
 *   scheduleInvalid: boolean, rawSchedule: string|undefined,
 *   keepInvalid: boolean, rawKeep: string|undefined,
 *   adminUrlMissing: boolean}}
 */
export function backupConfig(env) {
  const dir = String(env.HABITERALL_BACKUP_DIR ?? '').trim();

  const rawSchedule = env.HABITERALL_BACKUP_SCHEDULE;
  const parsedSchedule = parseBackupSchedule(rawSchedule);
  // Unset says nothing wrong; set-but-unparseable is a typo that must not
  // silently disable the backups, and must not be silent either.
  const scheduleWasSet = rawSchedule !== undefined && rawSchedule !== '';
  const scheduleInvalid = parsedSchedule === null && scheduleWasSet;
  const schedule = parsedSchedule === null ? DEFAULT_SCHEDULE : String(rawSchedule);
  const scheduleMinutes = parsedSchedule === null ? DEFAULT_SCHEDULE_MINUTES : parsedSchedule;

  const rawKeep = env.HABITERALL_BACKUP_KEEP;
  const keepWasSet = rawKeep !== undefined && rawKeep !== '';
  const parsedKeep = Math.floor(Number(rawKeep));
  // `keep: 0` must never be honoured — it would mean deleting the file this
  // very run just wrote.
  const parsedKeepInvalid = !Number.isFinite(parsedKeep) || parsedKeep < 1;
  const keepInvalid = parsedKeepInvalid && keepWasSet;
  const keep = parsedKeepInvalid ? DEFAULT_KEEP : parsedKeep;

  // No fallback to DATABASE_URL. `migrate.js` has one (`DATABASE_URL_ADMIN ??
  // DATABASE_URL`) and copying it here is the silent-empty-backup trap: it
  // would let a misconfigured instance quietly dump as the RLS-restricted app
  // role, which — since `--enable-row-security` is never passed (see
  // `pgDumpArgs`) — is at least LOUD (a non-zero exit), but "loud in a log
  // nobody reads" is not the same as refused up front.
  const rawAdminUrl = env.DATABASE_URL_ADMIN;
  const adminUrl = rawAdminUrl ? String(rawAdminUrl).trim() : '';
  let adminUrlUsable = false;
  if (adminUrl) {
    try {
      assertConnectionString(adminUrl, 'DATABASE_URL_ADMIN');
      const protocol = new URL(adminUrl).protocol;
      adminUrlUsable = protocol === 'postgres:' || protocol === 'postgresql:';
    } catch {
      adminUrlUsable = false;
    }
  }

  const pgDump = String(env.HABITERALL_PG_DUMP ?? '').trim() || 'pg_dump';

  const dirWanted = Boolean(dir);
  const adminUrlMissing = dirWanted && !adminUrlUsable;

  return {
    dir, schedule, scheduleMinutes, keep, adminUrl, pgDump,
    enabled: dirWanted && adminUrlUsable,
    scheduleInvalid, rawSchedule, keepInvalid, rawKeep, adminUrlMissing,
  };
}

/**
 * Log what `backupConfig` found wrong, if anything — split out of it on
 * purpose (FIX 3, issue #75 fix round). Call this ONCE, at boot, beside
 * `preflight` — never per request. See `backupConfig`'s own comment for why
 * logging cannot live there.
 *
 * @param {ReturnType<typeof backupConfig>} cfg
 */
export function reportBackupConfig(cfg) {
  if (cfg.scheduleInvalid) {
    log.warn('backup.schedule_invalid', { value: cfg.rawSchedule, fallback: DEFAULT_SCHEDULE });
  }
  if (cfg.keepInvalid) {
    log.warn('backup.keep_invalid', { value: cfg.rawKeep, fallback: DEFAULT_KEEP });
  }
  if (cfg.adminUrlMissing) {
    // An operator who asked for backups and did not get them must be told at
    // the top of their volume of a log, not left with silence.
    log.error('backup.admin_url_missing', {
      reason: 'HABITERALL_BACKUP_DIR is set but DATABASE_URL_ADMIN is absent, ' +
        'not a valid connection string, or not a postgres:// URL',
    });
  }
}

/**
 * Rebuild the admin connection string from the parts that were checked, with
 * the password removed, and return the password separately.
 *
 * This is trap 2 (root brief): the password goes in the child's environment
 * as `PGPASSWORD` and never in argv, because argv is visible in `ps` to
 * anything else on the box. Pure and exported so this exact transformation —
 * not a claim about source text — is what a test can assert reaches
 * `spawn`.
 *
 * @param {string} adminUrl
 * @returns {{arg: string, password: string}}
 */
export function pgDumpConnection(adminUrl) {
  const url = new URL(adminUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_URL_ADMIN is not a postgres connection string: ${url.protocol}`);
  }
  // `.password` is percent-encoded exactly as it appeared in the URL;
  // PGPASSWORD wants the raw bytes, not the URL escaping, or a password
  // containing a `%` or a reserved character would reach the child mangled.
  const password = decodeURIComponent(url.password);
  const rebuilt = new URL(adminUrl);
  rebuilt.password = '';
  return { arg: rebuilt.toString(), password };
}

/**
 * The exact argv `pg_dump` is run with.
 *
 * `--enable-row-security` must NEVER appear here. Measured (root brief,
 * premise 5): against a role that cannot bypass RLS, that flag turns a loud
 * exit-1 failure into a COMPLETE-LOOKING dump with every table's `COPY`
 * block empty — 37 bytes smaller than the real one, so no size check could
 * ever catch it. The safety here is `pg_dump`'s DEFAULT, `row_security =
 * off`, which instead refuses outright to produce that file.
 *
 * `--no-password` so a wrong credential fails deterministically instead of
 * blocking on a prompt neither this process nor its `PGPASSWORD` env can
 * answer. `--format=plain`, stated rather than left to the default, because
 * the restore procedure (`psql < file`, into an empty database) depends on
 * it being `psql`-able.
 *
 * @param {string} connArg
 * @returns {string[]}
 */
export function pgDumpArgs(connArg) {
  return ['--no-password', '--format=plain', '--dbname', connArg];
}

/** Whether today's file already exists — the crash-safe half of the dedupe. */
function todaysFileExists(dir, date) {
  return existsSync(join(dir, backupFileName(date, 'sql')));
}

/**
 * One dump. Never throws — every failure path logs at `error` and returns
 * normally, so the next scheduled tick tries again; a failed night must not
 * permanently disable the feature.
 *
 * @param {{dir: string, keep: number, adminUrl: string, pgDump: string}} cfg
 *   from `backupConfig`
 * @param {{instant?: Date|number}} [deps] `instant` defaults to now; a test
 *   drives this directly with a chosen one.
 */
export async function runBackup(cfg, deps = {}) {
  const { instant = new Date() } = deps;
  // The empty zone is deliberate: this schedule is on the SERVER's own
  // clock, because it is the operator's job on the operator's machine.
  // `resolveTimeZone` answers where an ACCOUNT is, a different question —
  // folding the two together breaks one of them (root CLAUDE.md).
  const { date } = zonedClock(instant, '');

  // FIX 1 (issue #75 fix round): this function's own JSDoc says "never
  // throws", and it did not keep that promise — `mkdirSync` below and the
  // `renameSync`/`statSync` pair further down used to sit OUTSIDE every try
  // in this function. `backupTask` builds `inFlight = runBackup(...)
  // .finally(...)` with no `.catch()` (belt-and-braces added there too, see
  // its own comment) and never awaits the result, so a rejection here became
  // an UNHANDLED promise rejection — which Node treats as fatal by default —
  // taking down the whole instance (every tenant's reminders and API with
  // it) for something as ordinary as a read-only mount, a regular file
  // sitting at a path component, or a root-owned volume. Wrapping the WHOLE
  // body (mirroring `habiterall-personal/src/backup.js`'s `runBackup`, which
  // already does this) is what keeps that promise true: every path below now
  // logs `backup.failed` at error and returns normally.
  try {
    mkdirSync(cfg.dir, { recursive: true });

    const name = backupFileName(date, 'sql');
    const finalPath = join(cfg.dir, name);
    // A random, per-RUN suffix (FIX 4, issue #75 fix round) — never
    // `process.pid`, because in a container the node process is usually pid
    // 1, so two replicas sharing this volume would pick the SAME name and
    // this would do nothing. Before this, two replicas both saw
    // `todaysFileExists` false, both opened the identical `${finalPath}.tmp`
    // with O_TRUNC, interleaved two dumps' bytes into it, and both renamed —
    // a corrupt file logged as `backup.ok` on both sides. With a unique
    // suffix per run, two writers can never share one temporary file, so the
    // blanket "unlink a stale .tmp first" this module used to do is GONE:
    // with unique names nothing this run wrote can already exist, and
    // unlinking blindly would delete another writer's still-in-progress
    // file — the very corruption this fix removes. What each failure path
    // below still does is unlink its OWN tmp file. The suffix sits between
    // the `.sql` extension and the final `.tmp`, so it can never match
    // `BACKUP_SQL_FILE_RE` (anchored `\.sql$`) and retention can never see it
    // as a kind this module manages.
    const tmpPath = `${finalPath}.${randomUUID()}.tmp`;

    let conn;
    try {
      conn = pgDumpConnection(cfg.adminUrl);
    } catch (err) {
      log.error('backup.failed', { date }, err);
      return;
    }

    const child = spawn(cfg.pgDump, pgDumpArgs(conn.arg), {
      // PGPASSWORD only when the URL actually carried a password (FIX 5,
      // issue #75 fix round). Always setting the key — even to `''` for a
      // passwordless URL — would OVERRIDE an inherited PGPASSWORD from the
      // parent environment with nothing, and would suppress a `.pgpass`
      // lookup that `--no-password` (see `pgDumpArgs`) leaves as the only
      // other way to authenticate. Never in argv either way — see
      // `pgDumpConnection`'s own comment.
      env: conn.password ? { ...process.env, PGPASSWORD: conn.password } : { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Bounded: a per-row Postgres error can spew, and this only has to name
    // the cause, not reproduce the whole thing.
    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
      if (stderrTail.length < STDERR_CAP_BYTES) stderrTail += chunk.toString('utf8');
    });

    // Mode 0o600 (FIX 5, issue #75 fix round): this file holds every
    // tenant's rows plus every stored ntfy token and Discord webhook, and
    // `createWriteStream`'s default (0666, so typically 0644 under an
    // ordinary umask) would leave it group/world-readable; `renameSync`
    // preserves whatever mode the file was created with.
    const tmpStream = createWriteStream(tmpPath, { mode: 0o600 });
    let streamErr = null;
    /** @type {Promise<void>} */
    const streamFinished = new Promise((resolve) => {
      tmpStream.on('finish', () => resolve());
      tmpStream.on('error', (err) => {
        streamErr = err;
        // FIX 2 (issue #75 fix round): without this, `pipe` stops reading on
        // a write error but nothing tells `pg_dump` to stop producing — the
        // OS pipe fills at 64 KiB, the child blocks on its own `write()`,
        // and `BACKUP_TIMEOUT_MS` (two hours) becomes the ONLY thing that
        // ever notices. For those two hours `pg_dump` holds its REPEATABLE
        // READ snapshot open, pinning the xmin horizon so vacuum cannot
        // reclaim, while `inFlight` blocks every later attempt. Destroying
        // `stdout` unblocks the child's write immediately by closing the
        // read end of the pipe (its next write fails with EPIPE); the
        // `SIGKILL` is belt and braces in case something else still holds it
        // open.
        child.stdout.destroy();
        child.kill('SIGKILL');
        resolve();
      });
    });
    child.stdout.pipe(tmpStream);

    let childErr = null;
    let exitCode = null;
    let exitSignal = null;
    /** @type {Promise<void>} */
    const childClosed = new Promise((resolve) => {
      child.on('error', (err) => { childErr = err; resolve(); });
      child.on('close', (code, signal) => { exitCode = code; exitSignal = signal; resolve(); });
    });

    // A hung child must not leave `inFlight` set forever — see the
    // constant's own comment above. `timedOut` is what tells the timeout
    // kill apart from an operator's own SIGTERM in the log below (FIX 5,
    // issue #75 fix round) — the one failure whose remedy differs (a bigger
    // `BACKUP_TIMEOUT_MS`, or a faster dump) from every other signal.
    let timedOut = false;
    let killGrace = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killGrace = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, BACKUP_TIMEOUT_MS);

    // BOTH, not either. Renaming on the child's exit alone is a
    // truncated-file race: the child can close its stdout and exit before
    // the write stream has finished flushing everything it already
    // received.
    await Promise.all([childClosed, streamFinished]);
    clearTimeout(timeout);
    if (killGrace) clearTimeout(killGrace);

    const failed = Boolean(childErr) || Boolean(streamErr) || exitCode !== 0 || Boolean(exitSignal);
    if (failed) {
      // The partial bytes must not survive (premise 5: a killed dump left
      // 9,435 bytes of truncated SQL on disk, looking like a backup).
      try { unlinkSync(tmpPath); } catch { /* best effort */ }
      log.error('backup.failed', {
        date, exit_code: exitCode, signal: exitSignal ?? undefined,
        ...(timedOut ? { timed_out: true } : {}),
        stderr: stderrTail.trim(),
      }, ...(childErr ?? streamErr ? [childErr ?? streamErr] : []));
      return;
    }

    renameSync(tmpPath, finalPath);
    const bytes = statSync(finalPath).size;

    let pruned;
    try {
      const names = readdirSync(cfg.dir);
      // `kinds: ['sql']` and never `json`/`db` — a cloud instance must not
      // delete a personal instance's files if someone ever points both at
      // one directory.
      pruned = prunableBackups(names, cfg.keep, { except: [name], kinds: ['sql'] });
      for (const doomed of pruned) unlinkSync(join(cfg.dir, doomed));
    } catch (err) {
      // The file that DID land above stays — only the STATE says error, the
      // same rule personal's runBackup follows: a volume quietly filling up
      // from a failed prune is exactly the failure that must be loud.
      log.error('backup.prune_failed', { date, file: name }, err);
      return;
    }

    if (pruned.length) {
      log.info('backup.pruned', { date, count: pruned.length, files: pruned.join(', ') });
    }

    log.info('backup.ok', { date, file: name, bytes, pruned: pruned.length });
  } catch (err) {
    // Every other failure path lands here — `mkdirSync`, or anything thrown
    // by an `fs` call outside the inner handlers above (`renameSync`,
    // `statSync`): log at error and return normally rather than let it
    // propagate. See this function's own comment above for the cost of NOT
    // having this (FIX 1, issue #75 fix round).
    log.error('backup.failed', { date }, err);
  }
}

let inFlight = null;
/** The only durable-ish state this module keeps: today's date once a run has
 * been attempted, so a failure is not retried every minute — see `backupTask`'s
 * own comment for why this is in memory and not a table. */
let lastAttemptDate = '';

/**
 * The periodic job `notifier.js` hooks onto the one tick that already runs —
 * never a `setInterval` of its own. `null` when the feature is not
 * configured, so `server.js` never registers a hook for a disabled instance.
 *
 * Unlike personal's `backupTask` (`habiterall-personal/src/backup.js`), the
 * function this returns is deliberately NOT awaited by its caller — and must
 * not be: a `pg_dump` run's duration is the size of the database, and
 * awaiting it inside `startNotifier`'s `running` guard — right for
 * personal's synchronous, millisecond JSON write — would suppress the
 * reminder tick for every account on the instance for that whole time. So
 * this returns PROMPTLY and carries its own "no two runs at once" guarantee
 * in `inFlight`, which `backupInFlight()` exposes so a test has something to
 * await on a deliberately non-blocking task.
 *
 * The dedupe is deliberately BOTH the filesystem and an in-memory date, and
 * neither alone is enough. Today's file existing is the crash-safe,
 * restart-safe record that the day succeeded — a redeploy at 14:00 must not
 * re-dump. The in-memory date is what stops a FAILED run being retried every
 * minute for the rest of the day; because it lives only in memory, a restart
 * after the operator fixes the underlying problem retries once, which is the
 * behaviour wanted.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{instant?: Date|number}} [deps] forwarded to `runBackup`.
 * @returns {((instant: Date|number) => void) | null}
 */
export function backupTask(env = process.env, deps = {}) {
  const cfg = backupConfig(env);
  if (!cfg.enabled) return null;

  return (instant) => {
    // This module's own guard: cheapest check first, no syscall.
    if (inFlight) return;

    const { date, minutes } = zonedClock(instant, '');
    if (lastAttemptDate === date) return;
    if (minutes < cfg.scheduleMinutes) return;
    if (todaysFileExists(cfg.dir, date)) {
      // The file on disk is already the record of success; only the
      // in-memory date needs updating.
      lastAttemptDate = date;
      return;
    }
    lastAttemptDate = date;
    inFlight = runBackup(cfg, { ...deps, instant })
      // Deliberately redundant with `runBackup`'s own outer try/catch (FIX
      // 1, issue #75 fix round): `.finally()` below does NOT swallow a
      // rejection — it observes settlement and then re-throws the same
      // reason — so without this `.catch()`, a future unguarded throw
      // inside `runBackup` would still leave `inFlight` a REJECTED promise
      // with no handler, and this call site is never awaited by its own
      // caller (see this function's own comment above), so Node would treat
      // that as an unhandled rejection and terminate the process. The cost
      // of being wrong here is the whole instance, which is why this stays
      // even though `runBackup` should never let anything reach it.
      .catch((err) => { log.error('backup.unhandled', { date }, err); })
      .finally(() => { inFlight = null; });
    // Deliberately NOT awaited — see this function's own comment above.
  };
}

/**
 * The current run's promise, or `null` when nothing is in flight. Exported
 * only so a test has something to await on a deliberately non-blocking task.
 */
export function backupInFlight() {
  return inFlight;
}

/** The one boolean `GET /backup/status` may send. */
export function backupEnabled(env = process.env) {
  return backupConfig(env).enabled;
}

/**
 * Log the `pg_dump` binary's version at startup, or that it could not be run
 * at all. Never throws, never blocks the boot.
 *
 * This is trap 4's loud half (root brief): the commonest failure — no client
 * in the image, or a client older than the server — becomes a line the
 * operator sees at startup rather than a silence at 03:00. `pg_dump` itself
 * refuses a newer server loudly; this only reports the version it found.
 *
 * @param {{pgDump: string}} cfg
 */
export function preflight(cfg) {
  const child = spawn(cfg.pgDump, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
  child.on('error', (spawnErr) => {
    log.error('backup.pg_dump_unusable', { pg_dump: cfg.pgDump }, spawnErr);
  });
  child.on('close', (code) => {
    if (code === 0) {
      log.info('backup.pg_dump', { version: out.trim() });
    } else {
      log.error('backup.pg_dump_unusable',
        { pg_dump: cfg.pgDump, exit_code: code, stderr: err.trim() });
    }
  });
}
