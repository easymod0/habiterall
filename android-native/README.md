# habiterall for Android (native)

A native Kotlin client whose reason to exist is **notification actions**: tap
Yes, No, or a count straight from the notification shade and the entry is
recorded, without opening anything.

Everything a web page cannot do is native here. Everything it does well —
charts, the calendar, history editing — opens the server's own web UI inside
the app, so there is exactly one implementation of the statistics and one app
icon on your phone.

## What is native, what is web

| | |
|---|---|
| **Native** | notifications with Yes / No / count actions, per-habit reminders, the day grid and everything you can record in it, creating and editing habits, archiving, deleting, reordering, and the account's settings |
| **Embedded web** | stats, charts, the calendar, import/export |

The line is drawn by what a second implementation would COST, not by what is
easy: charts and the calendar are one implementation on purpose, while managing
habits was native the moment it stopped being possible to do it here at all.

Individual screens can be ported to native later if any of them feel wrong.
Nothing about this design forces the split to stay where it is.

## Managing habits

Create with the **+** button, edit by **holding** a habit's name (tapping opens
its stats), and archive, delete or reorder from there and the overflow menu. All
of it writes to the server and takes the server's answer back, so a habit made on
the phone is on the laptop by its next refresh and vice versa.

Two rules are worth knowing before changing any of this:

- **`PUT /habits/:id` replaces, it does not patch.** The route runs the whole
  body through `parseHabit`, which defaults every absent field — so a partial
  write silently RESETS the fields it leaves out. `HabitInput` exists for that
  reason, and is serialised with `encodeDefaults = true`, because
  kotlinx.serialization otherwise omits exactly the fields that equal their
  Kotlin default and the write clears them.
- **`PUT /settings` does the opposite: it merges.** So the settings screen sends
  only the key that changed, which is also the only way two clients editing
  different preferences between fetches do not clobber one another.

**Nothing on this side validates.** `SETTING_VALUES` and `parseHabit` in
`shared/src/validate.js` are what is enforced; they normalise as well as check,
so an accepted value can differ from the one sent. The phone submits and renders
whatever comes back, including the error. A second copy of those rules here would
be one more thing to keep in step, and the mirrors this client does keep
(`Grid.nextState`, `ReminderTime`, `Reminders.needsReminder`) all earn their
place by having to work **offline** — which none of these do.

**The DEFAULTS are the exception, and they are a real mirror.** `GET /settings`
returns only the keys that have been stored — no gaps filled — so a setting
nobody has touched arrives as nothing at all, and every client has to know what
that means. They live in `AppSettings`, one constant and one `…OrDefault`
accessor each, and `AppSettingsDefaultsTest` reads `shared/public/ui/settings.js`
and fails if the two disagree. It is not a formality: `historyGranularity`
defaults to `week`, the only default in the registry that is not the first option
in its own list, and the first version of the settings screen read it as `day` —
which showed a value the charts were not using and then refused to store the one
it claimed was already selected, since a chip drawn as chosen does not fire. Never
write `?: "day"` at a call site; add the constant, and let the test check it.

Tapping a habit's name opens **that habit's** page in the embedded web UI
rather than the dashboard, via the `#/habit/<id>` route the web app added for
it. `ServerUrl.habitRoute` builds the fragment and `shared/public/ui/routes.js`
reads it; they are pinned to the same examples, because a route only one of
them understands is a page that silently opens the dashboard instead.

## The day grid

The list shows a row of days per habit — at least five on the narrowest phone,
scrolling back through a year of history, every row and the date header moving
together. Tapping a day cycles it the way the web grid does (unset → done →
skipped → unset) and a measurable habit asks for a number instead; holding one
opens a dialog that names the choices rather than making you count taps.

Each row carries its current streak (`🔥 8`), the same figure the web dashboard
shows under a habit's name and the server's own arithmetic — the row prints
`currentStreak` from `/api/overview` and computes nothing. Recording a day
therefore re-asks the server, silently: the optimistic overlay knows about one
day, and a streak is the whole history.

Which end today sits at is the account's `dayOrder` setting, not this app's, so
changing it in the web app moves the phone too. Pull down to refresh.

## The home-screen widget

One habit, today, tap to record it. Drop it on the home screen, pick the habit
once, and it never needs the app again: the tap cycles the same four states the
grid does, a measurable habit asks for a number instead, and a habit shown as
something to avoid paints a clean day in its own colour and a slip in red — the
same way up as everywhere else, because it is the same two functions deciding.

It works offline, which is most of the design. The habit and its day are kept on
the device (`Widgets.Record`), the write goes to the outbox like a notification's
does, and the cell repaints the moment you tap it rather than when the server
agrees.

Two things are worth knowing before changing it:

- **The record says which DAY it is about.** A widget has no `onResume`, so a
  record made yesterday would show a tick against today — and the next tap would
  advance it to *not done* and record a miss on a day nobody touched. `stateOn`
  answers "unanswered" for a stale record, and the tap resolves today when the
  tap arrives.
- **Nothing redraws a widget by itself.** The launcher keeps the last drawing
  until something replaces it, so the rule above is only as good as its trigger:
  the list's fetch, the six-hourly sync, an answer given in the shade, the tap
  itself, and — for midnight — an **alarm** (`HabitWidget.armMidnight`).
  `ACTION_DATE_CHANGED` looks like the answer and is not: it is not on Android's
  implicit-broadcast exception list, so a manifest receiver is never sent it.
  `TIME_SET` and `TIMEZONE_CHANGED` are, and are still registered.
- **A widget that cannot be redrawn cannot be recovered**, which is why a record
  that will not parse is a bug with teeth: the widget sits on its
  `initialLayout` with no click intent, so it is blank AND dead to taps. Free
  text is flattened through `Widgets.flatten` (`|`, `\n` and `\r` — a bare
  carriage return splits a line too), and `onRestored` re-points records at the
  ids a restore hands out.
- **A habit that leaves the account marks its widget rather than freeing it.**
  Archiving is enough — `/api/overview` carries neither archived nor deleted
  habits — and a record simply dropped would leave the last cell on screen,
  still tappable, recording writes that 404 forever. The widget says *Removed*
  under the habit's name and its tap opens the app.

## Requirements

- **Android 8.0 (API 26)** or newer — notification channels and exact alarms
- A running **habiterall** server the phone can reach — either edition: a LAN
  address (`http://192.168.1.50:3000`) or a public HTTPS URL

## Setup

On first launch the app asks for your server URL. It accepts `http://` for a
LAN address and `https://` for anything public.

## Signing in

The app asks the server how it signs people in (`GET /api/me`) and shows
whichever of the two it reports:

| The server says | You get |
|---|---|
| `none` — personal with `HABITERALL_AUTH=off` | Nothing. There is no sign-in to do |
| `password` — personal with a credential | A username and password form |
| `setup` — personal, auth on, no account yet | The same form, creating the account. Whoever fills it in first owns the instance |
| `oidc` — the cloud edition | Your identity provider's own sign-in page |

The last one is why this works at all without the app shipping an OAuth client
you would have to register. **The session is a cookie, and the app and its
WebView share one cookie store** — so signing in on the provider's page, in the
app's own WebView, leaves the session exactly where the native API client reads
it. The server side of that decision is in `shared/src/security.js`: both
editions issue one cookie name with one `SameSite`, so this is one code path
rather than two.

A tapped notification does not need any of this to be up: alarms are local, and
an answer given while the session has expired is queued and sent when you sign
in again rather than being dropped.

**Nothing about this can stop the app opening.** If that one request fails — no
signal, a 429, a proxy's 502, a captive portal's login page — the app carries on
to the list, which reports its own trouble and offers a retry, exactly as it did
before any of this existed. That matters most for the configuration with **no
sign-in at all**, which never needed this endpoint and must not acquire a way to
fail at boot because of it.

Being wrong that way costs a round trip. If there was a session to ask for, the
first request that gets through returns 401, and that is what brings you here.

Sign out from the list's ⋮ menu. It is absent on a server with no sign-in.

Plaintext HTTP is permitted only for private-range addresses
(`10.x`, `192.168.x`, `172.16–31.x`) — a public `http://` host is refused,
because habit data should not cross the internet in the clear. The rule is
enforced in `ServerUrl.parse`, **not** in the network security config: Android's
config matches literal hostnames and has no notion of CIDR, so it cannot express
a whole private range and permits cleartext at the base level instead. Both
layers are needed — that file cannot state the rule, and code cannot relax what
it forbids.

## Reminders

Set a time per habit — hour and minute dropdowns, or type it, since `8:30`,
`8:30 pm`, `830` and `8` are all things people type and all mean something. The
parsing lives in `ReminderTime` and mirrors `shared/public/ui/time.js` exactly,
because both clients write the same field on the same habit.

The same dialog sets **what the reminder asks** — "Did you exercise today?" —
which becomes the notification's title, with the habit's name beneath it.

The app schedules a local alarm, so a reminder fires whether or not the phone has
connectivity, and whether or not the server is reachable.

The buttons answer without the app coming forward; **tapping the notification
itself opens the app** on the habit it was about, which is what a notification
body does everywhere else and what the reminder should do when the answer is
"let me look at it".

**"In 1 hour" is the answer to the reminder being right and the moment being
wrong.** It records nothing — it takes the notification away and posts the same
one an hour later, as a second alarm beside the habit's daily one. An hour of
real time, not of wall clock, and always inside **the day the reminder is
about**: late in the evening, or on a notification left over from yesterday,
there is no snooze to give, so the button is absent (and a press is refused, in
case it was drawn hours earlier). The day rides on the alarm and is checked
again at the moment of posting, because a delivery can land minutes into the
next day — an alarm the app is not allowed to set exactly is loose by that much.
The re-post asks `needsReminder` again, so a day answered in between stays quiet.

On Android 12 and 12L, if you have switched "Alarms & reminders" off for this
app in Android's own settings, you still get your reminders — late rather than
never — and the Settings screen says so, in a line under the Reminders switch.
There is no button here for it: the toggle lives in Android's settings, not
this app's.

The collapsed shade shows three action buttons and drops the tail, which is why
snooze is added last. A yes/no habit and an avoided one spend two buttons on Yes
and No, so with skip days on they have four and lose the snooze; a measurable
habit spends one on the number pad and keeps all three. Deliberate — the others
answer the day and this one only defers it.

A pending snooze does not survive a reboot or a force-stop: `rescheduleAll`
re-arms the daily alarms from the cache and nothing re-arms a snooze. That is
the trade rather than an omission — the alternative is persisting scheduled
state to deliver a deferral after the interruption it deferred.

Reminder times are stored **on the server** as a field on the habit, so they
follow your account to a new phone and the web UI can set them too.

### This device is one destination among several

The account's Settings → Notifications lists where reminders go: this app, a
Discord channel, or both. The server delivers the webhook channels itself; it
never sends push, and it does not know about these alarms — so **unticking the
Android destination has to be honoured here or it does nothing at all.**

That is why the flag is mirrored into DataStore alongside the reminder times:
the decision has to be available on a cold boot with no network, and defaulting
to "enabled" while waiting for the server would re-arm alarms the user switched
off on every reboot. A settings fetch that fails falls back to the cached
answer, never to "on". An alarm already pending when the setting changes is
checked again at the moment of posting, so switching the destination off takes
effect immediately rather than at the next sync.

An account that has never touched the setting counts as enabled — the server's
default is on-device only, and a fresh install that armed nothing would look
broken.

Checking off from a notification while offline queues the write and retries
when connectivity returns — the same guarantee the web app's outbox gives.

## Building

CI builds the APK; see `.github/workflows/android-native.yml`. Nothing needs
installing locally.

- **Every PR touching `android-native/`** runs the unit tests and lint and
  uploads a debug APK as a build artifact, and so does a nightly scheduled run —
  which builds unconditionally, because the failure it exists to catch is the
  runner moving under a pinned toolchain rather than anything in the tree. There
  is deliberately **no push trigger**: `master` is only reachable through a pull
  request that already ran this. That workflow never publishes.
- **Releases come from `release.yml`**, on a `vX.Y.Z` tag or a manual run: it
  builds the signed APK, stamps it with the version, and attaches it to the
  GitHub release. Merging does not ship.

**Signing is required for a release.** With no `ANDROID_KEYSTORE_BASE64` secret
a publishing run *fails* rather than attaching an APK — an unsigned one is
rejected by Android's package manager itself
(`INSTALL_PARSE_FAILED_NO_CERTIFICATES`), which reaches the user as a bare "App
not installed", so no setting and no `adb install` gets around it. A dry run
still builds an unsigned APK, which is enough to validate the build. To sign,
set these repository secrets:

| Secret | What |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |

### Locally

You need **JDK 21** and the Android SDK **platform 37** — `compileSdk` is 37
even though `targetSdk` stays 36, so platform 36 alone will not build. Nothing
pins `buildToolsVersion`; AGP resolves its own. The
Gradle wrapper jar is not committed — it is a binary that cannot be reviewed in
a diff — so generate it once with a system Gradle **9.7.0**:

```bash
cd android-native
echo "sdk.dir=/path/to/Android/sdk" > local.properties
gradle wrapper --gradle-version 9.7.0    # once, needs Gradle 9.7.0 on PATH
./gradlew testDebugUnitTest lintDebug assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

The debug APK lands at `app/build/outputs/apk/debug/app-debug.apk` (~17 MB).
It is signed with the standard Android debug key, so it installs on a phone
with *Install unknown apps* enabled — no keystore needed to try it.

> **AGP decides the Gradle version. It does not decide the Kotlin one.** AGP
> 9.3.1 requires Gradle ≥ 9.5, so the wrapper is pinned to 9.7.0 in
> `gradle/wrapper/gradle-wrapper.properties` — the single place that number
> appears, which CI reads rather than repeats. Invoke a system Gradle that
> disagrees, directly rather than through `./gradlew`, and configuration fails
> before the wrapper is ever consulted.
>
> Kotlin is different, and this note used to claim otherwise. From AGP 9 the
> compiler is built in, so applying `org.jetbrains.kotlin.android` alongside it
> *is* a build failure — but the version AGP ships is a default, not a pin. The
> two compiler plugins in the root `build.gradle.kts` select the compiler
> through the Build Tools API, so the number they name is the one that compiles
> the app. They must agree with each other, and the Kotlin-compiled libraries
> below them must not get ahead of *them*.

> **`compileSdk` is 37 and `targetSdk` is 36, deliberately.** `androidx.core`
> 1.19.0 declares `minCompileSdk=37`, and compiling against 37 only widens which
> APIs are available. `targetSdk` is the opt-in to new runtime behaviour, which
> is a change with its own testing rather than a dependency bump.

## Tests

`./gradlew test` covers the pieces with logic worth pinning:

- **`ServerUrlTest`** — the private-range rule. Android's network security
  config cannot express CIDR ranges, so the "plain http only for a LAN
  address" rule is enforced in code; these tests are what keeps a typo from
  sending habit data to a public host in the clear.
- **`RemindersTest`** — next-occurrence scheduling, including both DST
  transitions. A reminder is a wall-clock promise: 08:30 must stay 08:30
  across a clock change, which computing in UTC millis would silently break.
  It also pins the destination rule above, including that an *absent*
  `notifyChannels` means enabled while an *empty* one means off — and
  `needsReminder`, which decides whether a day has been answered. That one
  mirrors `answeredIds` in `shared/src/notify.js` case for case: a completion or
  a skip is an answer, a partial amount or an explicit "no" is not. It used to
  ask whether a row existed for the day, which silenced the phone on days the
  server was still asking about. And `snoozeUntil`, which is the other half of
  the DST question: a reminder time is a wall-clock promise, while "in an hour"
  is a duration — so on the night the clocks go back a snooze is one hour later
  and not two. It refuses rather than re-dates when the hour would leave the day
  the reminder is about, including the case that reads as a judgement call and
  is not: a press at 00:30 on a notification still in the shade from yesterday.
- **`ReminderWiringTest`** — the wiring between those decisions and the
  platform, and the first suite here to need Robolectric. What AlarmManager
  was actually handed (a snooze must ADD an alarm, never re-point the daily one)
  and what the Notification actually carries (the buttons, in order, each
  naming the day it is about). It exists because pinning the decision is not
  pinning the wiring: two reviews broke four rules apiece one line below the
  pure functions that pin them, with every other test green.
- **`ReminderActionsTest`** — which buttons a reminder offers and in what order.
  Pulled out of the builder because a decision that exists only inside
  `addAction` calls cannot be tested, and every wrong arrangement of it still
  posts a perfectly good notification. The tail is what the shade drops, so the
  order decides which button a user does not get.
- **`ReminderTimeTest`** — the time parser, case for case with
  `shared/test/time.test.js`. Two parsers with one contract only stay honest if
  both are held to the same examples; `12 am` versus `12 pm` is the one that
  catches every hand-rolled converter.
- **`GridTest`** — the day grid's arithmetic, pulled out of Compose because
  these rules only misbehave on a real phone mid-gesture: which end today sits
  at, what a tap cycles to, when the far edge should load more history, and the
  scroll correction that keeps a prepended month from sliding the grid sideways.
- **`ScrollRestoreTest`** — a restored scroll position that no longer fits the
  list. The version inlined in the screen only covered a clipped *first* row.
- **`HabitEntryTest`** — what a stored day means, including the one that has bit
  this project twice: a bare `3` is a skip for a yes/no habit and a real amount
  for a measurable one.
- **`AuthTest`** — what `GET /api/me` is saying, pinned to the same cases as
  `shared/public/auth-session.js`. Only 200 and 401 say anything about how an
  instance authenticates; a 429, a proxy's 502 or a captive portal's HTML is a
  fault, and reading one as a statement is how the web app once replaced a
  working instance with a sign-in form whose only control 404s.
- **`OutboxRetryTest`** — which refusals a queued check-off gives up on. 401 and
  403 are not among them: they are about the session rather than the write, and
  the answer is still true when it comes back.
- **`AppSettingsDefaultsTest`** — the Kotlin half of `shared/test/settings.test.js`'s
  job. `GET /settings` returns only the keys that have been *stored*, so every
  client has to supply the same default or the two disagree about what the
  account is set to. It reads the registry and fails on a drift; the one that
  catches you is `historyGranularity`, whose default is `week` and is the only
  default that is not the first option in its own list.
- **`WebBackStackTest`** — the three ways a habit page can be reached and what
  Back must then do. Note what it cannot prove: it pins arithmetic, and every
  bug here has been in the *premise* — which entry the load lands on, and when.
  Verify a change to it on an emulator, not against this suite.
- **`HabitAmountTest`** — the box a target is typed into and the number that
  goes over the wire. A target of `0` is a legal habit meaning "no target", so
  text that fails to parse and falls back to zero stores cleanly, draws
  normally, and can never be met.
- **`WidgetTest`** — what only the home-screen widget has: a record that names
  the day it is about, a tap judged against TODAY rather than against whatever
  the widget was last drawn with, a habit that has left the account, the ids a
  restore hands out, and the three ways a record can become unreadable. The
  cycle and the encoding are `GridTest`'s and are not repeated. Note what it
  cannot prove — that anything redraws the widget at midnight. That is a
  premise, and premises here are verified on an emulator.
- **`HabitOrderTest`** — the reorder arithmetic, which fails invisibly: the
  phone posts the whole order and each index becomes a `position`, so an
  off-by-one stores a wrong order that the web app then faithfully agrees with.

### The ones that render a screen

Three suites RENDER a composable, on the JVM, under Robolectric plus
`androidx.compose.ui:ui-test-junit4`. They exist because everything above pins a
decision and none of it can see a screen: a rule that lives in a `@Composable`
was verified by a person on an emulator once and never again, which is issue
\#110. `createComposeRule` needs `@Config(application = android.app.Application::class)`
— `HabiterallApp.onCreate` initialises WorkManager and will not run under
Robolectric — and the `isIncludeAndroidResources` the reminder suite already set.
Omitting the `@Config` fails loudly rather than subtly: every test in the class
throws from `WorkManagerImpl`, so there is no version of this that quietly tests
a different application.

One trap is worth knowing before you spend an hour on it: **a real `AlertDialog`
under `createComposeRule` hangs `waitForIdle` indefinitely.** A dialog is its own
window and the rule waits on a composition that never goes idle, so there is no
timeout and no failure — the test simply never returns. That is why
`ReminderTimeFieldTest` asserts the reminder field's layout at a fixed width
standing in for a dialog's, rather than putting it in one.

- **`SettingsScreenTest`** — that the chip drawn as selected is the ACCOUNT's
  default rather than one written at the call site, that a chip already selected
  writes nothing, and that a key the server answered 200 and then *ignored* is
  explained instead of springing back. The first two are one defect: a wrong
  default is not merely wrong, it is unreachable, because the control that would
  fix it is the one that does not fire. `AppSettingsDefaultsTest` pins the
  constant; only this can say the screen asks for it.
- **`ReminderTimeFieldTest`** — the accessibility rule from #105 (an unparseable
  time announces what a time looks like, rather than Material's generic "Invalid
  input"), that blank is *no reminder* and not a mistake, that a typed odd minute
  reaches the menu instead of being rounded, and that the quick picks wrap. That
  last one is a LAYOUT rule and the only one here; read its comment before
  changing it, because a `Row` does not overflow — it squeezes, so the button
  that has been made unreachable is still inside the bounds and still 52dp tall.
- **`ArchiveScreenTest`** — that a restore made before tapping Edit travels with
  the hand-off (the form REPLACES this screen, so `onClose` never fires), and
  that a load which failed does not go on to say the archive is empty.

What these still cannot prove is a premise, exactly as `WebBackStackTest` and
`WidgetTest` cannot: Robolectric renders and measures, it does not draw, and it
is not a phone.

The habit list is deliberately **not** among them, and the reason is worth
knowing before reaching for a fourth suite. Its two rules worth pinning — that
the resume snap-to-top defers while a notification tap is pending, and that the
pending habit is cleared once a fetch lands whether or not the habit was *found*
— live in `MainActivity.HabitListScreen`, which is `private` and reaches
`settings`, `Reminders`, `WidgetSync` and `Outbox` through the activity: nine
call sites, four on `settings` and five on `this@MainActivity`. Rendering it
means first making it a top-level composable with all of that injected, which is
a refactor of the screen under test in a change whose subject is tests. The rule
is also a lifecycle race, so it wants a real RESUMED transition and not just a
rendered tree.

`Api` is deliberately **not** in that list, and it is the item that makes the
extraction harder rather than easier. It is built inside the composable — `val
api = remember(serverUrl, onUnauthorized) { Api(serverUrl, onUnauthorized) }` —
out of two of the screen's own parameters, so there is no collaborator being
reached for and no seam to inject one at. Whoever plans this by counting what
the screen takes from the activity will find a fifth dependency that has to be
*created* before it can be replaced. Worth doing, and worth doing as its own
change.

## Roadmap

- The other widgets Loop ships — frequency, score, history. The checkmark is
  the one that replaces opening the app, and it is done
- Porting individual screens from web to native where it clearly helps
