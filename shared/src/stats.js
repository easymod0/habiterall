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
 * Exponential-decay habit strength, in the spirit of Loop's score.
 *
 * Each day we measure adherence over a trailing window the length of the
 * habit's frequency period: "how much of my target did I hit recently?",
 * always a ratio in [0, 1]. That ratio is fed into an EWMA with a 30-day
 * half-life:
 *
 *   score = score * alpha + adherence * (1 - alpha)
 *
 * Feeding a normalized ratio (rather than boosting a single day's credit by
 * 1/frequency) is what makes this correct for non-daily habits: a habit held
 * exactly at its target converges to 1.0 for ANY frequency, the result never
 * leaves [0, 1] without clamping, and a single completion can never saturate
 * the score.
 */
export function computeScores(habit, entryMap, start, end) {
  const HALF_LIFE = 30;
  const alpha = Math.pow(0.5, 1 / HALF_LIFE); // daily retention factor

  const num = Math.max(1, habit.freq_numerator || 1);
  const den = Math.max(1, habit.freq_denominator || 1);

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

/* ---------- history aggregation ---------- */

const BUCKETERS = {
  day: (iso) => iso,
  week: (iso) => {
    const d = fromISO(iso);
    // ISO week starts Monday.
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    return toISO(d);
  },
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
export function computeHistory(habit, entryMap, start, end, granularity = 'day') {
  const bucketOf = BUCKETERS[granularity] ?? BUCKETERS.day;
  const buckets = new Map();

  for (const date of boundedRange(start, end)) {
    const key = bucketOf(date);
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
export function computeFrequency(habit, entryMap, start, end) {
  const weekTotals = new Map();

  for (const date of boundedRange(start, end)) {
    const value = entryMap.get(date) ?? UNSET;
    if (isCompleted(habit, value) !== true) continue;
    const week = BUCKETERS.week(date);
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
 * @param {{start?: string, end?: string, granularity?: string}} [opts]
 * @returns {import('./types.js').Stats}
 */
export function computeStats(habit, entries, { start, end, granularity = 'day' } = {}) {
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
    history: computeHistory(habit, entryMap, from, end, granularity),
    weekdays: computeWeekdays(habit, entryMap, from, end),
    frequency: computeFrequency(habit, entryMap, from, end),
  };
}
