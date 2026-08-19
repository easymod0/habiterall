# shared — working notes

Everything both editions have in common. **Nothing here may import a
database, an HTTP framework, or edition-specific code.** That constraint is
what lets the same file serve a single-user SQLite app and a multi-tenant
Postgres one.

## Modules

| file | what it owns |
|---|---|
| `src/stats.js` | scoring, streaks, resilience, history/weekday/frequency aggregation |
| `src/validate.js` | every input rule for habits, entries, and dates |
| `src/notify.js` | notification destinations, which reminders are due, what they say, and what a button means |
| `src/notify-send.js` | delivering them, and the tick loop — network only through an injected `fetch` |
| `src/discord.js` | posting as a bot (the only way to get buttons) and handling a press |
| `src/discord-gateway.js` | the WebSocket that receives presses, so no inbound port is needed |
| `src/import.js` | parsers: habiterall JSON, Loop `.db`, Loop CSV |
| `src/export-loop.js` | writes a Loop-compatible `.db` |
| `src/export-csv.js` | builds the `Habits.csv` + `Checkmarks.csv` archive |
| `src/unzip.js` | minimal ZIP reader (Loop's CSV export) |
| `src/zip.js` | minimal ZIP writer, for the CSV archive |
| `src/constants.js` | `UNSET` / `YES` / `SKIP` wire values |
| `src/security.js` | the CSP, the session cookie shape, the four rate limits, the `TRUST_PROXY` rule and `sameOriginOnly` — **data, not middleware**, so this package keeps its no-dependencies property |
| `src/password.js` | hashing, verification, and the one answer to "is auth on?". Personal's half of the shared sign-in flow; cloud uses none of it |
| `src/log.js` | structured logging: one event per line, one stream, and the redaction that keeps personal data out |
| `src/observe.js` | `logStartup`, `requestLog` and `watchRuntime` — an Express-shaped middleware that never imports Express |
| `src/types.js` | JSDoc typedefs, exporting nothing at runtime. The contract between three packages |
| `public/app.js` | boot, the top bar, the PWA; `start(authAdapter)` is the entry |
| `public/ui/store.js` | view state, and the `'change'` / `'reload'` channel views listen on |
| `public/ui/dashboard.js` | the habit list: day grid, paging, search, empty state, reordering, checkbox taps |
| `public/ui/detail.js` | the single-habit view and every chart on it |
| `public/ui/habit-dialog.js` | create / edit / delete / undelete a habit |
| `public/ui/day-dialog.js` | edit one day from the calendar |
| `public/ui/data-dialog.js` | backup and restore |
| `public/ui/settings-dialog.js` | the settings dialog, built from the registry |
| `public/ui/components.js` | card, subheading, segmented control, `windowedChart`, `cardInnerWidth` |
| `public/ui/views.js` | which of the two main views is showing |
| `public/ui/routes.js` | which view the URL names, and keeping the two in step |
| `public/ui/api.js` | every request, and what to do when one cannot be made |
| `public/ui/connectivity.js` | the offline banner, the outbox badge, reconnect handling |
| `public/ui/toast.js` | the transient message strip |
| `public/ui/nudge.js` | the browser's own reminder — what is still outstanding, when to say it and where. Dependency-free (one `document` listener, handed in), mirroring `answeredIds` |
| `public/ui/reminder-field.js` | the reminder time picker inside the habit dialog |
| `public/ui/amount.js` | reading, stepping and formatting an amount, DOM-free so it is testable |
| `public/ui/count-field.js` | the amount control over those rules, in the day editor and over the grid |
| `public/ui/settings.js` | the preference registry and its server sync |
| `public/ui/calendar.js` | calendar window/zoom maths, DOM-free so it is testable |
| `public/ui/window.js` | how many columns a chart fits, and which slice to show |
| `public/ui/resample.js` | thins the daily score series for the strength chart |
| `public/ui/dates.js` | browser-side date helpers, and the label-width estimator every chart reserves space with |
| `public/ui/time.js` | parsing and formatting a reminder time, DOM-free so it is testable |
| `public/ui/toggle.js` | what the next tap on a day records — Loop's cycle, and what each state is WORTH for this habit. DOM-free, mirrored in Kotlin |
| `public/ui/theme.js` | light / dark / follow-the-device, as a stored preference. No redraw callback — see `themed` in charts.js |
| `public/ui/values.js` | `UNSET` / `YES` / `SKIP` for the browser, mirroring `src/constants.js` |
| `public/auth-session.js` | the one auth adapter: `none` / `password` / `setup` / `oidc`, chosen by what the server reports |
| `public/charts.js` | hand-rolled SVG charts |
| `public/sw.js`, `offline.js` | PWA shell cache and the write outbox |

Parsers return plain data; the *writing* is per edition (`apply-import.js`),
because one talks to SQLite and the other to Postgres under row-level
security.
The frontend has its own file: **`shared/public/CLAUDE.md`**. Long-form
reasoning for everything below is in `docs/decisions/` — `day-states.md`,
`awards.md`, `import-and-loop.md`, `reminders.md`, `timezones.md`,
`discord.md`, `outbound-urls.md`.

## Day states and habit shape

The four states and the ban on `?? UNSET` are in the root `CLAUDE.md`. What is
specific here:

**What an unanswered day is worth on an at-most habit is asked at two levels.**
"I didn't smoke today" is worth a tap and is the whole reward; "I had no soda" is
not something anyone opens an app for. Both are ordinary, so there is the
account's `atMostUnlogged` and the habit's own `at_most_unlogged`, which
overrides it. `'default'` means the account's, and it is where an unmigrated row,
a Loop import and an unrecognised value all land — falling back to `success`
would hand a limit a perfect record on a typo. The account default is `miss`, or
every limit arrives with a perfect record on the day it was created.

**The precedence is resolved in `unansweredCounts` and nowhere else**, because
every caller already has the habit in hand and none of them should have to
remember it. It is exported for `awards.js`, which asks it rather than restating
it.

**A row holding 0 is still a success on an at-most habit** under either answer —
that is the user saying "none today", which is the thing being asked for.

**`isCompleted` / `dayCredit` take `{value, status}`.** Passing a bare number
still works for boolean habits, where `3` is unambiguously a skip, and is wrong
for numerical ones, where `3` is a real amount.

**The rule is gated to at-most habits, and the gate is load bearing.** Ungated,
`success` fell through to the ordinary predicate for every habit — and on an
at-least habit with a target of **0**, `0 >= 0` is true while `dayCredit`'s
`target <= 0` branch answers 0: a 30-day streak and 100% history beside a
strength of 0. A target of 0 is reachable, and `at_most_unlogged` deliberately
**outlives** a switch from At most to At least. The test asks the invariant
directly rather than by example: across every habit shape and both answers, a
full-credit day must be a completed day.

**Under `success`, `totalCompleted` counts ANSWERS while the window-derived
figures count DAYS** — a limit kept by saying nothing shows a streak, a strength
and a full history bar beside a "total done" of zero. Both are right about their
own question; the count is lifetime and computed in SQL, the rest are a window
walked day by day. The **reminder still asks** about an unlogged day under either
answer: `answeredIds` is about whether the day was ANSWERED, and under `success`
the reminder is precisely how you record the exception.

**A habit you are trying not to do is stored as what it is, and SHOWN the other
way up.** `show_as` is `'amount'` or `'avoid'`, per habit, and it decides the
rendering and nothing else — which is the whole reason it can exist. A flag
inverting the JUDGEMENT has nowhere to live in Loop's schema, so losing it on a
round trip would flip every verdict in the file; losing this loses a display
preference. `YES` still means the thing occurred and `isCompleted` still comes
from the target.

The storage is an at-most target, so **the tap cycle did not change** — an
avoided habit walks the same four states in the same order, and `nextDayState`
and its Kotlin mirror were untouched. Only the ENCODING differs, in
`valueForState`: a clean day is `0`, a slip is **`target + 1`** — the smallest
amount that fails, so a limit of two coffees records three. Three surfaces invert
(the grid's colours, the day editor's buttons, the notification's) and the
ACTIONS deliberately do not: `ACTION_YES` is still the good answer.

None of this is bad-habit support of the other kind. A limit of zero is how a bad
habit is *expressible*; what is still missing is the interaction — answering by
typing a number, a filled cell painting as an achievement.

**A habit's `icon` is one grapheme, decided by `parseIcon` and never a second
name.** It is validated the way `reminder_message` is — a rule in `validate.js`,
the importer's own copy in `import.js` — and, because `PUT /habits/:id`
REPLACES, a partial write clears it exactly as it clears every other omitted
field. The length limit is UTF-16 units, not characters, because a grapheme
cluster (a ZWJ family, a flag tag sequence) can legitimately be many of the
latter; slicing it would corrupt the sequence rather than shorten it, so a
value past the cap is dropped to `''` instead. It renders `aria-hidden` on
every surface — the dashboard row, a habit's own page, the day editor, the
archive view (the same dashboard row, so it needs nothing of its own) — because
an emoji announces as its Unicode name and must never stand in for the name a
screen reader gets. It is in `JSON_HABIT_FIELDS` and in no Loop list: Loop's
schema has nowhere to put it, so a Loop round trip correctly returns it to `''`,
the same asymmetry `at_most_unlogged` and `show_as` already have.

## Scoring, streaks and stats

**The score is a trailing-window ratio**, not per-day credit scaled by frequency.
It feeds an adherence ratio (always `[0,1]`) into an EWMA; do not "simplify" it
back to scaling a day's credit by `1/frequency`, which overshot for every
non-daily habit and was hidden by a clamp — a single checkmark on a 1×/365d
habit reported 100%. The decay constant is Loop's own,
`0.5^(sqrt(frequency)/13)`, read from its source: a 13-day half-life for a daily
habit, slower for less frequent ones. A fixed 30-day half-life lived here for a
while — the same shape, but so sluggish that a perfect habit took four months to
look strong instead of one. `test/stats.test.js` pins the curve at days 13, 30
and 60 so it cannot drift back.

**Every date range is clamped**, and `computeStats` starts at
`from = start ?? firstEntry`, clamped to `MAX_RANGE_DAYS` (`end - 3660`). That
window is derived inside `computeStats` and never returned, which is why anything
needing a figure from it gets a returned field rather than walking the entries
again — `computeRecovery` answers `longest` and `lastEnd` for that reason. Every
aggregation in `stats.js` already uses `boundedRange`; keep it that way, because
the unbounded `dateRange` on a distant-past entry turns one request into
~700,000 iterations on a single-threaded server.

**`dateRange` walks one local-time `Date` with `setDate`, never an epoch
integer.** It used to re-derive every day from a string — two `fromISO` calls
and a `toISO` per element — measured at 92% of `computeScores`' total time;
advancing a single `Date` instead is the same ~8x cheaper on every aggregation
in this file, since all of them go through `boundedRange`. The obvious faster
rewrite, `t += 86400000`, is wrong: it repeats `2026-11-01` under
`America/New_York`'s fall-back transition, because that calendar day is 25
hours long and an epoch walk cannot see the extra hour. The literals in
`test/stats.test.js` hold in this repo's own zone under *either* walk, which is
exactly why `test/timezones.test.js` exists — it sweeps both `stats.test.js`
and `streaks.test.js` under fixed `TZ`s in a child process, because `TZ` is
read once at process start and nothing short of a fresh process observes a
changed one.

**One input changed meaning with that rewrite, deliberately: a range that
STARTS on a date which is not a real day.** The old walk pushed the string it
was handed before normalising anything, so `dateRange('2026-02-30', …)` opened
on 2026-02-30 — a day that does not exist — and then skipped 2026-03-02, the
real day the rollover lands on. Building the `Date` up front normalises first,
so the list is a contiguous run of days that happened. `assertDate` refuses
such a date at every write path, so this is only reachable by reading one back
out of storage — a row predating that guard, a direct insert, an import that
went around it — and it matters because `computeStats` takes `from` as the
earliest STORED entry when a caller names no window. An account holding such a
row sees its derived figures move once. That is the phantom day leaving them,
not a regression.

`computeStats` therefore normalises `from` before it clamps, and that half is
not optional: `totalCompleted` selects by STRING comparison against `from`
while every other figure is read off the walked list, so an un-normalised
`from` counts the phantom row in one figure and in none of the others —
exactly the disagreement the note above `totalCompleted` says was fixed.

**And `n` counts elapsed 24-hour spans while the loop takes calendar steps**,
which agree everywhere except a zone that moved the date line WESTWARD and so
lived one local calendar day twice — `Pacific/Kwajalein` in 1969. There the
loop takes a step the elapsed count never saw and ends a day past `end`, so
the walk trims anything beyond it. A DELETED day needs no counterpart: the
elapsed count shrinks along with the calendar, which is why Apia round-trips
untouched. Both cases are pinned in `test/timezones.test.js`, under their own
zones, because neither is observable from anywhere else.

**`onPaceSeries` pro-rates the requirement near the start** —
`required = min(activeDays, num*activeDays/den)` — so a habit is not judged
against history it does not have yet. Consequence worth knowing before touching
it: moving the earliest entry EARLIER re-judges the first `den - 1` days against
a full requirement they now fail, so *remembering something you did* can lower a
figure. Daily habits (`num >= den`) have no leniency window and are immune, which
is why a test suite built on one cannot see this.

**`computeCoverage` reports only the months the window entirely CONTAINS**, and
that one rule does two jobs. A partial first month can never legitimately be
full, so reporting it is either unreachable or wrongly reached; and it settles
monotonicity with no second rule, since on the 3rd a month is not contained at
all. Containment is asked as "does the window hold all of this month's days",
which needs no comparison against the window's ends and survives `boundedRange`
clamping the far one.

**Coverage is an opt-out, and the first field to be one.** It is its own pass —
~10-11% of a call, measured — and both `/overview` routes pass `coverage: false`
because they keep four fields per habit and would discard it. The key is then
**absent** rather than empty: an empty array claims no month is fully answered,
where this is the absence of a claim. Every other field here is either a pass the
summary figures already need or a cheap read of one.

**A streak's `skips` counts only the skipped days INSIDE `[start, end]` of the
run.** Skips are transparent to the loop, so a trailing one sits after `runEnd`
and belongs to nothing, and banking every skip on sight reports a rest the run
never carried. There are **two** ways a skip lands outside a run: after the last
on-pace day (kept out by the reset when the run closes) and before any run has
STARTED (kept out by the guard on banking at all). The second was deletable with
the whole suite green until `s x x x x x x x` was added.

**Best streaks are selected by length but listed by date.** Two different
questions: which runs to show, and how to order them. A list ordered by length
reads as a leaderboard and hides whether the good runs were recent. Note the
bar scale must come from `Math.max(...top)`, not `top[0]` — that stopped being
the longest row the moment the ordering changed.

**A streak and a lapse are made of "on pace", not "done today".** `onPaceSeries`
asks whether the trailing `denominator`-day window holds enough completions,
pro-rated by any skips inside it — the same window and the same pro-rating
`computeScores` uses, so strength and streaks cannot disagree about whether a
habit is being kept. For `num >= den` the window is one day and the
requirement clamps to it, so this reduces exactly to `isCompleted` and daily
habits behave as they always have; that degeneration is what makes the change
safe, and `test/resilience.test.js` pins it.

Consequences worth knowing. A streak counts CALENDAR days, so a 3×/week habit
kept for a month is a 30-day streak rather than a 12-day one — that is what
"I have kept this up for a month" means, and it keeps the number comparable
with a daily habit's. The window is rolling, not calendar-aligned: three
sessions crammed into Mon–Wed satisfy every day that week and then fall short
the following Monday, because by then the trailing seven days hold only two.
And this is a computation change only — nothing about storage, the schema or
the Loop export moved.

**Resilience applies at any frequency.** It used to return
`{applicable: false}` for non-daily habits, because a miss meant "a day it was
not done" and a 3×/week habit has four of those every week. `onPaceSeries`
fixed the premise instead: a miss is a day the habit fell below its RATE.
`applicable` is kept in the response shape but nothing sets it false. Two
related rules in the same code: an *ongoing* lapse is excluded from recovery
rate (being mid-slip is not the same as having failed to recover) and reported
as `openRun` instead; and a rate of `null` means "nothing has ever been
missed", which is a different claim from 100% and must not render as a number.

**`weekStart` reaches every weekday axis, and for a long time it did not.**
`startOfWeek` in stats.js has always honoured it, so the history and
times-per-week charts bucketed on the right day — while `calendarWindow`
snapped unconditionally to Saturday/Sunday and the weekday charts drew Sunday
first. Someone whose week starts on Monday got a Sunday-anchored heatmap on the
chart the detail view opens to, with the labels beside it saying otherwise. The
setting's own help text says it is "used by the history and times-per-week
charts", which is literally true and is exactly how it survived.

`weekOrder` in charts.js is the one translation from `getDay()`'s Sunday-based
numbering to the account's, and **both the labels and the data read through
it**. Rotating the captions alone would have captioned Monday's row "Sunday"
and left the bars where they were — a chart wrong in the one dimension it
exists to show. The calendar heatmap needs neither, because its rows are
positional: `calendarWindow` decides which day the column starts on and the
grid fills sequentially from there. What it does need is the labels, and
Home/End, which jumped to `getDay() === 0` and so walked off the top of a
Monday-start grid.

## Awards

**An award is a READING of the stats response, computed on the SERVER because the
ladder it reads is.** `SURVIVAL_THRESHOLDS` and `MISS_BUCKETS` live in `stats.js`
and `shared/src` is not served to the browser, so computing awards in the browser
meant a second copy of the streak ladder — a badge at 20 days beside a survival
bar at 21. `awards.js` is pure and both editions' `/habits/:id/stats` call it.

**It is called in the two routes and not inside `computeStats`**, which is the
one place it looks like it belongs: `/overview` calls that once per habit and
keeps four of its fields.

**Nothing here is counted a second way.** Every award is a reading of figures
already on the payload, so an award needing something new gets a stats FIELD
rather than an entry map — a second derivation is a second answer waiting to
disagree about what "ever" means.

**An award can be taken away.** Not because the figures move — `currentStreak`
and the score's current value are refused precisely because they fall on an
ordinary bad week — but because the **window** does. Moving `firstEntry` earlier
re-judges the leniency window above (measured: a 3×/week habit's badge went 21 →
14 for logging one forgotten session), and `MAX_RANGE_DAYS` makes a habit older
than ten years slide rather than grow (watched over simulated weeks, a whole card
emptied itself). So the framing is **what this habit's history currently shows**:
the card says so in its lead, the payload carries no `permanent` flag, and there
is no second visual treatment implying some badges are safer. Durable awards mean
a granted ledger with a first-earned date — **issue #141**, and the only thing
that would change this.

Reading a maximum does not make an award durable; it stops it twitching day to
day. That is the smaller claim and the true one.

**The gate: on an at-most habit resolved to `success`, the whole card is
withheld** — ALL awards, not just the ones that would read oddly. An unanswered
day counts as kept there, so a limit with a single stored row grows a streak, a
strength band and a full weekday spread as the calendar moves. Right for a TILE,
which states a number; wrong for a BADGE, which makes a claim in English. The
gate is wider than its motivation on purpose — a limit with twelve typed-in slips
loses honest claims too — because the alternative is a per-award judgement about
which sentences survive, which is a second rule to keep in step. Coverage is the
one award `success` cannot flatter and is still not hoisted; `awards.js` says so
at the gate, and it is one `return` to undo.

**`computeAwards` takes five arguments and three are optional**, which makes
forgetting them silent on precisely the shape they exist for. The routes must
hand it the **same** `habit` and `unlogged` they handed `computeStats`, plus
`skipDays`. Two tests cover different halves: a source-text guard that demands
five and names the fifth (mutation-tested against a comment naming the full call,
a call spread over several lines, and a hard-coded `true`), and a **behavioural**
test per edition that sets the setting through its own API and watches the badge
appear and disappear — because a renamed binding or a `!==` for a `===` is not a
text bug and no regex can see it.

Wording rules that have each cost something:

- **Only the rung reached is shown.** Nine badges for a hundred-day habit is one
  fact said nine times, and the survival chart the card sits under answers "how
  far do my streaks usually get" better.
- **"No lapse over a day" is read from `missDistribution`, not
  `recovery.rate === 1`.** The closed set excludes an ongoing lapse — rightly —
  so three days into one the rate still says every lapse lasted a day. The
  sentence says *so far*, and there is a test on it. Buckets are found by `min`,
  never by `label`; the labels are prose.
- **`fresh` marks the award whose value MOVED**, for `COMEBACK_FRESH_DAYS`, and
  its test asserts a literal 7.
- **A one-day lapse earns no comeback** (`COMEBACK_MIN_DAYS`) — "Back after 1
  day" is what "Recovered N times" already said.
- **A year is measured between the runs, not from `created_at`** — *created* a
  year ago is true of a habit abandoned in its first week. It is the first run's
  **start**; the fixtures straddle 365 days on purpose, because an earlier pair
  gave 399 and 390 and left the distinction unpinned. It is honest about an
  import, which earns it on the day it lands.
- **Every day of the week is "at least once", deliberately not a RATE.**
  `computeWeekdays` counts completions, so a 3×/week habit kept perfectly has
  four weekdays at zero and any threshold over all seven is unreachable for every
  non-daily habit.
- **`STRENGTH_BANDS` is 50/80/95, and a perfect daily habit crosses them on days
  13, 31 and 57** — measured. The first draft asserted 30 and 60. Both sides of
  each crossing are pinned.
- **The "New" pill takes `--accent`, never `--award-accent`** — a habit's colour
  is one the user picked and nothing constrains its lightness, so `color: #fff`
  gave white on white. The habit's colour stays on the chip's left edge, where it
  needs no contrast ratio.

**Refused, and each looked cheap:** *Beat your worst day* is a current-state
claim over a lifetime rate, not monotone, its "stops being the lowest" half is
satisfiable by another weekday getting WORSE, and its whole value is NAMING the
day — which a server cannot do, since a weekday name is locale-dependent and
`shared/src` has no locale. Portfolio awards read every habit at once and belong
to an account-level route.

**Nothing here is worded per habit shape**, and that was checked. An at-most
habit and a `show_as: 'avoid'` one earn from the same vocabulary — lapse, streak,
strength — because those are the words the cards either side already use.

## Import, export and Loop

**Loop compatibility is exact and verified against a real backup**: timestamps
are epoch millis at UTC midnight, `YES_AUTO(1)` counts as done, `NO(0)` is a
stated lapse and keeps its row while `UNKNOWN(-1)` has none, and identity is
`(issuer, subject)`. None of it is guessable — it was read from the uhabits
source. The last two used to be one thing, both dropped, and dropping `NO`
discarded the only mark separating a day the user answered from a day nobody
has, which on a backup from someone who does not use Loop's question marks is
most of their history. `test/import.test.js` and `test/export-loop.test.js` pin
all of it: if you change a conversion and those fail, the tests are right.

**Only entry values scale by ×1000 — habit targets do not.** `Repetitions.value`
of `2000` means 2, but `Habits.target_value` of `2` means 2. Scaling the target
turned "at most 2 times" into "at most 0.002". Reading their source was not
enough to catch this; it took a real export.

**A merge may add an answer and must never delete one.** Both editions'
`applyImport` yield to the existing row for a bare lapse in merge mode and count
it as `entriesKept` — a Loop backup is full of explicit `NO` rows, so merging a
phone export taken before the web history would have wiped every completion the
two disagreed about. "Bare" is `!notes.trim()` and not `!notes`: content is what
suspends the rule, and a note of one space bought a lapse the right to overwrite
eight recorded glasses.

**A skip does NOT yield**, deliberately and pinned by a test. It is an answer —
`isCompleted` returns `null` for it — so a `SKIP` cell in a bare Checkmarks.csv
does overwrite a recorded amount.

**On a merge the FILE's type says how a value was written down; the ACCOUNT's
says what may be stored.** Answering both with one type is how a file claiming
`numerical` put an `8` on a boolean habit — a value `PUT /entries/:date` answers
400 to, and one `isCompleted` reads as *not done* forever. But the file's type
must still decide the ENCODING, because a `3` is Loop's skip sentinel in a
boolean column and three-of-something in a numerical one. The yield above is
gated on `type === 'boolean'`. Where the two genuinely disagree only a lapse and
a skip cross; the rest are reported in `skipped` rather than invented.

**A habit is matched by the name it is STORED under.** The lookup used the RAW
name while the INSERT wrote `clean.name`, clamped to `LIMITS.name` — so past 100
characters three merges of one backup left three habits with one visible name,
and cloud's `willAdd` counted each against `MAX_HABITS_PER_USER`. Every reader of
the name inside that loop moves together.

**An absent value is not an answer.** `entryValue` is about the TYPE, because
`Number(null)` and `Number('')` are `0` and a row holding zero is a stated lapse.
`{date, value: null}` was written as a day the user said they missed while
`{date}` was correctly refused. Harmless on a merge; in **replace** mode there is
nothing to yield to, and an invented lapse extends the habit's history window
back to its own date. Silence is reported in `skipped`. What goes with `Number()`
is its generosity about the *form*: `'0x10'` and `'1e3'` read as 16 and 1000.

**Every parse path has a row ceiling, and there are THREE of them.** An upload's
size is not a bound on what it describes: a SQLite row count is *declared*, so
`CREATE VIEW Habits AS WITH RECURSIVE …` makes 8KB claim five million rows; a CSV
header is one line, so `Date,a,a,a,…` two million times is 7.6MB that deflates
~1000:1; and `{"name":"a","entries":[]}` is 26 bytes. All three aborted the
process — **inside V8**, so the `try`/`catch` that turns a bad upload into a 400
cannot catch it. `MAX_PARSE_HABITS` and `MAX_PARSE_ENTRIES` bound all three, and:

- The bound goes **where the rows are produced** — `.iterate()` plus `LIMIT`,
  the header length — because anything materialising the array first has already
  spent the memory.
- The entry budget is a **total** across the file, not per habit: a per-item cap
  is no defence when the number of items is also the attacker's to choose.
- They are **env-settable with generous defaults**, because personal's API caps
  neither — a fixed ceiling would refuse a file its own API would accept one
  habit at a time.
- Note the name: `PARSE`, not `IMPORT`. Cloud's `MAX_HABITS_PER_IMPORT` is a
  product limit on the parsed array. One is a defence, the other a policy.

**The entry read is ONE pass over `Repetitions`, not one per habit.**
`WHERE habit = ?` inside the loop looks cheap and is the opposite: Loop's schema
indexes `habit`, an uploaded file need not, and then every execution is a full
scan — cost habits × rows, invisible to a budget spent by rows RETURNED. A 6.4MB
file of 2,000 habits and 300,000 orphan rows took 13.5 seconds and yielded zero
entries. Read once ordered by `habit, timestamp` and bucket into a Map, and bill
every row **before** it is looked up — there is a test on that clause.

**Loop's `question` is `reminder_message`; its `reminder_hour`/`reminder_min` are
`reminder_time`.** Both were dropped in both directions. `loopReminderToTime` and
`timeToLoopReminder` are the pair, and the case that decides them is
**midnight**: `00:00` is both columns holding 0, so any check for a truthy hour
reports a real reminder as none. A half-filled row is no reminder rather than
`HH:00`. Two traps: `Number('')` is `0`, so only digits count; and the three
columns are selected as **TEXT**, because read as INTEGER a value above 2^53
makes node:sqlite's row decoder throw for the whole `.all()`.

The CSV's version was a *pair* of bugs concealing each other: the export wrote
`description` into the `Question` column, and the import read
`idx('description', 'question')`. Fixtures where description and prompt DIFFER
are what catch it. Be precise about the import half: `idx` matches on
**headers**, and a real Loop `Habits.csv` always has `Description`, so the
fallback never fired there and the question was simply dropped. It fired only for
a file with `Question` and no `Description` — and there it was arguably right,
since Loop's migration 23 is `update Habits set question = description`.

**Only an ALL-DAYS Loop reminder is imported.** `reminder_days` is a 7-bit
weekday mask and habiterall has no concept of one. Taking the time alone turned a
Monday-only reminder into seven a week AND wrote that widening back into the
user's Loop app; a mask of `0` became daily. On export the mask is `127` with a
reminder and `0` without, which is what Loop's own writer stores.

**An export reports what it could not carry; it does not fail on it.**
`isoToLoopTimestamp` is `Date.UTC`, which rolls a date over, so `2026-02-30` left
as 2026-03-02 — and against a real row there, Loop's UNIQUE index made
`/api/export-loop.db` answer **500 for as long as the row existed**. The
collision is only the loud half: with no row on the day it rolled onto, the
export SUCCEEDED and filed the entry under a day the user never recorded.
`isLoopEncodableDate` asks the exporter's question — *does the timestamp read
back as the day it came from* — which is narrower than `assertDate` on purpose,
and weakens by itself as the encoder improves. Two surfaces report the skips:
`X-Habiterall-Export-Skipped` for a client that made the request, and
`export.rows_skipped` at warn for the browser, which downloads through an
`<a download>` and reads no headers. Count-only in the header, because a habit
name is free text and a `\r\n` in one throws inside the route; and the log report
is `{habit, date, reason}` rather than a sentence, because its reader is a log,
where names never go.

**Loop's backup carries no preferences** — they live in SharedPreferences — so
nothing from a Loop file can set one. habiterall's own JSON does carry settings,
because two of them decide what the rows in the same file MEAN. `PORTABLE_SETTINGS`
is the allowlist and `UNPORTABLE_SETTINGS` names what is held back: the
notification keys, because a backup is a file people email to themselves and a
webhook or an ntfy topic URL is a bearer capability. A **replace** applies what
travels and a **merge** does not.

**Loop's two tracking settings are `skipDays` and `questionMarks`,** both
defaulting off as Loop's own do, read from its source (`pref_skip_enabled`,
`pref_unknown_enabled`). Every surface that can record an answer reads
`skipDays`: both grids, both day editors, the Discord buttons and the Android
notification.

**The CSV export must ship both files.** `Checkmarks.csv` has one column per
habit and nothing that says what a habit *is*, so parsed alone every column
defaults to boolean — and a measurable habit's `3` is then read as Loop's SKIP
sentinel while `8` and `10` are dropped as unknown ones. That is why
`/api/export.csv` returns a zip. `test/export-csv.test.js` pins the failure
mode deliberately, so if the ambiguity ever goes away the test says so.

**And `Habits.csv` is a SOURCE of habits, not only a lookup table.** It was read
purely as metadata to decorate the columns of `Checkmarks.csv`, which meant the
habits an account has were taken from the value grid alone — so an account whose
habits have no entries exported a lone header line and restored as
`400 no habits found in the uploaded file`. Its own habits, fully described in
the other file, were parsed and thrown away. `parseZipExport` unions the two
now, which also covers a habit named in one file and not the other.

## Reminders and destinations

**A destination is either on-device or server-sent, and the difference is the
whole design.** `CHANNELS` says which. An on-device channel is scheduled by the
client, which is what keeps it working offline — so switching one *off* only has
an effect if the client honours the setting. Adding a destination means an entry
in `CHANNELS`, a branch in `sendToChannel`, and an option in `ui/settings.js` —
nothing per edition.

**A server-sent reminder is written down after it is sent** (`notify_log`, keyed
on habit + channel + the user's *local* date). Without that watermark a
minute-by-minute tick re-sends for the whole catch-up window. Keyed per channel,
or a second destination is silenced for its first day; on the local date, or a
user east of the server gets it filed under the wrong day.

**...and under `auto` that local date can move.** An account used from two zones
either side of a date boundary can have it crossed by a device checking in.
**Forward** moves the date on and the gate opens: inside the catch-up window a
second send, past it `too_late` at warn. **Backward** moves it onto a day the log
already has, so the answer is `already_sent` — never `too_late`, because that
gate is asked FIRST. The keying is deliberately left alone: adding the zone makes
the duplicate certain instead of possible.

**The two silences worth a warning**, both through the `once` dedupe.
`notify.too_late` means a reminder was LOST, and that claim rests entirely on the
ORDER of the gates: answered and sent are asked first, or every delivered
reminder is reported as a lost one, once per habit per channel per healthy day.
`notify.unreachable` covers a destination switched on but not configured, where
`needsServerDelivery` is false and every visible surface looks correct — a
Discord channel id on an instance with no `DISCORD_BOT_TOKEN`, silent forever.
Everything else a tick decides is at debug; 1,440 lines a day is how a log stops
being read.

**How it WENT is written down too, and that one is for the user.** A permanent
failure is marked as sent and logged at warn — and the log is the wrong surface,
unreachable to the person it concerns. `notify_status` holds the LAST outcome per
channel. Four things are load bearing: it is **not** in the settings blob (which
`/api/export` carries); it says whether a destination **did** deliver, never
whether it **can** (`channelConfigured` stays the only authority on the second);
it is written on a **change of state**, not per send; and **the state is the
REASON** — `stateKey` covers `ok`/`permanent`/`status`/`error`, because comparing
`ok: false` alone froze the message at whichever failure came first. `date` is
deliberately out of the key, so what is stored is the date the state BEGAN and
the dialog says "not delivered **since**". The wording is the **sender's own**;
re-phrasing it in the UI is how the dialog and the log come to disagree about one
404. `sendTest` records unconditionally, because a press is one deliberate act.

**A day that needs no reminder is one that has been ANSWERED, not one that has
been completed, and there are THREE readers of that rule.** It is
`isCompleted(...) !== false` rather than a truthiness test, because `isCompleted`
returns `null` for a skip — falsy, so a truthiness test asked again about every
day the user had explicitly skipped, while `false` is a real miss and still gets
its nudge. `answeredIds` is the server's; the Kotlin `Reminders.needsReminder` is
the phone's, mirrored for the same reason `ReminderTime` mirrors `ui/time.js`
(two clients answering one question differently is indistinguishable from one of
them being broken), and the phone once had a third rule of its own — "does a row
exist for today?" — which silenced six-of-eight-glasses while the server kept
asking. `isDayAnswered` in `public/ui/nudge.js` is the browser's, for the `web`
destination, deciding from `state` with no network; it is pinned against
`answeredIds` over shared fixtures in `test/nudge.test.js` rather than by
reading, and its shape carries the rule the other two get for free — a nullish
entry is `false` before anything else is asked, because `answeredIds` walks the
rows that EXIST and an at-most habit whose unlogged days count as staying under
would otherwise report every untouched day as answered.

**Whose clock resolves in ONE place, with three tiers.** `resolveTimeZone`: the
zone the account NAMED, else the zone its last client reported, else the
server's. `notifyTimezone` defaults to `auto` — the second tier — so an account
that has never opened the dialog gets reminders on its own clock instead of a
container's UTC.

**The reported zone is stored APART from the setting.** It is an OBSERVATION the
server makes from a header; `notifyTimezone` is a DECISION the user sent. Fold
them and the first client to check in turns "follow my device" into a chosen
value, after which nothing reaches automatic again. It is a `device_clock` table
in personal and a `users` column in cloud rather than a settings key, because
`/api/export` carries settings and restoring a backup abroad must not move when
reminders arrive. It costs no extra request — `X-Habiterall-Timezone` rides on
traffic both clients already make, and the server writes only on a CHANGE.

**`callerDay` is the other question and reads the HEADER and nothing else.** See
the root `CLAUDE.md`. What it is NOT is one day of slack: the spread is UTC−12 to
UTC+14, and 26 hours is wide enough for **two** calendar days at once, so
`today + 1` is both too narrow at the edges and too wide everywhere else.
`shared/test/notify.test.js` asserts the two-day gap directly.

**A zone has to be a NAME.** `parseTimeZone` returns the canonical name and
refuses offset zones. `Intl` accepts far more spellings than there are zones, and
`formatterFor` holds a built formatter and never evicts — measured, 16,384 case
variants of one name retained 2.2MB after GC, per limiter key. Offsets go for a
second reason: `+23:59` is two days ahead of `Etc/GMT+12`, and a fixed offset does
not observe DST. Nothing can send one; the test is for a leading sign rather than
a slash, because `UTC`, `GMT` and `Etc/UTC` all canonicalise to `UTC`.

Two traps that bit while this was written: `deliverAccount` re-deriving the zone
from `settings.notifyTimezone` was a SECOND place the clock was decided, and the
two diverged the moment `auto` existed — the account carries its resolved
`timeZone` now. And `new Intl.DateTimeFormat` THROWS for a zone it does not know,
inside a loop that runs once per account, so `formatterFor` falls back.

**The notifier reads its clock through `zonedClock`, never `new Date()`
locally.** The zone decides two things, and the second is easy to miss: what
time it is, *and* which calendar day the send is filed under. A server in UTC
reminding someone in Auckland files it under the wrong date and re-sends hours
later. Note `hourCycle: 'h23'` rather than `hour12: false` — en-US resolves the
latter to h24 and formats midnight as `'24'`, so a 00:00 reminder is compared
against 1440 minutes and never fires, with a correct-looking date beside it.
`runTick` also *hands* the instant to `collect`, so the adapter cannot read a
second clock a millisecond the other side of local midnight.

**`SETTING_VALUES` rules are an array *or* a normaliser** — a URL and a timezone
cannot be enumerated. That is also why an accepted setting may differ from what
was sent, and why `ui/settings.js` waits for the server's answer.

### Discord

**Buttons need a bot; a webhook cannot carry them.** Discord accepts `components`
on an *application-owned* webhook only, so bot mode exists alongside the plain
webhook rather than replacing it. `CHANNELS.discord.ready` is why "configured" is
a predicate rather than a list of required keys.

**Interactions arrive over a WebSocket, not an HTTP endpoint.** A self-hosted
instance behind a router has no inbound port and no hostname; requiring one would
mean interactive reminders only worked for people who had already solved a harder
problem. It is also why no request-signature verification appears anywhere here —
a socket is authenticated once, by the token.

**The bot token is an environment variable, never a setting.** It can post to
every channel the bot is in, and `GET /api/settings` hands settings to the
browser. The channel id *is* a setting: per user, worth nothing on its own.

**A press is authorised by the CHANNEL it came from, not by its `custom_id`.**
The id carries a habit and a date because that is all Discord gives back, and is
trusted for neither: `resolveChannel` decides whose data is written and the habit
is looked up inside that account. `discordUserId` narrows it to one user.

**A press is acknowledged before any storage is touched.** Three seconds, and
answering used to be the LAST thing `handleInteraction` did — over the line on a
cold pool, showing **"This interaction failed"** on a press that *was* written.
`DEFER_UPDATE` (type **6**, not 5, which posts a visible placeholder) goes out
first and the real answer follows on the same token, good for fifteen minutes.
The `try` wraps **all** the storage and the defer itself, because a type-6 defer
has no loading state to time out — an uncaught throw afterwards leaves the press
looking like it did nothing. Two exceptions: a **modal cannot be deferred**, and
the test button touches no storage. Deferring keeps the buttons live while the
write is in flight; `record` is an upsert, so a double press is idempotent.

**The gateway's own frames are remote input too.** `resume_gateway_url` says
where the NEXT socket opens and the RESUME frame carries the bot token, so
`resumeTarget` suffix-matches `*.discord.gg` / `*.discord.com` and rebuilds from
the host alone — falling back to the published gateway costs a fresh session and
nothing else. HELLO's `heartbeat_interval` sets a timer in this process, so
anything outside 1s–10min takes the published default; ungated, a `1` is a busy
loop starving the tick that shares the event loop.

**One disconnect must produce exactly one reconnect.** Closing a socket ourselves
fires its own `onclose`, so the handler left attached scheduled a second connect
— two live sockets, of which only the newer was heartbeated. Three things stop it
and the ordering of the first is load bearing: `ws` is nulled *before* the close,
the socket is detached, and `scheduleReconnect` is idempotent. The regression
test counts scheduled timers, because every wrong version still reports
`state() === 'waiting'`.

### ntfy

**There is no host list anybody here could write** — ntfy's whole point is that
most people run their own — so which networks this process may be aimed at is the
OPERATOR's question: `NTFY_ALLOWED_HOSTS`, defaulting to `ntfy.sh` alone, naming
your own **replaces** rather than adds, and `off` refuses every URL while still
telling the user why.

**An entry names a host, optionally a BASE PATH, and optionally a SCHEME.** The
scheme defaults to https and `http://ntfy.lan:8080` is how an operator says
their ntfy is on this server's own network, where the hop never leaves it and a
public proxy in the middle buys nothing. It is per ENTRY, not a switch — an
instance can allow http to the box in the cupboard and still refuse it to
ntfy.sh — and it is asked UPWARD only: an `http://` entry serves an https URL
too, because refusing one for being better protected than what was written
reads as a bug, while an https entry never serves an http URL. A user's URL can
never ask for plaintext; only the operator's list can offer it. The canonical
entry therefore carries its scheme (`https://ntfy.sh`), and so must any lookup.

**The BASE PATH is what pins the KIND of request.** The property worth copying
from `parseDiscordWebhook` is not "it checks the host", it is that allowlisting a
destination allows one KIND of request — so it pins the path too. The first
version allowed any 1–4 dotless segments and posted to all but the last, which
under the reverse-proxy deployment our own docs recommend made
`https://example.com/internal/admin/reset/x` a JSON POST with a chosen title,
4000 characters of chosen body and a chosen bearer token, the status handed back
as prose and repeatable from the test button. A user's URL may append **exactly
one topic segment**; the depth is one and not configurable because the topic is
the only part the operator cannot know in advance. It is a **whole-segment**
match (`Set.has` on the joined base), never a prefix, or `/ntfy` allows
`/ntfyadmin` — and the stored URL is rebuilt with the **entry's** spelling.

The rest of the shape and every clause in it: **https, unless the entry itself
named http** (above); **no credentials**
(`https://ntfy.sh@evil.test/x` has a host of `evil.test`); the host matched
**whole and with its port**, never a suffix test (`evilntfy.sh` ends with
`ntfy.sh`); segments containing **no dots at all**, which makes `..`
unrepresentable rather than filtered; and the URL **rebuilt from the parts that
were checked**. Deliberately not hostile: `https://ntfy.sh/a/../b` is accepted as
`/b`, because `new URL` resolves traversal before any of this sees it.

**DNS rebinding is closed by construction**, which is why no IP pinning appears
here: every name in the allowlist was chosen by the operator. Pinning would buy
nothing and break every ntfy behind a load balancer.

**A malformed entry fails closed, and says so once.** `*`, `*.example.com`,
`ftp://ntfy.sh`, `//ntfy.sh`, a bare comma — none allow anything (`http://` and
`https://` are the only two prefixes that mean anything, and every other
spelling of a scheme leaves a host that is not a host, which is the fail-closed
direction rather than a second check). Dropping it in silence was
the wrong half: the only surface was a user's URL snapping back to blank, which
gets reported as an app bug by somebody who cannot fix it.
`notify.ntfy_allowlist_unusable` is the operator's copy. The one fail-OPEN value
is **blank**, which is the `ntfy.sh` default and which the shipped compose files
interpolate as `${NTFY_ALLOWED_HOSTS:-}`.

**The stored value is not the last word.** `postNtfy` asks `ntfyTarget` again at
send time — the WHOLE rule, base path included — because an operator can narrow
the allowlist months after somebody saved a URL. The refusal is `permanent` and
its sentence names the variable.

**A reminder is published as JSON to the ntfy SERVER, not as headers to the
topic.** Both are documented and only one is safe: publishing to the topic URL
puts the title in a `Title:` header, and a habit name is free text. The only
header built here is the optional `Authorization`, refused outright if it could
not go in one.

**It ships as `interactive: false`, and that is a decision.** ntfy's action
buttons would work — as an HTTP request the SUBSCRIBER's device makes, from
wherever that phone is. That is an unauthenticated inbound endpoint, exactly what
the gateway exists to avoid, and the rule that saves the Discord buttons has no
counterpart: an ntfy topic is a URL somebody typed, not a channel to resolve an
account from. A test pins the flag.

**The two server-sent channels are not alike about rate limits, and the tick is
shared.** Discord limits per webhook, so a 429 is one account's own doing and the
inline `Retry-After` sleep is paid by whoever caused it. ntfy.sh limits per
**visitor IP**, which for a server-sent reminder is the instance — so on cloud one
account can put that sequential loop to sleep on everybody else's behalf. Noted
at the sleep rather than fixed there.

## Traps

**A READER must never collapse `unknown` into `no`.** The root `CLAUDE.md` has
the four states, the ban on `?? UNSET` and what a stored lapse does to a window;
what belongs here is the shape that makes the mistake unreachable.
`habit.entries[date] ?? UNSET` reports every unanswered day as an answered "no",
which starts the tap cycle in the wrong place and paints away the one difference
`questionMarks` draws. Ask whether the map HOLDS the date (`Object.hasOwn`, or a
null check in Kotlin), never what it holds. `ui/toggle.js`'s `dayStateOf` exists
so that decision is written once, and `normalizeEntry` answers
`status: 'unknown'` for the absent day so nothing below it has to. `stats.js`
was the exception and did not know it — six passes wrote `?? UNSET`, harmless
for an at-least habit, and a limit with no entries at all reported a 30-day
streak.

**`shared/src` is not served to the browser.** Only `shared/public` is mounted,
so `ui/settings.js` cannot import `notify.js` — the channel list is declared in
both and pinned by `test/notify.test.js`, exactly as `SETTING_VALUES` is. Do not
"fix" this by mounting `src/`.

## Tests

```bash
npm test              # unit — fast, no dependencies
npm run test:browser  # real Chrome, against a fleet it starts itself
```

`test/browser/run.mjs` takes `--bases` and shards the suites across them, one
worker per instance — it knows about no edition, which is how cloud is pointed
at it too. Starting the servers belongs to the caller;
`habiterall-personal`'s `npm run test:browser` is what does it for the ordinary
case. See the root `CLAUDE.md` for what a worker owning its instance implies.

`test/roundtrip-fixture.mjs` is shared by both editions' round-trip suites
(`npm run test:roundtrip -w habiterall-personal`, and the same in
`habiterall-cloud` with a Postgres). It defines the fixture *and* the
per-format fidelity rules, so the two editions cannot disagree about what a
faithful restore means. Add a case there when a new encoding trap appears —
that is how the CSV skip/value collision was caught.

`test/browser/` is not optional decoration: a CSS `display` rule silently
defeating the `hidden` attribute shipped once, and no unit test could have
seen it. `fixtures.mjs` resets known data before each suite.
