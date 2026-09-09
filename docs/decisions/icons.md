# Habit icons: the three tiers, and what each one costs (#66)

Moved out of #66. Tier 1 — one emoji grapheme per habit — shipped in PR #178
(`f137f83`); tiers 2 and 3 have not, and #66 remains the actionable issue for
them, with the surface list, the suggested order and the tests still owed.

What is here is the reasoning: what tier 1 settled and why, the constraint that
decides the shape of a preset set, **the tier-2-on-Android question that has to be
answered before tier 2 ships rather than after**, and the list of things tier 3
has to get right. Nothing here is loaded automatically; the operative rules —
`parseIcon`'s grapheme handling, the fidelity lists, the Android write bridges —
live in the `CLAUDE.md` nearest each.

The point of the feature, for context: a grid of twelve identically-shaped rows
is hard to scan, and the one thing already distinguishing them — the colour — is
doing double duty as the completion shading in the grid. That second job is why
tier 2 is not free, below.

## What tier 1 settled

**One grapheme, not one character.** `parseIcon` in `shared/src/validate.js`
segments with `Intl.Segmenter`, because `'👨‍👩‍👧‍👦'.length` is 11 and a naive
`slice(0, 2)` cuts a ZWJ sequence into two half-emoji. A grapheme past the cap is
**dropped** rather than sliced, which is the same corruption one step later.
Control characters and bidi overrides are stripped — but **not** `\p{Cf}`,
because U+200D ZWJ is `Cf` and stripping it destroys the sequences the segmenter
exists for. Any grapheme is accepted, not only pictographic ones.

**`icon` is in `JSON_HABIT_FIELDS` and in no Loop list.** The Loop round trip
correctly returns it to `''`, and both suites **assert** that gap rather than
implying it — the root `CLAUDE.md`'s rule that a new habit field has to be
assigned to a fidelity list, applied.

**The icon prefixes wherever the NAME appears, and nowhere else**
(the comment sits over the `icon` line in `reminderMessage`,
`shared/src/notify.js`). That is the whole rendering rule, web and notification
prose alike; `habitIcon` in `shared/public/ui/components.js` draws it beside the
name and never instead of it, `aria-hidden`.

**All three Android write bridges moved in the same commit, and that is why it
was one commit.** The moment `icon` existed in `parseHabit` the phone would have
started *erasing* it: `PUT /habits/:id` REPLACES, `writeJson` has
`encodeDefaults = true`, so a field missing from `HabitInput` is not omitted from
the request — it is sent as the Kotlin default and stored. `Habit.toInput()`
(unarchiving, and setting a reminder from the list) and `Draft.toInput()` in
`HabitFormScreen` were all three.

**`HabitFieldCoverageTest` is the generalisation, and the more valuable half.**
It reads `JSON_HABIT_FIELDS` off disk and asserts both that every name reaches
the bridge **and** that it arrives as the habit's own value. Those halves catch
different bugs: a key-presence check alone is blind to a field declared but
unwired, because `encodeDefaults` emits the key anyway. `HabitApiTest` could not
see this class at all — it iterates the keys `HabitInput` happens to send, so a
field in *neither* Kotlin model passed vacuously. That is the root `CLAUDE.md`'s
"pinning the DECISION is not pinning the WIRING", and the write-bridge hazard is
now guarded for the next field as well as this one.

## Tier 2: a preset set, and the one decision that shapes it

An SVG sprite in `shared/public/`, authored by us, so none of tier 3's upload risk
applies.

**Monochrome, drawn with `currentColor`, tinted by the habit's existing colour.**
That single decision resolves the second-colour problem: habits already have a
colour and it already drives the grid shading, so a preset carrying its own
colours makes a green habit's row say two things. It is also the only form that
survives the theme rule — an icon that *names* a colour follows light and dark,
while one that bakes in `#333` is invisible in one of the two themes and only a
re-render can fix it. The codebase has already paid for that lesson with
near-white calendar squares on a dark card.

Roughly 60–80 glyphs covering the habit vocabulary — the same vocabulary #182's
curated list needs, so **#182's panel should be able to grow this as a second
section without being rewritten**. That was written while the web picker was
still unbuilt; it has since shipped (#182, PR #299), so the constraint is now on
tier 2: it adds a section to the existing panel rather than bringing a grid of
its own.

Ship the sprite; do not pull in an icon package — there is no build step to
tree-shake one.

Two mechanical consequences of adding a file to `shared/public/`, both of which
have to be budgeted before the work starts: it goes in `SHELL` in `sw.js` **by
hand**, because `test/ui-modules.test.js` walks *imports* and cannot see a sprite
— the one kind of shell asset that test will not catch — and it means bumping
`CACHE_VERSION`, which drops every installed client's data cache.

## The tier-2-on-Android question

**It has to be answered before tier 2 ships, not after**, because it decides
whether a preset is "an icon" or "a web-only icon" — and that is a
product answer, not an implementation detail.

The phone cannot use the web's sprite. Compose has no SVG rasteriser and the list
row is native rather than WebView. So a preset reaching an Android surface means
one of:

| | what it costs |
|---|---|
| 60–80 hand-converted vector drawables | a second authored copy, which drifts the first time a glyph is edited |
| map preset names onto `material-icons-extended`, already a dependency | a *different glyph* for the same habit on two clients |
| nothing — a preset is invisible on the phone's native surfaces | the third is defensible |

*"I picked an icon and it is missing on my phone"* is a bug report under all
three. Only one of them has an answer ready.

Tier 1 does not have this problem, which is the argument for having done it
first: an emoji is text, and every surface that can draw a name can draw it.

## What the Android surfaces already decide

The work items are #66's group C — the form, the notification title, the list
row, the widget — and they stay there. What follows is the part of each that is
settled regardless of when the work happens.

**An emoji cannot be a small icon.** `setSmallIcon` stays
`R.drawable.ic_notification`: it is a monochrome vector the system tints. The
emoji goes in the title text — and the notification title is the one Android
surface delivering something no web change can, which is the reason tier 1 was
worth doing at all.

**The reminder cache is a separate encoding, so two rules bind anything added to
it.** `Notifications.kt` builds `setContentTitle` with no network, from
`Settings.cacheReminders` / `cachedReminders` (`data/Settings.kt`), which carries
no icon today.

- **A tenth field is appended, never inserted.** The reader indexes by position
  and tolerates a short line with `getOrNull`, which is what lets a cache written
  by the previous version still arm its alarms. Inserting silently re-reads every
  other field one place over.
- **Through `Widgets.flatten`**, which strips `|`, `\n` *and* `\r`. The
  server-side validator is necessary and not sufficient here, because the cache is
  its own encoding — the first reader of that rule cost a habit named `Run\rfast`
  writing one record and reading back as two unparseable halves, taking its alarm
  with it.

The widget record (`Widgets.Record`) is the same two rules again, for the same
reason: it draws with no network. Lowest value of the surfaces, fine to defer,
but the record format is cheaper to change once than twice.

**The width trap is the inverse of the web's.** In `HabitGridRow` (`ui/DayGrid.kt`)
the name column is a fixed `NAME_WIDTH = 120.dp` and the grid is a
horizontally-scrolling `ScrollState` of `CELL_WIDTH = 40.dp` cells — nothing is
squeezed out of existence, the name simply gets less of 120dp. So `responsive.mjs`'s
finding does not transfer, and the real question is whether 120dp survives an icon
plus a two-line name. If it has to widen: **the date header uses the same
`NAME_WIDTH` box**, and the two must move together or the dates stop lining up
with the rows they label.

**Accessibility is `Modifier.clearAndSetSemantics { }` on the icon slot** — not a
`contentDescription` override on the name `Text`, which would leave the icon as a
sibling node announcing "person running facing right" before every row. The
`🔥 5` streak line immediately below already fixes this pattern.

**And the phone's icon input is deliberately not a picker.** The system keyboard
already has an emoji key; `androidx.emoji2:emojipicker` is a View needing
`AndroidView` interop inside a Compose form; and a hand-copied Kotlin list is a
second authored copy of #182's curated list that drifts the first time a glyph is
added. #182 argues the same question at length and reaches the same answer.

## Tier 3: uploads, and the list it has to clear

Everything expensive lives here, and it should be its own change with this list
as its checklist.

**Store the bytes in the database, not on disk.** The personal edition's promise
is *"Your data is a single file at `data/habiterall.db` — back it up by copying
it."* A sibling `uploads/` directory makes that false, silently, and the way
people find out is a restore with every icon missing. The cloud edition's app
container holds no state. So a BLOB in SQLite, a BYTEA in Postgres, with the
cloud table carrying `user_id`, `ENABLE`/`FORCE ROW LEVEL SECURITY` and the
ordinary owner policy.

**Deliver it content-addressed, and do not inline it.** A `data:` URI on each
habit in `/overview` needs no CSP change and works offline for free — and is the
wrong call, because `/overview` is refetched on every check-off by design, so
inlining puts every icon's bytes on the wire every time anyone ticks a box (#189
is that route's size and is still open; #193 was its memo and has shipped — an
inlined icon works against both).
Instead: hash the bytes, store the hash on the habit, serve `GET /api/icons/:hash`
with a long immutable `Cache-Control`. Content-addressing gets two things at once
— the URL never changes for the same image, and changing an icon produces a
*different* URL, so there is no staleness to invalidate. **The route still
authenticates and still checks the hash is referenced by one of the caller's own
habits; content-addressing is a cache strategy, not an authorisation scheme.** And
`/^\/api\/icons\//` joins `CACHEABLE_API` in `sw.js`, or icons vanish the moment
the app goes offline while the rest of the dashboard keeps working from cache.

The upload path is the risky part:

- **Refuse SVG.** In an `<img>` under `img-src 'self'` it is inert, but nothing
  stops a user opening `/api/icons/<hash>` directly, where the browser treats it
  as a document and any script in it runs same-origin with the session cookie.
  Not accepting it is one rule instead of three. Our own presets are SVG because
  we wrote them.
- **Sniff the type from magic bytes, never from the declared `Content-Type`**, and
  respond with the sniffed type plus `X-Content-Type-Options: nosniff`. PNG and
  WebP are enough.
- **Cap the decoded dimensions, not only the byte length.** A 40KB PNG can declare
  a gigapixel canvas. PNG's `IHDR` and WebP's `VP8X` both put width and height at
  a fixed header offset, so this is a few lines of `DataView` — which matters,
  because adding `sharp` to re-encode server-side is not on the table for a
  project whose personal edition ships with one runtime dependency.
- **Resize in the browser** before uploading — a canvas draw to 128×128 — so the
  server's job is validation rather than image processing. The phone would need
  its own equivalent, which is an argument for Android offering presets and emoji
  only.
- **Its own rate limit**, and **authenticate before buffering the body**. The
  personal edition already fixed exactly that ordering bug on `/api/import`, where
  the raw parser sat above `requireAuth` and an unauthenticated 70MB POST was read
  into memory and *then* refused.

**The undelete trap.** Deleting a habit cascades its icon row away, and
`restoreHabit` in `habit-dialog.js` recreates the habit from a snapshot taken from
`GET /habits/:id`. If that snapshot holds only a hash, undo restores a habit
pointing at bytes that no longer exist — from an action whose entire promise is
that it is undoable. Either the snapshot carries the bytes, or the delete does
not remove them immediately. Tier 1 has no such trap, because the grapheme *is*
the value.

**Backup:** habiterall JSON carries it base64'd, which is the other reason the
dimension cap should be tight — at 128×128 forty habits stay well under a
megabyte, and this is a file people email to themselves. CSV and Loop `.db` have
nowhere to put it; that gap belongs in `shared/test/roundtrip-fixture.mjs` beside
the one tier 1 already asserts.

## An uploaded icon in a Discord reminder — correcting #66's "never"

#66 says: *"An uploaded icon will never appear in a Discord reminder — a
self-hosted instance behind a router has no inbound hostname, which is the stated
premise of the whole gateway design."* **The premise is real and the conclusion
does not follow.** The issue still carries the claim; this section is the
correction, and it is written out rather than quietly dropped because a wrong
"never" sitting in the archive is worse than no record at all — the whole point
of this directory is that a settled question is not re-derived, so a question
settled wrongly here propagates.

What is true: **a self-hosted instance behind a router has no inbound hostname.**
That is not an accident of deployment but the stated premise of the gateway
design — `discord.md` records that interactions arrive over an outbound WebSocket
precisely because requiring an inbound endpoint "would mean the interactive
reminders only worked for people who had already solved a harder problem".

That rules out an embed naming a URL for Discord's servers to fetch — **for that
deployment class, and not as a general fact.** The cloud edition *requires* a
public address (`PUBLIC_URL: ${PUBLIC_URL:?set PUBLIC_URL}` is a hard fail in its
compose file) and `notify.js` already puts `appLink` into `embed.url`, so
Discord's servers demonstrably can reach a cloud instance. Generalising the
self-hosted premise to everyone is the same move this section spent its first
paragraph undoing, so: not that.

The reason the URL approach is out **everywhere** is the rule two sections up.
`GET /api/icons/:hash` as specified there authenticates and checks the hash is
referenced by one of the caller's own habits, so an unauthenticated fetch by
Discord's servers gets a 401 whatever the hostname is. (That route does not exist
yet — tier 3 is unbuilt — so this is a property of the design above, not a
measurement.) Serving icons unauthenticated to make an embed work would be
trading the authorisation rule for a cosmetic one, and content-addressing is not
a substitute for it.

What that misses is that referencing a URL is not the only way to put an image in
an embed. Discord's own reference:

> To add file(s), the standard `application/json` body must be replaced by a
> `multipart/form-data` body. The JSON message body can optionally be provided
> using the `payload_json` parameter.

> Within an embed object, you can set an image to use an attachment as its URL
> with the attachment scheme syntax: `attachment://filename.png`

The bytes travel **outbound**, in the same POST as the reminder, in a `files[n]`
part whose index matches an entry in `attachments`. Nothing has to be able to
reach in. The hostname argument does not touch this path.

**The real constraint is our sender, and it is an implementation gap rather than
a structural impossibility.** Both Discord senders are JSON-only:
`postWebhook` in `shared/src/notify-send.js` and `discordRequest` in
`shared/src/discord.js` each set `Content-Type: application/json` and send
`JSON.stringify(payload)`. Neither builds a multipart body, and no caller asks
for one. So an uploaded icon cannot reach a Discord reminder **as the code
stands** — which is a true statement with an expiry date on it, not a law.

It is also architecturally available if it is ever wanted: the sender is already
outbound-only, and tier 3 stores the bytes server-side anyway, so the change is
in the sender rather than in anyone's deployment. What it would cost is worth
stating before somebody calls it free — a second encoding in a function whose
three-way answer (fine / retryable / permanently broken) is currently reasoned
about over one code path, and, in the straightforward version, the image bytes
going out again with every reminder. Whether that second cost can be avoided by
uploading once and reusing what Discord hands back was **not** investigated here;
anyone pricing this should find that out rather than assume either way.

#66's aside that an uploaded icon probably should not appear in an **Android**
notification either is a separate judgement and is untouched by this.

Tier 1 is unaffected, and that asymmetry is the point: an emoji travels as text,
so it reaches every destination the name reaches, for free, everywhere. A preset
or an upload reaches only the surfaces that can draw an image *and* whose sender
has been taught to carry one — two conditions instead of none, each of which has
to be checked per destination rather than assumed. That is the same question the
tier-2-on-Android section asks, arriving from the other side, and answering it
with a "never" is what went wrong the first time.
