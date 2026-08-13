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
 * Did this entry satisfy the habit on its day?
 * Skips are neither success nor failure — they are excluded from scoring
 * entirely, matching Loop's behaviour.
 *
 * `entry` may be a bare number (legacy/boolean callers) or `{value, status}`.
 * Passing the status explicitly is what keeps a numerical habit's legitimate
 * value of 3 from being mistaken for the SKIP sentinel.
 */
export function isCompleted(habit, entry) {
  const { value, status } = normalizeEntry(habit, entry);
  if (status === 'skip') return null; // "not applicable"

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
function dayCredit(habit, entry) {
  const { value, status } = normalizeEntry(habit, entry);
  if (status === 'skip') return null;
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
export function computeScores(habit, entryMap, start, end) {
  const num = Math.max(1, habit.freq_numerator || 1);
  const den = Math.max(1, habit.freq_denominator || 1);

  // Loop's constant. `frequency` is repetitions per day: 3 times in 7 days is
  // 3/7, and a daily habit is 1.
  const frequency = num / den;
  const alpha = Math.pow(0.5, Math.sqrt(frequency) / 13);

  const dates = boundedRange(start, end);

  // Credit per day, with skips recorded as null so they can be excluded from
  // the window rather than counted as failures.
  const credits = dates.map((date) => dayCredit(habit, entryMap.get(date) ?? UNSET));

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

/* ---------- streaks ---------- */

/**
 * Contiguous runs of success. Skipped days bridge a streak rather than
 * breaking it (Loop treats a skip as "this day didn't happen").
 */
export function computeStreaks(habit, entryMap, start, end) {
  const streaks = [];
  let runStart = null;
  let runEnd = null;

  // Clamp here rather than at each call site. dateRange allocates one element
  // per day, so a single entry dated in the distant past — trivially planted
  // through an import — would otherwise spin for hundreds of thousands of
  // iterations and block the event loop for every user of the process.
  for (const date of boundedRange(start, end)) {
    const value = entryMap.get(date) ?? UNSET;
    const done = isCompleted(habit, value);

    if (done === null) continue; // skip: neither extends nor breaks

    if (done) {
      if (runStart === null) runStart = date;
      runEnd = date;
    } else if (runStart !== null) {
      streaks.push({ start: runStart, end: runEnd, length: daysBetween(runStart, runEnd) + 1 });
      runStart = null;
      runEnd = null;
    }
  }
  if (runStart !== null) {
    streaks.push({ start: runStart, end: runEnd, length: daysBetween(runStart, runEnd) + 1 });
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
export function computeMissRuns(habit, entryMap, start, end) {
  const runs = [];
  let runStart = null;
  let runEnd = null;

  for (const date of boundedRange(start, end)) {
    const value = entryMap.get(date) ?? UNSET;
    const done = isCompleted(habit, value);

    if (done === null) continue;

    if (!done) {
      if (runStart === null) runStart = date;
      runEnd = date;
    } else if (runStart !== null) {
      runs.push({ start: runStart, end: runEnd, length: daysBetween(runStart, runEnd) + 1 });
      runStart = null;
      runEnd = null;
    }
  }
  // A run still open at `end` is deliberately included: an ongoing lapse is
  // the most important one to see, and excluding it would flatter the stats
  // exactly when the habit is in trouble.
  if (runStart !== null) {
    runs.push({ start: runStart, end: runEnd, length: daysBetween(runStart, runEnd) + 1 });
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
 * @returns {{rate: number|null, recovered: number, lapses: number, openRun: number}}
 *   `rate` is null when nothing has ever been missed — undefined, not 100%.
 */
export function computeRecovery(missRuns, end) {
  const closed = missRuns.filter((r) => r.end !== end);
  const openRun = missRuns.length && missRuns[missRuns.length - 1].end === end
    ? missRuns[missRuns.length - 1].length
    : 0;

  if (!closed.length) {
    return { rate: null, recovered: 0, lapses: 0, openRun };
  }
  const recovered = closed.filter((r) => r.length === 1).length;
  return {
    rate: recovered / closed.length,
    recovered,
    lapses: closed.length,
    openRun,
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
export function computeResilience(habit, entryMap, streaks, start, end) {
  // Only meaningful for habits meant to happen every day. For a 3×/week habit
  // the four off-days are not failures, so day-level miss runs would report a
  // perfectly-kept habit as lapsing every week — worse than showing nothing.
  // Period-level resilience for non-daily habits is worth doing, but it is a
  // different measure and does not belong behind the same label.
  const isDaily = Number(habit.freq_numerator) >= Number(habit.freq_denominator);
  if (!isDaily) {
    return { applicable: false, recovery: null, missDistribution: [], survival: [], worstLapse: 0 };
  }

  const missRuns = computeMissRuns(habit, entryMap, start, end);
  return {
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
                               weekStart = 'monday') {
  const bucketOf = BUCKETERS[granularity] ?? BUCKETERS.day;
  const buckets = new Map();

  for (const date of boundedRange(start, end)) {
    const key = bucketOf(date, weekStart);
    if (!buckets.has(key)) {
      buckets.set(key, { bucket: key, completed: 0, total: 0, value: 0, skipped: 0 });
    }
    const b = buckets.get(key);
    const value = entryMap.get(date) ?? UNSET;
    const done = isCompleted(habit, value);

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
export function computeWeekdayByMonth(habit, entryMap, start, end) {
  const byMonth = new Map();

  for (const date of boundedRange(start, end)) {
    const value = entryMap.get(date) ?? UNSET;
    const done = isCompleted(habit, value);
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
export function computeWeekdays(habit, entryMap, start, end) {
  const days = Array.from({ length: 7 }, (_, i) => ({
    weekday: i,
    completed: 0,
    total: 0,
    value: 0,
  }));

  for (const date of boundedRange(start, end)) {
    const value = entryMap.get(date) ?? UNSET;
    const done = isCompleted(habit, value);
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
export function computeFrequency(habit, entryMap, start, end, weekStart = 'monday') {
  const weekTotals = new Map();

  for (const date of boundedRange(start, end)) {
    const value = entryMap.get(date) ?? UNSET;
    if (isCompleted(habit, value) !== true) continue;
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

/* ---------- top-level summary ---------- */

/**
 * @param {import('./types.js').Habit} habit
 * @param {import('./types.js').Entry[]} entries
 * @param {{start?: string, end?: string, granularity?: string,
 *           weekStart?: 'monday'|'sunday'}} [opts]
 * @returns {import('./types.js').Stats}
 */
export function computeStats(habit, entries,
                             { start, end, granularity = 'day',
                               weekStart = 'monday' } = {}) {
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

  const scores = computeScores(habit, entryMap, from, end);
  const streaks = computeStreaks(habit, entryMap, from, end);

  const totalCompleted = [...entryMap.entries()].filter(
    ([, v]) => isCompleted(habit, v) === true
  ).length;

  return {
    score: scores.length ? scores[scores.length - 1].score : 0,
    scores,
    streaks,
    currentStreak: currentStreak(streaks, end),
    bestStreak: bestStreak(streaks),
    totalCompleted,
    history: computeHistory(habit, entryMap, from, end, granularity, weekStart),
    weekdays: computeWeekdays(habit, entryMap, from, end),
    weekdayByMonth: computeWeekdayByMonth(habit, entryMap, from, end),
    frequency: computeFrequency(habit, entryMap, from, end, weekStart),
    resilience: computeResilience(habit, entryMap, streaks, from, end),
  };
}
