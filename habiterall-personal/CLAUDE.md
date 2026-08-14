# habiterall-personal — working notes

Single-user edition: SQLite, **no authentication by design**, intended for
your own machine or a LAN. If it needs to face the internet, use
`habiterall-cloud` rather than bolting auth onto this.

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
- `public/app-entry.js` — three lines: pick the no-auth adapter, `start()`

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

## Running

```bash
npm start                 # http://localhost:3000  (no login)
npm run seed              # sample data (refuses if habits already exist)
npm test                  # the CSS-guard test
npm run test:notify       # reminder delivery, and that a send is not repeated
npm run test:roundtrip    # export every format, re-import, assert no drift
docker compose up -d      # containerised
```

Your data is a single file at `data/habiterall.db` — back it up by copying it,
or use `GET /api/export`.
