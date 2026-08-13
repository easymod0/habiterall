# habiterall-cloud — working notes

Multi-user edition: Postgres, OIDC login, Docker Compose. This holds other
people's personal data, so read the security model before touching anything
in `src/db/` or `src/auth.js`.

## The security model

**Tenant isolation is enforced by Postgres, not by application code.**

- Every table is `FORCE ROW LEVEL SECURITY` with a policy on
  `app_current_user_id()`.
- `withUser(userId, fn)` sets `app.user_id` transaction-locally, so it cannot
  leak between pooled connections.
- A query that forgets its `WHERE` clause therefore returns **nothing**. The
  isolation fails closed.
- The app connects as `habiterall_app`: not the table owner, `NOBYPASSRLS`,
  no DDL, no `INSERT`/`DELETE` on `users`, and `UPDATE` only on
  `email`/`display_name`/`last_seen_at`.

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

## Verify it, don't trust it

```bash
npm run test:tenancy    # from the repo root
```

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

`docker compose up -d` brings up Postgres, Redis, Authentik (server +
worker), and the app. First run needs `scripts/bootstrap-authentik.mjs` to
create the OIDC client — see `SETUP.md`.

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
