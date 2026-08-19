# Fragment routing and the WebView back stack

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**A view is named by a fragment, never a path.** `#/habit/42` is what the
native client opens to land on one habit's stats, and it is a fragment because
that reaches the server in neither edition: no static-serving change, no
service-worker navigation rule, nothing to teach a build step that does not
exist. `shared/public/ui/routes.js` owns it, and two rules in `go()` are load
bearing — writing nothing when the URL already says this (`detail.open()` is
re-entered by every zoom and paging control, so the alternative is a dozen
history entries per habit), and pushing a habit while the list replaces (Back
already goes home). Note the Android WebView and a browser then disagree, on
purpose: a cold deep link leaves an entry a browser's Back walks into, while
WebView's own back skips an entry pushed without a user gesture and closes the
screen — which is what returns you to the native list you tapped from.

**That agreement is a coincidence of the list being short, and the native client
has to keep it one.** `canGoBack()` closing the screen only works while the
habit's document sits at the BOTTOM of the back-forward list, which it did for
free while the WebView was built on the tap and destroyed on the way out. One
WebView for the whole activity ends that twice over: the warm-up's `about:blank`
is a real entry underneath, and `routes.go()`'s push is a real entry above —
added by the page after the load committed, so nothing the native side measures
before the load can count it. Both together turned the first Back press into a
walk to a blank screen — `about:blank`, because WebView skips the gestureless
push and lands under it. `WebBackStack` (android-native) is the rule now, and it
is three, because the ways in are not alike. A document load is fenced by
truncating the list once it commits, which restores the shape the per-tap WebView
had rather than teaching the native client how many entries a page pushes; the
truncation hangs off `doUpdateVisitedHistory` and not `onPageFinished` because a
FAILED load's error page commits after the latter has run, so there is nothing to
truncate yet and Back walked off the screen for the second reason. A habit opened
over the dashboard pushes, and is fenced by counting the one entry it adds. And a
habit opened over another habit **replaces** — the one place this client speaks
JavaScript (`location.replace`), because `loadUrl` cannot, and because
`routes.go(LIST)` reaches the dashboard by unwinding the entry it pushed. That
unwind assumes the entry underneath a habit is the dashboard, which a stack of
native taps quietly falsified: the page's own "← Back" walked to the habit viewed
before this one, and the list grew for as long as the app stayed open. Change what
`app.js` writes to history during boot, or what `go()` does to reach the list, and
all three have to be re-read.

All of it was verified on an emulator rather than argued, which is worth keeping
up: every wrong version of this still passes `WebBackStackTest`, because the unit
tests pin arithmetic and every bug here was in the *premise* — which entry the
load lands on, and when it lands there.

**A deep link does not paint the list on its way.** `start()` used to load and
render the dashboard and only then open the habit, so a link straight to one
showed a full grid of every habit for as long as the stats request took and
then replaced it — a flash of the wrong screen, on the native client's most
used path in. The boot now opens the habit alone; nothing else needs the list
(`state.habits` is the dashboard's), and Back reloads it. Two things keep it
honest, and both are the reason this is written down rather than obvious: the
URL still moves through the list (`routes.go(LIST)` before the habit is
opened), because that is the entry Back returns to; and `detail.open()` reports
whether it rendered, because a habit that will not open would otherwise leave
the app showing nothing at all. `routecheck.mjs` pins the flash with a
MutationObserver installed before the app boots — it lasts one request, which
is less than a devtools round trip, so it cannot be polled for from outside.



**A reminder is the strongest deep link in the app, and for a long time it was
not one.** `#/habit/<id>` shipped for the native client's list, was reachable by
bookmark, and was then not used by the two surfaces that name exactly one habit
and ask about exactly one day: `ntfyPayload`'s `click` and `discordPayload`'s
`embed.url` both pointed at the site root. Tapping a reminder landed on the
dashboard with the habit still to find — the complaint this whole file exists to
answer, arriving from the one place that already had the id in hand. `appLink`
(`shared/src/notify.js`) is now the single answer for both, and issue #216's
scoping comment is where the decision to do both channels together was made:
leaving one on the root is a difference nobody chose.

**It is a mirror rather than an import, and the reason is a typecheck.** The
obvious version imports `hashFor` and `parseRoute` from `ui/routes.js` and round
-trips the fragment through the app's own parser, which would make the builder
and the parser agree by construction — the property `usableAppUrl` was rewritten
to have. It was written that way first and reverted. `notify.js` is allowed to
reach into `shared/public` for `ui/toggle.js` because that module is DOM-free by
construction; `routes.js` is DOM-free only *at import time*, which is a weaker
claim and not the one tsc checks. `go`, `current` and `init` read `location` and
`history` and register on `window`, none is reachable from the server, and
`npm run typecheck` still fails with thirteen `Cannot find name` errors — the
server project has `lib: ["ES2023"]` and no DOM, deliberately, and widening it to
silence this would hand every server file `document`.

So it is two declarations pinned by a test, which is what this repo does
everywhere else the browser and the server must agree (`CHANNELS`,
`SETTING_VALUES`). The test is behavioural rather than a source-text guard: it
builds a real link and feeds its fragment to the real `parseRoute`, over a range
of ids, so a renamed binding or a `>=` for a `>` fails it.

**The bound is `Number.isSafeInteger(id) && id > 0`, both halves load bearing,
and the fallback is on a path anybody can press.** `sendTest` builds its
stand-in habit with `id: 0` in both editions — `parseRoute` refuses a
non-positive id, so a test notification would otherwise carry `#/habit/0`.

The assertion that made this checkable is narrower than the obvious one, and the
difference was found by mutation rather than by reading. Asserting where a
refused id ROUTES is not enough: `#/habit/1.5` routes to the dashboard, so a
builder guarded on `habitId > 0` alone passes a route-only check while shipping
a notification whose link names a habit that does not exist. The test asserts
the fragment is **absent**. Before that change the hand-written-bound mutation
passed all 104 tests.
