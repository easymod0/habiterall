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

**Streak connectors drawn over an empty cell are issue #176**, arriving here by
a different route (`inStreak`, `charts.js`). A kept-unlogged cell paints its own
faint fill; whether a streak line should visually bridge it is that issue's
question, not this one's, and this change does not touch `inStreak`.

**The credit window's missing far end is issue #223.** Different layer again —
this is about which cells paint which fill; #223 is about how far a range that
starts at the earliest stored entry should reach, which the root `CLAUDE.md`
already documents as "the model working" rather than a bug.

