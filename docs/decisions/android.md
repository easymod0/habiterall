# The native Android client

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**The native day grid runs whichever way `dayOrder` says, and only one
direction is free.** With today on the left, loading more history appends past
the right edge and the scroll offset is still correct. With today on the right
it *prepends*, so every column shifts by its own width and the offset must move
with it or the grid jumps a month sideways at the moment it loads —
`Grid.scrollAfterGrowth` is that correction and it is unit-tested. All rows and
the date header share one `ScrollState`, because two lazy rows cannot share one
state and rows that scroll apart stop lining up with the dates above them.

**The notification body opens the app; only the buttons answer.** Yes / No /
Skip and the number pad are the whole point of the native client, but the
notification is also just a notification, and a tap anywhere else has to do what
every other app does. `MainActivity` is `singleTop` so the tap reaches the
instance already running instead of stacking a second one, and the habit id
rides along so the list lands on the habit that asked. That focus and the
resume snap-to-top would otherwise race — whichever ran second decided where the
list sat — so the snap defers while a tap is pending, and the focus is cleared
once a fetch has landed whether or not the habit was found, or an archived habit
would suppress the snap forever.

**A snooze is a SECOND alarm, and the day the REMINDER is about is what bounds
it.** The "In 1 hour" button records nothing; it re-arms the same notification
an hour on, which on a local channel costs one more `setExactAndAllowWhileIdle`
and no state anywhere. `Reminders.snoozeUntil` is the rule and it says two
things. An hour is an hour of REAL time — `plusMinutes` on a `ZonedDateTime`
moves the instant — which is the exact opposite of `nextOccurrence` beside it, a
wall-clock promise that must survive a DST boundary saying the same o'clock; the
two differ on one night a year in each direction and both are pinned. And the
target must land on **the day the reminder names**, never on a later one, for
the reason `dueReminders` already drops a reminder whose window straddles
midnight: a notification names a date, so one posted at 00:30 asks about a day
nobody has lived yet while the day it was about goes unasked.

The first version asked whether an hour fitted inside **the day of the press**,
which is the same question only until the moment it matters. A notification is
not removed by pressing an action — `setAutoCancel` fires on a body tap — and
carries no `setTimeoutAfter`, so the 16th's reminder is still in the shade at
00:30 on the 17th, and there an hour fits perfectly. The re-post then read
`LocalDate.now()` and asked about the 17th, while the 16th left the shade
unanswered. The asymmetry is what made it a bug rather than a judgement: Yes /
No / Skip on that same stale notification write to the date it names, so snooze
was the one action that silently changed the subject. Refusing costs nothing —
the daily alarm is untouched, and the notification stays in the shade with its
three answers still correct about the day it names.

**A permission that is DECLARED and never REQUESTED is a permission the app does
not have, and this client shipped that from its first commit.** The manifest
carried `SCHEDULE_EXACT_ALARM` alone from `5cb7860` (2026-08-12), deliberately
and with the reasoning written beside it. That permission is user-grantable, and
for an app targeting 33+ it is denied by default from Android 14 on **for a
newly installed app** — a phone already running this APK when it took the OTA
to 14 keeps the grant it held under 13, and since the APK is sideloaded and
updated in place rather than reinstalled, that grant survives every later
version. `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` appears nowhere in this client
either way, so nothing ever asked or re-asked. So `canScheduleExactAlarms()` in
`Reminders.setAlarm` was false forever for anyone who first installed it on a
phone already at 14 or later, and every reminder that user got rode
`setAndAllowWhileIdle`, which is inexact by contract.

It did not read as a missing permission, which is the reason it lasted. App
standby widens the window the longer the app goes unopened, so a reminder set in
the app and watched for was punctual, and the same reminder set from a browser
and left overnight looked like it had never fired — flakiness, not a setting.
Nothing in the Kotlin could be made to fail by it either: the answer comes from
the manifest, so `ExactAlarmPermissionTest` had to be written to ask
`PackageManager` what the MERGED manifest requests. That is the same lesson this
file already carries twice — pinning the decision is not pinning the wiring.

**So the manifest now declares BOTH, split at 33: `USE_EXACT_ALARM` uncapped and
`SCHEDULE_EXACT_ALARM` with `android:maxSdkVersion="32"`.** This REVERSES the
earlier decision, and the earlier decision's two arguments are what it has to
answer. The first was Google Play's restriction of `USE_EXACT_ALARM` to alarm
clocks and calendars: that is a review policy, this APK is sideloaded from a
GitHub release (`release.yml`), there is no listing to reject — and Loop, a
habit tracker, ships the permission on Play anyway. The second was that
`USE_EXACT_ALARM` would turn the inexact fallback into dead code. It does not.
`minSdk` is 26, so 26-30 need no permission at all and take the `SDK_INT < 31`
arm; 33+ hold `USE_EXACT_ALARM`, which is protection level `normal` — granted at
install, not revocable — and so answer true unconditionally; and 31-32 hold
`SCHEDULE_EXACT_ALARM`, granted by default but revocable under "Alarms &
reminders". That range is where the fallback stays reachable, and it is the
range the cap keeps the permission for, since `USE_EXACT_ALARM` does not exist
below 33.

No migration goes with it. `setAlarm` re-reads the permission on every arm and
alarms are re-armed on every fetch, on boot and six-hourly, so the first arm
after an install is exact and a revocation on 31-32 is honoured at the next one
without anything being told. `BootReceiver` still handles
`SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED` for that range and stays.
**Telling the user is a soft answer, drawn from the same choice as the fallback
itself.** Loop's `IntentScheduler` answers the missing permission by refusing:
it logs "No permission to schedule exact alarms", returns
`SchedulerResult.IGNORED` and schedules nothing at all. That shape is rejected
here — on 31-32 the user affected is already receiving late-but-real
reminders, and refusing would turn a punctuality bug into a silence, taking
away a reminder that still works. So `setAlarm`'s `else` keeps arming with
`setAndAllowWhileIdle` and only stops being quiet about it: it logs a WARN
under the tag `habiterall.notify`, the same tag `ReminderReceiver` already
logs under, because these are one subsystem's logs.

`Reminders.exactAlarmsRevoked` is the gate the settings screen reads, and its
upper bound is the load-bearing half, not the lower one. The question is
31-32 **and** `!canScheduleExactAlarms()`: from 33 the app holds
`USE_EXACT_ALARM`, protection level `normal`, granted at install and never
revocable, so there is no toggle left to have turned off. A gate written
without that upper bound would show the line to every user on a current
phone — false, and false in the direction nobody would ever report, since
nothing on 33+ is ever late enough to disprove it. Below 31 there is equally
nothing to have revoked, which is the lower bound.

The screen's own `if` adds a third term, `settings.androidRemindersEnabled` —
the same switch the line sits under. With that switch off, `Reminders.schedule`
calls `cancel()` and returns before `setAlarm` is ever reached, so nothing is
armed at all; without the third term the line would claim a late-but-real
reminder directly under a control reading Off.

**The sentence went out asserting something it did not need to, and review
caught it.** The first version read "…so reminders **are still armed** but can
arrive late — by an hour or more." Everything in that sentence is conditional
and true in every state the gate admits *except* those four words, which are a
claim about the current alarm set — and the gate is not a question about the
alarm set. It asks what the platform PERMITS. A user on 12L with reminders on,
who has set no `reminder_time` on any habit (or archived every habit that had
one), has nothing armed at all: `Reminders.armFrom` reaches `setAlarm` for no
habit, and the screen would tell them otherwise with nothing on it able to
disprove the claim. The third gate term handles the case where the SWITCH is
off, which is a different state and was already covered; this one it could not
see.

Fixing it by asking is the wrong trade — that is a fetch behind a sentence, and
the answer would be stale the moment a habit changed. Deleting the four words
costs nothing: the consequence ("can arrive late") is the whole of the useful
content and is the part that holds in every admitted state. It also leaves the
tests' assertion key (`"can arrive late"`) correct, so the five rendered cases
survived the edit unchanged. The general shape is worth keeping: **a diagnostic
line should name the consequence, not the mechanism**, when only the
consequence is something the gate actually knows.

The line itself is a SEPARATE `Text` drawn under the Reminders `SwitchRow`,
never a rewrite of that row's own `subtitle`. The subtitle keeps its one
`else` ("Notifications are switched off for this app in Android settings"),
so a user with notifications off **and** "Alarms & reminders" revoked sees
both statements at once, on screen together, and neither has to win the
other's slot.

What stays out, deliberately: the row is not made tappable into
`ACTION_REQUEST_SCHEDULE_EXACT_ALARM`, and there is no "Fix this" button. That
is a further design call and not an oversight — the sentence names where the
toggle lives ("Alarms & reminders", in Android's own settings) and stops
there; asking the platform to jump there is a separate question for a
separate day.

It is proven at the screen, not at the predicate. Five `@Config(sdk = …)`
cases in `SettingsScreenTest` assert the RENDERED line rather than
`exactAlarmsRevoked` alone — 12 and 12L with the toggle revoked show it, 12L
with it left alone does not, nor does anything below 31 or at 33 and up, the
last of those against the shadow's own "revoked" default, which is the one a
gate missing its upper bound would fail. Two `ReminderWiringTest` cases pin
the other half, "soft, not loud": the alarm still lands
(`alarms().size == 1`) and the `else` no longer runs unheard, a WARN reaching
the tag.

**And then the hop between them, which the first round left open.** All of the
above pins the predicate and the rendering. It does not pin the one line where
they meet — `exactAlarmsRevoked = Reminders.exactAlarmsRevoked(context)`, in
`ManageScreen`'s settings branch — because `ManageScreen` was `private` inside
`MainActivity.kt` and no test could render it. Both call-site arguments are
required parameters, so neither can be *deleted* without a compile error; but
either can be replaced by a constant, and all 299 tests stay green while the
feature is simply gone. That is this file's own repeated lesson, and the review
was right to name it rather than accept "the sibling has the same gap" as a
defence — two unpinned hops is worse than one.

`ManageScreen` is therefore `internal`, for the same reason `HabitList` is
top-level, and `ManageScreenWiringTest` renders it. Nothing is passed in: the
four cases move the platform — the SDK Robolectric reports, `ShadowAlarmManager`'s
`canScheduleExactAlarms()`, `ShadowNotificationManager`'s
`areNotificationsEnabled()` — and assert what reaches the screen. The mapping is
one failure per mutation, which is what makes them value pins rather than a
smoke test:

| written at the call site | the case that fails |
|---|---|
| `exactAlarmsRevoked = false` | a revoked toggle reaches the screen (sdk 32) |
| `exactAlarmsRevoked = true` | the SDK upper bound reaches the screen (sdk 33) |
| `androidRemindersSupported = true` | notifications switched off reach the screen |
| `androidRemindersSupported = false` | notifications left alone keep the ordinary subtitle |

The last two are why the sibling gap closes with the same file rather than
being left for later: a constant `false` passes every "the warning is shown"
assertion there is, and only the positive case catches it.

**Arming is not the last chance to be wrong, which is why the day rides on the
alarm.** `setAlarm` falls back to `setAndAllowWhileIdle` when exact alarms are
not permitted — since the manifest change that is API 31-32 with "Alarms &
reminders" revoked, no longer the ordinary path but not the empty set either. An
inexact alarm is loose by minutes, so one armed at 22:52 for 23:52 can arrive at
00:03 with nobody having pressed anything late. The snooze intent therefore carries
`EXTRA_DATE` and `NotifyWorker` asks `stillAboutToday` before posting; a
delivery that has outlived its day is dropped and logged, exactly as the other
six silences there are. The daily alarm carries no date, deliberately — it names
no day and means whichever one it arrives on, so a check that refused a null
would silence every reminder there is.

The two alarms are two PendingIntents (`habiterall://snooze/<id>` against
`habiterall://remind/<id>`), because `filterEquals` ignores extras and one
intent for both would mean "in an hour" quietly became the habit's new daily
time. That separation is also what lets a snooze survive `schedule`, which runs
on every fetch and only ever touches the daily alarm. `EXTRA_SNOOZED` rides on
the alarm so `ReminderReceiver` does not arm tomorrow's when a snooze fires:
there is nothing to arm — the daily alarm is still pending — and doing it anyway
would spend a network sync per press.

**Pinning the DECISION is not pinning the WIRING, and this file is where that
was learned twice.** A review broke four things at once here — the
`EXTRA_SNOOZED` early return, the second cancel, the snooze's own data uri, and
the button's position — and every test passed, because every mutation that had
ever been run was aimed at a three-line pure function. `alarmUri` and
`Notifications.reminderActions` were extracted in answer to that, and the second
review then broke `snoozePendingIntent` to call `alarmUri(id, snoozed = false)`
and `buildReminder` to iterate `actions.reversed()` — and every test passed
again. Both bugs live ONE LINE BELOW the function that pins them, which is where
all four of the originals lived too: a string being right does not make its
caller use it, and a list being in order does not make its consumer read it that
way.

So `ReminderWiringTest` asserts the OUTPUTS — what AlarmManager was handed and
what the Notification carries — and it is the one place in this repo that uses
Robolectric. That dependency is the price of the lesson: this package's bugs are
all in the wiring, the wiring is Android, and a JVM test that cannot see an
`Intent` cannot see any of them. It expresses no rules; it only asks whether the
rules reached the platform, which is the same question `test/browser/` exists to
ask of the web app.

**Nothing here touches `notify_log`, and that is by construction rather than by
care.** The watermark is the SERVER's record of having sent a reminder, and an
Android reminder is a local alarm the server knows nothing about. It stops being
free the moment snooze is offered on a server-sent channel: the watermark is
written after a send, so a snoozed Discord reminder would already be filed as
delivered for the day and the re-post would never go out. That is why Discord is
out of scope — a snooze there is a scheduled item with its own state, not a
local timer — and why the reasoning is written on `Reminders.snooze`, where the
next person to offer one will be standing.

Three smaller decisions travel with it, and the first was written down wrong
once already. **A pending snooze is not cancelled when the day is answered**,
and the reason is `needsReminder` on the re-post rather than anything about
reachability: the outcome of an answer arriving from anywhere else is a
notification that is never posted, not a wrong write. The earlier claim here —
"a snooze takes the notification away, so there is nothing left to answer from"
— was false on its own surface, since "Enter count" opens `CountEntryActivity`
and only cancels the notification on SUBMIT, so the shade holds a live snooze
button while the number pad is open; and it ignored every other way a day gets
answered, which is the web app, another phone, Discord, this app's own grid and
its day editor. Worth being exact about, because the home-screen widget is
another surface that answers without touching the notification.

The duration is a Kotlin constant and not a setting: a setting would need a
`SETTING_VALUES` entry, a default every client mirrors and a `notMirrored`
decision, to answer a situation one duration already answers. And the button is
added **last**, because the collapsed shade shows three actions and the tail is
what it drops — the right one to lose, since the other three ANSWER the day and
this one only defers it. Which habits pay that is narrower than "an account that
uses skip days": a yes/no habit and an avoided one spend two buttons on Yes and
No, so with skips on they have four and snooze falls off, while a MEASURABLE
habit spends one on the number pad and keeps all three. It is still added rather
than omitted, since three is the phone's shade and a watch shows more.

**A pending snooze does not survive a reboot, and that is a decision rather than
an oversight.** `cancel` is the only place the app drops one; a reboot, a
force-stop or an OEM battery kill drops every alarm, and `rescheduleAll` re-arms
the DAILY alarm from the reminder cache and nothing else — so the nudge the user
asked for silently does not arrive, with no surface saying so. Persisting it
would mean storing exactly the scheduled state this design avoids, to deliver a
deferral after the interruption it was deferring; the day's own alarm still asks
at its own time. Say it as a trade, because stating it as an absolute is how the
first version of this paragraph came to be wrong.

**A home-screen widget is a CACHE, not a sixth mirror — and the cache is what
raises every question in it.** One habit, today, tap to cycle. Everything it
decides was already written down: the cycle is `Grid.nextState`, the encoding
`Grid.valueForState` (so an avoided habit's clean day is 0 and its slip is
target + 1), what a stored day means is `Habit`'s, and the write is `Outbox`'s.
What is new is `Widgets.Record` — the habit's SHAPE and one day's answer, on
disk — because a tap on a home screen happens with no network and nothing about
drawing or answering may wait for a server. That is the reminder cache's
reasoning at a second surface, and a second record rather than a wider one:
`cacheReminders` holds only the habits that carry a reminder, and a widget is
for whichever habit you put on the home screen.

**The record names the day it is about, and that is the whole of the midnight
problem.** A widget has no `onResume` — `MainActivity` re-reads `LocalDate.now()`
on every one, and nothing on a home screen can — so `stateOn` answers `unknown`
for a record whose date is not today rather than showing yesterday's tick. The
cost of getting that wrong is not a stale pixel: read as done, the next tap
advances to *not done* and records a MISS against a day nobody has touched. The
tap resolves today when the tap ARRIVES, never when the widget was drawn, which
is also why a measurable habit's click intent carries `EXTRA_TODAY` instead of a
date — a `getActivity` PendingIntent is built at draw time and pressed whenever
the user presses it. It has to be `getActivity`: opening the number pad from the
receiver instead would be a background activity launch, which Android 10 refuses.

**What redraws it is the part that has to be arranged.** Measured on an
emulator: the launcher keeps showing the last `RemoteViews` until something
updates them, so the rule above is only ever as good as its trigger. Four are
the ones that already existed — the list's own fetch (beside
`Reminders.armFrom`, for the same reason), the six-hourly `ScheduleWorker` that
already re-arms alarms, an answer given elsewhere on the phone
(`WidgetSync.noteAnswer`, from the notification's buttons and its number pad),
and the widget's own tap.

**Midnight itself is an ALARM, and the obvious answer to it is dead code.**
`ACTION_DATE_CHANGED` was the fifth trigger and the only one aimed at the
problem, and it never once fired: it is not on Android's implicit-broadcast
exception list, so a manifest-registered receiver is never sent it on any
version this app supports. `TIME_SET` and `TIMEZONE_CHANGED` *are* on that list
— which is exactly why the wrong version passes every test you can run from a
shell, and why they are still registered. `HabitWidget.armMidnight` is the real
one, through the same `Reminders.setAlarm` a reminder uses so the exact/inexact
choice is made once. It is armed from `redraw` — every path that can create a
widget draws it — and from `BootReceiver`, which is not one of those paths and
was the hole: a reboot clears every alarm, and the system's own
`APPWIDGET_UPDATE` is `updatePeriodMillis` away on an inexact alarm Doze defers,
so a reboot at 23:50 left yesterday on the home screen until the phone was
used. Inexact was the first attempt and `dumpsys alarm` refused
it: an alarm set 23 hours out is given a window of an HOUR, on the one alarm
whose whole purpose is a date boundary. That refusal was not fixed at the time
it was written down here — `armMidnight` arms through the same
`Reminders.setAlarm` a reminder does, so on a fresh install on 14 or later it
had been taking the very inexact branch this paragraph describes, since the
widget landed, and only became exact once the manifest carried
`USE_EXACT_ALARM`. `updatePeriodMillis` is 30 minutes
underneath all of it and is NOT the midnight answer either — those updates ride
an inexact alarm that Doze defers, so overnight the redraw lands on wake.

**A widget that cannot be redrawn is a widget that cannot be RECOVERED, and
three different things reached that state.** It is worth stating as one shape,
because each looked local. A record that will not parse leaves the widget on its
`initialLayout` — blank, and with no click PendingIntent at all — and the next
write rewrites the blob without it: `Widgets.flatten` was stripping `|` and
`\n` but not `\r`, and `lineSequence` splits on a bare carriage return too, so
one habit named `Run<CR>fast` was enough. `parseHabit` only trims, so an
interior `\r` arrives from a paste, a Loop import or the API, and `validate.js`
already flattens `[\r\n]` out of `reminder_message` naming this very reader —
the same hole was in `cacheReminders`, where it costs an alarm instead. A
RESTORE reaches it from the other side: the ids in the backup are not the ids
the launcher hands out, so without `onRestored` and `Widgets.remap` every record
names a widget nobody holds. And a habit that leaves the account reaches a
third version of it, where the drawing survives but is a lie.

`onRestored` has a trap of its own that only shows up in combination: ids move,
and a record the restore did not mention keeps the one it had, so
`remap([7, 12], old=[7], new=[12])` returned **12 twice**. `replaceWidgets`
wrote both, `redraw` drew one and `tap` resolved the other with `firstOrNull` —
the home screen showing habit B while a tap recorded habit A, self-healing later
to whichever `associateBy` kept. A fresh launcher hands out ids from a low
counter and a backup's ids are low too, so the overlap is ordinary. A record
whose id has just been given to somebody else is dropped.

That last one is the interesting one, because doing nothing looked defensible.
`/api/overview` carries neither an archived habit nor a deleted one, so both
arrive as an absence, and the first version left the record alone rather than
"claim the day is unanswered". The consequence it missed is that **the widget
stays tappable**: the launcher goes on drawing the last cell with its click
intent, a tap paints a tick, the write 404s, `isPermanent` drops it, and nothing
ever repaints. `Widgets.refreshedOrGone` marks the record instead —
`Reminders.armFrom` answers the same question the same way, by acting on what
has disappeared rather than only on what remains — and a gone record refuses
taps, drops its recording intent for one that opens the app, and comes back by
itself if the habit is un-archived.

**It also has to be VISIBLE, and the first version of it was not.** The
explanation went to `setContentDescription` and nowhere else, so on the day the
habit was archived the cell was pixel-identical to a live habit answered done —
full colour, a tick — and the day after it was a blank cell under the habit's
name. The only change a sighted user could see was that a tap opened the app,
which reads as a bug rather than as an explanation. The layout has a third view
for it now, hidden the rest of the time, because neither the name line nor the
cell can say it without borrowing a meaning. The reason it looked finished is
worth keeping: a `uiautomator dump` prints the accessibility tree, so the
sentence was right there in the verification — **the dump is not the screen**,
and a claim about what a user sees has to come from a screenshot.

**Who wins while a write is in flight is asked of WorkManager, not remembered.**
A refresh must not repaint the server's older answer over a tap that has not
been delivered — the `pending` overlay of the list screen, at a surface that has
nowhere to hold one: the tap happens in a broadcast receiver free to die the
moment it returns. So `Outbox.isPending` reads the unique work's own state, which
is durable, survives a reboot, and cannot get stuck the way a flag set by a
process that then died would. `SyncWorker` also repaints on SUCCESS, which is the
durable half of the same idea: the optimistic write happens in a receiver or a
finishing activity, and the worker is the one place the answer is known to have
landed.

**And a write the server refuses for good is taken back where it is refused.**
`SyncWorker` drops a 4xx as permanently inapplicable, so without
`WidgetSync.noteRefused` the cell went on claiming an answer nothing had stored
until some later refresh silently erased it — the defect `Outbox.awaitWrite`
was written for, arriving at a surface with no undo. The day goes back to
UNANSWERED rather than to what it held before, because the record keeps no
previous value and inventing one would be a second claim about the same day.
What this deliberately does NOT do is tell anybody, and that is the one
position here argued rather than fixed: the shade's buttons are equally silent
about a refused write, and the note line the widget does have is spent on the
state that is permanent rather than on one that a refresh will explain. It is
not free — the rollback blanks the day, so the user is left believing they never
answered rather than that their answer was refused, which invites the identical
second tap. The list screen remains the surface that reports one.

Four smaller decisions. A measurable habit's tap opens the number pad rather
than cycling, by the same predicate the notification uses (`isNumerical &&
!isAvoided`) — cycling one would record `YES`, which is 2, as the amount. That
pad now has `taskAffinity=""`, which is not cosmetic: it is launched
`NEW_TASK|CLEAR_TASK`, and while it shared `MainActivity`'s affinity those flags
finished every activity in the app's task and `noHistory` then emptied the task
away — so answering a number threw away the running app, its scroll position and
anything half-typed. Pre-existing, and reachable only from a reminder until the
widget made it the ordinary path. The configuration activity is the one part
that needs the server, deliberately: a widget names a habit and a phone that has
never reached the account has none to name, while everything after that point
works offline. And `questionMarks` joined `skipDays` in the local mirrors,
because those two are what `Grid.nextState` reads and the widget must walk the
same four states the app's grid does.

One last asymmetry worth writing down: `Widgets.answered` ignores an answer
about an OLDER day than the record holds. A reminder posted at 23:50 and
answered at 00:05 names yesterday, and is right to — the notification is about
that day — but the widget has moved on, and taking it would blank today to paint
a day that is over.

## The stats widget

**A second widget, and the issue proposing it had the wrong premise for what
it would cost.** The issue said the score "lives on the server ... reached
through `GET /api/habits/:id/stats`", and a comment on it argued
`Api.stats(habitId)` plus a new Kotlin model was a roughly 150-line
prerequisite this work would have to build first. Neither exists in this
change. `/api/overview` already returns, per habit and in both editions,
`score`, `currentStreak`, `bestStreak` and `totalCompleted`, and `Api.kt`'s
`Habit` already deserializes all four — `ui/DayGrid.kt` was already rendering
`currentStreak` off it. The widget's data source is the `Overview` response the
widget-refresh path already fetched, so the "prerequisite" the issue described
turned out to be nothing this widget needed. #171 genuinely does need
`Api.stats()` — for the `scores` series, `history`, `weekdays`, `frequency` and
`resilience`, none of which `/overview` carries — but that is a different
issue's cost, not this one's.

**The obvious extraction of the checkmark widget's fill colour was wrong, and a
mutation is what caught it.** `HabitWidget.fill`'s numerical arm read
`record.value` — the record's ONE day — to decide a cell's partial-credit
shading. Lifted unchanged into a per-cell call for a seven-day strip, every
numerical cell in the strip would have shaded off the SAME day's number: seven
dates, one figure. The fix changes `fill`'s signature to take the per-day
value explicitly instead of the whole record, with `HabitWidget.render`
passing `record.value` for its own one cell (always about `record.date`) and
`StatsWidget.render` passing each cell's own resolved value. The mutation that
proves the test would have caught the naive version — putting `record.value`
back at the `StatsWidget` call site for every cell — failed with

```
a partial day is the faint alpha variant of it
expected:<1497072374> but was:<-1580820>
```

— the partial cell painted as an empty cell instead of its own faint tint,
because the record's one day (`null`, for that test's third and unanswered
date) was standing in for six other dates' worth of value.

**No `Bitmap`s, and three hazard classes that decision removes.** `RemoteViews`
cannot draw, so a history strip drawn as one image would need
`setImageViewBitmap` — which brings the marshalled-transaction size ceiling
`RemoteViews` enforces on a bundle, and forces a full re-render on every
resize, every theme change and every density change, because a baked bitmap
does not itself adapt to any of the three. The strip is a fixed row of
`ImageView`s over an opaque `@drawable/widget_cell`, tinted per cell with
`setColorFilter`; the score is a `TextView` plus `RemoteViews.setProgressBar`
rather than a hand-drawn arc. None of those three hazards exist for a tint or a
platform-drawn bar.

**`WidgetSync.refreshFromServer` asked for one day, and a strip needs seven.**
It called `api.overview(days = 1)`, correct while its only consumer was the
checkmark widget reading `today`. `Widgets.encodeHistory` reads
`habit.entries`/`habit.skips` over the fetched window, so a one-day fetch left
every date but the current one absent from the encoded history — the strip
would have populated as all-unknown on every six-hourly sync, silently, with
nothing failing loudly enough to say why. The fix is
`days = Widgets.MAX_STRIP_DAYS` (7); `WidgetConfigActivity`'s own fetch,
already wider than one day, is widened to the same constant so a freshly
placed stats widget draws a populated strip immediately rather than waiting
for the next sync.

**`redraw` and `armMidnight` were hard-coded to one provider, and the second
failure mode was the sharper one.** Both asked
`getAppWidgetIds(ComponentName(app, HabitWidget::class.java))` — the checkmark
provider by name, from before `StatsWidget` existed. Left alone, a stats
widget would never be redrawn by any of the five triggers; and with ONLY a
stats widget on a home screen, `armMidnight`'s `wanted` read false off that
same hard-coded question and CANCELLED the one alarm that would ever redraw
anything at midnight — not a missed redraw but an actively cancelled alarm.
The fix is one helper answering "the live ids, per provider" for both
`redraw` and `armMidnight`, with `redraw` drawing each id through the renderer
for the provider that actually holds it and `armMidnight`'s `wanted` true if
EITHER provider has ids. One alarm still serves both; this did not become a
second alarm per provider.

**A test-only dependency: `mockwebserver`.** `StatsWidgetTest` needs to assert
the actual query string `WidgetSync.refreshFromServer` sends, rather than trust
the call site's `days = Widgets.MAX_STRIP_DAYS` the way a stub `Api` would, so
`testImplementation("com.squareup.okhttp3:mockwebserver:5.5.0")` joined
`build.gradle.kts` — pinned to the same version as the `okhttp` implementation
dependency it embeds a client for. It is test-only, and it buys a real local
server the request can be read back from rather than asserted by inspection of
the call site. The JDK's own `com.sun.net.httpserver.HttpServer` would be the
dependency-free alternative, if pulling in OkHttp's test artifact is ever
worth avoiding.

**`Widgets.encodeHistory` had no test, and a KDoc claimed one that did not
exist — this repo's most-shipped defect, worked in full.** The function was
correct. What was missing was a test reaching it: grep the test tree at the
time of review and the only line naming `encodeHistory` was a KDoc comment in
`StatsWidgetTest.kt` claiming `WidgetTest` pinned it. It did not. Every strip
test in that file hand-wrote a `history` literal, and the one test that
reached the real encoder (`refreshedOrGone carries the stats figures from the
habit`) used a habit with no entries at all, so `history` came out `""`
regardless of what the encoder did with a gap. Twelve strip tests passed. The
mutation that survives this gap is the one the root `CLAUDE.md` names —
collapsing `unknown` into `no`:

```kotlin
// the surviving mutation
else "$date:${habit.valueOn(date) ?: 0.0}"
```

An unanswered day then encodes as `date:0.0` instead of being left out of the
string, decodes to a real `0.0`, and `Grid.dayStateOf` no longer short-circuits
to `UNKNOWN` — it computes a state from that `0.0` the same as it would from a
stated lapse. Measured on `avoidedHabit()` (`at_most`, target `2.0`, the
fixture already used elsewhere in this suite): `0.0` is always `isMet` on an
`at_most` habit — the smallest possible value against a nonnegative limit — so
the mutated cell painted `DONE` (the habit's own colour, a "clean" day), not
`NO`/`SLIP` as an inline read of "collapsing unknown into no" might suggest.
That is the *other* direction root `CLAUDE.md` already names — "which spend
identically on an at-least habit and oppositely on an at-most one" — false
CREDIT on an at-most habit, a full-marks week manufactured for days nobody
answered, rather than a false slip. The test that catches it does not need to
predict the exact wrong colour, only that the cell must be
`widget_cell_empty` and it is not: it fails either way. The fix was three
tests directly on `encodeHistory` (a gap dropped, a stored zero kept, a skip
encoded as `s`) plus one end-to-end render test building `history` through the
real encoder rather than a literal, and the false KDoc claim was corrected
once the claim became true. The lesson this restates rather than introduces:
an inventory a guard or a comment claims is part of what has to be checked,
and twelve green tests said nothing about the one path none of them reached.

**`Record.figuresStale`, and why `record.date` alone could not answer
"are the figures current".** `record.date` names the day the entry is about;
`score` and `currentStreak` are the account's figures as of the last
`/api/overview` fetch, and nothing kept those two in step. Named case: a
morning sync returns `score = 0.30, currentStreak = 0` because yesterday was
missed; at 09:00 the user presses Yes in the notification shade, which moves
`record.date` to today with no fetch. `StatsWidget.render`'s old condition,
`record.date != today`, then read false — "current" — while the strip's
newest cell had just changed colour beside a note line asserting nothing was
wrong, for up to six hours until the next heartbeat. The fix is a field, not a
smarter read of the one that existed: the note line's condition became
`record.gone || record.date != today || record.figuresStale`, and the
`figuresStale`-only case gets its own sentence (`stats_figures_behind`) rather
than the dated one, because naming a date would be a false claim when the day
itself is not the stale part.

The field's DEFINITION took a second round to land on. The first cut set it
"wherever the strip moves without a fetch" — `Widgets.answered`'s ordinary
branch and `WidgetSync.noteRefused` both move `record.date`, so both set it —
and cleared it only in `Widgets.refreshed`. That definition was satisfied BY
CONSTRUCTION on `answered`'s early-return branch, the one that hands the
record back with `date`/`value` unchanged because the incoming answer named a
day OLDER than `record.date` already held: nothing there moves, so "wherever
the strip moves" was vacuously true and the flag stayed whatever it already
was — which is exactly wrong for a notification still in the shade about
yesterday, answered after this morning's sync had cleared the flag: an answer
WAS just recorded with no fetch behind it, and the note line went on reading
"current" regardless. The rule that now holds is what `StatsWidget.render` —
the field's one reader — actually needs to know: `figuresStale` means an
ANSWER has been recorded with no fetch behind it, set on BOTH of `answered`'s
branches, including the early return. A refusal (`WidgetSync.noteRefused`) is
the one answer-shaped path that does NOT set it — but a later review of the
call graph found the justification for that as first written was false.
Every path that can produce a refusal — the shade's buttons, the number pad,
a widget's own tap — reaches `noteRefused` only after `WidgetSync.noteAnswer`
(or `Widgets.answered` directly) has already run and already set the flag, so
`stats_figures_behind` is already on screen before the refusal is even known
about; leaving the flag untouched changes nothing there. The one path this
decision is not a no-op for is `MainActivity`'s own list-screen tap, which
enqueues the write without ever calling `noteAnswer`. The choice is still
right, for a narrower reason: a refusal never reached the server, so it is
neither evidence the figures are behind nor evidence they are current, and a
boolean cannot distinguish "the answer THIS refusal just rolled back" from
"an earlier answer that landed and has not been re-fetched since" — so the
flag is left exactly as found rather than set or cleared, and over-reporting
staleness is the fail-safe direction. The lesson this restates: a field is
defined by what its one reader asks of it, not by whichever mechanism happens
to make it true elsewhere — "the strip moved" and "an answer was recorded
with nothing behind it" agree everywhere except the one branch that
mattered.

**The ghost-kept fill, and why it lives beside `fill` rather than inside
it.** `Widgets.markFor` already has an arm for `state == UNKNOWN &&
habit.unloggedIsSuccess` — a ghost `✓`, because on such a habit an unanswered
day already counts as kept, not merely unknown. `HabitWidget.fill` has no such
arm; it did not need one, because the big cell carries that information in
the glyph `markFor` draws beside it. The strip has no glyphs at all, so a
strip built from plain `fill` painted that same day `widget_cell_empty` —
named case: `show_as = "avoid"`, `at_most`, `target_value = 2`,
`unlogged_is_success = true`, no entries in the last seven days, and
`/overview` answering `score: 1.0, currentStreak: 7`. The widget drew "100%",
"🔥 7" and seven empty cells: a full-marks week rendered as a blank one, beside
a red cell for a day that really was a slip, teaching the reader that empty
means "nothing happened". This is explicitly not the strip's already-accepted
collapse (`UNKNOWN`, `SKIPPED` and a yes/no `NO` all read as empty) — a
ghost-kept day is a fourth thing, on the other side of that line, and the
model itself disagrees that the day is blank. The fix, `HabitWidget.stripFill`,
draws the SAME faint alpha variant a numerical partial-credit day already
uses — no new colour invented — and sits as a thin wrapper beside `fill`
rather than a new arm inside it, specifically so the big cell's rendering and
`HabitWidget`'s existing tests stay untouched; only `StatsWidget` calls it. A
ghost-kept day and a numerical partial day now read identically on the strip,
which is accepted as a smaller, deliberate loss next to a kept day painting as
if nothing happened.

The tint was the whole of the first fix, and for a round it was also the whole
of the bug: `StatsWidget.render` built each cell's content description from
`HabitWidget.describe`, which still answers `widget_unanswered` for
`UNKNOWN` regardless of `unloggedIsSuccess` — so the ghost-kept cell painted
kept and announced itself unanswered, the screen and the screen reader
disagreeing about the same day. `HabitWidget.describeStrip` is the same shape
of fix as `stripFill` above and lives beside `describe` for the identical
reason: the big cell's one description stays right as it is (a `✓` right next
to the word), so `describe` gains no new arm, and only `StatsWidget` calls the
wrapper.

**`gone` hides the figures as well as the strip, for the same reason the
strip blanks itself.** The first cut of the stats widget blanked every strip
cell for a `gone` record with a comment arguing that drawing the old strip
beside "Removed" would be a second, contradicting claim about the same
widget — but left the score percentage, the progress bar and the streak
drawn from that same stale record, which is exactly the claim the comment
just refused to make, on the other half of the layout. `refreshedOrGone`
keeps a gone record's last figures in storage rather than zeroing them (the
same reasoning as everywhere else in this file: a record quietly wiped is a
record that cannot recover if the habit comes back), so `record.score` and
`record.currentStreak` are still sitting there to be drawn. The fix hides
`stats_score`, `stats_score_bar` and `stats_streak` under the same `gone`
check the strip already uses, leaving only the name and the note line — what
the checkmark widget already does with its one mark.

**A known limitation, left alone rather than fixed here: an answer about a day
OLDER than `record.date` does not repaint that day's cell on the strip
either.** The asymmetry already written down for the checkmark widget's own
cell (`Widgets.answered` ignores an answer about an older day, so the record
is not rewound to paint a day that is over) reaches the strip the same way,
because the strip's own-day cell reads `record.value`/`record.skip` and
nothing else moves them for an older date. A reminder answered after midnight
about yesterday, while the strip has already rolled to today, leaves
yesterday's strip cell exactly as it was until the next `/overview` fetch
lands. Self-healing, and no data is lost — the write itself still goes
through the outbox to the correct date — so this is recorded rather than
patched.


