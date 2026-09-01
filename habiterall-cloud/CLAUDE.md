# habiterall-cloud — working notes

Multi-user edition: Postgres, OIDC login, Docker Compose. This holds other
people's personal data, so read the security model before touching anything
in `src/db/` or `src/auth.js`.

## The security model

**Tenant isolation is enforced by Postgres, not by application code.**

- Every table is `FORCE ROW LEVEL SECURITY` with a policy on
  `app_current_user_id()`.
- `withUser(userId, fn)` sets `app.user_id` transaction-locally, so it cannot
  leak between pooled connections. A path that WRITES calls `withUserWrite`
  instead — the same transaction, plus the account's `data_version` bump in it.
  Not a line inside `withUser`, because `withUser` wraps the reads too.
- `withUser` and `withNotifierScope` open their transaction and set that
  scoping in ONE round trip — `BEGIN; SELECT set_config(...)` as a single
  multi-statement `query()` call (#188) — but the `set_config` third argument
  stays `true` (transaction-local) in both, whether folded or not. This is not
  a detail the fold gets to simplify away: a session-level `SET` would still
  be visible to the NEXT borrower of the pooled connection, which is a silent
  cross-tenant read, not merely a leftover setting. It is also what keeps this
  edition compatible with a transaction-mode connection pooler (#201, which
  names #188 as the change that must not undo it) — a pooler that hands a
  session to a different backend per transaction has nowhere for a session-level
  setting to survive to anyway, but a transaction-local one is exactly the unit
  such a pooler preserves.
- A query that forgets its `WHERE` clause therefore returns **nothing**. The
  isolation fails closed.
- The app connects as `habiterall_app`: not the table owner, `NOBYPASSRLS`,
  no DDL, no `INSERT`/`DELETE` on `users`, and column-level `UPDATE` on
  `email`, `display_name`, `last_seen_at`, `settings`, `device_time_zone` and
  `data_version` — and nothing else. Keep that list exact: it is the one place
  the boundary is written down in prose, and it had already gone stale for
  `settings` once. `idp_subject`, `idp_issuer`, `blocked` and `id` are
  SELECT-only, which is what stops an account editing its own identity or
  unblocking itself. `data_version` (migration 017) widens that boundary by
  nothing an attacker wants: `users_update_self` still scopes the UPDATE to the
  caller's own row, so an account can only bump its OWN counter, and the whole
  effect of doing so is that it stops being served its own memoised dashboards.

**`withoutUser` bypasses that boundary.** It exists for migrations, the
session store, and user provisioning. Keep its call sites countable on one
hand, and never use it for habit or entry data.

**User creation goes through `provision_user`** (a `SECURITY DEFINER`
function, migration 003/004). The app role cannot `INSERT` into `users` at
all. Identity is `(idp_issuer, idp_subject)` — **not** subject alone. Keying
on `sub` alone allowed a token from a second IdP carrying the same `sub` to
take over an existing account.

**Sessions are opaque cookies**, server-side in Postgres, `httpOnly` +
`SameSite=Lax`, `Secure` derived from the actual scheme (not `NODE_ENV` — a
`Secure` cookie over plain HTTP is silently dropped and login breaks with no
error). Regenerated on login against fixation; logout deletes the row.

**Imports are confined to the importer.** Ids inside an uploaded file are
ignored entirely; habits match by *name*, and every written row carries the
session's `user_id`. See the header comment in `src/apply-import.js`.

**Settings are a JSONB column on `users`**, covered by the existing
`users_select_self` / `users_update_self` policies — no new RLS needed. The
app role was granted `UPDATE (settings)` explicitly; it still cannot touch
`idp_subject` or `blocked`.

`device_time_zone` (migration 013) is the same arrangement and is deliberately
NOT in that blob: it is an observation the server makes from a request header,
where everything in `settings` is a decision the user sent through
`PUT /api/settings`. Keeping them apart is what makes `notifyTimezone: 'auto'`
reversible, and what keeps a device's zone out of `/api/export` — restoring a
backup on a laptop abroad must not move when reminders arrive.

**The reminder scheduler is the one job with no user to scope to**, and
migration 008 is where that is paid for. It must ask "who has a webhook
configured?" before it knows whose day to read, and `withoutUser` cannot answer
— no `app.user_id` means `users_self` matches nothing and the scan returns zero
rows, which is RLS working. So there is a `users_notifier_scan` policy, `FOR
SELECT` only, requiring `app_current_user_id() IS NULL` *and* a
transaction-local `app.scope = 'notifier'` that only `withNotifierScope` sets.
The two conditions are mutually exclusive by construction, so it cannot widen a
request already scoped to a user, and it reaches no table but `users`. Once it
has the ids, `src/notifier.js` goes back through `withUser` for the habits, the
entries, `notify_log` and `notify_status` — so a mistake there still fails
closed. Read the header of `008_notify_log.sql` before touching any of it.

**`notify_status` (migration 010) is the one thing the notifier writes FOR the
user.** One row per account per channel holding the last delivery outcome, so a
deleted webhook is something the settings dialog can say rather than a warn line
nobody can read. Ordinary owner policy — the key leads with `user_id`, so the
invisible-row squat migrations 007 and 008 guard against cannot arise here — and
`SELECT, INSERT, UPDATE` only, because it is upserted in place and nothing
deletes one. It carries an error string straight from Discord, which is why the
tenancy suite attacks it: a leak would hand one account a running commentary on
another's destinations.

**`categories` (migration 015) is the one habit-adjacent table whose grant
includes DELETE.** Same shape as `notify_status` — ordinary owner policy,
`user_id` leads the key, `FORCE ROW LEVEL SECURITY`, the owner policy on
`app_current_user_id()` for both `USING` and `WITH CHECK` — but the grant is
`SELECT, INSERT, UPDATE, DELETE`, because a category is a label its owner
manages and can remove, where `notify_status` is upserted in place and nothing
ever deletes a row. `habits.category_id` is `ON DELETE SET NULL`, never
`CASCADE`: removing a category must not take its habits' history with it.
That foreign key runs inside Postgres with RLS not applied to its own check,
so it is not a tenancy boundary by itself — a DB-layer write can point a
habit's `category_id` at another account's category and the constraint will
not stop it. That is exactly why the route resolves `category_id` against the
caller's own rows before the insert or update, and why the tenancy suite
attacks the DB layer directly rather than trusting the route to always be the
caller.

**A button press is authorised by its channel.** `interactionAdapter` in
`src/notifier.js` resolves the account from `interaction.channel_id` — through
the notifier scope, since it spans users — and everything after that runs in
`withUser`. The habit id on the button is looked up *inside* that account, so a
forged one finds nothing rather than someone else's habit; the tenancy suite
attacks exactly that. Two accounts naming the same channel resolves to neither,
because guessing would write to the wrong person's history.

**And a press is DATED by its account, so a fixture here has to name a zone.**
`interactionAdapter().today` resolves the day through `resolveTimeZone`, whose
third tier is the server's own clock — so a suite that dates its answer in UTC
and leaves the fixture's zone unstated has two clocks and no rule making them
agree. That suite passes in CI, which runs UTC, and fails on a developer machine
west of UTC once the UTC date has rolled over: six checks at once, every one of
them reporting `that date is in the future` about a date the test had just
called today (#288). So no account in `test/ntfy-answer.integration.mjs` leaves
its zone to the server: each one states which TIER is meant to answer for it.
Every account whose day is asserted through tier 1 names `notifyTimezone`
explicitly and names a `device_time_zone` that DISAGREES with it, so tier 1
beating tier 2 stays load-bearing rather than incidental — and the two accounts
left on `'auto'` are the deliberate exception, because tier 2 is the thing they
exist to assert. Do not reconcile them by pinning them to a named zone: that
deletes the only tier-2 coverage in the file and the suite stays green, which is
the hole two paragraphs below is about.
`test/notify.integration.mjs` already named the setting on the
accounts whose day it asserts; the accounts it leaves on `auto` are the ones
whose whole point is to follow a reported zone, and they are asserted against
that zone rather than against UTC.

**Pinning the fixture to UTC is also what would blind it, which is why the 26-hour
pair exists.** An account on UTC cannot tell a route that resolves its zone
correctly from one that ignores the account and hardcodes `toISOString()` — the
two agree in every runner zone, so the suite's own fix would have removed its
ability to see the defect next door to the one it fixed. `Pacific/Kiritimati`
(UTC+14) and `Etc/GMT+12` (UTC−12) are 26 hours apart, which
`docs/decisions/timezones.md` establishes is wider than a calendar day: their
local dates ALWAYS differ. So one signed date string, presented for one account
in each zone, must be accepted by the eastern one and refused as future by the
western one, race-free in both directions (the eastern account's age is 0 or 1
against a `MAX_ANSWER_AGE_DAYS` of 2, the western one's always negative) — and
any route judging every account by ONE clock, UTC or the server's, answers them
identically and fails the pair. That is exactly the class of defect the pair
exists for, and it escapes the pair at 0 of 24 hours, in every runner zone,
mutation-tested both ways round under `TZ=UTC`. It is not a wider claim than
that: the two zones are two calendar days apart, not one, for a 2-hour window
each day (10:00–12:00 UTC), and a route whose date is systematically a day too
late slips BOTH pairs at exactly those two hours — it does not slip the suite,
because `a future-dated reminder answers 400` and its companion sit on the
UTC-pinned account, where `shiftDay(1)` is an exact `age = -1` boundary, and
fail at all 24 hours.
And inverting the tier order fails the pair at every hour but the first
account's own six checks only once the runner's UTC hour reaches 10, where
Kiritimati stops sharing UTC's date — so it is the suite as a whole, not the
pair by itself, that has no blind spot.

**A second pair sits one tier down, because the first one left tier 2 covered by
nothing.** With every account naming `notifyTimezone`, `resolveTimeZone` answered
at tier 1 for every request the file made and its second tier —
`device_time_zone`, which is what `'auto'` reads — was exercised nowhere: a route
returning `deviceZone: ''` from `resolveAccount` passed the whole suite, while
dating every press by the server's clock for every account still on `'auto'`,
the mode every real account starts on. So two more accounts stay on `'auto'` and
carry the 26-hour split on `device_time_zone` instead.

It takes a PAIR here for the same reason it does above, and the gap a single
account leaves is most of the day rather than an instant. Measured against that
same mutation under `TZ=UTC`: a lone eastern account passes at every hour before
10:00 UTC, where `D` is the UTC date and its age is 0 — ten hours blind — and a
lone western one passes from 10:00 UTC on, where `D` is a day ahead and its age
is negative either way — fourteen hours blind. Two accounts 26 hours apart have
to answer one date string OPPOSITELY, so a route that drops or ignores tier 2
answers them alike and fails at every hour instead.

**A webhook URL is a user-supplied URL that the server fetches.** It is
validated in `shared/src/notify.js` against Discord's own hosts and stored
canonicalised; `/api/notify/test` re-reads it from the database rather than
taking one from the request body, and carries its own tight rate limit because
it causes outbound traffic.

## Both policy functions are `PARALLEL SAFE`, and that flag goes away in silence

`app_current_user_id()` and `app_is_notifier()` were marked `PARALLEL SAFE` by
migration 016 and must stay that way. `CREATE FUNCTION` defaults to UNSAFE and
a later `CREATE OR REPLACE FUNCTION` that omits the clause resets it without
saying so — and because both sit in the `USING` clause of a policy on every
table, one unsafe function takes parallelism away from the whole application at
once. That is what the before measurement showed: with `debug_parallel_query =
on`, a `count(*)` over `entries` inside `withUser` produced an identical plan
with no `Gather` node in it at all.

`test/schema-plans.integration.mjs` is what notices. It walks `pg_depend` from
the policies rather than naming these two functions, so a policy added later
brings its function into the check with it, and the index invariants beside it
are read out of `pg_index` / `pg_attribute` for the same reason — a table added
next year is already covered. `test/tenancy.integration.mjs` holds the other
half: forced parallel, inside `withUser`, an account still sees only its own
rows. Parallel safety says the body may run in a worker; it does not widen what
that worker can see, and that is asserted rather than argued.

**`SAFE` is the requirement, and `RESTRICTED` fails it exactly as `UNSAFE`
does.** The catalog walk asks `proparallel <> 's'`, not `= 'u'`, and that is
not pedantry: `PARALLEL RESTRICTED` means the function may run only in the
parallel group LEADER, so an expression containing it cannot appear in a
partial path — and an RLS qual is applied at the scan, so a restricted policy
function is a scan that cannot be parallelised at all. There is no `Gather` in
the plan, which is byte for byte the regression 016 exists to undo. The first
version of this suite asked `= 'u'`, so a THIRD policy function marked `'r'` by
an author being cautious would have passed it while taking parallelism away
from every query the app role issues; the named control beside it covers only
these two functions and would not have seen it either. Mutation-tested both
ways round.

**And the plan that carries a security claim must be the plan of the statement
whose ANSWER is trusted.** Round one of that tenancy block asserted `Workers
Launched: 1` on a stand-in — `SELECT count(*) FROM entries` — and then ran the
two isolation reads as separate statements, on the reasoning that the same
forced-parallel transaction makes them parallel too. It does not follow: a
`COUNT(DISTINCT ...)` is the sort of aggregate whose parallel-safety is worth
not assuming, and a single `random()` (which Postgres marks `PARALLEL
RESTRICTED`) anywhere in the select list is enough to take the `Gather` off one
read while the stand-in beside it keeps its worker — measured. Each isolation
read is now `EXPLAIN ANALYZE`d for its own plan and then issued again for its
rows, and the worker count is asserted per statement. Same lesson as the
`ANALYZE`-not-`EXPLAIN` one above, one level further in: a plan is a statement
about shape, and the shape asserted has to be the shape of the query being
believed.

`LEAKPROOF` is deliberately not applied to either and must not be: it is the
opposite lever — permission to push a user-supplied qual *below* a security
barrier — and these functions **are** the barrier.

**`test:plans` pins CAPABILITY; `bench:queries` is what measured CHOICE, and it
is not a suite.** `planFor` sets `enable_seqscan = off` (and, for the grid read,
`enable_bitmapscan = off` as well), so what it asserts is that the index can
serve the predicate and that the planner prefers it *among indexes* — which is
the half a test can pin, because the alternative is a cost estimate that moves
with table size. Whether the planner reaches for it UNFORCED is what
`scripts/bench-queries.mjs` reports, and that is where #185's before/after
numbers come from. It has an npm script (`npm run bench:queries -w
habiterall-cloud`) so it is invocable by name rather than by path, and it is
deliberately **not** in CI: it is DESTRUCTIVE — it empties `users`, `habits`,
`entries` and `notify_log` and seeds its own 20,000-user fixture, like the
tenancy suite — and it reports figures rather than passing or failing. Point it
at a throwaway database. If an index here is ever changed again, that script is
what re-establishes the numbers, and it is the file to update first.

None of this re-keys anything. `entries_pkey (habit_id, date)` and
`notify_log_pkey (habit_id, channel, date)` not leading with `user_id` is a
security decision with migrations 007 and 008 behind it — the composite foreign
key to `habits (id, user_id)` is what stops an invisible-row squat — and 016's
indexes are additions *beside* those keys. Read "the key does not lead with
`user_id`" as a thing that was paid for, not as an oversight to correct.

## An RLS table cannot be indexed on a non-leakproof operator

`jsonb_exists_any` (`?|`), `jsonb_exists` (`?`) and `jsonb_contains` (`@>`) all
have `proleakproof = false`. With a policy on the table, Postgres will not
evaluate a non-leakproof qual of the caller's ahead of the security qual — a
leaky operator could reveal a row the policy was about to hide — and an index
condition is by definition evaluated first. So on a table under RLS such a qual
can **never** become an `Index Cond`, whatever index exists. No jsonb index on
`users` can serve `candidates()` in `src/notifier.js`, and that scan is
knowingly a sequential one.

The trap is that nothing complains. The index builds, `ANALYZE` is happy, the
catalog says it is there, and the plan is byte for byte what it was. It only
looks otherwise if the `EXPLAIN` is taken on the admin connection, which is the
owner and bypasses RLS: no policy, no security qual, and the qual is free to
become an index condition in a plan of a query this application never issues.
That is exactly how #185 came to propose a GIN index on `users.settings` that
the app role could not have used; the measurements are in that issue's comment
thread. **Every plan taken in this edition must therefore be taken as
`habiterall_app` through `withUser` / `withNotifierScope`**, which is what
`test/schema-plans.integration.mjs` does and what anything added to it must do.

## `/healthz` has four callers, not the two it looks like

It is the only unauthenticated route here that touches Postgres. The container
healthcheck and an attacker are the obvious pair; the other two are the PWA's
connectivity probe (`isReachable`, on every boot and every visibilitychange) and
the Android setup screen's, and **both read anything but a 200 as "the server is
unreachable"**.

So a per-IP 429 does not shed load — it makes a browser banner itself offline and
divert writes to the outbox while the server is perfectly healthy. Self-feeding,
because going offline starts a backoff poll into the same bucket, and shared,
because an office NAT is one bucket for everyone behind it. `/healthz` therefore
**never answers 429**: over the limit it answers from the memo. `skip` covers the
other direction, since a healthchecker reads 429 as "down" and restarts the
container.

**What protects the pool is the memo (`src/health.js`), not the limit.**
`PG_POOL_MAX` is 10, and a per-IP limit is the wrong shape for pool exhaustion
anyway — a distributed flood pays nothing for a fresh bucket, while one second of
memo caps the cost at one connection per second however many callers arrive. Its
`inflight` half is what makes that true of the case that matters: a burst on a
cold memo would otherwise open a connection each and fill the memo afterwards.

It lives in its own file because `server.js` starts a server at import time, so
nothing declared in it can be unit tested — and the failure mode here is silent
in the worst direction, an `inflight` left set reporting the last good answer
forever while Postgres is down.

**Both pool timeouts are settable, `0` means OFF, and a cancellation is named.**
`statement_timeout` (15 s) and `idle_in_transaction_session_timeout` (30 s) go
in as connection parameters, so `SHOW` against a real session is the only thing
that can confirm them — `test/api.integration.mjs` does exactly that. They are
parsed by `timeoutFromEnv` and never by `Number(env) || default`, which is the
idiom next door at `PG_POOL_MAX` and is wrong here: **0 is a value Postgres has
a meaning for** — it disables the timeout — and `||` swallows exactly that
spelling. An unparseable value falls back *and warns*. `noteTimeout` logs
`pg.statement_timeout` / `pg.idle_tx_timeout` and rethrows untouched, rather
than converting to a 503 that would tell the offline outbox to replay a write
that cannot finish in the time allowed. `docs/decisions/caching.md` has the
rest, including why 15 s is the open judgement call here.

**The route is mounted ABOVE `app.use(session(...))`, and that is a rule rather
than a tidy-up.** It reads no session and never has, but below the middleware it
paid for one anyway: connect-pg-simple runs a `SELECT` on `session` for the
cookie, and `rolling: true` adds a touch `UPDATE` on top — two round trips, one
a write, on the one route whose job is to be cheap, and the memo covers
`SELECT 1` and nothing else. The personal edition has always mounted it there,
which is why only this edition had it. `sameOriginOnly` sits below too and costs
nothing, because it returns early for safe methods.

Nothing but a booted server can see that ordering, so `test/healthz.integration.mjs`
boots the real `server.js` and renames the `session` table out from under it:
above the middleware the probe still answers 200, below it answers 500. Its two
controls are the load-bearing half — one asserts `/api/me` returns **exactly**
500, because a 401 or a 403 is an answer about the *user* and passes with the
table intact, and one asserts a request below the middleware does write the row,
because otherwise "the column did not move" is also what a server with no
session handling at all would say.

## The dashboard is memoised, and a write is what clears it

`/overview` is the most expensive route here — five queries, one of them an
unbounded aggregate, plus per-habit synchronous CPU — and three tabs plus a
focus event is four identical computations within a few seconds. `overviewMemo`
(`src/api.js`, over `createMemo` in `src/cache.js`) is the health probe's shape
generalised to more than one key. **`docs/decisions/caching.md` is the whole
reasoning: the measurements behind every bound, the eviction policy, the
`Vary` that cost the offline dashboard, and what #192 should replace this
with.** What follows is only what you can get wrong from here.

**The key carries the caller's own DAY.** `summaryEnd` is `callerToday(req)`, so
two devices on one account either side of a date boundary send the *same URL*
and must get different answers. It is the same "whose day it is has two answers"
trap the root `CLAUDE.md` names, arriving through a cache instead of a route.
`buildOverview` is split out of the route so nothing in it can reach for `req` —
a payload depending on an input the key does not carry is the one way this is
wrong.

**Invalidation is one rule for every non-safe method, not a call per route.** A
list of the nine mutating routes is a list that drifts, and the errors are not
symmetrical: forgetting too much costs a recomputation, forgetting too little
paints a user's own tap away. It wraps `res.end` rather than listening for
`finish`, so the memo is clear before the first byte of the answer leaves.

**But `api.use(...)` is a rule about a ROUTER, and this edition writes from
outside it — twice.** The signed ntfy answer route is mounted above the `/api`
mount, and a Discord button press never touches Express at all. Both write a
real entry through `interactionAdapter().record`, and neither is reached by the
middleware. **`forgetAccount` (`src/cache.js`) is what a write path outside the
router calls**, with its `finally` OUTSIDE `withUser` so the forget follows the
COMMIT.

**Three per-user caches share one eviction policy** (`src/cache.js`): this memo,
`blockCache` and `lastReportedZone`. `session-touch.js`'s map is deliberately
not one of them — it bounds by clearing, because forgetting a session there
costs one extra `UPDATE`.

**Sharing a policy is not sharing a NUMBER: a cache whose entries cost something
else must pass its own bound.** `MAX_CACHED` (10,000) is justified by a ~100-byte
entry, and an `/overview` entry is a whole dashboard — 15 KB to 583 KB, a ~39×
spread, measured as the SERIALISED string because that is what `capBytes` sums.
So the memo passes `MAX_OVERVIEW_CACHED` (3,300), `MAX_OVERVIEW_BYTES` (48 MB)
and `MAX_OVERVIEW_PER_ACCOUNT` (8), the last because a shared bound is one an
account paging through its own history can spend alone. **The byte bound is the
operative one and the count is derived from it**, not the other way round: 3,300
is what makes 48 MB the limit reached first even at the SMALLEST entry size, and
a count sized against a residency argument is what the 60 s TTL invalidated (see
below). `createMemo` THROWS for a `maxBytes` with no `sizeOf`, at construction: a
byte bound with nothing to measure with is a comment claiming a bound, which is
the shape this module exists because of.

**The memo holds the SERIALISED payload**, which is what makes `sizeOf` exact
and lets a hit skip a `JSON.stringify` of up to ~580 KB. It is also why the
sizes above are the STRING and not the retained object — the archive records
both, and they differ by about 2×. `res.type` BEFORE `send` is the one way that
goes wrong — `res.send` of a string defaults the content type to `text/html`.

**Both ways of getting the bound wrong are silent**, in opposite directions —
thrash and no hits, or a killed container — and the count has no latency term in
it. So `overviewMemoGauge` rides on the runtime line beside `pg_pool_max`. A
`size()` read by nothing but tests is "who finds out?" answered with *nobody*.

**The memo is per PROCESS, and that used to be a statement about CORRECTNESS.**
On two replicas a tap handled by A and a refetch balanced to B was served B's own
pre-tap answer — the regression the invalidation exists to prevent, arriving
through the load balancer. All the ordering care above closes windows inside one
process and none of it reaches a second. Read a hit-rate metric knowing it is
1/N; the ANSWERS are no longer 1/N.

**`users.data_version` in the key is what closes that, and no client carries
anything** (#192). The account's counter is bumped in the same transaction as
every write (`withUserWrite`, `db/pool.js`) and read per request in front of the
memo, so an entry built before a write is unreachable on EVERY replica at once.
The `X-Habiterall-Fresh` header this used to be — a three-second hint both
clients sent after their own writes — is deleted rather than converted: it could
only ever speak for the device that WROTE, so a tab or a phone that had not
itself written was served the stale dashboard anyway.

**Read the version BEFORE the data, never after.** `withUser` is READ COMMITTED,
so the two statements see two snapshots, and the order decides which way an
interleaved write goes wrong. Version first tags an entry with the OLD version
holding NEW data — nobody asks for that key again, so it is simply unreachable
and the answer is rebuilt. Version last tags an entry with the NEW version
holding data read before the write, and every later reader asks for exactly that
key and is served it for the whole TTL. Silent, and in the worse direction.

**"Every write bumps" has one deliberate exception**: the device-zone middleware
above writes `users.device_time_zone` through bare `withUser`, on GETs, and does
not bump. It is an observation the server makes rather than a change to anything
`/overview` reads, and bumping there would invalidate an account's dashboards on
its own reads.

**The TTL is sixty seconds and is now a BACKSTOP.** It was two, which was as long
as it was safe to serve an answer nothing could prove was current. What a timer
is left to do is bound how long an unreachable entry stays resident and cap the
damage from a write path that forgot to bump, so it can be long — and
`MAX_OVERVIEW_CACHED` had to be re-derived at the same time, because it had been
sized against a live set of "what ten connections can produce in two seconds".

**The version read has no bail-out, and the pool cliff is an operator's problem
rather than the cache's.** The read costs ~0.3 ms with the pool idle and a full
transaction hold once it is not — measured, a cliff at exactly `PG_POOL_MAX`,
which moves with it. #192 first shipped a window that skipped the read entirely
while `pool.waitingCount > 0`; it was deleted, because "the pool is busy" is the
regime in which a tap on replica A and a refetch on B is *most* likely, and
serving B's pre-tap entry unchecked paints the user's own tap away — which the
header this replaced could not do at any pool depth, since the writer carried it.
An operator watching `pg_waiting` go non-zero should raise `PG_POOL_MAX`; the
knob already exists, and correctness is not the thing to buy latency with.

**There is a third regime past that cliff and it is a 5xx, not a slow answer.**
`connectionTimeoutMillis` is 5 s, so a pool held saturated for longer makes
`pool.connect()` reject and `/overview` answer 500 — on requests whose answer
was already memoised and which cost nothing before this change. The worker does
not soften it: `networkFirst` reaches its cached copy only when `fetch` throws,
so a 500 that arrives is shown. Raise `PG_POOL_MAX` well before this.

**A refused checkout is named, because it is the one pool failure that never
had a name.** All three helpers take their connection before their `try`, so
the rejection escapes `noteTimeout` — which matches SQLSTATEs, and an error
that never reached Postgres has none. `checkout()` wraps them and logs
`pg.checkout_failed` with the scope and the whole gauge; the gauge is what
separates a pool too small (`pg_total` at `pg_max`) from a database that is not
there (`pg_total` 0). **`pg_waiting` is not part of that test and must not be
added to it** — `pg` dequeues a request inside its own connection-timeout
callback, so the waiter that timed out is already gone from the count and a lone
one logs `pg_waiting: 0` while being the saturation itself. That event is the
TRIGGER for the
second pool the archive describes — a tiny one the version read owns, so a herd
of misses cannot starve the hit path — and the archive also says why the
smaller-looking fix, serving a resident entry when the checkout fails, is the
wrong one: it buys availability with exactly the staleness #192 deletes.

`docs/decisions/caching.md` has the measurements, the cliff table and the
deletion inventory. **The rule the deleted header found still stands and is not
about it**: a route the worker caches may not `res.vary` on a header the page
sends only sometimes — see `shared/public/CLAUDE.md`, and note
`res.vary(DEVICE_ZONE_HEADER)` is safe there because a device sends one zone on
every request.

## Which claim names the account

`displayName` in `src/auth.js` (unexported) picks what the chip shows:
`name -> preferred_username -> email`. `name` is an optional claim of the
`profile` scope — Authentik only emits it when the account's Name field has
been filled, so a bootstrapped admin with no Name set carries no `name` claim
at all. `preferred_username` is the claim carrying what the personal edition
calls a username, and unlike `name` an IdP has one for every account, which is
why it outranks `email`: cloud should read `mark` where personal would rather
read `mark@example.com`. A blank string counts as absent, hence the chain
trims before testing truthiness rather than testing the raw claim.

`display_name` is baked into the session at `/auth/callback` and `GET /api/me`
serves it from there — it must **not** re-read the `users` row. #205 is open
about exactly this route family paying for a database round trip it does not
need; a display name that goes stale at the IdP until the next sign-in is the
accepted trade, not a bug to fix here. `provision_user` refreshes
`display_name` on every login, so an existing row corrects itself the next
time that user signs in — no migration, no backfill.

`test/login-claims.integration.mjs` proves the chain reaches the response
body, not just the mapping function, by driving a real `/auth/login` ->
`/auth/callback` -> `/api/me` round trip against a fake issuer — no Authentik
needed. Its ID tokens are signed with `node:crypto` alone
(`generateKeyPairSync('rsa', ...)` plus `createSign('RSA-SHA256')`), on
purpose: `jose` is already a transitive dependency of `openid-client`, but
pulling it in directly for one test file is a dependency this suite does not
need to add.

## Verify it, don't trust it

```bash
npm run test:tenancy    # isolation attacks — from the repo root
npm run test:cloud      # API, settings, and the Loop round trip
```

Both need Postgres and run on every pull request.

That suite *attacks* the isolation: cross-user reads, forged `user_id`
inserts, malicious backups, `replace`-mode wipes, and privilege checks. Run it
after ANY change to the schema, the RLS policies, `db/pool.js`, or
`apply-import.js`.

## Migrations

Numbered SQL in `src/db/migrations/`, applied by `src/db/migrate.js` running
as a **separate admin credential the app never holds**.

Gotcha: `docker compose run --rm migrate` uses a cached image. After adding a
migration, `docker compose build migrate` first or it will report "already up
to date".

## Local stack

`docker compose up -d` brings up Postgres, Authentik (server + worker), the
migrations, the bootstrap and the app. The app listens on **:3100**;
Authentik's admin UI is on **:9000**. See `SETUP.md`.

`cp ../examples/cloud.env.example .env` first — the template moved out of this
package, because a downloader of `examples/docker-compose.cloud.yml` needs the
same one and one copy is the point.

`db`, `migrate` and `app` carry no environment block here: they `extends` the
ones in `examples/docker-compose.cloud.yml` and add the build. That file is the
one place this edition's variables are written down, and `examples/CLAUDE.md` has
the whole argument. Only the top-level `volumes:` declarations are restated by
hand; `depends_on` IS inherited — measured, where this used to hedge — so `app`
writes just the `authentik-bootstrap` key and the other two merge in beside it.

The topology still differs from `examples/docker-compose.cloud-authentik.yml`
on purpose: Authentik's database lives in the *same* Postgres server here,
created by `scripts/init-authentik-db.sh`, which is a file a downloader of that
example does not have.

Which is why the `authentik-*` services here are still a hand-kept copy of that
example's, rather than extended from it — and the blocker is exactly the
inheritance above. `depends_on` merges key by key and a key cannot be removed,
so extending services that depend on an `authentik-db` this stack does not run
gives `depends on undefined service "authentik-db": invalid compose project`.
Unified for the app, guarded for the rest. Both files are in `compose.test.js`'s list, so a new switch in
`bootstrap-authentik.mjs` has to reach both or one of them fails. If you add one
through `flag()`, add it to the `@env` marker beside it as well: it reads
`process.env[name]`, and nothing can see through that.

## Authentik is configured by a script that runs on every `up`

`scripts/bootstrap-authentik.mjs` creates the OIDC provider and application,
switches self-service registration on or off, and applies the branding. It is
idempotent by design, because that is what lets `.env` be the source of truth:
edit a value, `docker compose up -d`, and the identity provider agrees with the
file again. Authentik has no declarative config for the application in the free
tier, so this drives its API with `AUTHENTIK_BOOTSTRAP_TOKEN` — and with the
token gone it exits 0 having done nothing, which is what keeps `up` working
after the production checklist has you delete it.

**The client id and secret are pushed, not read back.** They are generated
into `.env` like every other secret and *set* on the provider, so the app and
the IdP are configured from the same two lines. Left empty, Authentik
generates a pair and the script prints it — the old paste-it-back flow, still
supported, no longer the path.

**A `CHANGE_ME` value from `.env.example` is refused, and the bootstrap token
is one of them.** The three the guard covers are the three that are worth
something to a stranger holding a public repository: the OIDC pair, because it
is written *onto* the provider, and `AUTHENTIK_BOOTSTRAP_TOKEN`, because
Authentik turns that line into a full admin API token for `akadmin` on every
boot. An unedited file otherwise reaches a stack that starts, reports
everything configured, and accepts an admin token whose value is published.

**Without the token the script states what is frozen; it does not warn.** It
used to warn when one of the three switches was set, which read as "your edit
did not take effect" — but both compose files default all three, so the
condition was true on every boot and the alarm fired at an operator who had
changed nothing. Whether `AUTHENTIK_SELF_SIGNUP=off` still disagrees with
Authentik cannot be known here at all: reading back what was applied needs the
API, which needs the token. So the no-token path prints one line naming the
switches that have no effect, and the production checklist carries the warning.

**The published-image path OVERWRITES the volumes it fills.** `publishFiles`
copies the blueprints and the branding assets out of the image on every run,
because they are versioned artifacts that ship inside it. `force: false` made
the first run's copies permanent: an upgraded image applied the previous
release's blueprint forever, while still logging that it had published them.
Nothing can tell an operator's edit in that volume from an older image's file,
so nothing tries — the checkout compose bind-mounts the directories for exactly
that case.

**`grant_types` must be sent explicitly.** The field defaults to an empty list
and an empty list permits nothing: a provider created without it looks correct
in the admin UI and rejects every sign-in with "Invalid grant\_type for
provider", which arrives at the app as `AuthorizationResponseError` and at the
user as a 500 on `/auth/callback`. That was a real bug here, and a fresh stack
could not log in at all.

**Signing out needs TWO redirect URIs and an ID token, and neither half works
alone.** Authentik has no separate post-logout field: `post_logout_redirect_uris`
is a property over `redirect_uris` filtered on a per-entry `redirect_uri_type`,
which defaults to `authorization`. So registering only the callback leaves that
list empty, `EndSessionView` gates its whole redirect block on it being
non-empty, and the `post_logout_redirect_uri` the app sends is discarded in
silence — signing out ends both sessions correctly and leaves the user sitting
on the identity provider's page, which reads as "sign-out took me to the wrong
site" rather than as anything being broken.

Registering the logout URI **on its own is worse than not registering it**,
which is why the bootstrap and `server.js` have to change together and why one
test asserts both. Once that URI exists, Authentik validates `id_token_hint`
*before* it plans the invalidation flow, so a request without one is an
`id_token_hint_missing` error page — a redirect that went nowhere becomes a
sign-out that does not happen. `completeLogin` therefore returns the ID token
beside the user and the callback stores it on the session, inside `regenerate`,
because regenerate discards whatever the old session held. Nothing reads a claim
out of it; it is carried, not trusted.

Both URIs are built with `new URL` rather than interpolated. `PUBLIC_URL` is
used raw here where `ISSUER_BASE` strips a trailing slash, and Authentik matches
these as exact strings — so a `PUBLIC_URL` ending in `/` registered
`https://host//auth/callback` against the single-slash form the app actually
sends, and the logout entry, whose path is a bare `/`, is where that bites
first.

None of this is visible to a test that calls `/auth/logout` with `fetch` and
checks for a 401, which is what existed and what passed throughout. The
redirect is the half only a real navigation can see —
`test/browser/cloudlogin.mjs` follows it now.

**And following it is still not signing out, because the flow it runs was the
one that does nothing.** Authentik ships two invalidation flows and the
end-session endpoint runs whichever the provider names.
`default-provider-invalidation-flow` is called "Logged out of application" and
has **no stages at all**: it shows that sentence and redirects.
`default-invalidation-flow` is called "Logout" and carries the `user_logout`
stage, which is the thing that ends the session. The bootstrap preferred the
first — `slug.includes('provider')`, on the reasonable-looking ground that this
is a provider — so every sign-out ended habiterall's session, left Authentik's,
and the next sign-in went straight through with no prompt. Both clients, not
just the phone: the web app follows the same `redirect`.

So `pickLogoutFlow` asks what a flow DOES, reading its bindings, because the
name is exactly what got this wrong and a flow with no stages cannot log
anybody out whatever it is called. Verified on an emulator against a real
Authentik rather than argued: sign out, tap Sign in, and the provider asks for
a username. It is worth measuring that way, because every wrong version of this
*also* ends with the app on its sign-in screen — the local session goes either
way, and the whole bug is in the half the app cannot see.

One trap in checking it: **Authentik's request log does not record the
invalidation flow**, so "the end-session endpoint was never called" is a
conclusion its logs will support when the call plainly happened. The WebView's
console is where the flow is visible.

**Registration and branding are blueprints, applied with a context this script
chooses.** `blueprints/*.yaml` are mounted read-only into both Authentik
containers and carry `instantiate: "false"`, so Authentik's own discovery never
applies them — it would apply them with an EMPTY context, and an empty context
means "signup off", which would quietly close registration on the next boot.
The script uses `POST /managed/blueprints/import/`, which applies once and
answers with the importer's own logs, so a broken blueprint fails the run
instead of leaving a task to go and read.

The switches are real booleans in that context, never `!Env` in the blueprint:
every truth test a blueprint does is Python truthiness, so `AUTHENTIK_SELF_SIGNUP=false`
would read as a non-empty string and turn registration **on**. The script
parses the environment strictly and refuses a value it does not recognise.

Three things about the blueprints are load bearing, and all three were found by
running them:

- **Every `absent` entry asks whether the object exists first**
  (`conditions: [!Condition [OR, …, !Find […]]]`). Authentik builds a throwaway
  model instance for identifiers that match nothing, and `Flow`/`FlowStageBinding`
  take their primary key from a `default=uuid4` — so the throwaway looks saved,
  `absent` deletes an object with a pk and no row, and the importer raises
  `RelatedObjectDoesNotExist` and fails the whole apply.
- **The "Sign up" link is written by the script, not the blueprint.** It is one
  field on the login flow's identification stage, and that serializer rejects a
  partial update omitting `user_fields` ("When no user fields are selected, at
  least one source must be selected"). A blueprint could only set the link by
  restating which fields the login form asks for, every `up`, over whatever an
  operator had chosen. So the script reads the stage and writes it back with one
  field changed.
- **The flow background is set per flow, not on the brand.**
  `branding_default_flow_background` is the setting for it and does not reach the
  screen in 2026.5.6: the challenge is built by `flow.background_url(use_cache=False)`
  with no request, and without a request the fallback is a hardcoded path to
  Authentik's own photograph rather than the brand's value.

**Turning registration off deletes the flow.** An enrollment flow is reachable
at `/if/flow/<slug>/` whether or not the login page offers a link to it, so
unlinking alone would leave the door open with the sign hidden.

**What a signed-out user sees was read off the rendered page, not guessed** —
brand title, brand logo, the *flow's* title, and a footer line. Three are
fields; "Powered by authentik" is appended unconditionally by `ak-brand-links`
in the shipped bundle, so it is hidden with the brand's custom CSS, which
Authentik adopts into the flow's shadow roots. The logo's `alt` is still
"authentik Logo" and stays that way: it is hardcoded in the same bundle, and
the alternative is patching a file inside the image on every upgrade. The
confirmation email's subject is the EMAIL STAGE's field, not the brand's — the
template is never handed a brand, and the stage's default is the bare word
"authentik".

**Brand-level settings are not scoped to the sign-in pages.** Only the flow's
own title and background are. `base/skeleton.html` renders `branding_title`,
`branding_favicon` and `branding_custom_css` into the admin and user
interfaces too, so those three follow you in there. Worth knowing before
writing a CSS rule general enough to restyle Authentik's admin — the accent on
`.pf-c-button.pf-m-primary` already does.

Two guards deliberately refuse to run insecurely and must be overridden for a
local HTTP stack (`ALLOW_INSECURE_OIDC=true`), both logging loud warnings:
`openid-client` rejects plaintext issuers, and cookies go non-`Secure` when
`PUBLIC_URL` is not HTTPS. **Never set that flag in a real deployment.**

The OIDC issuer string must resolve identically from the browser *and* the app
container, or token validation fails on an issuer mismatch. In production both
use the same public HTTPS URL; locally, compose aliases the host via
`extra_hosts`.

## Frontend

There isn't one here beyond `public/app-entry.js`. The UI lives in
`shared/public/` and is served by the static mounts in `src/server.js`. Do not
copy files back into this package.

**Those mounts are ABOVE `app.use(session(...))`, for the same reason `/healthz`
is and one more.** Nothing under `shared/public/` reads a session, so below the
middleware every asset paid for a `session` SELECT plus a `rolling: true` touch
UPDATE — thirty-odd round trips against Postgres per cold shell, to hand back
files off a disk. The half that was visible from outside: `rolling` re-stamps the
cookie on every response it reaches, so each asset went out carrying
`Set-Cookie`, and **no shared cache will store a response that sets a cookie**.
Read off the live instance, every asset came back `cf-cache-status: BYPASS` —
the CDN declining to cache the whole frontend. `Cache-Control: public, max-age=0`,
which is what `express.static` says when nothing passes `maxAge`, was
independently enough to cause the same thing; `STATIC_CACHE`
(`shared/src/security.js`) is the other half. The personal edition never had
either, having always mounted static up there.

The ordering is pinned in `shared/test/static-cache.test.js`, which reads both
editions' `server.js`, because nothing here can be booted without a Postgres and
an identity provider. The behavioural half — sign in, then check that an asset
comes back with no `Set-Cookie` while `/api/me` still does — is
`habiterall-personal/test/static-cache.integration.mjs`, over the same three
lines.
