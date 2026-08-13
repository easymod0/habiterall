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
- `public/app-entry.js` — three lines: pick the no-auth adapter, `start()`

The entire UI is in `shared/public/` and served by the static mounts in
`src/server.js`. Do not copy `app.js`, `style.css`, or `index.html` back here.

## Why `node:sqlite`

Built into Node 22, so there is no native module to compile, no rebuild on
Node upgrades, and the Docker image builds in about a second with one runtime
dependency. `DatabaseSync` is synchronous — fine for one user, and precisely
why the cloud edition uses Postgres instead.

## Traps

**Booleans are 0/1.** SQLite has no boolean type, so `archived` is mapped at
the call site (`habitRow()`); the shared validator returns a real boolean.

**Skips are `status = 'skip'`, never the value 3.** `db.js` migrates older
databases automatically: boolean `3`s become skips, numerical `3`s are left
alone as real amounts, because only the former is unambiguous.

**`/overview` is bounded.** It reads lifetime entries for the streak figures,
so the clamp inside `computeStreaks` is what keeps a distant-past entry from
blocking the process. Don't reintroduce an unbounded range here.

## Running

```bash
npm start                 # http://localhost:3000  (no login)
npm run seed              # sample data (refuses if habits already exist)
npm test                  # the CSS-guard test
docker compose up -d      # containerised
```

Your data is a single file at `data/habiterall.db` — back it up by copying it,
or use `GET /api/export`.
