---
name: issue-to-pr
description: Take a GitHub issue from analysis to an open, green, self-reviewed PR in this repo — scope it across the editions, ask the questions only Mark can answer, plan, dispatch workers to implement and verify, adjudicate two independent reviews, and open the PR. The model per role and whether workers run serially are both overridable per run. Use when asked to work, start, pick up, implement or "do" an issue (`issue-to-pr 123`, "work #123", "let's do issue 45").
---

# From an issue to an open PR

Invoked as `issue-to-pr <n>`. Everything below is one arc; do not skip a phase
because the change looks small. The largest PR of the 2026-08-15 night touched
both clients, a new column and two migrations, and reviews found six defects in
it. The smallest — one Kotlin function — found none. **Scope down before you
start, not after.**

The end state is a **reviewed, green, open PR**. You do not merge; the harness
refuses it and that is the right boundary.

## Who does what

You keep the judgement and delegate the mechanism. The split is not about
capability — it is about which model should be making a claim.

| phase | who | role name |
|---|---|---|
| 0–4: preflight, the issue, the premise, the matrix, the questions, the plan | **you** | `lead` |
| 5: implement, one step at a time | `habiterall-implementer` | `implement` |
| 6: re-run the suites and every mutation | `habiterall-verifier`, which did not write the code | `verify` |
| 7: commit | **you** | `lead` |
| 8: review | `habiterall-reviewer` ×2, two lenses — then **you** adjudicate | `review-a` / `review-b` |
| 9–11: the PR, CI, the report | **you** | `lead` |

Three rules make the delegation safe, and they are the reason this shape works
at all:

- **A worker shares none of your context.** It gets the CLAUDE.md hierarchy and
  a git status snapshot; everything else you learned is lost unless you write it
  down. Phase 4 is where you write it down.
- **A worker cannot ask.** `AskUserQuestion` is denied to all three agents. A
  worker that needs a decision stops and reports to you, and you own what
  happens next.
- **A worker never commits.** You read the diff and write the message, because
  the message makes claims and the model that makes a claim must be the one that
  checked it.

The **role names** in the last column are what the next two sections configure.
Everything else about a role is fixed: the agent type, its tools and its
prompt. Only the model it runs on and whether it runs alongside a sibling are
per-run choices.

### Choosing the models

Every dispatch below passes `model:` **explicitly**, because the `Agent` tool's
`model` parameter takes precedence over the agent definition's frontmatter. That
one parameter is the whole mechanism: a different mix never means editing
`.claude/agents/*.md`, and the frontmatter's `model: sonnet` is the fallback for
somebody invoking an agent outside this skill.

```
issue-to-pr <n> [preset] [role=model ...]
```

Roles are `implement`, `verify`, `review-a`, `review-b`. `review=X` sets both
reviewers; `review=X/Y` sets them in order. Models are `opus`, `sonnet`,
`haiku`.

| preset | implement | verify | review A | review B |
|---|---|---|---|---|
| *(none)* | sonnet | sonnet | sonnet | sonnet |
| `careful` | opus | sonnet | opus | sonnet |
| `all-opus` | opus | opus | opus | opus |

**There is deliberately no cheaper preset, and `verify=haiku` is the one
override to refuse.** The verifier exists because *a test that could not fail,
beside a commit message saying it could* is the most repeated defect this
project has shipped — so a weak verify does not cost a missed finding, it
produces a green run that is a lie, which is the failure this whole skill is
shaped around. `review-a=haiku` on a genuinely small change is defensible;
downgrade lens A before anything else, since it is the more mechanical of the
two. Nothing stops you writing either — this is a judgement, not a gate.

```
issue-to-pr 123                             # the default row
issue-to-pr 123 careful
issue-to-pr 123 review=opus/sonnet          # mixed reviewers, nothing else moved
issue-to-pr 123 implement=opus verify=opus
issue-to-pr 123 all-opus review-b=sonnet    # a preset, then one cell overridden
```

Prose resolves to the same table — "work #123 with Opus on both reviews" is
`review=opus`. **State the resolved four back before dispatching anything.** An
override that was misread and an override that was applied produce
identically-shaped runs, so the only moment it can be caught is before the first
worker starts.

Four things about this, in the order they cost you if you get them wrong.

- **What governs the whole thing is the session model, and it is not settable
  from here.** Phases 0–4 and 7–11 are the lead's — the premise check, the
  matrix, the questions, the plan, the adjudication, the commit message — and
  the lead is whatever `/model` says. `Agent(model:)` reaches subagents only. So
  "run the whole thing on Opus" is `/model opus` and *then* this skill; there is
  no argument for it, and one here would be claiming something it cannot do.
- **The lead is the place to spend.** It is the only phase that cannot be
  re-run cheaply: a wrong premise or a missing edition in the matrix costs the
  whole PR, while a weak reviewer costs a missed finding that round two may
  still catch. If exactly one thing is going to be Opus, it is the session.
- **Mixed reviewers beat matched ones at the same price.** Two reviewers exist
  for *independence*, and a model's blind spots are correlated with itself — two
  Sonnets under two lenses share every failure mode the model has. That also
  degrades the strongest signal this skill has: *a finding both reviewers
  reached independently* means much less when the two are one model. So
  `review=opus/sonnet` buys decorrelation that `review=opus/opus` does not, for
  half the upgrade. **If you upgrade one thing below the lead, upgrade one
  reviewer.**
- **An override changes the model, never the rules.** The three delegation rules
  hold at every model. `implement=opus` is a better implementer *of an approved
  brief*; it is not a licence to let it scope the change, decide a default, or
  write the commit message. The brief exists because the worker has no context,
  which is a property of the dispatch and not of the model.

`effort` is overridable the same way and usually should not be. All three agents
ship `effort: high`; lowering it on a reviewer or the verifier is a false
economy, because both exist to find the thing a faster pass missed.

The **agent type** is deliberately not a knob. There are three, and each encodes
its own toolset — the reviewer has no `Edit`, which is what makes "does not fix
anything" a property rather than a request. Swapping types is a redesign of this
skill, not a parameter of a run.

### Serial or parallel

```
issue-to-pr <n> [concurrency=serial|parallel]
```

**Serial is the default and is right nearly always.** Two workers in one
checkout do not collide on files, they collide on the **harness**.

Parallel dispatch of phase 5 has three preconditions, and *you* check all three
before the batch — a worker cannot see its siblings:

1. **Disjoint files.** No file is named by two steps in the brief. The brief
   already names files per step, so this is checkable; if it is not checkable,
   the brief is not finished.
2. **No dependency between the steps.** A step that wires up what another step
   creates cannot start before it exists. Parallel is per *independent* step,
   not per step.
3. **At most one exclusive suite at a time — and the safe way to get that is
   for no worker to run one.** `npm test` and `npm run typecheck` need nothing
   and are safe concurrently. Everything else is exclusive: the browser suites
   bind a port and reset `shared/test/browser/fixtures.mjs`, the Postgres suites
   share one database, and `test:notify` / `test:roundtrip` write a SQLite file.
   A **mutation check is worse than a suite run**, because it deliberately
   breaks the tree a sibling is testing against.

So in parallel mode a worker writes the code and its test, runs `npm test` and
`npm run typecheck` only, and **the mutation proof moves wholly to phase 6** —
where the verifier is single by construction and re-does every one of them
anyway. Say that cost out loud rather than discovering it: a test that cannot
fail is found one phase later than it would have been, and if phase 6 is where
it is found then phase 5's step has to be re-opened.

Two more rules travel with it:

- **Never interleave.** Do not start a parallel batch while a serial step is in
  flight, and do not add a worker to a batch already running.
- **Reading the diff gets harder, and it is still the artifact.** Serial says
  *between steps, read `git diff`*. A batch returns interleaved, so read
  `git diff --stat` first and then the diff **per step's named files** — a
  worker's summary is a claim about the diff, not the diff, and that does not
  change because there are three of them.

**Worktree isolation is not the answer to any of this.** A worktree has no
`node_modules`, so `@habiterall/shared` resolves *up* to the main checkout on
master and an edition-level suite may test code the branch never changed — a
green run that is a lie, which is worse than a collision that is loud.
`../pr-review/references/verify.md` has the rest.

**Phase 8's two reviewers are already parallel, and that is safe for a
structural reason** — they are read-only and have no `Edit`. One exception
survives: `pr-review` allows *running something to confirm a finding you already
suspect*, so precondition 3 applies to them too. If a reviewer needs an
exclusive suite, it is the lead who runs it, once, after both have reported.

---

## 0. Preflight

Cheap, and it has caught a whole wasted run more than once.

```bash
git status --porcelain          # must be empty — you are about to branch
git branch --show-current       # you are often NOT on master
git fetch origin && git log --oneline -1 origin/master
gh pr list --search "<n>"       # is somebody already on this?
git branch -a | grep -i <keyword>
```

Branch from **`origin/master`**, never from whatever branch the session
happened to start on. If a branch or PR for this issue already exists, say so
and stop for a decision — resuming somebody else's half-finished work is a
different task with different risks.

Note anything already running that a suite will collide with: a server on 3000,
a compose stack, an emulator. **At `concurrency=parallel` this is not a note but
a gate** — an occupied port or a live compose stack is a fourth precondition
failing, and the batch waits for it.

Resolve the run's configuration here too, and say it back: the four role models
and the concurrency, per *Who does what* above. It is one line and it is the
last cheap moment to catch a misread argument.

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

This phase is yours and it is the one that stops a whole wrong PR. Do not
delegate it.

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

The matrix goes in the brief, in the PR body, and nowhere else does the work.

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

**Ask now, not later.** No worker can reach Mark, so a question you leave open
becomes a worker stopping mid-step, and everything after it waits on you anyway.

**If this is an unattended run** (an overnight batch, no one to answer):
do not guess. Research it, write the findings and the options as an **issue
comment**, and stop. Filing a good issue is a complete piece of work.

## 4. Plan, get it approved, then write the brief

Use `EnterPlanMode`. The plan names, concretely:

- the files, split into shared vs per-edition, with the matrix from phase 2;
- **the registry checklist rows that apply** (below) — every one, or the change
  is half-wired;
- the tests: which suite, and **what mutation will prove each one bites**;
- the docs to update;
- a migration, if any, and what happens to existing rows;
- what you are deliberately NOT doing.

`ExitPlanMode` for approval. Nothing is dispatched before it.

**Then write the brief** to `.claude/work/issue-<n>/brief.md`, following
`references/worker-brief.md`. This is the phase that carries the whole delegation:
a worker gets the CLAUDE.md files and this file, and nothing else you know.
Split the work into **steps sized to one worker** — each a coherent slice
verifiable on its own, each naming its files, its test and its mutation.

The rule that decides whether a brief is finished: it says what to **change**,
not what to **achieve**. A goal makes a worker re-derive the scoping you just
did, with less context than you had.

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

## 5. Dispatch — one step, one worker

Branch first: `git checkout -b <type>/<a-short-sentence>` off `origin/master`.

Then, at `concurrency=serial` (the default), one `habiterall-implementer` per
step, in order:

```
Agent(subagent_type: "habiterall-implementer", model: "<implement>",
      run_in_background: false,
      prompt: "Brief: /abs/path/.claude/work/issue-<n>/brief.md — do STEP 2 only.")
```

`run_in_background: false` because the next action genuinely depends on the
result and nothing else can usefully happen meanwhile.

At `concurrency=parallel`, and **only** once you have checked all three
preconditions above, dispatch the independent steps in one message — adding the
line the mode requires:

```
Agent(subagent_type: "habiterall-implementer", model: "<implement>",
      prompt: "Brief: … — do STEP 2 only. PARALLEL RUN: other workers are
               editing other files in this same checkout. Run `npm test` and
               `npm run typecheck` only — do NOT run any browser, Postgres,
               notify or roundtrip suite, and do NOT mutation-test. Write the
               test; phase 6 proves it bites.")
```

**Between steps — or when the batch returns — read `git diff`, not the worker's
summary.** The diff is the artifact; the summary is a claim about it.

A worker that **stops and reports** has done the right thing. It comes back to
you: re-plan the step, narrow it, or ask Mark. Never re-dispatch the same brief
hoping for a different reading.

Two rules that are not optional, and are in the worker's prompt too:

- **Both editions move together** when the behaviour is shared. Personal and
  cloud answering one request differently is the defect class this repo names
  most often.
- **Write the test with the fix**, not after. And write it where it can fail —
  the fake-DOM suites (`atmost.mjs`, `rendercheck.mjs`, `daydialog.mjs`) cannot
  see anything needing `dataset`, a real listener, or `getComputedStyle`.

## 6. Verify — with a model that did not write it

`npm test` and `npm run typecheck` always, plus the suites for what you touched.
Dispatch `habiterall-verifier` over the whole change:

```
Agent(subagent_type: "habiterall-verifier", model: "<verify>",
      run_in_background: false,
      prompt: "Verify the change on this branch against master. New tests: …")
```

This phase is **always single and always serial**, whatever `concurrency` said —
it is the one that runs the exclusive suites and every mutation, so a second
worker anywhere near it is the collision the mode exists to avoid. After a
parallel phase 5 it is also carrying the mutation proof for every step, so say
so in its prompt and expect it to take longer.

It re-runs the matrix in `../pr-review/references/verify.md` — which also has the
environment gotchas that make a green run a lie — and **re-does the mutation for
every new test**, because the model that wrote a test is the worst judge of
whether it bites. That defect, a test that could not fail beside a message
saying it could, is the most repeated one this project has shipped.

When it returns, two things are yours:

- **Confirm the tree.** `git status --porcelain` and `git diff --stat` are what
  they should be. A mutation left in place breaks the branch and reads as a pass.
- **Read the raw output, not the conclusion.** "The suite failed as expected" is
  not evidence; the quoted failure is.

## 7. Commit

Yours, always — a commit message makes claims, and the model that makes a claim
must be the one that checked it.

`git status` before every commit; never trust `git add -A` blind. Style, from
the log: `type(scope): a sentence about what changed and why it matters`. The
body explains the *reason* and the shape of the bug, not the diff.

Say "verified the tests bite: reverting X fails Y" **only when you have read the
output that shows it.**

## 8. Review, then adjudicate

Two reviewers, dispatched in one message so they run concurrently, over the same
diff under different lenses. Both run `pr-review`'s six always-checks; the lens
only says where to spend the budget.

```
Agent(subagent_type: "habiterall-reviewer", model: "<review-a>",
      prompt: "Review `git diff master...HEAD`. LENS A: the PR's own claims,
               tests that cannot fail, mirrors and registries, configuration
               plumbing.")
Agent(subagent_type: "habiterall-reviewer", model: "<review-b>",
      prompt: "Review `git diff master...HEAD`. LENS B: the premise, entries /
               windows / figures, silence, security boundaries, offline and
               clocks.")
```

Give the **stronger model LENS B** when the two differ. Lens A is largely a
checklist — claims against the diff, registries against their pairs — and lens B
is the one that has to hold a premise and a window in mind at once.

They have no `Edit` and they never post — `local` is structural, not requested.

**Then adjudicate, and this part is yours.** For each HIGH and MEDIUM, decide:

- **real** — it goes into a fix brief;
- **the design** — grep the CLAUDE.md files before you accept anything that
  looks like an oversight; several past "findings" here have been the design,
  and 3,000 lines record the reason for nearly every rule;
- **speculation** — no named input that breaks it, so it is a question, not a
  finding.

A finding **both** reviewers reached independently is the strongest signal
available — **and it is weaker when both ran the same model**, whose blind spots
and whose false positives are correlated with itself. Under `review=opus/sonnet`
agreement means two models agreed; under `review=sonnet` it means one model
agreed with itself under two lenses. A finding only one reached still stands on
its own evidence either way.

Then dispatch fixes to a `habiterall-implementer` with a **fix brief in your own
words** — never the raw review report, which contains the findings you rejected
and will get those "fixed" too. Re-run the affected suites after.

- **Fix every real HIGH and MEDIUM.**
- **Cap at two rounds.** If a second round still finds a HIGH in the same
  change, stop touching it. Ask Mark if he is there; if not, leave the branch
  and write up what is unresolved. Blind iteration is how a defect gets buried
  under three fixes.
- Fixes made in response to reviews carried 6 of 19 defects on one night — the
  fix commits need reviewing too, which is what round two is for.

## 9. Open the PR

Only when no HIGH survives adjudication.

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

## 10. Make it green

The end state says *green*, and local suites are not CI. CI runs both Docker
builds, the compose job, the Postgres suites and Android — none of which a
local run necessarily covered.

```bash
gh pr checks <n> --watch
```

A failure is another round of the same loop: adjudicate what it means, write a
fix brief, dispatch, re-verify, push. Under the **same two-round cap** — a
third red CI is something to report, not to keep poking.

Two things to know before you read a red check. The `compose` job is the one
exception to the docs-only skip, deliberately: it is the job that guards
documentation, so a hand-edited generated README block fails exactly there. And
Android and the Docker builds are the slow ones — if the run is unattended and
they are still going, say so in the report rather than waiting the batch out.

## 11. Report

Three or four lines: what landed, the PR link, CI's state, what you could not
verify, and anything left running (servers, containers, an emulator). Name which
steps were delegated and to what, and say where the artefacts are
(`.claude/work/issue-<n>/`) so a dead session leaves a trail. Say plainly what
was not done.

**Name the run's configuration on one line** — the lead's model, the four roles,
and the concurrency:

```
lead opus · implement sonnet · verify sonnet · review opus/sonnet · serial
```

It costs a line and it is the difference between two reports that otherwise look
identical. A change reviewed by two Haikus and one reviewed by two Opuses
produce the same-shaped writeup and very different grounds for trusting it, and
the reader a week later has no other way to tell.
