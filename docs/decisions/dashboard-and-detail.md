# Dashboard window, grid columns, detail cards

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

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

**...and the setting on top of it is a CAP, which is what kept it out of both
editions' routes.** `gridDays` offers `auto | 5 | 7 | 10 | 14` and
`gridColumns` (shared/public/ui/window.js) is `Math.min(chosen, ladder(width))`,
so the ladder above is a ceiling the user may only ever ask to come under. That
one `Math.min` is the whole feature: without it the option is a control for
reintroducing the bug the ladder fixes, which is why `responsive.mjs` now runs
its whole pass a second time with the setting at its maximum — and does catch it,
at the tablet width, with the name back at 0px.

The costing follows from the cap rather than from the setting. `load()` asks
`/overview` for `GRID_DAYS` days, "the widest column count so a rotation to
landscape needs no refetch" — and because no offered value exceeds that, the
window fetched is still the widest the grid can draw, so **changing the setting
needs no refetch and neither edition's route learns anything**. Offer a value
above 14 and that stops holding silently: the grid would page into days nobody
asked the server for and paint them as unrecorded, which is the `end`-paging
defect `test/overview.integration.mjs` exists for, arriving from a preference.
There is a test asserting every value in `SETTING_VALUES.gridDays` is at most
`GRID_DAYS`, read from the list rather than restated.

Which is also why the list stops at 14, and that was **measured rather than
argued**. `.view` is `max-width: 1100px`, so the habit row is 1060px wide at
1440px, 1920px and 2560px alike — a bigger monitor buys nothing, ~999px is all
there ever is for the cells and the name together, and the ceiling without a CSS
change is about 18 columns. #112 proposed 21 and 30 on the premise that "a
1440px monitor has room for a month"; it does not, and both would have clamped
to the same number on every screen there is. What fewer columns buy differs by
width and that was measured too: above 640px `.check` is a fixed 44px, so the
gain is room for the NAME (329px → 761px), while under 640px the CSS shares the
row evenly and the gain is the fat thumb targets the issue asked for (45px →
65px). The first version of that test asserted fatter cells on a desktop and was
wrong about the app.

**Which cards a habit's page draws is a list of INVENTED IDS, and the server
never hears about it.** *Superseded by #163: `detailCards` is no longer a bare
`multi` list of ids — the stored shape is `{id, on}[]`, an `ordered-multi`, so
that a card can be reordered and not only hidden. See `shared/public/CLAUDE.md`
("The detail view") for the current shape and the legacy-migration rules; the
"invented ids" and "gating the append" framing below is still true, it is only
the membership-only-list part that no longer holds.* `detailCards` is a `multi`
over `DETAIL_CARDS` (shared/src/validate.js), gating the nine appends in
`ui/detail.js`. Ids and not
the card titles, because a card has no id — `card()` sets a class and the detail
view "owns no ids of its own" — and the titles are English prose that #144 is
about to make translatable. Nothing in the DOM needs one: the gate is on the
*append*, so a hidden card is never built, which is the point when what it costs
is an SVG.

Two things it deliberately does not do. It does not hide the four stat tiles,
which are the summary rather than a card, so unticking everything leaves a page
rather than a blank one. And it does not reach `/habits/:id/stats`, though
skipping the arithmetic looks like the obvious win. Measured: a 1-year habit's
stats response is 47KB and 5.7ms, a 10-year one 464KB and 52ms — and only THREE
of the nine cards map to a field nothing else reads (`history`,
`weekdayByMonth`, `frequency`), because `computeAwards` reads `scores`,
`streaks`, `weekdays` and `resilience` and the tiles read the rest. The rest of
the answer is the service worker: `networkFirst` does `cache.put(request, …)`,
which keys on the full URL, so a `?cards=` parameter is one data-cache entry per
combination — and changing the setting while offline would turn the whole detail
view into a synthetic 503 with a toast, rather than one missing card. The
payload is worth attacking through the WINDOW instead (`scores` is 139KB and a
day-granularity `history` 250KB of that 464KB), which is a different change.

One consequence that is not about drawing, **and it took two goes to put in the
right place.** `detail.open()` clears a paging position only when the HABIT
changes, so a card hidden while paged into 2023 comes back there with nothing on
screen to say why. The rule is `forgetHiddenPositions` in `ui/detail.js`: a card
that is not being DRAWN holds no position.

It belongs there rather than beside the setting, and that is the whole lesson.
The detail view keeps a position in **two** places — `state.chartOffsets`, which
`windowedChart` keys per card, and `state.calEnd`, which is the calendar's — and
two of the four offset keys are `score:<gran>` and `history:<gran>`, built from
the CURRENT granularity, session override included. Only `detail.js` knows that
mapping. Written in `applyDraft`, it would be a third copy of it, reconstructed
from a granularity that function is in the middle of clearing.

Both wrong versions shipped in a review round. The first cleared only
`chartOffsets`, and was measured hiding a calendar at `30 Jan 2023 → 7 Apr 2024`
and showing it again at exactly that — the rule failing on the one card anybody
pages. The second cleared BOTH but from `applyDraft`, gated on "`detailCards`
changed at all", so unticking *Weekday consistency* also sent a History card
paged back to 2019 — still ticked, never hidden — to today. One fix was too
narrow about WHICH state and the other too broad about WHICH CARDS, and the
scoped-by-card version in `detail.js` is what answers both.

Three things about the test, because two of them are the "cannot fail" shape
this file keeps recording. It drives the dialog with the habit open, since
setting the value through the API reloads the page and starts everything at
today for free. It runs **narrow and at day granularity**, because at desktop
width with the fixtures the calendar is the only card that pages at all — so the
first version found no range readout and compared `''` with `''`. And it asserts
that **both** cards actually MOVED before asserting one was left alone: the
calendar's position survives a broken `chartOffsets` rule on its own, so
checking only that one leaves History sitting at today and the comparison passes
against the very bug it is written for. The mutation run is what showed both.

`windowedChart` also gives its range readout the same `.cal-range` class the
calendar uses, so a test looking one up must scope to a card by title or it
reads whichever card is highest on the page.

An older half of this is left alone: `open()`'s comment says "Opening a
different habit starts at 'now'", and it clears `chartOffsets` only — so
`calEnd` already survives opening a different habit today.

Neither setting is mirrored on the phone, and the two reasons differ. The native
grid does not page a fixed window at all — it grows by scrolling and sends
`end = null` — so there is no count for `gridDays` to govern. `detailCards` the
phone already honours, because the detail view **is** the WebView: one renderer,
so a Kotlin default would be the drift `notMirrored` exists to prevent rather
than the mirror that prevents it.



## The day strip on a habit's own page ("Recent days")

Arriving at a habit from a reminder, there was no way to record that day without
opening the calendar card and the day editor behind it — two presses and a
dialog to answer a yes/no question the notification had already asked. The
dashboard has had the right control since the beginning; it just was not
reachable from the one page that names a single habit.

**The reuse could not be an import, and that decided the shape.** `dashboard.js`
imports `detail.js` to open a habit, so `detail.js` importing `dashboard.js` is
the cycle `ui/store.js` exists to break. The alternative to a third module was
writing the strip fresh on top of `ui/toggle.js`, which is a real option — the
tap RULES already live in a shared module — but it duplicates ~280 lines in
which four separate rules exist because a wrong version shipped: the avoided
inversion in `paintCheckbox`, asking whether the entry map HOLDS a date rather
than what it holds, the SKIP sentinel counting only for a boolean habit, and the
optimistic paint happening before the await. The amount dialog could not have
been duplicated at all — it is built on ids that must have exactly one owner.

So `ui/day-strip.js`, and the extraction landed as its own commit verified by
running all 30 existing browser suites UNCHANGED. Anything red there would have
been a botched move rather than a feature.

**Storage stays the caller's.** The two surfaces hold the same day in different
shapes: `/overview` returns `{date: value}` plus a `skips` ARRAY and flattens a
skip onto the SKIP wire value, while `/habits/:id/entries` returns rows carrying
`status` separately. A host answers what a day currently is, applies a change to
its own model and hands back an undo, and says how to repaint and how to reload.
It is a module-level singleton, never a per-render closure — the amount dialog
outlives a rebuild, which is why `counting` already held a habit id rather than
the habit.

**The three writers collapsed into one.** `writeDay(host, habit, date, to)` over
a `'clear' | 'skip' | number` union — the same vocabulary the method and body
already switch on — so optimistic-before-await, `e.queued` standing while
anything else rolls back, skips and entries moving together, and the trailing
refetch each exist once instead of three times.

**The two `repaint`s differ on purpose.** The dashboard's is `paint()`, which
also redraws each row's score and streak line and is cheap. The detail page's is
`repaintCells`, which re-runs the paint over existing nodes and replaces no DOM
at all — a rebuild there is two round trips and up to ten cards of SVG, far too
much to spend on a tap, and touching no nodes is what keeps keyboard focus on
the button that was just pressed.

**`refresh` is single-flight, and that is correctness rather than tuning.**
`open()` is two requests and a full rebuild, so three quick taps fire three of
them and nothing guarantees the third resolves last — a later-started reload can
finish first and leave OLDER data painted. The hazard predates the strip (two
fast presses on the History card's ‹ Earlier, which still refetches, do it) but
the strip makes rapid re-entry normal.

**Paging deliberately did not move.** The dashboard refetches a window; the
detail page holds its whole history already and slices it through
`windowedChart`, which also gives it the offset in `state.chartOffsets` that
`forget` knows how to clear. `gridDays` caps its columns through the new
`cappedColumns` rather than `gridColumns`, whose 7/10/14 ladder exists to
protect the dashboard's habit-name column — a column this card does not have.

### Four things the tests found that reading did not

- **The 4px gap between cells is part of the density.** `columnsForWidth`
  DIVIDES the width by the figure it is given, so 44 claimed 23 columns fit a
  1026px card when 23 of them need 1104px. Measured in a browser: the strip
  overflowed into a horizontal scrollbar and the captions drifted up to 72px off
  the squares they label, because `justify-content` resolves differently for a
  row that overflows. 48 is the cell plus its gap, which is what
  `MIN_SLOT.circle` has always meant by "diameter plus a gap".
- **`.grid-dates` carries `justify-content: flex-end`** for the dashboard's grid
  header, where it is right. Inside a card it right-aligns the captions while
  `.checks` left-aligns the boxes.
- **Three offline taps could not distinguish the rollback rule.** The cycle from
  an unanswered day is unknown → done → no → done, so a build that rolled back a
  QUEUED write — re-deriving `done` from `unknown` every time — finishes on the
  same value as a correct one. Two taps is what separates them: 0 against 2.
  Mutation-testing found this; the first version of the test passed against the
  broken build.
- **Hiding a card through a page RELOAD cannot test `forget`.** `open()` clears
  `state.chartOffsets` wholesale whenever it opens a habit that was not already
  open, so a reload puts every card back at today whether the `forget` entry
  exists or not. The assertion has to be driven through the settings dialog, in
  the page, which is what the calendar's equivalent test already did.

### Paging the strip redraws the card, not the page (#245)

Everything **Paging deliberately did not move** says is still true — the offset
lives in `state.chartOffsets`, `forget` clears it, `gridDays` caps the columns
through `cappedColumns`. What it did not say is what `redraw` did, and that was
the whole of the defect. This card's `redraw` was
`() => refresh(habit.id)` — the page's one idiom, shared with the other nine —
so a press of ‹ Earlier spent `open()`'s two GETs and a rebuild of up to ten
cards of SVG to show a slice the page was already holding. `page()`
(`ui/components.js`) writes `state.chartOffsets[key]` and *then* calls `redraw`,
in that order, and `open()`'s one `catch` is `toast(e.message); return false` —
so a GET that failed left the position moved and nothing redrawn.

`buildRecentDaysCard` now closes over a local `draw()` and passes `redraw:
draw`. Everything the old body did is inside it and none of it is hoisted —
`todayISO()` least of all, which must not freeze at the moment the card was
built — and because `windowedChart` builds into two places, the nav into the
card's `.card-head` and the chart onto the card itself, `draw` takes `.cal-nav`
and `.chart-scroll` away before building the next pair. No file and no export
was added, so `sw.js`'s `SHELL` and `CACHE_VERSION` are untouched: confining the
change to one module's internals is what keeps this from costing every installed
client its data cache, and it is the reason the shape was chosen that way rather
than a happy accident of it.

**Why this card could.** `open()` fetches `/habits/:id/entries` with no `start`
and no `end`, so `entries`, `entriesByDate` and `skipSet` are the habit's whole
history and every window this card can page to is already in memory; `inRun`
comes off the stats payload, requested the same way. The dashboard holds only
the fortnight it asked for and must ask again. Most of the other cards here draw
figures the SERVER computed, which could not move offline whatever their redraw
did.

**And the calendar is not one of those — it is a second instance of the same
defect, left out of scope and filed as #274.** (#274 landed — see "The
calendar pages the same way (#274)" below.) An earlier draft of this section
said "and nothing else on the page could", and shipped that reason into
`shared/public/CLAUDE.md` and into `detail.js`'s own comment beside it. It was
simply false, and it is worth recording as false rather than quietly narrowing:
a `CLAUDE.md` is loaded into context for every future change to this page, and a
wrong reason there is more expensive than no reason. `buildCalendarCard` draws
from `entriesByDate` and `skipSet` — fetched unwindowed exactly as the strip's
`entries` are — plus `stats.streaks` for the bands, already in memory, and
`calendarWindow(calEnd, CAL_WEEKS, weekStart)`, which is pure client arithmetic.
Nothing in its window needs the server. And its `shift` is the shape this whole
section is about:

```js
const shift = (weeks) => {
  state.calEnd = addDaysISO(state.calEnd ?? todayISO(), weeks * 7);
  if (state.calEnd > todayISO()) state.calEnd = todayISO();
  open(habit.id);                       // offline: toast, return false, no render
};
```

The difference is that the calendar's stored position OUTLIVES the strip's, so
this one is not mostly latent the way the strip's was. `open()` clears
`state.chartOffsets` only when a different habit is opened
(`if (!redraw) state.chartOffsets = {}`), and `dashboard.paint()` nulls
`state.openHabitId`, so going back to the list and reopening does clear the
strip's offset. Nothing on that path clears `state.calEnd`: it is nulled only by
the calendar's own `Today` button and by the card's `forget` entry
(`detail.js`), which runs when the card is hidden — and the comment on that
entry already says why, that `chartOffsets` alone was never enough for the one
card paged by a date. Press ‹ Earlier offline, go back to the dashboard, come
back online and reopen the habit — and the calendar renders a window you never
saw it move to, which is #245's own headline symptom surviving a navigation the
strip's did not. It is scoped out here for the reason #230 is, not because the
rule above stops at this card's edge. (This headline symptom is what #274
fixed; the cross-habit carry-over below is a narrower, separate question that
#274 left open — see "The calendar pages the same way (#274)".)

**The rejected shape was rolling the offset back when the redraw fails**, in
`page()`. It loses twice: it keeps a request this card never needed, and it
changes every card that pages through `windowedChart` to fix the behaviour of
one. Redrawing locally makes the
card's own documented claim true and removes the two round trips *online* as
well, which is the same waste seen from the other side.

**What a user actually met is the smaller claim, and it is the honest one.**
"The window jumps when something next draws it" needs a draw, and offline there
is no draw to be had: the detail view's only draw path is `open()`, which is
those same two GETs, and a settings change, a cell tap and a `'change'`
broadcast all end there. Reconnecting supplies no draw either —
`connectivity.js` emits `'reload'` from the outbox flush and again on the
transition back, `detail.js` deliberately does not handle that event, so the app
goes to the dashboard; reopening the habit then clears `state.chartOffsets`
wholesale. So the disagreement between the stored position and the drawn window
was real and is what the fix removes, and it was mostly latent. The symptom
nobody had to construct is the plain one: offline, ‹ Earlier did nothing at all.
`--- paging, offline ---` in `stripcheck.mjs` asserts both, in that order.

**Devtools offline emulation does not reach the service worker's own fetches,
and that nearly made the test theatre.** Measured against the unfixed code with
`Network.emulateNetworkConditions({offline: true})` and nothing else: both of
`open()`'s GETs came back out of `DATA_CACHE` — `CACHEABLE_API` in `sw.js`
matches `/^\/api\/habits/` — `open()` succeeded, the strip paged perfectly well,
and every check written for the bug passed. Deleting the data cache first did
not help either, because the worker simply re-fetched over a socket the
emulation was not applied to. `Network.setBypassServiceWorker` is what makes the
app offline for a GET, and it is the load-bearing line of that block rather than
a contrivance: it stands in for the self-hoster on a plain-`http` LAN address,
where `isSecureContext` is false and there is no worker at all, and for the
first offline boot after a `CACHE_VERSION` bump, which drops the data cache and
leaves the worker answering its synthetic 503. It is also why the older
`--- offline, the cycle still advances ---` block in the same file gets away
with the network conditions alone: only its WRITES have to fail, and `sw.js`
returns early for every non-GET.

**A latent test defect surfaced with the fix, and it had never been testing what
it named.** `calcheck.mjs`'s 'calendar paging' case found its button with an
unscoped `document.querySelectorAll('.cal-nav button')` — but `.cal-nav` is
`windowedChart`'s class rather than the calendar's, and Recent days is the FIRST
card on the page, so it had always been pressing the STRIP's ‹ Earlier. It
passed because that button rebuilt the whole page, which is precisely what the
block measures (a scroll position surviving a re-render). Once the strip redrew
itself in place the stamped node survived the press, and the check timed out
waiting for it to go. The selector is scoped to the Calendar card by title now.
This is the `.cal-range` hazard recorded further up met a second time, on the
sibling class, by a check that was green throughout — which is why the note in
`shared/public/CLAUDE.md` now names both classes.

**Scoped out here and open at the time: #230**, the strip and the calendar card
disagreeing about the same day offline. `writeDay` ends in a refetch that never
runs with no network, so the strip's optimistic paint stood while the calendar
kept the value it was drawn with. It lives in the same files, and it was left
alone because it is a different question: this change is about which WINDOW is
drawn, that one about which VALUES are in it. **That framing held, and #230 has
since shipped** — the WINDOW/VALUES split is still why these are three sections
rather than one. See "The strip and the calendar agree on a tap (#230)" below,
and the sentence in the `#274` section it corrects.

### The calendar pages the same way (#274)

`buildCalendarCard`'s ‹ Earlier / Later › / Today had exactly the shape the
section above already named and left open: `shift` moved `state.calEnd`,
clamped it to today, and then called `open(habit.id)` — position committed,
card not drawn, because `open()`'s one `catch` is `toast(e.message); return
false`. Everything the calendar draws was already in memory for the same
reason the strip's was: `entriesByDate` / `skipSet` / `notesByDate` come off
`render()`'s unwindowed `GET /habits/:id/entries`, `stats.streaks` is already
on the payload the builder was handed, and `calendarWindow(...)` is pure
client arithmetic over an end date and a week count. Nothing in the window
needed the server, so `draw` — the same local closure `buildRecentDaysCard`
already has — is what `shift` and `Today` call now, and `open()`'s refetch is
gone from both.

**"Offline" is the wrong name for what `open()` actually fails against here,
and this is where that gets corrected — the `#245` section above states the
strip's own symptom the same way ("offline, ‹ Earlier did nothing at all")
and carries the same qualification, left as written rather than rewritten.**
With a service worker installed and its data cache warm — true from the
second visit on — both of `open()`'s GETs, `/habits/:id/stats` and
`/habits/:id/entries`, are inside `CACHEABLE_API` (`sw.js`), so
`networkFirst`'s `catch` serves them out of `DATA_CACHE` and the redraw
SUCCEEDS: the position moves and the card draws it. What `open()` genuinely
fails against — and what this fix is actually for — is: no service worker at
all (a self-hoster on a plain-`http` LAN address, where `isSecureContext` is
false and nothing is installed); a NEW worker claiming an already-open page,
since `sw.js` calls `skipWaiting()` on install and `clients.claim()` on
activate and that activate deletes the old `habiterall-data-*` cache, so a
card rendered before the takeover meets an empty `DATA_CACHE` after it; a
`401` once the session cookie has aged out, or a `429` from the read limiter,
neither of which the data cache stands in for — `networkFirst` falls back to
the cache only when the `fetch` THROWS, and a 4xx returns normally and is not
even cached; and a hung-but-not-dead server.

Two of those were stated wrongly in the first version of this paragraph and
are worth the correction, because both are the kind of detail a reader would
otherwise take on trust. **The first offline boot after a `CACHE_VERSION`
bump is NOT one of these cases**, though it looks like the obvious one and
the `#245` section above uses it as an illustration: on that boot nothing
renders at all — `start()` awaits `adapter.load()` inside the boot `try` and
a throw ends at `showBootError` (`app.js`), which is the `#view-error` case
`shared/public/CLAUDE.md` already records — so there is no calendar card in
existence to press ‹ Earlier on. The claiming-worker sequence above is the
reachable version of the same idea. And the timer the hung server spends is
**`ui/api.js`'s own 10s `AbortSignal.timeout`, not `networkFirst`'s**, and it
is ONE of them rather than two: `open()` awaits its two GETs sequentially, so
the stats request throws and the entries request is never issued. The
distinction is not pedantry — the page's bound is armed before the request is
dispatched to the worker, so it always wins, and if the WORKER's bound fired
instead its `catch` would serve the warm cache and `open()` would merely
succeed ten seconds late. The right conclusion by the wrong mechanism is how
the paragraph above this one came to be wrong in the first place.
None of that makes the defect less real or less worth fixing: one press
making two round trips to redraw a slice already sitting in memory is a cost
on every one of those paths, the happy one included. "Offline" is what the
TEST reaches for, with `Network.setBypassServiceWorker`, to isolate `open()`'s
failure without needing a real `401` or a real bump — see "The service-worker
measurement…" further down, which is this same fact read from the test's
side, not a second, disagreeing reason.

**`state.calEnd` outlives `state.chartOffsets`, and that is still true after
the fix, not something it resolved.** `open()` clears `state.chartOffsets`
only when a DIFFERENT habit is opened (`detail.js:74`); it clears nothing for
`state.calEnd`. That is why the calendar's version of this defect was never
mostly latent the way the strip's was — the window a `redraw` failed to draw
stuck around across a reopen of the SAME habit, where the strip's own offset
had already been reset by the time you came back to it. Fixing `draw` to be
local removes the failure mode entirely for the habit you paged: every press
now draws what it stored, online or off, so there is no longer a `redraw`
that can commit a position and draw nothing.

**Opening a DIFFERENT habit inheriting the paged position was scoped OUT of
this fix, in the first round — described just above as a neighbouring issue
left for Mark to settle. He has since decided it belongs in this same PR, so
what follows is the decision as SHIPPED, reversing that scoping rather than
leaving it stand.** `state.calEnd = null` is added to `open()`'s `!redraw`
block, beside `state.chartOffsets = {}` — the identical reset, for the
identical reason, and it fires on a same-habit reopen too, not the
cross-habit case alone: reopening a habit, the SAME one or a different one,
starts the calendar at today. Five reasons, weighed in this order:

1. **The two cases cannot be separated at `:74`, and separating them costs
   new state.** `redraw` is `state.openHabitId === id`, and `dashboard.paint()`
   nulls `state.openHabitId` (`dashboard.js:235`; `categories.js:160` does
   too), so returning to the list and reopening the SAME habit is already
   `!redraw` — there is no cheaper hook a per-habit rule could hang off.
   Keeping a per-habit position would need `calEnd` keyed by habit — a
   `calEndHabitId`, or a map — which is a sixth thing for `Today`, the
   `forget` entry and the settings dialog to keep in step with. The one-line
   reset needs none of it.
2. **Consistency.** Nine other cards reset their paging position on
   `!redraw` (the same nine ids `CARDS`' `forget` entries name). A calendar
   that alone survives "go back to the list and reopen" makes that one
   gesture mean two different things on one page — the "two surfaces over one
   dataset disagree" shape this repo names most often.
3. **The `:74` comment's own principle already covers it.** "Opening a
   different habit starts at 'now'" is a statement about opening a PAGE, not
   about which habit it happens to repeat, and `calcheck.mjs` already asserts
   the scroll analogue beside it — "opening a habit starts at the top" makes
   no exception for the same habit either.
4. **What is preserved is the part that matters.** `redraw` is TRUE for every
   in-page action — a cell tap, a settings change, a zoom press, a
   granularity change, the `'change'` broadcast — so the paged position
   survives everything except leaving the page. The cost is one re-page after
   a dashboard round trip; the benefit is never landing on a detail page
   showing October 2024 with no memory of having asked for it.
5. **The `forget` entry's own ground — the calendar being "the one card
   anybody pages by a DATE rather than a window" — is real, and it argues for
   keeping the position WITHIN a viewing, which this still does.** Across a
   NAVIGATION the disorientation argument wins instead. And the option being
   replaced was never "keep it per habit" — nobody designed that; it was
   "keep it globally and leak it across habits", purely as a side effect of
   `calEnd` living outside `chartOffsets`. Both the kept option and the
   discarded one are changes from that starting point; this is the smaller
   one.

**#230 was not closed by this — and the "one true side effect" this paragraph
originally stated so narrowly turned out to be the whole mechanism #230's own
fix needed.** Kept in view rather than deleted, because the relationship
between the two changes is the part that cannot be reconstructed from either
diff alone. As written at the time: #230 is the strip and the calendar
disagreeing about a day's VALUE offline; this change is about which WINDOW is
drawn, not which values are in it; and its one side effect is that `draw()`
closes over the same `entriesByDate` object `detailHost.edit` mutates
optimistically, so a page press made AFTER an offline tap draws the tapped
value where before it would have redrawn nothing at all. All of that was
right, including the refusal to overclaim — nothing redrew the calendar ON the
tap, so the disagreement survived until something paged or reopened.

What the paragraph could not see is that "a local redraw reads the live maps"
is not a side effect at all but the missing half of #230. #230's fix adds no
drawing code: it gives `detailHost.repaint` a second caller for this same
`draw`. So #274 made the calendar's redraw local, and what it left behind was a
closure that draws current state from wherever it is called; #230 is the second
place that calls it. Read the two
together and the ordering was lucky rather than planned — had #230 been
attempted first it would have had to build the local redraw itself, which is
#274's whole body of argument. See "The strip and the calendar agree on a tap
(#230)" below.

**The service-worker measurement that makes the offline half of this real is
the same one already recorded above, for the strip.** Devtools' network
emulation does not reach the service worker's own fetches — `open()`'s GETs
answer out of `DATA_CACHE` under `Network.emulateNetworkConditions` alone,
because `CACHEABLE_API` matches `/^\/api\/habits/`, so `open()` SUCCEEDS and
every check written against the unfixed calendar would have passed for the
same reason the strip's did. `Network.setBypassServiceWorker` is what makes
the offline calendar checks in `calcheck.mjs` mean anything, for the reasons
`stripcheck.mjs`'s own comment gives in full.

### The strip and the calendar agree on a tap (#230)

The two grids are drawings of ONE pair of maps. `render()` computes
`entriesByDate` and `skipSet` once and stashes them at module scope
(`openEntriesByDate` / `openSkipSet`, for the reason those declarations give),
`detailHost.edit` mutates that pair before the write goes out, and
`detailHost.repaint` redrew the strip's cells from it and nothing else. Online
that was invisible: `writeDay` ends in `host.refresh()`, a refetch and a full
rebuild, so the calendar caught up a beat later whether or not the repaint had
ever touched it. Offline `api()` enqueues and THROWS, `host.refresh()` is never
reached, and the two grids sat showing one date two ways until reconnect. So
this was a redraw that was not happening rather than data that was missing, and
the fix is one call added to `repaint`.

**A whole-card redraw, not a cell-level one — a deliberate asymmetry with the
strip.** `repaintCells` exists because the strip's own rebuild is two round
trips and up to ten cards of SVG, and because touching no nodes keeps focus on
the button just pressed. The calendar has no equivalent and should not grow
one: `charts.js` owns what colour a day is — the ramp, the avoided inversion,
the ghost tick, the run stroke, the `?` — and a per-cell entry point into that
is a second declaration of the same decision, which is the drift the
one-derivation rule behind `inRun` (#176) exists to prevent. Calling the card's
own `draw` reuses the one that is already there, and it is affordable for
exactly the reason #274's paging is affordable: nothing in the window needs the
server, so a redraw is arithmetic and SVG with no request in it.

**`draw` READS `state.calEnd` and never writes it, and that is the whole of why
this cannot repeat #274.** #274 was a position committed before a redraw that
could fail; a repaint commits nothing, because `shift` and `Today` remain the
only writers. A tap therefore redraws the STORED position and leaves it where
the user put it. The wrong version anyone reaches for first is redrawing at
`todayISO()`, and it is invisible in the ordinary case — there is no stored
position, so the window is today either way — while silently discarding a paged
one the moment there is. `stripcheck.mjs` asserts both halves (the readout
unmoved, and `state.calEnd` still holding what the press stored) against a
calendar deliberately paged back first, because a check made at today would
pass against both versions.

**"The stored position" is the precise phrase, and "the window on screen" is
not — they differ exactly when there is no stored position, which is the
default.** `draw` resolves `state.calEnd ?? todayISO()` on every call and
`calendarChart` recomputes its own `realToday` on every call, so with `calEnd`
null a redraw is not a repaint of what was drawn before, it is today
re-resolved. That is invisible except across local midnight, and nothing in the
app cures the staleness first: the nudge's refresh declines while a habit is
open (`app.js`'s `refresh` returns on `!dashboardShowing()`, and `nudge.js`'s
own comment says so), and `'reload'` fires only on the outbox flush and the
offline→online transition, neither of which a clock produces. So a page left
open overnight has a strip showing yesterday's columns beside a calendar
anchored on yesterday, and the next tap moves the calendar to today's window and
rewrites `.cal-range` while `repaintCells` touches no nodes and the strip stays
where it was. No wrong VALUE — the day tapped is painted correctly on both — but
a new one-sided silent jump, of the same shape #230 just closed, one card
further in. Stated rather than fixed at the time; **the midnight invalidation
that section called for is now the day watch in `ui/detail.js`, and it is the
whole view rather than this card** — see "A page is drawn for one local day"
below.

**Notes rode along with nothing plumbed, and that has since changed for one
caller.** As #230 shipped, `draw` closed over `notesByDate` and a redraw handed
`openDayDialog` the notes the card was built with, on the argument that nothing
local could have moved them: `detailHost.edit` mutated `entriesByDate` and
`skipSet` alone, and the only writer of a note was the day dialog, which ends
in `emit('change')` — a refetch, not a repaint. That argument was sound and had
one hole in it, which is the hole "Two neighbours scoped out" below names:
OFFLINE the day dialog reaches no refetch at all. `edit` takes a fourth
argument now and the map is at module scope beside the other two, so there is
still one map rather than two — see "A queued day-write is not three
untruths".

**What the fix does not reach, and the run BANDS are the surprising one.**
Strength, streaks, resilience and history are figures the server computed, so
nothing local could move them offline — the same accepted staleness the
dashboard row already has, and the same one `stripRuns` is declared with. The
non-obvious consequence is inside the calendar itself: a cell is redrawn from
the maps and is right, while the band behind a run comes from `stats.streaks`
on the payload the page was built with. An offline tap closing a gap in a run
paints the day and not the run it extended — and the ERASE case is the same
mechanism read the other way, where a cell going blank leaves the connectors
and the continuation stroke drawn straight through it, and `calendarChart`
counts that newly-blank cell into `data-run-marks`, so an "In a run" legend
swatch can APPEAR on a tap that removed an entry. That is a much narrower
disagreement than the one #230 removed — between a cell and its own band rather
than between two cards — and closing it means recomputing streaks in the
browser, a second implementation of `shared/src/stats.js` that was scoped out
of #230 explicitly and that the same #176 argument refuses.

**The test could have passed for the wrong reason, and the guard against that
is a write left in the OUTBOX.** The block is in `stripcheck.mjs` and not
`calcheck.mjs` because the action is a tap on the strip. Asserting only that
the calendar cell moved is not enough: if the write reaches the server,
`host.refresh()` rebuilds the whole page and the calendar is right with no
redraw in the code at all — which is precisely what the online
'...and so does the calendar card' check further up that same file has always
been passing on. So the block reads `state.pending` beside the cell, and a
queued write is what says the redraw was local. Devtools network emulation
alone suffices here, unlike the paging blocks above: only a WRITE has to fail,
and `sw.js` returns early for every non-GET — the same asymmetry the
service-worker note above records from the paging side.

**Two neighbours scoped out at the time, both since fixed** — the sizing below
is #230's own, kept because it is what the fixes were built against, and each
paragraph now ends where the repair is recorded. Editing a day from
the CALENDAR offline is worse than the disagreement #230 removed, and worth
sizing accurately: `saveDay` (`ui/day-dialog.js`) awaits the write and only then
calls `dialog.close()` and `emit('change')`, so with no network `api()` stages
the write in the outbox and throws `{queued: true}`, the `catch` toasts its
"Saved offline — will sync when you reconnect", and neither the close nor the
refetch is reached. The dialog therefore stays OPEN showing the old value while
a toast says the change was saved, both grids paint the pre-edit day, and the
write really will land on reconnect — so the app is telling the truth and
showing three contradictions of it. Same maps, different mechanism (a broadcast
refetch, not a host repaint), and a fix has to carry `notesByDate` where this
one did not need to. Fixed below, in "A queued day-write is not three
untruths".
Separately, any rebuild of the grid resets the roving tab stop `calendarChart`
puts on its last cell, so a keyboard user who has arrowed to a day loses that
position — already true of #274's paging, and now of a tap as well. It is a
lost POSITION and not lost focus: on both paths the press is on a nav button or
a strip cell, so focus is never inside the grid being rebuilt. Fixed below, in
"A rebuild keeps the roving tab stop".

### A queued day-write is not three untruths

`saveDay` (`ui/day-dialog.js`) now closes the dialog and repaints on a QUEUED
write, which is what the strip's own tap path has always done. The shape is
`host.edit` then `host.repaint` — the same two calls `writeDay` makes, and
after #230 the second of them redraws the calendar beside the cells — reached
through a host the opening page hands in, exactly as `openCountDialog` is
handed one, because two surfaces could open a day editor and only the one that
opened it knows where the answer goes.

Three things about it are worth the words.

**It edits AFTER the await, where `writeDay` edits before it, and that is not
an inconsistency.** A TAP has to show the next state of the cycle immediately
and roll back if the write turns out to have failed, so it paints first and
keeps the undo `edit` returns. Here the dialog is modal, nothing else can read
the maps in between, and by the time the answer is known there is nothing to
decide — so the undo is discarded and never needed. The distinction that
matters in both is the same one: only an UNSENT request carries `queued`, so
anything answered is a real failure, and there the dialog stays open on the
value the server still holds and says so.

**`emit('change')` is deliberately not reached on that path.** It is a refetch,
which offline cannot answer: it would toast a second failure, and it could
rebuild the page out of the service worker's cached `/stats` and paint the
queued write straight back out. `writeDay` never reaches `host.refresh()` for a
queued tap for the same reason.

**The note is the part #230 did not have to carry.** This write states a value
(or a skip) AND a note, so `edit` takes a fourth argument: `undefined` means
"this write says nothing about the note", which is every tap from a strip and
matches `PUT /habits/:id/entries/:date` PRESERVING a note it was not asked to
change; a string is a stated note, and `''` a stated clear, which is an ABSENT
key in a map `render()` builds from `e.notes` being truthy. A `'clear'` takes
the note with the row, because the note lives on the row. `ui/dashboard.js`'s
host ignores the argument and needs no change: nothing opens the day editor
over the list. **Corrected by #297: that is still true of `edit`, and only of
`edit`.** The dashboard host's `read` now answers `hasNote` (from `/overview`'s
per-habit `notes` array of dates) and it now implements `editDay` — see "Issue
#297" below for why the note argument itself stays untouched.

The checks are in `calcheck.mjs` rather than `stripcheck.mjs` — the action is a
press in the calendar's own day editor, and `stripcheck` was already the
longest suite in the fleet, which is the floor the whole browser job sits on.
They need `Network.setBypassServiceWorker` for the reason recorded twice above.
Mutation-tested: reverting the `catch` to `toast(e.message)` alone fails five
checks with the dialog open, both grids unmoved and the write in the outbox;
dropping just the note argument fails exactly one, the reopened editor showing
an empty note over a day that has otherwise been answered.

### A rebuild keeps the roving tab stop

`calendarChart` takes a `tabStop` — a DATE — and `draw` reads it off the outgoing
grid before removing it. So a rebuild that still draws that day keeps the stop
there, and one that does not falls back to the most recent editable cell,
exactly as before.

**A date and not an index into `cells`.** The array holds only the editable
cells, so a window with future days in it has fewer of them and the "same"
index is a different day. A date either is in the new window, where it is
precisely where the user was, or it is not — which is what paging gets, since a
page moves the whole window and leaves that day off the grid, and the most
recent day is then the honest entry point rather than a position that no longer
exists.

**No cell-level repaint, which the #230 section above argues against on drift
grounds.** This adds no drawing code at all: one option read where the tab
stop was already being set, and one attribute read in `draw` before the removal
that was already there. It reaches all three rebuild paths at once — paging,
Today, and #230's own repaint — because all three are that one `draw`.

What it does not reach is a FULL render (a refetch, a zoom press, the settings
dialog): the card itself is replaced there, `calRedraw` is nulled and the
outgoing grid is not this closure's to read. Keyboard focus is not restored
across those either — calendar cells carry no `data-focus-key` — so nothing is
lost that was previously kept.

Pinned in `feat4.mjs`, beside the calendar-key checks, on a press of **Today**
with `state.calEnd` still null: the window is then unchanged, so "the stop went
back to the last cell" cannot be confused with "the window moved". The mutation
— parking the stop unconditionally on `cells[cells.length - 1]` — fails exactly
one check, naming the most recent day where the arrows had left an earlier one.

### A page is drawn for one local day

The midnight invalidation #230 said was the honest repair, done as it said: the
whole detail view, not the one card. `render()` records the local date it drew
for, and `refreshIfDayChanged` refetches the page when the browser's own
calendar day has moved past it.

**Whose day it is: the browser's own, and the archive was checked rather than
assumed.** `docs/decisions/timezones.md` — `resolveTimeZone` asks where an
ACCOUNT is, so that a reminder nobody is present for goes out at the right
hour, and `callerDay` asks what day it is for the client making THIS request.
A rendering decision is the second: the grid draws its last column from the
device clock and never from a setting, which is why `app.js` hands `nudge.init`
`today: todayISO` with a comment saying exactly that.

**A refetch and not a local redraw**, even though `lastStats` is in hand for the
save-seed above. Nothing this view shows can be recomputed from what it holds:
the score, the streaks and the history are computed as of a date the server
anchors from the caller's own zone, so a local redraw would move the columns
and leave every figure over them answering yesterday's question. It goes
through `refresh`, so it cannot race an in-flight reload, and offline `open()`
toasts and leaves the pre-midnight page up — the same answer every other
refresh on this page gives with no network.

**A timer AND a visibility listener, and neither alone is enough.** The timer
is armed for the next local midnight (`setHours(24, 0, 0, 0)`, so a 23- or
25-hour calendar day gets the right instant where `+ 86400000` would be an hour
out twice a year) and re-armed from the clock each time it fires: one wake-up a
day, not a poll. A background tab clamps it to roughly one a minute, which is
harmless — it fires late, and late is still after midnight — but a SUSPENDED
device is not running it at all, and a laptop closed at 23:00 and opened at
09:00 has no promise about when a timer armed for 00:00 arrives.
`visibilitychange` covers exactly that, and it is the trigger that matters: the
staleness costs nothing until somebody looks at the page, and looking at it is
the event. `ui/nudge.js` reaches the same conclusion from the same platform
facts. Both triggers ask the same predicate — has the local date moved off the
one `render()` drew for — so a timer that fires early or twice does nothing,
and a tab switch on the same day does nothing. That is also what makes this
right for a zone CHANGE: a laptop opened after a flight across the date line is
the same fact by a different route.

Pinned in `calcheck.mjs`, and the clock is moved with CDP
`Emulation.setTimezoneOverride` rather than a virtual clock or a `Date` stub.
It changes the renderer's zone, so `new Date()`'s local fields move — which is
what `todayISO()` reads and the question the page renders from. The two
extremes are 26 hours apart, so at least one of them is a different calendar
day whatever the machine's own date is, and the override is verified in the
page rather than assumed. The block asserts the strip's last column AND the
calendar's last editable cell, because fixing one card alone would move the
page from "one card is stale" to "one card jumps differently".

### ...and so is the dashboard, where the day is also a REQUEST

The same watch on the list, and it was left open above rather than missed: the
detail view's fix names the dashboard as having its own version of it.

The two are not the same defect, though, and the difference decides the shape.
A habit's own page fetches its entries UNWINDOWED, so after midnight it holds
every row it needs and is merely drawn wrong. The dashboard holds only the
fortnight it asked `/overview` for — the section at the top of this file — so
the new day's column is one the server has never been asked about. A local
redraw there does not just leave the figures answering yesterday, it draws a
column with no data behind it and paints any tap on it straight back out on the
next refetch. So `refreshIfDayChanged` calls `load()`, and the browser suite
asserts `state.gridLoaded.end` and not only the columns: a "fix" that repainted
would move the columns correctly and is exactly what that assertion refuses
(mutation-tested — `paint()` in place of `load()` reports
`{"columns":"2026-09-10","end":"2026-09-09"}`).

**The record is taken at the FETCH, not at the paint, and that is the other
difference.** On a habit's page a render is the only way a payload reaches the
screen, so `renderedDay` in `render()` says everything. `paint()` here is cheap
and runs with no request behind it — a search keystroke, a check-off's
optimistic repaint, a `'change'` — and it resolves `todayISO()` itself, so the
first keystroke after midnight walks the columns onto the new day. A record
taken there would then report the page as current for a window whose newest
column is empty, and the watch would never fire. `loadedDay` is read before the
request goes out and installed only if it succeeds, so a load spanning local
midnight records the day it ASKED for — the safe direction, since the watch
fires once more.

**It declines while another view is showing, and the detail view's declines
while the list is.** `load()` ends in `paint()`, which nulls
`state.openHabitId`, shows the list and unwinds the fragment, so firing it under
an open habit or the category comparison would navigate away from the page
somebody is reading, at midnight, with no gesture behind it. The two watches
therefore cover each other rather than duplicating work, and both are armed by
`init()` whichever view booted, because either view can be reached without a
reload. It costs nothing to decline: every road back to the list emits
`'reload'`, which lands in `load()`.

A PAGED grid is deliberately NOT refused here, where `app.js` refuses one for
the browser reminder. That refusal is about a window that could not contain
today whatever the answer said; this is about the figures on the row, which both
editions' `/overview` anchors on `summaryEnd = today` however far back `end`
reaches. `load()` re-sends `state.gridEnd`, so the window the user paged to
comes back unchanged with its summaries current.

**Restated rather than shared, and that is the `CACHE_VERSION` rule and not
laziness.** A `refreshIfDayChanged` / `armDayWatch` pair either module could
call would be a new export under `shared/public/`, which drops every installed
client's data cache — the same trade `showAmount` is declared three times for.
Six lines each.

Pinned in `gridcheck.mjs`, with `calcheck.mjs`'s instruments: `window.setTimeout`
wrapped from `Page.addScriptToEvaluateOnNewDocument` for the timer, and
`Emulation.setTimezoneOverride` for the date. Three things about that block are
worth knowing before changing it. It uses ONE page load for both triggers, which
`calcheck` could not — the probe is installed before the block's only navigation
— and the halves stay independently pinned because `visibilitychange` is
dispatched for the first only and the second invokes only callbacks recorded
before either zone move. The second move is BACKWARD, to the day the page
originally loaded on (the two extremes are 26 hours apart, so the other one is
always a different date), which is a flight west and is why the watch compares
the date rather than testing that it advanced — and it means the timer half
could pass having watched nothing if the `visibilitychange` half had failed, so
the page being stale again is asked as its own check and ANDed into the timer's.
And "a timer is armed for the next local midnight" is CONTEXT rather than the
biting check: `app.js` inits both views whichever is showing, so two watches arm
one each, and with the dashboard's `armDayWatch()` deleted that check still
passes on the detail view's. Every match is fired and the REBUILD is what bites,
because the detail view's callback returns at `state.openHabitId == null`.
Attributing a timer to a module by its position in the recorded list would be a
dependence on the order `app.js` inits its views, which no suite should be able
to break.

### A memoised formatter does not outlive the zone it was built for

Found while writing the midnight test, fixed after it: `ui/dates.js` memoised
each `Intl.DateTimeFormat` at module scope, and a formatter resolves its zone at
CONSTRUCTION. So a device that changes zone kept rendering every caption, range
readout and popover for the zone it had left, while everything derived from
`new Date()` beside them was right. Measured on a habit's page: a newest
editable calendar cell of `2026-09-10` under a readout saying
`6 Jul 2025 → 9 Sept 2026` — both ends a day behind, on one card.

**Where the check goes was the whole decision, and coverage decided it, not
cost.** The shape that suggests itself is a `forgetFormatters()` called from
`refreshIfDayChanged` — an explicit interface, and a partial fix wearing one:
ANY post-zone-change redraw already reached this defect, so paging the calendar
after landing in a new zone would go stale again with nothing to say why. The
midnight watch above merely added the first trigger that fires with no user act.
Putting the check at the USE covers every path by construction.

It also costs no `CACHE_VERSION` bump, and that is the rule NOT APPLYING rather
than being routed around: the stated hazard is a module link error from a stale
shell holding a new static import, and this adds no file and no export. A third
option — the export, reached by a dynamic `import()` so the link error is
impossible — was refused as exactly the routing-around the first two are not.

**The gate is the device's UTC offset**, compared against the offset the memo
was built under, via a generation counter (`clockNow` / `perClock`). A counter
and not a flag: several memos consult it, and a flag reset by the first reader
leaves every later one holding its stale value for the same move.
`getTimezoneOffset()` is a primitive read; `resolvedOptions().timeZone` was
declined because reading the zone NAME constructs an `Intl` object, which is the
thing being memoised, on a path asked once per calendar cell (~740 at the widest
zoom). Two imprecisions, both harmless and both written at the gate so nobody
tightens them away: it over-fires on a DST transition, where the offset moves
and the zone has not, rebuilding ~10 formatters twice a year for identical
output; and it under-fires between two zones sharing an offset, where nothing
these formatters produce would differ.

**Three memos hang off that one question, and the second one is why this was
not a one-line change.** The formatters, the weekday cache, and the REFERENCE
WEEK — seven `new Date(2026, 0, d)` built once at module load. Those are local
midnights, so they are instants fixed by the zone the device was in: rebuild the
formatter and keep the sample, and each renders as the PREVIOUS day. Measured
under Node, the same instant is `Sunday` to a formatter built at `Etc/GMT+12`
and `Monday` to one built at `Pacific/Kiritimati`. That is a rotation of every
weekday caption in the app — the defect `weekcheck.mjs` exists for — and it
would have been INTRODUCED by fixing the formatters alone.

Pinned in both places. `dates.test.js` moves `process.env.TZ`, which Node
re-reads on assignment, and is declared LAST in that file deliberately: the
defect is a memo outliving the move, so against unfixed code the stale
formatters leak into every test declared after it and three tests fail where one
is the finding. It asserts Sunday-first in BOTH zones, which is not belt and
braces — a sample frozen at module load was built in the RUNNER's zone, and
formatting it elsewhere only rotates when the offset delta crosses midnight, so
one zone leaves the reference-week half revertible with the suite green on some
machines. Measured: with one zone, that mutation passed. `calcheck.mjs` asserts
the range readout and the cells name the same day after the override, compared
against each other rather than against a literal, since the readout is `Intl`
prose in the runner's own locale and calendar.

Mutation results, and one of them is a gap stated rather than covered: reverting
the formatter memo fails one unit check (`actual: 'Jan 4, 2026'`) and the
browser check (`{"readout":"6 Jul 2025 → 9 Sept 2026","newest":"2026-09-10"}`);
reverting the reference week fails the unit check by name
(`after moving back west: index 1 does not name the day getDay() calls 1`);
reverting the weekday cache fails **nothing**, and cannot — the names are
zone-invariant while the sample and the formatter move together, because the
pair always describes seven consecutive local days from a Sunday and the words
come from the locale. It is kept per-clock anyway, as a cache keyed to its
inputs rather than to an argument about which of them happen to matter, and the
comment there says both halves.

The midnight block still reads dates out of `data-date` rather than off
`.cal-range`, and that is now a deliberate choice rather than a workaround in
force: a date is what it is asking for, and `data-date` is `todayISO()`'s own
spelling where the readout is prose.

The mutation is the visibility trigger doing nothing: two checks fail, with
both grids still ending on the day before while the clock says otherwise.

**The TIMER half is pinned too, and it needed no seam in the app.** The
obvious blockers are real: `Emulation.setTimezoneOverride` moves the date but
fires nothing and does not re-arm a `setTimeout` already pending, and no zone
can be asked for "a few seconds before midnight" — the available offsets are
quarter-hour steps, so the local SECONDS are whatever the real clock's are.
What works instead is wrapping `window.setTimeout` from a
`Page.addScriptToEvaluateOnNewDocument` script, exactly as `themesync.mjs`
wraps `window.fetch`, recording every long timer and invoking the recorded
callback at a chosen moment. It is the same function the platform would have
called; it adds no production surface; and an app that stopped arming a timer
fails the first check by name rather than leaving an exported hook nobody
calls. An exported `fireDayWatch` was the alternative and was refused twice
over — it is a new export under `shared/public/` and so a `CACHE_VERSION` bump,
and it is a seam that exists only for its test.

Three checks, and the middle one is the claim: a timer is armed for the next
local midnight; firing it — with no `visibilitychange` dispatched anywhere —
rebuilds the page for the new local day; and it re-arms for the next one,
recomputed. The expectation is built from the local clock FIELDS rather than by
calling `setHours(24, 0, 0, 0)`, which is the implementation's own expression,
and compared as an absolute instant (`at + ms`) so the seconds between arming
and reading cancel. Measured across the zone move, which is what makes the
re-arm assertion sharp: **39,407,853 ms armed in the real zone, 61,007,420 ms
after it**, each matching its own next local midnight to `off: 0`. A fixed
`+ 86400000`, or a reused delay, is ruled out by either number.

What that does NOT pin is a 23- or 25-hour day. The DST transition would have
to fall between now and the next midnight in a zone this suite can name, which
a run at an arbitrary moment cannot arrange; the hand-check stands for that
case (fall-back fires an hour early and no-ops on the date compare; spring
forward fires slightly late; `Math.max(1000, …)` covers a non-positive delta).
What IS pinned is the property the DST reasoning rests on — that the arming
targets local midnight rather than a fixed 24 hours.

The mutation is deleting `armDayWatch()` from `init()`: three checks fail by
name, printing `{"index":-1,...,"delays":[4000]}` — the app's only remaining
long timer — and the visibility checks above stay green, which is the two
triggers being independently pinned rather than one standing in for the other.
The firing is guarded on a timer having been found, for the reason `settled` in
the same file is bounded rather than a `waitUntil`: unguarded,
`window.__armed[-1].fn()` throws out of the try block and costs the remaining
checks their names, the `Emulation` override its reset, and the suite its exit
line. A regression must be a named FAIL, never a harness error.

### Edit, in the gap between a save and the refetch

`saveHabit` closes the dialog and then `announce()`s; from a habit's own page
that is `'change'`, which `ui/detail.js` answers with `/stats` and then
`/entries` and only then a `render()`. The head's Edit button CAPTURES the
habit it was drawn from, so in that gap pressing Edit opened the dialog on the
PRE-SAVE habit — and Save from there, because `PUT /habits/:id` REPLACES, wrote
the edit just made back out. Two ordinary presses, a silent revert.

The fix seeds the page synchronously from the save: `announce` passes the reply
on through `emit`, and the listener redraws from it before starting the
refetch, which is then a confirmation rather than the only source of truth.
Not a gate on the Edit button, and not a rework of how the view gets its data —
the same `render()`, over the same payload, with one field replaced.

**The seed is only sound if what overwrites it cannot be OLDER than it, and
that took a second line.** The `'change'` listener called `open()` directly;
it goes through `refresh` now, which is the guard that line was bypassing —
`refresh`'s own comment is this bug, in its own words: "a later-started reload
can finish first and leave OLDER data on screen". And the seed is what makes
two of them reachable, because the seed is what puts the stored habit in the
Edit box: a second save INSIDE the first refetch stopped being a race nobody
could win and became two ordinary presses. With two outstanding, `/stats` — the
heaviest computed route in the app — answers in whatever order it answers, and
if the FIRST reply lands last then `render()` draws the pre-second-save habit,
the Edit button re-captures it, and one more Edit-then-Save writes the second
save back out. Nothing refetches again to correct it, so the page STAYS wrong:
the loss this section is about, arriving after the gap instead of inside it.

`refresh` never runs two, and `refreshAgain` remembers the one that arrived
mid-flight, so the LAST request is always issued after the last write. Be
precise about what that does and does not buy: a stale reply can still RENDER
on its way past — it is an answered request and the page draws what it is
given — but a newer request is already promised behind it. The difference is
between a page that flickers and a page that stays wrong. Closing the flicker
too would mean discarding a reply issued before the last seed, which is a
generation counter on the payload and a different change; it is not needed for
the loss, because the loss needs the page to SETTLE stale.

Neither reviewer reached this and neither could have from the diff alone: the
line is pre-existing, and it only becomes reachable once the seed makes the
second save possible.

**The seed is what the SERVER accepted, never the form.** `parseHabit`
normalises as well as validates, so the reply is the truth; `staysOnList` on
the line above already asks the reply for the same reason.

**And it is merged over the habit the page was built with rather than assigned
wholesale.** `stats.habit` carries `unlogged_is_success`, which `/stats`
resolves per request and which `PUT /habits/:id` does not answer with — it is
response-only, in no `*_HABIT_FIELDS` list. Assigning the reply would drop it,
and a limit whose unlogged days count as kept would lose its ghost ticks and
its faint calendar fills for the length of the refetch. Merged, every field the
write answered wins and the one it cannot speak for keeps the server's last
answer, stale for one round trip if the edit changed `type`, `target_type` or
`at_most_unlogged` — the same staleness every server-computed figure on this
page already has after an optimistic tap.

**`emit` gained a payload, and it stays a hand-off rather than becoming a
second channel.** It is the thing the mutator already HAS, nothing is stored,
and every listener has to be right when it is absent, because most emitters
send nothing. The alternative was a field on `state`, which would be a second
source of truth for the habit outliving the emit that carried it.

The dashboard path is unaffected and was checked: `announce()` emits `'reload'`
when the dashboard is showing, which is a refetch of the list, and the payload
goes unread there.

Pinned in `countcheck.mjs`, which is where #305's flake was the suite noticing
this window. The gap is milliseconds on a healthy machine, so it is HELD OPEN
with CDP `Fetch` pausing `/stats` and never continuing it (`hangcheck.mjs`'s
mechanism), with the worker bypassed so `networkFirst` cannot answer out of
`DATA_CACHE`. The guard that makes the block mean anything is a resource-timing
count of zero landed `/stats` responses: had the refetch arrived, the page
would be right for a reason this block is not about. The mutation — dropping
the `seed` call — fails two checks, both printing the pre-save target.

**The ordering half has its own block, and the instrument had to change to
`requestStage: 'Response'` — which is the only interesting thing about it.**
Paused at the Request stage, which is right for the block above (there the
point is that the request never arrives), the server has not seen the request
yet, so releasing it after the second write answers from the database as it
stands and the held reply is FRESH. Measured: with a request-stage pause the
block passed against the unfixed code, reporting two refetches outstanding and
a correct head — a test that could not fail, and one whose output looked like
evidence. Paused at the Response stage the reply has already been computed, so
the held answer is the one computed BEFORE the second save. Both replies are
then released newest-first, one at a time and each DRAWN before the next is let
go, which forces the worst legal interleaving rather than hoping for it — see
`docs/decisions/testing.md` for the flake that taught the block the difference
between a reply landing and a render happening. `outstanding` is reported beside
the answer, because it is 2 under `open()` and 1 under `refresh` and that is the
clearest single line about what changed. Reverting the one word fails two
checks:

    FAIL  the page settles on the LAST save even when the older refetch answers
          after it :: {"head":"Every day · ≥ 12.5 pages","stored":9.5,
          "statsLanded":2} (2 refetch(es) were outstanding, 2 released, 2 drawn)
    FAIL  ...so Edit-then-Save from here cannot revert the second one :: "12.5"
          (a revert reads as "12.5")

— the head naming the first save while storage holds the second, and the
reopened Edit box primed to write the first one back.

### The flicker, looked at again and declined again — for a different reason

The paragraph above records the residual and calls it cosmetic: a reply issued
before the last seed still RENDERS on its way past, and only a newer request
being promised behind it stops the page settling wrong. The generation counter
that would discard it was written down rather than taken. Revisited
deliberately, two things came out of it, and neither is the reason it was
declined the first time.

**It is a little more than a flicker.** `render(staleStats)` redraws the head,
and the head's Edit button captures the habit it was drawn from — so between
the stale render and the refetch `refreshAgain` has already promised, the Edit
button is holding the pre-second-save habit AGAIN. That is exactly the revert
this whole section exists to close, on a window one round trip long instead of
two, and reachable only after two saves inside one refetch rather than after
one save. Strictly rarer, and not a different KIND of defect. Say it that way
round: "cosmetic" is what the first reading claimed, and the claim was too
strong.

**And the counter as specified would close the cheap half and make the
expensive half look closed.** "A reply issued before the last seed" is scoped
to this listener, and this listener is the one path already serialised —
`refresh` never has two `open()`s in flight. What is NOT serialised is every
other caller of `open()`, and there are **eight**, counted off the source
rather than remembered: `changeZoom`; three segmented controls
(`state.scoreGranularity` on the strength card, `state.granularity` and
`state.historyMode` on History); and four cards whose `windowedChart` `redraw`
refetches — score, history, weekday-by-month and frequency.

Exactly one of the eight can settle the page WRONG, and saying which is the
point of counting them. `open()` parameterises its request with
`historyGranularity()` alone, so seven of the eight send the identical url and
render from the same payload against whatever state is current when they land —
an out-of-order reply there costs a redundant render and nothing else. History's
granularity control is the exception: its two presses issue `?granularity=week`
then `?granularity=month`, and the older reply landing last draws week buckets
under a control that reads month, with nothing behind it to correct the page.
That is a SETTLE, not a flicker, and it predates all of this — `refresh`'s own
comment names "two fast presses on the History card's ‹ Earlier" as the hazard
it was written for, and then the fix was applied to one caller.

So the honest change is one ticket on `open()` itself — issue a number, install
the render only while it is still the newest — which is the
`state.categoryReadSeq` shape `shared/public/CLAUDE.md` already documents at
length for `state.categories`, down to the rule for what has to take one. It is
not a rename of that mechanism, because `open()` answers a BOOLEAN that is load
bearing: `app.js`'s boot does `if (!await detail.open(opening.id)) await
dashboard.load()`, and a superseded reply has no honest answer between the two
— `true` claims a render that did not happen, `false` can send a boot that is
fine to the dashboard. A third state, or a caller that stops asking. Either is
a change to how this view is entered, with its own test proving a stale reply
is DISCARDED rather than merely overtaken — which is a different assertion from
the ordering block above, where the page is allowed to flicker and only its
final state is judged.

### A third option: a sticky seed, and why it is a candidate rather than the fix

Raised in review and worth recording with its rebuttal, because it is the
cheapest-looking of the three and touches neither `open()`'s return nor
`refresh`. `seed` already holds the newest habit; remember it, and have
`render()` overlay it whenever the ids match. No reply is discarded, no boolean
is redefined, and the Edit-button revert above closes — the head and the button
drawn with it hold the saved habit even while a stale payload is being drawn
under them. It is not even a new SHAPE: `seed` already renders
`{...lastStats, habit: {...lastStats.habit, ...saved}}`, so the page is already
a blend of two payloads by design, and this only makes that blend outlive the
one render.

**The whole of it is the clearing rule, and that is the question it shares with
the counter rather than escapes.** Two answers are reachable and each fails:

- Clear on navigation (or not at all). Then the overlay outlives the server's
  truth: rename the habit on the phone, and this page's next refetch — the
  midnight watch, a tap's `host.refresh()`, a `'change'` from anywhere — draws
  the server's new name and puts the local one back over it, indefinitely.
  That converts a transient flicker into a silent permanent wrong value, which
  is the exact trade this whole section is written to refuse, arriving through
  the fix for it.
- Clear when a render arrives from a request issued after the seed. That is
  correct, and it is a generation comparison — the counter, relocated onto the
  habit object and not otherwise different.

**And it cannot reach the settle at all.** The overlay is about the habit's
FIELDS; nothing in it can say which `/stats` payload should win, so History's
granularity still settles the page on week buckets under a control reading
month. Taking it would close the alarming-but-transient half and leave the
quiet-but-permanent half untouched, which is the wrong half to close first —
and a page whose head is visibly correct is a page nobody then looks at the
chart under.

So: still declined, and the overlay belongs IN the issue as a candidate
implementation rather than beside it as a rider. Whichever is built, the test
is the same one and it is not the ordering block's: hold a `/stats` open at the
Response stage, save twice, release the older reply LAST, and assert the Edit
box holds the newest habit at the moment the stale render lands — not merely
after the refetch behind it has settled.

### The ticket, as built

The counter, not the overlay, and on `open()` rather than on the seed:
`openSeq` (`ui/detail.js`) is taken before the two round trips and compared
immediately before `render()`. `seed` bumps it, which is the half a reader
looking only at the settle would not think to check — `refresh` COALESCES a
second save into the refetch already in flight, so no newer request takes a
ticket to supersede the reply the first save issued, and without the bump the
one-round-trip revert above survives every version of this fix.

`load()` (`ui/dashboard.js`) had the same defect and takes its own, `loadSeq`,
over `habits`, `categorySummaries`, `gridLoaded` and `loadedDay` — the fields
`state.categoryReadSeq`'s own note leaves unticketed on the grounds that no
category writer can be newer than the reply. True of a category writer, untrue
of a second `load()`: two presses of the grid's ‹ are two `/overview`s for
windows that do not overlap, and the older landing last installed its habits
under columns `paint()` draws from the current `state.gridEnd`. Measured
against the unfixed code with both replies held at the Response stage and the
older released last: 33 answered cells of 40 became 14, under an unchanged
range label.

**Three counters, one mechanism, and they may not be merged.**
`categoryReadSeq` is bumped by `refreshCategoryPicker`, `moveCategory`'s splice
and the queued DELETE's optimistic removal — three writers that say nothing
about a habit's stats or the dashboard's grid — so sharing it would let a
habit-dialog open discard a `/stats` reply or a dashboard load. The two new
ones live at module scope in the files that write them, which is
`categoryReadSeq`'s own placement rule applied the other way round: it is on
`state` because its field has writers in two modules and no owner.

**What a discarded reply returns.** `open()`'s boolean was NARROWED rather than
given a third state: it reports whether the habit answered, so `false` means
only that the request failed. That is exactly what its one reader asks —
`app.js`'s boot falls back to the list for a deep link naming a habit that will
not open — and a discard is not that, because whatever superseded the call owns
the screen. A third value was weighed and buys that reader nothing: neither
`!== 'rendered'` (paint the list over the newer open) nor `=== 'failed'`
(identical to what shipped) is a better answer, and it would leave `detail.open`
and `categories.open`, the two adjacent lines of that boot, answering one
question in two shapes. Note the values the function can actually return did
not move — the old code answered `false` in the `catch` and `true` everywhere
else — so a shell serving one version of `detail.js` over a cached `app.js`
behaves the same either way round. `load()` needed none of this: no caller
reads its result. Its superseded reply still `paint()`s, because a paint reads
current state and can only re-confirm what is there — the rule
`shared/public/CLAUDE.md` already states for a superseded category read.

**Three checks, and each fails against a different mutation.** In
`countcheck.mjs`, the two-saves block now asserts what each render DREW rather
than only how the page settled: with the ticket removed it prints
`drew ["Every day · ≥ 12.5 pages","Every day · ≥ 9.5 pages"] after the seed`,
and with only `seed`'s bump removed it prints the same thing — which is what
establishes that half as load bearing. A third block presses History's
granularity twice inside one round trip and releases the older reply last;
unfixed it reports `control reads "day" over ["2026: 59/60 (98%)"]`. In
`paging.mjs`, the load block is the 33 → 14 measurement above.

That block's drain loop had to change shape, and the change is the ticket's own
signature: it used to release one reply and wait for the redraw it caused
before releasing the next, which stalls the moment a reply is discarded rather
than drawn — measured, it spent its whole deadline with the coalesced re-run
still paused and reported `0 render(s) after the seed`. It stops on QUIET
instead: three consecutive polls with nothing held. The quiet period is what
keeps the mutation from passing, since the re-run is issued in `refresh`'s own
`finally` milliseconds after the release and a loop stopping at the first empty
`paused` would count one render in either world.

## The label-width estimator's mark-billing fix, and what it forced (#132)

`estimateTextWidth` and `WIDTH_SAFETY` (`shared/public/ui/dates.js`) are #131's
own work: a per-character rate table plus a measured safety margin, so a chart
can reserve a gutter for a label it has no DOM to measure. #132 found one more
way that estimator was wrong, fixed it, and had to re-derive the margin because
of it — recorded here so the dependency between the two is not re-found by
someone reading only one of the two files.

**The bug was a double penalty on a combining mark, not the rate choice.**
`solid` (the code points that are not marks) was already used to CHOOSE
between the `LONE` and `JOINED` rate tables — that part was right — but the
summing loop still walked every code point, so a mark was billed at its own
rate ON TOP of the base glyph it rides on. A 3-code-point, 2-rendered-cluster
Devanagari word (`बुध`, "Wednesday") came out wider than a 3-glyph English one
(`Wed`) for two glyphs against three. The fix sums over `solid` — the same
filter, used once — so a mark costs nothing beyond the cluster it rides on,
matching what the function's own doc comment already claimed ("reads as a lone
glyph however many code points it takes").

**This made some estimates SMALLER, which is the dangerous direction**, so
`WIDTH_SAFETY` needed re-measuring rather than inheriting — decision 2 in the
issue, and the reason Step 1 of it was a measurement harness built BEFORE any
behaviour changed. `shared/test/label-widths.mjs` renders every label
`charts.js` draws, at the six font sizes it uses, in a real Chrome, and
compares `estimateTextWidth` against `getComputedTextLength()`. Re-run after
the fix, across the ten `locales.mjs` locales plus **seven** added for #132:
five for scripts that stack a combining vowel sign on a base consonant
(`ml-IN`, `ta-IN`, `te-IN`, `kn-IN`, `gu-IN`), since none of the original ten's
weekday/month/range labels carries a mark at all and that sweep alone could
not have seen the case the fix is about; `he-IL` for breadth — its CLDR
weekday/month names carry no niqqud either, so it exercises right-to-left and
a distinct script rather than a mark; and `el-GR`, added after review, below.

Review found **el-GR `Μαρ` at 1.23x**, which was the worst case at the time and
left 1.6% of headroom (**superseded by #286 below** — `Μαρ` is not an
under-estimate at all now, and the title has gone back to Arabic). It has
nothing to do with marks — Greek has no class in `classOf`
at all, so it falls through to the generic `other` rate — and it is
pre-existing, but it is what the sixteen could not see, exactly as the original
ten could not see Malayalam. Filed as **#286**. The lesson is the one this
section is already about: a sweep answers for the locales in it, and the number
it produces is only ever a lower bound on the worst case.

It was found by extending the harness's locale list by hand and NOT committing
the extension, which made the governing figure the one thing the committed
instrument could not reproduce — `el-GR` is in `LOCALES` now, and re-running
the harness reproduced 1.23x at that commit (**superseded by #286 below**: on
the tree with the Greek class it reports el-GR at 1.03x).

**On Arabic, because two records disagree and only one can be current.**
Master's `WIDTH_SAFETY` comment names 1.23x — Arabic `أغسطس` — as its worst
case. This harness measures the same string at **1.19x**, and the estimate for
it is byte-identical before and after this change (`أغسطس` carries no
combining mark, so nothing here could have moved it). So the two figures are
two INSTRUMENTS, not two states of the code, and master's is the one retired:
it came from a 67-locale corpus that no longer exists in the tree and cannot be
re-run. Every ratio recorded now is this harness's — including the 1.23x above,
which at this commit is Greek and not Arabic (**superseded by #286 below**,
after which the two records name the same STRING and differ only in its figure:
master's corpus said Arabic `أغسطس` at 1.23x and this harness says 1.19x). If
the older sweep read systematically high, it read high for Greek too.

**Review also found the sweep was not measuring the labels `formatStamp`
produces**, which are the widest strings the estimator is ever handed
(`26 de dez. de 2026`, `أغسطس ٢٠٢٦`, `2026 ജൂൺ 15`) and which reach two live
call sites — `historyChart`'s axis budget (`charts.js:1177`, which applies no
`WIDTH_SAFETY` at all, because it decides how many labels to DROP) and
`frequencyChart`'s row gutter (`:1450`). They are in the harness now. Adding
them moved `ml-IN`'s own worst case to `2026 ജൂൺ` at 1.07x and left the
overall worst where it was.

The current figures live in the comment above `WIDTH_SAFETY` itself, which is
the one that must be updated (with a fresh harness run) if the rates or the
sum ever change again.

**The fix is only safe because of a rate change that shipped separately,
first — #131's own recalibration of `LONE.indic` from a value near 1.0 up to
1.7.** The mark-billing bug being removed here is what the ORIGINAL indic rate
needed covering for: at the old, lower rate, freeing the mark made Malayalam
`ബു` (the case a deleted regression test named directly) under-estimate badly
— 11.0px estimated against an 18.0px real render. Re-billing the mark was a
workaround for an under-calibrated base rate, not a property of marks
themselves, and it is only correct to remove now because the base rate it was
compensating for has already been fixed. Raw margin at the tightest case this
sweep found (`ബു` at font-size 11) is 3.7% before `WIDTH_SAFETY` is even
applied — thin, but real, and `WIDTH_SAFETY`'s own 1.25 sits on top of it. Do
not remove the mark-billing fix without re-checking this dependency, and do
not lower `LONE.indic` again without re-checking this fix.

**Two behaviours named in the issue's own "not a bug" section are recorded at
the code, not fixed, because neither is reachable from anywhere the app
calls them:** `formatDayRange` throwing a `RangeError` when handed an invalid
`Date`, and `formatStamp('2026-13')` formatting as January 2027 (`Date`'s own
month-rollover, since `new Date(yyyy, 13 - 1, 15)` is month index 12). Every
caller of both builds its `Date`/stamp from data this app already validated —
`BUCKETERS` in `stats.js` never emits a month outside `01`–`12`, and
`fromISOLocal` is only ever handed a string that passed `assertDate` or a
device clock read — so there is no path through the API that reaches either
input. See the comments at the two functions themselves.

**`formatRange`'s ja-JP/zh-CN mismatch between the dashboard's range label and
the day dialog's long date stays as it is — Mark's decision, not an oversight
left for later.** Both are `Intl`'s own answer, correctly asked with each
surface's own granularity (a two-ended RANGE versus a single LONG date), and
they legitimately format a shared day differently in those two locales because
the two calls ask different questions. Overriding one to match the other means
hand-picking a format for languages neither of us reads, which is exactly the
kind of hardcoded table `formatDayRange` exists to avoid needing. See the
comment at `formatDayRange` in `dates.js` for the specific strings compared.

## Greek had no script class, and what giving it one costs (#286)

The section above filed #286 and named the figure it was filed on: el-GR `Μαρ`
at 1.23x, the worst under-estimate the harness could find, and the reason the
1.25 margin had 1.6% of headroom left. This is what happened when it was
picked up, and it is here because the root `CLAUDE.md` tells a reader to read
the archive before re-opening a decision — and until this section existed, the
archive's only statement about Greek was the retired figure.

**The defect was a missing class, not a wrong rate.** `classOf`
(`shared/public/ui/dates.js`) tests the scripts in range order and Greek and
Coptic (U+0370–U+03FF) sits BELOW `SEMITIC`'s U+0590 and above every other
script test, so every Greek code point fell through all of them to the generic
`other` rate — 0.58 joined, calibrated for Latin lowercase. Nothing was
mis-measured; there was simply nothing to measure. A `GREEK` class now sits
immediately above `SEMITIC`, tested first for exactly that reason, and the
`classOf` comment says so at the line.

**The rates were measured, and the rule for choosing them is the opposite of
the one a reservation would use.** `JOINED.greek = 0.72`, `LONE.greek = 0.8`,
against `getComputedTextLength()` over the whole block at the six font sizes
`charts.js` uses. A first draft used 0.74 on the reasoning that unknowns are
billed high — right for a RESERVATION, where `WIDTH_SAFETY` goes on top
anyway, and wrong here, because three call sites read the estimate raw and
DEGRADE on it. The number is therefore the smallest round rate that covers the
widest label the estimator is actually handed: `Μαρ` measures 0.711 per glyph
and 0.72 covers it, so `Μαρ` at 9.5px is now a real 20.25px against a 20.52px
estimate — not an under-estimate at all, where before the fix it estimated
16.53px.

**The worst case went back to Arabic and el-GR's own is now ASCII.** The
committed harness (`shared/test/label-widths.mjs`, `el-GR` in `LOCALES`)
reports 1.19x — Arabic `أغسطس` at 8px, real 29.4 against an estimate of 24.8 —
as the worst under-estimate of any locale it sweeps, and el-GR's own worst at
**1.03x**, which is `28/1/2026 – 3/2/2026`: the same ASCII date range that is
already the worst case in eight other locales. The cost is on the over-estimate
side and was priced deliberately: el-GR's worst over-estimate rises to 1.50x,
`Τρί` at 11.5px.

**A wider estimate degrades as well as reserves, and the first attempt to
price that got it wrong in a way worth recording.** The three call sites that
apply no `WIDTH_SAFETY` — `historyChart`'s caption stride, `weekdayChart`'s
`fits`, `streakChart`'s format-and-shrink — all read the estimate raw, so a
rate that covers `Μαρ` buys coverage by throwing labels away. The first
version of the figures was derived by transcribing those three charts'
arithmetic out of prose into a script, and two of the three formulas came out
wrong: `historyChart` divides `width - 46` and not `width`, and `streakChart`'s
`LABEL_W` is a floor-and-ceiling expression rather than the fixed 168 it was
read as. The published claims — "6 captions where 12 fitted at 700px", "gives
up the wordy label at a 328px card, `28 Δεκ 2025 – 4 Ιαν 2026`" — named a
width and a string at which nothing happens. Re-derived by importing the real
`historyChart`, `weekdayChart` and `streakChart`, driving them against the same
~15-line fake DOM `shared/test/browser/rendercheck.mjs` builds, and counting
the `<text>` nodes each actually emits, under `LC_ALL=el_GR.UTF-8`, with
"before" a whole copy of `shared/public/` carrying `JOINED.greek = 0.58`:

- `historyChart` loses captions in one band per bucket count, wherever
  `floor((width - 46) / (widest + 10))` crosses. The widest axis estimate at
  9.5px moves 47.69px → 53.01px, both from `Ιουν 2026` — the four-letter month
  abbreviation is what does the damage in Greek. Measured over 320–1440px: 12
  buckets go 12 → 6 at 739–802px and 6 → 4 at 393–424px, 16 go 16 → 8 at
  970–1054px, 10 go 5 → 4 at 335–361px. It is pure loss rather than a trade —
  the widest real label is `Μαρ 2026` at 44.45px against the old 57.7px
  budget, so that axis was not overlapping — and it is unavoidable at any rate
  covering `Μαρ`: swept rate by rate against the real chart, holding those
  bands needs 0.580, 0.670, 0.700 and 0.710 respectively.
- `streakChart` gives up the wordy range label for the numeric one at every
  card width from 320 to 373px, which includes 328 and 360, for one label
  shape: a cross-year range with a four-letter month at BOTH ends,
  `28 Ιουν 2025 – 4 Ιουλ 2026`. It estimates 165.72px against a 160px budget
  where the words really measure 142.84px. `labelSize` never moves.
- `weekdayChart` does not move at any width the app draws. Its crossover from
  the short names to the narrow ones goes from a 19.14px column to a 23.76px
  one, and the real widest short name is `Παρ` at 21.50px — so on paper the
  fix stops a clipped axis between 19.1 and 21.5px of column and becomes
  pessimistic between 21.5 and 23.8px. Both bands need a 180–212px chart, and
  `chartWidth` is `Math.max(320, cardInnerWidth(host))` (`ui/detail.js:492`),
  whose column is 39.1px. The first version of the record presented the
  clipping band as a defect this fixes; it is not one any reader could have
  seen.

Neither loss is fixed here. The fix for both is a stride that measures the
label it is about to drop, which is **#285** and wants a decision rather than a
number — no single per-character rate spans this script's own 0.480 (`Τρί`) to
0.711 (`Μαρ`).

**Two spans are deliberately left outside the class, and one of them is a gap
this issue did not close.** Greek Extended (polytonic, U+1F00–U+1FFF) stays on
`other`: its widest per-glyph rate in a uniform run is 1.138 (Ἧ, U+1F2F)
against the base block's 0.907, so rating it at greek's 0.72 would
under-estimate a polytonic glyph 1.58x — outside `WIDTH_SAFETY`, a worse defect
than the one being fixed — while rating the class for polytonic would
over-estimate real modern-Greek words by 1.60x to 2.37x. On `other` it
under-estimates 1.96x, pre-existing and reached by no locale in the sweep, el-GR
CLDR being monotonic. **Cyrillic (U+0400–U+04FF) has no class either**, for
exactly the reason Greek had none, and it is a live gap rather than a considered
exclusion (**superseded — fixed in the section below**): measured against real
CLDR labels, mn-MN `Ням` is 1.201x, kk-KZ
`мам.` 1.187x, ru-RU `май` 1.118x, mk-MK `мар.` 1.106x, and the narrow weekday
`Ш` — CLDR's narrow form for several Cyrillic locales — is 1.295x against
`LONE.other`, outside the margin, though no reachable call site was found where
it clips. **Three of those four figures are not reproducible and the section
below says why** — mn-MN, kk-KZ and mk-MK have no CLDR weekday or month data in
this Chrome build; `Ш` and `май` are the two that stand.
`LOCALES` contains no Cyrillic locale at all, so the 1.19x headline is
the worst case of the SWEEP and a lower bound on the app's. Left open on
purpose: a `CYRILLIC` class is the same kind of change this one is, wants its
own measurement of what it moves at the three degrade sites, and would move the
headline number — so it is a separate decision and not something to fold into
Greek's. (It did not move the headline. See below.)

**What the review round found, since the pattern is the point of this file.**
Every figure that had to be corrected came from an instrument standing in for a
measurement. The caption claims came from re-implementing `charts.js` instead of
running it. The per-glyph maxima (0.737 for the block, 0.717 for the Coptic
tail, 1.102 for Greek Extended) came from four-letter runs of *differing*
letters, which makes them the max of a per-run AVERAGE — measured as a uniform
run they are 0.907, 0.892 and 1.138, a third higher at the top of the range,
and the Coptic figure went from comfortable to 1.24x against 0.72. `Ιουν`'s
"0.472" was the label `Ιουν 2026`'s real width with this file's own ESTIMATE
rates for the space and the digits subtracted back out — the estimator was one
of the two instruments. It measures 0.510 when measured. The lesson matches the
`#132` section's: the number a sweep produces is a lower bound on the worst
case, and the number a re-implementation produces is not a measurement at all.

## Cyrillic had no class either, and its two rates are two measurements (#294's finding)

The `#286` section above left this open by name and predicted three things about
picking it up: that it would be the same kind of change, that it would need its
own measurement of what it moves at the degrade sites, and that it would move
the headline number. The first two were right. **The third was wrong — the
headline did not move.**

**The defect was the same missing-class shape, one block over and worse.**
`classOf` tested seven script spans and Cyrillic (U+0400–U+04FF) was in none of
them: `SEMITIC` starts at U+0590, `BROAD` covers Armenian and Georgian but not
this, and `UPPER` is ASCII-only. Unlike Greek there was no precedence subtlety
to get right — no span in the list overlaps U+0400–U+04FF at all, which is
exactly why it fell through — so the new branch sits beside `GREEK` for
readability and its comment says the placement is free.

**The interesting part is that Cyrillic needed TWO different rates, and the
existing two-table design already had the shape for it.** CLDR's Cyrillic month
and weekday *words* are lowercase and narrow; its narrow weekday is a single
*capital* and wide. Measured per glyph over every label the harness draws, in
the five Cyrillic locales this Chrome has data for: the widest real word is
uz-Cyrl-UZ `шан` at **0.6885** and the widest real lone glyph is `Ш` at
**1.0362** — a 1.51x spread *between the tables* inside one script. So
`JOINED.cyrillic = 0.70` and `LONE.cyrillic = 1.05` are not one number raised
twice; `LONE`/`JOINED` is doing precisely the job it was built for. Greek's own
1.48x spread (`Τρί` 0.480 to `Μαρ` 0.711) is a spread *within* the joined table,
which no single rate can absorb; this one falls on the seam between the two
tables, which is why it can be.

**`LONE.cyrillic` departs from `#286`'s reasoning, deliberately, and the
departure is a measurement rather than a preference.** Greek held `LONE.greek`
at `other`'s 0.8 on two grounds: that raising it would worsen every degrade
decision, and that no CLDR label produced an under-estimate needing it. Both are
false here. `Ш` **is** a CLDR label — the narrow weekday in six Cyrillic
locales — and at `LONE.other`'s 0.8 it under-estimated **1.296x**, *outside*
`WIDTH_SAFETY`: the only figure in that file that was not merely thin but
uncovered. And the degrade cost was measured at **zero**: driving the real
`historyChart`, `weekdayChart`, `streakChart` and `weekdayMonthChart` at every
width from 320 to 1440 with `JOINED` held at the old 0.58 and `LONE` at 1.05
reproduces the unfixed tree's output exactly, chart for chart and width for
width. Every caption the change costs is `JOINED`'s. That isolation run is what
makes this a decision rather than a guess, and it is the run to repeat before
anyone "simplifies" the entry back to 0.8.

**`JOINED = 0.70` is one hundredth above the rule, and the extra hundredth has
a price in captions.** `#286`'s rule is "the smallest round rate covering the
widest real label", which here is 0.69 — and 0.69 covers `шан` by **0.2%**,
which is inside the variance of the font stack itself: `system-ui` is not the
same font on two platforms and every figure in these records is one Chrome
build's. The price was measured rather than waved away: 0.70 rather than 0.69
costs one month caption at 420px on `weekdayMonthChart` (11 → 10) and one pixel
of `streakChart`'s wordy-label crossover (403 → 404px), and nothing else at any
width. Both numbers are in the `WIDTH_SAFETY` comment so nobody has to re-derive
them to re-open the question.

**The span was decided per block, and every extension failed the test `#286`
applied to Coptic.** That test is: is the block's widest glyph, as a uniform
three-glyph run, inside `WIDTH_SAFETY` against the class rate? Coptic passed at
1.24x and stayed in `GREEK`; Greek Extended failed at 1.58x and was excluded.
Here only the base block passes — Supplement's widest is 2.01x the class rate,
Extended-B's 1.92x, Extended-C's 1.28x (outside, and only just, which is what
made this a measurement rather than a judgement). Two blocks were excluded for
reasons that are *not* about width, and they are worth keeping because a reader
scanning for ratios would mis-read both: **Extended-A is 32 combining marks and
nothing else**, so a branch covering it would be dead code under `COMBINING`;
and **Extended-D has no glyph coverage in this font stack at all** — every one
of its 96 code points measures 0.6003, the .notdef box, indistinguishable from
the 33 unassigned ones beside it. There is nothing there to rate.

The base block's own widest glyph is far outside the margin — Ѹ (U+0478), the
digraph capital uk, at 1.743x — and that is stated plainly rather than smoothed
over, on the same argument Greek's 1.26x rests on: nothing hands the estimator a
uniform run of a block's widest letter, because the arguments are CLDR words
whose rate is the mean over their letters. Of the block's 256 code points only
**39** appear in any label measured across all five Cyrillic locales this Chrome
has CLDR data for — a wider set than the two the sweep commits, since the in-use
census is the argument and two locales would understate it. They span
U+0412–U+0459, and their own widest is the capital Ш at 1.0351, a glyph that only
ever arrives alone, where `LONE` covers it. Its lowercase ш is 0.8942 and does
arrive inside words, but a word's rate is the mean over its letters and `шан`
measures 0.6885.

**The block holds seven combining marks and Greek's held none, so this one
needed a test Greek did not.** U+0483–U+0489 are `\p{Mn}`, inert only because
`COMBINING` is tested *first* in `classOf`, ahead of every script test. That is
an ORDER property, not a rate, and no rate assertion implies it — so it has its
own test, which fails `10.5 !== 5` when `COMBINING` is moved below `CYRILLIC`.

### Two instruments again, and this time the older one is partly retired

`#294` recorded four Cyrillic figures. **mn-MN `Ням` at 1.201x, kk-KZ `мам.` at
1.187x and mk-MK `мар.` at 1.106x cannot be reproduced.** All three resolve to
the tag they are asked for in this Chrome build and then format every weekday
and month in the ASCII root pattern — `Mon`, `Jan` — which is exactly the
`ne-NP` failure mode `label-widths.mjs`'s third field was added to catch.
Sixteen Cyrillic tags were swept and **five** have CLDR data here: ru, uk, bg,
sr-Cyrl, uz-Cyrl. Node's own full-ICU build *does* have those labels, so those
three figures came from a mixed instrument — Node's label strings measured
against Chrome's renderer — which is the same defect this file records twice
already, and the reason the committed sweep carries only locales it can actually
measure. What `#294` got exactly right is the one that governed: `Ш` at 1.296x,
independently reproduced here, and reported by the harness itself as 1.30x.

**There was also a contradiction to resolve before any of this could be
measured, and it resolved as two instruments rather than an error.** `#294` says
"the harness sweeps no Cyrillic locale" while **issue #285's caption-count table
lists ru-RU at 390px among its measured locales**. Both are true and they
describe different instruments: the first is `label-widths.mjs` (committed, 17
tags, no Cyrillic, width ratios); the second is the hand-run caption counter
#285 describes in its own words as run by hand and never committed, whose locale
list included ru-RU, ko-KR and si-LK — none of which is in any committed list,
and none of which was ever deleted from the tree, because it was never in it.
Checked against git history: no instrument with a wider locale list has ever
been committed and removed.

That is a **harness gap as well as a rate gap**, and it is the transferable
finding: a script can be exercised by one instrument, at one width, in a table
somebody read and acted on, and still be invisible to the instrument that
governs the margin. ru-RU had been *measured* — just not for width. The two
sweeps now overlap on Cyrillic; they still do not overlap on ko-KR or si-LK.

### What it moves — reported, not fixed, and #285 is still the fix

Measured by importing the real charts and counting the `<text>` nodes they emit
against `rendercheck.mjs`'s fake DOM, at every width from 320 to 1440, with the
locale pinned by patching `Intl` before import — `LC_ALL` cannot express
uz-Cyrl-UZ at all (`uz_UZ@cyrillic` maps to the invalid tag `uz-UZ-cyrillic` and
Node falls back to Latin).

**The first version of this rig was wrong, in the way this file keeps
recording.** `historyChart` keys its bucket labels on `bucket`; the rig used
`label`, so every axis caption was `undefined`, the count was zero at every
width, and it reported "no change" for a reason that had nothing to do with the
rates. It was caught by an isolation run printing `0/0` — not by review, and not
by anything in the output that looked wrong. A caption count of zero is a
plausible-looking number.

- ⚠ `historyChart` loses captions, one band per bucket count. ru-RU: 12 → 6 at
  896–963px, 6 → 4 at 471–504px, 16 → 8 at 1179–1269px, 10 → 5 at 754–810px,
  4 → 3 at 330–351px (the phone). uz-Cyrl-UZ, whose month abbreviations are
  shorter: 12 → 6 at 701–741px, 16 → 8 at 919–973px.
- ⚠ `weekdayMonthChart` — **#285's own chart** — loses the most. ru-RU, 12
  months: 12 → 7 at 382–395px, → 8 at 396–409px, → 10 at 410–421px, → 11 at
  422–435px, and below 382px the counts collapse to 6. **At 390px that is
  12 → 7**, and 390px in ru-RU is the exact cell of #285's own table, which
  records the greedy walk drawing 12 there — reproduced by this rig before the
  change, which is two instruments agreeing on one number.
- ⚠ `streakChart` gives up the wordy range label over **384–403px in ru-RU**
  (20 widths, 390px inside it), crossover 384 → 404px, for a cross-year range.
  Below 384px it was already numeric, so 328 and 360 do not move, and
  `labelSize` never moves. uz-Cyrl-UZ does not move at any width.
- ✅ `weekdayChart` does not move at any width in either locale — short names,
  11px type, before and after. This is the site `LONE.cyrillic` would have been
  charged at, and it is not charged.

Swept rate by rate against the real chart, holding ru-RU's 12 captions at 390px
needs `JOINED.cyrillic` ≤ 0.60, 11 needs ≤ 0.62, 10 needs ≤ 0.64 and 8 needs
≤ 0.68; holding `streakChart`'s 384px crossover needs 0.58. The widest real
Cyrillic word measures 0.6885, so **12 captions at 390px costs a 1.148x
under-estimate on a label the app draws** — unavoidable at any rate that covers
the words, exactly as Greek's was.

None of it is fixed here. `WIDTH_SAFETY` stays at 1.25 and was not widened:
a wider margin papers over every under-classified script at once and hides the
next one the way these two were hidden. `columnsForWidth`'s default `reserved`
was not touched, and the stride is still **#285**, which wants a decision rather
than a number.

## `columnsForWidth`'s reserve must come from the caller's own gutter (#285)

#285 named two things and only one of them is a code change. Part 1 is the
caption stride the sections above kept deferring to it; it is decided here,
in prose, with no diff. Part 2 is `columnsForWidth`'s `reserved` argument
handing `weekdayMonthChart` a column count for a plot area wider than the one
it actually draws into — a real defect, fixed below.

**Part 1: the greedy caption walk stays exactly as it is on master, and no
code changed for it.** `weekdayMonthChart`'s caption placement (`charts.js`,
the `CAPTION_GAP` / `drawn` / `lastRight` block) drops whichever caption
collides with the last one DRAWN, reserving the last column first and filling
in leftward — a variable gap along the axis, because the collision a long
month name causes is not the same width as the collision a short one causes.
The alternative, tried and reverted, was a constant stride: size `every` from
the single WIDEST caption in the set and apply it to all twelve columns, so
one long month name thins the whole axis rather than only the columns near it.
Measured, that reversion cost: th-TH 12 captions down to 6 at 328px, ru-RU 12
down to 6 at 390px, ja-JP and ko-KR 11 down to 6, el-GR 11 down to 6 at 358px,
ml-IN and si-LK 5 down to 3, bn-IN 4 down to 3. #131's own objection to the
greedy walk — that a variable gap is "an axis you have to count along" — is
noted and overruled here: an axis you can count along at all beats one with
half its months missing, and the variable gap is accepted as the lesser cost.

**Part 2 is the fix.** `columnsForWidth(width, density, reserved = 46)`
(`shared/public/ui/window.js`) answers how many columns of at least
`MIN_SLOT[density]` pixels fit once `reserved` — the caller's own non-plot
furniture — is subtracted. The `46` default is not a guess: it is
`scoreChart`'s and `historyChart`'s own `pad.left + pad.right` (34 + 12), which
is why those two callers pass nothing. `weekdayMonthChart`'s `pad.left` is
never one of those fixed numbers — it is `gutterFor(weekdayNames('short'),
10.5, 42, 8, width * 0.32)`, measured from the account's own localised short
weekday names, floored at 42px and reaching 103px — so handing the shared
default to `columnsForWidth` for that card computed a column count for a plot
area 8–69px wider than the chart actually draws into, and `colW`
(`Math.min(72, w / shown.length)` in `weekdayMonthChart`) came out below
`MIN_SLOT.circle` (22) — the exact floor `columnsForWidth` exists to enforce.
That range is `reserve − 46`, not `gutter − 46`, and the two are eleven pixels
apart because the reserve carries `pad.right` as well: 8px in en-US (54 − 46)
and 69px in bn-IN (115 − 46), whose 103px gutter is reachable at any
`chartWidth ≥ 322px`, the width above which the `width * 0.32` ceiling stops
binding it. An earlier draft of this paragraph differenced a gutter against a
reserve and said 57px, which contradicted the 54px/115px figures given below
it.
The fix hoists the three furniture constants `weekdayMonthChart` used to
declare function-locally to module scope in `charts.js` and adds one exported
`weekdayMonthReserve(width)`, read by both the chart's own `pad` and by
`ui/detail.js`'s `weekdayByMonth` card, which now passes
`reserved: weekdayMonthReserve(chartWidth)` to `windowedChart`. There is
exactly one declaration of the gutter arithmetic; the chart renders
byte-identically to master in every locale, because nothing about the drawn
geometry moved — only what `columnsForWidth` is told about it did.

**The measured widths-under-`MIN_SLOT` sweep, over `gutterFor` and
`columnsForWidth` at widths 320–1440, one run per locale under `LC_ALL`,
counting widths where `min(72, (width - gutter - 12) /
columnsForWidth(width, 'circle', 46)) < 22`:** en-US (short weekday gutter
42px) 408 of 1121 widths, in 8px bands, one per column count — `332-339,
354-361, 376-383, 398-405, …`; ja-JP (42px) the same 408, same bands; th-TH
(49px) 764; and hi-IN (58px), pt-PT (66px), ne-NP (73px), lv-LV (74px), fa-IR
(78px), ar-EG (78px) and bn-IN (103px) all **1121 of 1121 — every width
measured.** With the reserve taken from the chart's own gutter
(`weekdayMonthReserve`), **0 widths, in all ten locales.** So this is not a
locale-only defect — en-US is wrong at 408 of 1121 widths on its own — but
seven of the ten sweep locales are wrong at *every* width, which is what makes
a locale-overridden browser assertion (`capacitycheck.mjs`, below) robust
rather than fragile: pt-PT was picked for it because its 66px gutter puts
every width the suite tries under the floor on the unfixed wiring.

**Three-way capacity table, measured on this tree (columns; `score` /
`history` / `frequency` are locale-independent, `weekdayByMonth` is shown at
its master figure, its reverted-PR figure, and this PR's figure per locale):**

- `score`: master 46 gives 47 / 52 / 57 / 112 / 232 columns at 328 / 360 / 390
  / 720 / 1440px. The reverted `Math.max(46, ceil(width*0.32) + 12)` gives 35
  / 38 / 42 / 79 / 161 — a cut of roughly 30% at every width. This PR gives
  back master's own 47 / 52 / 57 / 112 / 232, unchanged, because `score`'s
  reserve stays the fixed 46 it always was.
- `history`: master 28 / 31 / 34 / 67 / 139; reverted 21 / 23 / 25 / 47 / 96;
  this PR 28 / 31 / 34 / 67 / 139 — the same recovery, for the same reason.
- `frequency`: master 4 / 5 / 5 / 11 / 23; reverted 3 / 3 / 4 / 7 / 16; this PR
  4 / 5 / 5 / 11 / 23 — its reserve was never touched by either version, see
  below.
- `weekdayByMonth`: master 12 / 14 / 15 / 30 / 63; reverted 9 / 10 / 11 / 21 /
  43 — fewer than THIS PR gives, and not because the reversion under-reserved
  but because it over-reserved even here: `Math.max(46, ceil(width*0.32) + 12)`
  is 117 / 128 / 137 / 243 / 473px at those five widths, against this chart's
  real reserve of 54px in en-US and 115px in bn-IN, its widest measured. So
  the reversion was wrong in the same direction for all four charts — it
  charged three of them a reserve they had no gutter for, and charged the
  fourth roughly twice the one it does. This PR, per locale: en-US 12 / 13 / 15 / 30 / 63,
  pt-PT 11 / 12 / 14 / 29 / 61, hi-IN 11 / 13 / 14 / 29 / 62, th-TH 12 / 13 /
  14 / 29 / 62 — never more than master, and only ever fewer by the 0–2
  columns whose `colW` had fallen under 22px.

So three charts keep every column master gave them, and only `weekdayByMonth`
gives any up — never more than it has to, because the reserve is always ≥ 54
and the new count can only be smaller than or equal to master's.

**Measured in a real Chrome at pt-PT (`capacitycheck.mjs`), the four
viewports' `chartWidth` and what each drew.** The card's `<svg>` `width`
attribute reads 320px at a 360px viewport, 332 at 390, 694 at 768 and 1026 at
1440. Under the UNFIXED wiring (`reserved` left at the shared 46 default) the
chart drew columns at `colW` = 20.17 / 19.54 / 21.24 / 21.55px respectively —
below the 22px `MIN_SLOT.circle` floor at all four. With the per-caller
reserve, `colW` = 22.00 / 23.09 / 22.00 / 22.05, drawing 11 / 11 / 28 / 43
columns of the 50 seeded month buckets — never the full 50, so the assertion
that the pitch clears the floor is never vacuous: the window stayed
capacity-limited at every viewport, including 1440px.

**Why the default stays 46 rather than widening.** It is `scoreChart`'s and
`historyChart`'s own `pad.left + pad.right`, restated nowhere else, and it is
a default rather than a required parameter deliberately: a REQUIRED `reserved`
would hand a cached old caller under `shellFirst` — one still calling
`columnsForWidth(width, density)` with no third argument — `NaN` columns
instead of the 46 it was written against. The reverted change widened the
shared default itself to `Math.max(46, ceil(width*0.32) + 12)`, which exceeds
46 above ~106px and so charged `score`, `history` and `frequency` a reserve
sized for `weekdayMonthChart`'s benefit at every width — the ~30% cut in the
first bullet of the table above. This fix instead gives the one caller whose
gutter is measured its OWN figure, and leaves the shared default exactly as it
was for the three callers it was already right for.

**The `frequencyChart` correction: the issue is wrong that it needs a wider
reserve, and its numbers do not move.** `frequencyChart` does call `gutterFor`
(its own `pad.left`), so it looks like the same shape as `weekdayByMonth` — but
its `windowedChart` capacity is `density: 60`, a VERTICAL row count (months
per row; see the comment above `buildFrequencyCard` in `ui/detail.js`), and a
horizontal gutter cannot constrain how many rows fit. `ui/detail.js`'s
`frequency` call site carries a comment naming #285 and stating this
plainly, deliberately with no `reserved:` argument, so the next reader does
not re-derive the issue's claim.

**The `weekcheck.mjs` correction: the issue is wrong that nothing in CI would
have caught this.** `weekcheck.mjs` is in `SCRIPT_SUITES` in
`shared/test/locales.mjs`, which `npm run test:locales` runs under ten
`LC_ALL`s including `pt_PT.UTF-8` and `hi_IN.UTF-8` — two of the seven locales
above that are wrong at every width on the unfixed wiring, both of which
distinguish the old reserve from the new one. `shared/test/window.test.js` is
in that sweep's `SUITES` too. So `weekcheck.mjs` was always a legitimate home
for the rendered-geometry half of this defect, and CI already ran it in a
discriminating locale before this fix landed; what CI could not have caught is
that nobody had yet asked `weekcheck.mjs` the RIGHT question about it.

**Why there are two test halves, and what each one cannot see.**
`weekcheck.mjs`'s new `#285` block (offline, a fake DOM, ten-locale sweep)
proves `weekdayMonthReserve` is a CORRECT reserve for the chart it describes —
Check A that the drawn pitch clears 22px, Check B that the reserve equals the
chart's own rendered `pad.left + 12` so the two can never drift apart, Check C
that the window drew every column it claims so neither check is vacuous. It
cannot prove `ui/detail.js` ever calls `weekdayMonthReserve`, or that
`windowedChart` forwards what it is handed to `columnsForWidth` — neither
`detail.js`'s card builders nor `components.js`'s `windowedChart` are
reachable from a fake DOM. `capacitycheck.mjs` (a real server, a real Chrome,
`pt-PT` locale override) is the wiring half: it proves the pitch clears the
floor on the actual rendered "Weekday consistency" card, reached by clicking
into a seeded habit rather than by calling `weekdayMonthChart` directly.

Mutation M6 is the recorded evidence that the split is not redundant:
dropping `windowedChart`'s forwarding of `opts.reserved` back to
`columnsForWidth(width, density)` with no third argument fails
`capacitycheck` at all four viewports, naming the pitch — and leaves
`weekcheck.mjs` and `window.test.js` **both still passing**, because neither
suite ever calls `windowedChart` at all. A fake-DOM suite that pins the
DECISION cannot see a caller that stops using it.

Two more mutations sharpen what each check inside `weekcheck.mjs` actually
covers, found by running them rather than by predicting them. Mutation M2 —
`weekdayMonthChart`'s `pad.left` hardcoded to the literal `42` instead of
`weekdayMonthGutter(width)`, with `weekdayMonthReserve` itself untouched —
fails Check B (the reserve no longer equals the rendered `pad.left + 12`) in
every locale whose gutter exceeds 42px, and **never fails Check A**: `n` is
computed from the untouched, correct reserve, and a `pad.left` forced smaller
than that reserve only ever WIDENS the plot area for that fixed `n`, so
`colW` cannot drop below the floor. An earlier prediction said Check A would
fail too; it does not, and Check B is the only one of the three that can see a
reserve/chart drift at all. Mutation M3 — `weekdayMonthReserve` returns a
constant `46` — fails `npm run test:locales` in **all ten** locales the sweep
runs, not only the seven whose gutter exceeds 42px: en-US and ja-JP also carry
8px bad bands at some of the nine widths `weekcheck.mjs` tests, from the sweep
above, so a reserve stuck at 46 is wrong there too, just not at every width.

**The `CACHE_VERSION` bump.** `weekdayMonthReserve` is a new EXPORT from
`charts.js`, not a new file, and `shellFirst` is stale-while-revalidate: a
running worker can serve the new `ui/detail.js`, which now statically imports
`weekdayMonthReserve`, over a cached OLD `charts.js` with no such export — a
module link error before `start()` runs, outside `#view-error`, exactly the
v20 case this rule already covers. `CACHE_VERSION` moves `'v30'` → `'v31'` in
`shared/public/sw.js`; `SHELL` itself is unchanged, since no file was added or
removed.

## Issue #297

A note could be stored, exported, imported and round-tripped, and could be
*written* from exactly one place in the whole frontend — the detail page's
calendar's `onPick` — and was drawn nowhere at all. Mark's own report: notes
"are not readable or modifiable". Three pieces close that, and none of them
touch `entryWrite`'s preserve-on-omit rule (#224) or the tap cycle.

**The payload sends DATES, never the text.** `/overview` gains a per-habit
`notes` array, symmetric with the existing `skips` array, pushed for a skipped
day as well as an ordinary one — a skip is an answer, and it can carry a note
same as any other row. The alternative — the text itself, or a Set the client
builds once — was refused on a measurement already on this page:
`habiterall-cloud/src/cache.js` records the `/overview` memo retaining 499 KB
for 20 habits × 365 days, and a note is up to 500 characters. Sending the text
would multiply that by however many days carry one, on a payload the memo
already treats as expensive. A caller that wants the text has to ask
`/habits/:id/entries`, unwindowed — which the detail page already does, for
the same reason its calendar and its "Recent days" strip redraw locally
instead of refetching (see "The day strip on a habit's own page" above).

**A dot, never a colour, and never a fill.** See `shared/public/CLAUDE.md`'s
note under "The detail view" for the reasoning in full: the four day states,
the at-most ramp and the ghost-tick shapes already own every colour meaning
this grid has, and a note is orthogonal to all of them. The mark is drawn
after the cell (`data-note-for`, `pointer-events: none`, sized off `CELL`, a
`themed`/`shade` fill and stroke only), counted on `data-note-marks`
unconditionally including `"0"` — the same idiom `data-run-marks` already
established, for the same reason: an absent attribute must mean an OLDER
`charts.js`, not a quiet window. The `.check-box.has-note` mark on both strips
follows the identical rule from the other surface's vocabulary, exactly as
`unlogged_is_success`'s ghost tick and faint fill already split by medium.

**The dashboard routes through the habit's own page rather than opening the
editor in place, and the reason is `saveDay`'s oldest rule.** `saveDay`
(`ui/day-dialog.js`) unconditionally sends `notes: notes.value.trim()` on every
save — there is no "say nothing about the note" option from that dialog, only
from a strip tap. So *any* way into the editor that cannot seed the box with
the note's TRUE text would silently destroy whatever was there the moment it
was saved, which is exactly the shape #224 closed for a button that never saw
the note to begin with. The dashboard cannot seed truthfully — it holds only
the fortnight it asked for and, by the payload decision above, never the note
text, only which dates carry one — so `listHost.editDay` does not open the
dialog itself. It calls `openHabit(habit.id, { editDay: date })`, i.e.
detail's own `open`, already imported by `dashboard.js` as `openHabit`, so this
adds no new export. `open` renders the habit's page — which holds the whole
unwindowed history, note text included — and then opens the day editor over
it, guarded exactly as the calendar itself is (the habit must have rendered; a
future date is refused). One owner of the note data, no second fetch path, no
offline hole, and the URL stays `#/habit/<id>` — no `#/habit/42/day/...` form
that would reach Android's deep links (see "Routing" in `shared/public/CLAUDE.md`).

**The affordance is a right-click/long-press plus a keyboard equivalent, with
Android precedent.** `dayCells` wires `contextmenu` and Shift+Enter to
`host.editDay?.(...)`, leaving the plain `click` handler and its optimistic
cycle untouched — a SECONDARY affordance may not steal the primary tap, which
is also why a numerical habit's count dialog has always been a separate dialog
from the day editor (`openCountDialog`'s own comment, `day-strip.js`).
`android-native/.../ui/DayGrid.kt` already ships the identical gesture on a day
cell, and its own comment is why the web needed the keyboard path and the
`title`/`aria-keyshortcuts` rather than treating the mouse gesture as enough on
its own: a long press is not discoverable to a screen reader, and naming the
action is what turns a secret into a control.

**`e.preventDefault()` on the Shift+Enter path is load-bearing, and it does not
stop what it looks like it stops — which is the part worth writing down,
because the plausible version was written first and is false.** The reasoning
that produced it: a `<button>` runs an Enter activation as the keydown's
DEFAULT, so without the call the same press would open the editor AND cycle
the day underneath it — two writes from one press. That does not happen, and
the mutation says so: remove the call and the day's stored value is still
exactly what it was. The activation runs *after* the handler returns, by which
time `openDayDialog` has called `showModal()`, and the cell is behind a modal
and inert — the cycle can never fire. What actually happens is worse to read
and better to name. Focus is inside the dialog by then, so the press falls
THROUGH into the editor it just opened: measured on the unfixed build, with a
CDP event log, `keydown@BUTTON.check` → `keypress@BUTTON.day-choice` →
`click@BUTTON.day-choice`, both trusted, and the dialog's `open` attribute
going on and straight back off in one pair of mutation records. One press
opens the day editor, answers it with whatever its first button says, saves
and dismisses it — and `saveDay` states the note on every save, so that unseen
save writes the note box back too. The suite pins the mechanism rather than
the symptom: `stripcheck.mjs` records every click reaching a `.day-choice`
during the press and requires none. Its stored-value check is kept beside it
and is honest about biting a different regression — `editDay` wired onto the
plain click path — since it passes with the `preventDefault` removed.

**The notes card is the third way in, and the only one that costs no
shortcut.** It lists a habit's dated notes, newest first, capped (`NOTES_LIMIT`
in `ui/detail.js`, 20) with a muted line naming how many earlier ones are not
shown — a rendering cap over data already in memory, not a narrower fetch, so a
pager can be added later with no change to what is fetched. Each row is a real
`<button>` calling `detailHost.editDay`, keyboard-reachable by construction. It
returns `null` for a habit with no notes, the same rule `buildResilienceCard`
and `buildAwardsCard` already follow for their own kind of nothing, and its
registry row (`DETAIL_CARDS`, `SETTINGS.detailCards`, `CARDS` in
`ui/detail.js`) sits immediately after `calendar` — order is load-bearing
there, because `parseCardList` keeps a new-shape stored list close to verbatim
and a default written in another order is normalised away on its first write.
