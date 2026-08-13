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

## Contents

- [Which edition do I want?](#which-edition-do-i-want)
- [Quick start](#quick-start) · [personal](#personal-edition) · [cloud](#cloud-edition)
- [Features](#features) · [Statistics](#statistics)
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

```bash
npm run start:personal
```

Open **<http://localhost:3000>**. That is the whole setup — no login, no
configuration. Optionally seed sample data first with
`npm run seed -w habiterall-personal`.

<details>
<summary><b>Or with Docker</b></summary>

```bash
cd habiterall-personal
docker compose up -d --build
```

Also **<http://localhost:3000>**. Your database lives in the `habiterall-data`
volume and survives rebuilds.
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

Full walkthrough, including HTTPS and the production checklist:
**[habiterall-cloud/SETUP.md](habiterall-cloud/SETUP.md)**.

> **Note**
> Put a TLS-terminating reverse proxy in front before exposing either edition.
> The cloud edition's session cookies are only marked `Secure` over HTTPS, and
> the offline features need a secure context.

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

**Works offline** — check off habits with no signal; they queue on the device
and sync, in order, when you reconnect.

**Light and dark**, following your system preference.

### Statistics

| View | What it shows |
|---|---|
| **Strength** | An exponential-decay score (30-day half-life) over your whole history |
| **Calendar** | A clickable year heatmap, shaded by completion or progress toward the target |
| **History** | Completions by day / week / month / quarter / year, as a percentage or a count |
| **Best streaks** | Your five longest runs, with the dates you achieved them |
| **By day of week** | Which days you reliably miss |
| **Times per week** | How many weeks each month hit 1×, 2×, 3× … |

Plus current streak, best streak, and total completions at a glance.

---

## Install on a phone

Open your instance in a mobile browser and choose **Add to Home Screen**. You
get an app icon, a full-screen launch with no browser chrome, offline access
to your dashboard, and check-offs that queue until you reconnect.

For a Play-Store-installable APK, see **[android/SETUP.md](android/SETUP.md)** —
it builds a Trusted Web Activity wrapping this same app, in GitHub Actions, with
no Android toolchain on your machine.

> Requires HTTPS. Browsers disable service workers (and therefore offline
> support) on plaintext origins other than `localhost`.

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
| Checkmarks as CSV | `GET /api/export.csv` |
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

## Configuration

### personal

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HABITERALL_DB` | `./data/habiterall.db` | SQLite file path |

### cloud

See [`.env.example`](habiterall-cloud/.env.example). Beyond the database and
OIDC credentials: `MAX_HABITS_PER_USER`, `MAX_ENTRIES_PER_IMPORT`,
`MAX_UPLOAD_MB`, and `PORT`.

### In-app settings

Under the ⚙ button: day order (today on the left or right), which day the week
starts on, and whether deleting asks first. Preferences are stored server-side,
so in the cloud edition they follow your account between devices.

---

## API

18 endpoints, identical in both editions. Dates are local calendar dates
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
android/              Trusted Web Activity wrapper
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
npm run test:tenancy  # multi-tenant isolation attacks — needs Postgres
```

Every one of these runs on each pull request, alongside both Docker builds.

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
