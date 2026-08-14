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
| `public/app.js` | boot, the top bar, the PWA; `start(authAdapter)` is the entry |
| `public/ui/store.js` | view state, and the `'change'` / `'reload'` channel views listen on |
| `public/ui/dashboard.js` | the habit list: day grid, paging, empty state, reordering, checkbox taps |
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
| `public/ui/reminder-field.js` | the reminder time picker inside the habit dialog |
| `public/ui/settings.js` | the preference registry and its server sync |
| `public/ui/calendar.js` | calendar window/zoom maths, DOM-free so it is testable |
| `public/ui/window.js` | how many columns a chart fits, and which slice to show |
| `public/ui/resample.js` | thins the daily score series for the strength chart |
| `public/ui/dates.js` | browser-side date helpers |
| `public/ui/time.js` | parsing and formatting a reminder time, DOM-free so it is testable |
| `public/ui/toggle.js` | what the next tap on a day records — Loop's cycle, DOM-free, mirrored in Kotlin |
| `public/ui/theme.js` | light/dark, with a redraw callback |
| `public/ui/values.js` | `UNSET` / `YES` / `SKIP` for the browser, mirroring `src/constants.js` |
| `public/auth-none.js`, `auth-oidc.js` | the two auth adapters |
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
fallen behind — with fourteen modules where there was one, a hand-maintained
precache list drifts silently.

## Traps

**`dateRange` vs `boundedRange`.** Use `boundedRange` whenever the start date
comes from stored data. `dateRange` is unbounded and a distant-past entry
turns one request into ~700,000 iterations on a single-threaded server. Every
aggregation in `stats.js` already uses the bounded form; keep it that way.

**`isCompleted` / `dayCredit` take `{value, status}`.** Passing a bare number
still works for boolean habits (where `3` is unambiguously a skip) but is
wrong for numerical ones, where `3` is a real amount.

**A missing day and a day holding 0 are different states, and only the display
knows.** `unknown` is the absence of a row, `no` is a row with value 0, and
`isCompleted` answers `false` for both — deliberately, so `questionMarks` costs
nothing in the arithmetic. What must never happen is a *reader* collapsing them:
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

**The score formula is deliberate.** It feeds a trailing-window adherence
ratio (always `[0,1]`) into an EWMA. Do not "simplify" it back to scaling a
day's credit by `1/frequency` — that overshoots for every non-daily habit and
lets one completion saturate the score.

**Loop's encoding is not guessable.** It was read from the uhabits source:
epoch-millis UTC-midnight timestamps, ×1000 numerical scaling, `YES_AUTO(1)`
counts as done, `NO(0)`/`UNKNOWN(-1)` are dropped. `test/import.test.js` and
`test/export-loop.test.js` pin all of it — if you change a conversion and
those fail, the tests are right.

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

**The calendar is anchored on its END, not its start.** Going back
`weeks*7` days and *then* snapping to a Sunday shifts the whole grid earlier,
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

**The settings dialog holds a draft; nothing is written until Done.** It edits
a copy taken when it opens, so Cancel — and Escape, which `<dialog>` handles
itself — throws the whole thing away. Three consequences worth knowing before
changing it. The dependent controls (`requires`) read the *draft*, which is
what lets switching Discord on reveal its webhook field before anything is
stored. The body is rebuilt only when that visible set changes, so a `multi`
handler must read `draft[key]` at event time and never a list captured during
render — capture it and ticking a second box silently drops the first. And a
section action like "send a test notification" asks the server to use the
settings it *holds*, so it is disabled while the draft is dirty rather than
quietly testing the old value.

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
