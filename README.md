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
- [Features](#features) · [Statistics](#statistics) · [Bouncing back](#bouncing-back)
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
and sync, in order, when you reconnect. Reconnection is automatic, and does not
rely on the browser noticing: the app re-checks when you come back to the tab
and keeps probing while it is down, so restarting the server does not leave a
page stranded.

**Light and dark**, following your system preference.

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

> Shown for daily habits only. For a 3×/week habit an off-day is not a
> failure, so these figures would be measuring the wrong thing.

---

## Install on a phone

Three options, in increasing order of effort:

| | What you get | Needs |
|---|---|---|
| **Add to Home Screen** | The full app, offline, no browser chrome | Nothing — HTTPS |
| **[TWA wrapper](android/SETUP.md)** | The same, as an installable APK | A GitHub Action run |
| **[Native app](android-native/README.md)** | **Notification actions** — answer from the shade | A GitHub Action run |

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
