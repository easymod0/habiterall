# shared/test/browser — working notes

The real-Chrome suites, and the runner that shards them. The root
`CLAUDE.md` has the layer table — which suite needs what — and
`docs/decisions/testing.md` has the measurements behind every rule here:
boot timings, the sleep audit, the worker-count benchmarks, and both
template-literal variants in full.

The round-trip suites export every backup format, import it back, and assert
nothing changed. Three suites build a ~15-line fake DOM instead of a browser —
`atmost.mjs` and `rendercheck.mjs` drive `charts.js`, `daydialog.mjs` replays
`openDayDialog` — so anything reaching for a browser API there crashes them
outright. `OFFLINE_SUITES` in `run.mjs` is the set the runner will start without
a server; add a suite to it when it needs neither server nor fixtures.

Two suites exist for a shape nothing else can reach. `unknowncheck.mjs` taps a
day and then asks the API what the row says, because with `questionMarks` off a
0 row and no row paint identically. `hangcheck.mjs` holds a request open with
CDP `Fetch.requestPaused` and never continues it — devtools offline throttling
is connection-refused, which rejects in ~3ms and passes against a build with no
timeout in it at all. `responsive.mjs` checks every major view at 360 / 390 /
768 / 1440px; most other suites only ever run at 1440.

**`themecheck` is about colour; `themesync` is not.** The first is the palette
not being frozen into an SVG at draw time; the second is the settings-durability
model — the migration off `localStorage['habiterall-theme']`, the reconcile
between this device and the account, a dialog choice beating an unconfirmed
press, the outbox, a write that never answers. The theme is merely the setting
where that model is reachable. Do not merge `themesync`'s blocks into shared
setups: several look like near-duplicates and pin different halves, and each has
a version that passes while the other fails.

The browser suites reset to known fixtures before each run
(`shared/test/browser/fixtures.mjs`). If one fails, check the fixtures before
suspecting the app — several "failures" have been stale test data.

**Wait for the app, never for a duration.** `waitUntil` (`chrome.mjs`) polls a
predicate and THROWS naming what it wanted; a `sleep` after `Page.navigate` is a
guess in both directions. The predicate has to be everything the block depends
on — a poll on a weak condition returns the instant the DOM has anything in it,
which is worse than the sleep it replaced. Post-action settles are a different
thing and stay: waiting to see that something did NOT happen has no predicate to
poll.

**A reload and the wait after it are ONE call, `reloadAndWaitFor`
(`chrome.mjs`).** `location.reload()` returns before the navigation commits, so
a poll landing in between reads the old document — which is still painting
every row it had, including the one being waited for. Naming the habit's row
does not close that window when the page was already showing it before the
reload; only a page that did not have the row yet is saved by naming. So the
document is marked (`window.__doomed`) in the same evaluation as the reload,
and the predicate checks the marker as well as the row. `reloadAndWaitForRow`
is the row-shaped wrapper over it, and a **CDP** `Page.reload` — a suite
driving the browser over DevTools rather than evaluating in the page — goes
through the same join via a `reload:` callback, since the marker and a CDP
call cannot be one evaluation. No suite issues either kind of reload on its
own.

**A suite's page-side source is a TEMPLATE LITERAL, so a backtick inside it —
including one inside a `//` comment — ends the string early.** The variant that
costs the time is the one that leaves VALID host code behind: `node --check`
passes and the suite fails at runtime naming an identifier that appears nowhere
in the app. `docs/decisions/testing.md` has both variants, the symptom of each,
and why a per-line backtick count finds neither.

**A `Page.navigate` is the same race and joins the same way** — it too resolves
before the new document commits. The marker is sound only where the navigation
is CROSS-document, and a target with no `#` fragment always is, which is every
suite's `APP` / `BASE`; on a fragment-only navigation `window.__doomed` would
survive and the wait would hang for its full 20s. The eleven sends left
unjoined each carry a `// navigate-unjoined: <reason>` at the call site and a
per-file count in `NAVIGATE_UNJOINED` (`shared/test/browser-runner.test.js`),
which is what makes adding a twelfth a reviewed act. `docs/decisions/testing.md`
has the sweep, the reasons and why `themecheck`'s `boot` decides at runtime.

**The browser suites run in parallel, and a worker OWNS the instance it points
at.** `fixtures.reset()` deletes every habit on its server, so the parallelism is
the number of `--bases` and no flag can put two workers on one instance. The
default is **twice the core count, floor 4, ceiling 16**, both ends measured —
past the ceiling no worker count beats the LONGEST SUITE while every extra worker
slows every suite, so raising it is not the lever; making one of the two longest
suites faster is. `npm run test:browser` is personal's fleet script — N servers,
N throwaway SQLite files, N bases — while `run.mjs` stays edition-agnostic so
cloud is pointed at the same way. Two things that have already cost something:
the base must be threaded through `reset({base})` rather than left in module
state, and a suite's DevTools port is **assigned by the runner**, because two
suites sharing a literal made the second attach to the first's browser and hang.

The measurements behind those two rules — boot timings, the sleep audit, the
worker-count benchmarks and both bugs in full — are in
`docs/decisions/testing.md`.

