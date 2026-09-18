# The reminder tick, watermark and delivery status

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**A server-sent reminder is written down after it is sent** (`notify_log`,
keyed on habit + channel + the user's *local* date). Without that watermark a
minute-by-minute tick re-sends for as long as the catch-up window lasts. Keyed
per channel, or enabling a second destination is silenced for its first day by
the send to the first; keyed on the local date, or a user east of the server
gets it filed under the wrong day and again a few hours later.

**...and under `auto` that local date can move, which reads as a bug and is the
trade.** `resolveTimeZone`'s second tier is the zone the account's LAST CLIENT
reported, so an account genuinely used from two zones either side of a date
boundary can have the boundary crossed by a device checking in rather than by
time passing — and the two directions fail differently, which is the part worth
getting right. **Forward** (Los Angeles to Tokyo) moves the date on, the log's
row sits under the earlier one, and the gate opens: inside the catch-up window
that is a second send, the same habit twice in one UTC day, one per zone; past
it, `too_late`, at warn. **Backward** (Tokyo to Los Angeles) moves the date onto
a day the log already has, so the answer is `already_sent` — never `too_late`,
because that gate is asked FIRST and a present row wins however late the minute
is, which is the ordering `notify.too_late` exists to preserve. The arrival day's
reminder is simply suppressed, and `already_sent` logs at debug, so the symptom
is the absence of a line rather than the presence of one. A first version of this
paragraph had the two backwards and sent an operator looking for a warning that
cannot appear.

The keying is deliberately left alone: a UTC date is the defect the local date
was chosen to fix, and adding the zone to the key makes the duplicate certain
instead of possible, since two zones would then never share a slot. It is
bounded by how often somebody carries one account across a date line, and an
account that NAMES its zone — tier one — does not have it at all. Written down
in `dueReminders` because the day it happens it will be reported as a bug.

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

## Per-weekday reminders: the gate, its clock, and where it sits (#72)

A habit reminds on the weekdays its `reminder_days` mask names. The mask is a
7-bit integer in which **bit N is JavaScript's own `getDay()` N** — bit 0 Sunday
through bit 6 Saturday — defaulting to `127`, every day, which is what every
habit written before the column existed was already doing. The rule itself is one
declaration (`remindsOn` / `parseReminderDays` / `weekdayOf` in
`shared/public/ui/time.js`), imported by `shared/src/notify.js`,
`shared/src/validate.js`, `shared/src/import.js` and `shared/public/ui/nudge.js`
alike, with Kotlin's `ReminderTime` as the only mirror. The Loop side of it —
why the stored spelling is ours rather than Loop's Saturday-based one — is in
`docs/decisions/import-and-loop.md`, and that is where the verification lives.

**The gate reads `clock.date`, and asking any other clock is the defect.**
`dueReminders` already resolves an account's own calendar day through
`resolveTimeZone` before it decides anything, so `clock.date` IS the account's
today; the weekday comes off that string, by arithmetic, with no zone re-entering
the calculation (`weekdayOf` builds the date in UTC for that reason, and sets all
three fields at once so a year under 100 is not silently read as 19xx). The
alternative that looks identical from a desk in the same zone as the container is
`new Date().getDay()`, and it is wrong the same way the pre-#157 `TZ` fallback
was wrong: for an account far enough east or west the server's weekday and the
user's are different days for several hours every single day. A Monday-only
reminder would fire on Sunday evening in Auckland and be silent on Monday
morning, weekly, with a perfectly correct-looking `07:00` beside it in the
dialog. This is the same distinction `zonedClock` exists for — the zone decides
which DAY it is, not only what o'clock — and the test that protects it is a
`notify.test.js` case built at an instant that is still Sunday in UTC and already
Monday in `Pacific/Auckland`. A weekday test run only in the runner's own zone is
the test-that-cannot-fail shape here.

**Its position in the gate order is an argument, not an accident.** The gate is
asked beside `no_reminder_time` — ahead of `done_today`, `already_sent` and
`too_late`. `notify.too_late` is a WARN whose whole meaning is *a reminder was
LOST*, and the catch-up window closes half an hour after the minute, so any habit
whose masked-out day is more than 30 minutes old is also past it. Put the weekday
gate below the lateness check and every weekend, every weekdays-only habit
reports itself as a lost reminder, once per habit per channel per day — which is
the same failure the ordering of `done_today` / `already_sent` already exists to
prevent, and is worse than not warning at all, because a genuine loss then
arrives in a crowd. A day the habit does not remind on is not a lost reminder; it
is a day with nothing to send. Its own reason, `not_this_weekday`, logs at debug
like its neighbours and carries the normalised mask it judged on, for the reason
`skip` reports the zone the clock USED rather than the one that was asked for.

**`0` is a legal mask and nothing may repair it.** It means the habit reminds on
no day, and the scheduler then simply never matches — no special case anywhere.
Loop's own `EditHabitActivity` snaps an emptied picker back to every day, and
that remains available to a PICKER; it must not migrate into `parseReminderDays`,
because a validator that turns 0 into 127 is precisely the defect #78 refused to
ship (a Loop mask of zero becoming a daily reminder). The web picker keeps the
two apart by saying plainly, under the boxes, that nothing will be sent.

**Both notifiers reach the column through `SELECT *`, and that is load bearing.**
`habiterall-personal/src/notifier.js` and `habiterall-cloud/src/notifier.js` both
select the whole `habits` row. Narrow either one to an explicit column list —
which is a normal thing to do when tuning a query plan, and the cloud suite has a
plans test that invites it — and `reminder_days` is simply absent from the object
handed to `dueReminders`. `parseReminderDays` then answers its default, so the
gate opens for every day of the week, for that edition only, with every test
green and nothing in a log. It is the two-editions-disagree shape, arriving
through a change that has nothing to do with reminders.

**The browser's own channel carries the same gate.** `outstanding` in
`shared/public/ui/nudge.js` asks `remindsOn(habit.reminder_days, date)` in the
same position — after the time is read, before lateness — against the `date` the
caller handed in, which is this device's own `todayISO()` and the same day the
grid draws its last column from. Taking a fresh clock there is the defect
`minutesNow` already warns about: a nudge judged against a different day than the
row it is about. Adding the import cost `nudge.js` its "dependency-free"
description; the property that actually mattered was always *loadable under Node
by `shared/test/nudge.test.js`*, and a relative specifier to a sibling with no
imports of its own keeps it, exactly as `ui/calendar.js` already reaches
`./dates.js`.

**The phone gates twice, on purpose, and one of those is what makes it work
offline.** `Reminders.schedule` arms through `nextAllowedOccurrence`, which
layers a weekday filter over `nextOccurrence` rather than replacing it —
`nextOccurrence` is a wall-clock promise with DST guarantees pinned by their own
tests, so each candidate day is still its answer — bounded to seven candidates,
because seven consecutive days name every weekday and a mask of `0` must arm
nothing rather than search forever. `needsReminder` then asks again when the
alarm fires, for the same reason `stillAboutToday` beside it does: an inexact
alarm on API 31–32 armed for an allowed 23:52 can be delivered at 00:03 on a day
the mask does not name. `ReminderReceiver`'s offline branch reached neither until
#72 — it answered a bare `true` when there was no API to ask, which is the right
instinct (a redundant reminder beats a missed one) applied one level too high. It
now errs toward notifying *through* `needsReminder` with an empty entry list, so
the only thing left for it to refuse on is the weekday, which is exactly the
question a phone with no network can still answer for itself.

**A tick used to cost the SUM of its accounts, and the two channels do not want
the same fix.** `collect` and delivery both went one item at a time, so an
instance with 400 accounts paid for 400 sequential round trips even though
nothing forced them to be sequential, and the sharpest symptom of that shape was
the `Retry-After` sleep in `deliverAccount`: a single ntfy 429 put the whole
shared loop to sleep on every other tenant's behalf. `mapWithLimit`
(`shared/src/notify-send.js`) is bounded fan-out rather than `Promise.all` over
the whole set — the pool has ten connections and Discord rate-limits, so an
unbounded fan-out of 500 replaces one problem with two — but the two server
channels do not want the same NUMBER, and that is the actual point of the
change, not an implementation detail of it. Discord rate-limits per webhook
**in webhook mode**, so there a 429 is one account's own doing and its wait is
paid only by the account that caused it: Discord sends from different accounts
can run at once with nothing between them. In **bot** mode — one bot token
shared by every account on the instance, and the setup this project's own
notifier comment calls "recommended" — Discord's buckets are per bot token
and per route instead, so a 429 there is NOT one account's own doing: the
other seven workers keep firing at the same shared bucket while the one that
tripped it waits out its own `Retry-After`. That is known and deliberately
left ungated: eight concurrent posts are unlikely to trip Discord's global
limit, no measurement here suggests it binds, and adding a second gate on
that guess would cost more than the inaccuracy it corrects. ntfy.sh
rate-limits per **visitor IP**, which for a server-sent reminder is the whole
instance — one bucket shared by every tenant on it — so sending ntfy in
parallel across accounts does not just leave that bucket unprotected, it is
strictly worse than the sequential loop it replaces. A single global
concurrency limit is wrong for one of these two channels whichever number is
picked, which is why delivery fans out at the account
level and then gates ntfy again, per destination host, with `gatedByHost`: at
most one ntfy send in flight per host, so accounts on different self-hosted
ntfy servers still run in parallel and only a shared bucket ever queues.

**`collect`'s own concurrency is derived from the pool, not written as a
literal.** Each account's read is a transaction of four queries inside
`withUser`, and a busy tick still has to leave connections for whatever live
request is running at the same moment — a literal high enough to help a large
instance is exactly the number that starves `/overview` on a small one.
`COLLECT_CONCURRENCY` (`habiterall-cloud/src/notifier.js`) reads the pool's own
configured max (`PG_POOL_MAX`, the same number `poolGauge()` reports as
`pg_max`) and takes roughly half of it, floored at 1 so an operator who pinned
the pool down to serve one thing still gets a tick that completes, and capped
at 6 so raising the pool to serve more API traffic does not hand the notifier a
proportionally larger share of it. A `NOTIFY_CONCURRENCY` env var was the
obvious alternative and was rejected on purpose: it is one more number an
operator has to remember to keep under the pool size they set, and getting that
relationship right is the one thing this constant exists to do without being
told.

**Cloud's tick moved out of the web process into its own container (#194),
because a fleet of `app` replicas was running the tick N times, not once.**
Measured against the pre-split arrangement (`server.js` calling `startNotifier`
at boot, same as personal still does): N replicas meant N sequential scans of
the full `users` table every interval, N sets of per-account transactions
competing with request traffic for the same `PG_POOL_MAX`-sized pool, and — the
one that is not a performance argument — **N Discord gateway WebSockets, all
subscribed to the same bot token, racing to answer one button press.** A
Postgres advisory lock (`pg_try_advisory_lock`) is the cheap fix for "N
replicas doing the same job" and was considered and rejected: it would have
serialised the SCAN across replicas, but every replica would still open its
own gateway socket, because a lock held around a tick says nothing about a
long-lived connection opened once at boot and kept for the process's whole
life. Extraction removes the problem instead of arbitrating it: there is now
exactly one process that ever calls `startNotifier`, so there is nothing left
to elect a leader among.

`habiterall-cloud/src/notifier-entry.js` is that process — the tick, the
Discord gateway and the scheduled dump, and nothing else: no Express, no
session store, no API routes. It must never run more than one at a time, which
is a stronger constraint than "don't scale the app": **on Kubernetes,
`replicas: 1` is not sufficient**, because the default `RollingUpdate`
strategy starts the new pod before terminating the old one, so every ordinary
deploy has a window with two gateways open — both able to answer the same
three-second button press, with Discord showing "This interaction failed" on
whichever one it did not credit. `strategy: { type: Recreate }` is the fix,
and it is one line nobody writes unless they already know a rolling update can
double a singleton. **There is no compose equivalent, and reaching for one is
how this went wrong the first time.** The draft paired `restart: on-failure`
with a nothing-to-run case that exited 0, presenting it as the same singleton
idea one layer down. It is not: the restart policy answers "should the daemon
bring this back", and the singleton rule answers "may two of these run at
once" — different questions, and the first one has an answer that made the
second irrelevant. A host reboot or a `systemctl restart docker` SIGTERMs
every container; this one drains and exits 0; the daemon returns, restores the
`unless-stopped` services and leaves the `on-failure` one down, because 0 is
not a failure. The deployment keeps its dashboards and silently loses every
reminder and the nightly dump, with a correct, clean `shutdown.early` as the
last thing in its log. So the shipped policy is `restart: unless-stopped`, the
same as `app`, and the entry point **parks** rather than exiting when it has
nothing to run — an idle container is the cheaper half of that trade by a
wide margin.

**The split has a cost, and it is stated rather than hidden: `GET
/api/backup/status` is answered by the app, not the notifier.** The dump now
runs in a process the dashboard's "Backup and restore" dialog does not talk
to, and `backupEnabled()` reads `HABITERALL_BACKUP_DIR` /
`DATABASE_URL_ADMIN` from *that request's own process* — the app's
environment. An operator who moves the admin credential to `notifier` (the
correct, least-privilege placement — see `habiterall-cloud/CLAUDE.md`'s
"Scheduled backups" section) gets backups that run correctly and a dialog that
reports them as off, because the app was never asked and never dumps. Fixing
that would mean either the app calling out to the notifier for a status it
cannot otherwise see, or a shared status table — both rejected for the same
reasons a status table was rejected for the dump's own "last outcome" (no
tenant may read instance-level operator state, and a nightly write is not
worth a migration). The operator-facing answer is to set the credential on
both: `notifier`, which is what dumps, and `app` as well, purely so the dialog
agrees with reality.

### Taking the server away took the thing that held the loop open

The first version of the split ran one tick and then exited 0, silently. It is
worth recording in full, because nothing about it is visible in the diff that
caused it and the shape recurs: **a line whose correctness depended on a
property of its only caller, in a change whose whole point was to add a caller
without that property.**

`startNotifier` (`shared/src/notify-send.js`) ended with `timer.unref?.()` and
a two-line comment: *"Nothing here should keep a process alive on its own; the
HTTP server is what does that."* That was true, and right, of every caller it
had ever had — both editions started the tick inside a process that also
called `app.listen`, and a ref'd interval there would have kept a drained
server alive past its own exit, defeating `installShutdown`. `notifier-entry.js`
has no server.

What makes it worse than an obvious oversight is that it is **configuration-
dependent**, so half the deployments would have looked fine. A Discord bot
token opens a gateway WebSocket, and a socket is ref'd — so an instance with
`DISCORD_BOT_TOKEN` set stays up on the socket's ref and nobody sees anything
wrong. A webhook-only, ntfy-only or backup-only instance opens nothing that
outlives a tick: the pg pool's idle clients are gone after
`idleTimeoutMillis` (30 s), `fetch` closes, `pg_dump` is a child process that
does not run most minutes. Nothing refs the loop and Node leaves.

Measured against the real entry point and a real Postgres, on the shipped
defaults (`HABITERALL_NOTIFY_INTERVAL_MS` unset, so a 60 s tick):

| t | state |
|---|---|
| 0 s | boot, `notify.starting`, first tick runs cleanly |
| 5-40 s | alive |
| ~40-45 s | **exited, code 0, no signal, no log line** |
| 60 s | the second tick was due here, and never came |

`restart: on-failure`, which the draft carried at the time, does not restart an
exit 0 — and note this measurement is what put the policy itself under review
one section up, where it became `unless-stopped`. So the draft arrangement was
a notifier container that
went quiet under a minute after every boot, took the nightly backup with it,
and said nothing in any log about why. Against an *unreachable* database it
dies in about a second, which is what made it catchable in a suite that needs
no Postgres.

The fix is `ctx.keepAlive`, **defaulted off**: personal keeps the unref,
because personal's tick still shares a process with a server, and cloud's
`start()` (`habiterall-cloud/src/notifier.js`) passes `true` because since
#194 its only caller is a process with none. It is pinned twice and
deliberately at two levels, because pinning the decision is not pinning the
wiring: `shared/test/notify.test.js` starts a notifier in a CHILD process and
asserts it exits without the flag and survives with it — the property is "did
the event loop stay open", which is not observable from inside the process
being kept alive — and `habiterall-cloud/test/notifier-entry.integration.mjs`
asserts the real entry point is still alive half a second after its first
tick, which is the half that catches the flag being dropped from the ctx.
Deleting `keepAlive: true` from `notifier.js` leaves `npm test`, `typecheck`,
the cloud API suite and the tenancy suite entirely green and fails exactly
those two.


