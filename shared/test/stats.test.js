import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  computeStreaks, currentStreak, bestStreak, computeHistory,
  computeWeekdays, computeFrequency, computeScores, computeStats, isCompleted,
  dateRange, boundedRange, addDays, daysBetween, MAX_RANGE_DAYS,
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

const map = (obj) => new Map(Object.entries(obj));

/* ---------- date helpers ---------- */

test('dateRange is inclusive of both ends', () => {
  assert.deepEqual(dateRange('2026-01-01', '2026-01-04'),
    ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
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
