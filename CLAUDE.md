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
npm run test:browser        # UI suites — needs Chrome + a running server
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
editions still count a completion as `value = 2` — personal in `countCompleted`,
cloud in an inline `COUNT(*) FILTER`. But some ranges *start* at
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

Note "bare" is `!notes.trim()` and not `!notes`: a note of one space is truthy,
and content is what suspends the rule, so whitespace was enough to buy a lapse
the right to overwrite eight recorded glasses.

**On a merge the FILE's type says how a value was written down; the ACCOUNT's
says what may be stored.** These are two questions and answering them with one
type is how a file claiming `numerical` put an `8` on a boolean habit — a value
`PUT /entries/:date` answers 400 to, and one `isCompleted` reads as *not done*
forever. But the file's type still has to decide the *encoding*, because a `3`
is Loop's skip sentinel in a boolean column and three-of-something in a
numerical one; reading that against the account would re-create the value/skip
collision this file opens with. So the two rules run together, and the yield
above was gated on `type === 'boolean'` while they did not — which is what let a
merge rewrite eight glasses to a 2.

Where the two types genuinely disagree only a **lapse and a skip cross**: zero
glasses and "no" mean the same thing, and so does a skipped day. An amount is
not a yes and a yes carries no amount, so those days are reported in `skipped`
rather than invented. One asymmetry, deliberate and pinned by a test: a **skip
does not yield**. It is an answer — `isCompleted` returns `null` for it, not
`false` — so a `SKIP` cell in a bare Checkmarks.csv does overwrite a recorded
amount, where a bare lapse does not.

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

**An export reports what it could not carry; it does not fail on it.**
`isoToLoopTimestamp` is `Date.UTC`, which rolls a date over rather than refusing
one, so `2026-02-30` left as 2026-03-02 — and if that day held a real row, the
Loop file's UNIQUE index on (habit, timestamp) rejected the insert and
`/api/export-loop.db` answered **500 for as long as the row existed**, naming
neither the habit nor the date. Restoring your own backup is how such a row gets
in. `isLoopEncodableDate` is the gate, and it asks the exporter's question
rather than the calendar's — *does the timestamp read back as the day it came
from* — which is narrower than `assertDate` on purpose: that one also rejects
years 1-99, as a side effect of the same legacy two-digit mapping, and #81 is
teaching the encoder to carry them. This gate weakens by itself as the encoder
improves, with nothing here to remember to update.

The collision is only the loud half. With no real row on the day it rolled onto,
the export SUCCEEDED and filed the entry under a day the user never recorded, so
catching the UNIQUE violation alone would have left the silent corruption in
place and called it fixed. Two surfaces report the skips because neither reaches
everybody: `X-Habiterall-Export-Skipped` carries the count for a client that
made the request itself, and `export.rows_skipped` carries the rows at warn for
the browser, which downloads through an `<a download>` and reads no headers.
The count-only header is not timidity — a habit name is free text and a `\r\n`
in one would throw inside the route, which is the 500 all over again. For the
same reason the report is `{habit, date, reason}` rather than `applyImport`'s
sentence: its reader is a log, where names never go.

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

**The habit FIELDS are held to that standard too now, and two of them were not
connected at all.** Loop's `question` is the prompt a reminder asks, which is
`reminder_message` under another name; its `reminder_hour` / `reminder_min` are
`reminder_time` in two integer columns. Both were dropped in both directions —
`NULL, NULL` and `''` were literals in the export's INSERT, and none of the
three columns appeared in the import's SELECT — so the one habit field a Loop
file could carry and habiterall refused was the one with a picker on two
clients. `loopReminderToTime` and `timeToLoopReminder` are the pair, and the
case that decides them is **midnight**: `00:00` is both columns holding 0, so
any check for a truthy hour reports a real reminder as none. Absent means
absent, which is why a half-filled row (an hour with a NULL minute) is no
reminder rather than `HH:00` — inventing that puts a notification on a phone
that Loop never had.

The CSV's version of this was a *pair* of bugs that concealed each other: the
export wrote `description` into the `Question` column as well as its own, and
the import read `idx('description', 'question')` — question as a fallback FOR
description. So a habiterall round trip copied the description over the prompt.
Both halves had to move together; fixing either alone looks like it works, and
the fixtures that catch it are the ones where a habit's description and prompt
DIFFER — make them equal and the broken code passes.

Be precise about what the import half did, because the obvious reading is wrong
and issue #67 had it wrong too: `idx` matches on **headers**, and Loop's
Habits.csv always has a `Description` one, so on a real Loop export the fallback
never fired and the question was simply **dropped**. It fired only for a file
with a `Question` header and no `Description` header — and there it was
arguably right. Loop's migration 23 is `update Habits set question =
description`: pre-v2 Loop had one free-text field and v2 renamed it, so in a
backup from a migrated install the user's prose sits in `question` because Loop
moved it. Reading it as a description was true to what they wrote. Following
Loop's reclassification is still correct — it shows that text in the
notification — but this is a reassignment of existing prose, not purely a fix.

**Only an ALL-DAYS Loop reminder is imported.** `reminder_days` is a 7-bit
weekday mask (127 is every bit; `WeekdayList` in Loop's source) and habiterall
has no concept of one, so a Monday-only reminder has no faithful form here.
Taking the time alone turned it into seven notifications a week AND wrote that
widening back into the user's own Loop app on the way out; a mask of `0` — a
reminder that fires on no day — became a daily one, which is exactly what the
hour/minute rule above refuses to do. Missing is the honest answer until #72
lands. On export the mask is `127` for a habit with a reminder and `0` for one
without, which is what Loop's own writer stores.

Two smaller traps in reading those columns, both of which produced a reminder
out of nothing. `Number('')` is `0`, so an empty column passed a
`Number.isInteger(Number(x))` guard as midnight — only digits count now. And the
three columns are selected as **TEXT**: read as INTEGER, a value above 2^53
makes node:sqlite's row decoder throw for the whole `.all()`, so one garbage
cell rejected an entire backup that used to import fine.

That is why the fidelity rules are now two lists. `LOOP_HABIT_FIELDS` is what
both Loop formats carry and `LOOP_DB_HABIT_FIELDS` adds `reminder_time`, because
Loop's own `Habits.csv` has no reminder columns — an asymmetry of the format,
asserted in both suites rather than assumed. Note the cloud suite seeds by
writing columns by hand and had simply never written `reminder_message`, so
every comparison of it held `''` against `''` and passed; the personal suite
seeds through the API and never had the gap.

**Loop's backup carries no preferences** — they live in Android's
SharedPreferences, not the database — so nothing from a Loop file can set one,
and `skipDays` / `questionMarks` arrive only in habiterall's own JSON backup.
That backup does carry settings now — it silently did not for a while — because
two of them decide what the rows in the same file MEAN. Not all of them, though:
`PORTABLE_SETTINGS` is the allowlist and `UNPORTABLE_SETTINGS` says what is held
back, the notification keys, because a backup is a file people email to
themselves and `discordWebhook` is a bearer capability for a channel. A
**replace** applies what does travel and a **merge** does not: "make this account
look like the file" versus "add these habits to what I have".

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
`entryWrite` (shared/src/validate.js) because three callers need it: both editions'
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

**The connectivity state is an output of that probe, and a failed write is its
one other input.** `watchConnectivity` polls only while it believes it is
offline — deliberately, and the note above is why — so nothing asks the server
anything while it believes it is online, and `online` / `offline` /
`visibilitychange` none of them fire when the interface is up and only the route
is dead. That is the shape of a stale tunnel or a container that has stopped
answering, and through one the app went on looking connected for as long as the
tab stayed open: no banner, and the queued-write count hidden inside it. So the
app's own failed write reports in, through the watcher's `reportOffline` and not
a bare `setOffline` — setting the state from outside leaves the watcher's `last`
at `true`, so it neither polls nor ever reports the transition, and the banner
sticks up until a `visibilitychange`. The FIRST failure is trusted: waiting for a
second means the tap that started the outage still hangs, and confirming with a
probe is exactly what the paragraph above forbids. A blip costs a banner for a
second or two, because the backoff poll this arms is what takes it down again.

Which only works because `/healthz` no longer goes through the service worker.
It is not under `/api/`, so it fell to `shellFirst`, which cached the first 200
and served it cache-first forever — measured with the server killed outright,
`isReachable()` still answered `true` from the shell cache. Every input the app
has about connectivity runs through that one call, so an installed PWA could not
notice an outage, and could not notice a recovery either. It is excluded now, as
`/auth/` already was.

**A request the app makes is bounded; the one that creates a habit is not.**
10s, in `ui/api.js` and in the worker's `networkFirst`, taken from `Api.kt`'s
`connectTimeout` rather than invented — Chrome imposes no ceiling of its own on
a response that never arrives (measured still pending at 300s), so before this
a check-off could sit in a promise until the tab closed and be lost with it.
The exemption is about REPLAYING, not latency: aborting does not recall a
request the server has already begun, so everything bounded here has to be safe
to arrive twice, and `POST /habits` is the one call on this path that is not —
it yields a second habit. Import, export and the notify test bypass `api()`
entirely, which is what makes a blanket bound safe for everything else.

This is the bounded half of #87 and not the whole of it: the write is still
attempted before it is durable, so the loss window is 10 seconds rather than
unbounded. Closing it means enqueueing FIRST, which changes the outbox from
"writes that failed" to "every write" and needs an idempotency key before it can
be done — `flush()` would otherwise replay a create that had already landed.

**One auth adapter, and the server says which mode it is in.**
`shared/public/auth-session.js` covers all four states — `none`, `password`,
`setup`, `oidc` — because with no build step there is nothing to pick a module
at package time, so baking the edition into a file meant the personal edition
could not make auth a runtime choice at all. `GET /api/me` carries `mode`, and
so does its **401**: a signed-out client is the one that needs to know whether to
draw a form or a link, and that response is all it gets. It replaced
`auth-none.js` and `auth-oidc.js`, and both editions' `app-entry.js` are now the
same three lines.

Which makes `/api/me` the one route that reads a session **without**
`requireAuth`, since it sits above the `/api` mount and has to answer a caller
who has none. It therefore has to repeat by hand every question that middleware
asks, and it did not: it checked that a session existed and not that it was still
valid against the current credential, so a revoked cookie got a `200` naming the
account it no longer had. That is the answer the whole boot is built on — the
app painted its signed-in shell and threw it away on the first dashboard fetch —
and it handed back the previous owner's username on the way.

**Boot has to be able to fail visibly.** Everything `start()` does before the
first paint now happens with every view hidden, so an error escaping it used to
leave a completely blank page under a toast that cleared itself in 2.6 seconds.
`#view-error` is that surface, and the case it exists for is not exotic: a
`CACHE_VERSION` bump drops the data cache, so the first offline boot afterwards
gets the service worker's synthetic 503 for `/api/me` — which `load()` correctly
refuses to read a mode from. The split in `start()` is deliberate: anything up to
and including the dashboard's first render goes to that view, and
`handleLaunchAction` afterwards only toasts, because by then there is a painted
app that replacing would be the larger loss.

**Sign-in belongs in the app, not in the reverse proxy** — because of the
Android client. `android-native/.../data/Api.kt` talks to `/api` directly,
outside the WebView, so a proxy's login form is one it cannot fill; exempting
`/api` to fix that exempts everything worth guarding. The app also needs a `401`
it can act on, and a proxy answers an expired session with `200` and an HTML
login page, which the offline replay queue feeds straight to a JSON parser. Both
editions therefore issue the same cookie (`SESSION_NAME`, `httpOnly`,
`SameSite=Lax`), so one path in `Api.kt` can carry either.

**And the phone gets that cookie two ways, because the two editions ask
different things of a person.** The personal edition holds one credential and
can be asked for it, so the app draws a form and posts `/auth/login`. The cloud
edition redirects to an identity provider, which decides for itself whether that
means a password, a passkey or somebody else's login page — no native form can
stand in for it. So cloud sign-in is the *server's own page*, loaded in the
app's WebView, and it works because the session is a cookie and
`WebSession` makes Android's `CookieManager` the one store OkHttp and the
WebView share. A Custom Tab could not do this: its cookies belong to the
browser. `httpOnly` is untouched by any of it — that flag stops JavaScript
reading a cookie, and this is the native API underneath.

That is what makes a token endpoint unnecessary, and with it an OAuth client the
operator would have to register. The cost is that `AuthMode` and `Auth.read` are
a **mirror** of `shared/public/auth-session.js`, pinned by `AuthTest` for the
same reason `ReminderTime` and `Grid.nextState` are pinned: both clients boot
the whole app on one answer, and two readings of it are indistinguishable from
one being broken. The rule that matters most is the one the web adapter shipped
wrong — only 200 and 401 say anything about how an instance authenticates. On a
phone that is sharper than in a browser: a captive portal answering 200 with
HTML is a state no retry escapes if it is read as "signed in".

**But the phone adds a second half to that rule, and it is the opposite of an
error path.** Everything that is not 200 or 401 is `Session.Unknown`, and the
app **carries on past it** rather than stopping. A native client boots through
this route, so making a bad answer fatal breaks the same instance the web bug
broke, by a different road: `HABITERALL_AUTH=off` never needed `/api/me` at all,
and the personal edition's read limiter keys on IP — so a household behind one
NAT can 429 it while the server is perfectly healthy. An early version of this
had a "the server answered oddly" screen and that is exactly what it would have
covered. The list's own error state already reports a broken server, with a
retry, and it is reached by the requests that actually need one. Being wrong
this way costs a round trip; being wrong the other way costs the whole app.

One consequence reached further than the sign-in screen. `Outbox`'s worker
dropped every 4xx as permanently inapplicable, which was right while nothing
could 401 — and became a silent data loss the moment sign-in existed, because
the answer tapped on a notification is still true about that day when the cookie
ages out. `ApiException.isPermanent` is the rule now, and 403 is excluded
alongside 401 for the reason the web outbox already had: a proxy rewriting
`Host` with no hop trusted makes every write look cross-origin, and that is a
misconfiguration that gets fixed.

**The security config is shared; the limiter's key is not.**
`shared/src/security.js` holds the CSP, the session cookie shape, the four rate
limits and the `TRUST_PROXY` rule, because those describe `shared/public/` rather
than an edition — two copies of a CSP is two chances to break the PWA in exactly
one of them. What stays per edition is `keyGenerator`: cloud keys per
authenticated user, personal keys on IP through `ipKeyGenerator`, which
normalises IPv6 to its /56 (a bare `req.ip` gives one client 2^64 buckets to
rotate through, and express-rate-limit v8 says so at startup rather than
failing).

**The absence of a field is not a statement.** `auth-session.js` resolves the
mode from `/api/me`, and it used to read "no `mode` in the body" as an answer:
`body.mode ?? (res.ok ? 'none' : 'oidc')`. Both guesses were wrong somewhere. A
429 from the API limiter carries no mode — and the personal edition keys on IP,
so one household behind one NAT shares the bucket — which replaced a working app
with a sign-in screen whose only control 404s, on an instance with no auth at
all. Offline was sharper still: the service worker answers an unreachable API
with a *synthetic 503* rather than throwing, so the `catch` that existed for
exactly this never ran. Only 200 and 401 say anything about how an instance
authenticates; everything else is a fault and belongs on the error path.

**A cookie session needs an origin check, and a missing `Origin` must pass.**
Both editions authenticate with a cookie, which is what makes forgery possible:
a form on another site POSTs here and the browser attaches the session.
`SameSite=Lax` stops that in every current browser and is why the cookie is set
that way — but it is a defence written in one attribute, invisible at the routes
it protects. `sameOriginOnly` states the other half where the requests are.
Browsers always send `Origin` on a state-changing request, so a mismatch is
forgery and nothing else. What has no `Origin` is a *native* client — `Api.kt`
answering a notification — and refusing those would break the Android client to
stop a request it cannot make. That is also why this is an origin check rather
than a CSRF token: a token must be fetched, held and replayed by every client,
and the point of both editions issuing the same cookie is that the phone needs
no special path.

Its refusal is a **403, and the outbox must not treat that as a verdict on the
write.** The replay loop drops any 4xx other than 401 as permanently
inapplicable, which is right for a deleted habit and wrong for this: `req.host`
is trust-proxy-aware, so a proxy that rewrites `Host` with no hop trusted makes
every write look cross-origin, and the first flush after that silently destroyed
the entire queue. 403 now keeps its place in line, exactly as 401 does — the
misconfiguration is fixable, and the writes replay when it is.

**`req.host` is the third thing `TRUST_PROXY` decides**, after the limiters' key
and — since the personal edition stopped deriving it from a URL — whether the
session cookie can be `Secure` at all. All three fail quietly and in different
directions, which is why `warnOnUntrustedProxy` names all three.

**A `Secure` cookie is a per-REQUEST answer in the personal edition.** It was
`PUBLIC_URL.startsWith('https://')` — one verdict for the process — which is
exactly wrong for the deployment `HABITERALL_UPGRADE_INSECURE` is written for:
https from outside, plain http from the LAN, same database. The browser at
`http://192.168.1.5:3000` discarded the cookie, so login answered 200, the page
reloaded, and the app came back signed out forever with no error at either end.
`secure: 'auto'` asks `req.secure` instead, so each way in gets its own answer.
Cloud keeps the URL-derived form: it has one public origin, demands `PUBLIC_URL`,
and has no LAN half to serve.

**The credential limiter is not switchable.** `HABITERALL_RATE_LIMIT=off` exists
so a test run is not throttled on ordinary reads; it briefly reached
`/auth/login` too, which turned it into "also remove the only bound on guesses at
a single shared password" — something no amount of trusting your own network
justifies, and which the name does not hint at. CodeQL found it, because routing
the limiter through a helper that might return a pass-through is also how a
static analyser stops being able to see it. The auth suite now counts the
attempts that get through.

**`upgrade-insecure-requests` is the caller's decision, not helmet's.**
helmet adds it by default, which is right behind TLS and a trap on plain http:
the browser rewrites every request to https, nothing is listening, and the app
does not load. It goes unnoticed on `localhost`, which browsers exempt, so it
only ever breaks on a real address. `cspDirectives(upgradeInsecure)` takes it as
a parameter because the two editions want different answers — cloud ties it to
its own scheme, personal makes it an explicit opt-in
(`HABITERALL_UPGRADE_INSECURE=on`) and defaults to off, because a self-hosted box
is commonly reachable over both schemes at once and deriving it would break the
plain-http half.

**`[hidden]` needs `display: none !important`** in the stylesheet. A `display`
rule silently beats the attribute, which once made the day editor show both
habit types' controls at once. Only a real browser catches this class of bug —
that is why `test/browser/` exists.

**There is one environment block per edition, and it lives in `examples/`.**
The published file and the checkout's own were maintained by hand and kept
drifting the same way: #54 added ten variables to
`habiterall-personal/docker-compose.yml`, none of them reached
`examples/docker-compose.personal.yml` or the README, and every test passed —
because the only check compared the examples against the README, and the two
stale copies agreed with each other. Verbatim equality could never have been
that check: the files differ on purpose, one carrying `build:` and the other
`image: ghcr.io/…`.

So each edition's own compose file **`extends`** the published example and adds
nothing but the build. `extends`, not `include`, and they are not
interchangeable: include loads another file's services *alongside* this one's
and warns rather than merging when a name appears in both, so the same shape
written with it yields a container with a `build:` and no environment at all —
which starts, and looks fine. Two things are restated by hand rather than
inherited: the top-level `volumes:` declarations, which `extends` genuinely
does not carry because it works at the service level, and `depends_on` —
Compose v1 never shared that between extending services and the current
documentation says neither way, so it is written out, which a mapping merge
makes free if it would have been inherited and correct if not. What is at stake
there is the cloud app starting against an unmigrated schema.

The published Authentik file is the exception and stays standalone, repeating
`db` / `migrate` / `app`, because downloading ONE file and running it is the
whole point of `examples/`. `shared/test/compose.test.js` is what keeps that
copy honest, and it is tied to the SOURCE rather than to the other file: it
walks the module graph from each edition's entry points and fails when a
variable something reads is documented in no compose file that ships it.

**Three wrinkles defeat the naive version, and each has its own test.**
`HABITERALL_USERNAME` and its two neighbours are read off an *injected* `env`
object in `shared/src/password.js` and never as `process.env.…` — those are
precisely the three #54 added, so a grep would have passed. `shared/src` is
shared, so attributing a read to an edition by file path is wrong: `password.js`
is personal's and `notify-send.js` is both editions'. Which modules a server
actually imports is the only honest answer, and it needs no list to maintain.

And the one that cannot be read at all: **`process.env[name]` with a computed
key.** `flag('AUTHENTIK_BRANDING')` in `bootstrap-authentik.mjs` reaches the
environment a function call away, so the name is nowhere near the read — and
self-service registration, its email-verification switch and the branding were
invisible to the discovery while every test was green. A file that does this
declares its own names in an **`@env NAME NAME`** marker, and a test fails when
one does it without a marker, so the next helper of that shape is loud rather
than silent. A marker is hand-kept and can go stale, so `flag`'s call sites —
which do name their variable — are checked against what the discovery ended up
with. That hole was found by a review, not by the suite: worth remembering when
adding the fourth form of reading an environment variable.

The **checkout compose files are in that manifest too**, listed rather than
taken on trust. `extends` covers `db` / `migrate` / `app` only, so the Authentik
services in `habiterall-cloud/docker-compose.yml` remain a hand-kept copy of the
published Authentik file's — unified for the app, guarded for the rest. Leaving
those files out would have reproduced #54 one service over.

`ELSEWHERE` in that test is the decision of what an operator is expected to
*tune* — the log settings, the limits, the pool — and each entry carries its
reason, with a test that fails when one outlives the variable it excuses. What
none of this covers is a variable documented with the **wrong default or a
stale comment**: all of it checks presence, and nothing short of booting a
container catches the rest.

The README's copies are generated (`npm run docs:compose`, `--check` in CI and
in `examples.test.js`) from HTML-comment markers, so the README stops being a
place you can forget to edit. Note what that replaced was itself broken:
"everything up to the first blank line" reduced `examples/Caddyfile` — four
lines, no header — to the empty string, and `README.includes('')` is true of
every README there has ever been.

## Testing

Several layers, and they catch different things:

| | command | needs |
|---|---|---|
| Unit | `npm test` | nothing |
| Types | `npm run typecheck` | nothing |
| Browser | `npm run test:browser` | Chrome + a server with `HABITERALL_AUTH=off HABITERALL_RATE_LIMIT=off` |
| Auth modes | `npm run test:auth -w habiterall-personal` | nothing |
| Credential change | `npm run test:credchange -w habiterall-personal` | nothing |
| Sign-in view | `npm run test:signin -w habiterall-personal` | Chrome (starts its own server) |
| Habit JSON shape | `npm run test:apishape -w habiterall-personal` | nothing |
| Reminders | `npm run test:notify` | nothing |
| Cloud reminders | `npm run test:notify -w habiterall-cloud` | Postgres |
| Backup round trip | `npm run test:roundtrip -w habiterall-personal` | nothing |
| Dashboard summary anchor | `npm run test:overview -w habiterall-personal` | nothing |
| Loop export vs a bad date | `npm run test:exportloop -w habiterall-personal` | nothing |
| Cloud API | `npm run test:cloud` | Postgres |
| Cloud round trip | `npm run test:roundtrip -w habiterall-cloud` | Postgres |
| Tenancy | `npm run test:tenancy` | Postgres |
| Compose files | `npm run docs:compose -- --check`, and the CI `compose` job | Docker, for the job |
| Android | `cd android-native && ./gradlew testDebugUnitTest lintDebug` | JDK 21 + SDK |

CI runs all of these on every pull request, plus both Docker builds. Publishing
images to a registry is a separate job that skips itself when the credentials
are absent — see `.github/workflows/README.md`.

The `compose` job is the one exception to the docs-only skip, deliberately: it
is the job that guards documentation, and a pull request that hand-edits a
generated README block is exactly the change the `code == 'true'` filter calls
docs and skips. It is also where `docker compose config` actually resolves
`extends` — the unit test can only assert the files *say* the right thing, and
whether the merge produced the right project is a question only Compose can
answer.

The round-trip suites export every backup format, import it back, and assert
nothing changed. They found two real bugs on their first run, both in the CSV
path. Three suites build a ~15-line fake DOM instead of a browser —
`atmost.mjs` and `rendercheck.mjs` drive `charts.js`, `daydialog.mjs` replays
`openDayDialog` — so anything reaching for a browser API there crashes them
outright rather than failing a check. `OFFLINE_SUITES` in `run.mjs` is the set
the runner will start without a server, and all three are in it — `atmost` was
not, so the runner demanded a server on behalf of a suite that builds its own
DOM, and reset the fixtures for it too. Add a suite to that set when it needs
neither.

`unknowncheck.mjs` is where a tap is followed all the way to storage: it taps a
day and then asks the API what the row says, because the whole `questionMarks`
distinction is between a row holding 0 and no row, and with the setting off both
cells are the same empty square. A unit test can pin the cycle; only this can
catch the grid and the database disagreeing about which of the two happened.

`hangcheck.mjs` holds a request open with CDP `Fetch.requestPaused` and never
continues it, because that is the only shape of "offline" that reproduces the
one that matters — a server that accepts the connection and answers nothing.
Devtools offline throttling is connection-refused, which rejects in about 3ms
and passes against a build with none of this in it. The same warning applies to
the unit half: the fake `AbortController` in `connectivity.test.js` used to have
a no-op `abort()` against a `fetch` that ignored the signal, so a
hang-and-assert-aborted test passed with no timeout in the code at all.

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
