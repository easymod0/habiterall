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
android-native/       native Kotlin client — notification actions, and habits
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

The native Android client needs JDK 21, Android SDK 37 and Gradle **9.7.0**
— see `android-native/README.md`. The wrapper jar is generated rather than
committed, so that version lives in `gradle-wrapper.properties` and CI reads it
from there. AGP 9.3.1 requires Gradle ≥ 9.5 and nothing in the build may
contradict that; Kotlin it only *defaults*, and the two compiler plugins in the
root `build.gradle.kts` are what actually choose the compiler. `compileSdk` is
37 while `targetSdk` stays 36 — the first is what `androidx.core` 1.19.0
demands, the second is a runtime-behaviour opt-in and a separate decision.

## Non-obvious decisions

**Skips are stored out of band.** `entries.status = 'skip'`, never a magic
value. A numerical habit can legitimately record `3`, which used to collide
with Loop's SKIP sentinel and silently turn a real failure into a skip —
bridging streaks and inflating scores. `isCompleted()` takes `{value, status}`
for this reason.

**A day has four states, and the fourth is a missing row.** `done`, `skip`, `no`
(a row holding 0) and `unknown` (no row at all). "Not done" used to be the
absence of a row, which made the last two one thing — and the note exception
("except when a note is attached, which needs a row to live on") is what gave
that away: the row was already the difference between a day the user answered and
a day nobody has, but only a note could bring one into being. So Loop's
`pref_unknown_enabled` — *show question marks for missing data* — had nothing to
show, and a Loop backup's explicit `NO` rows were discarded on import because
there was nowhere to put them.

`entryWrite` therefore never deletes: `PUT {value: 0}` records a stated lapse and
`DELETE` is how a day goes back to unknown. `PUT {value: 0}` has changed meaning
for every client that used it to clear, which is invisible while question marks
are off (a lapse and an unknown day paint identically) and never wrong about what
it claims. Two more consequences, and the first is easy to state too strongly.

**The score, the streaks and the completion count do not move — the
window-derived figures can.** `isCompleted` is `false` for a 0 row and every
caller treats a missing row as a miss, so for the same window in, the same
numbers come out: `computeStats` is identical for a 0 row and no row, and both
editions' `countCompleted` still keys on `value = 2`. But some ranges *start* at
the earliest stored entry (`from = start ?? firstEntry` in `computeScores`, and
the history and weekday aggregations behind it), and a lapse is a stored entry
where there was none. Every unknown day between it and the next row then reads as
a miss — which is the model working as designed, and also why resilience can go
from "nothing has ever been missed" (`recovery.rate === null`) to a real lapse the
moment one day is marked as missed. One ancient Loop `NO` now extends a habit's
history back to its own date, where before it was dropped on import. Nothing is
miscounted; the window is simply older, and honest about it.

**A merge may add an answer and must never delete one.** Now that a bare "not
done" in a file reaches the writer, a plain upsert would overwrite a recorded
completion with it — and a Loop backup is full of explicit `NO` rows, so merging a
phone export taken before the web history would have wiped every completion the
two disagreed about. Both editions' `applyImport` yield to the existing row for
exactly that case — bare lapse, merge mode — and count it as `entriesKept`.

**Loop's two tracking settings are `skipDays` and `questionMarks`,** both
defaulting off as Loop's own do, and both read from Loop's source rather than
guessed (`pref_skip_enabled`, `pref_unknown_enabled`). The tap cycle is
`Entry.nextToggleValue` verbatim, in `shared/public/ui/toggle.js` and mirrored by
the Kotlin `Grid.nextState` with both test suites pinned to the same examples.
The one surprise in it is deliberate: with question marks off there is no way
back to `unknown` from the grid, because with the setting off the two states
paint the same and a step between them would be a tap that appears to do nothing.
The day editor's Clear is what gets there. Every surface that can record an
answer reads `skipDays` — both grids, both day editors, the Discord buttons
(`reminderComponents`) and the Android notification, which reads it from a local
mirror because an alarm fires whether or not the phone has a network.

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
are epoch millis at UTC midnight, `YES_AUTO(1)` counts as done, `NO(0)` is a
stated lapse and keeps its row while `UNKNOWN(-1)` has none, and identity is
`(issuer, subject)`. Both round-trip suites now assert every entry with no
documented gap left — Loop's `.db` and the CSV pair can each carry all four
states, so a lapse survives whether or not a note came with it.

**Loop's backup carries no preferences** — they live in Android's
SharedPreferences, not the database — so nothing from a Loop file can set one,
and `skipDays` / `questionMarks` arrive only in habiterall's own JSON backup.
That backup does carry settings now (it silently did not, while
`habiterall-personal/CLAUDE.md` claimed otherwise), because two of them decide
what the rows in the same file MEAN. A **replace** applies them and a **merge**
does not: "make this account look like the file" versus "add these habits to what
I have".

**Only entry values scale by ×1000 — habit targets do not.** `Repetitions.value`
of `2000` means 2, but `Habits.target_value` of `2` means 2. Scaling the target
turned "brush teeth at most 2 times" into "at most 0.002", which no entry could
ever satisfy. Reading their source was not enough to catch this; it took a real
export.

**The dashboard fetches the window it is showing.** `/overview` takes an
`end` date. Paging back without it re-rendered an empty grid, because the
entries for that window had never been loaded — the days looked unrecorded
while the stats view showed them fine.

**...but `end` moves the GRID only.** It was deciding two things, and they want
different dates: which days are painted, and the date the row summary is
computed as of. So paging back a month restated the strength and the streak as
of that month — "43%" and no fire, under a habit that is on a twelve-day run,
with nothing on the row to say the figures had moved. `summaryEnd` is `today()`
in both editions' `/overview`, and `bestStreak` was the tell: paging back also
*dropped* any run set after the date on screen. The detail view is the surface
that answers "as of when", and it has its own range controls. The Android
client always sent `end = null` (it grows `windowDays` backward instead), so it
never had this. Pinned by `habiterall-personal/test/overview.integration.mjs`
and the `--- overview ---` block in the cloud API suite — the one place that
one goes through the router rather than the data layer, because the bug was in
the route and `computeStats` was always doing exactly as it was told.

**Column count scales with viewport width**, not one breakpoint. At 768px the
14-column layout needed 668px of a 698px row and squeezed the habit name to
zero width. 7 / 10 / 14 columns by width.

**One rule decides what writing an entry does to storage**, and it lives in
`entryWrite` (shared/validate.js) because three callers need it: both editions'
PUT routes and the Discord button handler. It had been inline in the two routes,
and a third copy in the interaction handler is how "not done" would start meaning
something different depending on where you answered from.

**A client mirrors a rule only if it must work OFFLINE.** The native app keeps
five hand-written copies of shared logic — the tap cycle, reminder-time parsing,
`needsReminder`, the entry encoding, the channel default — and every one of them
runs when there may be no network, which is why they are worth the cost of
keeping in step. Nothing else is copied. Creating a habit, reordering, and the
settings screen are all server-authoritative: the phone submits and renders
whatever comes back, including the error, because `parseHabit` and
`SETTING_VALUES` normalise as well as validate and are the only opinion that
decides what gets stored. That rule is what let the phone become a full client
without doubling the mirror surface — and it is the question to ask of anything
added next, because a sixth mirror is a real cost and a sixth server call is not.

**A setting's DEFAULT is a mirror even though its rule is not.** `GET /settings`
returns only the keys that have been stored — neither edition fills gaps — so a
setting nobody has touched arrives as nothing, and every client has to supply the
same answer for it or the two disagree about what the account is set to. The web
has `SETTINGS` in `shared/public/ui/settings.js`; the phone has the constants in
`AppSettings`, and `AppSettingsDefaultsTest` reads the registry and fails if they
drift, which is the Kotlin half of what `shared/test/settings.test.js` already
does. The one that will catch you is `historyGranularity`, whose default is
`week` — the only default in the registry that is not the first option in its own
list, and duly copied as `day` the first time the phone grew a settings screen.
That combination is nastier than it sounds: the screen showed a value the charts
were not using, and a chip already drawn as selected does not fire, so the value
it claimed was set was the one value it would not store.

**The two habit routes disagree about what a write means, on purpose.**
`PUT /habits/:id` REPLACES — the body goes through `parseHabit`, which supplies a
default for every absent field, so a partial write resets what it omits rather
than leaving it alone. `PUT /settings` MERGES, which is why the phone sends one
key at a time and two clients editing different preferences do not clobber each
other. The Android side pays for the first with a dedicated `HabitInput` type
serialised with `encodeDefaults = true`: kotlinx.serialization omits fields equal
to their Kotlin default, which is precisely the set a replace would then clear,
and it had been safe only because those defaults happened to match the server's.

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

**That agreement is a coincidence of the list being short, and the native client
has to keep it one.** `canGoBack()` closing the screen only works while the
habit's document sits at the BOTTOM of the back-forward list, which it did for
free while the WebView was built on the tap and destroyed on the way out. One
WebView for the whole activity ends that twice over: the warm-up's `about:blank`
is a real entry underneath, and `routes.go()`'s push is a real entry above —
added by the page after the load committed, so nothing the native side measures
before the load can count it. Both together turned the first Back press into a
walk to a blank screen — `about:blank`, because WebView skips the gestureless
push and lands under it. `WebBackStack` (android-native) is the rule now, and it
is three, because the ways in are not alike. A document load is fenced by
truncating the list once it commits, which restores the shape the per-tap WebView
had rather than teaching the native client how many entries a page pushes; the
truncation hangs off `doUpdateVisitedHistory` and not `onPageFinished` because a
FAILED load's error page commits after the latter has run, so there is nothing to
truncate yet and Back walked off the screen for the second reason. A habit opened
over the dashboard pushes, and is fenced by counting the one entry it adds. And a
habit opened over another habit **replaces** — the one place this client speaks
JavaScript (`location.replace`), because `loadUrl` cannot, and because
`routes.go(LIST)` reaches the dashboard by unwinding the entry it pushed. That
unwind assumes the entry underneath a habit is the dashboard, which a stack of
native taps quietly falsified: the page's own "← Back" walked to the habit viewed
before this one, and the list grew for as long as the app stayed open. Change what
`app.js` writes to history during boot, or what `go()` does to reach the list, and
all three have to be re-read.

All of it was verified on an emulator rather than argued, which is worth keeping
up: every wrong version of this still passes `WebBackStackTest`, because the unit
tests pin arithmetic and every bug here was in the *premise* — which entry the
load lands on, and when it lands there.

**A deep link does not paint the list on its way.** `start()` used to load and
render the dashboard and only then open the habit, so a link straight to one
showed a full grid of every habit for as long as the stats request took and
then replaced it — a flash of the wrong screen, on the native client's most
used path in. The boot now opens the habit alone; nothing else needs the list
(`state.habits` is the dashboard's), and Back reloads it. Two things keep it
honest, and both are the reason this is written down rather than obvious: the
URL still moves through the list (`routes.go(LIST)` before the habit is
opened), because that is the entry Back returns to; and `detail.open()` reports
whether it rendered, because a habit that will not open would otherwise leave
the app showing nothing at all. `routecheck.mjs` pins the flash with a
MutationObserver installed before the app boots — it lasts one request, which
is less than a devtools round trip, so it cannot be polled for from outside.

**The native day grid runs whichever way `dayOrder` says, and only one
direction is free.** With today on the left, loading more history appends past
the right edge and the scroll offset is still correct. With today on the right
it *prepends*, so every column shifts by its own width and the offset must move
with it or the grid jumps a month sideways at the moment it loads —
`Grid.scrollAfterGrowth` is that correction and it is unit-tested. All rows and
the date header share one `ScrollState`, because two lazy rows cannot share one
state and rows that scroll apart stop lining up with the dates above them.

**The notification body opens the app; only the buttons answer.** Yes / No /
Skip and the number pad are the whole point of the native client, but the
notification is also just a notification, and a tap anywhere else has to do what
every other app does. `MainActivity` is `singleTop` so the tap reaches the
instance already running instead of stacking a second one, and the habit id
rides along so the list lands on the habit that asked. That focus and the
resume snap-to-top would otherwise race — whichever ran second decided where the
list sat — so the snap defers while a tap is pending, and the focus is cleared
once a fetch has landed whether or not the habit was found, or an archived habit
would suppress the snap forever.

**A row's streak is the server's arithmetic, so recording a day re-asks for
it.** The optimistic overlay knows one day and a streak is the whole history;
without a refetch, ticking today left the number sitting still at the exact
moment it is being watched. The refetch is *silent* — same fetch, no pull
indicator — because a check-off should not look like work. `quiet` is read and
cleared at the top of the fetch effect, so a fetch cut short by paging cannot
leave the next one silent too.

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

**A press is acknowledged before any storage is touched.** Discord allows an
interaction three seconds, and answering one used to be the LAST thing
`handleInteraction` did — after resolving the channel, asking what day it is
there, and recording. Three round trips through a database, under RLS on the
cloud side; on a cold pool or a container that has just started that is over the
line, and the user is shown **"This interaction failed"** on a press that *was*
written. The worst kind of failure message: it says the opposite of what
happened, and the natural response is to press again. So the first thing out is
`DEFER_UPDATE` (type **6**, not `DEFER`'s 5 — 6 leaves the message alone, where
5 posts a visible "thinking" placeholder that would then need cleaning up), and
the real answer follows on the same token, good for fifteen minutes.
`respondInteraction` takes `acknowledged` and picks the endpoint: the callback
first, then `PATCH …/messages/@original` for an edit or `POST …/webhooks/{app}`
for a private note — chosen from the response shape the handler already built,
so everything above that line reads the same either way. `application_id` rides
on the interaction, so this needs no extra call and still no bot token.

One consequence of deferring is that the *old* failure mode was at least
visible: an unanswered interaction showed "This interaction failed", which was
wrong but loud. A type-6 defer has no loading state to time out, so an uncaught
throw afterwards leaves the reminder sitting unchanged and the press looking
like it did nothing. The `try` therefore wraps **all** the storage — a pool that
has gone away takes `resolveChannel` and `today` down as readily as `record` —
and the defer itself is wrapped too, so a failure to acknowledge cannot skip the
write it exists to protect. Deferring also requires `application_id`: without it
the follow-up would post to `/webhooks/undefined/…` after spending the callback.

Two exceptions, and both are deliberate. **A modal cannot be deferred at all** —
it has to be *opened* inside the three seconds, and a callback of type MODAL is
the only way to open one — so the `amount` button keeps its lookup-and-answer
shape; it does one read and no write. And the **test button** touches no storage.
Note the ordering this costs: it is removing the buttons that stops a second
click recording twice, and a defer delays that, so the buttons stay live while
the write is in flight. `record` is an upsert for every action, so a double press
is idempotent and the window costs nothing.

**A server-sent reminder is written down after it is sent** (`notify_log`,
keyed on habit + channel + the user's *local* date). Without that watermark a
minute-by-minute tick re-sends for as long as the catch-up window lasts. Keyed
per channel, or enabling a second destination is silenced for its first day by
the send to the first; keyed on the local date, or a user east of the server
gets it filed under the wrong day and again a few hours later.

**How it WENT is written down too, and that one is for the user.** A permanent
failure — a deleted webhook, the bot kicked from its channel, a revoked token —
is marked as sent (a 404 answers 404 forever, and retrying every minute until
midnight helps nobody) and logged at warn. The log was the only surface, and it
is the wrong one: reminders simply stopped while the habit, its time and the
destination toggle all went on looking correct, and on a shared instance the
warning is unreachable to the person it concerns and invisible to an operator
with no reason to read one account's lines. `notify_status` — a table in
personal, migration 010 with the ordinary owner policy in cloud — holds the
LAST outcome per channel and nothing more, and the settings dialog shows it
without being asked. Four things about it are load bearing:

- It is **not** in the settings blob, though that is where it would have been
  cheapest. Settings are what `PUT /api/settings` writes and `/api/export`
  carries, so a diagnostic living there would end up in people's backups and in
  both round-trip suites. This is the server reporting on itself.
- It says whether a destination **did** deliver, never whether it **can**.
  `channelConfigured` stays the only authority on the second, or the two come
  to disagree about one setting.
- Written on a **change of state**, not per send: `collect` reads the stored
  verdict into `account.delivered` and `noteOutcome` compares. Five habits
  failing at 08:00 is one piece of news, and a healthy instance writes here
  roughly never. A success is stored for one reason — it clears a notice the
  user is being shown.
- **The state is the REASON, not just `ok`** — `stateKey` covers
  `ok`/`permanent`/`status`/`error`. A 500 on Monday and a deleted webhook on
  Tuesday are both `ok: false`, so comparing that alone froze the message at
  whichever failure came first: "webhook returned 500" forever, while the one
  actionable sentence — *create a new one* — never arrived. That is a softer
  version of the silence this whole feature exists to end. `date` is
  deliberately **out** of the key, because it moves every day a failure
  persists and including it would make this a write per reminder again. So what
  is stored is the date the state BEGAN, and the dialog says "not delivered
  **since**" rather than "the last reminder **on**" — a claim the data would
  not support.
- The wording is the **sender's own**, from `postWebhook` / `discordRequest`.
  Re-phrasing it in the UI is how the dialog and the log come to say different
  things about the same 404.

`sendTest` records unconditionally rather than on a change, because a press
there is one deliberate act rather than a tick, and it is what clears the notice
the moment a replacement webhook works instead of tomorrow morning.

**The phone's alarms follow the server only when something re-arms them, and a
refresh used not to count.** `habits.reminder_time` is the schedule, but an
alarm is a local copy of it, so every path that learns a new time has to arm
one. The habit list draws itself straight from `/api/overview`, which meant a
time set in a browser *appeared* on the phone immediately and changed nothing:
the alarm stayed as it was, or absent. The only correction was
`Application.onCreate`, which runs on a COLD start — and Android usually keeps
the process, so closing and reopening the app was not one. That is why this
presented as "notifications are unreliable" rather than as a missing feature:
whether the phone agreed with the server depended on whether it had happened to
die since. `Reminders.armFrom` now arms from every fetch the list makes (the
settings request it already made answers `androidRemindersEnabled` too), and
`enqueuePeriodicSync` is a six-hourly backstop, because every other path here is
an event handing off to the next and one dropped link is otherwise silent
forever. `ReminderReceiver` also holds itself open with `goAsync` now: it was
arming *tomorrow's* alarm in a detached coroutine while the process was free to
die, which is the same race `BootReceiver` already guarded.

**A skip is an answer, and both destinations have to agree.** `answeredIds`
(shared/src/notify.js) and `Reminders.needsReminder` are deliberate mirrors, and
the rule is `isCompleted(...) !== false` rather than a truthiness test:
`isCompleted` returns `null` for a skip, so asking "is it completed?" put every
skipped day back in the queue and asked about a day the user had already dealt
with. The phone had a third rule of its own — "does a row exist for today?" —
which silenced six-of-eight-glasses and a note-bearing "no" while the server
went on asking about the same day. Three rules for one question is how one
destination ends up looking broken.

**One disconnect must produce exactly one reconnect.** Closing a socket
ourselves also fires its own `onclose`, so the handler left attached reported a
deliberate close as an unexpected one and scheduled a second connect — two live
sockets, of which only the newer was heartbeated, so Discord closed the older a
couple of intervals later and *that* scheduled a third. Buttons then answer
twice (the second `respondInteraction` fails on a spent token) and the backoff
advances at double speed toward Discord's identify limit. Three things stop it
now and the ordering of the first is load bearing: `ws` is nulled *before* the
close, the socket is detached, and `scheduleReconnect` is idempotent. The
regression test counts scheduled timers, because every wrong version of this
still reports `state() === 'waiting'`.

**The two silences in a tick that are worth a warning.** Everything a tick
decides is at debug, and rightly — 1,440 lines a day of "nothing was due" is how
a log stops being read. Two exceptions, both routed through the `once` dedupe in
notify-send.js. `notify.too_late` means a reminder was *lost*: its minute passed
while nothing was running and it will not be retried today, which is what an
outage, an overrunning tick or an unset container timezone looks like. That claim
rests entirely on the ORDER of the gates in `dueReminders`: the catch-up window
closes half an hour after the reminder, so from 08:31 a habit whose reminder went
out at 08:00 is also past it, and asking about lateness before `done_today` and
`already_sent` reported every delivered reminder as a lost one, once per habit
per channel per healthy day — which is worse than not warning at all, because a
real loss then arrives in a crowd. Answered and sent are asked first, so
`too_late` is only ever said about a day still outstanding. And
`notify.unreachable` covers the state that produced no output whatsoever — a
destination switched on but not configured, where `needsServerDelivery` is false,
the account is skipped, and every visible surface looks correct. The case that
motivated it is a Discord channel id on an instance with no `DISCORD_BOT_TOKEN`:
the recommended setup, missing the one credential a user cannot supply
themselves, silent forever, and the settings dialog's test button says nothing
either because it only reports on channels that are ready.

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

**The gateway's own frames are remote input too, and two of them steer this
process.** A settings URL is the obvious case; the socket is the one that reads
as trusted because it was authenticated. It is not: `resume_gateway_url` in READY
says where the NEXT socket opens, and the RESUME frame it then sends carries the
bot token — so `resumeTarget` applies `parseDiscordWebhook`'s reasoning one step
out, suffix-matching `*.discord.gg` / `*.discord.com` (the value is regional and
the regions are not enumerable from here) and rebuilding the URL from the host
alone. Falling back to the published gateway costs a fresh session and nothing
else, which is why a rejected value is not an error. HELLO's
`heartbeat_interval` is the same shape of problem with a different sink: it sets
a timer in this process, so anything outside 1s–10min takes Discord's published
default instead of being clamped to the nearer bound. Ungated, a `1` is a busy
loop starving the reminder tick that shares the event loop.

**`/healthz` is the only unauthenticated route in cloud that touches Postgres,
and it has four callers rather than the two it looks like.** The container
healthcheck and an attacker are the obvious pair; the other two are the PWA's
connectivity probe (`isReachable`, on every boot and every visibilitychange) and
the Android setup screen's, and both read anything but a 200 as *the server is
unreachable*. So a per-IP 429 does not shed load, it makes a browser banner
itself offline and divert writes to the outbox while the server is perfectly
healthy — self-feeding, because going offline starts a backoff poll into the
same bucket, and shared, because an office NAT is one bucket for everyone behind
it. `/healthz` therefore never answers 429: over the limit it answers from the
memo. `skip` covers the other direction, since a healthchecker reads 429 as
"down" and restarts the container.

What protects the pool is that memo (`habiterall-cloud/src/health.js`), not the
limit. `PG_POOL_MAX` is 10, and a per-IP limit is the wrong shape for pool
exhaustion anyway — a distributed flood pays nothing for a fresh bucket, while
one second of memo caps the cost at one connection per second however many
callers arrive. Its `inflight` half is what makes that true of the case that
matters: a burst on a cold memo would otherwise open a connection each and fill
the memo afterwards. It lives in its own file because `server.js` starts a
server at import time, so nothing declared in it can be unit tested — and the
failure mode here is silent in the worst direction, an `inflight` left set
reporting the last good answer forever while Postgres is down.

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
| Dashboard summary anchor | `npm run test:overview -w habiterall-personal` | nothing |
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

`unknowncheck.mjs` is where a tap is followed all the way to storage: it taps a
day and then asks the API what the row says, because the whole `questionMarks`
distinction is between a row holding 0 and no row, and with the setting off both
cells are the same empty square. A unit test can pin the cycle; only this can
catch the grid and the database disagreeing about which of the two happened.

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
