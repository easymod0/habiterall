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


