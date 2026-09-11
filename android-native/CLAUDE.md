# android-native — working notes

The native Kotlin client. Build and toolchain: `README.md`. The long-form
reasoning behind everything here — what was measured on an emulator, which wrong
version shipped — is `docs/decisions/android.md` and `routing.md`.

Read the root `CLAUDE.md` first for the offline-mirror rule and the four day
states. This client holds **five** hand-written mirrors of shared logic and no
more: the tap cycle (`Grid.nextState`), reminder-time parsing (`ReminderTime`),
`needsReminder`, the entry encoding (`Grid.valueForState`), and the channel
default. Each runs where there may be no network. Everything else is
server-authoritative — the phone submits and renders whatever comes back,
including the error.

## The grid

**It runs whichever way `dayOrder` says, and only one direction is free.** With
today on the left, loading history appends past the right edge and the scroll
offset is still correct. With today on the right it *prepends*, so every column
shifts by its own width and the offset must move with it —
`Grid.scrollAfterGrowth`, unit-tested. All rows and the date header share one
`ScrollState`: two lazy rows cannot share one, and rows that scroll apart stop
lining up with the dates above them.

**A row's streak is the server's arithmetic, so recording a day re-asks for it.**
The optimistic overlay knows one day; a streak is the whole history. The refetch
is silent — same fetch, no pull indicator — and `quiet` is read and cleared at
the top of the fetch effect so a fetch cut short by paging cannot leave the next
one silent too.

**The client always sends `end = null`** and grows `windowDays` backward, which
is why it never had the dashboard's `end`-paging defect and why `gridDays` is not
mirrored: there is no fixed column count for a setting to govern.

## The search box

**`HabitList` is top-level, and that is the point.** `HabitListScreen` remains a
private method on `MainActivity` holding the fetch and the dialogs; the shell —
top bar, search box, empty states, list, focus effect — is a top-level
composable so a Robolectric test can drive it. This file's own repeated lesson
is that pinning the decision is not pinning the wiring; four bugs lived one line
below a correct pure function.

**The rendered list is a SUBSET, and three things must keep reading the
unfiltered one** — the reorder hand-off and its `enabled`, the full-screen error
branch, and the search icon's own `habits.isNotEmpty() || filtering` gate —
**while two must read the rendered one**: `ScrollRestore`'s item count and the
`focusHabit` index. Since grouping, "the rendered one" for those two is
`listRows` and not `visible` — see the section-header paragraph below, which is
where that distinction now lives. A reorder against a subset writes a wrong `position` for
habits that were never on screen, and it is the only one of the five that
reaches storage; the rest only look wrong — the error screen replacing a working
list, the search icon itself disappearing (were it gated on `visible` instead)
at the exact moment a live query narrows the list to nothing, taking with it the
only way back to the rest of the list, or `ScrollRestore` and the focus effect
answering about a list the `LazyColumn` does not hold.

**The icon's gate has two clauses and the second one is load bearing.** Quote it
whole — `habits.isNotEmpty() || filtering` — because the shorter half is the one
that reads like the whole rule and is not. `filtering` is what keeps the icon on
screen when `habits` goes empty UNDER a live filter (archive down to nothing
with a query set), which is the one state where the control that can clear a
filter would otherwise vanish along with the thing it was filtering. #173's
`showSearch` carried the same clause as `|| query.isNotEmpty()`; deleting the
six-habit threshold took it along, and it had to come back.

**A notification tap beats a filter**, and the focus effect is keyed on `query`
as well as the list because a query matching everything yields an `equals` list
when it clears — keyed on the list alone, the effect would never re-run and the
focus would stay pending for the life of the process, which is exactly what
suppresses the resume snap-to-top. `searchOpen` joins that key list, and its
guard, for the identical reason: a notification can arrive with the field
expanded but nothing typed, where `query` alone has nothing to change and the
effect would never re-fire to collapse it.

**A filter that outlives the box it was typed in is a subset with its reason
off screen, so the active icon and the ungated count are not decoration.**
Confirm collapses the field on purpose without clearing the query, and the
count `Text` is gated on `filtering` rather than on `searchOpen` for the same
reason the icon renders `BadgedBox` and tints itself
`MaterialTheme.colorScheme.primary` on that condition: drop any of the three
and a collapsed, filtered list reads as the whole of the account, with nothing
left on screen saying it is not.

**The field is in the bar's TITLE slot, so it inherits a style nobody chose.**
`TopAppBar` wraps that slot in `ProvideTextStyle(titleTextStyle)` and
`TextField`'s `textStyle` defaults to `LocalTextStyle.current` — measured at
22sp/28sp, against the 16sp every other field in this app uses. It is passed
explicitly for that reason, and pinned through `GetTextLayoutResult` because
nothing bounds-based can see it: the field measures to the bar's 64dp height
either way. The search icon's `role = Role.Button` is the same shape of
omission — `IconButton` supplies one, a bare `combinedClickable` does not, and
this control cannot be an `IconButton` because it needs the long-press.

**The two clients now disagree about when a search is offered, on purpose —
do not "fix" the difference.** The web keeps `dashboard.js`'s `SEARCH_FROM = 6`
untouched; the phone drops its own threshold entirely and offers a 48dp icon
from the first habit up, because an icon costs almost nothing while a
permanent row is only worth a 1440px dashboard's spare width. Neither predicate
reaches storage, so there is no shared truth for the two to have drifted out
of — only two different "is this control worth its space" answers to two
budgets that are not comparable.

**The client now HAS a picker and a grouped list, and `groupByCategory` is
still not a sixth mirror.** Issue #65's Android half added `CategoryPicker`
(`ui/HabitFormScreen.kt`) and the grouped `LazyColumn` (`ui/HabitList.kt`,
`ui/HabitSections.kt`), so "there is no picker: setting a category is a web
action" is no longer true — picking one is now a native action, same as
setting a habit's colour. What stays true, and is why `groupByCategory` joins
`AppSettings` without joining `Settings.kt`'s three cached mirrors: a category
never runs from an alarm — the notification path never asks which one a habit
is in — so there is nothing here that has to work with no network. The setting
is read from the settings fetch (`AppSettings.groupByCategoryEnabled`) and used
to draw, and no more. The replace hazard is also unchanged and is still why
`Habit`, `HabitInput`, `Draft`, `Habit.toInput()`, `Habit.toDraft()` and
`Draft.toInput()` all carry `category_id` untouched: `PUT /habits/:id` runs the
body through `parseHabit`, which defaults every absent field, so a write that
omits it CLEARS a category set on the web. The picker inherits that hazard
rather than removing it — see `Draft.categoryId`'s KDoc for the shape it takes
when `existing`'s category is not in the account's current list, the same
silent-clear bug #251's web habit dialog actually shipped.

**Grouping makes `HabitList`'s item count stop being its habit count, and two
places had to stop reading `visible` because of it.** `HabitSections.rows`
(`ui/HabitSections.kt`) interleaves a `ListRow.Header` per category into
`listRows`, so once grouping is on, `visible.size` items become `listRows.size`
items and a habit's position in `visible` is not its position in what the
`LazyColumn` actually holds. `ScrollRestore.needsSnapToTop` and the
notification-focus effect (`ui/HabitList.kt`) both read `listRows`, keyed and
indexed into by `ListRow.Entry`, for exactly that reason. A future change that
puts `visible.indexOfFirst { it.id == focusHabit }` back is the same defect
shape this file names repeatedly — a correct pure function (`HabitSections`)
with a caller one line away that stopped reading its output — and its
observable symptom is a notification tap scrolling to whatever row is that
many slots down, a different habit's row once a section boundary sits between
them.

**Reorder does not disable while grouped, unlike the web, and does not need
to.** `dashboard.js:300` sets `reorderable = … && !grouped` because the web's
drag writes a flat id list back, which would then be read as the *grouped*
order. Android's reorder is a separate full-screen `ReorderScreen` handed
`habits` — unfiltered, in the server's own `position, id` order, never passed
through `HabitSections.rows` — so a grouped view cannot leak into what a drag
writes. `HabitList.kt`'s `enabled = habits.size > 1` on the reorder hand-off is
therefore unchanged by this work and should stay that way; adding `&& !grouped`
to it would be porting a fix for a hazard this client's reorder screen was
never exposed to.

`HabitFieldCoverageTest` reads `JSON_HABIT_FIELDS` out of
`shared/test/roundtrip-fixture.mjs` and would demand a field called `category`,
because that is what the BACKUP carries — a name, resolved from the id at export
time. The wire carries `category_id`. So `category` is exempt there, in a map
with its reason, paired with a positive assertion that `category_id` itself
reaches the wire from the habit's own value through BOTH bridges. An exemption
with no replacement assertion is a hole; that pairing is the decision.

**There is no `Freshness` here any more, and it is not a thing to re-add.**
`Api.kt` used to send `X-Habiterall-Fresh: 1` on reads for three seconds after
any write that got an answer, so that cloud's per-process `/overview` memo would
rebuild rather than serve a replica's pre-tap dashboard. #192 replaced the whole
mechanism with `users.data_version` in the memo key, which makes an entry built
before a write unreachable on EVERY replica with no client cooperation at all —
strictly more than the header bought, and it closes the half the header never
could: a phone that did not itself write had nothing to say, so answering a
reminder on the laptop still left this client a stale list. The interceptor, the
constant, `FreshnessTest` and its half of `AppSettingsDefaultsTest` are all gone
with it. `habiterall-cloud/CLAUDE.md` has the server's half and
`docs/decisions/caching.md` has the argument.

**`HabitFilter` is not a sixth mirror.** A mirror exists so two clients agree
about a value that reaches storage; this predicate reaches none. The two
clients disagreeing about diacritic folding costs a search result, not a wrong
entry. The two folds are near-identical, not equal — Java's `\p{Mn}` and JS's
`\p{Diacritic}` part ways on marks like the Hawaiian ʻokina — and that gap is
tolerated for the same reason: nothing here reaches disk.

**"Is a filter live" is `HabitFilter.isActive`, never `query.isNotBlank()`.**
The bar makes five claims off it — the badge, the `primary` tint, "Search,
filter active", the long-press that clears, and the "N of M" count — and all
five are claims about what `matches` is doing, so they have to be decided by
the same predicate `matches` decides by. The fold strips before it looks: a
query of nothing but combining marks (a bare U+0301, pasted or left by an
orphaned dead key) folds to the empty string and matches every habit, while
being neither empty nor whitespace. Asked the wrong way the bar announced a
live filter over a complete list, with the count reading "N of N". The one
guard that stays `isNotBlank` is the focus effect's, and deliberately: that one
asks whether the BOX holds text a notification tap should take away, not
whether it narrows anything.

## Notifications

**The body opens the app; only the buttons answer.** `MainActivity` is
`singleTop` so the tap reaches the running instance, and the habit id rides
along. That focus and the resume snap-to-top race, so the snap defers while a tap
is pending, and the focus is cleared once a fetch has landed whether or not the
habit was found — otherwise an archived habit suppresses the snap forever.

**An avoided habit's buttons read Clean / Slipped and carry the ENCODED value in
the intent.** `ActionReceiver` has only an id and a date, and a DataStore read
inside a broadcast receiver's ten seconds is not available. What does NOT invert
is the actions: `ACTION_YES` is still the good answer, or every stored
notification and outbox entry changes meaning with a setting.

**A snooze is a SECOND alarm, and the day the REMINDER is about is what bounds
it.** `Reminders.snoozeUntil` re-arms the same notification an hour on and
records nothing. Two rules in it:

- An hour is an hour of REAL time (`plusMinutes` on a `ZonedDateTime`) — the
  exact opposite of `nextOccurrence` beside it, a wall-clock promise that must
  survive DST. Both are pinned, and they differ on one night a year each way.
- The target must land on **the day the reminder names**, never a later one. A
  notification is not removed by pressing an action, so the 16th's reminder is
  still in the shade at 00:30 on the 17th — where an hour fits perfectly, and
  asking `LocalDate.now()` silently changed the subject while the 16th went
  unanswered. Yes / No / Skip on that same stale notification write to the date
  it names; refusing costs nothing.

**The manifest declares BOTH exact-alarm permissions, and that reverses a
decision this file used to state the other way.** `USE_EXACT_ALARM` uncapped
plus `SCHEDULE_EXACT_ALARM` with `android:maxSdkVersion="32"`. The first is
protection level `normal` — granted at install, not revocable — so from 33 up
`canScheduleExactAlarms()` is true with nobody asked and every reminder takes
the exact branch. The old shape declared `SCHEDULE_EXACT_ALARM` alone, which for
an app targeting 33+ is denied by default from Android 14 on, and nothing in
this client ever called `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` — so the exact
branch was unreachable on any phone on 14 or later, and every test still passed,
because no test asked what the APK requests. `ExactAlarmPermissionTest` is that
assertion now, read from the MERGED manifest through `PackageManager`. The Play
restriction the old comment cited does not reach a sideloaded APK;
`docs/decisions/android.md` has the argument in full.

**Arming is not the last chance to be wrong, which is why the day rides on the
alarm.** `setAlarm` falls back to `setAndAllowWhileIdle` when exact alarms are
not permitted, which since the manifest change means API 31-32 for a user who
revoked "Alarms & reminders" — not the ordinary path any more, but not dead
either. So one armed at 22:52 for 23:52 can arrive at 00:03. The snooze intent
carries `EXTRA_DATE` and `NotifyWorker` asks `stillAboutToday`, load-bearing on
31-32 and belt-and-braces above. The daily alarm carries no date deliberately:
it names no day and means whichever one it arrives on, so refusing a null would
silence every reminder there is.

**The fallback stopped being silent about itself, and is quiet about repeating
itself.** `setAlarm`'s `else` logs a WARN under the tag `habiterall.notify`
**once per CHANGE of state, not once per arm** — `schedule` runs per habit on
every fetch and the widget's midnight alarm comes through the same function, so
unconditional it was one line per habit per resume, describing a single
persistent state hundreds of times a day. `lastArmWasExact` is the dedupe and it
caches the LOGGING only: the permission is still read on every arm, so a grant or
a revocation still takes effect on the next alarm and still gets exactly one line
when it does, in either direction. It is `internal` because Robolectric caches a
sandbox per SDK level across test classes, so an `object`'s field outlives the
test that set it and `ReminderWiringTest` has to clear it in `@Before`. The
settings screen draws a
separate line under the Reminders switch when `Reminders.exactAlarmsRevoked`
says so — 31-32 with "Alarms & reminders" revoked, never 33+, where
`USE_EXACT_ALARM` is held from install with nothing to have revoked, **and**
only while `settings.androidRemindersEnabled` — the same switch the line sits
under — is still true: with the switch off, `Reminders.schedule` cancels
rather than arms, so there is no reminder for lateness to be about and the
line would sit directly under the control that made it so. Three decisions a
later change would otherwise re-open: it stays SOFT — the alarm still arms,
refusing (Loop's `SchedulerResult.IGNORED`) is not this client's answer — the
SDK upper bound is what keeps the sentence from being false on every current
phone, and **the sentence asserts nothing about the current alarm set**. It
says only that reminders "can arrive late". An earlier version said they "are
still armed but can arrive late", which the gate cannot know: it answers what
the PLATFORM permits, so a user with reminders on and no habit carrying a
`reminder_time` was told something false with nothing on the screen able to
disprove it. The consequence is the part that is true in every state the gate
admits, so it is the whole of what the line says.

**Both platform questions on that screen are asked in `ManageScreen`, which is
`internal` for that reason.** `SettingsScreenTest` pins the rendering and
`RemindersTest` pins the predicate; the line that joins them —
`exactAlarmsRevoked = Reminders.exactAlarmsRevoked(context)`, and its sibling
`areNotificationsEnabled()` — is reachable from neither, and a constant written
at either leaves every other test green. `ManageScreenWiringTest` renders the
real composable and moves the PLATFORM instead (the reported SDK,
`ShadowAlarmManager`, `ShadowNotificationManager`); each of the four constants
that could be written there fails exactly one of its cases. Same reason
`HabitList` is top-level, and the same defect shape this file names twice.

**Two alarms are two PendingIntents** (`habiterall://snooze/<id>` against
`habiterall://remind/<id>`), because `filterEquals` ignores extras and one intent
for both would make "in an hour" the habit's new daily time. That is also what
lets a snooze survive `schedule`, which runs on every fetch and touches only the
daily alarm. `EXTRA_SNOOZED` stops `ReminderReceiver` arming tomorrow's when a
snooze fires — there is nothing to arm, and doing it costs a network sync.

**Alarms follow the server only when something re-arms them.** `Reminders.armFrom`
runs on every fetch the list makes; `enqueuePeriodicSync` is a six-hourly backstop
because every other path is an event handing off to the next. `ReminderReceiver`
holds itself open with `goAsync`. Before this, whether the phone agreed with the
server depended on whether the process had happened to die.

Three smaller decisions: a pending snooze is **not** cancelled when the day is
answered elsewhere (the re-post's `needsReminder` handles it, and there are six
other ways a day gets answered); the duration is a Kotlin constant and not a
setting; and the button is added **last**, because the collapsed shade shows
three and the tail is what it drops — the other three ANSWER the day. A pending
snooze does not survive a reboot: `rescheduleAll` re-arms the daily alarm only.
Nothing here touches `notify_log`, which is why a snooze on a server-sent channel
is out of scope — the watermark is written after a send, so it would already be
filed as delivered.

## The widget

**It is a CACHE, not a sixth mirror.** One habit, today, tap to cycle.
Everything it decides was already written down; what is new is `Widgets.Record`,
the habit's SHAPE and one day's answer on disk, because a tap on a home screen
happens with no network.

**The record names the day it is about.** A widget has no `onResume`, so
`stateOn` answers `unknown` for a record whose date is not today. Read as done,
the next tap advances to *not done* and records a MISS against a day nobody
touched. The tap resolves today when the tap ARRIVES, which is why a measurable
habit's click intent carries `EXTRA_TODAY` rather than a date — a `getActivity`
PendingIntent is built at draw time and pressed whenever. It has to be
`getActivity`: launching from the receiver is a background activity launch,
which Android 10 refuses.

**What redraws it has to be arranged** — the launcher keeps showing the last
`RemoteViews` until something updates them. Five triggers: the list's own fetch,
the six-hourly `ScheduleWorker`, an answer given elsewhere on the phone
(`WidgetSync.noteAnswer`), the widget's own tap, and **midnight**, which is an
alarm (`HabitWidget.armMidnight`, through the same `Reminders.setAlarm`). Armed
from `redraw` and from `BootReceiver` — a reboot clears every alarm, and a reboot
at 23:50 otherwise left yesterday on the home screen until the phone was used.
`ACTION_DATE_CHANGED` is registered and **has never fired**: it is not on
Android's implicit-broadcast exception list. `TIME_SET` and `TIMEZONE_CHANGED`
are, which is why they stay and why the wrong version passes every test you can
run from a shell. `updatePeriodMillis` is 30 minutes and is not the midnight
answer either — those updates ride an inexact alarm Doze defers.

**A widget that cannot be redrawn cannot be RECOVERED,** and three things reach
that state:

- A record that will not parse leaves it on `initialLayout` — blank, with no
  click PendingIntent — and the next write rewrites the blob without it.
  `Widgets.flatten` must strip `\r` as well as `|` and `\n`: `lineSequence`
  splits on a bare carriage return, `parseHabit` only trims, and an interior
  `\r` arrives from a paste, a Loop import or the API.
- A RESTORE: the ids in a backup are not the ids the launcher hands out, so
  `onRestored` / `Widgets.remap` are load bearing. Its own trap is that a record
  the restore did not mention keeps its id, so `remap([7,12], old=[7], new=[12])`
  returned **12 twice** — the home screen showing habit B while a tap recorded
  habit A. A record whose id has just been given to somebody else is dropped.
- A habit that leaves the account. `/api/overview` carries neither an archived
  nor a deleted habit, so both arrive as an absence — and leaving the record
  alone keeps the widget **tappable**: a tap paints a tick, the write 404s,
  `isPermanent` drops it, nothing repaints. `Widgets.refreshedOrGone` marks it
  instead; a gone record refuses taps, drops its recording intent for one that
  opens the app, and comes back by itself if the habit is un-archived.

**It has to be VISIBLE, not just described.** The first version put the
explanation in `setContentDescription` alone, so the cell was pixel-identical to
a live habit answered done. The layout has a third view for it, hidden the rest
of the time. A `uiautomator dump` prints the accessibility tree — **the dump is
not the screen**, and a claim about what a user sees needs a screenshot.

**Who wins while a write is in flight is asked of WorkManager, not remembered.**
`Outbox.isPending` reads the unique work's own state: durable, survives a reboot,
and cannot get stuck the way a flag set by a process that then died would — the
tap happens in a broadcast receiver free to die the moment it returns.
`SyncWorker` also repaints on SUCCESS.

**A write the server refuses for good is taken back where it is refused.**
`WidgetSync.noteRefused`, or the cell claims an answer nothing stored until a
later refresh silently erases it. The day goes back to UNANSWERED rather than to
what it held before: the record keeps no previous value and inventing one is a
second claim about the same day. It deliberately tells nobody — argued rather
than fixed, and not free, since the user is left believing they never answered.
The list screen remains the surface that reports one.

Four smaller ones. A measurable habit's tap opens the number pad by the same
predicate the notification uses (`isNumerical && !isAvoided`) — cycling would
record `YES`, which is 2, as the amount. That pad needs `taskAffinity=""`: it is
launched `NEW_TASK|CLEAR_TASK`, and sharing `MainActivity`'s affinity meant those
flags finished every activity in the task and `noHistory` emptied it away.
The configuration activity is the one part that needs the server. And
`questionMarks` joined `skipDays` in the local mirrors, because those two are
what `Grid.nextState` reads. `Widgets.answered` ignores an answer about an OLDER
day than the record holds — a reminder answered at 00:05 names yesterday and is
right to, but the widget has moved on.

### The stats widget

**A second provider, `StatsWidget`, over the SAME record store — one habit's
score, current streak and a seven-day strip, read-only.** Reusing
`Widgets.Record` rather than adding a second store is the same argument this
section already makes above: `remap`/`onRestored`, `refreshedOrGone` and the
encode/decode fail-safes are three hard-won mechanisms, and a second record
type would have had to re-implement all three — precisely where those bugs
lived.

**The figures are cached ANSWERS, and mirroring them is the refused option.**
`score` and `currentStreak` come from `/api/overview`, which already returns
both per habit, so this widget added no sixth mirror and no `Api.stats()`. What
it does NOT do is recompute either: the decay behind `score` is Loop's
`0.5^(sqrt(frequency)/13)`, the most intricate arithmetic in the project, and a
second implementation would drift from the first invisibly. "Make the strip
update between syncs" is the version of this argument that will look tempting
to the next person; the refusal is written as a comment at the one place the
figures are taken from the fetch (`Widgets.refreshed`), because that is the
only thing that will stop them.

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
is not stale, only the score and streak are. `WidgetSync.noteRefused` is the
one exception: a refusal never reached the server, so the last fetch's
figures are unaffected by it, and setting the flag there would read as
"queued, will land" on a write that was dropped for good.

**`redraw` and `armMidnight` used to be hard-coded to `HabitWidget` alone, and
the worse of the two failure modes was not "never redrawn."** Both asked
`getAppWidgetIds(ComponentName(app, HabitWidget::class.java))` — the checkmark
provider by name, from before `StatsWidget` existed. Left alone, a stats
widget would never be redrawn by any of the five triggers, and — the sharper
bug — with ONLY a stats widget on a home screen, `armMidnight`'s `wanted` read
false off that same hard-coded question and CANCELLED the one alarm that would
ever redraw anything at midnight. One helper now answers "the live ids, per
provider" for both `redraw` and `armMidnight`, so the two cannot drift apart on
which providers count again, and one alarm still serves both — not a second
alarm per provider.

**Read-only, deliberately — a tap opens the app on that habit and the widget
answers nothing.** Its `PendingIntent` needs `data` distinct from every other
widget's, for the same `filterEquals` reason the alarms above are two
PendingIntents rather than one (`habiterall://snooze/<id>` vs
`habiterall://remind/<id>`): extras are ignored by intent equality, so without
a distinct `habiterall://stats/<widgetId>`, two stats widgets — or a stats
widget and a checkmark widget for the same habit — would collapse onto one
PendingIntent.

**The strip is colour-only, and the collapse that comes with that is
accepted — except for a day the model counts as KEPT.** At ~20dp a cell there
is no room for `Widgets.markFor`'s glyphs, so `UNKNOWN`, `SKIPPED` and a
yes/no `NO` all tint to `widget_cell_empty` and the strip does not tell them
apart. That is accepted, not an oversight: it is a seven-day trend rather than
a per-day answer, and the per-day answer is one tap away in the app. What the
strip must not lose is the avoided-habit inversion — a clean day in the
habit's own colour, a slip in red — which comes free from reusing
`HabitWidget.fill` rather than writing a second one. The one collapse that is
NOT accepted is `unloggedIsSuccess`: `Widgets.markFor` already draws a ghost
`✓` for `state == UNKNOWN && habit.unloggedIsSuccess` on the big cell, because
on such a habit an unanswered day IS a kept one, not merely an unknown one. A
strip with no glyph for that state read a full-marks week as a blank one,
beside a red cell for a day that really was a slip. `HabitWidget.stripFill`
carries the same arm as the faint alpha variant a numerical partial-credit day
already uses — no new colour — and lives beside `fill` rather than inside it,
so the big cell's rendering and its own tests stay untouched; only
`StatsWidget` calls it. A ghost-kept day and a numerical partial day now read
identically on the strip, which is a small, deliberate loss next to a kept day
painting as if nothing happened.

**`gone` hides the figures, not only the strip.** A gone record keeps its last
`score`/`currentStreak` in storage (`refreshedOrGone` leaves them rather than
zeroing them), and drawing them beside "Removed" would be exactly the second,
contradicting claim the strip's own blanking already refuses to make — so the
score text, the progress bar and the streak are all hidden when
`record.gone`, leaving only the name and the note line, the same as the
checkmark widget's own cell does with its one mark.

**It follows the LAUNCHER's light/dark, never the account's `theme` setting.**
`res/values-night/colors.xml` is the only `values-night` in the app and always
has been; this is that same behaviour on a second layout, and this paragraph is
the recorded decision rather than the default nobody chose.

## The WebView back stack

**A view is named by a fragment, never a path** (`#/habit/42`), because that
reaches the server in neither edition. `shared/public/ui/routes.js` owns it.

**`canGoBack()` closing the screen only works while the habit's document sits at
the BOTTOM of the list,** which one WebView for the whole activity ends twice
over: the warm-up's `about:blank` is a real entry underneath, and `routes.go()`'s
push is a real entry above, added after the load committed so nothing measured
before it can count it. `WebBackStack` is the rule and it is **three**, because
the ways in are not alike:

- A document load is fenced by truncating the list once it commits — hung off
  `doUpdateVisitedHistory`, **not** `onPageFinished`, because a FAILED load's
  error page commits after the latter has run.
- A habit opened over the dashboard pushes, and is fenced by counting that entry.
- A habit opened over another habit **replaces** — the one place this client
  speaks JavaScript (`location.replace`), because `loadUrl` cannot, and because
  `routes.go(LIST)` reaches the dashboard by unwinding the entry it pushed. That
  unwind assumes the entry underneath a habit is the dashboard.

Change what `app.js` writes to history during boot, or what `go()` does to reach
the list, and all three have to be re-read. **Every wrong version still passes
`WebBackStackTest`** — the unit tests pin arithmetic and every bug here was in
the premise. Verify on an emulator.

## Auth and the API

**Both editions issue the same cookie**, so one path in `Api.kt` carries either.
The personal edition draws a form and posts `/auth/login`; cloud sign-in is the
*server's own page* in the app's WebView, because an identity provider decides
for itself what a login means. `WebSession` makes Android's `CookieManager` the
one store OkHttp and the WebView share — a Custom Tab could not, its cookies
belong to the browser. `httpOnly` is untouched by any of it.

**Signing out is a page too.** `WebSession.clear` cannot reach the provider's own
cookie, so the provider's session is ended by VISITING its end-session URL, which
`POST /auth/logout` hands back. An OkHttp call cannot stand in (wrong cookie jar)
and neither can a hidden load (a provider may ask something first).
`Auth.endSession` is the rule; the server's own root is nowhere to go, and the
value is **checked before it is loaded** because `loadUrl` executes a
`javascript:` URL in the context of whatever is showing. Every wrong version ends
with the phone on its sign-in screen — only asking the provider for a password
again tells you which one you have.

**Everything that is not 200 or 401 from `/api/me` is `Session.Unknown`, and the
app carries on past it.** A native client boots through this route, so making a
bad answer fatal breaks the instance the web bug broke by a different road:
`HABITERALL_AUTH=off` never needed it, and personal's read limiter keys on IP so
one NAT can 429 it. The list's own error state already reports a broken server.
Being wrong this way costs a round trip; being wrong the other way costs the app.

**`X-Habiterall-Timezone` rides on every request** from an OkHttp interceptor,
which is why the identical offline tap always survived here and was dropped in
the browser.

## Known gap

A typed amount has **three** readers that already disagree about `8,5` —
`HabitFormScreen.parseAmount` and a bare `toDoubleOrNull` in both
`CountEntryActivity` and the day dialog — so `numberFormat` is in `notMirrored`
with no single reader to give an answer to. That is **issue #157**: an account
that has CHOSEN a convention is followed in the browser and not here. Under
`auto`, which is almost everybody, the phone resolves its own locale and there is
nothing to carry.

**The habit ORDER and the reorder GATE used to arrive from two different
requests, and there was a narrow window where they could disagree — fixed
now by having both come from the SAME response.** `MainActivity`'s fetch
effect called `api.settings()` and `api.overview(...)` as two separate,
sequential `try`/`catch` blocks, the second not conditioned on the first
succeeding: a settings call that timed out or 500'd while the overview call
right after it succeeded could leave `manualOrder` at its seeded default while
`/overview` had actually returned a sorted list — the overflow menu offering
"Reorder habits", `enabled`, over a list that was not in `position, id` order,
and `ReorderScreen` writes every visible id's on-screen index back as its
`position`. `Overview` now carries the RESOLVED `habitSort` the server applied
to `habits` in that same reply (issue #200 review), and `MainActivity` reads
`manualOrder` off it (`data.manualOrderEnabled`) rather than off the settings
fetch — see the KDoc on `Overview.manualOrderEnabled` in `Api.kt`. The two
questions "what order is this list in" and "is reordering meaningful right
now" are now answered by one request, so they cannot land apart; `habitSort`
is no longer read from `GET /settings` by this client at all, mirrored default
or otherwise (`AppSettingsDefaultsTest`'s `notMirrored` map has the reason).
`grouped` never had this problem in the first place: the grouping and its own
gate both come from the identical `fetched` object, never from two requests
that can land apart.

Robolectric is not only `ReminderWiringTest`'s: `HabitListTest`,
`ArchiveScreenTest`, `SettingsScreenTest` and `ReminderTimeFieldTest` all run
under it too, and `HabitListTest` is now the largest suite in the package. The
reason is the one this file has stated all along: this package's bugs are all
in the wiring, the wiring is Android, and a JVM test that cannot see an
`Intent` or drive a real `Composable` cannot see any of them.
