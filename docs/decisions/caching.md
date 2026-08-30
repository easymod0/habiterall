# Caching, bounds, and reading your own writes

The `/overview` memo, the eviction policy the three per-user caches share, the
two pool timeouts, and the freshness header — how each bound was arrived at,
what was measured, and which version shipped first and was wrong.

The operative rules are in `habiterall-cloud/CLAUDE.md` ("The dashboard is
memoised, and a write is what clears it"), `shared/public/CLAUDE.md` (the `Vary`
rule) and `android-native/CLAUDE.md` (`Freshness`). This is the rest.

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
`/overview` entry is a whole dashboard. Measured with `--expose-gc`, after a
collection:

| shape | retained |
|---|---|
| 8 habits × 30 days (a typical dashboard) | 18 KB |
| 20 × 365 | 499 KB |
| 50 × 365 | 1.2 MB |

Inherited, the bound was ~4.9 GB — and reachable, because an account paging back
through its own history makes every window a distinct key (`end` and `days` are
both in it), none of it involves a write, so `forget` never fires.

The count bound alone was still not the whole fix. `remember` sweeps only when
the map is FULL, so with a 2 s TTL nothing was evicted until the backstop was
reached; a miss now drops its own expired entries first. One pass, on a path
already about to run five queries, and it makes the live set "the last 2 s of
traffic" — bounded by `PG_POOL_MAX` × the TTL rather than by the backstop.
In-flight placeholders are exempt however old they are, or the store-identity
guard fails and every computation slower than the TTL becomes silently
uncacheable.

## A backstop has to be a number the box survives reaching

`MAX_OVERVIEW_CACHED` shipped at 500, which is ≈ 250 MB of dashboards, and
neither compose file sets a memory limit — so the bound was sized such that
hitting it killed the process it was protecting. 100 × 499 KB ≈ 50 MB is the
same backstop at a size that leaves something to recover with.

## ...but a COUNT is only as good as the entry cost written beside it

And these vary by ~70×, per the table above. "100 × 499 KB ≈ 50 MB" picks the
middle measurement; against the top one the same 100 entries is ~120 MB.
`MAX_OVERVIEW_BYTES` (48 MB, `capBytes`) is what makes that sentence true rather
than approximately true, and it is the bound that holds whatever mix of
dashboard sizes an instance is actually serving.

`createMemo` THROWS for a `maxBytes` with no `sizeOf`, at construction rather
than at load, because a byte bound with nothing to measure with is a comment
claiming a bound — the shape this whole module exists because of.

## Which is affordable because the memo holds the SERIALISED payload

The compute is `JSON.stringify(await buildOverview(arg))` and the route is
`res.type('application/json').send(...)`. So `sizeOf` is exact rather than an
estimate, a hit skips a `JSON.stringify` of up to 1.2 MB as well as the five
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

`MAX_OVERVIEW_CACHED` has no latency term in it — the live set is
`PG_POOL_MAX ÷ buildOverview latency × TTL`, so 100 is right at ~40 ms and four
times too small at ~10 ms. That is why `overviewMemoGauge` rides on the runtime
line beside `pg_pool_max`: `overview_memo_entries`, `overview_memo_bytes`,
`overview_memo_inflight`. One line a minute is what tells the two apart.
`memo.size()` existed from the start and was read by nothing but tests, which is
"who finds out when this goes wrong?" answered with *nobody*.

## A SHARED bound is one an account can spend alone

Per-account keys do not stop one account taking every slot: paging back through
a few years is thousands of distinct windows, no write is involved, and the
account doing it evicts everybody else's answers — leaving every other tenant
the sweep and none of the hits, which is worse than having no memo.
`MAX_OVERVIEW_PER_ACCOUNT` is 8, roughly what the 300 req/min read limiter can
hold live inside a 2 s TTL, so it caps the abusive shape and not the ordinary
one.

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

## Per process, which is a statement about CORRECTNESS

"A write invalidates" is true inside one process. On two replicas a tap handled
by A and a refetch balanced to B is served B's own pre-tap answer — the very
regression the invalidation exists to prevent, arriving through the load
balancer. Every piece of ordering care above (`res.end` over `finish`, the
`finally` after the COMMIT, the store-identity guard) closes a window of
microseconds inside one process, and none of it reaches a second one. So read a
hit-rate metric knowing it is 1/N.

`X-Habiterall-Fresh` is what closes it, and the client is what sends it. The
client is the only party that knows it has just written: no replica can be told
cheaply, and asking a shared store on every read would cost a round trip on the
path the memo exists to remove five of. Three seconds because it must exceed the
2 s TTL — past the window, any entry predating that write has expired anyway, so
"bypass while open" and "nothing stale can remain after" meet with a second to
spare.

Both clients send it, because both write and then refetch. A web-only version
would have been a fix whose own documentation named "the client" and meant one
of the two, which is the shape the repo keeps paying for.

**The phone needs it more than the browser does, not less.** A web tap leaves the
dashboard on screen with the optimistic paint still on it; a Done pressed on a
notification with the app closed is a write followed immediately by an overview
fetch, with no surface at all to disagree with the stale list it opens to. On the
phone the decision lives in `Freshness` and not in the interceptor, and that was
forced rather than chosen: the first version gated inside the lambda with a
source-text guard over it, and lifting the method test out of the condition while
leaving its binding behind passed that guard while the phone had begun asking for
a rebuild on every write it made. The window is measured on
`SystemClock.elapsedRealtime()` rather than `System.nanoTime()`, which stops
during deep sleep — a phone that wrote and then slept for an hour would wake
inside its own three-second window under `nanoTime`.

What is left is one account's OTHER devices, and that is the staleness the TTL
already advertises rather than a hole under it: a tab that did not itself write
can be served a ≤ 2 s-old dashboard after a button press elsewhere.

## The `Vary` that cost the offline dashboard entirely

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

It is pinned from both ends — `cache.test.js` (the route does not call
`res.vary(FRESH_HEADER)`) and `overview-memo.integration.mjs` (the answer's own
`Vary` does not name it, and still names the zone header). The negative
source-text guard reads the region with its comments STRIPPED, because the first
version of it tripped over the paragraph in `api.js` explaining why the call is
deliberately absent: a negative source guard can be FAILED by a comment as
easily as a positive one can be satisfied by one.

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

`test/overview-memo.integration.mjs` boots the real server for the four things a
unit test cannot see: that the route uses the memo at all, that a write reaches
`forget`, that a write arriving OUTSIDE the `/api` router does too (it presses a
real signed ntfy button), and that the caller's day is in the key.

Two limits, stated rather than left to be found. The integration suite **cannot**
see whether the invalidation runs on the way in or the way out — every check in
it is sequential, and the case that distinguishes them needs a read still
computing when a write commits, which nothing over HTTP can arrange. That half is
`cache.test.js`'s injected-compute test. And *"no per-user cache is written past
the bound"* is a source-text guard, kept for the one thing it catches — a call
site going around the policy — with its blindness noted at the assertion.

## #192 deletes the freshness header, and this is the inventory

#192's version check is what removes the last of the staleness, and it should be
the version-**ECHO** shape: the write response carries the account's new version,
the client sends it back, and the memo entry records the version it was built at.
**Not** a version read per request, which would put back the round trip the
freshness header exists to avoid.

The freshness header is scaffolding with a known expiry, decided rather than
assumed: a version-keyed entry is unreachable across every replica with no client
cooperation at all, which is strictly more than the header buys, so under #192 it
is **deleted** rather than converted. Everything that goes with it, so the next
person does not have to find it:

| delete | why it goes |
|---|---|
| `FRESH_HEADER`, `freshnessHeader`, `FRESH_AFTER_WRITE_MS`, `noteWrite` (`shared/public/offline.js`) | the web copy |
| the `method === 'GET' ? freshnessHeader() : {}` spread and the `noteWrite()` call (`shared/public/ui/api.js`) | its two call sites |
| the `flush()` `noteWrite()` (`shared/public/offline.js`) | the replay path's half |
| `FRESH_HEADER`, `object Freshness`, the second interceptor (`android-native/.../Api.kt`) | the phone copy |
| `FreshnessTest.kt` whole, and the freshness test in `AppSettingsDefaultsTest.kt` | both halves of the Kotlin guard |
| `FRESH_HEADER`, the `fresh` branch and the no-`Vary` comment block (`habiterall-cloud/src/api.js`) | the server's half |
| `memo.fresh()` (`habiterall-cloud/src/cache.js`) if nothing else calls it | its only caller was the route |
| the two spelling/`Vary` tests in `cache.test.js`, the `Vary` checks in `overview-memo.integration.mjs` | they pin a header that no longer exists |
| the `Freshness` block in `android-native/CLAUDE.md`, the `X-Habiterall-Fresh` paragraphs in `habiterall-cloud/CLAUDE.md` | the prose defending it |

Three things must **survive** the deletion, because they are not about the header:

- the `Vary` rule in `shared/public/CLAUDE.md`. It is a rule about the service
  worker and any conditionally-sent header, and the freshness header is only the
  example that found it.
- `res.vary(DEVICE_ZONE_HEADER)` and the integration suite's control assertion
  that the answer still names the zone header.
- everything about the bounds, the sweep and the gauge. #192 changes what
  invalidates an entry, not how many of them there may be.

`TTL` becomes a backstop rather than the correctness mechanism once the version
is in the key, so `OVERVIEW_TTL_MS` can go up — but the residency argument above
("the live set is the last 2 s of traffic") is what it was holding, so raising it
means the byte bound is doing that work alone. Re-read the bounds section before
touching it.
