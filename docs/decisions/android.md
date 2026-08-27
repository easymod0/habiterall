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
Telling the user their reminders are inexact when they are is a separate
question and a separate issue — nothing here surfaces it.

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


