# habiterall — working notes

A self-hosted habit tracker modelled on [Loop Habit Tracker](https://github.com/iSoron/uhabits),
in two editions sharing one core. Read this before changing anything; the
non-obvious decisions below were each paid for with a real bug.

## Layout

```
shared/               EVERYTHING both editions have in common
  src/                pure logic — no database, no HTTP, no DOM
  public/             the entire UI, plus the PWA (manifest, sw, offline queue)
  public/ui/          settings registry, date helpers, theme, auth adapters
  test/               unit tests + browser suites (test/browser/)
habiterall-personal/  single user, SQLite, no auth   (src/ + one entry point)
habiterall-cloud/     multi user, Postgres, OIDC     (src/ + one entry point)
android/              Trusted Web Activity wrapper for the PWA
android-native/       native Kotlin client, for notification actions
```

One npm workspace. `shared` resolves as `@habiterall/shared/<file>.js`; the
browser gets the same files under `/shared/`. **No build step anywhere** —
what runs is what's on disk.

### What belongs where

- **`shared/`** — anything not coupled to storage or auth. The whole frontend
  lives here; each edition ships only `public/app-entry.js`, which picks an
  auth adapter and calls `start()`.
- **Per edition** — storage (`db.js` / `db/pool.js`), auth, the import
  *writer* (`apply-import.js`), and the API routes.

If you find yourself copying a file between editions, stop: it belongs in
`shared/` behind an adapter. That duplication has already bitten this project
once (~1,750 lines of frontend drifted apart before being merged back).

## Running it

```bash
npm install                 # once, at the root
npm test                    # unit tests, all workspaces
npm run test:browser        # UI suites — needs Chrome + a running server
npm run test:tenancy        # cloud isolation attacks — needs Postgres

npm run typecheck           # JSDoc types via tsc --noEmit
npm run test:cloud          # cloud API + Loop round trip — needs Postgres
npm run test:roundtrip -w habiterall-personal   # backup fidelity, all formats

npm run start:personal      # http://localhost:3000
cd habiterall-cloud && docker compose up -d   # app :3100, Authentik :9000

cd android-native && ./gradlew testDebugUnitTest lintDebug assembleDebug
```

The native Android client needs JDK 21, Android SDK 36 and Gradle **8.14.3**
— see `android-native/README.md`. AGP 8.x does not support Gradle 9, and the
wrapper jar is generated rather than committed.

## Non-obvious decisions

**Skips are stored out of band.** `entries.status = 'skip'`, never a magic
value. A numerical habit can legitimately record `3`, which used to collide
with Loop's SKIP sentinel and silently turn a real failure into a skip —
bridging streaks and inflating scores. `isCompleted()` takes `{value, status}`
for this reason.

**"Not done" is the absence of a row** — except when a note is attached, which
needs a row to live on.

**Every date range is clamped** (`boundedRange`, `MAX_RANGE_DAYS`). Ranges
derived from *stored* data are attacker-controlled: one entry dated year 0100
once made a single request block the event loop for 32 seconds. Never call
`dateRange` on a start date that came from the database.

**The score is a trailing-window ratio**, not per-day credit scaled by
frequency. The earlier formula overshot for every non-daily habit and was
hidden by a clamp; a single checkmark on a 1×/365d habit reported 100%. The
decay constant is Loop's own, `0.5^(sqrt(frequency)/13)` — read from its
source, not guessed. A fixed 30-day half-life sat here for a while and made a
perfect habit take four months to look strong instead of one.

**Loop compatibility is exact and verified against a real backup**: timestamps
are epoch millis at UTC midnight, `YES_AUTO(1)` counts as done, and identity is
`(issuer, subject)`.

**Only entry values scale by ×1000 — habit targets do not.** `Repetitions.value`
of `2000` means 2, but `Habits.target_value` of `2` means 2. Scaling the target
turned "brush teeth at most 2 times" into "at most 0.002", which no entry could
ever satisfy. Reading their source was not enough to catch this; it took a real
export.

**The dashboard fetches the window it is showing.** `/overview` takes an
`end` date. Paging back without it re-rendered an empty grid, because the
entries for that window had never been loaded — the days looked unrecorded
while the stats view showed them fine.

**Column count scales with viewport width**, not one breakpoint. At 768px the
14-column layout needed 668px of a 698px row and squeezed the habit name to
zero width. 7 / 10 / 14 columns by width.

**Settings live on the server** — a `settings` table (personal) or a JSONB
column on `users` (cloud, covered by the existing RLS policies). The browser
caches them in localStorage for a fast first paint, but the server wins.
`SETTING_VALUES` in `shared/src/validate.js` is what is enforced;
`test/settings.test.js` fails if the UI registry drifts from it.

**`Object.hasOwn` when looking up a key from user input.** `SETTING_VALUES['__proto__']`
resolves to `Object.prototype` — truthy, and with no `.includes` — so a plain
lookup let a crafted payload 500 the endpoint.

**`[hidden]` needs `display: none !important`** in the stylesheet. A `display`
rule silently beats the attribute, which once made the day editor show both
habit types' controls at once. Only a real browser catches this class of bug —
that is why `test/browser/` exists.

## Testing

Several layers, and they catch different things:

| | command | needs |
|---|---|---|
| Unit | `npm test` | nothing |
| Types | `npm run typecheck` | nothing |
| Browser | `npm run test:browser` | Chrome + a running server |
| Backup round trip | `npm run test:roundtrip -w habiterall-personal` | nothing |
| Cloud API | `npm run test:cloud` | Postgres |
| Cloud round trip | `npm run test:roundtrip -w habiterall-cloud` | Postgres |
| Tenancy | `npm run test:tenancy` | Postgres |
| Android | `cd android-native && ./gradlew testDebugUnitTest lintDebug` | JDK 21 + SDK |

CI runs all of these on every pull request, plus both Docker builds. Publishing
images to a registry is a separate job that skips itself when the credentials
are absent — see `.github/workflows/README.md`.

The round-trip suites export every backup format, import it back, and assert
nothing changed. They found two real bugs on their first run, both in the CSV
path. Two offline suites (`atmost.mjs`, `rendercheck.mjs`) drive `charts.js`
against a ~15-line fake DOM, so anything reaching for a browser API there
crashes them outright rather than failing a check.

`responsive.mjs` checks every major view at 360 / 390 / 768 / 1440px. It found
the tablet bug above on its first run; most other suites only ever ran at
1440px.

The browser suites reset to known fixtures before each run
(`shared/test/browser/fixtures.mjs`). If one fails, check the fixtures before
suspecting the app — several "failures" have been stale test data.

## Before you ship

`habiterall-cloud/.env` holds **real working secrets** used for local testing.
Regenerate every one of them before any real deployment, and read
`habiterall-cloud/SETUP.md`'s production checklist.
