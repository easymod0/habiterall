/**
 * The scheduled JSON backup, personal edition (issue #75).
 *
 * This is the storage/filesystem/environment half; the pure schedule and
 * retention math lives in `@habiterall/shared/backup.js` and is imported
 * from there rather than re-derived.
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
  mkdirSync, writeFileSync, readdirSync, renameSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { db } from './db.js';
import {
  parseBackupSchedule, backupFileName, dueBackup, prunableBackups,
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

/**
 * Read the three operator variables. Every read is a LITERAL member
 * expression (`env.HABITERALL_BACKUP_DIR`, not a destructure or a computed
 * key) so `shared/test/compose.test.js`'s graph walker can see it.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{dir: string, schedule: string, scheduleMinutes: number,
 *   keep: number, enabled: boolean}}
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

  return { dir, schedule, scheduleMinutes, keep, enabled };
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
 * @param {{dir: string, keep: number}} cfg from `backupConfig`
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
  const file = backupFileName(date);

  try {
    mkdirSync(cfg.dir, { recursive: true });

    // Claim the day FIRST. This is the one write per run that makes the
    // dedupe crash-safe: a process killed mid-run leaves the row at
    // 'running', which is the honest report and is exactly what the
    // settings dialog shows as a problem rather than as silence.
    q.upsertStatus.run(date, 'running', '', '', null, 0);

    const finalPath = join(cfg.dir, file);
    const tmpPath = `${finalPath}.tmp`;
    let bytes;
    try {
      const body = JSON.stringify(payload(), null, 2);
      bytes = Buffer.byteLength(body);
      writeFileSync(tmpPath, body);
      // Atomic: rename onto the final name is one filesystem operation, so a
      // reader never observes a truncated file. A crash between the write
      // and the rename leaves only the .tmp, which is what "no partial left
      // behind" (step 5) checks for after a clean run.
      renameSync(tmpPath, finalPath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* best effort */ }
      throw err;
    }

    let pruned;
    try {
      const names = readdirSync(cfg.dir);
      pruned = prunableBackups(names, cfg.keep, { except: file });
      for (const name of pruned) unlinkSync(join(cfg.dir, name));
    } catch (err) {
      // The write above already succeeded and the file this run wrote stays
      // — only the STATE says error, because a volume quietly filling up
      // from a failed prune is exactly the failure that must be loud.
      log.error('backup.prune_failed', { date, file }, err);
      q.upsertStatus.run(date, 'error', String(err?.message ?? err), file, bytes, 0);
      return;
    }

    if (pruned.length) {
      // Names and dates only, per the README's rule on what a log may hold.
      log.info('backup.pruned', { date, count: pruned.length, files: pruned });
    }
    q.upsertStatus.run(date, 'ok', '', file, bytes, pruned.length);
    log.info('backup.ok', { date, file, bytes, pruned: pruned.length });
  } catch (err) {
    // Every other failure path lands here — mkdir, the claim write, or
    // serialising/writing the payload: log at error, record the row, and
    // return normally rather than let it propagate.
    log.error('backup.failed', { date }, err);
    try {
      q.upsertStatus.run(date, 'error', String(err?.message ?? err), '', null, 0);
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
