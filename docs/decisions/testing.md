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
