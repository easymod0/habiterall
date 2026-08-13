# habiterall

A self-hosted web habit tracker with the statistics of [Loop Habit Tracker](https://github.com/iSoron/uhabits), backed by SQLite and packaged as a Docker image.

Single user, no login — intended for a home server, NAS, or LAN machine.

## Quick start

### Docker (recommended)

```bash
docker compose up -d --build
```

Open <http://localhost:3000>. The database lives in the `habiterall-data` named volume and survives rebuilds.

### Local

```bash
npm install
npm start          # http://localhost:3000
npm run seed       # optional: 5 habits with 180 days of sample history
npm test
```

Requires Node 22.5+ (uses the built-in `node:sqlite`, so there is no native module to compile).

## Features

**Habit types**
- **Yes/No** — a checkmark per day. Clicking cycles unset → done → skip → unset.
- **Measurable** — a number per day with a target and an *at least* / *at most* goal, so both "drink 8 glasses" and "at most 0 cigarettes" work.

**Frequency** — any *n* times per *m* days: daily, 3×/week, 1×/month, and so on. The score measures adherence over a trailing window the length of the frequency period, so a habit held at exactly its target converges to full strength at *any* frequency, and a single completion can never saturate it.

**Editing history** — open a habit and click any day in the calendar to fix it. Use **‹ Earlier** / **Later ›** to page back through months. The calendar is fully keyboard-navigable: Tab into it once, then ↑ / ↓ move by day, ← / → by week, PageUp / PageDown by four weeks, Home / End to the ends of a week, and Enter to edit the focused day. The editor matches the habit type: yes/no habits get *Done* / *Not done*, measurable habits get an amount field showing the unit and target. Any day can also be skipped, unskipped, or cleared. Future dates are not editable.

**Reordering** — drag a habit by its ⠿ handle, or focus the handle and press ↑ / ↓. The order saves automatically and reverts if the save fails.

**Undo** — deleting a habit offers an Undo for nine seconds, restoring the habit along with its full history and notes.

**Notes** — attach a note to any day from the calendar editor ("was ill", "short on time"). Notes survive export and import, and a note can be kept on a day you *didn't* do the habit.

**Archive** — retiring a habit hides it from the dashboard without deleting its history. Tick *Archived* when editing a habit; use **Show archived** on the dashboard to browse or restore them.

**Skips** — a skipped day is neither a success nor a failure. It bridges streaks rather than breaking them, and freezes the score instead of decaying it. Use it for illness or travel.

**Backup & migration** — export to JSON or CSV, re-import to restore, and import directly from Loop Habit Tracker's `.db` backup or CSV export. See [Backup, restore, and importing from Loop](#backup-restore-and-importing-from-loop).

### Statistics

| View | What it shows |
| --- | --- |
| **Strength** | Loop's exponential-decay score over trailing-window adherence, at whatever resolution you pick |
| **Calendar** | Clickable heatmap with streaks joined up — zoom, page back, correct any past day |
| **History** | Completions by day / week / month / quarter / year, as a percentage or a raw count |
| **Bouncing back** | Recovery rate, how long lapses last, and how far streaks usually get |
| **By day of week** | Success rate per weekday — shows which days you reliably miss |
| **Weekday consistency** | The same broken out by month, so a weekday that is slipping is visible |
| **Times per week** | Loop's frequency chart: how many weeks each month had 1×, 2×, 3× … completions |

Plus current streak, best streak, and total completions.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HABITERALL_DB` | `./data/habiterall.db` (`/data/habiterall.db` in Docker) | SQLite file path |

## API

All endpoints are under `/api`. Dates are local calendar dates, `YYYY-MM-DD`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/habits` | List habits (`?archived=true` for archived) |
| `POST` | `/habits` | Create a habit |
| `GET`/`PUT`/`DELETE` | `/habits/:id` | Read, update, delete (delete cascades to entries) |
| `POST` | `/habits/reorder` | Reorder, body `{ "order": [id, ...] }` |
| `GET` | `/habits/:id/entries` | All entries for a habit |
| `PUT` | `/habits/:id/entries/:date` | Record a value |
| `DELETE` | `/habits/:id/entries/:date` | Clear a day |
| `GET` | `/habits/:id/stats` | Full statistics (`?granularity=day\|week\|month\|quarter\|year`) |
| `GET` | `/overview` | All habits + recent entries + summary stats in one call (`?days=N`, `?archived=true`) |
| `GET` | `/export` | Everything as JSON, for backup (`?download=true` for a file) |
| `GET` | `/export.csv` | Zip of `Habits.csv` + `Checkmarks.csv`, Loop-shaped |
| `GET` | `/export-loop.db` | A Loop Habit Tracker `.db` backup |
| `POST` | `/import` | Import a backup; body is the raw file (`?mode=merge\|replace`) |

Entry values for Yes/No habits use Loop's encoding: `0` unset, `2` yes, `3` skip. Measurable habits store the raw amount.

Skips are held in a separate `status` field rather than in `value`, because a measurable habit may legitimately record the number 3. To skip a day on any habit type, send `{"status":"skip"}`; responses carry `status` alongside `value`. Databases created before this change are migrated automatically on first start.

```bash
# create a habit and check it off today
curl -X POST localhost:3000/api/habits -H 'Content-Type: application/json' \
  -d '{"name":"Meditate","type":"boolean","color":"#8b5cf6"}'

curl -X PUT localhost:3000/api/habits/1/entries/2026-08-12 \
  -H 'Content-Type: application/json' -d '{"value":2}'
```

## Backup, restore, and importing from Loop

Click **Backup** in the top bar for the full UI, or use the API directly.

### Export

| What | Where |
| --- | --- |
| Full JSON backup (everything, round-trippable) | `GET /api/export` |
| CSV archive, Loop-shaped (zip of `Habits.csv` + `Checkmarks.csv`) | `GET /api/export.csv` |
| **Loop Habit Tracker `.db` backup** | `GET /api/export-loop.db` |

The Loop `.db` export writes a genuine SQLite database in Loop's own schema, so it can be restored on Android via **Loop → Settings → Import data**. It is the exact inverse of the importer: timestamps become UTC-midnight epoch millis, numerical values and targets are scaled by 1000, skips become the `SKIP` sentinel, and colours are mapped back to the nearest Loop palette index.

```bash
curl -o backup.json localhost:3000/api/export
```

### Import

`POST /api/import` takes the **raw file as the request body**. The format is detected from the file's contents, so no `type` parameter is needed:

| File | Detected by |
| --- | --- |
| habiterall JSON backup | leading `{` or `[` |
| **Loop `.db` backup** | `SQLite format 3` header + `Habits`/`Repetitions` tables |
| **Loop CSV export (.zip)** | `PK` header; reads `Habits.csv` + `Checkmarks.csv` |
| A bare `Checkmarks.csv` | leading `Date,` column |

```bash
# restore your own backup
curl -X POST --data-binary @backup.json localhost:3000/api/import

# migrate from Loop Habit Tracker
curl -X POST --data-binary @Loop\ Habits\ Backup.db localhost:3000/api/import
curl -X POST --data-binary @Loop\ Habits\ CSV.zip  localhost:3000/api/import
```

**Modes** — `?mode=merge` (default) adds new habits and, for a name that already exists, merges entries into it. `?mode=replace` deletes all existing habits and history first.

The response reports what happened:

```json
{ "mode": "merge", "habitsCreated": 3, "habitsMerged": 1,
  "entriesImported": 412, "skipped": [] }
```

### How Loop data is translated

Verified against [iSoron/uhabits](https://github.com/iSoron/uhabits) `dev`:

- **Timestamps** are epoch milliseconds aligned to UTC midnight, and are read back with UTC getters so dates don't shift by a day in a non-UTC timezone.
- **Entry values** — `YES_MANUAL(2)` and `YES_AUTO(1)` both become "done"; `SKIP(3)` stays a skip; `NO(0)` and `UNKNOWN(-1)` are dropped, since habiterall stores "not done" as the absence of a row.
- **Numerical values and targets** are divided by 1000 (Loop stores 7.5 as `7500`).
- **Colors** are a palette index in Loop, mapped onto an equivalent hex palette.
- Backups predating the `unit`, `target_type`, or `notes` columns import fine — missing columns fall back to defaults.

### Backing up the raw file

The whole database is one file:

```bash
docker run --rm -v habiterall_habiterall-data:/data -v "$PWD:/backup" \
  alpine cp /data/habiterall.db /backup/habiterall-backup.db
```

## Project layout

```
src/db.js       schema + connection
src/stats.js    scoring, streaks, aggregation  (all the interesting math)
src/import.js   habiterall JSON + Loop .db/CSV importers
src/export-loop.js  writes a Loop-compatible .db backup
src/unzip.js    minimal ZIP reader for Loop's CSV export
src/api.js      REST routes + validation
src/server.js   express app
public/         frontend — plain ES modules, no build step
  charts.js     hand-rolled SVG charts (no chart library)
test/           node:test suite for the stats engine
```

## Notes

- There is no authentication. Do not expose this directly to the internet — put it behind a reverse proxy with auth, or keep it on your LAN.
- Entries cannot be recorded for future dates.
- Charts are inline SVG drawn by hand, so the app has one runtime dependency (Express) and no frontend build step.

## License

MIT
