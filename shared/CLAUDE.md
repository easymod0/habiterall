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

### How the frontend fits together

**Mutators announce; views listen.** Nothing calls another view's render
function. `ui/store.js` carries the state and exactly two events: `'change'`
means "the visible view's data moved, update it", and `'reload'` means "go to
the dashboard and fetch it". Each view decides whether it is the one showing —
the dashboard repaints from `state`, the detail view refetches, because none of
what it shows can be recomputed locally.

That is not decoration. The day editor has to refresh the detail view, the
settings dialog has to refresh both, and the detail view has to open the day
editor. Written as direct calls those are circular imports; written as one
2,100-line file — which is what this was — they are eleven scattered
`renderDashboard()` calls and no way to split it.

**A module owns its subtree, and `test/ui-modules.test.js` enforces it.** No
element id may be reached for by two modules; `ui/views.js` exists because
`#view-list` and `#view-detail` genuinely have three claimants. The same test
walks the imports from the entry point and fails when `SHELL` in `sw.js` has
fallen behind — with twenty-three modules where there was one, a hand-maintained
precache list drifts silently.

## Traps

**`dateRange` vs `boundedRange`.** Use `boundedRange` whenever the start date
comes from stored data. `dateRange` is unbounded and a distant-past entry
turns one request into ~700,000 iterations on a single-threaded server. Every
aggregation in `stats.js` already uses the bounded form; keep it that way.

**An amount is parsed, not typed into `<input type="number">`.** That input
does not report what it cannot read — it filters the keystrokes it dislikes and
hands back whatever survived. Measured in Chrome against the day editor's own
attributes: typing `8,5` left `85` in the box, so eight and a half was recorded
as eighty-five; typing `abc` left `''`, which the day editor read as "no entry"
and answered with a DELETE. The decimal comma is the one that matters, because
`inputmode="decimal"` is what shows it and most of Europe's keyboards offer it —
`HabitFormScreen.parseAmount` on the phone has a comment about the same input.

So the box is `type="text"` and `ui/amount.js` owns the reading, with the same
three-answer convention `parseTimeInput` uses and the same trap in it: `''`
(empty — a delete), `null` (unreadable — say so, write nothing) and a number, of
which `0` is a real answer. Two of the three are falsy, so callers compare with
`===`. `parseAmount` is also stricter than `Number()`, which the root CLAUDE.md
already records as too generous about form — `1e3` is not a thing anyone types
into a box asking how many glasses of water they drank.

The step comes from the goal rather than being 1: an eighth of the target,
snapped to a round number, because 1 is right for "8 glasses" and useless for
"10,000 steps". `test/browser/countcheck.mjs` follows a tap all the way to
storage, which is the only thing that can catch the control and the database
disagreeing about what was typed.

**A localised name is never indexed by a Gregorian field.** `getMonth()`,
`getDate()` and `getFullYear()` are fields of the *Gregorian* calendar, so
`MONTHS[d.getMonth()]` or `String(d.getDate())` silently assumes the locale's
calendar is Gregorian — and for fa-IR, th-TH and ar-SA it is not. It has now
been found five times in the same shape and each one looked local: a
`monthLabels()` table, a year printed as `String(yy)`, a year caption keyed on
the January column, a day number in the dashboard's grid header, and a month
caption keyed on `getDate() === 1`. The last two shipped on the branch that
fixed the first three. Hand the DATE to `Intl` — `formatMonthShort`,
`formatYear`, `formatDayNumber` — and read a CHANGE of month or year from the
formatted string, because a Persian year turns at Farvardin and a Persian month
does not start on the Gregorian first.

The tell is a header that disagrees with itself: `۱۹ تا ۲۵ مرداد ۱۴۰۵` over
columns numbered `10 11 12`, one localised half and one not, in one row.

**`WIDTH_SAFETY` reserves; it never decides to degrade.** `estimateTextWidth`
answers "about how wide is this", and the 1.25 margin exists so a RESERVATION is
never short — a gutter that is short clips a word. Applied instead to a decision
about whether to *drop* a caption, *shrink* the type or *shorten* a label, it
makes the chart pessimistic about itself and throws away a label that would have
fitted: measured, `weekdayChart` gave up `segunda` for a `S T Q Q S S D` axis at
438px when the real crossover is ~360, and `weekdayMonthChart` dropped half its
month captions in 11 of 14 non-English locales with room to spare. Over-
reserving costs pixels; over-degrading costs the label. Both call sites now name
which they are doing.

**A caption that is thinned away must not be the newest one.** The drop is a
left-to-right walk, and at the right-hand edge the collision is always with the
month a reader is actually looking at — en-US drew `Jan Mar May Jul Sep Nov` and
no December, under a comment saying the first and last are what orient a reader.
The last column is reserved first and the rest fill in to its left. The year
caption follows the month it sits under, for the same reason: with no month name
above it there is nothing for a year to disambiguate.

**The date rules are invisible in en-US, so `npm run test:locales` runs them
somewhere else.** Every defect above passes the whole unit suite in the locale
CI runs in — a `getMonth()`-indexed table is 12 for 12 in English. The sweep is
`LC_ALL` and a subprocess, so there is no test-only hook in the module under
test, and it runs `dates.test.js`, `calendar.test.js`, `window.test.js` and
`weekcheck.mjs` in ten locales chosen for a PROPERTY each (a non-Gregorian
calendar, non-ASCII digits, a different era, long weekday names) rather than for
coverage. It asserts the locale actually took, because ICU falls back silently
for a name it does not know and ten runs of en-US report ten passes.
`weekcheck` is in there because a LAYOUT is locale-shaped too: the row gutter's
ceiling binds in ten locales at 328px and in none in English, so running it only
in the runner's locale pinned the one case where the bound never applies.

**A chart's labels and its data have to be asserted TOGETHER.** `weekcheck.mjs`
exists because a review broke the week-start plumbing four ways at once — bars
read positionally while captions rotated, the calendar's row labels left
unrotated, Home/End back on `getDay()`, the month grid reading rows by index —
and the whole unit suite and every browser suite still passed. The arithmetic
was covered; nothing looked at a rendered chart. The failure that matters is not
"the wrong day is first", it is a caption and a datum moving independently,
which reads as deliberate.

Note where each half is pinned, because the split is forced rather than chosen.
`weekcheck.mjs` is OFFLINE and covers the labels and the pairing. **Home/End is
in `feat4.mjs`, in a real browser**, because the handler is reached through a
`keydown` listener that only exists when the calendar is interactive and it
reads `dataset`, which the offline fake DOM does not have — a first version of
`weekcheck` claimed to cover it and did not, and the `getDay()` mutation passed
every suite in the repo. The month chart needs BOTH its tooltip and its drawn
caption asserted: they are built from different arrays, so checking one leaves
the other free to move.

**`isCompleted` / `dayCredit` take `{value, status}`.** Passing a bare number
still works for boolean habits (where `3` is unambiguously a skip) but is
wrong for numerical ones, where `3` is a real amount.

**A missing day and a day holding 0 are different states, and only the display
knows.** `unknown` is the absence of a row, `no` is a row with value 0, and
`isCompleted` answers `false` for both — deliberately, so `questionMarks` costs
nothing in the arithmetic. One thing it does cost, because a range that starts at
the earliest stored entry now has an earlier one to start at: a lapse extends the
window, and the unknown days after it read as misses, which is how a habit with
one marked miss acquires a lapse in `computeRecovery` where it had none. The
figures are right; the window is older. See the root CLAUDE.md for the whole of
it. `stats.js` was the exception and did not know it: six of its passes wrote
`entryMap.get(date) ?? UNSET`, which is harmless for an at-least habit and hands
an at-most one a full success for a day nobody answered — a limit with no
entries at all reported a 30-day streak. It reads the map directly now, and
`normalizeEntry` answers `status: 'unknown'` for the absent day; what silence is
worth there is the account's `atMostUnlogged` (default `miss`) unless the
habit's own `at_most_unlogged` overrides it, which `unansweredCounts` resolves
in the one place every caller already passes a habit through. A row holding 0 is
untouched by that and stays a success, which is the whole distinction finally
being worth a number rather than only a question mark.

What must never happen is a *reader* collapsing them:
`habit.entries[date] ?? UNSET` reports every unanswered day as an answered "no",
which starts the tap cycle in the wrong place and paints away the one difference
the setting draws. Ask whether the map HOLDS the date (`Object.hasOwn`, or a null
check in Kotlin), never what it holds. `ui/toggle.js`'s `dayStateOf` exists so
that decision is written once.

**The score constant is Loop's, read from its source.** It is
`0.5^(sqrt(frequency)/13)` — a 13-day half-life for a daily habit, and slower
for less frequent ones. A fixed 30-day half-life lived here for a while: the
same shape, but so sluggish that a perfect habit took four months to look
strong instead of one. `test/stats.test.js` pins the curve at days 13, 30 and
60 so it cannot drift back.

**Best streaks are selected by length but listed by date.** Two different
questions: which runs to show, and how to order them. A list ordered by length
reads as a leaderboard and hides whether the good runs were recent. Note the
bar scale must come from `Math.max(...top)`, not `top[0]` — that stopped being
the longest row the moment the ordering changed.

**Charts with a time axis page rather than shrink.** `slot = width / count`
silently squeezes bars to hairlines once a habit has a year of daily data.
`ui/window.js` decides how many columns fit from a minimum per-column width,
and `windowedChart` in `ui/components.js` adds the ‹ Earlier / Later ›
controls. Paging
strides by one less than the window so a column of context is shared between
screens — `test/window.test.js` asserts no column is ever strandable.

**Connectivity needs more than the `online` event.** That event tracks the
network interface, not the server, so a restarted server left the app stuck
offline until a manual reload. `watchConnectivity` also re-probes on
`visibilitychange` and polls with a backoff *while offline only* — it makes no
requests at all once the server answers. It reports transitions, not polls, or
reconnecting would re-render the dashboard every few seconds.

Which leaves it blind to the outage it is most likely to meet, so the watcher
takes an input as well: `reportOffline`, called by `ui/api.js` when a write has
to be queued. A failed request of our own is better evidence than a probe — it
is the actual traffic — and it must come in through there rather than as a
`setOffline` from outside, or the watcher's `last` stays `true` and it neither
polls nor reports the transition. See the root CLAUDE.md.

And once it HAS said so, `api()` stops asking: a write finds `state.offline`
already true and goes to the outbox without opening a socket. Tap one is what
discovers an outage and there is no cheaper way to learn it — probing `/healthz`
per write is what that endpoint's four callers make expensive — so the first tap
pays the 10s bound and every tap after it costs ~100ms. Note this branch was
unreachable before the watcher grew that input: nothing set the state on the
write path, so "when the app already believes it is offline" described no state
the app could be in, and the obvious-looking fix would have done nothing.

And the write is staged BEFORE the attempt, not after it. `enqueue` returns its
`seq`, `api()` holds it for the length of the fetch and `unstage`s it the moment
any answer arrives. That closes the window the bound only shortened: the queue
used to hold writes that had already failed, so between the tap and the fetch
settling a check-off existed solely in a promise and closing the tab lost it
from the outbox and the server alike.

It is removed on ANY response, not just a good one. Leaving it staged on a 5xx
would turn every failed write into a silent retry, which is a bigger change than
this and not obviously wanted — the caller is told and the caller decides. What
the staging covers is precisely the in-flight window, which is precisely what
was lossy.

Staging is limited to calls safe to arrive twice, because a concurrent `flush()`
can send a staged write while the live attempt is still out: two identical
upserts keyed on habit and date, and the second changes nothing.

The predicate is `replayable()`, and it names one question — is this write safe
to arrive twice? — because three rules turn on it: what may be staged, what may
be pre-empted, and what may be queued on failure. All three end in a replay from
the outbox, so all three need the same answer, and having them read one function
is what stops the next change moving one and missing the others.

`POST /habits` is the only write that answers no. It is **bounded but never
queued**, which is not the obvious pairing and is the point: it used to be left
unbounded on the reasoning that aborting a create the server had begun and then
replaying it is two habits. The first half is true and is why it is not
replayable — but not bounding it did not avoid the duplicate, it only made the
dialog spin until the OS gave up while the create may or may not have landed.
Abandoned, not replayed, and reported as *indeterminate* is the honest shape; the
dialog closes and reloads the list on that error, so "check whether it was
created" is something the user can see rather than a thing they are told to do.

A GET still goes to the network, because
the service worker may hold a cached copy and skipping the request throws that
away — stale beats blank. And `POST /habits` is excluded **by the same
`bounded()` predicate as the timeout**, not by a second opinion about the same
call: pre-empting it would in fact be safe, since nothing is sent and nothing
can arrive twice, but two rules disagreeing about which call is special is how
the next person changes one and not the other.

**The score formula is deliberate.** It feeds a trailing-window adherence
ratio (always `[0,1]`) into an EWMA. Do not "simplify" it back to scaling a
day's credit by `1/frequency` — that overshoots for every non-daily habit and
lets one completion saturate the score.

**Loop's encoding is not guessable.** It was read from the uhabits source:
epoch-millis UTC-midnight timestamps, ×1000 numerical scaling, `YES_AUTO(1)`
counts as done, `NO(0)` is a stated lapse that **keeps its row**, and only
`UNKNOWN(-1)` has none. Those last two used to be one thing — both dropped — and
dropping `NO` discarded the only mark separating a day the user answered from a
day nobody has, which on a backup from someone who does not use Loop's question
marks is most of their history. See the root CLAUDE.md's four-state section.
`test/import.test.js` and `test/export-loop.test.js` pin all of it — if you
change a conversion and those fail, the tests are right.

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

**The calendar is anchored on its END, not its start.** Going back
`weeks*7` days and *then* snapping back to the week's first day shifts the whole
grid earlier,
so the last column stops short of today by however many days into the week it
is — today's square was invisible on six days out of seven. `calendarWindow`
owns this and `test/calendar.test.js` pins it.

**Charts size themselves from the card, and must not overshoot it.**
`svg.chart { max-width: 100% }` silently *scales* an oversized chart down, so
one pixel too wide makes 13px cells render at 12.6px. `calendarWidth` drops
the final column's trailing gap for exactly this reason, and `cardInnerWidth`
measures a real `.card` rather than hardcoding padding that can drift from the
stylesheet. Inside a `.chart-scroll` the cap is lifted so narrow screens
scroll instead of shrinking.

**A chart names a theme colour; it never resolves one.** Every fill and stroke
that comes from the palette is emitted as `var(--grid-empty)` and friends, and
a partial strength as `color-mix(in srgb, <habit colour> N%, var(--grid-empty))`
— never a value read with `getComputedStyle` at draw time. An SVG attribute
does not follow the theme, so a resolved colour freezes the palette the chart
was drawn under, and the only thing that can correct it is a re-render. In the
detail view a re-render is a *refetch*: switching to dark left every unrecorded
calendar square holding the light `#e6e9ef` — near-white against the dark card
— for two requests, and permanently if either failed. That is also why
`toggleTheme` no longer takes a redraw callback, and why the fake DOM in
`test/browser/atmost.mjs` and `rendercheck.mjs` no longer stubs
`getComputedStyle`: reach for it again and those suites crash rather than
quietly pass. `themecheck.mjs` blocks every request the detail view could make
*before* switching the theme, so it can only pass if the colours followed with
no redraw at all.

**`charts.js` must survive the fake DOM.** `test/browser/atmost.mjs` and
`rendercheck.mjs` import it directly with a ~15-line stand-in for `document`
that implements `setAttribute`/`appendChild` and nothing else. Use
`setAttribute('data-x')` rather than `.dataset.x`, pass `class` through the
attribute object rather than `classList.add`, and guard anything that needs
real event or `requestAnimationFrame` APIs. Reach for a browser API here and
those two suites crash outright rather than fail a check.

**Calendar cell hover has three non-obvious requirements.** `transform-box:
fill-box` — without it the transform origin is the SVG's origin and a hovered
cell flies across the grid instead of scaling in place. SVG has no `z-index`,
so the hovered cell is moved to the end of its parent or its neighbours clip
the growth. And the popover is positioned in JS because an SVG rect has no CSS
box to anchor an HTML tooltip to. `<title>` stays in the markup for screen
readers but is hidden with `display: none`, or the native bubble covers the
popover.

**The search box is OUTSIDE `#grid`, and that is the whole design.**
`paint()` runs on every keystroke and rebuilds that subtree with
`replaceChildren()`, so a control inside it would lose the caret mid-word.
`data-focus-key` restores a control that IS rebuilt; the cheaper answer for one
that need not be is to not rebuild it — and `searchcheck.mjs` asserts a whole
word arrives with focus still in the box, because moving it inside `#grid` does
not fail a check, it makes the element unreadable.

Three rules travel with it. **The drag handle goes while a filter is on**: a drop
against a subset computes a `position` from neighbours that are not the habit's,
and `persistOrder` sends the RENDERED order. **The threshold reads the unfiltered
count** (and the box also stays while it has focus), or it vanishes under the
cursor at the moment a query narrows the list past it. And **the MUTATORS clear the query**, not the `'reload'` listener. Creating a
habit or restoring a backup replaces the list, so a filter that hides the result
is a thing the user is told about and cannot see — `habit-dialog` and
`data-dialog` clear it where the archive toggle already does. Doing it in the
listener looks equivalent and is not: `'reload'` has ten emitters and only half
replace anything, so it also wiped the box on **Back from a habit** — the
feature's main workflow — and on a background reconnect, mid-word.

**A rebuilt control keeps focus via `data-focus-key`, not its position.**
`dashboard.paint()` rebuilds the grid with `replaceChildren()`, and a single
check-off does it twice — optimistically, then again after the refetch. That
destroys the focused element, so tabbing to a checkbox and pressing Enter used
to drop focus to `<body>` and send the next Tab to the top of the page. The key
names *what a control is* (`check:<habit>:<date>`, `handle:<habit>`,
`nav:older`), never where it sat, so the restore still lands after a reorder
moves the row. Two consequences worth knowing: a key that no longer exists
simply does not match, which is the right answer for a column you paged away
from; and a control that survives but is *disabled* — Today, once there is
nowhere to jump to — hands focus to its nearest working neighbour, because
`.focus()` on a disabled button is a silent no-op. `persistOrder` used to
re-focus the drag handle by hand; that special case is gone. Pinned by
`test/browser/gridcheck.mjs` and `dragtest.mjs`.

**`detail.open()` preserves scroll position.** Every control in the detail view
re-renders through it, and `replaceChildren()` collapses the page height,
which sends the window to the top. Preserve it on redraw of the *same* habit
only — opening a different one should start at the top.

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

**The settings dialog holds a draft; nothing is written until Done.** It edits
a copy taken when it opens, so Cancel — and Escape, which `<dialog>` handles
itself — throws the whole thing away. Three consequences worth knowing before
changing it. The dependent controls (`requires`) read the *draft*, which is
what lets switching Discord on reveal its webhook field before anything is
stored. The body is rebuilt only when that visible set changes, so a `multi`
handler must read `draft[key]` at event time and never a list captured during
render — capture it and ticking a second box silently drops the first. A `multi`
option may also carry `onEnable`, run when the box is TICKED and inside the click
that ticked it: a notification permission can be asked for from nowhere else, and
the dialog redraws when it settles so the section can report what the browser
said. Named on the option rather than tested for by key here, or the dialog stops
being able to render a section without knowing what is in it. And a
section action like "send a test notification" asks the server to use the
settings it *holds*, so it is disabled while the draft is dirty rather than
quietly testing the old value.

**A section can also SAY something, and that arrives late.**
`SECTION_NOTICES` mirrors `SECTION_ACTIONS` — keyed by section, given the draft,
returning prose — and the one entry is "your last reminder was not delivered",
from `GET /api/notify/status`. Three things about how it is rendered. It is
*not* awaited by `openSettings`: waiting on a request before showing the
settings would make every open feel slow to spare the one that has something to
report, and offline the dialog would never open at all. The redraw when the
answer lands is *conditional* — a clean draft and a changed set of notices —
for the same reason `stage` rebuilds sparingly: a rebuild tears every control
out and takes a text field's focus with it, and a late answer must not do that
to someone already typing. And the notices read the **draft**, so switching a
destination off makes its warning disappear immediately rather than after a save
and a refetch. Pressing "send a test notification" re-asks, because a test is a
real delivery attempt and is what clears the notice once a replacement webhook
works.

**A setting the server normalises cannot be judged here.** Whether a webhook
URL is acceptable depends on a host allowlist that lives with the fetch, so the
control has to show what was *stored* rather than what was typed. `saveAll`
writes the draft in one request and reports `ignored`; on anything refused the
dialog stays open, redraws from the server's values and names what did not
land. Applying is therefore partial by design — the endpoint takes a patch and
drops what it will not have rather than failing the lot. `set` (apply locally,
write through, works offline) is still right for the in-place calendar zoom in
the detail view, where there is no dialog to wait in.

**A setting with an in-place toggle needs a session override.** `calendarZoom`,
`historyGranularity` and `historyMode` all have controls in the detail view as
well as entries in the dialog. The pattern: `state.X = null` means "use the
saved value", the toggle sets it for the session, and `applyDraft` clears it
for every key Done actually changed — otherwise the dialog appears to do
nothing once a toggle has been touched. Read through the accessor, never
`state.X` directly.

**Saving a habit returns you to where the edit started.** `habit-dialog` emits
`'change'` when `openHabitId` is set and `'reload'` otherwise, so editing from
a habit's own page reloads that page and creating from the dashboard reloads
the list. It cannot simply call the detail view — that is the import cycle the
store exists to break — and it cannot always emit `'change'`, because on the
dashboard that is a repaint from stale state and a newly created habit would
not appear. Deleting still goes home: the page you were on is gone.

**The time picker's parser is mirrored in Kotlin.** `public/ui/time.js` and
`android-native/.../ReminderTime.kt` accept the same inputs and produce the same
`HH:MM`, because both clients write the same `reminder_time` on the same habit.
`test/time.test.js` and `ReminderTimeTest` pin the same examples on purpose — if
you add a form to one, add it to both. The two that catch people out: `12 am` is
00:00 while `12 pm` is 12:00, and an empty box means "no reminder" while
unparseable text is an error to report — the caller does different things with
them, so they are `''` and `null` rather than both falsy.

**A habit shown as something to avoid keeps the cycle and changes the
encoding.** `show_as: 'avoid'` on an at-most habit walks the same four states —
a clean day is `done`, a slip is `no` — so `nextDayState` is untouched and its
Kotlin mirror did not have to learn anything. `valueForState` is what differs:
`done` writes 0 and `no` writes `target + 1`, where an ordinary habit writes
`YES` and `UNSET`. It is mirrored in `Grid.valueForState` for the reason the
cycle is — a tap happens with no network — and `isAvoided` asks all THREE
questions: avoid, at-most, and MEASURABLE. `show_as` is kept when a habit's type
or goal is switched, so that switching back does not lose it, which means the
predicate carries the whole rule. Asking two of the three put a habit somewhere
it could not leave — boolean + at_most + avoid is reachable from the form in one
sitting, and a tap meaning done then encoded as 0, which `isCompleted` reads as
NOT done for a yes/no habit.

`valueForState` **throws** for a skip rather than answering. A skip is the
status column, and returning Loop's SKIP sentinel as a value stored three of the
thing on a measurable habit — `parseEntry` reads 3 as a skip only for a boolean
one. The dashboard's `recordSkip` writes `{status: 'skip'}`, which is what the
day editor and the phone have always sent.

Note `toggle.js` declares `UNSET`/`YES`/`SKIP` locally rather than importing
`ui/values.js`. It is dependency-free on purpose — that is what lets
`test/toggle.test.js` run it with no browser, since the absolute `/shared/...`
specifiers the rest of `public/ui` uses do not resolve under Node — and
`test/toggle.test.js` reads the declaration out of the source and pins it
against `values.js` so the third copy cannot drift.

**The tap cycle is mirrored in Kotlin too.** `public/ui/toggle.js` and
`Grid.nextState` are Loop's `Entry.nextToggleValue`, and `test/toggle.test.js` and
`GridTest` are pinned to the same examples for the same reason `ReminderTime`
mirrors `ui/time.js`. Both read `skipDays` and `questionMarks`, so the phone and
the browser cannot disagree about how many states a tap walks through. Note the
one asymmetry Loop has and this keeps: `SKIP` always moves on to `no`, even with
skips since switched off, because the setting does not erase the skips already
recorded and a tap on one has to go somewhere.

**A day that needs no reminder is one that has been ANSWERED, not one that has
been completed.** `answeredIds` tests `isCompleted(...) !== false` because
`isCompleted` returns `null` for a skip — falsy, so a truthiness test asked again
about every day the user had explicitly skipped. `false` is a real miss and still
gets its nudge. The Kotlin `Reminders.needsReminder` is the mirror of this, for
the same reason `ReminderTime` mirrors `ui/time.js`: two clients answering one
question differently is indistinguishable from one of them being broken.

There are **three** of them now: `isDayAnswered` in `public/ui/nudge.js` is the
browser's, for the `web` destination, which decides from `state` with no
network. It is pinned against `answeredIds` over shared fixtures in
`test/nudge.test.js` rather than by reading, and its shape carries the rule the
other two get for free — a nullish entry is `false` before anything else is
asked, because `answeredIds` walks the rows that EXIST and an at-most habit
whose unlogged days count as staying under would otherwise report every
untouched day as answered.

**The notifier reads its clock through `zonedClock`, never `new Date()`
locally.** The zone decides two things, and the second is easy to miss: what
time it is, *and* which calendar day the send is filed under. A server in UTC
reminding someone in Auckland files it under the wrong date and re-sends hours
later. Note `hourCycle: 'h23'` rather than `hour12: false` — en-US resolves the
latter to h24 and formats midnight as `'24'`, so a 00:00 reminder is compared
against 1440 minutes and never fires, with a correct-looking date beside it.
`runTick` also *hands* the instant to `collect`, so the adapter cannot read a
second clock a millisecond the other side of local midnight.

**`shared/src` is not served to the browser.** Only `shared/public` is mounted,
so `ui/settings.js` cannot import `notify.js` — the channel list is declared in
both and pinned by `test/notify.test.js`, exactly as `SETTING_VALUES` is. Do not
"fix" this by mounting `src/`.

**Adding a setting means two files.** `public/ui/settings.js` declares what
the dialog renders; `src/validate.js` declares what the server accepts. Both,
or the control is either unenforced or dead — `test/settings.test.js` fails if
they drift. Do not add a control before the behaviour it names actually works:
`weekStart` sat commented out until the aggregation honoured it.

**The UI is auth-agnostic.** No view mentions sign-in; `app.js` calls the
injected adapter (`load` / `render` / `signOut` / `onUnauthorized`) and hands it
to `ui/api.js`, which needs it only to tell an expired session from a bug.
Adding an `if (cloud)` branch anywhere here is how the frontends drifted apart
the first time.

There is now one adapter rather than one per edition, and the branch it used to
be lives on the server: `load()` reads `mode` from `/api/me`, **and from its
401** — a signed-out client is the one that has to decide between a form and a
link, and that response is all it gets. `mode === 'none'` renders nothing at all
and lets a 401 through as the bug it would be. With no build step nothing could
pick a module at package time, which is exactly what stopped the personal
edition making auth a runtime choice.

## Tests

```bash
npm test              # unit — fast, no dependencies
npm run test:browser  # real Chrome against a running server
```

`test/roundtrip-fixture.mjs` is shared by both editions' round-trip suites
(`npm run test:roundtrip -w habiterall-personal`, and the same in
`habiterall-cloud` with a Postgres). It defines the fixture *and* the
per-format fidelity rules, so the two editions cannot disagree about what a
faithful restore means. Add a case there when a new encoding trap appears —
that is how the CSV skip/value collision was caught.

`test/browser/` is not optional decoration: a CSS `display` rule silently
defeating the `hidden` attribute shipped once, and no unit test could have
seen it. `fixtures.mjs` resets known data before each suite.
