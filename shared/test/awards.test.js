import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  COMEBACK_FRESH_DAYS, STRENGTH_BANDS, computeAwards,
} from '../src/awards.js';

const STRENGTH_BAND = STRENGTH_BANDS[0];
import {
  SURVIVAL_THRESHOLDS, addDays, computeRecovery, computeStats, daysBetween,
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
  // The top band, reached two months in and kept even though today's score is
  // below the lowest one.
  assert.equal(a.strength.value, 95);
});

test('a habit that never reached the band earns no strength award', () => {
  // One day in nine: the score never gets near 50%.
  const str = 'x........'.repeat(6);
  const stats = computeStats(DAILY, entries(str), { end: endOf(str) });
  assert.ok(Math.max(...stats.scores.map((s) => s.score)) < STRENGTH_BAND);
  assert.equal(byFamily(computeAwards(stats, endOf(str))).strength, undefined);
});

test('the strength ladder shows the rung reached, and only that one', () => {
  // The same answer the streak ladder gives. A row of greyed-out bands is how a
  // months-long goal turns into a daily reminder of falling short, and the
  // strength curve at the top of the page already shows how far there is to go.
  const bands = (days) =>
    awardsFor('x'.repeat(days)).filter((a) => a.family === 'strength').map((a) => a.value);

  assert.deepEqual(bands(13), [50]);
  assert.deepEqual(bands(35), [80]);
  assert.deepEqual(bands(75), [95]);
});

test('every strength award is a band, never an arbitrary percentage', () => {
  const pcts = STRENGTH_BANDS.map((b) => Math.round(b * 100));
  for (let days = 0; days <= 90; days += 3) {
    for (const a of awardsFor('x'.repeat(days) || '.')) {
      if (a.family !== 'strength') continue;
      assert.ok(pcts.includes(a.value), `${a.id} is not a band`);
      assert.equal(a.label, `${a.value}% strength`);
    }
  }
});

test('the bands land where the curve puts them: a fortnight, a month, two months', () => {
  // Measured against the real curve rather than asserted from intuition — the
  // first draft of this test had 80% arriving on day 30 and 95% on day 60, and
  // both were wrong by a day and by three days respectively. Pinned exactly on
  // both sides of each crossing, so a change to Loop's decay constant fails
  // here as well as in `test/stats.test.js`, and so "95% is a months-long goal"
  // is a fact about the arithmetic rather than a claim in a comment.
  const bandAt = (days) =>
    awardsFor('x'.repeat(days)).find((a) => a.family === 'strength')?.value ?? 0;

  assert.equal(bandAt(12), 0);
  assert.equal(bandAt(13), 50);
  assert.equal(bandAt(30), 50);
  assert.equal(bandAt(31), 80);
  assert.equal(bandAt(56), 80);
  assert.equal(bandAt(57), 95);
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

test('a comeback is fresh for seven days and stale on the eighth', () => {
  // One lapse, then `n` days back on pace. Asserted against LITERALS: an
  // earlier version wrote `after(COMEBACK_FRESH_DAYS)`, which pins the
  // off-by-one and nothing else — changing the constant to 30 left every
  // assertion true while the comment claimed the boundary was pinned.
  const after = (n) =>
    byFamily(awardsFor('x'.repeat(10) + '.' + 'x'.repeat(n))).recovered;

  assert.equal(after(1).fresh, true);
  assert.equal(after(7).fresh, true);
  assert.equal(after(8).fresh, false);
  assert.equal(COMEBACK_FRESH_DAYS, 7, 'the constant and the boundary are one fact');

  // The award itself is untouched by the marker expiring — it is the emphasis
  // that fades, never the badge.
  assert.equal(after(8).value, after(1).value);
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

test('a two-day lapse ends the claim, and the wording says "so far"', () => {
  const a = byFamily(awardsFor('xxxxx.xxxxx.xxxxx'));
  // This one is falsified by the next bad week with no window movement at all,
  // so the sentence has to carry that rather than a flag on the payload.
  assert.match(a.lapses.detail, /so far/);
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

/* ---------- the two "ever" claims ---------- */

test('a full week needs all seven weekdays, and one short is not one', () => {
  // Seven consecutive days cover every weekday whichever day they start on.
  assert.equal(byFamily(awardsFor('x'.repeat(7))).week?.value, 7);
  assert.equal(byFamily(awardsFor('x'.repeat(6))).week, undefined);
});

test('a rigid weekly schedule does not earn a full week, and that is not a gate', () => {
  // `computeWeekdays` counts COMPLETIONS and not pace, so a 3x/week habit kept
  // exactly on Mon/Wed/Fri has four weekdays at zero. It is a claim that is
  // false rather than a habit shape being excluded — which is why the award is
  // "at least once" and not a rate across all seven, a test no non-daily habit
  // could ever pass.
  const gym = {
    type: 'boolean', target_value: 0, target_type: 'at_least',
    freq_numerator: 3, freq_denominator: 7,
  };
  const rows = [];
  for (let i = 0; i < 84; i++) {
    const d = new Date(2026, 0, 1 + i);
    if (![1, 3, 5].includes(d.getDay())) continue;
    rows.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      value: YES, status: '',
    });
  }
  const end = '2026-03-31';
  const stats = computeStats(gym, rows, { end });
  assert.ok(stats.bestStreak > 30, 'the habit is being kept, on pace');
  assert.deepEqual(stats.weekdays.map((d) => d.completed > 0),
    [false, true, false, true, false, true, false], 'four weekdays at zero');

  const a = byFamily(computeAwards(stats, end));
  assert.ok(a.streak, 'so it earns a streak');
  assert.equal(a.week, undefined, 'but it has never been done at a weekend');

  // Going once on each of the four is all it takes, which is what makes this a
  // claim about a schedule rather than a gate on the habit's frequency.
  for (const date of ['2026-03-22', '2026-03-24', '2026-03-26', '2026-03-28']) {
    rows.push({ date, value: YES, status: '' });
  }
  assert.ok(byFamily(computeAwards(computeStats(gym, rows, { end }), end)).week);
});

test('the long haul is measured from the first run\'s START, not its end', () => {
  // The fixtures straddle the boundary on purpose. An earlier version used a
  // 10-day first run, so start-to-end was 399 and end-to-end 390 — both over
  // 365, and measuring from the wrong end of the first run passed every
  // assertion. A 40-day first run puts the two answers either side of a year,
  // which is the distinction that makes this not `created_at`.
  const long = 'x'.repeat(40) + '.'.repeat(330) + 'x'.repeat(10);
  const a = byFamily(awardsFor(long));
  assert.equal(a.tenure.value, 1);
  assert.equal(a.tenure.label, 'A year of keeping it');
  assert.equal(daysBetween('2026-01-01', endOf(long)), 379, 'first run START to last end');
  assert.equal(daysBetween(addDays('2026-01-01', 39), endOf(long)), 340,
    'first run END to last end — under a year, so it must not be what is used');

  assert.equal(byFamily(awardsFor('x'.repeat(10) + '.'.repeat(300) + 'x'.repeat(10))).tenure,
    undefined);

  // Straddling the two-year boundary the same way: 739 days from the start,
  // 700 from the end of the first run.
  const longer = 'x'.repeat(40) + '.'.repeat(690) + 'x'.repeat(10);
  assert.equal(byFamily(awardsFor(longer)).tenure.label, '2 years of keeping it');
});

test('a habit that has simply never broken is not described as two runs', () => {
  const a = byFamily(awardsFor('x'.repeat(400)));
  assert.equal(a.tenure.value, 1);
  assert.equal(a.tenure.detail, 'One unbroken run, 400 days long.');
  assert.doesNotMatch(a.tenure.detail, /first|most recent|apart/);
});

test('a habit created a year ago and abandoned in week one does not earn it', () => {
  // The distinction from reading a creation date, and the reason the span is
  // read from the streaks instead. The window here is over a year wide; the
  // habit was kept for a week of it.
  const stats = computeStats(DAILY, entries('x'.repeat(7)), { end: '2027-03-01' });
  assert.ok(daysBetween('2026-01-01', '2027-03-01') > 365, 'the window is over a year');
  assert.equal(byFamily(computeAwards(stats, '2027-03-01')).tenure, undefined);
});

test('the long haul does not move as time passes without new entries', () => {
  const str = 'x'.repeat(10) + '.'.repeat(380) + 'x'.repeat(10);
  const rows = entries(str);
  const at = (end) => byFamily(computeAwards(computeStats(DAILY, rows, { end }), end)).tenure;

  const earned = at(endOf(str));
  assert.equal(earned.value, 1);
  // Six months later, nothing recorded: the award is a statement about what
  // happened and cannot be undone by the calendar moving.
  assert.equal(at(addDays(endOf(str), 180)).value, 1);
});

/* ---------- what an award can and cannot promise ---------- */

test('AN AWARD CAN BE TAKEN AWAY: logging an older day lowers a non-daily one', () => {
  // The counterexample that killed this module's first organising rule, which
  // was "only a monotone reading may be dressed as a trophy". `bestStreak` is a
  // maximum and does only go up for a FIXED window — but the window is not
  // fixed. `computeStats` starts at `start ?? firstEntry`, and `onPaceSeries`
  // pro-rates the requirement near that start so a habit is not judged against
  // history it does not have. Move the earliest entry earlier and the first
  // `den - 1` days are re-judged against a full requirement they now fail.
  //
  // So remembering one forgotten session — an ordinary, virtuous thing to do —
  // takes the badge DOWN. Pinned as behaviour, not as a bug to fix here: the
  // leniency is deliberate and correct, and it is the permanence claim that was
  // wrong. See issue #141 for the ledger that would change the answer.
  const gym = {
    type: 'boolean', target_value: 0, target_type: 'at_least',
    freq_numerator: 3, freq_denominator: 7,
  };
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const rows = [];
  for (let i = 0; i < 21; i++) {
    const d = new Date(2026, 6, 6 + i);
    if ([1, 3, 5].includes(d.getDay())) rows.push({ date: iso(d), value: YES, status: '' });
  }
  const end = '2026-07-26';

  const before = computeStats(gym, rows, { end });
  assert.equal(before.bestStreak, 21);
  assert.equal(byFamily(computeAwards(before, end)).streak.value, 21);

  // One session, a week before the habit's first stored day.
  rows.unshift({ date: '2026-06-28', value: YES, status: '' });

  const after = computeStats(gym, rows, { end });
  // Pinned exactly, not just "lower": 21 -> 17 is the figure the module header
  // and the CLAUDE.md section both quote, and a documented number that no test
  // holds is a number free to drift away from its prose.
  assert.equal(after.bestStreak, 17, 'the measured drop, 21 -> 17');
  assert.equal(byFamily(computeAwards(after, end)).streak.value, 14);
});

test('AN AWARD CAN VANISH WITH NO USER ACTION: the window slides', () => {
  // The second mechanism, and this one needs nobody to do anything at all.
  // `MAX_RANGE_DAYS` clamps the window start to `end - 3660`, so a habit with
  // any row older than ten years has a SLIDING window rather than a growing
  // one, and awards shrink as the calendar moves.
  const rows = [{ date: '2010-01-01', value: YES, status: '' }];
  for (let i = 0; i < 120; i++) {
    const d = new Date(2026, 0, 1 + i);
    rows.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      value: YES, status: '',
    });
  }
  const comebackAt = (end) =>
    byFamily(computeAwards(computeStats(DAILY, rows, { end }), end)).comeback?.value ?? 0;

  const now = comebackAt('2026-08-17');
  const later = comebackAt('2030-08-17');
  assert.ok(now > 0 && later > 0, `expected a comeback at both ends, got ${now} and ${later}`);
  assert.ok(later < now,
    `the comeback should have SHRUNK as the window slid: ${now} then ${later}`);
});

test('...and the two "ever" claims go the same way, at their own dates', () => {
  // The counterexamples the comments on those two awards now cite by date. A
  // claim written in a comment and checked nowhere is how the retracted rule
  // survived in this very file after the commit that retracted it.
  //
  // Rows in 2014 and 2016 only, so `MAX_RANGE_DAYS` walks over both blocks.
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const rows = [];
  for (const year of [2014, 2016]) {
    for (let i = 0; i < 30; i++) rows.push({ date: iso(new Date(year, 0, 1 + i)), value: YES, status: '' });
  }
  const at = (end) => {
    const s = computeStats(DAILY, rows, { end });
    return {
      ids: computeAwards(s, end, DAILY, 'miss').map((a) => a.id),
      weekdaysKept: s.weekdays.filter((d) => d.completed > 0).length,
    };
  };

  // Tenure dies first — it is the only award that reads the OLD end of the
  // history, so it goes as soon as the first run falls out of the window.
  assert.ok(at('2024-01-01').ids.includes('tenure:2'));
  assert.ok(!at('2024-06-01').ids.includes('tenure:2'),
    'tenure should be gone once the 2014 block slid out');
  assert.ok(at('2024-06-01').ids.includes('week:full'),
    'while everything else is still there');

  // The full week goes when the last row does, and the seven weekdays with it.
  assert.equal(at('2026-01-01').weekdaysKept, 7);
  assert.ok(at('2026-01-01').ids.includes('week:full'));
  assert.equal(at('2026-06-01').weekdaysKept, 0);
  assert.deepEqual(at('2026-06-01').ids, [], 'the card empties itself entirely');
});

test('a daily habit whose earliest entry does not move keeps what it shows', () => {
  // The narrow claim that survives, stated with both of its preconditions,
  // because it is the ordinary case and a regression in it would be real.
  // DAILY means `num >= den`, so `onPaceSeries` has no leniency window; a fixed
  // first entry means `from` does not move; and 130 days is far inside
  // MAX_RANGE_DAYS, so the clamp never engages. Take away any of the three and
  // the two tests above apply instead.
  const history =
    'xxxxxxxxxxxx.xxxxxxxx..xxxxxxxxxxxxxxxxxxxxx.....xxxxxxxxxxxxxxxxxx'
    + '.xxxxxxxxxxxxxxx...xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

  const seen = new Map();
  // Excluded by name: it is a claim about the whole record, so the next bad
  // week ends it whatever the window does. That is not the property under test.
  const RECORD = 'lapses';

  for (let n = 1; n <= history.length; n++) {
    const slice = history.slice(0, n);
    const end = endOf(slice);
    const list = computeAwards(computeStats(DAILY, entries(slice), { end }), end);
    const today = byFamily(list.filter((a) => a.family !== RECORD));

    for (const [family, previous] of seen) {
      assert.ok(today[family], `day ${n}: the ${family} award was taken away`);
      assert.ok(today[family].value >= previous,
        `day ${n}: ${family} fell from ${previous} to ${today[family].value}`);
    }
    for (const a of Object.values(today)) seen.set(a.family, a.value);
  }

  assert.ok(seen.size >= 3, `expected several families to be exercised, got ${seen.size}`);
});

test('no award claims permanence on the wire', () => {
  // The flag said which awards could not be taken away, and the answer is none
  // of them. A field that is false for every member is not a distinction, and
  // on the wire it is a claim a client could act on.
  for (const a of awardsFor('xxxxx.....xxxxxxxxxx.xxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxx')) {
    assert.ok(!('permanent' in a), `${a.id} still carries a permanence claim`);
  }
});

test('every award carries a label, a detail and no placeholder', () => {
  const list = awardsFor('xxxxx.....xxxxxxxxxx.xxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxx');
  assert.ok(list.length >= 3, `expected a full row, got ${list.length}`);
  for (const a of list) {
    assert.ok(a.id && a.family && a.label && a.detail, JSON.stringify(a));
    assert.doesNotMatch(a.label + ' ' + a.detail, /undefined|NaN|null|Infinity/);
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

/**
 * Source with comments removed, so a comment cannot be mistaken for code.
 *
 * The guard below reads `api.js` as text, and the first version of it matched
 * the raw file — which a COMMENT naming the call shape defeated completely. A
 * comment in these files' own house style, with the real call stripped back to
 * two arguments, passed 38 of 38. That is the worst kind of test: it fails only
 * when someone is not trying, and the thing it exists to catch is silent.
 *
 * Strings are tracked so a `//` inside one is not read as a comment. Regex
 * literals are not, because neither file has one — every `/**` in them opens a
 * JSDoc block, which this handles — and a scanner that guessed at regex-vs-
 * division would be more likely to be wrong than the thing it is protecting
 * against. `stripsComments` below pins the behaviour either way.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (two === '/*') {
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== '*/') i++;
      i += 2;
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      out += ch; i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') { out += src[i]; i++; }
        if (i < src.length) { out += src[i]; i++; }
      }
      out += src[i] ?? ''; i++;
      continue;
    }
    out += ch; i++;
  }
  return out;
}

/** The argument text of every `name(...)` call in `src`, comments removed. */
function callsIn(src, name) {
  const code = stripComments(src);
  const calls = [];
  for (const m of code.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
      i++;
    }
    calls.push(code.slice(from, i - 1));
  }
  return calls;
}

/** The argument text of every `computeAwards(...)` call, comments removed. */
const awardCallsIn = (src) => callsIn(src, 'computeAwards');

test('the comment stripper is not fooled by the two things it must not be', () => {
  // A test on the test, because everything below trusts it.
  // Asserted on substance rather than on whitespace: the stripper leaves the
  // space that sat before a comment, and pinning that exactly would make this
  // a test about spacing.
  assert.doesNotMatch(stripComments('a // computeAwards(x)\nb'), /computeAwards/);
  assert.doesNotMatch(stripComments('a /* computeAwards(x) */ b'), /computeAwards/);
  assert.match(stripComments('a // gone\nb'), /a\s*\nb/, 'code either side survives');
  // A `//` inside a string is not a comment, and losing the rest of that line
  // would silently delete real code.
  assert.match(stripComments('const u = "http://x//y"; // gone'),
    /const u = "http:\/\/x\/\/y";/);
  assert.doesNotMatch(stripComments('const u = "http://x//y"; // gone'), /gone/);
  assert.equal(awardCallsIn('// computeAwards(stats, end, habit, unlogged)\n'
    + 'computeAwards(stats, end);').length, 1, 'a comment is not a call site');
});

test('both editions hand the gate its inputs, or it silently does nothing', () => {
  // `computeAwards(stats, end)` still returns a full card — the habit and the
  // unlogged setting are optional, because a caller that has neither should get
  // awards rather than an exception. That makes forgetting them silent: the
  // suppression simply never fires, on the one shape it exists for.
  //
  // Read from the source, as `api-surface.test.js` reads the routes: mounting
  // either edition's api.js needs a database.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const edition of ['habiterall-personal', 'habiterall-cloud']) {
    const src = readFileSync(join(root, edition, 'src', 'api.js'), 'utf8');
    const calls = awardCallsIn(src);

    // EVERY call site, not the first one. Checking only the first let a second,
    // ungated `computeAwards(...)` ship in the same file — and a route added
    // later is exactly how that would happen.
    assert.equal(calls.length, 1,
      `${edition} has ${calls.length} computeAwards call sites, expected 1: `
      + calls.join(' | '));

    const args = calls[0].split(',').map((s) => s.trim());
    assert.equal(args.length, 5,
      `${edition} calls computeAwards with ${args.length} arguments: ${calls[0]}`);
    assert.equal(args[2], 'habit', `${edition} passes ${args[2]} as the habit`);
    assert.equal(args[3], 'unlogged', `${edition} passes ${args[3]} as the setting`);
    // The fifth is the same trap one argument further along: `skipDays` is
    // optional, so dropping it turns the rest award off for every account in
    // that edition and nothing anywhere else changes.
    assert.equal(args[4], 'skipDays', `${edition} passes ${args[4]} as skipDays`);

    // And it must be the SAME value computeStats was given, or the gate and the
    // arithmetic answer different questions about one habit.
    assert.match(stripComments(src), /computeStats\([\s\S]{0,400}?unlogged[,\s}]/,
      `${edition} does not hand the same unlogged to computeStats`);

    // `skipDays` is not one of computeStats' inputs — the arithmetic has no
    // opinion about it — so what has to be checked instead is that the name is
    // bound to something and not to a literal. A hard-coded `true` passes every
    // assertion above and hands the award to everybody.
    //
    // This is the WEAKEST check in the file and is deliberately kept anyway.
    // It matches the file rather than the binding that reaches the call, so a
    // misspelt JSON key (`settings ->> 'skipdays'`, the alias unchanged) and an
    // inverted comparison both slip past it, and no regex over source text can
    // close that. What closes it is behaviour: each edition has an integration
    // test that sets the setting through its own API and asserts the award
    // appears and disappears — `test:awards` in personal, the `--- awards ---`
    // block in cloud's API suite. This one catches the different thing those
    // cannot, which is a call site that never reads a setting at all.
    assert.match(stripComments(src), /skipDays\s*[:=][^;\n]*(storedSkipDays|skip_days)/,
      `${edition} does not derive skipDays from the account's setting`);

    // The other route calls `computeStats` too and throws all but four fields
    // away, which is why `coverage` is declinable and why `/overview` declines
    // it. Pinned by COUNT as well as by content: a third call site added later
    // would otherwise pay for a pass nothing on that route reads, silently and
    // once per habit.
    const statsCalls = callsIn(src, 'computeStats');
    assert.equal(statsCalls.length, 2,
      `${edition} has ${statsCalls.length} computeStats call sites, expected 2 `
      + `(/stats and /overview): ${statsCalls.join(' | ')}`);
    const declining = statsCalls.filter((c) => /coverage\s*:\s*false/.test(c));
    assert.equal(declining.length, 1,
      `${edition} should have exactly one computeStats call declining coverage, `
      + `found ${declining.length}`);
    // ...and it must be the one that is NOT feeding awards, or the badge is
    // withheld from the only route that shows it.
    assert.ok(!/granularity/.test(declining[0]),
      `${edition} declined coverage on the route that computes awards: ${declining[0]}`);
  }
});

test('the Award typedef lists every family the file can actually produce', () => {
  // `family` is typed `string`, so a stale union costs nothing at typecheck —
  // which is exactly how 'coverage' and 'rest' were added without it. The doc
  // comment is the only place a reader learns what the families are, so it is
  // enumerated against the code rather than trusted.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = readFileSync(join(root, 'shared', 'src', 'awards.js'), 'utf8');

  const produced = [...src.matchAll(/\bfamily:\s*'([a-z]+)'/g)].map((m) => m[1]);
  const doc = src.slice(
    src.indexOf('@typedef {object} Award'),
    src.indexOf('@property {string} label')
  );
  const documented = [...doc.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

  assert.ok(produced.length >= 9, `expected the full set, found ${produced.length}`);
  assert.deepEqual([...new Set(documented)].sort(), [...new Set(produced)].sort());
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
  assert.ok(a.week, 'and forty clean days cover every weekday');
  // The vocabulary has to be true of a limit as well as of a goal. "Lapse",
  // "streak" and "strength" are what the cards either side of this already say
  // about the same habit, so no award is worded the other way up.
  for (const x of Object.values(a)) {
    assert.doesNotMatch(x.label + ' ' + x.detail, /completed|done|times done/i);
  }
});

test('a limit whose silence counts as kept earns nothing, though its tiles fill', () => {
  // The one place awards decline to agree with the figures beside them.
  //
  // Under `success` an unanswered day counts as kept, so a limit with a single
  // stored row grows a streak, a strength and a full weekday spread purely as
  // `end` walks forward. That is right for a TILE, which states a number. It is
  // wrong for a BADGE, which says "You have kept this on all seven weekdays at
  // least once" in English, about a habit logged once — a sentence its owner
  // knows to be false. The figures are untouched and still shown; only the
  // claims are withheld.
  const habit = { ...LIMIT, at_most_unlogged: 'success' };
  const rows = [{ date: '2026-01-01', value: 0, status: '' }];
  const end = '2026-02-15';

  const kept = computeStats(habit, rows, { end });
  assert.equal(kept.bestStreak, 46, 'the tile really does claim the whole window');
  assert.ok(kept.weekdays.every((d) => d.completed > 0), 'and every weekday is "kept"');

  assert.deepEqual(computeAwards(kept, end, habit, 'miss'), [],
    'yet the card is empty, because every badge would be a false sentence');

  // The gate is the habit-level override beating the account's, resolved by
  // `unansweredCounts` and not restated here. Same habit, account saying
  // `success`, habit saying `miss`: the arithmetic changes and so does the card.
  const strict = { ...LIMIT, at_most_unlogged: 'miss' };
  const missed = computeStats(strict, rows, { end });
  const m = byFamily(computeAwards(missed, end, strict, 'success'));
  assert.equal(m.streak, undefined, 'one answered day is not a streak');
  assert.equal(m.week, undefined);
});

test('a habit saying "default" lets the ACCOUNT decide, both ways', () => {
  // The configuration `parseHabit` stores for every habit, and therefore the
  // one most accounts are actually in — and the case an inline re-implementation
  // of the gate gets wrong. `habit.at_most_unlogged === 'success'` looks like
  // the whole rule and is false here: the habit says `'default'`, so the
  // ACCOUNT's `success` is what applies and the card must be empty.
  const rows = [{ date: '2026-01-01', value: 0, status: '' }];
  const end = '2026-02-15';

  for (const own of ['default', undefined]) {
    const habit = { ...LIMIT, at_most_unlogged: own };
    const kept = computeStats(habit, rows, { end, unlogged: 'success' });
    assert.equal(kept.bestStreak, 46, `${own}: the arithmetic followed the account`);
    assert.deepEqual(computeAwards(kept, end, habit, 'success'), [],
      `${own}: the gate must follow the account too`);
  }

  // The other direction: the account says the strict thing, so a limit with a
  // real logged history earns normally even though the habit named nothing.
  const logged = [];
  for (let i = 0; i < 40; i++) {
    const d = new Date(2026, 0, 1 + i);
    logged.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      value: i === 12 ? 1 : 0, status: '',
    });
  }
  const habit = { ...LIMIT, at_most_unlogged: 'default' };
  const strictEnd = logged[logged.length - 1].date;
  const s = computeStats(habit, logged, { end: strictEnd, unlogged: 'miss' });
  assert.ok(computeAwards(s, strictEnd, habit, 'miss').length > 0,
    'nothing is withheld when silence is a miss');
});

test('the gate is at-most only, and a real history on a limit still earns', () => {
  // `unansweredCounts` is false for a boolean habit and for any at-least one,
  // so nothing else is touched by the carve-out — including an at-least habit
  // carrying `at_most_unlogged: 'success'`, which is reachable because the
  // field outlives a switch of goal type.
  const atLeast = {
    type: 'numerical', target_value: 1, target_type: 'at_least',
    freq_numerator: 1, freq_denominator: 1, at_most_unlogged: 'success',
  };
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const d = new Date(2026, 0, 1 + i);
    rows.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      value: 1, status: '',
    });
  }
  assert.ok(computeAwards(computeStats(atLeast, rows, { end: endOf('x'.repeat(40)) }),
    endOf('x'.repeat(40)), atLeast, 'success').length > 0);

  // And a limit whose days are actually answered is unaffected: it resolves to
  // `miss`, which is the account default.
  const limitRows = rows.map((r) => ({ ...r, value: 0 }));
  assert.ok(computeAwards(computeStats(LIMIT, limitRows, { end: endOf('x'.repeat(40)) }),
    endOf('x'.repeat(40)), LIMIT, 'miss').length > 0);
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

/* ---------- coverage: the award about ANSWERING ---------- */

/**
 * A full month of rows, minus the days listed. `kind` decides what the rows
 * SAY, which coverage must be indifferent to.
 */
function fullMonth(month, { missing = [], skip = [], lapse = [] } = {}) {
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

const coverageAward = (rows, end, ...rest) => {
  const stats = computeStats(DAILY, rows, { end });
  return byFamily(computeAwards(stats, end, DAILY, 'miss', ...rest)).coverage;
};

test('a month with an answer on every day earns it, and one blank day does not', () => {
  // The fixture straddles the boundary by a DAY and not by a month: the same
  // January either side, differing in one row. A version of this with a covered
  // month and an EMPTY month would pass against `answered > 0`, which is the
  // fixture mistake #137's tenure award was written up for.
  const full = coverageAward(fullMonth('2026-01'), '2026-01-31');
  assert.equal(full.value, 1);
  assert.equal(full.label, 'A month with no blanks');
  assert.match(full.detail, /Every day of 1 month/);

  assert.equal(coverageAward(fullMonth('2026-01', { missing: [17] }), '2026-01-31'),
    undefined, 'one unanswered day in thirty-one is not a covered month');
});

test('a lapse and a skip are answers; the missing row is not', () => {
  // The whole reason this award is worth having. A month where a third of the
  // days went badly and every one of them was recorded is a covered month —
  // which is the badge that is reachable when the habit is not going well, and
  // the behaviour the app's data depends on.
  const bad = fullMonth('2026-01', {
    lapse: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
    skip: [22, 24, 26],
  });
  assert.equal(coverageAward(bad, '2026-01-31').value, 1);

  // ...and it is the ROW that counts, so removing one of the bad days — the
  // ones the user had least reason to log — takes the badge away.
  const quiet = bad.filter((r) => r.date !== '2026-01-10');
  assert.equal(coverageAward(quiet, '2026-01-31'), undefined);
});

test('the month in progress cannot earn it, and the last day of a month can', () => {
  // #146's monotonicity requirement, settled by containment and no second rule:
  // the badge cannot appear on the 3rd and be gone on the 4th, because on the
  // 3rd March is not a month this window contains.
  const rows = [...fullMonth('2026-02'), ...fullMonth('2026-03')];

  assert.equal(coverageAward(rows, '2026-03-03').value, 1, 'February only');
  assert.equal(coverageAward(rows, '2026-03-30').value, 1, 'still February only');
  assert.equal(coverageAward(rows, '2026-03-31').value, 2,
    'March closes and is counted on its last day');
  assert.equal(coverageAward(rows, '2026-03-31').label, '2 months with no blanks');
});

test('the habit\'s own first, partial month is never held against it', () => {
  // Created on the 10th, answered every day since. January can never be covered
  // and is not reported as uncovered either — a figure unreachable by
  // construction is not a rung, it is a permanently unlit badge.
  const rows = [...fullMonth('2026-01').slice(9), ...fullMonth('2026-02')];
  const a = coverageAward(rows, '2026-02-28');
  assert.equal(a.value, 1);
  assert.equal(a.label, 'A month with no blanks');
});

test('the coverage detail is a claim about the window, not about all time', () => {
  const rows = [...fullMonth('2026-01'), ...fullMonth('2026-02')];
  const a = coverageAward(rows, '2026-02-28');
  assert.equal(a.value, 2);
  assert.match(a.detail, /here/, 'the sentence has to be scoped to the window');
  assert.doesNotMatch(a.detail, /\bever\b|\balways\b|completed|done/i);
});

test('coverage is withheld by the at-most gate, as every award here is', () => {
  // Checked rather than assumed, and the conclusion is written up in
  // `computeAwards`: coverage counts ROWS, so `success` — which credits days
  // that have none — cannot flatter it, and the sentence would be true outside
  // the gate too. It is still inside it, because the gate is one rule about one
  // habit shape and a per-award exemption is a second one to keep in step. What
  // that costs is a false negative on an account that answers every day of a
  // habit it has been told it need not answer.
  const habit = {
    type: 'numerical', target_value: 0, target_type: 'at_most',
    freq_numerator: 1, freq_denominator: 1, at_most_unlogged: 'success',
  };
  const rows = fullMonth('2026-01', { lapse: [1, 2, 3] });
  const stats = computeStats(habit, rows, { end: '2026-01-31' });

  // The figure is there on the payload for anything else that wants it...
  assert.equal(stats.coverage.find((c) => c.month === '2026-01').answered, 31);
  // ...and the card is empty, whole, exactly as it is for every other award.
  assert.deepEqual(computeAwards(stats, '2026-01-31', habit, 'miss', true), []);
});

/* ---------- rest taken deliberately ---------- */

const restAward = (str, skipDays) => {
  const end = endOf(str);
  const stats = computeStats(DAILY, entries(str), { end });
  return byFamily(computeAwards(stats, end, DAILY, 'miss', skipDays)).rest;
};

test('a rest inside a long run is an award, and it needs skipDays to be on', () => {
  // The setting defaults OFF, and #63's warning is that an award nobody can see
  // is worse than no award: with it off there is no Skip control on either grid
  // or in either day editor, so this would congratulate people on using
  // something they do not have.
  const str = 'xxxsxxxxxx';
  const on = restAward(str, true);
  assert.equal(on.value, 1);
  assert.equal(on.label, 'A rest day inside a run');
  assert.match(on.detail, /run of 10 days held together across 1 skipped day/);

  assert.equal(restAward(str, false), undefined, 'off is off');
  assert.equal(restAward(str, undefined), undefined,
    'and a caller that never asked gets the same answer as one that said no');
});

test('the rest award needs a run that HELD, and a week is the line', () => {
  // Straddled by a day, not by a shape: the same pattern one character longer.
  // Below the line this fires for anybody who has pressed Skip once, which is a
  // badge for using a control.
  assert.equal(restAward('xxsxxx', true), undefined, 'six days is not a run that held');
  assert.equal(restAward('xxxsxxx', true).value, 1, 'seven is');
});

test('a run with no rest in it earns nothing, however long', () => {
  assert.equal(restAward('x'.repeat(60), true), undefined);
});

test('the rest award reads the run that carried the MOST rest, not the longest', () => {
  // A 20-day run with one skip, then a 10-day run with three. The streak award
  // beside this one already reports the longest run; saying the same thing here
  // would be one fact twice, and the claim is about rest and not about length.
  const str = 'xxxxxxxxxsxxxxxxxxxx' + '..' + 'xxsxxsxxsxx';
  const a = restAward(str, true);
  assert.equal(a.value, 3);
  assert.match(a.detail, /run of 11 days held together across 3 skipped days/);
});

test('a skip that fell outside every run cannot be claimed as rest', () => {
  // `computeStreaks` counts only the skips INSIDE `[start, end]` of a run, so a
  // skip taken while the habit was already off pace is not rest that anything
  // was carried through. Ten on-pace days either side and the skip between them
  // belongs to neither.
  assert.equal(restAward('xxxxxxxxxxs.xxxxxxxxxx', true), undefined);
});

test('a rest the day BEFORE a run began is not rest that run carried', () => {
  // The user-visible half of `streaks.test.js`'s leading-skip fixture, and why
  // that guard is not cosmetic. Seven on-pace days clear `REST_MIN_RUN`, so
  // nothing else is withholding this: bank the skip that precedes them and the
  // card reads "held together across 1 skipped day" about a day the run does
  // not contain.
  assert.equal(restAward('sxxxxxxx', true), undefined);
  // The same skip one day in — now inside the run — is the award. Both runs are
  // seven days long, so the difference is the skip's position and nothing else.
  assert.equal(restAward('xsxxxxxxx', true).value, 1);
});

test('the rest award is withheld by the at-most gate too', () => {
  const habit = {
    type: 'numerical', target_value: 0, target_type: 'at_most',
    freq_numerator: 1, freq_denominator: 1, at_most_unlogged: 'success',
  };
  const rows = [{ date: '2026-01-01', value: 0, status: '' },
                { date: '2026-01-05', value: 0, status: 'skip' }];
  const stats = computeStats(habit, rows, { end: '2026-02-15' });
  assert.deepEqual(computeAwards(stats, '2026-02-15', habit, 'miss', true), []);
});
