/**
 * What the next tap on a day records.
 *
 * DOM-free and dependency-free so it can be unit tested, for the same reason
 * `ui/time.js` is: the Kotlin `Grid.nextState` is a deliberate mirror of this
 * function, `test/toggle.test.js` and `GridTest` are pinned to the same
 * examples, and two clients that disagree about what a tap means is
 * indistinguishable from one of them being broken.
 *
 * The cycle is Loop's, read from its source rather than guessed
 * (`Entry.nextToggleValue` in uhabits-core):
 *
 *   YES_AUTO   -> YES_MANUAL
 *   YES_MANUAL -> if (isSkipEnabled) SKIP else NO
 *   SKIP       -> NO
 *   NO         -> if (areQuestionMarksEnabled) UNKNOWN else YES_MANUAL
 *   UNKNOWN    -> YES_MANUAL
 *
 * Two consequences worth knowing before changing either setting's default.
 *
 * With question marks OFF there is no way back to `unknown` from the grid: once
 * a day has been touched it is yes or no forever, and clearing it means opening
 * the day editor. That is Loop's behaviour and it is deliberate here — a day you
 * have answered "no" and a day you have not answered look identical while the
 * setting is off, so a cycle step between them would be a tap that appears to do
 * nothing at all.
 *
 * `YES_AUTO` has no habiterall state. Loop writes it to fill in the days a
 * non-daily habit did not need, and the importer turns it into a plain YES; it
 * can therefore be reached from storage but never from a tap.
 */

/**
 * @typedef {'unknown'|'done'|'skip'|'no'} DayState
 *
 * `unknown` is the absence of a row, `no` is a row holding 0 — see the note in
 * shared/src/constants.js for why those are two states and not one.
 */

/**
 * The three wire values, declared here rather than imported.
 *
 * This module is dependency-free on purpose — that is what lets
 * `test/toggle.test.js` run it with no browser and no module resolution, and
 * the absolute `/shared/...` specifiers the rest of `public/ui` uses do not
 * resolve under Node. `ui/values.js` declares them for the same reason one
 * level up (`shared/src` is not served to the browser), and
 * `test/toggle.test.js` pins these against it so the third copy cannot drift.
 */
const UNSET = 0, YES = 2, SKIP = 3;

/** @type {Readonly<Record<string, DayState>>} */
export const DAY = Object.freeze({
  UNKNOWN: 'unknown',
  DONE: 'done',
  SKIP: 'skip',
  NO: 'no',
});

/**
 * The state a tap moves a day into.
 *
 * @param {DayState} current
 * @param {{skipDays?: boolean, questionMarks?: boolean}} [prefs]
 * @returns {DayState}
 */
export function nextDayState(current, prefs = {}) {
  const { skipDays = false, questionMarks = false } = prefs;

  switch (current) {
    case DAY.DONE:
      return skipDays ? DAY.SKIP : DAY.NO;
    case DAY.SKIP:
      // Straight to `no`, even with skips switched off mid-history: the day is
      // already a skip, and a tap has to take it somewhere.
      return DAY.NO;
    case DAY.NO:
      return questionMarks ? DAY.UNKNOWN : DAY.DONE;
    default:
      // `unknown`, and anything unrecognised. A tap on a day nothing is known
      // about means "I did it" in every configuration.
      return DAY.DONE;
  }
}

/**
 * Which state a day is in, from what the API reported for it.
 *
 * `value` is `undefined` for a day with no row, which is the whole point: the
 * caller must pass what the entries map actually held rather than defaulting a
 * missing day to 0, or every unanswered day reads as an answered "no".
 *
 * @param {{value?: number|null, isSkip?: boolean, done?: boolean}} day
 * @returns {DayState}
 */
export function dayStateOf({ value, isSkip = false, done = false }) {
  if (isSkip) return DAY.SKIP;
  if (value === undefined || value === null) return DAY.UNKNOWN;
  return done ? DAY.DONE : DAY.NO;
}

/**
 * Is this habit shown as something to avoid?
 *
 * All THREE questions, and the third was missing. `show_as` is a rendering
 * choice that only means anything for a MEASURABLE habit with an at-most
 * target: "at least 8 glasses" has nothing to avoid, and a yes/no habit has no
 * amount for a limit to bound. A habit keeps its `show_as` when its type or
 * goal is switched — deliberately, so switching back does not lose it — which
 * is why the predicate and not the stored value is what stops it applying in
 * between, and why leaving a question out of it is a trap rather than an
 * omission.
 *
 * Asking only two put a habit somewhere it could not leave. Create a
 * measurable at-most habit, choose "something to avoid", then switch it to
 * Yes / no and save: the form submits `show_as` regardless, so the stored
 * habit is boolean + at_most + avoid. `valueForState` then encoded a tap
 * meaning DONE as 0 — and `isCompleted` reads 0 on a boolean habit as NOT
 * done, so the day painted as a slip, the next tap recomputed the same state,
 * and no sequence of taps could ever mark the day done.
 */
export function isAvoided(habit) {
  return habit?.show_as === 'avoid'
    && habit?.target_type === 'at_most'
    && habit?.type === 'numerical';
}

/**
 * What a tap records, for this habit and this state.
 *
 * The cycle above is untouched by any of this, and that is the point. A habit
 * you are trying not to do walks the same four states in the same order — a
 * clean day is `done`, a slip is `no` — so the mirrored `nextDayState` did not
 * have to learn anything. What differs is only the ENCODING, which is per
 * habit and lives here:
 *
 *   state    normal habit        avoided habit
 *   done     YES                 0            "none today", which is the goal
 *   no       UNSET (0)           target + 1   the smallest amount that fails
 *
 * `target + 1` rather than a fixed 1, so a limit of two coffees records three
 * — the smallest count that is over. It is the least the app can claim on the
 * user's behalf; the day editor still takes the exact number for anyone who
 * wants to record it.
 *
 * `unknown` is absent from the table because it is not a value: it is the
 * absence of a row, and the caller deletes rather than writing. `skip` is the
 * status column and never a value at all — see constants.js.
 *
 * @param {{type?: string, target_type?: string, target_value?: number,
 *   show_as?: string}} habit
 * @param {DayState} state
 * @returns {number} the value to store
 */
export function valueForState(habit, state) {
  // A skip is NOT a value and must never be written as one. `parseEntry` reads
  // the SKIP sentinel as a skip only for a BOOLEAN habit, because a measurable
  // one may legitimately record 3 — so returning it here stored a numerical
  // habit's skip as three of the thing. On a habit shown as something to avoid
  // that is three cigarettes, counted as a real miss, and the skip step of the
  // cycle became unreachable. The Kotlin mirror never had this: it routes
  // SKIPPED to a status write before the encoding is reached, and so does the
  // day editor. Loud rather than silent, because a caller that gets here has a
  // bug that is invisible in the grid.
  if (state === DAY.SKIP) {
    throw new Error('a skip is the status column, not a value — write {status: "skip"}');
  }

  if (isAvoided(habit)) {
    const target = Number(habit.target_value) || 0;
    return state === DAY.DONE ? UNSET : target + 1;
  }

  return state === DAY.DONE ? YES : UNSET;
}
