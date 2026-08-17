// A relative specifier, so this module still loads under Node. The fourth
// byte-identical copy of `iso` lived here.
import { iso } from './dates.js';

/**
 * Display-time resampling for the strength chart.
 *
 * Lives under public/ rather than src/ because the browser imports it and only
 * public/ is served — the same reason ui/calendar.js is here. It is purely
 * presentational: the score itself is computed server-side, daily, and this
 * only decides which of those points to plot.
 */

/** Start of the week containing `iso`, matching stats.js's bucketing. */
function startOfWeek(stamp, weekStart = 'monday') {
  const [y, m, d] = stamp.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = weekStart === 'sunday' ? date.getDay() : (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - dow);
  return iso(date);
}

/**
 * Must stay in step with BUCKETERS in src/stats.js — the two are separate
 * because the server may not import browser code, and a mismatch would make
 * the strength chart bucket differently from the history chart beside it.
 */
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
 * Thin a daily score series down to one point per bucket.
 *
 * Takes the LAST score in each bucket, not the average. The score is a running
 * level rather than a quantity, so averaging it would smooth away exactly the
 * recent movement the chart exists to show — a habit that collapsed in the
 * last week of a month would still look fine for that month.
 *
 * @param {Array<{date: string, score: number}>} scores
 * @param {string} granularity
 * @param {'monday'|'sunday'} [weekStart]
 */
export function resampleScores(scores, granularity = 'day', weekStart = 'monday') {
  if (granularity === 'day' || !scores?.length) return scores ?? [];

  // Own-property check: BUCKETERS['__proto__'] is Object.prototype, which is
  // truthy and not callable — the same trap that once 500'd /api/settings.
  if (!Object.hasOwn(BUCKETERS, granularity ?? '')) return scores;
  const bucketOf = BUCKETERS[granularity];

  const byBucket = new Map();
  for (const point of scores) {
    // Later points overwrite earlier ones, leaving the last of each bucket.
    byBucket.set(bucketOf(point.date, weekStart), point);
  }

  // The final point is always kept, even mid-bucket: it is the number the
  // header tile shows, and a chart stopping short of it would contradict it.
  const out = [...byBucket.values()];
  const last = scores[scores.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}
