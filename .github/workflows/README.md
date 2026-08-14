# CI setup

What each workflow needs before it will run green.

**Short version: `ci.yml` needs nothing.** Push the repo and every test runs.
The only thing that needs configuring is APK **signing**, and only for a
publishing release — every test, and the debug APK the Android workflow
uploads, work with no setup at all.

## The workflows

| Workflow | Runs on | Publishes | Needs setup |
|---|---|---|---|
| `ci.yml` | every PR, and nightly at 05:17 UTC | nothing | **nothing** |
| `android-native.yml` | every PR (it builds only if the client can be affected), and nightly at 06:17 UTC | nothing | **nothing** |
| `codeql.yml` | every PR and every push to `master` (each language only if it can be affected), and weekly at 06:47 UTC Monday | code scanning alerts | **default setup must stay off** |
| `release.yml` | **a `vX.Y.Z` tag**, or manual | the APK, images, a GitHub release | signing, and only for a publishing run |

### Releasing

**Merging does not release.** It no longer runs `ci.yml` either: the tests ran
on the pull request, where they are *required*, against a branch the ruleset
forced up to date with master first — so the tree that merged is the tree that
was tested. A release is a decision, taken either from the Actions tab —
**Release → Run workflow** — or by tagging:

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
6. creates the release with the APK attached.

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
| documentation only | nothing but the three change detectors (~5s) |
| workflow configuration only | the detectors, and `Analyze (actions)` |
| any code, anywhere | the whole of `ci.yml` |
| `android-native/**`, or a shared file the Kotlin client mirrors | the Android workflow as well |
| a `.js` / `.ts` file, or `package.json` | `Analyze (javascript-typescript)` |
| `android-native/**` | `Analyze (java-kotlin)` — a full client build |
| `.github/workflows/*.yml` | `Analyze (actions)` |
| — a merge to `master` | the same three, gated the same way |
| — the nightly schedule | everything in both workflows, unconditionally |
| — the weekly schedule | all three CodeQL languages, unconditionally |

Four deliberate choices in there.

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

**`ci.yml` lost its push-to-master trigger, and gained a nightly.** These are not
the same trade. The post-merge run existed because a pull request proves "this
branch against the base as it was when the run started" and not "master after
the merge" — but the ruleset now requires a pull request, allows only squash,
requires every `ci.yml` job, and requires the branch to be up to date first, so
the tested tree *is* the tree that lands. Re-running was testing the same commit
under a second name.

The nightly replaces none of that; it catches a different class entirely — the
failures that arrive with **no commit at all**. The runner's preinstalled Chrome
moves under the browser suites, the docker job's base images move, `ubuntu-latest`
migrates, an `actions/*` node runtime deprecates, the Postgres service tag moves.
No push-triggered run can catch those, because nothing in the repository changed.
Found nightly they are one morning's known breakage; found during an unrelated
pull request they get **attributed to that pull request**, which is the expensive
way to learn it. Daily because those inputs drift over days, not hours; at `:17`
because GitHub queues and delays `0 * * * *`.

> Scheduled workflows are **disabled automatically after 60 days of repository
> inactivity**, public repositories included. If the nightly quietly stops, that
> is the first thing to check.

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

Every job pins **Node 26**, the same major as both Dockerfiles and the
`engines` floor. The three move together on purpose: a Dockerfile bump that
leaves the pins behind ships a runtime no job ever ran.

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

### Required checks on `master`

A repository **ruleset** (Settings → Rules) guards the default branch. It is
what makes the absent push-to-master trigger safe, so the two are one decision:

| Rule | Setting |
|---|---|
| Pull request required | yes — so there are no direct pushes to `master` |
| Approvals | 0, and no CODEOWNERS — a solo maintainer cannot approve their own PR |
| Merge methods | squash only |
| Branch up to date before merging | **yes** (`strict`) — this is the load-bearing one |
| Bypass actors | **none**, admins included |
| Force push / deletion | blocked |

The required checks are every job in both workflows:

```
What changed              Multi-tenant isolation
Unit tests                Cloud API (Postgres)
Type check                Backup round-trip (personal)
Browser suites            Docker images

Android — what changed    Build APK
```

Three things about that list are easy to get wrong.

**Requiring `Build APK` is what forced `android-native.yml`'s shape.** It used to
filter `pull_request` at the *workflow* level with `paths:`, and a workflow
filtered that way does not run at all when nothing matches — it reports no
status, so a required check on it sits **Pending forever** and the pull request
can never merge. The filter therefore had to move down into an
always-running `Android — what changed` job before the check could be required.
That order is the whole trick, and it is the same one `ci.yml` uses.

**A skipped job passes, and that is the documented behaviour** — "a job that is
skipped will report its status as `Success`. It will not prevent a pull request
from merging, even if it is a required check." That is precisely why the
expensive jobs are gated with a job-level `if:`: on a docs-only pull request they
all report Success and it merges. Skipping a whole *workflow* is the opposite,
per above.

**Both detectors are required for a reason that is not obvious.** A job skipped
because a job it `needs` *failed* also reports Success. So if a detector ever
dies — a checkout error, the script tripping `set -euo pipefail` — every job
behind it skips, each reports Success, and an untested pull request goes green.
Requiring the detector itself is what turns that silent pass into a red check.
If the list is ever trimmed, `What changed` and `Android — what changed` are the
entries that cannot go.

> Adding a job to `ci.yml` does **not** add it to this list. Add the new job
> name to the ruleset too, or it runs and is allowed to fail.

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

Its detector runs on every PR; the build itself runs when the change can affect
the client — `android-native/**`, this workflow, or one of the shared files the
Kotlin code mirrors by hand. It then runs the unit tests, lints, and uploads a
**debug APK** as a build artifact. It never publishes and it needs no
configuration: a debug APK carries the standard Android debug signature and
installs anywhere. Nightly it builds regardless.

**The mirrored-file list lives in the detector's `grep`, not in a `paths:`
filter,** and that is the only place it lives now. Keep it in step with the
Kotlin side: `types.js` / `constants.js` are the REST contract, `ui/time.js` is
`ReminderTime.kt`'s twin, `notify.js` backs `AppSettings.androidRemindersEnabled`,
`validate.js` holds the reminder-prompt cap. A shared file the app copies that is
not matched there can break the client with nothing to catch it.

**`Build APK` is a required check, so a red client blocks a merge.** That is new,
and it is why this workflow no longer runs on a push to `master` — the gate moved
to the pull request, where it can actually stop something.

**The release APK is `release.yml`'s, and signing it is required.** With no
`ANDROID_KEYSTORE_BASE64` secret the Gradle build still succeeds, but what it
produces is an **unsigned** APK — and Android will not install one under any
circumstances. It is rejected by the package manager itself
(`INSTALL_PARSE_FAILED_NO_CERTIFICATES`), so neither *Install unknown apps* nor
`adb install` gets around it; the user just sees "App not installed".

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

### `codeql.yml` — static analysis

Scans `javascript-typescript`, `actions` and `java-kotlin`, and needs no
configuration — but it is the one workflow here with a setting outside the
repository that has to stay a particular way.

**Default setup must remain disabled** (Settings → Code security → CodeQL
analysis). This workflow is an *advanced* configuration, and the two cannot
share a repository: with default setup enabled the analysis runs, succeeds, and
has its results **rejected** at the upload with `CodeQL analyses from advanced
configurations cannot be processed when the default setup is enabled`. Nothing
about the failure points at a setting rather than at the code, which is the
reason it is written here. Splitting languages between the two is only possible
through an organisation-level code security configuration.

It exists as a file at all because default setup could not build the native
client. Default setup analyses Kotlin with `autobuild`, which selects the JDK
the Android plugin *recommends* — 17 — while `app/build.gradle.kts` compiles at
source level 21, so every run died on `error: invalid source release: 21` with
nowhere to add a `setup-java`. Moving to a file fixed that and forced javascript
and actions to move too, per above.

Three things about the `java-kotlin` job are load bearing.

**Kotlin has to be compiled for real.** `build-mode: none` is how the other two
languages are analysed without a build, and it does not support Kotlin — it
reports the language unsupported and extracts nothing.

**A cached build teaches it nothing**, and this fails in a way that reads like a
configuration error. `gradle.properties` sets `org.gradle.caching=true`, so
`compileDebugKotlin` and `compileDebugJavaWithJavac` come back FROM-CACHE and
their outputs are unpacked without a compiler ever running — and tracing that
compiler is precisely how CodeQL learns what the code is. The symptom is
`BUILD SUCCESSFUL in 16s` followed by *"could not process any code written in
Java/Kotlin"*. Hence `--no-build-cache`, on this invocation only: dependency
caching is untouched, and `android-native.yml` keeps its cache hits because a
cached build still proves the client builds.

**Its toolchain is `android-native.yml`'s**, deliberately — same JDK 21, same
read-the-version-then-generate-the-wrapper pair of steps, for the same reasons
documented there. Both now read the number out of `gradle-wrapper.properties`
instead of stating it, which is what stops the two drifting apart and the client
quietly ceasing to be scanned while every check stays green.

Unlike `ci.yml` and `android-native.yml`, this one **does** run on a push to
`master`, and not for symmetry with anything. Code scanning treats the default
branch as the source of truth: a pull request run annotates that pull request,
but only a default-branch run updates the Security tab. Drop the trigger and the
alert list silently freezes at whatever master last said.

### What CodeQL analyses, and when it does not

Each language is gated separately by a `CodeQL — what changed` detector, on the
same job-level `if:` as everywhere else here — a workflow-level `paths:` filter
reports no status at all, and these checks should stay requirable.

| Changed | Analyses |
|---|---|
| a `.js` / `.mjs` / `.ts` file anywhere, or `package.json` | `javascript-typescript` |
| anything under `android-native/` | `java-kotlin` |
| `.github/workflows/*.yml`, or a composite action | `actions` |
| `codeql.yml` itself | all three |
| documentation only | none |

Three of those lines are less obvious than they look.

**The split is by extension, not by directory** — a fourth workspace would
otherwise go unscanned until somebody remembered to add it to a path list, and
nothing would say so.

**The Actions rule is `.github/workflows/*.yml`, not `.github/`.** The README you
are reading sits in that directory, and a change to it should analyse nothing. A
`^\.github/` rule re-runs the job for its own documentation, which is the case
that prompted the gating.

**The Kotlin rule is the whole of `android-native/`, deliberately coarse.** The
manifest decides which components are exported and the Gradle files decide what
is on the classpath, so both change what the Android queries find. Being wrong in
this direction costs one build; being wrong in the other loses a finding in
silence. Note it is **not** the shared-JS list `android-native.yml` keeps: that
workflow tests behavioural *mirroring*, so `ui/time.js` reaching `ReminderTime.kt`
matters to it, while this one only reads Kotlin.

**What makes gating safe is the weekly run.** A skipped language is not an
unscanned one — alerts are only ever closed by an analysis that runs and does not
find them, never by one that did not run, so the existing results simply stand
until the next analysis. And the case gating cannot cover is the case no
push-triggered run covers either: CodeQL's queries move without any commit here,
so Monday's sweep is what finds tomorrow's rule in code that has not changed
since. Same argument as `ci.yml`'s nightly, one rung slower because query packs
change over weeks rather than days.

The `Analyze` jobs are **not** required checks. A finding is a judgement call —
several of the open alerts are false positives that no fix would clear — so a
red one should not block a merge the way a failing test does.

## Triggering a release

```bash
git tag v1.4.0
git push origin v1.4.0
```

`release.yml` is the only workflow that publishes anything, and a `vX.Y.Z` tag
— or **Actions → Release → Run workflow** — is the only thing that starts it.
`android-native.yml` has no tag trigger at all: it builds and tests the client
on every PR that touches it, and stops there. There is no separate Android
release tag; the APK is versioned and attached by the same run that publishes
the images.

## If a run fails

- **`gradle wrapper` fails during configuration** — that step configures the
  project under the Gradle `setup-gradle` installed, before the wrapper it
  writes is ever used, so that Gradle has to be one the pinned AGP supports
  (AGP 9.3 requires ≥ 9.5). It is read from
  `gradle/wrapper/gradle-wrapper.properties` for exactly this reason: the
  version used to be written there *and* in three workflows, and a Dependabot
  bump of the properties file was then guaranteed to be red. A
  `NoClassDefFoundError` naming a `org.gradle.*` class is this and nothing else
  — a new AGP asking an old Gradle for a class it does not have.
- **"Compose Compiler Gradle plugin is required"** — from Kotlin 2.0 the
  Compose compiler is a separate plugin whose version must match Kotlin's
  exactly. `composeOptions.kotlinCompilerExtensionVersion` is the pre-2.0
  mechanism and is now a configuration error.
- **A `kotlin` extension is declared twice, or Kotlin metadata is "an
  incompatible version"** — AGP 9 has built-in Kotlin, so it *is* the Kotlin
  version (2.2.10 for AGP 9.3.1). Applying `org.jetbrains.kotlin.android`
  alongside it fails outright, and a library compiled by a later Kotlin cannot
  be read at all. Both look like broken artifacts and are really one ceiling —
  the one Dependabot cannot see, because it bumps the Kotlin plugins to the
  newest Kotlin published.
- **Every `Analyze` job fails at the upload** — "CodeQL analyses from advanced
  configurations cannot be processed when the default setup is enabled".
  Nothing is wrong with the code or the workflow: default setup has been turned
  back on. Disable it under Settings → Code security.
- **`Analyze (java-kotlin)` says "could not process any code"** after a green
  build — the compile tasks were a cache hit, so no compiler ran for CodeQL to
  trace. Check for `--no-build-cache` on the Gradle invocation, and for
  `from cache` in the build step's task list.
- **Browser suites fail but pass locally** — check
  `shared/test/browser/fixtures.mjs` first. Several "failures" have been stale
  test data, and a cached service worker can serve old CSS.
  is rejected deliberately, because either produces a manifest that builds fine
  and then fails verification on the phone.
