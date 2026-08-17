# Settings, client mirrors and the theme

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

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

**...but "every client" is not every setting, and the exception now has a
list.** A default is a mirror because two clients must agree about what an
account is set to — which presumes both clients READ the key. Some do not, and
copying a value nothing consults is a mirror with no second reader: cost with no
property. `notMirrored` in `AppSettingsDefaultsTest` is that half, and it is a
map rather than a set because each entry carries its reason, exactly as
`ELSEWHERE` in `compose.test.js` does — "we thought about it" has to be written
down or it cannot be told from "we forgot". The test enumerates the registry and
fails on any key in neither list, so the escape hatch costs a decision rather
than an omission, and it checks the other direction too: a name listed here that
the registry no longer has is a decision about nothing. The scan is scoped to
the `SETTINGS` literal rather than run over the file, or the next two-space
object at module scope becomes a setting demanding a mirror.

The four Discord keys and `notifyTimezone` are there because the phone neither
posts to a server-sent destination nor schedules from a server's clock. `theme`
is the interesting one, and it is honest about a cost rather than free: the
WebView paints the account's theme through the same cascade the browser uses,
while the native chrome around it follows Android's own setting — so a light
phone with a dark account shows light chrome around a dark page, and
`WebScreen`'s pre-paint colour flashes light on the way into each habit. Fixing
that means the phone knowing the account's theme, which is the mirror this list
refuses; if it is ever worth paying for, the shape is an OBSERVATION (cache the
colour the WebView last painted) rather than a copy of the setting.

**A theme is a DECISION, and "follow this device" is one of the three.** The
setting is `theme`, defaulting to `system`, and `system` is a stored value
rather than the absence of one — the same distinction `notifyTimezone: 'auto'`
and `at_most_unlogged: 'default'` already draw, for the same reason. It used to
live in localStorage alone, where `initTheme` read `saved ?? (prefersDark ?
'dark' : 'light')` while the button wrote one of two values: once pressed there
was no way back, so a machine that goes dark at sunset stopped doing so with no
control that said why. `apply()` resolves `system` against the device at paint
time and never writes the resolved value back, which is what keeps it
reversible.

What the device keeps is one record (`habiterall-theme`), and it is an
unconfirmed WRITE rather than a second opinion about the setting. It holds the
newest answer and says which kind it is — a bare `light` is what the pre-setting
build wrote and is superseded the moment the server names any theme, while
`press:light` is this device's own and is NOT retired by the account
disagreeing, because the write may still be in the outbox and the account is
then the older answer of the two. There were three carriers here at one point
and each fix added a fourth guard, because the durable member held the OLDEST
answer: a reload preferred a stale key over the press just made and quietly
undid it.

Three things about the reply that retires it. Only a **full** reply may be read
as "the account has no theme" — personal answers a write with the accepted
PATCH, so `{calendarZoom: 'wide'}` says nothing about the theme, and read as
though it did, a device whose settings GET had been refused pushed its own value
over another device's the moment an unrelated preference changed. **`wrote`**
names the keys THIS device just sent, which is how a choice made in the settings
dialog beats a press made on the same device — `stored` cannot answer it,
because cloud returns the whole blob on every write. And a write that ran out of
time is **neither** a refusal nor offline: the request is bounded and cannot be
recalled, so there is no verdict, and deleting the record there loses the answer
while the write may still land.

`theme` is portable — it is in `PORTABLE_SETTINGS`, because it is a preference
like the rest and carries no capability, unlike the notification keys. The
fixtures set it to `dark` against a `system` default in both round-trip suites,
for the reason `reminder_message` taught the cloud suite: a field holding its
default everywhere compares equal to itself and passes with the field dropped.

**Two surfaces read that record rather than the account, and both had to be
told.** The settings dialog seeds its draft from `settings.load()`, which
sanitises from defaults and so cannot tell "the account follows the device" from
"this device pressed dark and the write is unconfirmed" — it showed *Follow this
device* over a page painted dark, in the one place you go to find out what the
theme is. It reads `currentTheme()` now, seeded before the baseline so it does
not by itself make the draft dirty. And the button SHOWS which of the three it
is on (`◐` / `☀` / `☾`), because the cycle's last step — back to `system` from a
value the device already matches — is the same appearance by definition. The
label was the whole answer to that and is not one on a phone: a `title` needs a
pointer to hover and an `aria-label` needs a screen reader, so the third press
did nothing observable at all on the app's primary target.

Two smaller rules travel with it. `set()` passes `[key]` as `wrote`, as `save`
and `saveAll` do — defaulting it to `[]` says a write came from somewhere else,
which is exactly the signal `reconcile` turns on. And a `set()` write that runs
out of time is **dropped rather than queued**, for every key it writes and not
only the theme: the cache already holds the value, the request may still land,
and replaying it later would put it on top of whatever the user chose in the
meantime. These are all in-place toggles somebody is actively working; `save` is
the path for a value that has to be confirmed.

**The two habit routes disagree about what a write means, on purpose.**
`PUT /habits/:id` REPLACES — the body goes through `parseHabit`, which supplies a
default for every absent field, so a partial write resets what it omits rather
than leaving it alone. `PUT /settings` MERGES, which is why the phone sends one
key at a time and two clients editing different preferences do not clobber each
other. The Android side pays for the first with a dedicated `HabitInput` type
serialised with `encodeDefaults = true`: kotlinx.serialization omits fields equal
to their Kotlin default, which is precisely the set a replace would then clear,
and it had been safe only because those defaults happened to match the server's.


**`SETTING_VALUES` rules are an array *or* a normaliser.** A URL and a timezone
name cannot be enumerated, so those entries are functions returning the value
to store (or `undefined` to reject) — which is also why an accepted setting may
differ from what was sent, and why `ui/settings.js` has a `save()` that waits
for the server's answer rather than assuming it. Do not widen the array form to
"any string" instead: `parseSettings` being the only thing that needs trusting
is the point.


