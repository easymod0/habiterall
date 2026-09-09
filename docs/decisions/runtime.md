# The backend runtime — why Node, measured (#199)

Moved out of #199, which was filed to *"measure it once and record the answer"*
rather than to propose a rewrite. Nothing here is loaded automatically; the
operative fact is that the backend is Node, and that this was settled on
evidence rather than on habit.

`CLAUDE.md` never states the runtime and, before this file, nothing in the
archive did either. That matters more than it sounds: **this is the premise the
#183–#198 sequence silently assumes.** Every issue in that run optimises Node
code without saying why Node is the right thing to be optimising, and
*"we are CPU-bound on one thread"* is precisely the observation that prompts
somebody to re-open the question from scratch. `docs/decisions/README.md` exists
so that does not happen; the "What would change the answer" section at the
bottom is what a re-opening has to clear.

## What was measured

The inner loop of `computeScores` — the exponential-decay scoring walk with its
sliding window — ported faithfully to four languages, reduced to a boolean daily
habit so all four do identical arithmetic over a 320-day window. 2,000
iterations, warmed, same 16-core box. All four produce the same output (checksum
1641.480 in every run), so they are computing the same thing.

```
rust 1.97.1   -O                         1.20 us/pass
node 26.7.0   Math.round(x*1e6)/1e6      3.22 us/pass
dotnet 10.0   Release                    6.35 us/pass
node 26.7.0   Number(x.toFixed(6))      24.47 us/pass   <- what stats.js:282 does
python 3.14.7                           131.42 us/pass
```

Three runs each; spread under 5%.

**The four-language harness is not in this tree**, so these five figures are
#199's as reported and cannot be re-run from the repository. That is a real limit
on a record whose stated purpose is that the question be re-opened on evidence:
anyone doing so has to rebuild the harness rather than check this table.

The block is the benchmark's own output, line number included; that line has
since moved and the formulation has not — `Number(score.toFixed(6))` is still
what `computeScores` does, deliberately, for the reason two sections down.

**Read that table with the caveat attached, or do not read it.** It measures the
kernel and not the program — see "The microbenchmark measured the language, not
the program" below, which is the same table's own undoing.

## What the numbers actually say

**Python is not a candidate.** 131 us against Node's 3.2 is 40x, and 5x slower
than the *unoptimised* Node path. This is a tight numeric loop, the worst case
for CPython, and the GIL means the threads that would notionally recover it do
not. Reaching parity with today's Node would mean rewriting `stats.js` in NumPy
or C — i.e. not writing it in Python.

**C#/.NET was slower than correctly-written Node here** — 6.4 us against 3.2.
Both rounding formulations were tried (`Math.Round(x, 6)` and
`Math.Round(x*1e6)/1e6`); the difference was not the API. V8 is very good at
exactly this shape: a monomorphic double loop with a short-lived array per call.
This is one kernel and not a general claim about .NET, but it is enough to retire
the assumption that a "real" runtime is automatically faster at the thing this
app actually does.

**Only Rust beat Node, by 2.7x.** Real, and far smaller than the gap a rewrite
has to justify.

## The workload is CPU-bound in userland, not I/O-bound

Which disarms both halves of the argument that usually carries this question.

The familiar case against Node — *"it blocks under concurrent I/O"* — is about a
runtime waiting on sockets and disks, and that is not where this app's time goes:
it goes into `computeScores` and the date handling around it, in userland, on the
one thread. And the familiar answer — *"async Python fixes it"* — fixes the same
non-problem. An `await` does nothing for a 131 us arithmetic loop except make it
131 us later.

Concurrency here is a **process** question, not a runtime one, which is why #190
(cluster across cores, downstream of PgBouncer) is in the ranking below and a
language is not.

## The result that decides it

The four numbers above are the *arithmetic*. Against the real
`shared/src/stats.js` the arithmetic is not the cost: **89% of `computeScores` is
`dateRange` building the list of date strings**, and ~0% is the entry-map lookups
(#198). Fixing that one function's body — no new language, no schema change,
output byte-identical — is **3.35x on `/overview` per habit and 3.30x on
`/stats`**.

So the ranking that matters is not the language table. It is:

```
fix dateRange (#198)                     3.35x   one function body
+ drop the five discarded passes (#183)  further  one parameter
+ cluster across cores (#190)            ~8-12x   downstream of PgBouncer
------------------------------------------------------------------
rewrite the arithmetic in Rust            2.7x    the entire backend
rewrite it in C#                         0.5x     the entire backend
```

A rewrite would also *carry the same defect with it*: a Rust port that walks
dates by allocating and formatting strings per day is slow in Rust too. The cost
was the representation, not the runtime — which is the general reason this
question keeps having the answer it has.

## The microbenchmark measured the language, not the program

The methodological warning is worth as much as the result.

The isolated kernel said replacing `Number(score.toFixed(6))` with
`Math.round(score*1e6)/1e6` was a **7.4x** win. Against the real module it is
**1.09x** (56 us/habit), because the surrounding date walk dominates.

A microbenchmark that isolates the arithmetic measures the language and not the
program. That is the same failure mode as the root `CLAUDE.md`'s tests that
cannot fail — a number that is true about a thing nobody runs — and it is why
**the language table above must not be quoted on its own.**

## The cost that is specific to this repo

A backend rewrite is not a backend rewrite here.

`shared/src/` is not server code. `stats.js`, `validate.js` and `awards.js` run
**in the browser too** — `shared/public/` imports them directly, with no build
step — and parts are already hand-mirrored in Kotlin under the deliberate rule in
`CLAUDE.md` ("a client mirrors a rule only if it must work offline", five copies,
each justified). Moving the backend to C# or Rust means the completion rule, the
four day-states and the scoring model either become a **third** independent
implementation, or the frontend loses them and every figure needs a round trip.

So the runtime is a **three-consumer decision**, not a server one. The repo has
already priced that: #195 exists because *two* implementations of the same route
surface "have already drifted on both correctness and cost", and the root
`CLAUDE.md` records ~1,750 lines of frontend drift before being merged back. A
rewrite trades a ≤2.7x constant factor for exactly the failure mode the
architecture is organised to prevent.

## The answer

**Stay on Node.** Do #198, #183, #190 in that order; re-measure before sizing
#184/#196.

Where that stands as this file is written: #198, #183 and #184 have shipped and
#196 is closed, so the only step left in the ranking is #190.
`shared/CLAUDE.md`'s `dateRange` section is what the first of them became, and it
is worth reading beside this file — the rewrite it describes was constrained by
DST and by a zone that deleted a calendar day, neither of which a language choice
would have helped with.

This is explicitly **not** a proposal to reimplement `computeStats` in SQL
either — #196 rules that out for the same three-copies reason. A SQL
implementation is a second implementation of the scoring model that the browser
cannot run.

## What would change the answer

Recorded so the decision can be re-opened on evidence rather than instinct:

- The per-habit cost stays above ~1 ms after #198 and #183, *and* profiling shows
  it in arithmetic rather than in allocation or date handling.
- A genuinely different workload appears — server-side analytics across all
  users, ML, bulk report generation. That is a **separate service** alongside,
  talking to the same Postgres, not a migration; it does not touch `shared/src/`.
- `shared/src/` stops being shared — if the frontend ever moves to server-rendered
  figures, the three-consumer argument weakens and the calculus changes.

Nothing else does. In particular, a benchmark of the arithmetic alone does not,
for the reason two sections up.
