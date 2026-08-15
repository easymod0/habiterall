# habiterall-personal — working notes

Single-user edition: SQLite, one account, **optional password sign-in**.

This used to say "no authentication by design — if it needs to face the
internet, use `habiterall-cloud`", and that advice pointed the wrong way for the
common case: one person who wants their own habits from outside the house. Cloud
means standing up Postgres and an OIDC provider to guard a single dataset.
Putting the app behind a reverse proxy's own auth was the other answer, and it
breaks the Android client, which talks to `/api` directly and cannot fill in a
login form — see the root CLAUDE.md.

So sign-in lives here, and it is **on unless you turn it off**
(`HABITERALL_AUTH=off`). What it is *not* is multi-user: everyone who signs in
shares one set of habits. Separate data per person is still `habiterall-cloud`.

## What lives here

Only what is coupled to storage:

- `src/db.js` — schema, connection, and the in-place migration that moved
  skips out of `entries.value` into `entries.status`
- `src/api.js` — routes; validation comes from `@habiterall/shared/validate.js`
- `src/apply-import.js` — the SQLite *writer*; parsing is shared
- a `settings` key/value table — preferences live server-side, so they survive
  a browser reset and are captured by the same backup as the habits
- `src/notifier.js` — the storage half of server-sent reminders: read this
  user's settings and habits, record what has been sent (`notify_log`), and
  record how each destination last behaved (`notify_status`, which is what
  `GET /api/notify/status` and the settings dialog read). The scheduling and
  the delivery are in `@habiterall/shared/notify.js` and `notify-send.js`
- `src/auth.js` — the three modes, the routes, and the session secret. The
  hashing and the "is auth on?" rule are shared (`@habiterall/shared/password.js`)
- `src/session-store.js` — express-session over `node:sqlite`, written rather
  than installed so this edition keeps its no-native-module property
- `public/app-entry.js` — three lines: `start()` with the shared adapter
- `docker-compose.yml` — a build and nothing else. The environment block is in
  `examples/docker-compose.personal.yml`, which this file `extends`; see the
  root CLAUDE.md for why, and do not write one back in here

The entire UI is in `shared/public/` and served by the static mounts in
`src/server.js`. Do not copy `app.js`, `style.css`, or `index.html` back here.

## Why `node:sqlite`

Built into Node, so there is no native module to compile, no rebuild on
Node upgrades, and the Docker image builds in about a second with one runtime
dependency. It is why a major bump is a `FROM` line and a CI pin rather than a
toolchain problem. `DatabaseSync` is synchronous — fine for one user, and precisely
why the cloud edition uses Postgres instead.

## Traps

**Booleans are 0/1.** SQLite has no boolean type, so `archived` is mapped at
the call site (`habitRow()`); the shared validator returns a real boolean.

**Skips are `status = 'skip'`, never the value 3.** `db.js` migrates older
databases automatically: boolean `3`s become skips, numerical `3`s are left
alone as real amounts, because only the former is unambiguous.

**`src/server.js` only listens when it is the entry point.** It exports `app`
so tests can mount the real server on an ephemeral port; importing the module
must stay side-effect-free on that front, or every such test fights over port
3000. `HABITERALL_DB` is read by `db.js` at module load, so a test has to set
it *before* the first import. **The notifier starts in the same block, for a
sharper version of the same reason**: a test that imported the server would
otherwise start posting to whatever webhook the developer's own database holds.

**`/overview` is bounded.** It reads lifetime entries for the streak figures,
so the clamp inside `computeStreaks` is what keeps a distant-past entry from
blocking the process. Don't reintroduce an unbounded range here.

**`/overview` also has two end dates on purpose.** `end` is the grid window the
dashboard is paging through; `summaryEnd` is `today()` and is what the row's
strength and streaks are computed as of. They were one variable, and paging back
a month restated the summary as of that month. Both lookbacks count back from
`summaryEnd`, so the bound above still holds. `test/overview.integration.mjs`
pins it, and the cloud edition mirrors it exactly.

**Auth is on unless the flag says exactly `off`.** Every other value — unset,
empty, `false`, `0`, `disabled`, and every typo of `off` — leaves it ON, and
`authFlagMisread` makes the server say so at startup rather than failing safe in
silence. Inverted from a normal feature flag on purpose: leaving it on by
accident costs a login prompt, turning it off by accident costs the database.

**Rate limits apply whether or not auth does**, and `HABITERALL_RATE_LIMIT=off`
is the only way out. They were briefly tied to auth, on the reasoning that a
limiter behind `requireAuth` never meets an unauthenticated caller anyway — which
gets this edition backwards: with auth off nothing else stands in front of the
API, so the limiter is the only thing between an open instance and a client
hammering a *synchronous* SQLite database until the event loop stops. The switch
is for the browser suites, which reset fixtures across twenty-two runs from one
address and pass 300/minute long before they find a bug, and for a trusted LAN.
It warns at startup when it is off.

**`upgrade-insecure-requests` is opt-in** (`HABITERALL_UPGRADE_INSECURE=on`),
not derived from `PUBLIC_URL`. It tells the browser to rewrite every http
request to https, which is right for an instance only ever reached over TLS and
fatal for one that is not — and a self-hosted box is commonly both at once:
https from outside, plain http from the LAN, same database. Deriving it would
break the LAN half of that setup, and `localhost` is exempt in browsers so the
breakage only ever shows up on a real address.

**The password hash and the session secret are not settings.** `settings` is
served to the browser by `GET /api/settings`, so `auth_credentials` and
`server_secrets` are tables of their own — the same rule that keeps
`DISCORD_BOT_TOKEN` out of settings.

A backup is the second reason and it draws its own line: `GET /api/export`
carries `portableSettings(...)`, the `PORTABLE_SETTINGS` allowlist, and **not**
the whole table. `UNPORTABLE_SETTINGS` names what is held back and why — a
backup is a file people email to themselves, and `discordWebhook` is a bearer
capability for a channel. What is left is how the app is displayed plus
`skipDays` and `questionMarks`, which is the point: those two decide what the
rows in the same file MEAN.

**Environment credentials win over the database, and OVERWRITE it.**
`state.managed` says which to the UI. Two sources of truth for one password is
how an operator changes it in the browser, redeploys the container, and silently
gets the old one back — but preferring one at read time only masks the other,
and masking lasts exactly as long as the variables do. A stranger who claims an
unguarded instance leaves their username and hash in `auth_credentials` forever;
the documented remedy below therefore *suspended* their access rather than
revoking it, and a compose edit, a `docker run` without `--env-file` or the
volume restored elsewhere brought their password back. `adoptEnvCredential`
writes the environment's credential into that row instead.

Overwriting rather than *deleting* it, which would close the same hole and open a
worse one: with no credential at all, dropping the variables reopens the
unguarded setup window on an instance that has an owner. What is left behind is
the operator's own credential, which costs nothing when the masking ends — and
because it is the same credential, the epoch does not move and nobody is signed
out. The row is written only when it differs, or a plaintext password would
rewrite it at every boot; that comparison is a second `verifyPassword` beside
`syncCredential`'s, before the server listens.

**`HABITERALL_PASSWORD` and `HABITERALL_PASSWORD_HASH` together are ambiguous,
and the hash wins.** `envCredentials` returns `plain` as the password *behind*
`hash` or nothing at all, because its one consumer asks scrypt whether a stored
hash still matches — a question an unrelated plaintext answers "no" to on every
boot. That made every restart look like a credential change: a fresh epoch,
`DELETE FROM sessions`, and a warning about an eviction nobody caused, while the
plaintext was also being quietly ignored for login. It is a warning at startup
now rather than a silent preference.

**Setup is unguarded, deliberately.** With auth on and no credentials anywhere,
the first visitor to `POST /auth/setup` claims the instance — no token, no
source-address check. `initAuth` warns at every start while that window is open.
Set `HABITERALL_USERNAME` and `HABITERALL_PASSWORD` to close it before exposing
the port — that remedy revokes the stranger's session (the epoch), their password
(the adopted row) and their next attempt, and each of those three is a separate
mechanism that had to be argued for. The claim itself is a single
`INSERT ... ON CONFLICT DO NOTHING`, and
that matters: it was a check, then thirty milliseconds of scrypt, then an
*upsert*, so two concurrent claims both wrote and the second one won — locking
the real owner out with a 200 in hand.

**A session is only valid against the credential that raised it.** Sessions
carry a fingerprint of the active credential, `requireAuth` compares it, and
`initAuth` empties the `sessions` table when it changes across a restart.
Without that, the remedy in the paragraph above did not work: setting the
environment credentials refused the stranger's *password* while their *cookie*
kept full read and write for another fourteen days. (Taking those credentials
away again brought the older database row back to life, which is the half the
epoch could not fix — see `adoptEnvCredential` above.) What a session carries is
an opaque random **epoch**, not a
digest of anything: the first version of this fingerprinted the credential's
source material — for `HABITERALL_PASSWORD`, the plaintext — which put a fast,
unsalted digest of a password in the database beside the key it was made with,
the exact offline shortcut scrypt exists to deny. Detecting the change cannot be
hash equality either, since a plaintext password is re-salted on every boot and
that logged everybody out at each restart; `syncCredential` runs `verifyPassword`
against the stored hash instead, once per start.

`requireAuth` is not the only place that comparison has to happen. **`/api/me`
sits above the `/api` mount** — it has to answer a caller with no session, which
is the whole point of it — so it repeats both questions by hand, and it used to
ask only the first. A revoked cookie got a `200` there naming the account it no
longer had, which is the one answer `auth.load()` boots the entire app from.

**The session cookie's `Secure` flag is decided per request** (`secure: 'auto'`),
not from `HABITERALL_PUBLIC_URL`. A process-wide answer is wrong for the same
both-schemes-at-once box the paragraph above describes: with the public URL set
to the https name, a browser on `http://192.168.1.5:3000` threw the cookie away,
so `POST /auth/login` answered 200, the page reloaded, and the app came back
signed out — in a loop, with nothing on either side saying why. `req.secure` is
Express's trust-proxy-aware reading of the scheme, so this is one more thing
`TRUST_PROXY` decides: behind TLS with no hop trusted, the cookie cannot be
marked `Secure` at all, and the server warns at startup when the public URL says
https and nothing is trusted.

**Trust no proxy unless told to.** `TRUST_PROXY` defaults to **0** here and to 1
in cloud, and the difference is the whole point: this edition's quickstart is
`npm start` on a LAN with nothing in front, and every limiter keys on `req.ip`
alone. Trusting a hop that is not there makes `X-Forwarded-For` the caller's to
choose — forty guesses walked through a limit of twenty by rotating one header.

Being wrong the *other* way is an availability bug rather than a security one —
every caller keys on the proxy's address, so one client can spend everyone's
allowance — and a safe default is only safe if that failure is noticeable.
It was not, so two things now make it so: `trust_proxy` is in the startup line
beside `auth` and `rate_limits`, and `warnOnUntrustedProxy` says something the
first time a request arrives carrying `X-Forwarded-For` while nothing is
trusted. Once per process — a per-request warning is one nobody reads, and a
client can forge the header to repeat it. **If you put this behind a reverse
proxy, set `TRUST_PROXY=1`.**

And then **the port must only be reachable through that proxy**, which is the
half that gets skipped because both halves look like they work. Trust is granted
to the immediate peer, not to a particular route in: leaving 3000 open on the LAN
as a shortcut means anything on that LAN is the immediate peer and writes its own
`X-Forwarded-For` — the twenty-guess bound gone by rotating a header, on the one
password this edition has. `X-Forwarded-Host` walks past `sameOriginOnly` the
same way. Publish the port to the proxy's network only, and reach the app by its
proxied name from inside the house as well as outside.

**`/api/import` authenticates before it buffers.** The raw body parser sat above
`requireAuth`, so an unauthenticated 70MB POST was read into memory and *then*
refused — 413 rather than 401, with `importLimiter` never running to bound the
attempt rate. Cloud always had the right order; the port did not carry it
across.

## Running

```bash
npm start                 # http://localhost:3000 — asks you to create an account
HABITERALL_AUTH=off npm start          # the old behaviour: no login at all
npm run seed              # sample data (refuses if habits already exist)
npm test                  # the CSS-guard test
npm run test:notify       # reminder delivery, and that a send is not repeated
npm run test:roundtrip    # export every format, re-import, assert no drift
npm run test:auth         # the modes and their attacks, end to end (no browser)
npm run test:credchange   # a session must not outlive its credential (restarts)
npm run test:signin       # the sign-in view in Chrome; starts its own server
docker compose up -d      # containerised
```

The browser suites in `shared/test/browser/` need a server started with
`HABITERALL_AUTH=off HABITERALL_RATE_LIMIT=off` — they drive the app rather than
the login, and twenty-two suites resetting fixtures from one address is exactly
the traffic shape the API limit exists to stop.

Your data is a single file at `data/habiterall.db` — back it up by copying it,
or use `GET /api/export`.
