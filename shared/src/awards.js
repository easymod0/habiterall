/**
 * Awards: the figures `computeStats` already produced, read back as something
 * the app can TELL you rather than something you have to go and look up.
 *
 * Every award here is a reading. Nothing is stored, nothing is counted a second
 * way, and no award has a source that is not already on the stats response —
 * which is the whole reason this file is thirty lines of arithmetic and not a
 * table with a ledger behind it.
 *
 * Two rules decide what may be in here, and they are the ones that cost
 * something to get wrong:
 *
 * **A derived award can be REVOKED, so only a monotone reading may be dressed
 * as a trophy.** With no ledger there is no "you earned this on the 4th": the
 * award exists for exactly as long as the numbers say so. `bestStreak`, the
 * peak score, the longest lapse recovered from and the recovery count all only
 * ever go up as the window grows, so an award read off one of them cannot be
 * taken away. `permanent` says which, and it is on the payload rather than
 * implicit so that the next award of the other kind has to say what it is.
 *
 * **The one that is not monotone is worded as a record, not as a medal.** "No
 * lapse over a day" is a claim about the whole history and a two-day lapse ends
 * it — there is no honest way to make that permanent short of storing it, which
 * is the decision issue #63 defers. It is `permanent: false`, and it reads as a
 * statement of fact so that its going away is the fact changing rather than a
 * prize being confiscated.
 *
 * Note what is deliberately NOT read here: `currentStreak`, and the score's
 * current value. Both go down. An award tied to either un-earns itself on the
 * day the run ends, which is the single most demotivating thing this could do.
 */

import { daysBetween, SURVIVAL_THRESHOLDS } from './stats.js';

/**
 * The one strength band in this first set.
 *
 * Calibrated against the real curve rather than against intuition. The decay is
 * Loop's, `0.5^(sqrt(frequency)/13)`, and `test/stats.test.js` pins a perfect
 * daily habit at ~50% on day 13, >75% at day 30 and >94% at day 60. So 50% is a
 * fortnight of keeping it — reachable by someone who has just started, which is
 * who an award is for. The 80% and 95% bands are months-long goals and want to
 * be presented as such; they are not in this pass.
 */
export const STRENGTH_BAND = 0.5;

/**
 * How long a comeback stays news.
 *
 * Pure derivation has no "you just earned this" moment, which is the thing it
 * genuinely gives up. This is the cheapest honest substitute: the award whose
 * value MOVED when a lapse closed says so for a week. The award itself is
 * permanent — it is the emphasis that expires, not the badge.
 */
export const COMEBACK_FRESH_DAYS = 7;

/**
 * A lapse this short is what "Recovered N times" already counts, so a second
 * award about it is one fact said twice. The comeback award is for the hole you
 * had to climb out of.
 */
const COMEBACK_MIN_DAYS = 2;

/**
 * @typedef {object} Award
 * @property {string} id        stable within a family; the tier moves with it
 * @property {string} family    'streak' | 'strength' | 'comeback' | 'recovered' | 'lapses'
 * @property {string} label     the badge itself
 * @property {string} detail    the number behind it, in a sentence
 * @property {number} value     the figure the award was read from
 * @property {boolean} permanent  false only for a claim a future lapse can end
 * @property {boolean} fresh    this moved within COMEBACK_FRESH_DAYS
 */

/** @param {Partial<Award>} a @returns {Award} */
const award = (a) => /** @type {Award} */ ({ permanent: true, fresh: false, ...a });

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Every award this habit's history supports, in a fixed order.
 *
 * @param {import('./types.js').Stats} stats the response `computeStats` built
 * @param {string} end the day the stats were computed as of, 'YYYY-MM-DD'.
 *   The caller's day, not the container's — see `callerDay` in notify.js.
 * @returns {Award[]}
 */
export function computeAwards(stats, end) {
  /** @type {Award[]} */
  const out = [];
  if (!stats) return out;

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
  if (peak >= STRENGTH_BAND) {
    out.push(award({
      id: `strength:${Math.round(STRENGTH_BAND * 100)}`,
      family: 'strength',
      value: Math.round(STRENGTH_BAND * 100),
      label: `${Math.round(STRENGTH_BAND * 100)}% strength`,
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

  /* ---- and the one that is a record rather than a trophy ---- */

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
      permanent: false,
    }));
  }

  return out;
}
