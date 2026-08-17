# Verifying, cheaply

A review that only reads is worth less than one that measures one thing. Pick
the **one or two** claims whose failure would be worst and check those. Do not
run the full matrix.

## Mutation-test the tests

This is the highest-yield check in the repo, and the author was supposed to have
done it. When a PR adds a test for a fix, break the fix and confirm the test
fails.

```bash
cp path/to/file.js /tmp/x.bak          # NEVER `git checkout` to revert —
<edit the one line the fix changed>    # it takes uncommitted work with it
<run the one suite the PR names>       # expect FAIL
cp /tmp/x.bak path/to/file.js
```

Rules learned the hard way:

- Break **the specific line the suite is about**, not something adjacent.
- Confirm the module still **loads** after the mutation — a syntax error fails
  the suite for the wrong reason and reads as a pass of the check.
- For a browser suite, break the line that produces the rendered output, not the
  arithmetic behind it.
- If the test cannot be made to fail, it is either in the wrong harness (fake
  DOM vs real browser) or it should not exist. That is a HIGH finding when the
  PR claims otherwise.

## Which suite for which change

| change | command |
|---|---|
| anything | `npm test` and `npm run typecheck` (fast, no deps) |
| dates, labels, charts | `npm run test:locales` |
| a rendered surface | `npm run test:browser` (Chrome + server, see below) |
| reminders | `npm run test:notify` |
| import/export | `npm run test:roundtrip -w habiterall-personal` |
| `/overview` anchors | `npm run test:overview -w habiterall-personal` |
| auth, sessions | `npm run test:auth -w habiterall-personal`, `test:credchange` |
| RLS, `db/`, `apply-import.js` | `npm run test:tenancy`, `npm run test:cloud` (Postgres) |
| env vars, compose, README | `npm run docs:compose -- --check` |
| Kotlin | `cd android-native && ./gradlew testDebugUnitTest lintDebug` |

## Environment gotchas that make a green run a lie

- **A worktree has no `node_modules`**, so `@habiterall/shared` resolves *up* to
  the main checkout — on master. An edition-level suite run in a worktree may
  have tested code the PR did not change. Prove the linkage by breaking a file
  in the branch's `shared/` and seeing the suite notice.
- **Android worktrees have no `local.properties` and no Gradle wrapper.** A
  missing wrapper makes `./gradlew` exit 0 having measured nothing — count the
  files in `app/build/test-results/`.
- **Chrome for Testing is at `~/.local/chrome/chrome-linux64/chrome`.** Set no
  `CHROME_PATH`; never the Flatpak.
- **Browser suites need a server** started with `HABITERALL_AUTH=off
  HABITERALL_RATE_LIMIT=off`. Use a fresh port and a fresh DB under `/tmp` — a
  stale server holding the port answers with old code and looks like a missing
  column.
- **Killing that server**: `pkill -f .../server.js` matches its own shell (exit
  144) and swallows whatever was chained after it. Kill by PID and confirm with
  `ss -lptn` that nothing is still listening — `npm start` leaves a child bound.
- **The shell's cwd resets between calls.** Absolute paths.
- **Fixtures**: browser suites reset to `shared/test/browser/fixtures.mjs`. A
  "failure" is stale test data more often than it is the app.

## What proof to demand for a claim

| claim in the PR | what would actually show it |
|---|---|
| "the tests bite" | the mutation, named, with the suite that failed |
| "verified on the emulator" | what was tapped and what appeared — and a **screenshot**, not a `uiautomator dump`, for anything about what a user sees |
| "compose still resolves" | `docker compose config`, not reasoning about `extends` |
| "round-trips" | a fixture that *varies* the field, not one at its default |
| "no behaviour change" | which figure was computed before and after — a window that moved is a behaviour change |
| "mirrors X" | both test suites pinned to the **same examples** |

## When you cannot run it

Say so, in the report, naming the suite and why. A disclosed gap is a normal
outcome of a bounded review; a silent one is how a PR gets trusted for something
nobody checked.
