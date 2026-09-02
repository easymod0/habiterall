#!/usr/bin/env node
/**
 * What `/overview` spends per habit, broken down by pass.
 *
 *   npm run bench:overview
 *
 * This is the measurement base for the backend cost sequence (#204): #183
 * (five discarded passes), #184 (two lifetime figures re-derived per load),
 * #196 (materialisation) and #198 (the date walk) all quote numbers produced
 * by a bench of this shape. It is committed because the original was not — it
 * sat untracked at the repo root, and by the time #198 landed and the sequence
 * needed re-sizing it was gone. Nobody could then confirm they were measuring
 * the same thing, which is the only property a measurement base has.
 *
 * So: the fixture, the window and the habit shape are written into this file
 * as literals, and the numbers below are falsifiable against it.
 *
 * ## What it does NOT measure
 *
 * No database, no HTTP, no serialisation. This is the synchronous CPU the
 * route spends inside `shared/src/stats.js`, which is the part that is the
 * same in both editions and the part every issue in the sequence is about.
 * Query cost is #185 and #188; the wire is #189.
 *
 * ## The methodological warning this bench exists to respect
 *
 * #199 records that an isolated kernel said replacing `Number(x.toFixed(6))`
 * with `Math.round(x*1e6)/1e6` was a 7.4x win, and against the real module it
 * was 1.09x. A microbenchmark that isolates the arithmetic measures the
 * language and not the program. Every table here therefore reports the
 * WHOLE-MODULE call — both `computeStats`, the old cost, and `summaryStats`,
 * what `/overview` actually invokes now — beside the pass breakdown, and a
 * pass is only ever timed as the route's own code calls it, with the same
 * arguments and the same shared `streaks`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeStats, summaryStats, computeScores, computeStreaks, bestStreak, currentStreak,
  creditAnchor,
  computeHistory, computeWeekdays, computeWeekdayByMonth, computeFrequency,
  computeResilience, computeCoverage, computeMissRuns,
  boundedRange, addDays, UNLOGGED_DEFAULT,
} from '@habiterall/shared/stats.js';

const ROOT = join(import.meta.dirname, '..');

/* ---------- the fixture, stated ---------- */

/**
 * The window anchor. FIXED, not `today()`: a bench whose window slides with
 * the calendar produces numbers that cannot be compared across two runs a
 * month apart, which is exactly the comparison this file exists to allow.
 */
const END = '2026-06-30';

/** `SUMMARY_WINDOW_DAYS` — what `summaryStats` is given on `/overview` now; `computeStats` is still given it here too, for the old-cost row. */
const WINDOW_DAYS = 400;

/**
 * `STREAK_HISTORY_DAYS` — what the separate `bestStreak` scan reads.
 *
 * Declared in `shared/src/summary-cache.js` since #184, not per edition: the
 * window is part of what the CACHED figure means.
 */
const HISTORY_DAYS = 1830;

/**
 * Rows per day of history. 0.8 is what produces #183's stated fixture —
 * 1,464 rows over five years, 320 of them inside the summary window — and
 * those two counts are asserted below rather than hoped for.
 */
const DENSITY = 0.8;

/** Fixed, so the arrangement of misses is identical on every machine. */
const SEED = 0x5eed_1830;

/** Iterations per timed batch, and batches per figure. See `bench()`. */
const ITERATIONS = 200;
const BATCHES = 3;
const WARMUP = 30;

/** Habit counts the per-request rows are projected to, as in #183. */
const HABIT_COUNTS = [20, 50];

/**
 * A boolean daily habit, every present row a completion.
 *
 * Deliberately the plain case. Skips are NOT modelled and neither is a
 * numerical target: both change which branch of `isCompleted` runs, and the
 * point of this bench is to stay comparable to the figures already quoted in
 * #183/#184/#196, which were taken on a shape like this one. Add a second
 * fixture rather than editing this one, or the sequence loses its baseline.
 */
const HABIT = {
  id: 1,
  name: 'bench',
  description: '',
  type: 'boolean',
  unit: '',
  target_value: 0,
  target_type: 'at_least',
  freq_numerator: 1,
  freq_denominator: 1,
  color: '#4caf50',
  reminder_time: '',
  reminder_message: '',
  at_most_unlogged: 'default',
  show_as: 'amount',
  icon: '',
  archived: false,
};

/* ---------- keeping the fixture honest ---------- */

/**
 * Fail if the app no longer uses the windows this file measures.
 *
 * This reads SOURCE TEXT, so it is the weak kind of guard CLAUDE.md warns
 * about: it cannot see a renamed binding, and it cannot see a call site that
 * stopped passing the constant at all. Kept for the one thing it does catch,
 * which is the thing that actually happens — somebody tunes 400 or 1830 and
 * this bench goes on quoting figures for a window the app no longer has. The
 * behavioural half is that the numbers below are per-pass: a window change
 * moves all of them together and visibly.
 *
 * **The two constants are no longer declared in the same place, and that is
 * #184.** `SUMMARY_WINDOW_DAYS` is still one declaration per edition, so both
 * are read; `STREAK_HISTORY_DAYS` moved into `shared/src/summary-cache.js`,
 * because the window a CACHED `bestStreak` was computed over is part of what
 * the stored number means and two editions must not drift on it. So it is read
 * once, from there. This function reading both editions in one pass is why it
 * had to be repointed for both at once even though only cloud's declaration
 * has gone yet.
 */
function assertWindowsMatchTheRoutes() {
  /**
   * @param {string} file repo-relative
   * @param {string} name
   * @param {number} want
   */
  const windowIn = (file, name, want) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const m = src.match(new RegExp(`const ${name}\\s*=\\s*(\\d+)`));
    if (!m) {
      throw new Error(
        `${file} no longer declares ${name}. This bench's window literals are ` +
        `now unanchored — re-read the source and update WINDOW_DAYS / ` +
        `HISTORY_DAYS here, then re-measure #183, #184 and #196.`
      );
    }
    if (Number(m[1]) !== want) {
      throw new Error(
        `${file} has ${name} = ${m[1]} and this bench assumes ${want}, which is ` +
        `the window every figure quoted in #183/#184/#196 was taken over. ` +
        `Re-measure before quoting the old numbers.`
      );
    }
  };

  for (const edition of ['habiterall-cloud', 'habiterall-personal']) {
    windowIn(join(edition, 'src', 'api.js'), 'SUMMARY_WINDOW_DAYS', WINDOW_DAYS);
  }
  windowIn(join('shared', 'src', 'summary-cache.js'), 'STREAK_HISTORY_DAYS', HISTORY_DAYS);
}

/* ---------- the fixture itself ---------- */

/** mulberry32 — small, seeded, and identical on every platform. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Choose `count` of `days`, always including the first.
 *
 * The first day is forced present because `computeStats` takes its window
 * start from the EARLIEST STORED ENTRY when the caller names none — which is
 * what `/overview` does. Leaving that to the seed would make the walked
 * window a day or two shorter at random, and a bench whose window depends on
 * its own randomness cannot be compared to itself.
 */
function pick(days, count, rng) {
  const rest = days.slice(1);
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [days[0], ...rest.slice(0, count - 1)].sort();
}

/**
 * Five years of history, dense but not regular.
 *
 * The two segments are filled INDEPENDENTLY — 80% of the 400-day summary
 * window and 80% of the 1,430 days before it — so both counts #183 states are
 * exact, rather than one of them being a draw around its mean.
 *
 * The arrangement inside each segment is shuffled rather than periodic. A
 * regular "every fifth day missing" pattern hits the same counts and makes
 * every miss run one day long, which would leave `computeResilience` — the
 * largest discarded pass, and the one that runs `computeMissRuns` and then
 * three aggregations over the result — measured on input that costs nothing
 * to aggregate. That is the bench version of a test that cannot fail.
 */
function buildEntries() {
  const beforeDays = HISTORY_DAYS - WINDOW_DAYS;
  const rng = mulberry32(SEED);

  const windowStart = addDays(END, -(WINDOW_DAYS - 1));
  const historyStart = addDays(END, -(HISTORY_DAYS - 1));

  const window = boundedRange(windowStart, END);
  const before = boundedRange(historyStart, addDays(windowStart, -1));

  const dates = [
    ...pick(before, Math.round(beforeDays * DENSITY), rng),
    ...pick(window, Math.round(WINDOW_DAYS * DENSITY), rng),
  ];

  return dates.map((date) => ({ date, value: 2, status: '' }));
}

/**
 * Everything the tables below claim about the fixture, checked.
 *
 * A bench states its fixture in prose and then measures whatever it actually
 * built; these are the sentences in #183 and #184, asserted. The last group
 * is the one that matters most: each discarded pass is called once and its
 * result checked for being non-trivial, because a pass that early-returns an
 * empty result is fast for a reason that has nothing to do with the program.
 */
function verify(all, recent, streaks) {
  // The LITERALS #183 states, not `HISTORY_DAYS * DENSITY`. Deriving the
  // expectation from the constants that built the fixture makes the check
  // self-consistent and therefore unfalsifiable — it passed with DENSITY
  // changed to 0.7, which is a different fixture and different numbers.
  const expectRows = 1464;
  const expectWindow = 320;

  const check = (label, got, want) => {
    if (got !== want) {
      throw new Error(`fixture: ${label} is ${got}, expected ${want}`);
    }
  };

  check('total rows', all.length, expectRows);
  check('rows in the summary window', recent.length, expectWindow);
  check('the walked summary window', boundedRange(recent[0].date, END).length, WINDOW_DAYS);
  check('the walked history window', boundedRange(all[0].date, END).length, HISTORY_DAYS);

  const entryMap = new Map(recent.map((e) => [e.date, { value: e.value, status: e.status }]));
  const from = recent[0].date;

  const missRuns = computeMissRuns(HABIT, entryMap, from, END, UNLOGGED_DEFAULT);
  const longestMiss = missRuns.reduce((m, r) => Math.max(m, r.length ?? 0), 0);

  const nonTrivial = {
    'computeScores': computeScores(HABIT, entryMap, from, END).length,
    'computeStreaks': streaks.length,
    'computeHistory': computeHistory(HABIT, entryMap, from, END).length,
    'computeWeekdays': computeWeekdays(HABIT, entryMap, from, END).length,
    'computeWeekdayByMonth': computeWeekdayByMonth(HABIT, entryMap, from, END).length,
    'computeFrequency': computeFrequency(HABIT, entryMap, from, END).length,
    'computeCoverage': computeCoverage(entryMap, from, END).length,
    'miss runs': missRuns.length,
  };

  for (const [label, n] of Object.entries(nonTrivial)) {
    if (!n) throw new Error(`fixture: ${label} produced nothing — it is not being exercised`);
  }

  // A regular miss pattern would cap this at 1 and quietly make
  // `computeResilience` the cheapest pass instead of the dearest.
  if (longestMiss < 2) {
    throw new Error(
      `fixture: longest miss run is ${longestMiss} — the misses are evenly ` +
      `spaced, so computeResilience is aggregating nothing`
    );
  }

  return { ...nonTrivial, 'longest miss run': longestMiss };
}

/* ---------- timing ---------- */

/** Defeats dead-code elimination: every timed call feeds this. */
let sink = 0;

/**
 * Mean ms per call, taking the BEST of `BATCHES` batches.
 *
 * The minimum is the least-noise estimate of the work itself — a batch can
 * only ever be made slower by a GC pause or the scheduler, never faster — and
 * this bench is used to compare one revision against another rather than to
 * predict production latency.
 */
function bench(fn) {
  for (let i = 0; i < WARMUP; i += 1) sink += fn() ? 1 : 0;

  let best = Infinity;
  for (let b = 0; b < BATCHES; b += 1) {
    const t0 = performance.now();
    for (let i = 0; i < ITERATIONS; i += 1) sink += fn() ? 1 : 0;
    const mean = (performance.now() - t0) / ITERATIONS;
    if (mean < best) best = mean;
  }
  return best;
}

const ms = (n) => n.toFixed(2);
const us = (n) => (n * 1000).toFixed(1);
const pct = (n, of) => `${((n / of) * 100).toFixed(0)}%`;

/* ---------- the tables ---------- */

function main() {
  assertWindowsMatchTheRoutes();

  const all = buildEntries();
  const cutoff = addDays(END, -WINDOW_DAYS);
  const recent = all.filter((e) => e.date >= cutoff);

  const from = recent[0].date;
  // The date both routes resolve once per habit and hand to every figure on the
  // row (#223) — the LIFETIME earliest row that states a value, which is what
  // `creditAnchor` takes. Read off `all` rather than `recent`, because that is
  // where the routes read it from: a grouped `MIN(date)` over the whole table.
  const firstStated = all.find((e) => (e.status ?? '') !== 'skip')?.date ?? null;
  const recentMap = new Map(recent.map((e) => [e.date, { value: e.value, status: e.status }]));
  const streaks = computeStreaks(HABIT, recentMap, from, END, UNLOGGED_DEFAULT);

  const shapes = verify(all, recent, streaks);

  console.log(`# /overview per-habit CPU\n`);
  console.log(`node ${process.version}, ${ITERATIONS} iterations x ${BATCHES} batches, warmed, best batch`);
  console.log(`window ${END} back ${WINDOW_DAYS}d (summary) and ${HISTORY_DAYS}d (streaks)`);
  console.log(`${all.length} rows, ${recent.length} inside the summary window, boolean daily habit\n`);

  /* --- the whole-module call, first, per #199 --- */

  const route = bench(() =>
    computeStats(HABIT, recent, { end: END, unlogged: UNLOGGED_DEFAULT, coverage: false }));

  // #183's actual fix: this is what `/overview` calls now, timed the same way
  // as the row above — same fixture, same `END`, same warmup — so the two are
  // directly comparable rather than one being a cold call.
  // `creditFrom` supplied, as the route supplies it (#223): both routes resolve
  // ONE credit date per habit from the lifetime first STATED answer and hand it
  // to this call and to the streak scan below, so a bench omitting it would pay
  // for a `firstStatedAnswer` walk over the whole window that the route skips —
  // and would overstate the figure quoted in `shared/CLAUDE.md`.
  const creditFrom = creditAnchor(firstStated, END);
  const summary = bench(() =>
    summaryStats(HABIT, recent, { end: END, unlogged: UNLOGGED_DEFAULT, creditFrom }));

  /* --- #183: what the route keeps and what it throws away --- */

  const kept = bench(() => {
    const m = new Map(recent.map((e) => [e.date, { value: e.value, status: e.status }]));
    const s = computeScores(HABIT, m, from, END, UNLOGGED_DEFAULT);
    const st = computeStreaks(HABIT, m, from, END, UNLOGGED_DEFAULT);
    return s.length + st.length + currentStreak(st, END);
  });

  const discarded = {
    computeHistory: bench(() => computeHistory(HABIT, recentMap, from, END, 'day', 'monday', UNLOGGED_DEFAULT).length),
    computeWeekdays: bench(() => computeWeekdays(HABIT, recentMap, from, END, UNLOGGED_DEFAULT).length),
    computeWeekdayByMonth: bench(() => computeWeekdayByMonth(HABIT, recentMap, from, END, UNLOGGED_DEFAULT).length),
    computeFrequency: bench(() => computeFrequency(HABIT, recentMap, from, END, 'monday', UNLOGGED_DEFAULT).length),
    computeResilience: bench(() => computeResilience(HABIT, recentMap, streaks, from, END, UNLOGGED_DEFAULT) ? 1 : 0),
  };

  const discardedTotal = Object.values(discarded).reduce((a, b) => a + b, 0);
  const passTotal = kept + discardedTotal;

  console.log(`## #183 — the five discarded passes\n`);
  console.log(`| pass | ms/habit | |`);
  console.log(`|---|---:|---|`);
  console.log(`| \`computeStats\` (\`coverage: false\`) — what \`/overview\` used to call | ${ms(route)} | whole module |`);
  console.log(`| \`summaryStats\` — what \`/overview\` calls now | **${ms(summary)}** | whole module |`);
  console.log(`| \`computeScores\` + \`computeStreaks\` | ${ms(kept)} | KEPT |`);
  for (const [name, t] of Object.entries(discarded)) {
    console.log(`| \`${name}\` | ${ms(t)} | discarded |`);
  }
  console.log(`| | | |`);
  console.log(`| kept | ${ms(kept)} | ${pct(kept, passTotal)} |`);
  console.log(`| discarded | ${ms(discardedTotal)} | **${pct(discardedTotal, passTotal)}** |\n`);

  // No route declines this any more — `/overview` doesn't call `computeStats`
  // at all now, so there is nothing left to opt a field out of there. Measured
  // anyway because it is still `computeStats`'s own opt-out, paid on
  // `/habits/:id/stats`, and #183 ended up as a second entry point rather than
  // the per-field `fields` option that would have made this the precedent for.
  const coverage = bench(() => computeCoverage(recentMap, from, END).length);
  console.log(`\`computeCoverage\` is ${ms(coverage)} ms/habit — still \`computeStats\`'s opt-out; \`/overview\` no longer calls \`computeStats\` at all to decline it.\n`);

  // The passes are timed one at a time and `computeStats` is timed whole, so
  // they are two independent measurements of the same work and the remainder
  // is a statement about the bench rather than about the program. It should be
  // the entry Map plus the `totalCompleted` filter and nothing else; a large
  // or negative remainder means a pass here is not the call the route makes.
  const unaccounted = route - passTotal;
  console.log(
    `Passes sum to ${ms(passTotal)} ms against ${ms(route)} ms for the whole ` +
    `module — ${ms(unaccounted)} ms unaccounted, which is the entry Map and ` +
    `\`totalCompleted\`.\n`
  );

  console.log(`Per request — what \`/overview\` used to spend calling \`computeStats\`, against what \`summaryStats\` costs it now:\n`);
  for (const n of HABIT_COUNTS) {
    console.log(`- ${n} habits — was ${ms(route * n)} ms, now ${ms(summary * n)} ms, saving ~${ms((route - summary) * n)} ms`);
  }
  console.log('');

  /* --- #184: the two lifetime figures --- */

  const mapBuild = bench(() =>
    new Map(all.map((e) => [e.date, { value: e.value, status: e.status }])).size);

  const streakScan = bench(() => {
    const m = new Map(all.map((e) => [e.date, { value: e.value, status: e.status }]));
    // The route's own shape, `creditAnchor` included (#223): it resolves one
    // credit date per habit and hands it to this scan and to `summaryStats`
    // alike, so a bench that omitted it would stop measuring the code it names.
    // The same `firstStated` date as the summary above, not `all[0].date`: the
    // route's date is the first row that STATES a value, and the two differ for
    // any habit whose earliest row is a skip.
    return bestStreak(computeStreaks(HABIT, m, all[0].date, END, UNLOGGED_DEFAULT,
      creditAnchor(firstStated, END)));
  });

  console.log(`## #184 — \`bestStreak\` over ${HISTORY_DAYS} days, per habit, per load\n`);
  console.log(`| | ms/habit |`);
  console.log(`|---|---:|`);
  console.log(`| \`computeStreaks\`(${HISTORY_DAYS}d) + \`bestStreak\` | **${ms(streakScan)}** |`);
  console.log(`| of which building the ${all.length}-row Map | ${ms(mapBuild)} |`);
  console.log(`| \`/overview\` per-habit total, old (this + \`computeStats\`) | ${ms(route + streakScan)} |`);
  console.log(`| \`/overview\` per-habit total, now (this + \`summaryStats\`) | **${ms(summary + streakScan)}** |`);
  console.log(`| \`bestStreak\`'s share of it, old | ${pct(streakScan, route + streakScan)} |`);
  console.log(`| \`bestStreak\`'s share of it, now | **${pct(streakScan, summary + streakScan)}** |\n`);

  /* --- #198: the walk that used to be 89% of it --- */

  const walkWindow = bench(() => boundedRange(from, END).length);
  const walkHistory = bench(() => boundedRange(all[0].date, END).length);
  const scoresOnly = bench(() => computeScores(HABIT, recentMap, from, END, UNLOGGED_DEFAULT).length);

  console.log(`## #198 — the date walk, now that it is one \`Date\` instead of ${WINDOW_DAYS}\n`);
  console.log(`| | us | share of the pass |`);
  console.log(`|---|---:|---:|`);
  console.log(`| \`boundedRange\`, ${WINDOW_DAYS} days | ${us(walkWindow)} | ${pct(walkWindow, scoresOnly)} of \`computeScores\` |`);
  console.log(`| \`boundedRange\`, ${HISTORY_DAYS} days | ${us(walkHistory)} | ${pct(walkHistory, streakScan)} of the \`bestStreak\` scan |`);
  console.log(`| \`computeScores\`, whole pass | ${us(scoresOnly)} | |\n`);

  console.log(`<details><summary>fixture shape, asserted</summary>\n`);
  for (const [k, v] of Object.entries(shapes)) console.log(`- ${k}: ${v}`);
  console.log(`\n</details>`);

  if (!Number.isFinite(sink)) throw new Error('unreachable');
}

main();
