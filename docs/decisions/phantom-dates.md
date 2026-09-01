# A phantom date cannot anchor a window — #270

`assertDate` refuses a date shaped like `2026-02-30` or `9999-99-99` on the way
*into* storage, but a row that got in before that guard existed — or through an
import that went around it — does not get re-validated on the way out. Nothing
in this fix deletes such a row or hides it: it stays in `entries`, it stays in
`entryMap`, and every per-day lookup still answers it exactly as it always did.
What changes is narrower and load-bearing: it can no longer be *chosen* as the
date a window, a warm-up, or a credit period opens at. Mark's words, settling
the question: "I agree we shouldn't show non real dates."

## The rule, and the six sites it closes

A date is "real" when it round-trips through `fromISO`/`toISO` unchanged AND
matches the canonical four-digit-year shape — `isRealDay` in
`shared/src/stats.js`, beside `addDays`. That refuses three different things
with one check: a phantom day (`fromISO('2026-02-30')` rolls into March, so
`toISO` answers `'2026-03-02'`, which disagrees with the input string), a
non-canonical spelling of a real one (`'2026-8-10'`), and a real day whose year
falls outside the four-digit domain every comparison in this file assumes
(`'10000-01-01'`: a real Postgres date, and one `toISO`'s round-trip check
alone would have accepted, since it pads a year to a MINIMUM of four digits
rather than exactly four — see "Five-digit years" below). All three matter for
the same reason: every comparison in `stats.js` is lexical string
comparison — `from <= date <= end` — and each of the three sorts wrongly
against a canonical date beside it.

`earliestRealDay` is the min over an iterable of date strings that passes
`isRealDay`, or `null` if none does — and is now `export`ed from
`shared/src/stats.js`, the one spelling of "skip a phantom when choosing an
anchor" that every site below uses; none restates the loop inline. The issue
named two of what turned out to be six places, across both editions, that pick
an anchor from stored dates this way. Two (A and C) are the issue's own text.
Three more (D, E, F) surfaced only under review — and D and E specifically
were not bugs the issue missed, they were live cross-surface bugs THIS BRANCH
introduced, by fixing one surface of the rule (a derived path, or `stats.js`'s
own callers) without fixing the surface right beside it (a supplied path, or a
route's own read). Closing #270 correctly meant re-opening #270 against itself
twice before it was actually closed:

- **A. `resolveWindow`'s `firstEntry` loop** (`shared/src/stats.js`) — the
  earliest logged date, which decides where a window with no explicit `start`
  opens. Named by the issue.
- **B. `firstStatedAnswer`** (`shared/src/stats.js`) — the earliest date whose
  row is not a `skip`, which feeds `creditFor` → `windowStart` under
  `at_most_unlogged: 'success'`, #223's territory (Decision 4, below). Found by
  review: the issue's own two sites did not cover it, and leaving it alone
  would have shipped two thirds of one rule.
- **C. `computeCategoryStats`'s `warmAnchor`** (`shared/src/stats.js`) — the
  member warm-up (the issue calls it `memberWarm`). Named by the issue.
- **D. `computeCategoryStats`'s supplied `lifetimeAnswer` credit branch**
  (`shared/src/stats.js`) — the mirror-image hole beside C, for a
  caller-SUPPLIED credit date rather than one derived from a member's own
  entries. Found by review, and introduced by this branch: an earlier landing
  closed C without closing the branch right beside it.
- **E. `creditAnchor` itself** (`shared/src/stats.js`) — `/overview`'s credit
  date, raw from SQL (`MIN(date) FILTER (WHERE status <> 'skip')`), the one
  caller of this shape that neither A-D nor `windowStart`'s re-clamp reach,
  because it never passes through an `entryMap`. Found by review, and also
  introduced by this branch: fixing B's derived path and D's supplied path
  without fixing this third caller of the identical shape left `/overview`'s
  own score disagreeing with the habit's own page for identical rows. See "A
  second review round" below.
- **F. Both editions' `/overview` `bestStreak` scan**
  (`habiterall-personal/src/api.js`, `habiterall-cloud/src/api.js`) — opened at
  `entries[0].date` / `all[0].date`, the lexical min out of `ORDER BY date`,
  exactly as phantom-capable as the raw `MIN(date)` reads A-E already refuse.
  Found by review, after fixing A-E made its own disagreement visible. See
  "The sixth site" below.

A phantom row is simply invisible to `earliestRealDay`'s MIN at every one of
the six sites now, the same way a `skip` row is invisible to
`firstStatedAnswer`'s MIN (Site B) — but for a different reason, which the code
says explicitly at both: a skip states nothing, so it cannot buy compliance; a
phantom date is not a day the habit could have stated anything ON, so it
cannot be the day credit — or a window — begins.

`windowStart` additionally re-applies both `[earliest, end]` clamps *after* its
own reformat-and-round-trip step, as a backstop. That is Half 1 of the fix and
is independent of `earliestRealDay`: a route reads `MIN(date)` straight out of
SQL for `/overview` and the category endpoints, and that read is
phantom-capable at both. The two differ in where the phantom is caught. The
category endpoints hand theirs to `computeCategoryStats`, which filters it
INSIDE — `warmAnchor` (Site C) for the window and, since a review of this PR
found the mirror-image hole, the credit anchor beside it (Site D) — so nothing
raw survives to either of that function's own calls into `windowStart`.

**`/overview` hands its own `MIN(date)`-derived credit read to `creditAnchor`
directly (Site E), and a SECOND review round found that this function had no
guard of its own either** — see "A second review round" below. It is not a
route's job to filter it, and it is not `windowStart`'s re-clamp's job either
(the re-clamp only fires when the rollover lands OUTSIDE `[earliest, end]`, and
a phantom credit date normalises INSIDE it far more often than it rolls out):
`creditAnchor` now refuses a non-real `firstAnswer` itself, treating it as
`null` before `windowStart` ever sees it, exactly as `firstStatedAnswer` (Site
B) and `computeCategoryStats`'s supplied `firstAnswer` (Site D) already do. Of
the three callers of `windowStart`, none now hands it a phantom `anchor` — the
re-clamp remains as a backstop for a caller-named `start` that this file
cannot itself verify is a real day (see the comment on `windowStart` in
`shared/src/stats.js`), not for a raw `MIN(date)` reaching it through
`creditAnchor` any more.

`/overview` also runs its OWN `bestStreak` scan (Site F) over the `entries` it
already fetched, and that scan calls into none of `stats.js`'s window
machinery at all — no `resolveWindow`, no `creditAnchor`, no `windowStart` —
so nothing above reaches it. It needed a guard of its own kind: not a
`windowStart` re-clamp, since it is not a window, just a loop the route runs
itself over a `Map` it already built. See "The sixth site" below.

## The measured before/after

All of the following were measured on this branch's base (`origin/master`,
86b4672) before the fix, and again after, with the fixtures now pinned in
`shared/test/stats.test.js`.

**`computeStats` on a daily boolean habit, rows `2026-08-10`…`2026-08-18`, one
junk row, `{ end: '2026-08-18' }`:**

| junk row | history (before → after) | totalCompleted | history[0] | score | currentStreak |
|---|---|---|---|---|---|
| `2026-07-99` | 0 → 9 | 0 → 9 | `undefined` → `2026-08-10` | 0 → 0.381137 | 0 → 9 |
| `9999-99-99` | 9 (unchanged) | 9 | `2026-08-10` | 0.381137 | 9 |
| `2026-02-30` | 170 → 9 | 9 (unchanged) | `2026-03-02` → `2026-08-10` | 0.381137 (unchanged) | 9 (unchanged) |
| *(no junk row)* | 9 | 9 | `2026-08-10` | 0.381137 | 9 |

`2026-07-99` is the issue's headline bug: every figure zero for a habit with a
live nine-day streak, because the phantom sorted *below* `end` (so neither
pre-reformat clamp fired), rolled forward to `2026-10-07`, and emptied
`boundedRange` outright. `9999-99-99` was already caught by the pre-reformat
clamp (it sorts *above* every real date, so `from > end` fires regardless of
Half 2) — it is the case `windowStart`'s existing test covered before this PR,
which is why it reads unchanged both before and after. `2026-02-30` is
Decision 3: see below.

**`creditAnchor(anchor, end)`, called directly** (the one path a route's raw
`MIN(date)` read still takes, so this is where Half 1's re-clamp — not Half
2's choosing rule — was on trial, before the second review round below added a
guard of `creditAnchor`'s own):

| call | before Half 1 | after Half 1, before the review round | after the review round |
|---|---|---|---|
| `('2026-07-99', '2026-08-19')` | `'2026-10-07'` | `'2026-08-19'` | `'2026-08-19'` (unchanged again) |
| `('2026-02-31', '2026-08-18')` | `'2026-03-03'` | `'2026-03-03'` (unchanged) | `'2026-08-18'` (moved) |
| `('9999-99-99', '2026-08-18')` | `'2026-08-18'` | `'2026-08-18'` (unchanged) | `'2026-08-18'` (unchanged again) |
| `('0100-01-01', '2026-08-19')` | `'2016-08-11'` | `'2016-08-11'` (unchanged) | `'2016-08-11'` (unchanged again) |

The middle column's "unchanged" claim for `2026-02-31` did not hold: it was
true only of Half 1 alone, which is exactly the trap Decision 3 above already
warns about for the same date reaching `firstStatedAnswer` instead. `0100-01-01`
is a *real* day, just an old one, so `isRealDay` accepts it and none of this
fix's guards — Half 1's, Half 2's, or the review round's — apply to it;
`MAX_RANGE_DAYS` is doing that clamping, as it always has. See "A second review
round" below for why `2026-02-31` moved again and why the other three did not.

**`computeCategoryStats`, two members** — one ("Read") fully logged over the
window, one ("Ghost") whose *only* row is the junk date — window
`{start: '2026-06-01', end: '2026-06-30'}`:

| junk row | members | unloggedExcluded (before → after) | worst (before → after) | series[0].members (before → after) |
|---|---|---|---|---|
| `2024-99-99` | 2 | 0 (unchanged) | Ghost (unchanged) | 2 (unchanged) |
| `2025-99-99` | 2 | 1 → 0 | Read → Ghost | 1 → 2 |
| `2026-99-99` | 2 | 1 → 0 | Read → Ghost | 1 → 2 |

`2024-99-99` was already inert before this fix: it rolls to `2032-06-07`, which
still sorts *before* `warmStart` (`CAT_START - 400 = 2025-04-27`), so the plain
clamp on the raw `firstEntry` already caught it. `2025-99-99` and `2026-99-99`
roll *past* `warmStart` and past `CAT_END`, so `landedAt` excluded the member
entirely — reported as never logged despite holding a row, and the category
read 1.00 because the member dragging it down was excluded rather than scored.
After the fix all three read identically to `2024-99-99` (`mean: 0.499968` for
all), which is the point: asserting `2025-99-99`'s reading *equal to*
`2024-99-99`'s, rather than merely "some number", is what "all three junk dates
are now inert" means in the test.

**"Already inert / unchanged" is true only because `2024-99-99` is that
member's ONLY row.** A later review round found this needed saying explicitly:
a member with a phantom `firstEntry` AND later REAL rows is not merely
"caught by the clamp either way" — it lands on the real row now, where before
this whole fix it could land at `warmStart` instead, which is a deliberate
change and not a regression. Measured: a category with `Read` (fully logged
June) and `Gap` (`firstEntry: '2024-99-99'`, real rows starting `2026-06-15`),
window `{start: '2026-06-01', end: '2026-06-30', granularity: 'day'}` — the
`2026-06-01` bucket read `members: 2, value: 0.025961` on `origin/master` and
reads `members: 1, value: 0.051922` now. Before this fix, `Gap`'s raw
`firstEntry` ('2024-99-99') lexically compared *below* `warmStart`
('2025-04-27'), so `memberWarm` took the `else` branch and became `warmStart`
directly — landing `Gap` for the WHOLE window, scored from over a year of
"never completed" before its real row on the 15th, which is why it dragged the
bucket down to 0.025961. Now `warmAnchor` refuses the phantom and falls back to
`earliestRealDay(entryMap.keys())`, which finds `Gap`'s real row on
`2026-06-15` — later than `warmStart` — so `memberWarm` becomes that date
instead, and `Gap` has not yet landed on `2026-06-01`: the bucket's `members`
drops to 1 (`Read` alone) and its value is `Read`'s own score on the first day
of a window it just opened, `0.051922`. See "Why the narrower fallback is
still the safe direction" below for why landing LATER, not earlier, is the
correct behaviour here.

## Decision 2 — why this is the exception, not a violation, of "a stored lapse can move window-derived figures"

Root `CLAUDE.md` says plainly that a stored lapse moving window-derived figures
is the model working: importing a `0` row can and should grow a window
backwards and turn every unknown day after it into a miss, because that `0` row
is a true statement about a day the habit existed. This fix looks like it
contradicts that — the account's figures visibly move, in the direction that
looks *more generous* (a phantom-anchored zero streak becomes a real nine-day
one) — and it is worth being precise about why it is not the same thing.

A `0` row is a real day the account said something false, or nothing, about a
habit that existed on that day. A phantom-dated row is not a real day at all —
there is no `2026-02-30`, no `2026-07-99` — so it is not a claim about a day
the habit lived, and it cannot be the day a window, a warm-up, or a credit
period *opens*. The row is not deleted and it is not hidden: `resolveWindow`
still holds it in `entryMap`, a per-day lookup for that literal string still
answers it, and `firstEntry`/`landsOn` in `computeCategoryStats` still treat
"the habit has an entry, even a junk-dated one" as true. What changes is
narrower than "moving a figure" — the row goes **inert** as an anchor
candidate, because a date that is not a day is not a day the habit lived, and
so it cannot be the day the window opens.

## Decision 3 — `2026-02-30` moves too (170 → 9), and that follows rather than being collateral

`toISO(fromISO('2026-02-30'))` is `'2026-03-02'` — it does not round-trip, so
`isRealDay` refuses it exactly as it refuses `2026-07-99` or `9999-99-99`. The
issue's own text calls `2026-02-30` "unchanged" by the fix, and that claim is
true of *Half 1 alone* (re-clamping after the reformat does nothing for a date
whose rollover lands back *inside* `[earliest, end]`, which `2026-03-02` does
for the fixture's window). That intermediate state was pinned deliberately
while Half 1 stood alone — a test asserting `history.length === 170` with a
comment saying the next step had to move it — and the test that replaced it,
`#270 Half 2: '2026-02-30' moves too`, carries 170 as its stated before-number
rather than as an assertion. Once Half 2 is in, `2026-02-30` is refused as a
*candidate* anchor at all, the same as every other phantom, and the window
opens on the real first entry instead: `history.length` moves from 170 to 9.
That is not a second bug or an unintended side effect — `2026-03-02` is not a
day this habit lived either, so by the same rule that fixes `2026-07-99` it
cannot be the day the window opens. Accepting it was the explicit judgement
call recorded in the brief for this PR; the number is stated here so nobody
re-derives 170 as "the correct" figure later.

## Decision 4 — the third site: `firstStatedAnswer`

The issue names two sites (`resolveWindow`'s `firstEntry`, and
`computeCategoryStats`'s `memberWarm`). `shared/src/stats.js` has a third
loop shaped exactly the same way — pick the lexical min from stored dates —
that the issue does not mention: `firstStatedAnswer`, which decides where
credit begins under `at_most_unlogged: 'success'` (`creditFor` →
`windowStart`). `shared/test/stats.test.js`'s own pre-existing test,
`issue #223: credit begins at the first STATED answer, wherever it falls`,
already said in its comment that "a fix for #270 has to move this number
deliberately" — the two issues share a mechanism (pick a min from stored
entries) even though #223 is about crediting silence and #270 is about
phantom dates.

Leaving this site alone would have shipped two thirds of one rule: a phantom
date would still be refused as the date a *window* opens, but could still be
chosen as the date *credit* begins, which is the same defect through a
sibling door. The guard is `if (!isRealDay(date)) continue;`, added beside the
existing skip check in `firstStatedAnswer` — same shape, different reason: a
skip states nothing, so it cannot buy compliance; a phantom is not a day the
habit could have stated anything on, so it cannot be the day compliance
starts either.

The measured consequence is `issue #223`'s own third fixture (renamed from
"#270 is untouched" to "#270 is no longer untouched"): an at-most habit with
`resolved: 'success'`, a real skip on `2026-01-01`, and its only *value* row
dated `2026-02-31` (→ `2026-03-03`, which sorts *earlier* than the habit's
other real answer). Before this fix, `firstStatedAnswer` chose the phantom's
rollover as the credit date, crediting the account for five and a half months
it had no evidence for: `currentStreak: 169`. After, Site B refuses the
phantom and lands on the habit's one real row instead, so the reading is
almost exactly "no evidence yet": `currentStreak: 1`, `totalCompleted: 2`
(unchanged), `score: 0.051922`. This is the fail-*open* half of #270 closing —
the direction the brief's stop-condition was written to catch had it gone the
other way (crediting *more* silence than the same habit without the junk row
would get), and it does not: it credits less, which is what "no phantom date
can state anything" implies.

## A second review round: `creditAnchor`'s own SUPPLIED anchor

A later review found the mirror-image hole to Decision 4, in the one place
Decision 4's own fix does not reach: `creditAnchor`, which `/overview` calls
DIRECTLY with its own raw `MIN(date) FILTER (WHERE status <> 'skip')` read, for
`score`/`currentStreak` over its own 400-day slice. `firstStatedAnswer` (Site
B) already refuses a phantom for the DERIVED path — a caller that hands
`resolveWindow` a whole `entryMap` — but a route computing its own pass and
calling `creditAnchor` with a lifetime date SUPPLIED from SQL bypassed that
guard entirely, on the theory recorded in the earlier version of this
function's own JSDoc: that it "has only one date and no map to filter through
`isRealDay`". That theory does not hold — the fix is the same one-line
narrowing every other site in this rule already uses, `null` in place of a
refused date, letting `creditFor`'s `?? end` clause do the rest.

The consequence was the same shape as Decision 4's, and worse in one respect:
a phantom CREDIT date normalises *inside* `[earliest, end]` far more often than
it rolls outside it, so `windowStart`'s re-clamp backstop — which only fires on
the second case — mostly did not catch it. Measured, reproduced before fixing
(the fixture in `shared/test/stats.test.js`, `issue #270: creditAnchor itself
must refuse a phantom firstAnswer…`): an at-most habit, target 2, resolved to
`success`, `end: '2026-08-18'`, rows `{2026-01-01 skip}`, `{2026-02-30 value
1}`, `{2026-08-18 value 1}`. `/habits/:id/stats` (`computeStats`, already
Site-B-filtered) read `score: 0.051922`, `currentStreak: 1` — no evidence yet.
`/overview`'s own path, `summaryStats` with `creditFrom: creditAnchor('2026-02-30',
end)`, read `score: 0.999884`, `currentStreak: 170` — a near-perfect record
credited from five and a half months of silence nobody had answered for. **On
`origin/master`, before this whole PR, both read `0.999884` / `170` — wrong but
consistent.** This PR's first landing (Half 1 and Half 2 above) is what
introduced the *disagreement*, by fixing the derived path (Site B) and the
category functions' supplied path (Site D) without fixing `creditAnchor`'s own.

The fix makes `creditAnchor` refuse a non-real `firstAnswer` the same way, so
all four surfaces — the habit's own page, `/overview`'s score, and both of
`computeCategoryStats`'s member-level anchors — give one answer for one habit.
This closes the `creditAnchor(anchor, end)` table's "`2026-02-31` unchanged"
row above: that claim was true only up to this round, not of the finished fix.

## The sixth site: both editions' own `/overview` `bestStreak` scan

`buildOverview` (`habiterall-personal/src/api.js`, `habiterall-cloud/src/api.js`)
builds its own `streakMap` from the same `entries` / `all` rows `summaryStats`
already read, and until this round ran its `bestStreak` scan from
`entries.length ? entries[0].date : summaryEnd` (personal) /
`all.length ? all[0].date : summaryEnd` (cloud) — the LEXICAL min out of
`ORDER BY date`, exactly as phantom-capable as the raw `MIN(date)` reads Site E
already refuses. Nothing above reaches this scan: it never calls
`resolveWindow`, `creditAnchor` or `windowStart`, so none of Sites A-E's fixes,
nor `windowStart`'s re-clamp, touch it. The fix is the same one-line narrowing
as every other site — `earliestRealDay(streakMap.keys()) ?? summaryEnd` in
place of the raw index read, in both editions' `api.js` — which is why
`earliestRealDay` is now `export`ed from `shared/src/stats.js`: these are the
two callers of it outside `stats.js` itself, one per edition, and a route must
not restate the loop inline.

Measured, on a boolean habit with a live nine-day streak and one row dated
`2026-07-99` (`PhantomAnchor` in
`habiterall-personal/test/overview.integration.mjs`): on `origin/master`, all
three figures the `/overview` row reports — `score`, `currentStreak`,
`bestStreak` — read `0`, self-consistent with each other and with the same
habit's `/habits/:id/stats` page, because none of Sites A-E were fixed yet
either. On this branch, BEFORE Site F was fixed (Sites A-E already fixed, F
still reading the raw index), the same row read `currentStreak: 9`, `score:
0.381137`, `bestStreak: 0` — a combination impossible for any real habit,
since a live nine-day current streak can never exceed a best streak of zero.
Fixing Sites A-E is what made Site F's own bug visible: on the unfixed base
all three figures read the same wrong number, so nothing looked inconsistent;
correcting two of the three without the third is what turned a uniformly-wrong
answer into a visibly self-contradictory one. That is why Site F had to be
closed in this PR rather than deferred — shipping Sites A-E alone would have
shipped a `/overview` row that disagreed with itself.

`habiterall-personal/test/overview.integration.mjs` pins Site F behaviourally:
it inserts the phantom row directly (`assertDate` refuses it on every write
path, so the test plants it the way a database predating that guard, or an
import that went around it, already would), then asserts `bestStreak`,
`currentStreak` and `score` all agree with the same habit's
`/habits/:id/stats` page. See "The cloud reproduction of Site F, and what was
wrong about assuming there wasn't one" below — cloud carries an equivalent
assertion too, over a different discriminating value than personal's, because
the two editions' storage does not fail the same way.

## Why the narrower fallback is still the safe direction, in both directions it appears

`warmAnchor` (`computeCategoryStats`, Site C) and the credit-anchor fallback
beside it (Site D) both read, in an earlier version of this file's comments,
as WIDENING the figure they feed — "the member is admitted and scored rather
than excluded". A review round found that claim false for `warmAnchor` and
corrected it for both, since they are the same shape of fallback.

`earliestRealDay(entryMap.keys())` is bounded BELOW by the slice's own
earliest fetched date: the route hands `computeCategoryStats` `entries` from
`start - SCORE_WARMUP_DAYS` onward and no earlier, so the fallback can never
land before `warmStart` — only at or after it. That is a NARROWING relative to
whatever an unguarded rollover of the phantom might have produced (which could
land almost anywhere, before or after `warmStart`, depending on the specific
junk date), not a widening. The `Gap` fixture immediately above is the
concrete case: the member lands on `2026-06-15`, its own first real row,
rather than at `warmStart` (`2025-04-27`) the way an unclamped `firstEntry`
comparison used to place it — LATER, not earlier, and out of the early
buckets it used to be scored into.

Narrowing is nonetheless the safe direction for both fallbacks, and each for
its own reason:

- **Site C (`warmAnchor`)**: landing a member before its first REAL evidence
  is exactly the warm-up defect the clamp above it exists to prevent — the
  0.969536-against-0.41327 gap this same file documents elsewhere for an
  at-most habit converged over days it never had. Landing on the earliest
  real evidence available (or on `warmStart` when the slice holds none at
  all) is the closest honest answer to a question the supplied anchor cannot
  answer.
- **Site D (the credit anchor)**: crediting silence with no evidence behind it
  is #223's own defect (Decision 4, above, and the second review round). A
  narrower credit date means LESS silence read as compliance, never more —
  nothing stated resolves to `end`, i.e. no evidence, never an invented
  perfect record.

Both fallbacks therefore move a figure in the SAME direction relative to an
unguarded phantom, not opposite ones, and narrowing is what makes each safe.

## Why `memberWarm`'s normalise-then-clamp block is kept though unreachable

`computeCategoryStats` now computes a `warmAnchor` — `firstEntry` when
`isRealDay(firstEntry)`, else the earliest real day in the member's own entry
slice, else `null` (which falls through to `warmStart`) — and only ever hands
`memberWarm` one of those two values. Both are real days by construction:
`isRealDay(firstEntry)` on the first branch, `earliestRealDay`'s own guarantee
on the second, and `warmStart` is `addDays` over `dates[0]`, itself always
real. That means the `fromISO`/`toISO` reformat-and-clamp block immediately
below — the one that used to be where the ordering bug lived — is now a no-op
on every possible input.

It is kept rather than deleted, and documented as unreachable rather than
described as still pinning anything: the alternative is a silent behavioural
change disguised as a cleanup, and a future refactor that widens
`warmAnchor`'s inputs again would regain exactly the hazard the block guards
against. The ordering claim it used to make — "clamped before normalised, not
after" — has genuinely moved, not disappeared: it now lives in `windowStart`'s
own re-clamp (Half 1) and is pinned by that function's `creditAnchor`
assertions in `shared/test/stats.test.js`.

**As of the second review round above, `creditAnchor` no longer hands
`windowStart` a raw phantom either** — it now applies its own `isRealDay`
guard before ever calling `creditFor`, the same as `firstStatedAnswer` (Site
B) and `computeCategoryStats`'s supplied `firstAnswer` (Site D). Of the three
callers of `windowStart` (`creditFor` from `creditAnchor`, `resolveWindow`'s
two calls, and `computeCategoryStats`'s `memberCredit`), none now hands
`anchor` a phantom by construction. The re-clamp is therefore not proven
unreachable the way this block is — see the comment on `windowStart` in
`shared/src/stats.js` — because it is also reached with a caller-NAMED
`start`, which nothing in this file asserts is a real day (that is a route's
job, via `assertDate`); it is simply no longer reachable through `creditAnchor`
specifically. `landsOn`/`firstEntry` itself is deliberately not narrowed the
same way: `firstEntry === null` is still the only test for "never logged", so
a phantom-only member still lands (and is scored) rather than being pushed
into `unloggedExcluded` — only the WARM-UP and CREDIT anchors a landed member
is scored from are narrowed to a real day.

## The naming trap: fixed already, this PR only removed the alias

The issue's last section observed that `shared/public/ui/dates.js`'s `iso()`
did not pad the year, which would make a phantom-adjacent bug in the browser's
own calendar rendering. That is no longer true: commit `cd8da99` (#272) added
`padStart(4, '0')` to `iso()`, with `shared/test/dates.test.js:169-172` pinning
it, before this PR's branch existed. This PR did not re-fix that — it fixes
only what was left, which is a naming collision: `shared/public/ui/calendar.js`
imported `iso` under the alias `iso as toISO`, so the codebase had two
functions both callable as `toISO` from a reader's point of view (this file's
own `shared/src/stats.js` has an unrelated internal `toISO`). The two now agree
in behaviour (both pad the year), so the alias bought nothing but the
appearance of a shared identity between two functions that live in different
runtime worlds — `shared/src` is never served to the browser, so
`calendar.js` could never have imported the other one regardless. Dropping the
alias (`import { fromISOLocal, iso } from './dates.js'`, used at its two call
sites) is a rename with no behavioural change, and has no mutation test for
that reason — see the PR's Step 3.

## The cloud reproduction of Site F, and what was wrong about assuming there wasn't one

**What remains true:** cloud's `entries.date` is a native Postgres
`DATE NOT NULL` (`habiterall-cloud/src/db/migrations/001_initial.sql:48`), not
the TEXT column personal's SQLite uses, and `'2026-07-99'` — a day that does
not exist on any calendar — cannot be stored in cloud AT ALL. Postgres refuses
it at the `INSERT`, regardless of whether `assertDate` also would have. That
one sub-case of the phantom-date rule — an invalid CALENDAR shape, wrong
month/day rather than merely a wrong-shaped year — is genuinely unreachable in
cloud and reachable in personal for exactly the reason the issue's own text
gives: personal's SQLite stores the string verbatim and never re-validates it
on the way out, where Postgres's `DATE` type parses and normalises every value
at the `INSERT` boundary.

**What was wrong is the conclusion drawn from that one sub-case: that NO
cloud-storable value discriminates the fix, and so Site F could carry no cloud
test.** A five-digit year is a different shape of phantom — not an invalid
calendar day, but a real one whose year falls outside the four-digit domain
every comparison in this file assumes — and Postgres stores it without
complaint: `SELECT DATE '10000-01-01'` and `to_char('10000-01-01'::date,
'YYYY-MM-DD')` both round-trip it unchanged. `isRealDay`'s canonical-shape
check refuses it (see "Five-digit years" below), which is exactly the gap the
old version of this section reasoned about — and got backwards.

The old text's load-bearing claim was that `ORDER BY date` sorts
CHRONOLOGICALLY here, because `entries.date` is a native `DATE`, so
`all[0].date` — the unfixed anchor Site F replaced — could never land on a
five-digit year: such a year is chronologically the LATEST row, never the
earliest. That is false for the actual query `buildOverview`'s `allRows` read
issues:
`SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, ... FROM entries ...
ORDER BY date` — an alias named `date`, over an underlying COLUMN also named
`date`. Postgres's own tie-break rule for this is the opposite of the one this
section assumed: "if an ORDER BY expression is a simple name that matches both
an output column name and an input column name, ORDER BY will interpret it as
the output column name" (verified directly, not merely quoted — see below).
The output column here is `to_char(date, 'YYYY-MM-DD')`, a TEXT value, so the
bare `ORDER BY date` in this exact query sorts LEXICALLY on the rendered
string, not chronologically on the `DATE` column underneath. Verified against
a throwaway table on Postgres 17, with rows dated `2019-03-03`, `2020-01-01`,
`2021-06-15` and `10000-01-01`:

```sql
SELECT id, to_char(date,'YYYY-MM-DD') AS date FROM t ORDER BY date;
--  id |    date
-- ----+-------------
--   3 | 10000-01-01   -- ORDER BY resolves to the alias: lexical, '1' < '2'
--   4 | 2019-03-03
--   1 | 2020-01-01
--   2 | 2021-06-15

SELECT id, to_char(date,'YYYY-MM-DD') AS d FROM t ORDER BY date;   -- different alias
--  id |      d
-- ----+-------------
--   4 | 2019-03-03    -- unambiguous: ORDER BY resolves to the DATE column,
--   1 | 2020-01-01    -- chronological, year 10000 sorts LAST
--   2 | 2021-06-15
--   3 | 10000-01-01
```

So `all[0].date` is exactly as lexical as personal's TEXT column for this one
shape of phantom, not "chronological and therefore immune" — the archived
argument for cloud's safety was an artifact of not having checked which
column `ORDER BY date` actually binds to when the alias shadows it.

**The reusable lesson, recorded here so the mistake is not repeated the other
way round:** a first attempt at this test reasoned the way the old section
did — that a five-digit year could never be `all[0]` because `ORDER BY date`
is chronological on a native `DATE` — and concluded, correctly given that
premise, that no fixture could make Site F's cloud code path fail. That
premise was never checked against the actual SQL text these routes issue, only
asserted from what `DATE` columns do in general. Checking it directly (the
`psql` session above) overturned it in about a minute. The lesson is not "add
a test" — it is that "no discriminating value exists" is a claim about SQL
semantics, checked against a scratch table, not a claim about a column type,
inferred from its declaration. The right response to a test that would not
have failed was to go looking for why, not to remove the attempt and record
the gap as permanent.

**Site F now has a behavioural test in both editions**
(`habiterall-cloud/test/api.integration.mjs`, "issue #270: cloud's own
bestStreak anchor", beside `habiterall-personal/test/overview.integration.mjs`'s),
over different discriminating values because the two editions fail
differently. Personal plants `'2026-07-99'` (an invalid calendar day; SQLite's
TEXT column stores it verbatim). Cloud plants `DATE '10000-01-01'` (a valid,
storable calendar day whose year is the wrong shape) directly, by SQL insert,
past `assertDate` the same way an old row — or a value Postgres's own `DATE`
domain admits that `assertDate` would refuse — already would. The cloud
fixture pairs it with an at-most habit resolved to `success` and an old real
stated answer (dated past `STREAK_HISTORY_DAYS`, so it is never itself an
anchor candidate) that sets the account's lifetime credit date far enough back
to match `boundedRange`'s own clamp point — so the unfixed anchor does not
merely read one wrong day, it credits an entire blown-out window as success.
Measured directly against a live fixture (`npm run test:cloud`), not merely
asserted: fixed, `/overview` reads `bestStreak: 9` beside `currentStreak: 9` —
the live run, agreeing with itself. Reverting the anchor to
`all.length ? all[0].date : summaryEnd` moves `bestStreak` to `3661`
(`MAX_RANGE_DAYS + 1`, the full clamped window) while `currentStreak` stays at
`9`, since it is computed by an unrelated, already-fixed path — the same
self-contradictory shape ("The sixth site" above) that made Site F's bug
visible in personal.

**And the asymmetry between the two editions is real and is worth stating
plainly, now that both are tested rather than one being asserted safe by
argument:** personal's exposure is a LEXICAL TEXT column that stores and sorts
any string exactly as written, so every phantom shape — an invalid calendar
day, a non-canonical spelling, a wrong-shaped year — reorders it. Cloud's
`DATE` column parses and normalises at the `INSERT`, so the invalid-calendar
and non-canonical-spelling shapes are unreachable there; what remains
reachable is narrower — a year outside Postgres's own four-digit rendering —
and it reaches the same bug through the query's own `ORDER BY`-alias quirk
rather than through the column's storage format. Same rule
(`earliestRealDay`, the one guard, in both editions), two different reachable
shapes, and now two different tests over the shape each edition can actually
be handed.

**What was probed and ruled out as a NON-discriminating cloud value, so
nobody redoes the search** (each verified directly against a Postgres 17
instance and against `shared/src/stats.js`'s own
`fromISO`/`toISO`/`boundedRange`, not asserted from memory):

- **Two-digit years** (`'0050-01-01'`) are a REAL Postgres date —
  `SELECT '0050-01-01'::date` round-trips to `0050-01-01` unchanged — but FAIL
  `isRealDay`: `fromISO` builds `new Date(50, 0, 1)`, and the two-digit-year
  special case built into the JS `Date` constructor maps `50` to `1950`, so
  `toISO` answers `'1950-01-01'`, which disagrees with the input string. It
  does not matter which way `isRealDay` rules on it, though: `'0050-01-01'`
  sorts lexically below `boundedRange`'s own `earliest` clamp for any
  realistic `end` (verified: `'0050-01-01' < addDays('2026-08-18',
  -MAX_RANGE_DAYS)` is `true`), so a value picked by the unfixed lexical anchor
  and a value `earliestRealDay` falls back to are both clamped to the
  identical `earliest` value regardless of which one a route asks for —
  verified by calling `boundedRange` with each as `start` and diffing the
  returned range (byte-identical, both ends, both lengths). Whether `ORDER BY
  date` resolves to the column or the alias makes no difference to THIS value,
  because both readings land inside `boundedRange`'s own clamp either way.
- **Five-digit years** (`'10000-01-01'`) are the one value that DOES
  discriminate, and are now the cloud test's fixture — see above. `toISO` pads
  a year to a MINIMUM of four digits rather than exactly four, which is why
  `isRealDay` used to accept a five-digit year as real before the canonical
  four-digit shape check was added; with that check in place, `earliestRealDay`
  refuses it outright and is never handed it as a candidate.
- **`'infinity'::date`** is a real Postgres value but a different hazard
  entirely, not this one: `to_char('infinity'::date, 'YYYY-MM-DD')` returns
  `NULL` — verified directly against Postgres — not a string `stats.js` could
  compare, lexically or otherwise, against anything. Whatever a route does
  with a `null` reaching `entries[].date` is a shape mismatch, not a
  lexical-vs-chronological ordering bug, and is out of scope for #270.
