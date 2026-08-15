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
served to the browser by `GET /api/settings` and copied into every backup by
`GET /api/export`, so `auth_credentials` and `server_secrets` are tables of their
own — the same rule that keeps `DISCORD_BOT_TOKEN` out of settings.

**Environment credentials win over the database**, and `state.managed` says so
to the UI. Two sources of truth for one password is how an operator changes it in
the browser, redeploys the container, and silently gets the old one back.

**Setup is unguarded, deliberately.** With auth on and no credentials anywhere,
the first visitor to `POST /auth/setup` claims the instance — no token, no
source-address check. `initAuth` warns at every start while that window is open.
Set `HABITERALL_USERNAME` and `HABITERALL_PASSWORD` to close it before exposing
the port.

## Running

```bash
npm start                 # http://localhost:3000 — asks you to create an account
HABITERALL_AUTH=off npm start          # the old behaviour: no login at all
npm run seed              # sample data (refuses if habits already exist)
npm test                  # the CSS-guard test
npm run test:notify       # reminder delivery, and that a send is not repeated
npm run test:roundtrip    # export every format, re-import, assert no drift
npm run test:auth         # the three modes, end to end (no browser needed)
npm run test:signin       # the sign-in view in Chrome; starts its own server
docker compose up -d      # containerised
```

The browser suites in `shared/test/browser/` need a server started with
`HABITERALL_AUTH=off HABITERALL_RATE_LIMIT=off` — they drive the app rather than
the login, and twenty-two suites resetting fixtures from one address is exactly
the traffic shape the API limit exists to stop.

Your data is a single file at `data/habiterall.db` — back it up by copying it,
or use `GET /api/export`.
