import { test } from 'node:test';
import assert from 'node:assert/strict';


const { computeStreaks, dateRange, bestStreak, currentStreak, computeScores,
  computeStats, summaryStats, addDays, UNLOGGED_DEFAULT } = await import('../src/stats.js');

const YES = 2, SKIP = 3, UNSET = 0;
const boolHabit = {
  type: 'boolean', target_value: 0, target_type: 'at_least',
  freq_numerator: 1, freq_denominator: 1,
};

/** Mirrors the ranking the Best streaks chart applies. */
const topStreaks = (streaks, limit = 5) =>
  [...streaks].sort((a, b) => b.length - a.length).slice(0, limit);

test('streaks carry the dates they were achieved', () => {
  const entries = new Map([
    ['2026-01-01', YES], ['2026-01-02', YES], ['2026-01-03', YES],
    ['2026-01-04', UNSET],
    ['2026-01-05', YES],
  ]);
  const streaks = computeStreaks(boolHabit, entries, '2026-01-01', '2026-01-05');

  assert.deepEqual(streaks[0],
    { start: '2026-01-01', end: '2026-01-03', length: 3, skips: 0 });
  assert.deepEqual(streaks[1],
    { start: '2026-01-05', end: '2026-01-05', length: 1, skips: 0 });
});

test('top streaks are ranked longest first', () => {
  // Runs of 2, 5, 1, 3 separated by misses.
  const entries = new Map();
  const mark = (from, n) => {
    for (let i = 0; i < n; i++) {
      const d = new Date(2026, 0, from + i);
      entries.set(
        `2026-01-${String(d.getDate()).padStart(2, '0')}`,
        YES
      );
    }
  };
  mark(1, 2);   // Jan 1-2
  mark(5, 5);   // Jan 5-9
  mark(12, 1);  // Jan 12
  mark(15, 3);  // Jan 15-17

  const streaks = computeStreaks(boolHabit, entries, '2026-01-01', '2026-01-31');
  const top = topStreaks(streaks);

  assert.deepEqual(top.map((s) => s.length), [5, 3, 2, 1],
    'sorted by length descending');
  assert.equal(top[0].start, '2026-01-05');
  assert.equal(top[0].end, '2026-01-09');
});

test('the list is capped at the requested limit', () => {
  // Ten separate one-day streaks.
  const entries = new Map();
  for (let i = 1; i <= 20; i += 2) {
    entries.set(`2026-02-${String(i).padStart(2, '0')}`, YES);
  }
  const streaks = computeStreaks(boolHabit, entries, '2026-02-01', '2026-02-28');
  assert.ok(streaks.length > 5, `expected more than 5 streaks, got ${streaks.length}`);
  assert.equal(topStreaks(streaks, 5).length, 5);
});

test('a streak bridged by a skip reports the full span', () => {
  const entries = new Map([
    ['2026-03-01', YES], ['2026-03-02', SKIP], ['2026-03-03', YES],
  ]);
  const [streak] = computeStreaks(boolHabit, entries, '2026-03-01', '2026-03-03');
  assert.equal(streak.start, '2026-03-01');
  assert.equal(streak.end, '2026-03-03');
  assert.equal(streak.length, 3, 'span includes the skipped day');
  assert.equal(streak.skips, 1, 'and counts it as rest carried inside the run');
});

test('a skip is counted only where it lies INSIDE the run it bridged', () => {
  // The case a running total gets wrong. A skip after the last on-pace day sits
  // beyond `end`, so the run it appears to belong to never carried it. Note a
  // run is already OPEN at the skip here, so what makes this pattern come out
  // right is the reset when the run closes — the guard on banking at all is
  // pinned by the two tests below, which this one cannot reach.
  const trailing = new Map([
    ['2026-05-01', YES], ['2026-05-02', YES], ['2026-05-03', SKIP],
    ['2026-05-04', UNSET],
    ['2026-05-05', YES], ['2026-05-06', YES],
  ]);
  const runs = computeStreaks(boolHabit, trailing, '2026-05-01', '2026-05-06');
  assert.deepEqual(runs.map((s) => s.length), [2, 2]);
  assert.deepEqual(runs.map((s) => s.skips), [0, 0],
    'the skip is outside both runs: after the first ends, before the second starts');

  // ...and with the MISS moved one day later the same skip IS inside the first
  // run, because a success now follows it instead of a failure. The skip does
  // not move — 2026-05-03 in both — what moves is whether anything closed the
  // run before the skip could be banked into it. One day apart, opposite
  // answers, which is what a fixture has to straddle to pin anything.
  const inside = new Map([
    ['2026-05-01', YES], ['2026-05-02', YES], ['2026-05-03', SKIP],
    ['2026-05-04', YES],
    ['2026-05-05', UNSET],
    ['2026-05-06', YES],
  ]);
  const bridged = computeStreaks(boolHabit, inside, '2026-05-01', '2026-05-06');
  assert.deepEqual(bridged.map((s) => s.length), [4, 1]);
  assert.deepEqual(bridged.map((s) => s.skips), [1, 0]);
});

test('a skip BEFORE anything has started belongs to no run', () => {
  // The other half of "inside", and the half the fixture above structurally
  // cannot reach: there a run is already open at the skip, so the reset on
  // closing is what gives the right answer and the guard on banking is never
  // consulted. Here nothing is open yet, so only the guard can answer 0.
  //
  // What it prevents is a live misreport rather than a tidy one: seven days on
  // pace with a skip the day before them is a rest award reading "held together
  // across 1 skipped day" about a day outside the run it names.
  const leading = new Map([
    ['2026-07-01', SKIP],
    ['2026-07-02', YES], ['2026-07-03', YES], ['2026-07-04', YES],
    ['2026-07-05', YES], ['2026-07-06', YES], ['2026-07-07', YES],
    ['2026-07-08', YES],
  ]);
  const [run] = computeStreaks(boolHabit, leading, '2026-07-01', '2026-07-08');
  assert.equal(run.start, '2026-07-02', 'the run starts at the first day on pace');
  assert.equal(run.length, 7);
  assert.equal(run.skips, 0, 'the skip is before [start, end] and is not carried');
});

test('a skip in the gap between two runs is banked by neither', () => {
  // One run closes, a skip falls in the gap, another begins. The first is
  // already closed and the second has not started, so this needs the reset AND
  // the guard — it is the pattern where forgetting either shows up as rest that
  // no run took.
  const between = new Map([
    ['2026-08-01', YES], ['2026-08-02', YES], ['2026-08-03', UNSET],
    ['2026-08-04', SKIP],
    ['2026-08-05', YES], ['2026-08-06', YES],
  ]);
  const runs = computeStreaks(boolHabit, between, '2026-08-01', '2026-08-06');
  assert.deepEqual(runs.map((s) => s.length), [2, 2]);
  assert.deepEqual(runs.map((s) => s.skips), [0, 0]);
});

test('two skips inside one run are both carried', () => {
  const entries = new Map([
    ['2026-06-01', YES], ['2026-06-02', SKIP], ['2026-06-03', YES],
    ['2026-06-04', SKIP], ['2026-06-05', YES],
  ]);
  const [streak] = computeStreaks(boolHabit, entries, '2026-06-01', '2026-06-05');
  assert.equal(streak.length, 5);
  assert.equal(streak.skips, 2);
});

test('a streak spanning a year boundary keeps both dates', () => {
  const entries = new Map(
    dateRange('2026-12-28', '2027-01-04').map((d) => [d, YES])
  );
  const [streak] = computeStreaks(boolHabit, entries, '2026-12-28', '2027-01-04');
  assert.equal(streak.start, '2026-12-28');
  assert.equal(streak.end, '2027-01-04');
  assert.equal(streak.length, 8);
});

test('no completions yields no streaks', () => {
  const entries = new Map([['2026-01-01', UNSET], ['2026-01-02', UNSET]]);
  const streaks = computeStreaks(boolHabit, entries, '2026-01-01', '2026-01-02');
  assert.deepEqual(streaks, []);
  assert.deepEqual(topStreaks(streaks), [], 'empty list is safe to render');
});

test('numerical habits produce dated streaks too', () => {
  const water = {
    type: 'numerical', target_value: 8, target_type: 'at_least',
    freq_numerator: 1, freq_denominator: 1,
  };
  const entries = new Map([
    ['2026-04-01', 9], ['2026-04-02', 8], ['2026-04-03', 4], ['2026-04-04', 10],
  ]);
  const streaks = computeStreaks(water, entries, '2026-04-01', '2026-04-04');
  assert.deepEqual(streaks.map((s) => s.length), [2, 1]);
  assert.equal(streaks[0].start, '2026-04-01');
  assert.equal(streaks[0].end, '2026-04-02');
});

/* ---------- #340: a fractional requirement rounded up, not down ---------- */

// A schedule that lands on Mon/Wed/Fri passes even against the unfixed code
// (`num * activeDays / den` is a whole number every seventh day for that one
// layout), which is exactly how three existing 3x/7 tests above never saw
// this. Every case below either avoids that layout or, where it must reuse it
// (case 3), adds skips that make the rounding bite anyway.

test('a 3x/7 habit kept perfectly on Sat+Sun+Mon is one unbroken 91-day streak', () => {
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const start = '2026-01-05', end = '2026-04-05'; // Monday .. Sunday, 91 days
  const entries = new Map();
  for (const d of dateRange(start, end)) {
    const dow = new Date(d + 'T12:00:00').getDay(); // Sat=6, Sun=0, Mon=1
    if (dow === 6 || dow === 0 || dow === 1) entries.set(d, YES);
  }
  const streaks = computeStreaks(habit, entries, start, end);
  assert.deepEqual(streaks, [{ start, end, length: 91, skips: 0 }],
    'perfect adherence must not fracture into two runs depending on which ' +
    'weekday the schedule falls on');
});

test('a 5x/7 habit kept perfectly on Thu-Mon is one unbroken 91-day streak', () => {
  const habit = { ...boolHabit, freq_numerator: 5, freq_denominator: 7 };
  const start = '2026-01-05', end = '2026-04-05';
  const entries = new Map();
  for (const d of dateRange(start, end)) {
    const dow = new Date(d + 'T12:00:00').getDay(); // Thu=4 .. Mon=1, wrapping Sun=0
    if ([4, 5, 6, 0, 1].includes(dow)) entries.set(d, YES);
  }
  const streaks = computeStreaks(habit, entries, start, end);
  assert.deepEqual(streaks, [{ start, end, length: 91, skips: 0 }]);
});

test('a 3x/7 Mon/Wed/Fri habit with two skip days stays one run, and strength ' +
     'agrees with the streak about every day inside it', () => {
  // must-stay-fixed.md's invariant: a streak and a lapse are made of "on
  // pace", not "done today", so strength and streaks cannot disagree about
  // the same day. Before this fix they did here — the two skips shrank
  // `activeDays` enough that `>=` against the un-floored ratio rounded the
  // requirement up, and 2026-01-23/-24/-26 read as a lapse in the streak
  // while the score (which floors nothing, and never fixed the requirement's
  // rounding this way) kept climbing across them.
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const start = '2026-01-01', end = '2026-02-01';
  const entries = new Map();
  for (const d of dateRange(start, end)) {
    const dow = new Date(d + 'T12:00:00').getDay();
    if ([1, 3, 5].includes(dow)) entries.set(d, YES); // Mon, Wed, Fri
  }
  entries.set('2026-01-21', SKIP); // a scheduled Wednesday
  entries.set('2026-01-22', SKIP); // an unscheduled Thursday

  const streaks = computeStreaks(habit, entries, start, end);
  assert.deepEqual(streaks,
    [{ start: '2026-01-02', end: '2026-02-01', length: 31, skips: 2 }]);

  const [streak] = streaks;
  for (const d of ['2026-01-23', '2026-01-24', '2026-01-26']) {
    assert.ok(d >= streak.start && d <= streak.end,
      `${d} must fall inside the one streak — the strength/streak ` +
      'disagreement this fix closes');
  }

  // The other half of the same claim: the score never disagreed about these
  // days either, and unfixed it did — the streak called 2026-01-23/-24/-26 a
  // lapse while the score kept climbing across them. Measured on this
  // fixture: 2026-01-20 (the last day that read as on pace even before the
  // fix) scores 0.466383, then 0.507831 / 0.522427 / 0.550135 — rising, so a
  // `>` against 01-20's own score is what closes the disagreement rather than
  // pinning the EWMA's exact constants.
  const scores = computeScores(habit, entries, start, end);
  const scoreOn = (date) => scores.find((s) => s.date === date).score;
  const baseline = scoreOn('2026-01-20');
  for (const d of ['2026-01-23', '2026-01-24', '2026-01-26']) {
    assert.ok(scoreOn(d) > baseline,
      `the score on ${d} (${scoreOn(d)}) must exceed 2026-01-20's ` +
      `(${baseline}) — the streak agrees these days are on pace, so the ` +
      'score, which never stopped rising across them, must too');
  }
});

test('a 3x/7 habit whose only row is a stated lapse has no streak at all', () => {
  // The `Math.max(1, …)` guard: without it a lone `{value: 0}` row still
  // manufactures a requirement of 0 for every day around it, reporting a
  // 2-day bestStreak out of a single stated miss (#223's shape).
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const entries = new Map([['2026-01-05', UNSET]]);
  const streaks = computeStreaks(habit, entries, '2026-01-01', '2026-01-10');
  assert.deepEqual(streaks, []);
  assert.equal(bestStreak(streaks), 0);
});

test('a 3x/7 habit whose only row is a skip has no streak at all', () => {
  // The `windowDone >= 1` gate on the unfilled-window clause: ungated, a lone
  // skip still leaves `potential` high enough to call the window on pace,
  // reporting a 4-day bestStreak out of silence (#223's shape again).
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const entries = new Map([['2026-01-05', SKIP]]);
  const streaks = computeStreaks(habit, entries, '2026-01-01', '2026-01-10');
  assert.deepEqual(streaks, []);
  assert.equal(bestStreak(streaks), 0);
});

test('a 3x/7 habit done only 2 times a week has no current streak', () => {
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const start = '2026-01-01', end = '2026-03-01';
  const entries = new Map();
  for (const d of dateRange(start, end)) {
    const dow = new Date(d + 'T12:00:00').getDay();
    if ([1, 3].includes(dow)) entries.set(d, YES); // Mon+Wed only, under target
  }
  const streaks = computeStreaks(habit, entries, start, end);
  // `currentStreak` alone is 0 under both the fix and the unfixed code —
  // measured, the unfixed code produces ZERO runs at all from this fixture
  // (`[]`), because the un-floored, un-clamped ratio never falls low enough
  // for two days a week to clear it even once. It is the STRUCTURE that
  // differs: fixed, every trailing window this schedule can ever fill floors
  // to a requirement of 1, which the first Monday alone already meets, so the
  // two on-days a week accumulate into a single one-day streak instead of
  // none at all.
  assert.deepEqual(streaks,
    [{ start: '2026-01-05', end: '2026-01-05', length: 1, skips: 0 }]);
  assert.equal(currentStreak(streaks, end), 0);
});

test('daily and twice-a-day habits split at a miss exactly as before (num >= den degenerates)', () => {
  const start = '2026-01-01', end = '2026-01-10';
  const daily = { ...boolHabit }; // 1/1
  const dailyEntries = new Map(dateRange(start, end).map((d) => [d, YES]));
  dailyEntries.set('2026-01-05', UNSET);
  const dailyStreaks = computeStreaks(daily, dailyEntries, start, end);
  assert.deepEqual(dailyStreaks, [
    { start: '2026-01-01', end: '2026-01-04', length: 4, skips: 0 },
    { start: '2026-01-06', end: '2026-01-10', length: 5, skips: 0 },
  ]);

  const twiceDaily = {
    type: 'numerical', target_value: 2, target_type: 'at_least',
    freq_numerator: 2, freq_denominator: 1,
  };
  const twiceEntries = new Map(dateRange(start, end).map((d) => [d, 2]));
  twiceEntries.set('2026-01-05', 0);
  const twiceStreaks = computeStreaks(twiceDaily, twiceEntries, start, end);
  assert.deepEqual(twiceStreaks, [
    { start: '2026-01-01', end: '2026-01-04', length: 4, skips: 0 },
    { start: '2026-01-06', end: '2026-01-10', length: 5, skips: 0 },
  ]);
});

/* ---------- #340 review round 1: the leniency is sound only at a BIRTH ---------- */

// A 3x/7 habit with one row 900 days before `end`, then silence, then a
// restart 300 days before `end` kept perfectly at Mon/Wed/Fri ever since.
// `computeStats` (no `start`) opens at the habit's own lifetime first row —
// its genuine birth — so it always agreed. `summaryStats` over a bounded
// 400-day slice opens at the RESTART instead, which is not a birth: the days
// before it already happened, they are simply outside the slice the caller
// fetched. Without the gate the restart's own first six days were pro-rated
// as if the habit had no history there, adding five days nothing earned.
test('#340 review: a bounded slice must not mistake its own edge for the ' +
     'habit\'s birth — computeStats and summaryStats must agree', () => {
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const end = '2026-06-30';
  const trueBirth = addDays(end, -900);
  const restart = addDays(end, -300);

  const entries = [{ date: trueBirth, value: YES }];
  for (const d of dateRange(restart, end)) {
    const dow = new Date(d + 'T12:00:00').getDay();
    if ([1, 3, 5].includes(dow)) entries.push({ date: d, value: YES }); // Mon/Wed/Fri
  }

  // The detail view: the whole history, no `start`, opens at `trueBirth`.
  const detail = computeStats(habit, entries, { end });
  assert.equal(detail.currentStreak, 296);

  // The dashboard: a bounded 400-day slice, so the earliest row IN the slice
  // is the restart — 300 days back, well inside the fetched 400. `birth` is
  // supplied as the habit's real, LIFETIME first row (900 days back), which
  // both editions' routes read from the same `MIN(date)` query that already
  // feeds `creditAnchor`.
  const cutoff = addDays(end, -400);
  const windowed = entries.filter((e) => e.date >= cutoff);
  const dashboard = summaryStats(habit, windowed, { end, birth: trueBirth });
  assert.equal(dashboard.currentStreak, 296,
    'the dashboard must agree with the detail view about this habit (#340)');
});

// The contract test: `summaryStats` with `birth` WITHHELD. This is the same
// shape `creditFrom` already has (`resolveWindow`'s own JSDoc) — a bounded
// caller that does not supply the lifetime value gets a figure derived from
// its own slice, which is narrower than the truth and, here, simply wrong:
// the derived birth lands on the restart, which IS the slice's own edge, so
// the leniency fires there as if it were day one of the habit's life.
test('#340 review: summaryStats withholding birth is a stated contract, not a bug', () => {
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const end = '2026-06-30';
  const trueBirth = addDays(end, -900);
  const restart = addDays(end, -300);

  const entries = [{ date: trueBirth, value: YES }];
  for (const d of dateRange(restart, end)) {
    const dow = new Date(d + 'T12:00:00').getDay();
    if ([1, 3, 5].includes(dow)) entries.push({ date: d, value: YES });
  }

  const cutoff = addDays(end, -400);
  const windowed = entries.filter((e) => e.date >= cutoff);
  const withheld = summaryStats(habit, windowed, { end });
  assert.equal(withheld.currentStreak, 301,
    'withholding birth from a bounded caller is the caller\'s to get right, ' +
    'exactly as creditFrom already documents — this is the pre-#340 number');
});

// The other half: a habit whose range genuinely DOES open at its own birth
// must be entirely unaffected by this review round — reuses the Sat+Sun+Mon
// fixture from #340's own fix above, but passes `birth` explicitly (equal to
// `start`) rather than relying on the omitted-`birth` default, so this pins
// the gate's ACTIVE branch (`dates[0] === birth`) and not merely its
// backward-compatible fallback, which the pre-existing test above already
// covers.
test('#340 review: a habit whose range opens at its own birth is unaffected', () => {
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const start = '2026-01-05', end = '2026-04-05'; // Monday .. Sunday, 91 days
  const entries = new Map();
  for (const d of dateRange(start, end)) {
    const dow = new Date(d + 'T12:00:00').getDay(); // Sat=6, Sun=0, Mon=1
    if (dow === 6 || dow === 0 || dow === 1) entries.set(d, YES);
  }
  const streaks = computeStreaks(habit, entries, start, end, UNLOGGED_DEFAULT, undefined, start);
  assert.deepEqual(streaks, [{ start, end, length: 91, skips: 0 }],
    'unchanged by the birth gate — the range opens at this habit\'s own first row');
});
