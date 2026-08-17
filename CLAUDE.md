# habiterall — working notes

A self-hosted habit tracker modelled on [Loop Habit Tracker](https://github.com/iSoron/uhabits),
in two editions sharing one core.

This file holds the rules that reach everywhere. Everything subsystem-specific
is in the `CLAUDE.md` nearest the code, and the long-form reasoning behind each
decision — how it was found, what was measured, which wrong version shipped
first — is in `docs/decisions/`, which is not loaded into context. Read the
archive before re-opening a decision; it usually already answers the objection.

## Layout

```
shared/               EVERYTHING both editions have in common
  src/                pure logic — no database, no HTTP, no DOM
  public/             the entire UI, plus the PWA (manifest, sw, offline queue)
  public/ui/          one module per view and dialog, over a shared store
  test/               unit tests + browser suites (test/browser/)
habiterall-personal/  single user, SQLite, optional password  (src/ + one entry point)
habiterall-cloud/     multi user, Postgres, OIDC     (src/ + one entry point)
android-native/       native Kotlin client — notification actions, and habits
```

One npm workspace. `shared` resolves as `@habiterall/shared/<file>.js`; the
browser gets the same files under `/shared/`. **No build step anywhere** —
what runs is what's on disk.

### What belongs where

- **`shared/`** — anything not coupled to storage or auth. The whole frontend
  lives here; each edition ships only `public/app-entry.js`, which calls
  `start()` with the one auth adapter.
- **Per edition** — storage (`db.js` / `db/pool.js`), auth, the import
  *writer* (`apply-import.js`), the notifier's storage adapter
  (`notifier.js`), and the API routes.

If you find yourself copying a file between editions, stop: it belongs in
`shared/` behind an adapter. That duplication has already bitten this project
once (~1,750 lines of frontend drifted apart before being merged back).

## Running it

```bash
npm install                 # once, at the root
npm test                    # unit tests, all workspaces
npm run test:browser        # UI suites — needs Chrome; starts its own servers
npm run test:tenancy        # cloud isolation attacks — needs Postgres

npm run typecheck           # JSDoc types via tsc --noEmit
npm run docs:compose        # rewrite the README's compose blocks from examples/
npm run test:cloud          # cloud API + Loop round trip — needs Postgres
npm run test:notify         # reminder delivery + its watermark, against SQLite
npm run test:roundtrip -w habiterall-personal   # backup fidelity, all formats

npm run start:personal      # http://localhost:3000
cd habiterall-cloud && docker compose up -d   # app :3100, Authentik :9000

cd android-native && ./gradlew testDebugUnitTest lintDebug assembleDebug
```

The native Android client needs JDK 21, Android SDK 37 and Gradle **9.7.0**
— see `android-native/README.md`. The wrapper jar is generated rather than
committed, so that version lives in `gradle-wrapper.properties` and CI reads it
from there. AGP 9.3.1 requires Gradle ≥ 9.5 and nothing in the build may
contradict that; Kotlin it only *defaults*, and the two compiler plugins in the
root `build.gradle.kts` are what actually choose the compiler. `compileSdk` is
37 while `targetSdk` stays 36 — the first is what `androidx.core` 1.19.0
demands, the second is a runtime-behaviour opt-in and a separate decision.

## Where the rest is written down

| working in | read | archive |
|---|---|---|
| `shared/src/` | `shared/CLAUDE.md` | `docs/decisions/day-states.md`, `awards.md`, `import-and-loop.md` |
| `shared/public/` | `shared/CLAUDE.md`, `shared/public/CLAUDE.md` | `dashboard-and-detail.md`, `routing.md`, `amounts.md`, `notifications-web.md` |
| `android-native/` | `android-native/CLAUDE.md` | `android.md`, `routing.md` |
| `habiterall-personal/` | `habiterall-personal/CLAUDE.md` | `auth.md` |
| `habiterall-cloud/` | `habiterall-cloud/CLAUDE.md` | `auth.md`, `connectivity.md` |
| reminders, any channel | `shared/CLAUDE.md` | `reminders.md`, `discord.md`, `timezones.md`, `outbound-urls.md` |
| `examples/`, compose, env | `examples/CLAUDE.md` | `compose-and-env.md` |
| settings, client mirrors | here, below | `settings-and-mirrors.md` |

## Rules that reach everywhere

**A day has four states, and the fourth is a missing row.** `done`, `skip`,
`no` (a row holding 0) and `unknown` (no row at all). `entryWrite`
(`shared/src/validate.js`) is the one rule for what a write does to storage and
it never deletes: `PUT {value: 0}` records a stated lapse, `DELETE` is how a day
goes back to unknown. Skips are stored out of band (`entries.status = 'skip'`,
never a magic value), because a numerical habit can legitimately record Loop's
SKIP sentinel of 3.

**Never write `entryMap.get(date) ?? UNSET`.** It collapses `no` and `unknown`,
which spend identically on an at-least habit and oppositely on an at-most one —
where it silently handed a limit nobody had logged an unbroken streak and a
strength climbing to 100%. Ask `normalizeEntry`, which answers
`status: 'unknown'` for a nullish entry, and let `isCompleted` / `dayCredit`
decide from that. Both take `{value, status}` for this reason.

**A stored lapse can move window-derived figures, and that is the model
working.** The score, the streaks and the completion count treat a 0 row and a
missing row alike, but ranges that *start* at the earliest stored entry grow
backwards when a lapse is imported, so every unknown day after it reads as a
miss. Say so before "fixing" it.

**Every date range is clamped** (`boundedRange`, `MAX_RANGE_DAYS`). Ranges
derived from *stored* data are attacker-controlled: one entry dated year 0100
once made a single request block the event loop for 32 seconds. Never call
`dateRange` on a start date that came from the database.

**A client mirrors a rule only if it must work OFFLINE.** The native app keeps
five hand-written copies of shared logic — the tap cycle, reminder-time parsing,
`needsReminder`, the entry encoding, the channel default — and every one runs
when there may be no network. Nothing else is copied: creating a habit,
reordering and the settings screen are server-authoritative, because
`parseHabit` and `SETTING_VALUES` normalise as well as validate. Ask this of
anything added next — a sixth mirror is a real cost and a sixth server call is
not.

**A setting's DEFAULT is a mirror even though its rule is not.** `GET /settings`
returns only the keys that have been stored, so every client must supply the
same answer for an untouched one: `SETTINGS` in `shared/public/ui/settings.js`,
the constants in `AppSettings`, and `AppSettingsDefaultsTest` fails if they
drift. The exception has a list — `notMirrored`, a map rather than a set so each
entry carries its reason, for keys no second client reads.

**Settings live on the server** — a `settings` table (personal) or a JSONB
column on `users` (cloud). The browser caches them in localStorage for a fast
first paint, but the server wins. `SETTING_VALUES` in `shared/src/validate.js`
is what is enforced, and its rules are an array **or** a normaliser: a URL and a
timezone cannot be enumerated, so those entries are functions returning the
value to store. Do not widen the array form to "any string".

**Use `Object.hasOwn` when looking up a key from user input.**
`SETTING_VALUES['__proto__']` resolves to `Object.prototype` — truthy, and with
no `.includes` — so a plain lookup let a crafted payload 500 the endpoint.

**The two habit routes disagree about what a write means, on purpose.**
`PUT /habits/:id` REPLACES — the body goes through `parseHabit`, which supplies
a default for every absent field, so a partial write resets what it omits.
`PUT /settings` MERGES, which is why the phone sends one key at a time. Android
pays for the first with a dedicated `HabitInput` serialised with
`encodeDefaults = true`.

**A new habit field has to be assigned to a fidelity list.** `LOOP_HABIT_FIELDS`
is what both Loop formats carry, `LOOP_DB_HABIT_FIELDS` adds `reminder_time`
(Loop's own `Habits.csv` has no reminder columns), and `JSON_HABIT_FIELDS` is
habiterall's own backup. A field Loop cannot carry — `at_most_unlogged`,
`show_as` — goes in the last and neither of the others, and a Loop round trip
correctly returns it to its default.

**Adding a FILE or an EXPORT under `shared/public/` is a `CACHE_VERSION` bump.**
`shellFirst` is stale-while-revalidate and writes into the running worker's
cache, so a shell can hold the new module over a cached old one — a module link
error before `start()`, and so outside `#view-error`. The bump costs every
installed client its data cache, which is why one-off helpers go in an existing
module rather than a new file.

**A user-supplied URL that the server fetches is a request-forgery primitive.**
Allowlist the host whole and with its port (never a suffix test), require HTTPS,
refuse credentials, refuse redirects, and rebuild the URL from the parts you
checked. Allowlisting a destination must allow one KIND of request, so pin the
path too. See `docs/decisions/outbound-urls.md`.

**Whose day it is has two answers and folding them together breaks one.**
`callerDay` (`shared/src/notify.js`) reads the `X-Habiterall-Timezone` header
and nothing else — it is what a route judges "is this today?" by, for the write
guard and for the `/overview` and `/stats` anchors. `resolveTimeZone` asks where
an ACCOUNT is, so a reminder goes out at the right hour with nobody present. A
caller reporting no zone gets the server's clock.

**Sign-in belongs in the app, not in the reverse proxy** — because of the Android
client. `Api.kt` talks to `/api` directly, outside the WebView, so a proxy's login
form is one it cannot fill; exempting `/api` to fix that exempts everything worth
guarding. The app also needs a `401` it can act on, and a proxy answers an expired
session with `200` and an HTML login page, which the offline replay queue feeds
straight to a JSON parser. Both editions therefore issue the same cookie
(`SESSION_NAME`, `httpOnly`, `SameSite=Lax`).

**A cookie session needs an origin check, and a missing `Origin` must pass.**
`SameSite=Lax` is the defence and it is written in one attribute, invisible at the
routes it protects; `sameOriginOnly` states the other half where the requests are.
Browsers always send `Origin` on a state-changing request, so a mismatch is
forgery — but a *native* client sends none, and refusing those would break the
Android client to stop a request it cannot make. That is also why this is an
origin check rather than a CSRF token, which every client would have to fetch,
hold and replay.

**The security config is shared; the limiter's KEY is not.**
`shared/src/security.js` holds the CSP, the cookie shape, the four rate limits and
the `TRUST_PROXY` rule, because those describe `shared/public/` rather than an
edition — two copies of a CSP is two chances to break the PWA in exactly one of
them. `keyGenerator` stays per edition: cloud keys per authenticated user,
personal on IP through `ipKeyGenerator`, which normalises IPv6 to its /56.
`TRUST_PROXY` decides three things that fail quietly in different directions —
the limiters' key, `req.host`, and whether the session cookie can be `Secure` at
all — which is why `warnOnUntrustedProxy` names all three.

**The credential limiter is not switchable.** `HABITERALL_RATE_LIMIT=off` exists
so a test run is not throttled on ordinary reads; it briefly reached `/auth/login`
too, which made it "also remove the only bound on guesses at a single shared
password". CodeQL found it, because routing a limiter through a helper that might
return a pass-through is also how a static analyser stops being able to see it.

**Only 200 and 401 say anything about how an instance authenticates.** Every
other answer from `/api/me` is a fault, not a mode: a 429 from the read limiter
or the service worker's synthetic 503 offline both used to replace a working app
with a sign-in screen whose only control 404s. Both clients boot on this one
answer, which is why `AuthMode` / `Auth.read` are a pinned mirror.

**401 and 403 are not permanent outbox failures.** Every other 4xx is dropped as
permanently inapplicable, and that is right for a deleted habit. A 403 is the
origin check refusing a request a misconfigured proxy made look cross-origin,
and a 401 is a cookie that aged out while the answer is still true about that
day — both fixable, so the writes stay in line and replay.

## Writing tests here

The defect this repo ships most is a test that cannot fail. Five shapes of it,
each of which has cost a release:

- **A fixture holding a field's default compares equal to itself** and passes
  with the field dropped entirely. Set it to a non-default value on purpose —
  `reminder_message` taught the cloud suite this, and the coverage fixture
  straddles a month boundary by a DAY rather than a month for the same reason.
- **A test that imports the constant it checks** pins the name and nothing else.
  Assert the literal — the `fresh` window passed with 7 widened to 30 while its
  own comment claimed the boundary was covered.
- **A property test is only as good as the shapes it constructs.** The awards
  invariant walked a daily habit from a fixed first entry, so the window never
  moved and it could not have seen either mechanism that breaks it.
- **Pinning the DECISION is not pinning the WIRING.** A string being right does
  not make its caller use it; a list being in order does not make its consumer
  read it that way. Four Android bugs and then two more lived one line below the
  pure function that pinned them. Assert the output that reached the platform.
- **A guard that reads SOURCE TEXT cannot see a renamed binding or an inverted
  comparison.** Keep it for what it does catch — a call site that reads no
  setting at all — and add a behavioural test beside it.

**Mutation-test before claiming.** Break the fix, watch the new test fail, put
it back. Every rule above was found that way and not by reasoning.

## Testing

Several layers, and they catch different things:

| | command | needs |
|---|---|---|
| Unit | `npm test` | nothing |
| Types | `npm run typecheck` | nothing |
| Dates in other calendars | `npm run test:locales` | nothing |
| Browser | `npm run test:browser` | Chrome (starts its own fleet) |
| Auth modes | `npm run test:auth -w habiterall-personal` | nothing |
| Credential change | `npm run test:credchange -w habiterall-personal` | nothing |
| Sign-in view | `npm run test:signin -w habiterall-personal` | Chrome (starts its own server) |
| Habit JSON shape | `npm run test:apishape -w habiterall-personal` | nothing |
| Reminders | `npm run test:notify` | nothing |
| Cloud reminders | `npm run test:notify -w habiterall-cloud` | Postgres |
| Backup round trip | `npm run test:roundtrip -w habiterall-personal` | nothing |
| Dashboard summary anchor | `npm run test:overview -w habiterall-personal` | nothing |
| Award inputs, from storage | `npm run test:awards -w habiterall-personal` | nothing |
| Whose day a route judges by | `npm run test:callerday -w habiterall-personal` | nothing |
| Loop export vs a bad date | `npm run test:exportloop -w habiterall-personal` | nothing |
| Cloud API | `npm run test:cloud` | Postgres |
| Cloud round trip | `npm run test:roundtrip -w habiterall-cloud` | Postgres |
| Tenancy | `npm run test:tenancy` | Postgres |
| Compose files | `npm run docs:compose -- --check`, and the CI `compose` job | Docker, for the job |
| Android | `cd android-native && ./gradlew testDebugUnitTest lintDebug` | JDK 21 + SDK |

CI runs all of these on every pull request, plus both Docker builds. Publishing
images to a registry is a separate job that skips itself when the credentials
are absent — see `.github/workflows/README.md`. The `compose` job is the one
exception to the docs-only skip, deliberately: it is the job that guards
documentation, and it is where `docker compose config` actually resolves
`extends`.

The round-trip suites export every backup format, import it back, and assert
nothing changed. Three suites build a ~15-line fake DOM instead of a browser —
`atmost.mjs` and `rendercheck.mjs` drive `charts.js`, `daydialog.mjs` replays
`openDayDialog` — so anything reaching for a browser API there crashes them
outright. `OFFLINE_SUITES` in `run.mjs` is the set the runner will start without
a server; add a suite to it when it needs neither server nor fixtures.

Two suites exist for a shape nothing else can reach. `unknowncheck.mjs` taps a
day and then asks the API what the row says, because with `questionMarks` off a
0 row and no row paint identically. `hangcheck.mjs` holds a request open with
CDP `Fetch.requestPaused` and never continues it — devtools offline throttling
is connection-refused, which rejects in ~3ms and passes against a build with no
timeout in it at all. `responsive.mjs` checks every major view at 360 / 390 /
768 / 1440px; most other suites only ever run at 1440.

The browser suites reset to known fixtures before each run
(`shared/test/browser/fixtures.mjs`). If one fails, check the fixtures before
suspecting the app — several "failures" have been stale test data.

**Wait for the app, never for a duration.** `waitUntil` (`chrome.mjs`) polls a
predicate and THROWS naming what it wanted; a `sleep` after `Page.navigate` is
a guess in both directions. Measured on the personal edition: a boot is ready in
**52–95ms**, and the settings reconcile it performs lands within **7ms** of that,
because `start()` awaits `settings.init()` before it renders — so a rendered
dashboard is downstream of the whole of it, and it holds under a stubbed-out
`/api/settings` too (49–67ms, *faster*). `themecheck` carried 26 fixed sleeps of
1.2–3s against that: 53.8s, 56% of its runtime, and it now runs in 46s instead of
99s. The predicate has to be everything the block depends on — a poll on a weak
condition returns the instant the DOM has anything in it, which is worse than the
sleep it replaced. Post-action settles are a different thing and stay: waiting to
see that something did NOT happen has no predicate to poll.

**The browser suites run in parallel, and a worker OWNS the instance it points
at.** `fixtures.reset()` deletes every habit on its server, so the parallelism is
the number of `--bases` and there is no flag that can put two workers on one
instance. The default is **twice the core count, capped at eight** — these suites
are mostly idle, not CPU-bound (`hangcheck` holds a request open for 38s), so a
worker per core leaves the box waiting. Swept on a 4-core runner: 126s at j=4,
90s at j=8, and past that both slower and FAILING, because contention exposes
waits weaker than what follows them (`pwatest`, then `awardcheck` and
`calcheck` — all pre-existing, all reproducing on master). Fix those before
raising it. `npm run test:browser` is personal's fleet script — N servers, N
throwaway SQLite files, N bases — while `run.mjs` stays edition-agnostic so cloud
is pointed at the same way. Two consequences that have already cost something:
the base must be threaded through `reset({base})` rather than left in module
state, because `reset` awaits ~240 times and a second worker's `useBase` lands
in the middle of the first one's (measured: one instance holding both workers'
fixtures, eight habits); and a suite's DevTools port is **assigned by the
runner**, because two suites sharing a literal made the second attach to the
first's browser and hang — `searchcheck`/`unknowncheck` and
`notifycheck`/`nudgecheck` both did, invisibly, for as long as the run was
serial.

## Before you ship

`habiterall-cloud/.env` holds **real working secrets** used for local testing.
Regenerate every one of them before any real deployment, and read
`habiterall-cloud/SETUP.md`'s production checklist.
