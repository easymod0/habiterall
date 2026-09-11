/**
 * The scheduled backup, personal edition (issue #75), in the JSON export's
 * own shape and, since phase two, an optional `.db` snapshot beside it.
 *
 * This is the storage/filesystem/environment half; the pure schedule and
 * retention math lives in `@habiterall/shared/backup.js` and is imported
 * from there rather than re-derived. `HABITERALL_BACKUP_FORMAT` is read in
 * THIS file and nowhere else — it is personal-only (cloud always writes a
 * whole-database `pg_dump`), so it must never be read from `shared/` or from
 * `habiterall-cloud`.
 *
 * Import direction is deliberately ONE-WAY: `api.js` already imports
 * `notifier.js`, and `api.js`'s `/backup/status` route needs `backupStatus`
 * and `backupConfig` from THIS file — so if this file imported
 * `buildBackupPayload` back from `api.js` at its own module scope, that
 * would close a cycle. Instead `runBackup` takes the payload builder as an
 * INJECTED dependency (`deps.payload`), and `server.js` — which already
 * imports both modules — is what wires them together. `backupStatus` and
 * `backupConfig` stay free of any `api.js` import for the same reason: the
 * route in `api.js` has to be able to reach them with nothing in the middle.
 */

import {
  mkdirSync, writeFileSync, readdirSync, renameSync, unlinkSync, statSync, chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { db } from './db.js';
import {
  parseBackupSchedule, parseBackupFormat, backupFileName, dueBackup, prunableBackups,
} from '@habiterall/shared/backup.js';
import { zonedClock } from '@habiterall/shared/notify.js';
import { log } from '@habiterall/shared/log.js';

const q = {
  status: db.prepare(`SELECT * FROM backup_status WHERE id = 1`),
  upsertStatus: db.prepare(`
    INSERT INTO backup_status (id, date, state, error, file, bytes, pruned, at)
    VALUES (1, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(id) DO UPDATE SET date   = excluded.date,
                                   state  = excluded.state,
                                   error  = excluded.error,
                                   file   = excluded.file,
                                   bytes  = excluded.bytes,
                                   pruned = excluded.pruned,
                                   at     = excluded.at
  `),
};

/** The default `HH:MM`, and its minutes-since-midnight, when nothing valid is set. */
const DEFAULT_SCHEDULE = '03:00';
const DEFAULT_SCHEDULE_MINUTES = 180;
const DEFAULT_KEEP = 7;
// `json` keeps phase one's reviewed default behaviour unchanged — this phase
// is purely additive.
const DEFAULT_FORMAT = 'json';

/**
 * Read the four operator variables. Every read is a LITERAL member
 * expression (`env.HABITERALL_BACKUP_DIR`, not a destructure or a computed
 * key) so `shared/test/compose.test.js`'s graph walker can see it.
 *
 * UNLIKE cloud's `backupConfig` (issue #75 second fix round), this function
 * still logs `backup.schedule_invalid` / `backup.keep_invalid` /
 * `backup.format_invalid` itself, as a side effect of being called — cloud's
 * was split into a pure classifier plus a separate `reportBackupConfig`
 * precisely because `GET /backup/status` calls it on every request, and any
 * ONE of N untrusted tenants opening the dialog could drive a warn line into
 * the operator's log at the read limiter's rate. That argument does not
 * transfer here: this edition has ONE account, and that account is the
 * operator, so a warn line it causes by mis-setting its own environment is
 * the operator reading about the operator's own typo. Do not "fix" this back
 * into cloud's shape without knowing which argument applied to which
 * edition. The one case that sharpens the asymmetry rather than closing it:
 * under `HABITERALL_AUTH=off` this route has nothing in front of it at all,
 * so a typo'd variable then lets anything reachable on the LAN — not just the
 * operator — drive warn lines into the log at the read limiter's rate, the
 * exact shape the split above exists to prevent in cloud. Still judged
 * acceptable here (see `habiterall-personal/CLAUDE.md`), but on purpose and
 * not by oversight.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{dir: string, schedule: string, scheduleMinutes: number,
 *   keep: number, enabled: boolean, format: 'json'|'db'|'both',
 *   formats: Array<'json'|'db'>}}
 */
export function backupConfig(env) {
  const dir = String(env.HABITERALL_BACKUP_DIR ?? '').trim();
  // Empty is the opt-in's absence — the feature is OFF, deliberately, so an
  // existing install sees no behaviour change on upgrade.
  const enabled = Boolean(dir);

  const rawSchedule = env.HABITERALL_BACKUP_SCHEDULE;
  const parsedSchedule = parseBackupSchedule(rawSchedule);
  // A schedule left UNSET is the ordinary default and says nothing wrong; a
  // schedule that was SET but does not parse is a typo, and that must not
  // silently disable the backups — nor pass in silence, or nobody learns the
  // value was never honoured.
  const scheduleWasSet = rawSchedule !== undefined && rawSchedule !== '';
  if (parsedSchedule === null && scheduleWasSet) {
    log.warn('backup.schedule_invalid', { value: rawSchedule, fallback: DEFAULT_SCHEDULE });
  }
  const schedule = parsedSchedule === null ? DEFAULT_SCHEDULE : String(rawSchedule);
  const scheduleMinutes = parsedSchedule === null ? DEFAULT_SCHEDULE_MINUTES : parsedSchedule;

  const rawKeep = env.HABITERALL_BACKUP_KEEP;
  const keepWasSet = rawKeep !== undefined && rawKeep !== '';
  const parsedKeep = Math.floor(Number(rawKeep));
  // `keep: 0` must never be honoured — it would mean deleting the file this
  // very run just wrote, on top of every other backup.
  const keepInvalid = !Number.isFinite(parsedKeep) || parsedKeep < 1;
  if (keepInvalid && keepWasSet) {
    log.warn('backup.keep_invalid', { value: rawKeep, fallback: DEFAULT_KEEP });
  }
  const keep = keepInvalid ? DEFAULT_KEEP : parsedKeep;

  const rawFormat = env.HABITERALL_BACKUP_FORMAT;
  const parsedFormat = parseBackupFormat(rawFormat);
  // Same division as the schedule and keep fallbacks above: unset says
  // nothing wrong, set-but-unparseable is a typo that must fall back rather
  // than silently disable the feature, and must not be silent either.
  const formatWasSet = rawFormat !== undefined && rawFormat !== '';
  if (parsedFormat === null && formatWasSet) {
    log.warn('backup.format_invalid', { value: rawFormat, fallback: DEFAULT_FORMAT });
  }
  const format = parsedFormat === null ? DEFAULT_FORMAT : parsedFormat;
  // The kinds this run WRITES. 'both' is JSON and `.db` together; retention
  // always covers both families regardless of this list — see `runBackup`.
  /** @type {Array<'json'|'db'>} */
  const formats = format === 'both' ? ['json', 'db'] : [format];

  return { dir, schedule, scheduleMinutes, keep, enabled, format, formats };
}

/**
 * A short classification of `err` that structurally CANNOT carry a
 * filesystem path — never `err.message`, never `String(err)`. A Node `fs`
 * error's `.message` embeds the path it operated on
 * (`ENOTDIR: not a directory, mkdir '/…'`), and `backup_status.error` is
 * exactly what `GET /api/backup/status` returns verbatim: the route's own
 * comment, the `backup_status` column comment in `db.js`, and the
 * "Scheduled backups" paragraph in this edition's `CLAUDE.md` all promise
 * that response never discloses the operator's `HABITERALL_BACKUP_DIR`, and
 * that route sits behind `requireAuth`, which is a no-op under
 * `HABITERALL_AUTH=off` — the very edition whose password is optional.
 *
 * The FULL error still reaches the server's own log exactly as before
 * (`log.error('backup.failed', { date }, err)`) — that is the operator's own
 * log, read by the operator alone, and it is where the detail belongs. What
 * is stored here is a CLASSIFICATION for the dialog, not a redaction of the
 * message: `code`+`syscall` (`ENOSPC (write)`), else `code` alone, else the
 * error's constructor name (`TypeError`), else the literal `'Error'`.
 */
function reportableError(err) {
  const code = typeof err?.code === 'string' && err.code ? err.code : '';
  const syscall = typeof err?.syscall === 'string' && err.syscall ? err.syscall : '';
  if (code && syscall) return `${code} (${syscall})`;
  if (code) return code;
  return err instanceof Error ? err.constructor.name : 'Error';
}

/** The `backup_status` row, shaped for `GET /api/backup/status`, or `null`. */
export function backupStatus() {
  const row = /** @type {any} */ (q.status.get());
  if (!row) return null;
  return {
    date: String(row.date),
    state: String(row.state),
    error: String(row.error ?? ''),
    file: String(row.file ?? ''),
    bytes: row.bytes == null ? null : Number(row.bytes),
    pruned: Number(row.pruned ?? 0),
    at: String(row.at ?? ''),
  };
}

/**
 * One backup run. Never throws — every failure path logs at `error`, records
 * `backup_status`, and returns normally so tomorrow's tick tries again; a
 * failed night must not permanently disable the feature.
 *
 * Writes every kind in `cfg.formats` ('json', or 'db', or both under
 * 'both'). A failure writing one kind does not stop the others being
 * attempted — whatever files DID land are kept and reported — but the run as
 * a whole is recorded as `'error'`; a partial success is still an honest
 * error state.
 *
 * @param {{dir: string, keep: number, formats: Array<'json'|'db'>}} cfg from
 *   `backupConfig`
 * @param {{payload: () => any, instant?: Date|number}} deps `payload` is the
 *   injected builder (`buildBackupPayload` from `api.js`, supplied by
 *   `server.js` — never imported here directly, see the file header).
 *   `instant` defaults to now; a test drives this directly with a chosen one.
 */
export async function runBackup(cfg, deps) {
  const { payload, instant = new Date() } = deps;
  // The empty zone is deliberate: this schedule is on the SERVER's own
  // clock, because it is the operator's job on the operator's machine.
  // `resolveTimeZone` answers where an ACCOUNT is, a different question —
  // folding the two together breaks one of them (root CLAUDE.md).
  const { date } = zonedClock(instant, '');

  try {
    mkdirSync(cfg.dir, { recursive: true });

    // Claim the day FIRST. This is the one write per run that makes the
    // dedupe crash-safe: a process killed mid-run leaves the row at
    // 'running', which is the honest report and is exactly what the
    // settings dialog shows as a problem rather than as silence.
    q.upsertStatus.run(date, 'running', '', '', null, 0);

    /** @type {Array<{name: string, bytes: number}>} */
    const written = [];
    let failure = null;

    for (const kind of cfg.formats) {
      const name = backupFileName(date, kind);
      const finalPath = join(cfg.dir, name);
      const tmpPath = `${finalPath}.tmp`;
      try {
        if (kind === 'db') {
          // VACUUM INTO REFUSES an output file that already exists (measured
          // — "output file already exists"), so a best-effort unlink of a
          // stale .tmp from a crashed previous run comes first, or one crash
          // permanently breaks every future .db snapshot.
          try { unlinkSync(tmpPath); } catch { /* no stale .tmp — fine */ }
          // The BOUND parameter, never string concatenation: the directory
          // is operator-controlled, and `VACUUM INTO '<path>'` built by
          // concatenation would make a quote in the path a SQL-injection
          // surface. This is not optional.
          db.prepare('VACUUM INTO ?').run(tmpPath);
          // Mode 0600, applied to the TEMPORARY file before the rename below
          // — never after — so the final file is never briefly
          // world-readable. SQLite creates the file itself, so unlike the
          // JSON branch this cannot be passed at creation time: this
          // snapshot holds the password hash and the session secret
          // (root CLAUDE.md's fidelity note on this format), and a typical
          // umask would otherwise leave it 0644.
          chmodSync(tmpPath, 0o600);
        } else {
          const body = JSON.stringify(payload(), null, 2);
          // Mode 0600 at creation time (fix round, issue #75): this file
          // is stored "like the database itself", per the README, and the
          // code should not be looser than that sentence — `writeFileSync`'s
          // default mode (0666, so typically 0644 under an ordinary umask)
          // would leave it group/world-readable.
          writeFileSync(tmpPath, body, { mode: 0o600 });
        }
        // Atomic: rename onto the final name is one filesystem operation, so
        // a reader never observes a truncated file. A crash between the
        // write and the rename leaves only the .tmp, which is what "no
        // partial left behind" (step 5) checks for after a clean run.
        renameSync(tmpPath, finalPath);
        written.push({ name, bytes: statSync(finalPath).size });
      } catch (err) {
        try { unlinkSync(tmpPath); } catch { /* best effort */ }
        log.error('backup.write_failed', { date, kind }, err);
        failure = failure ?? err;
      }
    }

    // Prune ALWAYS covers both personal families ('json' and 'db'), never
    // just `cfg.formats` — an operator who switches `both` -> `json` must
    // not leave `.db` files unmanaged forever. Never 'sql': that family is
    // cloud's, and a personal instance must not delete it.
    let pruned;
    try {
      const names = readdirSync(cfg.dir);
      pruned = prunableBackups(names, cfg.keep,
        { except: written.map((w) => w.name), kinds: ['json', 'db'] });
      for (const name of pruned) unlinkSync(join(cfg.dir, name));
    } catch (err) {
      // Whatever DID land above stays — only the STATE says error, because a
      // volume quietly filling up from a failed prune is exactly the
      // failure that must be loud.
      const fileList = written.map((w) => w.name).join(', ');
      const totalBytes = written.length ? written.reduce((sum, w) => sum + w.bytes, 0) : null;
      log.error('backup.prune_failed', { date, file: fileList }, err);
      q.upsertStatus.run(date, 'error', reportableError(err), fileList, totalBytes, 0);
      return;
    }

    if (pruned.length) {
      // Names and dates only, per the README's rule on what a log may hold.
      // `files` is joined into one string rather than left as an array:
      // `scalar()` (shared/src/log.js) collapses any array to `[N items]`,
      // which is why `count` already carries the number and this field
      // exists at all — an unjoined array here logged no names, ever.
      log.info('backup.pruned', { date, count: pruned.length, files: pruned.join(', ') });
    }

    // `file` is every basename this run wrote, comma-joined when there is
    // more than one (format: 'both'); `bytes` is the TOTAL across them.
    const fileList = written.map((w) => w.name).join(', ');
    const totalBytes = written.length ? written.reduce((sum, w) => sum + w.bytes, 0) : null;

    if (failure) {
      // A partial success (one kind landed, the other did not) is still an
      // honest 'error' state — the files that DID land are kept and named.
      q.upsertStatus.run(date, 'error', reportableError(failure), fileList, totalBytes, pruned.length);
      return;
    }

    q.upsertStatus.run(date, 'ok', '', fileList, totalBytes, pruned.length);
    log.info('backup.ok', { date, file: fileList, bytes: totalBytes, pruned: pruned.length });
  } catch (err) {
    // Every other failure path lands here — mkdir or the claim write: log at
    // error, record the row, and return normally rather than let it
    // propagate.
    log.error('backup.failed', { date }, err);
    try {
      q.upsertStatus.run(date, 'error', reportableError(err), '', null, 0);
    } catch (inner) {
      // Recording the failure must not itself be the thing that throws.
      log.error('backup.status_write_failed', { date }, inner);
    }
  }
}

/**
 * The periodic job `notifier.js` hooks onto the one tick that already runs —
 * never a `setInterval` of its own. `null` when `HABITERALL_BACKUP_DIR` is
 * unset, so `server.js` never registers a hook for a disabled feature.
 *
 * Cheap on the 1,439 ticks a day that do nothing: read the one status row,
 * ask `dueBackup`, return.
 *
 * `deps.payload` is required whenever `cfg.enabled` — the function returns
 * `null` before it is ever needed otherwise — but is typed optional here (and
 * defaulted to `{}`) so a caller checking only the disabled case need not
 * supply one, matching case 6 of the integration suite.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{payload?: () => any}} [deps] forwarded to `runBackup` verbatim,
 *   plus the tick's own `instant`.
 * @returns {((instant: Date|number) => Promise<void>) | null}
 */
export function backupTask(env = process.env, deps = {}) {
  const cfg = backupConfig(env);
  if (!cfg.enabled) return null;

  return async (instant) => {
    const row = backupStatus();
    const { date, minutes } = zonedClock(instant, '');
    const due = dueBackup({
      date, minutes, scheduleMinutes: cfg.scheduleMinutes, lastRunDate: row?.date ?? '',
    });
    if (!due) return;
    await runBackup(cfg, /** @type {{payload: () => any, instant: Date|number}} */
      ({ ...deps, instant }));
  };
}
