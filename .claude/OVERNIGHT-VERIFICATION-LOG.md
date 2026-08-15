# Overnight batch 1 — verification record

## PR #81 — fix/loop-timestamp-year-boundaries (#80 items 9, 10)  [VERIFIED BY ME]
- Scope: 4 files, exactly as scoped. No closing keyword (correct — #80 is a group).
- Diff read: `setUTCFullYear` replaces `Date.UTC`; year padded to 4 and bounded 1..9999.
- I ran on branch 670ce30: unit 451+14 pass/0 fail, typecheck clean, personal round-trip all pass.
- I independently confirmed round-trip exact for years 1,50,99,100,999,1000,1970,1998,2026,9999 (0 mismatches).
- Good catch by the agent, unprompted: padding alone would have made year 0 format as a
  plausible `0000-01-01` that the writers' regex ACCEPTS, where unpadded `0-01-01` was rejected.
  So the 1..9999 guard had to land with the padding. That is a real hole they closed.
- Agent did NOT run cloud suites (another agent held the only Postgres) — disclosed in PR. Gap.
- Flagged, not fixed (pre-existing, real — I confirmed): loopTimestampToISO(null) === "1970-01-01"
  because Number(null) === 0, while undefined/NaN correctly give null.

## PR #82 — fix/roundtrip-asserts-what-the-db-actually-carries (#80 item 14)  [VERIFIED BY ME]
- Test-only diff (3 files), no closing keyword. Correct.
- Agent verified the premise before acting (as instructed) — description/archived/notes DO all
  survive the .db. Header comment claiming otherwise was false on all three.
- DEVIATED FROM MY BRIEF, correctly: Habits.csv also has Description and Archived columns, so
  filing them as ".db only" would have swapped one false comment for another. They went into
  LOOP_HABIT_FIELDS (both formats). Only `notes` is a genuine .db exclusive. This is right.
- I PROVED the gap myself: broke `archived` in the writer ->
    * on MASTER's suite: "all round-trip checks passed"  (gap was real)
    * on the PR's suite:  3 assertions FAIL, both editions
- I ran on branch 0a489f2: unit 448+14, typecheck clean, cloud round-trip pass, cloud API pass.

## PR #83 — fix/csv-archive-round-trips-every-habit (#80 items 11, 12)  [VERIFIED BY ME]
- Scope: 4 files as asked. No closing keyword. No node_modules committed.
- I confirmed behaviour directly on branch 16113ab:
    item 11: Run / Run / Run (2)  ->  header `Date,Run,Run (3),Run (2)` — suffix now skips the
             taken name; numerical habit keeps type + 8/10/3 (before: dropped 8 and 10, forged a skip)
    item 12: habits with no entries now restore with type and unit (before: 400 "no habits found")
- I ran: unit 458+14, typecheck clean, personal RT pass, cloud RT pass, cloud API pass.

## PROCESS FINDING — affects trust in agent-reported results
Worktrees have NO node_modules, so `@habiterall/shared` resolves UP to the MAIN checkout
(on master). Any edition-level suite run inside a worktree may have tested master's shared/,
not the agent's change. Unit tests under shared/test/ are unaffected (relative imports).
- Found and disclosed by the #83 agent, who fixed it with a gitignored symlink and re-ran.
- MY verifications are unaffected: I ran everything in the MAIN checkout with the branch
  checked out, so resolution was correct.
- I warned the 3 still-running agents and told them to prove the linkage by breaking a file.

## PR #84 — fix/import-repairs-what-it-claims-to (#80 items 2, 4)  [VERIFIED BY ME]
- Scope: shared/src/import.js + its test only. No closing keyword. No stray files.
- I confirmed on branch f6ba05c that EVERY repaired frequency now satisfies parseHabit:
    1000/1 -> 365/365 | 400/400 -> 365/365 | 2.5/7 -> 2/7 | 1e30/1 -> 365/365
    500/1000 -> 182/365 (rate preserved, NOT invented as daily) | 9/2 -> 9/9 (Loop case intact)
    NaN/1 -> 1/1 | 3/7 unchanged
- All four malformed uploads now carry status=400 (before: `[`-prefixed gave undefined -> 500).
- I ran: unit 451+14, typecheck clean, personal RT, cloud RT, cloud API — all pass.
- Their test uses parseHabit as the ORACLE rather than restating the rule, so it fails on drift
  rather than only on anticipated cases. Good design.
- Flagged, not fixed: normaliseImportedHabit still passes target_value through unclamped
  (1e308 reaches storage) — same "repair stops one field short" shape. Add to #80.

## INCIDENT — git stash is repo-global across worktrees
- The #84 agent and another agent collided on the shared stash stack; one popped the other's
  entry into their tree. #84's agent detected it, restored the entry with `git stash store`,
  and recovered their own from dangling commit 2b7001ff. #84's committed diff is CLEAN
  (I verified: only import.js + its test).
- Current stash stack (I did NOT touch it):
    stash@{0} apply-import.js x2, 166 insertions  -> the apply-import agent's work
    stash@{1} shared/src/import.js, 85 insertions -> created on fix/import-row-ceiling
- Both remaining agents' branches are still at a557273 with NO commits; work is uncommitted.
- I sent both agents the exact stash contents, told them to use `apply` not `pop`, to leave
  the other's entry alone, and to stop using stash entirely.

## PR #85 — fix/apply-import-honours-the-api-rules (#80 items 1,3,5,6)  [VERIFIED BY ME]
- Scope: 2 apply-import.js + 2 suites. No shared/ contamination. No closing keyword.
- I reproduced all three over HTTP on branch 6a9b0e7:
    item 5: before 8/6/7 -> after 8/6/7 (was 8->2, 6->2). entriesKept:1, and the skip message
            NAMES the reason: 'the file records "Water" as boolean and this account has it as
            numerical: 2 answered days have no faithful form here'
    item 6: boolean habit no longer accepts a value of 8 from a file (stored nothing)
    item 1: bad dates reported in `skipped` by name; the good date still stored
- Their key insight, unprompted and correct: on merge the ACCOUNT's type decides what may be
  STORED, but the FILE's type decides how a value was ENCODED (a 3 is a skip sentinel in a
  boolean column and three-of-something in a numerical one). Naively using the account's type
  would have re-read the boolean YES as "2 glasses" — so 5 and 6 genuinely had to be one change.
- I ran: unit 448+14, typecheck, personal RT, cloud RT, cloud API, tenancy — all pass.
- Confirmed their work was PRESENT in their tree; stash@{0} is a redundant duplicate.

## PR #86 — fix/import-row-ceiling (#79)  [VERIFIED BY ME]  Closes #79 (correct)
- Scope: shared/src/import.js + its test. Closing ref = #79 only.
- MAX_IMPORT_HABITS = 10_000, MAX_IMPORT_ENTRIES = 250_000, each justified at declaration.
  They measured 500k entries at 143MB and cut it to 250k — good instinct.
- I PROVED the ceiling with a PLAIN TABLE (not the view path), 80k rows, 64MB heap:
    on the PR:  clean 400 "backup expands to too much data: more than 10000 habits", 84ms, +21MB
    on MASTER:  process dumped core (SIGABRT)
  So the ceiling itself is load-bearing, not masked by the view check.
- The view rejection also works (8KB CTE bomb -> 400 in 4ms) but is defence in depth only;
  they deliberately used plain tables in the regression test so it cannot mask a missing ceiling.
- I ran: unit 452+14, typecheck, personal RT, cloud RT, cloud API — all pass.

## MERGE COMPATIBILITY — all six, tested by me
Sequential merge in this order is CLEAN (no conflicts), auto-merging import.js 3x:
  #81 -> #82 -> #83 -> #84 -> #85 -> #86
Combined result: unit 468+14 pass, typecheck clean, personal RT, cloud RT, cloud API,
tenancy, notify, overview — ALL PASS. Merging all six together is safe.

# BATCH 2

## #61 investigation (no PR — research task)  [KEY CLAIMS VERIFIED BY ME]
Analysis posted to issue #61. I verified the four load-bearing claims by reading the code:
  1. api.js:30-45 — enqueue() is in the CATCH, so a web write is durable only AFTER the
     fetch rejects. Confirmed. Android enqueues BEFORE opening a socket (MainActivity:1082),
     so the issue's premise is FALSE for Android — half the issue title is wrong.
  2. setOffline is called ONLY at api.js:50 (a GET/cache-header path) and inside
     connectivity.js. The write-failure branch calls refreshOfflineBadge() and NOT setOffline.
     Confirmed — the app never learns it is offline from a failed write.
  3. #pending-count IS a child of #offline-bar (index.html:57-61), so the queued-write badge
     is hidden whenever the bar is. Confirmed.
  4. api.js:58-69 is DEAD CODE — sw.js:131 returns early for every non-GET, so the synthetic
     offline 503 can never reach a write. Confirmed.
Measured in real Chrome via CDP: fetch with no AbortSignal never caps a response that never
arrives — 300,001 ms and still pending. So the data-loss window is UNBOUNDED.
=> I filed this as its own issue #87, because #61 is framed as latency and this is data loss
   with a different fix and a different severity.
Recommendation from the agent, which I find sound: feed a queued write back into the
connectivity state THROUGH watchConnectivity's goOffline (not a bare setOffline, or the
watcher's `last` stays true and it never polls). No new probing — which respects the
/healthz four-callers constraint. Bound the attempt second, at 10s taken from Api.kt:386.
No Android mirror needed: a timeout is a transport property, not an opinion about a day.
