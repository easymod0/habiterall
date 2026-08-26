import { UNSET, YES, SKIP } from './constants.js';

/**
 * Hard cap on how many days any single stats computation may span. Every
 * aggregation pass allocates one element per day, so this bounds both memory
 * and time for a request. ~10 years is far beyond any real habit history.
 */
export const MAX_RANGE_DAYS = 3660;

/* ---------- date helpers (all dates are local 'YYYY-MM-DD' strings) ---------- */

/**
 * `'00'`…`'99'`, so a two-digit field is a lookup rather than a `String()`
 * plus a `padStart` — two allocations per field, and `dateRange` builds two
 * fields per day. Only ever indexed with a month (1-12) or a day (1-31), both
 * of which a valid `Date` guarantees; see `dateRange` for why it has one.
 */
const TWO_DIGIT = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0'));

export function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso, n) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/**
 * Whole days from `a` to `b`. Math.round absorbs the +/- 1 hour a DST
 * transition introduces, which is why this is correct across timezones.
 * @param {string} a 'YYYY-MM-DD'
 * @param {string} b 'YYYY-MM-DD'
 * @returns {number}
 */
export function daysBetween(a, b) {
  return Math.round((fromISO(b).getTime() - fromISO(a).getTime()) / 86400000);
}

export function today() {
  return toISO(new Date());
}

/**
 * Every date from `start` to `end` inclusive, oldest first.
 *
 * Advances one local-time `Date` with `setDate`, the same mechanism
 * `addDays` uses, rather than re-deriving each day from a string — that is
 * what makes this cheap. An epoch `+= 86400000` walk looks equivalent and
 * is not: it repeats a day across a fall-back DST transition, which is the
 * same ±1 hour `daysBetween`'s Math.round note is defending against.
 * `!(n >= 0)` rather than `n < 0`: `daysBetween` answers `NaN` for an
 * unparseable date, and `n < 0` is false for `NaN` too, so `new Array(n + 1)`
 * would throw `RangeError` instead of returning `[]`.
 *
 * **The `Date` cannot leave this loop either**, and that was measured rather
 * than assumed. Stepping the calendar arithmetically — increment the day, roll
 * over on a days-in-month table — needs no `Date` at all and is faster again,
 * and it is wrong for the same family of reasons the epoch walk is: it knows
 * the calendar but not which of its days a zone actually LIVED. Under
 * `Pacific/Apia`, which skipped 2011-12-30 outright when Samoa crossed the
 * date line, it emits that day — a date no entry can ever be keyed by, since
 * nobody there had one — and then, being one element longer at the front, ends
 * the range a day SHORT of `end`. `setDate` on a local `Date` is what makes
 * this list "the calendar days that happened here", which is what an entry map
 * is keyed on. The remaining cost is the strings, and that is what the loop
 * below is careful about.
 */
export function dateRange(start, end) {
  const n = daysBetween(start, end);
  if (!(n >= 0)) return [];
  const [y, m, d] = start.split('-').map(Number);
  const cur = new Date(y, m - 1, d);
  const out = new Array(n + 1);

  // Consecutive days share a `'YYYY-MM-'` prefix for a month at a time, so it
  // is built on a rollover rather than per day: one string concatenation and
  // one array lookup per element, against `toISO`'s three `Date` accessors,
  // two `String()`s, two `padStart`s and a four-part template. The output is
  // byte-identical and `test/stats.test.js` pins that against `toISO` itself,
  // because this is now the one place in the file that spells a date without
  // calling it.
  //
  // That one test does TWO jobs, and `prevDay = 32` is the second of them.
  // No real day exceeds 31, so the opening iteration always takes the branch
  // and the first prefix exists before anything reads it. `day === 1` would
  // not: a range starting on the 25th would spell its whole first month
  // `'25'`, `'26'`, … with an empty prefix. That is a covered branch, not a
  // defensive one — `test/stats.test.js` opens on 2023-12-25 and fails on it.
  //
  // The other job is the rollover, and there `day <= prevDay` is wider than
  // strictly needed in two directions, both harmless. No rollover can be
  // MISSED, because a month change cannot raise the day: sweeping all 418
  // IANA zones over 1900-2030 finds none that ever skipped a first of a month
  // — the date-line jumps that delete a day (Apia 2011-12-30, Kiritimati
  // 1994-12-31) all landed elsewhere in it — so every rollover in the tzdb
  // lands on the 1st, and even one that did not would still bring the day
  // down. And a non-increase is not always a rollover: where a zone began DST
  // at midnight the walk can repeat a local day, which rebuilds the prefix to
  // the value it already held. `America/Recife` around 2000-10-08 is the case
  // — reproducing it depends on which `Date`s the process built first, since
  // V8 caches the offset, which is why no suite here can pin it.
  let prefix = '';
  let prevDay = 32;
  for (let i = 0; i <= n; i++) {
    const day = cur.getDate();
    if (day <= prevDay) prefix = `${cur.getFullYear()}-${TWO_DIGIT[cur.getMonth() + 1]}-`;
    prevDay = day;
    out[i] = prefix + TWO_DIGIT[day];
    cur.setDate(day + 1);
  }

  // `n` counts elapsed 24-hour spans; the loop takes calendar steps. Those
  // agree everywhere except a zone that moved the date line WESTWARD and so
  // lived one local calendar day twice — Pacific/Kwajalein in 1969 is the
  // reachable one — where the walk takes one step more than `n` saw and ends
  // a day past `end`. A deleted day needs no counterpart: there the elapsed
  // count shrinks with the calendar and both agree. Costs one comparison in
  // the ordinary case, where the last element is already `end`.
  //
  // Compared through `daysBetween` rather than as strings, because `toISO`
  // pads the month and the day and NOT the year: for a year before 1000 it
  // writes '100-03-05', which is lexically ABOVE '0100-03-05' and would make
  // a string test pop the entire range. `boundedRange` clamps such a start
  // long before it reaches here, so nothing in the app can ask for it — but a
  // trim that empties a range on an input the function itself accepts is a
  // trap to leave lying around.
  while (out.length && daysBetween(out[out.length - 1], end) < 0) out.pop();
  return out;
}

/**
 * `dateRange`, but never spanning more than MAX_RANGE_DAYS.
 *
 * Every aggregation walks a range day by day, so an unbounded span is a
 * denial of service: one entry dated in the distant past (easily planted via
 * an import) turns a single request into hundreds of thousands of iterations
 * on a single-threaded server. Callers that take a start date from *stored
 * data* rather than from validated input must use this.
 */
export function boundedRange(start, end) {
  const earliest = addDays(end, -MAX_RANGE_DAYS);
  const from = start < earliest ? earliest : start;
  if (daysBetween(from, end) < 0) return [];
  return dateRange(from, end);
}

/* ---------- completion semantics ---------- */

/**
 * What a day nobody answered counts as. `'miss'` is the default and the answer
 * every habit but one already gave; see `unansweredCounts`.
 *
 * Named rather than inlined because three files have to agree on it — this,
 * the registry the dialog draws from, and the phone's own copy — and
 * `shared/test/settings.test.js` plus `AppSettingsDefaultsTest` pin them to
 * this one. A default that drifts shows a value the arithmetic is not using.
 */
export const UNLOGGED_DEFAULT = 'miss';

/**
 * Does a day with NO ROW count as having met the habit?
 *
 * For every habit but one the question does not arise: an unanswered day holds
 * no value, and no value is short of an at-least target and is not `YES`. It
 * arises for an **at-most** habit, where zero is *under* the limit — so the
 * absence of an answer reads as a perfect one, and a habit nobody has ever
 * logged reports an unbroken streak that grows for as long as it is ignored.
 *
 * Which of the two is right depends on the habit and cannot be decided here.
 * "I didn't smoke today" is worth a tap and is the whole reward; "I had no
 * soda" is not something anyone opens an app for, and the point of tracking it
 * is to record the exception. Both are ordinary and people keep both, so the
 * answer is asked at two levels: the account's `atMostUnlogged` is what most
 * habits follow, and a habit's own `at_most_unlogged` overrides it when it
 * differs. `'default'` — and an absent value, which is every habit stored
 * before this existed — means the account's.
 *
 * The default of the account setting is `miss`, because the other way round
 * every new limit looks perfect on the day it is created, having been kept for
 * exactly no time.
 *
 * Resolved HERE rather than at each entry point, because every caller already
 * has the habit in hand and none of them should have to remember the
 * precedence. Add a third level and this stays the only place that changes.
 * `awards.js` is the one caller outside this file, and it asks the question
 * rather than restating it for exactly that reason — see the awards section of
 * the root CLAUDE.md for why an award is withheld where a tile is not.
 *
 * Note this is about the FOURTH state and not about zero. A row holding 0 is a
 * stated lapse — "I had none today" — and for an at-most habit that is a real
 * success under either answer. It is the difference between a day the user
 * answered and a day nobody has, which is the whole of `questionMarks` and the
 * reason `entryWrite` stopped deleting rows. See constants.js.
 */
export function unansweredCounts(habit, unlogged) {
  // Gated on the case this exists for, and the gate is load bearing rather
  // than tidy. Ungated, `success` fell through to the ordinary predicate for
  // EVERY habit — and on an at-least habit with a target of 0, `0 >= 0` is
  // true while `dayCredit`'s matching branch (`target <= 0`) answers 0. One
  // response then reported a 30-day streak and 100% history beside a strength
  // of 0: the score and the streak disagreeing about the same day, which is
  // the thing the comment in `dayCredit` is written to prevent. A target of 0
  // is reachable — `parseHabit` accepts it, the form's `min` is 0, and the
  // Loop CSV path defaults one — and `parseHabit` deliberately KEEPS
  // `at_most_unlogged` when a habit's goal is switched from At most to At
  // least, so a habit-level 'success' outlives the target type it was set for.
  if (habit?.type === 'boolean' || habit?.target_type !== 'at_most') return false;

  const own = habit.at_most_unlogged;
  const rule = own && own !== 'default' ? own : unlogged;
  return rule === 'success';
}

/**
 * Did this entry satisfy the habit on its day?
 * Skips are neither success nor failure — they are excluded from scoring
 * entirely, matching Loop's behaviour.
 *
 * `entry` may be a bare number (legacy/boolean callers) or `{value, status}`.
 * Passing the status explicitly is what keeps a numerical habit's legitimate
 * value of 3 from being mistaken for the SKIP sentinel.
 *
 * **A nullish `entry` is a day with no row**, which is not the same as a row
 * holding 0 — see `unansweredCounts`. Callers used to spell that `?? UNSET`,
 * which is precisely the collapse `shared/CLAUDE.md` forbids of a reader.
 *
 * @param {*} [unlogged] `'miss'` | `'success'`, from the account's
 *   `atMostUnlogged`. Read only for a day with no row.
 */
export function isCompleted(habit, entry, unlogged = UNLOGGED_DEFAULT) {
  const { value, status } = normalizeEntry(habit, entry);
  if (status === 'skip') return null; // "not applicable"
  if (status === 'unknown' && !unansweredCounts(habit, unlogged)) return false;

  if (habit.type === 'boolean') return value === YES;
  // numerical
  if (habit.target_type === 'at_most') return value <= habit.target_value;
  return value >= habit.target_value;
}

/** The numeric amount of an entry, ignoring status. */
function rawValue(entry) {
  if (entry && typeof entry === 'object') return Number(entry.value) || 0;
  return Number(entry) || 0;
}

/**
 * Accept either `{value, status}` or a bare number. A bare 3 is only read as
 * a skip for boolean habits, where it is an unambiguous sentinel.
 */
function normalizeEntry(habit, entry) {
  // No row at all — the fourth state, and the one a `?? UNSET` at the call site
  // used to spend before it got here. `rawValue` still answers 0 for it, so a
  // history bucket's numerical total is unchanged by any of this.
  if (entry == null) return { value: UNSET, status: 'unknown' };
  if (entry && typeof entry === 'object') {
    return { value: Number(entry.value) || 0, status: entry.status ?? '' };
  }
  const value = Number(entry) || 0;
  const isSentinelSkip = habit.type === 'boolean' && value === SKIP;
  return { value, status: isSentinelSkip ? 'skip' : '' };
}

/**
 * Fractional credit for a day, used by the score curve. Boolean habits are
 * all-or-nothing; numerical habits get partial credit toward their target so
 * that 6 of 8 glasses of water still moves the needle.
 */
function dayCredit(habit, entry, unlogged = UNLOGGED_DEFAULT) {
  const { value, status } = normalizeEntry(habit, entry);
  if (status === 'skip') return null;
  // The same rule `isCompleted` states, and it has to be the same or the score
  // and the streak disagree about the very same day.
  if (status === 'unknown' && !unansweredCounts(habit, unlogged)) return 0;
  if (habit.type === 'boolean') return value === YES ? 1 : 0;

  const target = habit.target_value;
  if (habit.target_type === 'at_most') {
    // Full credit at or under target, decaying to zero at twice the target.
    if (target <= 0) return value <= 0 ? 1 : 0;
    if (value <= target) return 1;
    return Math.max(0, 1 - (value - target) / target);
  }
  if (target <= 0) return value > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, value / target));
}

/* ---------- score / strength ---------- */

/**
 * Exponential-decay habit strength, matching Loop's score.
 *
 * Each day we measure adherence over a trailing window the length of the
 * habit's frequency period: "how much of my target did I hit recently?",
 * always a ratio in [0, 1]. That ratio is fed into an EWMA:
 *
 *   score = score * multiplier + adherence * (1 - multiplier)
 *
 * Feeding a normalized ratio (rather than boosting a single day's credit by
 * 1/frequency) is what makes this correct for non-daily habits: a habit held
 * exactly at its target converges to 1.0 for ANY frequency, the result never
 * leaves [0, 1] without clamping, and a single completion can never saturate
 * the score.
 *
 * The multiplier is Loop's, read from uhabits' Score.kt:
 *
 *   multiplier = 0.5 ^ (sqrt(frequency) / 13)
 *
 * Two things follow that a fixed half-life gets wrong. A daily habit has a
 * 13-DAY half-life, not 30 — a perfect habit reaches 80% in a month rather
 * than crawling to 94% over four, which is what makes the number feel
 * responsive. And the sqrt term means a less frequent habit decays more
 * slowly (3x/week works out at ~20 days), so missing one of three weekly
 * sessions does not punish you as hard as missing a day of a daily habit.
 */
export function computeScores(habit, entryMap, start, end, unlogged = UNLOGGED_DEFAULT) {
  const num = Math.max(1, habit.freq_numerator || 1);
  const den = Math.max(1, habit.freq_denominator || 1);

  // Loop's constant. `frequency` is repetitions per day: 3 times in 7 days is
  // 3/7, and a daily habit is 1.
  const frequency = num / den;
  const alpha = Math.pow(0.5, Math.sqrt(frequency) / 13);

  const dates = boundedRange(start, end);

  // Credit per day, with skips recorded as null so they can be excluded from
  // the window rather than counted as failures.
  const credits = dates.map((date) => dayCredit(habit, entryMap.get(date), unlogged));

  const out = [];
  let score = 0;
  let windowSum = 0;   // running total of credit over the trailing window
  let windowSkips = 0; // skipped days currently inside the window

  for (let i = 0; i < dates.length; i++) {
    const credit = credits[i];
    if (credit === null) windowSkips++; else windowSum += credit;

    // Drop the day that just fell out of the trailing `den`-day window.
    const outgoing = i - den;
    if (outgoing >= 0) {
      const old = credits[outgoing];
      if (old === null) windowSkips--; else windowSum -= old;
    }

    // Scale the target down by any skipped days: a week with two skips only
    // demands the pro-rated share of the goal.
    const windowDays = Math.min(i + 1, den);
    const activeDays = windowDays - windowSkips;
    const target = num * (activeDays / den);

    // A window of nothing but skips leaves the score untouched.
    if (activeDays > 0 && target > 0) {
      const adherence = Math.min(1, windowSum / target);
      score = score * alpha + adherence * (1 - alpha);
    }

    out.push({ date: dates[i], score: Number(score.toFixed(6)) });
  }
  return out;
}

/* ---------- on pace ---------- */

/**
 * Whether each day leaves the habit ON PACE, which is what a streak and a
 * lapse are both made of.
 *
 * A day used to count only if the habit was completed on it. That is right for
 * a daily habit and wrong for every other kind: a 3×/week habit kept perfectly
 * has four off-days a week, and asking "was it done today?" reports the best
 * possible behaviour as a streak of one and a lapse every other day. The score
 * has always known better — it measures adherence over a trailing window the
 * length of the frequency period — so this asks the same question the same way
 * and the two numbers stop contradicting each other.
 *
 * The window is `denominator` days ending on the day being judged, and the
 * requirement is pro-rated by any skips inside it, exactly as `computeScores`
 * does: a week with two skipped days only demands its share of the target.
 * Near `start` the window is short and the requirement shrinks with it, so a
 * habit is not judged against a week of history it does not have yet.
 *
 * For a habit asking for something every day (`num >= den`) the window is one
 * day and the requirement clamps to it, so this reduces exactly to
 * `isCompleted` and daily habits behave precisely as they always have.
 *
 * @returns {{date: string, ok: boolean|null}[]} `null` on a skipped day, which
 *   is transparent: it neither starts, extends nor breaks a run.
 */
function onPaceSeries(habit, entryMap, start, end, unlogged = UNLOGGED_DEFAULT) {
  const num = Math.max(1, Number(habit.freq_numerator) || 1);
  const den = Math.max(1, Number(habit.freq_denominator) || 1);

  // Clamp here rather than at each call site. dateRange allocates one element
  // per day, so a single entry dated in the distant past — trivially planted
  // through an import — would otherwise spin for hundreds of thousands of
  // iterations and block the event loop for every user of the process.
  const dates = boundedRange(start, end);
  const done = dates.map((date) => isCompleted(habit, entryMap.get(date), unlogged));

  const out = [];
  let windowDone = 0;
  let windowSkips = 0;

  for (let i = 0; i < dates.length; i++) {
    if (done[i] === null) windowSkips++;
    else if (done[i]) windowDone++;

    // Drop the day that just fell out of the trailing `den`-day window.
    const outgoing = i - den;
    if (outgoing >= 0) {
      if (done[outgoing] === null) windowSkips--;
      else if (done[outgoing]) windowDone--;
    }

    if (done[i] === null) { out.push({ date: dates[i], ok: null }); continue; }

    const windowDays = Math.min(i + 1, den);
    const activeDays = windowDays - windowSkips;
    // `num * activeDays` before the division, so a whole-number requirement
    // stays whole: 3 × 7 / 7 is exactly 3, where 3 × (7/7) can float.
    // Capped at the days available, which is what keeps a "twice a day" habit
    // — more than the one row a day can hold — from being impossible to meet.
    const required = Math.min(activeDays, (num * activeDays) / den);

    out.push({
      date: dates[i],
      // A hair of tolerance: the requirement is a ratio and the count is not.
      ok: activeDays <= 0 || windowDone + 1e-9 >= required,
    });
  }
  return out;
}

/* ---------- streaks ---------- */

/**
 * Contiguous runs of being on pace. Skipped days bridge a streak rather than
 * breaking it (Loop treats a skip as "this day didn't happen").
 *
 * Note this counts CALENDAR days, including the off-days of a non-daily
 * habit: a 3×/week habit kept for a month is a 30-day streak, not a 12-day
 * one. That is what people mean by "I have kept this up for a month", and it
 * keeps the number comparable with a daily habit's.
 */
export function computeStreaks(habit, entryMap, start, end, unlogged = UNLOGGED_DEFAULT) {
  const streaks = [];
  let runStart = null;
  let runEnd = null;
  // Skipped days already counted into the run, and the ones seen since the last
  // day that was actually on pace. The second is what keeps `skips` a count of
  // days INSIDE `[start, end]`: skips bridge a run, so a trailing one sits after
  // `runEnd` and belongs to nothing. `x x s .` has one skip and a run of two
  // days that does not contain it — banking every skip on sight would report a
  // rest the run never carried.
  let runSkips = 0;
  let pendingSkips = 0;

  for (const { date, ok } of onPaceSeries(habit, entryMap, start, end, unlogged)) {
    if (ok === null) { // skip: neither extends nor breaks
      if (runStart !== null) pendingSkips++;
      continue;
    }

    if (ok) {
      if (runStart === null) runStart = date;
      runEnd = date;
      runSkips += pendingSkips;
      pendingSkips = 0;
    } else if (runStart !== null) {
      streaks.push({
        start: runStart, end: runEnd,
        length: daysBetween(runStart, runEnd) + 1, skips: runSkips,
      });
      runStart = null;
      runEnd = null;
      runSkips = 0;
      pendingSkips = 0;
    }
  }
  if (runStart !== null) {
    streaks.push({
      start: runStart, end: runEnd,
      length: daysBetween(runStart, runEnd) + 1, skips: runSkips,
    });
  }
  return streaks;
}

export function currentStreak(streaks, endDate) {
  if (!streaks.length) return 0;
  const last = streaks[streaks.length - 1];
  // Still "current" if it runs through today or yesterday.
  const gap = daysBetween(last.end, endDate);
  return gap <= 1 ? last.length : 0;
}

export function bestStreak(streaks) {
  return streaks.reduce((max, s) => Math.max(max, s.length), 0);
}

/* ---------- resilience ---------- */

/**
 * Miss runs: contiguous stretches of failure, the mirror image of
 * `computeStreaks`.
 *
 * Skips are transparent here for the same reason they bridge a streak — a day
 * that "didn't happen" is not a failure to come back from.
 */
export function computeMissRuns(habit, entryMap, start, end, unlogged = UNLOGGED_DEFAULT) {
  const runs = [];
  let runStart = null;
  let runEnd = null;

  for (const { date, ok } of onPaceSeries(habit, entryMap, start, end, unlogged)) {
    if (ok === null) continue;

    if (!ok) {
      if (runStart === null) runStart = date;
      runEnd = date;
    } else if (runStart !== null) {
      // Closed by a success, so it is decided: the user did come back.
      runs.push({
        start: runStart, end: runEnd,
        length: daysBetween(runStart, runEnd) + 1, open: false,
      });
      runStart = null;
      runEnd = null;
    }
  }
  // A run still open at `end` is deliberately included: an ongoing lapse is
  // the most important one to see, and excluding it would flatter the stats
  // exactly when the habit is in trouble.
  //
  // `open: true` is set HERE rather than inferred later by comparing `end`.
  // Skips are transparent to this loop, so a lapse whose final days were
  // skipped stops short of `end` and any such comparison misreads it as
  // closed — see computeRecovery.
  if (runStart !== null) {
    runs.push({
      start: runStart, end: runEnd,
      length: daysBetween(runStart, runEnd) + 1, open: true,
    });
  }
  return runs;
}

/**
 * How reliably you come back after a miss.
 *
 * Of every lapse that has ended, what fraction lasted only a single day?
 * This is the figure streaks cannot show: a long best-streak says you once
 * had a good month, while recovery rate says whether one bad day tends to
 * become a bad week.
 *
 * The final run is excluded when it is still open — an ongoing lapse has no
 * recovery yet, and counting it as a failure to recover would penalise a habit
 * simply for being mid-slip. `openRun` reports it separately.
 *
 * "Open" cannot be decided by comparing against `end`. Skips are transparent
 * to `computeMissRuns` — they neither start nor break a run — so an ongoing
 * lapse whose last days were skipped *ends before* `end` and used to be
 * misread as closed and unrecovered. A single trailing skip flipped a habit
 * from "never missed" (rate null) to "0% recovery", the precise misreport this
 * function exists to avoid. `computeMissRuns` therefore marks the run itself.
 *
 * `longest` and `lastEnd` are the same closed set read two other ways, and they
 * are returned rather than recomputed because `awards.js` needs them and must
 * not go back to the entries for them: the window every figure in a stats
 * response is computed over (`from = start ?? firstEntry`, clamped) is derived
 * inside `computeStats` and never returned, so a second derivation is a second
 * answer waiting to disagree with this one.
 *
 * @returns {{rate: number|null, recovered: number, lapses: number, openRun: number,
 *            longest: number, lastEnd: string|null}}
 *   `rate` is null when nothing has ever been missed — undefined, not 100%.
 */
export function computeRecovery(missRuns, end) {
  const last = missRuns.length ? missRuns[missRuns.length - 1] : null;
  // `open` is set by computeMissRuns; the `end` comparison is a fallback for
  // callers that build runs themselves (the chart tests do).
  const isOpen = last ? (last.open ?? last.end === end) : false;

  const closed = isOpen ? missRuns.slice(0, -1) : missRuns;
  const openRun = isOpen ? last.length : 0;

  if (!closed.length) {
    return { rate: null, recovered: 0, lapses: 0, openRun, longest: 0, lastEnd: null };
  }
  const recovered = closed.filter((r) => r.length === 1).length;
  return {
    rate: recovered / closed.length,
    recovered,
    lapses: closed.length,
    openRun,
    // The deepest hole this habit has climbed out of, and the last day it was
    // in one. Both are over the CLOSED runs, so an ongoing lapse moves neither
    // — being mid-slip is not a comeback, which is the line this function
    // already draws for the rate.
    longest: closed.reduce((max, r) => Math.max(max, r.length), 0),
    lastEnd: closed[closed.length - 1].end,
  };
}

/**
 * How miss runs are distributed by length, bucketed.
 *
 * The shape is the message: misses clustered at 1 day mean a habit that
 * self-corrects; a fat tail at 4+ means a habit that, once dropped, stays
 * dropped. Buckets rather than raw lengths because a histogram with a bar for
 * every distinct length is unreadable at a glance.
 */
export const MISS_BUCKETS = [
  { label: '1 day', min: 1, max: 1 },
  { label: '2 days', min: 2, max: 2 },
  { label: '3 days', min: 3, max: 3 },
  { label: '4–6 days', min: 4, max: 6 },
  { label: '1–2 weeks', min: 7, max: 14 },
  { label: '2 weeks+', min: 15, max: Infinity },
];

export function computeMissDistribution(missRuns) {
  const buckets = MISS_BUCKETS.map((b) => ({ ...b, count: 0 }));
  for (const run of missRuns) {
    const bucket = buckets.find((b) => run.length >= b.min && run.length <= b.max);
    if (bucket) bucket.count++;
  }
  const total = missRuns.length;
  return buckets.map((b) => ({
    label: b.label,
    min: b.min,
    count: b.count,
    share: total ? b.count / total : 0,
  }));
}

/**
 * Survival curve: of all streaks started, what fraction reached N days?
 *
 * Reframes "best streak: 23" — a trophy — into "you clear a week about 40% of
 * the time", which is a probability you can act on. The cliff in the curve is
 * the informative part: it locates where this habit reliably breaks.
 *
 * An in-progress streak counts toward every threshold it has already passed
 * but is not counted as having failed the ones ahead of it, so a streak on
 * day 5 of a good run does not drag down the 7-day figure.
 */
export const SURVIVAL_THRESHOLDS = [2, 3, 5, 7, 14, 21, 30, 60, 100];

export function computeSurvival(streaks, end, thresholds = SURVIVAL_THRESHOLDS) {
  if (!streaks.length) return [];

  const last = streaks[streaks.length - 1];
  const ongoing = last.end === end ? last : null;

  return thresholds
    .map((days) => {
      // A still-running streak is undecided for any threshold beyond its
      // current length: it has not failed, it simply has not got there yet.
      const decided = streaks.filter(
        (s) => s !== ongoing || s.length >= days
      );
      const reached = decided.filter((s) => s.length >= days).length;
      return {
        days,
        reached,
        total: decided.length,
        share: decided.length ? reached / decided.length : 0,
      };
    })
    // Drop thresholds nothing has ever come close to, so a two-week-old habit
    // does not render seven empty bars.
    .filter((t) => t.total > 0 && (t.days === thresholds[0] || t.reached > 0));
}

/**
 * The three resilience figures together.
 *
 * They answer one question that neither streaks nor the score curve does:
 * when this habit fails, what happens next?
 */
export function computeResilience(habit, entryMap, streaks, start, end,
                                  unlogged = UNLOGGED_DEFAULT) {
  // This used to refuse to run for anything but a daily habit, because a miss
  // run meant "a day it was not done" and a 3×/week habit has four of those
  // every week — a perfectly-kept habit reported as lapsing continuously.
  // `onPaceSeries` fixed the premise rather than the symptom: a miss is now a
  // day the habit fell BELOW ITS RATE, which is a real failure for any
  // frequency, so there is nothing left to suppress.
  const missRuns = computeMissRuns(habit, entryMap, start, end, unlogged);
  return {
    // Retained: the response shape is public, and the detail view still guards
    // on it. Nothing sets it false any more.
    applicable: true,
    recovery: computeRecovery(missRuns, end),
    missDistribution: computeMissDistribution(missRuns),
    survival: computeSurvival(streaks, end),
    // The longest lapse is the natural counterweight to `bestStreak`, and it
    // costs nothing now that the runs are computed.
    worstLapse: missRuns.reduce((max, r) => Math.max(max, r.length), 0),
  };
}

/* ---------- history aggregation ---------- */

/**
 * Start of the week containing `iso`.
 *
 * @param {string} iso
 * @param {'monday'|'sunday'} [weekStart] ISO weeks start Monday; much of the
 *   Americas starts Sunday, and a habit tracker's week should match the
 *   user's calendar or the counts look wrong at the boundary.
 */
export function startOfWeek(iso, weekStart = 'monday') {
  const d = fromISO(iso);
  const dow = weekStart === 'sunday' ? d.getDay() : (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return toISO(d);
}

const BUCKETERS = {
  day: (iso) => iso,
  week: (iso, weekStart) => startOfWeek(iso, weekStart),
  month: (iso) => iso.slice(0, 7),
  quarter: (iso) => {
    const [y, m] = iso.split('-').map(Number);
    return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  },
  year: (iso) => iso.slice(0, 4),
};

/**
 * Group entries into buckets, returning completions and opportunities per
 * bucket so the UI can show either a raw count or a percentage.
 */
/**
 * @param {import('./types.js').Habit} habit
 * @param {Map<string, any>} entryMap
 * @param {string} start
 * @param {string} end
 * @param {string} [granularity]
 * @param {'monday'|'sunday'} [weekStart]
 */
export function computeHistory(habit, entryMap, start, end, granularity = 'day',
                               weekStart = 'monday', unlogged = UNLOGGED_DEFAULT) {
  // `Object.hasOwn`, because `granularity` is a query parameter and
  // `BUCKETERS['valueOf']` is an inherited function: truthy, so `??` never
  // reaches the default, and calling it unbound throws instead of bucketing
  // by day. Both editions pass the parameter straight through.
  const bucketOf = Object.hasOwn(BUCKETERS, granularity)
    ? BUCKETERS[granularity]
    : BUCKETERS.day;
  const buckets = new Map();

  for (const date of boundedRange(start, end)) {
    const key = bucketOf(date, weekStart);
    if (!buckets.has(key)) {
      buckets.set(key, { bucket: key, completed: 0, total: 0, value: 0, skipped: 0 });
    }
    const b = buckets.get(key);
    const value = entryMap.get(date);
    const done = isCompleted(habit, value, unlogged);

    if (done === null) {
      b.skipped += 1;
      continue;
    }
    b.total += 1;
    if (done) b.completed += 1;
    if (habit.type === 'numerical') b.value += rawValue(value);
  }
  return [...buckets.values()];
}

/* ---------- weekday breakdown ---------- */

/**
 * Weekday consistency, month by month.
 *
 * `computeWeekdays` collapses all history into seven numbers, which hides
 * drift: a habit can rot on Saturdays for months while the lifetime bar still
 * looks healthy. This keeps the month axis, so "Mondays used to be fine" is
 * visible as a row that fades.
 *
 * Returns a rate, not a count, because months have differing numbers of each
 * weekday (four Mondays or five) and a raw count would make February look
 * worse than March for no reason.
 *
 * @returns {Array<{month: string, days: Array<{weekday: number, completed: number,
 *   total: number, rate: number}>}>}
 */
export function computeWeekdayByMonth(habit, entryMap, start, end, unlogged = UNLOGGED_DEFAULT) {
  const byMonth = new Map();

  for (const date of boundedRange(start, end)) {
    const value = entryMap.get(date);
    const done = isCompleted(habit, value, unlogged);
    // A skip is "this day didn't happen", so it must not count against the
    // weekday's rate — same rule as everywhere else.
    if (done === null) continue;

    const month = date.slice(0, 7);
    if (!byMonth.has(month)) {
      byMonth.set(month, {
        month,
        days: Array.from({ length: 7 }, (_, i) => ({
          weekday: i, completed: 0, total: 0, rate: 0,
        })),
      });
    }

    const wd = byMonth.get(month).days[fromISO(date).getDay()];
    wd.total += 1;
    if (done) wd.completed += 1;
  }

  for (const m of byMonth.values()) {
    for (const d of m.days) d.rate = d.total ? d.completed / d.total : 0;
  }

  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Success counts per day of week (0 = Sunday), for spotting which days
 * a habit reliably fails on.
 */
export function computeWeekdays(habit, entryMap, start, end, unlogged = UNLOGGED_DEFAULT) {
  const days = Array.from({ length: 7 }, (_, i) => ({
    weekday: i,
    completed: 0,
    total: 0,
    value: 0,
  }));

  for (const date of boundedRange(start, end)) {
    const value = entryMap.get(date);
    const done = isCompleted(habit, value, unlogged);
    if (done === null) continue;

    const wd = fromISO(date).getDay();
    days[wd].total += 1;
    if (done) days[wd].completed += 1;
    if (habit.type === 'numerical') days[wd].value += rawValue(value);
  }
  return days;
}

/* ---------- frequency (times per week) ---------- */

/**
 * Loop's frequency chart: for each month, how many weeks had 1, 2, 3 ...
 * completions. Reveals whether a "3x/week" habit is actually held at 3x.
 */
/**
 * @param {import('./types.js').Habit} habit
 * @param {Map<string, any>} entryMap
 * @param {string} start
 * @param {string} end
 * @param {'monday'|'sunday'} [weekStart]
 */
export function computeFrequency(habit, entryMap, start, end, weekStart = 'monday',
                                 unlogged = UNLOGGED_DEFAULT) {
  const weekTotals = new Map();

  for (const date of boundedRange(start, end)) {
    if (isCompleted(habit, entryMap.get(date), unlogged) !== true) continue;
    const week = startOfWeek(date, weekStart);
    weekTotals.set(week, (weekTotals.get(week) ?? 0) + 1);
  }

  const byMonth = new Map();
  for (const [week, count] of weekTotals) {
    const month = week.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, { month, counts: {} });
    const m = byMonth.get(month);
    m.counts[count] = (m.counts[count] ?? 0) + 1;
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/* ---------- coverage ---------- */

/** Days in the calendar month `'YYYY-MM'` names. */
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  // Day 0 of the next month is the last day of this one, which is how February
  // and a leap year answer for themselves rather than from a table.
  return new Date(y, m, 0).getDate();
}

/**
 * How many days of each month have an ANSWER, over the months this window
 * entirely contains.
 *
 * The four-state day model is what makes this askable at all: `done`, `skip`,
 * `no` (a row holding 0) and `unknown` (no row). Every other figure in a stats
 * response reads what a day SAID; this one reads whether the day was answered,
 * which is the distinction almost no tracker can draw. All three of the first
 * count and `unknown` does not, so this is membership of the entry map and
 * nothing else — never `entryMap.get(date) ?? UNSET`, the collapse
 * `shared/CLAUDE.md` forbids of a reader and that `isCompleted` already paid
 * for once.
 *
 * **Only months entirely inside `[start, end]` are reported, and the
 * containment rule does two jobs.** A partial first month — the habit was
 * created on the 10th — can never legitimately be fully covered, so counting it
 * would either be a figure nothing can reach or, if the denominator were the
 * days of the window rather than the days of the month, one reached wrongly.
 * And it settles "a month in progress is not finished" with no second rule: on
 * the last day of a month the month is contained and what it says can no longer
 * change downward, while on the 3rd it is not contained at all — so a reader can
 * never show something on the 3rd that vanishes on the 4th.
 *
 * `days` is therefore always the length of the month, and a caller wanting
 * "fully answered" asks `answered === days`.
 *
 * @param {Map<string, any>} entryMap
 * @param {string} start
 * @param {string} end
 * @returns {Array<{month: string, answered: number, days: number}>} oldest first
 */
export function computeCoverage(entryMap, start, end) {
  const months = new Map();

  for (const date of boundedRange(start, end)) {
    const month = date.slice(0, 7);
    if (!months.has(month)) months.set(month, { month, answered: 0, days: 0 });
    const m = months.get(month);
    m.days += 1;
    if (entryMap.has(date)) m.answered += 1;
  }

  // A month is entirely inside the window exactly when the window holds all of
  // its days — which needs no comparison against `start` and `end` and stays
  // right when `boundedRange` clamps the far edge.
  return [...months.values()].filter((m) => m.days === daysInMonth(m.month));
}

/* ---------- top-level summary ---------- */

/**
 * The window every top-level summary shares: the entry map, keyed by date and
 * holding `{value, status}`, and `from` — clamped to `MAX_RANGE_DAYS` and
 * normalised to a real day. `computeStats` and `summaryStats` both call this
 * rather than each carrying their own copy, so the clamp and the
 * normalisation cannot drift between the detail view and the dashboard.
 *
 * @param {import('./types.js').Entry[]} entries
 * @param {string|undefined} start
 * @param {string} end
 * @returns {{entryMap: Map<string, {value: *, status: string}>, from: string}}
 */
function resolveWindow(entries, start, end) {
  // Preserve `status` alongside the value so skips stay distinguishable from
  // a numerical habit legitimately recording the value 3.
  const entryMap = new Map(
    entries.map((e) => [e.date, { value: e.value, status: e.status ?? '' }])
  );

  // Don't assume the caller sorted the entries, and never span more than
  // MAX_RANGE_DAYS even if a stray entry is dated decades ago.
  const firstEntry = entries.length
    ? entries.reduce((min, e) => (e.date < min ? e.date : min), entries[0].date)
    : end;

  const earliest = addDays(end, -MAX_RANGE_DAYS);
  let from = start ?? firstEntry;

  if (from < earliest) from = earliest;
  if (from > end) from = end;

  // `firstEntry` comes out of STORAGE, so it can be a date that is not a real
  // day — `assertDate` refuses one on the way in, but a row predating that
  // guard does not have to be a real day to be read back. `dateRange`
  // normalises such a start (a walk from 2026-02-30 begins on 2026-03-02),
  // and `totalCompleted` below selects by STRING comparison against `from`,
  // so leaving it un-normalised makes the two disagree about which entries
  // are inside the window.
  //
  // AFTER the clamps, never before, and that ordering is the whole safety of
  // it: `toISO` does not pad the YEAR, so normalising '0999-12-31' yields
  // '999-12-31', which sorts ABOVE '2016-...' and walks straight past the
  // `earliest` clamp. One entry dated year 0999 — which `assertDate` accepts,
  // 999 being a real year that does not roll over — then collapsed the whole
  // payload to a single day and reported zero completions for a habit logged
  // every other day. Clamped first, `from` is already inside the window
  // before anything reformats it.
  const asDate = fromISO(from);
  if (!Number.isNaN(asDate.getTime())) from = toISO(asDate);

  return { entryMap, from };
}

/**
 * Every figure the detail view draws, over one window.
 *
 * **`coverage` is the one field a caller may decline, and the rule is the same
 * one that keeps `computeAwards` out of here.** Awards are computed at
 * `/habits/:id/stats` and nowhere else, because that route is now the only
 * caller of this function at all — `/overview` reads `score` and
 * `currentStreak` off `summaryStats` instead, so the five passes only the
 * detail view reads are no longer run per habit on the dashboard's hot path
 * just to be thrown away. Coverage is the first field to make that cost
 * visible rather than free: it is its own pass over the window, measured at
 * ~10% of a call, where every other field here is either a pass the summary
 * figures already need (`scores`, `streaks`) or a cheap read of one. The
 * parameter is kept as the opt-out for a caller that wants this whole reading
 * without its dearest optional pass — `/overview` no longer is one, but
 * declining it still means the key is ABSENT rather than empty, since an empty
 * array would say "no month is fully answered", which is a claim, and this is
 * the absence of one. `computeAwards` reads `stats.coverage ?? []` and so
 * degrades to withholding the badge, which is the right answer for a caller
 * that did not ask for the figure.
 *
 * A test pins each edition's one remaining call site here — `/stats`, the one
 * that still needs `granularity` — and its one `summaryStats` call site at
 * `/overview`, because a third route added later must not quietly pay for
 * passes it discards either way.
 *
 * @param {import('./types.js').Habit} habit
 * @param {import('./types.js').Entry[]} entries
 * @param {{start?: string, end?: string, granularity?: string,
 *           weekStart?: 'monday'|'sunday', unlogged?: string,
 *           coverage?: boolean}} [opts]
 * @returns {import('./types.js').Stats}
 */
export function computeStats(habit, entries,
                             { start, end, granularity = 'day',
                               weekStart = 'monday',
                               unlogged = UNLOGGED_DEFAULT,
                               coverage = true } = {}) {
  const { entryMap, from } = resolveWindow(entries, start, end);

  const scores = computeScores(habit, entryMap, from, end, unlogged);
  const streaks = computeStreaks(habit, entryMap, from, end, unlogged);

  // Bounded to the same [from, end] window every other figure in this payload
  // uses. Filtering the whole map counted entries outside the range — a
  // future-dated row, or one beyond MAX_RANGE_DAYS — so `totalCompleted`
  // disagreed with `streaks`, `history` and `scores` computed from the very
  // same call.
  const totalCompleted = [...entryMap.entries()].filter(
    ([date, v]) => date >= from && date <= end && isCompleted(habit, v) === true
  ).length;

  return {
    score: scores.length ? scores[scores.length - 1].score : 0,
    scores,
    streaks,
    currentStreak: currentStreak(streaks, end),
    bestStreak: bestStreak(streaks),
    totalCompleted,
    history: computeHistory(habit, entryMap, from, end, granularity, weekStart, unlogged),
    weekdays: computeWeekdays(habit, entryMap, from, end, unlogged),
    weekdayByMonth: computeWeekdayByMonth(habit, entryMap, from, end, unlogged),
    frequency: computeFrequency(habit, entryMap, from, end, weekStart, unlogged),
    resilience: computeResilience(habit, entryMap, streaks, from, end, unlogged),
    // On the payload rather than passed into `computeAwards` as a second data
    // source. `awards.js`'s header states that every award is a reading of the
    // figures already here and that nothing is counted a second way; an entry
    // map handed to it would break that property for exactly one award. A field
    // also inherits `[from, end]` — `start ?? firstEntry`, clamped to
    // MAX_RANGE_DAYS — so coverage cannot disagree with the awards beside it
    // about what "ever" means.
    //
    // ...and spread rather than assigned, so a caller that declined it gets no
    // key at all. See the note on the parameter.
    ...(coverage ? { coverage: computeCoverage(entryMap, from, end) } : {}),
  };
}

/**
 * The two numbers `/overview` keeps, computed the same way `computeStats`
 * does: `/overview` calls this once per habit and reads `score` and
 * `currentStreak` off the dashboard's hot path, where `computeStats` is the
 * detail view's whole reading, run once for the one habit it draws.
 * `test/stats.test.js`'s parity test is what stops the two disagreeing —
 * asserting that this always deep-equals the same two fields picked out of
 * `computeStats` over the same arguments, so a future change to one pass
 * cannot drift from the other unnoticed.
 *
 * @param {import('./types.js').Habit} habit
 * @param {import('./types.js').Entry[]} entries
 * @param {{start?: string, end?: string, unlogged?: string}} [opts]
 * @returns {import('./types.js').SummaryStats}
 */
export function summaryStats(habit, entries, { start, end, unlogged = UNLOGGED_DEFAULT } = {}) {
  const { entryMap, from } = resolveWindow(entries, start, end);

  const scores = computeScores(habit, entryMap, from, end, unlogged);
  const streaks = computeStreaks(habit, entryMap, from, end, unlogged);

  return {
    score: scores.length ? scores[scores.length - 1].score : 0,
    currentStreak: currentStreak(streaks, end),
  };
}

/* ---------- comparing categories ---------- */

/**
 * How much history a category comparison scores each member over BEFORE the
 * window it was asked for.
 *
 * `computeScores` starts its EWMA at `score = 0` on the first day of the range
 * it is handed, so a comparison starting cold at the requested `start` reports
 * every habit weaker than its own page does — `ui/detail.js` sends no `start`
 * to `/habits/:id/stats`, so a habit's strength there is always converged from
 * its first entry. Two surfaces disagreeing about the same habit is
 * indistinguishable from one of them being broken, so each member's series is
 * computed over `[start - SCORE_WARMUP_DAYS, end]` — clamped forward to that
 * member's own first entry, because that is where its own page opens too — and
 * sliced back to `[start, end]` for the response. The clamp is not a detail: see
 * `memberWarm` in `computeCategoryStats` for the habit shape it exists for.
 *
 * 400 days, which is the number both editions' `/overview` already spends on
 * the same problem (`SUMMARY_WINDOW_DAYS` in each `api.js`). Declared here and
 * imported by both routes rather than spelled once per edition: a warm-up that
 * drifted between the two would have one edition report a habit weaker than
 * the other, which is the defect class this repo names most often.
 */
export const SCORE_WARMUP_DAYS = 400;

/**
 * The widest window a CATEGORY COMPARISON may be asked for — its own ceiling,
 * tighter than `MAX_RANGE_DAYS`.
 *
 * `MAX_RANGE_DAYS` bounds a route that walks ONE habit. A comparison walks
 * every habit the account has, so the same span buys a cost multiplied by the
 * habit count: at 50 habits a 3,660-day window is ~385,000 synchronous
 * day-steps before the warm-up is even added, which is the order of the single
 * year-0100 entry the root `CLAUDE.md` records blocking the event loop for 32
 * seconds. Five years halves the worst case and is the number
 * `STREAK_HISTORY_DAYS` already is for the same "far beyond any real history"
 * reason.
 *
 * Declared here and imported by both editions' routes rather than spelled once
 * per edition: a ceiling that drifted between the two would have one refuse a
 * URL the other served, which is the defect class this repo names most often.
 */
export const MAX_COMPARE_DAYS = 1830;

/**
 * The window a category comparison covers when the caller names no start.
 *
 * A year, against the five-year ceiling above — the same shape `/overview`
 * has, where `days` defaults to 30 against a cap of 365. The ORDINARY request
 * must not be the worst case the route can be asked for: at the ceiling, the
 * plainest possible question would cost 1,831 daily buckets per category. A
 * caller who wants five years says so.
 *
 * Shared for the same reason the ceiling is, and it is the same divergence
 * arriving by the other door: two editions answering a `start`-less URL with
 * different bucket counts is one request served two ways. `SUMMARY_WINDOW_DAYS`
 * and `STREAK_HISTORY_DAYS` are still spelled once per edition with a comment
 * claiming they match — that is a guard that cannot see a renamed binding, and
 * it is precedent for a pattern to stop repeating rather than to follow.
 */
export const COMPARE_WINDOW_DAYS = 365;

/**
 * The strongest and the weakest member of one category.
 * Ties keep the first member seen, so a category of one has `best === worst`,
 * which is the correct answer rather than a degenerate one.
 */
function extremeMember(rows, better) {
  let chosen = null;
  for (const row of rows) if (chosen === null || better(row.score, chosen.score)) chosen = row;
  return chosen && { id: chosen.id, name: chosen.name, score: chosen.score };
}

/**
 * The mean, spread and n over one set of category members, at a single
 * reading. This is the one aggregation rule `computeCategoryStats`'s `section`
 * and a caller needing only a header figure — never a whole comparison —
 * both call, so the two cannot silently disagree about which members count.
 *
 * **A member that has never been logged has no strength, which is not a
 * strength of zero.** Averaging one in would report that your health got
 * worse on the day you decided to do more about it, so a member is counted
 * into `mean`, `best` and `worst` only once `landed` is true, and until then
 * it is counted into `unloggedExcluded` instead. `mean` is `null` — never
 * `0` — when nothing has landed, which covers an empty set too; `best` and
 * `worst` are `null` then as well. Ties keep the first member seen, so a
 * one-member category has `best === worst`. See `computeCategoryStats`'s own
 * header comment for the long-form reasoning and the landing rule itself —
 * this function does not decide what "landed" means, it only aggregates over
 * whatever the caller already decided.
 *
 * @param {Array<{id: number, name: string, score: number, landed: boolean}>} rows
 * @returns {import('./types.js').MemberSummary}
 */
export function summariseMembers(rows) {
  const landed = rows.filter((r) => r.landed);
  return {
    members: rows.length,
    unloggedExcluded: rows.length - landed.length,
    mean: landed.length
      ? landed.reduce((sum, r) => sum + r.score, 0) / landed.length
      : null,
    best: extremeMember(landed, (a, b) => a > b),
    worst: extremeMember(landed, (a, b) => a < b),
  };
}

/**
 * `categorySummaries`: the mean, spread and n over each category's own
 * members, from the SAME `habits` array `/overview` already returns — never a
 * second scoring pass. Which members count is the one rule `summariseMembers`
 * states and `#/categories` (`computeCategoryStats`'s `section`) also calls,
 * so the two agree by construction about MEMBERSHIP even though the scores
 * themselves are two different windows (see that function's header comment).
 *
 * The partition matches `computeCategoryStats` and the grouped dashboard: a
 * `category_id` naming no row in `categories` falls into Uncategorised rather
 * than being dropped, and Uncategorised (`id: null`) is always present, even
 * with no members.
 *
 * @param {import('./types.js').Category[]} categories
 * @param {any[]} payloads - the response's own `habits`, already carrying `score`
 * @param {Map<number, string|null>} firstEntry - habit id -> that habit's
 *   lifetime earliest entry date, or absent/null if it has none. Compared
 *   against `day` as a STRING — must never reach `addDays`, `dateRange` or
 *   `boundedRange` (root `CLAUDE.md`).
 * @param {string} day - the reading the route computed every payload's
 *   `score` as of (`summaryEnd`), so a member whose earliest entry is AFTER
 *   it is not yet landed even though it has one. Matches `landedAt`'s rule
 *   in `computeCategoryStats`'s `section` below: has this member landed by
 *   the day being read, not merely does it have an entry at all.
 * @returns {import('./types.js').CategorySummaryRow[]}
 */
export function summariseByCategory(categories, payloads, firstEntry, day) {
  const byCategory = new Map(categories.map((c) => [c.id, []]));
  const uncategorised = [];
  for (const h of payloads) {
    const bucket = h.category_id != null && byCategory.get(h.category_id);
    (bucket || uncategorised).push(h);
  }
  const summarise = (members) => summariseMembers(members.map((h) => {
    const first = firstEntry.get(h.id);
    return {
      id: h.id,
      name: h.name,
      score: h.score,
      landed: first != null && first <= day,
    };
  }));
  return [
    ...categories.map((c) => ({ id: c.id, ...summarise(byCategory.get(c.id)) })),
    { id: null, ...summarise(uncategorised) },
  ];
}

/**
 * Which of an account's categories is holding up, over one window.
 *
 * **There is no category-level score formula and there must not be one.** The
 * per-habit score is an EWMA over a trailing-window adherence ratio whose decay
 * carries a `sqrt(frequency)` term, and that term is exactly what makes a
 * 3x/week habit's number comparable with a daily one's. A category has as many
 * frequencies as it has members, plus a mix of boolean/numerical and
 * at_least/at_most, so there is no single frequency `computeScores` could be
 * handed for one. What is aggregated is therefore the members' own strengths,
 * **equal weight per habit** — never per entry, which would let one daily
 * member drown a weekly one, and never re-derived from raw entries.
 *
 * **`members` and the spread ride beside the `mean`, which is never shown
 * alone**: `best`/`worst` are the spread and `members` is the n.
 *
 * **A habit that has NEVER been logged has no strength, which is not a strength
 * of zero.** Averaging one in would report that your health got worse on the
 * day you decided to do more about it — so a member is counted into `mean`,
 * `best` and `worst` only once it has an entry, and until then it is counted
 * into `unloggedExcluded` instead. Adding a habit to a category raises
 * `members` and raises `unloggedExcluded`; it moves no figure downward. That is
 * the same shape of claim `recovery.rate === null` already makes — undefined,
 * not zero — and this file already refuses to average that one into a number.
 * `mean` is `null` when no member has landed, which covers an empty category
 * too.
 *
 * That is "never logged" and not "nothing in the entry slice", and the two are
 * only the same question when the caller hands over a whole history: see
 * `firstEntry` on a member below. An ABANDONED habit — logged for years, then
 * dropped — has a genuine strength near zero and belongs in the mean, because
 * it really is dragging its category down.
 *
 * **Uncategorised is always present and always last**, `id: null`, even with no
 * members at all. It is a state a habit is in and never a category it belongs
 * to (see `shared/CLAUDE.md`), the same discipline the four day states get in
 * the root one — and a habit whose `category_id` names no category in
 * `categories`, deleted between the two reads, lands there too, so every member
 * is counted exactly once. It carries `name: null` and `color: null`: naming it
 * is the view's job, exactly as it already is on the grouped dashboard, and
 * `shared/src` holds no prose.
 *
 * **A member contributes to a bucket only once its first entry has landed**,
 * and an absent member is never counted as 0 — a habit added in March must read
 * as a line starting in March, not as a category that was doing half as well
 * all of January. `members` per bucket is what says how many the value is over.
 *
 * A bucket's value is read on the LAST day of the bucket that the window holds,
 * not averaged across its days. A score is a level, not a rate: "where this
 * category stood at the end of that month" is the reading. Together with the
 * landing rule above that makes `series.at(-1).value === mean` unconditionally
 * — the same members, the same day, the same arithmetic — because a chart whose
 * last point disagrees with the number printed over it reads as a bug whichever
 * of the two is right.
 *
 * `recoveryRate` is over the REQUESTED window and carries no warm-up: it counts
 * closed lapses rather than converging on them, so unlike the score it means
 * exactly what the window says. A member whose `rate` is `null` has no CLOSED
 * lapse in that window — it has never missed, or has never been logged, or its
 * only lapse is still open — and that is a different claim from 100%, so it is
 * excluded from the mean and counted into `recoveryExcluded`. A category where
 * every member says so answers `null` rather than 0. `recoveryExcluded` is
 * therefore its own count and not a restatement of `unloggedExcluded`: they
 * overlap on a never-logged member and agree about nothing else.
 *
 * Archived habits are excluded from every figure here and counted into
 * `archivedExcluded`, so the view can say what it left out. That is derived
 * from the members handed in, which is the only way a pure function can answer
 * it — a caller that filters them out in SQL will see 0 and have nothing to
 * report. It is reported TWICE, and the two answer different questions: the
 * account-wide total on the payload, which the header reads, and a per-section
 * count beside `members`, because one number cannot tell a category nobody has
 * filled from one whose habits have all been shelved — both arrive with
 * `members: 0`, and the view said the first about the second.
 *
 * @param {import('./types.js').Category[]} categories in the order to report
 *   them; Uncategorised is appended and is not one of these
 * @param {Array<{habit: import('./types.js').Habit,
 *                entries: import('./types.js').Entry[],
 *                firstEntry?: string|null}>} members every habit the account
 *   has, with its entries from `start - SCORE_WARMUP_DAYS`. `firstEntry` is
 *   that habit's LIFETIME earliest entry date, or `null` if it has none —
 *   supply it, because a truncated `entries` slice cannot answer it and a
 *   habit last logged before the slice would otherwise read as never logged.
 *   Omit the key to derive it from `entries`.
 * @param {{start?: string, end?: string, granularity?: string,
 *          weekStart?: 'monday'|'sunday', unlogged?: string}} [opts]
 * @returns {import('./types.js').CategoryStats}
 */
export function computeCategoryStats(categories, members,
                                     { start, end, granularity = 'day',
                                       weekStart = 'monday',
                                       unlogged = UNLOGGED_DEFAULT } = {}) {
  // `Object.hasOwn` for the same reason `computeHistory` needs it: granularity
  // is a query parameter, and `BUCKETERS['valueOf']` is an inherited function.
  const bucketOf = Object.hasOwn(BUCKETERS, granularity)
    ? BUCKETERS[granularity]
    : BUCKETERS.day;

  // The one axis every category's series is drawn on, built exactly as
  // `computeHistory` builds its buckets so the two align at a shared
  // granularity. `refDay` is the last day of each bucket the window holds.
  const dates = boundedRange(start, end);
  const buckets = [];
  const refDay = new Map();
  for (const date of dates) {
    const key = bucketOf(date, weekStart);
    if (!refDay.has(key)) buckets.push(key);
    refDay.set(key, date);
  }

  const active = [];
  const shelved = [];
  for (const member of members) {
    if (member.habit.archived) shelved.push(member.habit);
    else active.push(member);
  }

  // `dates` is already clamped, so the warm-up is derived from ITS first day
  // rather than from `start`: that keeps `addDays` off an unvalidated string,
  // and it guarantees the warm range covers every visible day, since
  // `boundedRange` re-clamps the earlier start to the same MAX_RANGE_DAYS
  // boundary. Every `refDay` therefore has a score point.
  const warmStart = dates.length ? addDays(dates[0], -SCORE_WARMUP_DAYS) : null;

  const readings = active.map(({ habit, entries, firstEntry: lifetimeFirst }) => {
    // `status` is preserved alongside the value for the reason `resolveWindow`
    // states: a skip must stay distinguishable from a numerical habit
    // legitimately recording 3.
    const entryMap = new Map(
      entries.map((e) => [e.date, { value: e.value, status: e.status ?? '' }])
    );

    // **The habit's LIFETIME earliest entry, which `entries` cannot answer.** A
    // route fetches from `start - SCORE_WARMUP_DAYS`, so a habit last logged
    // two years ago — still active, never archived — has nothing in that slice
    // and derives `null` here. It would then be reported as never logged, which
    // is false about a habit with years behind it, and excluded from the mean,
    // which makes the category read healthier than it is. "Has never been
    // logged" and "has nothing in the window I happened to fetch" are different
    // questions and the landing rule asks the first, so the caller supplies the
    // answer (`MIN(date)`, indexed and cheap) and this prefers it.
    //
    // Derived from `entries` only when the key is ABSENT, so the function stays
    // usable standalone and a caller that has the whole history in hand need
    // not restate it. An explicit `null` is a caller saying the habit truly has
    // no entry at all, and is not the same as omitting the key.
    //
    // Don't assume the caller sorted the entries.
    const firstEntry = lifetimeFirst !== undefined
      ? lifetimeFirst
      : (entries.length
        ? entries.reduce((min, e) => (e.date < min ? e.date : min), entries[0].date)
        : null);

    // **And the warm-up is clamped to that same date**, which is exactly what
    // `resolveWindow` already does for a habit's own page: it opens at
    // `start ?? firstEntry`, so scoring a member from 400 days before it existed
    // compares it against a window it never had. For an at-least member those
    // phantom days credit 0 and the two surfaces agree anyway; for an at-most
    // member whose unlogged days count as kept — `at_most_unlogged: 'success'`,
    // or the account's `atMostUnlogged`, which is every `show_as: 'avoid'` habit
    // under that setting — an unlogged day is FULL credit, so the warm-up
    // converged a new limit to ~0.97 where its own page read 0.41, for the first
    // ~430 days of every avoid habit's life.
    //
    // The clamp leaves `scoreAt` without a point for any day before
    // `memberWarm`, and the only thing that keeps `scoreAt.get(day)` from
    // answering `undefined` — and putting NaN through every mean below — is that
    // `landedAt` already refuses to read a member on a day before it landed. The
    // two dates are now the same one, so that coupling is load bearing:
    // weakening the landing rule means widening this range back.
    let memberWarm = firstEntry && firstEntry > warmStart ? firstEntry : warmStart;

    // **Normalised AFTER the clamp, never before**, which is `resolveWindow`'s
    // own shape and is here for the same reason: `firstEntry` comes out of
    // STORAGE and does not have to be a real day. `assertDate` refuses one on
    // the way in, but a row predating that guard does not, and `computeScores`
    // normalises the start it is handed (a walk from 2026-02-30 begins on
    // 2026-03-02) while `landedAt` below selects by STRING comparison. The two
    // then disagreed about the days in between: 2026-03-01 read as landed, with
    // no score point behind it, which is `undefined` through `meanScoreAt` and
    // one NaN bucket — serialised as `null` and dropped by `ui/categories.js`'s
    // own filter, so the drawn line quietly lost a vertex. Measured: `mean`
    // itself survived, because the last bucket is `end`, long past the gap.
    //
    // A phantom day never happened, so the member lands on the real day the walk
    // reaches instead. `unloggedExcluded` is unmoved either way — the member has
    // an entry, whatever that entry is dated.
    //
    // The ORDERING is the whole safety of it, exactly as it is in
    // `resolveWindow`: `toISO` pads the month and the day and NOT the year, so
    // normalising '0999-12-31' yields '999-12-31', which sorts ABOVE '2026-...'
    // and walks straight past every bound in this function. Clamped first, the
    // value being reformatted is at or after `warmStart` — itself derived from
    // `end` — so it is already inside the window. A `firstEntry` OLDER than
    // `warmStart` is never reformatted at all and does not need to be:
    // `memberWarm` is then `warmStart`, a real day, and the member is admitted
    // on every day of the window under either spelling.
    if (memberWarm) {
      const asDate = fromISO(memberWarm);
      if (!Number.isNaN(asDate.getTime())) memberWarm = toISO(asDate);
    }

    const scoreAt = new Map();
    let rate = null;
    if (dates.length) {
      for (const point of computeScores(habit, entryMap, memberWarm, end, unlogged)) {
        scoreAt.set(point.date, point.score);
      }
      rate = computeRecovery(
        computeMissRuns(habit, entryMap, dates[0], end, unlogged), end
      ).rate;
    }

    return {
      id: habit.id,
      name: habit.name,
      categoryId: habit.category_id,
      // The day this member LANDS on, which is `memberWarm` and not the raw
      // `firstEntry`: it names the day `computeScores` above actually began its
      // walk at, so the landing rule and `scoreAt` cannot disagree about which
      // days have a point. `null` when the habit has never been logged at all —
      // that is what keeps it out of every figure, and `memberWarm` is
      // `warmStart` for such a member rather than anything about it.
      landsOn: firstEntry === null ? null : memberWarm,
      scoreAt,
      score: dates.length ? scoreAt.get(dates[dates.length - 1]) : 0,
      rate,
    };
  });

  // The same partition the grouped dashboard makes, and for the same reason:
  // a `category_id` pointing at a category that is not in `categories` falls
  // into Uncategorised rather than being dropped.
  const byCategory = new Map(categories.map((c) => [c.id, []]));
  const uncategorised = [];
  for (const reading of readings) {
    const bucket = reading.categoryId != null && byCategory.get(reading.categoryId);
    (bucket || uncategorised).push(reading);
  }

  // The archived members are partitioned the same way, by the same authority —
  // `byCategory.has`, so a dangling `category_id` lands in Uncategorised here
  // exactly as it does above rather than by a second rule that could disagree.
  // The account-wide total is one number and cannot answer for a SECTION: a
  // category whose members are all archived arrives with `members: 0` and is
  // otherwise indistinguishable from one nobody has filled, so the card said
  // "No habits in this category yet." about a category the user filled and
  // later shelved.
  const archivedIn = new Map();
  let archivedUncategorised = 0;
  for (const habit of shelved) {
    const id = habit.category_id;
    if (id != null && byCategory.has(id)) archivedIn.set(id, (archivedIn.get(id) ?? 0) + 1);
    else archivedUncategorised++;
  }

  // The landing rule, asked once and used by every figure that reads a
  // strength: the headline mean, the spread, and each bucket of the series.
  // `mean` and `series.at(-1).value` are therefore the same arithmetic over the
  // same members on the same day, which is what makes them equal rather than
  // nearly equal — see the note above about a chart's last point disagreeing
  // with the number printed over it.
  //
  // It reads `landsOn` rather than the raw `firstEntry`, and `meanScoreAt`
  // beneath it is why: every member this admits must have a point in `scoreAt`,
  // or an `undefined` goes through that sum as NaN. The two are the same date
  // by construction now — see `memberWarm` above, which is where both come
  // from.
  const lastDay = dates.length ? dates[dates.length - 1] : null;
  const landedAt = (rows, day) =>
    day === null ? [] : rows.filter((r) => r.landsOn !== null && r.landsOn <= day);
  const meanScoreAt = (rows, day) =>
    rows.length ? rows.reduce((sum, r) => sum + r.scoreAt.get(day), 0) / rows.length : null;

  const section = (id, name, color, rows, archived) => {
    const rates = rows.map((r) => r.rate).filter((r) => r !== null);
    // The one aggregation rule, asked at `lastDay` — the same landing rule
    // `landedAt` applies below, restated per-row because `summariseMembers`
    // takes a plain array rather than closing over a day.
    const summary = summariseMembers(rows.map((r) => ({
      id: r.id,
      name: r.name,
      score: r.scoreAt.get(lastDay),
      landed: r.landsOn !== null && r.landsOn <= lastDay,
    })));
    return {
      id,
      name,
      color,
      members: summary.members,
      archivedExcluded: archived,
      unloggedExcluded: summary.unloggedExcluded,
      mean: summary.mean,
      best: summary.best,
      worst: summary.worst,
      series: buckets.map((bucket) => {
        const day = refDay.get(bucket);
        const at = landedAt(rows, day);
        return { bucket, value: meanScoreAt(at, day), members: at.length };
      }),
      recoveryRate: rates.length
        ? rates.reduce((sum, r) => sum + r, 0) / rates.length
        : null,
      recoveryExcluded: rows.length - rates.length,
    };
  };

  return {
    buckets,
    archivedExcluded: shelved.length,
    categories: [
      ...categories.map((c) => section(c.id, c.name, c.color, byCategory.get(c.id),
        archivedIn.get(c.id) ?? 0)),
      section(null, null, null, uncategorised, archivedUncategorised),
    ],
  };
}
