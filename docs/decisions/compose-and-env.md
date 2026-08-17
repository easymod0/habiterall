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


