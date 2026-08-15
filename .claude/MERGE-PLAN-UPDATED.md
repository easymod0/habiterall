Every PR has now been reviewed a second time by an agent with **fresh context**
(no knowledge of the earlier review), findings applied, and a comment left on
the PR. This section is what is left for **you** to decide — nothing here is
blocking a merge unless it says so.

---

## Merge order (updated)

Nine branches. All conflict-free except one pair. Tick as you go.

- [ ] **#81** `fix/loop-timestamp-year-boundaries` — #80 items 9, 10
- [ ] **#82** `fix/roundtrip-asserts-what-the-db-actually-carries` — #80 item 14
- [ ] **#83** `fix/csv-archive-round-trips-every-habit` — #80 items 11, 12
- [ ] **#84** `fix/import-repairs-what-it-claims-to` — #80 items 2, 4
- [ ] **#85** `fix/apply-import-honours-the-api-rules` — #80 items 1, 3, 5, 6
- [ ] **#86** `fix/import-row-ceiling` — bounds the `.db` reader for #79
- [ ] **#88** `fix/loop-export-survives-a-colliding-date` — #80 item 8
- [ ] **#89** `fix/export-papercuts` — #80 low-impact set ⚠️ conflicts with #83
- [ ] **#91** `docs/say-what-the-code-actually-does` — documentation accuracy

**The one conflict**, #89 against #83, one import line in
`shared/test/export-csv.test.js`. Keep both names:

```js
  buildHabitsCsv, buildCheckmarksCsv, buildCsvArchive, esc, uniqueNames, csvNumber,
```

Verified on the fully-merged tree with that resolution: **485 unit tests**,
typecheck, personal round-trip, the new export suite, cloud round-trip, cloud
API, tenancy, notify, auth, overview and the compose check — all green.

---

## ⚠️ Read this before merging #86

**#86 no longer closes #79, and I removed the keyword.** A **7,918-byte zip**
still hard-kills the process on that branch — I reproduced it, core dump.
`parseLoopCheckmarksCSV` creates one habit per header column with no cap, and
`Date,a,a,a,…` deflates ~1010:1. Filed as **#92**.

#86 is still worth merging — the `.db` ceilings are correct and load-bearing.
It just does not finish the job, and auto-closing #79 would have recorded the
*cheaper* attack as fixed.

---

## Decisions for you

**1. `#84` — floor or round when clamping a frequency?**
At denominators just above 365 the floor loses a whole count: `2/366` becomes
`1/365`, a visible halving. Measured across `n=1..365, d=366..3000`, the current
floor is more accurate in **958,271** cases and less accurate in **866** (all
`d ≤ 486`). I kept the floor because it obeys the PR's own rule — *never ask
more of the user than the file did* — and `Math.round` would break that and
change the pinned `182/365` to `183/365`. Say the word if you want accuracy over
that rule.

**2. `#85` — should a SKIP in a file overwrite a recorded amount?**
Today it does, and I did not change it: a skip is an answer (`isCompleted`
returns `null`, not `false`), so a file asserting one is asserting something.
But it does mean a `SKIP` cell in a bare Checkmarks.csv overwrites eight
recorded glasses, which is the headline case of that PR inverted. Unchanged from
master, identical in both editions, now commented and pinned by a test so it
reads as a decision. Your call whether it should yield like a bare lapse does.

**3. `#80` item 13 — CSV formula injection.** Still untouched. A habit named
`=HYPERLINK(...)` executes when the export is opened in Excel. The mitigation (a
leading `'` or tab) costs byte-fidelity with Loop's own format, which is a trade
only you can make.

**4. `#91` — two security-relevant doc fixes worth eyeballing.** I verified both
against the code:
   - `SETUP.md`'s secret generator gives `DB_OWNER_PASSWORD` **base64**, because
     it does not match the `*DB_PASSWORD` glob — and that value goes into a
     connection URL, which is the exact `/`-breaks-the-authority failure the
     comment three lines above exists to prevent.
   - `SETUP.md` claimed the app binds to `127.0.0.1:3100`. Compose publishes
     `'${APP_PORT:-3100}:3000'`, i.e. **all interfaces** — and that sentence
     opens the "Put TLS in front" section, so a reader may skip firewalling.

**5. `#91` carries seven open questions** the agent would not guess at, plus a
likely bug in `run.mjs`'s `OFFLINE_SUITES` (it omits `atmost`, which needs no
server). Read the PR body.

**6. `#87` — the web offline data-loss bug.** Not attempted; it has real design
content. A check-off exists only in a promise until the fetch rejects, and Chrome
applies no cap to a response that never arrives (measured: 300,001 ms, still
pending). Android does not have this. And **#61's own proposed fix is a no-op**
for the reported symptom, because nothing on the write path ever sets the
offline state.

---

## Follow-ups now tracked, no action needed from you

- **#92** — the CSV/zip and JSON import paths have no ceiling; also records that
  #86's ceilings bound memory but **not CPU** (a 15.8 MB `.db` blocks the event
  loop for 3m42s and answers 200).
- **#80** — items 7 and 13 remain, plus `target_value` unclamped. Note the
  review **corrected me** on that last one: `parseHabit` itself accepts
  `1e308`, so passing it through is consistent with the API rather than a
  divergence, and clamping it in the importer would make the importer stricter.
- `shared/src/stats.js:12-22` has the same date bug pair #81 fixes
  (`toISO(fromISO('0050-03-15')) === '1950-03-15'`). Unreachable today only
  because aggregations clamp by string comparison first — an accident of
  lexicographic ordering, not a guard.
- `PORTABLE_HABIT_KEYS` (#89) catches cloud-side drift only; closing the other
  direction needs the list somewhere both editions assert against.
- The import dialog never shows `entriesKept`, so after #85 a merge reports
  "1 merged · 0 entries imported" and omits the number that explains why.
- `habiterall-personal/CLAUDE.md`'s `npm test # the CSS-guard test` is wrong —
  that package has no `test` script. Left alone because it sits inside #88's
  diff; one-line follow-up after #88 merges.

---

## What the second review round actually caught

Worth knowing, because it argues for the fresh-context pass being worth it:

- **#84 shipped two real bugs in the fix itself.** `1e400` parses to `Infinity`,
  which the code read as "the file said nothing" — so a habit due twice per 1e400
  days was stored as **due every day**. Master was more faithful. And the overflow
  guard did the same at the top of the range. Neither was catchable by the test,
  because `parseHabit` acceptance is too weak an oracle: `1/1` is accepted.
- **#82's own new assertion had a vacuous sibling**, and the CSV colour was
  asserted by nothing — destroying every habit's colour on export passed both
  suites.
- **#85's widened yield could be defeated by a note of one space.**
- **#86 does not close #79.**
- **#88's integration suite passed with its main guard removed.**
