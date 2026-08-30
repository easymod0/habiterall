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
