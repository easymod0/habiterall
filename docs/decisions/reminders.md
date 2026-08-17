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


