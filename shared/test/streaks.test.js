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

  assert.deepEqual(streaks[0], { start: '2026-01-01', end: '2026-01-03', length: 3 });
  assert.deepEqual(streaks[1], { start: '2026-01-05', end: '2026-01-05', length: 1 });
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
