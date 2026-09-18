# Native stats for one habit, and the second chart implementation it would create (#171)

Moved out of #171, filed because #145 (open: a stats widget for one habit and
an overview widget for all of them) raised the question of a native stats
screen and should not be the place it gets answered. Nothing here is loaded
automatically. It has three separable parts, and only two of them are work —
the third is the recommendation this file exists to record.

Every other screen in the native client is Compose — `ArchiveScreen`,
`DayGrid`, `HabitFormScreen`, `HabitList`, `ReorderScreen`, `SettingsScreen`,
`SignInScreen`. Stats and the calendar are the exception: tapping a habit
opens `WebScreen`, the app's one long-lived WebView, on `#/habit/:id`.

## 1. A stale comment, worth fixing whatever this concludes

`android-native/app/build.gradle.kts:134-135`, beside the `androidx.browser`
dependency, still reads (checked against the tree this record was written
against):

> Stats and the calendar are the server's own web UI, shown in a **Custom
> Tab** so there is one implementation of the charts rather than two.

**The Custom Tab is no longer how Stats works.** `MainActivity.openInBrowser`
says so in as many words — it is kept only for a user who wants the site in
their own browser, with their own extensions and password manager. Stats is
`WebScreen`, in-app, since the warm-WebView change. The dependency comment
describes a container that path stopped using, and anyone reading it to find
the recorded decision finds a wrong one. Correcting it to name `WebScreen` is
five minutes of work and needs no decision — it is the one part of this issue
that was unambiguously worth doing on its own, independent of what the rest of
this record concludes.

## 2. `Api.stats(habitId)` — a prerequisite for the screen, and NOT one #145 shared

**`Api.kt` has no stats call at all**, confirmed against the tree: `overview`,
`habits`, `entries`, `setEntry`, `setReminder`, `createHabit`, `updateHabit`,
`reorderHabits`, `settings` — nothing reaches `/habits/:id/stats`.

This section was originally written as *the prerequisite shared with #145* —
roughly 150 lines (the call, a Kotlin model, the cache-the-answer decision
made concrete, and score/streak formatting with the avoided-habit inversion
applied once), to be built by whichever issue landed first. **#145 landed
first and needed none of it.** Its widget shows a habit's score and current
streak, and both already arrive on `/overview`'s own `Habit` model — so the
widget stores the answer it was already being handed, and `Api.kt` still has
no stats call. The shared prerequisite was not shared; it was a cost this
record assumed and the cheaper surface disproved.

What survives is the narrower claim. A native stats *screen* draws the survival
curve, the miss distribution, the weekday spread and the award grid, and none
of those is on `/overview` — so it would still need `Api.stats(habitId)` and a
model for the rest of that payload. That work has no second issue to share it
with now, which makes it cost of the screen rather than cost already paid.

**`computeScores` must not be mirrored**, and this is the temptation the
prerequisite creates. Loop's `0.5^(sqrt(frequency)/13)` decay is pinned at
days 13, 30 and 60 (`shared/CLAUDE.md`, `must-stay-fixed.md`). The root rule
is that a client mirrors a rule only if it must work offline, and the answer
here is the one #145 reaches: cache the ANSWER from `GET /habits/:id/stats`,
not the rule. A native screen makes the mirror tempting in a way the current
WebView does not, and that temptation should be refused in a comment at the
fetch site, not in an issue.

## 3. The native screen itself — "a bounded summary, or nothing"

The cheap win has already been taken, which is why building the rest is not
obviously worth it:

- **The WebView is warm.** One instance for the life of the activity, laid
  out and measured from the moment the server is known, invisible rather than
  absent. The renderer process, TLS, the shell and the service worker are all
  paid before the tap.
- **Habit to habit is not a page load at all.** `#/habit/42` to `#/habit/43`
  is a fragment change on a parsed document, handled by `routes.js` as a
  same-document navigation — the payoff for the fragment routing chosen for
  this client.

`WebScreen.kt`'s header comment records the stutter the warm-WebView change
removed and why `about:blank` was chosen over pre-loading the dashboard.

**What a native screen would genuinely buy:** it works offline (the WebView
does not, beyond what the service worker cached, and the app is otherwise
offline-first); it is testable in-process (Compose UI tests reach nothing
inside `WebScreen`); it is consistent with every other screen; and Compose
can draw on a `Canvas`, unlike `RemoteViews`.

**What it costs is the whole issue: a second implementation of the charts,
drifting invisibly.** `charts.js` exports nine chart-drawing functions;
`ui/detail.js` draws ten cards, confirmed against the current tree —
`DETAIL_CARDS` (`shared/src/validate.js`) is `recentDays`, `strength`,
`calendar`, `streaks`, `resilience`, `awards`, `history`, `weekdays`,
`weekdayMonths`, `frequency` — and each would need a native equivalent or a
written-down omission. This count has grown since #171 was filed (nine cards
then, ten now: `recentDays` shipped after), which is itself evidence for the
issue's own point — the card list does not hold still, and a second
implementation has to keep matching it. `recentDays` is not an SVG chart at
all; it is the dashboard's tappable day strip for one habit (`ui/day-strip.js`,
`shared/public/CLAUDE.md`), a shared, stateful, write-capable component — the
hardest of the ten to leave out of "a small, native-drawn summary" and the
first place a native/WebView split has to decide whether it is drawing a
chart or reimplementing a write path. A Kotlin copy of the rest is worse than
the ~1,750 lines of frontend that drifted across the two editions before
being merged back (`CLAUDE.md`), because it cannot be merged back the same
way: there is no shared module a Compose chart and an SVG chart can both live
in. The two are different rendering technologies on the same data, not two
copies of the same file.

And the queue that would double is not hypothetical: #160 (three stats the
detail view cannot answer), #159 (what a typical lapse costs), #132 (chart
label estimation), #144 (translations for all of this prose) are each one
change today; with a native screen each becomes two, and the second is the
one nobody remembers. `detailCards` is a further cost: a server-stored list
carrying order as well as visibility, normalised by `parseCardList` — a
native screen that ignores it is a settings mirror that silently disagrees
with the account, the failure mode `settings-and-mirrors.md` is about.

## The shape #171 itself argued for, if this is taken at all

**A bounded native summary, with the full detail view still one tap away —
never a full native replacement of `ui/detail.js`.** The issue's own split:

- **Native:** the four stat tiles, the score chart, and the recent-history
  strip. These are the numbers someone opens a habit to see, they survive
  being small, and they are the ones #145's widget needs anyway.
- **`WebScreen`:** everything else — the calendar, weekday months, frequency,
  survival, the award grid — behind an explicit affordance.

That keeps `charts.js` and `ui/detail.js` as the one implementation of the
other eight cards, spending the Compose investment only on the three pieces
cheap enough to duplicate, and it leans on `Api.stats` (above) for the data
rather than a second cache shape.

**This shape is not itself a settled decision — it is gated on a question
this record does not answer.** #171 opens its own recommendation with "the
first one gates the rest": *is the offline argument the real motivation?* If
nobody has actually wanted stats offline, part 3 (the native screen) is cost
without a benefit and the issue reduces to part 1 above — the stale comment,
since part 2 turned out to be the screen's own cost rather than a shared
one. #171 also leaves open
whether a native summary replaces the tap target or sits above `WebScreen` as
a new screen (the first changes the app's most-used path), whether
`detailCards` gates the native tiles at all, and whether v1 draws a score
chart on a Compose `Canvas` or ships with numbers only — "a summary with no
score chart is much cheaper and may be enough." None of those four questions
is this record's to resolve; they are Mark's, the same way #144's
server-prose question is `translations.md`'s.

## `Record.figuresStale`: why `record.date` alone cannot answer "are these current"

**The figures are as of `record.date`, on a line a user can see — except
`record.date` alone cannot answer "are they current".** Same rule as the
checkmark cell's own note above, and the same precedent behind it: the first
version of THAT put the explanation in `setContentDescription` alone ("It has
to be VISIBLE, not just described"), so a stats widget repeating that mistake
would have been the identical bug on a second surface. But `record.date` names
the day the ENTRY is about, not when `score`/`currentStreak` were last
fetched, and `Widgets.answered` can record an answer with no network at all — a
notification button, its number pad, or the checkmark widget's own tap. A
morning sync leaves the figures at yesterday's answer; a 9am tap in the shade
moves the strip to today with no fetch behind it, and `record.date == today`
then read as "everything here is current" for up to six hours, contradicting
the strip cell sitting right beside it. `Record.figuresStale` is the second
flag this needed: set on BOTH of `answered`'s branches — an answer has been
recorded with no fetch behind it, not "the strip moved", so the branch that
leaves `date` unchanged (an older-day answer) still sets it — cleared in
`Widgets.refreshed` (a successful fetch is exactly what makes the figures
current again), and shown as its own sentence (`stats_figures_behind`) rather
than the dated one — naming a date would be a false claim when the day itself
is not stale, only the score and streak are. `WidgetSync.noteRefused` leaves
the flag untouched rather than setting or clearing it, but not because
setting it would put the note line on screen: on every path that can produce
a refusal (the shade, the number pad, a widget's own tap), the `answered`
that preceded the write already set the flag, so the note line is already
showing before the refusal ever runs, and leaving it alone changes nothing
there. The decision only matters on the one path that enqueues without
calling `noteAnswer` — the list screen's own tap (`MainActivity`). A refusal
never reached the server, so it is neither evidence the figures are stale nor
evidence they are current, and a boolean cannot hold "this refusal's own
answer" apart from "an earlier one still unfetched" — so it is left exactly
as found, and over-reporting staleness is the fail-safe direction.

