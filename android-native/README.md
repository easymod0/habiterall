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
| **Native** | notifications with Yes / No / count actions, per-habit reminders, the habit list, quick check-offs, server settings |
| **Embedded web** | stats, charts, calendar editing, import/export |

Individual screens can be ported to native later if any of them feel wrong.
Nothing about this design forces the split to stay where it is.

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

Set a time per habit. The app schedules a local alarm, so a reminder fires
whether or not the phone has connectivity, and whether or not the server is
reachable.

Reminder times are stored **on the server** as a field on the habit, so they
follow your account to a new phone and the web UI can set them too.

Checking off from a notification while offline queues the write and retries
when connectivity returns — the same guarantee the web app's outbox gives.

## Building

CI builds the APK; see `.github/workflows/android-native.yml`. Nothing needs
installing locally.

- **Every PR touching `android-native/`** runs the unit tests and lint, and
  uploads a debug APK as a build artifact.
- **Pushing a tag matching `android-v*`** builds a release APK and attaches it
  to a GitHub release. A manual run with *release* ticked does the same
  without tagging.

Signing is optional. With no `ANDROID_KEYSTORE_BASE64` secret the release
build still succeeds and produces an **unsigned** APK, which is fine for
sideloading. To sign, set these repository secrets:

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

`./gradlew test` covers the two pieces with logic worth pinning:

- **`ServerUrlTest`** — the private-range rule. Android's network security
  config cannot express CIDR ranges, so the "plain http only for a LAN
  address" rule is enforced in code; these tests are what keeps a typo from
  sending habit data to a public host in the clear.
- **`RemindersTest`** — next-occurrence scheduling, including both DST
  transitions. A reminder is a wall-clock promise: 08:30 must stay 08:30
  across a clock change, which computing in UTC millis would silently break.

## Roadmap

- Cloud-edition sign-in (OAuth2 + PKCE via AppAuth)
- A home-screen widget
- Porting individual screens from web to native where it clearly helps
