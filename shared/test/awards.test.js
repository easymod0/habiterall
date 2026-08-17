import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMEBACK_FRESH_DAYS, STRENGTH_BAND, computeAwards,
} from '../src/awards.js';
import {
  SURVIVAL_THRESHOLDS, computeRecovery, computeStats,
} from '../src/stats.js';

const DAILY = {
  type: 'boolean', target_value: 0, target_type: 'at_least',
  freq_numerator: 1, freq_denominator: 1,
};

const YES = 2;

/**
 * Entries from a compact pattern, one character per day starting at `start`:
 *   x = done, . = missed (no row), 0 = a stated lapse (a row holding 0),
 *   s = skipped
 *
 * The same shape `resilience.test.js` uses, deliberately: these are readings of
 * the numbers that file pins, so the two should be arguing about the same
 * histories.
 */
function entries(str, start = '2026-01-01') {
  const out = [];
  const [y, m, d] = start.split('-').map(Number);
  const cursor = new Date(y, m - 1, d);

  for (const ch of str) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    if (ch === 'x') out.push({ date: iso, value: YES, status: '' });
    else if (ch === '0') out.push({ date: iso, value: 0, status: '' });
    else if (ch === 's') out.push({ date: iso, value: 0, status: 'skip' });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function endOf(str, start = '2026-01-01') {
  const [y, m, d] = start.split('-').map(Number);
  const cursor = new Date(y, m - 1, d + str.length - 1);
  return `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
}

/** Awards for a pattern, through the real `computeStats`. */
function awardsFor(str, habit = DAILY, opts = {}) {
  const end = endOf(str);
  const stats = computeStats(habit, entries(str), { end, ...opts });
  return computeAwards(stats, end);
}

const byFamily = (list) => Object.fromEntries(list.map((a) => [a.family, a]));

/* ---------- streaks ---------- */

test('a streak award is a rung of the survival ladder, never a new number', () => {
  // 8 days on pace: past the 7 rung, short of 14.
  const a = byFamily(awardsFor('xxxxxxxx'));
  assert.equal(a.streak.value, 7);
  assert.equal(a.streak.label, '7-day streak');
  assert.ok(SURVIVAL_THRESHOLDS.includes(a.streak.value));

  // And only the rung reached — nine badges for one fact is one fact nine
  // times, and the survival chart beside it is the better answer to "next".
  assert.equal(awardsFor('xxxxxxxx').filter((x) => x.family === 'streak').length, 1);
});

test('every streak award is a rung, across every history length', () => {
  for (let days = 0; days <= 40; days++) {
    const list = awardsFor('x'.repeat(days) || '.');
    for (const a of list.filter((x) => x.family === 'streak')) {
      assert.ok(SURVIVAL_THRESHOLDS.includes(a.value),
        `${a.id} is not on the ladder`);
      assert.ok(a.value <= days, `${a.id} claims more than ${days} days`);
    }
  }
});

test('a run shorter than the lowest rung earns nothing', () => {
  assert.equal(byFamily(awardsFor('x')).streak, undefined);
});

test('the streak award is read from the BEST run, not the current one', () => {
  // Thirty on pace, then a fortnight off: `currentStreak` is 0 and the award
  // must survive it. A badge tied to the current run un-earns itself on the day
  // the run ends, which is the single most demotivating thing this could do.
  const str = 'x'.repeat(30) + '.'.repeat(14);
  const end = endOf(str);
  const stats = computeStats(DAILY, entries(str), { end });

  assert.equal(stats.currentStreak, 0);
  assert.equal(byFamily(computeAwards(stats, end)).streak.value, 30);
});

/* ---------- strength ---------- */

test('the strength award is the PEAK of the curve, not today\'s score', () => {
  // Two perfect months (>94% by the pinned curve), then two months of nothing.
  const str = 'x'.repeat(60) + '.'.repeat(60);
  const end = endOf(str);
  const stats = computeStats(DAILY, entries(str), { end });

  assert.ok(stats.score < STRENGTH_BAND,
    `the current score should have decayed below the band, got ${stats.score}`);
  const a = byFamily(computeAwards(stats, end));
  assert.ok(a.strength, 'a high-water mark must survive the decay');
  assert.equal(a.strength.value, 50);
});

test('a habit that never reached the band earns no strength award', () => {
  // One day in nine: the score never gets near 50%.
  const str = 'x........'.repeat(6);
  const stats = computeStats(DAILY, entries(str), { end: endOf(str) });
  assert.ok(Math.max(...stats.scores.map((s) => s.score)) < STRENGTH_BAND);
  assert.equal(byFamily(computeAwards(stats, endOf(str))).strength, undefined);
});

test('the band is where the pinned curve says a fortnight of keeping it is', () => {
  // `test/stats.test.js` pins a perfect daily habit at ~50% on day 13. The band
  // is calibrated to that and not to intuition, so it must be reachable there
  // and not before.
  assert.equal(byFamily(awardsFor('x'.repeat(13))).strength?.value, 50);
  assert.equal(byFamily(awardsFor('x'.repeat(11))).strength, undefined);
});

/* ---------- resilience ---------- */

test('nothing ever missed earns no resilience award, and no 100%', () => {
  const list = awardsFor('x'.repeat(20));
  const a = byFamily(list);
  assert.equal(a.comeback, undefined);
  assert.equal(a.recovered, undefined);
  assert.equal(a.lapses, undefined);
  // `rate === null` means undefined, not perfect — nothing may render it.
  for (const x of list) assert.doesNotMatch(x.detail + x.label, /100%|null|NaN/);
});

test('a one-day lapse is counted, not decorated with a second award', () => {
  const a = byFamily(awardsFor('xxxxx.xxxxx'));
  assert.equal(a.recovered.value, 1);
  // "Back after 1 day" says exactly what "Recovered 1 time" already said.
  assert.equal(a.comeback, undefined);
});

test('the comeback tier is the longest lapse CLOSED, not the current one', () => {
  // A five-day hole climbed out of, then two days into a fresh one.
  const a = byFamily(awardsFor('xxxxx.....xxxxxxxxxx..'));
  assert.equal(a.comeback.value, 5);
  assert.match(a.comeback.label, /Back after 5 days/);
});

test('a lapse you have not come out of yet is not a comeback', () => {
  // Five days into the first one this habit has ever had. `worstLapse` is 5 and
  // is the obvious-looking source; it counts the open run, and reading it here
  // would congratulate somebody on a slip they are still in.
  const str = 'x'.repeat(10) + '.....';
  const stats = computeStats(DAILY, entries(str), { end: endOf(str) });
  assert.equal(stats.resilience.worstLapse, 5);

  const a = byFamily(computeAwards(stats, endOf(str)));
  assert.equal(a.comeback, undefined);
  assert.equal(a.recovered, undefined);
  assert.equal(a.lapses, undefined);
});

test('being mid-slip neither earns a comeback nor takes one away', () => {
  const closed = byFamily(awardsFor('xxxxx....xxxxx')).comeback;
  const openToo = byFamily(awardsFor('xxxxx....xxxxx.......')).comeback;
  assert.equal(closed.value, 4);
  assert.equal(openToo.value, 4, 'an ongoing lapse must not move the tier');
});

test('a comeback is fresh for a week and then is not', () => {
  // One lapse, then `n` days back on pace: the marker is the only "you just
  // earned this" pure derivation can offer, so its boundary is worth pinning.
  const after = (n) =>
    byFamily(awardsFor('x'.repeat(10) + '.' + 'x'.repeat(n))).recovered;

  assert.equal(after(1).fresh, true);
  assert.equal(after(COMEBACK_FRESH_DAYS).fresh, true);
  assert.equal(after(COMEBACK_FRESH_DAYS + 1).fresh, false);

  // The award itself is untouched by the marker expiring — it is the emphasis
  // that fades, never the badge.
  assert.equal(after(COMEBACK_FRESH_DAYS + 1).value, after(1).value);
});

test('"no lapse over a day" needs more than one lapse to be a claim', () => {
  assert.equal(byFamily(awardsFor('xxxxx.xxxxx')).lapses, undefined);
  const a = byFamily(awardsFor('xxxxx.xxxxx.xxxxx'));
  assert.equal(a.lapses.value, 2);
  assert.equal(a.lapses.label, 'No lapse over a day');
});

test('"no lapse over a day" counts the lapse you are IN', () => {
  // Every CLOSED lapse here lasted one day — `recovery.rate` is 1 — while the
  // habit is three days into a fourth. Reading the closed set would print "no
  // lapse over a day" over a lapse the user is currently in.
  const str = 'xxxxx.xxxxx.xxxxx...';
  const stats = computeStats(DAILY, entries(str), { end: endOf(str) });
  assert.equal(stats.resilience.recovery.rate, 1);
  assert.equal(byFamily(computeAwards(stats, endOf(str))).lapses, undefined);
});

test('a two-day lapse ends the claim, and says so as a record', () => {
  const a = byFamily(awardsFor('xxxxx.xxxxx.xxxxx'));
  assert.equal(a.lapses.permanent, false, 'this one can be lost, and must say so');
  assert.equal(byFamily(awardsFor('xxxxx.xxxxx..xxxxx')).lapses, undefined);
});

/* ---------- what `computeRecovery` now reports ---------- */

test('computeRecovery reports the longest closed lapse and when it ended', () => {
  const runs = [
    { start: '2026-01-02', end: '2026-01-02', length: 1, open: false },
    { start: '2026-01-10', end: '2026-01-14', length: 5, open: false },
    { start: '2026-01-20', end: '2026-01-20', length: 1, open: false },
    { start: '2026-01-28', end: '2026-01-31', length: 4, open: true },
  ];
  const r = computeRecovery(runs, '2026-01-31');
  assert.equal(r.longest, 5, 'the open run must not be the longest');
  assert.equal(r.lastEnd, '2026-01-20');
  assert.equal(r.openRun, 4);
});

test('computeRecovery reports no longest and no date when nothing has closed', () => {
  const r = computeRecovery([], '2026-01-31');
  assert.equal(r.longest, 0);
  assert.equal(r.lastEnd, null);
  assert.equal(r.rate, null);
});

/* ---------- the property the whole design rests on ---------- */

test('a permanent award is never taken away as history grows', () => {
  // The reason `permanent` is on the payload at all. Nothing is stored, so an
  // award exists for exactly as long as the numbers say — which is only safe
  // while the numbers it is read from cannot go down. Asserted as the invariant
  // rather than by example: walk one history a day at a time and require that
  // no family ever disappears and no value ever drops.
  //
  // `is-record` awards are exempt by construction: that is what the flag means.
  const history =
    'xxxxxxxxxxxx.xxxxxxxx..xxxxxxxxxxxxxxxxxxxxx.....xxxxxxxxxxxxxxxxxx'
    + '.xxxxxxxxxxxxxxx...xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

  const seen = new Map();

  for (let n = 1; n <= history.length; n++) {
    const slice = history.slice(0, n);
    const end = endOf(slice);
    const list = computeAwards(computeStats(DAILY, entries(slice), { end }), end);
    const today = byFamily(list.filter((a) => a.permanent));

    for (const [family, previous] of seen) {
      assert.ok(today[family], `day ${n}: the ${family} award was taken away`);
      assert.ok(today[family].value >= previous,
        `day ${n}: ${family} fell from ${previous} to ${today[family].value}`);
    }
    for (const a of Object.values(today)) seen.set(a.family, a.value);
  }

  assert.ok(seen.size >= 3, `expected several families to be exercised, got ${seen.size}`);
});

test('every award carries a label, a detail and no placeholder', () => {
  const list = awardsFor('xxxxx.....xxxxxxxxxx.xxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxx');
  assert.ok(list.length >= 3, `expected a full row, got ${list.length}`);
  for (const a of list) {
    assert.ok(a.id && a.family && a.label && a.detail, JSON.stringify(a));
    assert.doesNotMatch(a.label + ' ' + a.detail, /undefined|NaN|null|Infinity/);
    assert.equal(typeof a.permanent, 'boolean');
    assert.equal(typeof a.fresh, 'boolean');
  }
  // A plural that reads as machine output is how a number stops being trusted.
  assert.doesNotMatch(list.map((a) => a.detail).join(' '), /\b1 (days|times|lapses)\b/);
});

test('a stats response from before this shipped yields no awards', () => {
  assert.deepEqual(computeAwards(null, '2026-01-01'), []);
  assert.deepEqual(computeAwards({}, '2026-01-01'), []);
  assert.deepEqual(computeAwards({ bestStreak: 0, scores: [] }, '2026-01-01'), []);
});

/* ---------- the two habit shapes that read differently ---------- */

const LIMIT = {
  type: 'numerical', target_value: 0, target_type: 'at_most',
  freq_numerator: 1, freq_denominator: 1,
};

test('an at-most habit earns from stated lapses, and a slip is a lapse', () => {
  // For a limit, `x` in the patterns above would be an amount over the target,
  // so build it the other way up: a row holding 0 is a clean day and a row
  // holding 1 is a slip.
  const days = 40;
  const rows = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(2026, 0, 1 + i);
    const iso = `2026-01-${String(d.getDate()).padStart(2, '0')}`;
    if (d.getMonth() !== 0) break;
    rows.push({ date: iso, value: i === 12 ? 1 : 0, status: '' });
  }
  const end = rows[rows.length - 1].date;
  const stats = computeStats(LIMIT, rows, { end });
  const a = byFamily(computeAwards(stats, end));

  assert.ok(a.streak, 'a run of clean days is a streak');
  assert.equal(a.recovered.value, 1, 'the day over the limit is a lapse recovered from');
  // The vocabulary has to be true of a limit as well as of a goal. "Lapse",
  // "streak" and "strength" are what the cards either side of this already say
  // about the same habit, so no award is worded the other way up.
  for (const x of Object.values(a)) {
    assert.doesNotMatch(x.label + ' ' + x.detail, /completed|done|times done/i);
  }
});

test('what an unlogged day is worth reaches awards without a second opinion', () => {
  // A limit nobody has ever logged. Under the account default (`miss`) there is
  // nothing to award; under `success` the streak, the strength and the history
  // bar all say the habit is being kept — documented, deliberate, and the
  // awards have to AGREE with the tiles beside them rather than hold a view of
  // their own about silence.
  const habit = { ...LIMIT, at_most_unlogged: 'success' };
  const rows = [{ date: '2026-01-01', value: 0, status: '' }];

  const missed = computeStats({ ...habit, at_most_unlogged: 'miss' }, rows,
    { end: '2026-02-15' });
  const kept = computeStats(habit, rows, { end: '2026-02-15' });

  assert.equal(byFamily(computeAwards(missed, '2026-02-15')).streak, undefined);

  const a = byFamily(computeAwards(kept, '2026-02-15'));
  assert.equal(a.streak.value, 30, 'the award must match the streak on the tile');
  assert.equal(a.streak.value <= kept.bestStreak, true);
  assert.ok(a.strength, 'and the strength band the curve reached');
});

test('an avoided habit is judged on what is stored, not on how it is shown', () => {
  // `show_as` decides the rendering and nothing else — losing it must lose a
  // display preference and no verdict. So the two must award identically.
  const rows = [];
  for (let i = 1; i <= 28; i++) {
    rows.push({
      date: `2026-01-${String(i).padStart(2, '0')}`,
      value: i === 9 || i === 10 ? 1 : 0, status: '',
    });
  }
  const shown = computeAwards(
    computeStats({ ...LIMIT, show_as: 'avoid' }, rows, { end: '2026-01-28' }), '2026-01-28');
  const stored = computeAwards(
    computeStats({ ...LIMIT, show_as: 'amount' }, rows, { end: '2026-01-28' }), '2026-01-28');

  assert.deepEqual(shown, stored);
  assert.equal(byFamily(shown).comeback.value, 2, 'two days over the limit is a two-day lapse');
});
