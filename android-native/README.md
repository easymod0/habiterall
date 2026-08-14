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
| **Native** | notifications with Yes / No / count actions, per-habit reminders, the day grid and everything you can record in it, server settings |
| **Embedded web** | stats, charts, the calendar, import/export |

Individual screens can be ported to native later if any of them feel wrong.
Nothing about this design forces the split to stay where it is.

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
a diff — so generate it once with a system Gradle **8.14.3**:

```bash
cd android-native
echo "sdk.dir=/path/to/Android/sdk" > local.properties
gradle wrapper --gradle-version 8.14.3    # once, needs Gradle 8.14.3 on PATH
./gradlew testDebugUnitTest lintDebug assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

The debug APK lands at `app/build/outputs/apk/debug/app-debug.apk` (~17 MB).
It is signed with the standard Android debug key, so it installs on a phone
with *Install unknown apps* enabled — no keystore needed to try it.

> **Gradle 9 does not work.** AGP 8.x caps out at Gradle 8, and the version
> here is pinned in `gradle/wrapper/gradle-wrapper.properties`. If you invoke a
> newer system Gradle directly rather than through `./gradlew`, configuration
> fails before the wrapper is ever consulted.

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
