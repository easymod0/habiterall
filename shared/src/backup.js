/**
 * The pure schedule and retention math for the scheduled JSON backup
 * (issue #75, personal edition only — see `habiterall-personal/CLAUDE.md`).
 *
 * This module touches no filesystem and no `process.env`: reading the
 * environment and writing files belong to `habiterall-personal/src/backup.js`.
 * Staying free of `process.env` matters for a second reason beyond the usual
 * "shared is pure" rule — `shared/test/compose.test.js` walks the module
 * import graph from each edition's ENTRY POINT, so an env read placed here
 * could later be dragged into cloud's graph too and start demanding these
 * personal-only variables in cloud's compose files.
 */

import { minutesOfDay } from './notify.js';

/**
 * `'HH:MM'` on the local clock -> minutes since local midnight, or `null`
 * when `raw` is not exactly that shape. This is `minutesOfDay` (`notify.js`,
 * itself built on `TIME_RE` in `constants.js`) under a name that reads at the
 * call site — the repo has exactly one schedule format ('HH:MM' reminders)
 * and this reuses it rather than writing a third parser for the same shape.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseBackupSchedule(raw) {
  return minutesOfDay(/** @type {any} */ (raw));
}

/** The filename prefix every backup this module writes starts with. */
export const BACKUP_FILE_PREFIX = 'habiterall-backup-';

/**
 * The strict, anchored shape of a generated backup filename. Used both to
 * BUILD one (`backupFileName`) and, in `prunableBackups`, to decide which
 * files in a directory are this module's to manage — it must not match a
 * `<name>.tmp` partial (`runBackup` writes one while the export is still
 * being serialised) or some unrelated `.json` file a user or another tool
 * left in the same directory. Matching either would turn retention into a
 * directory wipe rather than a policy.
 */
export const BACKUP_FILE_RE = /^habiterall-backup-(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * The filename for a backup dated `date` ('YYYY-MM-DD').
 *
 * @param {string} date
 * @returns {string}
 */
export function backupFileName(date) {
  return `${BACKUP_FILE_PREFIX}${date}.json`;
}

/**
 * Whether a scheduled backup is due right now.
 *
 * True exactly when `scheduleMinutes` is a number, the clock has reached it
 * (`minutes >= scheduleMinutes`), and today has not already run
 * (`lastRunDate !== date`).
 *
 * `>=` rather than `>` is what lets a server restarted at 05:00 against a
 * 03:00 schedule catch up the day it missed, instead of skipping straight to
 * tomorrow. `lastRunDate !== date` is the dedupe that stops a second run
 * later the same day, and is the whole reason the caller stores the date the
 * run BEGAN rather than the date of the last attempt
 * (`habiterall-personal/src/backup.js`): this only ever needs to know
 * whether TODAY has run, never the exact minute it happened at. It never
 * looks at yesterday — one run per local day, today's only.
 *
 * `scheduleMinutes: null` (an unparseable schedule, already reported by the
 * caller) is always false, before either of the other two are asked.
 *
 * @param {{date: string, minutes: number, scheduleMinutes: number|null, lastRunDate: string}} clock
 * @returns {boolean}
 */
export function dueBackup({ date, minutes, scheduleMinutes, lastRunDate }) {
  if (typeof scheduleMinutes !== 'number') return false;
  return minutes >= scheduleMinutes && lastRunDate !== date;
}

/**
 * Which of `names` a retention pass should delete, oldest first.
 *
 * `names` is filtered by `BACKUP_FILE_RE` FIRST — anything this module did
 * not generate is never a candidate, which is the difference between a
 * retention policy and a directory wipe. What is left is sorted by the
 * captured date (lexicographic on `YYYY-MM-DD` is chronological), the newest
 * `keep` are kept, and the rest are returned.
 *
 * `except`, when given, is never returned even if the date-based arithmetic
 * says so — it names the file THIS run just wrote, so a run can never delete
 * its own output. The filter is applied unconditionally, as the very last
 * step, which is also what keeps the guarantee true when `keep` itself is
 * bad input: a `keep` below 1, or non-finite, is a caller error the caller
 * (`backupConfig` in the personal edition) has already normalised away, but
 * `except` is still honoured regardless of what `keep` says.
 *
 * @param {string[]} names
 * @param {number} keep
 * @param {{except?: string}} [opts]
 * @returns {string[]}
 */
export function prunableBackups(names, keep, { except } = {}) {
  const dated = names
    .map((name) => {
      const m = BACKUP_FILE_RE.exec(name);
      return m ? { name, date: m[1] } : null;
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const cut = Math.max(0, dated.length - keep);
  return dated.slice(0, cut).map((entry) => entry.name).filter((name) => name !== except);
}
