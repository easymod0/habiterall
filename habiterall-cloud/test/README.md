# Tests

`tenancy.integration.mjs` is an **adversarial** test of multi-tenant
isolation: it actively tries to read, modify, and delete another user's data,
and to smuggle rows into another account through an import. It needs a real
Postgres, so it is not part of `npm test`.

```bash
docker run -d --name hab-pg-test -p 55432:5432 \
  -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=habiterall -e POSTGRES_USER=owner \
  postgres:17-alpine

DATABASE_URL_ADMIN='postgres://owner:testpw@localhost:55432/habiterall' \
APP_DB_PASSWORD='apptestpw' node src/db/migrate.js

node test/schema-plans.integration.mjs
node test/tenancy.integration.mjs
node test/api.integration.mjs
node test/roundtrip.integration.mjs
node test/notify.integration.mjs
```

`schema-plans` goes first because it is the only one that wants a database
nothing has put rows in yet, and because the others reset what they need.

Run them after ANY change to the schema, the RLS policies, `db/pool.js`, or
`apply-import.js`.

## `schema-plans.integration.mjs`

What the schema lets Postgres *do*. Migration 016 changed no answer — every
query returns exactly what it returned before it ran — so there is nothing here
for an API suite to see, and this one asserts against the catalog and the
planner instead of against a payload: that no function an RLS policy depends on
is `PARALLEL UNSAFE`, that no table carries two indexes with identical
definitions, that every foreign key has an index to cascade through, and that
`idx_entries_owner_habit` and `idx_notify_log_owner_date` carry exactly the key
columns — in order — and the INCLUDE lists they were added for. The first of
those is the one that goes away in silence: a later
`CREATE OR REPLACE FUNCTION` omitting the clause resets the flag, and both
functions sit in the `USING` clause of a policy on every table.

What an index IS and whether the planner CHOOSES it are two different
questions, and the second one needs rows. The structural halves come out of
`pg_index` / `pg_attribute` and run on an empty database; the one
planner-choice assertion seeds 6,000 entries, `ANALYZE`s, and forces off both
sequential and bitmap scans, because a bitmap scan over the right index is
still not an index-only scan and would not falsify a missing INCLUDE list. It
deletes that fixture and re-analyses afterwards, since the CI `cloud` job runs
several suites against one database and stale statistics for a table that is
now empty are the next suite's problem.

**Every plan it takes is taken as `habiterall_app` through `withUser` /
`withNotifierScope`, and any plan added here must be too.** An `EXPLAIN` on the
admin connection bypasses RLS, so it describes a query this application never
issues — the security qual that decides which index is usable at all is simply
not in it. That is not a style preference; it is how #185 came to propose an
index the app role can never use. See `../CLAUDE.md`, "An RLS table cannot be
indexed on a non-leakproof operator".

## `notify.integration.mjs`

The reminder scheduler's storage adapter: which accounts the cross-user scan
finds, that the per-user reads go through `withUser` like everything else, and
that the watermark is keyed on each account's *own* local date — a server in
UTC and a user in Tokyo must not file a send under the wrong day and repeat it
hours later. Every send goes to a fake `fetch`; nothing here reaches Discord.

The policy that lets the scan span users at all is attacked in
`tenancy.integration.mjs` — see the "notifier scope" checks there and the
header of `migrations/008_notify_log.sql`.

## `login-claims.integration.mjs`

Which claim ends up naming the account: `name -> preferred_username -> email`
(`src/auth.js`). It boots the real `server.js` and drives a real
`/auth/login` -> `/auth/callback` -> `/api/me` round trip against a fake
issuer it starts on an ephemeral port, so it needs no Authentik and no
network — only Postgres, for the same reason every other suite here does.

The assertion is on `GET /api/me`'s response body, not on the mapping
function directly: a unit test on the function alone would pin the ordering
and nothing about whether `completeLogin` actually wires it into the session.
Every case also asserts the login answered `200`, because a suite in which
every login had silently broken would otherwise still read as a pass on the
case that expects an empty name.

## `roundtrip.integration.mjs`

Seeds a known dataset, exports it as JSON, a Loop `.db`, and a CSV archive,
imports each one back, and asserts nothing changed. It shares its fixture and
comparison rules with the personal edition's suite
(`@habiterall/shared/test/roundtrip-fixture.mjs`), so the two editions cannot
disagree about what a faithful restore means.

It also checks that a restore stays inside the importing account: Bob
importing Alice's backup — ids and all — must leave Alice untouched, including
in `replace` mode.

Each format is held to what it can actually carry. JSON is lossless. The Loop
`.db` and the CSV archive carry every habit attribute and entry but have
nowhere to put per-day notes, so a day whose only content is a note is
expected to be dropped — and the test asserts that exactly one such day
disappears, rather than loosening the comparison.

## `browser/cloudlogin.mjs`

The only suite that signs in for real: Chrome, the Authentik container, the
whole OIDC round trip, then the authenticated app and signing out again.

**It needs an account that nothing creates.** `testuser` /
`TestPassw0rd!123` is a prerequisite, and its absence does not look like one —
Authentik re-serves the password prompt, the suite submits it twelve times and
then reports "returned to the application after login" as the failure, which
reads as a broken redirect rather than a missing user. With the bootstrap token
still in `.env`:

```bash
TOK=$(grep '^AUTHENTIK_BOOTSTRAP_TOKEN=' .env | cut -d= -f2-)
PK=$(curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"username":"testuser","name":"Test User","email":"testuser@example.com","is_active":true,"path":"users"}' \
  http://localhost:9000/api/v3/core/users/ | python3 -c 'import json,sys; print(json.load(sys.stdin)["pk"])')
curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"password":"TestPassw0rd!123"}' "http://localhost:9000/api/v3/core/users/$PK/set_password/"
```

It also **creates a habit and does not clean up**, so a second run reports
`["Cloud Habit","Cloud Habit"]` against a check that wants one. Delete that
habit between runs; the rest of the suite is idempotent.

Signing out is checked in two halves, and the second is the one that had a bug.
A `fetch` to `/auth/logout` can see the app's own session go away, and that is
all it can see — the browser being left on the identity provider's page is
invisible to it. So the suite reads the `redirect` out of the response and
**navigates to it**, then asserts where it landed. Both `id_token_hint` and
`post_logout_redirect_uri` are asserted on the URL as well, because Authentik
needs each for a different reason and either one alone is broken: see the
`redirect_uris` comment in `scripts/bootstrap-authentik.mjs`.
