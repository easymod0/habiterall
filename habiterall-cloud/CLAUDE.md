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

**Settings are a JSONB column on `users`**, covered by the existing
`users_select_self` / `users_update_self` policies — no new RLS needed. The
app role was granted `UPDATE (settings)` explicitly; it still cannot touch
`idp_subject` or `blocked`.

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
entries, and `notify_log` — so a mistake there still fails closed. Read the
header of `008_notify_log.sql` before touching any of it.

**A button press is authorised by its channel.** `interactionAdapter` in
`src/notifier.js` resolves the account from `interaction.channel_id` — through
the notifier scope, since it spans users — and everything after that runs in
`withUser`. The habit id on the button is looked up *inside* that account, so a
forged one finds nothing rather than someone else's habit; the tenancy suite
attacks exactly that. Two accounts naming the same channel resolves to neither,
because guessing would write to the wrong person's history.

**A webhook URL is a user-supplied URL that the server fetches.** It is
validated in `shared/src/notify.js` against Discord's own hosts and stored
canonicalised; `/api/notify/test` re-reads it from the database rather than
taking one from the request body, and carries its own tight rate limit because
it causes outbound traffic.

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

`docker compose up -d` brings up Postgres, Redis, Authentik (server +
worker), and the app. The app listens on **:3100**; Authentik's admin UI is on
**:9000**. First run needs `scripts/bootstrap-authentik.mjs` to
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
