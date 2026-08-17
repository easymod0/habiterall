# examples — working notes

The published deployment surface: one compose file per stack, one `.env`
template per edition, and the Caddyfile. Long-form reasoning is in
`docs/decisions/compose-and-env.md`.

**There is one environment block per edition, and it lives here.** The published
file and the checkout's own were maintained by hand and kept drifting the same
way: #54 added ten variables to `habiterall-personal/docker-compose.yml`, none
reached `examples/` or the README, and every test passed — because the only check
compared the examples against the README, and the two stale copies agreed with
each other.

**Each edition's own compose file `extends` the published example** and adds
nothing but the build. `extends`, not `include`, and they are not
interchangeable: include loads another file's services *alongside* this one's and
warns rather than merging when a name appears in both, so the same shape written
with it yields a container with a `build:` and no environment at all — which
starts, and looks fine.

**What `extends` carries was measured with `docker compose config`, not argued.**
Top-level `volumes:` declarations are not carried (it works at the service
level), so they are restated by hand. `depends_on` **is** carried, so cloud's
`app` writes only the third key and it merges alongside the two it inherits.

That second answer is also a *limit*. A mapping merges key by key and a key
cannot be REMOVED, so a service cannot extend one whose `depends_on` names
something the extending project does not run: the published Authentik example's
containers depend on an `authentik-db`, and `habiterall-cloud/docker-compose.yml`
puts Authentik's database in habiterall's own Postgres. Extending them yields
`depends on undefined service "authentik-db"`. They stay a hand-kept copy, and
`compose.test.js` lists both files so a new variable has to reach both. Volumes
were the plausible second blocker and are not one: a service-level `volumes:`
merges by CONTAINER PATH.

**The published Authentik file is the exception and stays standalone**, repeating
`db` / `migrate` / `app`, because downloading ONE file and running it is the whole
point of this directory.

**A line in a `.env` template is inert unless the compose file NAMES the
variable.** `.env` is read for `${NAME}` substitution and nothing else — no
service uses `env_file:`, deliberately, since that would put
`DB_OWNER_PASSWORD` into the app container. So `MAX_HABITS_PER_USER`,
`MAX_HABITS_PER_IMPORT`, `MAX_ENTRIES_PER_IMPORT` and `MAX_UPLOAD_MB` were set in
the old cloud template, interpolated by no cloud compose file, and had been doing
nothing since they were written. Both halves individually looked right.

`ENV_TEMPLATES` in `shared/test/compose.test.js` runs both ways: every `${NAME}`
in a stack's compose files must be offered by its template, and nothing in a
template may go uninterpolated. A commented `#LOG_LEVEL=info` counts as offered —
the tuning block ships that way and uncommenting is the intended path. Everything
named is `${NAME:-}`, and empty is safe for every one, since each reader is
`Number(x) || default` or an equality test.

**Templates ship the limits at their CODE defaults**, so repairing the inertness
does not silently change what a running instance enforces —
`MAX_ENTRIES_PER_IMPORT` was written as 200000 against a code default of 50000,
and carrying it across would have quadrupled it on upgrade.

## What the discovery test can and cannot see

`shared/test/compose.test.js` walks the module graph from each edition's entry
points and fails when a variable something reads is documented in no compose file
that ships it. Tied to the SOURCE rather than to the other file, so there is no
list to maintain. Three wrinkles defeat the naive version and each has its own
test:

- `HABITERALL_USERNAME` and its two neighbours are read off an *injected* `env`
  object in `shared/src/password.js`, never as `process.env.…` — those are
  precisely the three #54 added, so a grep would have passed.
- `shared/src` is shared, so attributing a read to an edition by file path is
  wrong: `password.js` is personal's and `notify-send.js` is both editions'.
  Which modules a server actually imports is the only honest answer.
- **`process.env[name]` with a computed key** cannot be read at all.
  `flag('AUTHENTIK_BRANDING')` in `bootstrap-authentik.mjs` reaches the
  environment a function call away, so self-service registration, its
  email-verification switch and the branding were invisible while every test was
  green. A file doing this declares its names in an **`@env NAME NAME`** marker,
  and a test fails when one does it without a marker. A marker is hand-kept and
  can go stale, so `flag`'s call sites are checked against what the discovery
  ended up with. That hole was found by a review, not by the suite — worth
  remembering when adding a fourth way of reading an environment variable.

The **checkout compose files are in that manifest too**, listed rather than taken
on trust, because `extends` covers `db` / `migrate` / `app` only. Leaving them
out would have reproduced #54 one service over.

`ELSEWHERE` is the decision of what an operator is expected to *tune* — the log
settings, the limits, the pool — and each entry carries its reason, with a test
that fails when one outlives the variable it excuses. What none of this covers is
a variable documented with the **wrong default or a stale comment**: all of it
checks presence, and nothing short of booting a container catches the rest.

## The README

Its compose blocks are generated — `npm run docs:compose`, `--check` in CI and in
`examples.test.js` — from HTML-comment markers, so the README stops being a place
you can forget to edit. The env templates are in `PRINTED` too, so
`examples.test.js`'s directory walk (which fails on any file here that no README
block prints) covers them without a second mechanism.

**A file here that an operator does not run needs an excuse, not a block.**
`exampleFiles()` skips `NOT_PRINTED`, which is a map carrying each reason — the
same shape as `ELSEWHERE` in `compose.test.js` and `notMirrored` on the Android
side, because "we thought about it" has to be distinguishable from "we forgot".
This file is its only entry. A test fails when an excuse outlives the file it
excuses, or the next file to take that name inherits it silently.

What that replaced was itself broken: "everything up to the first blank line"
reduced `examples/Caddyfile` — four lines, no header — to the empty string, and
`README.includes('')` is true of every README there has ever been.
