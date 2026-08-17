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

**Arming is not the last chance to be wrong, which is why the day rides on the
alarm.** `setAlarm` falls back to `setAndAllowWhileIdle` when exact alarms are
not permitted, and on Android 14+ that is the ORDINARY path — `SCHEDULE_EXACT_ALARM`
is not granted by default. So one armed at 22:52 for 23:52 can arrive at 00:03.
The snooze intent carries `EXTRA_DATE` and `NotifyWorker` asks `stillAboutToday`.
The daily alarm carries no date deliberately: it names no day and means whichever
one it arrives on, so refusing a null would silence every reminder there is.

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

`ReminderWiringTest` is the one place in this repo that uses Robolectric,
deliberately: this package's bugs are all in the wiring, the wiring is Android,
and a JVM test that cannot see an `Intent` cannot see any of them.
