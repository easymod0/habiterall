---
name: issue-to-pr
description: Take a GitHub issue from analysis to an open, self-reviewed PR in this repo — scope it across the editions, ask the questions only Mark can answer, plan, implement, verify, self-review with pr-review, and open the PR. Use when asked to work, start, pick up, implement or "do" an issue (`issue-to-pr 123`, "work #123", "let's do issue 45").
---

# From an issue to an open PR

Invoked as `issue-to-pr <n>`. Everything below is one arc; do not skip a phase
because the change looks small. The largest PR of the 2026-08-15 night touched
both clients, a new column and two migrations, and reviews found six defects in
it. The smallest — one Kotlin function — found none. **Scope down before you
start, not after.**

The end state is a **reviewed, green, open PR**. You do not merge; the harness
refuses it and that is the right boundary.

---

## 1. Read the issue and find the ground

```bash
gh issue view <n> --comments
```

Then locate the code — `grep`, not a tour of the repo. Two questions:

- **Is the premise true?** Check it before acting. A past PR was asked to fix a
  header comment claiming three fields were `.db`-only; two of them were not,
  and filing them as stated would have swapped one false comment for another.
  If the issue is wrong about the code, say so and stop for a decision.
- **Is it one issue?** An umbrella issue (`#80`-style, a numbered list) is a
  source of several PRs, not one. Pick the items that belong together, and say
  which you are taking.

## 2. Scope across the editions — write the matrix down

This is the phase that prevents the drift this repo has paid for twice
(~1,750 lines of frontend, and #54's ten undocumented variables). Produce a
table and state a reason for every **No** — silence is how one edition is
forgotten.

| | affected? | why |
|---|---|---|
| `shared/src` | | pure logic — no db, no HTTP, no DOM |
| `shared/public` | | the whole web UI |
| `habiterall-personal` | | SQLite, auth, routes, `apply-import.js`, `notifier.js` |
| `habiterall-cloud` | | Postgres + RLS, OIDC, same four |
| `android-native` | | only if it must work offline — see below |
| docs | | README prose, `examples/`, `SETUP.md`, a CLAUDE.md |

The rules that decide it:

- **If you are about to copy a file between editions, stop.** It belongs in
  `shared/` behind an adapter. Only storage, auth, the import *writer*, the
  notifier's storage adapter and the API routes are per-edition — and a
  behaviour that lands in one edition's routes almost always has to land in the
  other's too, or the two disagree about the same request.
- **A client mirrors a rule only if it must work OFFLINE.** The phone has five
  hand-written copies (tap cycle, reminder-time parsing, `needsReminder`, the
  entry encoding, the channel default) and each runs with no network. Everything
  else is server-authoritative: the phone submits and renders whatever comes
  back, including the error. **A sixth mirror is a real cost and a sixth server
  call is not** — if you are adding one, justify it in the plan or drop it.
- **A new file under `shared/public/` must join `sw.js`'s `SHELL` and bump
  `CACHE_VERSION`**, which costs every installed client its data cache. Ask
  whether the code can live in an existing module instead. Several rules here do,
  for exactly this reason.
- **`shared/src` is not served to the browser.** A constant both need is declared
  twice and pinned by a test — do not "fix" it by mounting `src/`.

## 3. Ask — before planning, not during implementation

Use `AskUserQuestion` for anything that is **Mark's judgement**, and nothing else:

- which of two representations, what a default should be, whether a semantic
  change is wanted at all;
- adding an npm dependency (personal's no-native-module property and `shared`'s
  no-dependencies property are both deliberate — this is close to a veto);
- scope: shipping half a feature across two clients, where a *rendering* gap is
  acceptable and a *data* gap is not;
- anything that changes what existing stored data means.

Do **not** ask what the code, the tests or a CLAUDE.md already answers — grep
first. Ask everything in one round if you can; batch beats drip.

**If this is an unattended run** (an overnight batch, no one to answer):
do not guess. Research it, write the findings and the options as an **issue
comment**, and stop. Filing a good issue is a complete piece of work.

## 4. Plan, and get it approved

Use `EnterPlanMode`. The plan names, concretely:

- the files, split into shared vs per-edition, with the matrix from phase 2;
- **the registry checklist rows that apply** (below) — every one, or the change
  is half-wired;
- the tests: which suite, and **what mutation will prove each one bites**;
- the docs to update;
- a migration, if any, and what happens to existing rows;
- what you are deliberately NOT doing.

`ExitPlanMode` for approval. Do not start writing code before it.

### The registry checklist — "if you add X, you must also touch Y"

| adding | also |
|---|---|
| a **setting** | `SETTING_VALUES` (validate.js) **and** the `ui/settings.js` registry; then `AppSettings` **or** `notMirrored` in `AppSettingsDefaultsTest` *with its reason*; then a `PORTABLE_SETTINGS` / `UNPORTABLE_SETTINGS` decision (a bearer capability is never portable) |
| a **habit field** | `parseHabit`; `JSON_HABIT_FIELDS`; a decision about `LOOP_HABIT_FIELDS` / `LOOP_DB_HABIT_FIELDS`; both editions' schema and SQL; the round-trip fixture, **varied off its default** |
| an **env var** | the code; both the checkout and the published compose file for that edition; the `.env` template; `npm run docs:compose`. A computed `process.env[name]` needs an `@env NAME` marker |
| a file under **`shared/public/`** | `sw.js` `SHELL` + `CACHE_VERSION` |
| a **notification destination** | `CHANNELS`, a branch in `sendToChannel`, an option in `ui/settings.js` — nothing per edition |
| a **cloud table** | a numbered migration, its RLS policy, the exact grant list, the tenancy suite, and the prose in `habiterall-cloud/CLAUDE.md` |
| a **personal schema change** | the in-place migration in `db.js` |
| a **route reading a date** | `callerDay` for "is this today", `boundedRange` for anything from storage |
| an **offline client rule** | the mirror, and both test suites pinned to the **same examples** |
| a **user-facing change** | README prose. There is no CHANGELOG here; the README is where a user reads what the app does |
| a **non-obvious decision** | a paragraph in the nearest CLAUDE.md. That is what those files are — but only for what the code cannot say itself |

## 5. Implement

Branch first: `git checkout -b <type>/<a-short-sentence>`. Match the repo's
existing patterns — read the neighbouring code before writing.

Two rules that are not optional here:

- **Both editions move together** when the behaviour is shared. Personal and
  cloud answering one request differently is the defect class this repo names
  most often.
- **Write the test with the fix**, not after. And write it where it can fail —
  the fake-DOM suites (`atmost.mjs`, `rendercheck.mjs`, `daydialog.mjs`) cannot
  see anything needing `dataset`, a real listener, or `getComputedStyle`.

## 6. Verify — and prove the tests bite

`npm test` and `npm run typecheck` always. Then the suites for what you touched:
the table in `../pr-review/references/verify.md`, which also has the environment
gotchas that make a green run a lie.

**Mutation-test every new test before you write the commit message:**

```bash
cp path/to/file.js /tmp/x.bak     # NEVER `git checkout` — it takes
<undo the fix>                    # uncommitted work with it
<run the suite>                   # expect FAIL
cp /tmp/x.bak path/to/file.js
```

Confirm the module still loads after the mutation — a syntax error fails the
suite for the wrong reason and reads as a pass. If a test cannot be made to
fail, it is in the wrong harness or should not exist.

## 7. Commit

`git status` before every commit; never trust `git add -A` blind. Style, from
the log: `type(scope): a sentence about what changed and why it matters`. The
body explains the *reason* and the shape of the bug, not the diff.

Say "verified the tests bite: reverting X fails Y" **only when you did it.**

## 8. Self-review, before the PR exists

```
Skill(skill: "pr-review", args: "local")
```

`local` means print, do not post. Then:

- **Fix every HIGH and MEDIUM**, and re-run the affected suites.
- **Cap at two rounds.** If a second round still finds a HIGH in the same
  change, stop touching it. Ask Mark if he is there; if not, leave the branch
  and write up what is unresolved. Blind iteration is how a defect gets buried
  under three fixes.
- Fixes made in response to reviews carried 6 of 19 defects on one night — the
  fix commits need reviewing too, which is what round two is for.

## 9. Open the PR

Only when no HIGH survives.

```bash
gh pr create --title "<same style as the commit subject>" --body-file /tmp/pr-<n>.md
```

The body carries: what changed and why, **the edition matrix from phase 2**,
what you verified (naming the suites and the mutation), and **what you did not
verify** and why. `Closes #<n>` only when this PR fully resolves that issue —
never on an umbrella issue, where you name the items instead.

Footer:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Do not merge, and do not `gh pr review --approve`.** A self-spawned review is
not the review gate, and the harness will refuse it. If the change touches a
schema, a migration, a data model or user-visible semantics, say plainly in the
PR that it wants Mark's eyes before merge.

## 10. Report

Three or four lines: what landed, the PR link, what you could not verify, and
anything left running (servers, containers, an emulator). Say plainly what was
not done.
