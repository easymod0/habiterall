# Authentication and the security config

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**One auth adapter, and the server says which mode it is in.**
`shared/public/auth-session.js` covers all four states — `none`, `password`,
`setup`, `oidc` — because with no build step there is nothing to pick a module
at package time, so baking the edition into a file meant the personal edition
could not make auth a runtime choice at all. `GET /api/me` carries `mode`, and
so does its **401**: a signed-out client is the one that needs to know whether to
draw a form or a link, and that response is all it gets. It replaced
`auth-none.js` and `auth-oidc.js`, and both editions' `app-entry.js` are now the
same three lines.

Which makes `/api/me` the one route that reads a session **without**
`requireAuth`, since it sits above the `/api` mount and has to answer a caller
who has none. It therefore has to repeat by hand every question that middleware
asks, and it did not: it checked that a session existed and not that it was still
valid against the current credential, so a revoked cookie got a `200` naming the
account it no longer had. That is the answer the whole boot is built on — the
app painted its signed-in shell and threw it away on the first dashboard fetch —
and it handed back the previous owner's username on the way.

**Boot has to be able to fail visibly.** Everything `start()` does before the
first paint now happens with every view hidden, so an error escaping it used to
leave a completely blank page under a toast that cleared itself in 2.6 seconds.
`#view-error` is that surface, and the case it exists for is not exotic: a
`CACHE_VERSION` bump drops the data cache, so the first offline boot afterwards
gets the service worker's synthetic 503 for `/api/me` — which `load()` correctly
refuses to read a mode from. The split in `start()` is deliberate: anything up to
and including the dashboard's first render goes to that view, and
`handleLaunchAction` afterwards only toasts, because by then there is a painted
app that replacing would be the larger loss.

**Sign-in belongs in the app, not in the reverse proxy** — because of the
Android client. `android-native/.../data/Api.kt` talks to `/api` directly,
outside the WebView, so a proxy's login form is one it cannot fill; exempting
`/api` to fix that exempts everything worth guarding. The app also needs a `401`
it can act on, and a proxy answers an expired session with `200` and an HTML
login page, which the offline replay queue feeds straight to a JSON parser. Both
editions therefore issue the same cookie (`SESSION_NAME`, `httpOnly`,
`SameSite=Lax`), so one path in `Api.kt` can carry either.

**And the phone gets that cookie two ways, because the two editions ask
different things of a person.** The personal edition holds one credential and
can be asked for it, so the app draws a form and posts `/auth/login`. The cloud
edition redirects to an identity provider, which decides for itself whether that
means a password, a passkey or somebody else's login page — no native form can
stand in for it. So cloud sign-in is the *server's own page*, loaded in the
app's WebView, and it works because the session is a cookie and
`WebSession` makes Android's `CookieManager` the one store OkHttp and the
WebView share. A Custom Tab could not do this: its cookies belong to the
browser. `httpOnly` is untouched by any of it — that flag stops JavaScript
reading a cookie, and this is the native API underneath.

**Signing OUT of that is a page too, and for the same reason sign-in is.** The
app's session is a cookie on this server; the identity provider holds one of
its own, on its own origin, and `WebSession.clear` cannot reach it —
deliberately, because emptying every site's cookies would sign the user out of
everything that shares that provider. So the provider's session is ended by
VISITING its end-session URL, which `POST /auth/logout` hands back and which
nothing used to load: the local session went, the credential that silently
recreates it stayed, and on a shared device that is the half that matters. An
OkHttp call cannot stand in for the visit — its cookie jar is not where the
provider's cookie lives — and neither can a hidden load, because a provider is
entitled to ask something first and a confirmation nobody can reach is the same
silent survival. `Auth.endSession` is the rule and `SignOutScreen` is where it
is allowed to be a page.

Two things about that rule read as edition-specific and are not. **The server's
own root is nowhere to go** — the personal edition answers `/` and so does
cloud when its provider has no end-session endpoint — which is what keeps this
from guessing where a provider lives, since a self-hosted one commonly sits on
the same host one port over. And the value is **checked before it is loaded**
even though it came from the server we are authenticated to, because `loadUrl`
executes a `javascript:` URL in the context of whatever the WebView is showing;
resolving it as http(s) is the whole check and it costs one line.

The other half of that sign-out is not in this app at all — Authentik ships two
invalidation flows and the bootstrap named the one with no stages in it. See
`habiterall-cloud/CLAUDE.md`; the point worth carrying here is that **every
wrong version ends with the phone on its sign-in screen**, because the local
session goes either way. Only asking the provider for a password again tells
you which version you have.

That is what makes a token endpoint unnecessary, and with it an OAuth client the
operator would have to register. The cost is that `AuthMode` and `Auth.read` are
a **mirror** of `shared/public/auth-session.js`, pinned by `AuthTest` for the
same reason `ReminderTime` and `Grid.nextState` are pinned: both clients boot
the whole app on one answer, and two readings of it are indistinguishable from
one being broken. The rule that matters most is the one the web adapter shipped
wrong — only 200 and 401 say anything about how an instance authenticates. On a
phone that is sharper than in a browser: a captive portal answering 200 with
HTML is a state no retry escapes if it is read as "signed in".

**But the phone adds a second half to that rule, and it is the opposite of an
error path.** Everything that is not 200 or 401 is `Session.Unknown`, and the
app **carries on past it** rather than stopping. A native client boots through
this route, so making a bad answer fatal breaks the same instance the web bug
broke, by a different road: `HABITERALL_AUTH=off` never needed `/api/me` at all,
and the personal edition's read limiter keys on IP — so a household behind one
NAT can 429 it while the server is perfectly healthy. An early version of this
had a "the server answered oddly" screen and that is exactly what it would have
covered. The list's own error state already reports a broken server, with a
retry, and it is reached by the requests that actually need one. Being wrong
this way costs a round trip; being wrong the other way costs the whole app.

One consequence reached further than the sign-in screen. `Outbox`'s worker
dropped every 4xx as permanently inapplicable, which was right while nothing
could 401 — and became a silent data loss the moment sign-in existed, because
the answer tapped on a notification is still true about that day when the cookie
ages out. `ApiException.isPermanent` is the rule now, and 403 is excluded
alongside 401 for the reason the web outbox already had: a proxy rewriting
`Host` with no hop trusted makes every write look cross-origin, and that is a
misconfiguration that gets fixed.

**The security config is shared; the limiter's key is not.**
`shared/src/security.js` holds the CSP, the session cookie shape, the four rate
limits and the `TRUST_PROXY` rule, because those describe `shared/public/` rather
than an edition — two copies of a CSP is two chances to break the PWA in exactly
one of them. What stays per edition is `keyGenerator`: cloud keys per
authenticated user, personal keys on IP through `ipKeyGenerator`, which
normalises IPv6 to its /56 (a bare `req.ip` gives one client 2^64 buckets to
rotate through, and express-rate-limit v8 says so at startup rather than
failing).

**The absence of a field is not a statement.** `auth-session.js` resolves the
mode from `/api/me`, and it used to read "no `mode` in the body" as an answer:
`body.mode ?? (res.ok ? 'none' : 'oidc')`. Both guesses were wrong somewhere. A
429 from the API limiter carries no mode — and the personal edition keys on IP,
so one household behind one NAT shares the bucket — which replaced a working app
with a sign-in screen whose only control 404s, on an instance with no auth at
all. Offline was sharper still: the service worker answers an unreachable API
with a *synthetic 503* rather than throwing, so the `catch` that existed for
exactly this never ran. Only 200 and 401 say anything about how an instance
authenticates; everything else is a fault and belongs on the error path.

**A cookie session needs an origin check, and a missing `Origin` must pass.**
Both editions authenticate with a cookie, which is what makes forgery possible:
a form on another site POSTs here and the browser attaches the session.
`SameSite=Lax` stops that in every current browser and is why the cookie is set
that way — but it is a defence written in one attribute, invisible at the routes
it protects. `sameOriginOnly` states the other half where the requests are.
Browsers always send `Origin` on a state-changing request, so a mismatch is
forgery and nothing else. What has no `Origin` is a *native* client — `Api.kt`
answering a notification — and refusing those would break the Android client to
stop a request it cannot make. That is also why this is an origin check rather
than a CSRF token: a token must be fetched, held and replayed by every client,
and the point of both editions issuing the same cookie is that the phone needs
no special path.

Its refusal is a **403, and the outbox must not treat that as a verdict on the
write.** The replay loop drops any 4xx other than 401 as permanently
inapplicable, which is right for a deleted habit and wrong for this: `req.host`
is trust-proxy-aware, so a proxy that rewrites `Host` with no hop trusted makes
every write look cross-origin, and the first flush after that silently destroyed
the entire queue. 403 now keeps its place in line, exactly as 401 does — the
misconfiguration is fixable, and the writes replay when it is.

**`req.host` is the third thing `TRUST_PROXY` decides**, after the limiters' key
and — since the personal edition stopped deriving it from a URL — whether the
session cookie can be `Secure` at all. All three fail quietly and in different
directions, which is why `warnOnUntrustedProxy` names all three.

**A `Secure` cookie is a per-REQUEST answer in the personal edition.** It was
`PUBLIC_URL.startsWith('https://')` — one verdict for the process — which is
exactly wrong for the deployment `HABITERALL_UPGRADE_INSECURE` is written for:
https from outside, plain http from the LAN, same database. The browser at
`http://192.168.1.5:3000` discarded the cookie, so login answered 200, the page
reloaded, and the app came back signed out forever with no error at either end.
`secure: 'auto'` asks `req.secure` instead, so each way in gets its own answer.
Cloud keeps the URL-derived form: it has one public origin, demands `PUBLIC_URL`,
and has no LAN half to serve.

**The credential limiter is not switchable.** `HABITERALL_RATE_LIMIT=off` exists
so a test run is not throttled on ordinary reads; it briefly reached
`/auth/login` too, which turned it into "also remove the only bound on guesses at
a single shared password" — something no amount of trusting your own network
justifies, and which the name does not hint at. CodeQL found it, because routing
the limiter through a helper that might return a pass-through is also how a
static analyser stops being able to see it. The auth suite now counts the
attempts that get through.

**`upgrade-insecure-requests` is the caller's decision, not helmet's.**
helmet adds it by default, which is right behind TLS and a trap on plain http:
the browser rewrites every request to https, nothing is listening, and the app
does not load. It goes unnoticed on `localhost`, which browsers exempt, so it
only ever breaks on a real address. `cspDirectives(upgradeInsecure)` takes it as
a parameter because the two editions want different answers — cloud ties it to
its own scheme, personal makes it an explicit opt-in
(`HABITERALL_UPGRADE_INSECURE=on`) and defaults to off, because a self-hosted box
is commonly reachable over both schemes at once and deriving it would break the
plain-http half.



## The Authentik bootstrap script (habiterall-cloud's local stack)

`habiterall-cloud/scripts/bootstrap-authentik.mjs` runs on every `docker
compose up` in the checkout stack. Everything below was found by running it;
the rules stayed in `habiterall-cloud/CLAUDE.md`, the reasoning is here.

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

