# A day that ends after midnight (#76)

Nothing here is loaded automatically; the operative rules are in the root
`CLAUDE.md` ("Whose day it is"), `shared/CLAUDE.md` and
`shared/public/CLAUDE.md`. This is the argument behind them. `timezones.md` is
the prerequisite: it explains why the app already has two answers to "what day
is it", and this change adds a boundary to one of them and deliberately not to
the other.

## What was built

An account setting, `dayEndsAt`: `'00:00'` (default) through `'06:00'`, whole
hours. While the wall clock in the relevant zone is short of that hour, the
date the app treats as today is the PREVIOUS calendar date. At the default,
every behaviour is what it was before the setting existed.

Scope of this record: the server and the web client. The native Android client
is the next PR, which is why `dayEndsAt` is in `AppSettingsDefaultsTest`'s
`notMirrored` map for now, with that reason, and why the phone keeps the
calendar day until then.

## Decision 1 — the rule is one function, and the server imports it

`effectiveDay(date, minutes, dayEnd)` lives in `shared/public/ui/time.js`, with
`effectiveReminderMinutes`, `dayEndMinutes` and the `DAY_END_TIMES` list.
`shared/src/notify.js` imports it, exactly as it already imports `remindsOn`
from the same file; the browser's `ui/dates.js` imports it by relative path
(that module loads under Node, so an absolute `/shared/...` specifier is not
available to it).

The design as planned put a rule in each tier. As built there is no second copy
to drift: the only thing the server and the browser each own is WHICH wall
clock and WHICH boundary to hand it. Android will mirror it in Kotlin, the one
place a copy is unavoidable (it works offline), and `ReminderTimeTest`'s shape —
the same literal examples on both sides — is the model.

## Decision 2 — wall clock against the boundary, once, after the zone is resolved

`minutes < end` means the previous date and `minutes + 1440`. A reminder whose
time is `at < end` compares as `at + 1440`. The boundary is never subtracted
from an instant: "03:00 earlier than now" is an hour out twice a year across a
DST change, where "is the wall-clock minute count under 180" is not. The
previous date is arithmetic on the date's parts in UTC, canonical
`YYYY-MM-DD`, so `2026-03-01` at 00:30 is `2026-02-28` and `2027-01-01` is
`2026-12-31`.

A junk or missing boundary reads as `00:00`, because the value reaches the
server on a header a client controls. `includes` against the frozen list, not a
numeric parse.

## Decision 3 — the write guard stays on the CALENDAR day

`assertNotFuture(date, callerDay(req.get(DEVICE_ZONE_HEADER)))` is unchanged;
`callerDay` was not modified. The read anchors moved, the guard did not, and
that asymmetry is the point.

A client that has not yet fetched the setting — a cold boot, a second device,
a tab opened before the change — taps calendar-today at 00:30 and has no idea
the account's day has not ended. If the guard used the boundary, that write
would be a 400, and **a 400 is dropped from the outbox as permanently
inapplicable**. The tap would vanish. The cost of the loose guard is that a
date between "the account's today" and "the calendar's today" is accepted a
few hours early, which is a tap the user made on a day they were looking at.
Tomorrow's calendar date is still refused, and the suites assert both.

## Decision 4 — a caller reports its boundary on a header; routes read nothing

`X-Habiterall-Day-End` rides on every request, `00:00` included. Four read
anchors use it through `callerEffectiveDay` (compare, `/habits/:id/stats`,
`/awards`, `/overview`).

It is a header and not a settings read because cloud's `/overview` computes its
day before it touches the database, and the memo key already carries the
resulting day, so it needed no change. A route gaining a settings query for this
would be a read on the hot path of every request for a value the client already
holds.

It is sent on every request, not only when the value is not the default,
because the read anchors need it every time. `deviceClockHeader` returns both
headers and a zone failure still returns the day-end one.

**The routes do NOT `Vary` on it, and the first version did.** The zone is in
`Vary`; this header is not, and the reason is the Cache API. It selects a stored
response by comparing the VALUES of the headers its `Vary` names, so every
`/api/overview` and `/api/habits/*` entry in the worker's data cache is stored
under the day-end value in force when it was fetched. Change `dayEndsAt` once,
online, at an hour where `todayISO()` does not move, and nothing is refetched:
every cached entry now misses for any request carrying the new value, and
`caches.match` falls through to the synthetic 503. Detail pages stay stranded
until each URL is individually refetched. The `Vary` bought nothing in return:
`/api` responses carry no freshness headers, so no intermediary may reuse one
without revalidating, the worker fetches with `cache: 'no-store'`, and cloud's
memo key already carries the resulting day. `dayboundary.mjs` reloads offline
after a change and asserts the dashboard still renders.

Paths with NO client — the notifier's `collect`, `adapter.today` for the
Discord and ntfy buttons — read `settings.dayEndsAt` through `accountDay`, with
the zone `resolveTimeZone` chose. That is the same split `timezones.md` draws
between a request and an account.

## Decision 5 — the setting is portable

`dayEndsAt` is in `PORTABLE_SETTINGS`, array form in `SETTING_VALUES` (a fixed
list of seven strings, so the array form applies). It is a preference about the
person rather than the instance: restoring a backup on another server should
not move where their day ends, unlike the reported device zone, which is an
observation and which `timezones.md` keeps out of backups. Both round-trip
suites carry it at `'03:00'`, off its default.

Export filenames and the scheduled backups keep the SERVER's clock. They are
not a day anyone lives in.

## The reminder semantic

A reminder whose time is before the boundary belongs to the day that is
ENDING. With a 03:00 boundary, a Monday-only 01:00 reminder fires at 01:00 wall
clock on Tuesday, asks about Monday, and is governed by Monday's `reminder_days`
bit. At Monday 01:00 local the same habit is not due, `not_this_weekday`,
because that instant is logically Sunday. A 23:00 reminder sent on Monday is
still `alreadySent`-checked against Monday at Tuesday 00:30.

`dueReminders` therefore computes the effective day once, right after the
clock, and `remindsOn`, `alreadySent`, the returned `date`, `late` and
`not_yet` all read it, with `at` through `effectiveReminderMinutes`. The skip
log's `now` stays the wall clock (`clock.time`), since that is what a reader
comparing it to their watch sees; its `date` is the effective date.

The alternative — a reminder at 01:00 belongs to the NEW day and merely fires
late in it — was refused: it would ask about a date for which nothing has been
lived yet, and "did you do it?" at 01:00 means last night's.

## Edges left open

**A change of `dayEndsAt` can send one reminder twice.** The watermark
(`notify_log`) is keyed on the effective date, and a change moves which date a
tick asks about. A 01:00 reminder sent at Tuesday 01:00 under `00:00` is filed
under Tuesday; change to `03:00` at Tuesday 01:20 and the same tick asks about
Monday, finds nothing sent, sees the reminder 20 minutes late (inside
`CATCH_UP_MINUTES`, 30) and sends it again, about Monday. The reverse change
does the same. It needs a reminder timed between the two boundaries AND the
change made within the catch-up window after it, so it is at most one extra
message, once, per such reminder; an entry for the date asked about suppresses it.
Accepted rather than closed, because closing it means keying the watermark on
something other than the date, a migration in both editions for a setting
changed about once.

**A button can lose a race with a change.** A Discord or ntfy button carries the
date its reminder asked about, and the answer is judged against
`adapter.today(account)` at PRESS time. If the boundary moves between the send
and the press — `00:00` to `03:00` at 00:45, after a reminder dated Tuesday —
the account's day is now Monday and the button's date is the future: ntfy
answers 400 "in the future", Discord likewise. Pressing again after the day
ends works, and nothing is recorded wrongly; it is a refused tap, not a wrong
one. Not fixed: widening the future check for buttons would loosen it for
every press to cover a setting change, and the signed code already pins the
date to one the server chose.

**A reminder inside a skipped hour can be neither sent nor logged.** On a
spring-forward night, a reminder timed inside the hour that does not exist, with
`dayEndsAt` equal to the hour the gap ends at, never has a tick whose wall clock
matches it: Europe/Berlin, 2027-03-28, reminder `02:30`, `dayEndsAt` `03:00`. The
clock goes 01:59 to 03:00; the old day's clock never reaches 02:30, and at 03:00
the new day has begun and the reminder (compared as `at + 1440`, the day that is
ending) is not yet due. Once a year, one boundary value, one reminder. Accepted rather than
special-cased.

## How the web client follows a change

`ui/dates.js` holds the boundary as module state, set by `settings.onApply` in
`app.js` before any view. `onApply`, and not `onChange`: `onChange` fires only
when the server's answer differed from the cache, and the dialog's own Done
applies locally first, so the answer matches and `onChange` would stay silent for
the very change it is for. The dashboard's and the detail view's own `onApply`
listeners re-arm their day watch and call `refreshIfDayChanged`, and are
registered AFTER `app.js`'s, since appliers run in registration order.

`nextDayStart()` is `setHours` on the boundary hour on the local calendar, not
`+ 86400000`, for the DST reason in Decision 2. `calendarChart`'s own `realToday`
was a second reading of the clock (`new Date()` at midnight) that nothing pinned:
it decides which calendar cells are editable, so at 06:00 with the boundary
active it drew the calendar's tomorrow tappable. It reads `todayISO()` now and
`dayboundary.mjs` asserts the future cell has no `gridcell` role and the previous
date's does, then that the calendar date becomes one again at `00:00`.

## What it does not do

No re-bucketing of history: entries already recorded stay where they are, and
the dialog's help says so. No Android client (next PR). No widgets or midnight
alarm. No settings read in any route.
