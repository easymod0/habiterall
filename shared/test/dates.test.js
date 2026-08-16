import test from 'node:test';
import assert from 'node:assert/strict';

const {
  formatDateLong, formatDateShort, fromISOLocal, iso, monthLabels, weekdayLetters,
} = await import('../public/ui/dates.js');

/**
 * The presentation helpers, and the one way they can go wrong quietly.
 *
 * These replaced two hardcoded English arrays — one in `ui/dashboard.js`, one in
 * `charts.js` — with `Intl`, and the arrays were indexed by `getDay()` and
 * `getMonth()`. So the risk the swap introduces is not the WORDS, which are the
 * platform's; it is the INDEX. A reference week starting on the wrong day
 * rotates every weekday caption in the app by one, which is the failure
 * `weekcheck.mjs` exists for and which reads as deliberate rather than broken.
 *
 * Asserted against the same `Date` the callers pass, rather than against
 * literals: the strings depend on the runtime's locale and pinning them here
 * would make this suite say "en-US" when what it means is "the right day".
 */

test('the weekday letters are indexed by getDay(), Sunday first', () => {
  const letters = weekdayLetters();
  assert.equal(letters.length, 7);

  // A month with a known shape: 2026-01-04 is a Sunday.
  for (let i = 0; i < 7; i++) {
    const day = new Date(2026, 0, 4 + i);
    assert.equal(day.getDay(), i, 'the reference week itself must start on Sunday');
    assert.equal(
      letters[day.getDay()],
      new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(day),
      `index ${i} does not name the day getDay() calls ${i}`);
  }
});

test('the month labels are indexed by getMonth(), January first', () => {
  const months = monthLabels();
  assert.equal(months.length, 12);

  for (let m = 0; m < 12; m++) {
    const day = new Date(2026, m, 15);      // mid-month, so no rollover
    assert.equal(
      months[day.getMonth()],
      new Intl.DateTimeFormat(undefined, { month: 'short' }).format(day),
      `index ${m} does not name the month getMonth() calls ${m}`);
  }
});

test('a date is formatted from its LOCAL parts, not shifted through UTC', () => {
  // The trap `fromISOLocal` exists for, one layer up: a formatter handed a date
  // built with `new Date('2026-01-01')` shows 31 December for anyone west of
  // Greenwich. Both helpers take a `Date`, and the callers build it with
  // `fromISOLocal`, so this pins the pairing rather than the formatter.
  for (const date of ['2026-01-01', '2026-06-15', '2026-12-31']) {
    const d = fromISOLocal(date);
    assert.equal(iso(d), date, 'round trip');
    const short = formatDateShort(d);
    const long = formatDateLong(d);
    const dayOfMonth = String(d.getDate());
    assert.ok(short.includes(dayOfMonth), `${short} does not contain ${dayOfMonth}`);
    assert.ok(long.includes(dayOfMonth), `${long} does not contain ${dayOfMonth}`);
    assert.ok(short.includes('2026'), short);
  }
});

test('the formatters are built once, not per call', () => {
  // The grid header asks for a weekday per column on every paint, and
  // `Intl.DateTimeFormat` is not cheap. Identity is the observable part of the
  // memo: a fresh array every call would also mean a fresh formatter.
  assert.equal(weekdayLetters(), weekdayLetters());
  assert.equal(monthLabels(), monthLabels());
});
