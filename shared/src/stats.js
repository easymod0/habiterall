import { UNSET, YES, SKIP } from './constants.js';

/**
 * Hard cap on how many days any single stats computation may span. Every
 * aggregation pass allocates one element per day, so this bounds both memory
 * and time for a request. ~10 years is far beyond any real habit history.
 */
export const MAX_RANGE_DAYS = 3660;

/* ---------- date helpers (all dates are local 'YYYY-MM-DD' strings) ---------- */

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
 */
export function dateRange(start, end) {
  const out = [];
  for (let d = start; daysBetween(d, end) >= 0; d = addDays(d, 1)) out.push(d);
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
 * Every figure the detail view draws, over one window.
 *
 * **`coverage` is the one field a caller may decline, and the rule is the same
 * one that keeps `computeAwards` out of here.** Awards are computed at
 * `/habits/:id/stats` and nowhere else, because `/overview` calls this once per
 * habit and keeps `score` and `currentStreak` — so work that only the detail
 * view reads is paid for per habit on the dashboard's hot path and thrown away.
 * Coverage is the first field to make that cost visible rather than free: it is
 * its own pass over the window, measured at ~10% of a call, where every other
 * field here is either a pass the summary figures already need (`scores`,
 * `streaks`) or a cheap read of one. So `/overview` passes `coverage: false` in
 * both editions and the key is then ABSENT rather than empty — an empty array
 * would say "no month is fully answered", which is a claim, and this is the
 * absence of one. `computeAwards` reads `stats.coverage ?? []` and so degrades
 * to withholding the badge, which is the right answer for a caller that did not
 * ask for the figure.
 *
 * A test pins both editions' call sites, because a third route added later
 * would otherwise pay this quietly.
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
