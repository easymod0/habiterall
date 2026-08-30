# Caching, bounds, and reading your own writes

The `/overview` memo, the eviction policy the three per-user caches share, the
two pool timeouts, and `users.data_version` — how each bound was arrived at,
what was measured, and which version shipped first and was wrong.

The operative rules are in `habiterall-cloud/CLAUDE.md` ("The dashboard is
memoised, and a write is what clears it") and `shared/public/CLAUDE.md` (the
`Vary` rule). This is the rest.

Two things in here were rewritten by #192 rather than added to, and it is worth
knowing which before reading: the freshness header this file used to specify is
**gone**, and the version-**echo** shape it recommended in its place was
measured and **not** what shipped. Both are recorded below as history.

## Two caches claimed a bound in a comment and had none

`blockCache` and `lastReportedZone` each carried a comment asserting a bound —
*"small and bounded by the number of live users"*, *"bounded by the accounts
seen this process lifetime"*. Neither is one. Both had a TTL deciding whether an
entry is **trusted** and nothing deciding whether it is **kept**, so an account
that made one request and never came back sat there for the life of the
container. `shared/CLAUDE.md` already records the same shape costing 2.2 MB in
`formatterFor`.

`src/cache.js` is one policy for both and for the memo: sweep on write when
full, expired entries first, then least recently written. A rewrite deletes
before it sets, so *least recently written* is true rather than *first
inserted* — `Map.set` leaves an existing key's position alone, and the entry a
busy account keeps rewriting is exactly the one a first-insertion sweep would
throw away.

`session-touch.js`'s map stays out of it deliberately: it bounds by clearing,
because forgetting a session there costs one extra `UPDATE`.

## Sharing a policy is not sharing a NUMBER

`MAX_CACHED` is 10,000 and `cache.js` justifies it by an entry costing ~100
bytes, which is true of the other two caches and false for the memo: an
`/overview` entry is a whole dashboard. Measured twice, in two different units,
and **the two numbers are not interchangeable** — which is the whole of the
correction #192 made here:

| shape | retained object | serialised string |
|---|---|---|
| 8 habits × 30 days (a typical dashboard) | 18 KB | 15.1 KB |
| 8 × 365 | — | 93.6 KB |
| 20 × 365 | 499 KB | 233.4 KB |
| 50 × 365 | 1.2 MB | 582.9 KB |

The first column is what this file originally recorded: measured with
`--expose-gc`, after a collection, and the honest figure at the time, when the
memo held the payload as an object. It stopped being the right number the moment
the memo started holding the **serialised** payload, because `capBytes` sums what
`sizeOf` returns and `sizeOf` measures the string. The object is roughly twice
the string — 365 dated grid keys per habit cost far more as object properties
than as JSON text — so every bound stated against the left-hand column was
conservative by about 2×, and "the entries vary by ~70×" was really ~39×.

Both columns are kept because both are true of something: the left is what the
process holds if the payload is ever handed back as an object again, the right is
what the byte bound actually counts today. **Any bound derived here must use the
right-hand column**, and the sizes there are the ones re-measured over the real
route for #192.

Inherited, the bound was ~4.9 GB — and reachable, because an account paging back
through its own history makes every window a distinct key (`end` and `days` are
both in it), none of it involves a write, so `forget` never fires.

The count bound alone was still not the whole fix. `remember` sweeps only when
the map is FULL, so with a 2 s TTL nothing was evicted until the backstop was
reached; a miss now drops its own expired entries first. One pass, on a path
already about to run five queries, and it makes the live set "whatever was asked
for in the last `ttlMs`". In-flight placeholders are exempt however old they are,
or the store-identity guard fails and every computation slower than the TTL
becomes silently uncacheable.

**How big that live set is was then argued from the TTL, and that argument
expired with the number it was written against.** It read: since a computation
holds a pool connection while it runs, the live set is bounded by `PG_POOL_MAX` ×
the TTL and not by the backstop at all. True at 2 s, where ten connections cannot
produce many answers. Nonsense at the 60 s TTL #192 moved to, where the same ten
connections can produce thousands — so the backstop becomes the binding
constraint again and starts evicting entries that are still fresh. A caller
passing a long TTL has to size `max` against `maxBytes` instead, which is exactly
what `MAX_OVERVIEW_CACHED` now does.

## A backstop has to be a number the box survives reaching

`MAX_OVERVIEW_CACHED` shipped at 500, which against the sizes then recorded was
≈ 250 MB of dashboards, and neither compose file sets a memory limit — so the
bound was sized such that hitting it killed the process it was protecting. It
went to 100 as the same backstop at a size that leaves something to recover
with, and both numbers were arrived at by multiplying a count by a
representative entry, which is the method the next section is about.

Neither survives #192, and for a reason that has nothing to do with memory:
**a count sized to be reached is wrong once the TTL is long**. At 100 entries and
a 60 s TTL, `remember` spends its time evicting fresh entries — all of the sweep,
none of the hits, the failure that shows up only as "the dashboard is slow
again". So the direction reversed: `MAX_OVERVIEW_BYTES` is the bound, and the
count is set high enough that the bytes are reached first.

## ...but a COUNT is only as good as the entry cost written beside it

And these vary by ~39×, per the right-hand column of the table above. The old
arithmetic — "100 × 499 KB ≈ 50 MB" — picked the middle measurement, and against
the top one the same 100 entries was ~120 MB. `MAX_OVERVIEW_BYTES` (48 MB,
`capBytes`) is what makes that sentence true rather than approximately true, and
it is the bound that holds whatever mix of dashboard sizes an instance is
actually serving.

`MAX_OVERVIEW_CACHED` (3,300) is now derived from it, and the entry size that
decides it is the **smallest** rather than the largest:

| shape | one entry | fits in 48 MB |
|---|---|---|
| 8 habits × 30 days (typical) | 15.1 KB | 3,254 |
| 8 × 365 | 93.6 KB | 525 |
| 20 × 365 | 233.4 KB | 210 |
| 50 × 365 | 582.9 KB | 84 |

3,300 clears the largest of that right-hand column, 3,254, because a big
dashboard reaches 48 MB in 84 entries and any count at all is a backstop for it.
Below ~15 KB an entry the count does bind first — an account with two habits and
a week of history is far smaller — and that is the backstop doing its job: 3,300
of anything that small is a few megabytes, and what is bounded there is the map
itself rather than the dashboards in it.

`createMemo` THROWS for a `maxBytes` with no `sizeOf`, at construction rather
than at load, because a byte bound with nothing to measure with is a comment
claiming a bound — the shape this whole module exists because of.

## Which is affordable because the memo holds the SERIALISED payload

The compute is `JSON.stringify(await buildOverview(arg))` and the route is
`res.type('application/json').send(...)`. So `sizeOf` is exact rather than an
estimate, a hit skips a `JSON.stringify` of up to ~580 KB as well as the five
queries — on a single-threaded server that is everyone's latency, which is what
`runtime.loop_blocked` is watched for — and no two callers are ever handed the
same mutable object.

`res.type` BEFORE `send` is the one way that swap goes wrong: `res.send` of a
STRING defaults the content type to `text/html` where `res.json` would have set
it. With it set first the two are byte-identical — no `json replacer` or `json
spaces` is configured on this app — and `overview-memo.integration.mjs` asserts
a hit and a miss agree on status, content type and body.

## Both ways of getting the bound wrong are silent, in opposite directions

Too small and the memo thrashes: `remember` evicts entries that are still fresh,
the hit rate collapses toward zero, and every tenant pays the sweep for no hits.
The only symptom is that the dashboard is slow again. Too large and the heap
grows until the container is killed.

`MAX_OVERVIEW_CACHED` used to be justified by a residency figure with no latency
term in it — the live set as `PG_POOL_MAX ÷ buildOverview latency × TTL`, which
made 100 right at ~40 ms and four times too small at ~10 ms. That sensitivity to
a number nobody measures is why the count is no longer derived that way at all:
it is derived from `MAX_OVERVIEW_BYTES` and a measured entry, which moves only
when the payload's shape does.

Which is why `overviewMemoGauge` rides on the runtime line beside `pg_pool_max`:
`overview_memo_entries`, `overview_memo_bytes`, `overview_memo_inflight`. One
line a minute is what tells the two directions apart. `memo.size()` existed from
the start and was read by nothing but tests, which is "who finds out when this
goes wrong?" answered with *nobody*.

## A SHARED bound is one an account can spend alone

Per-account keys do not stop one account taking every slot: paging back through
a few years is thousands of distinct windows, no write is involved, and the
account doing it evicts everybody else's answers — leaving every other tenant
the sweep and none of the hits, which is worse than having no memo.
`MAX_OVERVIEW_PER_ACCOUNT` is 8, which is roughly what one account can
legitimately have live: a real dashboard holds one or two, since the grid window
only changes when the user pages, plus a couple for a second device and the
archived view. So it caps the abusive shape and not the ordinary one.

**The 60 s TTL made this matter more, not less.** The old justification for 8 was
"the read limiter allows 300 req/min = 5/s, entries live 2 s, so a client
hammering distinct windows as fast as it is allowed holds ~10". At sixty seconds
that same client would hold ~300, and eight accounts doing it would be the whole
shared count. The number does not move, because it was never sized against the
hammering — it is what makes the hammering cost the account doing it and nobody
else. Since #192 an account's entries at SUPERSEDED versions count against its
share too, which is the right way round: they are unreachable, so its own cap is
exactly who should give them up.

Both sweeps step over an in-flight placeholder: taking one wastes the
computation, loses its answer to the store-identity guard, and re-forms the
burst it was collapsing.

## Invalidation, and the two write paths outside the router

Invalidation is one rule for every non-safe method rather than a call per route.
A list of the nine mutating routes is a list that drifts, and the two errors are
not symmetrical: forgetting too much costs a recomputation, forgetting too
little paints a user's own tap away on the refetch that follows it.

It wraps `res.end` rather than listening for `finish`, so the memo is provably
clear before the first byte of the answer leaves. `finish` fires from a later
turn of the loop, which would make "the client cannot have refetched yet" a
claim about scheduling instead of something the code makes true.

**But `api.use(...)` is a rule about a ROUTER, and this edition writes from
outside it — twice.** `NTFY_ANSWER_PATH` is mounted in `server.js` above the
`/api` mount on purpose, so it is never reached through `requireAuth`, and a
Discord button press arrives on the gateway socket without touching Express at
all. Both write a real entry, both through `interactionAdapter().record` in
`src/notifier.js`, and neither was cleared by the router middleware — so
pressing **Done** on a reminder while the PWA sat open in a tab served that tab
a dashboard computed before the press, day still blank, for the length of the
TTL. `forgetAccount` is the one function both halves call, and the `finally`
belongs OUTSIDE `withUser` so the forget follows the COMMIT.

## Per process, which WAS a statement about CORRECTNESS

"A write invalidates" is true inside one process. On two replicas a tap handled
by A and a refetch balanced to B is served B's own pre-tap answer — the very
regression the invalidation exists to prevent, arriving through the load
balancer. Every piece of ordering care above (`res.end` over `finish`, the
`finally` after the COMMIT, the store-identity guard) closes a window of
microseconds inside one process, and none of it reaches a second one. So read a
hit-rate metric knowing it is 1/N — the ANSWERS stopped being 1/N in #192, which
is what the next three sections are about.

**The first answer to it was `X-Habiterall-Fresh`, a three-second hint both
clients sent after their own writes**, on the reasoning that the client is the
only party that knows it has just written: no replica can be told cheaply, and
asking a shared store on every read would cost a round trip on the path the memo
exists to remove five of. Three seconds because it had to exceed the 2 s TTL.

That reasoning has one hole and it is in the sentence itself. **The client knows
only about its OWN write.** A second tab, a phone that did not press the button,
a laptop that has been idle — none of them has anything to declare, so each
satisfies its own check and is served the stale dashboard. The header could
close read-your-own-writes and could not close anything else, and it was scoped
as scaffolding for that reason. #192 deleted it; the inventory is at the end of
this file.

## What replaced it, and the two claims that turned out wrong

This file used to SPECIFY the replacement, and it specified the wrong one. It
called for a version **echo** — the write response carries the account's new
version, the client sends it back, the memo entry records the version it was
built at — and it rejected reading the version per request as "putting back the
round trip the memo exists to remove five of". Both halves of that were checked
and neither held.

**Echo does not close the other-devices half.** It is the same hole as the
header, one level up: a tab that never wrote has no newer version to echo, so it
sends the version it last saw, matches the entry built at that version, and is
served it. Echo closes exactly what the header already closed, at the cost of a
wire contract in two clients.

**And the read is not a round trip the memo exists to remove.** It removes one,
not five, and what it is worth is arithmetic nobody had done. Measured over the
real route, through `withUser` as `habiterall_app` — `scripts/bench-version-read.mjs`,
`npm run bench:version-read -w habiterall-cloud`:

| shape | rebuild (miss) | hit, with the read | the read alone | break-even |
|---|---|---|---|---|
| 8 habits × 365 days | 18.0 ms | 2.42 ms | 0.34 ms | 2.14% |
| 20 × 365 | 31.6 ms | 2.40 ms | 0.29 ms | 0.97% |
| 50 × 365 | 76.2 ms | 2.58 ms | 0.32 ms | 0.43% |

Break-even is the fraction of requests the read must convert from a miss into a
hit to pay for itself, and it is under 2% everywhere. The TTL going from 2 s to
60 s converts far more than that. So the read shipped and the echo did not, and
no client carries anything at all — which is also why nothing about this change
needed a client release, an Android version check or a wire contract to keep the
two editions honest about.

**A hit is no longer free, and the bench says so where it used to say "no
database touch".** ~2.4 ms of that hit is this edition's floor for any
authenticated request — `GET /api/habits`, the same shape, measures 2.36 ms and
`/healthz`, which is mounted above the session middleware, measures 1.33 ms. The
read is the ~0.3 ms on top.

## The version is read BEFORE the data, and that is the whole ordering

`withUser` is READ COMMITTED, so the version read and the five queries see two
different snapshots and the order decides which way an interleaved write is
wrong.

- **Version first** — a write committing between them leaves an entry tagged
  with the OLD version holding NEW data. No later reader asks for that key, so
  the entry is unreachable and the answer is rebuilt. Wasteful, correct.
- **Version last** — the entry is tagged with the NEW version holding data read
  before the write. Every later reader asks for exactly that key and every one
  of them is served the stale payload, for the whole 60 s TTL.

The second is silent and is the failure this issue exists to remove, so it would
have been the change moving the bug rather than fixing it. The reason is written
at the ordering in `api.js` rather than only here.

On a miss the version read is folded into the rebuild's own transaction, since
that transaction is being opened anyway; the separate read exists only for the
hit path. The decision of hit-versus-join-versus-compute is taken with the
connection in hand (`memo.peek`) and acted on outside it, because a caller
joining somebody else's in-flight rebuild would otherwise hold a pool connection
for the length of that rebuild — `PG_POOL_MAX` gone to four tabs foregrounding
at once.

## The pool cliff, which is an OPERATOR note and was nearly a bail-out

The objection that could have sunk the shape: before #192 a memo hit touched
Postgres zero times, so it was answered at full speed however saturated the pool
was — the memo is a load SHEDDER. Put a read on the hit path and it has to queue
for one of `PG_POOL_MAX` connections behind whatever rebuilds are in flight.

Measured, with 29 ms transactions holding the SAME pool the read draws from —
which the first version of that section got wrong, driving the load through the
server's pool while the reads went through a second pool of its own, and so
measuring "is Postgres slower under load" (it is not) rather than "does the read
queue":

| pool | concurrent holders | mean | p95 |
|---|---|---|---|
| 10 | 9 | 0.35 ms | 0.43 ms |
| 10 | 10 | 9.9 ms | 30.3 ms |
| 10 | 20 | 38.8 ms | 60.2 ms |
| 20 | 19 | 0.37 ms | 0.44 ms |
| 20 | 20 | 7.9 ms | 28.6 ms |
| 40 | 39 | 0.38 ms | 0.43 ms |
| 40 | 40 | 5.9 ms | 26.4 ms |

**The cliff is at exactly `PG_POOL_MAX` and it moves with it** — free at 9 on a
pool of 10, at 19 on a pool of 20, at 39 on a pool of 40. That is the sentence
an operator seeing `pg_waiting` non-zero needs: the read is free right up to
saturation and costs a full transaction hold past it, and raising `PG_POOL_MAX`
moves the cliff out rather than merely deferring it. (Raising it is not free for
rebuilds, which hold their connection through per-habit CPU on a single thread,
so a bigger pool moves that queue from the pool to the event loop. It is free for
this read, which is ~0.3 ms of socket wait and almost no CPU.)

**Past the table it stops being a latency cliff and becomes an availability
one, and that is the sentence the measurements above do not contain.**
`connectionTimeoutMillis` is 5 s (`db/pool.js`). The rows stop at 20 holders on
a pool of 10 because that is where the queue is still being served; hold the
pool saturated for five seconds and `pool.connect()` REJECTS, so `/overview`
answers **500** — on a request whose answer was already in the map and which
master answered instantly. The client has no softer landing for it either:
`networkFirst` (`shared/public/sw.js`) reaches `caches.match` only from the
`catch` around `fetch`, so a 500 that *arrives* is handed to the page and the
installed PWA shows an error rather than its saved dashboard. A rolling deploy
or a mass foreground putting ~30 tabs on one replica is enough.

So the cost of the unconditional read is: free below `PG_POOL_MAX`, a full
transaction hold above it, and a 5xx above THAT. The first two are what the
bail-out below was deleted over; the third is not an argument for bringing it
back, and it is not a reason to hold the change — but an operator sizing the
pool for the second number and getting the third has been told the wrong thing.

**That table is the whole of what survives, and what survives is a note for an
operator, not a mechanism in the code.** `PG_POOL_MAX` is already a knob; the
answer to `pg_waiting` being non-zero is to raise it, not to make the dashboard
answer from a cache the pool depth has excused from checking itself.

**If the third regime is ever actually reached, the fix is a second pool, not a
bail-out.** The failure is that two workloads with very different profiles
share one queue — a ~0.3 ms version read behind rebuilds that hold a connection
through per-habit CPU. Giving the version read its own tiny pool (2–3
connections, a transaction that is always four trivial round trips) means a
herd of misses can no longer starve the hit path, and it costs no correctness
at all: every request still reads a real version before it decides anything.
The price is a second pool to drain on SIGTERM, three more connections per
replica, and a miss paying two checkouts instead of one — the design point
`cache.test.js` currently pins as `the version read and the rebuild share ONE
transaction`, which was chosen against a SHARED pool where the second checkout
came out of the same ten. **Do not reach for "serve the resident entry when the
checkout fails" instead.** It is the smaller diff and it buys availability with
exactly the stale-serve the section below deletes, in exactly the regime that
section says the staleness is most likely.

Neither is worth building until the third regime is known to be reachable, and
until this change it could not be known: `pool.connect()` throws before the
`try` in all three helpers, so `noteTimeout` never saw it — and could not have
named it anyway, since an error that never reached Postgres carries no
SQLSTATE. A refused checkout arrived as a bare 500.

So it is named now. `checkout()` in `db/pool.js` wraps all three call sites and
logs **`pg.checkout_failed`** with the scope that wanted the connection and the
whole of `poolGauge()`. The gauge is the load-bearing half, because saturation
and an unreachable database are the same rejection with the same message and
only the numbers separate them: `pg_total` at `pg_max` is a pool too small,
`pg_total` 0 is a database that is not there. Logged and rethrown untouched, the
rule `noteTimeout` already states — a 503 would tell the offline outbox to
replay a write the pool cannot accept either.

**`pg_waiting` is deliberately not in that test, and the first version of this
section had it there.** "A pool too small reads `pg_waiting` non-zero" is the
obvious sentence and it is false in the case it names. `pg` removes a pending
request from `_pendingQueue` inside the `connectionTimeoutMillis` callback,
before it hands the error back (`pg-pool/index.js`, the `removeWhere` in the
timeout), and `waitingCount` is that queue's length — so the request being
logged about has already stopped counting itself. Ten rebuilds holding a pool of
ten with one `/overview` queued behind them logs `pg_total: 10, pg_max: 10,
pg_waiting: 0`: a pool too small, wearing neither documented signature. It is
also always the shape of the LAST waiter of any burst to time out. So the
number is a corroborator of how wide the queue was, and `pg_total` against
`pg_max` is the only half that reads true at the moment it is sampled.

**That event firing is the trigger for the second pool.** If it never appears,
none of this section needs building; if it appears with `pg_total` at `pg_max`,
the version read is starving behind rebuilds and the pool is the answer. Either
way the decision is now one a log can make rather than one an argument has to.

### The bail-out that was written first, and why it was deleted

#192 shipped one (`OVERVIEW_TRUST_MS` = 2 s, `memo.trusted` in `cache.js`, a
block ahead of the transaction in the route): when `pool.waitingCount > 0`, an
entry younger than the window was served **without reading the version at all**.
Both halves were required, and the pair was justified by the claim that its worst
case was "exactly the staleness the TTL used to advertise".

That claim is wrong, and the sequence it is wrong about is the one the whole
change exists for:

1. A tab loads the dashboard. Replica **B** builds it and memoises it.
2. 1.5 s later the user taps a day. The `PUT` is balanced to replica **A**, which
   bumps `data_version` and clears **A's** map — B's map still holds the entry.
3. The client refetches. It lands on **B**, whose pool has somebody queued.
4. `trusted` finds the pre-tap entry, well inside 2 s, and serves it.

The user's own tap, painted away. The old 2 s TTL could not do that and neither
could the header it replaced: `X-Habiterall-Fresh` was sent by the device that
wrote, so a writer forced a rebuild on **any** replica at **any** pool depth. The
old TTL only ever exposed devices that had NOT written, because the writer
carried the header. So the bail-out was not "the staleness we used to have" — it
was a new staleness, aimed squarely at the writing device, which is the one
reader who notices.

What it bought was latency, in a regime where the server is already saturated and
where the alternative — a miss — costs a connection wait *plus* 16–76 ms of
rebuild anyway. Correctness is not the thing to buy that with. The version read
is now unconditional: every `/overview` reads `users.data_version` and keys on
it, at every pool depth, full stop.

## The TTL and the count bound had to move together

`OVERVIEW_TTL_MS` went 2 s → 60 s because the timer stopped being the correctness
mechanism. What is left for it to do is bound how long an unreachable entry stays
resident, and cap the damage from a write path that forgets to bump — which is
why it is sixty and not an hour.

`MAX_OVERVIEW_CACHED` had to be re-derived in the same change, because 100 was
sized against a live set of "what ten connections can produce in two seconds".
That is the residency argument two sections above, and at sixty seconds it says
nothing. See "A backstop has to be a number the box survives reaching".

## `forgetAccount` stays, and stops being the correctness mechanism

Two mechanisms now clear an account's dashboards and only one of them is load
bearing. A bumped version makes every entry built before a write unreachable on
every replica at once, which is more than any amount of forgetting inside one
process could do. The invalidation middleware and `forgetAccount` are kept for
two smaller jobs, both worth having:

- **Eager reclamation.** An unreachable entry is resident until the TTL sweep
  meets it, and the TTL is a minute. Forgetting at the write frees it at the
  write, so a bumped account does not hold a minute of dead dashboards against
  `MAX_OVERVIEW_BYTES` and its own per-account share.
- **Cover for a missed bump.** A route added tomorrow that writes through bare
  `withUser` announces nothing, and the version would then be a correctness
  mechanism that silently is not one. The middleware still clears that account
  on the way out, so the failure is a stale entry for ≤ 60 s rather than for as
  long as the process lives. That cost grew with the TTL — it was ≤ 2 s — which
  is why `cache.test.js` now enumerates every non-GET handler in `api.js` and
  requires `withUserWrite`, and why `data-version.integration.mjs` enumerating
  the write paths by hand was not enough on its own: a route nobody adds to its
  list is simply absent from it, and nothing goes red.

## One write deliberately does not bump

"Every write bumps" is the rule and it has exactly one exception: the device-zone
middleware in `api.js` writes `users.device_time_zone` through bare `withUser`,
on GETs, guarded by `IS DISTINCT FROM` and memoised for a minute. It does not
bump, on purpose. It is an observation the server makes about where a request
came from, not a change to anything `/overview` reads, and bumping there would
invalidate an account's dashboards on its own READS — the exact failure that
keeps the bump out of `withUser` itself.

`POST /notify/test` goes the other way and DOES bump, also on purpose: it writes
nothing `/overview` reads either, but uniformity is the property that survives a
new route being added, and over-bumping costs one recomputation where
under-bumping serves stale data until the TTL.

## The `Vary` that cost the offline dashboard entirely

This is about a header that no longer exists, and the rule it found outlives it —
`shared/public/CLAUDE.md` states it about any route the worker caches. Kept
because the measurement is the argument.

`res.vary(FRESH_HEADER)` reads like the obviously right thing to say to caches,
and is free everywhere except the one cache this app ships. `sw.js` stores
`/api/overview` with `cache.put(request, …)` and reads it back with
`caches.match(request)`, both of which select an entry using the STORED
RESPONSE's `Vary` — and this header rides on exactly one read per write.

Measured in Chrome rather than reasoned about, because the spec and the
implementation disagree about the half that matters:

```
put(plain, A)                 → 1 entry, match(plain) = A
put(fresh-header, B)          → 1 entry, match(plain) = null
                                         match(fresh) = B
                                         caches.match(plain) = null
put(plain, A) / put(fresh, B), response varies on the ZONE header only
                              → 1 entry, match(plain) = B
```

So the post-write `put` **replaces** the cold-boot entry — one entry, not the two
a Vary-aware query implies — and the survivor answers only a request carrying a
header no cold boot sends. `caches.match` returns nothing, `networkFirst` falls
through to its synthetic 503, and the installed cloud PWA opened offline to **no
dashboard** rather than to a stale one. Every write left it that way until the
next write-free reload.

Nothing is lost by dropping the `Vary`: it lets a cache pick between stored
representations, and this header is a demand to REBUILD, which no cache holding
an entry can satisfy. The worker is network-first, so while there is a network
the demand always reaches the route; with none it is unsatisfiable and the saved
dashboard is the right answer. `Vary: X-Habiterall-Timezone` sits on the same
responses and is safe, which is the distinction: a device sends one zone on
every request.

It **was** pinned from both ends: `cache.test.js` asserted the route did not call
`res.vary(FRESH_HEADER)`, and `overview-memo.integration.mjs` asserted the
answer's own `Vary` did not name it. Both went with the header in #192 — a guard
that a deleted constant is absent is a test that cannot fail. What survives is
the positive half, `overview-memo.integration.mjs` asserting the answer still
names the ZONE header, which is what proves `res.vary` is reached at all rather
than merely that one name is missing from it.

That negative guard is worth remembering for its own lesson, since the next
conditionally-sent header will want one: it read the region with its comments
STRIPPED, because the first version tripped over the paragraph in `api.js`
explaining why the call was deliberately absent. **A negative source guard can be
FAILED by a comment as easily as a positive one can be satisfied by one.**

## The pool timeouts

The pool had `connectionTimeoutMillis` but no `statement_timeout` and no
`idle_in_transaction_session_timeout`. One pathological statement held one of ten
connections until it finished, while what reached the operator was *other*
requests failing their five-second checkout, naming nothing about the query
responsible.

Both are passed as connection parameters, so they reach every session the pool
opens and `SHOW` is the only thing that can confirm it — `test/api.integration.mjs`
reads both back against a real session for that reason.

They are parsed by `timeoutFromEnv` and not by `Number(env) || default`, which is
the idiom next door at `PG_POOL_MAX` and is wrong here: **0 is a value Postgres
has a meaning for** — it disables the timeout — and `||` swallows exactly that
spelling, so the one setting the README tells an operator to reach for when a
long export is being cancelled would be the one setting they could not make. An
unparseable value falls back *and warns*, because a typo must not silently remove
a bound.

`noteTimeout` logs `pg.statement_timeout` / `pg.idle_tx_timeout` on the way past,
then rethrows untouched. Without it the timeouts trade one anonymous failure for
another: a bare 500 out of SQLSTATE `57014` names nothing either. Logged rather
than converted to a 503, which would tell the offline outbox to replay a write
that cannot finish in the time allowed.

**15 s is a default, not a measurement**, and it is the open judgement call here:
the three export routes read every row an account has, so an instance holding a
decade for somebody may need to raise it.

## What the tests cover, and what they cannot

`test/cache.test.js` covers the eviction policy and the memo in isolation, with
an injected clock and a computation that can be held open by hand — including
the case only an injected computation can reach: a write landing while a read is
still computing must not let that read's pre-write answer into the cache.

`test/overview-memo.integration.mjs` boots the real server for the six things a
unit test cannot see: that the route uses the memo at all, that a write this
process never saw is visible on the next request (the cross-replica case, with
the admin connection standing in for the other replica), that the answer still
names the zone header in its `Vary`, that a write reaches `forget`, that a write
arriving OUTSIDE the `/api` router does too (it presses a real signed ntfy
button), and that the caller's day is in the key.

Three limits, stated rather than left to be found. The integration suite
**cannot** see whether the invalidation runs on the way in or the way out — every
check in it is sequential, and the case that distinguishes them needs a read
still computing when a write commits, which nothing over HTTP can arrange. That
half is `cache.test.js`'s injected-compute test. It equally cannot see whether
the version is read before or after the data: that needs a write committing
between two statements of one transaction, so the ordering is guarded on source
text and argued at the read. And *"no per-user cache is written past the bound"*
is a source-text guard, kept for the one thing it catches — a call site going
around the policy — with its blindness noted at the assertion.

*"No mutating route in `api.js` writes through bare `withUser`"* is a fourth
source-text guard and the newest, and the shape it catches is the one neither
behavioural suite can: `data-version.integration.mjs` proves each write path it
KNOWS ABOUT bumps, one case per route, so a route added next month is simply not
in the list and nothing goes red. The guard enumerates instead — every
`api.post` / `put` / `patch` / `delete` handler in the file — so a new one is
covered on the day it is written. What it cannot see is a renamed binding, a
wrapper forwarding to bare `withUser`, or an `api.use` middleware, which is not
enumerated at all because the device-zone middleware is deliberately in exactly
that shape. All three are stated at the assertion.

## #192 deleted the freshness header — the inventory, DONE

Kept as history, because a deletion spread over three sides is the kind that
leaves one copy behind, and the next person reading this should be able to check
rather than trust. Every row below shipped in #192.

The header was scaffolding with a known expiry, decided rather than assumed: a
version-keyed entry is unreachable across every replica with no client
cooperation at all, which is strictly more than the header bought, so it was
**deleted** rather than converted. `CACHE_VERSION` went v28 → v29 with it —
removing an EXPORT under `shared/public/` is a bump for the same reason adding
one is, since `shellFirst` can serve a cached old module against a new shell and
a missing export is a module link error before `start()`, outside `#view-error`.
No file was added or removed, so `SHELL` itself is unchanged.

| deleted | why it went |
|---|---|
| `FRESH_HEADER`, `freshnessHeader`, `FRESH_AFTER_WRITE_MS`, `noteWrite` (`shared/public/offline.js`) | the web copy |
| the `method === 'GET' ? freshnessHeader() : {}` spread and the `noteWrite()` call (`shared/public/ui/api.js`) | its two call sites |
| the `flush()` `noteWrite()` (`shared/public/offline.js`) | the replay path's half |
| `FRESH_HEADER`, `object Freshness`, the second interceptor (`android-native/.../Api.kt`) | the phone copy |
| `FreshnessTest.kt` whole, and the freshness test in `AppSettingsDefaultsTest.kt` | both halves of the Kotlin guard |
| `FRESH_HEADER`, the `fresh` branch and the no-`Vary` comment block (`habiterall-cloud/src/api.js`) | the server's half |
| `memo.fresh()` (`habiterall-cloud/src/cache.js`) | its only caller was the route; `memo.peek` is what took its place, and it is not a deleting operation |
| the two spelling/`Vary` tests in `cache.test.js`, the `Vary` checks in `overview-memo.integration.mjs` | they pinned a header that no longer exists |
| the `Freshness` block in `android-native/CLAUDE.md`, the `X-Habiterall-Fresh` paragraphs in `habiterall-cloud/CLAUDE.md` | the prose defending it |

Three things **survived** the deletion, because they are not about the header:

- the `Vary` rule in `shared/public/CLAUDE.md`, and its restatement in
  `sw.js`'s `networkFirst`. It is a rule about the service worker and any
  conditionally-sent header, and the freshness header was only the example that
  found it. **Both were re-tensed rather than left alone**, which is the half
  that was nearly missed: the rule survived, but it was written in the present
  tense about a header that no longer exists ("the freshness hint rides on
  exactly one read per write"), in two files a reader is expected to trust as a
  description of the app. A kept rule whose only worked example is fiction is
  how the next person concludes the mechanism is still there.
- `res.vary(DEVICE_ZONE_HEADER)` and the integration suite's control assertion
  that the answer still names the zone header.
- everything about the bounds, the sweep and the gauge. #192 changed what
  invalidates an entry, not how many of them there may be — though it did change
  how the COUNT is derived, which is the bounds sections above.

Nothing in the phone or the browser replaced it. `Api.kt` lost an interceptor and
gained nothing; `offline.js` lost `noteWrite` and its `flush()` call and gained
nothing. That is the property worth remembering about this shape: the fix is
entirely server-side, so an old client installed on somebody's phone gets it
without updating.
