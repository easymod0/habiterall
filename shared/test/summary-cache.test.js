import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STREAK_HISTORY_DAYS, SUMMARY_CACHE_COLUMNS, stripSummaryCache,
  summaryCacheHit, recomputeBestStreak,
} from '../src/summary-cache.js';

/** The day every case below asks for its figures as of. */
const TODAY = '2026-06-05';

/** A habit row as storage hands it over, with a VALID cached pair on it. */
const cached = (over = {}) => ({
  id: 7,
  name: 'Coffee',
  type: 'numerical',
  target_type: 'at_most',
  target_value: 2,
  at_most_unlogged: 'success',
  best_streak: 12,
  total_completed: 40,
  summary_asof: TODAY,
  ...over,
});

test('STREAK_HISTORY_DAYS is 1830', () => {
  // The literal, not the imported name: the window is part of what the cached
  // figure MEANS, and a test comparing the constant against itself would pass
  // with the bound widened under both editions' feet.
  assert.equal(STREAK_HISTORY_DAYS, 1830);
});

test('a pair stamped for the caller\'s own day is a hit', () => {
  assert.equal(summaryCacheHit(cached(), TODAY), true);
});

test('a pair stamped TOMORROW is a miss', () => {
  // The two-timezone trap, and the reason `summaryCacheHit` compares with
  // `!==` and never `<`. `summaryEnd` is the CALLER's day, so an account used
  // from two zones either side of a date boundary can move it BACKWARDS — and
  // a `<` test would then serve a device west of the last one a pair built for
  // a day that has not happened there yet, all day.
  assert.equal(summaryCacheHit(cached({ summary_asof: '2026-06-06' }), TODAY), false);

  // The other side of the same comparison: a pair from yesterday is a miss
  // too, which is the case a `<` test gets right and is therefore no evidence
  // on its own.
  assert.equal(summaryCacheHit(cached({ summary_asof: '2026-06-04' }), TODAY), false);
});

test('a null stamp is a miss even though the figures are still on the row', () => {
  // Invalidation clears the STAMP alone — `UPDATE habits SET summary_asof =
  // NULL` — so an out-of-date pair sits on the row beside it. Asking only
  // "are the two figures present?" serves that pair forever.
  assert.equal(summaryCacheHit(cached({ summary_asof: null }), TODAY), false);
});

test('a matching stamp with a missing figure is a miss', () => {
  assert.equal(summaryCacheHit(cached({ best_streak: null }), TODAY), false);
  assert.equal(summaryCacheHit(cached({ total_completed: null }), TODAY), false);
  assert.equal(summaryCacheHit(cached({ best_streak: undefined }), TODAY), false);

  // A genuine zero is an ANSWER — a habit nobody has ever completed — and must
  // not read as "never computed". That collapse is what nullable columns and a
  // separate stamp exist to prevent.
  assert.equal(summaryCacheHit(cached({ best_streak: 0, total_completed: 0 }), TODAY), true);
});

test('an empty stamp is a miss, and is one against an empty day too', () => {
  assert.equal(summaryCacheHit(cached({ summary_asof: '' }), TODAY), false);

  // The assertion that carries this test. Against a real day the first line
  // holds however the function is written — `''` is simply not `'2026-06-05'`
  // — so the non-empty clause is only falsifiable against a caller that lost
  // its own day. `''` equalling `''` must not be a hit: neither side is a date,
  // and a pair served for no day at all is served forever.
  assert.equal(summaryCacheHit(cached({ summary_asof: '' }), ''), false);

  // Same shape, a driver rather than a bad write: anything that is not a
  // string cannot be compared against a day and is a miss.
  assert.equal(summaryCacheHit(cached({ summary_asof: new Date(TODAY) }), TODAY), false);
});

test('a falsy row is a miss rather than a throw', () => {
  assert.equal(summaryCacheHit(null, TODAY), false);
  assert.equal(summaryCacheHit(undefined, TODAY), false);
});

test('stripSummaryCache removes exactly the three keys', () => {
  const row = cached();
  const out = stripSummaryCache(row);

  assert.deepEqual(out, {
    id: 7,
    name: 'Coffee',
    type: 'numerical',
    target_type: 'at_most',
    target_value: 2,
    // Named close enough to the three to be caught by a filter that matches on
    // shape rather than on the list — and it is a habit FIELD, which the three
    // are not: losing it changes what an unanswered day is worth.
    at_most_unlogged: 'success',
  });
  assert.deepEqual(SUMMARY_CACHE_COLUMNS,
    ['best_streak', 'total_completed', 'summary_asof']);

  // Non-destructive: both editions serialise a derivative of a row they are
  // still reading the cached pair off.
  assert.equal(row.best_streak, 12);
  assert.equal(row.total_completed, 40);
  assert.equal(row.summary_asof, TODAY);

  assert.equal(stripSummaryCache(null), null);
  assert.equal(stripSummaryCache(undefined), undefined);
});

/** A daily boolean habit. */
const boolHabit = {
  type: 'boolean', target_value: 0, target_type: 'at_least',
  freq_numerator: 1, freq_denominator: 1,
};

/** A daily limit — the shape whose unanswered days can count as kept. */
const limitHabit = {
  type: 'numerical', target_value: 0, target_type: 'at_most',
  freq_numerator: 1, freq_denominator: 1, at_most_unlogged: 'default',
};

test('recomputeBestStreak over no entries at all scans the single day summaryEnd', () => {
  assert.equal(
    recomputeBestStreak(boolHabit, [], { summaryEnd: TODAY, unlogged: 'miss' }),
    0
  );

  // A limit whose silence counts as compliance: `summaryEnd` itself is one
  // day kept, and exactly one. Anything wider than `[summaryEnd, summaryEnd]`
  // as the fallback start reports more.
  assert.equal(
    recomputeBestStreak(limitHabit, [], { summaryEnd: TODAY, unlogged: 'success' }),
    1
  );
});

test('recomputeBestStreak honours creditFrom on a limit whose first answer is recent', () => {
  // #223. The habit's only rows are a skip in January — which STATES nothing —
  // and a real answer on 1 June. Under `success` every unanswered day before
  // that answer would otherwise read as the limit being kept, so the scan must
  // not credit silence until the habit has answered once.
  const entries = [
    { date: '2026-01-01', value: 0, status: 'skip' },
    { date: '2026-06-01', value: 0, status: '' },
  ];

  const best = recomputeBestStreak(limitHabit, entries, {
    summaryEnd: TODAY,
    unlogged: 'success',
    // What the route resolves from the account's LIFETIME first stated answer
    // (`creditAnchor`), handed in rather than re-derived from this slice.
    creditFrom: '2026-06-01',
  });

  // 1–5 June: the answer, then four silent days that DO count now. Not 155,
  // which is 2 January to 5 June — what the same scan reports with the credit
  // date dropped.
  assert.equal(best, 5);
});
