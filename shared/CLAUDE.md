# shared — working notes

Everything both editions have in common. **Nothing here may import a
database, an HTTP framework, or edition-specific code.** That constraint is
what lets the same file serve a single-user SQLite app and a multi-tenant
Postgres one.

## Modules

| file | what it owns |
|---|---|
| `src/stats.js` | scoring, streaks, history/weekday/frequency aggregation |
| `src/validate.js` | every input rule for habits, entries, and dates |
| `src/import.js` | parsers: habiterall JSON, Loop `.db`, Loop CSV |
| `src/export-loop.js` | writes a Loop-compatible `.db` |
| `src/unzip.js` | minimal ZIP reader (Loop's CSV export) |
| `src/constants.js` | `UNSET` / `YES` / `SKIP` wire values |
| `public/app.js` | the whole UI; `start(authAdapter)` is the entry |
| `public/auth-none.js`, `auth-oidc.js` | the two auth adapters |
| `public/charts.js` | hand-rolled SVG charts |
| `public/sw.js`, `offline.js` | PWA shell cache and the write outbox |

Parsers return plain data; the *writing* is per edition (`apply-import.js`),
because one talks to SQLite and the other to Postgres under row-level
security.

## Traps

**`dateRange` vs `boundedRange`.** Use `boundedRange` whenever the start date
comes from stored data. `dateRange` is unbounded and a distant-past entry
turns one request into ~700,000 iterations on a single-threaded server. Every
aggregation in `stats.js` already uses the bounded form; keep it that way.

**`isCompleted` / `dayCredit` take `{value, status}`.** Passing a bare number
still works for boolean habits (where `3` is unambiguously a skip) but is
wrong for numerical ones, where `3` is a real amount.

**The score formula is deliberate.** It feeds a trailing-window adherence
ratio (always `[0,1]`) into an EWMA. Do not "simplify" it back to scaling a
day's credit by `1/frequency` — that overshoots for every non-daily habit and
lets one completion saturate the score.

**Loop's encoding is not guessable.** It was read from the uhabits source:
epoch-millis UTC-midnight timestamps, ×1000 numerical scaling, `YES_AUTO(1)`
counts as done, `NO(0)`/`UNKNOWN(-1)` are dropped. `test/import.test.js` and
`test/export-loop.test.js` pin all of it — if you change a conversion and
those fail, the tests are right.

**The UI is auth-agnostic.** `app.js` never mentions sign-in; it calls the
injected adapter (`load` / `render` / `signOut` / `onUnauthorized`). Adding an
`if (cloud)` branch here is how the frontends drifted apart the first time.

## Tests

```bash
npm test              # unit — fast, no dependencies
npm run test:browser  # real Chrome against a running server
```

`test/browser/` is not optional decoration: a CSS `display` rule silently
defeating the `hidden` attribute shipped once, and no unit test could have
seen it. `fixtures.mjs` resets known data before each suite.
