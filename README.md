<div align="center">

# habiterall

**A self-hosted habit tracker with the statistics of [Loop Habit Tracker](https://github.com/iSoron/uhabits) — in your browser, on your server, with your data.**

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A526-brightgreen)

</div>

---

Track daily habits, see your streaks and strength over time, and keep every
byte on hardware you control. Imports directly from Loop Habit Tracker, so you
can bring your history with you — and exports back, so you are never stuck
here either.

Installs to a phone home screen as an app, works offline, and syncs when you
reconnect.

<div align="center">
<img src="docs/screenshots/dashboard.png" width="900"
     alt="The habiterall dashboard: four habits, each with its frequency, strength and current streak, beside two weeks of tappable squares — checkmarks for yes/no habits, numbers for measurable ones.">
<br><sub>Every screenshot in this README is the real app, with sample data.</sub>
</div>

## Contents

- [Which edition do I want?](#which-edition-do-i-want)
- [Quick start](#quick-start) · [personal](#personal-edition) · [cloud](#cloud-edition)
- [Features](#features) · [Statistics](#statistics) · [Bouncing back](#bouncing-back) · [Awards](#awards)
- [Reminders and notifications](#reminders-and-notifications)
- [Install on a phone](#install-on-a-phone)
- [Coming from Loop Habit Tracker](#coming-from-loop-habit-tracker)
- [Backup and restore](#backup-and-restore) · [Upgrading](#upgrading) · [Releases](#releases)
- [Configuration](#configuration) · [API](#api)
- [Security](#security) · [Architecture](#architecture) · [Development](#development)

---

## Which edition do I want?

|  | **personal** | **cloud** |
|---|---|---|
| Users | one | many, each isolated |
| Login | a username and password, on by default — or `HABITERALL_AUTH=off` | any OIDC provider |
| Database | one SQLite file | Postgres |
| Setup | one command | Docker Compose + an identity provider |
| Runs on | `http://localhost:3000` | `http://localhost:3100` |
| Best for | one person, wherever it runs | several people, each with their own habits |

**Start with personal.** It has no moving parts, and a JSON backup imports
straight into cloud later if you outgrow it.

The dividing line is **how many people**, not whether it faces the internet.
The personal edition signs you in, so it is fine on a public address; what it
does not do is keep two people's habits apart — everyone who signs in shares one
set. That is what cloud is for.

---

## Quick start

Both editions ship as published images on GHCR, so there is nothing to clone,
nothing to build, and no source code on your server. Each section below ends
with a note for running from a checkout instead, which is what you want for
development.

### personal edition

One file, one command. Save this as `docker-compose.yml` anywhere — or
download it:

```bash
curl -o docker-compose.yml \
  https://raw.githubusercontent.com/easymod0/habiterall/master/examples/docker-compose.personal.yml
docker compose up -d
```

Open **<http://localhost:3000>**. That is the whole install; everything below
is what you can change.

**The file**, with a comment on every variable
([`examples/docker-compose.personal.yml`](examples/docker-compose.personal.yml)):

<!-- generated from examples/docker-compose.personal.yml — edit that file, then `npm run docs:compose` -->
```yaml
services:
  habiterall:
    image: ghcr.io/easymod0/habiterall-personal:latest
    container_name: habiterall
    ports:
      # BIND_ADDR empty (the default) is every interface, both address
      # families — Docker's own behaviour. Set it to 127.0.0.1 when a
      # reverse proxy on this host is the only thing that should reach the
      # port. Do not write 0.0.0.0: that is IPv4 only.
      - '${BIND_ADDR:-}:${APP_PORT:-3000}:3000'
    volumes:
      - habiterall-data:/data        # your whole database is one file in here
    environment:
      HABITERALL_DB: /data/habiterall.db
      TZ: ${TZ:-Etc/UTC}             # SET THIS — a container is UTC otherwise

      # Set both before exposing this port, or the first visitor claims the app.
      HABITERALL_USERNAME: ${HABITERALL_USERNAME:-}              # default "admin"
      HABITERALL_PASSWORD: ${HABITERALL_PASSWORD:-}              # unchecked here; use 8+
      HABITERALL_PASSWORD_HASH: ${HABITERALL_PASSWORD_HASH:-}    # or this instead
      HABITERALL_AUTH: ${HABITERALL_AUTH:-}                      # exactly "off" disables sign-in
      HABITERALL_SESSION_SECRET: ${HABITERALL_SESSION_SECRET:-}  # survives a redeploy

      TRUST_PROXY: ${TRUST_PROXY:-0}                             # 1 behind a reverse proxy
      HABITERALL_UPGRADE_INSECURE: ${HABITERALL_UPGRADE_INSECURE:-}  # "on" if https-only
      HABITERALL_RATE_LIMIT: ${HABITERALL_RATE_LIMIT:-}          # "off" on a trusted LAN

      HABITERALL_NOTIFY: ${HABITERALL_NOTIFY:-on}                # reminders this server sends
      HABITERALL_NOTIFY_INTERVAL_MS: ${HABITERALL_NOTIFY_INTERVAL_MS:-60000}
      HABITERALL_PUBLIC_URL: ${HABITERALL_PUBLIC_URL:-}          # https://habits.example.com
      DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN:-}                  # adds Yes / No / Skip buttons
      NTFY_ALLOWED_HOSTS: ${NTFY_ALLOWED_HOSTS:-}                # ntfy.sh; name your own to replace it

      # Limits and logging. Empty means the default, so these are here to make
      # the knob reachable from .env rather than to set anything — a variable
      # this file does not name never reaches the container at all.
      MAX_UPLOAD_MB: ${MAX_UPLOAD_MB:-}                          # 16
      MAX_PARSE_HABITS: ${MAX_PARSE_HABITS:-}                    # 10000
      MAX_PARSE_ENTRIES: ${MAX_PARSE_ENTRIES:-}                  # 250000
      LOG_LEVEL: ${LOG_LEVEL:-}                                  # info; debug for reminders
      LOG_FORMAT: ${LOG_FORMAT:-}                                # json, or pretty on a TTY
      LOG_REQUESTS: ${LOG_REQUESTS:-}                            # true logs every request
      LOG_SLOW_MS: ${LOG_SLOW_MS:-}                              # 1000
      LOG_RUNTIME_MS: ${LOG_RUNTIME_MS:-}                        # 60000
      LOG_LAG_WARN_MS: ${LOG_LAG_WARN_MS:-}                      # 200
    restart: unless-stopped

volumes:
  habiterall-data:
```
<!-- /generated -->

Set those in the file itself, or in a `.env` beside it —
[`examples/personal.env.example`](examples/personal.env.example) is the
template, and every line in it has a working default:

<details>
<summary><b>Show <code>personal.env.example</code></b></summary>

<!-- generated from examples/personal.env.example — edit that file, then `npm run docs:compose` -->
```ini
# ---- where it listens -------------------------------------------------------
APP_PORT=3000

# Which interface the published port appears on. Empty is Docker's default:
# every interface, both address families. Use 127.0.0.1 when a reverse proxy on
# THIS host is the only thing that should reach it. Not 0.0.0.0 — IPv4 only.
BIND_ADDR=

# The container's own clock, and a fallback for both things that need one: an
# account no client has ever reported a zone from, and a request that names no
# zone. Browsers and the Android app report their own, so a check-off is filed
# under the day it is where you are. Unset, a container is UTC.
TZ=Etc/UTC

# ---- sign-in ----------------------------------------------------------------
# On unless set to EXACTLY `off`. Every other value — empty, false, 0, and
# every typo of off — leaves it on, deliberately: leaving it on by accident
# costs a login prompt, turning it off by accident costs the database.
HABITERALL_AUTH=

# The single account. Set both before exposing the port, or the first visitor
# to reach the setup page claims the instance. Nothing checks the password's
# length here — the 8-character minimum is on the in-app form only.
HABITERALL_USERNAME=
HABITERALL_PASSWORD=

# The same password pre-hashed, to keep the plaintext out of `docker inspect`.
# Wins if both are set. Generate one with:
#   docker run --rm ghcr.io/easymod0/habiterall-personal:latest node -e \
#     "import('@habiterall/shared/password.js').then(m=>m.hashPassword(process.argv[1]).then(console.log))" \
#     'your password'
HABITERALL_PASSWORD_HASH=

# Set it to keep people signed in across a redeploy. Left empty, one is
# generated and stored in the database.  openssl rand -base64 36
HABITERALL_SESSION_SECRET=

# ---- behind a proxy ---------------------------------------------------------
# Reverse-proxy hops in front, for correct client IPs. Wrong in either
# direction is a bug: trust a hop that is not there and a caller writes its own
# X-Forwarded-For, walking past the limit on this edition's one password. Set
# it to 1 AND publish the port to the proxy only — not to the whole LAN.
TRUST_PROXY=0

# `on` tells browsers to rewrite every http request to https. Only for an
# instance reached over TLS and nothing else — a box that is https from outside
# and plain http from the LAN breaks on the LAN half.
HABITERALL_UPGRADE_INSECURE=

# `off` removes the API rate limits, for a trusted LAN. The limit on LOGIN
# attempts is not included and cannot be switched off.
HABITERALL_RATE_LIMIT=

# ---- reminders --------------------------------------------------------------
# Reminders pointed at a Discord webhook are sent by this process, once a
# minute. `off` disables the loop entirely.
HABITERALL_NOTIFY=on
HABITERALL_NOTIFY_INTERVAL_MS=60000

# This instance's address, so a Discord reminder can link back to it.
HABITERALL_PUBLIC_URL=

# Interactive Discord reminders — Yes / No / Skip buttons and an amount box.
# Create it at https://discord.com/developers/applications → Bot → Reset Token,
# then invite the bot with the `bot` scope and Send Messages. With it set the
# app opens ONE outbound WebSocket to Discord; no inbound port is needed.
# Without it, Discord reminders are webhook text.
DISCORD_BOT_TOKEN=

# Which hosts an ntfy topic URL may name. Reminders go out as an ntfy publish
# that THIS SERVER makes, so whatever is here is what it can be aimed at — a URL
# typed into Settings is only ever fetched if its host is on this list.
#
# An entry is a host, and optionally a BASE PATH under it:
#
#   ntfy.sh                     https://ntfy.sh/<topic>
#   ntfy.example.com:8443       a port, when your ntfy is not on 443
#   example.com/ntfy            https://example.com/ntfy/<topic>
#
# A user's URL may add exactly ONE topic segment to what you name here, and
# nothing else — so naming `example.com` alone does NOT allow
# `https://example.com/anything/else`. Name the base path if your ntfy is
# reverse-proxied under one. https is required either way.
#
# LEAVING THIS EMPTY MEANS ntfy.sh — it is the default, not "nothing allowed".
# Naming your own REPLACES that rather than adding to it, so write both if you
# want both. `off` refuses every URL, which is how you switch the destination
# off instance-wide.
#
#   NTFY_ALLOWED_HOSTS=ntfy.sh,example.com/ntfy
NTFY_ALLOWED_HOSTS=

# ---- limits -----------------------------------------------------------------
# Ceiling on a backup being restored.
#MAX_UPLOAD_MB=16

# What one uploaded file may DECLARE, before anything is built from it — a
# bound on a hostile file rather than a product limit. A SQLite file's row
# count is a claim, so a few kilobytes can assert millions. Raising them trades
# memory for generosity: both defaults together cost roughly 90MB to parse.
#MAX_PARSE_HABITS=10000
#MAX_PARSE_ENTRIES=250000

# ---- tuning -----------------------------------------------------------------
# Uncommented only when you mean it. Defaults shown.
#LOG_LEVEL=info                 # debug is the switch for "the reminder never came"
#LOG_FORMAT=json                # pretty on a TTY, json otherwise
#LOG_REQUESTS=false             # true logs every request, not just the slow ones
#LOG_SLOW_MS=1000
#LOG_RUNTIME_MS=60000
#LOG_LAG_WARN_MS=200
```
<!-- /generated -->
</details>

If you set `HABITERALL_USERNAME` and `HABITERALL_PASSWORD` above, sign in with
them and that is the whole setup. If you left them blank you are asked to
**create an account** on that first visit — and until somebody does, *anyone who
can reach the port* can be that somebody. On a laptop or a home LAN that is
exactly what you want and takes ten seconds. Anywhere reachable from the
internet, fill the two variables in first, so there is no window to walk
through.

Sign-in can be turned off entirely with `HABITERALL_AUTH=off`, which restores
what this edition did before it had any: every route open to whoever can reach
it. That is a real option for a machine only you can talk to — see
[Turning the guards off](#turning-the-guards-off) for that setting and the
others alongside it.

Between the two files above, every variable this edition reads is accounted
for — a test fails if the server grows one neither mentions. To update:

```bash
docker compose pull && docker compose up -d
```

<details>
<summary><b>Or from a clone, with no Docker at all</b></summary>

Requires **Node 26+**, the major both Docker images ship. There is no build
step — what runs is what is on disk.

```bash
git clone https://github.com/easymod0/habiterall.git
cd habiterall
npm install
npm run start:personal
```

Also **<http://localhost:3000>**, with the database at
`habiterall-personal/data/habiterall.db`. Optionally seed sample data first with
`npm run seed -w habiterall-personal`.
</details>

### cloud edition

Multi user, so it needs a database and somewhere to sign in. This brings both:
the published image, Postgres, and Authentik as the identity provider — nothing
to build, and no source on the server. Two files, then one command:

```bash
curl -o docker-compose.yml \
  https://raw.githubusercontent.com/easymod0/habiterall/master/examples/docker-compose.cloud-authentik.yml
curl -o .env \
  https://raw.githubusercontent.com/easymod0/habiterall/master/examples/cloud.env.example
```

Fill in the `.env` — that is the only editing step, and it is covered next.
Then `docker compose up -d`, and the stack configures itself.

<details>
<summary><b>Show <code>docker-compose.cloud-authentik.yml</code></b></summary>

<!-- generated from examples/docker-compose.cloud-authentik.yml — edit that file, then `npm run docs:compose` -->
```yaml
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: habiterall
      POSTGRES_USER: habiterall_owner
      POSTGRES_PASSWORD: ${DB_OWNER_PASSWORD:?set it in .env}
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U habiterall_owner -d habiterall']
      interval: 5s
      retries: 20
    restart: unless-stopped

  authentik-db:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: authentik
      POSTGRES_USER: authentik
      POSTGRES_PASSWORD: ${AUTHENTIK_DB_PASSWORD:?set it in .env}
    volumes:
      - authentik-db-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U authentik -d authentik']
      interval: 5s
      retries: 20
    restart: unless-stopped

  authentik-server:
    image: ghcr.io/goauthentik/server:2026.5.6
    command: server
    depends_on:
      authentik-db: { condition: service_healthy }
    environment:
      AUTHENTIK_SECRET_KEY: ${AUTHENTIK_SECRET_KEY:?openssl rand -base64 60}
      AUTHENTIK_POSTGRESQL__HOST: authentik-db
      AUTHENTIK_POSTGRESQL__NAME: authentik
      AUTHENTIK_POSTGRESQL__USER: authentik
      AUTHENTIK_POSTGRESQL__PASSWORD: ${AUTHENTIK_DB_PASSWORD}
      # Only needed to create the first admin; harmless to leave set.
      AUTHENTIK_BOOTSTRAP_PASSWORD: ${AUTHENTIK_BOOTSTRAP_PASSWORD:-}
      AUTHENTIK_BOOTSTRAP_EMAIL: ${AUTHENTIK_BOOTSTRAP_EMAIL:-admin@example.com}
      AUTHENTIK_BOOTSTRAP_TOKEN: ${AUTHENTIK_BOOTSTRAP_TOKEN:-}
      # Only self-service registration with email verification sends mail.
      AUTHENTIK_EMAIL__HOST: ${AUTHENTIK_EMAIL__HOST:-localhost}
      AUTHENTIK_EMAIL__PORT: ${AUTHENTIK_EMAIL__PORT:-587}
      AUTHENTIK_EMAIL__USERNAME: ${AUTHENTIK_EMAIL__USERNAME:-}
      AUTHENTIK_EMAIL__PASSWORD: ${AUTHENTIK_EMAIL__PASSWORD:-}
      AUTHENTIK_EMAIL__USE_TLS: ${AUTHENTIK_EMAIL__USE_TLS:-true}
      AUTHENTIK_EMAIL__USE_SSL: ${AUTHENTIK_EMAIL__USE_SSL:-false}
      AUTHENTIK_EMAIL__FROM: ${AUTHENTIK_EMAIL__FROM:-habiterall@example.com}
    # Filled by authentik-bootstrap out of the habiterall image. The two asset
    # volumes land under directories Authentik already serves at
    # /static/dist/assets/, which is one of the two forms its brand settings
    # accept without an upload.
    volumes:
      - authentik-blueprints:/blueprints/custom
      - authentik-icons:/web/dist/assets/icons/habiterall
      - authentik-images:/web/dist/assets/images/habiterall
    ports:
      - '${BIND_ADDR:-}:${AUTHENTIK_PORT:-9000}:9000'
    restart: unless-stopped

  authentik-worker:
    image: ghcr.io/goauthentik/server:2026.5.6
    command: worker
    depends_on:
      authentik-db: { condition: service_healthy }
    environment:
      AUTHENTIK_SECRET_KEY: ${AUTHENTIK_SECRET_KEY}
      AUTHENTIK_POSTGRESQL__HOST: authentik-db
      AUTHENTIK_POSTGRESQL__NAME: authentik
      AUTHENTIK_POSTGRESQL__USER: authentik
      AUTHENTIK_POSTGRESQL__PASSWORD: ${AUTHENTIK_DB_PASSWORD}
      AUTHENTIK_BOOTSTRAP_PASSWORD: ${AUTHENTIK_BOOTSTRAP_PASSWORD:-}
      AUTHENTIK_BOOTSTRAP_EMAIL: ${AUTHENTIK_BOOTSTRAP_EMAIL:-admin@example.com}
      AUTHENTIK_BOOTSTRAP_TOKEN: ${AUTHENTIK_BOOTSTRAP_TOKEN:-}
      AUTHENTIK_EMAIL__HOST: ${AUTHENTIK_EMAIL__HOST:-localhost}
      AUTHENTIK_EMAIL__PORT: ${AUTHENTIK_EMAIL__PORT:-587}
      AUTHENTIK_EMAIL__USERNAME: ${AUTHENTIK_EMAIL__USERNAME:-}
      AUTHENTIK_EMAIL__PASSWORD: ${AUTHENTIK_EMAIL__PASSWORD:-}
      AUTHENTIK_EMAIL__USE_TLS: ${AUTHENTIK_EMAIL__USE_TLS:-true}
      AUTHENTIK_EMAIL__USE_SSL: ${AUTHENTIK_EMAIL__USE_SSL:-false}
      AUTHENTIK_EMAIL__FROM: ${AUTHENTIK_EMAIL__FROM:-habiterall@example.com}
    # The worker is what lists the blueprint directory for the endpoint that
    # applies one, and what sends the mail. It needs the same files.
    volumes:
      - authentik-blueprints:/blueprints/custom
      - authentik-icons:/web/dist/assets/icons/habiterall
      - authentik-images:/web/dist/assets/images/habiterall
    restart: unless-stopped

  # Configures Authentik from this file's .env — the OIDC provider and
  # application, self-service registration, the sign-in branding — and copies
  # the blueprints and images it needs out of the habiterall image into the
  # volumes above. Idempotent, and runs to completion on every `up`.
  #
  # Without AUTHENTIK_BOOTSTRAP_TOKEN it does nothing and exits 0, which is
  # what keeps `up` working once you have removed the token.
  authentik-bootstrap:
    image: ghcr.io/easymod0/habiterall-cloud:latest
    depends_on:
      authentik-server: { condition: service_started }
      authentik-worker: { condition: service_started }
    environment:
      AUTHENTIK_URL: http://authentik-server:9000
      # The API is reached over this network; the ISSUER has to be the string a
      # browser sees, and they are not the same host.
      AUTHENTIK_PUBLIC_URL: ${AUTHENTIK_PUBLIC_URL:-http://localhost:${AUTHENTIK_PORT:-9000}}
      AUTHENTIK_BOOTSTRAP_TOKEN: ${AUTHENTIK_BOOTSTRAP_TOKEN:-}
      PUBLIC_URL: ${PUBLIC_URL:?the address browsers use, https in production}
      OIDC_ISSUER: ${OIDC_ISSUER:-}
      OIDC_CLIENT_ID: ${OIDC_CLIENT_ID:?openssl rand -hex 32}
      OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET:?openssl rand -hex 32}
      AUTHENTIK_SELF_SIGNUP: ${AUTHENTIK_SELF_SIGNUP:-off}
      AUTHENTIK_SELF_SIGNUP_VERIFY_EMAIL: ${AUTHENTIK_SELF_SIGNUP_VERIFY_EMAIL:-off}
      AUTHENTIK_BRANDING: ${AUTHENTIK_BRANDING:-on}
      AUTHENTIK_EMAIL__HOST: ${AUTHENTIK_EMAIL__HOST:-}
      # Set only here: this is the container with the files to copy.
      AUTHENTIK_BLUEPRINTS_OUT: /out/blueprints
      AUTHENTIK_ICONS_OUT: /out/icons
      AUTHENTIK_IMAGES_OUT: /out/images
    volumes:
      - authentik-blueprints:/out/blueprints
      - authentik-icons:/out/icons
      - authentik-images:/out/images
    command: ['node', 'scripts/bootstrap-authentik.mjs']
    restart: 'no'

  # Runs once per deploy, as a SEPARATE credential the app never holds — it is
  # the only thing allowed to change the schema. `up -d` waits for it to finish.
  migrate:
    image: ghcr.io/easymod0/habiterall-cloud:latest
    depends_on:
      db: { condition: service_healthy }
    environment:
      DATABASE_URL_ADMIN: postgres://habiterall_owner:${DB_OWNER_PASSWORD}@db:5432/habiterall
      APP_DB_PASSWORD: ${APP_DB_PASSWORD:?set it in .env}
    command: ['node', 'src/db/migrate.js']
    restart: 'no'

  app:
    image: ghcr.io/easymod0/habiterall-cloud:latest
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
      authentik-bootstrap: { condition: service_completed_successfully }
    ports:
      - '${BIND_ADDR:-}:${APP_PORT:-3100}:3000'
    environment:
      NODE_ENV: production
      # The RESTRICTED role — not the owner. This is what makes a forgotten
      # WHERE clause return nothing instead of another user's rows.
      DATABASE_URL: postgres://habiterall_app:${APP_DB_PASSWORD}@db:5432/habiterall
      SESSION_SECRET: ${SESSION_SECRET:?openssl rand -base64 36}
      PUBLIC_URL: ${PUBLIC_URL:?the address browsers use, https in production}
      OIDC_ISSUER: ${OIDC_ISSUER:?from Authentik, ends in a slash}
      # Values you generate, not values you collect from Authentik — so there
      # is no moment when empty is correct, and these are required.
      OIDC_CLIENT_ID: ${OIDC_CLIENT_ID:?openssl rand -hex 32}
      OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET:?openssl rand -hex 32}
      ALLOW_INSECURE_OIDC: ${ALLOW_INSECURE_OIDC:-false}   # local testing ONLY
      TRUST_PROXY: ${TRUST_PROXY:-1}                       # TLS terminators in front
      DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN:-}            # adds Yes / No / Skip buttons
      HABITERALL_NOTIFY: ${HABITERALL_NOTIFY:-on}          # reminders this server sends
      HABITERALL_NOTIFY_INTERVAL_MS: ${HABITERALL_NOTIFY_INTERVAL_MS:-60000}
      NOTIFY_MAX_ACCOUNTS: ${NOTIFY_MAX_ACCOUNTS:-500}     # accounts visited per tick
      # Which hosts a user's ntfy topic URL may name. Empty is ntfy.sh alone;
      # your own ntfy REPLACES that, and `off` refuses every one. The server
      # fetches whatever is here, so this is the whole guard.
      NTFY_ALLOWED_HOSTS: ${NTFY_ALLOWED_HOSTS:-}          # ntfy.sh, or your own
      # The fallback clock. A container has no timezone, so it is UTC; users
      # can override it for their own reminders in ⚙ → Notifications.
      TZ: ${TZ:-Etc/UTC}

      # Limits, the pool, and logging. Empty means the default, so these are
      # here to make the knob reachable from .env rather than to set anything
      # — a variable this file does not name never reaches the container.
      MAX_HABITS_PER_USER: ${MAX_HABITS_PER_USER:-}        # 200
      MAX_HABITS_PER_IMPORT: ${MAX_HABITS_PER_IMPORT:-}    # 200
      MAX_ENTRIES_PER_IMPORT: ${MAX_ENTRIES_PER_IMPORT:-}  # 50000
      MAX_UPLOAD_MB: ${MAX_UPLOAD_MB:-}                    # 16
      MAX_PARSE_HABITS: ${MAX_PARSE_HABITS:-}              # 10000
      MAX_PARSE_ENTRIES: ${MAX_PARSE_ENTRIES:-}            # 250000
      PG_POOL_MAX: ${PG_POOL_MAX:-}                        # 10 — the /healthz memo is sized on it
      PGSSL: ${PGSSL:-}                                    # `require` for a managed Postgres
      LOG_LEVEL: ${LOG_LEVEL:-}                            # info; debug for reminders
      LOG_FORMAT: ${LOG_FORMAT:-}                          # json, or pretty on a TTY
      LOG_REQUESTS: ${LOG_REQUESTS:-}                      # true logs every request
      LOG_SLOW_MS: ${LOG_SLOW_MS:-}                        # 1000
      LOG_RUNTIME_MS: ${LOG_RUNTIME_MS:-}                  # 60000
      LOG_LAG_WARN_MS: ${LOG_LAG_WARN_MS:-}                # 200
    restart: unless-stopped

volumes:
  db-data:
  authentik-db-data:
  # Refilled from the habiterall image on every `up`, so a file edited in here
  # is overwritten on the next start. Change them in an image you build.
  authentik-blueprints:
  authentik-icons:
  authentik-images:
```
<!-- /generated -->
</details>

#### Filling in the `.env`

**Two hostnames, not one.** `PUBLIC_URL` is where habiterall answers and
`OIDC_ISSUER` is where Authentik does, and they must be different origins
unless your proxy path-routes `/application/*`, `/if/*` and
`/outpost.goauthentik.io/*` to Authentik. Point `auth.example.com` at the
Authentik container's published port and `habits.example.com` at the app's.
Putting the issuer on the app's own hostname produces a memorable failure: the
proxy asks habiterall for Authentik's discovery document, the app is still
starting — because it is waiting on that very document — and you get a 502
that looks like a proxy fault rather than a configuration one.

Every secret ships as a `CHANGE_ME` line, and there are nine. Hex for the two
database passwords and the OIDC pair, because those go into a connection URL or
an `Authorization` header and base64's `/` ends a URL's authority — about half
of generated passwords contain one:

```bash
openssl rand -hex 32      # DB_OWNER_PASSWORD, APP_DB_PASSWORD,
                          # OIDC_CLIENT_ID, OIDC_CLIENT_SECRET
openssl rand -base64 36   # AUTHENTIK_DB_PASSWORD, SESSION_SECRET,
                          # AUTHENTIK_BOOTSTRAP_TOKEN
openssl rand -base64 60   # AUTHENTIK_SECRET_KEY
```

The OIDC pair is yours to choose, not Authentik's to hand you: the stack
configures the provider *with* them, so nothing is pasted back. Set
`PUBLIC_URL`, `OIDC_ISSUER` and `AUTHENTIK_PUBLIC_URL` to your two hostnames,
and `AUTHENTIK_BOOTSTRAP_PASSWORD` to the first admin's password.

> **Just trying it on your laptop?** Leave those three URLs at their
> `http://localhost` defaults and set **`ALLOW_INSECURE_OIDC=true`**. Without
> it the app exits at startup with *"OIDC_ISSUER uses plaintext http"* —
> `openid-client` refuses a plaintext issuer, and rightly. Set it back to
> `false` the moment the stack is behind TLS; the
> [production checklist](habiterall-cloud/SETUP.md) checks for it.

<details>
<summary><b>Show <code>cloud.env.example</code></b></summary>

<!-- generated from examples/cloud.env.example — edit that file, then `npm run docs:compose` -->
```ini
# ---- database ---------------------------------------------------------------
# HEX, not base64: these two are interpolated into a `postgres://user:PASSWORD@`
# URL, and base64 emits '+' and '/', which end the URL's authority.
#   openssl rand -hex 32
DB_OWNER_PASSWORD=CHANGE_ME_owner
APP_DB_PASSWORD=CHANGE_ME_app

# Read by Authentik as a discrete setting, never through a URL, so base64 is
# fine here.  openssl rand -base64 36
AUTHENTIK_DB_PASSWORD=CHANGE_ME_authentik

# ---- application ------------------------------------------------------------
#   openssl rand -base64 36
SESSION_SECRET=CHANGE_ME_session_secret_at_least_32_bytes

# The address browsers use. Must match the redirect URI registered with your
# provider, and must be https in production — the session cookie is Secure.
PUBLIC_URL=http://localhost:3100

APP_PORT=3100
AUTHENTIK_PORT=9000

# Which interface those ports are published on. Empty is Docker's default:
# every interface, both address families. Use 127.0.0.1 when a reverse proxy on
# THIS host is the only thing that should reach them. Not 0.0.0.0 — IPv4 only.
BIND_ADDR=

# Reverse-proxy hops in front, for correct client IPs. 0 if nothing proxies it.
TRUST_PROXY=1

# The container's own clock, and a fallback for both things that need one: an
# account no client has ever reported a zone from, and a request that names no
# zone. Browsers and the Android app report their own, so a check-off is filed
# under the day it is where you are. Unset, a container is UTC.
TZ=Etc/UTC

# Lets the app talk OIDC over plain http. LOCAL TESTING ONLY — never in a real
# deployment. Both guards it lifts exist because plaintext issuers and
# non-Secure cookies are how a session gets stolen.
#
# READ THIS IF YOU ARE JUST TRYING IT OUT. The URLs above ship as
# http://localhost, and openid-client REFUSES a plaintext issuer — so on those
# defaults the app container exits at startup with "OIDC_ISSUER uses plaintext
# http". Set this to `true` for a local trial, and back to `false` the moment
# you put the stack behind TLS.
ALLOW_INSECURE_OIDC=false

# ---- identity provider ------------------------------------------------------
# The OIDC application is created for you: compose runs
# scripts/bootstrap-authentik.mjs on every `up`, and it CONFIGURES the provider
# with the id and secret below rather than handing you a generated pair to
# paste back. Generate both like any other secret:  openssl rand -hex 32
#
# They cannot be left empty — compose interpolates the whole file before it
# starts anything. And unlike the other CHANGE_ME lines they are WRITTEN TO the
# identity provider, so the bootstrap refuses a placeholder from a public repo.
OIDC_CLIENT_ID=CHANGE_ME_oidc_client_id
OIDC_CLIENT_SECRET=CHANGE_ME_oidc_client_secret

# Authentik's URL as the BROWSER sees it, plus the application slug, ending in
# a slash. Byte-identical for the browser and the app container, or token
# validation fails on an issuer mismatch.
OIDC_ISSUER=http://localhost:9000/application/o/habiterall/
# The same URL without the application path. Only the bootstrap reads it.
AUTHENTIK_PUBLIC_URL=http://localhost:9000

# Checkout stack only. The issuer must resolve to the same string from the
# browser and from inside the app container, so the hostname in OIDC_ISSUER is
# aliased to the Authentik container. In a real deployment both sides use the
# public https URL and this stays as it is.
OIDC_HOST_ALIAS=localhost

# ---- self-service registration ----------------------------------------------
# `on` puts a "Sign up" link on the Authentik login page, and anyone who can
# reach it can create an account. `off` removes the link AND the flow behind it.
#
# The link goes on the DEFAULT login flow, which every application on that
# Authentik shares — so read SETUP.md first if it serves anything besides
# habiterall. Accepted: on/true/yes/1/enabled and off/false/no/0/disabled.
# Anything else stops the stack rather than being guessed at.
AUTHENTIK_SELF_SIGNUP=off

# Confirm the address before the account works. The user is created inactive
# and the mailed link activates them, so this needs real SMTP settings below.
AUTHENTIK_SELF_SIGNUP_VERIFY_EMAIL=off

# ---- branding ---------------------------------------------------------------
# habiterall's name, mark and colours on the sign-in and sign-up pages. `off`
# stops these being managed; it does not restore Authentik's own branding.
# The tab title, favicon and accent also reach Authentik's admin interface.
AUTHENTIK_BRANDING=on

# ---- outgoing mail ----------------------------------------------------------
# Authentik's own setting names. Only the email verification above sends mail,
# so these can stay as they are until you turn it on.
#
# Submission port and STARTTLS by default: the minimal edit is the host and the
# credentials, and on port 25 with TLS off that edit puts an SMTP password and
# an account-activation link on the wire in the clear.
AUTHENTIK_EMAIL__HOST=localhost
AUTHENTIK_EMAIL__PORT=587
AUTHENTIK_EMAIL__USERNAME=
AUTHENTIK_EMAIL__PASSWORD=
AUTHENTIK_EMAIL__USE_TLS=true
AUTHENTIK_EMAIL__USE_SSL=false
AUTHENTIK_EMAIL__FROM=habiterall@example.com

# ---- authentik bootstrap ----------------------------------------------------
# The password and email create the first admin and are then dead weight. The
# TOKEN is what keeps the OIDC application and the switches above in step with
# this file on every `up` — delete it and both freeze as they are, which is a
# supported way to run once you are done configuring.
#
# Authentik turns that line into a full admin API token for `akadmin`, so the
# placeholder is refused for the same reason the OIDC pair is.
#   openssl rand -base64 36  (the secret key too, base64 60)
AUTHENTIK_SECRET_KEY=CHANGE_ME_authentik_secret_key
AUTHENTIK_BOOTSTRAP_PASSWORD=CHANGE_ME_initial_admin_password
AUTHENTIK_BOOTSTRAP_EMAIL=admin@example.com
AUTHENTIK_BOOTSTRAP_TOKEN=CHANGE_ME_api_token_for_setup

# ---- reminders --------------------------------------------------------------
# Reminders pointed at a Discord webhook are sent by this process, once a
# minute; users with only the on-device destination cost nothing here, because
# the phone arms its own alarms. `off` disables the loop entirely.
HABITERALL_NOTIFY=on
HABITERALL_NOTIFY_INTERVAL_MS=60000
# Accounts visited per tick. A tick is a minute and each account may cost a
# webhook round trip, so this stops one pass overlapping the next.
NOTIFY_MAX_ACCOUNTS=500

# Interactive Discord reminders — Yes / No / Skip buttons and an amount box.
# One bot for the whole instance; each user pastes their own channel id into
# Settings. Deliberately NOT a per-user setting: this token can post to every
# channel the bot is in, and GET /api/settings hands user settings to a browser.
#
# Create it at https://discord.com/developers/applications → Bot → Reset Token,
# then invite the bot with the `bot` scope and Send Messages. With it set the
# app opens ONE outbound WebSocket to Discord; no inbound port is needed.
DISCORD_BOT_TOKEN=

# Which hosts an ntfy topic URL may name. Reminders go out as an ntfy publish
# that THIS SERVER makes, and on this edition the person typing the URL is not
# the person running the server — so this is the line that decides what a user
# can point your instance at. Without it a topic URL is a request-forgery
# primitive aimed at your private network or your cloud metadata endpoint.
#
# An entry is a host, and optionally a BASE PATH under it:
#
#   ntfy.sh                     https://ntfy.sh/<topic>
#   ntfy.example.com:8443       a port, when your ntfy is not on 443
#   example.com/ntfy            https://example.com/ntfy/<topic>
#
# A user's URL may add exactly ONE topic segment to what you name here, and
# nothing else. That is the point of the base path rather than a convenience:
# naming `example.com` alone would let any account on this instance make the
# server POST to any shallow path on that host, and read the status back.
# Name the base path if your ntfy is reverse-proxied under one. https either way.
#
# LEAVING THIS EMPTY MEANS ntfy.sh — it is the default, not "nothing allowed".
# Naming your own REPLACES that rather than adding to it, so write both if you
# want both. `off` refuses every URL, which is how you switch the destination
# off instance-wide.
#
#   NTFY_ALLOWED_HOSTS=ntfy.sh,example.com/ntfy
NTFY_ALLOWED_HOSTS=

# ---- limits -----------------------------------------------------------------
# Shown at their code defaults, so an unedited copy changes nothing.
MAX_HABITS_PER_USER=200
MAX_HABITS_PER_IMPORT=200
MAX_ENTRIES_PER_IMPORT=50000
MAX_UPLOAD_MB=16

# What one uploaded file may DECLARE, before anything is built from it — a
# bound on a hostile file rather than a product limit. A SQLite file's row
# count is a claim, so a few kilobytes can assert millions. Raising them trades
# memory for generosity: both defaults together cost roughly 90MB to parse.
#MAX_PARSE_HABITS=10000
#MAX_PARSE_ENTRIES=250000

# ---- tuning -----------------------------------------------------------------
# Uncommented only when you mean it. Defaults shown.
#LOG_LEVEL=info                 # debug is the switch for "the reminder never came"
#LOG_FORMAT=json                # pretty on a TTY, json otherwise
#LOG_REQUESTS=false             # true logs every request, not just the slow ones
#LOG_SLOW_MS=1000
#LOG_RUNTIME_MS=60000
#LOG_LAG_WARN_MS=200
#PG_POOL_MAX=10                 # what the /healthz memo is sized against
#PGSSL=                         # `require` for a managed Postgres reached over TLS
```
<!-- /generated -->
</details>

Then start it, once:

```bash
docker compose up -d
```

There is no second phase and nothing to click — the `authentik-bootstrap`
service does the configuring. What it says it will do, it says here:

```bash
docker compose logs authentik-bootstrap
#   created provider
#   created application
#   branding: habiterall
#   self-service registration: OFF
```

| | |
|---|---|
| **The app** | **<http://localhost:3100>** |
| Authentik admin | <http://localhost:9000> (sign in as `akadmin`) |

Create users in Authentik under *Directory → Users*; a habiterall account is
provisioned the first time each one signs in.

**Or let people create their own.** `AUTHENTIK_SELF_SIGNUP=on` in `.env`, then
`docker compose up -d`, and the login page grows a **Sign up** link — anyone
who can reach that page can then create an account, which on a public instance
is everyone. `AUTHENTIK_SELF_SIGNUP_VERIFY_EMAIL=on` makes them confirm the
address first, and needs a real SMTP server in the `AUTHENTIK_EMAIL__*`
settings. `off` removes the link *and* the sign-up page behind it. The sign-in
pages carry habiterall's name and colours unless you set
`AUTHENTIK_BRANDING=off`. Read
[`habiterall-cloud/SETUP.md`](habiterall-cloud/SETUP.md) before opening
registration on an Authentik that serves anything else — the link goes on the
instance-wide login flow, so what a stranger creates is an Authentik account.

<details>
<summary><b>Or from a clone, which is the same stack built from source</b></summary>

The compose file in the repository builds the image instead of pulling it, and
puts Authentik's database in the same Postgres server as habiterall's rather
than running a second one. Everything else is the same file: the bootstrap
configures Authentik identically, except that it reads the blueprints and
images straight from the checkout, so editing one takes effect on the next
request instead of on the next build.

```bash
git clone https://github.com/easymod0/habiterall.git
cd habiterall/habiterall-cloud
cp ../examples/cloud.env.example .env    # then fill in the CHANGE_ME lines
docker compose up -d
```

`habiterall-cloud/SETUP.md` is the longer version, including TLS, backups and
what to check before a real deployment.
</details>

**Already run an identity provider?** The stack above brings its own Authentik,
which is the quickest way to have *one*. If you already have Keycloak, Authelia,
Entra or Auth0, use
[`examples/docker-compose.cloud.yml`](examples/docker-compose.cloud.yml) instead
— the published image, Postgres, and nothing else.

<details>
<summary><b>Show that file</b></summary>

<!-- generated from examples/docker-compose.cloud.yml — edit that file, then `npm run docs:compose` -->
```yaml
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: habiterall
      POSTGRES_USER: habiterall_owner
      POSTGRES_PASSWORD: ${DB_OWNER_PASSWORD:?set it in .env}
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U habiterall_owner -d habiterall']
      interval: 5s
      retries: 20
    restart: unless-stopped

  # Runs once per deploy, as a SEPARATE credential the app never holds — it is
  # the only thing allowed to change the schema. `up -d` waits for it to finish.
  migrate:
    image: ghcr.io/easymod0/habiterall-cloud:latest
    depends_on:
      db: { condition: service_healthy }
    environment:
      DATABASE_URL_ADMIN: postgres://habiterall_owner:${DB_OWNER_PASSWORD}@db:5432/habiterall
      APP_DB_PASSWORD: ${APP_DB_PASSWORD:?set it in .env}
    command: ['node', 'src/db/migrate.js']
    restart: 'no'

  app:
    image: ghcr.io/easymod0/habiterall-cloud:latest
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    ports:
      - '${BIND_ADDR:-}:${APP_PORT:-3100}:3000'
    environment:
      NODE_ENV: production
      # The RESTRICTED role — not the owner. This is what makes a forgotten
      # WHERE clause return nothing instead of another user's rows.
      DATABASE_URL: postgres://habiterall_app:${APP_DB_PASSWORD}@db:5432/habiterall
      SESSION_SECRET: ${SESSION_SECRET:?openssl rand -base64 36}
      PUBLIC_URL: ${PUBLIC_URL:?the address browsers use, https in production}
      OIDC_ISSUER: ${OIDC_ISSUER:?from your provider}
      OIDC_CLIENT_ID: ${OIDC_CLIENT_ID:?}
      OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET:?}
      ALLOW_INSECURE_OIDC: ${ALLOW_INSECURE_OIDC:-false}   # local testing ONLY
      TRUST_PROXY: ${TRUST_PROXY:-1}                       # TLS terminators in front
      DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN:-}            # adds Yes / No / Skip buttons
      HABITERALL_NOTIFY: ${HABITERALL_NOTIFY:-on}          # reminders this server sends
      HABITERALL_NOTIFY_INTERVAL_MS: ${HABITERALL_NOTIFY_INTERVAL_MS:-60000}
      NOTIFY_MAX_ACCOUNTS: ${NOTIFY_MAX_ACCOUNTS:-500}     # accounts visited per tick
      # Which hosts a user's ntfy topic URL may name. Empty is ntfy.sh alone;
      # your own ntfy REPLACES that, and `off` refuses every one. The server
      # fetches whatever is here, so this is the whole guard.
      NTFY_ALLOWED_HOSTS: ${NTFY_ALLOWED_HOSTS:-}          # ntfy.sh, or your own
      # The fallback clock. A container has no timezone, so it is UTC; users
      # can override it for their own reminders in ⚙ → Notifications.
      TZ: ${TZ:-Etc/UTC}

      # Limits, the pool, and logging. Empty means the default, so these are
      # here to make the knob reachable from .env rather than to set anything
      # — a variable this file does not name never reaches the container.
      MAX_HABITS_PER_USER: ${MAX_HABITS_PER_USER:-}        # 200
      MAX_HABITS_PER_IMPORT: ${MAX_HABITS_PER_IMPORT:-}    # 200
      MAX_ENTRIES_PER_IMPORT: ${MAX_ENTRIES_PER_IMPORT:-}  # 50000
      MAX_UPLOAD_MB: ${MAX_UPLOAD_MB:-}                    # 16
      MAX_PARSE_HABITS: ${MAX_PARSE_HABITS:-}              # 10000
      MAX_PARSE_ENTRIES: ${MAX_PARSE_ENTRIES:-}            # 250000
      PG_POOL_MAX: ${PG_POOL_MAX:-}                        # 10 — the /healthz memo is sized on it
      PGSSL: ${PGSSL:-}                                    # `require` for a managed Postgres
      LOG_LEVEL: ${LOG_LEVEL:-}                            # info; debug for reminders
      LOG_FORMAT: ${LOG_FORMAT:-}                          # json, or pretty on a TTY
      LOG_REQUESTS: ${LOG_REQUESTS:-}                      # true logs every request
      LOG_SLOW_MS: ${LOG_SLOW_MS:-}                        # 1000
      LOG_RUNTIME_MS: ${LOG_RUNTIME_MS:-}                  # 60000
      LOG_LAG_WARN_MS: ${LOG_LAG_WARN_MS:-}                # 200
    restart: unless-stopped

volumes:
  db-data:
```
<!-- /generated -->

Register `${PUBLIC_URL}/auth/callback` as the redirect URI with your provider.
**Register `${PUBLIC_URL}/` as the post-logout redirect too** — `POST
/auth/logout` sends it as `post_logout_redirect_uri`, and a provider only
honours a value it has been told about. Where that value goes is not the same
question for each of the four above:

| Provider | Where the post-logout URI goes |
|---|---|
| **Keycloak** | *Valid post logout redirect URIs*, a list of its own. A literal `+` there means "reuse the sign-in list", and is the default for realms migrated from before Keycloak 19 — so some installs already work |
| **Auth0** | *Allowed Logout URLs*, a list of its own, on the application or on the tenant |
| **Entra ID** | The **same** list as the sign-in redirect URI; there is no second field. The *Front-channel logout URL* box is a different feature — single sign-out notification — and filling that in instead leaves a configuration that looks complete and is not |
| **Authelia** | Nothing to register. It does not implement RP-initiated logout, so it advertises no `end_session_endpoint` |

The bundled Authentik stack registers both entries itself, which is why nobody
on the quickstart path meets any of this.

What a missing registration costs depends on which way the provider refuses.
Some ignore the unregistered value and end the session anyway: you are signed
out, but the browser is left on the provider's page rather than back here. The
other kind rejects the logout request, and that one is worth the trouble of
avoiding — this app's own session has already gone, so it returns to its
sign-in screen looking entirely correct, while the provider's session, the
credential that silently recreates yours, is still there. On a shared device
that is the half that matters, and only being asked for a password again tells
the two apart.

Authelia is the case with nothing to get wrong and nothing to fix. With no
end-session endpoint to build a URL from, `/auth/logout` hands back this app's
own root: the habiterall session ends and Authelia's own outlives it, by design
rather than by misconfiguration. Signing out of Authelia is a separate act
until [authelia#5057](https://github.com/authelia/authelia/issues/5057) lands.

Users are provisioned the first time each one signs in.

> **Pin the tag here.** `latest` is fine for the personal edition, where an
> update is a new binary against the same file. The cloud edition runs
> migrations on deploy, so pulling `latest` means taking a schema change at a
> moment you did not choose. Pin the full `X.Y.Z` and bump it deliberately.
</details>

Full walkthrough, including HTTPS and the production checklist:
**[habiterall-cloud/SETUP.md](habiterall-cloud/SETUP.md)**.

### Put HTTPS in front

Not optional, and not only for the usual reasons — two features here are
load-bearing on it:

- **Offline and installability.** Service workers are disabled on plaintext
  origins other than `localhost`, so without HTTPS there is no offline mode, no
  outbox, and no *Add to Home Screen*.
- **Signing in (cloud).** The session cookie is marked `Secure` whenever
  `PUBLIC_URL` is https, and a browser discards a `Secure` cookie sent over
  plain HTTP. Login then fails with no error message at all — it simply loops
  back to the sign-in page.

[`examples/Caddyfile`](examples/Caddyfile) is the whole thing, certificate
included:

<!-- generated from examples/Caddyfile — edit that file, then `npm run docs:compose` -->
```caddyfile
habits.example.com {
	# Caddy gets and renews the certificate itself. Nothing else to configure.
	reverse_proxy localhost:3000
}
```
<!-- /generated -->

```bash
docker compose up -d      # habiterall on :3000
caddy run                 # or: sudo caddy start
```

<details>
<summary><b>nginx, if you already run it</b></summary>

```nginx
server {
    listen 443 ssl;
    server_name habits.example.com;

    ssl_certificate     /etc/letsencrypt/live/habits.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/habits.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        # The personal edition's limiters key on the client address, so without
        # this every request appears to come from the proxy and one user's
        # traffic throttles everybody. Cloud keys most of its limits per
        # signed-in user — but not the one on login attempts, which has no
        # user yet and is the limit you least want collapsed into one bucket.
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        # And this is what tells the app the browser is on https, which is what
        # makes the session cookie Secure.
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
</details>

<details>
<summary><b>Nginx Proxy Manager</b></summary>

Nothing to write — it is all in the web UI, and its default proxy config
already sends the headers above. **Hosts → Proxy Hosts → Add Proxy Host:**

| Field | Value |
|---|---|
| Domain Names | `habits.example.com` |
| Scheme | `http` — this is the hop *behind* the proxy, not what your browser uses |
| Forward Hostname / IP | the container name (`habiterall`) if it shares a Docker network with NPM, otherwise the host's LAN IP |
| Forward Port | `3000` (personal) or `3100` (cloud) |
| Cache Assets | off — the app's service worker already does this, and a stale `index.html` served from the proxy pins clients to an old build |
| Block Common Exploits | on |
| Websockets Support | not needed; harmless if on |
| **SSL** tab | request a Let's Encrypt certificate, then **Force SSL** on |

The one that catches everybody: **`localhost` in *Forward Hostname* means NPM's
own container**, not your server. It resolves, connects to nothing, and shows a
502 — which reads like the app is down. Put both on one network instead:

```yaml
services:
  habiterall:
    image: ghcr.io/easymod0/habiterall-personal:latest
    expose: ['3000']        # not `ports:` — only NPM needs to reach it
    volumes: ['habiterall-data:/data']
    environment:
      HABITERALL_DB: /data/habiterall.db
    networks: [proxy]
    restart: unless-stopped

networks:
  proxy:
    external: true          # the network Nginx Proxy Manager is already on
volumes:
  habiterall-data:
```

Then *Forward Hostname* is `habiterall` and *Forward Port* is `3000`.
</details>

Whichever you use: with one proxy in front, set **`TRUST_PROXY=1`**. Use the
number of proxies if there are more, and `0` when the app is reached directly.
The two editions default differently on purpose — cloud to `1`, because its
documented deployment has TLS in front, and personal to `0`, because its
quickstart is a port on a LAN with nothing in front at all.

Getting it wrong is a bug in both directions. Too low and every caller looks
like the proxy, so one client spends everyone's rate limit, the session cookie
cannot be marked `Secure`, and a proxy that rewrites `Host` makes every write
look cross-origin and get refused. Too high and `X-Forwarded-For` becomes the
caller's to choose, which is the rate limiter's only key — forty guesses at the
password walk through a limit of twenty by rotating one header. The server logs
`trust_proxy` at startup and warns when a forwarded header arrives that it has
been told not to believe.

One thing that follows and is easy to get wrong: **if you set `TRUST_PROXY=1`,
the app's port must only be reachable through the proxy.** Leaving 3000 open on
the LAN as a shortcut means anything on that LAN can send those headers itself.
Set `BIND_ADDR=127.0.0.1` so the port is published to loopback only, or
firewall it, and reach the app by its proxied name from inside the house as
well as outside. If the proxy runs on a *different* host, leave `BIND_ADDR`
empty and firewall to that host instead — loopback would put the app out of
the proxy's reach too.

### Turning the guards off

The personal edition is meant to be run on a laptop, a NAS or a LAN as readily
as on the internet, so most of the hardening is a setting rather than a fact.
For an instance only reachable over a VPN or a trusted network:

| Set | Effect |
|---|---|
| `HABITERALL_AUTH=off` | No sign-in at all. Every route is open to whoever can reach the port, exactly as this edition behaved before it had auth. The value must be **exactly** `off` — `false`, `0` and every typo leave it on, and the server says so at startup. |
| `HABITERALL_RATE_LIMIT=off` | Removes the limits on the API, imports and test notifications. The limit on *login attempts* is deliberately not included and cannot be switched off. |
| `TRUST_PROXY=0` (the default) | Nothing in front is believed. Right for a direct port; see above. |
| `HABITERALL_UPGRADE_INSECURE` unset (the default) | Browsers are **not** told to rewrite http to https. Leave it unset unless the instance is only ever reached over TLS — turning it on breaks a box that answers on both. |
| `NODE_ENV` to anything but `production` | No HSTS header. A browser that sees one on a plain-http stack pins that hostname to https for a year, and `localhost` is a hostname a lot of other things use too. **Both published images bake in `NODE_ENV=production`**, so HSTS is *on* by default under Docker and unsetting it means saying so in the compose file; a clone started with `npm start` has it off already. |

The session cookie needs nothing: it is marked `Secure` only on requests that
actually arrived over TLS, so a plain-http LAN instance and an https one behind
a proxy both work, including when they are the same instance.

Two things have no switch, and both are load bearing rather than decorative.
The **Content-Security-Policy** is what makes the frontend's design true —
`connect-src 'self'` is the reason the browser cannot post to a Discord webhook
and the server keeps time for reminders instead — so relaxing it changes the
architecture, not a header. And the **cross-origin check** on writes costs a
same-origin client nothing: browsers send `Origin` on every state-changing
request, a request without one is allowed through (that is how the Android
client posts), and what it refuses is a page on another site using your logged-in
browser as a lever. Neither of those gets safer on a VPN.

---

## Features

**Two habit types** — yes/no checkmarks, and measurable habits with a target
and an *at least* / *at most* goal, so both "drink 8 glasses" and "at most 0
cigarettes" work.

**Habits you are trying not to do** — that last one reads backwards by default,
so an *at most* habit can be shown the other way up. Set **Show this habit as**
to *Something to avoid* on its edit screen: a clean day then fills in the
habit's colour while a slip paints red and shows how far over you went, and the
day editor's two buttons read **Clean day** / **Slipped** rather than Done / Not
done. The Android notification inverts with it — **Clean** / **Slipped** in the
shade, where a limit is answered without opening anything. Nothing about the
storage moves. It is still an at-most
target, the target still decides whether a day counts, and the Loop export
carries exactly what it carried before — this is a way of *reading* a habit,
not a different kind of habit. The tap cycle is unchanged too; only what a tap
writes differs, so a clean day records 0 and a slip records one over the limit,
the least the app is willing to claim on your behalf. Type the real number in
the day editor when it matters.

**Any frequency** — *n* times per *m* days. A habit held at exactly its target
reaches full strength whether that is daily or 3×/week.

**Edit any day** — click a square in the calendar to correct history, page
back through months, or attach a note explaining why a day went the way it
did.

**Skips** — a skipped day is neither success nor failure. It bridges streaks
instead of breaking them, and holds your score steady. Use it for illness or
travel.

**Archive** — retire a habit without deleting its history.

**Reorder** — drag by the handle, or focus it and use ↑ / ↓.

**Undo** — deleting a habit offers an Undo that restores it with every entry
and note intact.

**Reminders, where you want them** — set a time on a habit, choose what the
reminder *asks* ("Did you exercise today?"), and pick where it goes under ⚙ →
Notifications: the Android app, a Discord channel, an ntfy topic, or any
combination of them. In Discord you can answer with a button without leaving
the chat. See [Reminders and notifications](#reminders-and-notifications).

**Works offline** — check off habits with no signal; they queue on the device
and sync, in order, when you reconnect. Reconnection is automatic, and does not
rely on the browser noticing: the app re-checks when you come back to the tab
and keeps probing while it is down, so restarting the server does not leave a
page stranded.

**Find a habit** — once an account has six or more habits, a search box appears
above the dashboard. It folds case and strips accents, so "cafe" finds "Café",
and it matches the description as well as the name — a habit called "Gym" whose
description says "swimming Tuesdays" is one people look for by the second. It
filters what is already on screen, so it works offline and costs no request.
The Android app offers the same search, but behind an icon in its top bar
rather than a permanent row — a phone shows about four rows and can't spare a
dashboard's vertical room — and it's offered as soon as the account holds any
habits at all, not from six. Closing the field doesn't drop the filter: the
icon stays lit and an "N of M" count stays on screen until you clear it. The
fold is still near-identical.

**Light, dark, or whatever this device is set to** — three states, not two, and
the header's ◐ / ☀ / ☾ button cycles between them. *Follow this device* is
somewhere you can go back to, which is the actual change: the old toggle wrote
one of two values and following the system was the absence of both, so pressing
it once was irreversible and a machine that goes dark at sunset quietly stopped
doing so with nothing on screen to say why. The choice is stored on the account
rather than on the device, so it follows you between browsers, and it travels in
the JSON backup.

<div align="center">
<img src="docs/screenshots/dashboard-dark.png" width="820"
     alt="The same dashboard in dark theme: the surrounding chrome goes near-black while each habit keeps its own colour, so the filled squares still read at a glance.">
</div>

### Statistics

| View | What it shows |
|---|---|
| **Strength** | Loop's exponential-decay score, plotted by day / week / month / quarter / year |
| **Calendar** | A clickable heatmap with streaks joined up, zoomable and pageable |
| **History** | Completions by day / week / month / quarter / year, as a percentage or a count |
| **Best streaks** | Your ten longest runs, listed newest first with the dates |
| **Bouncing back** | What happens *after* a miss — see below |
| **Awards** | What the history has already earned — see below |
| **By day of week** | Which days you reliably miss |
| **Weekday consistency** | The same, month by month, so you can see a weekday slipping |
| **Times per week** | How many weeks each month hit 1×, 2×, 3× … |

Every chart with a time axis pages through history rather than cramming years
into one screen, and the number of columns follows the width you have.

Plus current streak, best streak, and total completions at a glance.

<div align="center">
<img src="docs/screenshots/statistics.png" width="820"
     alt="A habit's detail view: strength 86%, current and best streak 8, 106 total; the strength curve rising over four months; a year-long calendar heatmap; and the ten best streaks listed by date.">
</div>

### Bouncing back

Streaks reward perfection and punish one bad day. **Bouncing back** measures
the thing that actually decides whether a habit survives — what happens after
you miss:

- **Recovery rate** — of every lapse that ended, how often were you back the
  very next day?
- **How long lapses last** — misses clustered at one day mean a habit that
  self-corrects; a fat tail means one that, once dropped, stays dropped.
- **How far streaks get** — of all the streaks you started, what share reached
  3 days? 7? 30? The cliff in that curve locates where this habit reliably
  breaks, which "best streak: 23" cannot tell you.

Two habits can both recover 100% of the time and still be nothing alike: one
clears a week 86% of the time, the other 40%. Only the survival curve
separates them.

<div align="center">
<img src="docs/screenshots/bouncing-back.png" width="820"
     alt="The Bouncing back card: back next day 100%, longest lapse 1 day, currently missed 1 day; a histogram showing all 14 lapses lasted a single day; and a survival curve ending at 93% of streaks reaching 7 days.">
</div>

> Shown for **every** frequency. This used to be daily-only, because a miss
> meant "a day it was not done" and a 3×/week habit has four of those a week —
> a perfectly kept habit reported as lapsing continuously. A miss is now a day
> the habit fell *below its rate*, which is a real failure whatever the
> frequency, so there is nothing left to suppress.

### Awards

A short row of badges under *Bouncing back*, for what a habit's history
currently shows:

- **Streaks** — the longest run you have managed, against the same ladder the
  survival curve uses: 2, 3, 5, 7, 14, 21, 30, 60, 100 days. It reads your
  *best* run, not the one you are on, so it does not go out the day a run ends.
- **Strength** — 50%, 80% or 95%, whichever your strength curve has reached.
  50% is about a fortnight of keeping a daily habit, 95% about two months. It
  reads the curve's high point, so an ordinary bad week does not take it.
- **Comebacks** — how many times you were back the next day after a miss, and
  the longest lapse you have climbed out of. A recent one is flagged as new for
  a week, because coming back is the moment worth noticing.
- **Every day of the week** — you have kept this on all seven weekdays at least
  once.
- **A year of keeping it** — your first good run and your most recent are a
  year or more apart. Importing a backup that already covers a year earns it on
  arrival, because the record really is that long.
- **No lapse over a day** — every lapse so far has lasted a single day. The
  next two-day one ends it, which is why it is worded as a record.
- **A month with no blanks** — every day of a whole month has an *answer*,
  whatever it said. A day you did it, a day you skipped and a day you recorded
  as missed all count; only a day you never touched does not. It is the one
  badge here that a bad month can earn, which is the point of it — and it is
  a reason to log the days that went badly. A month counts from its last day
  onwards, never before, so this never appears on the 3rd and vanishes on the
  4th.
- **A rest day inside a run** — a run of a week or more that held together
  across days you deliberately skipped. Only shown if you have skipped days
  switched on under ⚙, since that is what puts Skip on the grid in the first
  place.

They are **worked out from your entries each time, never stored.** That has one
consequence worth knowing, because it can surprise you: a badge is a reading of
the history *as it stands*, so editing your history can move one — including
downwards. Filling in a session you forgot to log changes what the earlier part
of the record looks like, and on a habit with a weekly or monthly goal that can
lower a streak badge as easily as raise it. Nothing is miscounted; you are
seeing a different history than you were.

The upside of the same design is that there is nothing extra in your backup and
nothing to keep in step: restore anywhere and the badges follow the entries.

There is nothing to switch on, and no card at all until a habit has something to
show. One case is deliberately quiet: an *at most* habit set to treat days you
never logged as kept gets no badges, because with almost nothing recorded they
would be claims you know to be untrue. Its charts and figures are unchanged.

---

## Reminders and notifications

A reminder has two halves, set in two places:

1. **When** — a time on the habit itself, on its edit screen. Pick it from the
   hour and minute dropdowns, or type it: `8:30`, `8:30 pm`, `830` and `8` all
   work, and become `08:30`. No time, no reminder. It is a wall-clock time —
   08:00 means eight in the morning, and stays there across a DST change.
2. **Where** — under ⚙ → **Notifications**, as a list of destinations. They are
   not exclusive; pick as many as you like.

<div align="center">
<img src="docs/screenshots/reminder-time.png" width="420"
     alt="The habit dialog's reminder field: an hour dropdown reading 07 (7 am), a minute dropdown reading 30, a box you can type into showing 07:30, a Clear button, one-tap presets for 07:00, 08:00, 12:00, 18:00 and 21:00, and below it the What the reminder asks field.">
&nbsp;&nbsp;
<img src="docs/screenshots/notifications.png" width="420"
     alt="Settings, Notifications section: checkboxes for the Android app and a Discord channel, fields for a Discord channel id and a webhook URL, a reminder timezone, and a Send a test notification button.">
<br><sub><b>When</b>, on the habit · <b>Where</b>, in settings</sub>
</div>

| Destination | Delivered by | Answer from it | Works offline | Needs |
|---|---|---|---|---|
| **Android app** | the phone, as a local alarm | Yes / No / a count, from the shade — or tap the notification itself to open the app on that habit | yes | the [native app](android-native/README.md) |
| **Discord (bot)** | your server | Yes / No / Skip buttons, and a box for an amount | no | a Discord application |
| **Discord (webhook)** | your server | nothing — text only | no | a webhook URL |
| **ntfy** | your server | nothing — it is notify-only, by design (see below) | no | a topic URL on a host whoever runs the instance allows |

Nothing is sent for a habit you have already recorded that day.

### What the reminder asks

Each habit has an optional **What the reminder asks** field. Left blank you get
the habit's name and a generated line; filled in, it leads:

> **Did you exercise today?**
> Meditate · Goal: at least 8 glasses.

For a measurable habit this is where it pays off — "How many cups of water did
you drink today?" is a question, where "Meditate / time to log this one" is a
form. The same text is used by the Android notification and the Discord message,
and it labels the amount box you type into.

<div align="center">
<img src="docs/screenshots/android-reminder.png" width="480"
     alt="An Android notification from habiterall reading 'Did you sit for ten minutes?' with 'Meditate' underneath and three actions: Yes, No, Skip.">
<br><sub>The same question, in the Android shade — answered without opening anything.</sub>
</div>

### Discord with buttons (recommended)

Buttons need a Discord **application**, because Discord only accepts them on a
message from one — a plain channel webhook is text-only, permanently.

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Bot** → **Reset Token** → copy it. Set it as `DISCORD_BOT_TOKEN` on the
   server (see [Configuration](#configuration)) and restart.
3. **Installation** (or OAuth2 → URL Generator) → scope `bot`, permission
   **Send Messages** → open the URL and add it to your server.
4. In Discord: **User Settings → Advanced → Developer Mode** on, then
   right-click the channel → **Copy Channel ID**.
5. Paste that into ⚙ → Notifications → **Discord channel id**, and press
   **Send a test notification**.

The test message carries the same buttons as a real reminder, and pressing one
answers "Nothing — this was a test message", so you can check the whole path
before waiting for 08:00.

Answering edits the reminder in place — the buttons disappear and the message
gains a **Recorded: Done** line — so the channel ends up as a log of what you
did rather than a pile of unanswered pings. A measurable habit's **Enter amount**
button opens a small box; `2,5` and `2.5` are both fine.

> **Anyone who can see the channel can press the buttons.** Use a private
> channel, or set **Your Discord user id** (right-click yourself → Copy User ID)
> and only your own clicks will count.

You can answer a reminder up to two days late; older than that and it asks you
to open the app, so a forgotten message cannot quietly rewrite last week.

### Discord without a bot

Paste a webhook URL instead: **Edit Channel → Integrations → Webhooks → New
Webhook → Copy Webhook URL**. You get the reminder text with no buttons, and
nothing to set up on the server. If both are configured, the bot wins.

Two settings that matter here:

- **Reminder timezone** — 08:00 on whose clock? The default is **Automatic —
  follow this device**: whichever browser or phone last used the account, sent
  on requests it was already making. That is right for almost everyone,
  including a traveller, whose reminders move with them. Two other answers are
  there when it is not: name a zone to pin reminders to it — the traveller who
  wants to stay on home time — or pick **Server's own clock**, which is what the
  default used to be and is the option to choose if you would rather no device
  reported anything.
- The webhook URL is checked against Discord's own hosts and rejected
  otherwise. That is deliberate: your server is what makes the request, so
  accepting any URL would turn this field into a way to make it fetch things on
  the private network it sits in.

### ntfy

[ntfy](https://ntfy.sh) is the destination that asks least of you: **no
account, no bot, and no inbound port.** Your server POSTs the reminder to a
topic, and your phone or desktop subscribes to that topic — which is the same
property that makes the Discord bot an outbound socket rather than a webhook
endpoint, arrived at from the other side. There is nothing to register and
nothing to forward, and it works against ntfy.sh or against an ntfy the
operator runs themselves.

Paste the topic URL into ⚙ → Notifications → **ntfy topic URL**, subscribe to
the same topic in the ntfy app, and press **Send a test notification**. A
protected topic also takes an **ntfy access token**; a public one needs none.

**You cannot choose the host freely, and that is the real difference from
pasting in a Discord webhook.** Your server is what makes the request, so
whoever runs the instance decides which ntfy hosts it may be aimed at
(`NTFY_ALLOWED_HOSTS` — see [Configuration](#configuration)); out of the box
that is ntfy.sh alone. A URL on any other host is refused and the field snaps
back to blank, so on a shared instance the host — and the base path, if the
ntfy sits behind a reverse proxy under one — is something to ask your operator
for. Everything after it is yours: the topic is the one part of the URL you
choose.

**There is nothing to press on an ntfy notification, deliberately.** ntfy can
carry action buttons, and answering with one would mean this server exposing an
HTTP endpoint that anything able to reach it could call — the inbound endpoint
the Discord integration goes to some length to avoid. So the reminder tells you
and the app is where you answer. If answering from the notification is what you
want, the Android app and the Discord bot both do it.

The server checks once a minute. A reminder the server slept through is still
sent if it is less than half an hour late, and dropped if it is more — waking
up after a day of downtime should not fire a day of reminders at once.

**When a destination stops working, ⚙ → Notifications says so.** A deleted
webhook, a bot kicked from its channel or a revoked token fails permanently and
is not retried, and nothing else about the habit changes to show it — so the
dialog carries the last outcome per destination and reports it in the sender's
own words, without your having to press anything. The test button is how you
confirm the fix.

> The Android app needs no server involvement at all — it arms its own alarms
> and fires them with the server unreachable. Unticking it there stops those
> alarms, which is the only thing that can.

---

## Install on a phone

Two options, in increasing order of effort:

| | What you get | Needs |
|---|---|---|
| **Add to Home Screen** | The full app, offline, no browser chrome | Nothing — HTTPS |
| **[Native app](android-native/README.md)** | **Notification actions** — answer Yes / No / a count from the shade — plus reminders that fire offline and a plain-http LAN address | Download the APK from [Releases](../../releases) |

The native client works against **either edition**. It asks the server how it
signs people in and shows whichever it reports: a username and password form for
the personal edition, your identity provider's own page — in the app's own
WebView, sharing one cookie store with the native API client — for cloud.

The native APK is attached to every [release](../../releases), signed — a
release that has no signing key fails rather than publishing an APK, because
Android refuses to install an unsigned one at all. Installing it still means
allowing *Install unknown apps* for whatever you download it with, which every
sideloaded app needs and is not a warning about this one.

<div align="center">
<img src="docs/screenshots/dashboard-mobile.png" width="300"
     alt="The web app at phone width: each habit is a card with its name, frequency, strength and streak, above a row of seven day squares.">
&nbsp;&nbsp;
<img src="docs/screenshots/android-list.png" width="300"
     alt="The native Android app: a Today list of four habits, each with its current streak and a reminder time or an Add reminder link, beside a scrolling row of day squares — checkmarks, amounts, and today outlined.">
<br><sub>The web app added to the home screen · the native app, which can answer from the shade</sub>
</div>

### Add to Home Screen

Open your instance in a mobile browser and choose **Add to Home Screen**. You
get an app icon, a full-screen launch with no browser chrome, offline access
to your dashboard, and check-offs that queue until you reconnect.

> Requires HTTPS. Browsers disable service workers (and therefore offline
> support) on plaintext origins other than `localhost`.

### The Android app

**[`android-native/`](android-native/README.md) — native Kotlin client.**
Exists for one reason the web cannot do: a reminder notification with **Yes /
No / count buttons in it**. Tap one and the entry is recorded without the app
ever coming to the foreground; if you are offline the write queues and retries.
Reminders are local alarms, so they fire whether or not the server is
reachable, and the reminder *times* live on the server so they follow your
account to a new phone.

The list itself is native: a row of days per habit — its current streak beside
the name, tappable squares back through a year of history, the whole grid
scrolling together and running whichever way your `dayOrder` setting says. It
carries the same search, behind an icon in the top bar rather than a permanent
row — the phone doesn't have a dashboard's room to spare — offered from the
first habit onward rather than six, with a near-identical fold of case and
accents, matching the description as well as the name, and filtering what is
already on screen so it works offline. Closing the field keeps a live filter
in place: the icon shows active and an "N of M" count stays visible until it's
cleared. Everything a web page does well —
charts, the calendar, history editing — opens the server's own UI inside the
app, so there is one implementation of the statistics rather than two, and
tapping a habit lands on *that* habit's page rather than the dashboard.

> Plain `http://` is accepted only for private addresses (`10.x`,
> `192.168.x`, `172.16–31.x`) so a LAN server works without a certificate;
> anything public must be `https://`.

---

## Coming from Loop Habit Tracker

Import a Loop backup and keep your history. Both editions accept:

| File | How to get it |
|---|---|
| **`.db` backup** | Loop → Settings → Export full backup |
| **CSV export** (`.zip`) | Loop → Settings → Export as CSV |
| A bare `Checkmarks.csv` | from that zip |

Use ⚙ → **Backup & Restore**, or, on an instance with sign-in off:

```bash
curl -X POST --data-binary @"Loop Habits Backup.db" localhost:3000/api/import
```

The conversion is verified against a real Loop export, not just their source:
timestamps are epoch-millisecond UTC midnights, entry values are scaled by
1000 while habit targets are not, `YES_AUTO` counts as done, and skips are
preserved. All four of Loop's day states survive — including `NO`, a day you told
Loop you had missed, which is kept apart from a day you never answered. Backups
predating Loop's `unit`, `target_type` or `notes` columns import fine.

Reminders come across too, in both directions. Loop's question becomes *What the
reminder asks*, in every format. The reminder **time** is `.db` only — Loop's own
`Habits.csv` has no columns for it — and only for a reminder Loop had set on
**all seven days**, since there is no weekday mask here to hold anything
narrower, and inventing a daily one would put a notification on your phone that
Loop never had.

Loop keeps its *preferences* in Android, not in the backup, so nothing in the
file can set yours — "Enable skip days" and "Show question marks" start off, as
they do in Loop, and are yours to switch on under ⚙.

**And back out again** — ⚙ → *Backup & Restore* → *Loop .db* writes a real Loop
database you can restore on Android. You are not locked in.

---

## Backup and restore

Two kinds, and they are for different things.

**A portable export** — for moving between editions, or leaving. Restore by
importing the file back: `?mode=merge` (the default) adds and merges by habit
name, `?mode=replace` clears first.

| What | Where |
|---|---|
| Full JSON backup (round-trippable) | ⚙ → Backup & Restore, or `GET /api/export` |
| CSV archive — `Habits.csv` + `Checkmarks.csv`, zipped | `GET /api/export.csv` |
| Loop-compatible `.db` | `GET /api/export-loop.db` |

The JSON backup carries your **settings** as well as your habits, and only a
`replace` applies them — that mode means "make this account look like the file",
while a merge is "add these habits to what I have" and leaves your preferences
alone. It matters more than it sounds: *Show question marks* decides how the very
rows in the same file are read.

**The whole database** — for disaster recovery, and the one to automate:

| | |
|---|---|
| personal | one file: `data/habiterall.db` from a clone, or the `habiterall-data` volume under Docker. Safely while running: `sqlite3 habiterall.db ".backup /tmp/backup.db"` |
| cloud | `docker compose exec -T db pg_dump -U habiterall_owner habiterall \| gzip > backup.sql.gz` |

> For the personal edition, copy **all three** files (`.db`, `.db-wal`,
> `.db-shm`) or use `.backup`. The database runs in WAL mode, so a plain copy of
> the `.db` alone can be missing recent writes — they are still in the
> write-ahead log.

Back up Authentik's database too, or you lose your user directory.

---

## Upgrading

```bash
docker compose pull && docker compose up -d
```

For the **personal** edition that is the whole story: a new binary against the
same file, and the schema migrates itself on start.

For the **cloud** edition, pin the image tag and bump it deliberately. It runs
migrations on deploy, so tracking `latest` means taking a schema change at a
moment you did not choose — and a migration is the one thing here that is not
trivially reversible. Take a dump first:

```bash
docker compose exec db pg_dump -U habiterall_owner habiterall > before-upgrade.sql
docker compose pull && docker compose up -d   # runs migrate, then the app
```

Migrations are numbered and recorded, so re-running is safe and applying twice
does nothing.

> **One upgrade moved numbers that were already on screen**, and this is where
> to look if a streak vanished. Until this release, a day with **no row at all**
> counted as a success on an *at most* habit — zero is under the limit, and an
> unanswered day held no value — so a limit nobody had ever logged reported an
> unbroken streak and a strength climbing toward 100%, both growing for as long
> as it was ignored. An unanswered day now counts as a **miss**. Every at-most
> habit you were keeping by saying nothing lost its streak and most of its
> strength the moment you upgraded, with nothing on the row to say why.
>
> Nothing was miscounted in either direction; the days simply stopped being
> credited to you for free. Days you had recorded as **0 are unaffected** —
> that is a stated "none today", and it counts as staying under the limit under
> either answer.
>
> If a habit really is "assume clean, record the exception", set **A day you
> never log** to *Counts as staying under* on that habit's edit screen, or
> change the account default under ⚙ → Tracking. Both are described in
> [In-app settings](#in-app-settings).
>
> One consequence of choosing that, so it does not read as a bug: **total done
> counts answers, while the streak and the strength count days.** The total is
> a count of rows and a day you never logged has none, so a limit kept by
> saying nothing shows a streak, a strength and a full history bar beside a
> total of zero. Both figures are right about their own question.

---

## Releases

Every [release](../../releases) carries **Docker images** for both editions on
GHCR, for `linux/amd64` and `linux/arm64`, the **native Android APK**, and notes
listing every commit since the previous tag. See
[Published images](#published-images) for the tag scheme.

A release is a decision, taken by pushing a tag; merging to `master` publishes
nothing. Signing and image pushing each skip themselves when their credentials
are absent, so a fork can cut a release having configured nothing. Details in
[`.github/workflows/README.md`](.github/workflows/README.md).

---

## Configuration

### personal

[`examples/docker-compose.personal.yml`](examples/docker-compose.personal.yml)
carries these in place and
[`examples/personal.env.example`](examples/personal.env.example) describes each
one, with a test failing if the server reads one neither mentions. The limits
and the six `LOG_*` settings ship **commented out** in the env template, since
tuning those is a considered change rather than a deployment step. Two are in
no file: `PORT`, because the port *inside* the container is fixed by the image
and the published mapping — `APP_PORT` is the host-side knob — and `NODE_ENV`,
which the image already sets.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HABITERALL_DB` | `./data/habiterall.db` | SQLite file path |
| `TZ` | the host's, **`UTC` in a container** | The fallback clock. Reminders follow the account's own zone and a check-off follows the caller's; this is what either falls back to — see [the reminder scheduler](#both-editions-the-reminder-scheduler) |
| `HABITERALL_AUTH` | on | Sign-in. Off only when set to **exactly** `off` |
| `HABITERALL_USERNAME` | `admin` | The single account |
| `HABITERALL_PASSWORD` | — | Its password. Set both before exposing the port, or the first visitor claims the instance. Nothing checks its length here — the 8-character minimum is on the in-app setup form only, so this is yours to get right |
| `HABITERALL_PASSWORD_HASH` | — | The same thing pre-hashed, to keep the plaintext out of `docker inspect`. Wins if both are set |
| `HABITERALL_SESSION_SECRET` | generated, stored in the database | Set it to keep people signed in across a redeploy |
| `TRUST_PROXY` | `0` | Reverse-proxy hops in front. See [Put HTTPS in front](#put-https-in-front) — wrong in either direction is a bug |
| `HABITERALL_RATE_LIMIT` | on | `off` removes the API limits. The one on *login attempts* is not included and cannot be switched off |
| `HABITERALL_UPGRADE_INSECURE` | off | `on` tells browsers to rewrite http to https. Only for an instance reached over TLS and nothing else |
| `HABITERALL_PUBLIC_URL` | — | This instance's address, so a Discord reminder can link back to it |
| `DISCORD_BOT_TOKEN` | — | Enables the interactive Discord mode (buttons). Without it, Discord reminders are webhook text |
| `NTFY_ALLOWED_HOSTS` | `ntfy.sh` | Where an ntfy topic URL may point. An entry is `host`, `host:port` or `host/base/path`, and a user's URL may add exactly one topic segment to it. Naming your own replaces the default; `off` refuses every URL. Your server makes the request, so this is the whole guard |
| `MAX_UPLOAD_MB` | `16` | Ceiling on a backup being restored |
| `BIND_ADDR` | empty | Which interface the published port appears on. Empty is every interface; `127.0.0.1` restricts it to a reverse proxy on this host. Not `0.0.0.0`, which is IPv4 only |
| `NODE_ENV` | `production` in both images | `production` turns on HSTS. See [Turning the guards off](#turning-the-guards-off) before unsetting it |
| `MAX_PARSE_HABITS` | `10000` | Habits a single uploaded file may declare. A bound on a hostile file, not a product limit — see [Limits on an import](#limits-on-an-import) |
| `MAX_PARSE_ENTRIES` | `250000` | Entries one file may declare, totalled across its habits |

To set `HABITERALL_PASSWORD_HASH` and keep the plaintext out of your compose
file and out of `docker inspect`:

```bash
docker run --rm ghcr.io/easymod0/habiterall-personal:latest node -e \
  "import('@habiterall/shared/password.js').then(m=>m.hashPassword(process.argv[1]).then(console.log))" \
  'your password'
```

### cloud

[`examples/cloud.env.example`](examples/cloud.env.example) is the whole list,
with a comment on each — the database and OIDC credentials, `TRUST_PROXY`,
`TZ`, `NOTIFY_MAX_ACCOUNTS`, `NTFY_ALLOWED_HOSTS` (which decides where a user
may point an ntfy topic URL, and matters more here than on a single-user box:
the person typing it is not you), the four import limits, and
`ALLOW_INSECURE_OIDC`, which is for local HTTP testing and never a real
deployment. It is the file both cloud compose files read, and a test fails if
the server grows a variable it does not mention.

The last block in it ships **commented out**, because tuning those is a
considered change rather than a deployment step: `MAX_PARSE_HABITS` and
`MAX_PARSE_ENTRIES` (see below), the six `LOG_*` settings, `PG_POOL_MAX` (10 —
what the `/healthz` memo is sized against) and `PGSSL`.

One variable is in no file at all: `PORT`, which is fixed inside the container
by the image and the published mapping. `APP_PORT` is the host-side knob.

### Limits on an import

`MAX_PARSE_HABITS` and `MAX_PARSE_ENTRIES` bound what a single uploaded file
may *declare*, before anything is built from it. They exist because the row
count of a SQLite file is a claim rather than a measurement: a few kilobytes
can assert millions of rows, and reading them all takes the process out of
service in a way no `try`/`catch` can answer.

They are not a product limit, and the defaults are far above any real account
— 10,000 habits is fifty times cloud's own per-account cap, and 250,000 entries
is roughly 68 habits answered every day since Loop shipped in 2016. They are
settable because the personal edition has no other cap on either, so a fixed
ceiling here would leave its importer refusing files its own API would happily
have created one habit at a time.

Raising them trades memory for generosity: a file sitting on both defaults
costs roughly 90MB to parse, and half a million entries alone costs 143MB.
### Published images

Every release publishes both editions to GitHub Container Registry, for
`linux/amd64` and `linux/arm64`:

```bash
docker pull ghcr.io/easymod0/habiterall-personal:latest
docker pull ghcr.io/easymod0/habiterall-cloud:latest
```

Tags are `X.Y.Z`, `X.Y` and `latest`, so a deployment can pin as tightly as it
likes — except below `1.0.0`, where the `X.Y` tag is dropped: a moving `1.4`
promises that anything it points at is compatible with anything else it does,
and 0.x carries no such guarantee. Docker Hub is published to as well when its
credentials are configured —
see [`.github/workflows/README.md`](.github/workflows/README.md).

### Both editions: the reminder scheduler

| Variable | Default | Purpose |
|---|---|---|
| `HABITERALL_NOTIFY` | `on` | `off` disables server-sent reminders entirely |
| `HABITERALL_NOTIFY_INTERVAL_MS` | `60000` | How often to check for due reminders |
| `DISCORD_BOT_TOKEN` | — | Turns on buttons. One bot per instance; each user points it at their own channel |
| `TZ` | the host's, **`UTC` in a container** | The fallback clock — for an account no client has reported from, and for a request that names no zone |

> **`TZ` is the fallback now, not the answer.** A reminder is sent on the
> account's own clock: the zone it named, else the zone its last browser or
> phone reported, else this. So `TZ` decides an account that has never opened a
> client — one restored from a backup, or driven only by Discord buttons — and
> nothing else about reminders.
>
> **It is the fallback for the calendar day too**, and no longer the answer to
> that either. Every route that asks *is this today?* now judges by the day it
> is for the client making the request: the guard that refuses a check-off in
> the future, the dashboard's row summary, and a habit's stats window. Both the
> browser and the Android app report their own zone in a header, and it rides
> on traffic they were already making — so this costs no extra request and
> needs no setting. Before it,
> a user east of a UTC container had the current column of their own grid
> refused as a future date for as many hours a day as the offset — thirteen of
> them in Auckland — and a day they *had* recorded was scored as of the
> server's yesterday, so ticking today left the streak sitting still. `TZ` is
> what a caller that reports no zone still gets, which is what every caller got
> before. Export filenames go on stamping the server's day, deliberately:
> nothing reads them back.
>
> This is not the same question as the one above, and folding the two together
> breaks whichever loses. The reminder clock asks where an **account** is, so
> that a reminder nobody is present for still goes out at the right hour — and
> its first tier is a zone you can name, which is how somebody abroad keeps
> reminders on home time. The calendar day asks what day it is for the **device
> making this request**, which is the clock the grid draws its last column
> from. Judging a tap against a named zone would re-break the write for exactly
> the person who set one.
>
> Worth knowing when upgrading: before this, `TZ` was what reminders used for
> every account that had not set the timezone setting, which was most of them.
> They now follow their own devices instead. If you deliberately relied on `TZ`
> for an account, choose **Server's own clock** in ⚙ → Notifications to keep it.

The scheduler costs nothing until someone configures a destination for it: with
none, it queries and stops. On-device reminders do not involve it at all.

The bot token is read from the environment rather than the settings dialog on
purpose: it can post to every channel the bot is in, so it is the operator's
credential, not a user's. With it set, the server also opens one outbound
WebSocket to Discord to receive button presses — **no inbound port, no public
hostname, and nothing to forward**, which is what makes this work on a home
network.

### Logs

One JSON object per line on stdout, which is what a pod's log collector reads.
On a TTY it switches to a readable `key=value` form instead, so a local run does
not look like a machine talking to itself.

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `LOG_FORMAT` | `pretty` on a TTY, else `json` | Override the choice |
| `LOG_REQUESTS` | `false` | A line for *every* request. Off, because the interesting ones are logged anyway |
| `LOG_SLOW_MS` | `1000` | Above this, a request is a warning |
| `LOG_RUNTIME_MS` | `60000` | How often to emit the `runtime` gauge |
| `LOG_LAG_WARN_MS` | `200` | Event-loop lag that warrants a warning |

Every line carries `t`, `level` and `msg`; a stack trace is a *field*, never
extra lines, so one event stays one log entry. **No personal data is logged** —
habit names, notes, entry values, email addresses and every credential-shaped
key are dropped, so what you get is `habit=7 user=3`.

The ones worth a dashboard or an alert:

| `msg` | Level | Why you care |
|---|---|---|
| `startup` | info | Everything this process resolved its configuration to, including `tz` **and** the zone that produced — the pair that reveals a container running on UTC |
| `runtime` | info | Once a minute: `loop_p99_ms`, RSS, and (cloud) `pg_waiting`. **Graph `loop_p99_ms`** |
| `runtime.loop_blocked` | warn | The event loop stalled. On a single-threaded server that is *everyone's* latency, and it is the signal to add a replica rather than tune a query |
| `http.error` | error | A 5xx, with the `X-Request-Id` the client was given, so a user's "it broke at 14:03" reaches a stack trace |
| `http.slow` | warn | Over `LOG_SLOW_MS` |
| `http.denied` / `http.rate_limited` | warn | A 401/403, or a limiter firing. Read from the response, so a new limiter cannot forget to report itself |
| `notify.starting` | info | `mode=bot` or `mode=webhook` — whether reminders can carry buttons at all |
| `notify.sent` | info | A reminder actually went, with the channel and how long it took |
| `notify.failed` | warn | It did not. `permanent=true` means it will not be retried, so this is the one to alert on |
| `notify.too_late` | warn | A reminder was **lost**: its minute passed while nothing was running and it will not be retried today. An outage, an overrunning tick, or a `TZ` the container never got. Said once per habit, channel and day |
| `notify.unreachable` | warn | A destination is switched on but cannot deliver — most often a Discord channel id on an instance with no `DISCORD_BOT_TOKEN`. Nothing else reports this: the settings dialog's test button only speaks for channels that *are* ready. Said once per process |
| `notify.tick` | info / debug | Per tick: sent, failed, and a count per reason nothing was sent. Debug when it had nothing to do |
| `notify.skip` | debug | **Why one habit was skipped**, with the clock it judged against |
| `notify.tick_slow` | warn | A tick is overrunning its interval, so the next one is skipped and the last accounts are starved |
| `export.rows_skipped` | warn | A backup left rows out rather than failing. `rows` names each one as `habit@date=reason` — `bad_date` is an entry filed under a day that does not exist, which no API here can write but an older import could. The export is otherwise complete, and the response carries the count in `X-Habiterall-Export-Skipped` |
| `auth.login` / `auth.suspended` | info / warn | Cloud: who signed in (id and issuer, never the subject or the email), and who was turned away |
| `pg.client_error` | error | Cloud: a pooled connection failed |

**When a reminder does not arrive, read the warnings first.** The two states
that used to be silent now name themselves at `warn`: `notify.unreachable` if
the destination could never have delivered, and `notify.too_late` if the
reminder was there and its minute went by unserved.

If neither appears, **set `LOG_LEVEL=debug` and wait a minute.** `notify.skip`
names the gate that dropped it — `not_yet`, `done_today`, `already_sent`,
`too_late`, `archived`, `no_reminder_time` — and prints the clock it compared
against. Those are in the order they are asked, which is why `already_sent`
rather than `too_late` is what a delivered reminder reports for the rest of the
day. `too_late` with a `zone` you did not expect is the `TZ` problem above.

### In-app settings

Under the ⚙ button: the theme, day order (today on the left or right), which day
the week starts on, how much of the dashboard and of a habit's page you want to
see, chart resolutions, whether deleting asks first, and where reminders are
sent. Preferences are stored server-side, so in the cloud edition they follow
your account between devices — and they travel in the JSON backup.

Two of them decide how much there is to look at:

| Setting | Default | What it does |
|---|---|---|
| **Day columns** (Dashboard) | Fit the screen | How many days the dashboard grid shows **at most** — 5, 7, 10, 14, or as many as fit. It is a maximum and never a minimum: a phone asked for a fortnight still draws a week, because fourteen columns on a narrow screen leave nothing for the habit's name. Choosing fewer on a phone is how you get five fat columns you can hit with a thumb |
| **Cards on a habit's page** (Statistics) | All of them, in this order | Which of the nine cards a habit's page draws, and in what order: the strength curve, the calendar, best streaks, bouncing back, awards, history, by day of week, weekday consistency and times per week. Each row has ▲ / ▼ buttons to move it up or down the list, alongside its tick. The four figures at the top are always shown, so unticking everything leaves a page rather than a blank one |

A card with nothing in it yet — bouncing back on a habit with no history, awards
on one that has not earned any — stays hidden whichever way this is set.

An account that saved this setting before ordering existed still records only
which cards were on, so a card added to habiterall after that save arrives
**off** rather than in its usual place. Opening ⚙ and pressing **Done** — even
with nothing else changed — rewrites it, after which a newly added card arrives
on, at its usual place in the order above. Nothing else does: no upgrade step
and no background write will do it for you.

Two of them are Loop's, with Loop's names and Loop's defaults (both **off**):

| Setting | What it does |
|---|---|
| **Enable skip days** | Adds *skip* to the tap cycle, for a day the habit does not apply — a rest day, or being ill. A skip leaves your score and streak untouched rather than breaking them. Off, a tap goes done → not done → done |
| **Show question marks for missing data** | Tells a day you marked as missed apart from a day you never answered, drawing the second as **?**. It also adds a fourth step to the tap cycle, so a tap can clear a day back to no data |

Switching skips off never touches skips you have already recorded — including
those imported from Loop — and "Unskip" stays available on those days.

Two more are worth spelling out. One has a third state people miss, and the
other decides what a day nobody answered is worth:

| Setting | Default | What it does |
|---|---|---|
| **Theme** (Dashboard) | Follow this device | *Follow this device*, *Light* or *Dark*. The ◐ / ☀ / ☾ button in the header cycles the same setting, and the glyph says which of the three it is on — the last step of the cycle is back to *Follow this device* from a value the device already matches, which is the same appearance by definition |
| **On an "at most" habit, a day you never logged** (Tracking) | Counts as a miss | Whether a day with **no row at all** counts as having stayed under the limit. Read for an at-most habit and nothing else |

That second one is the one place a *missing* answer is genuinely ambiguous. On
an at-least habit an unanswered day is short of the target and there is nothing
to ask; on a limit, zero is *under* the limit, so saying nothing could honestly
mean either thing. "I didn't smoke today" is worth a tap and is most of the
reward; "I had no soda" is not something anyone opens an app for, and recording
the exception is the whole point of tracking it. Both are ordinary, so it is a
setting rather than a rule.

Note what is **not** in question: a day you recorded as **0 is staying under the
limit either way**. That is you saying "none today", which is the thing being
asked for. Only the day nobody answered is in doubt.

The account's answer is what most habits follow. A habit's own **A day you never
log** field, on its edit screen beside the target, overrides it and ships set to
*Use the account setting* — including on every habit that existed before this
did, and on anything imported from Loop, whose backup carries no preferences at
all.

Both travel in habiterall's own JSON backup, and they have to: change what an
unanswered day is worth and the same rows in the same file give back a
different streak and a different strength. They come back by different routes,
though. The habit's field is part of the habit, so it restores on a merge as
well as a replace; the account setting is a *setting*, and only a **replace**
applies those — a merge deliberately leaves your preferences alone. Merge a
backup onto an account set the other way and the habits keep their own answers
while the account keeps its.

One more decides what a number you type *means*:

| Setting | Default | What it does |
|---|---|---|
| **Decimal separator** (Tracking) | Follow this device | Whether you write a decimal point as `1234.5` or `1234,5`, wherever an amount is typed. *Follow this device* reads it off the browser each time rather than storing what it found, so one account can be right on a laptop and on a phone — and choosing one explicitly is what to do when the device is not set up the way you write |

It matters because of what it makes `10.000` mean: ten, or ten thousand written
with a separator. Neither reading can be assumed for everybody, and getting it
wrong is not a display glitch — it is a stored number out by a factor of a
thousand, with nothing on screen to say so.

Whichever way it is set, a **thousands separator is refused rather than guessed
at**, and the message says what to type instead. `10,000` on a *point* account
and `10.000` on a *comma* one are one refusal seen from two sides. Anything with
fewer than three digits after the separator — `8,5`, `8.5` — is the same number
under both conventions and is accepted under both, which is most of what anyone
types. The box also *writes* amounts back the way you write them, so a field
that accepts `8,5` does not redraw it as `8.5`.

It travels in the JSON backup, because it decides what the next amount you type
will mean. The Android app does not read it yet — see issue #157, which has to
give that client a single reader for a typed amount before it can have one
answer.

---

## API

20 endpoints, identical in both editions. Dates are local calendar dates
(`YYYY-MM-DD`).

<details>
<summary><b>Full reference</b></summary>

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/habits` | List habits (`?archived=true` for the archive) |
| `POST` | `/habits` | Create |
| `GET` `PUT` `DELETE` | `/habits/:id` | Read, update, delete (cascades to entries) |
| `POST` | `/habits/reorder` | Reorder — `{ "order": [id, …] }` |
| `GET` | `/habits/:id/entries` | Every entry for a habit |
| `PUT` | `/habits/:id/entries/:date` | Record a value, a skip, or a note |
| `DELETE` | `/habits/:id/entries/:date` | Clear a day |
| `GET` | `/habits/:id/stats` | Full statistics (`?granularity=day\|week\|month\|quarter\|year`) |
| `GET` | `/overview` | Dashboard data in one call (`?days=N&end=YYYY-MM-DD`) |
| `GET` `PUT` `DELETE` | `/settings` | User preferences |
| `POST` | `/notify/test` | Send a test notification to each configured destination |
| `GET` | `/notify/status` | How each destination's last reminder went |
| `GET` | `/export`, `/export.csv`, `/export-loop.db` | Backups |
| `POST` | `/import` | Restore — body is the raw file (`?mode=merge\|replace`) |

Yes/no habits use Loop's encoding: `0` not done, `2` yes, `3` skip. Measurable
habits store the amount. Skips are held in a separate `status` field, because a
measurable habit may legitimately record the number 3.

**A row is an answer, and `DELETE` is how a day goes back to having none.**
`PUT {"value": 0}` records "not done" — a real answer, which is what makes
question marks meaningful — so clearing a day is the `DELETE` above, not a `PUT`
of zero. Four states in all: a row with `2` (done), a row with `status: "skip"`,
a row with `0` (not done), and no row (nothing known). On every habit but one
the last two are told apart by the display alone, and every statistic counts
both as a miss. The exception is an **at most** habit, where zero is under the
limit: there a row holding `0` is a success, and whether a day with no row is
one as well is what the *at most* setting in
[In-app settings](#in-app-settings) decides.

```bash
curl -X POST localhost:3000/api/habits -H 'Content-Type: application/json' \
  -d '{"name":"Meditate","type":"boolean","color":"#8b5cf6"}'

curl -X PUT localhost:3000/api/habits/1/entries/2026-08-12 \
  -H 'Content-Type: application/json' -d '{"value":2,"notes":"felt good"}'
```

Every endpoint in that table requires a session in both editions — the `curl`
examples above assume `HABITERALL_AUTH=off`, and otherwise want the session
cookie. In cloud each one is additionally scoped to your own data.

Outside that table: `GET /healthz` is unauthenticated in both, and `GET /api/me`
reports which sign-in mode this instance is in — `none`, `password`, `setup` or
`oidc`. A signed-out caller still gets that answer, because the `mode` rides the
**401** as well as the 200; it is the one thing a client with no session has to
know before it can draw anything. Sign-in itself differs: `POST /auth/login` and
`POST /auth/setup` in personal, `GET /auth/login` → `GET /auth/callback` in
cloud, with `POST /auth/logout` in both.
</details>

---

## Security

**Both editions.** Sign-in is in the app rather than in a reverse proxy, so the
Android client — which talks to `/api` outside the WebView and cannot fill in a
proxy's login form — gets a `401` it can act on instead of an HTML page. Both
issue the same **opaque session cookie**, `httpOnly` + `SameSite=Lax`, stored
server-side so it can be revoked instantly. `Secure` is decided **per request**
in personal, so one instance can serve https from outside and plain http on the
LAN; cloud derives it from its single `PUBLIC_URL`. Writes are
additionally refused when the `Origin` is another site's, a request with no
`Origin` being allowed through because that is the native client and not a
forgery a browser can make. The session is regenerated on login. One shared CSP
with no inline scripts; rate limits on login, the API and imports, and the
**limit on login attempts cannot be switched off**. **Imports cannot escape the
importer** — ids inside an uploaded backup are ignored entirely.

**Cloud, additionally.** Isolation is enforced by **Postgres row-level
security**, not by application code — a query that forgets its `WHERE` clause
returns nothing rather than leaking. The app connects as a role that is not the
table owner, cannot bypass RLS, cannot run DDL, and cannot create or delete
users. **No passwords are stored**: authentication is delegated to an OIDC
provider, which owns credentials, MFA and resets, users are keyed on
`(issuer, subject)`, tokens never reach the browser, and the flow carries PKCE,
state and a nonce.

All of it is verified adversarially: the test suite tries to read, modify and
delete another user's data, to smuggle rows in through a crafted backup, and to
walk past each auth mode in turn.

---

## Architecture

```
shared/               everything both editions have in common
  src/                scoring, validation, Loop import/export — no DB, no HTTP
  public/             the entire UI, plus the PWA
habiterall-personal/  single user, SQLite, optional password
habiterall-cloud/     multi user, Postgres, OIDC
android-native/       native Kotlin client, for notification actions
```

One npm workspace and **no build step** — what runs is what is on disk. Each
edition ships the same three-line entry point, calling `start()` with the one
auth adapter that asks the server which mode it is in; everything else is
shared, so a fix lands in both at once. The personal edition's database driver
is `node:sqlite`, built into Node, so there is no native module to compile.

The charts are hand-rolled SVG — no charting library, no bundler, no
`node_modules` in the browser.

---

## Development

```bash
npm test              # unit tests, all workspaces
npm run typecheck     # JSDoc types via tsc --noEmit (no build step)
npm run test:browser  # real-browser UI suites — needs Chrome; starts its own servers
npm run test:cloud    # cloud API + Loop round trip — needs Postgres
npm run test:roundtrip -w habiterall-personal   # backup fidelity, all formats
npm run test:tenancy  # multi-tenant isolation attacks — needs Postgres
```

Those are the layers worth knowing about; `CLAUDE.md` has the full table,
including the auth, sign-in, reminder and API-shape suites. Every one runs on
each pull request, alongside both Docker builds.

**The main suite needs no configuration** — fork it, push, and everything runs.
The only secrets anything needs are the four Android signing ones, and only to
*sign* a released APK; see
**[.github/workflows/README.md](.github/workflows/README.md)**.

The browser suites drive real Chrome and check things unit tests structurally
cannot — a CSS rule silently defeating the `hidden` attribute, offline
behaviour with the server stopped, and the layout at 360 / 390 / 768 / 1440px.

Contributor notes live in `CLAUDE.md` at the repo root and in each package;
they record the non-obvious decisions, each of which was paid for with a real
bug.

---

## License

[GNU General Public License v3.0 or later](LICENSE).

Use it, modify it, run it as a service — but derivative works must also be
GPLv3. Every runtime dependency is permissive (MIT / ISC / BSD-3-Clause) and
compatible.
