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
```

Run it after ANY change to the schema, the RLS policies, `db/pool.js`, or
`apply-import.js`.
