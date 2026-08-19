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
  no DDL, no `INSERT`/`DELETE` on `users`, and column-level `UPDATE` on
  `email`, `display_name`, `last_seen_at`, `settings` and `device_time_zone`
  — and nothing else. Keep that list exact: it is the one place the boundary is
  written down in prose, and it had already gone stale for `settings` once.
  `idp_subject`, `idp_issuer`, `blocked` and `id` are SELECT-only, which is
  what stops an account editing its own identity or unblocking itself.

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
