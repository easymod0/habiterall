import { test } from 'node:test';
import assert from 'node:assert/strict';


const { computeStreaks, dateRange, bestStreak, currentStreak, computeScores,
  computeStats, summaryStats, addDays, UNLOGGED_DEFAULT,
  computeMissRuns } = await import('../src/stats.js');

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
  // NOTHING, and the emptiness is the assertion (#346). Two completions a week
  // can never fill a group of three inside seven days — Mon, Wed and the NEXT
  // Mon span exactly 7, which `buildIntervals` rejects — so this schedule earns
  // no block anywhere and every day of it is a lapse.
  //
  // The two ways this could wrongly pass are both live options that were
  // measured and declined, so assert the whole array rather than
  // `currentStreak` alone:
  //   - Crediting a completion that earned no block (Loop's own rule, where any
  //     value > 0 is a streak day) gives SIXTEEN one-day runs here, and turns
  //     one 60-day failure into seventeen lapses of at most four days.
  //   - The trailing-window model this replaced gave exactly one one-day run,
  //     an artifact of its leniency at the range's opening edge.
  assert.deepEqual(streaks, []);
  assert.equal(currentStreak(streaks, end), 0);
  assert.equal(bestStreak(streaks), 0);
  // The lapse this habit really is: one run of it, not a scatter of short ones.
  const misses = computeMissRuns(habit, entries, start, end);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].length, 60);
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
// `computeStats` (no `start`) opens at the habit's own lifetime first row; the
// dashboard's `summaryStats` opens at the RESTART, 300 days back, because that
// is the earliest row inside the 400-day slice it fetched.
//
// #340 held these together with a birth GATE: the slice edge had to be told
// from a real birth so the trailing window's leniency could be withheld at one
// and not the other. #346 removes the need for the gate rather than tuning it —
// an interval model anchored to real completions makes coverage a pure function
// of the completions inside the walk, so the two surfaces agree by construction
// however the range was opened. The figure moved from 296 to 301 with the
// model; the PROPERTY this test exists for is the agreement, and asserting it
// three ways is what keeps a future change from restoring the disagreement
// while all three numbers drift together.
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
  assert.equal(detail.currentStreak, 301);

  // The dashboard: a bounded 400-day slice, so the earliest row IN the slice
  // is the restart — 300 days back, well inside the fetched 400. `birth` is
  // supplied as the habit's real, LIFETIME first row (900 days back), which
  // both editions' routes read from the same `MIN(date)` query that already
  // feeds `creditAnchor`.
  const cutoff = addDays(end, -400);
  const windowed = entries.filter((e) => e.date >= cutoff);
  const dashboard = summaryStats(habit, windowed, { end, birth: trueBirth });
  assert.equal(dashboard.currentStreak, 301,
    'the dashboard must agree with the detail view about this habit (#340)');

  // And the third call path, which is the one that actually bites: WITHHOLDING
  // `birth` must not move the answer either. Porting Loop's
  // `snapIntervalsTogether` verbatim failed exactly here — the slide depends on
  // which other blocks are in the list and a bounded caller has fewer, so this
  // read 302 / 301 / 301 across the three (`#346`).
  assert.equal(summaryStats(habit, windowed, { end }).currentStreak, 301,
    'coverage must be a pure function of the completions in the walk — a ' +
    'caller that supplies no birth may not get a different habit');
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

// #340 needed `birth` to carry THREE distinguishable answers into the streak —
// absent, an explicit `null` meaning "`MIN(date)` returned no row", and a real
// date — because each landed on a different branch of the trailing window's
// leniency, and folding absent into `null` with `??` handed back the leniency a
// caller had explicitly declined. #346 removes that machinery: `onPaceSeries`
// no longer reads `birth` at all, so the three must now be INDISTINGUISHABLE in
// `currentStreak`. That is the same window-independence the agreement test
// above pins, reached from the other side — there by varying the WINDOW with
// `birth` fixed, here by varying `birth` with the window fixed.
//
// `birth` is still live, and this test must not be read as saying otherwise:
// `summaryStats` reads it for the `runs` floor (#247), which is why the
// parameter stays in the chain and why both routes still fetch it.
test('#346: birth no longer moves the streak — absent, null and a real date ' +
     'are one answer', () => {
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const start = '2026-01-05', end = '2026-04-05'; // Monday .. Sunday, 91 days
  const entries = [];
  for (const d of dateRange(start, end)) {
    const dow = new Date(d + 'T12:00:00').getDay(); // Sat=6, Sun=0, Mon=1
    if (dow === 6 || dow === 0 || dow === 1) entries.push({ date: d, value: YES });
  }

  // The literal, not a constant: Sat+Sun+Mon kept perfectly for the whole 91.
  // Under the trailing window this fixture answered 91 / 85 / 85 across the
  // three, which is what made `??` a live defect; it is now 91 three times.
  assert.equal(summaryStats(habit, entries, { end }).currentStreak, 91);
  assert.equal(summaryStats(habit, entries, { end, birth: null }).currentStreak, 91,
    'an explicit null is no longer a different question from an absent one');
  assert.equal(summaryStats(habit, entries, { end, birth: '2025-01-01' }).currentStreak, 91,
    'nor is a real date earlier than the range');
  // The one that would catch `birth` creeping back in as an interval floor: a
  // birth LATER than the first completion would clip the opening block.
  assert.equal(summaryStats(habit, entries, { end, birth: '2026-02-01' }).currentStreak, 91,
    'a birth inside the range must not clip coverage either — that is the ' +
    'caller-dependence #346 removed');
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

/* ---------- #340 review round 3: how far "unaffected off-birth" reaches ---------- */

// The PR body, this file's own fix and `onPaceSeries`'s doc comment all once
// claimed that outside a habit's genuine birth this change "alters no streak,
// no miss run, no resilience figure and no `lastMiss` anywhere". That is too
// wide, and this pins the true boundary so it cannot be restated.
//
// The gate is `windowDays < den && !opensAtBirth`, so it governs the PARTIAL
// window and nothing else. A FULL window always takes the floored branch
// whatever the gate says — and there the floor is not a no-op once skips have
// pulled `activeDays` below `den`, which is this branch's own headline
// fixture. So the honest claim is about the SLICE EDGE, not about everything
// off-birth.
//
// Reuses the two-skip fixture above verbatim, with `birth` set a year before
// `start` so the gate is SHUT for every partial-window day. Master splits this
// into runs of 1 / 14 / 5; this splits it 1 / 26 — measured against
// `origin/master`, not reasoned from the branch condition, which is how the
// wide claim came to be written in the first place.
test('#340 review 3: the floor applies at a FULL window off-birth too, so the ' +
     '"unaffected outside a birth" property is about the SLICE EDGE only', () => {
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const start = '2026-01-01', end = '2026-02-01';
  const entries = new Map();
  for (const d of dateRange(start, end)) {
    const dow = new Date(d + 'T12:00:00').getDay();
    if ([1, 3, 5].includes(dow)) entries.set(d, YES); // Mon, Wed, Fri
  }
  entries.set('2026-01-21', SKIP);
  entries.set('2026-01-22', SKIP);

  const offBirth = '2025-01-01'; // a year before `start`
  const streaks = computeStreaks(
    habit, entries, start, end, UNLOGGED_DEFAULT, undefined, offBirth);

  // ONE run, and the skips are inside it. #340 reached this only at a habit's
  // genuine birth and left `1 + 26` at a slice edge; #346 has no slice-edge
  // branch to get wrong, so the skip inversion is closed in one answer rather
  // than in two that have to be kept in step.
  assert.deepEqual(streaks, [
    { start: '2026-01-02', end: '2026-02-01', length: 31, skips: 2 },
  ], 'one unbroken run — the trailing window gave 1 / 26 here and master 1 / 14 / 5');

  // The days the two skips once manufactured a lapse out of.
  const [run] = streaks;
  for (const d of ['2026-01-23', '2026-01-24', '2026-01-26']) {
    assert.ok(d >= run.start && d <= run.end,
      `${d} must sit inside the run, not be split out of it`);
  }

  // The property that replaces the gate: the SAME fixture read with no birth at
  // all must give the same answer, run for run. This is what fails if `birth`
  // is ever wired back into coverage — and it is a stronger check than the
  // literal above, which a caller-dependent floor could satisfy on one branch.
  assert.deepEqual(
    computeStreaks(habit, entries, start, end, UNLOGGED_DEFAULT, undefined, undefined),
    streaks,
    'birth may not move the streak (#346)');

  // The miss-run half, through the sibling wrapper: the skip-bridged lapse of
  // 2026-01-23..27 is gone, and so is the 2026-01-03..06 opening lapse the
  // slice-edge branch used to produce. Only the single unearned day before the
  // first completion remains.
  const missRuns = computeMissRuns(
    habit, entries, start, end, UNLOGGED_DEFAULT, undefined, offBirth);
  assert.deepEqual(missRuns.map((r) => ({ start: r.start, end: r.end })), [
    { start: '2026-01-01', end: '2026-01-01' },
  ], 'one lapse: the day before the habit had completed anything at all');
});

// The same comparison, inverted by #346. Under the trailing window these two
// readings of one fixture had to DIFFER — that difference was the birth gate's
// whole job, and this case existed to prove the gate was wired up. Under the
// interval model they must be IDENTICAL, because coverage is a function of the
// completions in the walk and of nothing else.
//
// The Sat+Sun+Mon layout is kept rather than Mon/Wed/Fri, and for the reason
// the old comment gave: Mon/Wed/Fri is FRONT-LOADED and met the old rounded-up
// requirement at every step, so it could not tell two treatments apart at a
// range's opening edge at all. Sat+Sun+Mon from a range opening on a Monday
// back-loads its first period — the next two completions do not land until days
// 6 and 7 — so it is the layout with something to lose here. It reading 91
// through both paths is therefore a real result and not a fixture that could
// not have failed.
test('#346: a slice edge and a birth are the same answer — the gate is gone', () => {
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const start = '2026-01-05', end = '2026-04-05'; // Monday .. Sunday, 91 days
  const entries = new Map();
  for (const d of dateRange(start, end)) {
    const dow = new Date(d + 'T12:00:00').getDay(); // Sat=6, Sun=0, Mon=1
    if (dow === 6 || dow === 0 || dow === 1) entries.set(d, YES);
  }

  const offBirth = computeStreaks(
    habit, entries, start, end, UNLOGGED_DEFAULT, undefined, '2025-01-01');
  const atBirth = computeStreaks(
    habit, entries, start, end, UNLOGGED_DEFAULT, undefined, start);

  // The literal, written out: 91 days unbroken, which is what perfect
  // adherence over this range is. The trailing window gave 2 + 85 off-birth.
  assert.deepEqual(atBirth, [{ start, end, length: 91, skips: 0 }]);
  assert.deepEqual(offBirth, atBirth,
    'a slice edge is not a different habit — an interval anchored to a real ' +
    'completion cannot know which day the caller opened its range on');
});

/* ---------- #247: summaryStats' opt-in `runs`, clipped and true-length ---------- */

// A daily boolean habit over 60 days: a 5-day run entirely BEFORE the window
// every case below asks for, a 40-day run straddling its left edge, and a
// 2-day run entirely INSIDE it. `runsDay(n)` is the habit's own day `n`, with
// `runsDay(60) === runsEnd`, so every literal below is a day count rather
// than a calendar date nobody could check by eye.
const runsEnd = '2026-03-01';
const runsDay = (n) => addDays(runsEnd, n - 60);
const runsEntries = [];
for (let n = 1; n <= 5; n++) runsEntries.push({ date: runsDay(n), value: YES });   // run A
for (let n = 11; n <= 50; n++) runsEntries.push({ date: runsDay(n), value: YES }); // run B
for (let n = 53; n <= 54; n++) runsEntries.push({ date: runsDay(n), value: YES }); // run C
// The window every case asks for: day 40 through the end — inside run B,
// past run A entirely, and containing run C whole.
const runsWindow = { start: runsDay(40), end: runsEnd };

test('#247 case 1: a run longer than the window clips its dates but reports ' +
     'its TRUE, unclipped length', () => {
  const stats = summaryStats(boolHabit, runsEntries, { end: runsEnd, runs: runsWindow });
  const clippedB = stats.runs.find((r) => r.length === 40);
  assert.ok(clippedB, 'the 40-day run must still be reported');
  assert.equal(clippedB.start, runsDay(40),
    'clipped to the window\'s start, not to the run\'s own start (day 11)');
  assert.equal(clippedB.end, runsDay(50));
  assert.equal(clippedB.length, 40,
    'the TRUE length — reporting the clipped 11-day span instead is the trap: ' +
    'a 2-day-reading run is exactly what a client-side MIN_STREAK gate drops');
});

test('#247 case 2: a run entirely outside the window is absent from `runs`', () => {
  const stats = summaryStats(boolHabit, runsEntries, { end: runsEnd, runs: runsWindow });
  assert.equal(stats.runs.length, 2,
    'run A (days 1-5, entirely before the window) must not be one of them');
  assert.ok(!stats.runs.some((r) => r.length === 5),
    'run A specifically must be absent, not merely outnumbered');
});

test('#247 case 3: a 2-day run is still returned — the length gate is the ' +
     'client\'s, not summaryStats\'', () => {
  const stats = summaryStats(boolHabit, runsEntries, { end: runsEnd, runs: runsWindow });
  const clippedC = stats.runs.find((r) => r.length === 2);
  assert.ok(clippedC, 'a 2-day run must still be reported here, unfiltered');
  assert.equal(clippedC.start, runsDay(53));
  assert.equal(clippedC.end, runsDay(54));
});

test('#247 case 4: a caller that passes no `runs` option gets no key at all', () => {
  const stats = summaryStats(boolHabit, runsEntries, { end: runsEnd });
  assert.equal('runs' in stats, false,
    'absent, not `undefined` and not `[]` — the same convention `lastMiss` sets');
});

// Cases 1-3 all ask for a window ending at `runsEnd`, so no run of theirs ever
// runs PAST the window's far end and `clipRuns`' right-hand clip is never
// exercised: delete `end: streak.end > to ? to : streak.end` and all four pass.
// That branch is what a PAGED-BACK dashboard reaches on every load — the grid's
// `end` is then strictly inside a run that continues to today — so it is not an
// edge case, it is the ordinary paged request, and only the two editions'
// integration suites were holding it. A window with run B open at BOTH ends is
// what pins both clips at once.
// A BOUNDED slice — which is the only kind either `/overview` hands this — is
// judged by `onPaceSeries` against a trailing window that is missing real
// history for its first `den - 1` days, with #340's leniency correctly withheld
// because the range did not open at the habit's birth. The verdict there is not
// lenient or strict but WRONG, and `runs` is the one field that would draw it.
// Measured against the unguarded code, this exact fixture: two runs,
// `[day401..day404] length 4` and `[day406..] length 395`, with day 405 a HOLE —
// a blank square mid-band on the dashboard while the calendar, which sees the
// whole history, strokes through the same day.
test('#247 case 6: a slice that opens AFTER the habit\'s birth draws no run in ' +
     'the days its own edge makes unreliable', () => {
  const thrice = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const end = '2026-03-01';
  const day = (n) => addDays(end, n - 500);
  // Kept perfectly: exactly 3 in every trailing 7 days, for 500 days.
  const all = [];
  for (let n = 1; n <= 500; n++) if (n % 7 === 1 || n % 7 === 3 || n % 7 === 5) {
    all.push({ date: day(n), value: YES });
  }
  const birth = all[0].date;
  // What the route hands it: the last 100 days only, birth supplied from SQL.
  const slice = all.filter((e) => e.date >= day(401));
  const stats = summaryStats(thrice, slice, {
    end, birth, runs: { start: day(395), end: day(410) },
  });

  assert.equal(stats.runs.length, 1,
    'ONE run, not a fragment and a hole — the slice edge must not split a run '
    + 'the habit\'s own page reports unbroken');
  // **An EQUALITY, and the day is 408 rather than 407** (#346's review round).
  // This read `>= day(407)`, and both halves of that were wrong: `>=` cannot
  // tell the floor from a floor one day short, and the arithmetic behind 407
  // assumed `from` is the slice's nominal first day. It is not — `summaryStats`
  // takes no `start` here, so `resolveWindow` derives `from` from the EARLIEST
  // ENTRY in the slice, and day 401 carries no entry (`401 % 7 === 2`, where
  // this fixture logs on 1, 3 and 5). `from` is day 402, so the floor is
  // 402 + 7 - 1 = day 408. Pinned exactly, because a boundary asserted with an
  // inequality is a boundary that moves without telling anyone.
  assert.equal(stats.runs[0].start, day(408),
    `nothing may be drawn before the first trustworthy day — the slice's own `
    + `earliest ENTRY (day 402) + 7 - 1; got ${stats.runs[0].start}`);

  // The other half, and the one that stops the guard being "return []": a slice
  // that DID open at the habit's birth keeps its early days, because it has no
  // missing history to be wrong about.
  //
  // **Asserted as an EQUALITY on the birth day, and that is the whole point of
  // the case** (#346's review round). It read `some((r) => r.start <= day(7))`,
  // which is satisfied by `day(7)` itself — exactly the value an unconditional
  // `addDays(from, den - 1)` produces — so deleting the `birth` gate from
  // `edgeSafeStart` left the entire suite green. The habit's first three
  // completions are days 1, 3 and 5, a span of 5 inside 7, so the block they
  // earn opens on day 1 and the run must start THERE.
  const fromBirth = summaryStats(thrice, all, {
    end, birth, runs: { start: day(1), end: day(20) },
  });
  assert.equal(fromBirth.runs[0].start, day(1),
    'a range opening at the birth is not floored at all — not floored to the '
    + 'same day the floor would have chosen');
});

test('#247 case 5: a window INSIDE a run is clipped at both ends, and the ' +
     'length is still the run\'s own', () => {
  const inside = { start: runsDay(20), end: runsDay(30) };
  const stats = summaryStats(boolHabit, runsEntries, { end: runsEnd, runs: inside });
  assert.equal(stats.runs.length, 1,
    'only run B (days 11-50) spans this window; A ended at 5 and C starts at 53');
  assert.equal(stats.runs[0].start, runsDay(20), 'clipped UP to the window start');
  assert.equal(stats.runs[0].end, runsDay(30), 'clipped DOWN to the window end');
  assert.equal(stats.runs[0].length, 40,
    'still the whole run — 11 days of it are visible and 40 is what a client '
    + 'gates on, so an 11 here is a run that would survive MIN_STREAK anyway '
    + 'and tells you nothing; the mutation to watch is case 1\'s');
});

/* ---------- #346: the interval model itself ---------- */

// A block is earned by `num` completions landing inside `den` days, and it runs
// FORWARD from the oldest of them — so the days between check-offs are held by
// the block rather than being drawn as holes. These cases pin the construction
// directly, because everything above reads it only through a streak.

test('#346: completions inside one period earn a block that covers the gap ' +
     'days between them', () => {
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  // Mon, Wed, Fri of one week: three completions spanning 4 days, inside 7.
  const entries = new Map([
    ['2026-01-05', YES], ['2026-01-07', YES], ['2026-01-09', YES],
  ]);
  const streaks = computeStreaks(habit, entries, '2026-01-05', '2026-01-11');
  // The whole period, not the three check-off days: 2026-01-06, -08, -10 and
  // -11 are unlogged and inside the block the three completions bought.
  assert.deepEqual(streaks,
    [{ start: '2026-01-05', end: '2026-01-11', length: 7, skips: 0 }]);
});

test('#346: completions spread WIDER than the period earn nothing', () => {
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  // The same three completions, one day further apart each: Mon, Thu, Sun is a
  // span of 7, which is one day too wide to be a single period.
  const entries = new Map([
    ['2026-01-05', YES], ['2026-01-08', YES], ['2026-01-12', YES],
  ]);
  assert.deepEqual(computeStreaks(habit, entries, '2026-01-05', '2026-01-12'), [],
    'a span of exactly `den` is a lapse — the `< den` test is not `<= den`, ' +
    'and widening it makes the previous case indistinguishable from this one');
});

// The reported fixture, written out as dates rather than derived, so the case
// that motivated #346 is readable against the screenshot it came from. A 4x/7
// habit logged Aug 25, 26, 27, 29, Sep 1, 5, 6, 9, 10, 14, 15, 16.
test('#346: the reported 4x/7 habit reads as two runs, not five fragments', () => {
  const habit = { ...boolHabit, freq_numerator: 4, freq_denominator: 7 };
  const entries = new Map();
  for (const d of ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-29',
                   '2026-09-01', '2026-09-05', '2026-09-06', '2026-09-09',
                   '2026-09-10', '2026-09-14', '2026-09-15', '2026-09-16']) {
    entries.set(d, YES);
  }
  const streaks = computeStreaks(habit, entries, '2026-08-25', '2026-09-18');

  // The trailing window gave three fragments over this stretch — 08-29..09-01
  // (4), 09-10..09-11 (2) and 09-15..09-16 (2) — with 09-07, 09-08, 09-12 and
  // 09-13 drawn as holes inside days the habit was being kept at its own rate.
  assert.deepEqual(streaks, [
    { start: '2026-08-25', end: '2026-09-01', length: 8, skips: 0 },
    { start: '2026-09-05', end: '2026-09-16', length: 12, skips: 0 },
  ]);

  // The days the user reported as wrongly blank, named one by one so a
  // regression says WHICH day came back rather than only that a length moved.
  const held = new Set();
  for (const s of streaks) {
    for (let d = s.start; d <= s.end; d = addDays(d, 1)) held.add(d);
  }
  for (const d of ['2026-09-07', '2026-09-08', '2026-09-11',
                   '2026-09-12', '2026-09-13']) {
    assert.ok(held.has(d), `${d} is inside a kept period and must be held`);
  }
  // And the genuine gap between the two runs stays a gap: 09-02..09-04 has no
  // period that reaches it, so this is not "cover everything".
  for (const d of ['2026-09-02', '2026-09-03', '2026-09-04']) {
    assert.ok(!held.has(d), `${d} earned no block and must stay a lapse`);
  }
});

test('#346: a skipped day lowers what its period demands, and an unlogged ' +
     'one does not', () => {
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const start = '2026-01-01', end = '2026-01-07';

  // Two completions and three skips: the period asks about four active days,
  // so it demands floor(3 x 4 / 7) = 1, which two completions clear.
  const skipped = new Map([
    ['2026-01-01', YES], ['2026-01-03', YES],
    ['2026-01-04', SKIP], ['2026-01-05', SKIP], ['2026-01-06', SKIP],
  ]);
  assert.deepEqual(computeStreaks(habit, skipped, start, end),
    [{ start, end, length: 7, skips: 3 }]);

  // The same two completions with those three days merely unlogged: seven
  // active days demand three, and two is short. Collapsing the skip count into
  // the requirement makes these two fixtures agree, which is the mutation.
  const unlogged = new Map([['2026-01-01', YES], ['2026-01-03', YES]]);
  assert.deepEqual(computeStreaks(habit, unlogged, start, end), []);
});

test('#346: coverage does not depend on where the caller opened its range', () => {
  const habit = { ...boolHabit, freq_numerator: 3, freq_denominator: 7 };
  const end = '2026-04-05';
  const entries = new Map();
  for (const d of dateRange('2026-01-05', end)) {
    const dow = new Date(d + 'T12:00:00').getDay();
    if ([6, 0, 1].includes(dow)) entries.set(d, YES); // Sat+Sun+Mon, back-loaded
  }

  const holds = (from, day) => computeStreaks(habit, entries, from, end)
    .some((s) => s.start <= day && day <= s.end);

  // The same habit read from three different opening days, all of them more
  // than `den` days before the day being probed. Every one must agree — this is
  // the property Loop's `snapIntervalsTogether` broke when it was ported
  // verbatim, and it broke it by ONE day, which no length assertion at a single
  // opening would have caught.
  assert.deepEqual(
    ['2026-01-05', '2026-02-01', '2026-03-01'].map((from) => holds(from, '2026-03-20')),
    [true, true, true],
    'a day inside a kept run is inside it however the range was opened');

  // And the boundary that is REAL, asserted rather than left to look like the
  // same thing failing: a range opening ON the day cannot see the completions
  // whose block would cover it, so the first `den - 1` days of any bounded
  // slice are under-covered. That is what `edgeSafeStart` floors, for
  // `summaryStats`' `runs` (#247) and for `computeCategoryStats`' recovery
  // axis (#346's review round).
  assert.equal(holds('2026-03-20', '2026-03-20'), false,
    'the slice-edge shortfall is a known bound, not window-dependence — ' +
    'widening this assertion to `true` would be claiming the model sees ' +
    'rows the caller never fetched');

  // `den - 1` days of lead-in is SUFFICIENT, and that is the whole claim — it
  // is not the tight boundary for this fixture and an earlier version of this
  // comment said it was. Measured here, `2026-03-16` (four days of lead-in)
  // already holds, because where the shortfall actually ends depends on where
  // this habit's completions fall and not on `den` alone. `edgeSafeStart` is
  // the SAFE bound rather than the tight one for exactly that reason: it is
  // the only one derivable without reading the rows a bounded caller does not
  // have. So assert sufficiency at `den - 1` and insufficiency at 0, and claim
  // nothing in between.
  assert.equal(holds(addDays('2026-03-20', -(7 - 1)), '2026-03-20'), true,
    '`den - 1` days of lead-in is always enough — the literal is derived from ' +
    'the habit\'s own denominator so a frequency change cannot leave this ' +
    'asserting a span that no longer means anything');
});
