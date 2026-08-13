/**
 * Wire-level constants shared by both editions.
 *
 * Entry value sentinels mirror Loop Habit Tracker's encoding. SKIP is a
 * wire/API value only — it is never stored in `entries.value`, because a
 * numerical habit may legitimately record the amount 3. Skips live in the
 * `status` column instead.
 */
export const UNSET = 0;
export const YES = 2;
export const SKIP = 3;

/**
 * 24-hour local wall time, e.g. '08:30'. Empty means "no reminder".
 *
 * It lives here rather than in validate.js because notify.js also needs it,
 * and validate.js imports notify.js for the settings rules — putting the
 * regex in either of those two makes the pair circular. validate.js
 * re-exports it, so every existing importer is unaffected.
 */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
