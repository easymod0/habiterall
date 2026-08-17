import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { parseAmount, stepFor, formatAmount, stepAmount, amountComplaint } =
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

/* ---------- what verifying the fix caught in the fix ---------- */

test('a thousands group needs thousands in front of it', () => {
  // The first cut refused any comma followed by three digits, which took
  // "0,255" and ",255" with it — a nought-point-two-five-five that no reader
  // could mistake for a group, since nothing precedes the comma to be counted
  // in thousands. Refusing is loud, so it cost no data, but it refused a form
  // the rule was never aimed at.
  assert.equal(parseAmount('0,255'), 0.255);
  assert.equal(parseAmount(',255'), 0.255);
  assert.equal(parseAmount('0,500'), 0.5);
  // And still refuses the real thing.
  for (const raw of ['10,000', '1,500', '100,000', '12,345']) {
    assert.equal(parseAmount(raw), null, `${raw} is a group and must be refused`);
  }
});

test('an accepted amount survives being shown and read back — every accepted amount', () => {
  // The bounds alone made this true only at the ENDS. In the middle,
  // `3.14159265` was accepted whole and displayed as `3.141593`, so opening a
  // day and pressing Save changed the stored value without anyone asking for a
  // change. The parser quantises to what the box can show, so the two agree
  // everywhere rather than in the range the first test happened to sample.
  const cases = [
    '3.14159265', '0.1234567', '0.00000149', '999999999999.9',
    '1000000000000', '0.000001', '0', '8.5', '0.1', '20',
  ];
  for (const raw of cases) {
    const value = parseAmount(raw);
    assert.notEqual(value, null, `${raw} should be an amount`);
    assert.equal(parseAmount(formatAmount(value)), value,
      `${raw} does not survive the box (shown as ${formatAmount(value)})`);
  }
});

test('an amount too small to show is never shown as nothing', () => {
  // `parseAmount` bounds what can be TYPED and that is no bound on what can
  // ARRIVE: neither `parseEntry` nor a habit's target is bounded server-side,
  // so an import or an older client can store one. Rendered as "0" it would be
  // rewritten into a stated lapse by the next Save. Rendered as itself it is
  // refused, and refused is loud.
  assert.notEqual(formatAmount(5e-7), '0');
  assert.equal(parseAmount(formatAmount(5e-7)), null);
  // Zero itself is still zero — a real answer, and not the case above.
  assert.equal(formatAmount(0), '0');
  assert.equal(parseAmount('0'), 0);
});

/* ---------- and saying WHY it was refused ---------- */

test('a refusal about an ambiguous number says how to fix it', () => {
  // The whole point of refusing "10,000" is that it is a real number somebody
  // meant something by. Telling them it is "not an amount" is true of "eight"
  // and useless here, and it is what they get for typing their step goal the
  // way their own country writes it.
  const ambiguous = amountComplaint('10,000');
  assert.match(ambiguous, /10000/, 'it has to say what to type instead');
  assert.doesNotMatch(ambiguous, /not an amount/,
    'the generic sentence is the one this exists to replace');

  // ...and nonsense still gets the generic sentence, because there is nothing
  // more specific to say about it.
  assert.match(amountComplaint('eight'), /not an amount/);
});

test('the complaint says nothing about the quoted text that is untrue of it', () => {
  // The sentence used to name the readings — "could be ten thousand or ten and
  // a half" — beside whatever had been typed, so somebody entering 1,500 was
  // told it might be ten thousand. The ambiguity is what is the same for every
  // input; the numbers are not, and naming them is what made it false.
  for (const raw of ['1,500', '2,000', '10,000.5']) {
    assert.doesNotMatch(amountComplaint(raw), /ten thousand|ten and a half/,
      `${raw} is not ten thousand and must not be told that it might be`);
  }
});

test('the complaint offers an example the box would accept', () => {
  // "like 10000" is an example; "like 1500" is an instruction, and it is the
  // user's own number. Which makes the suggestion itself something that can be
  // wrong — so it is run through the parser before being offered, and an input
  // whose de-comma'd form would be refused again is not this case at all.
  assert.match(amountComplaint('1,500'), /like 1500\./);
  assert.match(amountComplaint('1,000.5'), /like 1000\.5\./);

  // De-comma'd, this is "1500 steps" — still not an amount, so the comma was
  // never the problem and the whole branch is wrong for it. It gets the generic
  // sentence: a box may not suggest something it would then refuse.
  assert.match(amountComplaint('1,500 steps'), /not an amount/);

  // The property behind the three examples, over every ambiguous input the
  // suite knows: whatever is offered, typing it works.
  for (const raw of ['10,000', '1,500', '2,000', '10,000.5', '1,000,000']) {
    const offered = /like ([^ ]+)\.$/.exec(amountComplaint(raw));
    assert.ok(offered, `${raw} was given no example to follow`);
    assert.equal(typeof parseAmount(offered[1]), 'number',
      `${raw} was told to type "${offered[1]}", which this box refuses`);
  }
});

test('the complaint and the parser agree about which case is which', () => {
  // A complaint about a case the parser ACCEPTS is worse than a generic one:
  // it tells somebody to change an entry that was going to be stored correctly.
  // `THOUSANDS` is one declaration read by both, so that is unrepresentable
  // rather than merely untrue today — this pins the BEHAVIOUR either way, over
  // the examples the Kotlin `amountComplaint` uses too.
  const separator = ['10,000', '1,500', '10,000.5', '  2,000  '];
  // '10,0000' is the one that pins the lookahead: four digits after the comma
  // is not a thousands group, `parseAmount` reads it as 10, and a complaint
  // that offered separator advice about it would be telling somebody to change
  // an entry that was going to be stored correctly.
  const notSeparator = ['8,5', '0,255', ',255', '0.500', '10.000', '8', '',
    '10,0000'];

  for (const raw of separator) {
    assert.equal(parseAmount(raw), null, `${raw} should be refused`);
    assert.match(amountComplaint(raw), /without the thousands separator/,
      `${raw} is the ambiguous case and should be told so`);
  }
  for (const raw of notSeparator) {
    assert.doesNotMatch(amountComplaint(raw), /without the thousands separator/,
      `${raw} is not a thousands group, so that advice is wrong for it`);
  }
});

test('a thousands group is refused however it is dressed', () => {
  // The predicate is anchored, which is what makes it linear (below) — and the
  // anchors are only safe because everything the loose form also caught is
  // refused one line later by the decimal test. These are the four shapes that
  // argument turns on, so they are pinned rather than reasoned about.
  assert.equal(parseAmount('10,000'), null);
  assert.equal(parseAmount('12,345,678'), null, 'more than one group');
  assert.equal(parseAmount('10,000.5'), null, 'a group and a decimal point');
  // The `0*` clause. Without it "01,000" is not a group, and "01.000" IS a
  // number to the decimal test — so a leading zero would buy a silent 1 where
  // ten thousand was meant.
  assert.equal(parseAmount('01,000'), null, 'a leading zero is still a group');

  // And all four are still told what to type, because the complaint asks the
  // parser rather than the anchored predicate.
  for (const raw of ['10,000', '12,345,678', '10,000.5', '01,000']) {
    assert.match(amountComplaint(raw), /without the thousands separator/, raw);
  }
});

test('a long string of digits is not a way to spend the event loop', () => {
  // `src/discord.js` hands this a modal field off a socket, so the parser reads
  // remote input now and its cost has to be bounded. Unanchored — which is what
  // this was, and what the Kotlin still is on input that never leaves the phone
  // — `[1-9]\d*,\d{3}(?!\d)` is quadratic on digits with no comma among them:
  // measured at 2.6ms for 2,000 characters, 42ms for 8,000 and 655ms for
  // 32,000, which extrapolates to ~6s here. CodeQL called it js/polynomial-redos
  // on exactly that path. The bound is loose because CI machines vary; the two
  // implementations are four orders of magnitude apart, so it does not need to
  // be tight to be decisive.
  const hostile = '1'.repeat(100_000);
  const started = performance.now();
  assert.equal(parseAmount(hostile), null);
  assert.ok(performance.now() - started < 2000,
    'the thousands test has stopped being linear');
});

test('a dot group is still given the benefit of the doubt', () => {
  // Pinned so that closing #108's remaining half is a deliberate change to a
  // failing test rather than something that quietly starts happening. `10.000`
  // is ten here, and to a de-DE reader it is ten thousand — but `0.500` and
  // `1.250` are ordinary decimals, and a dot is the spelling this field itself
  // writes. Whoever adds a locale changes this test on purpose.
  assert.equal(parseAmount('10.000'), 10);
  assert.equal(parseAmount('1.500'), 1.5);
  assert.equal(parseAmount('0.500'), 0.5);
});

test('the advice is the phone\'s advice, read from the phone', () => {
  // The two clients refuse a thousands group identically — they are not mirrors
  // and agree only about the form, which is exactly the part this is about — so
  // one of them explaining better than the other is a difference with nothing
  // behind it. Read out of the source rather than restated, the way
  // `toggle.test.js` reads its own declaration: a comment claiming the two
  // agree is exactly the thing that goes stale.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const kotlin = readFileSync(join(root, 'android-native', 'app', 'src', 'main',
    'java', 'com', 'habiterall', 'app', 'ui', 'HabitFormScreen.kt'), 'utf8');

  const advice = /"(Type it without the thousands separator[^"]*)"/.exec(kotlin);
  assert.ok(advice, 'the Kotlin complaint has moved or been reworded');

  // The actionable core, not the whole sentence: the phone has no room to quote
  // what was typed and the web does, which is house style rather than a rule.
  assert.match(advice[1], /without the thousands separator/);
  // Digit-bounded on both sides. Matched loosely, `/10000/` is satisfied by
  // "100000" — so an edit to the example number leaves this green while the two
  // clients tell somebody to type different numbers, which is the exact
  // divergence this test exists for.
  assert.match(advice[1], /(?<!\d)10000(?!\d)/);

  const web = amountComplaint('10,000');
  assert.match(web, /without the thousands separator/,
    'the web says something different from the phone about the same input');
  assert.match(web, /(?<!\d)10000(?!\d)/);
});
