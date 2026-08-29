import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  computeStreaks, currentStreak, bestStreak, computeHistory,
  computeWeekdays, computeFrequency, computeScores, computeStats, summaryStats,
  computeCategoryStats, computeMissRuns, computeRecovery, SCORE_WARMUP_DAYS,
  summariseMembers, summariseByCategory,
  isCompleted, dateRange, boundedRange, addDays, daysBetween, toISO, fromISO, MAX_RANGE_DAYS,
} = await import('../src/stats.js');

const UNSET = 0, YES = 2, SKIP = 3;

const boolHabit = {
  type: 'boolean', target_value: 0, target_type: 'at_least',
  freq_numerator: 1, freq_denominator: 1,
};
const numHabit = {
  type: 'numerical', target_value: 8, target_type: 'at_least',
  freq_numerator: 1, freq_denominator: 1, unit: 'glasses',
};
const atMostHabit = {
  type: 'numerical', target_value: 5, target_type: 'at_most',
  freq_numerator: 1, freq_denominator: 1, unit: 'cigarettes',
};

// Two stated at-most days eight days apart, with five UNKNOWN days between
// them that `unlogged` reads oppositely — `success` credits them as under the
// limit, the default reads them as misses. Shared between the parity fixture
// list and the literal test pinning both readings, rather than inlined twice,
// so an edit made to "make the fixtures consistent" (swapping the habit for
// one where `unlogged` has nothing to read, say) invalidates both checks
// instead of only the parity one.
const unloggedSeparatesFixture = {
  habit: atMostHabit,
  entries: [
    { date: '2026-08-10', value: 2, status: '' },
    { date: '2026-08-18', value: 2, status: '' },
  ],
  end: '2026-08-18',
};

const map = (obj) => new Map(Object.entries(obj));

/* ---------- date helpers ---------- */

test('dateRange is inclusive of both ends', () => {
  assert.deepEqual(dateRange('2026-01-01', '2026-01-04'),
    ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
});

// These lists are asserted as literals, never against a second implementation
// of the walk (both would share the same bug), and they hold in every zone —
// which is what makes the timezones.test.js sweep of this same file safe.
test('dateRange across US spring forward', () => {
  assert.deepEqual(dateRange('2026-03-06', '2026-03-12'), [
    '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09',
    '2026-03-10', '2026-03-11', '2026-03-12',
  ]);
});

test('dateRange across US fall back', () => {
  // This is the one that bites: an epoch `+= 86400000` walk repeats a day
  // here under America/New_York, because the fall-back transition makes that
  // calendar day 25 hours long. `setDate` does not.
  assert.deepEqual(dateRange('2026-10-30', '2026-11-05'), [
    '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02',
    '2026-11-03', '2026-11-04', '2026-11-05',
  ]);
});

test('dateRange across Lord Howe\'s 30-minute DST transition', () => {
  assert.deepEqual(dateRange('2026-04-02', '2026-04-08'), [
    '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05',
    '2026-04-06', '2026-04-07', '2026-04-08',
  ]);
});

test('dateRange across a leap day', () => {
  assert.deepEqual(dateRange('2024-02-27', '2024-03-02'),
    ['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02']);
});

test('dateRange across a year boundary', () => {
  assert.deepEqual(dateRange('2026-12-30', '2027-01-02'),
    ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});

test('dateRange returns [] rather than throwing on an unreadable date', () => {
  // The first three make `daysBetween` answer NaN, and `NaN < 0` is false —
  // so a `n < 0` guard lets NaN reach `new Array(NaN + 1)`, which throws
  // RangeError where the old loop returned []. `!(n >= 0)` is false only for
  // a non-negative number, which is why it is written that way.
  assert.deepEqual(dateRange('', '2026-01-01'), []);
  assert.deepEqual(dateRange('garbage', '2026-01-01'), []);
  assert.deepEqual(dateRange('2026-01-01', 'nope'), []);
  // Not a NaN case, despite looking like one: `new Date(2026, 12, 99)` rolls
  // over to 2027-04-09 rather than failing, so this is an ordinary backwards
  // range (-463) caught by the same guard. Pinned because the rollover is the
  // surprise — an out-of-domain date does not stay out of domain.
  assert.deepEqual(dateRange('2026-13-99', '2026-01-01'), []);
});

test('dateRange normalises a start that is not a real calendar day', () => {
  // `assertDate` refuses these at every write path, so a range can only START
  // on one by reading it back out of storage — a row predating that guard, a
  // direct insert, or an import that went around it. `computeStats` takes
  // `from` as the earliest STORED entry whenever a caller names no window,
  // which is what makes this reachable rather than hypothetical.
  //
  // The walk used to push the string it was handed before normalising
  // anything, so the list opened on 2026-02-30 — a day that does not exist —
  // and then skipped 2026-03-02, the real day the rollover lands on. Building
  // the Date up front means every element is a day that happened. This is a
  // deliberate behaviour change, not a preserved one; see shared/CLAUDE.md.
  assert.deepEqual(dateRange('2026-02-30', '2026-03-05'),
    ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
});

test('dateRange spells every element exactly as toISO does', () => {
  // `dateRange` builds 'YYYY-MM-DD' itself — a month prefix cached across the
  // rollover, plus a two-digit lookup — rather than calling `toISO` per
  // element, because that walk is a quarter of an `/overview` request. That
  // makes it the one place in this file which spells a date without going
  // through `toISO`, and nothing else in the suite would notice the two
  // drifting apart: every other assertion here is a literal, so a `toISO`
  // that changed would break those and leave this agreeing with itself.
  //
  // The reference is the walk this replaced — `toISO` on a `setDate`-stepped
  // Date — so the comparison is against the previous implementation rather
  // than against a restatement of the new one.
  //
  // The span crosses two year boundaries and a leap February, and both ends
  // sit in single-digit months, which is where the padding is.
  const start = '2023-12-25', end = '2025-03-05';
  const cur = new Date(2023, 11, 25);
  const expected = [];
  for (let i = 0, n = daysBetween(start, end); i <= n; i++) {
    expected.push(toISO(cur));
    cur.setDate(cur.getDate() + 1);
  }

  assert.deepEqual(dateRange(start, end), expected);
  // The literal, so this cannot pass by comparing two empty lists.
  assert.equal(expected.length, 437);
  assert.equal(expected[0], '2023-12-25');
  assert.equal(expected.at(-1), '2025-03-05');
  assert.ok(expected.includes('2024-02-29'));
});

test('totalCompleted counts the same window the walked figures do, even when the earliest stored date is not a real day', () => {
  // `computeStats` takes `from` as the earliest STORED entry when no window is
  // named, and selects `totalCompleted` by STRING comparison against it while
  // every other figure comes from the walked list. So an un-normalised `from`
  // puts the two on different windows: '2026-02-30' >= '2026-02-30' is true and
  // counts the phantom row, while the walk starts on 2026-03-02 and never looks
  // that key up — a payload claiming a completion no other figure in it can
  // justify. Normalising `from` is what keeps them on one window.
  const habit = {
    type: 'boolean', target_value: 0, target_type: 'at_least',
    freq_numerator: 1, freq_denominator: 1,
  };
  const entries = [{ date: '2026-02-30', value: YES }, { date: '2026-03-04', value: YES }];
  const stats = computeStats(habit, entries, { end: '2026-03-05' });

  // The window walked, and the count, agree: the phantom day is in neither.
  assert.deepEqual(stats.history.map((h) => h.bucket),
    ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
  assert.equal(stats.totalCompleted, 1);
});

test('a range whose year predates 1000 is spelled with four digits at both ends', () => {
  // `dateRange` pads its own year, as `toISO` does, so every element of this
  // range is canonical and the past-end trim has a last element that compares
  // as the day it is. It used to write '100-03-05' where the range was asked
  // for '0100-03-05' — lexically ABOVE it, so a string-compared trim would
  // have popped every element and returned nothing, which is why that trim
  // goes through `daysBetween`. `boundedRange` clamps such a start long before
  // `dateRange` sees it, so the app cannot ask for this; it is pinned because
  // the whole stats model compares dates as strings and a range that spells
  // one of them short is a comparison that answers backwards.
  const days = dateRange('0100-02-25', '0100-03-05');
  // Nine days: year 100 is not a leap year under proleptic Gregorian, so its
  // February has 28.
  assert.equal(days.length, 9);
  assert.equal(days[0], '0100-02-25');
  assert.equal(days[days.length - 1], '0100-03-05');
});

test('every date this file spells is ten characters, year included', () => {
  // The whole stats model compares dates as strings — `from <= date <= end`,
  // `start < earliest`, `boundedRange`'s clamp — which is correct and cheap
  // only while every date is spelled 'YYYY-MM-DD'. An unpadded year is the one
  // way a real day can be spelled shorter: '999-12-31' sorts ABOVE '2016-...',
  // so a date a thousand years in the past reads as one in the future to every
  // comparison in the file.
  //
  // Asserted against literals rather than against a second implementation of
  // `toISO`, which would share whatever bug `toISO` has.
  assert.equal(toISO(fromISO('0999-12-31')), '0999-12-31');
  assert.equal(toISO(fromISO('0100-02-25')), '0100-02-25');
  assert.equal(addDays('0100-02-25', 1), '0100-02-26');
  assert.equal(addDays('1000-01-01', -1), '0999-12-31');

  // `dateRange` is the one place in stats.js that spells a date without
  // calling `toISO`, so it is asked separately: every element, not just the
  // ends the test above pins.
  for (const day of dateRange('0100-02-25', '0100-03-05')) {
    assert.equal(day.length, 10, `dateRange spelled '${day}'`);
  }
});

test('a stored entry dated year 0999 is clamped and reads as the day it is', () => {
  // What this covers NOW is the year padding and the two literals beneath it:
  // '0999-12-31' normalises to itself, so the entry stays a thousand years
  // before `earliest` and the window is the clamp's width rather than the one
  // day it collapsed to when `toISO` wrote '999-12-31' — lexically ABOVE
  // '2016-...' and so past the `earliest` clamp MAX_RANGE_DAYS is enforced by.
  // `assertDate` accepts this date (999 is a real year and does not roll over,
  // unlike 0050), so one `PUT /entries/0999-12-31` is all it took to reach it.
  //
  // What it no longer covers is the clamp/normalise ORDERING, and that is the
  // padding's doing: both orderings now answer '0999-12-31' identically,
  // because there is nothing left for the normalisation to change. The
  // '9999-99-99' fixture below is what pins the ordering — a date that ROLLS
  // OVER is the only kind that still can.
  const habit = {
    type: 'boolean', target_value: 0, target_type: 'at_least',
    freq_numerator: 1, freq_denominator: 1,
  };
  const entries = [
    { date: '0999-12-31', value: YES },
    { date: '2026-08-10', value: YES },
    { date: '2026-08-12', value: YES },
  ];
  const stats = computeStats(habit, entries, { end: '2026-08-18' });

  // The window is the clamp's width, not one day, and the two recent
  // completions are still counted.
  assert.equal(stats.history.length, MAX_RANGE_DAYS + 1);
  assert.equal(stats.totalCompleted, 2);
  assert.equal(stats.streaks.length, 2);
});

test('a stored entry of \'9999-99-99\' is clamped BEFORE it is normalised', () => {
  // The ordering `resolveWindow` says is "the whole safety of it", pinned by
  // the one shape that can still see it. Normalising is a ROLLOVER, and a
  // rollover moves the date by an amount nothing in `resolveWindow` bounds:
  // '9999-99-99' lands in year 10007, and '10007-...' sorts BELOW '2026-...'
  // however the year is padded, because it is a digit longer.
  //
  //   clamped first:    '9999-99-99' > end       -> from = end        (1 day)
  //   normalised first: '10007-06-07' < earliest -> from = earliest (3661 days)
  //
  // So one junk row opens the widest window MAX_RANGE_DAYS allows, on every
  // request, for a habit that has none of those days — 3660 day-steps per
  // aggregation pass, eight passes to a `/habits/:id/stats`.
  //
  // The junk row is this habit's ONLY row on purpose, and it is not a fixture
  // that could have been written any other way: `from` is `start ?? firstEntry`
  // and `firstEntry` is the lexical MIN of the entries, so a date whose year
  // field must reach 9999 to roll into five digits sorts ABOVE every real one
  // and is never the min while a real row exists beside it. A single
  // unparseable row is what an import that went around `assertDate` leaves.
  const habit = {
    type: 'boolean', target_value: 0, target_type: 'at_least',
    freq_numerator: 1, freq_denominator: 1,
  };
  const stats = computeStats(habit, [{ date: '9999-99-99', value: YES }],
    { end: '2026-08-18' });

  // Literals, and the window's first day rather than only its width: a length
  // of 1 is what several unrelated ways of being wrong also produce, while
  // '2026-08-18' names the clamp that was applied.
  assert.equal(stats.history.length, 1);
  assert.equal(stats.history[0].bucket, '2026-08-18');
  assert.equal(stats.scores.length, 1);
  assert.equal(stats.scores[0].date, '2026-08-18');
  // The phantom row is outside `[from, end]` under either ordering, so this is
  // not what discriminates — it is here because `totalCompleted` selects by
  // string comparison against `from` and is the one figure that would count it.
  assert.equal(stats.totalCompleted, 0);
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('daysBetween handles leap years', () => {
  assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2); // 2028 is a leap year
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
});

/* ---------- completion semantics ---------- */

test('boolean completion only counts YES', () => {
  assert.equal(isCompleted(boolHabit, YES), true);
  assert.equal(isCompleted(boolHabit, UNSET), false);
  assert.equal(isCompleted(boolHabit, SKIP), null);
});

test('numerical at_least completes at or above target', () => {
  assert.equal(isCompleted(numHabit, 8), true);
  assert.equal(isCompleted(numHabit, 9), true);
  assert.equal(isCompleted(numHabit, 7.9), false);
});

test('numerical at_most completes at or below target', () => {
  assert.equal(isCompleted(atMostHabit, 5), true);
  assert.equal(isCompleted(atMostHabit, 0), true);
  assert.equal(isCompleted(atMostHabit, 6), false);
});

test('a numerical value of 3 is a real amount, not a skip', () => {
  // Regression: skips used to be stored in-band as the value 3, so an
  // at-most habit recording 3 cigarettes was silently reclassified as a
  // skipped day — which bridged streaks instead of breaking them.
  const smoking = {
    type: 'numerical', target_value: 0, target_type: 'at_most',
    freq_numerator: 1, freq_denominator: 1,
  };

  assert.equal(isCompleted(smoking, { value: 3, status: '' }), false,
    '3 cigarettes against a target of 0 is a failure');
  assert.equal(isCompleted(smoking, { value: 0, status: 'skip' }), null,
    'an explicit skip is still not applicable');
  assert.equal(isCompleted(smoking, { value: 0, status: '' }), true);

  const entries = new Map([
    ['2026-07-01', { value: 0, status: '' }],       // success
    ['2026-07-02', { value: 3, status: '' }],       // failure — must break
    ['2026-07-03', { value: 0, status: '' }],       // success
    ['2026-07-04', { value: 0, status: 'skip' }],   // skip — must bridge
    ['2026-07-05', { value: 0, status: '' }],       // success
  ]);
  const streaks = computeStreaks(smoking, entries, '2026-07-01', '2026-07-05');

  assert.deepEqual(streaks.map((s) => s.length), [1, 3],
    'the 3-cigarette day breaks the run; the skip bridges it');
  assert.equal(streaks[1].start, '2026-07-03');
  assert.equal(streaks[1].end, '2026-07-05');
});

test('a boolean bare 3 is still honoured as a skip sentinel', () => {
  // Legacy callers and the wire format still use 3 for boolean skips.
  assert.equal(isCompleted(boolHabit, 3), null);
  assert.equal(isCompleted(boolHabit, SKIP), null);
});

/* ---------- streaks ---------- */

test('a contiguous run is one streak', () => {
  const entries = map({
    '2026-01-01': YES, '2026-01-02': YES, '2026-01-03': YES,
  });
  const streaks = computeStreaks(boolHabit, entries, '2026-01-01', '2026-01-03');
  assert.equal(streaks.length, 1);
  assert.equal(streaks[0].length, 3);
});

test('a missed day splits the streak in two', () => {
  const entries = map({
    '2026-01-01': YES, '2026-01-02': YES,
    '2026-01-03': UNSET,
    '2026-01-04': YES,
  });
  const streaks = computeStreaks(boolHabit, entries, '2026-01-01', '2026-01-04');
  assert.equal(streaks.length, 2);
  assert.deepEqual(streaks.map((s) => s.length), [2, 1]);
});

test('a skipped day bridges rather than breaks a streak', () => {
  const entries = map({
    '2026-01-01': YES, '2026-01-02': SKIP, '2026-01-03': YES,
  });
  const streaks = computeStreaks(boolHabit, entries, '2026-01-01', '2026-01-03');
  assert.equal(streaks.length, 1, 'skip should not break the run');
  assert.equal(streaks[0].length, 3, 'streak spans the skipped day');
});

test('currentStreak counts a run ending today or yesterday, else zero', () => {
  const run = [{ start: '2026-01-01', end: '2026-01-05', length: 5 }];
  assert.equal(currentStreak(run, '2026-01-05'), 5, 'ends today');
  assert.equal(currentStreak(run, '2026-01-06'), 5, 'ends yesterday, still live');
  assert.equal(currentStreak(run, '2026-01-07'), 0, 'two days stale, broken');
  assert.equal(currentStreak([], '2026-01-07'), 0);
});

test('bestStreak picks the longest run', () => {
  const streaks = [
    { length: 3 }, { length: 11 }, { length: 7 },
  ];
  assert.equal(bestStreak(streaks), 11);
  assert.equal(bestStreak([]), 0);
});

/* ---------- score ---------- */

test('score rises with consistency and stays within 0..1', () => {
  const entries = map(
    Object.fromEntries(dateRange('2026-01-01', '2026-03-31').map((d) => [d, YES]))
  );
  const scores = computeScores(boolHabit, entries, '2026-01-01', '2026-03-31');
  const final = scores[scores.length - 1].score;

  assert.ok(final > 0.8, `90 perfect days should build strength, got ${final}`);
  assert.ok(final <= 1, 'score must not exceed 1');
  for (const s of scores) {
    assert.ok(s.score >= 0 && s.score <= 1, `score out of range: ${s.score}`);
  }
});

test('the score uses Loop\'s decay constant, not a slower one', () => {
  // 0.5^(sqrt(frequency)/13) from uhabits' Score.kt — a 13-day half-life for
  // a daily habit. This was 0.5^(1/30) here for a while, which is faithful in
  // shape but far too sluggish: a perfect habit took four months to look
  // strong instead of one, and the number stopped feeling responsive.
  const entries = new Map();
  const d = new Date(2026, 0, 1);
  for (let i = 0; i < 90; i++) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    entries.set(iso, { value: 2, status: '' });
    d.setDate(d.getDate() + 1);
  }

  const scores = computeScores(boolHabit, entries, '2026-01-01', '2026-03-31');
  const at = (n) => scores[n - 1].score;

  // Half-life 13 days: a perfect habit is at 50% on day 13.
  assert.ok(Math.abs(at(13) - 0.5) < 0.01,
    `day 13 should be ~50%, got ${(at(13) * 100).toFixed(1)}%`);
  assert.ok(at(30) > 0.75,
    `a perfect month should exceed 75%, got ${(at(30) * 100).toFixed(1)}%`);
  assert.ok(at(60) > 0.94,
    `two perfect months should exceed 94%, got ${(at(60) * 100).toFixed(1)}%`);
});

test('a less frequent habit decays more slowly', () => {
  // Loop scales the exponent by sqrt(frequency), so a 3x/week habit has a
  // ~20-day half-life against a daily habit's 13. Missing one of three weekly
  // sessions should not sting as much as missing a day of a daily habit.
  const build = (freqNum, freqDen, doneOn) => {
    const entries = new Map();
    const d = new Date(2026, 0, 1);
    for (let i = 0; i < 60; i++) {
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (doneOn(d)) entries.set(iso, { value: 2, status: '' });
      d.setDate(d.getDate() + 1);
    }
    return computeScores(
      { ...boolHabit, freq_numerator: freqNum, freq_denominator: freqDen },
      entries, '2026-01-01', '2026-03-01'
    );
  };

  const daily = build(1, 1, () => true);
  const weekly3 = build(3, 7, (d) => [1, 3, 5].includes(d.getDay()));

  // Both are perfectly kept, so both climb — but the daily one climbs faster.
  const dayN = 30;
  assert.ok(daily[dayN].score > weekly3[dayN].score,
    `daily ${daily[dayN].score.toFixed(3)} should outpace 3x/week ${weekly3[dayN].score.toFixed(3)}`);

  // And both still converge: a habit held exactly at its target reaches full
  // strength whatever its frequency.
  assert.ok(weekly3[weekly3.length - 1].score > 0.85,
    `a perfectly-kept 3x/week habit should approach full strength, got ${weekly3[weekly3.length - 1].score}`);
});

test('score decays once the habit is abandoned', () => {
  const entries = map(
    Object.fromEntries(dateRange('2026-01-01', '2026-01-31').map((d) => [d, YES]))
  );
  const scores = computeScores(boolHabit, entries, '2026-01-01', '2026-03-31');

  const atPeak = scores.find((s) => s.date === '2026-01-31').score;
  const later = scores[scores.length - 1].score;
  assert.ok(later < atPeak, `score should decay: peak ${atPeak}, later ${later}`);
});

test('a habit held exactly at its target frequency scores high', () => {
  // 3x/week habit done every Mon/Wed/Fri for a year — this is perfect
  // adherence and must not be penalised for the four non-scheduled days.
  const gym = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const entries = new Map();
  for (const d of dateRange('2026-01-01', '2026-12-31')) {
    const dow = new Date(d + 'T12:00:00').getDay();
    if ([1, 3, 5].includes(dow)) entries.set(d, YES);
  }
  const scores = computeScores(gym, entries, '2026-01-01', '2026-12-31');
  const final = scores[scores.length - 1].score;
  assert.ok(final > 0.85,
    `on-target 3x/week habit should score high, got ${final}`);
});

test('daily and 3x/week habits at full adherence score comparably', () => {
  const daily = { ...boolHabit };
  const gym = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const range = dateRange('2026-01-01', '2026-12-31');

  const dailyEntries = new Map(range.map((d) => [d, YES]));
  const gymEntries = new Map();
  for (const d of range) {
    const dow = new Date(d + 'T12:00:00').getDay();
    if ([1, 3, 5].includes(dow)) gymEntries.set(d, YES);
  }

  const a = computeScores(daily, dailyEntries, '2026-01-01', '2026-12-31').at(-1).score;
  const b = computeScores(gym, gymEntries, '2026-01-01', '2026-12-31').at(-1).score;
  assert.ok(Math.abs(a - b) < 0.2,
    `full adherence should score similarly regardless of frequency: daily=${a} gym=${b}`);
});

test('a 3x/week habit done only once a week scores below one done three times', () => {
  const gym = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const range = dateRange('2026-01-01', '2026-12-31');

  const onTarget = new Map();
  const underTarget = new Map();
  for (const d of range) {
    const dow = new Date(d + 'T12:00:00').getDay();
    if ([1, 3, 5].includes(dow)) onTarget.set(d, YES);
    if (dow === 1) underTarget.set(d, YES);
  }

  const good = computeScores(gym, onTarget, '2026-01-01', '2026-12-31').at(-1).score;
  const poor = computeScores(gym, underTarget, '2026-01-01', '2026-12-31').at(-1).score;
  assert.ok(poor < good, `under-target ${poor} should trail on-target ${good}`);
});

test('skipped days freeze the score rather than decaying it', () => {
  const built = new Map(dateRange('2026-01-01', '2026-02-28').map((d) => [d, YES]));
  const peak = computeScores(boolHabit, built, '2026-01-01', '2026-02-28').at(-1).score;

  // Two weeks of skips (e.g. illness, vacation) should hold the score steady.
  const withSkips = new Map(built);
  for (const d of dateRange('2026-03-01', '2026-03-14')) withSkips.set(d, SKIP);
  const after = computeScores(boolHabit, withSkips, '2026-01-01', '2026-03-14').at(-1).score;

  assert.ok(Math.abs(after - peak) < 1e-9,
    `skips should not move the score: peak=${peak} after=${after}`);
});

test('score never exceeds 1 WITHOUT relying on clamping', () => {
  // Regression: the old gain=1/freq formula overshot for every non-daily
  // frequency and was truncated by a clamp, so a perfectly-held 1x/30d habit
  // oscillated between 51% and 100% depending only on which day you looked.
  const range = dateRange('2026-01-01', '2026-12-31');

  for (const [label, n, d, pred] of [
    ['daily', 1, 1, () => true],
    ['1x/week', 1, 7, (x) => new Date(x + 'T12:00:00').getDay() === 1],
    ['3x/week', 3, 7, (x) => [1, 3, 5].includes(new Date(x + 'T12:00:00').getDay())],
    ['1x/30d', 1, 30, (x) => Number(x.slice(8, 10)) === 1],
    ['1x/365d', 1, 365, (x) => x === '2026-06-01'],
  ]) {
    const habit = { ...boolHabit, freq_numerator: n, freq_denominator: d };
    const entries = new Map(range.filter(pred).map((x) => [x, YES]));
    const scores = computeScores(habit, entries, '2026-01-01', '2026-12-31');

    for (const s of scores) {
      assert.ok(s.score >= 0 && s.score <= 1,
        `${label}: score left [0,1] at ${s.date}: ${s.score}`);
    }
  }
});

test('one completion cannot saturate a low-frequency habit', () => {
  // Regression: gain = 1/freq made a single checkmark on a 1x/365d habit
  // report 100% strength forever.
  const annual = { ...boolHabit, freq_numerator: 1, freq_denominator: 365 };
  const entries = new Map([['2026-08-10', YES]]);
  const scores = computeScores(annual, entries, '2026-08-01', '2026-08-20');

  const peak = Math.max(...scores.map((s) => s.score));
  assert.ok(peak < 0.5,
    `a single entry should not imply full strength, got ${peak}`);
});

test('sustained on-target adherence converges high for every frequency', () => {
  const range = dateRange('2025-01-01', '2026-12-31');

  for (const [label, n, d, pred] of [
    ['daily', 1, 1, () => true],
    ['1x/week', 1, 7, (x) => new Date(x + 'T12:00:00').getDay() === 1],
    ['3x/week', 3, 7, (x) => [1, 3, 5].includes(new Date(x + 'T12:00:00').getDay())],
    ['1x/30d', 1, 30, (x) => Number(x.slice(8, 10)) === 1],
  ]) {
    const habit = { ...boolHabit, freq_numerator: n, freq_denominator: d };
    const entries = new Map(range.filter(pred).map((x) => [x, YES]));
    const final = computeScores(habit, entries, '2025-01-01', '2026-12-31').at(-1).score;

    assert.ok(final > 0.8,
      `${label} held exactly on target should converge high, got ${final}`);
  }
});

test('a habit at half its target scores well below one on target', () => {
  const range = dateRange('2025-01-01', '2026-12-31');
  const gym = { ...boolHabit, freq_numerator: 4, freq_denominator: 7 };

  const onTarget = new Map(
    range.filter((x) => [1, 2, 4, 5].includes(new Date(x + 'T12:00:00').getDay()))
      .map((x) => [x, YES])
  );
  const halfTarget = new Map(
    range.filter((x) => [1, 4].includes(new Date(x + 'T12:00:00').getDay()))
      .map((x) => [x, YES])
  );

  const good = computeScores(gym, onTarget, '2025-01-01', '2026-12-31').at(-1).score;
  const poor = computeScores(gym, halfTarget, '2025-01-01', '2026-12-31').at(-1).score;

  assert.ok(poor < good * 0.75,
    `half adherence (${poor}) should trail full adherence (${good}) clearly`);
});

test('a distant-past entry cannot blow up any aggregation (DoS guard)', () => {
  // Regression: /overview passed the earliest STORED entry date straight into
  // computeStreaks. One entry dated year 0100 — trivially planted through an
  // import — walked ~703,000 days per habit and blocked the event loop for
  // every user of the single-threaded server for ~32 seconds.
  const entries = new Map([['0100-01-01', { value: YES, status: '' }]]);

  const started = Date.now();
  const streaks = computeStreaks(boolHabit, entries, '0100-01-01', '2026-08-12');
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2000,
    `computeStreaks over a 1900-year span took ${elapsed}ms — the clamp is gone`);
  assert.ok(Array.isArray(streaks));
});

test('every aggregation is bounded by MAX_RANGE_DAYS', () => {
  const entries = new Map([['0100-01-01', { value: YES, status: '' }]]);
  const list = [{ date: '0100-01-01', value: YES, status: '' }];

  const scores = computeScores(boolHabit, entries, '0100-01-01', '2026-08-12');
  assert.ok(scores.length <= MAX_RANGE_DAYS + 1,
    `computeScores produced ${scores.length} points`);

  const stats = computeStats(boolHabit, list, { end: '2026-08-12' });
  assert.ok(stats.scores.length <= MAX_RANGE_DAYS + 1);
  assert.ok(stats.history.length <= MAX_RANGE_DAYS + 1,
    `history had ${stats.history.length} buckets`);
});

test('boundedRange clamps the start but never the end', () => {
  const r = boundedRange('0100-01-01', '2026-08-12');
  assert.equal(r.length, MAX_RANGE_DAYS + 1);
  assert.equal(r.at(-1), '2026-08-12', 'the end date must be preserved');
  assert.equal(r[0], addDays('2026-08-12', -MAX_RANGE_DAYS));
});

test('boundedRange leaves ordinary ranges untouched', () => {
  const normal = boundedRange('2026-01-01', '2026-01-10');
  assert.deepEqual(normal, dateRange('2026-01-01', '2026-01-10'));
});

test('boundedRange returns nothing when start is after end', () => {
  assert.deepEqual(boundedRange('2026-12-31', '2026-01-01'), []);
});

test('an empty history scores zero', () => {
  const scores = computeScores(boolHabit, new Map(), '2026-01-01', '2026-01-10');
  assert.equal(scores[scores.length - 1].score, 0);
});

/* ---------- history ---------- */

test('daily history reports completions against opportunities', () => {
  const entries = map({
    '2026-01-01': YES, '2026-01-02': UNSET, '2026-01-03': YES,
  });
  const hist = computeHistory(boolHabit, entries, '2026-01-01', '2026-01-03', 'day');
  assert.equal(hist.length, 3);
  assert.deepEqual(hist.map((b) => b.completed), [1, 0, 1]);
  assert.deepEqual(hist.map((b) => b.total), [1, 1, 1]);
});

test('monthly history groups by month', () => {
  const entries = map({
    '2026-01-05': YES, '2026-01-20': YES, '2026-02-10': YES,
  });
  const hist = computeHistory(boolHabit, entries, '2026-01-01', '2026-02-28', 'month');
  assert.deepEqual(hist.map((b) => b.bucket), ['2026-01', '2026-02']);
  assert.equal(hist[0].completed, 2);
  assert.equal(hist[1].completed, 1);
});

test('quarterly history labels quarters correctly', () => {
  const entries = map({ '2026-02-01': YES, '2026-05-01': YES });
  const hist = computeHistory(boolHabit, entries, '2026-01-01', '2026-06-30', 'quarter');
  assert.deepEqual(hist.map((b) => b.bucket), ['2026-Q1', '2026-Q2']);
});

test('skipped days are excluded from history totals', () => {
  const entries = map({ '2026-01-01': YES, '2026-01-02': SKIP });
  const hist = computeHistory(boolHabit, entries, '2026-01-01', '2026-01-02', 'month');
  assert.equal(hist[0].total, 1, 'skip should not count as an opportunity');
  assert.equal(hist[0].skipped, 1);
});

test('numerical history sums recorded values', () => {
  const entries = map({ '2026-01-01': 8, '2026-01-02': 4 });
  const hist = computeHistory(numHabit, entries, '2026-01-01', '2026-01-02', 'month');
  assert.equal(hist[0].value, 12);
  assert.equal(hist[0].completed, 1, 'only the day hitting 8 counts');
});

test('an inherited property is not a granularity', () => {
  // `granularity` is `req.query.granularity` in both editions, and a lookup
  // on a plain object reaches Object.prototype. Each of these is truthy, so
  // `?? BUCKETERS.day` never ran: 'valueOf' and 'hasOwnProperty' were then
  // called with `this` undefined (a 500 on the stats endpoint), '__proto__'
  // is not a function at all, and 'toString' quietly bucketed every day
  // under '[object Undefined]'.
  //
  // The same shape as SETTING_VALUES['__proto__'] in validate.js.
  const entries = map({ '2026-01-01': YES, '2026-01-02': YES });

  for (const key of ['valueOf', 'toString', 'hasOwnProperty', '__proto__', 'constructor']) {
    const hist = computeHistory(boolHabit, entries, '2026-01-01', '2026-01-02', key);
    assert.deepEqual(hist.map((b) => b.bucket), ['2026-01-01', '2026-01-02'],
      `${key} should fall back to daily buckets`);
  }
});

/* ---------- weekdays ---------- */

test('weekday breakdown attributes days correctly', () => {
  // 2026-01-04 is a Sunday, 2026-01-05 a Monday.
  const entries = map({ '2026-01-04': YES, '2026-01-05': UNSET });
  const wd = computeWeekdays(boolHabit, entries, '2026-01-04', '2026-01-05');
  assert.equal(wd[0].completed, 1, 'Sunday completed');
  assert.equal(wd[1].completed, 0, 'Monday missed');
  assert.equal(wd[1].total, 1, 'Monday still counts as an opportunity');
});

/* ---------- frequency ---------- */

test('frequency counts completions per week grouped by month', () => {
  // Week of Mon 2026-01-05: three completions.
  const entries = map({
    '2026-01-05': YES, '2026-01-06': YES, '2026-01-07': YES,
  });
  const freq = computeFrequency(boolHabit, entries, '2026-01-05', '2026-01-11');
  assert.equal(freq.length, 1);
  assert.equal(freq[0].month, '2026-01');
  assert.deepEqual(freq[0].counts, { 3: 1 }, 'one week with three completions');
});

test('isCompleted needs the whole row, not just the value', () => {
  // A skip is stored as `value 0, status 'skip'`. Passing the bare number
  // throws the skip signal away, and 0 then gets judged against the target:
  // on an at_most habit — or any at_least habit with a target of 0 — every
  // skipped day was counted as a COMPLETION.
  //
  // This shipped in the personal edition's totalCompleted while the cloud
  // edition passed the row correctly, so the two reported different lifetime
  // totals for identical data.
  const skip = { date: '2026-01-01', value: 0, status: 'skip' };

  const cases = [
    ['numerical at_most 2', { type: 'numerical', target_value: 2, target_type: 'at_most' }],
    ['numerical at_least 0', { type: 'numerical', target_value: 0, target_type: 'at_least' }],
    ['numerical at_least 8', { type: 'numerical', target_value: 8, target_type: 'at_least' }],
    ['boolean', { type: 'boolean', target_value: 0, target_type: 'at_least' }],
  ];

  for (const [label, habit] of cases) {
    assert.equal(isCompleted(habit, skip), null,
      `${label}: a skipped day is "not applicable", never a completion`);
  }
});

/* ---------- a day nobody answered, on a habit that is a limit ---------- */

const UNLOGGED_DEFAULT = (await import('../src/stats.js')).UNLOGGED_DEFAULT;

test('an unlogged day is not a success on an at-most habit', () => {
  // The finding this section exists for. `entryMap.get(date) ?? UNSET` handed
  // an unanswered day the value 0, and 0 is UNDER a limit — so a habit nobody
  // had ever logged reported an unbroken streak and a strength climbing toward
  // 100%, and both grew for as long as it was ignored. That is also the exact
  // collapse `shared/CLAUDE.md` forbids of a reader: ask whether the map HOLDS
  // the day, never what it holds.
  const stats = computeStats(atMostHabit, [],
    { start: '2026-07-01', end: '2026-07-30' });

  assert.deepEqual(stats.streaks, [],
    'a habit with no entries at all reported a streak');
  assert.equal(stats.score, 0, 'and a strength it had not earned');
  assert.equal(stats.totalCompleted, 0);
});

test('a stated zero IS a success on an at-most habit, under either answer', () => {
  // The other half, and the reason this is about the fourth state rather than
  // about zero. A row holding 0 is the user saying "none today", which for a
  // limit is exactly the thing being asked for. Both must not move together:
  // reading the unanswered day as a miss is right, and reading the answered
  // one as a miss would make the setting unusable — there would be no way to
  // record a clean day at all.
  for (const unlogged of ['miss', 'success']) {
    assert.equal(isCompleted(atMostHabit, { value: 0, status: '' }, unlogged), true,
      `${unlogged}: a row holding 0 is under the limit`);
    assert.equal(isCompleted(atMostHabit, undefined, unlogged), unlogged === 'success',
      `${unlogged}: a day with no row follows the setting`);
  }
});

test('the setting buys back the old reading, and only for the unanswered day', () => {
  // "I had no soda" is not something anyone opens an app for; the point of
  // tracking it is to record the exception. That account says so once and gets
  // this, which is what the previous behaviour was — now chosen rather than
  // fallen into.
  const stats = computeStats(atMostHabit, [],
    { start: '2026-07-01', end: '2026-07-30', unlogged: 'success' });

  assert.equal(stats.streaks.length, 1);
  assert.equal(stats.streaks[0].length, 30);
  assert.ok(stats.score > 0.7, 'the EWMA should be climbing');
});

test('a slip breaks the run under either answer', () => {
  // Whatever the silence means, an entry over the limit is a miss. Six on the
  // 10th, on a habit that allows five.
  for (const unlogged of ['miss', 'success']) {
    const stats = computeStats(atMostHabit,
      [{ date: '2026-07-10', value: 6, status: '' }],
      { start: '2026-07-01', end: '2026-07-30', unlogged });
    assert.ok(
      stats.streaks.every((s) => !(s.start <= '2026-07-10' && '2026-07-10' <= s.end)),
      `${unlogged}: the day over the limit was inside a streak`
    );
  }
});

test('nothing about an at-least habit turns on this at all', () => {
  // The question only arises for a limit: for every other habit an unanswered
  // day holds no value, and no value is short of an at-least target and is not
  // YES. Pinned so a future change to the rule cannot quietly reach further
  // than the one case it is for.
  for (const habit of [boolHabit, numHabit]) {
    for (const unlogged of ['miss', 'success']) {
      assert.equal(isCompleted(habit, undefined, unlogged), false,
        `${habit.type}/${unlogged}: an unanswered day is a miss, always`);
    }
  }
});

test('a skip still outranks the setting', () => {
  // A skip is an answer — "this day did not happen" — and it is neither a
  // success nor a failure whatever silence is taken to mean.
  for (const unlogged of ['miss', 'success']) {
    assert.equal(isCompleted(atMostHabit, { value: 0, status: 'skip' }, unlogged), null);
  }
});

test('the default is the honest one', () => {
  // A limit created today has been kept for exactly no time. Defaulting the
  // other way hands every new one a perfect record on its first day, which is
  // the same unearned progress this whole change removes.
  assert.equal(UNLOGGED_DEFAULT, 'miss');
  assert.equal(isCompleted(atMostHabit, undefined), false,
    'the default reading of an unanswered day changed without this test noticing');
});

test('a habit overrides the account, in both directions', () => {
  // Two levels because the two kinds of limit want opposite answers and people
  // keep both. The account setting is what most habits follow; a habit that
  // disagrees says so, and 'default' — which is every habit stored before the
  // column existed — means the account's.
  const window = { start: '2026-07-01', end: '2026-07-30' };
  const streakOf = (own, account) => computeStats(
    { ...atMostHabit, at_most_unlogged: own }, [], { ...window, unlogged: account }
  ).streaks.length;

  assert.equal(streakOf('default', 'miss'), 0, 'default must follow the account');
  assert.equal(streakOf('success', 'miss'), 1, 'the habit must win over the account');
  assert.equal(streakOf('default', 'success'), 1, 'default must follow the account');
  assert.equal(streakOf('miss', 'success'), 0, 'the habit must win over the account');
});

test('a habit stored before the column existed follows the account', () => {
  // Undefined, not 'default' — which is what every row read back from a
  // database that has not been migrated looks like, and what a Loop file
  // yields, since no Loop format has anywhere to carry a preference.
  const legacy = { ...atMostHabit };
  delete legacy.at_most_unlogged;

  assert.equal(isCompleted(legacy, undefined, 'success'), true);
  assert.equal(isCompleted(legacy, undefined, 'miss'), false);
});

test('an unrecognised override is read as the account, not as success', () => {
  // The server clamps this to the enum on the way in, but a stats function is
  // reachable from an import writer and from a database somebody has edited.
  // Falling back to the account is the same answer 'default' gives; falling
  // back to `success` would hand a limit a perfect record on a typo.
  for (const junk of ['', 'yes', 'TRUE', null, 0]) {
    assert.equal(
      isCompleted({ ...atMostHabit, at_most_unlogged: junk }, undefined, 'miss'), false,
      `${JSON.stringify(junk)} was read as something other than the account`
    );
  }
});

test('the rule reaches at-most habits and nothing else', () => {
  // The gate, and it is not tidiness. Ungated, `success` fell through to the
  // ordinary predicate for every habit — and on an at-least habit with a
  // target of 0, `0 >= 0` is true while dayCredit's `target <= 0` branch
  // answers 0. One response then reported a 30-day streak and 100% history
  // beside a strength of 0.
  //
  // A target of 0 is reachable (parseHabit accepts it, the form's min is 0,
  // the Loop CSV path defaults one) and `at_most_unlogged` deliberately
  // OUTLIVES a switch from At most to At least, so a habit carrying 'success'
  // can arrive here as an at-least habit.
  const cases = [
    ['at_least target 0', { type: 'numerical', target_type: 'at_least', target_value: 0 }],
    ['at_least target 8', { type: 'numerical', target_type: 'at_least', target_value: 8 }],
    ['boolean', { type: 'boolean', target_type: 'at_most', target_value: 0 }],
  ];
  for (const [label, base] of cases) {
    const habit = { ...base, freq_numerator: 1, freq_denominator: 1 };
    for (const unlogged of ['miss', 'success']) {
      assert.equal(isCompleted(habit, undefined, unlogged), false,
        `${label} / account ${unlogged}: an unanswered day must be a miss`);
      assert.equal(
        isCompleted({ ...habit, at_most_unlogged: 'success' }, undefined, unlogged), false,
        `${label} / habit success: the override must not reach a non-limit`
      );
    }
  }
});

test('the score and the streak never disagree about an unanswered day', () => {
  // The invariant the bug above broke, stated directly rather than through one
  // example: for every habit shape and every answer, a full-credit day must be
  // a completed day and a zero-credit day must not be.
  const shapes = [
    { type: 'boolean', target_type: 'at_least', target_value: 0 },
    { type: 'numerical', target_type: 'at_least', target_value: 0 },
    { type: 'numerical', target_type: 'at_least', target_value: 8 },
    { type: 'numerical', target_type: 'at_most', target_value: 0 },
    { type: 'numerical', target_type: 'at_most', target_value: 2 },
  ];
  for (const shape of shapes) {
    for (const own of ['default', 'miss', 'success']) {
      for (const account of ['miss', 'success']) {
        const habit = { ...shape, freq_numerator: 1, freq_denominator: 1, at_most_unlogged: own };
        const label = `${shape.type}/${shape.target_type}/${shape.target_value} ${own}/${account}`;

        // One unanswered day, scored both ways. `computeScores` reaches
        // dayCredit and `onPaceSeries` reaches isCompleted, so a disagreement
        // shows up as a streak without a score or the reverse.
        const window = { start: '2026-07-01', end: '2026-07-01', unlogged: account };
        const stats = computeStats(habit, [], window);
        const kept = stats.streaks.length === 1;
        assert.equal(kept, stats.score > 0,
          `${label}: streak says ${kept} and the score says ${stats.score}`);
        assert.equal(kept, stats.history[0].completed === 1,
          `${label}: the history disagrees with the streak`);
      }
    }
  }
});

/* ---------- coverage ---------- */

/**
 * Rows for every day of `month` except the dates listed, all `value`.
 * A row is a row whatever it says, which is the whole point of the figure.
 */
function monthRows(month, { skip = [], missing = [], lapse = [] } = {}) {
  const rows = [];
  const [y, m] = month.split('-').map(Number);
  for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    if (missing.includes(d)) continue;
    if (skip.includes(d)) rows.push({ date, value: 0, status: 'skip' });
    else if (lapse.includes(d)) rows.push({ date, value: 0, status: '' });
    else rows.push({ date, value: YES, status: '' });
  }
  return rows;
}

const coverageOf = (rows, end, opts) =>
  Object.fromEntries(
    computeStats(boolHabit, rows, { end, ...opts }).coverage
      .map((c) => [c.month, `${c.answered}/${c.days}`])
  );

test('coverage counts a day that has a ROW, whatever the row says', () => {
  // done, skip and a stated lapse are three answers; a missing row is the
  // fourth state and is not one. `entryMap.get(date) ?? UNSET` would make the
  // last two identical, which is the collapse this figure exists to refuse.
  const rows = monthRows('2026-01', { skip: [5, 6], lapse: [7, 8] });
  assert.deepEqual(coverageOf(rows, '2026-01-31'), { '2026-01': '31/31' });

  const holed = monthRows('2026-01', { skip: [5], lapse: [7], missing: [9] });
  assert.deepEqual(coverageOf(holed, '2026-01-31'), { '2026-01': '30/31' });
});

test('one missing day is the difference between covered and not', () => {
  // The fixture straddles the boundary by a DAY and not by a month: two
  // Januaries, alike in every other respect.
  const full = coverageOf(monthRows('2026-01'), '2026-01-31')['2026-01'];
  const short = coverageOf(monthRows('2026-01', { missing: [17] }), '2026-01-31')['2026-01'];
  assert.equal(full, '31/31');
  assert.equal(short, '30/31');
});

test('only months the window entirely contains are reported', () => {
  // A habit whose first row is the 10th cannot have covered January, so
  // January is not in the list at all — a figure that could never be reached
  // is worse than a missing one, and worse still if the denominator quietly
  // became "days of the window".
  const rows = [
    ...monthRows('2026-01').slice(9),   // from the 10th
    ...monthRows('2026-02'),
  ];
  assert.deepEqual(coverageOf(rows, '2026-02-28'), { '2026-02': '28/28' });
});

test('the month in progress is not reported, and the last day of it is', () => {
  // The whole of the "closed month" requirement, settled by containment alone.
  // On the 3rd March is not contained, so nothing about it can be shown — which
  // is what stops a badge appearing on the 3rd and vanishing on the 4th. On the
  // 31st it is contained, and what it says can no longer go down.
  const rows = [...monthRows('2026-02'), ...monthRows('2026-03')];

  const onThe3rd = coverageOf(rows, '2026-03-03');
  assert.equal(onThe3rd['2026-03'], undefined, 'March is still in progress');
  assert.equal(onThe3rd['2026-02'], '28/28', 'while February is closed and full');

  const onThe31st = coverageOf(rows, '2026-03-31');
  assert.equal(onThe31st['2026-03'], '31/31');

  // And the day before the last is still not enough, which is the edge itself.
  assert.equal(coverageOf(rows, '2026-03-30')['2026-03'], undefined);
});

test('coverage knows how long a month is, February and a leap year included', () => {
  assert.deepEqual(coverageOf(monthRows('2026-02'), '2026-02-28'), { '2026-02': '28/28' });
  assert.deepEqual(coverageOf(monthRows('2028-02'), '2028-02-29'), { '2028-02': '29/29' });
  // 29 rows in a 28-day February is not a thing the data can hold, but 28 rows
  // in a 29-day one is: the leap day left blank.
  assert.deepEqual(coverageOf(monthRows('2028-02', { missing: [29] }), '2028-02-29'),
    { '2028-02': '28/29' });
});

test('coverage is over the same window every other figure uses', () => {
  // `from = start ?? firstEntry`, so an explicit start narrows this exactly as
  // it narrows the history and the streaks — the awards beside it cannot come
  // to disagree about what "ever" means.
  const rows = [...monthRows('2026-01'), ...monthRows('2026-02')];
  assert.deepEqual(coverageOf(rows, '2026-02-28'),
    { '2026-01': '31/31', '2026-02': '28/28' });
  assert.deepEqual(coverageOf(rows, '2026-02-28', { start: '2026-01-15' }),
    { '2026-02': '28/28' });
});

/* ---------- summaryStats: the two-field entry point /overview uses ---------- */

test('summaryStats matches the score and currentStreak computeStats would return', () => {
  // Every fixture also exercises `computeStats` over the same arguments, so a
  // change to `summaryStats`'s own wiring — the wrong entry map, a dropped
  // `unlogged`, a different window — shows up as a divergence rather than a
  // silent rename. `resolveWindow` is the one thing both call for the window
  // itself, so this is not a test of that helper in isolation; see the
  // '0999-12-31' fixture below for why it still needs a literal alongside it.
  const END = '2026-08-18';
  const dailyRun = [
    { date: '2026-08-10', value: YES }, { date: '2026-08-11', value: YES },
    { date: '2026-08-12', value: YES }, { date: '2026-08-13', value: YES },
    { date: '2026-08-14', value: YES }, { date: '2026-08-15', value: YES },
    { date: '2026-08-16', value: YES }, { date: '2026-08-17', value: YES },
    { date: '2026-08-18', value: YES },
  ];
  const julyRun = dateRange('2026-07-01', '2026-07-15').map((d) => ({ date: d, value: YES }));

  const fixtures = [
    // A boolean daily habit with a normal run.
    { habit: boolHabit, entries: dailyRun, opts: { end: END } },
    // An at-most habit: the unknown/no distinction this repo has been bitten
    // by before, with an unlogged day sitting between two stated values.
    { habit: atMostHabit, entries: [
        { date: '2026-08-15', value: 2, status: '' },
        { date: '2026-08-17', value: 0, status: '' },
      ], opts: { end: END } },
    // A numerical habit.
    { habit: numHabit, entries: [
        { date: '2026-08-17', value: 8 }, { date: '2026-08-18', value: 10 },
      ], opts: { end: END } },
    // No entries at all.
    { habit: boolHabit, entries: [], opts: { end: END } },
    // unlogged: 'success', on a one-day window with nothing to be unlogged
    // ABOUT: the only entry stored is the window's one day, so there is no
    // unknown day for the setting to read either way and both answers give
    // the same pair. Kept as a one-day-window case, but it is not the
    // `unlogged` cover — see the fixture below for that.
    { habit: atMostHabit, entries: [{ date: '2026-08-18', value: 6, status: '' }],
      opts: { end: END, unlogged: 'success' } },
    // unlogged: 'success', with an UNKNOWN day inside the window: two stated
    // days (10th and 18th) eight days apart on a target of 5, so days 11-17
    // have no row at all. `unlogged: 'success'` credits those days as under
    // the limit; the default reads them as misses. That is what makes this
    // fixture separate on the axis the one above cannot — a wrong `unlogged`
    // wiring inside `summaryStats` (e.g. always passing UNLOGGED_DEFAULT)
    // changes the pair returned here but not the one-day-window case above.
    // Shared with the literal test below pinning both readings, so an edit
    // here invalidates that test too, not only this parity comparison.
    { habit: unloggedSeparatesFixture.habit, entries: unloggedSeparatesFixture.entries,
      opts: { end: unloggedSeparatesFixture.end, unlogged: 'success' } },
    // An explicit `start` in opts, narrower than the entries' own span.
    { habit: boolHabit, entries: dailyRun, opts: { end: END, start: '2026-08-15' } },
    // A stored lapse: a row holding 0, status ''.
    { habit: boolHabit, entries: [...dailyRun, { date: '2026-08-09', value: 0, status: '' }],
      opts: { end: END } },
    // An entry older than MAX_RANGE_DAYS before end.
    { habit: boolHabit, entries: [{ date: '2000-01-01', value: YES }, ...dailyRun],
      opts: { end: END } },
    // An entry dated '0999-12-31' — a real day, and a thousand years before
    // `earliest`, so it exercises the clamp and the year padding that keeps
    // it sorting as the past. Not the ordering: see the literal test below.
    { habit: boolHabit, entries: [{ date: '0999-12-31', value: YES }, ...dailyRun],
      opts: { end: END } },
    // A best run that ENDED before `end`, with a shorter run live at `end` —
    // `currentStreak !== bestStreak` here, which every other fixture in this
    // list fails to distinguish (all nine have current === best, so a
    // `summaryStats` that swapped in `bestStreak(streaks)` for
    // `currentStreak(streaks, end)` passed every one of them). A 15-day run
    // in July, a gap, then a live 3-day run ending on `end`.
    { habit: boolHabit, entries: [
        ...julyRun,
        { date: '2026-08-16', value: YES }, { date: '2026-08-17', value: YES },
        { date: '2026-08-18', value: YES },
      ], opts: { end: END } },
    // The July run ALONE, its trailing three days removed: `streaks` is
    // non-empty (one 15-day run) but its last streak ended over a month
    // before `end`, which none of the fixtures above reach — the one above
    // has a run still LIVE at `end`, and every `atMostHabit` fixture that
    // returns `currentStreak: 0` does so through `streaks.length === 0`,
    // which returns before `currentStreak`'s gap check ever runs. This is
    // the shape that check exists for: `daysBetween(last.end, end)` is
    // large, so the answer is 0, not the length of the only streak there is.
    { habit: boolHabit, entries: julyRun, opts: { end: END } },
  ];

  for (const { habit, entries, opts } of fixtures) {
    const { score, currentStreak: cs } = computeStats(habit, entries, opts);
    assert.deepEqual(summaryStats(habit, entries, opts), { score, currentStreak: cs });
  }
});

test('the 0999-12-31 and 2016-07-9999 fixtures are pinned to literals, not only to computeStats', () => {
  // The parity assertion above compares `summaryStats` against a LIVE
  // `computeStats` call, so a bug shared by both — one inside the window
  // preamble both of them call — moves both readings the same way and the
  // comparison still passes. The literal is what catches that; the comparison
  // above is what catches `summaryStats` disagreeing with `computeStats`.
  //
  // Two junk rows, because one date can no longer carry both halves.
  const dailyRun = [
    { date: '2026-08-10', value: YES }, { date: '2026-08-11', value: YES },
    { date: '2026-08-12', value: YES }, { date: '2026-08-13', value: YES },
    { date: '2026-08-14', value: YES }, { date: '2026-08-15', value: YES },
    { date: '2026-08-16', value: YES }, { date: '2026-08-17', value: YES },
    { date: '2026-08-18', value: YES },
  ];
  const opts = { end: '2026-08-18' };

  // '0999-12-31' is the PADDING and the `earliest` clamp: a real day a
  // thousand years back, which is where the window opens without the clamp,
  // and which sorts ABOVE '2016-...' if `toISO` stops padding the year — either
  // of which walks the entry into the score. It says nothing about the
  // clamp/normalise ordering any more: normalising it is a no-op, so both
  // orderings answer it identically.
  assert.deepEqual(summaryStats(boolHabit, [{ date: '0999-12-31', value: YES },
    ...dailyRun], opts), { score: 0.381137, currentStreak: 9 });

  // '2016-07-9999' is the ORDERING, and a rollover is the only shape left that
  // can see it here. It sorts just BELOW `earliest` (end - MAX_RANGE_DAYS,
  // '2016-08-10'), so clamped first it becomes `earliest` and the reading is
  // the one above — the junk row moves nothing. Normalised first it is
  // '2043-11-15', past `end`, so the window collapses to the single day `end`
  // and the same nine completions read 0.051922 with a current streak of 1.
  //
  // Note that the score cannot see the ordering the way `computeStats`'
  // window WIDTH can (see the '9999-99-99' fixture near the top of this file):
  // the EWMA starts at 0, so a window that merely opens EARLIER over days with
  // no rows leaves the score untouched. It takes a fixture that collapses the
  // window the other way, which is why this date and not that one.
  assert.deepEqual(summaryStats(boolHabit, [{ date: '2016-07-9999', value: YES },
    ...dailyRun], opts), { score: 0.381137, currentStreak: 9 });
});

test('the current-vs-best-streak fixture is pinned to a literal, not only to computeStats', () => {
  // Parity alone cannot see this bug: `bestStreak(streaks)` and
  // `currentStreak(streaks, end)` are both derived from the same `streaks`
  // array, so a `summaryStats` that called the wrong one would still equal
  // whatever `computeStats` computes IF `computeStats` made the same swap —
  // and every fixture above this one has `current === best`, so the swap is
  // invisible there regardless. This fixture's two numbers differ, and they
  // are pinned as literals rather than compared only against a second call.
  const entries = [
    ...dateRange('2026-07-01', '2026-07-15').map((d) => ({ date: d, value: YES })),
    { date: '2026-08-16', value: YES }, { date: '2026-08-17', value: YES },
    { date: '2026-08-18', value: YES },
  ];
  const opts = { end: '2026-08-18' };
  assert.deepEqual(summaryStats(boolHabit, entries, opts),
    { score: 0.237667, currentStreak: 3 });
});

test('a streak that ended over a month ago pins currentStreak: 0 as a literal', () => {
  // `currentStreak(streaks, anchor)` computes `gap = daysBetween(last.end,
  // anchor)` and returns `gap <= 1 ? last.length : 0` — so the ANCHOR it is
  // handed is itself an axis a fixture can fail to separate on, the same way
  // `unlogged` and `bestStreak` above did. Every fixture above this one either
  // has a streak still LIVE at `end` (`gap` comes out <= 1 no matter which
  // date is passed as the anchor) or an empty `streaks` array (the gap check
  // never runs), so a `summaryStats` calling `currentStreak(streaks, from)`
  // instead of `currentStreak(streaks, end)` — `from` sits before every
  // streak's end, so the gap comes out negative and the length is returned
  // unconditionally — would answer every one of them the same as before. This
  // fixture's one streak ended in July and nothing is live at `end`, so a
  // wrong anchor answers 15 instead of the correct 0. Pinned as a literal,
  // not only through the parity assertion above, so the check survives a
  // change to `computeStats`'s own call sharing the same mistake.
  const julyRun = dateRange('2026-07-01', '2026-07-15').map((d) => ({ date: d, value: YES }));
  assert.deepEqual(summaryStats(boolHabit, julyRun, { end: '2026-08-18' }),
    { score: 0.089848, currentStreak: 0 });
});

test('the unlogged-success fixture pins the SEPARATION between its two readings, not only the fixture', () => {
  // This fixture is the only cover in the repo for `summaryStats`'s `unlogged`
  // wiring, and it is defended above only by parity against a live
  // `computeStats` — which is self-consistent: if the fixture stops
  // separating (a habit swapped in for one where `unlogged` is inert, a date
  // moved, anything), `summaryStats` and `computeStats` still agree with EACH
  // OTHER over whatever pair comes out, and nothing fails. Demonstrated, not
  // speculated: swap `unloggedSeparatesFixture.habit` for `numHabit` above (an
  // at-least habit, where `unlogged` has nothing to read) and this exact
  // fixture edit both keeps the whole suite green AND turns the
  // UNLOGGED_DEFAULT mutation (7a) green again. Pinning both readings as
  // literals — independently re-derived, not read off a passing run — is what
  // survives that: this fails the moment the two readings collapse into one,
  // whatever caused it, because it shares the fixture object with the parity
  // list above rather than duplicating it.
  const { habit, entries, end } = unloggedSeparatesFixture;
  assert.deepEqual(summaryStats(habit, entries, { end, unlogged: 'success' }),
    { score: 0.381137, currentStreak: 9 });
  assert.deepEqual(summaryStats(habit, entries, { end }),
    { score: 0.085815, currentStreak: 1 });
});

test('summaryStats returns exactly the two fields /overview reads, nothing more', () => {
  // This is the test that makes the saving real rather than a rename: adding
  // any of the five discarded passes back onto the return object must fail it.
  const stats = summaryStats(boolHabit, [{ date: '2026-08-18', value: YES }],
    { end: '2026-08-18' });
  assert.deepEqual(Object.keys(stats).sort(), ['currentStreak', 'score']);
});

test('an explicit start after end collapses the window to [end, end], not an empty one', () => {
  // Neither route can hand `resolveWindow` this shape — both editions' /stats
  // routes reject `start > end` with a 400 before `computeStats` is ever
  // called — so this is not a live route bug. It is what keeps the shared
  // helper correct for a caller that has no such guard, and the test exists
  // so `if (from > end) from = end;` cannot be deleted from `resolveWindow`
  // as dead code: every OTHER reader of the window goes through
  // `boundedRange`, whose own `daysBetween(from, end) < 0` check absorbs an
  // inverted window for free, but `totalCompleted` selects by STRING
  // comparison against `from` directly and so is the one figure that
  // diverges when the clamp is missing.
  const entries = [{ date: '2026-08-18', value: YES }];
  const stats = computeStats(boolHabit, entries, { start: '2026-08-20', end: '2026-08-18' });
  assert.equal(stats.totalCompleted, 1);
});

/* ---------- comparing categories ---------- */

const CAT_START = '2026-06-01';
const CAT_END = '2026-06-30';
const CAT_WINDOW = { start: CAT_START, end: CAT_END };
// Where every fixture's history begins: comfortably inside the 400-day warm-up
// and five months before the window, so a comparison that starts its EWMA cold
// at CAT_START reports a different number from the habit's own page.
const CAT_HISTORY = '2026-01-01';

const dowOf = (iso) => new Date(iso + 'T12:00:00').getDay();
const rowsOn = (from, to, value, pred = () => true) =>
  dateRange(from, to).filter(pred).map((d) => ({ date: d, value, status: '' }));
const entryMapOf = (entries) =>
  new Map(entries.map((e) => [e.date, { value: e.value, status: e.status ?? '' }]));

// The three shapes whose scores are arrived at differently, each set off its
// defaults on purpose: a daily boolean, a 3x/week numerical, and a limit.
const readHabit = { ...boolHabit, id: 11, name: 'Read', category_id: 1 };
const gymHabit = {
  ...numHabit, id: 12, name: 'Gym', unit: 'sets', target_value: 5,
  freq_numerator: 3, freq_denominator: 7, category_id: 1,
};
const smokeHabit = { ...atMostHabit, id: 13, name: 'Smoke', category_id: 1 };

const readRows = rowsOn(CAT_HISTORY, CAT_END, YES);
const gymRows = rowsOn(CAT_HISTORY, CAT_END, 5, (d) => [1, 3, 5].includes(dowOf(d)));
const smokeRows = rowsOn(CAT_HISTORY, CAT_END, 2);

const CATS = [
  { id: 1, name: 'Health', color: '#2e7d32', position: 0 },
  { id: 2, name: 'Admin', color: '#6a1b9a', position: 1 },
];

test('SCORE_WARMUP_DAYS is 400, the number /overview already spends', () => {
  // The literal, not the imported name: both editions' SUMMARY_WINDOW_DAYS is
  // 400 for the same reason, and a warm-up that quietly widened here would
  // change every figure on the comparison and nothing else in the suite.
  assert.equal(SCORE_WARMUP_DAYS, 400);
});

test('a category\'s mean is the mean of its members\' own strengths, warmed up the way their own pages are', () => {
  // Decision 2 of the brief, and the whole reason the warm-up exists.
  // `ui/detail.js` sends no `start` to /habits/:id/stats, so a habit's own page
  // shows a score converged from its first entry. A comparison starting cold at
  // CAT_START reports every one of these habits weaker than its own page does,
  // and two surfaces disagreeing about the same habit is indistinguishable
  // from one of them being broken.
  const members = [
    { habit: readHabit, entries: readRows },
    { habit: gymHabit, entries: gymRows },
    { habit: smokeHabit, entries: smokeRows },
  ];
  const own = members.map((m) => computeStats(m.habit, m.entries, { end: CAT_END }).score);
  const expected = own.reduce((a, b) => a + b, 0) / own.length;

  // The fixture separates only if the habits are actually converged: a cold
  // start would put the daily members at ~0.80 and the 3x/week one at ~0.65.
  assert.ok(own.every((s) => s > 0.99), `members are not converged: ${own.join(', ')}`);

  const health = computeCategoryStats(CATS, members, CAT_WINDOW).categories[0];

  // Not zero tolerance, and the reason is a real property rather than
  // floating-point slack: `onPaceSeries`/`computeScores` pro-rate the
  // requirement over the first `den - 1` days, so starting the 3x/week member
  // 400 days earlier re-judges those days against a full week's requirement
  // (shared/CLAUDE.md says so). That residue decays by alpha^n and is ~2e-3
  // here; the cold-start mutation this test exists for moves the mean by ~0.25.
  assert.ok(Math.abs(health.mean - expected) < 5e-3,
    `mean ${health.mean} should track the members' own pages (${expected})`);
  assert.ok(health.mean > 0.99, `a category of three converged habits read ${health.mean}`);

  // And exactly, for a category whose only member is daily — `num >= den`, so
  // there is no leniency window for the warm-up to re-judge and the two windows
  // must agree to the last bit.
  const solo = computeCategoryStats(CATS, [{ habit: readHabit, entries: readRows }],
    CAT_WINDOW).categories[0];
  assert.ok(Math.abs(solo.mean - own[0]) < 1e-12,
    `a daily member's category mean ${solo.mean} must equal its own page's ${own[0]}`);
});

test('a member is warmed up from ITS first entry, so an at-most habit whose unlogged days count as kept is not converged by days before it existed', () => {
  // The clamp on `memberWarm`, and the shape the warm-up is most dangerous for.
  // Every other fixture in this section is at-least, or is `smokeHabit` with a
  // row on every day of the window and `at_most_unlogged` left at its 'miss'
  // default — none of which can see this, and all of them pass either way.
  //
  // A habit's own page opens at `start ?? firstEntry` (`resolveWindow`), so
  // scoring a member from 400 days before it was created compares it against a
  // window it never had. For an at-least member those phantom days credit 0 and
  // the two surfaces agree anyway; under `at_most_unlogged: 'success'` an
  // unlogged day is FULL credit, so they converge it upward. Measured against
  // the unclamped code: 0.969536 here, against an own page of 0.41327 — which
  // is every avoid/limit habit's opening state, for its first ~430 days.
  const avoid = {
    ...atMostHabit, id: 23, name: 'No soda', target_value: 0,
    at_most_unlogged: 'success', show_as: 'avoid', category_id: 1,
  };
  // Created INSIDE the window — one slip, ten days before it closes — so there
  // is nothing earlier for a warm-up to legitimately reach back for.
  const slip = [{ date: addDays(CAT_END, -10), value: 1, status: '' }];

  const own = computeStats(avoid, slip, { end: CAT_END }).score;
  // The fixture separates only while the habit is a long way from converged: a
  // member handed 400 days of full credit reads ~0.97 here, so a check that
  // merely compared the two numbers could pass on a fixture that had climbed
  // there honestly.
  assert.ok(own > 0.2 && own < 0.6, `the fixture must sit mid-scale: ${own}`);

  const health = computeCategoryStats(CATS, [{ habit: avoid, entries: slip }],
    CAT_WINDOW).categories[0];

  assert.ok(Math.abs(health.mean - own) < 1e-12,
    `the comparison says ${health.mean} where the habit's own page says ${own}`);
  assert.ok(health.mean < 0.6,
    `an unclamped warm-up reads ~0.97 for this habit; this read ${health.mean}`);
  // And the series is the same members on the same day, as it is everywhere
  // else — a clamp that moved only the headline would leave the chart saying
  // the other number.
  assert.equal(health.series.at(-1).value, health.mean);

  // The control, and it is what says this is about the SHAPE rather than about
  // the fixture: the identical rows on an at-least habit agree with their own
  // page whether or not the clamp is there, which is exactly why nothing in
  // this suite caught it.
  const atLeast = {
    ...avoid, id: 24, name: 'Push-ups', target_type: 'at_least',
    at_most_unlogged: 'default', show_as: 'amount',
  };
  const control = computeCategoryStats(CATS, [{ habit: atLeast, entries: slip }],
    CAT_WINDOW).categories[0];
  assert.ok(Math.abs(control.mean - computeStats(atLeast, slip, { end: CAT_END }).score) < 1e-12,
    `the at-least control disagrees too, so the fixture is not isolating the shape: ${control.mean}`);
});

test('a member whose first entry is not a real calendar day lands on the day the walk actually reaches', () => {
  // The clamp above is what put these two in contact, so this is its own
  // defect. `firstEntry` comes out of STORAGE and does not have to be a real
  // day — `assertDate` refuses one on the way in, but a row predating that
  // guard, a direct insert or an import around it does not. `computeScores`
  // normalises the start it is handed and begins its walk on 2026-03-02;
  // `landedAt` selects by STRING comparison and admits 2026-03-01. That bucket
  // then had a member and no score point behind it — an `undefined` summed into
  // NaN, which serialises as `null` and is dropped by `ui/categories.js`'s
  // `p.value !== null` filter, so the drawn line silently loses a vertex.
  //
  // `mean` itself survives, which is why this is small and why nothing else
  // here can see it: the last bucket's day is `end`, long past the two-day gap.
  const PHANTOM = '2026-02-30';
  const opts = { start: '2026-02-25', end: '2026-03-31' };
  const entries = [
    { date: PHANTOM, value: YES, status: '' },
    ...rowsOn('2026-03-02', opts.end, YES),
  ];
  const health = computeCategoryStats(CATS,
    [{ habit: readHabit, entries, firstEntry: PHANTOM }], opts).categories[0];
  const at = (bucket) => health.series.find((p) => p.bucket === bucket);

  // The fixture is only about this while the window holds the gap.
  assert.ok(at('2026-03-01'),
    'the window must contain the day the phantom date normalises past');

  const nan = health.series.filter((p) => Number.isNaN(p.value));
  assert.equal(nan.length, 0,
    `NaN buckets: ${nan.map((p) => `${p.bucket} over ${p.members}`).join(', ')}`);

  // ...and it does not pass by excluding the member everywhere instead: it
  // lands on the real day, and every bucket from there carries it.
  assert.equal(at('2026-03-01').members, 0, 'a phantom day never happened');
  assert.equal(at('2026-03-01').value, null);
  assert.equal(at('2026-03-02').members, 1);
  assert.equal(typeof at('2026-03-02').value, 'number');

  // `unloggedExcluded` is unmoved — the member has an entry, whatever it is
  // dated — and the headline figure is still a number over it.
  assert.equal(health.members, 1);
  assert.equal(health.unloggedExcluded, 0);
  assert.equal(typeof health.mean, 'number');
  assert.equal(health.series.at(-1).value, health.mean);
});

test('a member whose first entry ROLLS OVER is clamped to warmStart BEFORE it is normalised', () => {
  // `memberWarm` clamps and then normalises, exactly as `resolveWindow` does
  // and for the same reason, and nothing in this suite could see that ordering
  // — reversing it left `npm test` at zero failures. The clamp is a STRING
  // comparison against `warmStart` and normalising is a ROLLOVER of a stored
  // string, so normalising first lets the rollover decide which of the two
  // dates the comparison picks.
  //
  // '2024-99-99' is the fixture, and every digit of it is doing work.
  // `warmStart` is CAT_START - 400 = '2025-04-27', so:
  //
  //   clamped first:    '2024-99-99' <= warmStart  -> memberWarm = warmStart
  //   normalised first: '2032-06-07' >  warmStart  -> memberWarm = '2032-06-07'
  //
  // and '2032-06-07' is past CAT_END, so `landedAt` refuses the member on every
  // day of the window: it drops out of `mean`, out of `worst`, out of every
  // bucket's `members`, and into `unloggedExcluded` — a habit reported as never
  // logged when it holds a row, and a category reading 1.00 because the member
  // dragging it down was quietly excluded rather than scored.
  //
  // NOT '9999-99-99', which is the date `resolveWindow`'s own fixture uses:
  // here it is invisible under either ordering. It sorts above `warmStart`, so
  // clamped first `memberWarm` is '10007-06-07' — and `boundedRange` inside
  // `computeScores` re-clamps that to end - MAX_RANGE_DAYS, because five year
  // digits sort BELOW four. Both orderings then score the member over days it
  // has no rows on and answer 0. The rollover has to land on the far side of
  // `warmStart` to be seen, not merely be a rollover.
  const ghost = { ...boolHabit, id: 31, name: 'Ghost', category_id: 1 };
  const members = [
    { habit: readHabit, entries: readRows },
    { habit: ghost, entries: [{ date: '2024-99-99', value: YES, status: '' }] },
  ];
  const health = computeCategoryStats(CATS, members, CAT_WINDOW).categories[0];

  // The member has an entry, whatever that entry is dated, so it is scored
  // rather than excused — and a row on a day that never happened credits
  // nothing, which is an honest 0 and half the mean of the pair.
  assert.equal(health.members, 2);
  assert.equal(health.unloggedExcluded, 0);
  assert.equal(health.mean, 0.499968);
  assert.equal(health.worst.name, 'Ghost');
  assert.equal(health.worst.score, 0);
  // And the series carries it from the window's first day, not from partway in:
  // an excluded member is a chart whose early buckets count one habit and whose
  // late ones count two, which reads as the category improving.
  assert.equal(health.series[0].members, 2);
  assert.equal(health.series.at(-1).value, health.mean);
});

test('the mean is equal weight per HABIT, never per entry', () => {
  // A daily habit logged every day carries seven times the rows of a 3x/week
  // one, so weighting by entries lets it drown its category-mate — the daily
  // member here is near 1.0 and the weekly one is held at a third of its
  // target, and an entry-weighted mean reads 0.92 where an equal-weighted one
  // reads 0.67.
  const mondaysOnly = rowsOn(CAT_HISTORY, CAT_END, 5, (d) => dowOf(d) === 1);
  const members = [
    { habit: readHabit, entries: readRows },
    { habit: gymHabit, entries: mondaysOnly },
  ];
  assert.ok(readRows.length > 6 * mondaysOnly.length,
    `the fixture must be lopsided in ENTRIES: ${readRows.length} vs ${mondaysOnly.length}`);

  const health = computeCategoryStats(CATS, members, CAT_WINDOW).categories[0];

  // best/worst are these two members' own scores, so this states the rule
  // without restating the arithmetic: the mean of a two-member category is the
  // midpoint of its spread, whatever the two habits' entry counts are.
  assert.ok(health.best.score - health.worst.score > 0.5,
    `the fixture must be lopsided in STRENGTH: ${health.best.score} vs ${health.worst.score}`);
  assert.ok(Math.abs(health.mean - (health.best.score + health.worst.score) / 2) < 1e-12,
    `mean ${health.mean} is not the midpoint of ${health.worst.score}..${health.best.score}`);
  assert.ok(health.mean < 0.7,
    `an entry-weighted mean reads ~0.92 here; this read ${health.mean}`);
});

test('a member joins the series when its first entry lands, and is never counted as 0 before', () => {
  // A habit added mid-window must read as a line STARTING, not as a category
  // that was doing half as well for every bucket before it existed.
  const joinerRows = rowsOn('2026-06-16', CAT_END, YES);
  const joiner = { ...boolHabit, id: 14, name: 'Stretch', category_id: 1 };
  const members = [
    { habit: readHabit, entries: readRows },
    { habit: joiner, entries: joinerRows },
  ];
  // The incumbent's own daily series, derived independently of the aggregation.
  const ownScores = new Map(
    computeStats(readHabit, readRows, { end: CAT_END }).scores.map((p) => [p.date, p.score])
  );

  const health = computeCategoryStats(CATS, members, CAT_WINDOW).categories[0];
  const at = (bucket) => health.series.find((s) => s.bucket === bucket);

  assert.equal(health.series.length, 30);
  assert.equal(at('2026-06-01').members, 1, 'only one habit existed on the 1st');
  assert.ok(Math.abs(at('2026-06-01').value - ownScores.get('2026-06-01')) < 1e-12,
    `the 1st read ${at('2026-06-01').value}, not the one member's own ${ownScores.get('2026-06-01')}`);
  assert.equal(at('2026-06-15').members, 1, 'the day before the joiner\'s first entry');
  assert.equal(at('2026-06-16').members, 2, 'the day it lands');
  assert.equal(at(CAT_END).members, 2);

  // The last bucket reads the last day the window holds, which is what keeps
  // the chart's final point and the headline `mean` from disagreeing.
  assert.ok(Math.abs(at(CAT_END).value - health.mean) < 1e-12,
    `the final bucket ${at(CAT_END).value} disagrees with the mean ${health.mean}`);
});

test('a member that has never missed is excluded from recoveryRate, and counted', () => {
  // `rate === null` means nothing has ever been missed, which is a different
  // claim from 100%: averaging it in as either number invents a reading.
  const lapsed = ['2026-06-05', '2026-06-10', '2026-06-15', '2026-06-16', '2026-06-17'];
  const lapsedRows = rowsOn(CAT_HISTORY, CAT_END, YES, (d) => !lapsed.includes(d));
  const lapser = { ...boolHabit, id: 15, name: 'Floss', category_id: 1 };
  const spotless = { ...boolHabit, id: 16, name: 'Vitamins', category_id: 2 };

  // The fixture, pinned through the same pair the aggregation uses: three
  // CLOSED lapses of which two lasted a single day.
  const own = computeRecovery(
    computeMissRuns(lapser, entryMapOf(lapsedRows), CAT_START, CAT_END), CAT_END
  );
  assert.equal(own.lapses, 3);
  assert.equal(own.rate, 2 / 3);

  const result = computeCategoryStats(CATS, [
    { habit: lapser, entries: lapsedRows },
    { habit: { ...spotless, category_id: 1 }, entries: readRows },
    { habit: spotless, entries: readRows },
  ], CAT_WINDOW);

  // One member with a rate, one without: the answer is the first member's own
  // rate. Averaging the null as 0 reads 1/3 here.
  assert.equal(result.categories[0].members, 2);
  assert.equal(result.categories[0].recoveryRate, 2 / 3);
  assert.equal(result.categories[0].recoveryExcluded, 1);

  // And where every member has never missed, the category says so rather than
  // reporting a recovery rate of 0.
  assert.equal(result.categories[1].members, 1);
  assert.equal(result.categories[1].recoveryRate, null);
  assert.equal(result.categories[1].recoveryExcluded, 1);
});

test('a category of one is its own best and worst member', () => {
  const result = computeCategoryStats(CATS, [
    { habit: readHabit, entries: readRows },
    { habit: { ...gymHabit, category_id: 2 }, entries: gymRows },
    { habit: { ...smokeHabit, category_id: 2 }, entries: rowsOn('2026-06-20', CAT_END, 9) },
  ], CAT_WINDOW);

  const [health, admin] = result.categories;
  assert.equal(health.members, 1);
  assert.deepEqual(health.best, health.worst,
    'a category of one has the same habit at both ends of its spread');
  assert.equal(health.best.id, 11);
  assert.equal(health.best.name, 'Read');
  assert.equal(health.best.score, health.mean);

  // And with two, the ends are the two ends — a reducer that answers the first
  // member for both, or skips one, fails here as well as above.
  assert.equal(admin.members, 2);
  assert.equal(admin.best.id, 12, 'the kept 3x/week habit is the stronger');
  assert.equal(admin.worst.id, 13, 'the limit blown for ten days is the weaker');
  assert.ok(admin.best.score > admin.worst.score);
});

test('Uncategorised is present and last even with no members, and so is an empty category', () => {
  // Uncategorised is a state a habit is in, never a category — the same
  // discipline the four day states get — so it is drawn whether or not anything
  // is in it, exactly as the grouped dashboard draws its trailing section.
  // An empty NAMED category is present for the neighbouring reason: sections
  // are not collapsed away.
  const result = computeCategoryStats(CATS,
    [{ habit: readHabit, entries: readRows }], CAT_WINDOW);

  assert.equal(result.categories.length, 3);
  assert.deepEqual(result.categories.map((c) => c.id), [1, 2, null]);

  const empty = result.categories[1];
  assert.equal(empty.name, 'Admin');
  assert.equal(empty.members, 0);
  assert.equal(empty.mean, null, 'an empty category has measured nothing, and is not 0');
  assert.equal(empty.best, null);
  assert.equal(empty.worst, null);
  assert.equal(empty.recoveryRate, null);
  assert.equal(empty.recoveryExcluded, 0);
  assert.equal(empty.unloggedExcluded, 0);

  const none = result.categories[2];
  assert.equal(none.name, null, 'naming Uncategorised is the view\'s job, as on the dashboard');
  assert.equal(none.color, null);
  assert.equal(none.members, 0);
  assert.equal(none.mean, null);
  // The axis is still shared, so the view can draw an empty small multiple
  // against the same buckets as its neighbours.
  assert.deepEqual(none.series.map((s) => s.bucket), result.buckets);
  assert.ok(none.series.every((s) => s.members === 0 && s.value === null));
});

test('a habit whose category was deleted since the fetch falls into Uncategorised', () => {
  // The grouped dashboard makes the same fallback for the same reason: every
  // habit is drawn exactly once, and a dangling id must not drop one.
  const orphan = { ...readHabit, id: 17, name: 'Orphan', category_id: 99 };
  const result = computeCategoryStats(CATS, [
    { habit: readHabit, entries: readRows },
    { habit: orphan, entries: readRows },
    { habit: { ...readHabit, id: 18, name: 'Nulled', category_id: null }, entries: readRows },
  ], CAT_WINDOW);

  assert.equal(result.categories[0].members, 1);
  assert.equal(result.categories[2].id, null);
  assert.equal(result.categories[2].members, 2);
});

test('archived members are excluded from every figure, and counted — per SECTION as well as account-wide', () => {
  const shelved = { ...readHabit, id: 19, name: 'Shelved', archived: 1 };
  // A category whose ONLY member is archived. It arrives with `members: 0`,
  // exactly as an empty one does, and one account-wide number cannot tell the
  // view which of the two it is looking at — so the card said "No habits in
  // this category yet." about a category the user filled and later shelved.
  const allShelved = {
    ...readHabit, id: 25, name: 'Old routine', category_id: 2, archived: 1,
  };
  // And a dangling `category_id` falls into Uncategorised here for the same
  // reason a live member's does: one partition rule, asked twice, not two.
  const orphanShelved = {
    ...readHabit, id: 26, name: 'Loose end', category_id: 99, archived: 1,
  };
  const result = computeCategoryStats(CATS, [
    { habit: readHabit, entries: readRows },
    { habit: shelved, entries: readRows },
    { habit: allShelved, entries: readRows },
    { habit: orphanShelved, entries: readRows },
  ], CAT_WINDOW);

  assert.equal(result.archivedExcluded, 3, 'the account-wide total is still every one of them');
  assert.equal(result.categories[0].members, 1);
  assert.equal(result.categories[0].best.id, 11);

  assert.equal(result.categories[0].archivedExcluded, 1);
  assert.equal(result.categories[1].members, 0);
  assert.equal(result.categories[1].archivedExcluded, 1,
    'a category whose habits are all archived is not an empty category');
  assert.equal(result.categories[2].id, null);
  assert.equal(result.categories[2].archivedExcluded, 1);

  // ...and a genuinely empty category still says 0, rather than inheriting the
  // total — which is the reading that would make the two indistinguishable
  // again from the other side.
  const noneShelvedHere = computeCategoryStats(CATS, [
    { habit: readHabit, entries: readRows },
    { habit: shelved, entries: readRows },
  ], CAT_WINDOW);
  assert.equal(noneShelvedHere.archivedExcluded, 1);
  assert.equal(noneShelvedHere.categories[1].members, 0);
  assert.equal(noneShelvedHere.categories[1].archivedExcluded, 0);
  assert.equal(noneShelvedHere.categories[2].archivedExcluded, 0);
});

test('the bucket axis is the one computeHistory draws, at the same granularity', () => {
  // Shared so the comparison's small multiples line up with the history chart
  // a habit's own page draws — including `weekStart`, which is why this asks
  // for Sunday weeks rather than the default.
  const opts = { ...CAT_WINDOW, granularity: 'week', weekStart: 'sunday' };
  const result = computeCategoryStats(CATS, [{ habit: readHabit, entries: readRows }], opts);
  const history = computeHistory(readHabit, entryMapOf(readRows),
    CAT_START, CAT_END, 'week', 'sunday');

  assert.deepEqual(result.buckets, history.map((b) => b.bucket));
  assert.equal(result.buckets[0], '2026-05-31', 'the Sunday the window opens inside');
  assert.deepEqual(result.categories[0].series.map((s) => s.bucket), result.buckets);
});

test('an inherited property is not a granularity here either', () => {
  // `granularity` reaches this straight off a query string, and
  // `BUCKETERS['valueOf']` is truthy — the same shape computeHistory pays for.
  for (const key of ['valueOf', 'toString', 'hasOwnProperty', '__proto__', 'constructor']) {
    const result = computeCategoryStats(CATS, [{ habit: readHabit, entries: readRows }],
      { start: '2026-06-01', end: '2026-06-02', granularity: key });
    assert.deepEqual(result.buckets, ['2026-06-01', '2026-06-02'],
      `${key} should fall back to daily buckets`);
  }
});

test('a habit with no entries yet is counted in `members` and excluded from the mean', () => {
  // A habit added to a category has no strength yet, which is not a strength of
  // zero — the same claim `recovery.rate === null` makes, and this file already
  // refuses to average that one into a number. Averaging it in would report
  // that the category got worse on the day you decided to do more about it.
  const fresh = { ...boolHabit, id: 20, name: 'Fresh start', category_id: 1 };
  const health = computeCategoryStats(CATS, [
    { habit: readHabit, entries: readRows },
    { habit: fresh, entries: [] },
  ], CAT_WINDOW).categories[0];

  // n still describes the category: the new habit IS in it.
  assert.equal(health.members, 2);
  // And the reason it is not in the mean is stated rather than hidden.
  assert.equal(health.unloggedExcluded, 1);

  const own = computeStats(readHabit, readRows, { end: CAT_END }).score;
  assert.ok(Math.abs(health.mean - own) < 1e-12,
    `mean ${health.mean} should be the one logged member's ${own}, not half of it`);
  assert.equal(health.best.id, 11, 'the unlogged member is not the spread either');
  assert.deepEqual(health.best, health.worst);
});

test('the final bucket and the headline mean are the same number, unconditionally', () => {
  // The property the last-day bucket rule and the landing rule exist to hold
  // together: a chart whose final point disagrees with the number printed over
  // it reads as a bug whichever of the two is right. Asserted over a category
  // holding a never-logged member, which is the shape that breaks it if `mean`
  // is taken over all members while the series is not.
  const fresh = { ...boolHabit, id: 20, name: 'Fresh start', category_id: 1 };
  const opts = { ...CAT_WINDOW, granularity: 'week', weekStart: 'sunday' };
  const result = computeCategoryStats(CATS, [
    { habit: readHabit, entries: readRows },
    { habit: fresh, entries: [] },
    { habit: { ...gymHabit, category_id: 2 }, entries: gymRows },
  ], opts);

  for (const cat of result.categories) {
    const last = cat.series.at(-1);
    assert.equal(last.value, cat.mean,
      `category ${cat.id}: the last bucket says ${last.value} and the mean says ${cat.mean}`);
    assert.equal(last.members, cat.members - cat.unloggedExcluded,
      `category ${cat.id}: the last bucket is over a different set from the mean`);
  }
  // ...and the fixture is not passing by having nothing to compare: two of the
  // three categories carry a real number, and one of them holds the unlogged
  // member the property is at risk from.
  assert.equal(result.categories[0].unloggedExcluded, 1);
  assert.ok(result.categories[0].mean > 0.99);
  assert.ok(result.categories[1].mean > 0.99);
  assert.equal(result.categories[2].mean, null);
});

test('an ABANDONED habit is in the mean at its decayed score, not mistaken for a new one', () => {
  // A route fetches entries from `start - SCORE_WARMUP_DAYS`, so a habit last
  // logged two years ago — still active, never archived — has NOTHING in that
  // slice. Deriving `firstEntry` from the slice calls it never logged, which
  // excludes it from the mean (the category then reads healthier than it is)
  // and describes it with a sentence that is false about a habit with years
  // behind it. The caller supplies the lifetime date instead.
  const abandoned = { ...boolHabit, id: 21, name: 'Guitar', category_id: 1 };
  const health = computeCategoryStats(CATS, [
    { habit: readHabit, entries: readRows, firstEntry: CAT_HISTORY },
    { habit: abandoned, entries: [], firstEntry: '2023-01-01' },
  ], CAT_WINDOW).categories[0];

  assert.equal(health.members, 2);
  assert.equal(health.unloggedExcluded, 0,
    'a habit logged for years and then dropped has been logged');

  // It lands in every bucket, at the strength it has actually decayed to.
  assert.equal(health.series[0].members, 2);
  assert.equal(health.series.at(-1).members, 2);
  assert.equal(health.worst.id, 21);
  assert.equal(health.worst.score, 0, 'two years untouched IS a strength of zero');

  // And it drags the category down, because it really is dragging it down.
  const own = computeStats(readHabit, readRows, { end: CAT_END }).score;
  assert.ok(Math.abs(health.mean - own / 2) < 1e-12,
    `mean ${health.mean} should be halved by the abandoned member, from ${own}`);
  assert.equal(health.series.at(-1).value, health.mean);

  // `recoveryExcluded` is a different count from `unloggedExcluded`, and this
  // fixture separates them: 0 against 2. Both members have a null rate for the
  // two reasons the JSDoc now names beside "never logged" — the kept habit has
  // never missed, and the abandoned one's single lapse never closes, so neither
  // has a CLOSED lapse to judge. Neither is excluded from the mean.
  assert.equal(health.unloggedExcluded, 0);
  assert.equal(health.recoveryExcluded, 2);
  assert.equal(health.recoveryRate, null);
});

test('firstEntry falls back to the entries when the caller omits it', () => {
  // The function stays usable standalone — every other test in this section
  // relies on it — and a caller holding a whole history need not restate it.
  const joinerRows = rowsOn('2026-06-16', CAT_END, YES);
  const joiner = { ...boolHabit, id: 22, name: 'Stretch', category_id: 1 };
  const health = computeCategoryStats(CATS, [
    { habit: readHabit, entries: readRows },
    { habit: joiner, entries: joinerRows },
  ], CAT_WINDOW).categories[0];

  const at = (bucket) => health.series.find((s) => s.bucket === bucket);
  assert.equal(at('2026-06-15').members, 1, 'derived from the earliest entry, not from nothing');
  assert.equal(at('2026-06-16').members, 2);
  assert.equal(health.unloggedExcluded, 0);
  assert.equal(health.members, 2);

  // An explicit `null` is a caller saying there is no entry at all, which is
  // NOT the same as omitting the key — so it must not fall back to the rows.
  const stated = computeCategoryStats(CATS, [
    { habit: readHabit, entries: readRows },
    { habit: joiner, entries: joinerRows, firstEntry: null },
  ], CAT_WINDOW).categories[0];
  assert.equal(stated.unloggedExcluded, 1);
  assert.equal(stated.series.at(-1).members, 1);
});

test('summariseMembers: a single landed member is its own best and worst', () => {
  const result = summariseMembers([{ id: 1, name: 'Read', score: 0.6, landed: true }]);
  assert.equal(result.members, 1);
  assert.equal(result.unloggedExcluded, 0);
  assert.equal(result.mean, 0.6);
  assert.deepEqual(result.best, result.worst,
    'a set of one has the same member at both ends of its spread');
  assert.equal(result.best.id, 1);
});

test('summariseMembers: every member unlanded reports null, never 0', () => {
  const result = summariseMembers([
    { id: 1, name: 'Read', score: 0, landed: false },
    { id: 2, name: 'Gym', score: 0, landed: false },
  ]);
  assert.equal(result.members, 2);
  assert.equal(result.unloggedExcluded, 2);
  assert.equal(result.mean, null, 'never logged is not a strength of zero');
  assert.notEqual(result.mean, 0);
  assert.equal(result.best, null);
  assert.equal(result.worst, null);
});

test('summariseMembers: a mixed category averages only what has landed', () => {
  const result = summariseMembers([
    { id: 1, name: 'Read', score: 0.8, landed: true },
    { id: 2, name: 'Gym', score: 0.4, landed: true },
    { id: 3, name: 'New', score: 0, landed: false },
  ]);
  assert.equal(result.members, 3);
  assert.equal(result.unloggedExcluded, 1);
  assert.ok(Math.abs(result.mean - 0.6) < 1e-9);
  assert.equal(result.best.id, 1);
  assert.equal(result.worst.id, 2);
});

test('summariseMembers: adding an unlanded member never moves mean, best or worst', () => {
  const before = summariseMembers([
    { id: 1, name: 'Read', score: 0.8, landed: true },
    { id: 2, name: 'Gym', score: 0.4, landed: true },
  ]);
  const after = summariseMembers([
    { id: 1, name: 'Read', score: 0.8, landed: true },
    { id: 2, name: 'Gym', score: 0.4, landed: true },
    { id: 3, name: 'New', score: 0, landed: false },
  ]);

  assert.equal(after.members, before.members + 1);
  assert.equal(after.unloggedExcluded, before.unloggedExcluded + 1);
  assert.equal(after.mean, before.mean,
    'a new habit must never move a figure downward');
  assert.deepEqual(after.best, before.best);
  assert.deepEqual(after.worst, before.worst);
});

test('summariseByCategory: an unknown category_id lands in Uncategorised, not dropped', () => {
  const categories = [{ id: 1, name: 'Health', color: '#fff' }];
  const payloads = [
    { id: 10, name: 'Read', score: 0.5, category_id: 1 },
    { id: 11, name: 'Gym', score: 0.9, category_id: 99 }, // names no row in `categories`
    { id: 12, name: 'Sleep', score: 0.2, category_id: null },
  ];
  const firstEntry = new Map([[10, '2026-01-01'], [11, '2026-01-01'], [12, '2026-01-01']]);
  const result = summariseByCategory(categories, payloads, firstEntry, '2026-06-01');

  const totalCounted = result.reduce((sum, section) => sum + section.members, 0);
  assert.equal(totalCounted, payloads.length,
    'every habit handed in is counted exactly once across the returned sections');

  const uncategorised = result.find((s) => s.id === null);
  assert.equal(uncategorised.members, 2,
    'the unknown-category habit joins the null-category one rather than being dropped');
});

test('summariseByCategory: Uncategorised is always present with id: null, and an empty category still gets a section', () => {
  const categories = [{ id: 1, name: 'Health', color: '#fff' }];
  const result = summariseByCategory(categories, [], new Map(), '2026-06-01');

  assert.equal(result.length, 2, 'the one known category plus Uncategorised');

  const uncategorised = result.find((s) => s.id === null);
  assert.ok(uncategorised, 'Uncategorised is present even with no members at all');
  assert.equal(uncategorised.members, 0);

  const health = result.find((s) => s.id === 1);
  assert.ok(health, 'an empty category still draws a section');
  assert.equal(health.members, 0);
});

test('summariseByCategory: a member whose firstEntry is AFTER the reading day is not landed', () => {
  // The defect this pins: `landed` used to be `firstEntry.get(h.id) != null`,
  // which asks only "does this member have an entry at all" — true for a
  // habit whose only entry is dated tomorrow relative to the day the route is
  // reading. `landedAt` (`computeCategoryStats`'s `section`) asks the RIGHT
  // question — has this member landed BY the day being read — and this must
  // match it: `first != null && first <= day`.
  const categories = [{ id: 1, name: 'Health', color: '#fff' }];
  const day = '2026-06-15';
  const payloads = [
    { id: 10, name: 'Daily', score: 0.7, category_id: 1 },
    { id: 11, name: 'Future', score: 0, category_id: 1 }, // score is 0: a
    // one-day window with no entry on it, exactly what `resolveWindow`
    // clamping `from` to `end` for an unlanded member produces.
  ];
  const firstEntry = new Map([
    [10, '2026-01-01'],
    [11, '2026-06-16'], // one day AFTER `day`
  ]);

  const result = summariseByCategory(categories, payloads, firstEntry, day);
  const health = result.find((s) => s.id === 1);

  assert.equal(health.members, 2, 'both members are counted');
  assert.equal(health.unloggedExcluded, 1,
    'the future-dated member is excluded, not averaged in at its 0 score');
  assert.equal(health.mean, 0.7,
    'the mean is over the landed member alone — averaging the future-dated ' +
    'one in at 0 would report 0.35');
  assert.equal(health.best.id, 10);
  assert.equal(health.worst.id, 10);
});

test('summariseByCategory: a member whose firstEntry EQUALS the reading day is landed', () => {
  const categories = [{ id: 1, name: 'Health', color: '#fff' }];
  const day = '2026-06-15';
  const payloads = [
    { id: 10, name: 'Daily', score: 0.7, category_id: 1 },
    { id: 11, name: 'JustLanded', score: 0.3, category_id: 1 },
  ];
  const firstEntry = new Map([
    [10, '2026-01-01'],
    [11, day], // firstEntry === day, the boundary in the other direction
  ]);

  const result = summariseByCategory(categories, payloads, firstEntry, day);
  const health = result.find((s) => s.id === 1);

  assert.equal(health.unloggedExcluded, 0, 'a member landing ON the reading day already counts');
  assert.equal(health.mean, 0.5, 'both members are averaged in: (0.7 + 0.3) / 2');
});
