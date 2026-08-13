# CI setup

What each workflow needs before it will run green.

**Short version: `ci.yml` needs nothing.** Push the repo and every test runs.
Only the two Android workflows need configuring, and only for *signed*
release builds — unsigned APKs and all the tests work with no setup at all.

## The workflows

| Workflow | Runs on | Publishes | Needs setup |
|---|---|---|---|
| `ci.yml` | every push and PR | nothing | **nothing** |
| `android-native.yml` | PRs and pushes touching `android-native/` | nothing | only to sign |
| `android-release.yml` | PRs and pushes touching `android/` | nothing | `TWA_HOST` + signing |
| `release.yml` | **a `vX.Y.Z` tag**, or manual | APKs, images, a GitHub release | nothing (each part skips itself) |

### Releasing

**Merging does not release.** Every merge to `master` runs the tests and stops
there. A release is a decision, and tagging is how it is taken:

```bash
git tag v1.4.0 && git push origin v1.4.0
```

That runs `release.yml`, which:

1. derives the version from the tag, and an Android `versionCode` from it
   (`1.4.0` → `10400`, monotonic by construction);
2. runs the whole test suite again — tagging a commit whose tests never ran is
   the failure a release pipeline exists to prevent;
3. builds the native APK and the TWA APK, both stamped with that version;
4. builds both Docker images and pushes `1.4.0`, `1.4` and `latest`;
5. writes release notes listing every commit since the previous `v*` tag,
   grouped by subject prefix, with anything unprefixed under *Other* rather
   than dropped;
6. creates the release with the APKs attached.

To try it without publishing, use **Actions → Release → Run workflow** and leave
*dry_run* ticked: everything builds, nothing is pushed, and the summary lists
what would have been attached.

Each part degrades on its own. No `DOCKERHUB_*` secrets means images are built
but not pushed. No keystore means the APKs are unsigned (still sideloadable). No
`TWA_HOST` means no TWA asset. The release still succeeds and says which parts
were skipped.

### `ci.yml` — the main suite

Seven jobs, all self-contained. Postgres comes from a service container, Chrome
is preinstalled on the runner, and the personal edition is started by the
workflow itself.

| Job | What it proves |
|---|---|
| Unit tests | scoring, streaks, resilience, validation, Loop encoding |
| Type check | JSDoc types via `tsc --noEmit` |
| Browser suites | real Chrome, 360–1440px, against a running server |
| Multi-tenant isolation | adversarial: tries to reach another user's data |
| Cloud API | routes and the import writer, against real Postgres |
| Backup round-trip | export every format, re-import, assert nothing changed |
| Docker images | both editions build and boot |

No secrets. No variables. Nothing to enable beyond Actions itself.

### Publishing Docker images (optional)

`release.yml` pushes both editions to Docker Hub, and only for a release. It is
**skipped entirely** when credentials are absent — the images are still built,
which is what proves the Dockerfiles work, and the summary explains what to set.
So you can ignore this section until you actually want published images.

This used to live in `ci.yml` and fire on every merge, which made every merge a
release of `latest`.

It only runs on a push to `main` or a `v*` tag, never on a pull request.

| Kind | Name | Required |
|---|---|---|
| Secret | `DOCKERHUB_USERNAME` | to publish |
| Secret | `DOCKERHUB_TOKEN` | to publish — an *access token*, not your password |
| Variable | `DOCKERHUB_NAMESPACE` | optional; defaults to the username |

Create the token at **Docker Hub → Account Settings → Personal access
tokens**, scoped *Read & Write*. Set `DOCKERHUB_NAMESPACE` only if you publish
under an organisation rather than your own account.

Images are built for **linux/amd64 and linux/arm64**, so the personal edition
runs on a Raspberry Pi as well as a normal server:

```
<namespace>/habiterall-personal:latest
<namespace>/habiterall-cloud:latest
```

Tagging follows the ref: `main` publishes `latest`, and a tag like `v1.2.3`
publishes `1.2.3`, `1.2`, and a short-SHA tag, so a deployment can pin as
tightly as it likes.

```bash
git tag v1.0.0 && git push origin v1.0.0
```

> Docker Hub's free tier allows unlimited public repositories and one private
> one. Both images are pushed as whatever visibility the repository has on
> Docker Hub — create them there first if you want them private.

### `android-native.yml` — the native client

On a PR touching `android-native/` it runs the unit tests, lints, and uploads a
**debug APK** as a build artifact. That path needs no configuration.

Signing is optional: with no `ANDROID_KEYSTORE_BASE64` secret the release build
still succeeds and produces an **unsigned** APK, which installs fine via
`adb install`. Set the four secrets below only when you want a signed one.

### `android-release.yml` — the TWA wrapper

This one **does** need configuration, because a Trusted Web Activity is bound
to a specific domain: it must know which host it is wrapping, and the app must
be signed so that host can vouch for it.

## Repository variable

*Settings → Secrets and variables → Actions → **Variables** → New variable*

| Name | Value | Notes |
|---|---|---|
| `TWA_HOST` | `habits.example.com` | Hostname only — no `https://`, no trailing path. The workflow rejects both rather than producing a silently broken manifest. |

You can skip this and pass the host as an input on a manual run instead.

## Repository secrets

*Settings → Secrets and variables → Actions → **Secrets** → New secret*

| Name | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the keystore file, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |

Both Android workflows read the same four, so one keystore covers both apps.

### Generating a keystore

Once, on your own machine:

```bash
keytool -genkeypair -v \
  -keystore habiterall.keystore \
  -alias habiterall \
  -keyalg RSA -keysize 2048 -validity 10000
```

Then base64 it for the secret:

```bash
base64 -w0 habiterall.keystore          # Linux
base64 -i habiterall.keystore | tr -d '\n'   # macOS
certutil -encode habiterall.keystore tmp.b64 && findstr /v CERTIFICATE tmp.b64  # Windows
```

> **Keep the keystore file.** Losing it means you can never ship an update that
> installs over an existing copy — Android identifies an app by its signature,
> and a differently-signed APK is a different app. Back it up somewhere other
> than this repository, and never commit it (`*.jks` and `*.keystore` are
> gitignored).

## Digital Asset Links (TWA only)

For the TWA to launch without a URL bar, your server must serve a file at
`https://<TWA_HOST>/.well-known/assetlinks.json` naming your signing key's
SHA-256 fingerprint. Both editions already serve that path; you supply the
content. See [`android/SETUP.md`](../../android/SETUP.md) — the workflow prints
the exact JSON to paste, so run it once and copy from the log.

The native app needs none of this: it is an ordinary app, not a wrapper around
your domain.

## Triggering a release

```bash
git tag android-v0.1.0
git push origin android-v0.1.0
```

Both Android workflows fire on `android-v*` tags and attach their APK to the
GitHub release. Or run either manually from the **Actions** tab —
`android-native.yml` takes a *release* checkbox, `android-release.yml` takes an
optional host override.

## If a run fails

- **`gradle wrapper` fails during configuration** — the Gradle version is
  pinned in both `setup-gradle` and `gradle/wrapper/gradle-wrapper.properties`.
  They must agree, and must be a version the pinned AGP supports (AGP 8.x does
  not support Gradle 9).
- **"Compose Compiler Gradle plugin is required"** — from Kotlin 2.0 the
  Compose compiler is a separate plugin whose version must match Kotlin's
  exactly. `composeOptions.kotlinCompilerExtensionVersion` is the pre-2.0
  mechanism and is now a configuration error.
- **Browser suites fail but pass locally** — check
  `shared/test/browser/fixtures.mjs` first. Several "failures" have been stale
  test data, and a cached service worker can serve old CSS.
- **`TWA_HOST` errors** — the value must be a bare hostname. A scheme or path
  is rejected deliberately, because either produces a manifest that builds fine
  and then fails verification on the phone.
