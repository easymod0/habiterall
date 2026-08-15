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
one place this edition's variables are written down, and the root CLAUDE.md has
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
