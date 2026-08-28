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

## SIGTERM, keep-alive, and what `server.close()` does not do

The bug in #237 was reported as "SIGTERM kills in-flight requests". It is not
that. Measured against the real `habiterall-personal/src/server.js` on Node
v26.7.0 with `HABITERALL_AUTH=off` — a raw socket, half a `POST /api/habits` body
sent, then `SIGTERM`, then the body finished:

| case | master's shutdown block | with `installShutdown` |
|---|---|---|
| pooled keep-alive socket **idle** at the signal | exits in **5 ms** | 4 ms |
| **in flight** at the signal, then goes idle and is left alone | exits in **6158 ms** | **156 ms** |
| in flight, and the peer keeps using the pooled socket | **20188 ms**, having served **70** requests after the signal — Docker SIGKILLs at 10000 ms | **155 ms**, 0 requests served |

In every case the held request itself came back `HTTP/1.1 201 Created` with a real
habit id, on master and after the fix alike. So a drain that kills in-flight work
was never the defect; the defect is the process not leaving, and then leaving by
SIGKILL — which loses whatever the 10th second happened to be carrying, and loses
the cleanup and the log line with it.

Two consequences, and the first one invalidates the issue's own proposed fix.

**`server.close()` on Node 26 already sweeps the connections that are idle at the
instant it is called**, so a one-shot `server.closeIdleConnections()` — literally
what #237 asks for — is a no-op. Mutation-measured both ways: removing the
one-shot call while keeping the repeated sweep changed nothing (`idle` 5 ms,
`inflight` 156 ms, `pooling` 156 ms); removing the **repeated** sweep while
keeping the one-shot call put `inflight` back to **6157 ms** and `pooling` to an
8005 ms forced `exit(1)`. The issue's proposed mutation ("remove
`closeIdleConnections()` and the held-connection case must hang") would therefore
not have bitten, and a suite built on it would have passed against a fix that
does nothing. The one-shot call is kept anyway: it is the same call as the sweep
two lines above it, and `shutdown.js` says so at the line, because deleting the
redundant one invites deleting both.

**The load-bearing mechanism is the sweep hooked to every response's `close`
event while draining, attached at INSTALL time.** A request already in flight when
the signal lands had its `request` event long ago, so a hook installed by the
signal handler could never see it — and that request is the only case that hangs.
`close` rather than `finish`, so an aborted response counts too: either way the
connection has just gone idle, and idle is what `close` sweeps.

Rejected alternative: **setting `Connection: close` on every response while
draining.** It works, and it is what a lot of guides recommend, but only once the
peer sends another request on that socket — the case above where the process sat
for 6158 ms with a silent pooled socket is exactly the one it does not reach. It
also needs a change in each edition's request path (a header written per
response, in two files, under a flag both have to read) to buy a subset of what
one `closeIdleConnections()` on the response's `close` already buys.

The ceiling is `DRAIN_DEADLINE_MS`, 8000 ms, a constant rather than an
environment variable: Docker's default `stop_grace_period` is 10 s, and the
number's whole job is to hold for an operator who sets nothing. At 8 s *we*
choose the exit and its code and there is a log line saying the drain ran out; at
10 s SIGKILL chooses, with no line, no cleanup, and a status that says only that
something killed it.

**Neither number describes an ordinary restart, and the compose comment used to
read as though they did.** It said "lower this below ~9s and SIGKILL chooses the
exit instead, which is what taking in-flight requests down looks like" — true of
the ceiling case and false as a general claim, which is how an operator reads a
sentence in a compose file. The measured normal drain is ~155 ms (check 1 of
both suites), so a 5 s grace takes nothing down on any day where nothing is
slow. What the 10 s buys is the bad day: a request still running when the grace
expires is cut off rather than answered. The comment in all three examples says
that now, and `npm run docs:compose` carries it into the README's three blocks.
Worth generalising: a tuning knob's comment should say what the ORDINARY value
of the thing is before it says what the ceiling costs, or the ceiling reads as a
floor.

There are **three** exits, and an operator reads them apart by the event beside
the status. `exit(0)` with `shutdown.drained` is the whole thing working: every
accepted response finished and the storage teardown ran. `exit(1)` with
`shutdown.deadline` is the 8 s running out — no cleanup was attempted, because
something was still stuck and a `closePool()` that hung too would lose the exit
the deadline just bought. `exit(1)` with `shutdown.cleanup_failed` is the third
and the least obvious: the drain SUCCEEDED, every accepted response *was*
finished, and only `db.close()` / `closePool()` failed. That is why the rejection
is caught rather than left alone — an unhandled rejection is also a status of 1,
but with a raw stack and no line, which destroys the distinction between a
teardown that failed and a process that never left.

## The window before that: a signal with nothing listening yet

The drain above was written first and this was stated as a known limitation of
it. It is #237's own symptom by a second route: `installShutdown` is called
after the server exists, so everything before that call is a stretch with no
signal handler at all. Node is PID 1 in both images (exec-form `CMD`, no init, no
`init: true`), and for PID 1 a signal with **default disposition is discarded**
rather than fatal, so there is no default behaviour to fall back on. `docker stop`
during
that stretch does nothing whatever and the operator waits the full
`stop_grace_period` for the SIGKILL, which is precisely the outcome the drain
exists to get ahead of, reached before the drain has been installed.

Both editions have the window and **neither of them is unbounded**, which an
earlier draft of this section got wrong and is worth stating plainly because the
conclusion survives the correction unchanged. Cloud's is the long one:
`const server = await start()` is `await initAuth()`, and
`habiterall-cloud/src/auth.js`'s `client.discovery(issuer, …)` passes no
`timeout` option — but the library supplies one. In **openid-client 6.8.5**,
`node_modules/openid-client/build/index.js`'s `performDiscovery` is

```js
const timeout = options?.timeout ?? 30;
const signal = AbortSignal.timeout(timeout * 1000);
```

and `index.d.ts` documents it: *"Timeout (in seconds) for the Authorization
Server Metadata discovery. … Default is `30` (seconds)"*. The two call sites in
`auth.js` pass `undefined` or `{execute: […]}` as that options argument, so the
default applies and an IdP that accepts the connection and never answers makes
`initAuth()` reject with a `TimeoutError` at ~30 s. It does not hang forever.

**The arm is still the right fix, and 30 s is why.** All three shipped compose
files set `stop_grace_period: 10s`, so cloud's boot window is three times the
whole grace: a `docker stop` landing anywhere inside it is discarded by PID 1,
runs out the grace, and gets the SIGKILL — the bound is far too loose to be the
thing that saves the operator. Anyone bumping openid-client should re-read this
paragraph and re-measure the default; the argument only changes if the default
drops under ~10 s, and even then only for an instance that never lengthened its
grace.

Personal's is bounded and **small**, and on the commonest install it is smaller
still. `initAuth()` hashes and calls `adoptEnvCredential` → `verifyPassword`
**only inside `if (env)`** — only when `HABITERALL_USERNAME` /
`HABITERALL_PASSWORD` / `HABITERALL_PASSWORD_HASH` are set. The shipped
`personal.env.example` and compose file leave all three empty, so a default
install takes the setup-form path with its credential in the database, runs
**zero** scrypts, and its arm-covered window is a SQLite read. With an
environment credential the shipped parameters are `N=16384, r=8, p=1`, measured
at **28 ms** per call on this machine, so a whole `initAuth()` is still well
under a tenth of a second. What makes
the window reachable by a test at all is that `verifyPassword`
(`shared/src/password.js`) reads N, r and p **out of the stored hash**, bounding
them only by `Number.isInteger(v) && v > 0`, and `p` multiplies scrypt's work
linearly at no extra memory cost. So the suite can open the window through
nothing but production code — no patched module, no sleep — and having to seed
p=128 to make it measurable is the tell that personal's *covered* window is not
where the risk is. Measured on this machine, Node v26.7.0, N=16384 r=8:

| p | 1 | 64 | 128 | 256 |
|---|---|---|---|---|
| `verifyPassword` | 28 ms | 2178 ms | 4761 ms | 7923 ms |

The suite seeds p=128 — clear of a second, under the 8 s deadline. Not higher:
past node's 32 MB `maxmem`, `verifyPassword` catches the throw and answers
`false` *immediately*, which would silently close the very window it was raised
to buy. Cloud's suite needs no such trick; it points `OIDC_ISSUER` at a
`createServer` that accepts, takes the request and never answers, which is the
unreachable-IdP shape with no network and no timing assumption in it.

**`armShutdown` takes the signals at the top of each entry point's module body,
ahead of every `await`** — in cloud ahead of the `config_missing` env check too,
so a process that exits on a missing `SESSION_SECRET` or `PUBLIC_URL` is still
one that could have been stopped, and in personal gated on `isEntryPoint`, which
is why that computation moved up from beside `app.listen` where it used to sit.
It cannot drain anything, nothing having been accepted. What it can do is close
whatever the imports above it already opened — personal's SQLite handle, cloud's
pool, on which `closePool()` resolves in 0 ms when nothing has ever borrowed from
it — and leave.

**`DATABASE_URL` is the exception in that env loop, and an earlier draft claimed
it as an example.** `habiterall-cloud/src/db/pool.js` calls
`assertConnectionString(process.env.DATABASE_URL, 'DATABASE_URL')` at MODULE
scope, and `server.js` imports it at the top of its import list. ES modules
evaluate every import fully before the importing module's body, so with
`DATABASE_URL` unset or malformed the process dies on an uncaught throw during
import — before the arm, and before the loop, whose `DATABASE_URL` branch is
therefore unreachable for the missing case. Observed:

```
Error: DATABASE_URL must be set
    at assertConnectionString (…/habiterall-cloud/src/db/url.js:32:19)
    at …/habiterall-cloud/src/db/pool.js:24:1
    at ModuleJob.run (node:internal/modules/esm/module_job:569:25)
```

No arm placed in a module body could ever have covered that, and there is nothing
to cover: it exits in microseconds, so there is no window in it worth a handler.
The env check is left exactly where it is — reordering it, or moving the import,
is a behaviour change to an error path and belongs to whoever wants that, not to
this fix.

**What the arm covers is the module BODY onward, and the largest real window on
personal is outside it.** The same rule about imports cuts the other way here.
Everything the entry point imports has already run: express, helmet and
`express-session` cost a fixed ~100–300 ms to evaluate, and on personal
`src/db.js` at module scope opens the handle, runs the whole schema, and runs the
one-time `entries.status` data migration —

```sql
ALTER TABLE entries ADD COLUMN status TEXT NOT NULL DEFAULT '';
UPDATE entries SET status = 'skip', value = 0
  WHERE value = 3 AND habit_id IN (SELECT id FROM habits WHERE type = 'boolean');
```

— which is data-proportional and bounded by nothing this code controls. On a
container upgraded from a pre-`status` build holding a large Loop import that
`UPDATE` is the slow part of the boot, and it is the FIRST start after an
upgrade: precisely the boot an operator is most likely to interrupt. Meanwhile
what the arm does cover on personal is `await initAuth()` — 28 ms of scrypt per
call on an instance with an environment credential, and no scrypt at all on one
whose credential is in the database. So the honest summary is: personal's
covered window is small in
production, personal's *uncovered* window is the one that can be long, and
cloud's covered window — up to 30 s against a 10 s grace — is the one this change
is actually for.

It is left open because closing it is a **different change**, not a bigger
version of this one. A wrapper entry point that arms and then
`await import('./server.js')` adds a new entry file, and moves both Dockerfiles'
`CMD`, both `start` scripts and both drain suites' `serverPath` with it. The
shape of this fix was chosen deliberately over that; anyone who wants the wrapper
should decide it on its own.

Three more decisions are worth stating, because each has a plausible
alternative.

**Adoption, not `process.off` + `process.on`.** `installShutdown` hands the arm
its drain handler and registers no process listener of its own; from that instant
the arm's listener dispatches into the drain. The obvious alternative — remove
the early listener, install the real one — has a gap between the two calls,
however small, and this has none. It also means the arm owns the REGISTRATION,
and therefore owns `installShutdown`'s `signals` and `onSignal` options too: both
branches of the `if (arm)` return, so neither option means anything once an arm
is passed. That is stated in the JSDoc and at the branch rather than enforced
with a throw — no caller passes the combination (both editions take the defaults
in both places) and a throw would be a new failure mode bought for nobody.

When a signal has already arrived, `adopt` answers `false` instead: the early
exit owns the exit, and what the brand-new listener does is log
`shutdown.adoption_refused`, then `beforeClose()`, `server.close()` and
`server.closeIdleConnections()` — the same pair the drain path takes, for the
reason written there: the sweep hooked to `request` is the same call, and reading
one without the other invites deleting both. Neither the line nor the sweep bites
today, and it is worth being exact about why rather than implying they were
measured. Nothing can be idle on that branch because nothing can have been
ACCEPTED: in both editions the stretch from `app.listen` to `installShutdown`
contains no macrotask — personal's is straight-line, cloud's crosses only
`await start()`, which resumes on a microtask off an already-resolved promise —
so the loop never turns in between. Put one piece of real async work between the
two in either entry point and both become live. The log line is there for the
operator whose stop lands in that instant, who would otherwise see a listener
torn down at birth with nothing saying why; the unit suite pins its presence and
its position before `beforeClose`, which is the only thing that can fail today.

**Exit 0 on the early path.** Nothing had been accepted, so nothing was
dropped — the operator asked it to stop and it stopped on its own terms. That
keeps 1 for the two failures the section above draws apart, `shutdown.deadline`
and `shutdown.cleanup_failed`, which the early path reuses unchanged because they
mean the same things here. So there are still three exit *codes* and now four
events: `shutdown.early` sits beside 0 as `shutdown.drained` does, and carries a
`reason` field for exactly that reason — two clean exits with a line above them
otherwise read alike. The early path also runs no `beforeClose`, the mirror of
the deadline path's no `cleanup`: at arm time neither the notifier nor the
runtime watcher exists to be stopped.

**`shutdown.armed` is one info line per process start**, and the only observable
that says this process could be stopped cleanly from that instant. It is also the
predicate both drain suites wait on, which is what lets them signal INSIDE the
window rather than after a sleep and a hope — and the *budget* on that wait is
load bearing in the other direction. An entry point with no arm in it never logs
the line, so a generous budget would wait until that process had finished booting
and then signal a perfectly ordinary running server, which drains, exits 0 and
looks fine. Bounded at a second, the unarmed build is signalled while it is still
booting, which is the case the assertions are written against.

**The numbers, on this machine, Node v26.7.0, over the several runs this took —
stated as the spread rather than as one run's figures, because a single number
here would be pinned to whichever run got written down.** Personal, control run
with no signal: `shutdown.armed` at **91-101 ms**, `startup` at
**3292-3382 ms**. The control is what makes "no `startup` line" a fact about the
signal landing inside the window rather than about a run that was simply
signalled late — and it fails by name on a machine fast enough to have closed
the window, instead of letting the check pass for the wrong reason. Signalled
inside that window personal exits in **30-34 ms**, code 0, signal null. Cloud,
against the stalling issuer: **12-19 ms**, code 0, signal null.

`signal === null` is asserted beside the code, and it carries as much as the code
does. The mutations say why.

**Remove either edition's arm** (and the `arm` argument to `installShutdown`).
The signalled process is KILLED rather than leaving: `code=null signal=SIGTERM`
at **4 ms** on the host. On the host that is fast, and "it exited quickly" is
exactly what a passing run looks like when only the duration is asserted — a
signalled death and a chosen exit must not read alike. In the image it is the
opposite and worse: PID 1 discards the signal, nothing happens at all, and the
operator waits the full grace for the SIGKILL.

**Keep the arms, delete the `exit(0)` from the early success path.** Cloud
reaches the ceiling — **8016 ms**, code 1, having logged `shutdown.armed`,
`shutdown.early` and then `shutdown.deadline`. The budget is what bites, and this
is the mutation that proves the budget is the half asserting the signal was not
merely deferred into a hang. Personal fails differently and it is worth
recording: `cleanup()` has closed the SQLite handle out from under a boot that is
still running, so `adoptEnvCredential` throws `ERR_INVALID_STATE` and node exits
1 at **27 ms**. On personal the early exit is not merely tidy — the boot cannot
survive its own storage being closed.

**Pass `arm` but have `installShutdown` register through `onSignal` as well.** A
doubled handler, and this one is the fix re-creating the defect it was written
for: the arm's early path wins at ~5 ms and the process leaves taking the
in-flight request with it. Personal's checks 1–3 and cloud's check 1 catch it —
and **both new boot-window checks pass under it**, because inside the window a
doubled handler is indistinguishable from a single one. Nothing about the boot
window can see this, which is why the unit suite asserts the injected `onSignal`
was never called at all.

The three drain measurements above are unchanged by the arm: personal in flight
156 ms / code 0, pooling peer 156 ms / code 0 with 0 further requests served,
never-idle peer 8007 ms / code 1; cloud in flight 156 ms / code 0.


