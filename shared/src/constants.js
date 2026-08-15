/**
 * Wire-level constants shared by both editions.
 *
 * Entry value sentinels mirror Loop Habit Tracker's encoding. SKIP is a
 * wire/API value only — it is never stored in `entries.value`, because a
 * numerical habit may legitimately record the amount 3. Skips live in the
 * `status` column instead.
 *
 * FOUR states, and the fourth is the one that is easy to miss:
 *
 *   done     a row, value YES (or an amount that meets the target)
 *   skip     a row, `status = 'skip'` — "not applicable", see above
 *   no       a row, value UNSET. A lapse the user stated.
 *   unknown  NO ROW AT ALL. Nothing is known about the day.
 *
 * `no` and `unknown` are both "not done" for every figure computed here, with
 * ONE exception that used to be a bug: on an **at-most** habit zero is under
 * the limit, so a stated `no` is a genuine success and an unanswered day is not
 * an answer at all. `atMostUnlogged` is the account's word on what silence is
 * worth there, and `unansweredCounts` in stats.js is the rule. Everywhere else
 * `isCompleted` says `false` for both and nothing about scores, streaks or
 * resilience turns on the difference. What turns on it is what the app can SAY:
 * Loop's
 * `pref_unknown_enabled` ("Show question marks for missing data") exists to
 * differentiate a day you marked as missed from a day you never answered, and
 * that distinction has to be storable before it can be shown. Which is why
 * UNSET now writes a row rather than deleting one: `DELETE` is how a day goes
 * back to unknown. See `entryWrite` in validate.js, the one rule that decides.
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
