# Testing infrastructure

The measurements behind the browser-suite rules in the root `CLAUDE.md`. The
operative rules live there; what is here is how each number was arrived at, and
the bugs that produced them.

## `themecheck` and `themesync` were one file

They were a single 1,042-line suite whose name described a seventh of it: 13 of
its 47 assertions are the palette not being frozen into an SVG at draw time, and
the other 34 are the settings-durability model — the migration off
`localStorage['habiterall-theme']`, the reconcile between this device and the
account, a dialog choice beating an unconfirmed press, the outbox, a write that
never answers.

The theme is merely the only setting with both a pre-setting home on the device
and a record of a press, so it is where that model is reachable. Rename the
setting and every block in `themesync` is unchanged — which is the argument for
the split, and for the name.

The blocks are deliberately NOT merged into shared setups. Several look like
near-duplicates and pin different halves: the record's FORMAT against the
behaviour a reload shows, a write abandoned against a write refused. Each has a
version that passes while the other fails, which is exactly what a shared setup
would hide.

## Wait for the app, never for a duration

Measured on the personal edition: a boot is ready in **52–95ms**, and the
settings reconcile it performs lands within **7ms** of that, because `start()`
awaits `settings.init()` before it renders. So a rendered dashboard is downstream
of the whole of it — and it holds under a stubbed-out `/api/settings` too
(49–67ms, *faster*).

`themecheck` carried 26 fixed sleeps of 1.2–3s against that: **53.8s, 56% of its
runtime.** Replacing them took the suite from 99s to 46s, and then to 3.7s once
the durability half moved to `themesync`.

The trap in the replacement is a weak predicate. A poll on "the DOM has anything
in it" returns instantly and is worse than the sleep it replaced, because it
passes for the wrong reason. The predicate has to be everything the block depends
on.

Post-action settles are a different thing and stay: waiting to see that something
did NOT happen has no predicate to poll.

## The worker count, both ends measured

The default is twice the core count, floor 4, ceiling 16. These suites are mostly
idle rather than CPU-bound — `themesync` waits 13s on a write that never answers
— so a worker per core leaves the box waiting.

| box | j=4 | j=8 | j=12 | j=16 | j=24 | j=32 |
|---|---|---|---|---|---|---|
| 4-core | 126s | **90s** | flat, within 3–8s variance | | | |
| 16-core | | 41.2s | | **36.6s** | 38.4s | 39.0s, and failing |

Past the ceiling there is nothing to win: no worker count beats the LONGEST
SUITE, while every extra worker slows every suite. Raising it is therefore not
the lever; making one of the two longest suites faster is.

## Two bugs the parallelism produced

**The base has to be threaded through `reset({base})`,** not left in module
state. `reset` awaits ~240 times, so a second worker's `useBase` lands in the
middle of the first one's. Measured: one instance holding both workers' fixtures,
eight habits where there should have been four.

**A suite's DevTools port is assigned by the runner.** Two suites sharing a
literal made the second attach to the first's browser and hang.
`searchcheck`/`unknowncheck` and `notifycheck`/`nudgecheck` both did — invisibly,
for as long as the run was serial, because a serial run never has two attached at
once.

## A reload and the wait after it are one call

From #130, then #153, then #154.

`avoidcheck` reloaded and then polled a `#grid .habit-row` selector — a
condition the fixtures' own rows already satisfy, and, worse, one the
PRE-reload document satisfies too, because `location.reload()` returns before
the navigation commits and the old document is still painting everything it
had a moment ago. A poll landing in that window breaks the loop on a document
about to be thrown away, and the suite either clicks into nothing or dies with
`Cannot read properties of undefined (reading 'querySelector')`, naming
neither the habit nor the wait that was too weak.

#130 proposed the obvious strengthening: wait for THIS habit's row rather than
any row. Checked against all four of `avoidcheck`'s reload sites, evaluated
synchronously inside the doomed document immediately before the reload
committed:

    site                          any row   this habit's row
    A  after Smoking is created   true      false
    B  the skips reload           true      TRUE
    C  after Coffee is created    true      false
    D  the switch to amount       true      TRUE

Naming the row only helps where the habit did not exist a moment ago (A, C).
Sites B and D reload a page that is already painting Smoking, so the
strengthened predicate is satisfied by the very page about to be destroyed —
exactly as weak as "any row" was. #153 is that fix, and #154 is the same
defect found a second time at a fifth call site (`countcheck.mjs`), because
naming happened to close it by an accident of ordering (the row's habit was
created moments earlier by a raw `fetch` the page never saw) rather than by
the predicate being sound.

The predicate that actually distinguishes the two documents does not ask what
is painted at all: it asks WHICH document it is in. `window.__doomed` is set
in the same evaluation as `location.reload()`, immediately before it, and
cannot survive the navigation — a fresh document has no such property, so
`!window.__doomed` is false in the old page and true in the new one, whatever
either is painting. That is `reloadAndWaitForRow` (`shared/test/browser/chrome.mjs`),
and it is why no suite calls `location.reload()` on its own: the reload and
the wait are one call because the bug is in the join between them, and every
version that separated the two got the join wrong.

#130 measured the pre-reload window itself: under a tight CDP poll the old
document was gone by the first round trip in 6 of 6 trials, so it put the
window at under ~8ms. That is #130's own measurement, and six trials that saw
nothing is a weak bound rather than a small number — it does not claim the
window is always that narrow, only that a runner under load is exactly where
a wider one opens.

**The new measurement is the interesting half, and it is why a browser suite
holding the window open with CDP to prove the join behaviourally could not be
built.** On Chrome for Testing 152.0.7977.42, the doomed document is not
observable through CDP at all:

- Pausing the reload's Document request with `Fetch.requestPaused` makes
  `Runtime.evaluate` on that target never answer — not throw, never answer.
- That is not a `Fetch` artifact: stalling the document response 4s at a proxy
  does the same thing instead. `Runtime.evaluate` answered once at +0ms and
  then blocked until the response arrived at +4073ms.
- In every configuration tried — cache on, cache disabled, response stalled —
  the +0ms answer came from a NEW, empty document (`readyState: 'interactive'`,
  0 rows, no sentinel). **0 probes out of 400 ever saw the old document.**

So on this build, CDP's own `Runtime.evaluate` cannot be the witness to the
window it would need to observe, which rules out a browser suite as the test
for this: it could neither reproduce the bug nor be mutation-tested against
it. `reloadAndWaitForRow` takes its evaluator (`ev`) as a parameter and
touches no browser API of its own — its whole contract is which strings it
sends to `ev`, and in what order — so the test that actually exercises it is a
unit test over a fake `ev` that models a window/document/location well enough
to hold the doomed document open on purpose, which a real browser on this
build will not (`shared/test/browser-runner.test.js`).

Worth saying plainly, because a careful reader will notice it on their own:
every suite poll IS a `Runtime.evaluate`, so "CDP cannot observe the window"
and "a CDP poll cannot land in it" are the same sentence — which means the
1.3s `avoidcheck` flake in CI is equally explicable by the WEAK predicate
#153 already replaced ("any row" rather than "this habit's row"), and this
build gives no way to tell the two apart. On this build, the fix's necessity
rests on #130's six-trial observation and on the shape of the race rather
than on a reproduction here. That is not resolved by asserting harder: the
change is strictly stronger either way — it can only close a window, never
open one — and it costs nothing to hold a predicate that cannot be answered
by a document that is going away, whether or not this build ever lands in it.

**#269 is the same defect through a different door.** `snackcheck.mjs` reloads
over CDP (`send('Page.reload', …, sessionId)`), and each reload was followed
by its own hand-rolled poll on `detailReady`, checking three selectors — the
calendar cell, the History bars, the strip cell — that the detail view had
already drawn BEFORE the reload. Naming the content does not help here either,
for the same reason #153 found: the page being reloaded already had all three,
so the strengthened predicate is exactly as satisfiable in the doomed document
as the weak one was.

The join still has to be one call, but a CDP reload cannot literally be one
evaluation with the marker the way `location.reload()` is — it is a separate
round trip over the DevTools socket, not an expression the page can run.
`reloadAndWaitFor` is the factored-out join: the marker is set in its own
evaluation, and the caller's reload (in-page by default, or a `reload:`
callback for CDP) runs immediately after it, with nothing else able to
navigate the page in between. That keeps it sound despite the split.
`reloadAndWaitForRow` becomes the row-shaped wrapper over it, unchanged in
behaviour, and `snackcheck.mjs`'s own poll loops are gone in favour of one
`reloadAndWaitFor` call per reload site.

The guard (`browser-runner.test.js`) is widened to see a free-standing
`Page.reload` and forbid it exactly as it already forbade a bare
`location.reload(` — with one exemption, for `Page.reload` appearing as
`reloadAndWaitFor`'s own `reload:` argument, which is the sanctioned form now
that one exists. `location.reload(` gets no matching exemption: it offends
even inside a `reload:` callback, because the whole reason the CDP door needs
one is that the in-page reload's soundness depends on being one evaluation
with the marker, which a callback would undo.

**`Page.navigate` is the same defect through a third door, and the sweep of it
is the rest of #269.** `send('Page.navigate', …)` resolves before the new
document commits, exactly as `location.reload()` and `Page.reload` do, so a
wait written as a separate statement after it can be answered by the document
the navigation is destroying. There are **79 such sends across 29 suite
files**, of which **68 in 28 files** now join theirs through
`reloadAndWaitFor(ev, PRED, { reload: () => send('Page.navigate', …), what })`
and **11 in 9 files** are deliberately unjoined and registered below.

Those figures are on one stated population, because three plausible ones give
three different numbers and an unqualified count here has already gone stale
once. The population is **a literal `send('Page.navigate', …)` call in
`shared/test/browser/*.mjs`** — so it excludes `browser-runner.test.js`, which
is a unit test in `shared/test/` rather than a suite in `shared/test/browser/`,
and it counts nothing in `chrome.mjs`, which is inside that directory but
contains no send at all (only prose naming the method, and the guard does not
scan it). It also counts *sends*, not text matches: a bare `grep` for
`Page.navigate` over the same files answers **90** here, because comments and
JSDoc mention the method too — it answered 84 before this sweep, and that 84
is how the scope of #269 was first mis-stated.

Those numbers moved during the work rather than being miscounted, which is the
more useful warning. The sweep itself **added** a send (`themecheck`'s
same-document branch, so 76 before and 77 after) and **added** prose (84 text
matches before, 86 after). Then the branch was rebased onto a master that had
gained two more navigations while it sat open — `hangcheck`'s new
`AbortSignal.timeout` guard block (#87) and `calcheck`'s `openFirstHabit`
(#274) — each a fresh instance of the very defect this sweep exists to close,
written after the sweep had already passed over those files. Both were joined
during the conflict resolution, taking the tree to **79 sends, 68 of them
joined**, and the guard is what caught them: it fails on a free-standing
`Page.navigate`, so the rebase could not have quietly reintroduced the race.

Every count in this section is therefore of the tree as it stands *after* that
rebase. A figure measured before a change and quoted after it reads exactly
like a correct one, and that is the drift this file exists to prevent — it is
also, three times now, the drift it failed to prevent. The lesson is not to
count more carefully; it is that **a sweep over a shared directory goes stale
the moment another branch touches one of those files**, so the count and the
guard both have to be re-run at merge time rather than at review time.

**The rule for deciding soundness is checkable from the call site alone, and
it is about the TARGET url.** A marker is sound only where the navigation is
cross-document: on a same-document (fragment) navigation the window is never
replaced, `window.__doomed` survives, `!window.__doomed` is never true, and
the wait hangs to its full 20s — trading a sub-10ms race for a guaranteed
20-second one, which is the wrong direction.

- **A target with NO `#` fragment is always cross-document.** HTML's fragment
  fast-path requires the *target* url's fragment to be non-null, so
  `Page.navigate({url: APP})` is a real document load even from
  `APP/#/habit/3`. `APP` and `BASE` are `process.env.BASE ?? 'http://localhost:3000'`
  in every suite — fragment-less — which is why this one clause covers the
  overwhelming majority of the 79.

**That premise is measured, not only read out of the spec.** Chrome for
Testing 152.0.7977.42, personal edition on a throwaway SQLite instance, 20
trials each. Per trial: settle the document, evaluate `window.__doomed = 1`,
confirm it took, `Page.navigate`, settle again, read the marker back —
`undefined` means the window was replaced, `1` means it survived.

    target                                        replaced   survived
    http://…/            (fragment-less, and      20 / 20     0 / 20
                          identical to the url
                          it was issued FROM)
    http://…/#/habit/1   (identical, fragment)     0 / 20     20 / 20

The control is the half worth having. A probe that only ever saw one outcome
would prove nothing about its own sensitivity, and this one produces both,
cleanly separated, from the same code path a suite uses — so 20/20 on the
main case is a statement about `Page.navigate` and not about the probe. Note
what the first row rules out: a navigation to the *same* fragment-less url,
which is the case a reader is most likely to suspect of being optimised into
a no-op, still replaces the document every time.
- **A target WITH a fragment is cross-document only if something other than
  the fragment differs** — a path or a query. Two sites are in that shape and
  both are already deliberate: `stripcheck.mjs`'s `openHabit` carries an
  incrementing `?open=N` precisely so the navigation is a real load (its
  comment says so), and `themecheck.mjs`'s deep link is cross-document only
  because it is the first navigation in the file and the page is still
  `about:blank`.

**Why the race bit so widely is `shared/public/ui/views.js:26`:**
`for (const el of all) el.hidden = el !== view;` — a view is HIDDEN, never
emptied. So once the dashboard has painted, `#grid .habit-row` keeps matching
from the detail view and from `#/categories`; once a habit has been opened,
`#view-detail .day-strip .check` keeps matching from the dashboard. Almost
every "wait for the dashboard" predicate in the tree is therefore satisfiable
by the outgoing document, and naming the content closes nothing — the same
finding #153 made about naming the row.

**`themecheck.mjs`'s `boot` is the one site where cross-document had to be
decided at RUNTIME rather than statically**, because it has two callers: a
bare `boot()` on the fragment-less default, and the deep link
``boot(`${APP}/#/habit/${id}`)``. An unconditional marker inside the helper
would be sound today and one line-move from a 20s hang. So `boot` asks the
question of the two urls in the page — does the target carry a fragment, and
does its pre-fragment part equal `location.href`'s — and takes the joined
`reloadAndWaitFor` path only where the answer is "cross-document". The
same-document branch is a free-standing `Page.navigate` plus a `waitUntil`.

**Be exact about what that branch is, because it is easy to over-claim.** It
is a TRIPWIRE, not a working same-document path. It is dead today — both
callers are cross-document — and if it ever did fire it would not be a fix
either: it falls back to `waitUntil(ev, until)`, and `until` is already true
in the document a fragment change leaves in place, so ``boot(`${APP}/#/habit/4`)``
issued from `…#/habit/3` would return instantly and go on to measure habit 3.
That is exactly the weak-predicate failure #269 exists to close, preserved
rather than replaced. What the branch buys is only that a line-move cannot
silently hand a fragment caller a marker that never clears — a wrong
measurement traded for a guaranteed 20s hang, which is the better of two bad
outcomes and neither of them correct. A fragment caller that genuinely needed
joining would need a different PREDICATE, not this branch.

**Eleven sends stay unjoined, and each is annotated at the call site**
(`// navigate-unjoined: <reason>`) and counted per file in `NAVIGATE_UNJOINED`
in `shared/test/browser-runner.test.js`. Seven are followed by a bare `sleep`
and no predicate at all — `calcheck.mjs`, `responsive.mjs`, `feat4.mjs`,
`notifycheck.mjs`, `timepicker.mjs` and `settingscheck.mjs` twice — where
inventing a predicate is a different change from joining an existing one. The
other four each have a reason of their own:

- `timepicker.mjs`'s `about:blank` teardown exists to escape a renderer that
  may be unresponsive to `Runtime.evaluate`, so a poll evaluated *in the page*
  is the wrong instrument, and `about:blank` satisfies no predicate anyway.
- `hangcheck.mjs` navigates off `about:blank` (safe either way) and uses a
  bounded poll on purpose, so a hang is REPORTED rather than thrown — its own
  comment explains that its `try` has no `catch`, and a throw would skip the
  checks that make the diagnosis.
- `pwatest.mjs`'s one `goto` helper is called twice — online at boot (`:59`)
  and again with the network cut (`:117`) — and it stays unjoined for the
  shape rather than for the offline half: `sleep` plus
  `check('app shell loads with no network', …)` yields a NAMED failure, where
  a `waitUntil` would turn that into a silent 20s throw with no check output.
  The offline call is where it matters; the reason holds at both.
- `themecheck.mjs`'s same-document tripwire, above.

The guard (`browser-runner.test.js`) forbids a free-standing `Page.navigate`
on the same terms as `Page.reload`, exempting it as `reloadAndWaitFor`'s own
`reload:` argument or where the line carries a `navigate-unjoined:` marker
with a **non-empty** reason — an empty one buys nothing, or the marker
degenerates into a token to paste in. It matches `Page.navigate` as a QUOTED
method name rather than by substring, unlike `Page.reload`: the string is
written in prose all over these suites, and `categorycheck.mjs` writes it
inside a `/* … */` block whose continuation lines carry no leading `*` and so
are invisible to a line-based comment skip. A CDP call always spells the
method as a string literal and prose never does. The registry is a per-file
COUNT rather than a `file:line` pin, in the spirit of `notMirrored`: a line
pin goes stale on the next edit above it and gets updated mechanically, which
is how a registry stops being read, while a count changes only when an
exemption is added or removed.
