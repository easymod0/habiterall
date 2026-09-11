/**
 * The pure schedule and retention math for the scheduled backup
 * (issue #75 — personal's JSON/`.db` snapshot and cloud's whole-database
 * `pg_dump`; see `habiterall-personal/CLAUDE.md` and `habiterall-cloud/CLAUDE.md`).
 *
 * This module touches no filesystem and no `process.env`: reading the
 * environment and writing files belong to each edition's own
 * `src/backup.js`. Staying free of `process.env` matters for a second reason
 * beyond the usual "shared is pure" rule — `shared/test/compose.test.js`
 * walks the module import graph from each edition's ENTRY POINT, so an env
 * read placed here could later be dragged into the other edition's graph and
 * start demanding variables that belong to only one of them.
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

/**
 * `HABITERALL_BACKUP_FORMAT` (personal only — cloud always writes a dump) ->
 * `'json' | 'db' | 'both'`, or `null` when `raw` is not one of those three,
 * trimmed and lower-cased. As with `parseBackupSchedule`, the CALLER decides
 * the fallback and the warning; this only answers whether the value parses.
 *
 * @param {unknown} raw
 * @returns {'json'|'db'|'both'|null}
 */
export function parseBackupFormat(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value === 'json' || value === 'db' || value === 'both' ? value : null;
}

/** The filename prefix every backup this module writes starts with. */
export const BACKUP_FILE_PREFIX = 'habiterall-backup-';

/**
 * The strict, anchored shape of a generated JSON backup filename. Used both
 * to BUILD one (`backupFileName`) and, in `prunableBackups`, to decide which
 * files in a directory are this module's to manage — it must not match a
 * `<name>.tmp` partial (`runBackup` writes one while the export is still
 * being serialised) or some unrelated `.json` file a user or another tool
 * left in the same directory. Matching either would turn retention into a
 * directory wipe rather than a policy.
 *
 * Kept exactly as phase one shipped it — reviewed, and pinned by this same
 * test file — rather than folded into a parameterised builder.
 */
export const BACKUP_FILE_RE = /^habiterall-backup-(\d{4}-\d{2}-\d{2})\.json$/;

/** The same anchored shape for personal's `VACUUM INTO` snapshot. */
export const BACKUP_DB_FILE_RE = /^habiterall-backup-(\d{4}-\d{2}-\d{2})\.db$/;

/** The same anchored shape for cloud's whole-database `pg_dump`. */
export const BACKUP_SQL_FILE_RE = /^habiterall-backup-(\d{4}-\d{2}-\d{2})\.sql$/;

/**
 * Every filename family this module manages, by kind. Each pattern stays
 * ANCHORED, and for the same reason as `BACKUP_FILE_RE` above: retention must
 * manage only files this module generated, and an anchored pattern per
 * extension is what keeps a `.tmp` partial, the live `habiterall.db`, its
 * `-wal` sidecar and any unrelated file structurally unmatchable. Do not
 * loosen an existing regex to cover a new extension — add a family instead.
 */
export const BACKUP_KINDS = Object.freeze({
  json: { ext: '.json', re: BACKUP_FILE_RE },
  db:   { ext: '.db',   re: BACKUP_DB_FILE_RE },
  sql:  { ext: '.sql',  re: BACKUP_SQL_FILE_RE },
});

/**
 * The filename for a backup dated `date` ('YYYY-MM-DD'), in the given
 * family. `kind` defaults to `'json'` so every phase-one call site keeps
 * working unchanged.
 *
 * @param {string} date
 * @param {'json'|'db'|'sql'} [kind]
 * @returns {string}
 */
export function backupFileName(date, kind = 'json') {
  return `${BACKUP_FILE_PREFIX}${date}${BACKUP_KINDS[kind].ext}`;
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
 * `kinds` is REQUIRED — the list of families this call is willing to manage.
 * There is no default: a default would be a guess about which families the
 * caller writes, and guessing wrong is a directory wipe. Each listed family
 * is filtered by its own `BACKUP_KINDS[kind].re` FIRST — anything this
 * module did not generate, or that belongs to a family not asked for, is
 * never a candidate — sorted by the captured date (lexicographic on
 * `YYYY-MM-DD` is chronological), and cut independently: the newest `keep`
 * of THAT family are kept and the rest are returned. `keep` is per family, so
 * `kinds: ['json', 'db']` with `keep: 7` leaves 7 JSON files and 7 `.db`
 * files, not 7 of either combined.
 *
 * `except` is a filename, or an array of filenames (a run can write more
 * than one), that is never returned even if the date-based arithmetic says
 * so — it names the file(s) THIS run just wrote, so a run can never delete
 * its own output. It is applied unconditionally, as the very last step,
 * which is also what keeps the guarantee true when `keep` itself is bad
 * input: a `keep` below 1, or non-finite, is a caller error the caller
 * (`backupConfig` in each edition) has already normalised away, but `except`
 * is still honoured regardless of what `keep` says.
 *
 * Return order: deletions oldest-first within a family, families in the
 * order given in `kinds`, so the result is deterministic and a caller (or a
 * test) can assert it exactly.
 *
 * @param {string[]} names
 * @param {number} keep
 * @param {{except?: string|string[], kinds: string[]}} opts
 * @returns {string[]}
 */
export function prunableBackups(names, keep, { except, kinds }) {
  // This function's wrong answer is a deletion, so an unusable `kinds` must
  // be a loud failure and never an implied default — the JSDoc type already
  // makes a missing `kinds` a `tsc --noEmit` error, but a type is checked
  // only where a caller is type-checked, and nothing stopped a runtime
  // default from going unnoticed by the rest of the suite. Both editions'
  // `runBackup` wrap every call here in a `try`/`catch` that records an
  // `'error'` status on any throw, so throwing is the safe direction: it
  // degrades to "retention did not run and said so", never to "retention ran
  // against a guess about which families this call is willing to manage".
  if (!Array.isArray(kinds) || kinds.length === 0) {
    throw new TypeError(
      `prunableBackups: 'kinds' must be a non-empty array of family names, got ${JSON.stringify(kinds)}`);
  }
  for (const kind of kinds) {
    if (!Object.hasOwn(BACKUP_KINDS, kind)) {
      throw new TypeError(`prunableBackups: 'kinds' names an unknown family: ${JSON.stringify(kind)}`);
    }
  }

  const exceptSet = new Set(
    except === undefined ? [] : Array.isArray(except) ? except : [except]);

  const doomed = [];
  for (const kind of kinds) {
    const family = BACKUP_KINDS[kind];
    const re = family.re;
    const dated = names
      .map((name) => {
        const m = re.exec(name);
        return m ? { name, date: m[1] } : null;
      })
      .filter((entry) => entry !== null)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const cut = Math.max(0, dated.length - keep);
    for (const entry of dated.slice(0, cut)) doomed.push(entry.name);
  }

  return doomed.filter((name) => !exceptSet.has(name));
}
