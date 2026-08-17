# The awards card

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**An award is a READING of the stats response, and it is computed on the
SERVER because the ladder it reads is.** `SURVIVAL_THRESHOLDS` and
`MISS_BUCKETS` live in `shared/src/stats.js`, and `shared/src` is not served to
the browser — which is why `CHANNELS` and `SETTING_VALUES` are each declared
twice and pinned by a test. Computing awards in the browser therefore meant a
second copy of the streak ladder, which is exactly the drift issue #63 asked for
it to be *reused* to avoid: a badge at 20 days beside a survival curve with a
bar at 21 is two numbers about one question. It would also have cost a new file
under `shared/public/`, which has to join `sw.js`'s `SHELL` and bump
`CACHE_VERSION` — every installed client's data cache, to buy one import, which
is the same price `deviceClockHeader` declined to pay. So `shared/src/awards.js`
is pure and both editions' `/habits/:id/stats` call it. The phone gets awards
without a sixth mirror, and `ui/detail.js` renders words it did not choose.

It is called **in the two routes and not inside `computeStats`**, which is the
one place it looks like it belongs: `/overview` calls `computeStats` once per
habit and keeps four of its fields, so putting awards there is a per-habit
computation the dashboard would throw away.

**An award can be taken away, and the first version of this section said it
could not.** That claim — *only a monotone reading may be dressed as a trophy,
so an award read off `bestStreak` or the peak score cannot be revoked* — is
false, and it is worth reading how it failed, because the reasoning was the
plausible kind. It was a true statement about the FIGURES and a false one about
the WINDOW, and only the second is what a user sees.

`computeStats` starts at `from = start ?? firstEntry`, and `onPaceSeries`
pro-rates the requirement near that start — `required = min(activeDays,
num*activeDays/den)` — deliberately, so a habit is not judged against history it
does not have yet. Move the earliest entry EARLIER and the first `den - 1` days
are re-judged against a full requirement they now fail. Measured end to end
through the real route: a 3×/week habit kept perfectly reads `bestStreak` 21 and
shows "21-day streak"; logging **one forgotten session** from the week before
drops it to 17 and the badge to "14-day streak". Remembering something you did
takes the award down. Daily habits (`num >= den`) have no leniency window and
are immune, which is exactly why this survived a test suite built on one.

The second mechanism needs no user at all. `MAX_RANGE_DAYS` clamps `from` to
`end - 3660`, so a habit older than ten years — or one carrying a single ancient
row from an import — has a **sliding** window rather than a growing one. Watched
over a few weeks of simulated calendar, an entire awards card emptied itself,
`comeback` walking 2191 → 38 → 14 → gone.

So there is no cleverer figure to read; the window is the problem, and nothing
inside `awards.js` can patch around it. The framing is therefore **what this
habit's history currently shows** — the position `computeSurvival`'s docstring
already argues one card up, that a probability you can act on beats a trophy.
The card says so in its lead, the payload carries no `permanent` flag, and there
is no second visual treatment implying some badges are safer than others. If
awards should ever be durable the answer is a granted ledger with a first-earned
date, which is **issue #141**, and it is the only thing that would change this.

What survives is the part that was about the figures rather than about
permanence. `currentStreak` and the score's CURRENT value are still refused,
because both fall on an ordinary bad week with the window standing perfectly
still — a badge on either flickers for reasons the user cannot even see.
Reading a maximum does not make an award durable; it stops it twitching day to
day. That is a smaller claim and a true one.

Two lessons about the tests, both of which cost nothing to state and would have
cost a release to learn later. The invariant test asserted the property honestly
and walked a **daily** habit forward from a fixed first entry — so `from` never
moved and the leniency window never applied. It could not have seen either
mechanism. It is now three tests: the two counterexamples above, pinned as
behaviour, and the narrow claim that does hold with **both of its preconditions
named in the test itself**. And a property test that constructs its own history
is only ever as good as the shapes it constructs; the fuzz that found this ran
400 non-daily histories and lost or lowered an award in 36.

**The two ladders are calibrated to the curve, and the calibration was
MEASURED.** `STRENGTH_BANDS` is 50/80/95, and a perfect daily habit crosses them
on days **13, 31 and 57** — the first draft of the test asserted 30 and 60 from
the two figures `test/stats.test.js` happens to pin, and was wrong by a day and
by three. Both sides of each crossing are pinned now, so Loop's decay constant
drifting fails here as well as there, and "95% is a months-long goal" is a fact
about the arithmetic rather than a claim in a comment. Which is also how that
goal is *presented as one*: only the rung reached is shown, so a new user is
never handed a row of greyed-out bands they have not earned — and the strength
curve is drawn full height at the top of the same page, which answers "how far
is there to go" better than a badge could. Same answer as the streak ladder, and
for the same reason.

**"No lapse over a day" is falsified by a bad week rather than by the window,
and the wording is what carries that.** Every other award moves when the window
does; this one is a claim about the whole record, so the next two-day lapse ends
it with the window standing still. It used to be `permanent: false` against a
payload where everything else was `true` — a distinction that stopped meaning
anything the moment the paragraph above was written. The sentence does the work
instead: *All 7 lapses **so far** have lasted a single day*, which is a
statement of the record and not a prize, and there is a test on the "so far".

That award is also read from `missDistribution` and **not** from
`recovery.rate === 1`, which is the same fact one set smaller. The closed set
excludes an ongoing lapse — rightly, that is what makes the recovery rate fair —
so three days into a lapse the rate still says every lapse lasted one day, and
printing that over a lapse the user is standing in is the cheerful wrongness
this whole file is written to avoid. The bucket is found by `min` and never by
`label`, because the labels are prose.

**Where a number was computed and thrown away, it is now returned — not
recounted.** The comeback award needs the longest lapse recovered FROM, which is
not `worstLapse` (that counts the open one, so it congratulates you on a slip
you are still in). `computeRecovery` already had the closed runs in hand and
reported only counts, so it now also answers `longest` and `lastEnd`. The
alternative was for `awards.js` to walk the entries again — and the window every
figure in a stats response is computed over (`from = start ?? firstEntry`,
clamped) is derived inside `computeStats` and never returned, so a second
derivation is a second answer waiting to disagree.

**Deriving on every request has no "you just earned this" moment, and `fresh` is
the cheapest honest substitute.** It marks the award whose value MOVED — the
recovery count, which goes up every time a lapse closes, not the comeback tier,
which only moves when you beat your worst one — for `COMEBACK_FRESH_DAYS`. Its
test asserts a **literal** 7 and not the constant: reading the name back pins
the off-by-one and nothing else, and that version passed with the window widened
to 30 while its own comment claimed the boundary was covered. The same trap is
worth looking for anywhere a test imports the number it is checking.

Two smaller decisions, both of which read as omissions and are not. **Only the
rung reached is shown**, not every rung passed: nine badges for a hundred-day
habit is one fact said nine times, and "how far do my streaks usually get" is
answered by the survival chart the awards card sits directly *under* — which is
the ordering `computeSurvival`'s own docstring argues for, a probability you can
act on beating a trophy. And a **one-day lapse earns no comeback**
(`COMEBACK_MIN_DAYS`), because "Back after 1 day" is precisely what "Recovered N
times" already said.

**The two "ever" claims, and one of them had to refuse the obvious threshold.**
*Every day of the week* is `computeWeekdays` with `completed > 0` on all seven,
and *A year of keeping it* is the span between the FIRST streak's start and the
LAST one's end. Both read maxima, which is what stops them twitching — and, per
the paragraph above, is not a promise that they last.

The weekday one is deliberately "at least once" and deliberately not a RATE
across all seven, and that is the load-bearing part. `computeWeekdays` counts
completions rather than pace, so a 3×/week habit kept perfectly has four
weekdays sitting at zero — and any threshold over all seven is then unreachable
for every non-daily habit, which is the `applicable: false` shape
`computeResilience` had to stop doing. "At least once" a Mon/Wed/Fri habit can
genuinely meet by going once at a weekend: a claim about a schedule that is
false until it is true, rather than a gate on the habit's frequency. It is also
what keeps the award consistent with the tiles for a limit under
`atMostUnlogged: 'success'`, where an unanswered day counts as kept and so does
the weekday it fell on.

**A year is measured between the runs, not from `created_at`.** The reason is
not availability — `computeAwards` does take the habit now, for the gate below —
it is that the creation date answers a different question: *created* a year ago
is true of a habit abandoned in its first week, and there is a test that says
so. The span between the first good run and the most recent one claims what the
badge actually says. Note it is the first run's **start**, and the test's
fixtures straddle the boundary on purpose: an earlier pair used a ten-day first
run, so start-to-end and end-to-end were 399 and 390 days — both over a year, so
measuring from the wrong end of that run passed every assertion and the whole
distinction was unpinned. A forty-day first run puts the two answers either side
of 365.

It is also honest about an import in a way `created_at` would not be: a Loop
backup carrying a year of history earns it on the day it lands, because the
record is a year long and that is what the badge claims. (The README used to say
there was "exactly one way to earn that one", which this contradicts. It no
longer does.)

**On an at-most habit resolved to `success`, the whole card is withheld — ALL
awards, not just the ones that would read oddly.** An unanswered day counts as
kept there — deliberately, and documented above — so a limit with a single
stored row grows a streak, a strength band and a full weekday spread purely as
the calendar moves. That is right for a TILE, which states a number the user
reads against their own memory. It is wrong for a BADGE, which makes a claim in
English: *"You have kept this on all seven weekdays at least once"* over a habit
logged once is a sentence its owner knows to be false, and being told it
discredits every other sentence on the card. #63 settles the tie itself — where
an award is pure vanity, prefer the chart — and every figure is still on the
chart and the tiles, untouched.

Be clear about what that costs, because the gate is wider than its motivation.
A limit with twelve typed-in slips loses "Recovered 12 times" and "No lapse over
a day" as well, and those are honest claims about ROWS THAT EXIST — nothing
about them depends on how silence is read. They go because the alternative is a
per-award judgement about which sentences survive the setting, which is a second
rule to keep in step with the first and would have to be re-decided for every
award added later. One gate that is occasionally too broad beats seven that
drift apart.

That last sentence used to end "the narrower version wants a coverage measure,
and if that ever lands this gate should be revisited with it". Coverage has
landed and the revisit reached the **same** answer, which is worth recording
because the reasoning moved even though the code did not. Coverage is the one
award `success` genuinely cannot flatter — it counts ROWS, and the whole of
`success` is crediting a day that has none, so a limit logged once covers no
month and its sentence would be true either side of the gate. Hoisting it is
therefore *safe* and not merely tempting, and it is still not hoisted: the
exemption would exist for an account that has been told silence is the answer
and has answered every day of a month regardless, and the price of serving that
account is the second rule this paragraph refuses. The cost is a false NEGATIVE,
which is the direction this file prefers everywhere else. It is one `return` to
undo, and `awards.js` says so at the gate.

The gate asks `unansweredCounts` rather than restating it, so the habit's
`at_most_unlogged` beating the account's `atMostUnlogged` stays resolved in the
one place that knows the precedence; that function is exported from `stats.js`
for this one caller. And the routes must hand `computeAwards` the **same**
`habit` and `unlogged` they handed `computeStats`, or the gate and the
arithmetic answer different questions about one habit. Both arguments are
optional — a caller with neither should get awards rather than an exception —
which makes forgetting them silent on precisely the shape this exists for, so a
test reads both editions' `api.js` and fails if either call loses them.

**The award nobody else can offer is about ANSWERING, and it arrives as a stats
FIELD rather than as an entry map.** *A month with no blanks* counts the days
that hold a row — `done`, `skip` and `no` all count, `unknown` does not — which
is the four-state model read as an achievement, and #63's strongest argument:
every gamified tracker rewards success only, so the moment you slip you stop
logging and the data dies exactly where it would be most useful. This is the
badge that is reachable on a bad month.

It is not a reading of `computeStats`'s output, which is why it was deferred
once. The two ways to fix that were to hand `computeAwards` the entries or to
add a field, and the field wins on two counts. `awards.js`'s header states the
property that every award is a reading of the figures already on the payload and
that nothing is counted a second way — an entry map breaks that for one award,
and once broken there is nothing to point the next one at. And a field inherits
the window every other figure already uses (`from = start ?? firstEntry`,
clamped to `MAX_RANGE_DAYS`), where a second derivation is a second answer
waiting to disagree about what "ever" means — the same reason `computeRecovery`
returns `longest` and `lastEnd` rather than letting awards recount them.

**A field is not free, though, and this one is the first to say so out loud.**
The paragraph three above — awards are computed at `/stats` and never inside
`computeStats`, because `/overview` calls that once per habit and keeps `score`
and `currentStreak` — applies word for word to a FIELD of `computeStats` that
only the detail view reads. Coverage is its own pass over the window, measured
at ~10-11% of a call (2,000 iterations of a 400-day habit: 12.1s against 10.8s),
and it was being paid per habit on the dashboard's hot path and discarded. Every
other field there is either a pass the summary figures already need or a cheap
read of one, which is why this is the first opt-out and not a general one:
`coverage: false`, passed by both `/overview` routes, and the key is then
**absent** rather than empty — an empty array claims no month is fully answered,
where this is the absence of a claim. `computeAwards` reads `stats.coverage ??
[]` and withholds the badge, which is the right answer for a caller that did not
ask. A test pins the call sites by COUNT as well as by content, so a third route
cannot quietly start paying for it, and asserts the declining call is the one
NOT feeding awards — declining it on `/stats` would withhold the badge from the
only surface that shows it.

**`computeCoverage` reports only the months the window entirely CONTAINS, and
that one rule does two jobs.** A partial first month — the habit was created on
the 10th — can never legitimately be full, so reporting it is either a figure
nothing can reach or, if the denominator were the days of the window rather than
the days of the month, one reached wrongly. And it settles #146's monotonicity
requirement with no second rule: on the last day of a month the month is
contained and can no longer go down, while on the 3rd it is not contained at
all, so the badge cannot appear on the 3rd and vanish on the 4th. Containment is
asked as "does the window hold all of this month's days", which needs no
comparison against the window's ends and survives `boundedRange` clamping the
far one. Both edges have tests, and the coverage fixture straddles the boundary
by a **day and not by a month** — two Januaries alike but for one row — because
a fixture with a full month and an empty one passes against `answered > 0`,
which is exactly how #137's tenure fixture went unpinned.

**Rest taken deliberately reads a number `computeStreaks` was already standing
next to.** A skip bridges a run rather than breaking it, so a long run may
contain planned rest, and "you rested and did not fall off" is a different claim
from "you did not stop" — which is why the award is read from a new `skips` on
each streak and not from the streak award's own rung. The subtlety is that
`skips` must count only the skipped days INSIDE `[start, end]` of the run: skips
are transparent to the loop, so a trailing one sits after `runEnd` and belongs
to nothing, and banking every skip on sight reports a rest the run never
carried. `x x s .` is the fixture — one skip, and a run of two days that does
not contain it — beside `x x s x`, where the MISS has moved and the same skip is
now inside the run. Note which token moves: the skip is on the same date in
both, and what changes is whether anything closed the run before the skip could
be banked into it.

There are **two** ways a skip lands outside a run and the pair above only
reaches one of them. A skip after the run's last on-pace day is kept out by the
reset when the run closes; a skip before any run has STARTED is kept out by the
guard on banking at all, and nothing exercised that — the guard was deletable
with the whole suite green until `s x x x x x x x` was added. It is not a tidy
case: seven days on pace with a rest the day before them is a badge reading
"held together across 1 skipped day" about a day the run does not contain.
A third fixture puts a skip in the gap between two runs, which needs both.

It is gated on the account's `skipDays`, which defaults **off**: with the
setting off there is no Skip control on either grid or in either day editor, so
the only skips are imported ones and the badge congratulates somebody on using
something they do not have. That gate is a **fifth argument** to `computeAwards`
and it inherits the trap the fourth had — optional, so dropping it turns the
award off for a whole edition in silence. The call-site guard now demands five
and names the fifth, and it was mutation-tested against the two shapes that have
fooled it before: a comment naming the full call, and the call spread over
several lines. It also refuses a hard-coded `true`, which passes every other
assertion in that test and hands the award to everybody.

**But that guard reads SOURCE TEXT, and the class of bug one argument along is
not a text bug.** It matches the file rather than the binding that reaches the
call, so `settings ->> 'skipdays'` with the column alias left alone, and
`=== true` written as `!== true`, both pass it — and each one silently costs
every account in that edition the award, in opposite directions. No regex over
source can close that; the second one is not even wrong-looking. So each edition
has a **behavioural** test that sets the setting through its own API and watches
the badge appear and disappear: `test:awards` in personal, the `--- awards ---`
block in cloud's API suite. Both were confirmed by mutation to catch exactly
those two while the unit suite stayed green at 55 of 55. The text guard is kept
because it catches the different thing they cannot — a call site that reads no
setting at all — and the two are written up as covering different halves so
neither is deleted as redundant. Both also pin `coverage` to `/stats` and its
absence from `/overview`, which is the opt-out above seen from the wire.

**What is NOT here, and why, because each looked cheap and was not.**
*Beat your worst day* is refused for a harder reason: it is
a current-state claim over a lifetime rate, so it is not monotone; its "stops
being the lowest" half can be satisfied by another weekday getting WORSE, which
is an award for regression; and its entire value is NAMING the day, which the
server cannot do — a weekday name is locale-dependent and `shared/src` has no
locale, so it would have to hand the client a number to compose prose around,
which is the one thing computing awards on the server exists to prevent.
Portfolio awards read every habit at once and belong to an account-level route.

`?start=` narrows the window and lowers any of these, which is the same
mechanism as the two above and the one case where it is unambiguously right:
that caller is asking about a period, exactly as the detail view's range
controls do, and `bestStreak` has always answered it that way.

**Nothing here is worded per habit shape, and that was checked rather than
assumed.** An at-most habit and a `show_as: 'avoid'` one both earn from the same
vocabulary — lapse, streak, strength — because those are the words the cards
either side of the awards row already use for the same habit, and #113 inverted
the RENDERING and no verdict. `show_as` is display-only, so the two award
identically and a test pins that.

**One element here has text on a fill, and it must not be the habit's colour.**
The "New" pill took `--award-accent`, which is a colour the user picked and
whose lightness nothing constrains, with `color: #fff` — so a pale habit gave
white on white. Every other coloured surface in the app either carries no text
or mixes against a theme variable, as `charts.js` does. It takes `--accent` and
the `#fff` pairing `.btn-primary` already ships in both themes; the habit's
colour stays on the chip's left edge, where it needs no contrast ratio.


