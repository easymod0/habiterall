# Compose files and env templates

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**There is one environment block per edition, and it lives in `examples/`.**
The published file and the checkout's own were maintained by hand and kept
drifting the same way: #54 added ten variables to
`habiterall-personal/docker-compose.yml`, none of them reached
`examples/docker-compose.personal.yml` or the README, and every test passed —
because the only check compared the examples against the README, and the two
stale copies agreed with each other. Verbatim equality could never have been
that check: the files differ on purpose, one carrying `build:` and the other
`image: ghcr.io/…`.

So each edition's own compose file **`extends`** the published example and adds
nothing but the build. `extends`, not `include`, and they are not
interchangeable: include loads another file's services *alongside* this one's
and warns rather than merging when a name appears in both, so the same shape
written with it yields a container with a `build:` and no environment at all —
which starts, and looks fine.

**What `extends` carries was measured with `docker compose config`, not
argued**, and the two answers pull in opposite directions. The top-level
`volumes:` declarations genuinely are not carried — it works at the service
level — so they are restated by hand. `depends_on` **is** carried, where this
file used to hedge that Compose v1 did not and the documentation says neither
way; the restatements are gone, and cloud's `app` now writes only the third
key, `authentik-bootstrap`, which merges alongside the two it inherits.

That second answer is also a *limit*, and it is why one duplication survives.
A mapping merges key by key and a key cannot be REMOVED, so a service cannot
extend one whose `depends_on` names something the extending project does not
run. The published Authentik example's containers depend on an `authentik-db`,
and `habiterall-cloud/docker-compose.yml` puts Authentik's database in
habiterall's own Postgres via an init script a downloader has no checkout to
mount — so extending them yields `depends on undefined service
"authentik-db": invalid compose project`. They stay a hand-kept copy, and
`compose.test.js` lists both files so a new variable has to reach both. Volumes
were the plausible second blocker and are not one: a service-level `volumes:`
merges by CONTAINER PATH, so the checkout's bind mount cleanly displaces the
published named volume at the same target.

The published Authentik file is the exception and stays standalone, repeating
`db` / `migrate` / `app`, because downloading ONE file and running it is the
whole point of `examples/`. `shared/test/compose.test.js` is what keeps that
copy honest, and it is tied to the SOURCE rather than to the other file: it
walks the module graph from each edition's entry points and fails when a
variable something reads is documented in no compose file that ships it.

**Three wrinkles defeat the naive version, and each has its own test.**
`HABITERALL_USERNAME` and its two neighbours are read off an *injected* `env`
object in `shared/src/password.js` and never as `process.env.…` — those are
precisely the three #54 added, so a grep would have passed. `shared/src` is
shared, so attributing a read to an edition by file path is wrong: `password.js`
is personal's and `notify-send.js` is both editions'. Which modules a server
actually imports is the only honest answer, and it needs no list to maintain.

And the one that cannot be read at all: **`process.env[name]` with a computed
key.** `flag('AUTHENTIK_BRANDING')` in `bootstrap-authentik.mjs` reaches the
environment a function call away, so the name is nowhere near the read — and
self-service registration, its email-verification switch and the branding were
invisible to the discovery while every test was green. A file that does this
declares its own names in an **`@env NAME NAME`** marker, and a test fails when
one does it without a marker, so the next helper of that shape is loud rather
than silent. A marker is hand-kept and can go stale, so `flag`'s call sites —
which do name their variable — are checked against what the discovery ended up
with. That hole was found by a review, not by the suite: worth remembering when
adding the fourth form of reading an environment variable.

The **checkout compose files are in that manifest too**, listed rather than
taken on trust. `extends` covers `db` / `migrate` / `app` only, so the Authentik
services in `habiterall-cloud/docker-compose.yml` remain a hand-kept copy of the
published Authentik file's — unified for the app, guarded for the rest. Leaving
those files out would have reproduced #54 one service over.

`ELSEWHERE` in that test is the decision of what an operator is expected to
*tune* — the log settings, the limits, the pool — and each entry carries its
reason, with a test that fails when one outlives the variable it excuses. What
none of this covers is a variable documented with the **wrong default or a
stale comment**: all of it checks presence, and nothing short of booting a
container catches the rest.

**The `.env` template is the operator's surface, and a line in one is inert
unless the compose file NAMES the variable.** A compose file's `environment:`
block is not somewhere anybody edits — the published files are downloaded and
run, the checkout files carry no environment at all — so `examples/` ships
`personal.env.example` and `cloud.env.example` beside them, one per edition
rather than one per file, and `habiterall-cloud/.env.example` is gone. But
`.env` is read for `${NAME}` **substitution and nothing else**: no service uses
`env_file:`, deliberately, since that would put `DB_OWNER_PASSWORD` into the app
container. So a variable the compose file does not mention never reaches the
process, however plainly the template sets it — and the old cloud template had
four such lines. `MAX_HABITS_PER_USER`, `MAX_HABITS_PER_IMPORT`,
`MAX_ENTRIES_PER_IMPORT` and `MAX_UPLOAD_MB` were set there, interpolated by no
cloud compose file, and had been doing nothing since they were written. Both
halves individually looked right, which is why nothing caught it.

`ENV_TEMPLATES` in `compose.test.js` is the check, and it runs both ways:
every `${NAME}` in a stack's compose files must be offered by its template, and
nothing in a template may go uninterpolated. The reader counts a commented
`#LOG_LEVEL=info` as offered, because the tuning block ships that way on
purpose and an operator uncommenting a line is the intended path. Fixing the
wiring meant naming the limits, the pool and the six `LOG_*` settings in the
compose `environment:` blocks as `${NAME:-}`; empty is safe for every one of
them, since each reader is `Number(x) || default` or an equality test. Note the
templates ship the limits at their **code** defaults, so repairing the
inertness does not silently change what a running instance enforces —
`MAX_ENTRIES_PER_IMPORT` was written as 200000 against a code default of 50000,
and had it been carried across, upgrading would have quadrupled it.

The README's copies are generated (`npm run docs:compose`, `--check` in CI and
in `examples.test.js`) from HTML-comment markers, so the README stops being a
place you can forget to edit. The env templates are in `PRINTED` too, so
`examples.test.js`'s directory walk — which fails on any file in `examples/`
that no README block prints — covers them without a second mechanism. Note what that replaced was itself broken:
"everything up to the first blank line" reduced `examples/Caddyfile` — four
lines, no header — to the empty string, and `README.includes('')` is true of
every README there has ever been.

**A service can hit the `extends` sequence-concatenation limit from INSIDE one
file, not only across the two.** Splitting the reminder tick into its own
`notifier` container (#194) meant adding a fourth service to
`examples/docker-compose.cloud.yml`, and the obvious shape — `notifier`
`extends: service: app`, since the two share `db` / `migrate` as
`depends_on` — was rejected for the same reason `extends` already gets a
restatement of `depends_on` in the checkout's own compose file: a mapping
merges key by key, but `ports:` is a SEQUENCE, and a sequence is
*concatenated*, never replaced. `notifier` extending `app` would have
inherited `app`'s `ports: ['${BIND_ADDR:-}:${APP_PORT:-3100}:3000']` verbatim,
and two containers publishing the same host port fight over the bind at
startup — not a config-time error `docker compose config` would catch, a
runtime one on `docker compose up`. So `notifier` is hand-written in the
published file instead, and it is the checkout's own
`habiterall-cloud/docker-compose.yml` that `extends: service: notifier` from
it, the same as the other three services.

**#189 posed a fork on `/overview`, the largest response on the app's hot
path — `GET /api/export` is bigger for any account older than the dashboard's
window, so the superlative is about the hot path and not about the API:
add a `compression` dependency, or document that the reverse proxy is where
compression belongs and make the shipped examples actually do it. The second
branch was taken**, and `examples/Caddyfile` and the README's nginx and Nginx
Proxy Manager instructions now each carry the one line or field that turns it
on, and so does the Caddy block in `habiterall-cloud/SETUP.md`. Know the
denominator: FOUR places, of which three are config and one is not. All three
configs are pinned by `shared/test/examples.test.js` — `examples/Caddyfile`,
read from the file an operator runs rather than from the README's generated
copy of it; the README's nginx block; and cloud's own walkthrough, which is
the one that hides, because it is hand-written outside `examples/` so
`docs:compose` never touches it and the generator test cannot see it. The
Nginx Proxy Manager row is the fourth and is prose in a table describing a web
form, with no config file to assert against, so it alone rests on review.

**Why not the dependency, and the decisive fact.** Nginx Proxy Manager's own
shipped `nginx.conf` sets `proxy_set_header Accept-Encoding "";`, stripping
the client's `Accept-Encoding` on the way upstream — so an app sitting behind
one of the most common self-hosted proxies is handed a request that never
asks for gzip, and an app-side `compression` dependency would be dead code
there. A proxy is entitled to take the choice away from the app in front of
it, and no dependency changes that. Beside it, two lesser reasons pointed the
same way: personal's dependency budget is a real cost for one line of gain,
and every deployment documented here already puts a proxy in front for the
TLS certificate, so compression adds no extra moving part — only the line
that turns it on.

**The reason that is NOT an argument, named so nobody re-derives it.** The
`compression` middleware runs zlib on the libuv threadpool, not on the event
loop — it would not have blocked the way this project's synchronous stats
passes do. The cost of adding it would have been a dependency and a hop in
the response path, not lag. Do not let "it would have been slow" stand in for
the real reason above; it is not what was weighed.

**Why there is no startup warning.** An earlier draft added one, shaped like
`warnOnUntrustedProxy`. Refused, for four reasons:

1. The app cannot observe the thing it would be warning about. Compression
   happens downstream, in a proxy this process never sees. Every other
   warning here is derived from something the process actually knows —
   `insecure_cookies` from `PUBLIC_URL` and `trustProxyHops`,
   `rate_limits_disabled` from its own configuration, `proxy_untrusted` from a
   header that actually arrived — and there is no equivalent input for "is
   anything compressing me".
2. Every available gate is blind to the population that most needs it. The
   operator most likely to be missing compression after this change is the one
   who copied `examples/Caddyfile` BEFORE it grew an `encode` line — proxy
   present, `TRUST_PROXY=1`, no compression. Nothing distinguishes that
   instance from one whose Caddy does compress: Caddy forwards the client's
   `Accept-Encoding` upstream unchanged either way, so the two are identical
   from in here. A gate on `TRUST_PROXY === 0` is therefore silent for exactly
   them, and ungated it fires on every correctly configured instance instead.
   Be precise about what IS available, because the weaker claim is the one a
   reader will catch: `warnOnUntrustedProxy` warns from an OBSERVED header, so
   its inverse — `TRUST_PROXY === 0` and no `X-Forwarded-For` seen in the life
   of the process — is an honest observation of "nothing is in front of me",
   and that is a sufficient condition for "nothing compressed this". So the
   process CAN observe the directly-exposed case. What kills that sharper gate
   is reason 4 rather than reason 2: it fires on personal's own documented LAN
   quickstart, which is precisely `TRUST_PROXY=0` with no forwarded header.
3. The consequence is not the kind this project spends a warn line on. The
   three existing configuration warnings each name something that silently
   BREAKS: a login that loops with no error, every rate limit collapsed into
   one bucket, guards switched off. Missing compression breaks nothing and is
   visible in any browser's Network tab.
4. Personal's documented quickstart is the false positive. `npm start` on a
   LAN is `TRUST_PROXY=0` by design and by the README, and the response is
   crossing a LAN. That operator is configured correctly and would be warned
   about a cost they do not pay.

Also refused, and worth knowing before anyone re-adds it: a constant
`compression: 'none'` field on the `startup` line. It cannot be wrong, but it cannot vary either —
it is a fact about the code, not about this process's configuration, which is
what that line is for — and a test asserting a constant is this repo's own
most-shipped defect shape (see "Writing tests here" in the root `CLAUDE.md`).

**What is deliberately not measured.** No compression ratio is stated
anywhere in the docs this change touched. Any figure producible here without
a real account is synthetic and would read as measured, and the claim being
made is about WHERE compression happens, not how much it saves. The issue's
own size estimate for `/overview` is its own and is not repeated as if it
were this project's measurement.

**The nginx detail worth keeping, and it cost a review round.** `gzip_types`
REPLACES the list rather than adding to it, and `text/html` is the only entry
that is implicit and unremovable — so `gzip on;` by itself looks enabled and
compresses the one thing this app barely serves. The first version of this
change wrote `gzip_types application/json;`, which fixed the dashboard and
left the shell plain: there is no build step here, so a cold load fetches 34
separate ES modules plus the stylesheet, which together are the
larger half of the problem, and Caddy's default matcher was quietly covering
all of it while the nginx example was not. The README bullet claiming "the
proxy compresses all of it" was therefore true of one shipped example and
false of the other two. The list now names every type this app actually
serves, and `examples.test.js` asserts each of them rather than
`application/json` alone — a test written against the narrow claim would have
gone on passing over exactly the gap it was meant to close.

Two spellings in that list are not interchangeable. It is **`text/javascript`**,
because that is what `mime-types` resolves a `.js` to and `express.static` is
what serves them — a list naming `application/javascript` instead misses the
whole shell while looking correct. And the web manifest needs no entry of its
own: it is `shared/public/manifest.json`, so `application/json` already covers
it, and `application/manifest+json` would be a type nothing here sends.

And `gzip_proxied any;` is about a `Via` header on the *inbound* request — a
CDN in front of nginx, not nginx in front of an app — so it is not required in
this shape and was left out on purpose; the next person tempted to "fix" its
absence should read this paragraph first.


