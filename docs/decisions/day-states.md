# Day states, scoring and at-most habits

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**Skips are stored out of band.** `entries.status = 'skip'`, never a magic
value. A numerical habit can legitimately record `3`, which used to collide
with Loop's SKIP sentinel and silently turn a real failure into a skip —
bridging streaks and inflating scores. `isCompleted()` takes `{value, status}`
for this reason.

**A day has four states, and the fourth is a missing row.** `done`, `skip`, `no`
(a row holding 0) and `unknown` (no row at all). "Not done" used to be the
absence of a row, which made the last two one thing — and the note exception
("except when a note is attached, which needs a row to live on") is what gave
that away: the row was already the difference between a day the user answered and
a day nobody has, but only a note could bring one into being. So Loop's
`pref_unknown_enabled` — *show question marks for missing data* — had nothing to
show, and a Loop backup's explicit `NO` rows were discarded on import because
there was nowhere to put them.

`entryWrite` therefore never deletes: `PUT {value: 0}` records a stated lapse and
`DELETE` is how a day goes back to unknown. `PUT {value: 0}` has changed meaning
for every client that used it to clear, which is invisible while question marks
are off (a lapse and an unknown day paint identically) and never wrong about what
it claims. Two more consequences, and the first is easy to state too strongly.

**The score, the streaks and the completion count do not move — the
window-derived figures can.** `isCompleted` is `false` for a 0 row and every
caller treats a missing row as a miss, so for the same window in, the same
numbers come out: `computeStats` is identical for a 0 row and no row, and both
editions still count a completion as `value = 2` — personal in `countCompleted`,
cloud in an inline `COUNT(*) FILTER`. But some ranges *start* at
the earliest stored entry (`from = start ?? firstEntry` in `computeScores`, and
the history and weekday aggregations behind it), and a lapse is a stored entry
where there was none. Every unknown day between it and the next row then reads as
a miss — which is the model working as designed, and also why resilience can go
from "nothing has ever been missed" (`recovery.rate === null`) to a real lapse the
moment one day is marked as missed. One ancient Loop `NO` now extends a habit's
history back to its own date, where before it was dropped on import. Nothing is
miscounted; the window is simply older, and honest about it.

**That paragraph was true of every habit but one, and the exception is the kind
you want to STOP.** "Every caller treats a missing row as a miss" was a claim
about the callers, and six of them made it by writing
`entryMap.get(date) ?? UNSET` — the collapse `shared/CLAUDE.md` forbids of a
reader, done in the one place nobody was reading it as a display decision. For
an at-least habit the two spend identically, which is why it went unnoticed. For
an **at-most** habit zero is *under* the limit, so the unanswered day was handed
a full success: a limit nobody had ever logged reported an unbroken streak and a
strength climbing toward 100%, both growing for as long as it was ignored.

The fix is not a new concept, it is the fourth state reaching the rules that
already know about it. `normalizeEntry` answers `status: 'unknown'` for a
nullish entry, and `isCompleted` / `dayCredit` decide from that. Note what does
NOT move with it: **a row holding 0 is still a success on an at-most habit**
under either answer, because that is the user saying "none today", which is the
thing being asked for. The distinction the whole four-state model exists to draw
turns out to be worth a real number here, where before it was only worth a
question mark.

Which of the two an unanswered day should be is not decidable in `stats.js`:
"I didn't smoke today" is worth a tap and is the whole reward, while "I had no
soda" is not something anyone opens an app for. Both are ordinary and people
keep both, so it is asked at **two levels** — the account's `atMostUnlogged`,
which most habits follow, and the habit's own `at_most_unlogged`, which
overrides it. `'default'` means the account's, and it is what an unmigrated row,
a Loop import and an unrecognised value all land on: falling back to `success`
would hand a limit a perfect record on a typo. The precedence is resolved in
`unansweredCounts` and nowhere else, because every caller already has the habit
in hand and none of them should have to remember it.

The account default is `miss` — the other way round, every limit
arrives with a perfect record on the day it was created. The setting is
**portable** (it changes what the days with no row in the same backup are worth,
so restoring the entries without it restores different streaks) and it is *not*
Loop's: Loop has no such preference and its backup carries no preferences at
all, so it travels in habiterall's own JSON and nowhere else. That is true of
the habit's field as well as the account's, which is why `at_most_unlogged` is
in `JSON_HABIT_FIELDS` and in neither Loop list — a Loop round trip correctly
returns it to `'default'`. The fixture sets it to `success` on its one at-most
habit for the reason `reminder_message` taught the cloud suite: a field that
holds its default everywhere compares equal to itself and passes with the field
dropped. The entries themselves are untouched by any of this, so a Loop export
is exactly as faithful as it was.

**A habit you are trying not to do is stored as what it is, and SHOWN the other
way up.** `show_as` is `'amount'` or `'avoid'`, per habit, and it decides the
rendering and nothing else — which is the whole reason it can exist. Issue #64's
other option was a flag inverting the JUDGEMENT, and Loop's schema has nowhere
to carry one: losing it on a round trip would flip every verdict in the file.
Losing this loses a display preference and the rows go on meaning what they
meant, so it sits in `JSON_HABIT_FIELDS` and in neither Loop list, exactly as
`at_most_unlogged` does. `YES` still means the thing occurred, `isCompleted`
still comes from the target, and the export is untouched.

The storage is an at-most target, which needs no new column and round-trips
perfectly. What was missing was the interaction, and the surprise is how little
it cost: **the tap cycle did not change**. An avoided habit walks the same four
states in the same order — a clean day is `done`, a slip is `no` — so
`nextDayState` and its Kotlin mirror `Grid.nextState` were untouched. Only the
ENCODING differs, and it is one function per client (`valueForState`), mirrored
for the reason the cycle is: it runs when a tap is made with no network.

| state | normal habit | avoided habit |
|---|---|---|
| `done` | `YES` | **0** — none today, which is the goal |
| `no` | `0` | **target + 1** — the smallest amount that fails |

`target + 1` rather than a fixed 1, so a limit of two coffees records three: the
least the app can claim on someone's behalf. The day editor still takes the
exact number, which is why it keeps the amount box beside the two buttons.

Three surfaces invert with it and one deliberately does not. The grid paints a
clean day in the habit's colour and a slip in red, because filling a slip with
the habit's own colour — right for a habit read as an amount, where a bigger
number is more done — reads as having done well. The day editor's buttons read
Clean day / Slipped. The Android notification's read Clean / Slipped and carry
the encoded value in the intent, since `ActionReceiver` has only an id and a
date and a DataStore read inside a broadcast receiver's ten seconds is not
available — the value is decided where the habit is in hand. What does NOT
invert is the ACTIONS: `ACTION_YES` is still the good answer. Inverting those
would have meant every stored notification and every outbox entry changing
meaning with a setting.

The offline reminder cache gained two fields, appended and read with
`getOrNull`, because the notification's buttons are built with no network and
a cache written by an older build must still arm its alarms.

None of this is bad-habit support of the other kind, and it is worth being clear
about the join.
A limit of zero is already how a bad habit is *expressible* — issue #64's option
(b) — and `success` on that habit is what makes it usable: assume clean, record
the exception. What is still missing is the interaction, which is the rest of
that issue: you answer by typing a number rather than tapping yes/no, a filled
cell paints as an achievement rather than a slip, and the tap cycle runs in the
order a good habit wants.

Three consequences worth stating because they look like inconsistencies and are
not. The **reminder still asks** about an unlogged day under either answer —
`answeredIds` is about whether the day was ANSWERED, and under `success` the
reminder is precisely how you record the exception. Both editions' SQL
completion counts needed no change at all: they count rows, and a day with no
row was never in them. And that is the third — under `success`,
**`totalCompleted` counts ANSWERS while the window-derived figures count DAYS**,
so a limit kept by saying nothing shows a streak, a strength and a full history
bar beside a "total done" of zero. Both are right about their own question and
neither can be made to answer the other's cheaply: the count is lifetime and
computed in SQL, while the rest are a window walked day by day. It is the same
split the paragraph on stated lapses opens with, arriving from the other side.

**The rule is gated to at-most habits, and the gate is load bearing.** Ungated,
`success` fell through to the ordinary predicate for every habit — and on an
at-least habit with a target of **0**, `0 >= 0` is true while `dayCredit`'s
`target <= 0` branch answers 0. One response then reported a 30-day streak and
100% history beside a strength of 0, which is the score and the streak
disagreeing about the same day. A target of 0 is reachable (`parseHabit` accepts
it, the form's `min` is 0, the Loop CSV path defaults one), and
`at_most_unlogged` deliberately **outlives** a switch from At most to At least —
so a habit carrying `success` does arrive here as an at-least habit. The test
that pins it asks the invariant directly rather than by example: across every
habit shape and both answers, a full-credit day must be a completed day.


**The score is a trailing-window ratio**, not per-day credit scaled by
frequency. The earlier formula overshot for every non-daily habit and was
hidden by a clamp; a single checkmark on a 1×/365d habit reported 100%. The
decay constant is Loop's own, `0.5^(sqrt(frequency)/13)` — read from its
source, not guessed. A fixed 30-day half-life sat here for a while and made a
perfect habit take four months to look strong instead of one.

## Issue #222 — an unlogged day that counts as kept, drawn as one

Everything above this heading is `unansweredCounts` deciding what an unlogged
day is WORTH. None of it taught a single grid cell to draw the answer: every
figure the server computes — score, streaks, history, weekday charts,
times-per-week — read `success` correctly, and every cell any client painted
still showed an empty square, because the renderers gate on the presence of a
row and stop; they never asked the precedence at all. The repro that made this
concrete: a daily at-most habit, target 2, `at_most_unlogged: 'success'`, one
row 30 days ago and nothing since. The server reports a 31-day streak, a score
of 0.809, and 31 of 31 history buckets completed. The Calendar card paints one
filled square and thirty empty ones; the History card immediately under it
paints thirty-one full bars. Same page, same window, opposite verdicts.

### The decisions, and why each one is what it is

**The cell does change, and the treatment is a faint MARK, not a new step on
the ramp.** The alternative — folding an unlogged-but-kept day into the
existing colour ramp, as if it were a recorded amount at some fractional
strength — would have made the Less→More legend lie: that ramp means "how much
was logged", and this day has nothing logged on it at all. A mark that reads
as "this is a different KIND of fact" was the only option that leaves the ramp
meaning what it already means.

**Day cells (checkboxes) get a ghost `✓`; the calendar (blocks) gets a faint
block.** These are not the same idea painted twice, they are one idea in two
mediums. `ui/day-strip.js`'s cells and the Android widget's grid are a glyph
medium: one character stands for the whole day, so the natural way to say
"this counted as a check mark, faintly" is a faint check mark. `charts.js`'s
calendar and `DayGrid`'s own cells are a block medium: a filled rectangle
already IS the unit of meaning, at varying opacity for varying strength — so
the natural way to say the same thing there is a faint fill, not a glyph
stamped on top of a block that has never carried one. A design that put a
ghost tick INSIDE the calendar block, or a tinted background behind the
checkbox glyph, was considered and rejected for exactly this reason: it
imports the other grid's vocabulary into a place that already has its own,
which reads as two ideas rather than one.

**The faint mark replaces the `?`, it does not sit beside it.** Both the
checkbox and the calendar cell have exactly one slot for "what happened here"
— one glyph, one fill — so `questionMarks`'s `?` is suppressed on precisely the
days the new mark already claims: `charts.js`'s `unknownMark` block gates on
`!habit.unlogged_is_success`, and `paintCheckbox`'s ghost-tick branch is
checked before the `showUnknown` branch, so the tick wins when both would
otherwise apply. This does lose something — "nobody answered" and "counted as
kept anyway" were two separate facts, and one glyph cannot show both at once —
so both survive in the one place that is not a glyph at all: the accessibility
text. The calendar cell's `<title>` (what a screen reader gets; it never sees
the fill) reads `` `${date}: counted as kept — no entry` ``, and Android's
`describe(...)` reads `"counted as kept, no entry"` for the same cell. Neither
fact is dropped; they are just no longer both visible glyphs.

**0.07, chosen against the ramp's FLOOR, not picked from the ramp.** The
at-most ramp's existing fills, for the habits this can ever reach (numerical,
`target_type: 'at_most'`):

| cell | fill |
|---|---|
| clean (`value <= target`) | `shade(color, 1)` — full |
| over target | `shade(color, max(0.15, 1 - (value-target)/scale))` — 0.15 floor |
| unlogged | `var(--grid-empty)` |

`Math.max(0.15, …)` is the floor an over-target day can fall to, and it means
something specific: a number WAS recorded, however badly the day went. 0.07 is
under half of that floor, deliberately, so a kept-unlogged cell can never be
mistaken for a recorded amount at a glance — it reads as categorically fainter,
not as "a very bad day". (The `Math.max(0.2, …)` floor belongs to the
at-least branch, which `unansweredCounts`'s gate means these habits can never
reach; it is not the number this was chosen against.)

Android's fill uses `alpha = 0.15f` for the kept-unlogged cell against its own
existing `alpha = 0.35f` for a measurable habit that fell short — a different
absolute number from the web's 0.07, and that is intentional rather than a
drift between clients. The two ramps blend toward different things: the web's
`shade` mixes toward `--grid-empty`, a themed near-white/near-black background,
while Android's alpha blends the fill toward the CARD behind it. Matching the
literal number across clients would not have matched the visual weight; what
was matched instead is the RELATIVE position — under half of each client's own
"a number was recorded" floor — which is what actually keeps the mark from
being misread on either platform.

**The renderers get the answer from a server-resolved boolean on the habit
payload, `unlogged_is_success` — not a sixth mirror.** Two alternatives were on
the table and both lost. One was a fifth copy of the precedence logic in
`ui/toggle.js` (which already mirrors the tap cycle and is DOM-free by
construction, so it was the obvious place to reach) plus a sixth in Kotlin, to
match `unansweredCounts`. Both were rejected on the same ground `shared/CLAUDE.md`
already states for every existing mirror: a client earns a copy of shared logic
only when it must work OFFLINE with no server round trip available at all — the
tap cycle, reminder-time parsing, `needsReminder`, the entry encoding, the
channel default. Deciding what a day's FILL should be is not that: both editions'
`/overview` and `/stats` routes already hold the exact pair `unansweredCounts`
needs (the habit, and the account's resolved `unlogged` setting) for the score
and the streaks on the same response, so resolving the boolean there costs each
route one more call to a function it already imports, and ships the ANSWER
rather than a reason for two more places to compute one. It goes stale in
exactly the way `score` and `currentStreak` beside it already do — an offline
client draws the account's last-known verdict until its next `/overview` — which
is not a new offline-correctness cost, because nothing about this flag is truer
offline than those figures already were.

**The gate makes the boolean branch of every renderer unreachable, on
purpose.** `unansweredCounts` returns `false` unless the habit is non-boolean
AND `target_type === 'at_most'`, so `unlogged_is_success` can only ever be
`true` for two paint branches: `isAvoided(habit)` (`show_as: 'avoid'` +
at-most + numerical) and a plain at-most numerical habit. A boolean habit's
day-state branch was deliberately given no matching arm in any of the four
files that draw one (`charts.js`, `day-strip.js`, `DayGrid.kt`, `Widgets.kt`) —
there is no habit shape that could ever reach it, and an arm that can never
fire is a claim the tests cannot make honest.

### What is still open

**Streak connectors drawn over an empty cell was issue #176, addressed
below** — a different route (`inStreak`, `charts.js`) from anything in this
section, and it left `unlogged_is_success`'s own fill untouched: a
kept-unlogged cell still paints its own faint fill, independent of whatever
the connector pass decides about the days around it.

**What silence is WORTH was issue #223, addressed below.** Different layer
again — this is about which cells paint which fill; #223 is about whether an
unanswered day may be read as compliance at all, which it now may only once the
habit has stated one real answer. **It adds a case to THIS section's family,
though**, and says so at its own end: the kept-unlogged fill is drawn from a
per-habit boolean with no date in it, so a day before the credit date paints as
kept while every figure counts it a miss. What else remains open: the window's
far end is still deliberately unbounded, so an abandoned limit habit with one
real answer still accrues credited silence.

## Issue #176 — a streak is linked through cells painted "no entry"

`charts.js`'s calendar already draws connectors through a run
(`inStreak`, built from `streakDates`), but the cell loop those connectors run
over never asked `inStreak` at all — it is computed once per render and read
only by the connector pass, twenty-some lines above the loop that decides each
cell's own fill. So a kept 3-in-7 run painted as a few filled squares joined by
a bar over cells that drew nothing: any day with no row (and, on a boolean or
at-least habit, any day holding a stored 0) left `fill` at `empty`, regardless
of whether a connector was crossing it. The reproducing habit was already in
the fixtures — Gym, boolean, `freq_numerator: 3`, `freq_denominator: 7`, logged
Mon/Wed/Fri for 60 days — where every Tue/Thu/Sat/Sun is unlogged, on pace, and
inside one long run.

`shared/src` needed no change. `onPaceSeries` and `computeStreaks` already put
these days inside the run figure the server reports; this was a rendering gap
only, sitting on top of a score and a streak count that were already right —
the same shape #222 above found, one layer over.

### The decisions, and why each one is what it is

**A stroke on the calendar, a reused ghost tick on the strip — covered in "A
day nobody answered, drawn as kept" above, not restated here.** Both issues
are the same shape of question: a faint mark competing for a fill slot the
ramp above already uses (0.07 / 0.15 / 0.2), or for a glyph slot a checkbox
has only one of. What follows is what is specific to a RUN rather than to a
single day's own verdict.

**Rejected: a `shade(color, 0.12)` fill, squeezed between 0.07 ("Kept,
unlogged") and the at-most ramp's 0.15 floor.** It would sit on the same fill
ramp those floors describe, and a real over-target fill can legitimately land
anywhere from 0.15 up — so a fill picked to read as "there is a run here"
would be indistinguishable, at a glance, from a very faint recorded amount.
The ramp already means something specific; asking it to also carry "this cell
is inside a run" is the same collapse #222 rejected once, for a different
reason.

**Rejected: reusing 0.07 for two different meanings.** "Kept, unlogged" and
"inside a run" are different facts about a cell — one about the day's own
verdict, one about the days around it — and a `<title>` / popover that says
both ("no entry — in a run") only works if there is one visual weight that
answers both questions at once being asked for two different reasons; the
existing 0.07 fill already answers one of them. A stroke, being on no ramp,
answers the other without touching either number.

**The rule is "where the cell draws nothing at all", not "where the day is not
a completion".** A half-filled at-least cell, an over-limit number, a red slip
and a skip already read as something on either surface, and marking them again
would be a second mark on a cell that has already said something. On the
calendar that predicate is `fill === empty` — read against the binding the
paint branches themselves assign, not a string literal, so it inherits every
exclusion those branches already encode. A future day needs no separate
`!isFuture` guard on top of it: the `isFuture` branch above always assigns
`fill = 'transparent'`, which already fails the `=== empty` test on its own.
On the strip the same rule reads "no glyph and no background".

**A stored `0` and a missing row both get the mark.** A run is about pace, and
a stated lapse inside a kept run is still on pace — the same decision #222
made about `unlogged_is_success` habits, applied here to every habit shape a
run can reach. Neither branch reads an entry map for a verdict; both ask the
same `fill === empty` / "no glyph, no background" question the rest of the
mark already asks, never `entryMap.get(date) ?? UNSET`.

### What was not extended, and why

**The dashboard's own day-square strip.** `ui/day-strip.js`'s `dayCells` and
`repaintCells` both take the run set as their last argument, defaulting to
`new Set()` — which is what leaves `ui/dashboard.js`, their other caller,
undrawing nothing. `/overview` ships only `bestStreak`, no per-day streak
range, so marking a run on the dashboard would need that route to carry one,
in both editions, which this issue did not ask for and Mark scoped out on
purpose.

**Android.** `android-native`'s payload carries `currentStreak` as a plain
number and no per-day run data, so neither `DayGrid` nor the home-screen
widget has anything to locate a run from. A follow-up issue is filed for
Android's grid and widget together with the dashboard strip above, since both
would need the same `/overview` streak-range payload this issue does not add.

### What is still open

**The calendar and the detail page's own "Recent days" strip draw a run now;
the dashboard's day squares and both Android grids still draw these same days
blank**, until the follow-up above ships whatever payload change either needs.
Same habit, same run, three surfaces still disagreeing about it — the gap
#222 found between the Calendar card and the History card, still open here in
a different pair of surfaces.

**What silence is WORTH was issue #223, now addressed below**: a different
layer again, about whether an unanswered day may be read as compliance rather
than which cells carry a mark — but not unrelated, because it leaves behind one
more surface disagreeing with another about one day. The kept-unlogged fill is
drawn from a per-habit boolean carrying no date, so a day before the credit date
paints as kept while every figure counts it a miss; that gap is measured and
named at the end of the #223 section. What else remains open is the far end of
the credit window, deliberately — there is still no "silence expires" rule, so
an abandoned limit habit with one real answer keeps accruing.


## Issue #223 — an unanswered day counts as success only once the habit has answered

`unansweredCounts` says whether a day with no row counts as having met an
at-most habit. Under `success` it does — "I stayed under the limit by not doing
anything about it" — and until this issue that reading needed no evidence of any
kind. `resolveWindow` opened every top-level summary at `start ?? firstEntry`
with `firstEntry` the earliest stored row of ANY kind, so a lone **skip** a year
in the past opened a year-wide window in which every silent day was credited.
Measured on master, a daily at-most habit, target 2, `at_most_unlogged:
'success'`, window ending 2026-08-19:

| stored rows | streak | strength | totalCompleted |
|---|---|---|---|
| none at all | 1 | 0.052 | 0 |
| one row today, value 1 | 1 | 0.052 | 1 |
| one row today + an imported lapse a year earlier | 366 | 1.000 | 2 |
| ONLY an imported lapse a year earlier | 366 | 1.000 | 1 |
| ONLY a skip a year earlier — **before** | **365** | **1.000** | **0** |
| ONLY a skip a year earlier — **after** | **1** | **0.052** | **0** |

Only the last row moves, and it moves to become identical to the first: a habit
with no evidence reads like a habit with no rows. The same skip on an at-LEAST
habit reports 0 / 0.000 both before and after — the finding was never the number,
it was that the identical mechanism adds BLAME on one habit shape and CREDIT on
the other.

### It is a credit rule, not a window move — and that is the whole design

The obvious fix, and the one that shipped first as **PR #292**, was to move the
anchor: make `firstEntry` the earliest row whose status is not `'skip'`. It
produces the table above and it was rejected, for a cost that only shows up one
figure over.

**`computeCoverage` asks a different question, and a skip answers it.** Coverage
counts `answered` as `entryMap.has(date)` — `awards.js` states outright that
"`done`, `skip`, `no` and `unknown` are four things" — and it shares the one
window with everything else in the payload, deliberately, "so coverage cannot
disagree with the awards beside it about what 'ever' means". Measured: a habit
whose first ever row is `{2026-01-01, skip}` and which then holds a stated value
on **every** day through 2026-08-19 reports seven fully-answered coverage months
on master and **six** under the anchor form — January dropped, a month in which
all 31 days hold a row, because a window opening on the 2nd no longer CONTAINS
January. A coverage award rung goes down for a month the user answered
completely. That is the anchor form paying for the fix with a figure that was
right.

So the window stays where it is and a **second** date decides credit:

```
from       = start ?? earliest row of ANY kind ?? end     (unchanged)
creditFrom = start ?? earliest row that STATES a value ?? end
```

Both go through one clamp-and-normalise helper (`windowStart`), because two
spellings of that sequence would be two chances for them to disagree about the
same stored row and every word about the ORDERING would have to hold twice. Two
questions, two dates: `from` is how far back the reading REACHES, and a skip
belongs in it because a skip is an answer; `creditFrom` is whether SILENCE inside
that reach may be read as compliance, and a skip does not answer that — it says
"this day does not count", which is no evidence a limit was kept.

`start ??` is the first clause of both and is load bearing. A caller that names a
window is naming it; this rule exists to stop STORAGE-derived silence from
inventing evidence, not to overrule a caller. `ui/detail.js` sends no `start`,
which is the half the issue calls already-right and which is untouched — and with
an explicit `start: '2026-08-10'` and one row today the reading is 10 / 0.41327
before and after. Drop that clause and it reads 1 / 0.051922. The corollary is a
rule for direct callers: **a caller whose own `start` came out of storage must
pass `undefined`**, which is exactly what both editions' `/overview` does with
its `entries[0].date`.

### The gate sits ABOVE the two-level precedence, and the first draft got it wrong

The first draft threaded the rule as an `unlogged` VALUE — hand the passes
`'miss'` for a day before `creditFrom`. That is wrong and it failed silently in
the most misleading direction: `unansweredCounts` resolves a habit's own
`at_most_unlogged` over the account's answer, so a habit carrying an explicit
`'success'` overrode the gate and only habits on `'default'` were fixed — the
exact habits the issue is about, unfixed, with a passing measurement beside them.
It is therefore a separate argument (`mayCredit`) applied to `isCompleted` /
`dayCredit`'s ANSWER, and it can only ever withhold credit that `unlogged` would
have granted. The wiring test asserts all three spellings — habit `success` with
account `miss`, habit `default` with account `success`, habit `default` with
account `miss` — because a fixture using one of them cannot see this.

`creditFrom` reaches **nine** passes: `computeScores`, `onPaceSeries` (and so
`computeStreaks`, `computeMissRuns`, `computeResilience`), `computeHistory`,
`computeWeekdays`, `computeWeekdayByMonth` and `computeFrequency`. Not just the
two the issue measures: `dayCredit`'s own comment says the rule "has to be the
same or the score and the streak disagree about the very same day", and a history
bar or a weekday rate painting a day as kept that the streak beside it counts as
missed is that same disagreement one surface further out.

Both dates are derived from the deduped entry MAP rather than from the `entries`
array, so the two of them and every downstream reader see the same rows by
construction. They can only differ where one date appears twice — the map keeps
the LAST — so reading the array would let a value row the map has already
overwritten with a skip go on granting credit over a window that holds no stated
value as far as every other figure is concerned. Unreachable through either
edition (`PRIMARY KEY (habit_id, date)`), and the test pins both orderings
because a rule reading the array passes one of them by accident.

### The imported-lapse row is deliberately left at 366

A row holding `0` with status `''` is the user recording "I was at zero that
day": real evidence, unlike a skip's "this day does not count". A stretch of
credited silence after real evidence is precisely what the root `CLAUDE.md`'s
"a stored lapse can move window-derived figures, and that is the model working"
paragraph and this file's own opening describe, and it is said out loud here
rather than quietly narrowed. This issue **qualifies** that paragraph rather than
contradicting it: it was written under `miss`, where a wider window adds BLAME to
every unknown day, and under `success` the identical mechanism adds CREDIT — the
opposite sign on the same rule. The archive's "say so before fixing it" covered
the lapse; it could not have covered the skip, because a skip is not the lapse
the paragraph is about.

**The window still has no far end**, also deliberately. An abandoned at-most-
`success` habit with one real answer still accrues credited silence for as long
as the account exists. Bounding it — "credit unanswered days only within N days
of the last real answer" — was the issue's option 2 and lost: it needs a number
nobody has measured AND a name for what happens past it (a streak that stops
growing is not one that breaks), and it moves figures for a sparse-but-real limit
habit that genuinely is still being kept. Gating the streak and the strength on
`totalCompleted > 0` lost too, as a symptom patch on the report: it leaves the
two figures disagreeing with the window that produced them, which is the
disagreement `resolveWindow` exists to prevent.

### What did NOT move, measured

- **At-least and at-most-`miss` habits do not move at all.** Those shapes already
  count an unanswered day as a miss, so there is no credit to withhold. This is
  the second thing the anchor form cost and this one does not: there, a
  skip-anchored NON-daily habit opened its window later and scored HIGHER for it
  (measured 0.053382 → 0.120939 on a 3×/7 habit, because `onPaceSeries` pro-rates
  its requirement by the window's width), while a daily habit of either shape was
  immune and so could not show it. Here both are byte-identical: 0.04195 daily,
  0.053382 at 3×/7, before and after.
- **`coverage`, `totalCompleted` and every `entryMap.has` figure** are untouched,
  the window not having moved. `totalCompleted` walks stored rows only, so no
  unanswered day ever reached it.
- **A skip that is not the earliest row** changes nothing (366 / 1.000 / 1).
- **#270 stops being adjacent.** The anchor form made a phantom-dated row
  reachable as the anchor — rows `{2026-01-01 skip}`, `{2026-07-99 value}`,
  `{2026-08-17}`, `{2026-08-18}` gave 2 / 0.101149 / 3 over 230 score points on
  master and *every figure zero* on that branch, because `2026-07-99` normalises
  to 2026-10-07 and `boundedRange` answered `[]`. A credit rule moves no anchor,
  so that window is master's byte for byte and the interaction is gone. The
  honest half: on an at-most habit resolved to `success` those same rows now
  credit nothing, because the phantom date is the earliest stated value and its
  rollover lands past `end` — #270's existing hazard reaching a second date by
  the same route, not a new hazard, and the reason `creditFrom` goes through the
  same clamp-then-normalise sequence rather than a second one. #270 itself is
  untouched. **The rollover moves the credit date in BOTH directions and the
  disclosure has to say so**: it can land past `end` (above — nothing credited,
  the fail-closed direction) and it can land EARLIER than the habit's real
  answer, which credits silence the rule means to withhold. Measured, rows
  `{2026-01-01 skip}`, `{2026-02-31 value 1}`, `{2026-08-18 value 1}` on the same
  at-most-`success` habit: `2026-02-31` normalises to `2026-03-03`, so credit
  begins five and a half months before the only real answer and `currentStreak`
  reads **169** where the rule implies 2 (master read 229). Same #270 population
  — a row predating `assertDate`, a direct insert or an import around it — and
  the same conclusion, that #270 is worth fixing on its own; but the fail-open
  half is stated rather than left out, and both are pinned.
- One asymmetry worth stating: for a DAILY habit the skip-only reading becomes
  identical to the no-rows reading, which is the issue's table. For a **3×/7**
  habit it does not (0 / 0.011434 against 1 / 0.034303), because the window
  legitimately still reaches back a year and the trailing seven days ask for
  three completions where a one-day window pro-rates down to 3/7. That is
  `onPaceSeries`' leniency window, not the credit rule, and it is pinned.

### The two surfaces that scan a pass themselves, fixed in the same PR

`resolveWindow` is only reached through `computeStats` and `summaryStats`. Two
surfaces compute a pass directly and so had to be handed the credit date
explicitly — both were already inconsistent with the habit's own page and both
are fixed here rather than deferred, because a fix that leaves one figure on the
old rule is how a dashboard and a detail page come to disagree about one habit.

1. **`/overview`'s three figures, and the credit date is a LIFETIME question.**
   Both editions scan streaks themselves for `bestStreak`, over a wider window
   than `summaryStats` uses (`STREAK_HISTORY_DAYS`, 1830 days against 400),
   starting at `entries[0].date` — the earliest row of any kind. So `score` and
   `currentStreak` came from the fixed entry point while `bestStreak` beside them
   did not: measured on the skip-only fixture, `/stats` reported `bestStreak` 1
   and `/overview` reported **365**, on the same habit, in the same second.

   The first version of this fix handed each of those two scans a credit date
   derived from **its own slice**, and defended the bound as "the same trade the
   `score` beside it already makes". That was wrong, and review caught it. The
   `score`'s slice trade is harmless because an EWMA over 400 days has converged;
   a credit date does not converge — it decides what the days at the END of the
   window are worth. Measured, at-most habit resolved to `success`, one stated
   value 500 days back and a skip 350 days back: master read **1.000** on the
   dashboard and **1.000** on the habit's own page, and the slice-derived version
   read **0.051922** against **1.000** — a disagreement this fix would have
   CREATED, on precisely the habit class the issue is about. Worse, the payload
   contradicted itself, because `bestStreak`'s 1830-day slice could see the
   answer the 400-day one could not.

   It is the same argument `firstEntry` already makes one item down: **a bounded
   window cannot tell "never answered" from "answered before the rows I
   fetched"**. So both routes read the lifetime `first_answer` out of the grouped
   `MIN(date)` query, resolve it ONCE through `creditAnchor`, and hand that one
   date to `summaryStats` and to the streak scan — one derivation, so the three
   figures cannot disagree about WHEN THE HABIT FIRST ANSWERED by construction.
   That is the credit date and not the window; the paragraph below is what the
   windows still do to `currentStreak`. `creditAnchor` takes no `start`
   parameter at all rather than documenting that a route must pass `undefined`,
   because a parameter that must always hold one value is a rule waiting to be
   broken. The grouped read consequently runs in ARCHIVED mode too, where it used
   to be skipped for having no `categorySummaries` to feed: the row figures are
   computed either way, and skipping it would make the archived view the one
   place they are wrong. Pinned behaviourally in each edition, with a fixture
   whose stated answer is deliberately OUTSIDE the 400-day slice — the first
   round's fixtures put every row 365 days back, inside both windows, where the
   two derivations agree and neither could fail.

   What is left, and it is older than this issue: the credit date is now one
   date, but the WINDOWS it is applied over are still three. `score` and
   `currentStreak` read 400 days (`SUMMARY_WINDOW_DAYS`), `bestStreak` reads
   1830 (`STREAK_HISTORY_DAYS`), and `/habits/:id/stats` reads lifetime — so a
   habit whose only stored row is 500 days old still reports `score` 0.051922,
   `currentStreak` **1** and `bestStreak` 501 on the dashboard, against 1 / 501
   / 501 on its own page. **`currentStreak` belongs in that list and used to be
   missing from it**, and naming it matters more than the other two, because it
   is the figure that disagrees even where they have been brought into
   agreement.

   Measured at both routes on this branch, on the very fixture this item's
   regression test builds — at-most habit resolved to `success`, one stated
   value 500 days back, one skip 350 days back:

   | | `/overview` | `/habits/:id/stats` |
   |---|---|---|
   | `score` | 1 | 1 |
   | `bestStreak` | 501 | 501 |
   | `currentStreak` | **350** | **501** |

   `score` and `bestStreak` agree there — that is this fix working — while
   `currentStreak` is out by 151 days on the same habit in the same second: a
   streak of 350 under the habit's name on the dashboard and 501 on that
   habit's own page. The cause is not the credit date, which both reads resolve
   to the same day, and it is not `unlogged` either. It is `from` in
   `resolveWindow`, which opens the reading at the earliest row IN THE SLICE IT
   WAS HANDED: the 400-day slice holds nothing but the skip, and a skip cannot
   OPEN a run, so the streak starts the day after it and is 350 days long; the
   lifetime read opens at the stated answer 500 days back and carries that same
   skip through without breaking it: `{length: 501, skips: 1}`.
   Reproduced byte-identical against master with no `creditFrom` mechanism in
   the tree at all, which is what makes it older than this issue.

   Closing it means making the dashboard's `currentStreak` a lifetime read,
   which is a behaviour change on that route's hot path and out of scope here.
   So it is instead PINNED where it stands — 350 from `/overview` and 501 from
   `/stats`, as literals, in both editions' regression blocks — so that the gap
   stays visible and cannot move without a test saying so.
2. **The category comparison.** `computeCategoryStats` scores each member from
   `memberWarm`, and a skip-only member read **1.00** there against **0.051922**
   on its own page — a wider version of the 0.97-against-0.41 gap
   `shared/CLAUDE.md` already records for the warm-up clamp, and worse, because
   1.00 is the ceiling. The member's credit date has to be a LIFETIME question
   for exactly the reason its `firstEntry` already is — a route fetches a bounded
   slice, and "has never stated an answer" is not "has stated none in the window
   I happened to fetch" — so it comes from SQL: one extra aggregate on the
   grouped `MIN(date)` query both editions already run for `/categories/stats`,
   `firstAnswer`, derived from `entries` when the key is absent so the function
   stays usable standalone. The window there still opens at `memberWarm`, so the
   landing rule, `unloggedExcluded` and `landsOn` are untouched — a skip-anchored
   member still lands and is still averaged in, now at an honest strength.

### What this leaves open, and one of them is new

**The clients still paint a kept-unlogged cell from a per-habit BOOLEAN, and the
rule now has a date in it.** `unlogged_is_success` rides on the `/overview` and
`/stats` payloads and every renderer asks the same thing of it — `value == null
&& habit.unlogged_is_success` in `charts.js`' calendar cell and its history
fill, in `ui/day-strip.js`, and in Android's `DayGrid.kt` and `Widgets.kt`. That
boolean cannot carry "…and only from the day this habit first answered", so for
an unanswered day BEFORE the credit date the cell paints "counted as kept, no
entry" while the server counts it a miss.

Measured on this branch against master — numerical at-most, target 2,
`at_most_unlogged: 'success'`, rows `{2026-01-01 skip}` and `{2026-08-01 value
1}`, today 2026-08-19, reading the day 2026-06-15:

| | master | this branch |
|---|---|---|
| `score` / `currentStreak` | 0.999995 / 230 | 0.636894 / 19 |
| `history` bucket for that day | `completed: 1` | `completed: 0` |
| calendar cell, day strip, Android grid and widget | kept fill | **kept fill — unchanged** |

On the detail page the disagreement is on ONE screen: the Calendar card paints
that day as kept, the History card beside it draws a zero bar for it, and the
legend swatch under both says "Kept, unlogged". This is the class #222 and #176
are about — the same day read differently by two surfaces — and this issue adds
a case to it rather than only inheriting one, which is why both of those
sections' closing paragraphs now say so.

A weaker version predates this: an unanswered day OUTSIDE `[from, end]` was
always painted kept while contributing to nothing. What is new is a day INSIDE
the reading painted kept and counted as a miss, and it can span months.

It is left out of this PR deliberately rather than for lack of a fix. The fix
shape is known and is not small: serve the resolved date beside
`unlogged_is_success` — both `/overview` loops already hold it as `creditFrom`
and `/stats` has it inside `resolveWindow` — and gate the paint on
`date >= credit_from` in all five renderers. That is a new response field, two
web modules and two Kotlin ones, a `CACHE_VERSION` bump (introducing
`unlogged_is_success` itself was treated as one, for the same three modules
moving together), and verification in the browser suites and an Android build.
The data is right on every surface that computes a figure; what lags is the
paint, which is the direction this project's own scope rule prefers to be wrong
in — a rendering gap rather than a data gap — and it wants its own issue with
#222 and #176 beside it.

**The far end of the credit window is still unbounded**, deliberately, as above.

**And `/overview`'s windows still disagree about each other, `currentStreak`
loudest.** `score` and `currentStreak` read 400 days where `bestStreak` reads
1830 and the detail page reads lifetime, so a habit whose only stored row is 500
days old reports `score` 0.051922 and `currentStreak` 1 beside a `bestStreak` of
501. **`currentStreak` is the one that disagrees even when the other two have
been brought into agreement**: on the fixture item 1's regression test builds —
one stated value 500 days back, one skip 350 days back — `/overview` reports 350
where the habit's own page reports 501, with `score` and `bestStreak` matching
at 1 and 501. Both figures are pinned as literals in the two editions'
regression blocks so the gap cannot drift while it is unfixed. Measured
identical on master: that is the window mismatch, older than this issue and out
of scope for it.

## Issue #224 — a quick answer erases that day's note

Measured live against the real personal adapter, no mocks, before any change —
a stored entry `{value: 2, notes: "coach said 10, only managed 8"}`, then a
press of Yes through `interactionAdapter().record({action: 'yes'})`:

```
BEFORE:               {"value":2,"notes":"coach said 10, only managed 8"}
AFTER  press :        {"value":2,"notes":""}     <- interactionAdapter().record(action:'yes')
AFTER  PUT w/o notes: {"value":2,"notes":""}     <- the Android shade, Api.kt:817
AFTER  PUT notes:"" : {"value":2,"notes":""}     <- the deliberate clear; must keep working
```

Three callers of `entryWrite` never had a note to send in the first place —
`answerBody` builds a Discord/ntfy reply from the action alone, and the
Android notification shade's PUT is the same shape — and all three were
silently overwriting one anyway, because `parseEntry` read
`String(body.notes ?? '')`: an absent key and an explicit `''` arrived at the
function as the same string, and every upsert wrote `notes = excluded.notes`
without asking which. The fourth caller, the web day dialog
(`shared/public/ui/day-dialog.js:145`), always resends the note it loaded, so
it never depended on the collapse and is the one path this had to keep
working unchanged.

### The governing precedent was already written down, for a different route

`shared/CLAUDE.md`'s import rule — "a merge may add an answer and must never
delete one" — draws exactly this line for `applyImport`: a bare lapse yields to
a stored row in merge mode, and "bare" is `!notes.trim()`, not `!notes`,
because content is what suspends the automated overwrite. That rule was never
extended to the answer path, and #224 is the same content doing the same job
one level down: a note is something a user typed on purpose, and an automated
write — a button press, a reminder answer — that never saw it is not evidence
the user wants it gone. The single case the precedent does NOT cover is
`notes: ''` sent on purpose, which is why decision 2 exists separately: an
explicit empty string is content too, in the sense that matters here — it is
something the CALLER supplied, deliberately, rather than something `parseEntry`
invented by collapsing an absence.

### Where "absent" and "explicit-empty" stop being distinguishable

They stop being distinguishable the moment `String(body.notes ?? '')` runs.
Fixing it downstream — in each edition's route, or in each SQL upsert alone —
would have meant fixing it three times (personal's route, personal's notifier,
cloud's route, cloud's notifier: four, in fact) with three chances for one of
them to re-collapse the two cases on the way in. `parseEntry` is upstream of
all four, so the fix is one branch: `body.notes === undefined ||
body.notes === null ? null : String(body.notes).slice(...)`. `null` now means
what `??` used to erase — "not supplied" — and every downstream reader is
handed the distinction rather than asked to reconstruct it. A JSON `null` is
folded into the absent case rather than given a fourth meaning, for the same
reason `??` folded it into `undefined` before: nothing sends it on purpose, and
inventing a "the caller explicitly said no note" reading for it would be a
second interpretation nobody asked for.

### The SQL shape, and why the parameter is bound once and referenced twice

The natural-looking fix — write `notes = excluded.notes` unless `excluded.notes
IS NULL` — cannot be spelled through `excluded`, because the `COALESCE` on the
`VALUES` side has already turned an absent note into `''` for the INSERT
branch, by the time the conflict clause could read `excluded.notes` at all: a
fresh row needs `''` to satisfy `NOT NULL`, so whatever value lands in
`excluded.notes` is the post-`COALESCE` one, and the conflict clause needs the
PRE-`COALESCE` value to tell "absent" from "cleared". The one value that
survives to answer both questions is the bound parameter itself, asked twice:
once inside the `VALUES`-side `COALESCE` (collapse `NULL` to `''` for a row
that has never existed) and once in the `SET` clause's own `COALESCE`
(`NULL` means "leave `entries.notes` alone"). This was proven against both
engines before it was written down here — a real Postgres 17 container and
`node:sqlite` — and the three things it establishes are the reason no schema
change or migration was needed: `entries.notes` is already `TEXT NOT NULL
DEFAULT ''` in both editions, so a stored `NULL` was never a legitimate value
and is free to mean "absent" without colliding with anything a user could ever
have saved.

The over-eager version was tried and rejected on purpose, not merely avoided:
`COALESCE(NULLIF(?, ''), entries.notes)` reads an explicit `''` as "nothing to
say" too, and would preserve a note the user just asked to clear — the day
dialog's own use case. The mutation that proves this is in the personal and
cloud test suites, run and reverted: that exact SQL substitution is what makes
the "PUT `notes:''` clears" and "the echo on a clear" cases fail, which is the
day dialog's whole way of working.

### The reply had to stop echoing the request

Before this, `entryWrite`'s `reply` always carried `notes` straight from the
`parsed` argument, so a route only had to spread it into `res.json(...)`. Under
preserve semantics that stops being sound: a PUT that omits `notes` now has
`notes: null` in `parsed`, and echoing `null` (or coercing it back to `''`)
would tell the caller the note was cleared when storage still holds it — a
fresh defect of exactly the kind #224 is about, this time in the response
instead of the write. There is also no fallback value `entryWrite` could
supply instead, because it is a pure function with no database handle; only
the row the upsert just wrote knows what is actually stored. So `notes` was
taken OUT of `reply` rather than patched — `reply` is `{value}` and `{value,
status: 'skip'}` now — which makes "echo the request" something a route has to
add back in on purpose rather than something it does by not thinking about it.
Both editions' `upsertEntry` gained `RETURNING notes` for exactly this: the PUT
route reads the returned row and answers with the note that is actually there,
which is also why the notifier's own upsert deliberately did NOT gain a
`RETURNING` — `answerText(...)` never contains a note, so there is nothing for
that caller to echo and widening its query would be a change with no reader.
`Api.kt:481`'s `val notes: String = ""` is the reason personal's route
coalesces a missing row (the `delete` branch, which nothing reaches today) to
`''` rather than leaving the field out: the client's own default already
assumes a string is always present.

### Why an entry write and a habit write are allowed to disagree

`PUT /habits/:id` REPLACES, on purpose, and the root `CLAUDE.md`'s "the two
habit routes disagree about what a write means" paragraph already says so —
`parseHabit` supplies a default for every field a body omits, so an omission
there IS the stated intent. Making `PUT /habits/:id/entries/:date` do the same
with `notes`
would not have been a neutral choice sitting beside that one; it would have
been the same collapse #224 closes, just moved from `parseEntry` to
`parseHabit`'s side of the fence. The distinction is not "notes are special",
it is what KIND of body each route receives. A habit PUT is a form a client
rendered in full and submitted whole — every field was ON SCREEN, so leaving
one out is a decision about that field. An entry PUT is, at least as often, a
button's entire vocabulary: `answerBody` for a Discord press or an ntfy button
returns `{value}` or `{status: 'skip'}` and nothing else, because those UIs
have a Yes, a No and a Skip and never rendered a note field to omit from. The
Android notification shade is the same shape again, a third caller with no
note in its own body. An omission from a form is intent; an omission from a
button is ignorance — the button never had the information to omit on
purpose — and treating the two alike would make one of the two write rules
wrong regardless of which one it borrowed from.
