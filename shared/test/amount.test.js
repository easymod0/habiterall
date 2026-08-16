import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseAmount, stepFor, formatAmount, stepAmount } =
  await import('../public/ui/amount.js');

/* ---------- reading what was typed ---------- */

test('an empty box and an unreadable one are different answers', () => {
  // Both falsy, and they mean opposite things: one is "nothing is known about
  // this day" (a DELETE) and the other is "you typed something I cannot use"
  // (write nothing, say so). Collapsing them is how the day editor came to
  // delete a recorded amount when someone typed a decimal comma.
  assert.equal(parseAmount(''), '');
  assert.equal(parseAmount('   '), '');
  assert.equal(parseAmount(null), '');
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('8 glasses'), null);
});

test('zero is an amount, not an absence', () => {
  // A row holding 0 is a stated lapse — one of the four day states — so this
  // must be the number and not the empty answer above.
  assert.equal(parseAmount('0'), 0);
  assert.equal(parseAmount('0.0'), 0);
});

test('a comma is a decimal point, as it is on the phone', () => {
  // `inputmode="decimal"` shows whatever separator the keyboard's locale uses,
  // which across most of Europe is a comma. `<input type="number">` silently
  // DROPPED it — measured: typing "8,5" left "85" in the box — so eight and a
  // half was recorded as eighty-five. HabitFormScreen.parseAmount on Android
  // has the same rule for the same reason.
  assert.equal(parseAmount('8,5'), 8.5);
  assert.equal(parseAmount('0,25'), 0.25);
});

test('a form that mixes both separators is refused, not guessed', () => {
  // "1,000.5" means a thousand and a half to one reader and nothing sensible
  // to another. Refusing says so; picking one silently records the wrong
  // amount, which is the failure this whole field exists to end.
  assert.equal(parseAmount('1,000.5'), null);
  assert.equal(parseAmount('1.000,5'), null);
});

test('the generosity of Number() is not inherited', () => {
  // The root CLAUDE.md records this class for the importer: `Number('0x10')`
  // is 16 and `Number('1e3')` is 1000. `<input type="number">` accepts `1e3`
  // and hands it straight to Number, so typing it recorded a thousand.
  for (const raw of ['0x10', '1e3', '1E3', 'Infinity', '0b11', '  +8']) {
    assert.equal(parseAmount(raw), null, `${raw} was read as a number`);
  }
});

test('a negative amount is refused here rather than at the server', () => {
  // `parseEntry` refuses it too, but a control that can produce a value its
  // own API rejects is a control that produces an error message instead of an
  // answer.
  assert.equal(parseAmount('-5'), null);
  assert.equal(parseAmount('-0.5'), null);
});

test('the forms people actually type are accepted', () => {
  assert.equal(parseAmount('8'), 8);
  assert.equal(parseAmount('8.5'), 8.5);
  assert.equal(parseAmount(' 8.5 '), 8.5);
  assert.equal(parseAmount('.5'), 0.5);
  assert.equal(parseAmount('8.'), 8);
  assert.equal(parseAmount('10000'), 10000);
});

/* ---------- the step ---------- */

test('the step comes from the goal, not from the number 1', () => {
  // The complaint the number input's arrows earned: stepping by 1 is right for
  // "8 glasses" and useless for "10,000 steps".
  assert.equal(stepFor(8), 1);
  assert.equal(stepFor(10000), 1000);
  assert.equal(stepFor(20), 2);
  assert.equal(stepFor(100), 10);
});

test('the step is a number a person would have chosen', () => {
  // Snapped to a ladder rather than computed: an eighth of 10,000 is 1250 and
  // nobody counts in 1250s.
  const ladder = new Set([0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]);
  for (const target of [1, 3, 8, 12, 20, 60, 99, 150, 2000, 10000, 86400]) {
    assert.ok(ladder.has(stepFor(target)), `${target} -> ${stepFor(target)} is off the ladder`);
  }
});

test('a habit with no target still steps', () => {
  // `parseHabit` accepts a target of 0, and there is nothing to derive from —
  // 1 is what the field had before any of this.
  for (const target of [0, -1, undefined, null, NaN, 'x']) {
    assert.equal(stepFor(target), 1, `${target} did not fall back to 1`);
  }
});

/* ---------- stepping ---------- */

test('the arrows never walk below zero', () => {
  // Zero is a real answer to stop at — a stated lapse — and a negative amount
  // is one the server refuses, so a button that produces one produces an error.
  assert.equal(stepAmount(1, 1, -1), 0);
  assert.equal(stepAmount(0, 1, -1), 0);
  assert.equal(stepAmount(0.5, 1, -1), 0);
});

test('the arrows are idempotent, which floating point does not give for free', () => {
  // 0.2 + 0.1 is 0.30000000000000004, and a box showing that has stopped being
  // a count. Up then down must return the value it started on.
  let v = 0.2;
  v = stepAmount(v, 0.1, 1);
  assert.equal(formatAmount(v), '0.3');
  v = stepAmount(v, 0.1, -1);
  assert.equal(formatAmount(v), '0.2');
});

test('the first press up offers the goal rather than one step', () => {
  // An empty box on a habit with a target of 8: "8" is nearly always what is
  // about to be recorded, which is why the phone's count dialog prefills it.
  assert.equal(stepAmount('', 1, 1, 8), 8);
  assert.equal(stepAmount(null, 1, 1, 8), 8);
  // With no goal to offer, one step.
  assert.equal(stepAmount('', 5, 1, 0), 5);
  // Down from nothing is zero, not the goal — pressing − must not put a
  // number UP on a day that has none.
  assert.equal(stepAmount('', 1, -1, 8), 0);
});

test('an amount is written the way a person writes it', () => {
  assert.equal(formatAmount(3), '3');
  assert.equal(formatAmount(3.0), '3');
  assert.equal(formatAmount(0.30000000000000004), '0.3');
  assert.equal(formatAmount(NaN), '');
});

/* ---------- what a review caught ---------- */

test('a thousands separator is refused, not read as a decimal point', () => {
  // The regression this parser nearly shipped, and it was worse than the bug
  // it fixes: "10,000" — this module's own example habit, 10,000 steps — read
  // as TEN. A thousandfold under-record, silent, and the old day editor got it
  // right (the browser stripped the comma to 10000) while the old grid refused
  // it loudly. It is genuinely ambiguous, which is the same reason the mixed
  // form below is refused: "1,500" is fifteen hundred to one reader and one and
  // a half to another.
  for (const raw of ['10,000', '1,500', '1,000', '12,345', '1,000,000']) {
    assert.equal(parseAmount(raw), null, `${raw} was guessed at rather than refused`);
  }
  // Three digits is what makes it a group. One or two are an unambiguous
  // decimal and must keep working, or the comma rule is useless.
  assert.equal(parseAmount('8,5'), 8.5);
  assert.equal(parseAmount('0,25'), 0.25);
  assert.equal(parseAmount('1,2345'), 1.2345);
});

test('everything accepted can be shown back faithfully', () => {
  // `parseAmount` and `formatAmount` must have one domain, or the control ends
  // up displaying a value its own `value()` refuses. `String()` goes
  // exponential at 1e21 and this parser rejects an exponent; anything under
  // half a millionth formats to "0", which the next Save would rewrite into a
  // stated lapse.
  for (const raw of ['1e21', '1000000000000000000000', '0.0000001']) {
    assert.equal(parseAmount(raw), null, `${raw} was accepted but cannot be shown`);
  }
  for (const raw of ['1000000000000', '0.000001', '0', '8.5']) {
    const value = parseAmount(raw);
    assert.notEqual(value, null, `${raw} should be an amount`);
    assert.equal(parseAmount(formatAmount(value)), value,
      `${raw} does not survive a round trip through the box`);
  }
});

test('a whole-number goal gets a whole-number step', () => {
  // An eighth of a target below 8 is a fraction, so "3 glasses" stepped to
  // 3.25 glasses — an amount in a unit that does not divide. The goal's own
  // form is the signal: half a kilometre is a real thing to record, a quarter
  // of a glass is not.
  for (const target of [1, 2, 3, 5, 8, 20, 100, 10000]) {
    assert.ok(Number.isInteger(stepFor(target)),
      `stepFor(${target}) = ${stepFor(target)} is fractional on a whole goal`);
  }
  // A fractional goal may still step in fractions.
  assert.ok(!Number.isInteger(stepFor(0.5)));
});
