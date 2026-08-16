/**
 * Reading and stepping an amount, DOM-free so it can be tested without one.
 *
 * The counterpart of `ui/time.js`: the rules live here and `ui/count-field.js`
 * is the control over them, exactly as `ui/reminder-field.js` sits over the
 * time rules. That split is what makes these testable at all.
 *
 * Why a parser rather than `<input type="number">`, which is what both places
 * that record an amount used to be. Measured in Chrome, typing into one with
 * the day editor's own attributes:
 *
 *   typed "8,5"   -> .value "85"     eight and a half recorded as eighty-five
 *   typed "abc"   -> .value ""       read as "no entry" — the day is DELETED
 *   typed "1e3"   -> .value "1e3"    Number() reads 1000
 *
 * The browser filters the keystrokes it does not like and hands back whatever
 * survived, so an unparseable amount is never an error to report — it is a
 * different amount, or nothing. The decimal comma is the one that matters: it
 * is what most of Europe's keyboards invite, `inputmode="decimal"` shows it,
 * and dropping it multiplies the answer by ten. `HabitFormScreen.parseAmount`
 * on the phone has a comment about the same input for the same reason.
 */

/**
 * The amount in a box, or what is wrong with it.
 *
 * Three answers, and callers must tell them apart with `===` because two of
 * them are falsy — the same convention (and the same trap) as `parseTimeInput`:
 *
 *   `''`    the box is empty. That is "nothing is known about this day", which
 *           for a caller is a DELETE. It is NOT the amount zero.
 *   `null`  something was typed and it is not an amount. Say so; write nothing.
 *   number  a non-negative amount. `0` is a real answer — a stated lapse — and
 *           is why the two above cannot be collapsed into one falsy check.
 *
 * A comma is read as a decimal point, matching the phone. A form that mixes
 * both — `1,000.5` — is refused rather than guessed at: it means one thing to
 * a reader who writes thousands with commas and another to one who writes
 * decimals with them, and this is not the place to decide which they are.
 *
 * The regex is deliberately stricter than `Number()`, which the root CLAUDE.md
 * already records as too generous about form: it reads `0x10` as 16 and `1e3`
 * as 1000. Neither is a thing anyone types into a box asking how many glasses
 * of water they drank.
 *
 * @param {string} raw
 * @returns {'' | null | number}
 */
export function parseAmount(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '';

  // A comma group that reads as a thousands separator is REFUSED, not guessed.
  // Reading it as a decimal point is how "10,000 steps" — this module's own
  // example habit — became ten: a thousandfold under-record, silent, and worse
  // than the bug this parser exists to fix. It is genuinely ambiguous, since
  // "1,500" is fifteen hundred to one reader and one and a half to another, and
  // that is exactly the case the mixed form below is already refused for.
  // Three digits is what makes it a group; "8,5" and "0,25" are unambiguous
  // decimals and still work.
  if (/,\d{3}(?!\d)/.test(text)) return null;

  const decimal = text.replace(/,/g, '.');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(decimal)) return null;

  const value = Number(decimal);
  if (!Number.isFinite(value) || value < 0) return null;

  // Bounded at both ends so that everything this accepts is something
  // `formatAmount` can show back faithfully. Without it the two disagree at the
  // extremes and the control ends up displaying a value its own `value()`
  // refuses: `String()` goes exponential at 1e21 and this parser rejects an
  // exponent, and anything under half a millionth formats to "0" — which the
  // next Save would rewrite into a stated lapse. A trillion is past any amount
  // a habit records.
  if (value > MAX_AMOUNT) return null;
  if (value > 0 && value < MIN_AMOUNT) return null;

  return value;
}

/**
 * The range an amount may take, chosen so `parseAmount` and `formatAmount`
 * have the same domain — see the bounds check above for what goes wrong when
 * they do not.
 */
export const MAX_AMOUNT = 1e12;
export const MIN_AMOUNT = 1e-6;

/**
 * How much one press of − or + should move, for a habit with this target.
 *
 * A spinner that steps by 1 is right for "8 glasses" and useless for "10,000
 * steps" — which is the complaint `<input type="number">`'s arrows earned. So
 * the step comes from the goal: about an eighth of it, snapped to a number a
 * person would have chosen.
 *
 * Snapped rather than computed, because `target / 8` is 1250 for 10,000 steps
 * and nobody counts in 1250s. The ladder is the set of round numbers, and the
 * answer is the largest one that does not overshoot an eighth of the target.
 *
 * A habit with no target — 0, which `parseHabit` accepts — gets 1. There is
 * nothing to derive from, and 1 is the step the field had before any of this.
 *
 * @param {number} target
 * @returns {number}
 */
export function stepFor(target) {
  const goal = Number(target);
  if (!Number.isFinite(goal) || goal <= 0) return 1;

  const ladder = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  // A whole-number goal gets a whole-number step. Below a target of 8 an eighth
  // is a fraction, so "3 glasses" stepped to 3.25 glasses — an amount in a unit
  // that does not divide. The goal's own form is the honest signal for that:
  // half a kilometre is a real thing to record, a quarter of a glass is not.
  const floor = Number.isInteger(goal) ? 1 : ladder[0];
  const wanted = goal / 8;

  let step = floor;
  for (const rung of ladder) if (rung <= wanted && rung >= floor) step = rung;
  return step;
}

/**
 * An amount as a person would write it: `3`, not `3.0`.
 *
 * Floating point is why this is not `String(n)` — stepping 0.1 up from 0.2
 * lands on 0.30000000000000004, and a box that shows that has stopped being a
 * count. Rounded to a sane number of places and then trimmed, which also makes
 * the arrows idempotent: pressing + then − returns the value it started on.
 *
 * @param {number} n
 * @returns {string}
 */
export function formatAmount(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '';
  // Six places is far beyond anything a habit records and well inside the
  // precision that survives a round trip through the database.
  return String(Number(value.toFixed(6)));
}

/**
 * Move an amount by one step, never below zero.
 *
 * The floor is not a validation rule borrowed from the server — it is what the
 * control can offer. An amount is non-negative (`parseEntry` refuses the rest),
 * so a − that walks into a value the server would reject is a button that
 * produces an error, and zero is a real answer to stop at: a stated lapse.
 *
 * @param {number|''|null} current what `parseAmount` said about the box
 * @param {number} step
 * @param {1|-1} direction
 * @param {number} target used only when the box holds nothing to step from
 * @returns {number}
 */
export function stepAmount(current, step, direction, target = 0) {
  // Nothing usable in the box: the first press offers the goal rather than
  // stepping from zero, since that is nearly always what is about to be
  // recorded — the same reason the phone's count dialog prefills the target.
  if (typeof current !== 'number') {
    const goal = Number(target);
    if (direction > 0 && Number.isFinite(goal) && goal > 0) return goal;
    return direction > 0 ? step : 0;
  }
  return Math.max(0, Number((current + step * direction).toFixed(6)));
}
