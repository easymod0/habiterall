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

Each half fixes one fixture and does nothing for the other, and each opens its
own hole that the other's guard has to close — measured by ablating each half
in isolation against both fixtures (the 91-day Sat+Sun+Mon schedule and the
Mon/Wed/Fri-with-two-skips fixture above):

- **Floor alone fixes the skip case.** A floored requirement never demands
  more than the habit's own rate, so the skip fixture collapses to one run.
  It does **nothing** for the warm-up: Sat+Sun+Mon still fractures into two
  runs (measured: 4 and 86 days) exactly as it does unfixed, because flooring
  changes what the requirement demands once the window is full, not whether an
  unfilled window is judged at all. And flooring alone opens a hole of its
  own: on day one of a brand-new 3×/7 habit, `Math.floor(0.429)` is 0, and a
  requirement of 0 is trivially met by a window with nothing in it at all —
  measured, a habit whose only stored row is a stated lapse reports
  `bestStreak` 2 with floor alone, where master and the full fix both read 0.
- **The unfilled-window clause alone fixes the warm-up.** A window that has
  not finished filling cannot yet fail, because there are still days left in
  it to reach `num` — measured, Sat+Sun+Mon collapses to one 91-day run with
  the clause alone and no floor. It does **nothing** for the skip case (still
  two runs, measured), because the skip fixture's window is full and it is the
  floored-vs-raw requirement that was wrong there, not whether the window had
  finished filling. And the clause opens its own hole if the requirement is
  otherwise met trivially by an empty window: ungated, `potential` alone reads
  a window with no evidence in it as "still able to reach target" — measured,
  a habit whose only stored row is a skip reports `bestStreak` 4 with the
  clause ungated, where master and the full fix both read 0.

So `Math.max(1, …)` and the `windowDone >= 1` gate are not a third feature —
each is closing the hole its own neighbouring half opens, and neither guard is
answering the other fixture. Both halves, both guards, are what the measurement
shows necessary; no combination of three of the four passes both fixtures.

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
