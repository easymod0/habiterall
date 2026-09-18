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
**So is changing the SHAPE of a value read by more than one shell module** even
when neither is true — `detailCards` becoming `{id, on}[]` (#163) added no file
and no export, but `ui/settings.js`, `ui/settings-dialog.js` and `ui/detail.js`
all read the stored value, and `shellFirst`'s stale-while-revalidate can serve
one of those three a new module over a cached old one. See `sw.js`'s own
comment at `v18` for what that looks like in practice.

**A route the worker caches may not `Vary` on a header the page sends only
SOMETIMES.** `networkFirst` stores with `cache.put(request, …)` and reads back
with `caches.match(request)`, and the Cache API selects an entry using the
stored RESPONSE's `Vary` — so a conditionally-sent header turns one URL into
two keys, and the key an offline boot presents is the one without it. That is
not a stale answer, it is no answer.

**The measurement is historical and the rule is not.** It was taken in Chrome
against cloud's `X-Habiterall-Fresh`, a header #192 has since deleted — no
client sends it and no route reads it, so nothing below is a description of
what the app does today. It is why the rule exists: the `put` made from the
post-write refetch REPLACED the entry stored from the cold-boot read (one
entry, not two), after which nothing an ordinary request could ask for matched
it at all — `networkFirst` fell through to its synthetic 503 and the installed
PWA opened offline to no dashboard. `Vary: X-Habiterall-Timezone` sat on the
same responses and was safe, which was the whole distinction: a device sends
one zone on every request, where that header rode on exactly one read per
write.

A header asking the server to REBUILD is not a representation a cache could
pick between anyway, so there is nothing to trade. If a route ever genuinely
does need one, the worker has to opt out of it (`{ignoreVary: true}`) in the
same change. `docs/decisions/caching.md` has the measurement in full, and its
deletion inventory records that this rule was kept on purpose.

**`[hidden]` needs `display: none !important`** in the stylesheet. A `display`
rule silently beats the attribute, which once made the day editor show both habit
types' controls at once. Only a real browser catches this class of bug — that is
why `test/browser/` exists.

## The dashboard grid

**What a cell IS, and what a tap on one does, is `ui/day-strip.js` — not
`ui/dashboard.js`.** The painting (`paintCheckbox`), the cell markup, the date
captions, the tap cycle, the one `writeDay` all three writes collapsed into,
and the amount dialog all moved there when a habit's own page grew the same
control. `dashboard.js` may not name `#count-*` any more; `ui-modules.test.js`
fails with two owners if it does. What stayed is list-shaped: rows, drag
reordering, search, the empty state, and paging — which the dashboard does by
REFETCHING, because it holds only the fortnight it asked for.

**It fetches the window it is showing.** `/overview` takes an `end` date; paging
back without it re-rendered an empty grid, because the entries for that window
had never been loaded.

**...but `end` moves the GRID only.** It was deciding two things that want
different dates: which days are painted, and the date the row summary is computed
as of. Paging back a month restated the strength and the streak as of that month.
`summaryEnd` is `today()` in both editions' `/overview`. The detail view is the
surface that answers "as of when", and it has its own range controls.

**...so the list is fetched for ONE local day, and it asks again when that day
ends.** `load()` records the browser's own date and `refreshIfDayChanged`
refetches when the clock has moved past it, on a timer armed for the next local
midnight and on `visibilitychange` — the same pair, and the same argument for
needing both, as `ui/detail.js`'s day watch, restated here rather than shared
because a helper either module could import would be a new export under
`shared/public/` and so a `CACHE_VERSION` bump. Three things differ from the
detail view's and each is the dashboard being the dashboard. It is a `load()`
and never a `paint()`, because this view holds only the fortnight it asked for
and the new day's column is one the server has never been asked about — a
repaint would draw it empty and paint any tap on it back out. The day is
recorded at the FETCH, because `paint()` runs here with no request behind it (a
search keystroke, an optimistic repaint) and resolves `todayISO()` itself, so a
record taken at the paint would call the page current for a window whose newest
column has nothing in it. And it declines unless `dashboardShowing()`: `paint()`
nulls `state.openHabitId` and unwinds the fragment, so firing under an open
habit would navigate away from a page somebody is reading — which costs nothing,
since every road back to the list emits `'reload'`. A PAGED grid is still
refreshed, unlike the browser reminder's own `refresh` policy in `app.js`: that
one declines a window that could not contain today, where this is about the
row's figures, which `/overview` anchors on today however far back `end`
reaches, and `load()` re-sends `state.gridEnd`.

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

**The drag gate is five clauses, named in `canReorder` rather than an inline
`&&` chain, because #65 phase 2's grouping work already wants a sixth.**
`sort !== 'manual'` is the fifth: a drop computes a new `position` from
ON-SCREEN neighbours and `persistOrder` sends the whole
`state.habits.map(h => h.id)`, which under any other sort IS the sorted order —
so one drag under `strength` would rewrite every habit's stored `position` into
that sort's order. Stored-data corruption, the class the other four clauses
guard against, not a handle that merely looks wrong.

**It reads `state.habitSort` — the `/overview` payload — and not
`settings.get('habitSort')`, unlike every other clause here.** The other four
are local view state or the web's own rendering decision, so gate and render
cannot disagree by construction. This one can: `settings.init()` runs once per
page load and nothing re-reads `/api/settings`, while `state.habits` is
refetched by every `load()` — so a tab open since before a SECOND tab changed
the sort saw a cached `'manual'` over a list that came back in `strength` order
(#200, review round). `/overview` echoes the RESOLVED sort, `load()` installs
it under the same `loadSeq` guard as `habits`, so the gate and the order it
guards come from one response, offline included. Compare against `'manual'`
specifically, not `!== undefined`: an untouched account's reply has no
`habitSort` key at all, and dragging must go on working there. See
`shared/CLAUDE.md`'s "Habit order" for why the sort is a server decision.

**A grouped section header's mean and spread hide under the same two guards
`reorderable` answers to.** `summarised` refuses a search filter and shown
archived habits, because a mean over a filtered or archive-inflated set is a
figure over a different set of habits than the count beside it — and
`#/categories` already excludes archived habits from the same aggregation.
`summarised` can be true with nothing to draw: `state.categorySummaries` is
read as possibly `undefined` (`?archived=true` sends no such key, and a cached
payload may carry none), and `sectionHeader` treats that exactly like
`summarised` being false.

**A grouped section's ORDER is `position`, and the habit dialog's category
manage list is the one surface that writes it.** Both editions already read
categories `ORDER BY position, id` and land a create at `MAX(position) + 1`, so
`POST /categories/reorder` (`moveCategory`) is a caller for existing storage
semantics — nothing on the read side had to learn anything. The ↑/↓ pair are
disabled while `editingCategoryId != null`, because `repaintCategories` will
not rebuild a list holding a live rename `<input>`, so a press there would
write and repaint nothing. `docs/decisions/categories.md` phase 5 has the
disable rules in full.

**`state.categories` has several writers that can be in flight at once, so a
read may only INSTALL its answer if it is still the newest one.**
`state.categoryReadSeq` (`ui/store.js`) is that counter, and it lives beside
the field rather than beside any one reader because the writers are in two
modules. The rule for anything added next is the shape rather than the list:
**a writer of `state.categories` that is not itself the newest read must take
a ticket** — an optimistic write bumps, a read installs only while it holds
one. Five writers obey it today: `refreshCategoryPicker`, `load()`
(`ui/dashboard.js`), `moveCategory`'s optimistic splice, `moveCategory`'s
catch, and the queued DELETE's optimistic removal. Each fails differently and
a version with any four of them still ships the bug; two of the five were
found by review after the counter shipped. `habits` and `categorySummaries`
are deliberately NOT ticketed — no category writer can be newer than the reply
— while `loadSeq`, added later, tickets those for a second `load()`.
`categorycheck.mjs` blocks `j` to `n` pin one half each, and each passes with
any of the other four deleted.

**`load()` emits `'categories'` where it assigns, and `habit-dialog.js`
answers it with `repaintCategoriesKeepingPlace`.** The ticket stops a stale
writer winning; this is the other half — telling a modal that the newest
writer landed, since `paint()` does not repaint `#category-manage`. Three
things are load bearing: it is emitted inside the assignment's own guard, so
it means "this field just moved" rather than "a load finished"; it is **not**
`'reload'`, which fires BEFORE anything is fetched; and the listener declines
while the dialog is CLOSED, or `restoreArrowFocus` moves focus into a panel
the user is not in.

**The picker's clear is `clearCategoryIfChosen`, and it is EXPLICIT (#323).**
`renderCategorySelect` PRESERVES a non-empty unknown `select.value` behind
`(current category)` on every path, because a list that has not caught up and
an authoritative read from a device where the category was genuinely deleted
are indistinguishable to it — and only the second may clear the habit's
category. The only signal that tells them apart is "this handler just deleted
this category itself", which no repaint can know; `clearCategoryIfChosen` is
that signal, called by the ✕ handler in both branches before either repaint.
Two orderings still reach `saveHabit` with a doomed id and are an accepted
cost rather than an oversight — do not add a pre-queue guard in `saveHabit`
without deciding that separately, since `resolveCategoryId` is the authority.

**A reorder arrow may not be restored with `restoreFocus`,** whose fallback is
the first still-operable `[data-focus-key]` in the same parent — right for
`Today`, wrong in a manage row where ↑ and ↓ are each other's undo.
`restoreArrowFocus` parks focus on the list itself at a boundary. **And the
scroll is a separate question**: both `.focus()` calls pass `preventScroll` and
`revealArrow` owns visibility, because `.focus()` is not a scroll mechanism.

`docs/decisions/categories.md` phases 4 and 5 have all of this in full — each
writer's own failure, the two accepted `saveHabit` orderings, the disable
rules, and why `moveCategory` keeps the optimistic order on `err.queued` where
`persistOrder` does not.

## The detail view

**Which cards it draws is a list of INVENTED IDS, and the server never hears
about it.** `detailCards` gates the eleven builders in `ui/detail.js` (#297 added
the notes card, below); the ids come from `DETAIL_CARDS` (`shared/src/validate.js`)
and not titles, because a card has no id and the titles are English prose #144
will translate.

**A note's DOT is a mark, never a hue (#297).** The four day states already own
the colour meaning on that grid, plus the at-most ramp and the ghost-tick
shapes above, and a note is orthogonal to all of them — recolouring the cell
would invent a fifth meaning for a hue or steal one of the four. A corner dot
reuses the idiom the `?` glyph and the run stroke already established: drawn ON
TOP of whatever the cell means, `pointer-events: none` so it never steals the
click, and read only for truthiness — never for its own colour, so `charts.js`
reads `themed(...)`/`shade(...)` like every other mark rather than a literal
resolved at draw time (`themecheck.mjs`).

**A note gained four ways into the day editor, and the plain tap is the only
one that is the account's choice.** Three are SECONDARY and none could steal
the tap: `contextmenu` and Shift+Enter on both grids (`dayCells`), and the
notes card's own rows, which are real `<button>`s. The fourth is `dayTap` —
`'cycle'` by default, `'editor'` hands the cell to `host.editDay`. The setting
is asked FIRST, before the habit type, because it is a fact about the TAP and
the branches below it are facts about the HABIT; it is read through
`settings.get` at TAP time, never held; and `host.editDay` stays optional, so a
preference cannot turn a grid off. All four converge on the rule the day editor
has always had: `saveDay` states the note on every save, so a way in that
cannot seed the box with the TRUE text destroys whatever was there (#224).

**`StripHost.editDay` is optional, and the two hosts differ in what they must
do to SEED it, not in where they open it.** `detail.js` holds the whole
unwindowed history and seeds directly; `dashboard.js` holds only the fortnight
and, by design, never the note TEXT — only which DATES hold one (`/overview`'s
per-habit `notes`) — so `editDayOverList` fetches `/habits/:id/entries` and
opens in place. Two rules keep it honest. It fetches **unconditionally** and
does not shortcut on `hasNote`, because a missing `h.notes` reads as empty and
that is exactly what a service-worker-cached `/overview` predating the field
sends. And a fetch that FAILS still opens the dialog with the note declared
**unknown** — `openDayDialog`'s fifth argument takes `null` as a third answer
beside a string and `''`, hiding the box and leaving `notes` out of the body,
which `PUT /entries/:date`'s preserve-on-omit makes safe.

**The value and the skip come from the HOST, only the note from the reply** —
they are the optimistic model, so reading them off the fetch opens the dialog
on a day the grid is painting differently. Both are read AFTER the await.

**And `saveDay` must tell the host on the SUCCESS path, not only the queued
one.** The day editor is the one writer that does not move `state` before the
request, so with the editor opening over the list an ordinary ONLINE save
redrew the pre-edit day and said nothing. The fix is the `edit` + `repaint`
pair the queued branch already does. Pinning it needs a day the save can
CHANGE, which is why `gridcheck.mjs` DELETES a day in its seed and asserts the
blank start first — the fixtures lay down 60 days of entries, so the first
version of that check compared a cell to a state it was already in and was
green against the unrepainted build.

`docs/decisions/dashboard-and-detail.md`'s `dayTap` section has the rest,
including the mutation table behind each of these.

**"Recent days" is the one card you ACT on, and it is first for that reason.**
It is the dashboard's tappable day strip for one habit — `ui/day-strip.js`,
shared with the dashboard rather than copied — so a reminder can be answered
without going through the calendar and the day editor behind it. Two things
about it are not obvious:

- **It pages by SLICING, not by asking for a window, and paging it makes no
  request.** `open()` fetches `/habits/:id/entries` unwindowed, so
  `entriesByDate` / `skipSet` are the whole history and no `end` parameter ever
  reaches the server from this card — which is what makes a local redraw
  possible here and impossible on the dashboard, which holds only the fortnight
  it asked for and must ask again. `buildRecentDaysCard`'s own `draw` is what
  the ‹ Earlier / Later › / Now buttons call, and it rebuilds the window out of
  the entries already in hand. Be exact about the claim, because an earlier
  version of this bullet was not: it is request-free to PAGE, and the card is
  still built by a page that fetched twice to get here.

  **The rule that keeps it that way, and the thing worth knowing: `page()`
  (`ui/components.js`) moves `state.chartOffsets` BEFORE it calls `redraw`, so
  any `redraw` that can FAIL without rendering leaves the stored position and
  the drawn window disagreeing.** `refresh(habit.id)` is such a redraw — a GET
  is not replayable, and `open()` toasts and returns without rendering — and it
  is what this card used to pass (#245). Its redraw must stay local.
  Most of the other cards draw figures the server computed, so they have
  nothing local to redraw from and keep the refetch.

  **The calendar redraws locally too, the same way (#274).** `buildCalendarCard`
  draws from the same unwindowed `entriesByDate` / `skipSet`, from
  `stats.streaks` already in memory, and from `calendarWindow(...)`, which is
  pure client arithmetic — nothing in its window needs the server either, so its
  ‹ Earlier no longer moves `state.calEnd` and then calls `open()`. Both cards
  now redraw from data already in hand rather than refetching.
  `open()` also resets `state.calEnd` alongside `state.chartOffsets`, both at
  `detail.js:74`, so reopening a habit — the SAME one or a different one —
  starts the calendar at today rather than carrying a paged position across the
  navigation; every in-page redraw (a tap, a zoom press, a granularity change,
  the settings dialog, the `'change'` broadcast) is `redraw === true` and keeps
  it. See `docs/decisions/dashboard-and-detail.md`'s `#274` section for the
  argument, including why a same-habit reopen is folded into the same reset
  rather than kept as a per-habit position.
- **Its host repaints CELLS IN PLACE (`repaintCells`), not the page.** The
  dashboard's `repaint` is a full `paint()`, which is cheap there; here a
  rebuild is two round trips and up to ten cards of SVG. Touching no nodes is
  also what keeps focus on the button that was just pressed during the
  optimistic step — `open()`'s later rebuild is what `focusKeyOf` /
  `restoreFocus` (now in `ui/components.js`) are called for.

Bounded to `STRIP_HISTORY_DAYS`: running from the habit's first entry is the
browser-side shape of the `MAX_RANGE_DAYS` rule, and an imported row dated year
0100 would ask for a ~700,000-element array. And `gridDays` caps its columns
through `cappedColumns`, NOT `gridColumns` — that function's 7/10/14 ladder
exists to protect the dashboard's habit-name column, which this card does not
have.

**Offline, the strip, the calendar card and the notes card agree about a day
(#230, extended by #297).** They draw one set of maps and a tap moves them
before it writes, so `detailHost.repaint` redraws all three beside the cells
rather than waiting on the refetch `writeDay` ends in, which offline never
runs. All are nulled by `render()` before a rebuild, or a tap redraws a card
that has been detached. **The notes card is the third redraw and was missed on
the first pass** — `notesRedraw` is its `calRedraw`, with the same lifecycle —
because offline a cleared note otherwise left a GHOST ROW after the dot and
the strip mark had gone. That is squarely INSIDE the redraw rule, not an
instance of the accepted staleness below: that excuses figures the SERVER
computed, and a note is local data the edit itself moved.

**One case a repaint deliberately cannot cover: a habit's FIRST note written
offline gets no card until the next full render.** `buildNotesCard` returns
`null` for a habit with no notes, so there is no card to redraw, and inserting
one is `render()`'s job — it owns card ORDER, from the stored `detailCards`
list, which a repaint has no business deciding. The dot and strip mark still
light immediately. The mirror case IS covered, because there the card exists.

**A QUEUED write from the day editor closes the dialog and repaints too.**
`saveDay` awaits `api()`, and offline `api()` stages the write and THROWS — so
with the close and the `emit('change')` both after the await, a toast said
*Saved offline* while the dialog stayed open on the old value and both grids
painted the pre-edit day. It takes the opening page's host and does `edit` +
`repaint`, and reaches no `emit('change')`, which is a refetch offline cannot
answer and could repaint the queued write straight back out. **`edit`
therefore takes a NOTE:** absent means the write says nothing about it —
matching `PUT /entries/:date` preserving one it was not asked to change — a
string is a stated note, `''` a stated clear, and a `'clear'` takes the note
with the row. A genuine failure (anything ANSWERED; only an unsent request
carries `queued`) still leaves the dialog open and says so.

**The calendar redraw draws the STORED position, and re-resolves today when
there is none.** `draw` reads `state.calEnd` and never writes it, so #274
cannot repeat; with `calEnd` null — the default — `draw` and `calendarChart`
both resolve today afresh.

**The page is drawn for ONE local day, and it asks again when that day ends.**
`render()` records `todayISO()` and `refreshIfDayChanged` refetches when the
browser's own day has moved past it — the WHOLE view, because every window on
the page is frozen at render time the same way, and fixing one card moves the
page from "one card is stale" to "one card jumps differently". The browser's
own date, never a named zone: `callerDay`'s question, not `resolveTimeZone`'s
(`docs/decisions/timezones.md`). **Two triggers, and neither is enough alone**
— a timer armed for the next local midnight (`setHours(24, 0, 0, 0)`, so a DST
day gets the right instant) and re-armed per fire, plus `visibilitychange`,
since a suspended device runs no timer. Both ask the same date comparison, so
an early fire or a same-day tab switch does nothing, and a zone CHANGE is
covered by the same rule. A refetch and not a local redraw: every figure is
computed as of a date the SERVER anchors.

**A memoised `Intl` formatter is only valid while the device's clock stays
put, and `ui/dates.js` drops its own when the UTC offset moves.** A formatter
resolves its zone at CONSTRUCTION, so one built at page load goes on rendering
for a zone the device has left. The check is at the USE (`clockNow` /
`perClock`), not in a reset a caller has to remember: **every** path that
redraws after a zone change reaches this, so an invalidator wired to one of
them fixes that one and leaves the rest silently stale. `getTimezoneOffset()`
and never `resolvedOptions().timeZone`, which constructs the very thing being
memoised on a per-cell path; it over-fires on a DST transition and under-fires
between two zones sharing an offset, and **both are harmless**. Three memos
hang off the one question, and the REFERENCE WEEK is the one to know about:
those seven sample dates are local midnights, so rebuilding the formatters
while freezing the sample rotates every weekday caption in the app by one —
the defect `weekcheck.mjs` exists for, introduced by fixing half of this.

**A calendar rebuild keeps the roving tab stop.** `calendarChart` takes a
`tabStop` DATE — not an index, since the cell array is only the editable cells
— and `draw` reads it off the outgoing grid before removing it; a date the new
window does not draw falls back to the last cell.

**What the repaint cannot reach stays stale, and THAT is accepted rather than
missed**: strength, streaks, resilience, history, awards and the weekday
breakdowns are figures the server computed. The run BANDS are the non-obvious
one, and the one to know before reading a screenshot — a calendar cell is
redrawn from the maps and is right, while the band around it comes from
`stats.streaks` on the payload the page was built with. So an offline tap
closing a gap paints the day and not the run it extended, and one ERASING a
day leaves the stroke drawn through a blank cell, which also ticks
`data-run-marks` up and can raise an "In a run" swatch.

**The stored shape is `{id, on}[]`, not a bare list of the ids that are on**
(#163). Membership and order are two different decisions, and a bare array can
record only one of them. `[]` is read as the LEGACY shape and means nothing
visible — reading it as the new shape would invert unticking everything to
everything shown.

**A legacy account is read tolerantly, and migrated only by a deliberate
Done.** Nothing writes the new shape on its behalf. `LEGACY_ERA_CARDS`
(`shared/src/validate.js`) freezes `DETAIL_CARDS` as #174 left it, so an absent
id of that era was unticked and stays off while an absent id outside it did not
exist to tick and arrives **on** — otherwise every card added after an
account's last save is invisible to it, with no surface at all, which is how
`recentDays` shipped (#297). **That list is frozen in time**: appending a new
card's id to it reintroduces exactly that bug. A legacy list also carries no
ORDER to honour and is read in `DETAIL_CARDS` order, since every value that can
be in storage is already a canonical-order subset.

**Pressing Done rewrites it, even with nothing else changed**, and that took a
deliberate mechanism — `storedShapeIsStale` (`ui/settings.js`), answered from
`ApplyMeta.stored` and never from `load()`, generic over `def.normalise` rather
than a `detailCards` special case. Without it the documented recovery is a
no-op.

Two things it deliberately does not do: it does not hide the four stat tiles,
so unticking everything leaves a page rather than a blank one; and it does not
reach `/habits/:id/stats`, because a `?cards=` parameter would be one
service-worker data-cache entry per combination.

**A card that is not being DRAWN holds no position, and one table says both
what to build and what to forget.** `CARDS` in `ui/detail.js` is a `Map` keyed
by id — `build` plus an optional `forget` — replacing two separate lists of the
same nine ids. The view keeps a position in **two** places, `state.chartOffsets`
and `state.calEnd`, and `forget` attaches that knowledge to the id it belongs
to. Both wrong versions shipped in one review round: clearing only
`chartOffsets` left the calendar at its old date, and clearing both from
`applyDraft` gated on "`detailCards` changed at all" sent a still-ticked History
card back to today.

`docs/decisions/dashboard-and-detail.md` has the whole argument — why a marked
string faces the same ambiguity, what `parseCardList` does with a new-shape
absence, and why the two tables were merged rather than kept in step.

`windowedChart` gives its range readout the same `.cal-range` class the
calendar uses, and its nav the same `.cal-nav`, so a test looking either one up
must scope to a card by title. Recent days is FIRST on the page, so an unscoped
query finds the strip's and not the calendar's — which `calcheck.mjs`'s paging
check did, greenly, for as long as pressing the strip's ‹ Earlier happened to
rebuild the page.

## A day nobody answered, drawn as kept

**The dashboard grid and the Calendar card get different treatments on
purpose, because they are different mediums.** `ui/day-strip.js`'s cells are
checkboxes — a glyph medium — so a habit whose unlogged days already count as
kept (`habit.unlogged_is_success`, resolved server-side by `unansweredCounts`)
draws a ghost `✓` at 0.45 opacity in the habit's own colour. `charts.js`'s
calendar is a heatmap — a block medium — so the same fact is a faint FILL,
`shade(color, 0.07)`. One idea in each grid's own vocabulary; drawing a tick
over a calendar block, or a tinted square in the strip, is the same idea said
twice in a grid that has no use for the other's.

**The faint mark replaces the `?`, it does not sit beside it.** Both slots hold
one glyph or one fill, so `questionMarks`'s `?` is suppressed on exactly the
days the ghost tick or faint fill already claims. The two facts this collapses
— "nobody answered" and "counted as kept anyway" — move to the calendar cell's
`<title>`, which is all a screen reader gets.

**0.07 is chosen against the ramp's floor, not from it.** The at-most ramp's
`Math.max(0.15, …)` floor means "a number was recorded"; 0.07 is under half of
it, so a kept-unlogged cell can never be misread as a logged amount. It is not
a fifth step on the Less→More legend but a separately-labelled swatch ("Kept,
unlogged") in front of it, in **both** of `ui/detail.js`'s legend branches — a
fill the legend does not explain is the defect the `isAvoided` branch beside it
already exists to avoid.

**The gate makes the boolean branch unreachable, and that is not an
oversight.** `unansweredCounts` returns `false` unless the habit is non-boolean
AND `target_type === 'at_most'`. Do not add a matching arm to a boolean day's
paint branch — no day shape reaches it. **The flag is a payload field, not a
sixth mirror**: `shared/src` is not served here, so no module in this directory
could call `unansweredCounts` even by mistake.

**Issue #176 extends the same medium split to a run, not to a fill.** The rule
is "where the cell would otherwise draw nothing at all", not "where the day is
not a completion" — on the calendar that predicate is literally `fill ===
empty`, read against the same binding the branches above assign and never a
string literal, so it inherits every exclusion they already encode. On the
strip it reads "no glyph and no background".

**The calendar's run mark is a STROKE, never a fill, because 0.07 is already
spoken for** — a fill squeezed between 0.07 and 0.15 would sit on the ramp
those floors describe and inherit an argument that has nothing to do with it.
`shade(color, 0.55)`, against the connectors' own `shade(color, 1)`. That is
also why **the `?` survives the run mark on the calendar and not on the
strip**: the stroke leaves the cell's fill and glyph slots free, where a
checkbox has only the one glyph.

**The "In a run" swatch asks the GRID what it drew.** `calendarChart` counts
the cells it actually stroked and reports `data-run-marks` on the `<svg>`; the
legend gates on that rather than on `inRun.size`, because the run set covers a
habit's whole history while the card draws one window — a habit whose only
qualifying run is months back showed the swatch over a grid carrying nothing.
Recomputing the window in `ui/detail.js` would be a second derivation and wrong
a second way. The count is set even when **zero**, so an absent attribute means
an old `charts.js`, and the gate reads it through `Number(...)` because `"0"`
is truthy.

**The strip's in-run tick reuses the ghost tick's `✓` at 0.45, and the two are
disjoint by construction** rather than by a check: `unansweredCounts` is true
only for a non-boolean at-most habit, where every unlogged day already IS a
completion and every logged day renders its number, so no cell is ever a
candidate for both. Same shape as the unreachable boolean branch above — state
it, do not add an arm for a case that cannot arise.

**A day before the habit existed was considered and declined, not lost.**
`.check.before-start { opacity: 0.35 }` was in the stylesheet and nothing ever
set the class. "Before the habit existed" is not a supported cell state — the
states are the four in the root `CLAUDE.md` plus the treatments above, and
`.check.today` is a column HIGHLIGHT rather than a day state. The rule was
deleted rather than wired up (#231), so it must not be "restored" by someone
assuming it regressed; dimming pre-start days is a legitimate future feature,
but it starts by setting the class. `shared/test/css-dead-rules.test.js` makes
re-adding one a deliberate act.

**Still open, on purpose.** Streak connectors drawn over an empty cell was
issue #176, addressed above — a different route (`inStreak`) from anything
else in this section, and it left `unlogged_is_success`'s own fill untouched.
It reached the calendar and the detail page's own strip first; #247 (below)
extends it to the dashboard's own day squares. Both Android grids (`DayGrid`,
the widget) still draw these days blank, and stay that way until a follow-up
ships them the same `/overview` streak ranges. The credit window's missing far
end is still issue #223, and it is not this one's to fix either.
`docs/decisions/day-states.md` has the long form.

**#247 threads the same run set into the dashboard's own day squares.**
`ui/dashboard.js`'s `habitRow` passes `streakDates(habit.runs, MIN_STREAK)` as
`dayCells`'s fifth argument — the same call `ui/detail.js`'s strip already
makes over `stats.streaks` — so the ghost tick above reaches a third grid with
no new renderer, only a caller that had been passing the `new Set()` default.
`habit.runs` rides on `/overview`: `summaryStats` already reads its `score`
and `currentStreak` off entries the route bounded to a fixed ~400-day window
anchored to today (`SUMMARY_WINDOW_DAYS`, not to the grid's own `end`), and
`runs` is that same `streaksFrom` array, clipped into the GRID window the
route is about to answer (its own `start`/`end`, never `summaryEnd`) instead
of the 1830-day scan `recomputeBestStreak` runs on a stale summary cache —
that scan would make the marks flicker between two loads of one page
depending on cache freshness, and a second, narrower entries read plus a
second `onPaceSeries` pass for a paged-back grid window was rejected too,
since a narrower window moves `onPaceSeries`'s own birth-gated leniency and
would put the dashboard at odds with the detail page about the same run. So a
grid paged back past the 400-day entries window shows no run marks for those
days, accepted rather than coded around, and each run's `length` on the wire
is the TRUE unclipped length, never the span visible in whatever grid window
clipped it.

**"No marks past the bound" needs the first `den - 1` days of the slice
suppressed too, and without that the boundary drew WRONG marks rather than
none.** `onPaceSeries` judges a day against the trailing `denominator`-day
window ending on it, so a day less than `den - 1` from the start of the walked
range is judged against a window missing history that really happened — with
#340's leniency correctly withheld, because the range opened at the slice's
edge and not at the habit's birth. Measured on a 3x/7 habit kept perfectly for
500 days: the 400-day slice reported its own first fortnight as a 4-day run,
then a ONE-DAY HOLE, then the real run, where the habit's own page reports one
unbroken 499. Drawn, that is a blank square mid-band on the dashboard while the
calendar strokes through the same day. `summaryStats` therefore floors the
`runs` window at `from + (den - 1)` whenever `from > birth`, so those days are
absent instead of wrong — `score` and `currentStreak` are untouched, both being
read at the range's far end where nothing is truncated. The read of
`freq_denominator` that needs sits INSIDE the `runs` branch, because
`stats.test.js`'s counting-getter guard measures pass invocations through that
property and a third unconditional read would stop it meaning what it says.

**A `.check` cell SAYS its state, because the glyph alone lies — and the
`aria-label` goes on the BOX, never on the button.** A button with no label of
its own is named from its contents, so before this the dashboard announced
`"✓ S"` for an in-run day nobody had logged: the app stating a habit was done
on a day it was not, with `questionMarks` on or off. The faint tick and a solid
one are one character. `paintCheckbox` therefore labels the `.check-box` in the
SAME branch that decides the glyph — `says()`, and `ghostTick` takes the state
as an argument — which is what keeps a glyph from disagreeing with its own
description; a `describeDay()` mirroring the branch order would be two
functions over one set of inputs, which is the drift this project keeps paying
for. Labelling the box rather than the button is what preserves the weekday
letter in `.check-day` as part of the computed name, and it is also the only
option available: `dayCells` paints the box BEFORE `btn.append(box, day)`, so
the button is not reachable from there. The vocabulary is Android's
`describe()` (`ui/DayGrid.kt`) rather than a second one — "counted as kept, no
entry", "no entry", "done", "not done", "clean", "slipped, N unit", "N of M
unit" — plus the two in-run states, which Android will need when #247's other
half lands. `gridcheck.mjs` reads the COMPUTED name over CDP
(`Accessibility.getPartialAXTree`, the same shape `categorycheck.mjs` uses) and
not the attribute, and asserts the name is PROSE rather than the raw glyph:
with the label dropped the name falls back to `"✓ T"`, which still differs from
a logged cell's name and still contains no "done", so neither of those two
checks catches it and a third one has to.

**The box carries `role="img"` with that label, and the reason is that a bare
`<span>` is `role=generic` — the one role ARIA 1.2 lists `aria-label` as
PROHIBITED on.** It is the only label in this directory that sits on anything
but a `<button>`, an `<input>` or an `<svg>`. Chrome honours it regardless:
every accessible-name check in `gridcheck.mjs` passes with the role removed,
measured, so nothing this fleet can observe holds it and a later reader looking
only at Chrome would be right that it changes nothing — on Chrome. Whether a
prohibited label still contributes to an ANCESTOR's name-from-contents is
engine-specific rather than specified, and this app installs as a PWA onto iOS;
dropped there, the cell falls back to announcing `"✓ T"`, which is the whole
defect, silently, under a green suite. `img` supports naming, replaces the
glyph with the name instead of sitting beside it, and still contributes to the
button, so the weekday letter survives. `paintCheckbox`'s reset clears the role
with the label, since a box left `img` with no name is an unnamed image rather
than a plain span. The attribute assertion in `gridcheck.mjs` is deliberately
NOT behavioural, and says so at the check: it is the one thing here a Chrome-only
fleet cannot prove.

**A measurable day names the goal the SHADE is measured against, and names none
when the habit has none.** `parseHabit` accepts `target_value: 0` in either
direction, and the two mean different things: on a LIMIT it is a stated goal
("at most none" is the point of such a habit) and is both shaded and spoken,
while on an at-least habit it is the ABSENCE of one and the `|| 1` in the ratio
is a divide-by-zero fallback rather than a target anybody set. Spoken from
`habit.target_value` the cell announced `"8 of 0 pages"`; spoken from the
fallback, `"8 of 1 pages"` — an internal detail promoted to a claim. So that
one case says the amount alone, and every other reads the same binding the
shade did. Two readings of one field six lines apart is exactly the drift
`says()` exists to prevent, met inside `says()`'s own branch.

**The run set is exactly as stale as the rest of the row it draws.** It is the
one `/overview` last answered with, so an offline tap that turns a day into a
stored 0 keeps drawing that cell's in-run tick until the next load corrects
it — the same acceptance `ui/detail.js`'s `stripRuns` already states for the
strip. `shared/test/browser/gridcheck.mjs`'s "clearing a skip while offline
repaints the cell" case is the worked example.

## Amounts

**An amount is parsed — not asked for with `prompt()`, and not typed into
`<input type="number">`.** The dashboard asked with `window.prompt()`, which
blocks the event loop, cannot show a unit or a target, and is suppressed outright
by a browser that decides the page makes too many dialogs. `type="number"` is the
other wrong answer: it does not report what it cannot read, it filters the
keystrokes it dislikes and hands back whatever survived. Measured in Chrome
against the day editor's own attributes — typing `8,5` left `85` in the box, so
eight and a half was recorded as eighty-five, and typing `abc` left `''`, which
the day editor read as "no entry" and answered with a DELETE. The decimal comma
is the one that matters, because `inputmode="decimal"` is what shows it and most
of Europe's keyboards offer it; `HabitFormScreen.parseAmount` on the phone has a
comment about the same input.

So the box is `type="text"`, the day editor and the dashboard grid are both
`ui/count-field.js` over the rules in `ui/amount.js`, and that module owns the
reading — with the same three-answer convention `parseTimeInput` uses and the
same trap in it: `''` (empty — a delete), `null` (unreadable — say so, write
nothing) and a number, of which `0` is a real answer. Two of the three are
falsy, so callers compare with `===`. `parseAmount` is also stricter than
`Number()`, which `shared/CLAUDE.md` records as too generous about form —
`1e3` is not a thing anyone types into a box asking how many glasses of water
they drank. The dashboard keeps its own write path — `recordValue`, which
paints before awaiting, because offline `api()` queues the write and THEN
throws.

**A third typed-amount surface is deliberately not a `count-field`.** The habit
dialog's Target box is a GOAL, not a day's amount, and `stepFor(goal)` plus a
preset offering the goal back are both meaningless in the box where the goal
itself is being typed — so it is a plain `type="text"` box straight over
`ui/amount.js`, asking `count-field.js`'s exported `convention()` so there is
still one answer to the decimal-point question rather than a second guess at
it. `readTarget` (`ui/habit-dialog.js`) is the reader, and two decisions about
it are not obvious from the code alone.

**A target is an AMOUNT wherever it is WRITTEN DOWN, and that rule reached
four surfaces one at a time.** `targetLabel` spells the number through the
caller's `showAmount` — `formatAmount` bound to `convention()` — so the detail
head and the dashboard row read `≥ 8,5 pages` on the same account whose Edit
box holds `8,5`. It is passed IN rather than looked up, because `ui/dates.js`
has NO imports, and DEFAULTED to `String`, because `shellFirst` can serve one
boot this module over a cached older caller and that boot must show an
old-looking label rather than throw in `render()`.

**The FOURTH surface is not a `targetLabel` caller and needed the rule
separately**: the day editor's subtitle says the direction in words (`target
at most 8,5 cigs`), so it had its own template literal and read `at most 8.5`
four lines above a box holding `8,5`. That makes the same
`formatAmount(n, convention())` one-liner declared in three modules, for the
reason it was already in two — a helper either could import would be a new
export under `shared/public/`, and that is a `CACHE_VERSION` bump.

**Two suites pin it and they pin different halves.** `daydialog.mjs` hands the
formatter in with every other free identifier, so it pins the PASS-THROUGH and
cannot see which formatter the module ASKS for — `convention()` replaced by a
literal `'point'` passes every case in it, typecheck clean, measured. The
WIRING is `countcheck.mjs`'s comma section, which opens the day editor on a
`comma` account with a fractional target and requires `#day-sub` to end
`at least 9,5 pages` and hold no `9.5`.

**The target box submits what was typed; an untouched box submits what was
stored.** Typing runs through `parseAmount`, bounded to `[1e-6, 1e12]` and
quantised to six places exactly as a day's amount is; leaving the box alone
submits the stored `target_value` verbatim, whatever it is. A target has never
been bounded server-side — not in `parseHabit`, not on the phone, not on any
import path — and `PUT /habits/:id` REPLACES, so inheriting the day amount's
domain whole would let a colour-only edit quantise a stored `3.14159265`, and
would make a habit whose target sits outside that domain unsavable over a
field nobody touched, with no in-domain spelling to retype it as. This changes
what no stored row means, which is why it needed no further approval than the
one it already has.

**A refusal is gated on the target box being ON SCREEN, not on the parse.**
Mistype the target, decide the habit is Yes/No after all, and press Save: the
box lives inside `.numerical-only`, which `syncTypeFields` hides the moment
Type stops being Measurable, and hidden, a complaint would land in a hidden
span while `focus()` landed on a hidden input — the dialog would just stop
saving with nothing visible saying why. A refusal nobody can see is not a
refusal, so hidden and unreadable, the stored target stands instead.

**An empty Target box still means a habit with no target — 0 — not a
delete.** That is what `Number(f.target_value.value) || 0` meant before this
and what `parseHabit` stores for one; it is deliberately not the day editor's
empty box, which is a DELETE, because there is no row here to delete.

**A refusal has to be actionable, and what it QUOTES has to be true of what it
quoted.** `parseAmount` refuses `10,000` as ambiguous; `amountComplaint` names
the AMBIGUITY, which is the same whatever the digits are, and carries the
specifics in the advice — the user's own number with the commas taken out. Naming
the reading is what made the first version false (`1,500` was told it might be
ten thousand). The suggestion is run through the parser before it is offered, and
it decides the whole branch: `1,500 steps` is not ambiguous, it is not an amount,
and a box may not suggest something it would then refuse. It lives beside the
parser rather than in the view, because the phone and the web must not tell
somebody to type different things about the same input.

**Which character a decimal point is, is a DECISION with a device-shaped
default.** `numberFormat`, whose `auto` resolves against `Intl` at parse time in
`resolveNumberFormat`'s three tiers: the account's stated answer, else the
device's, else the app's. It is passed IN rather than looked up, because a
DOM-free module has no business reaching for a settings cache or for `Intl`. Only
a three-digit group depends on it (`10.000`), which is why the default costs no
existing caller anything — and a group is refused under **every** convention, so
the setting only moves which spelling is refused, never what is accepted, because
most accounts are on `auto` and a wrong guess that accepts costs a row out by a
thousand that nothing reports. `formatAmount` takes it too, and groups at no
size, so the control's output stays inside its own parser's domain.
`docs/decisions/amounts.md` has the argument.

`count-field.js` asks the settings cache and `Intl` at each read or write, never
at import time — either can change while the module is loaded.

**`ui/amount.js` is imported by `shared/src/discord.js`**, the one import
reaching from `src` into `public`. "DOM-free so it can be tested without one" is
now a contract with a server: a Discord modal is the same box arriving over a
socket, and its own comma-to-dot `Number()` read `10,000` as **ten**.
`docs/decisions/amounts.md` has the direction, and why it is not the usual
two-declarations-and-a-test.

**The step comes from the goal rather than being 1** — an eighth of the target,
snapped to a round number, because 1 is right for "8 glasses" and useless for
"10,000 steps". `test/browser/countcheck.mjs` follows a tap all the way to
storage, which is the only thing that can catch the control and the database
disagreeing about what was typed.

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

**There are THREE fragment routes — `#/habit/<id>`, `#/categories` and
`#/category/<id>` — and NAVIGATING into a stack two of ours deep is still
unreachable.** `ui/routes.js` keeps `ourEntry` as a single boolean and
`go(LIST)` unwinds with one `history.back()`, so neither can describe a stack
two of ours deep. Nothing in `routes.js` enforces that; three rules in
`ui/categories.js` do, and they are why the single boolean is still honest.
**Neither category view links to a habit** — the comparison names `best` and
`worst` as text and a category's own page names its whole roster the same way,
and not one of them is
an `<a>` or a `<button>`, because dashboard → categories → habit would be two
entries of ours and Back from that habit lands on `#/categories` with the
dashboard painted underneath it. **The top-bar button is hidden whenever a
habit OR a category's own page is open** (`syncEntry`, which reads
`state.openHabitId` and `state.openCategoryId`), which closes the same hole from
the other two sides: no habit can sit UNDER the comparison, and
dashboard → category → categories is unreachable. And **a category's own page is
entered only from the dashboard's grouped section header**, never from the
comparison, which offers no way into one. One invariant, three rules, paid at
four sites — the spread, the roster, and each of `syncEntry`'s two view clauses.
Weakening any of them means teaching `routes.js` a real stack first (issue
**#348**), and none of them is a tidiness rule.

**Be exact about what "unreachable" covers, because a RACE is not a
navigation.** The three rules bound what a user can navigate into; they say
nothing about a request that was already in flight when a second view opened.
An older reply landing then renders over whatever is showing and writes its own
URL through `go()`, which pushes — so open a category's section header, then a
habit, and if the habit wins the race `#/category/3` is pushed on top of
`#/habit/42`. Each view holds a ticket over its OWN requests (`openSeq` in
`ui/categories.js`, which covers two section headers pressed inside one flight,
and `ui/detail.js`'s, which covers that view's own callers of `open()`), and
neither can see the other's, which is why the cross-view case is the one left.
It is pre-existing rather than something the third route introduced, and it is
**#348**'s to close with a counter above both views — do not read the paragraph
above as a claim that it cannot happen.

**And `go()` must not be made to REPLACE for any of them.** It looks like the
one-line answer to the same problem and it is not: on Android a same-document
open counts an entry in `WebBackStack.floorAfterShow`, so replacing leaves
`currentIndex` AT the floor and the next system Back closes the screen out from
under the user rather than reaching the dashboard.
`android-native/CLAUDE.md` requires all three back-stack rules re-read together
and checked on an emulator whenever `go()` changes, and records that every wrong
version still passes `WebBackStackTest`. `routecheck.mjs` pins the push at
exactly one entry and Back returning to the dashboard, which is the browser half
of it only.

**"Is the dashboard what is showing?" is `dashboardShowing()` in
`ui/store.js`, and it is never spelled out a second time.** Eight guards in four
modules ask it — `app.js` twice (which view a traversal lands on; whether the
browser reminder may reload the list), `dashboard.js` four times (the
`'change'` listener, the `matchMedia` reflow, the day-change refetch, and the
guard on opening the day editor over the list), `settings-dialog.js` once and
`habit-dialog.js` through its own `announce()` — and until `#/categories`
existed every one of them could write `state.openHabitId == null` and be right.
A second full-page view made that spelling wrong at all of them AT ONCE, and the
two that were missed on the first pass are why this paragraph exists: the
breakpoint reflow painted the dashboard over the comparison **on a phone
rotation**, and the habit dialog's `'reload'` did the same on Save. Neither is a
`routes.js` question — the URL is already correct in both — so do not go looking
there.

**The third view arrived (#259) and it is the one function that changed.**
`#/category/<id>` is neither the comparison nor a habit, so it has no id of
theirs to give it away: `state.openCategoryId` is its flag, mutually exclusive
with `openCategories`, and the predicate gained one clause while every guard
above was left alone. That is what the sentence this paragraph replaces promised
and it held. A FOURTH view means the same edit and nothing else — and the same
discipline on the way in: every view that paints sets all three flags
explicitly (`paint()`, `detail.js`'s `render`, both of `ui/categories.js`'s),
because a flag left set is the dashboard silently declining to repaint itself.

**A dialog does not know which view it was opened over, so it announces rather
than navigates.** `'reload'` means "go to the dashboard and fetch it"
(`ui/store.js`), which is right only when the dashboard is what is showing;
`'change'` is what every other view answers by refetching itself in place.
`#btn-new` is in `auth-session.js`'s `SIGNED_IN_ONLY` and nothing hides it per
view, so the habit dialog — and with it the in-place category manager — opens
over a habit's own page and over the comparison as readily as over the list.
Its four category mutations emitted `'reload'` unconditionally, which is how
**adding a category while editing a habit dropped the user on the dashboard**;
`announce()` is the one rule now. The three emitters that stay unconditional
are the ones where going home IS the answer: a habit deleted, a habit restored,
and a create whose request was abandoned. Note what the modal hides: nothing
repaints behind it, so the view that was pulled out from under it only becomes
visible when the dialog closes — which is why a suite that opens and closes
this dialog a dozen times never saw it, and why `categorycheck.mjs` now asserts
the URL as well as the visible view (measured against the unfixed code, the
`history.back()` inside `paint()` landed on ANOTHER habit's page, so
`#view-detail` was still showing and only the fragment gave it away).

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

**A request the app makes is bounded** — 10s, in `ui/api.js`, the worker's
`networkFirst` and the worker's `shellFirst`, taken from `Api.kt`'s
`connectTimeout`. Chrome imposes no ceiling of its own (measured still pending
at 300s). `shellFirst` awaits the network before consulting a cached copy one
line below it, so unbounded it is an installed PWA that opens to nothing
rather than one showing a stale shell — missed by #93, which bounded only the
worker's API half. The exemption is about REPLAYING, not latency, and it is
`ui/api.js`'s alone: aborting does not recall a request the server has begun,
so everything it bounds has to be safe to arrive twice, and `POST /habits` is
the one call on this path that is not. Import, export and the notify test
bypass `api()`. Nothing in `sw.js` needs the exemption — only GETs reach the
worker, so there is nothing there a retry could duplicate.

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

**An emit may carry ONE thing the mutator already has, and it stays a hand-off
rather than a second channel.** `emit(event, what)` passes it to every
listener, nothing is stored, and every listener must be right when it is absent
because most emitters send nothing. The one emitter is `habit-dialog`'s
`announce`, handing on the reply to `PUT /habits/:id` so a habit's own page can
redraw its head from what was STORED instead of showing the pre-save habit for
the length of two round trips — and the Edit button behind that dialog captures
the habit it was drawn from, so that window was a press away from reverting the
save (`PUT /habits/:id` REPLACES). The refetch still happens; the seed is an
early paint of the same fact, and a field on `state` was refused because it
would outlive the emit and be a second source of truth for the habit.

**A view that seeds must refetch through `refresh`, never `open` — what
overwrites a seed cannot be allowed to be OLDER than it.** `ui/detail.js`'s
`'change'` listener bypassed that guard, and the seed is what made it reachable:
it puts the stored habit in the Edit box, so a second save inside the first
refetch became two ordinary presses, and two `/stats` replies land in whatever
order the server answers them. The older one landing last redraws the head from
the pre-second-save habit and re-arms the same revert, with nothing left to
correct it. `refresh` runs one at a time and remembers the one that arrived
mid-flight, so the last request is always issued after the last write; a stale
reply can still flicker past on its way, which is a different (and much
smaller) claim than the page settling wrong.

**That flicker was the visible half of a race `refresh` cannot reach, and it is
a TICKET on the request that closes it — `openSeq` in `ui/detail.js`.** It was
never purely cosmetic: while the stale render is on screen the head's Edit
button is holding the pre-second-save habit again, which is the same revert on
a one-round-trip window. And the narrow fix the earlier note reached for —
discard a reply issued before the last seed — would have been scoped to the one
path `refresh` already serialises. **The eight other callers of `open()` are
not serialised at all**: `changeZoom`, three segmented controls (the strength
card's granularity, and History's granularity and mode) and the four cards
whose `redraw` refetches — score, history, weekday-by-month and frequency.
History's granularity is the reachable one, and the ONLY one, because it alone
issues DIFFERENT urls (`?granularity=`); the other seven send the identical
request, so a reply landing out of order renders the same payload against
current state. There, the older reply landing last SETTLED the page on week
buckets under a control reading month.

So the ticket sits on `open()` itself and answers both, and **`seed` bumps it**
— an optimistic write of the thing the ticket protects, with no read of its
own, exactly as `moveCategory`'s splice is, and the half without which the
`refresh` path stays open (nothing NEWER takes a ticket there, because
`refreshAgain` coalesces). `load()` (`ui/dashboard.js`) has the same shape and
the same defect and takes its own, `loadSeq`, over `habits`,
`categorySummaries`, `gridLoaded` and `loadedDay` — the fields
`state.categoryReadSeq`'s own note calls unticketed because no category writer
can be newer than the reply, which is true of a category writer and not of a
second `load()`. **Three counters, one mechanism, three questions**: sharing
one would let a habit-dialog open (which bumps `categoryReadSeq` through
`refreshCategoryPicker`) discard a dashboard load or a habit's page.

**A superseded reply is DISCARDED, and `open()`'s boolean was narrowed rather
than given a third state.** It reports whether the habit ANSWERED, so `false`
means only that the request failed — which is precisely what its one reader
asks (`app.js`'s boot falls back to the list for a deep link naming a habit
that will not open). A discard is not that: whatever superseded the call owns
the screen. The values the function can return did not move, so a shell serving
one version of `detail.js` over a cached `app.js` behaves the same either way
round. `load()` needed none of this — no caller reads its result — and its
superseded reply still `paint()`s, because a paint reads current state and can
only re-confirm what is there.

**A module owns its subtree, and `test/ui-modules.test.js` enforces it.** No
element id may be reached for by two modules; `ui/views.js` exists because
`#view-list` and `#view-detail` genuinely have three claimants. The same test
walks the imports from the entry point and fails when `SHELL` in `sw.js` has
fallen behind — with twenty-six modules where there was one, a hand-maintained
precache list drifts silently.

## Traps

**A text box added inside a dialog's `<form>` inherits Enter, and Enter means
that form's submit button.** The habit dialog manages the account's categories
in place, so its "New category" and rename boxes sit inside `#habit-form` —
where Enter closed the dialog, WROTE THE HABIT, and dropped the category that
had just been typed, inventing a whole habit from the form's defaults on the
create path. Nothing said so: `saveHabit` succeeds on its own terms and
`#category-hint` is written only by the category handlers. `enterPresses`
(`ui/habit-dialog.js`) routes the key to the button beside the box rather than
calling `preventDefault` alone — a box where Enter does nothing is its own bug
report. Ask this of any control added to a sub-form of a dialog next.

And pinning it needs a REAL key event: implicit submission is the browser's
own behaviour on a trusted keypress, so a `new KeyboardEvent('keydown')` from
script does not trigger it and a test built on one passes against the
unguarded code. `categorycheck.mjs` drives CDP `Input.dispatchKeyEvent`.

**The emoji picker is an ADDITION to the icon field, never a replacement, and
`icon-field.js` is the sole owner of every `#icon-*` id.** The field stays a
real, editable `<input name="icon">` because the OS picker lands its choice
there, a paste is how an uncurated emoji arrives, and `parseIcon` accepts any
grapheme a ~200-entry list will never hold. A cell's click writes THE TEXT OF
THE FIELD and nothing else — no hidden input, no module-level "selected" glyph
— because a preset arriving with #66 tier 2 has to be a *different field*.
`previewIcon` is a SECOND DECLARATION of `parseIcon`'s derivation (`shared/src`
is not served here), pinned behaviourally by `test/icon-field.test.js`, and it
decides what is DISPLAYED and nothing about what is STORED.

Five rules about the panel, each of which shipped wrong once. The search box is
inside `#habit-form`, so it is the same Enter trap as the category boxes above
— Enter picks the first matching cell and calls `preventDefault()`. **Escape
closes the PANEL, and `preventDefault` is the load-bearing half, not
`stopPropagation`**: a `<dialog>`'s Escape-close is the keydown's own default
action rather than a bubbling listener. **That handler is bound to the DIALOG,
guarded on the panel being open** — bound to the panel it never runs for a
mouse-opened picker, where focus is still on the toggle. **It may not restore
focus unconditionally**: it asks `els.panel.contains(activeElement) ||
activeElement === els.toggle`, and asks BEFORE `closePanel()`, since hiding a
subtree blurs what is in it. **A press outside dismisses, and the TOGGLE is
excluded** — unexcluded, one press is two state changes and the toggle can
never close. And **the grid is built on the first picker open, keyed on
`gridQuery`** — the QUERY, not "has this been built", or a session closed
mid-search reopens filtered.

Two things about pinning any of it: the dismissal and the focus cases need REAL
CDP mouse presses (a scripted `.click()` dispatches no `pointerdown` and does
not move focus), and the field's hint is `aria-describedby` rather than a
wrapping label — a hint that is nobody's child reaches no assistive technology
at all. `docs/decisions/icons.md` has all five in full, with the measured node
counts and the accessibility-tree readings.

`#icon-picker`'s `hidden` state and `#icon-search`'s value are static markup,
wired once by `initIconField()`, so `iconField.set()` resets both on every
dialog open — otherwise a panel left open and filtered in one session is still
open and still filtering for a *different* habit the next time.

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

**#132: `formatDayRange`'s ja-JP/zh-CN mismatch against the day dialog's long
date stays as it is — a decision, not an oversight left open.** The dashboard's
range and the day dialog's single long date legitimately format the same day
differently in those two locales, because both are `Intl`'s own correct answer
to two DIFFERENT questions (a two-ended range versus one long date) asked at
each surface's own granularity — unlike the Gregorian-field bugs above, where
both readings were answering the SAME question and one of them was simply
wrong. Overriding one to match the other means hand-picking a format for
languages neither of us reads, which is exactly what `formatDayRange` exists to
avoid needing. See the comment at `formatDayRange` in `dates.js`.

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

**#132: `estimateTextWidth` no longer bills a combining mark twice.** The sum
walks `solid` (the non-mark code points) as the rate-table choice already did,
so a mark costs nothing beyond its cluster — what the doc comment always
claimed. This makes some estimates SMALLER, the dangerous direction, so
`WIDTH_SAFETY` was re-measured rather than carried over
(`shared/test/label-widths.mjs`) and is safe only because #131 had already
raised `LONE.indic` from ~1.0 to 1.7 — the mark-billing this removes was
covering for that OLD rate, not for a property of marks.
`docs/decisions/dashboard-and-detail.md` has the numbers and why the two
changes are coupled.

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
`weekcheck.mjs` in ten locales chosen for a PROPERTY each rather than for
coverage. **It asserts the locale actually took**, because ICU falls back
silently and ten runs of en-US report ten passes. `weekcheck` is in there
because a LAYOUT is locale-shaped too: the row gutter's ceiling binds in ten
locales at 328px and in none in English.

**A chart's labels and its data have to be asserted TOGETHER.** `weekcheck.mjs`
exists because a review broke the week-start plumbing four ways at once and the
whole unit suite and every browser suite still passed — the arithmetic was
covered and nothing looked at a rendered chart. The failure that matters is not
"the wrong day is first", it is a caption and a datum moving independently,
which reads as deliberate. Note where each half is pinned, because the split is
forced rather than chosen: `weekcheck.mjs` is OFFLINE and covers the labels and
the pairing, while **Home/End is in `feat4.mjs`, in a real browser**, because
that handler needs a `keydown` listener and `dataset` the fake DOM does not
have — a first version of `weekcheck` claimed to cover it and did not. The
month chart needs BOTH its tooltip and its drawn caption asserted: they are
built from different arrays.

**Charts with a time axis page rather than shrink.** `slot = width / count`
silently squeezes bars to hairlines once a habit has a year of daily data.
`ui/window.js` decides how many columns fit from a minimum per-column width,
and `windowedChart` in `ui/components.js` adds the ‹ Earlier / Later ›
controls. Paging
strides by one less than the window so a column of context is shared between
screens — `test/window.test.js` asserts no column is ever strandable.

**`columnsForWidth`'s `reserved` is the CALLER's own non-plot width, and a
chart whose gutter is MEASURED must pass its own (#285).** The `46` default is
not a general-purpose figure — it is `scoreChart`'s and `historyChart`'s own
`pad.left + pad.right`, which is why those two pass nothing.
`weekdayMonthChart` measures its `pad.left` from the account's localised
weekday names, so it is the one caller that passes its own
(`weekdayMonthReserve(width)`). Handing `columnsForWidth` a reserve narrower
than the real gutter computes a column count for a plot area wider than the
chart has, and the per-column width falls below `MIN_SLOT` — the floor the
function exists to enforce. **`frequencyChart` is the trap this generalises
to**: it calls `gutterFor` too and still takes the default, because its
capacity (`density: 60`) is a vertical ROW count and a horizontal gutter
cannot constrain rows — calling `gutterFor` is not by itself a reason to pass
`reserved`. Do not widen the shared default for one caller instead: a reverted
`Math.max(46, …)` version cost `score` and `history` ~30% of their columns at
every width and locale, to fix a defect neither had.
`docs/decisions/dashboard-and-detail.md` (#285) has the figures.

**Connectivity needs more than the `online` event.** That event tracks the
network interface, not the server, so a restarted server left the app stuck
offline until a manual reload. `watchConnectivity` re-probes on
`visibilitychange` and polls with a backoff *while offline only*, and it
reports transitions rather than polls, or reconnecting would re-render the
dashboard every few seconds. That leaves it blind to the outage it is most
likely to meet, so it takes an input too: `reportOffline`, called by
`ui/api.js` when a write has to be queued. It must come in through there rather
than as a `setOffline` from outside, or the watcher's `last` stays `true` and
it neither polls nor reports the transition. See
`docs/decisions/connectivity.md`.

Once it HAS said so, `api()` stops asking: a write finds `state.offline` true
and goes to the outbox without opening a socket, so the first tap pays the 10s
bound and every tap after costs ~100ms. A GET still goes to the network, since
the worker may hold a cached copy and stale beats blank.

**The write is staged BEFORE the attempt.** `enqueue` returns its `seq`,
`api()` holds it for the length of the fetch and `unstage`s it the moment any
answer arrives — on ANY response, not just a good one, since leaving it staged
on a 5xx turns every failed write into a silent retry. That closes the window
the bound only shortened: a check-off used to exist solely in a promise between
the tap and the fetch settling, and closing the tab lost it from the outbox and
the server alike.

**The predicate is `replayable()`, and it names one question — is this write
safe to arrive twice?** Three rules turn on it (what may be staged, what may be
pre-empted, what may be queued on failure), all three end in a replay, so all
three read one function. `POST /habits` is the only write that answers no, and
it is **bounded but never queued**: aborting a create the server has begun and
replaying it is two habits, but not bounding it only made the dialog spin while
the create may or may not have landed. Abandoned and reported as *indeterminate*
is the honest shape. It is excluded by the same `bounded()` predicate as the
timeout, not a second opinion about the same call.

**`POST /categories` is replayable even though it also yields a second row on a
literal reading** — the rule is not "any create is fine to replay". A second
attempt cannot succeed *silently*: the account's own name is unique, so a
staged write landing twice is refused as a duplicate and the outbox drops every
4xx as permanent. `POST /habits` has no name uniqueness to fall back on. Do not
relax the duplicate-name check on that route without re-reading this — it is
what keeps the write safe to stage and replay at all.

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

**And `raise` must be able to SEE that it has already run, or the cell it
raises stops being clickable at all.** It moves the hovered cell to the end of
its parent and then its MARKS after it — the `?` glyph, #297's note dot — so
the obvious early return, `parent.lastElementChild === cell`, is one a cell
carrying a mark can never satisfy: `raise` itself put the mark last. Every
event therefore re-appended the group, a re-append blurs the cell, `raise`
restores the focus it took, and the restore fires `focusin`, which raises
again. Measured on the unfixed build with a real CDP press on a noted day:
**2,066 `focusin`s and 66 `pointerover`s for one press, and no `click` at all**
— so the day editor could not be opened from any day carrying a note, or, with
`questionMarks` on, from any unanswered day. `alreadyRaised` walks the exact
end state `raise` builds — the cell, then its marks, then nothing — rather than
counting them or testing `lastElementChild`, either of which is satisfiable by
an arrangement `raise` would not have produced.

Pinning it needs a **real CDP mouse press** (the loop is driven by
`pointerover` and `focusin`, which a scripted `.click()` dispatches neither)
and the **negative half beside it** — the same press on a day with no mark — or
a press that opened nothing for an unrelated reason reads as this defect.
`calcheck.mjs`'s note-mark block has both. This is the root `CLAUDE.md`'s
own warning met exactly: drawing the dot and counting it on `data-note-marks`
was pinned, and said nothing about whether the day underneath could be opened.

**The search box is OUTSIDE `#grid`, and that is the whole design.**
`paint()` runs on every keystroke and rebuilds that subtree with
`replaceChildren()`, so a control inside it would lose the caret mid-word.
`data-focus-key` restores a control that IS rebuilt; the cheaper answer for one
that need not be is to not rebuild it — and `searchcheck.mjs` asserts a whole
word arrives with focus still in the box, because moving it inside `#grid` does
not fail a check, it makes the element unreadable.

Three rules travel with it. **The drag handle goes while a filter is on**: a
drop against a subset computes a `position` from neighbours that are not the
habit's. Note what is NOT the reason — `persistOrder` sends the FULL list, so
nothing is dropped from the write; what a drop against a subset gets wrong is
where in that list the habit lands. **The threshold reads the unfiltered
count** (and the box stays while it has focus), or it vanishes under the cursor
as a query narrows the list past it. And **the MUTATORS clear the query**, not
the `'reload'` listener — `'reload'` has ten emitters and only half replace
anything, so doing it there also wiped the box on Back from a habit and on a
background reconnect, mid-word.

**But a mutator clears it only when what it wrote would be OFF THE LIST, and
the question is `staysOnList` rather than `matchesQuery`.** Clearing on every
save wipes a filter that nothing replaced (edit only the colour, Save, Back).
A create need not match and a rename may stop matching — but **archiving**
touches neither matched field and removes the row anyway, because `load()`
fetches the active habits or the archived ones and never both, so the filter
alone left "No habits match that." over an archive that had just succeeded.
`staysOnList` is `archived` and the match together. `deleteHabit`'s
unconditional clear is that rule resolved in advance rather than a second rule;
`restoreHabit` asks it properly; `data-dialog` is the one real exception, since
a restore replaces the whole account.

Two things about its shape. It re-tests the MATCH rather than comparing the
name, because the filter reads the **description** too. And it is asked of the
**reply**, not the request — `parseHabit` clamps `description`, so a mention of
the query past the cut is in what was sent and not in what was stored. It lives
in `ui/store.js` beside `query`, because `dashboard` imports `habit-dialog`
already and a second copy of the rule was the alternative to a cycle. All four
clears are pinned in `searchcheck.mjs`; three were deletable in silence, and
the restore is the one whose removal left the entire browser suite green.

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
`SECTION_NOTICES` mirrors `SECTION_ACTIONS` — keyed by section, given the
draft, returning prose — and the one entry is "your last reminder was not
delivered", from `GET /api/notify/status`. It is *not* awaited by
`openSettings`: waiting would make every open feel slow to spare the one with
something to report, and offline the dialog would never open. What lands when
the answer does is **`paintNotices`, which repaints the prose and touches no
control**, and that is the whole of why a late answer is safe — a rebuild
tears every control out and takes a text field's focus and CONTENT with it,
since `change` never fires on a removed input. **Do not put the rebuild
back**; `test/browser/nudgecheck.mjs` holds `/api/notify/status` open, types
into the webhook field and releases it, so it fails if you do. It is
deliberately unhedged: an earlier version repainted only on a clean draft,
which is exactly the state nobody is in when they most need the sentence. The
notices read the **draft**, so switching a destination off clears its warning
immediately; pressing "send a test notification" re-asks, because a test is a
real delivery attempt.

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

**Saving a habit returns you to where the edit started**, and so does adding a
category from the same dialog. `habit-dialog`'s `announce()` emits `'reload'`
only when `dashboardShowing()`, `'change'` otherwise — see "A dialog does not
know which view it was opened over" under Routing. It cannot simply call the
detail view (the import cycle the store exists to break) and it cannot always
emit `'change'`, because on the dashboard that is a repaint from stale state
and a newly created habit would not appear. Deleting still goes home.

**...and the page it returns to is SEEDED from the save, not left to the
refetch.** `announce(saved)` passes the reply on and `ui/detail.js` redraws
from it synchronously, because the head's Edit button captures the habit it
was drawn from — so in that gap pressing Edit reopened the dialog on the
pre-save habit and Save from there wrote the edit back out. The seed is the
SERVER's answer merged OVER the habit the page holds, **never assigned
wholesale**: `unlogged_is_success` rides on the `/stats` payload and not on a
habit write, so assigning would drop it and a limit would lose its ghost ticks
until the refetch landed.

**The time picker's parser is mirrored in Kotlin.** `public/ui/time.js` and
`android-native/.../ReminderTime.kt` accept the same inputs and produce the same
`HH:MM`, because both clients write the same `reminder_time` on the same habit.
`test/time.test.js` and `ReminderTimeTest` pin the same examples on purpose — if
you add a form to one, add it to both. The two that catch people out: `12 am` is
00:00 while `12 pm` is 12:00, and an empty box means "no reminder" while
unparseable text is an error to report — the caller does different things with
them, so they are `''` and `null` rather than both falsy.

**A habit shown as something to avoid keeps the cycle and changes the
encoding** — see `shared/CLAUDE.md`'s "Day states and habit shape" for the
storage argument. What matters here: `valueForState` is the only thing that
differs (`done` writes 0, `no` writes `target + 1`), it is mirrored in
`Grid.valueForState` because a tap happens with no network, and `isAvoided`
asks all THREE questions — avoid, at-most, and MEASURABLE. Asking two of the
three put a habit somewhere it could not leave: boolean + at_most + avoid is
reachable from the form in one sitting, and a tap meaning done was then encoded
as 0, which `isCompleted` reads as NOT done for a yes/no habit.

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

