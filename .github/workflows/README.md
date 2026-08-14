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
| `release.yml` | **a `vX.Y.Z` tag**, or manual | APKs, images, a GitHub release | nothing (each part skips itself) |

### Releasing

**Merging does not release.** Every merge to `master` runs the tests and stops
there. A release is a decision, taken either from the Actions tab — **Release →
Run workflow** — or by tagging:

```bash
git tag v1.4.0 && git push origin v1.4.0
```

From the Actions tab the *version* box is optional:

| version | releases |
|---|---|
| *(blank)* | the next **patch**, derived from the highest `vX.Y.Z` tag — `1.4.0` → `1.4.1` |
| `1.5.0` | exactly that |

Patch is automatic because it is the common case, and typing it is the one place
a release can silently go backwards. Major and minor are judgement calls, so
they stay manual. Pre-releases (`v1.5.0-rc1`) are never used as the base for a
bump and never produced by one — pass a version for those.

Either route runs `release.yml`, which:

1. derives the version from the tag, and an Android `versionCode` from it
   (`1.4.0` → `10400`, monotonic by construction);
2. runs the whole test suite again — tagging a commit whose tests never ran is
   the failure a release pipeline exists to prevent;
3. builds the native APK, stamped with that version;
4. builds both Docker images and pushes `1.4.0`, `1.4` and `latest` — the
   moving `X.Y` tag only from `1.0.0` up, since under semver a `0.x` series
   promises no compatibility for it to stand for;
5. writes release notes listing every commit since the previous `v*` tag,
   grouped by subject prefix, with anything unprefixed under *Other* rather
   than dropped;
6. creates the release with the APKs attached.

To try it without publishing, use **Actions → Release → Run workflow** and leave
*dry_run* ticked: everything builds, nothing is pushed, and the summary lists
what would have been attached.

Most parts degrade on their own. No `DOCKERHUB_*` secrets means the images go
to GHCR only — which needs no secrets at all, so images are published either
way. The release still succeeds and says which parts were skipped.

Signing is the exception: **a publishing run with no keystore fails.** An
unsigned APK cannot be installed on any device, so degrading there would mean
attaching a file nobody can use. A dry run still builds one, which is enough to
validate the build.

### What runs when

| A pull request touching | runs |
|---|---|
| documentation or workflow config only | nothing but the change detector (~5s) |
| any code, anywhere | the whole of `ci.yml` |
| `android-native/**`, or a shared file the Kotlin client mirrors | the Android workflow as well |
| a push to `master` | everything, always — that run is what says master is releasable |

Two deliberate choices in there.

**The expensive `ci.yml` jobs are filtered by a job-level `if:`, not by a
workflow-level `paths:`.** A workflow skipped by `paths` never reports a status,
so a *required* check on it waits forever for a run that will never arrive, and
the pull request can never merge. A job skipped by `if:` reports "skipped", which
branch protection accepts. If you add branch protection later, this is the
difference between it working and it wedging every docs PR.

**All or nothing, not a middle.** Even the unit tests and the type check are
gated. They only take twenty seconds, so leaving them on was tempting — but a
change to `release.yml` cannot make `npm test` fail, and running it anyway is
theatre. What makes this safe is that the detector is not asked to be clever: a
pull request that touches *one line* of code anywhere runs the entire suite, so
the only way to skip anything is to have changed nothing but prose and workflow
config.

**No per-directory matrix.** It looks tempting — only test the edition that
changed — and it would be false precision here: the browser suites drive a real
personal-edition server, and the Postgres jobs exercise `shared/src` through the
cloud edition. The honest split is "docs and workflow config" against "code", and
that is what is implemented. A change to `ci.yml` itself always runs everything,
or a broken pipeline merges green.

The Android workflow's path list names the shared files the Kotlin client mirrors
**by hand** (`ui/time.js` against `ReminderTime.kt`, `notify.js` against
`AppSettings`). That list and those mirrors have to be kept in step: a shared file
the app copies and that is not listed is a change that can break the client with
nothing to catch it.

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

### Publishing images — nothing to configure

`release.yml` publishes both editions to **GitHub Container Registry**, and only
for a release:

```
ghcr.io/<your-github-owner>/habiterall-personal:1.4.0   (and :1.4, :latest)
ghcr.io/<your-github-owner>/habiterall-cloud:1.4.0
```

**No secrets.** The workflow's automatic `GITHUB_TOKEN` can push to GHCR given
`packages: write`, which the job asks for. That is why GHCR is the default: a
fresh clone of this repository can publish images without its owner configuring
anything, which was never true of Docker Hub.

Built for **linux/amd64 and linux/arm64**, so the personal edition runs on a
Raspberry Pi as well as a normal server.

> **If a pull asks for credentials**, the package is private — GitHub does that
> for a package published into some accounts. Open **Packages →
> habiterall-personal → Package settings → Change visibility → Public**, once,
> and it stays public for every later release. Verified for this repository:
> an anonymous `docker pull ghcr.io/easymod0/habiterall-personal:latest` works,
> so nothing needed doing here.

#### Docker Hub as well (optional)

Set both secrets and every image is pushed to Docker Hub *in addition* to GHCR.
Leave them unset and it is skipped, with a note in the run summary.

| Kind | Name | Purpose |
|---|---|---|
| Secret | `DOCKERHUB_USERNAME` | enables the Docker Hub push |
| Secret | `DOCKERHUB_TOKEN` | an *access token*, not your password |
| Variable | `DOCKERHUB_NAMESPACE` | optional; defaults to the username |

Create the token at **Docker Hub → Account Settings → Personal access tokens**,
scoped *Read & Write*. Set the namespace only if you publish under an
organisation rather than your own account.

This publishing used to live in `ci.yml` and fire on every merge, which made
every merge a release of `latest`.

### `android-native.yml` — the native client

On a PR touching `android-native/` it runs the unit tests, lints, and uploads a
**debug APK** as a build artifact. That path needs no configuration.

**Signing is required for a usable APK.** With no `ANDROID_KEYSTORE_BASE64`
secret the build still succeeds, but it produces an **unsigned** APK — and
Android will not install one under any circumstances. It is rejected by the
package manager itself (`INSTALL_PARSE_FAILED_NO_CERTIFICATES`), so neither
*Install unknown apps* nor `adb install` gets around it; the user just sees
"App not installed".

A publishing release therefore **fails** if the secrets are absent, rather than
attaching a file nobody can install. A dry run still builds an unsigned APK, so
the build itself can be validated without a keystore.

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

## Triggering a release

```bash
git tag android-v0.1.0
git push origin android-v0.1.0
```

Both Android workflows fire on `android-v*` tags and attach their APK to the
GitHub release. Or run either manually from the **Actions** tab —
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
  is rejected deliberately, because either produces a manifest that builds fine
  and then fails verification on the phone.
