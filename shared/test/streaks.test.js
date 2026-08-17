import { test } from 'node:test';
import assert from 'node:assert/strict';


const { computeStreaks, dateRange } = await import('../src/stats.js');

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
