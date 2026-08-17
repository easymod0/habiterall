# /healthz, connectivity and bounded requests

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**`/healthz` is the only unauthenticated route in cloud that touches Postgres,
and it has four callers rather than the two it looks like.** The container
healthcheck and an attacker are the obvious pair; the other two are the PWA's
connectivity probe (`isReachable`, on every boot and every visibilitychange) and
the Android setup screen's, and both read anything but a 200 as *the server is
unreachable*. So a per-IP 429 does not shed load, it makes a browser banner
itself offline and divert writes to the outbox while the server is perfectly
healthy — self-feeding, because going offline starts a backoff poll into the
same bucket, and shared, because an office NAT is one bucket for everyone behind
it. `/healthz` therefore never answers 429: over the limit it answers from the
memo. `skip` covers the other direction, since a healthchecker reads 429 as
"down" and restarts the container.

What protects the pool is that memo (`habiterall-cloud/src/health.js`), not the
limit. `PG_POOL_MAX` is 10, and a per-IP limit is the wrong shape for pool
exhaustion anyway — a distributed flood pays nothing for a fresh bucket, while
one second of memo caps the cost at one connection per second however many
callers arrive. Its `inflight` half is what makes that true of the case that
matters: a burst on a cold memo would otherwise open a connection each and fill
the memo afterwards. It lives in its own file because `server.js` starts a
server at import time, so nothing declared in it can be unit tested — and the
failure mode here is silent in the worst direction, an `inflight` left set
reporting the last good answer forever while Postgres is down.

**The connectivity state is an output of that probe, and a failed write is its
one other input.** `watchConnectivity` polls only while it believes it is
offline — deliberately, and the note above is why — so nothing asks the server
anything while it believes it is online, and `online` / `offline` /
`visibilitychange` none of them fire when the interface is up and only the route
is dead. That is the shape of a stale tunnel or a container that has stopped
answering, and through one the app went on looking connected for as long as the
tab stayed open: no banner, and the queued-write count hidden inside it. So the
app's own failed write reports in, through the watcher's `reportOffline` and not
a bare `setOffline` — setting the state from outside leaves the watcher's `last`
at `true`, so it neither polls nor ever reports the transition, and the banner
sticks up until a `visibilitychange`. The FIRST failure is trusted: waiting for a
second means the tap that started the outage still hangs, and confirming with a
probe is exactly what the paragraph above forbids. A blip costs a banner for a
second or two, because the backoff poll this arms is what takes it down again.

Which only works because `/healthz` no longer goes through the service worker.
It is not under `/api/`, so it fell to `shellFirst`, which cached the first 200
and served it cache-first forever — measured with the server killed outright,
`isReachable()` still answered `true` from the shell cache. Every input the app
has about connectivity runs through that one call, so an installed PWA could not
notice an outage, and could not notice a recovery either. It is excluded now, as
`/auth/` already was.

**A request the app makes is bounded; the one that creates a habit is not.**
10s, in `ui/api.js` and in the worker's `networkFirst`, taken from `Api.kt`'s
`connectTimeout` rather than invented — Chrome imposes no ceiling of its own on
a response that never arrives (measured still pending at 300s), so before this
a check-off could sit in a promise until the tab closed and be lost with it.
The exemption is about REPLAYING, not latency: aborting does not recall a
request the server has already begun, so everything bounded here has to be safe
to arrive twice, and `POST /habits` is the one call on this path that is not —
it yields a second habit. Import, export and the notify test bypass `api()`
entirely, which is what makes a blanket bound safe for everything else.

This is the bounded half of #87 and not the whole of it: the write is still
attempted before it is durable, so the loss window is 10 seconds rather than
unbounded. Closing it means enqueueing FIRST, which changes the outbox from
"writes that failed" to "every write" and needs an idempotency key before it can
be done — `flush()` would otherwise replay a create that had already landed.


