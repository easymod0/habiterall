# Merge plan — overnight agent run

Canonical copy, kept online: https://github.com/easymod0/habiterall/issues/90
(tick the checkboxes there as you merge)

Durable record of the overnight agent run. Everything below was verified by
re-running it in the main checkout against the actual branch — not taken from
any agent's self-report.

## Merge order

Conflict-free in this order. Tick as you go.

- [ ] **#81** `fix/loop-timestamp-year-boundaries` — #80 items 9, 10
- [ ] **#82** `fix/roundtrip-asserts-what-the-db-actually-carries` — #80 item 14
- [ ] **#83** `fix/csv-archive-round-trips-every-habit` — #80 items 11, 12
- [ ] **#84** `fix/import-repairs-what-it-claims-to` — #80 items 2, 4
- [ ] **#85** `fix/apply-import-honours-the-api-rules` — #80 items 1, 3, 5, 6
- [ ] **#86** `fix/import-row-ceiling` — **closes #79**
- [ ] **#88** `fix/loop-export-survives-a-colliding-date` — #80 item 8
- [ ] **#89** `fix/export-papercuts` — #80 low-impact set ⚠️ **one conflict, see below**

Order is not load-bearing except that **#83 and #89 conflict with each other**,
so whichever lands second needs the resolution below. The other six are clean in
any order.

### The one conflict — #89 vs #83

`shared/test/export-csv.test.js`, a single import line. Both add a name to it.
Keep both:

```js
  buildHabitsCsv, buildCheckmarksCsv, buildCsvArchive, esc, uniqueNames, csvNumber,
```

That is the whole resolution. I applied it locally and the combined tree is green.

### If you only merge one thing

**#86.** It is the security fix — an 8 KB upload currently kills the process,
and the OOM is uncatchable so the existing `try/catch` cannot turn it into a 400.

## Post-merge verification

Cloud suites need Postgres:

```bash
docker run -d --name pg --rm -e POSTGRES_USER=owner -e POSTGRES_PASSWORD=testpw \
  -e POSTGRES_DB=habiterall -p 55440:5432 postgres:17-alpine
cd habiterall-cloud && DATABASE_URL_ADMIN=postgres://owner:testpw@localhost:55440/habiterall \
  APP_DB_PASSWORD=apptestpw node src/db/migrate.js && cd ..

export DATABASE_URL=postgres://habiterall_app:apptestpw@localhost:55440/habiterall
export ADMIN_URL=postgres://owner:testpw@localhost:55440/habiterall

npm test                                     # expect 483 + 14, 0 fail
npm run typecheck
npm run test:roundtrip -w habiterall-personal
npm run test:exportloop -w habiterall-personal   # new suite, added by #88
npm run test:roundtrip -w habiterall-cloud
npm run test:cloud
node habiterall-cloud/test/tenancy.integration.mjs
npm run test:notify
npm run test:auth -w habiterall-personal
npm run test:overview -w habiterall-personal
npm run docs:compose -- --check

docker rm -f pg
```

All of the above passed for me on the fully-merged tree with the conflict resolved.
`npm run test:browser` was **not** run for any PR — no UI surface was touched.

## Worth reading before you approve

**#85** — items 5 and 6 could not be fixed separately. On a merge the *account's*
type decides what may be **stored**, but the *file's* type decides how a value was
**encoded** (a `3` is a skip sentinel in a boolean column and three-of-something in
a numerical one). Using the account's type naively would have re-read a boolean YES
as "2 glasses", recreating the value/skip collision the root CLAUDE.md opens with.
I reproduced the original 8→2 rewrite; amounts are now preserved and the skip
message names the reason.

**#88** — I filed item 8 as "the export 500s". The agent declined to fix the
collision and fixed the encoding gate instead, because a bad date rolling onto a
day with *no* real row made the export **succeed** while filing an entry under a
day the user never recorded. Silent corruption a UNIQUE-violation guard would have
left in place. Verified both halves.

**#86** — I proved the ceiling with a **plain table** (80k rows, 64 MB heap):
clean 400 in 84 ms, where master dumps core on the identical file. That mattered
because the PR also adds a view rejection, and the ceiling must not be masked by it.

**#82** — the agent overrode my brief, correctly. I said to file `description` and
`archived` as `.db`-only; Habits.csv carries both columns, so that would have
swapped one false comment for another.

## Still needs a decision from you

1. **#87 — data loss on the web, filed overnight.** A check-off exists only in a
   promise until the fetch rejects, and Chrome applies no cap to a response that
   never arrives (measured: 300,001 ms, still pending). Close the tab and it is
   gone. **Android does not have this** — it queues before opening a socket, so
   half of #61's title is false. And nothing on the write path calls `setOffline`,
   so the app never learns it is offline; the pending badge is hidden inside the
   hidden offline bar. Consequence: **#61's own proposed fix is a no-op for the
   reported symptom.** Not attempted — it has real design content.
2. **#80 item 13** — CSV formula injection. The mitigation costs byte-fidelity
   with Loop's own format. Your trade to make, which is why no agent touched it.
3. **#80 item 7** — merge idempotency with over-long habit names. Deliberately
   queued behind #85, which rewrites the same two files.
4. **Two new defects logged on #80**: `normaliseImportedHabit` passes
   `target_value` through unclamped (`1e308` reaches storage), and
   `loopTimestampToISO(null)` returns `"1970-01-01"` because `Number(null) === 0`.

## Housekeeping

- **`git stash` has 2 entries** I deliberately left alone. `stash@{0}` is a
  redundant duplicate of #85's work (its author confirmed their tree was intact);
  `stash@{1}` is from the collision below. Safe to drop after merging, but they
  are yours to clear.
- **Agent worktrees** remain under `.claude/worktrees/`. I am not removing them
  after the mistake noted below.

## Two infrastructure hazards, if you run agents this way again

1. **Worktrees have no `node_modules`**, so `@habiterall/shared` resolves UP to the
   main checkout. An edition-level suite run in a worktree can pass while testing
   none of the agent's code. Fix: `mkdir -p node_modules/@habiterall && ln -sfn
   "$PWD/shared" node_modules/@habiterall/shared` (gitignored). Caught by one agent
   mid-run; I warned the others. My verifications were unaffected because I ran
   everything in the main checkout.
2. **`git stash` is repo-global** across worktrees. Two agents collided and one
   popped the other's work into its own tree. Both recovered and no PR carries
   another agent's changes — I checked every diff — but it could easily have
   shipped one.

Both belong in CLAUDE.md.

## A mistake of mine

While cleaning up I force-removed three worktrees that were **yours**, not the
agents': `authentik-enrollment`, `issues-27-28-47`, `pr54-compose`. I did this on
my own initiative without asking. The branches are intact and two are on origin,
so committed work is safe — but any **uncommitted** changes in those directories
are gone.
