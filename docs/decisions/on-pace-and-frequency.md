# `onPaceSeries` rounded a fractional requirement up — #340

`onPaceSeries` (`shared/src/stats.js`) judges a trailing `denominator`-day
window by comparing a COUNT of completed days against a REQUIREMENT computed as
a ratio — `num * activeDays / den`. The count is necessarily an integer;
the requirement is not, except on the one day in seven the window happens to
divide evenly. Comparing them with `>=` rounds the requirement UP to the next
whole day, because a count that falls short of a fractional target by any
margin still falls short of the integer above it. That is backwards: it makes
the habit demand MORE than its own rate, and it demands most from the days
that have the least history to judge.

## The demanded rate, measured

A 3×/7 habit asks for 43%. Here is what `windowDone + 1e-9 >= required` (the
unfixed code) actually demanded, at every window length inside the first
`den - 1` days of any range:

```
days in window   required   integer days you must have   rate demanded   habit asks
  1               0.429        1                           100%            43%
  2               0.857        1                            50%            43%
  3               1.286        2                            67%            43%
  4               1.714        2                            50%            43%
  5               2.143        3                            60%            43%
  6               2.571        3                            50%            43%
  7               3.000        3                            43%            43%
```

Only the full window (`num * den / den` is exactly `num`) lands on the number
the habit was actually set to. Every window shorter than that overshoots, and
the worst of it — 100% on day one — is exactly the day with the least evidence
behind it. This is why daily habits (`num >= den`) never showed the bug: their
window is one day and `num * 1 / 1` is always a whole number, so `>=` against
it and `>=` against its floor agree everywhere.

It is also why the three existing 3×/7 tests in `shared/test/stats.test.js`
(`:670`, `:684`, `:701`) never caught it — all three keep the habit on
Mon+Wed+Fri, and that layout survives the unfixed rounding for a reason that
is NOT "the ratio happens to land on a whole number more often": the rounded-up
requirement demands its completions FRONT-LOADED, and Mon+Wed+Fri front-loads
where, say, Sat+Sun+Mon does not. Measured day by day from the day each range
opens (3×/7, the unfixed rounded-up requirement):

```
Mon+Wed+Fri                          Sat+Sun+Mon
day 1  X  have 1  needs 1  on pace   day 1  X  have 1  needs 1  on pace
day 2  .  have 1  needs 1  on pace   day 2  .  have 1  needs 1  on pace
day 3  X  have 2  needs 2  on pace   day 3  .  have 1  needs 2  OFF PACE
day 4  .  have 2  needs 2  on pace   day 4  .  have 1  needs 2  OFF PACE
day 5  X  have 3  needs 3  on pace   day 5  .  have 1  needs 3  OFF PACE
day 6  .  have 3  needs 3  on pace   day 6  X  have 2  needs 3  OFF PACE
day 7  .  have 3  needs 3  on pace   day 7  X  have 3  needs 3  on pace
```

Mon+Wed+Fri puts a completion on days 1, 3 and 5, so its running count meets
the rounded-up requirement at every step along the way. Sat+Sun+Mon's first
completion is also day 1, but its next two do not land until days 6 and 7 — so
the one completion it is carrying alone has to cover it through day 5, by
which point the rounded-up requirement has already climbed to 3. Any layout
that front-loads its completions inside the window happens to survive the
unfixed rounding; any layout that back-loads them, or any layout at all with a
skip inside the window, exposes it.

## Five schedules, same rate, different answers

Perfect adherence — exactly 3 completions every 7 days, 39 entries, no misses —
over 2026-01-05 .. 2026-04-05 (91 days), through `computeStats`, before and
after this fix:

```
                 before        after
Mon+Wed+Fri      91, 1 run     91, 1 run
Tue+Thu+Sat      90, 1 run     90, 1 run
Fri+Sat+Sun      87, 1 run     87, 1 run
Sat+Sun+Mon      85, 2 runs    91, 1 run
Sun+Mon+Tue      85, 2 runs    91, 1 run
```

Fri+Sat+Sun reads 87 both before and after — its first entry falls four days
later than the others, so its range is genuinely shorter, and that is not a
defect. The other four schedules are all the same rate kept for the same 91
days, and before the fix three different weekday layouts produced three
different answers to "how long has this streak been unbroken", including two
that fractured a perfect 91-day run into two runs of it. A 5×/7 habit kept
Thu-Mon over the same range shows the same shape: 85 days, 2 runs before this
fix; 91 days, 1 run after.

## The skip inversion

The pro-rating is supposed to make skips cost less, not more. 3×/7 on
Mon/Wed/Fri, 2026-01-01 .. 2026-02-01, with 2026-01-21 and 2026-01-22 both
marked skip: before the fix, two runs — 16 days and 6 days, the skips
themselves splitting what should have been one unbroken run. After: one run,
`{start: '2026-01-02', end: '2026-02-01', length: 31, skips: 2}`. Two skip
days made the habit HARDER to keep up with than zero skip days would have —
`activeDays` shrank, and shrinking the denominator of a ratio that then gets
rounded UP pushed the integer requirement higher, not lower.

## The strength/streak disagreement this closes

`shared/CLAUDE.md`'s "A streak and a lapse are made of 'on pace'" paragraph and
`docs/decisions/must-stay-fixed.md`'s item 2 both assert that `onPaceSeries`
and `computeScores` ask the same trailing-window question so the two figures
cannot disagree about whether a day was kept. On the skip fixture above they
did disagree, because `computeScores` never inherited this rounding — its
`adherence = Math.min(1, windowSum / target)` stays continuous and was never
compared against an integer at all. Measured on that same fixture: the score
on 2026-01-20 (the last day that read as on pace even before the fix) is
0.466383, and it keeps climbing through the three days the unfixed streak
called a lapse — 0.507831 on 2026-01-23, 0.522427 on 2026-01-24, 0.550135 on
2026-01-26. Score and streak disagreed about all three; that was the stated
invariant failing, not merely the streak looking wrong in isolation.

## Why floor, and why the unfilled-window clause — neither alone is enough

The fix is two guarded halves in `onPaceSeries`:

```js
const required = Math.max(1, Math.floor(Math.min(activeDays, (num * activeDays) / den) + 1e-9));
const potential = windowDone + (den - windowDays);

ok: activeDays <= 0 || windowDone + 1e-9 >= required
  || (windowDone >= 1 && potential + 1e-9 >= Math.min(activeDays, num));
```

This is the AT-BIRTH branch only — the one that runs while `dates[0] === birth`
— and the ablations below are about the two guards inside it. The gate that
decides whether this branch or master's own, unfloored expression runs for a
given day is a review-round addition, covered in its own section further down;
it changes nothing about which fixture exercises which guard here.

Neither half is separable along a clean "this fixture, not that one" line —
measured by ablating each of the four sub-expressions in isolation against
SIX fixtures, not two: Sat+Sun+Mon and the 5×/7 Thu-Mon schedule (the two
front-loading cases), the Mon/Wed/Fri-with-two-skips fixture, the under-target
case (3×/7 done only 2 days a week, `currentStreak` must read 0), and the two
`bestStreak`-manufactured-from-silence cases (a lone stated lapse, a lone
skip). The ablations are MORE entangled than "each half owns one fixture",
which is worse for isolating either half and better for what it says about
the coverage: no single fixture in the set is carried by only one guard.

- **Dropping `Math.max(1, …)`** — `Math.floor(...)` alone, no floor at
  1 — fails **four** of the six: the lone-lapse and lone-skip cases (a
  requirement of 0 on day one, `Math.floor(0.429)`, is trivially met by a
  window holding nothing at all — measured, `bestStreak` 2 for the lone
  lapse), and, less obviously, the two-skip and under-target cases too:
  without the floor at 1, a day whose window has too few active days to
  round up to even 1 completion passes the FIRST condition on nothing, which
  papers over exactly the shortfall the `windowDone >= 1` gate on the clause
  exists to catch, so the fixtures that exercise that gate fail once the
  floor stops forcing a nonzero requirement onto it. Sat+Sun+Mon and Thu-Mon
  are unaffected — their divergence from master is about the CLAUSE, not the
  floor's lower bound.
- **Deleting `windowDone >= 1 &&` from the clause** fails the SAME four —
  lone-lapse, lone-skip, two-skip and under-target — for the mirror-image
  reason: with the evidence gate gone, `potential` alone reads a window with
  ZERO completions in it as "still able to reach target" purely because days
  remain, which is precisely the #223 shape both `bestStreak`-from-silence
  fixtures are built to catch, and the same ungated clause also papers over
  the two-skip and under-target shortfalls the way the missing floor does
  above — two different sub-expressions guarding the identical set of four
  fixtures from two different directions.
- **Deleting the whole clause** — no leniency at all, `ok` decided by the
  floored requirement alone — fails Sat+Sun+Mon, 5×/7 Thu-Mon and
  under-target. The two front-loading fixtures fail for the reason the clause
  exists: a still-filling window cannot pass on `windowDone` alone once every
  short window is compared against a strictly-positive floored requirement.
  Under-target fails too, for a subtler reason: that fixture's `currentStreak`
  reads 0 only because every trailing window this schedule can ever fill
  floors its requirement down to 1, which the FIRST Monday already meets
  without needing the clause — remove the clause and that same first Monday
  needs the clause to be judged at all (`windowDays < den` there), so the one
  streak the fixture asserts (`length: 1`) disappears along with the two it
  is checking are absent. The two-skip and lone-row fixtures are unaffected
  by this ablation — their divergence from master is about the FLOOR and the
  evidence gate, not the clause's leniency.

So `Math.max(1, …)`, the `windowDone >= 1` gate and the clause are not three
independent features each answering its own fixture — they overlap, and the
overlap is what makes the set of six fixtures a stronger net than "one guard,
one bug" would suggest: the same four fixtures catch a missing floor AND a
missing evidence gate, from opposite directions, while a third, disjoint set
of three catches a missing clause. Every guard is still necessary — no
ablation above leaves all six passing — but "each half fixes one fixture and
does nothing for the other" overstated how separable they are.

Both holes are #223's shape — a lone imported or stray row manufacturing a
streak out of silence rather than out of anything the habit did — and both
read `bestStreak` 0 on master and 0 after the full fix. Neither is unbounded:
the clause's `potential` term is `windowDone + (den - windowDays)`, and
`den - windowDays` is 0 once the window has fully filled (`windowDays` reaches
`den`), so an ungated clause can only manufacture a run inside the first
`den - 1` days of a range — measured `bestStreak` 4 for the lone-skip fixture
holds regardless of how far past that the range extends (checked out to five
months past the stray row), it does not keep growing.

## The accepted price

A 3×/7 habit with exactly one completion and then silence now reads on pace
for 5 days, where master gave 2. This is Mark's call, not a bug: while the
first 7-day window is still open, and it holds at least the one completion
the evidence gate asks for, the habit has not yet had the chance to fall
behind — the unfilled-window clause is doing exactly what it is for. Do not
narrow it back down; that reopens the warm-up case above.

## Review round 1: the leniency is sound only at a habit's BIRTH

The first round of this fix treated "the window is short" as "the habit has
not lived this long" unconditionally — true when `dates[0]` is the habit's own
first row, and false when the range merely *opens* there because that is all
the caller fetched. Three callers fetch a bounded SLICE rather than a habit's
whole history: both editions' `/overview` (`summaryStats` over
`SUMMARY_WINDOW_DAYS`, 400 days), `recomputeBestStreak`
(`shared/src/summary-cache.js`) over `STREAK_HISTORY_DAYS` (1830 days), and
`GET /habits/:id/stats?start=`. The days a bounded slice's window reaches back
into DID happen and DO have rows — the caller simply did not fetch them — so
crediting them with "the habit has no history here" is wrong, and it made two
surfaces disagree about one habit.

**Measured, and this is the reproduction kept as the record.** A 3×/7 habit
with one row 900 days before `end`, then silence, then a restart 300 days
before `end` kept perfectly at Mon/Wed/Fri ever since, `end = 2026-06-30`:

| | master | round 1 | round 2 (birth-gated) |
|---|---|---|---|
| detail view — `computeStats`, no `start` | 296 | 296 | 296 |
| dashboard — `summaryStats` over the 400-day slice | 296 | **301** | 296 |

Master agrees with itself; round 1 did not. Gating only the unfilled-window
CLAUSE on birth was not enough by itself and still measured 301: the floored
`Math.max(1, …)` requirement over-credits at a slice edge too, because
`max(1, floor(3d/7))` is far laxer than master's own `ceil(3d/7)`-shaped
demand for small `d`. The gate has to cover the whole partial-window
treatment, both the requirement and the clause, not just the clause.

**The rule:** `onPaceSeries` learns the habit's LIFETIME earliest real row
(`birth`), and a day whose window is still partial (`windowDays < den`) is
judged by the new, floored rule only while `dates[0] === birth` — the range
genuinely opens at this habit's own start, and the days before it did not
happen. Once the range opens somewhere else, a short window is merely a
SLICE edge, not missing history, and every such day is judged by MASTER's
own expression instead, unfloored and unclaused: **outside a habit's genuine
birth, this fix alters no streak, no miss run, no resilience figure and no
`lastMiss` anywhere** — the property the shape above is chosen to hold, and
the property the 296/296/296 row confirms. `birth` is threaded the same way
`creditFrom` already is (`resolveWindow`'s own JSDoc states the same
reasoning for that date): a caller holding the whole history gets it for
free, since the range does open at the habit's birth there; a caller holding
a bounded slice must supply the LIFETIME value itself, or `onPaceSeries`
narrows to the same answer round 1 gave, which is `summaryStats`'s and
`recomputeBestStreak`'s own stated contract for withholding it.

## Review round 2: the leniency must refuse a PHANTOM birth too

Round 1's `birth` comes from a raw `MIN(date)` in both editions — personal's
`q.firstEntryPerHabit` over a SQLite **TEXT** column, cloud's grouped
`MIN(date)` — so it is exactly as phantom-capable as every other raw
`MIN(date)` this file already refuses as an anchor (#270): `creditAnchor`,
`firstStatedAnswer`, and `warmAnchor`, whose own comment says the value beside
it is "exactly as phantom-capable as the `MIN(date)` that feeds
`firstEntry`/`warmAnchor`". `dates[0]` — round 1's own comparison point — comes
from `earliestRealDay` and is never phantom, so an unfiltered `birth` could
never equal it: a phantom row is lexically the minimum, `birth` lands on a date
like `2026-02-30`, `dates[0] === birth` is false for the WHOLE slice, and the
gate collapses to the strict branch throughout — re-entering the disagreement
round 1 exists to close, through the very anchor it introduced. Measured: a
3×/7 habit with real rows from 2026-03-22 kept Sat+Sun+Mon and one phantom row
dated 2026-02-30 read **101** on the habit's own page and **95** on the
dashboard.

The fix: `onPaceSeries` treats a `birth` that is a STRING but not a real day
the same way it treats an absent one — the lenient branch, not the strict one —
matching what `creditAnchor`, `firstStatedAnswer` and `warmAnchor` already do
with this class of value.

**The residue, stated plainly.** Treating a non-real `birth` as absent means
assuming the range opens at the habit's birth. That is right whenever the
phantom IS the habit's earliest row, and it is narrowly wrong for a habit that
carries a phantom row AND has real rows before the slice edge: there the gate
is withdrawn where it should have fired, and the slice edge over-credits
again. That residue is strictly better than the guaranteed disagreement it
replaces, for every phantom-carrying habit rather than only some of them, and
it is not fixable in SQL — no `GLOB` or `LIKE` rejects February 30th, so no
sharper `MIN(date)` read can hand this function a birth that is never
phantom. Do not spend an afternoon looking for one.

An explicit `null` — both routes' spelling for "no `MIN(date)` row at all" —
stays on the strict branch rather than joining the phantom on the lenient one.
The two mean different things (a real row this file cannot admit as an anchor,
against no anchor to be lenient about), and over a one-day range the floored
and the raw expressions are provably identical, so the strict branch costs a
`null` birth nothing while keeping `null` and `undefined` the documented
opposites they already are.

The existing `PhantomAnchor` route fixture (`overview.integration.mjs`) is a
**daily** habit, so `num >= den` gives it no leniency window and it
structurally cannot see this — the blindness `shared/CLAUDE.md` already names,
landing again on the same shape of test. The fixture this round adds beside it
is 3×/7 for exactly that reason.

## What this does not fix

`docs/decisions/awards.md` documents a separate mechanism: a 3×/7 habit kept
perfectly reads `bestStreak` 21, and logging one forgotten session from the
week before drops it to 17, because `computeStats` starts its window at
`from = start ?? firstEntry` and moving that earliest entry earlier re-judges
days that used to sit before the window even started. **21 and 17 are the
measured figures both before and after this change** — re-measured on this
branch to confirm. That is the window-movement mechanism `docs/decisions/
day-states.md` names ("a stored lapse can move window-derived figures, and
that is the model working"), not the integer-vs-ratio bug this record is
about, and `awards.md`'s conclusion — that the window is the problem and no
cleverer figure inside `onPaceSeries` patches around it — stands unchanged.
The only edit this PR makes there is to the quoted formula, which described
the rounding this record fixes.

## Not touched, and why

`computeScores` divides by the same ratio (`target = num * (activeDays /
den)`) but never rounds it against an integer count — `adherence = Math.min(1,
windowSum / target)` stays continuous, so it never had a cliff to round
against and this bug never touched it. The fix brings `onPaceSeries` in line
with `computeScores`'s existing behaviour rather than changing both to match
some third answer.
