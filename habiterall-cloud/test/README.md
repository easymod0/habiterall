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

node test/tenancy.integration.mjs
node test/api.integration.mjs
node test/roundtrip.integration.mjs
node test/notify.integration.mjs
```

Run them after ANY change to the schema, the RLS policies, `db/pool.js`, or
`apply-import.js`.

## `notify.integration.mjs`

The reminder scheduler's storage adapter: which accounts the cross-user scan
finds, that the per-user reads go through `withUser` like everything else, and
that the watermark is keyed on each account's *own* local date — a server in
UTC and a user in Tokyo must not file a send under the wrong day and repeat it
hours later. Every send goes to a fake `fetch`; nothing here reaches Discord.

The policy that lets the scan span users at all is attacked in
`tenancy.integration.mjs` — see the "notifier scope" checks there and the
header of `migrations/008_notify_log.sql`.

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
