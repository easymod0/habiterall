/**
 * The `habitSort` setting: the enumeration, the normaliser, and the comparator
 * that reorders a habit-payload array for `/overview`.
 *
 * This is deliberately the ONLY place that decides how to sort. Both editions'
 * `/overview` call `sortHabitPayloads` over the same setting, so the two
 * clients agree BY CONSTRUCTION rather than by both remembering to send the
 * same `?sort=` parameter (see `shared/CLAUDE.md` and the brief for issue
 * #200 for the full reasoning). Nothing here reaches a database or the DOM —
 * this module is pure, so it can be imported by `shared/src` callers in both
 * editions without pulling in storage or HTTP.
 */

/**
 * The five values `habitSort` may hold. `'manual'` is the default and is
 * identity — the incoming order IS the order, so nothing here computes
 * anything for it. Note the `'recently missed'` spelling has a SPACE; it is
 * not `'recentlyMissed'`, and `SETTING_VALUES.habitSort` and
 * `shared/public/ui/settings.js` must all spell it the same way.
 */
export const HABIT_SORTS = Object.freeze([
  'manual', 'name', 'strength', 'streak', 'recently missed',
]);

/**
 * Normalise anything not in `HABIT_SORTS` to `'manual'`, rather than throwing.
 * A stored value can outlive the code that wrote it — an older client, or a
 * hand-edited settings row — and a 500 on the dashboard is a worse failure
 * than silently falling back to the order the account always had. Both
 * editions call this and neither writes a second normaliser.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function resolveHabitSort(raw) {
  return HABIT_SORTS.includes(/** @type {any} */ (raw)) ? /** @type {string} */ (raw) : 'manual';
}

/**
 * Whether a sort needs the last-miss date `sortHabitPayloads` cannot derive
 * from the payload alone. Only `'recently missed'` does; every other sort
 * reads a field already on the payload (`name`, `score`, `currentStreak`) or
 * is identity. Callers use this to skip the extra `computeMissRuns` pass
 * (`summaryStats`'s `lastMiss` option) on every request but the one that asks
 * for it — which is almost every request, since `manual` is the default.
 *
 * @param {string} sort
 * @returns {boolean}
 */
export function needsLastMiss(sort) {
  return sort === 'recently missed';
}

/**
 * Order habit payloads for display. Returns a NEW array and never mutates
 * `payloads` — both editions build `categorySummaries` from the same,
 * UNSORTED array (before or after calling this makes no difference, and that
 * is the property that matters: an aggregate must not depend on display
 * order), so a caller must not be able to change that aggregate by handing it
 * a reordered list. `[...payloads].sort(...)` rather than `payloads.sort(...)`
 * is what keeps that true.
 *
 * Every arm is a PARTIAL comparator that returns `0` on a tie, relying on
 * `Array.prototype.sort` being a STABLE sort (guaranteed by ECMA-262 since
 * ES2019). Do not "fix" a `0` return into an `id` tiebreak — the incoming
 * order is already `ORDER BY position, id`, which is a better fallback than
 * `id` alone, and a stable sort preserves it for every tied pair for free.
 *
 * @param {any[]} payloads
 * @param {string} sort one of `HABIT_SORTS`; anything else is identity
 * @param {Map<number, string|null>} [lastMiss] habit id -> the end of its
 *   most recent miss run, or `null`/absent if it has none in the window.
 *   Deliberately NOT a field on the `/overview` response — it is an input to
 *   a server-side ordering decision that no client reads, so adding it to the
 *   payload would be API surface with no consumer.
 * @returns {any[]}
 */
export function sortHabitPayloads(payloads, sort, lastMiss = new Map()) {
  switch (sort) {
    case 'name':
      // Pinned to the 'en' locale explicitly. A bare `localeCompare()` reads
      // the SERVER's locale, so the two editions — or one edition on two
      // hosts — would order the same account's list differently, which is
      // the drift class this repo names most often. `foldCategoryName` is
      // NOT reused here even though it also normalises a name: it folds for
      // EQUALITY (a duplicate-name check), collapsing case and a handful of
      // Unicode edge cases to test whether two strings are the SAME name.
      // This needs an ORDER, which `localeCompare`'s locale-aware collation
      // gives and a fold does not.
      return [...payloads].sort((a, b) =>
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }));

    case 'strength':
      // Descending — strongest first.
      return [...payloads].sort((a, b) => b.score - a.score);

    case 'streak':
      // Descending — longest current streak first.
      return [...payloads].sort((a, b) => b.currentStreak - a.currentStreak);

    case 'recently missed': {
      // Most recent miss FIRST. A habit with no miss in the window
      // (`null`/absent from `lastMiss`) sorts LAST — and "no miss" and "missed
      // longer ago than the window reaches" are the same answer here, on
      // purpose: the window is the 400-day summary slice
      // (`SCORE_WARMUP_DAYS`), so a habit that last missed 500 days ago sorts
      // as never-missed. That is a real limitation, not an oversight, and it
      // is accepted rather than hidden — a wider window would cost every
      // ordinary request to serve the rare account with a five-year-old
      // habit.
      const missOf = (p) => lastMiss.get(p.id) ?? null;
      return [...payloads].sort((a, b) => {
        const ma = missOf(a);
        const mb = missOf(b);
        if (ma === null && mb === null) return 0;
        if (ma === null) return 1;
        if (mb === null) return -1;
        return mb < ma ? -1 : mb > ma ? 1 : 0;
      });
    }

    case 'manual':
    default:
      // `manual`, and anything unrecognised, is identity — a value stored by
      // a newer version, or a hand-edited row, must not 500 the dashboard.
      // `resolveHabitSort` is meant to have already normalised `sort` before
      // it reaches here, but this arm makes the function safe even if a
      // caller skips that step.
      return [...payloads];
  }
}
