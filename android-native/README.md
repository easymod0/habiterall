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

## Requirements

- **Android 8.0 (API 26)** or newer — notification channels and exact alarms
- A running **habiterall personal** server the phone can reach: a LAN address
  (`http://192.168.1.50:3000`) or a public HTTPS URL

> The cloud edition is not supported yet: it requires an OIDC sign-in flow
> the app does not implement. See [Roadmap](#roadmap).

## Setup

On first launch the app asks for your server URL. It accepts `http://` for a
LAN address and `https://` for anything public.

Plaintext HTTP is permitted only for private-range addresses
(`10.x`, `192.168.x`, `172.16–31.x`) via a network security config — a
public `http://` host is refused, because habit data should not cross the
internet in the clear.

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

- **Every PR touching `android-native/`**, and every push to `master`, runs the
  unit tests and lint and uploads a debug APK as a build artifact. That
  workflow never publishes.
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

You need **JDK 21** and the Android SDK (platform 36, build-tools 36). The
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
  server was still asking about.
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

## Roadmap

- Cloud-edition sign-in (OAuth2 + PKCE via AppAuth)
- A home-screen widget
- Porting individual screens from web to native where it clearly helps
