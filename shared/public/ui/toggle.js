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
