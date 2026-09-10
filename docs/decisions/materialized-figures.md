# A materialised `habit_summary` table, proposed and closed unbuilt (#196)

Moved out of #196, closed. Nothing here is loaded automatically. Unlike most
records in this archive, this one is not a decision that shipped — it is a
design that was written down, deliberately parked, and then correctly
predicted to close unbuilt once its own cheap probe (#184) turned out to be
enough. The reasoning is kept for the same reason `must-stay-fixed.md` keeps
refused settings: so nobody re-derives the bigger table from scratch without
first re-reading why the smaller one already closed the gap.

#196's own pinned comment, at the top of the issue when it closed:

> **Parked, deliberately.** Do not start this. It is gated on #184's
> *outcome*, not on #184's completion — #184 is the cheap probe and closing
> this unbuilt is the expected result. #198 (measured, 3.35x on `/overview`
> per habit, one function body, no schema change) moved the numbers below and
> has not been re-measured against them. Anyone picking this up should
> re-measure first and expect to close it.

That prediction held. #184 (closed: "The dashboard's two lifetime figures are
re-derived from the whole history on every load...") shipped the cheap 20% —
two nullable columns on `habits` (`best_streak`, `total_completed`,
`summary_asof`) rather than a new table, with `summary_asof` alone deciding
validity and a write clearing it. `docs/decisions/caching.md` has the full
design, the measurements, and the concurrency proof (`test:summarycache`,
`test:summaryrace`). #198 (closed: the `dateRange` rewrite, ~8x cheaper per
aggregation) and #183 (closed: the measurement this whole sequence started
from) both landed too. #196 itself is closed, unbuilt, exactly as predicted.

## The shape of the workload #196 was answering

A user taps a handful of habits a day. The dashboard is loaded on every app
open, every foreground, every tab, and on every reconnect. The read:write
ratio is on the order of 100:1.

Every one of those reads re-derived every figure from raw entry rows, in JS,
on one thread — no materialisation anywhere in the system, not a summary
table, not a cached column, not a derived index. `score`, `currentStreak`,
`bestStreak`, `totalCompleted`, and the seven fields `/stats` returns were all
recomputed from scratch, every time, for every habit on the page. Measured (in
#183): 9.35 ms per habit against five years of history, synchronous, on the
event loop every tenant shares. That figure predates #198, which cut a
comparable pass by 3.35x on `/overview` for one function body alone — #196's
numbers were never re-measured against the post-#198 tree, which is why its
own comment says so before anyone reopens it.

**Why "it depends on today, so you cannot cache it" was not the obstacle it
looked like.** The obvious objection is that these figures are functions of
`(entries, today)` rather than of `entries` alone — the score decays daily, a
streak extends because the calendar moved. True, and the dependency has
structure: a figure for day D depends only on entries dated <= D
(`computeScores` and `computeStreaks` both walk forward from `from` to `end`
and never look ahead), so the series is append-only as the calendar advances —
yesterday's value is not invalidated by today arriving — and an edit to a past
entry invalidates only from that date forward. The correct shape is therefore
not a cache with a TTL; it is an incremental derivation with backward
invalidation from the earliest edited date. That argument is exactly right,
and it is what #184's two columns implement in miniature — a single stamp
rather than a per-day series, because two figures (not a whole date-indexed
history) turned out to be the entire cost worth caching.

## The proposed shape, unbuilt

```sql
CREATE TABLE habit_summary (
  habit_id  BIGINT NOT NULL,
  user_id   BIGINT NOT NULL,
  asof      DATE   NOT NULL,
  score           DOUBLE PRECISION NOT NULL,
  current_streak  INTEGER NOT NULL,
  best_streak     INTEGER NOT NULL,
  total_completed INTEGER NOT NULL,
  PRIMARY KEY (habit_id, asof),
  FOREIGN KEY (habit_id, user_id) REFERENCES habits (id, user_id) ON DELETE CASCADE
);
```

Extended forward by a cheap rollover (a daily job, or lazily on the first read
of a new day for that account, to avoid a job that has to know every
account's timezone); truncated backward on write
(`DELETE FROM habit_summary WHERE habit_id = $1 AND asof >= $2`, where `$2` is
the edited date); a dashboard read becomes one indexed lookup per habit
instead of two scans and eight passes. The composite FK carrying `user_id` was
correct as specified — the pattern migration 007 established, and its header
explains what a table keyed without the owner permits (an invisible-row squat
producing an unfixable 500 for the victim). Any new per-habit table still has
to follow it; nothing about this record changes that rule, only whether this
particular table gets built.

## The three things that would have made this harder than it looked

These are not specific to the unbuilt table — they are true of any
materialisation of these figures, including the one that shipped, and #184's
actual design (`caching.md`) had to answer versions of the second and third.

**1. `asof` is the caller's day, not the server's.** `callerDay`
(`shared/src/notify.js`) reads the `X-Habiterall-Timezone` header and nothing
else, and `CLAUDE.md` is explicit that whose day it is has two answers. An
account used from two zones can move `asof` backwards, so a rollover has to be
idempotent and a lookup must not assume monotonicity.

**2. `bestStreak` is bounded and can legitimately go down.** `STREAK_HISTORY_DAYS`
is 1830, so as the window slides a long-ago run leaves it — `awards.md`
records the same property for the award ladder, "a habit older than ten years
slides rather than grows." A materialised column must be recomputed, never
`GREATEST(old, new)`, which would quietly convert a bounded figure into an
unbounded one and reintroduce the exact bug the bound exists to fix.

**3. A stored lapse rewrites history backwards.** The root `CLAUDE.md`:
"ranges that start at the earliest stored entry grow backwards when a lapse
is imported, so every unknown day after it reads as a miss." An import, or a
single backdated `PUT` of value 0, can invalidate a habit's entire figure
series — not just from the edited date, but from the new `firstEntry`. The
invalidation rule for the unbuilt table was therefore
`asof >= min(edited_date, old_first_entry, new_first_entry)`, not simply the
edited date — the clause most likely to be got wrong, and silent when it is:
the figures just stay stale and plausible.

A property test for either shape has to move the first entry, cross the
1830-day bound, and include backdated lapses, or it cannot see these three
cases — the same warning `CLAUDE.md`'s testing section gives about the awards
invariant walking a daily habit from a fixed first entry.

## Explicitly not recommended, and still not recommended

Three alternatives considered and refused, independent of whether the bigger
table or the smaller columns ship:

- **Reimplementing `computeStats` in SQL.** Faster, and directly against this
  repo's grain — #195 (open: "the two editions ship a byte-identical route
  surface from two implementations, and they have already drifted on both
  correctness and cost") is a preview of what a third implementation, in SQL
  this time, becomes.
- **Packed/bitmap entry storage.** A classic win for dense day series, and it
  would destroy the clarity of the four-state model the whole codebase is
  organised around. The fourth state is the absence of a row; a bitmap has to
  encode that separately, and this project's single loudest rule is about not
  collapsing `no` and `unknown`.
- **`worker_threads` for the stats pass.** Plausible, and the structured-clone
  cost on ~16k small entry objects likely eats the win — and after #183,
  #184 and #198 the remaining CPU may not justify it regardless. Measure
  again only after the CPU those three left behind is itself measured.

## What would change the answer

#195 is the live thread this closed issue's reasoning still feeds: if the two
editions' route surfaces keep drifting on correctness and cost, a third,
shared implementation of the aggregation (SQL or otherwise) becomes a
question about consolidation rather than about caching, and this record's
"not recommended" on SQL stops being the whole answer. #190 (open: "scaling
out is blocked in three places") is the other — if the dashboard's read cost
becomes a scaling blocker at an account count this instance's process cache
and #184's per-row columns were never sized for, that is the point to
re-measure #196's original 9.35 ms/habit figure against the current tree
before reopening it, exactly as its own pinned comment said.
