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
