# Time zones, callerDay and the device clock header

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**Whose clock a server-sent reminder is on is resolved in ONE place, and the
answer has three tiers.** `resolveTimeZone` (shared/src/notify.js): the zone the
account NAMED wins, else the zone its last client reported, else the server's
own. `notifyTimezone` defaults to `auto` — the second tier — so an account that
has never opened the settings dialog gets reminders on its own clock instead of
on a container's, which is UTC in both compose files and therefore right for
almost nobody.

The reported zone is **stored apart from the setting**, and that is the whole
design rather than an implementation detail. It is an OBSERVATION the server
makes from a request header; `notifyTimezone` is a DECISION the user sent. Fold
the first into the second and the first client to check in turns "follow my
device" into a chosen value, after which nothing can reach automatic again and a
stale detection outlives the trip that caused it — the same distinction
`theme: 'system'` and `at_most_unlogged: 'default'` already draw, and the reason
`''` keeps its old meaning of "the server's clock, chosen deliberately". It is
also why it is a `device_clock` table in personal and a `users` column in cloud
rather than a key in the settings blob: `/api/export` carries settings, and
restoring a backup on a laptop abroad must not move when your reminders arrive.

**It costs no extra request.** `X-Habiterall-Timezone` rides on traffic both
clients already make — `ui/api.js`'s single `fetch` and an OkHttp interceptor in
`Api.kt` — and the server writes only when the value CHANGES, so a settled
account writes here never. This is not a mirrored RULE: the client reports a
fact and the server decides what it means, so there is nothing to drift.

**That header answers a SECOND question, and it is deliberately not the same
question.** Every route that asks "is this today?" was asking it of the process:
`assertNotFuture(date, today())` guarded the entry write, and the same date
clamped `/overview`'s `summaryEnd` and `/stats`'s `end`. `today()` is the
container's calendar day, which is UTC in both compose files and therefore right
for almost nobody — so a user east of the server had the current column of their
own grid **refused as a future date**, for as many hours a day as the offset.
Thirteen of them in Auckland, nine in Tokyo, two in Berlin. The message said
`cannot record entries in the future` about a day the user was standing in, and
`recordValue` rolled the paint back, so the tap looked like it had failed at
random.

The refusal is the loud half. The read anchors are the quiet one: a day that was
recorded was scored as of the server's yesterday, so ticking today left the
streak sitting still — the same "paging back restates the summary" defect
`test/overview.integration.mjs` exists for, arriving from the clock instead of
from a query parameter. Fixing only the write leaves that, which is why
`callerToday` is applied to all three.

`callerDay` (shared/src/notify.js) is the rule, and it reads the HEADER and
nothing else — not `resolveTimeZone`, though that is one call away and was the
obvious reuse. Two questions, two answers, and folding them together breaks
whichever one loses:

- `resolveTimeZone` asks where an ACCOUNT is, so that a reminder nobody is
  present for still goes out at the right hour. Its first tier is the zone the
  user NAMED, which is how somebody abroad keeps reminders on home time.
- `callerDay` asks what day it is for the client making THIS request. The grid
  draws its last column from the browser's own clock and never from a setting,
  so judging its tap against a named zone re-breaks the write for exactly the
  person who set one. And the stored zone is the last one ANY device reported,
  so a desktop in Berlin would have its day decided by the phone that checked in
  from Tokyo an hour ago.

A caller that reports no zone gets the server's clock, which is what it got
before this existed — so adding the rule moves no caller's day, and the fallback
is pinned by a test rather than left to drift into something wider.

**That fallback has one real caller, and it is not the one it was written for.**
Reasoning about it reached for curl and old clients; the browser's own **replay
queue** is on it. `flush()` rebuilds a queued write from a record holding a url,
a method and a body, so a check-off tapped offline went back out with no zone on
it — judged by the container's clock, refused as a future date, and then
**dropped**, because a 4xx that is not 401 or 403 is permanently inapplicable.
The queue exists to prevent exactly that loss and was causing it, in the window
between the user's local midnight and the server's: thirteen hours a day at
UTC+13. The only surface was "1 change could not be synced". `Api.kt` sets the
header from an OkHttp interceptor on *every* request, so the identical tap
always survived on the phone — which is what made this read as a browser flake
rather than as a hole in a rule.

The header is therefore added in `flush()`, and the zone is read at REPLAY time
rather than stored on the record. Three call sites enqueue (`api()` twice, and
`ui/settings.js` directly, bypassing it), so capturing it at submission would be
one rule in three places — and replay time is the better answer anyway for the
case that motivates it, since the queue drains seconds later on the same device.
`deviceClockHeader` moved to `offline.js` so both senders share one definition.
It did not become a module of its own because a new file under `shared/public/`
has to join `sw.js`'s `SHELL` and bump `CACHE_VERSION`, which costs every
installed client its data cache to buy one import.

The Discord button handler keeps `resolveTimeZone` (`adapter.today`) and is not
an exception to any of this: a press arrives from Discord, so there is no device
making the request and no header to read — the account is the only thing there
is to ask. What it fixes is that the two paths now AGREE in the ordinary case,
where they did not. Pressing Yes on Monday's reminder wrote the row while
tapping Monday's cell in the browser answered 400, on the same account, the same
day and the same storage, because one path resolved a zone and the other did
not.

**What this is NOT is one day of slack**, which is the shape the issue proposed
and the arithmetic does not support. The spread is UTC−12 to UTC+14, and 26
hours is wide enough for **two** calendar days at once: at 10:00 UTC,
`Pacific/Kiritimati` is on the 17th while `Etc/GMT+12` is still on the 15th —
and `Pacific/Niue` against Kiritimati, both inhabited, is the same two days. So
`today + 1` is both too narrow at the edges and too wide everywhere else, since
it accepts a genuinely future date from every caller on Earth to fix the ones it
can reach. The guard stays exact; it is the day it is exact ABOUT that moved.
`shared/test/notify.test.js` asserts the two-day gap directly, so the reasoning
is checked rather than recorded.

**That arithmetic only holds because a zone has to be a NAME**, and making it
one is also what bounds a cache this put a request header into.
`parseTimeZone` used to return the string it was handed; it returns the
canonical name now, and refuses offset zones. Both halves are the same
observation — `Intl` accepts far more spellings than there are zones. It matches
case-insensitively and resolves aliases, so `america/new_york`,
`AmErIcA/nEw_YoRk` and `US/Eastern` are all accepted and were all distinct keys
in `formatterFor`'s map, which holds a built formatter and never evicts.
Harmless while the only caller was the notifier tick reading a stored setting;
`callerDay` reads its key off a header, so a client could mint valid spellings
for as long as it cared to. Measured: 16,384 case variants of one name retained
2.2MB after GC — per limiter key, which is per IP in personal and per USER in
cloud. Canonicalising collapses them to one entry and caps the map at the ICU
zone table whoever is calling.

Offsets go for a second reason on top of that one: `+23:59` is a zone `Intl`
takes, and it is two days ahead of `Etc/GMT+12`, so the UTC−12..UTC+14 window
above was not the real bound until they were refused. They are also not zones in
the sense the rest of this cares about — a fixed offset does not observe DST, so
an account holding one gets its reminders an hour out for half the year. Nothing
can send one: both clients report `resolvedOptions().timeZone`, which is always
a name, and Java's fallback spelling (`GMT+05:30`) `Intl` rejects outright. The
test is for a leading sign rather than for a slash, because `UTC`, `GMT` and
`Etc/UTC` all canonicalise to `UTC` and a slash test would have thrown them
away.

The export filenames still stamp the server's day, deliberately: nothing reads
them back, and a `Content-Disposition` is not a claim about anybody's calendar.

Two traps, both of which bit while this was written. `deliverAccount` used to
re-derive the zone from `settings.notifyTimezone` for `dueReminders`, which was a
SECOND place the clock was decided — and the two answers diverged the moment
`auto` existed: `collect` resolved it to the device's zone while this passed the
literal string `auto`, so every reminder for a following account was judged
against the wrong day and reported `too_late`. The account carries its resolved
`timeZone` now. And `new Intl.DateTimeFormat` THROWS for a zone it does not
know, inside a loop that runs once per account, so one bad value would have
ended the tick for everyone; `formatterFor` falls back to the server's clock
instead.


