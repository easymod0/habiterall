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
| `src/security.js` | the CSP, the session cookie shape, `STATIC_CACHE`, the four rate limits, the `TRUST_PROXY` rule and `sameOriginOnly` — **data, not middleware**, so this package keeps its no-dependencies property |
| `src/password.js` | hashing, verification, and the one answer to "is auth on?". Personal's half of the shared sign-in flow; cloud uses none of it |
| `src/log.js` | structured logging: one event per line, one stream, and the redaction that keeps personal data out |
| `src/observe.js` | `logStartup`, `requestLog` and `watchRuntime` — an Express-shaped middleware that never imports Express |
| `src/shutdown.js` | the drain between the signal and the exit, and the deadline that bounds it — handed a server, importing no HTTP framework |
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

**The resolved verdict also rides on the `/overview` and `/stats` payload, as
`unlogged_is_success`, and that is not a sixth thing to keep in step.** Both
routes already hold the pair `unansweredCounts` needs — the habit and the
account's resolved `unlogged` — for the figures beside it, so the field costs
each route one more call to a function it already imports. It is deliberately
NOT a mirror of the kind the root `CLAUDE.md` warns a client only earns when it
must work offline: `shared/src` is not served to the browser, so no web
renderer could call `unansweredCounts` itself, and Android holds no second copy
of the precedence either — both clients hold the two INPUTS (the setting, the
override) but not the RULE, and now they are handed the answer instead of a
reason to restate it. It goes stale exactly the way `score` and
`currentStreak` on the same payload already do — an offline device draws the
account's last-known verdict until its next `/overview` — which costs no
offline correctness that payload did not already cost. It is response-only:
not in `parseHabit`, any `*_HABIT_FIELDS` list, `HabitInput`, or a migration.
`docs/decisions/day-states.md` has the long form, including the alternatives
that lost (a mirror in `ui/toggle.js` plus a Kotlin copy).

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
amount that fails, so a limit of two coffees records three. Four surfaces invert
(the grid's colours, the day editor's buttons, and the buttons on each reminder
— the Android notification's and the Discord one's, which are separate surfaces
and each offer Clean / Slipped in place of Yes / No or a number pad) and the
ACTIONS deliberately do not: `ACTION_YES` is still the good answer.

`shared/src/notify.js` reads `isAvoided` **by import** from `ui/toggle.js`
rather than by mirror, so unlike the web/Kotlin pair there is no third copy to
keep in step — see the comment above the import in `notify.js` for why that is
safe (node can read `shared/public`; the browser cannot see `shared/src`).

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

**A habit's `category_id` is a replace-rule field too, and its absent value is
a stated clear.** Because `PUT /habits/:id` REPLACES, a write that omits
`category_id` clears the habit's category exactly as an omitted `icon` clears
that field — there is no partial-update path that leaves a category alone by
not mentioning it. Every writer has to carry the current value forward on
every edit, including a phone edit: Android's contribution here is
carry-through only — it must never clear a category, and it gains neither a
picker nor a grouped list this PR. `parseHabit` only ever produces a positive
safe
integer or `null` from it; it does not check the id refers to a category that
exists — that lookup needs the caller's own rows, which is why it happens in
the route (`resolveCategoryId`) and not in the shared parser.

**Uncategorised is a state a habit is in, never a category it belongs to.**
`category_id IS NULL` is the whole representation: there is no row named
"Other" for it, no category a user can rename or delete on its behalf, and the
dashboard's grouped view always draws it as a trailing section rather than
omitting it — the same discipline the four day states get in the root
`CLAUDE.md`. Deleting a category does not delete its habits: `ON DELETE SET
NULL`, never `CASCADE`, moves them into that same uncategorised state with
every entry and note untouched.

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

**The `Date` cannot leave that loop, and what is left to save is the STRINGS.**
Stepping the calendar arithmetically instead — increment the day, roll over on
a days-in-month table — needs no `Date` at all and is faster again. It is wrong
the same way the epoch walk is: it knows the calendar but not which of its days
a zone actually LIVED. Under `Pacific/Apia`, which deleted 2011-12-30 outright,
it emits a day no entry can be keyed by and then ends the range a day SHORT of
`end`. `test/timezones.test.js` pins both that deletion and `Pacific/Kwajalein`
repeating a day, which is what makes this checkable rather than a story. So the
walk keeps `setDate` and spends its remaining effort on formatting: the
`'YYYY-MM-'` prefix is rebuilt on a rollover rather than per day, and the two
digit fields are a lookup rather than a `String()` plus a `padStart`. Measured
at **1.28x on `boundedRange`** and ~8% of a whole `/overview` per-habit cost.
That makes `dateRange` the one place in the file that spells a date without
calling `toISO`, so a test compares every element against `toISO` directly —
every other assertion in that suite is a literal and would pin the wrong half.

**Building the list is still the largest single line item, and the reason is no
longer how it is built.** One `computeStats` calls `boundedRange` **eight
times** on the identical window — once each in `computeScores`, `computeHistory`,
`computeWeekdays`, `computeWeekdayByMonth`, `computeFrequency` and
`computeCoverage`, and once per `onPaceSeries`, which `computeStreaks` and
`computeMissRuns` each build separately. `/habits/:id/stats` is the only route
left that calls `computeStats`, and pays for all eight; `coverage` still
defaults to **true** there. `/overview` no longer calls `computeStats` at
all — it calls `summaryStats`, which walks the window **twice**, instrumented
and counted rather than read off the two call sites it makes: once in
`computeScores` and once in `computeStreaks`'s `onPaceSeries`. Sharing one
walk, and one `onPaceSeries`, inside `computeStats` is worth more than any
further tuning of the loop; it is filed rather than done because it changes
signatures or adds a cache, and it stays filed regardless of what `/overview`
calls, because `/habits/:id/stats` still needs every one of the eight.

**One thing changed meaning with that rewrite, deliberately: the FIRST
element.** The old walk pushed the string it was handed before normalising
anything, so element 0 was the raw `start` and every later element was
`toISO`'d. The two differ exactly when `toISO(fromISO(start)) !== start`, which
is a date that is not a real day — `dateRange('2026-02-30', …)` opened on
2026-02-30 and then skipped 2026-03-02, the real day the rollover lands on.
A year before 1000 used to be a second case, because `toISO` dropped the
padding and the old list was internally inconsistent — `0100-02-25` followed
by `100-02-26`; both `toISO` and `dateRange`'s own prefix pad the year to four
digits now. Building the `Date` up front means every element is normalised, so
the list is a contiguous run of days that happened, spelled one way.

**A date is a real day spelled `YYYY-MM-DD`, and the padding is not
cosmetic.** The whole stats model compares dates as strings — `from <= date <=
end`, `start < earliest`, `boundedRange`'s clamp — which is correct and cheap
only while every date has four year digits, two month digits and two day
digits. `999-12-31` sorts ABOVE `2016-…`, so a day a thousand years in the past
reads as one in the future to every comparison in the file. `toISO` pads all
three fields, and `dateRange` — the one place in `stats.js` that spells a date
without calling `toISO` — pads the year on its cached `'YYYY-MM-'` prefix, not
per element, so the walk costs the same as it did. `test/stats.test.js` pins
both, in literals rather than against a second implementation, and in the days
themselves rather than in a LENGTH: `String(-1).padStart(4, '0')` is `'00-1'`,
so `'00-1-01-01'` is ten characters and not a date, and a guard a malformed
value satisfies is weaker than it reads. `toISO`'s domain is years 1-9999 and
its JSDoc says so.

**There is a third site and it is in the browser: `iso()` in
`public/ui/dates.js`.** It is the source of `todayISO()` and `addDaysISO()`,
and `ui/dashboard.js` compares its output against server dates lexically, so
the same rule holds there and it pads the year too (`test/dates.test.js`). No
client can reach a year before 1000 — `todayISO()` is the device clock — so
that one is unreachability being made into canonicality, which is what stops
the property depending on who calls it.

Only the first of those is reachable through the app: `boundedRange` clamps a
low-year start long before `dateRange` sees it, while a phantom date survives
the clamp. `assertDate` refuses one at every write path, so it takes a row
predating that guard, a direct insert or an import that went around it — and
it matters because `computeStats` takes `from` as the earliest STORED entry
when a caller names no window. An account holding such a row sees its derived
figures move once. That is the phantom day leaving them, not a regression.

**Every route that takes a date into a RANGE calls `assertDate`, and one route
deliberately does not.** `DATE_RE` is a shape and nothing more, so it admits
`2026-00-10` and `2026-02-30` — and a route that takes one of those into the
window arithmetic gets two answers to one question, because `fromISO` ROLLS the
bad component over while `totalCompleted` compares the raw string. `queryDate`
(`src/validate.js`) is the one guard for that: absence returns the caller's
fallback, everything else goes through `assertDate`, and a non-string — a
REPEATED query parameter is an array — is turned into `''` rather than
string-coerced. That last clause is a rule stated, not a bug patched, and the
JSDoc there says which: under Express 5's default `simple` parser a repeated
`end` is always a two-or-more-element array, so it carries a comma and
`DATE_RE` refuses it either way. It is the `extended` parser, which can produce
a ONE-element array, where the coercion yields a valid-looking date and
`assertDate` then calls `.split` on an array — a 500. Neither edition sets that
parser; the guard is what makes it not matter if one ever does.
Three routes and five parameters, in each of the two editions: `end` and
`start` on `GET /habits/:id/stats` and on `GET /categories/stats`, and `end` on
`GET /overview`. The exception is
`DELETE /habits/:id/entries/:date`, which stays on `DATE_RE` — its date keys a
single row and reaches no range, no comparison and no computed figure, and rows
filed under a day that does not exist are exactly what the paragraph above says
are out there, so `assertDate` on that path would make one permanently
undeletable through the API. `habiterall-personal/test/querydate.integration.mjs`
and the matching block in `habiterall-cloud/test/api.integration.mjs` pin it,
at the routes, because nothing here can say which validator a route reached
for. What those two do NOT pin is the `typeof` clause: a repeated `end` is a
400 without it, on the comma, and both suites say so where they used to credit
the guard. The clause is pinned in `shared/test/validate.test.js` instead,
since no route as configured can be pointed at the one-element array it exists
for.

`computeStats` therefore normalises `from`, and that half is not optional:
`totalCompleted` selects by STRING comparison against `from` while every other
figure is read off the walked list, so an un-normalised `from` counts the
phantom row in one figure and in none of the others — exactly the disagreement
the note above `totalCompleted` says was fixed.

**It normalises AFTER the two clamps, never before, and the ordering is the
whole safety of it.** Normalising is a ROLLOVER of a string that came out of
storage, and a rollover moves the date by an amount nothing in `resolveWindow`
bounds: `9999-99-99` lands in year 10007, five digits, which sorts BELOW
`2026-…` however the year is padded. Normalised first it clamps to `earliest`,
so one junk row opens the widest window `MAX_RANGE_DAYS` allows on every
request for a habit that has none of those days; clamped first it is `end`. The
same ordering, for the same reason, in `computeCategoryStats`' `memberWarm`,
where that five-digit year would otherwise compare as OLDER than `warmStart`
and score a member over a warm-up it never had.

**It is NECESSARY AND NOT SUFFICIENT, which is #270.** The clamp is a string
comparison and the reformat is a rollover worth up to ~8 years, so a date
inside the window *lexically* can land outside it afterwards with neither clamp
having run since. `2026-07-99` sorts below an `end` of `2026-08-18`, normalises
to `2026-10-07`, and `boundedRange` answers `[]` — every figure zero for a
habit with a live nine-day streak. `memberWarm` has the same hole above
`warmStart`. Both are older than the year padding (measured byte-identical on
master) and neither is something the ordering ever closed; the fix is to
re-apply the clamps AFTER the reformat, and it is filed rather than done
because it changes what an affected account's figures say. Do not read the
paragraph above as saying the window is safe — it says only which of the two
orderings is less wrong.

The year padding closed the same trap one step earlier, and it was LATENT
rather than live — say it that way round, because the difference is the whole
of what a reader can check. `toISO` used to pad the month and the day and not
the year, so normalising `0999-12-31` yielded `999-12-31` — ABOVE `2016-…`,
and above the `earliest` clamp `MAX_RANGE_DAYS` is enforced by. What stopped
that being a wrong figure is the ordering above: `from` has already been
clamped to `earliest` by the time anything reformats it, and
`toISO(fromISO('2016-08-10'))` is a no-op under both spellings. Measured, by
reverting the padding on the fixed tree: the year-0999 test in
`test/stats.test.js` still passes and only the canonical-spelling literals
fail. So no account's figures moved, and the padding is worth having for what
it stops being true — invert that ordering, or normalise an unclamped stored
date anywhere else (`assertDate` accepts `0999-12-31`, 999 being a real year
that does not roll over where `0050` does), and an unpadded year is a payload
collapsed to a single day with nothing findable behind it.

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
~10-11% of a call, measured — and the parameter exists for a caller that wants
`computeStats`'s whole detail-view reading without its dearest optional pass.
`/overview` is no longer that caller: both editions call `summaryStats` there
now, an entry point that never had a `coverage` field to decline in the first
place. Declined, the key is **absent** rather than empty: an empty array
claims no month is fully answered, where this is the absence of a claim. Every
other field here is either a pass the summary figures already need or a cheap
read of one.

**Two entry points share one window, and a parity test is the only thing
keeping them from drifting.** `summaryStats` exists because `/overview` was
paying for `computeStats`'s five discarded passes — `computeHistory`,
`computeWeekdays`, `computeWeekdayByMonth`, `computeFrequency`,
`computeResilience` — once per habit, per load, to keep two numbers. Both
functions call the same `resolveWindow` and compute `scores`/`streaks` the
same way; `test/stats.test.js`'s parity test asserts `summaryStats` always
deep-equals the same two fields picked out of `computeStats` over identical
arguments, so a change to one pass cannot silently disagree with the other.
Measured on this machine (`npm run bench:overview`): `computeStats(coverage:
false)` is 1.58 ms/habit and `summaryStats` is 0.29 ms/habit — an 82% cut per
habit. Per request that is 31.6 ms down to 5.8 ms at 20 habits, and 79.0 ms
down to 14.5 ms at 50.

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

**A CATEGORY has no score of its own, and `computeCategoryStats` aggregates
HABITS rather than entries.** The decay above carries a `sqrt(frequency)` term,
and that term is the whole reason a 3×/week habit's number is comparable with a
daily one's — a category has as many frequencies as it has members, plus a mix
of boolean/numerical and at_least/at_most, so there is no single frequency
`onPaceSeries` could be handed for one. What is reported is the mean of the
members' own strengths, **equal weight per habit**: never per entry, which lets
a daily member drown a weekly one, and never re-derived from raw entries, which
would be a second answer to a question `computeStats` already answers. The mean
never travels alone either — `members` is the n and `best`/`worst` are the
spread, on the same payload, because a mean over an unstated number of habits
is a figure its reader cannot check.

**Each member is scored over `[start - SCORE_WARMUP_DAYS, end]` — clamped
forward to that member's own first entry — and sliced back to `[start, end]`.**
`computeScores` starts its EWMA at 0 on the first day of the range it is handed,
and `ui/detail.js` sends **no `start`** to `/habits/:id/stats` — so a habit's own
page is always converged from its first entry, while a comparison starting cold
at `start` reports that same habit weaker. Two surfaces disagreeing about one
habit is indistinguishable from one of them being broken. `SCORE_WARMUP_DAYS` is
400, the number both editions' `/overview` already spends on the same problem,
and it is exported from `stats.js` and imported by both routes rather than
spelled once per edition. What makes it easy to lose again: a year of window
swamps the warm-up, so dropping it moves nothing on the DEFAULT request and only
an explicitly short `start` can falsify it — measured in
`docs/decisions/categories.md`, and the reason the suite's window is 20 days
rather than the route's own year.

**The CLAMP is the other half and is not a detail**, because a habit's own page
opens at `start ?? firstEntry` and a warm-up reaching further back is scoring a
member over a window it never had. On an at-least member those phantom days
credit 0 and the two surfaces agree anyway, which is what made this survive a
suite of them; under `at_most_unlogged: 'success'` — every `show_as: 'avoid'`
habit when the account says so — an unlogged day is FULL credit, so 400 days
before the habit existed converged a limit to **0.97** against an own page of
**0.41**, for the first ~430 days of its life. The clamped date is normalised
**after** the clamp for the reason `resolveWindow` gives at length, and
`landedAt` reads that same normalised date rather than the raw `firstEntry`:
`computeScores` normalises the start it is handed while the landing rule
compares strings, so a member dated `2026-02-30` was admitted on `2026-03-01`
with no score point behind it and put one NaN bucket through the series.

**A member that has never been logged has no strength, which is not a strength
of zero** — the same claim `recovery.rate === null` already makes, and the same
refusal to average it into a number. It is counted in `members` and in
`unloggedExcluded` and left out of `mean`, `best`, `worst` and every bucket of
`series` until its first entry lands, so adding a habit to a category raises two
counts and moves no figure downward; a bare mean would report that your health
got worse on the day you decided to do more about it. That landing rule is asked
once and used by all four, which is what makes `series.at(-1).value === mean`
hold unconditionally — the same members, the same day, the same arithmetic —
because a chart whose last point disagrees with the number printed over it reads
as a bug whichever of the two is right. "Never logged" is not "nothing in the
entry slice": a route fetches a bounded window, so the LIFETIME first-entry date
is supplied per member, and an abandoned habit keeps its genuine near-zero
strength in the mean instead of being excused from it.

**`MAX_COMPARE_DAYS` is 1830 and is deliberately not `MAX_RANGE_DAYS`.** That
ceiling bounds a route walking ONE habit; a comparison walks every habit the
account has, so the same span costs the habit count times as much — at 50
habits, `MAX_RANGE_DAYS` is ~385,000 synchronous day-steps before the warm-up is
added, the order of the year-0100 entry the root `CLAUDE.md` records blocking
the event loop for 32 seconds. `COMPARE_WINDOW_DAYS` is what an absent `start`
opens, 365 and never the ceiling, because the ORDINARY request must not be the
worst case the route can be asked for — the shape `/overview` already has, where
`days` defaults to 30 against a cap of 365. Both live here beside
`SCORE_WARMUP_DAYS` and are imported by both editions: a ceiling that drifted
would have one edition refuse a URL the other served, and a default that drifted
would have them answer one `start`-less URL with different bucket counts.

## Awards

**An award is a READING of the stats response, computed on the SERVER because the
ladder it reads is.** `SURVIVAL_THRESHOLDS` and `MISS_BUCKETS` live in `stats.js`
and `shared/src` is not served to the browser, so computing awards in the browser
meant a second copy of the streak ladder — a badge at 20 days beside a survival
bar at 21. `awards.js` is pure and both editions' `/habits/:id/stats` call it.

**It is called at the `/stats` route, in both editions, and not inside
`computeStats`**, which is the one place it looks like it belongs:
`computeStats` has exactly one caller now, and it is this one — `/overview`
no longer calls `computeStats` at all, it calls `summaryStats` for two
numbers, and its payload carries no `awards` field to decline.

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

**`writeLoopDatabase` writes the whole export as one transaction**, because
without it every `insertRep.run()` was its own implicit one under SQLite's
default rollback-journal mode — a journal file created, written, fsynced and
deleted once PER ROW. Measured against the reporter's own account (9 habits,
2,308 entries): 5,386ms autocommit versus 22ms in one transaction, in a
container and out, at ~400-430 rows/sec either way against ~500k in one
transaction — and the function is synchronous, so those milliseconds are the
event loop, blocked, for anybody the instance is serving. `BEGIN` is placed
AFTER the `CREATE TABLE`s and the `Metadata` insert, not around them, so the
schema stays committed to the file independently of the rows: a second
connection opened on the path mid-write can still see `Habits` and
`Repetitions` exist, which is what `test/export-loop.test.js` depends on to
observe the transaction from outside at all. There is no explicit rollback and
no `try`/`catch` around it — `DatabaseSync.close()` with a transaction still
open rolls back cleanly rather than throwing, so the existing `finally {
db.close(); }` already discards a partial write exactly as it did before this
existed.

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

**A reminder links to the habit it is about, and `appLink` is the one place
that decides.** Both server-sent channels aimed at the site root — the
dashboard, with the habit still to find, from the one surface that knows
exactly which habit it means. `appLink` (`notify.js`) is `usableAppUrl` plus
the fragment, asked by `ntfyPayload`'s `click` and `discordPayload`'s
`embed.url`.

It is a **mirror of `parseRoute`, not an import of it**, and that is the one
interesting thing about it. `notify.js` may import `ui/toggle.js` because
`toggle.js` is DOM-free by construction; `ui/routes.js` is not — `go`,
`current` and `init` read `location` and `history` and register on `window`.
None of them is called from the server, but a typecheck is not a call graph:
the import pulls the whole file into a project with no DOM lib and
`npm run typecheck` fails with thirteen unresolved globals. So it is the usual
answer instead — two declarations pinned by a test — and the test is
behavioural, building a link and feeding its fragment to the real `parseRoute`
across a range of ids.

**The bound is `Number.isSafeInteger(id) && id > 0`, and dropping either half
ships a dead link.** `sendTest` builds its stand-in habit with `id: 0` in both
editions, so the fallback to the root is on the path anybody presses. Note what
the test asserts for a refused id: that the fragment is **absent**, not that it
routes to the list — `#/habit/1.5` routes to the list too, so a route-only
check passes a notification whose link names a habit the app has none of.

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

**The button now comes to US, and that reverses an earlier decision.** ntfy's
action buttons used to be refused because the obvious design routes them
through the SUBSCRIBER's device — an HTTP request made from wherever that phone
is, to whatever URL the message carried, authorised by nothing. That danger was
real and is still why there is no ordinary inbound endpoint here otherwise. The
button that ships instead is an `http` action pointed at habiterall's own
`POST /notify/ntfy/answer`, carrying an HMAC over `(account, habit, date,
action, value)` signed with the instance secret (`shared/src/ntfy-answer.js`) —
so the code, not the topic, is what authorises the write, and it is bounded to
answering the one question the reminder already asked, for a habit and date
already visible in the same message. `interactive` is a predicate on `appUrl`:
an instance with no public address gets no buttons, because the code has
nowhere to be posted back to. The topic still gates who can *see* the
reminder — ntfy.sh has no per-topic ACL, so on it the HMAC alone carries the
whole burden of gating who can *answer*. `docs/decisions/ntfy-answers.md` has
the long form.

**The two server-sent channels are not alike about rate limits, and delivery
now fans out across accounts.** Discord limits per webhook, so a 429 is one
account's own doing and the inline `Retry-After` sleep is paid by whoever
caused it — Discord sends from different accounts run at once with nothing
guarding between them. ntfy.sh limits per **visitor IP**, which for a
server-sent reminder is the instance — one bucket for every tenant on it — so
letting the fan-out send ntfy in parallel would make that shared bucket worse,
not just unprotected. `gatedByHost` (`shared/src/notify-send.js`) is the fix: a
module-level map from host to its tail promise, and an ntfy send (its
`Retry-After` retry included) queues behind whatever else is already sending to
that same host before it starts, so at most one is ever in flight per host.
Keyed on the host rather than one instance-wide gate, because two accounts on
different self-hosted ntfy servers share no bucket and queuing one behind the
other would slow a healthy destination to punish a busy one it has nothing to
do with.

## Traps

**An id that COERCES is not an id.** `Number()` answers 0 for `null`, `''` and
`[]`, 1 for `true`, and 7 for `[7]`, so `Number.isInteger(Number(n))` accepts
all of them — which is how `POST /categories/reorder` came to move a category
nobody had named in one edition and answer 200 having moved nothing in the
other. `parseCategoryId` gates on `typeof` FIRST, which makes those spellings
unrepresentable rather than filtered one at a time, and both editions ask it
so a malformed reorder cannot be a 400 in one and a 200 in the other. Note it
is deliberately not the rule `parseHabit` applies to `body.category_id`: there
the id arrives in a JSON body, where a number is the only honest spelling.

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

**`server.close()` is not a drain.** On Node 26 it does sweep the connections
that are idle at the instant it is called, which is what makes the obvious fix
look like it works; it says nothing about a connection that was IN FLIGHT when
the signal landed and goes idle a moment later. Nothing closes that one — it sits
until `keepAliveTimeout`, and a pooling reverse proxy never leaves it idle long
enough to expire at all, so the process runs until Docker's SIGKILL takes it with
its in-flight requests. Measured on the real personal server: 5ms when the socket
was already idle, **6158ms** when it went idle after the signal, and **20188ms
having served 70 further requests** when the peer kept using the pool.
`docs/decisions/connectivity.md` has the numbers and the mutations behind them.

The mechanism is therefore the sweep hooked to **every response's `close` while
draining**, and it is attached at INSTALL time rather than by the signal handler.
A request already in flight had its `request` event long ago, so a hook installed
by the handler could never see it — and that is the only case that hangs.

**The sweep is a trade, and every measurement flatters it, so say the other half
out loud.** Shutting a pooled socket the moment it goes idle DROPS a request the
peer had already written onto it — those 70 requests master served are requests
this branch does not — and a proxy will not retry that one, because bytes were
already on the wire when the connection went. Caddy pools upstream connections
and `examples/Caddyfile` is a bare `reverse_proxy` with no retry configured, so
it surfaces as a 502. The trade is still right (one bounded loss against an
unbounded wait that ends in a SIGKILL losing in-flight work anyway) and it is
still not free, which is why check 2 of the personal drain suite bounds "further
requests served" at `<= 1` rather than `=== 0`. It is also the argument for #208:
a readiness signal is the only thing that stops the proxy handing us the request
we are about to drop.

Two more consequences worth knowing before touching `installShutdown`: the
deadline is a
constant (8s) and not an environment variable, because it has to hold for an
operator who never sets `stop_grace_period` and so gets Docker's default 10s; and
the deadline path deliberately runs **no** `cleanup`, since something is already
stuck and a `closePool()` that hangs too would lose the exit the deadline just
bought. A cleanup that REJECTS **or throws synchronously** — cloud's
`closePool()` is the first, personal's `db.close()` the second, and
`.then(() => cleanup())` rather than `Promise.resolve(cleanup())` is the one line
that covers both — is the third exit: `shutdown.cleanup_failed` and
`exit(1)`, caught rather than left to become an unhandled rejection — because
there the drain SUCCEEDED and only the storage teardown failed, and an unhandled
rejection would have reported that as a crash: no line, a raw stack, and nothing
to tell it from the SIGKILL this whole module exists to get ahead of.

**There is a second hole and it is earlier: the signal that arrives before
anything is listening.** Node is PID 1 in both images (exec-form `CMD`, no init),
and for PID 1 a signal with DEFAULT disposition is *discarded* rather than
fatal — so between process start and `installShutdown` a `docker stop` did
nothing whatever and the operator waited the full grace for the SIGKILL, which is
the failure above arriving by a second route and before the server it drains
exists. Both editions have the window and **neither is unbounded** — cloud's is
merely the long one. `await initAuth()` there is OIDC discovery, and
openid-client 6.8.5's `performDiscovery` is `const timeout = options?.timeout ??
30`, which neither call site in `habiterall-cloud/src/auth.js` overrides, so an
IdP that accepts the connection and never answers aborts the boot with a
`TimeoutError` at ~30s. That is what makes the arm necessary rather than what
would: 30s is **three times** the `stop_grace_period: 10s` all three shipped
compose files set, so a `docker stop` landing anywhere in that window waits out
the whole grace and is SIGKILLed regardless of the bound. Check the bound again
after an openid-client bump. Personal's window is `await initAuth()` too, where
`verifyPassword` runs scrypt with the cost parameters read out of the STORED
hash — measured with a p=128 credential, `shutdown.armed` at 91-101 ms against a
`startup` at 3292-3382 ms, and signalled inside that it left in 30-34 ms;
cloud's in 12-19 ms. Spreads rather than single figures, over the runs this
took: one number here is pinned to whichever run got written down.

**What the arm covers is the entry module's BODY onward, and on personal that
leaves the larger window outside it.** ES modules evaluate every import fully
before the importing module's body runs, so the express/helmet/session import
cost (~100–300 ms, fixed) is ahead of any arm placed in a module body — and so,
on personal, is `habiterall-personal/src/db.js`, which at module scope opens the
handle, runs the whole schema and runs the one-time `entries.status` migration:
`ALTER TABLE entries ADD COLUMN status …` then an `UPDATE entries SET status =
'skip' … WHERE value = 3 AND habit_id IN (…)`. That `UPDATE` is
data-proportional and unbounded by anything this code controls, and it runs on
the FIRST start after an upgrade from a pre-`status` build — the boot an operator
is most likely to interrupt. What the arm does cover on personal is
`await initAuth()`, which is one or two p=1 scrypts at 28 ms each on an instance
with an environment credential and NO scrypt at all on one whose credential is
in the database — `initAuth` hashes only inside `if (env)`, and the shipped
compose file leaves all three credential variables empty. The suite has to seed
a p=128 credential to make the window measurable at all, and that is the tell.
So personal's covered window is small in production and cloud's
is the one that matters. It is not closed here because closing it is a different
change: a wrapper entry point that arms and then dynamically `import()`s the
server touches a new entry file, both Dockerfiles' `CMD`, both `start` scripts and
both drain suites' `serverPath`. Do not add one without deciding that separately.

`armShutdown` is what closes it: a bare handler taken at the top of each entry
point's module body ahead of every `await` — in cloud ahead of the `config_missing`
env check too, so a process that exits on a missing `SESSION_SECRET` or
`PUBLIC_URL` is still one that could have been stopped, and in personal gated on
`isEntryPoint`, because importing the module for its routes must not install
process signal handlers. **`DATABASE_URL` is not one of those two**, however that
loop reads: `db/pool.js` calls `assertConnectionString(process.env.DATABASE_URL,
…)` at MODULE scope and `server.js` imports it, and every import is evaluated
before the importing module's body — so a missing or malformed `DATABASE_URL`
kills the process on an uncaught throw at import time, before the arm and before
the loop, whose `DATABASE_URL` branch is unreachable for the missing case. No arm
in a module body could have covered it, and it exits in microseconds, so there is
no window there worth having. It cannot drain
anything, nothing having been accepted, so it closes whatever HAS been opened and
exits **0**: nothing was dropped, and 1 stays reserved for the two failures
above. It runs no `beforeClose`, because at arm time neither the notifier nor the
runtime watcher exists. `installShutdown` then ADOPTS it and registers nothing of
its own — a `process.off` + `process.on` pair has a gap between the two calls and
this has none, and a second registration beside the arm is not a harmless
redundancy but this fix's own defect re-created: one press runs both sequences,
the early exit wins at ~5 ms, and the in-flight request goes with it. The two
boot-window checks cannot see that (inside the window a doubled handler is
indistinguishable from a single one) and the drain checks can, which is why the
unit suite asserts `installShutdown` given an arm calls `onSignal` never.
`shutdown.armed` is one info line per start, and it is also the predicate both
drain suites wait on — what lets them signal INSIDE the window rather than after
a sleep.

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
