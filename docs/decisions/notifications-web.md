# Web notifications, the nudge and the settings dialog

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

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

**`delivery: 'device'` says who DECIDES, and the `web` channel keeps a time
nobody promised.** It is the fourth destination to be BUILT and the second
`device` one — it sits second in `CHANNEL_IDS`, beside `android`, which is worth
knowing because the `DEVICE_CHANNELS` pin below compares in registry order. It
differs from `android` in the one way that matters to a user: the phone arms
an `AlarmManager` alarm and fires at 08:00, and a browser cannot. A page's
timers run only while a tab is open and are clamped to about one a minute in the
background, a service worker is terminated when idle and has no wake-at-time
event, Notification Triggers ran as an origin trial and never shipped, and
Periodic Background Sync picks its own interval. So a reminder at a MINUTE needs
the server, which is #70's part 2 and is deliberately not built. What is built
is the honest half: on boot and on `visibilitychange`, anything whose reminder
time has passed and whose day is still unanswered says so. The word `device`
still fits, because the only thing it decides is whether the notifier has
anything to do — `serverChannels` filters on it, so an account with this and
nothing else on costs the tick nothing and raises no `notify.unreachable`.

Three things about it are load bearing and each is a rule stated elsewhere in
this file, arriving from a new direction.

**`isDayAnswered` in `shared/public/ui/nudge.js` is `answeredIds`,** and it is a
mirror because the nudge runs from `state` with no network — the offline rule,
paid for the way the others are: `shared/test/nudge.test.js` runs both over the
same fixtures. The trap it is shaped to make unreachable is the at-most one. A
nullish entry answers `false` before anything else is asked, and
`atMostUnlogged` appears nowhere in the function, because `answeredIds` walks
the rows that EXIST — so a day with no row is unanswered under either reading.
Written the obvious way, a limit whose unlogged days count as staying under
reports every untouched day as answered, and this destination goes quiet exactly
where Discord and the phone do not. The fixture asserts
`isCompleted(habit, undefined, 'success') === true` first, or the rest of it
would pass for the wrong reason.

**The watermark is localStorage and never a setting.** It is `notify_log`'s
local counterpart — without it every `visibilitychange` re-notifies — and it is
a DEVICE fact twice over: a notification was shown on THIS screen, so an
account-level record would silence the laptop that has not been opened today;
and settings are what `/api/export` carries, so a key there would end up in
people's backups and in both round-trip suites. That is the argument that keeps
`notify_status` out of the blob. The date is stored WITH the ids, so a new day
replaces the record rather than appending to it.

**Two things about that permission are the platform being unhelpful in ways the
dialog has to explain.** On a **non-secure origin** the permission is `denied`
and cannot be anything else — measured on a LAN address: `isSecureContext`
false, `Notification` still a function, `requestPermission()` resolving `denied`
with no prompt, `navigator.serviceWorker` undefined. That is the plain-http half
of `HABITERALL_UPGRADE_INSECURE`, so it is an ordinary deployment here, and
telling that user to change a site setting is the one surface written to explain
the silence explaining it wrongly. `globalThis.isSecureContext === false` is
asked first, and `=== false` rather than falsy so a runtime that does not define
the flag falls through to the permission questions.

**The permission is asked for from the settings dialog, inside the click.** It
cannot be asked for on boot — a prompt nobody invited is one browsers refuse
outright, after which the destination can never be granted at all — so a `multi`
option may carry `onEnable`, which the dialog runs when the box is ticked.
`denied` is unrecoverable from script, so `SECTION_NOTICES` says so; without
that the box looks on, `channelConfigured` says yes (there are no keys), and
nothing anywhere reports the one thing that is wrong.

What must NOT follow that is a rebuild. A permission prompt is answered on the
user's schedule, not inside the click, and `renderSettingsBody` tears every
control out — measured: Discord on, tick the browser destination, type a webhook
URL without blurring, answer the prompt, and the field is empty with focus on
`<body>`, because `change` never fires on a removed input. `paintNotices`
repaints what a section SAYS and touches no control, which is the same hazard
`stage` and `refreshDeliveryNotices` were already written around — both now go
through it, and the second lost two guards it only had because it used to
rebuild. `stage` paints them too, which is what covers a browser with no
`Notification` at all: `onEnable` returns `undefined` there, and hanging the only
repaint off the promise left the one state the notice exists for unreachable. On Android
Chrome `new Notification(...)` throws and only `registration.showNotification`
works, so both are tried — and it is `getRegistration()` rather than `ready`,
which never settles on a page with no worker and would hang holding the in-app
fallback. That fallback is the destination's behaviour for everyone who said no,
not a consolation prize.

**What `state.habits` holds is an ANSWER TO A WINDOW, and reading it without
one is the fifth state.** `/overview` returns the days it was asked for —
`dashboard.load()` sends `end=state.gridEnd` — so a grid paged back a fortnight
holds entries that legitimately stop before today, and a missing key there means
*never fetched* rather than *no row*. That is the `?? UNSET` collapse arriving
from the other side, and it shipped in the first version of this: measured in
Chrome, ticking today and then pressing "Previous 14 days" produced "1 habit
still to answer today" about a habit answered an hour earlier. `state.gridLoaded`
is the window the server actually answered with — its `start`/`end`, never the
request's, since `end` is clamped to the caller's own day — and `covers` in
`ui/nudge.js` refuses the whole payload for a date outside it. Refuse rather than
guess: nagging about a day already dealt with is what gets a destination switched
off, and the dashboard behind it is showing the truth either way. Anything else
that starts reading `habit.entries` for a date needs the same pair.

**A window falls short of today for TWO reasons, and refusing was the whole
answer to only one of them.** Paging back is the user's own act, undone by
pressing Today. The other is the clock: nothing in the app refreshes on
`visibilitychange` — `syncNow` returns early on an empty queue and `'reload'`
fires only on an offline→online transition — so a tab left open across local
midnight holds yesterday's window for ever, and refusing there silenced every
habit at 09:00 the next morning, which is the one moment this exists for. That
was a regression the fix above introduced and a review caught. `check` now asks
once for a fresh window before it gives up, and WHAT counts as fresh is the
caller's policy rather than the module's: `app.js` declines when the grid has
been paged back (a deliberate exclusion) and when a habit is open over the
dashboard (`dashboard.paint()` clears `openHabitId`, so a reload would navigate
away from the page being read — the same guard `settings-dialog.js` uses on its
`'reload'`). A refusal leaves the window alone and `outstanding` says nothing,
which is the paged-back answer and is correct.

`covers`' lower bound is unreachable rather than unpinned, and is worth
remembering when this changes: `end` is server-clamped to the caller's own day,
so `today < start` needs a backwards clock. Nothing above makes it reachable.

The blind spot that remains is stated in `check` rather than fixed: it reads what
the app has already fetched rather than fetching on a schedule — which is what
makes it work offline — so answering on the phone and switching to a browser tab
open since morning can nudge about an answered day. The watermark caps it at one
per habit per day, and a fetch on every `visibilitychange` is traffic nobody
asked for. The one fetch it does ask for is the case above, where the payload
cannot answer at all rather than answering stalely.

`ui/nudge.js` is a new file under `shared/public/`, which costs a
`CACHE_VERSION` bump — the cost `deviceClockHeader` was kept out of a module of
its own to avoid. It is paid here because this is a subsystem rather than one
import, and because no existing module owns it (the dashboard owns the grid,
settings the preferences, connectivity the banner). Be exact about what the bump
buys; this note has been written wrong in BOTH directions and the true answer is
that it is v9's case and v14's at once. v9's, because a brand-new module is one
an installed PWA fetches on first use and is offline for. And v14's, which a
rewrite denied on the reasoning that an old shell serving the old `app.js`
alongside it links fine — true, and not the state the window produces:
`shellFirst` is stale-while-revalidate and writes into the RUNNING worker's
cache, so while the outgoing worker is still in control it can store the NEW
`app.js` into a shell that has no `nudge.js`, and offline that is a module link
error before `start()` and so outside `#view-error`.

What the bump then does is narrower than "all-or-nothing", which is an
overstatement inherited from the v14 note and now corrected in both: `install`
uses `Promise.allSettled`, so a partly populated new shell is a normal outcome
and `activate` deletes the old one regardless. It is atomic at the cache NAME —
no request can mix the two shells — and not at the asset. It costs every
installed client its data cache. It is **dependency-free**, as `ui/toggle.js` is
and for the same reason — that is what lets the rule AND the call site be tested
under Node — so everything it needs arrives through `init()`, including
`todayISO`, because this app has one `iso()` and `test/dates.test.js` refuses a
second. It is not DOM-*free*: `init` registers one `visibilitychange` listener,
and takes the document so a test can hand it one.


