# shared/public — working notes

The entire UI, plus the PWA. Both editions ship only `app-entry.js`, which calls
`start()` with the one auth adapter. Long-form reasoning for anything here is in
`docs/decisions/` — `dashboard-and-detail.md`, `amounts.md`,
`notifications-web.md`, `routing.md`, `settings-and-mirrors.md`.

`shared/src` is **not** served to the browser; only `shared/public` is mounted.
That is why `CHANNELS` and `SETTING_VALUES` are each declared twice and pinned by
a test, and why anything a page needs has to live on this side of the line.

**Adding a FILE or an EXPORT here is a `CACHE_VERSION` bump.** See the root
`CLAUDE.md`. It is why one-off helpers go in an existing module —
`deviceClockHeader` lives in `offline.js` rather than in a module of its own.

**`[hidden]` needs `display: none !important`** in the stylesheet. A `display`
rule silently beats the attribute, which once made the day editor show both habit
types' controls at once. Only a real browser catches this class of bug — that is
why `test/browser/` exists.

## The dashboard grid

**It fetches the window it is showing.** `/overview` takes an `end` date; paging
back without it re-rendered an empty grid, because the entries for that window
had never been loaded.

**...but `end` moves the GRID only.** It was deciding two things that want
different dates: which days are painted, and the date the row summary is computed
as of. Paging back a month restated the strength and the streak as of that month.
`summaryEnd` is `today()` in both editions' `/overview`. The detail view is the
surface that answers "as of when", and it has its own range controls.

**Column count scales with viewport width**, not one breakpoint — 7 / 10 / 14 by
width. At 768px the 14-column layout needed 668px of a 698px row and squeezed the
habit name to zero.

**...and the `gridDays` setting on top of it is a CAP.** `gridColumns`
(`ui/window.js`) is `Math.min(chosen, ladder(width))`, and that one `Math.min` is
the whole feature: without it the option reintroduces the bug the ladder fixes.
Because no offered value exceeds `GRID_DAYS`, changing the setting needs **no
refetch** and neither edition's route learns anything — offer a value above 14
and that stops holding silently, and the grid pages into days nobody asked the
server for. A test asserts every value in `SETTING_VALUES.gridDays` is at most
`GRID_DAYS`.

The list stops at 14 because `.view` is `max-width: 1100px`, so the habit row is
1060px at 1440, 1920 and 2560px alike — measured, not argued. Fewer columns buy
different things by width: above 640px `.check` is a fixed 44px so the gain is
room for the NAME; under 640px the row shares evenly and the gain is thumb
targets.

## The detail view

**Which cards it draws is a list of INVENTED IDS, and the server never hears
about it.** `detailCards` is a `multi` over `DETAIL_CARDS` (`shared/src/validate.js`),
gating the nine appends in `ui/detail.js`. Ids and not titles, because a card has
no id and the titles are English prose #144 will translate. The gate is on the
*append*, so a hidden card is never built.

Two things it deliberately does not do: it does not hide the four stat tiles, so
unticking everything leaves a page rather than a blank one; and it does not reach
`/habits/:id/stats`, because only three of the nine cards map to a field nothing
else reads, and a `?cards=` parameter would be one service-worker data-cache
entry per combination.

**A card that is not being DRAWN holds no position.** `forgetHiddenPositions` in
`ui/detail.js`, and it belongs there rather than beside the setting: the view
keeps a position in **two** places — `state.chartOffsets`, keyed per card by
`windowedChart`, and `state.calEnd` — and two of the four offset keys are built
from the CURRENT granularity, session override included. Only `detail.js` knows
that mapping. Both wrong versions shipped in one review round: clearing only
`chartOffsets` left the calendar at its old date, and clearing both from
`applyDraft` gated on "`detailCards` changed at all" sent a still-ticked History
card back to today.

`windowedChart` gives its range readout the same `.cal-range` class the calendar
uses, so a test looking one up must scope to a card by title.

## Amounts

**Recording an amount is a control, not a `prompt()` and not a spinner.** The
dashboard asked with `window.prompt()`, which blocks the event loop, cannot show
a unit or a target, and is suppressed outright by a browser that decides the page
makes too many dialogs. Both surfaces are `ui/count-field.js` over the rules in
`ui/amount.js`. The dashboard keeps its own write path — `recordValue`, which
paints before awaiting, because offline `api()` queues the write and THEN throws.

**A refusal has to be actionable, and what it QUOTES has to be true of what it
quoted.** `parseAmount` refuses `10,000` as ambiguous; `amountComplaint` names
the AMBIGUITY, which is the same whatever the digits are, and carries the
specifics in the advice — the user's own number with the commas taken out. Naming
the reading is what made the first version false (`1,500` was told it might be
ten thousand). The suggestion is run through the parser before it is offered, and
it decides the whole branch: `1,500 steps` is not ambiguous, it is not an amount,
and a box may not suggest something it would then refuse.

**Which character a decimal point is, is a DECISION with a device-shaped
default.** `numberFormat`, whose `auto` resolves against `Intl` at parse time in
`resolveNumberFormat`'s three tiers: the account's stated answer, else the
device's, else the app's. A group is refused under **every** convention — the
setting only moves which spelling is refused, never what is accepted, because
most accounts are on `auto` and a wrong guess that accepts costs a row out by a
thousand that nothing reports. `formatAmount` takes it too, and groups at no
size, so the control's output stays inside its own parser's domain.

`count-field.js` asks the settings cache and `Intl` at each read or write, never
at import time — either can change while the module is loaded.

**`ui/amount.js` is imported by `shared/src/discord.js`**, the one import
reaching from `src` into `public`. "DOM-free so it can be tested without one" is
now a contract with a server: a Discord modal is the same box arriving over a
socket, and its own comma-to-dot `Number()` read `10,000` as **ten**.

## The browser reminder (`web` channel)

**A page cannot keep a time, so this destination promises none.** Timers are
clamped in a background tab, a service worker has no wake-at-time event,
Notification Triggers never shipped, Periodic Background Sync picks its own
interval. What is built is the honest half: on boot and on `visibilitychange`,
anything whose reminder time has passed and whose day is still unanswered says
so. `delivery: 'device'` still fits — `serverChannels` filters on it, so an
account with only this on costs the tick nothing.

**`isDayAnswered` in `ui/nudge.js` is `answeredIds`,** mirrored because the nudge
runs from `state` with no network; `shared/test/nudge.test.js` runs both over the
same fixtures. The trap it is shaped to make unreachable is the at-most one: a
nullish entry answers `false` before anything else is asked, and `atMostUnlogged`
appears nowhere in the function, because `answeredIds` walks the rows that EXIST.
Written the obvious way, a limit whose unlogged days count as staying under
reports every untouched day as answered.

**The watermark is localStorage and never a setting.** A notification was shown
on THIS screen, so an account-level record would silence the laptop nobody opened
today — and settings are what `/api/export` carries, so a key there ends up in
people's backups. The date is stored WITH the ids, so a new day replaces the
record.

**What `state.habits` holds is an ANSWER TO A WINDOW.** `/overview` returns the
days it was asked for, so a grid paged back a fortnight holds entries that stop
before today, and a missing key means *never fetched* rather than *no row* — the
`?? UNSET` collapse from the other side. `state.gridLoaded` is the window the
server actually answered with (its `start`/`end`, never the request's), and
`covers` refuses the whole payload for a date outside it.

**A window falls short of today for TWO reasons and refusing answers only one.**
Paging back is the user's own act. The other is the clock: nothing refreshes on
`visibilitychange`, so a tab left open across local midnight holds yesterday's
window forever, and refusing there silenced every habit at 09:00 — the moment
this exists for. `check` asks once for a fresh window before giving up, and what
counts as fresh is the CALLER's policy: `app.js` declines when the grid has been
paged back and when a habit is open over the dashboard.

The blind spot that remains is stated in `check` rather than fixed: it reads what
has already been fetched, so answering on the phone can nudge a browser tab open
since morning. The watermark caps it at one per habit per day.

**The permission is asked for inside the click**, from the settings dialog — a
prompt nobody invited is refused outright, after which the destination can never
be granted. A `multi` option may carry `onEnable`. `denied` is unrecoverable from
script, so `SECTION_NOTICES` says so, and on a **non-secure origin** it is
`denied` and cannot be anything else (measured on a LAN address:
`isSecureContext` false, `Notification` still a function, no prompt,
`navigator.serviceWorker` undefined). `globalThis.isSecureContext === false` is
asked first, and `=== false` rather than falsy.

**What must NOT follow that prompt is a rebuild.** `renderSettingsBody` tears
every control out, and a permission is answered on the user's schedule —
measured: type a webhook URL without blurring, answer the prompt, and the field
is empty because `change` never fires on a removed input. `paintNotices` repaints
what a section SAYS and touches no control; `stage` and `refreshDeliveryNotices`
both go through it. `stage` paints them too, which covers a browser with no
`Notification` at all. Both `new Notification(...)` and
`registration.showNotification` are tried (the first throws on Android Chrome),
via `getRegistration()` rather than `ready`, which never settles on a page with
no worker.

## The theme

**A theme is a DECISION, and "follow this device" is one of the three.** `theme`
defaults to `system`, and `system` is a stored value rather than the absence of
one. It used to live in localStorage alone, where `initTheme` read
`saved ?? (prefersDark ? 'dark' : 'light')` while the button wrote one of two
values: once pressed there was no way back. `apply()` resolves `system` against
the device at paint time and never writes the resolved value back.

**What the device keeps is one record (`habiterall-theme`), an unconfirmed WRITE
rather than a second opinion.** A bare `light` is what the pre-setting build
wrote and is superseded the moment the server names any theme; `press:light` is
this device's own and is NOT retired by the account disagreeing, because the
write may still be in the outbox. Three things about the reply that retires it:
only a **full** reply may be read as "the account has no theme" (personal answers
a write with the accepted PATCH); **`wrote`** names the keys THIS device just
sent, which is how the dialog beats a press made on the same device; and a write
that ran out of time is **neither** a refusal nor offline, so the record stays.

**Two surfaces read that record rather than the account.** The settings dialog
seeds its draft from `currentTheme()`, not `settings.load()`, which cannot tell
"follows the device" from "pressed dark, write unconfirmed". And the button SHOWS
which of the three it is on (`◐` / `☀` / `☾`), because the cycle's last step is
the same appearance by definition — a `title` needs a pointer and an `aria-label`
needs a screen reader, so the third press did nothing observable on a phone.

**`set()` passes `[key]` as `wrote`**, as `save` and `saveAll` do — defaulting it
to `[]` says a write came from somewhere else, which is the signal `reconcile`
turns on. A `set()` write that runs out of time is **dropped rather than
queued**, for every key: the cache holds the value, the request may still land,
and replaying it would put it on top of whatever the user chose meanwhile.

## Routing

**A view is named by a fragment, never a path.** `#/habit/42` reaches the server
in neither edition: no static-serving change, no service-worker navigation rule,
nothing to teach a build step that does not exist. `ui/routes.js` owns it, and
two rules in `go()` are load bearing — writing nothing when the URL already says
this (`detail.open()` is re-entered by every zoom and paging control), and
pushing a habit while the list replaces (Back already goes home).

**A deep link does not paint the list on its way.** `start()` used to render the
dashboard first, so a link straight to a habit showed a full grid for as long as
the stats request took. The boot opens the habit alone. Two things keep it
honest: the URL still moves through the list (`routes.go(LIST)` before the habit
is opened), because that is the entry Back returns to; and `detail.open()`
reports whether it rendered, or a habit that will not open leaves the app showing
nothing. `routecheck.mjs` pins the flash with a MutationObserver installed before
the app boots — it lasts one request, less than a devtools round trip.

The Android WebView and a browser then disagree on purpose; see
`android-native/CLAUDE.md`, whose back-stack rules depend on exactly what
`app.js` writes to history during boot.

## Boot and auth

**Boot has to be able to fail visibly.** Everything `start()` does before the
first paint happens with every view hidden, so an error escaping it used to leave
a blank page under a toast that cleared itself in 2.6 seconds. `#view-error` is
that surface, and its case is not exotic: a `CACHE_VERSION` bump drops the data
cache, so the first offline boot gets the worker's synthetic 503 for `/api/me`.
The split is deliberate — anything up to and including the dashboard's first
render goes to that view, and `handleLaunchAction` afterwards only toasts.

**One auth adapter.** `public/auth-session.js` covers all four states — `none`,
`password`, `setup`, `oidc` — because with no build step there is nothing to pick
a module at package time. `GET /api/me` carries `mode`, and so does its **401**.
See the root `CLAUDE.md` for what the other status codes mean.

**A request the app makes is bounded** — 10s, in `ui/api.js` and in the worker's
`networkFirst`, taken from `Api.kt`'s `connectTimeout`. Chrome imposes no ceiling
of its own (measured still pending at 300s). The exemption is about REPLAYING,
not latency: aborting does not recall a request the server has begun, so
everything bounded has to be safe to arrive twice, and `POST /habits` is the one
call on this path that is not. Import, export and the notify test bypass `api()`.

This is the bounded half of #87: the write is still attempted before it is
durable, so the loss window is 10 seconds rather than unbounded. Closing it means
enqueueing FIRST, which needs an idempotency key before `flush()` can be allowed
to replay a create.

**The replay queue is the fallback's one real caller.** `flush()` rebuilds a
queued write from a url, a method and a body, so a check-off tapped offline went
back out with no `X-Habiterall-Timezone` — judged by the container's clock,
refused as a future date, and then **dropped**. The header is added in `flush()`
and the zone read at REPLAY time; three call sites enqueue, so capturing it at
submission would be one rule in three places.

**`/healthz` must not go through the service worker.** It is not under `/api/`,
so it fell to `shellFirst`, which cached the first 200 and served it cache-first
forever — measured with the server killed outright, `isReachable()` still
answered `true`. Every input the app has about connectivity runs through that one
call. It is excluded now, as `/auth/` already was.

## How it fits together

**Mutators announce; views listen.** Nothing calls another view's render
function. `ui/store.js` carries the state and exactly two events: `'change'`
means "the visible view's data moved, update it", and `'reload'` means "go to
the dashboard and fetch it". Each view decides whether it is the one showing —
the dashboard repaints from `state`, the detail view refetches, because none of
what it shows can be recomputed locally.

That is not decoration. The day editor has to refresh the detail view, the
settings dialog has to refresh both, and the detail view has to open the day
editor. Written as direct calls those are circular imports; written as one
2,100-line file — which is what this was — they are eleven scattered
`renderDashboard()` calls and no way to split it.

**A module owns its subtree, and `test/ui-modules.test.js` enforces it.** No
element id may be reached for by two modules; `ui/views.js` exists because
`#view-list` and `#view-detail` genuinely have three claimants. The same test
walks the imports from the entry point and fails when `SHELL` in `sw.js` has
fallen behind — with twenty-three modules where there was one, a hand-maintained
precache list drifts silently.

## Traps

**An amount is parsed, not typed into `<input type="number">`.** That input
does not report what it cannot read — it filters the keystrokes it dislikes and
hands back whatever survived. Measured in Chrome against the day editor's own
attributes: typing `8,5` left `85` in the box, so eight and a half was recorded
as eighty-five; typing `abc` left `''`, which the day editor read as "no entry"
and answered with a DELETE. The decimal comma is the one that matters, because
`inputmode="decimal"` is what shows it and most of Europe's keyboards offer it —
`HabitFormScreen.parseAmount` on the phone has a comment about the same input.

So the box is `type="text"` and `ui/amount.js` owns the reading, with the same
three-answer convention `parseTimeInput` uses and the same trap in it: `''`
(empty — a delete), `null` (unreadable — say so, write nothing) and a number, of
which `0` is a real answer. Two of the three are falsy, so callers compare with
`===`. `parseAmount` is also stricter than `Number()`, which the root CLAUDE.md
already records as too generous about form — `1e3` is not a thing anyone types
into a box asking how many glasses of water they drank.

Which of the two separators is the decimal point is the account's
`numberFormat`, resolved by `resolveNumberFormat` in three tiers — the stated
answer, else the device's, else the app's own — and passed IN rather than looked
up, because a DOM-free module has no business reaching for a settings cache or
for `Intl`. Only a three-digit group depends on it (`10.000`), which is why the
default costs no existing caller anything, and a group is refused under either
convention rather than read. The root CLAUDE.md has the argument.

It owns the reading for the SERVER too, which is what makes "DOM-free" a
contract rather than a convenience: `src/discord.js` imports it, because a modal
is the same box arriving over a socket and its own `Number()` reading recorded
`10,000` as ten. The root CLAUDE.md has the direction and why it is not the
usual two-declarations-and-a-test. `amountComplaint` lives beside the parser for
the same reason — a refusal that cannot be acted on is barely better than the
silent ten, and the phone and the web must not tell somebody to type different
things about the same input.

The step comes from the goal rather than being 1: an eighth of the target,
snapped to a round number, because 1 is right for "8 glasses" and useless for
"10,000 steps". `test/browser/countcheck.mjs` follows a tap all the way to
storage, which is the only thing that can catch the control and the database
disagreeing about what was typed.

**A localised name is never indexed by a Gregorian field.** `getMonth()`,
`getDate()` and `getFullYear()` are fields of the *Gregorian* calendar, so
`MONTHS[d.getMonth()]` or `String(d.getDate())` silently assumes the locale's
calendar is Gregorian — and for fa-IR, th-TH and ar-SA it is not. It has now
been found five times in the same shape and each one looked local: a
`monthLabels()` table, a year printed as `String(yy)`, a year caption keyed on
the January column, a day number in the dashboard's grid header, and a month
caption keyed on `getDate() === 1`. The last two shipped on the branch that
fixed the first three. Hand the DATE to `Intl` — `formatMonthShort`,
`formatYear`, `formatDayNumber` — and read a CHANGE of month or year from the
formatted string, because a Persian year turns at Farvardin and a Persian month
does not start on the Gregorian first.

The tell is a header that disagrees with itself: `۱۹ تا ۲۵ مرداد ۱۴۰۵` over
columns numbered `10 11 12`, one localised half and one not, in one row.

**`WIDTH_SAFETY` reserves; it never decides to degrade.** `estimateTextWidth`
answers "about how wide is this", and the 1.25 margin exists so a RESERVATION is
never short — a gutter that is short clips a word. Applied instead to a decision
about whether to *drop* a caption, *shrink* the type or *shorten* a label, it
makes the chart pessimistic about itself and throws away a label that would have
fitted: measured, `weekdayChart` gave up `segunda` for a `S T Q Q S S D` axis at
438px when the real crossover is ~360, and `weekdayMonthChart` dropped half its
month captions in 11 of 14 non-English locales with room to spare. Over-
reserving costs pixels; over-degrading costs the label. Both call sites now name
which they are doing.

**A caption that is thinned away must not be the newest one.** The drop is a
left-to-right walk, and at the right-hand edge the collision is always with the
month a reader is actually looking at — en-US drew `Jan Mar May Jul Sep Nov` and
no December, under a comment saying the first and last are what orient a reader.
The last column is reserved first and the rest fill in to its left. The year
caption follows the month it sits under, for the same reason: with no month name
above it there is nothing for a year to disambiguate.

**The date rules are invisible in en-US, so `npm run test:locales` runs them
somewhere else.** Every defect above passes the whole unit suite in the locale
CI runs in — a `getMonth()`-indexed table is 12 for 12 in English. The sweep is
`LC_ALL` and a subprocess, so there is no test-only hook in the module under
test, and it runs `dates.test.js`, `calendar.test.js`, `window.test.js` and
`weekcheck.mjs` in ten locales chosen for a PROPERTY each (a non-Gregorian
calendar, non-ASCII digits, a different era, long weekday names) rather than for
coverage. It asserts the locale actually took, because ICU falls back silently
for a name it does not know and ten runs of en-US report ten passes.
`weekcheck` is in there because a LAYOUT is locale-shaped too: the row gutter's
ceiling binds in ten locales at 328px and in none in English, so running it only
in the runner's locale pinned the one case where the bound never applies.

**A chart's labels and its data have to be asserted TOGETHER.** `weekcheck.mjs`
exists because a review broke the week-start plumbing four ways at once — bars
read positionally while captions rotated, the calendar's row labels left
unrotated, Home/End back on `getDay()`, the month grid reading rows by index —
and the whole unit suite and every browser suite still passed. The arithmetic
was covered; nothing looked at a rendered chart. The failure that matters is not
"the wrong day is first", it is a caption and a datum moving independently,
which reads as deliberate.

Note where each half is pinned, because the split is forced rather than chosen.
`weekcheck.mjs` is OFFLINE and covers the labels and the pairing. **Home/End is
in `feat4.mjs`, in a real browser**, because the handler is reached through a
`keydown` listener that only exists when the calendar is interactive and it
reads `dataset`, which the offline fake DOM does not have — a first version of
`weekcheck` claimed to cover it and did not, and the `getDay()` mutation passed
every suite in the repo. The month chart needs BOTH its tooltip and its drawn
caption asserted: they are built from different arrays, so checking one leaves
the other free to move.

**Charts with a time axis page rather than shrink.** `slot = width / count`
silently squeezes bars to hairlines once a habit has a year of daily data.
`ui/window.js` decides how many columns fit from a minimum per-column width,
and `windowedChart` in `ui/components.js` adds the ‹ Earlier / Later ›
controls. Paging
strides by one less than the window so a column of context is shared between
screens — `test/window.test.js` asserts no column is ever strandable.

**Connectivity needs more than the `online` event.** That event tracks the
network interface, not the server, so a restarted server left the app stuck
offline until a manual reload. `watchConnectivity` also re-probes on
`visibilitychange` and polls with a backoff *while offline only* — it makes no
requests at all once the server answers. It reports transitions, not polls, or
reconnecting would re-render the dashboard every few seconds.

Which leaves it blind to the outage it is most likely to meet, so the watcher
takes an input as well: `reportOffline`, called by `ui/api.js` when a write has
to be queued. A failed request of our own is better evidence than a probe — it
is the actual traffic — and it must come in through there rather than as a
`setOffline` from outside, or the watcher's `last` stays `true` and it neither
polls nor reports the transition. See the root CLAUDE.md.

And once it HAS said so, `api()` stops asking: a write finds `state.offline`
already true and goes to the outbox without opening a socket. Tap one is what
discovers an outage and there is no cheaper way to learn it — probing `/healthz`
per write is what that endpoint's four callers make expensive — so the first tap
pays the 10s bound and every tap after it costs ~100ms. Note this branch was
unreachable before the watcher grew that input: nothing set the state on the
write path, so "when the app already believes it is offline" described no state
the app could be in, and the obvious-looking fix would have done nothing.

And the write is staged BEFORE the attempt, not after it. `enqueue` returns its
`seq`, `api()` holds it for the length of the fetch and `unstage`s it the moment
any answer arrives. That closes the window the bound only shortened: the queue
used to hold writes that had already failed, so between the tap and the fetch
settling a check-off existed solely in a promise and closing the tab lost it
from the outbox and the server alike.

It is removed on ANY response, not just a good one. Leaving it staged on a 5xx
would turn every failed write into a silent retry, which is a bigger change than
this and not obviously wanted — the caller is told and the caller decides. What
the staging covers is precisely the in-flight window, which is precisely what
was lossy.

Staging is limited to calls safe to arrive twice, because a concurrent `flush()`
can send a staged write while the live attempt is still out: two identical
upserts keyed on habit and date, and the second changes nothing.

The predicate is `replayable()`, and it names one question — is this write safe
to arrive twice? — because three rules turn on it: what may be staged, what may
be pre-empted, and what may be queued on failure. All three end in a replay from
the outbox, so all three need the same answer, and having them read one function
is what stops the next change moving one and missing the others.

`POST /habits` is the only write that answers no. It is **bounded but never
queued**, which is not the obvious pairing and is the point: it used to be left
unbounded on the reasoning that aborting a create the server had begun and then
replaying it is two habits. The first half is true and is why it is not
replayable — but not bounding it did not avoid the duplicate, it only made the
dialog spin until the OS gave up while the create may or may not have landed.
Abandoned, not replayed, and reported as *indeterminate* is the honest shape; the
dialog closes and reloads the list on that error, so "check whether it was
created" is something the user can see rather than a thing they are told to do.

A GET still goes to the network, because
the service worker may hold a cached copy and skipping the request throws that
away — stale beats blank. And `POST /habits` is excluded **by the same
`bounded()` predicate as the timeout**, not by a second opinion about the same
call: pre-empting it would in fact be safe, since nothing is sent and nothing
can arrive twice, but two rules disagreeing about which call is special is how
the next person changes one and not the other.

**The calendar is anchored on its END, not its start.** Going back
`weeks*7` days and *then* snapping back to the week's first day shifts the whole
grid earlier,
so the last column stops short of today by however many days into the week it
is — today's square was invisible on six days out of seven. `calendarWindow`
owns this and `test/calendar.test.js` pins it.

**Charts size themselves from the card, and must not overshoot it.**
`svg.chart { max-width: 100% }` silently *scales* an oversized chart down, so
one pixel too wide makes 13px cells render at 12.6px. `calendarWidth` drops
the final column's trailing gap for exactly this reason, and `cardInnerWidth`
measures a real `.card` rather than hardcoding padding that can drift from the
stylesheet. Inside a `.chart-scroll` the cap is lifted so narrow screens
scroll instead of shrinking.

**A chart names a theme colour; it never resolves one.** Every fill and stroke
that comes from the palette is emitted as `var(--grid-empty)` and friends, and
a partial strength as `color-mix(in srgb, <habit colour> N%, var(--grid-empty))`
— never a value read with `getComputedStyle` at draw time. An SVG attribute
does not follow the theme, so a resolved colour freezes the palette the chart
was drawn under, and the only thing that can correct it is a re-render. In the
detail view a re-render is a *refetch*: switching to dark left every unrecorded
calendar square holding the light `#e6e9ef` — near-white against the dark card
— for two requests, and permanently if either failed. That is also why
`toggleTheme` no longer takes a redraw callback, and why the fake DOM in
`test/browser/atmost.mjs` and `rendercheck.mjs` no longer stubs
`getComputedStyle`: reach for it again and those suites crash rather than
quietly pass. `themecheck.mjs` blocks every request the detail view could make
*before* switching the theme, so it can only pass if the colours followed with
no redraw at all.

**`charts.js` must survive the fake DOM.** `test/browser/atmost.mjs` and
`rendercheck.mjs` import it directly with a ~15-line stand-in for `document`
that implements `setAttribute`/`appendChild` and nothing else. Use
`setAttribute('data-x')` rather than `.dataset.x`, pass `class` through the
attribute object rather than `classList.add`, and guard anything that needs
real event or `requestAnimationFrame` APIs. Reach for a browser API here and
those two suites crash outright rather than fail a check.

**Calendar cell hover has three non-obvious requirements.** `transform-box:
fill-box` — without it the transform origin is the SVG's origin and a hovered
cell flies across the grid instead of scaling in place. SVG has no `z-index`,
so the hovered cell is moved to the end of its parent or its neighbours clip
the growth. And the popover is positioned in JS because an SVG rect has no CSS
box to anchor an HTML tooltip to. `<title>` stays in the markup for screen
readers but is hidden with `display: none`, or the native bubble covers the
popover.

**The search box is OUTSIDE `#grid`, and that is the whole design.**
`paint()` runs on every keystroke and rebuilds that subtree with
`replaceChildren()`, so a control inside it would lose the caret mid-word.
`data-focus-key` restores a control that IS rebuilt; the cheaper answer for one
that need not be is to not rebuild it — and `searchcheck.mjs` asserts a whole
word arrives with focus still in the box, because moving it inside `#grid` does
not fail a check, it makes the element unreadable.

Three rules travel with it. **The drag handle goes while a filter is on**: a drop
against a subset computes a `position` from neighbours that are not the habit's.
Note what is NOT the reason — `persistOrder` sends `state.habits.map(h => h.id)`,
the FULL list, so nothing is dropped from the write; what a drop against a subset
gets wrong is where in that list the habit lands. **The threshold reads the
unfiltered count** (and the box also stays while it has focus), or it vanishes
under the cursor at the moment a query narrows the list past it. And **the
MUTATORS clear the query**, not the `'reload'` listener. Doing it in the listener
looks equivalent and is not: `'reload'` has ten emitters and only half replace
anything, so it also wiped the box on **Back from a habit** — the feature's main
workflow — and on a background reconnect, mid-word.

**But a mutator clears it only when what it wrote would be OFF THE LIST**, which
is one question and not a list of mutators. Clearing on every save was the same
defect one road over: filter to a habit, open it, Edit, change only the COLOUR,
Save, Back — and the box is empty with all eight rows showing, a filter wiped by
something that replaced nothing. So `habit-dialog` asks `staysOnList` and clears
only on a no.

**The question is `staysOnList` and not `matchesQuery`, and the gap between them
is a whole route.** A create need not match the query and a rename may stop
matching — that second one is the same disappearance from the other side, and the
reason "this was a create" is the tempting simpler rule and the wrong one. But
**archiving** touches neither matched field and removes the row anyway, because
`load()` fetches the active habits or the archived ones and never both. Asking
the filter alone left "No habits match that." over an archive that had just
succeeded — the very sentence the rename case exists to prevent, arriving by the
one route that predicate cannot see. `staysOnList` is `archived` and the match
together, and it is what `deleteHabit`'s unconditional clear already IS: for a
habit that no longer exists the answer is no however the account is set up, so
the constant there is this rule resolved in advance rather than a second rule.
`restoreHabit` asks it properly, since an undo is a create with the habit in
hand. `data-dialog` is the one real exception — a restore replaces the whole
account, and there is no one habit to ask about.

Two things about the shape of it. It re-tests the MATCH rather than comparing the
name, because the filter reads the **description** too: a habit found by its
second field is one a name comparison is blind to, and the match also makes an
edit that still matches a no-op rather than a harmless pointless clear. And it is
asked of the **reply**, not of the request — `parseHabit` clamps `description` to
`LIMITS.description`, so a mention of the query past the cut is in what was sent
and not in what was stored, and the box then survives over a list the habit has
just left. Both routes return the stored habit in both editions.

The predicate lives in `ui/store.js` beside `query` — a file that touches no DOM
and imports nothing — because `dashboard` imports `habit-dialog` already, so a
second copy of the rule was the alternative to a cycle. All four clears are
pinned in `searchcheck.mjs` now; three were deletable in silence, and the restore
is the one whose removal left the entire browser suite green.

**A rebuilt control keeps focus via `data-focus-key`, not its position.**
`dashboard.paint()` rebuilds the grid with `replaceChildren()`, and a single
check-off does it twice — optimistically, then again after the refetch. That
destroys the focused element, so tabbing to a checkbox and pressing Enter used
to drop focus to `<body>` and send the next Tab to the top of the page. The key
names *what a control is* (`check:<habit>:<date>`, `handle:<habit>`,
`nav:older`), never where it sat, so the restore still lands after a reorder
moves the row. Two consequences worth knowing: a key that no longer exists
simply does not match, which is the right answer for a column you paged away
from; and a control that survives but is *disabled* — Today, once there is
nowhere to jump to — hands focus to its nearest working neighbour, because
`.focus()` on a disabled button is a silent no-op. `persistOrder` used to
re-focus the drag handle by hand; that special case is gone. Pinned by
`test/browser/gridcheck.mjs` and `dragtest.mjs`.

**`detail.open()` preserves scroll position.** Every control in the detail view
re-renders through it, and `replaceChildren()` collapses the page height,
which sends the window to the top. Preserve it on redraw of the *same* habit
only — opening a different one should start at the top.

**The settings dialog holds a draft; nothing is written until Done.** It edits
a copy taken when it opens, so Cancel — and Escape, which `<dialog>` handles
itself — throws the whole thing away. Three consequences worth knowing before
changing it. The dependent controls (`requires`) read the *draft*, which is
what lets switching Discord on reveal its webhook field before anything is
stored. The body is rebuilt only when that visible set changes, so a `multi`
handler must read `draft[key]` at event time and never a list captured during
render — capture it and ticking a second box silently drops the first. A `multi`
option may also carry `onEnable`, run when the box is TICKED and inside the click
that ticked it: a notification permission can be asked for from nowhere else.
Named on the option rather than tested for by key here, or the dialog stops
being able to render a section without knowing what is in it. What follows the
answer is `paintNotices` and never a rebuild — see the next paragraph — and
`stage` paints them too, which is what covers an option whose `onEnable` returns
no promise at all. And a section action like "send a test notification" asks the
server to use the settings it *holds*, so it is disabled while the draft is
dirty rather than quietly testing the old value.

**A section can also SAY something, and that arrives late.**
`SECTION_NOTICES` mirrors `SECTION_ACTIONS` — keyed by section, given the draft,
returning prose — and the one entry is "your last reminder was not delivered",
from `GET /api/notify/status`. Three things about how it is rendered. It is
*not* awaited by `openSettings`: waiting on a request before showing the
settings would make every open feel slow to spare the one that has something to
report, and offline the dialog would never open at all. What lands when the
answer does is **`paintNotices`, which repaints the prose and touches no
control**, and that is the whole of why a late answer is safe. It used to be
`renderSettingsBody`, hedged twice — only on a clean draft, and only when the
set of notices had changed — because a rebuild tears every control out and takes
a text field's focus and CONTENT with it: `change` never fires on a removed
input, so a half-typed webhook URL was simply gone. Both guards are now
unnecessary rather than merely absent, and removing them was the point: a clean
draft is exactly the state nobody is in when they most need the sentence, so the
old rule withheld it from the person mid-edit trying to work out why their
reminders had stopped. Do not put the rebuild back; `test/browser/nudgecheck.mjs`
holds `/api/notify/status` open, types into the webhook field and releases it, so
it fails if you do. The notices read the **draft**, so switching a destination
off makes its warning disappear immediately rather than after a save and a
refetch. Pressing "send a test notification" re-asks, because a test is a real
delivery attempt and is what clears the notice once a replacement webhook
works.

**A setting the server normalises cannot be judged here.** Whether a webhook
URL is acceptable depends on a host allowlist that lives with the fetch, so the
control has to show what was *stored* rather than what was typed. `saveAll`
writes the draft in one request and reports `ignored`; on anything refused the
dialog stays open, redraws from the server's values and names what did not
land. Applying is therefore partial by design — the endpoint takes a patch and
drops what it will not have rather than failing the lot. `set` (apply locally,
write through, works offline) is still right for the in-place calendar zoom in
the detail view, where there is no dialog to wait in.

**A setting with an in-place toggle needs a session override.** `calendarZoom`,
`historyGranularity` and `historyMode` all have controls in the detail view as
well as entries in the dialog. The pattern: `state.X = null` means "use the
saved value", the toggle sets it for the session, and `applyDraft` clears it
for every key Done actually changed — otherwise the dialog appears to do
nothing once a toggle has been touched. Read through the accessor, never
`state.X` directly.

**Saving a habit returns you to where the edit started.** `habit-dialog` emits
`'change'` when `openHabitId` is set and `'reload'` otherwise, so editing from
a habit's own page reloads that page and creating from the dashboard reloads
the list. It cannot simply call the detail view — that is the import cycle the
store exists to break — and it cannot always emit `'change'`, because on the
dashboard that is a repaint from stale state and a newly created habit would
not appear. Deleting still goes home: the page you were on is gone.

**The time picker's parser is mirrored in Kotlin.** `public/ui/time.js` and
`android-native/.../ReminderTime.kt` accept the same inputs and produce the same
`HH:MM`, because both clients write the same `reminder_time` on the same habit.
`test/time.test.js` and `ReminderTimeTest` pin the same examples on purpose — if
you add a form to one, add it to both. The two that catch people out: `12 am` is
00:00 while `12 pm` is 12:00, and an empty box means "no reminder" while
unparseable text is an error to report — the caller does different things with
them, so they are `''` and `null` rather than both falsy.

**A habit shown as something to avoid keeps the cycle and changes the
encoding.** `show_as: 'avoid'` on an at-most habit walks the same four states —
a clean day is `done`, a slip is `no` — so `nextDayState` is untouched and its
Kotlin mirror did not have to learn anything. `valueForState` is what differs:
`done` writes 0 and `no` writes `target + 1`, where an ordinary habit writes
`YES` and `UNSET`. It is mirrored in `Grid.valueForState` for the reason the
cycle is — a tap happens with no network — and `isAvoided` asks all THREE
questions: avoid, at-most, and MEASURABLE. `show_as` is kept when a habit's type
or goal is switched, so that switching back does not lose it, which means the
predicate carries the whole rule. Asking two of the three put a habit somewhere
it could not leave — boolean + at_most + avoid is reachable from the form in one
sitting, and a tap meaning done then encoded as 0, which `isCompleted` reads as
NOT done for a yes/no habit.

`valueForState` **throws** for a skip rather than answering. A skip is the
status column, and returning Loop's SKIP sentinel as a value stored three of the
thing on a measurable habit — `parseEntry` reads 3 as a skip only for a boolean
one. The dashboard's `recordSkip` writes `{status: 'skip'}`, which is what the
day editor and the phone have always sent.

Note `toggle.js` declares `UNSET`/`YES`/`SKIP` locally rather than importing
`ui/values.js`. It is dependency-free on purpose — that is what lets
`test/toggle.test.js` run it with no browser, since the absolute `/shared/...`
specifiers the rest of `public/ui` uses do not resolve under Node — and
`test/toggle.test.js` reads the declaration out of the source and pins it
against `values.js` so the third copy cannot drift.

**The tap cycle is mirrored in Kotlin too.** `public/ui/toggle.js` and
`Grid.nextState` are Loop's `Entry.nextToggleValue`, and `test/toggle.test.js` and
`GridTest` are pinned to the same examples for the same reason `ReminderTime`
mirrors `ui/time.js`. Both read `skipDays` and `questionMarks`, so the phone and
the browser cannot disagree about how many states a tap walks through. Note the
one asymmetry Loop has and this keeps: `SKIP` always moves on to `no`, even with
skips since switched off, because the setting does not erase the skips already
recorded and a tap on one has to go somewhere.

**Adding a setting means two files.** `public/ui/settings.js` declares what
the dialog renders; `src/validate.js` declares what the server accepts. Both,
or the control is either unenforced or dead — `test/settings.test.js` fails if
they drift. Do not add a control before the behaviour it names actually works:
`weekStart` sat commented out until the aggregation honoured it.

**The UI is auth-agnostic.** No view mentions sign-in; `app.js` calls the
injected adapter (`load` / `render` / `signOut` / `onUnauthorized`) and hands it
to `ui/api.js`, which needs it only to tell an expired session from a bug.
Adding an `if (cloud)` branch anywhere here is how the frontends drifted apart
the first time.

There is now one adapter rather than one per edition, and the branch it used to
be lives on the server: `load()` reads `mode` from `/api/me`, **and from its
401** — a signed-out client is the one that has to decide between a form and a
link, and that response is all it gets. `mode === 'none'` renders nothing at all
and lets a 401 through as the bug it would be. With no build step nothing could
pick a module at package time, which is exactly what stopped the personal
edition making auth a runtime choice.

