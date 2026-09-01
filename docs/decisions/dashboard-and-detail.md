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

**Still open and deliberately not touched here: #230**, the strip and the
calendar card disagreeing about the same day offline. `writeDay` ends in a
refetch that never runs with no network, so the strip's optimistic paint stands
while the calendar keeps the value it was drawn with. It lives in the same
files, and it is a different question: this change is about which WINDOW is
drawn, that one about which VALUES are in it.

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

**#230 is not closed by this, and must not be read as closed.** #230 is the
strip and the calendar disagreeing about a day's VALUE offline — `writeDay`
ends in a refetch that never runs with no network, so an offline tap's
optimistic paint can sit ahead of what the calendar last drew. This change is
about which WINDOW is drawn, not which values are in it, and it does have one
true side effect worth stating narrowly and not overclaiming: `draw()` closes
over the same `entriesByDate` object `detailHost.edit` mutates optimistically,
so a page press made AFTER an offline tap now draws the tapped value where
before it would have redrawn nothing at all. Nothing redraws the calendar ON
the tap itself, so the disagreement #230 names survives exactly as before
until something pages or reopens — this narrows one path by which a stale
value could be SEEN, it does not touch the disagreement #230 names.

**The service-worker measurement that makes the offline half of this real is
the same one already recorded above, for the strip.** Devtools' network
emulation does not reach the service worker's own fetches — `open()`'s GETs
answer out of `DATA_CACHE` under `Network.emulateNetworkConditions` alone,
because `CACHEABLE_API` matches `/^\/api\/habits/`, so `open()` SUCCEEDS and
every check written against the unfixed calendar would have passed for the
same reason the strip's did. `Network.setBypassServiceWorker` is what makes
the offline calendar checks in `calcheck.mjs` mean anything, for the reasons
`stripcheck.mjs`'s own comment gives in full.

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
