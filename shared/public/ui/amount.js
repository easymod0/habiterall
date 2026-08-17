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
 * on the phone has a comment about the same input — and note it is NOT a mirror
 * of this and does not try to be: it reads a habit's TARGET where this reads a
 * DAY's amount. Be exact about where they part, because "not a mirror" is easy
 * to say too strongly. They agree about the FORM: the same thousands refusal
 * since #111, the same digits-and-at-most-one-separator shape, the same refusal
 * of a sign, an exponent or hex. They part at the DOMAIN, and only there — this
 * one bounds and quantises to what `formatAmount` can show back, so
 * `3.14159265` is 3.141593 here and itself there; that one answers to no
 * display and needs neither.
 *
 * The web's own target box is the gap that leaves. `index.html`'s
 * `target_value` is still an `<input type="number">` — the very control this
 * comment opens by measuring — so `8,5` typed into a habit's goal is still 85.
 * That is issue #156 and not this module's to fix from here.
 *
 * **The server imports this**, which is the one thing here with a cost. A
 * Discord modal is a box somebody types an amount into, arriving over a socket
 * rather than off a keyboard, and `shared/src/discord.js` had its own reading
 * of one until it read "10,000" as ten. Nothing in `shared/public` may import
 * from `shared/src` — the browser cannot see it — but node can read this, so
 * the rule is imported rather than mirrored. What that costs is the first line
 * of this file: "DOM-free" was a convenience for the tests and is now a
 * CONTRACT with a server. A `document` reached for anywhere in here takes the
 * reminder path down with it.
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
  //
  // A non-zero integer part is required, so this fires on a real group and not
  // on "0,255" or ",255", where no thousands can precede the comma. Three
  // digits is what makes it a group; "8,5" and "0,25" were never ambiguous.
  //
  // **The same ambiguity spelled with a DOT is not closed, and cannot be here.**
  // `10.000` is ten, and to a de-DE or es-ES reader it is ten thousand — but
  // `0.500` and `1.250` are ordinary decimals people type, and refusing
  // `\.\d{3}` to catch the other reading would break far more than it fixed. A
  // dot is the spelling this field itself writes (`formatAmount`) and shows
  // (the placeholder), so it gets the benefit of the doubt. Closing that
  // properly needs a locale, not a regex.
  if (THOUSANDS.test(text)) return null;

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

  // Quantised to what `formatAmount` can show. Without this the domain is
  // shared only at the ends: `3.14159265` was accepted whole, displayed as
  // `3.141593` on the next open, and saved as that — a value changing behind a
  // Save nobody meant to change anything with. Six places is far beyond what a
  // habit records.
  return Number(value.toFixed(6));
}

/**
 * The range an amount may take, chosen so `parseAmount` and `formatAmount`
 * have the same domain — see the bounds check above for what goes wrong when
 * they do not.
 */
export const MAX_AMOUNT = 1e12;
export const MIN_AMOUNT = 1e-6;

/**
 * "10,000" and "1,500", but not "0,255" or ",255" — see `parseAmount`, which
 * is the only place the reasoning is written down.
 *
 * ONE declaration, read by the parser and by `amountComplaint`, exactly as the
 * Kotlin `THOUSANDS` is. Written twice it drifts: dropping the `(?!\d)` from
 * the complaint's copy alone offered separator advice about "10,0000", which
 * the parser reads as 10 — telling somebody to change an entry that was going
 * to be stored correctly. That is now unrepresentable rather than tested for.
 * No `g` flag, deliberately: a shared regex with one is stateful across calls.
 */
const THOUSANDS = /[1-9]\d*,\d{3}(?!\d)/;

/**
 * Why `parseAmount` refused, for somebody looking at the box.
 *
 * "Not an amount" is true of `eight` and unhelpful for `10,000`, which IS a
 * number and a perfectly reasonable thing to type — it is refused because it is
 * AMBIGUOUS, not because it is nonsense, and a refusal the user cannot act on is
 * only half better than the silent ten it replaced. They typed their step goal
 * the way their phone's keyboard and their own country write it, and were told
 * it was not a number.
 *
 * The ADVICE agrees with the Kotlin `amountComplaint`'s — both say to type it
 * without the thousands separator, and about `10,000`, which is the input the
 * test uses, both name 10000 — and a test reads that string out of
 * `HabitFormScreen.kt` rather than trusting this comment, because two clients
 * telling somebody to type different things about the same input is a
 * difference with nothing behind it. It is agreement and not identity: the
 * phone has no room to quote what was typed and this box does, so the sentences
 * differ and the test checks the actionable core rather than the wording.
 *
 * Note the two parsers are NOT mirrors — see this module's header — so what is
 * pinned here is narrower than it looks: they happen to answer the same way
 * about a thousands group, and this makes them SAY the same thing about it.
 * Nothing about the rest of their domains is claimed.
 *
 * The predicate is `THOUSANDS`, the parser's own and not a copy of it, so a
 * complaint about a case the parser ACCEPTS cannot be written — it would tell
 * somebody to change an entry that was going to be stored correctly.
 *
 * **What is quoted must be true of what was quoted.** The first version of this
 * named the two readings — *could be ten thousand or ten and a half* — beside
 * whatever the user had typed, so "1,500" was told it might be ten thousand.
 * That is the module's own example of the ambiguity (`parseAmount` says
 * fifteen hundred or one and a half, correctly, forty lines up) with the wrong
 * number attached to it. Naming the reading is what made it specific and is
 * what made it false, so the sentence names the AMBIGUITY, which is the same
 * whatever the digits are, and the ADVICE carries the specifics instead.
 *
 * That advice is the user's own number with the commas taken out, because
 * "like 10000" is an example where "like 1500" is an instruction. Which makes
 * the suggestion something that can itself be wrong, so it is RUN THROUGH THE
 * PARSER before it is offered — and that decides the whole branch, not just the
 * number in it: `1,500 steps` holds a thousands group and is not ambiguous, it
 * is not an amount, and telling somebody to drop a comma that is not their
 * problem sends them round the loop again. A box may not suggest something it
 * would refuse. So the group is necessary and the suggestion working is what
 * makes it sufficient.
 *
 * @param {string} raw exactly what is in the box
 * @returns {string} a sentence to show
 */
export function amountComplaint(raw) {
  const text = String(raw ?? '').trim();
  const plain = text.replace(/,/g, '');
  return THOUSANDS.test(text) && typeof parseAmount(plain) === 'number'
    ? `"${text}" is ambiguous — a comma can separate thousands or stand for a `
      + `decimal point. Type it without the thousands separator, like ${plain}.`
    : `"${text}" is not an amount — type a number like 8 or 8.5.`;
}

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
  const shown = Number(value.toFixed(6));

  // Never render a real amount as nothing. `parseAmount` bounds what can be
  // TYPED, and that is not a bound on what can arrive: neither `parseEntry`
  // nor the habit's target is bounded server-side, so an import, the phone or
  // an older client can store a value smaller than this can show. As "0" it
  // would be rewritten into a stated lapse by the next Save; as its raw self
  // it is refused by `parseAmount`, and being refused is loud.
  if (shown === 0 && value !== 0) return String(value);
  return String(shown);
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
