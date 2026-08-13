<div align="center">

# habiterall

**A self-hosted habit tracker with the statistics of [Loop Habit Tracker](https://github.com/iSoron/uhabits) — in your browser, on your server, with your data.**

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)

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
- [Features](#features) · [Statistics](#statistics) · [Bouncing back](#bouncing-back)
- [Reminders and notifications](#reminders-and-notifications)
- [Install on a phone](#install-on-a-phone)
- [Coming from Loop Habit Tracker](#coming-from-loop-habit-tracker)
- [Backup and restore](#backup-and-restore)
- [Configuration](#configuration) · [API](#api)
- [Security](#security-cloud-edition) · [Architecture](#architecture) · [Development](#development)

---

## Which edition do I want?

|  | **personal** | **cloud** |
|---|---|---|
| Users | one | many, each isolated |
| Login | none | any OIDC provider |
| Database | one SQLite file | Postgres |
| Setup | one command | Docker Compose + an identity provider |
| Runs on | `http://localhost:3000` | `http://localhost:3100` |
| Best for | your own machine, or a home LAN | a server other people log in to |

**Start with personal.** It has no moving parts, and a JSON backup imports
straight into cloud later if you outgrow it.

---

## Quick start

```bash
git clone <your-repo-url> habiterall
cd habiterall
npm install
```

Requires **Node 22.5+**. There is no build step — what runs is what is on disk.

### personal edition

The published image needs no clone and no build. Save this as
`docker-compose.yml` anywhere:

```yaml
services:
  habiterall:
    image: ghcr.io/easymod0/habiterall-personal:latest
    container_name: habiterall
    ports:
      - '3000:3000'
    volumes:
      # Your entire database is one file in here. Back it up by copying it.
      - habiterall-data:/data
    environment:
      HABITERALL_DB: /data/habiterall.db
      # Optional, and only for reminders the SERVER sends (a Discord channel).
      # The Android app needs neither of these — it arms its own alarms.
      HABITERALL_PUBLIC_URL: ''      # e.g. https://habits.example.com
      DISCORD_BOT_TOKEN: ''          # enables Yes / No / Skip buttons
    restart: unless-stopped

volumes:
  habiterall-data:
```

```bash
docker compose up -d
```

Open **<http://localhost:3000>**. That is the whole setup — no login, no
configuration.

That file is also in the repository as
[`examples/docker-compose.personal.yml`](examples/docker-compose.personal.yml)
(and the cloud one beside it), with a test that fails if it drifts from what is
printed here. To update:

```bash
docker compose pull && docker compose up -d
```

<details>
<summary><b>Or from a clone, with no Docker at all</b></summary>

```bash
npm install
npm run start:personal
```

Also **<http://localhost:3000>**, with the database at
`habiterall-personal/data/habiterall.db`. Optionally seed sample data first with
`npm run seed -w habiterall-personal`.
</details>

### cloud edition

```bash
cd habiterall-cloud
cp .env.example .env          # then fill in the secrets it lists
docker compose up -d db redis authentik-server authentik-worker

# create the OIDC client (waits for Authentik to finish booting)
export $(grep AUTHENTIK_BOOTSTRAP_TOKEN .env | xargs)
node scripts/bootstrap-authentik.mjs   # paste its output into .env

docker compose run --rm migrate
docker compose up -d app
```

| | |
|---|---|
| **The app** | **<http://localhost:3100>** |
| Authentik admin | <http://localhost:9000> (sign in as `akadmin`) |

Create users in Authentik under *Directory → Users*; a habiterall account is
provisioned the first time each one signs in.

**Already run an identity provider?** The stack above brings its own Authentik,
which is the quickest way to have *one*. If you already have Keycloak, Authelia,
Entra or Auth0, use
[`examples/docker-compose.cloud.yml`](examples/docker-compose.cloud.yml) instead
— the published image, Postgres, and nothing else.

<details>
<summary><b>Show that file</b></summary>



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
      - '3100:3000'
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
      TRUST_PROXY: 1
      DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN:-}
    restart: unless-stopped

volumes:
  db-data:
```

Register `${PUBLIC_URL}/auth/callback` as the redirect URI with your provider.
Users are provisioned the first time each one signs in.

> **Pin the tag here.** `latest` is fine for the personal edition, where an
> update is a new binary against the same file. The cloud edition runs
> migrations on deploy, so pulling `latest` means taking a schema change at a
> moment you did not choose. Use `:0.0.1` and bump it deliberately.
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

```caddyfile
habits.example.com {
	# Caddy gets and renews the certificate itself. Nothing else to configure.
	reverse_proxy localhost:3000
}
```

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
        # The cloud edition's rate limiter keys on the client address, so
        # without this every request appears to come from the proxy and one
        # user's traffic throttles everybody.
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

Whichever you use: with one proxy in front, leave `TRUST_PROXY=1` (the default).
Set it to the number of proxies if there are more, or `0` if the app is exposed
directly — getting this wrong either breaks the rate limiter's keying or lets a
client spoof its own address with a header.

---

## Features

**Two habit types** — yes/no checkmarks, and measurable habits with a target
and an *at least* / *at most* goal, so both "drink 8 glasses" and "at most 0
cigarettes" work.

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
Notifications: the Android app, a Discord channel, or both. In Discord you can
answer with a button without leaving the chat. See
[Reminders and notifications](#reminders-and-notifications).

**Works offline** — check off habits with no signal; they queue on the device
and sync, in order, when you reconnect. Reconnection is automatic, and does not
rely on the browser noticing: the app re-checks when you come back to the tab
and keeps probing while it is down, so restarting the server does not leave a
page stranded.

**Light and dark**, following your system preference — and a toggle for when it
disagrees with you.

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

> Shown for daily habits only. For a 3×/week habit an off-day is not a
> failure, so these figures would be measuring the wrong thing.

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
| **Android app** | the phone, as a local alarm | Yes / No / a count, from the shade | yes | the [native app](android-native/README.md) |
| **Discord (bot)** | your server | Yes / No / Skip buttons, and a box for an amount | no | a Discord application |
| **Discord (webhook)** | your server | nothing — text only | no | a webhook URL |

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

- **Reminder timezone** — 08:00 on whose clock? The default is the server's own
  timezone, which is what you want on a machine in your house. On a shared
  instance, or a VPS in another country, set your own.
- The webhook URL is checked against Discord's own hosts and rejected
  otherwise. That is deliberate: your server is what makes the request, so
  accepting any URL would turn this field into a way to make it fetch things on
  the private network it sits in.

The server checks once a minute. A reminder the server slept through is still
sent if it is less than half an hour late, and dropped if it is more — waking
up after a day of downtime should not fire a day of reminders at once. If a
webhook is deleted, delivery fails permanently and is not retried; the test
button is how you find out.

> The Android app needs no server involvement at all — it arms its own alarms
> and fires them with the server unreachable. Unticking it there stops those
> alarms, which is the only thing that can.

---

## Install on a phone

Three options, in increasing order of effort:

| | What you get | Needs |
|---|---|---|
| **Add to Home Screen** | The full app, offline, no browser chrome | Nothing — HTTPS |
| **[Native app](android-native/README.md)** | **Notification actions** — answer Yes / No / a count from the shade | Download the APK from [Releases](../../releases) |
| **[TWA wrapper](android/SETUP.md)** | The same PWA, as an installable APK | A public HTTPS host, then a workflow run |

The native APK is attached to every [release](../../releases). It is unsigned
unless the repository has signing secrets configured, so Android will ask you to
allow *Install unknown apps* for whatever you download it with — that is
expected, not a warning about the app.

<div align="center">
<img src="docs/screenshots/dashboard-mobile.png" width="300"
     alt="The web app at phone width: each habit is a card with its name, frequency, strength and streak, above a row of seven day squares.">
&nbsp;&nbsp;
<img src="docs/screenshots/android-list.png" width="300"
     alt="The native Android app: a Today list of four habits, each with its current state, a reminder time or an Add reminder link, and Yes / No buttons or an amount button.">
<br><sub>The web app added to the home screen · the native app, which can answer from the shade</sub>
</div>

### Add to Home Screen

Open your instance in a mobile browser and choose **Add to Home Screen**. You
get an app icon, a full-screen launch with no browser chrome, offline access
to your dashboard, and check-offs that queue until you reconnect.

> Requires HTTPS. Browsers disable service workers (and therefore offline
> support) on plaintext origins other than `localhost`.

### The two Android apps

They are different things, and which you want depends on one question: do you
want to record a habit **without opening anything**?

**[`android/`](android/SETUP.md) — Trusted Web Activity.** A thin native shell
around the PWA. Same UI, same code, installable as an APK, and it verifies
against your domain so no URL bar appears. Built by bubblewrap in GitHub
Actions, so nothing needs installing locally. Choose this if you just want an
app icon and a Play-Store-shaped package.

**[`android-native/`](android-native/README.md) — native Kotlin client.**
Exists for one reason the web cannot do: a reminder notification with **Yes /
No / count buttons in it**. Tap one and the entry is recorded without the app
ever coming to the foreground; if you are offline the write queues and retries.
Reminders are local alarms, so they fire whether or not the server is
reachable, and the reminder *times* live on the server so they follow your
account to a new phone.

Everything a web page does well — charts, the calendar, history editing —
opens the server's own UI inside the app, so there is one implementation of the
statistics rather than two. The habit list, quick check-offs and server
settings are native.

> The native app talks to the **personal** edition. The cloud edition needs an
> OIDC sign-in flow it does not implement yet.
>
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

Use the **Backup** button, or:

```bash
curl -X POST --data-binary @"Loop Habits Backup.db" localhost:3000/api/import
```

The conversion is verified against a real Loop export, not just their source:
timestamps are epoch-millisecond UTC midnights, entry values are scaled by
1000 while habit targets are not, `YES_AUTO` counts as done, and skips are
preserved. Backups predating Loop's `unit`, `target_type` or `notes` columns
import fine.

**And back out again** — *Backup → Loop .db* writes a real Loop database you
can restore on Android. You are not locked in.

---

## Backup and restore

| What | Where |
|---|---|
| Full JSON backup (round-trippable) | `GET /api/export` |
| CSV archive — `Habits.csv` + `Checkmarks.csv`, zipped | `GET /api/export.csv` |
| Loop-compatible `.db` | `GET /api/export-loop.db` |

Restore by importing the file back. `?mode=merge` (default) adds and merges by
habit name; `?mode=replace` clears first.

The personal edition's database is a single file — copying `data/habiterall.db`
is a complete backup. For cloud:

```bash
docker compose exec -T db pg_dump -U habiterall_owner habiterall | gzip > backup.sql.gz
```

Back up Authentik's database too, or you lose your user directory.

---

## Upgrading, and getting your data out

### Upgrading

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

### Backups

Two kinds, and they are for different things.

**The whole database** — for disaster recovery, and the one to automate:

| | |
|---|---|
| personal | `cp /var/lib/docker/volumes/…/habiterall.db` — or, safely while running: `sqlite3 habiterall.db ".backup /tmp/backup.db"` |
| cloud | `pg_dump -U habiterall_owner habiterall` |

> For the personal edition, copy **all three** files (`.db`, `.db-wal`,
> `.db-shm`) or use `.backup`. The database runs in WAL mode, so a plain copy of
> the `.db` alone can be missing recent writes — they are still in the
> write-ahead log.

**A portable export** — for moving between editions, or leaving:
`GET /api/export` (or ⚙ → Backup) writes a JSON file that imports into either
edition, and into a fresh install of anything you replace this with. See
[Backup and restore](#backup-and-restore).

---

## Releases

Versions are tagged, and a tag is what publishes:

```bash
git tag v1.4.0 && git push origin v1.4.0
```

Every [release](../../releases) carries:

- **Docker images** for both editions on GHCR, tagged `1.4.0`, `1.4` and
  `latest`, for `linux/amd64` and `linux/arm64`;
- **the native Android APK**, attached to the release;
- **notes** listing every commit since the previous tag, grouped by kind.

Merging to `master` publishes nothing — it runs the tests and stops. A release is
a decision, taken by tagging. The Android `versionCode` is derived from the
version (`1.4.0` → `10400`), so it always increases; and signing, image pushing
and the TWA build each skip themselves when their credentials are absent, so a
fork can cut a release having configured nothing. Details in
[`.github/workflows/README.md`](.github/workflows/README.md).

---

## Configuration

### personal

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HABITERALL_DB` | `./data/habiterall.db` | SQLite file path |
| `HABITERALL_PUBLIC_URL` | — | This instance's address, so a Discord reminder can link back to it |
| `DISCORD_BOT_TOKEN` | — | Enables the interactive Discord mode (buttons). Without it, Discord reminders are webhook text |

### cloud

See [`.env.example`](habiterall-cloud/.env.example). Beyond the database and
OIDC credentials: `MAX_HABITS_PER_USER`, `MAX_ENTRIES_PER_IMPORT`,
`MAX_UPLOAD_MB`, and `PORT`.

### Published images

Every release publishes both editions to GitHub Container Registry, for
`linux/amd64` and `linux/arm64`:

```bash
docker pull ghcr.io/easymod0/habiterall-personal:latest
docker pull ghcr.io/easymod0/habiterall-cloud:latest
```

Tags are `X.Y.Z`, `X.Y` and `latest`, so a deployment can pin as tightly as it
likes. Docker Hub is published to as well when its credentials are configured —
see [`.github/workflows/README.md`](.github/workflows/README.md).

### Both editions: the reminder scheduler

| Variable | Default | Purpose |
|---|---|---|
| `HABITERALL_NOTIFY` | `on` | `off` disables server-sent reminders entirely |
| `HABITERALL_NOTIFY_INTERVAL_MS` | `60000` | How often to check for due reminders |
| `DISCORD_BOT_TOKEN` | — | Turns on buttons. One bot per instance; each user points it at their own channel |

The scheduler costs nothing until someone configures a destination for it: with
none, it queries and stops. On-device reminders do not involve it at all.

The bot token is read from the environment rather than the settings dialog on
purpose: it can post to every channel the bot is in, so it is the operator's
credential, not a user's. With it set, the server also opens one outbound
WebSocket to Discord to receive button presses — **no inbound port, no public
hostname, and nothing to forward**, which is what makes this work on a home
network.

### In-app settings

Under the ⚙ button: day order (today on the left or right), which day the week
starts on, chart resolutions, whether deleting asks first, and where reminders
are sent. Preferences are stored server-side, so in the cloud edition they
follow your account between devices.

---

## API

19 endpoints, identical in both editions. Dates are local calendar dates
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
| `GET` | `/export`, `/export.csv`, `/export-loop.db` | Backups |
| `POST` | `/import` | Restore — body is the raw file (`?mode=merge\|replace`) |

Yes/no habits use Loop's encoding: `0` unset, `2` yes, `3` skip. Measurable
habits store the amount. Skips are held in a separate `status` field, because a
measurable habit may legitimately record the number 3.

```bash
curl -X POST localhost:3000/api/habits -H 'Content-Type: application/json' \
  -d '{"name":"Meditate","type":"boolean","color":"#8b5cf6"}'

curl -X PUT localhost:3000/api/habits/1/entries/2026-08-12 \
  -H 'Content-Type: application/json' -d '{"value":2,"notes":"felt good"}'
```

In the cloud edition every endpoint requires a session and is scoped to your
own data.
</details>

---

## Security (cloud edition)

Isolation is enforced by **Postgres row-level security**, not by application
code — a query that forgets its `WHERE` clause returns nothing rather than
leaking. The app connects as a role that is not the table owner, cannot bypass
RLS, cannot run DDL, and cannot create or delete users.

- **No passwords stored.** Authentication is delegated to an OIDC provider,
  which owns credentials, MFA and resets. Users are keyed on `(issuer, subject)`.
- **Opaque session cookies**, `httpOnly` + `Secure` + `SameSite=Lax`, stored
  server-side so they can be revoked instantly. Tokens never reach the browser.
- **Imports cannot escape the importer** — ids inside an uploaded backup are
  ignored entirely.
- Session regeneration on login, PKCE + state + nonce on the OIDC flow, a CSP
  with no inline scripts, and rate limits on login, API and import.

All of it is verified adversarially: the test suite tries to read, modify and
delete another user's data, and to smuggle rows in through a crafted backup.

---

## Architecture

```
shared/               everything both editions have in common
  src/                scoring, validation, Loop import/export — no DB, no HTTP
  public/             the entire UI, plus the PWA
habiterall-personal/  single user, SQLite, no auth
habiterall-cloud/     multi user, Postgres, OIDC
android/              Trusted Web Activity wrapper for the PWA
android-native/       native Kotlin client, for notification actions
```

One npm workspace, **no build step**, and one runtime dependency for the
personal edition (Express). Each edition ships a three-line entry point that
picks an auth adapter; everything else is shared, so a fix lands in both at
once.

The charts are hand-rolled SVG — no charting library, no bundler, no
`node_modules` in the browser.

---

## Development

```bash
npm test              # unit tests, all workspaces
npm run typecheck     # JSDoc types via tsc --noEmit (no build step)
npm run test:browser  # real-browser UI suites — needs Chrome + a running server
npm run test:cloud    # cloud API + Loop round trip — needs Postgres
npm run test:roundtrip -w habiterall-personal   # backup fidelity, all formats
npm run test:tenancy  # multi-tenant isolation attacks — needs Postgres
```

Every one of these runs on each pull request, alongside both Docker builds and
a backup round-trip check that exports every format, re-imports it, and asserts
nothing changed.

**The main suite needs no configuration** — fork it, push, and everything runs.
Only the two Android release workflows need secrets, and only to *sign* an APK;
see **[.github/workflows/README.md](.github/workflows/README.md)**.

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
GPLv3. All dependencies are permissive (MIT / ISC / BSD-3-Clause) and
compatible.
