/**
 * Awards: the figures `computeStats` already produced, read back as something
 * the app can TELL you rather than something you have to go and look up.
 *
 * Every award here is a reading. Nothing is stored, nothing is counted a second
 * way, and no award has a source that is not already on the stats response —
 * which is the whole reason this file is thirty lines of arithmetic and not a
 * table with a ledger behind it.
 *
 * **Nothing here is permanent, and an earlier draft of this file claimed
 * otherwise.** The claim was that a reading taken from a figure that only goes
 * up — `bestStreak`, the peak score, the longest lapse recovered from — could
 * not be taken away, so it was safe to present as something earned. That is
 * false, and it is false through the ordinary API. Two mechanisms, neither
 * patchable from here:
 *
 * 1. `computeStats` starts its window at `start ?? firstEntry`, and
 *    `onPaceSeries` pro-rates the requirement near the start of that window —
 *    deliberately, so a habit is not judged against history it does not have
 *    yet. Move the earliest entry EARLIER and the first `den - 1` days are
 *    re-judged against a full requirement they now fail. So logging one
 *    forgotten session takes a 3×/week habit from `bestStreak` 21 to 17, and
 *    the badge from "21-day streak" to "14-day streak". Daily habits
 *    (`num >= den`) have no leniency window and are immune; every other
 *    frequency is exposed.
 * 2. `MAX_RANGE_DAYS` clamps that window start to `end - 3660`, so a habit
 *    older than ten years — or one carrying a single ancient row from an
 *    import — has a SLIDING window rather than a growing one. Awards then
 *    shrink and vanish with no user action at all, purely as the calendar
 *    moves.
 *
 * So the framing is not "you have earned this" but **what this habit's history
 * currently shows**, which is the position `computeSurvival`'s docstring
 * already argues for one card further up: a reading you can act on beats a
 * trophy. Every label and every detail sentence here is a statement in the
 * present tense about the window that was computed, and the card says so. If
 * awards should ever be durable, the answer is the granted-ledger with a
 * first-earned date — issue #141 — and not a cleverer choice of figure. There
 * is no cleverer choice of figure; the window is the problem.
 *
 * What survives from that first draft is the part that was about the FIGURES
 * rather than about permanence, and it is still worth keeping. `currentStreak`
 * and the score's current value are refused: both fall on an ordinary bad week
 * with the window standing perfectly still, so a badge on either flickers for
 * reasons the user cannot even see. Reading a maximum does not make an award
 * durable, but it does stop it twitching day to day, which is a smaller and
 * true claim.
 */

import {
  daysBetween, unansweredCounts, SURVIVAL_THRESHOLDS, UNLOGGED_DEFAULT,
} from './stats.js';

/**
 * The strength ladder, calibrated against the real curve rather than against
 * intuition.
 *
 * The decay is Loop's, `0.5^(sqrt(frequency)/13)`, and `test/stats.test.js`
 * pins a perfect daily habit at ~50% on day 13, >75% at day 30 and >94% at day
 * 60. So the rungs are a fortnight, about a month, and about two months of
 * keeping it perfectly — and longer than that for anyone real. 50% is the one
 * that carries somebody who has just started, which is who an award is for;
 * 95% is a months-long goal.
 *
 * Presenting 95% "as one" is what the ladder does by SHOWING ONLY THE RUNG
 * REACHED, exactly as the streak ladder does. A new user is never handed a row
 * of greyed-out bands they have not earned, which is how a months-long goal
 * turns into a daily reminder of falling short — and the strength curve is
 * drawn full-height at the top of this very page, so how far there is to go is
 * already answered better than a badge could.
 */
export const STRENGTH_BANDS = [0.5, 0.8, 0.95];

/**
 * How long a comeback stays news.
 *
 * Deriving on every request has no "you just earned this" moment, which is the
 * thing it genuinely gives up. This is the cheapest honest substitute: the
 * award whose value MOVED when a lapse closed says so for a week.
 *
 * Pinned against a LITERAL in the test rather than against this name, because a
 * test that reads the constant proves only the off-by-one and passes with the
 * value changed to anything at all.
 */
export const COMEBACK_FRESH_DAYS = 7;

/**
 * How long a habit has to have been going to count as a long one.
 *
 * A year, and measured between the first good run and the most recent one —
 * see `computeAwards`. 365 rather than a calendar year because `daysBetween`
 * counts days and absorbs DST, and a leap day either way does not change what
 * this is claiming.
 */
const LONG_HAUL_DAYS = 365;

/**
 * A lapse this short is what "Recovered N times" already counts, so a second
 * award about it is one fact said twice. The comeback award is for the hole you
 * had to climb out of.
 */
const COMEBACK_MIN_DAYS = 2;

/**
 * @typedef {object} Award
 * @property {string} id        stable within a family; the tier moves with it
 * @property {string} family    'streak' | 'strength' | 'comeback' | 'recovered' |
 *                              'week' | 'tenure' | 'lapses'
 * @property {string} label     the badge itself
 * @property {string} detail    the number behind it, in a sentence
 * @property {number} value     the figure the award was read from
 * @property {boolean} fresh    this moved within COMEBACK_FRESH_DAYS
 *
 * There is deliberately no `permanent` here any more. It used to say which
 * awards could not be taken away, and the answer turned out to be none of
 * them — see the header. A flag that is false for every member is not a
 * distinction, and leaving it on the wire would have kept the claim alive in
 * the one place a client could act on it.
 */

/** @param {Partial<Award>} a @returns {Award} */
const award = (a) => /** @type {Award} */ ({ fresh: false, ...a });

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Every award this habit's history currently supports, in a fixed order.
 *
 * @param {import('./types.js').Stats} stats the response `computeStats` built
 * @param {string} end the day the stats were computed as of, 'YYYY-MM-DD'.
 *   The caller's day, not the container's — see `callerDay` in notify.js.
 * @param {*} [habit] the habit those stats are about. Read for ONE question —
 *   see the gate below — and never for a figure: everything an award reports
 *   comes off `stats`.
 * @param {string} [unlogged] the account's `atMostUnlogged`, as passed to
 *   `computeStats`. Same value, or the gate and the arithmetic disagree.
 * @returns {Award[]}
 */
export function computeAwards(stats, end, habit, unlogged) {
  /** @type {Award[]} */
  const out = [];
  if (!stats) return out;

  // A limit whose unanswered days count as KEPT earns nothing here, and this is
  // the one place awards decline to agree with the tiles beside them.
  //
  // Under that resolution the arithmetic counts every day nobody answered as a
  // success — deliberately, and documented: "I had no soda" is not something
  // anyone opens an app for, so silence is the answer. It is right for a tile,
  // which STATES A NUMBER the user can read against their own memory. It is
  // wrong for a badge, which makes A CLAIM IN ENGLISH: "You have kept this on
  // all seven weekdays at least once" over a habit with one stored row is a
  // sentence its owner knows to be false, and being told it undermines every
  // other sentence on the card. #63's own brief settles the tie — where an
  // award is pure vanity, prefer the chart — and every figure is still on the
  // chart and the tiles, unchanged.
  //
  // Asked through `unansweredCounts` rather than restated, so the habit's
  // `at_most_unlogged` beating the account's `atMostUnlogged` stays resolved in
  // the one place that knows the precedence.
  if (unansweredCounts(habit, unlogged ?? UNLOGGED_DEFAULT)) return out;

  /* ---- streaks: the ladder the survival curve already uses ---- */

  // Against `bestStreak` and never `currentStreak`. And only the rung reached,
  // not every rung passed: nine badges for a hundred-day habit is one fact said
  // nine times, and how far streaks usually get is the chart directly beside
  // this — which is a better answer to "what is next" than a greyed-out badge.
  const best = stats.bestStreak ?? 0;
  const rung = SURVIVAL_THRESHOLDS.filter((days) => days <= best).pop();
  if (rung) {
    out.push(award({
      id: `streak:${rung}`,
      family: 'streak',
      value: rung,
      label: `${rung}-day streak`,
      detail: `Your longest run so far is ${plural(best, 'day')}.`,
    }));
  }

  /* ---- strength: a high-water mark, because the score comes back down ---- */

  // The peak of the series, not `stats.score`. The score is a trailing-window
  // EWMA: a badge reading the current value flickers on and off with a bad
  // week, which is a badge that punishes you for the thing it is meant to
  // encourage. The series is what the chart above already plots.
  const peak = (stats.scores ?? []).reduce((max, p) => (p.score > max ? p.score : max), 0);
  // The highest band reached, and only that one — the same answer the streak
  // ladder gives, for the same reason.
  const band = STRENGTH_BANDS.filter((b) => peak >= b).pop();
  if (band) {
    const pct = Math.round(band * 100);
    out.push(award({
      id: `strength:${pct}`,
      family: 'strength',
      value: pct,
      label: `${pct}% strength`,
      detail: `Your strength has been as high as ${Math.round(peak * 100)}%.`,
    }));
  }

  const recovery = stats.resilience?.recovery;

  /* ---- resilience: the richest source, and the least like other apps ---- */

  if (recovery) {
    // The deepest hole climbed out of. `longest` is over CLOSED lapses only, so
    // being mid-slip neither earns this nor takes it away — the same line
    // `computeRecovery` already draws for the recovery rate, and the reason it
    // can be permanent.
    if (recovery.longest >= COMEBACK_MIN_DAYS) {
      out.push(award({
        id: `comeback:${recovery.longest}`,
        family: 'comeback',
        value: recovery.longest,
        label: `Back after ${plural(recovery.longest, 'day')}`,
        detail:
          `The longest lapse you have come back from lasted ` +
          `${plural(recovery.longest, 'day')}.`,
      }));
    }

    // `fresh` rides here rather than on the comeback, because this is the award
    // that MOVES on the day a lapse closes: the count goes up every time,
    // where the tier only moves when you beat your worst one.
    if (recovery.recovered > 0) {
      const since = recovery.lastEnd ? daysBetween(recovery.lastEnd, end) : NaN;
      out.push(award({
        id: 'recovered',
        family: 'recovered',
        value: recovery.recovered,
        label: `Recovered ${plural(recovery.recovered, 'time')}`,
        detail:
          `You were back on pace the next day after ${recovery.recovered} of ` +
          `${plural(recovery.lapses, 'lapse')}.`,
        fresh: since >= 0 && since <= COMEBACK_FRESH_DAYS,
      }));
    }
  }

  /* ---- the two "ever" claims, which is what makes them permanent ---- */

  // Every weekday kept at least once. An "at least once" claim over a window
  // that only grows, so it cannot come untrue — and note what it deliberately
  // is NOT: a threshold on all seven weekdays. `computeWeekdays` counts
  // COMPLETIONS and not pace, so a 3×/week habit kept perfectly has four
  // weekdays sitting at zero, and any rate test across all seven would be
  // unreachable for every non-daily habit. That is the `applicable: false`
  // shape `computeResilience` had to stop doing. "At least once" a Mon/Wed/Fri
  // habit can genuinely meet, by going once on a Sunday — it is simply a claim
  // about a rigid schedule that is false until it is true.
  const weekdays = stats.weekdays ?? [];
  if (weekdays.length === 7 && weekdays.every((d) => d.completed > 0)) {
    out.push(award({
      id: 'week:full',
      family: 'week',
      value: 7,
      label: 'Every day of the week',
      detail: 'You have kept this on all seven weekdays at least once.',
    }));
  }

  // The long haul, read from the STREAKS rather than from the habit's creation
  // date — which is not on the stats response, and which answers a slightly
  // different question anyway. "Created a year ago" is true of a habit
  // abandoned in its first week; what is worth an award is having been on pace
  // once and on pace again a year or more later, which is what the span
  // between the first run and the last one says. Both ends only move outward
  // as the window grows, so it is monotone, and it costs no new input.
  const streaks = stats.streaks ?? [];
  const span = streaks.length
    ? daysBetween(streaks[0].start, streaks[streaks.length - 1].end)
    : 0;
  const years = Math.floor(span / LONG_HAUL_DAYS);
  if (years >= 1) {
    out.push(award({
      id: `tenure:${years}`,
      family: 'tenure',
      value: years,
      label: years === 1 ? 'A year of keeping it' : `${years} years of keeping it`,
      // One run is both the first and the most recent, and "your first good run
      // and your most recent are 399 days apart" is a strange thing to read
      // about a habit that has simply never broken.
      detail: streaks.length === 1
        ? `One unbroken run, ${plural(streaks[0].length, 'day')} long.`
        : `Your first good run and your most recent are ${plural(span, 'day')} apart.`,
    }));
  }

  /* ---- the claim about the whole record ---- */

  // Read from the DISTRIBUTION, which counts an open run, and not from
  // `rate === 1`, which does not. Those two disagree in exactly the case that
  // matters: three days into a lapse, the closed set still says every lapse
  // lasted one day, and printing that over a lapse the user is currently in is
  // the sort of cheerful wrongness this whole file is meant to avoid. The
  // bucket is found by `min` and never by `label` — the labels are prose.
  const dist = stats.resilience?.missDistribution ?? [];
  const lapses = dist.reduce((n, b) => n + b.count, 0);
  const single = dist.find((b) => b.min === 1)?.count ?? 0;
  // Two, because one single-day lapse is precisely what "Recovered 1 time"
  // already said, and "never" is not a word one instance earns.
  if (lapses >= 2 && single === lapses) {
    out.push(award({
      id: 'lapses:single',
      family: 'lapses',
      value: lapses,
      label: 'No lapse over a day',
      detail: `All ${plural(lapses, 'lapse')} so far have lasted a single day.`,
    }));
  }

  return out;
}
