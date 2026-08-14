# habiterall — working notes

A self-hosted habit tracker modelled on [Loop Habit Tracker](https://github.com/iSoron/uhabits),
in two editions sharing one core. Read this before changing anything; the
non-obvious decisions below were each paid for with a real bug.

## Layout

```
shared/               EVERYTHING both editions have in common
  src/                pure logic — no database, no HTTP, no DOM
  public/             the entire UI, plus the PWA (manifest, sw, offline queue)
  public/ui/          one module per view and dialog, over a shared store
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
  *writer* (`apply-import.js`), the notifier's storage adapter
  (`notifier.js`), and the API routes.

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
npm run test:notify         # reminder delivery + its watermark, against SQLite
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

**One rule decides what writing an entry does to storage**, and it lives in
`entryWrite` (shared/validate.js) because three callers need it: both editions'
PUT routes and the Discord button handler. It had been inline in the two routes,
and a third copy in the interaction handler is how "not done" would start meaning
something different depending on where you answered from.

**A view is named by a fragment, never a path.** `#/habit/42` is what the
native client opens to land on one habit's stats, and it is a fragment because
that reaches the server in neither edition: no static-serving change, no
service-worker navigation rule, nothing to teach a build step that does not
exist. `shared/public/ui/routes.js` owns it, and two rules in `go()` are load
bearing — writing nothing when the URL already says this (`detail.open()` is
re-entered by every zoom and paging control, so the alternative is a dozen
history entries per habit), and pushing a habit while the list replaces (Back
already goes home). Note the Android WebView and a browser then disagree, on
purpose: a cold deep link leaves an entry a browser's Back walks into, while
WebView's own back skips an entry pushed without a user gesture and closes the
screen — which is what returns you to the native list you tapped from.

**The native day grid runs whichever way `dayOrder` says, and only one
direction is free.** With today on the left, loading more history appends past
the right edge and the scroll offset is still correct. With today on the right
it *prepends*, so every column shifts by its own width and the offset must move
with it or the grid jumps a month sideways at the moment it loads —
`Grid.scrollAfterGrowth` is that correction and it is unit-tested. All rows and
the date header share one `ScrollState`, because two lazy rows cannot share one
state and rows that scroll apart stop lining up with the dates above them.

**A time is parsed, not pattern-matched.** `08:30` is what gets stored, but
`8:30`, `8:30 pm`, `830` and `8` are what people type, and an `^HH:MM$` check
rejects all four with nothing useful to say. `shared/public/ui/time.js` and the
Kotlin `ReminderTime` are deliberate mirrors — same inputs, same outputs, tests
pinned to the same examples — because both clients write the same field. Note
12am/12pm is the pair every hand-rolled converter gets wrong.

**Settings live on the server** — a `settings` table (personal) or a JSONB
column on `users` (cloud, covered by the existing RLS policies). The browser
caches them in localStorage for a fast first paint, but the server wins.
`SETTING_VALUES` in `shared/src/validate.js` is what is enforced;
`test/settings.test.js` fails if the UI registry drifts from it.

**`Object.hasOwn` when looking up a key from user input.** `SETTING_VALUES['__proto__']`
resolves to `Object.prototype` — truthy, and with no `.includes` — so a plain
lookup let a crafted payload 500 the endpoint.

**A notification destination is either on-device or server-sent, and the
difference is the whole design.** `CHANNELS` in `shared/src/notify.js` says
which. The Android channel is a local alarm armed from `habits.reminder_time`;
the server neither schedules nor pushes it, which is what keeps it working
offline — so switching that destination *off* only has an effect if the phone
honours the setting, and it reads `notifyChannels` for exactly that reason.
Discord is the opposite: nothing on the phone knows the webhook, and the
browser could not post to it anyway (`connect-src 'self'`), so the server keeps
time. Adding a destination means an entry in `CHANNELS`, a branch in
`sendToChannel`, and an option in `ui/settings.js` — nothing per edition.

**Buttons in Discord need a bot; a webhook cannot carry them.** Discord accepts
`components` on an *application-owned* webhook only, so the plain channel
webhook anyone can create is text-only, permanently. Bot mode therefore exists
alongside it rather than replacing it: with `DISCORD_BOT_TOKEN` and a channel id
the reminder gets Yes / No / Skip and a number modal; with only a URL it gets
the same text as before. `sendToChannel` picks, and `CHANNELS.discord.ready` is
why "configured" is a predicate rather than a list of required keys.

**Interactions arrive over a WebSocket, not an HTTP endpoint.** Discord will
call an endpoint if you have one, but a self-hosted instance behind a router has
no inbound port and no hostname — requiring one would mean the interactive
reminders only worked for people who had already solved a harder problem. The
outbound socket in `shared/src/discord-gateway.js` needs nothing. It is also why
no request-signature verification appears anywhere here: a socket is
authenticated once, by the token.

**The bot token is an environment variable, never a setting.** It can post to
every channel the bot is in, and `GET /api/settings` hands settings to the
browser — so a stolen session would exfiltrate the operator's token. The channel
id *is* a setting, because it is per user and worth nothing on its own.

**A button press is authorised by the CHANNEL it came from, not by its
`custom_id`.** The id carries a habit and a date because that is all Discord
gives back, and it is trusted for neither: `resolveChannel` decides whose data
is written, and the habit is then looked up inside that account, so a forged id
finds nothing. `discordUserId` narrows it further to one Discord user — without
it, anyone who can see the channel can answer.

**A server-sent reminder is written down after it is sent** (`notify_log`,
keyed on habit + channel + the user's *local* date). Without that watermark a
minute-by-minute tick re-sends for as long as the catch-up window lasts. Keyed
per channel, or enabling a second destination is silenced for its first day by
the send to the first; keyed on the local date, or a user east of the server
gets it filed under the wrong day and again a few hours later.

**`SETTING_VALUES` rules are an array *or* a normaliser.** A URL and a timezone
name cannot be enumerated, so those entries are functions returning the value
to store (or `undefined` to reject) — which is also why an accepted setting may
differ from what was sent, and why `ui/settings.js` has a `save()` that waits
for the server's answer rather than assuming it. Do not widen the array form to
"any string" instead: `parseSettings` being the only thing that needs trusting
is the point.

**A user-supplied URL that the server fetches is a request-forgery
primitive.** `parseDiscordWebhook` allowlists Discord's hosts, requires HTTPS,
rebuilds the URL from the parts it checked, and the sender refuses redirects.
Without the host check, `discordWebhook` aims the server at cloud metadata or a
port on its own network and reports the result as a status code.

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
| Reminders | `npm run test:notify` | nothing |
| Cloud reminders | `npm run test:notify -w habiterall-cloud` | Postgres |
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
