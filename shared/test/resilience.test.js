import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeMissRuns, computeRecovery, computeMissDistribution,
  computeSurvival, computeResilience, computeStreaks, computeStats,
} from '../src/stats.js';

const DAILY = {
  type: 'boolean', target_value: 0, target_type: 'at_least',
  freq_numerator: 1, freq_denominator: 1,
};

const YES = 2;

/**
 * Build an entry map from a compact pattern string, one character per day
 * starting at `start`:
 *   x = done, . = missed (no row), s = skipped
 */
function pattern(str, start = '2026-01-01') {
  const map = new Map();
  const [y, m, d] = start.split('-').map(Number);
  const cursor = new Date(y, m - 1, d);

  for (const ch of str) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    if (ch === 'x') map.set(iso, { value: YES, status: '' });
    else if (ch === 's') map.set(iso, { value: 0, status: 'skip' });
    // '.' is absence, which is how "not done" is stored
    cursor.setDate(cursor.getDate() + 1);
  }
  return map;
}

/** Last date of a pattern that started at `start`. */
function endOf(str, start = '2026-01-01') {
  const [y, m, d] = start.split('-').map(Number);
  const cursor = new Date(y, m - 1, d + str.length - 1);
  return `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
}

const runs = (str) => computeMissRuns(DAILY, pattern(str), '2026-01-01', endOf(str));

/* ---------- miss runs ---------- */

test('miss runs are the mirror image of streaks', () => {
  const r = runs('xx..xxx.x');
  assert.deepEqual(r.map((x) => x.length), [2, 1]);
  assert.equal(r[0].start, '2026-01-03');
  assert.equal(r[0].end, '2026-01-04');
});

test('a skip neither starts nor breaks a miss run', () => {
  // The skip sits inside what would otherwise be one 3-day lapse. Treating it
  // as a miss would invent a failure; treating it as a success would split
  // the lapse in two. It must do neither.
  const r = runs('x.s.x');
  assert.deepEqual(r.map((x) => x.length), [3],
    'the lapse spans the skipped day as one run');
});

test('a run of skips alone produces no miss run', () => {
  assert.deepEqual(runs('xsssx'), []);
});

test('a lapse still open at the end is included', () => {
  // The most important lapse to see is the one you are in.
  const r = runs('xxx...');
  assert.deepEqual(r.map((x) => x.length), [3]);
  assert.equal(r[0].end, '2026-01-06');
});

test('a habit never completed is one long miss run', () => {
  assert.deepEqual(runs('.....').map((x) => x.length), [5]);
});

test('a perfect habit has no miss runs', () => {
  assert.deepEqual(runs('xxxxx'), []);
});

/* ---------- recovery ---------- */

const recoveryOf = (str) =>
  computeRecovery(runs(str), endOf(str));

test('recovery counts single-day lapses that were come back from', () => {
  //          .  ..   .
  const r = recoveryOf('x.xx..xx.xx');
  assert.equal(r.lapses, 3);
  assert.equal(r.recovered, 2);
  assert.equal(r.rate, 2 / 3);
});

test('an ongoing lapse is excluded rather than counted as a failure', () => {
  // Being mid-slip is not the same as having failed to recover, and counting
  // it as one would penalise a habit precisely when it needs encouragement.
  const r = recoveryOf('x.xx..');
  assert.equal(r.lapses, 1, 'only the closed lapse counts');
  assert.equal(r.recovered, 1);
  assert.equal(r.rate, 1);
  assert.equal(r.openRun, 2, 'the open lapse is reported separately');
});

test('recovery is null, not 100%, when nothing was ever missed', () => {
  // "You have never failed to recover" and "you recover every time" are
  // different claims; only the second deserves a percentage.
  const r = recoveryOf('xxxxx');
  assert.equal(r.rate, null);
  assert.equal(r.lapses, 0);
});

test('recovery is null when the only lapse is still open', () => {
  const r = recoveryOf('xxx..');
  assert.equal(r.rate, null);
  assert.equal(r.openRun, 2);
});

test('a habit that never recovers scores zero', () => {
  const r = recoveryOf('x..x...x');
  assert.equal(r.rate, 0);
  assert.equal(r.recovered, 0);
  assert.equal(r.lapses, 2);
});

/* ---------- distribution ---------- */

test('miss runs land in the right buckets', () => {
  const dist = computeMissDistribution([
    { length: 1 }, { length: 1 }, { length: 2 },
    { length: 5 }, { length: 9 }, { length: 40 },
  ]);
  const by = Object.fromEntries(dist.map((b) => [b.label, b.count]));

  assert.equal(by['1 day'], 2);
  assert.equal(by['2 days'], 1);
  assert.equal(by['3 days'], 0);
  assert.equal(by['4–6 days'], 1);
  assert.equal(by['1–2 weeks'], 1);
  assert.equal(by['2 weeks+'], 1);
});

test('bucket shares sum to one', () => {
  const dist = computeMissDistribution([{ length: 1 }, { length: 3 }, { length: 8 }]);
  const total = dist.reduce((s, b) => s + b.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, String(total));
});

test('an empty distribution has no NaN shares', () => {
  const dist = computeMissDistribution([]);
  assert.ok(dist.every((b) => b.share === 0 && b.count === 0));
});

test('every bucket boundary is covered', () => {
  // A length falling through the gaps would silently vanish from the chart.
  for (let len = 1; len <= 60; len++) {
    const dist = computeMissDistribution([{ length: len }]);
    assert.equal(dist.reduce((s, b) => s + b.count, 0), 1, `length ${len} was dropped`);
  }
});

/* ---------- survival ---------- */

const survivalOf = (str) => {
  const map = pattern(str);
  const end = endOf(str);
  return computeSurvival(computeStreaks(DAILY, map, '2026-01-01', end), end);
};

test('survival reports the share of streaks reaching each length', () => {
  // Streaks of 1, 3 and 5 days.
  const s = survivalOf('x.xxx.xxxxx.');
  const at = (d) => s.find((t) => t.days === d);

  assert.equal(at(2).reached, 2, 'two streaks reached 2 days');
  assert.equal(at(2).total, 3);
  assert.equal(at(3).reached, 2);
  assert.equal(at(5).reached, 1);
});

test('an in-progress streak is not counted as having failed a longer threshold', () => {
  // A streak on day 3 of a good run has not failed to reach 7 — it simply
  // has not got there yet, and counting it as a failure would make the curve
  // dip exactly when the habit is going well.
  const s = survivalOf('xxxxxxx.xxx');
  const at7 = s.find((t) => t.days === 7);

  assert.equal(at7.reached, 1);
  assert.equal(at7.total, 1, 'the ongoing 3-day streak is undecided at 7 days');
  assert.equal(at7.share, 1);
});

test('an ongoing streak still counts toward thresholds it has passed', () => {
  const s = survivalOf('xxxxx');
  const at3 = s.find((t) => t.days === 3);
  assert.equal(at3.reached, 1);
  assert.equal(at3.total, 1);
});

test('survival shares never exceed one and never rise with length', () => {
  const s = survivalOf('x.xx.xxxx.xxxxxxx.xx');
  for (const t of s) {
    assert.ok(t.share >= 0 && t.share <= 1, `${t.days}d share ${t.share}`);
  }
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i].reached <= s[i - 1].reached,
      `${s[i].days}d reached more than ${s[i - 1].days}d`);
  }
});

test('thresholds nothing came close to are dropped', () => {
  // A two-week-old habit should not render seven empty bars.
  const s = survivalOf('xxx.xx');
  assert.ok(s.every((t) => t.days <= 3 || t.reached > 0),
    s.map((t) => `${t.days}:${t.reached}`).join(' '));
});

test('no streaks means no curve', () => {
  assert.deepEqual(survivalOf('.....'), []);
});

/* ---------- non-daily habits ---------- */

test('resilience is marked inapplicable for a non-daily habit', () => {
  // For a 3x/week habit the four off-days are not failures. Day-level miss
  // runs would report a perfectly-kept habit as lapsing every single week,
  // which is worse than showing nothing at all.
  const gym = { ...DAILY, freq_numerator: 3, freq_denominator: 7 };
  const map = pattern('x.x.x..x.x.x..');
  const streaks = computeStreaks(gym, map, '2026-01-01', endOf('x.x.x..x.x.x..'));
  const r = computeResilience(gym, map, streaks, '2026-01-01', endOf('x.x.x..x.x.x..'));

  assert.equal(r.applicable, false);
  assert.equal(r.recovery, null);
  assert.deepEqual(r.survival, []);
});

test('a daily habit is applicable', () => {
  const map = pattern('xx.xx');
  const streaks = computeStreaks(DAILY, map, '2026-01-01', endOf('xx.xx'));
  const r = computeResilience(DAILY, map, streaks, '2026-01-01', endOf('xx.xx'));
  assert.equal(r.applicable, true);
});

/* ---------- measurable habits ---------- */

test('an at_most habit counts over-target days as misses', () => {
  const snacks = {
    type: 'numerical', target_value: 2, target_type: 'at_most',
    freq_numerator: 1, freq_denominator: 1,
  };
  const map = new Map([
    ['2026-01-01', { value: 0, status: '' }],   // under target: success
    ['2026-01-02', { value: 5, status: '' }],   // over: miss
    ['2026-01-03', { value: 1, status: '' }],   // success
  ]);
  const r = computeMissRuns(snacks, map, '2026-01-01', '2026-01-03');
  assert.deepEqual(r.map((x) => x.length), [1]);
  assert.equal(r[0].start, '2026-01-02');
});

test('a numerical value of 3 is an amount, not a skip', () => {
  // The collision that has bitten this project before: 3 is Loop's SKIP
  // sentinel but a real quantity on a measurable habit.
  const water = {
    type: 'numerical', target_value: 8, target_type: 'at_least',
    freq_numerator: 1, freq_denominator: 1,
  };
  const map = new Map([['2026-01-01', { value: 3, status: '' }]]);
  const r = computeMissRuns(water, map, '2026-01-01', '2026-01-01');
  assert.deepEqual(r.map((x) => x.length), [1],
    '3 of 8 glasses is a miss, not a skipped day');
});

/* ---------- wiring ---------- */

test('computeStats exposes resilience', () => {
  const entries = [
    { date: '2026-01-01', value: YES, status: '' },
    { date: '2026-01-02', value: YES, status: '' },
    { date: '2026-01-04', value: YES, status: '' },
  ];
  const stats = computeStats({ ...DAILY, id: 1 }, entries, { end: '2026-01-04' });

  assert.ok(stats.resilience, 'resilience is present');
  assert.equal(stats.resilience.applicable, true);
  assert.equal(stats.resilience.recovery.rate, 1, 'the single 1-day lapse was recovered');
  assert.equal(stats.resilience.worstLapse, 1);
});

test('resilience survives a habit with no entries at all', () => {
  const stats = computeStats({ ...DAILY, id: 1 }, [], { end: '2026-01-04' });
  assert.ok(stats.resilience);
  assert.equal(stats.resilience.recovery.rate, null);
  assert.deepEqual(stats.resilience.survival, []);
});

/* ---------- trailing skips ---------- */

test('a trailing skip does not close an ongoing lapse', () => {
  // Skips are transparent to computeMissRuns, so an ongoing lapse whose last
  // day is skipped ends BEFORE `end`. Deciding "open" by comparing against
  // `end` therefore misread it as closed and unrecovered: one trailing skip
  // flipped a habit from "never missed" to "0% recovery".
  const pairs = [
    ['xxx..', 'xxx..s'],
    ['x.xx..', 'x.xx..s'],
    ['xx...', 'xx...ss'],
  ];

  for (const [plain, withSkip] of pairs) {
    const a = recoveryOf(plain);
    const b = recoveryOf(withSkip);
    assert.equal(b.rate, a.rate,
      `"${withSkip}" reported rate ${b.rate}, but "${plain}" reports ${a.rate}`);
    assert.equal(b.lapses, a.lapses, `lapses differ for "${withSkip}"`);
    assert.equal(b.openRun, a.openRun, `openRun differs for "${withSkip}"`);
  }
});

test('an open run is marked as such rather than inferred from the end date', () => {
  const r = runs('xxx..s');
  const last = r[r.length - 1];
  assert.equal(last.open, true, 'the ongoing lapse must be flagged open');
  assert.ok(last.end < endOf('xxx..s'),
    'and its end is genuinely before the window end — which is why the flag is needed');
});

test('a lapse closed by a success is not open', () => {
  assert.equal(runs('x.xx')[0].open, false);
});
