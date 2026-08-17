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


