/**
 * Entry value sentinels, mirroring Loop Habit Tracker's encoding.
 *
 * SKIP is a wire/API value only — it is never stored in `entries.value`,
 * because a numerical habit may legitimately record the amount 3. Skips live
 * in the `status` column instead.
 */
export const UNSET = 0;
export const YES = 2;
export const SKIP = 3;
