---
name: pr-review
description: Review a pull request or branch diff in this repo — adversarially, with the defect classes this project has actually shipped. Use when asked to review a PR, review a branch, review changes before merge, or check someone else's (or your own) commit. Also use before opening a PR.
---

# Reviewing a change in habiterall

You are the last reader before this lands. Your job is to find defects that
tests and CI cannot, and to check that the change's own claims are true. You do
not fix anything, and you do not rewrite prose you merely dislike.

Every review of this project so far has found at least one defect on the first
round. Assume there is one.

## What you were given

One optional argument decides what you review and whether you post.

| invoked as | review | post? |
|---|---|---|
| `pr-review 555` | that PR — `gh pr view 555 --comments`, `gh pr diff 555`, base is its own base branch | yes, to 555 |
| `pr-review <branch>` or `pr-review <sha>` | that ref against `master` | only if it has an open PR |
| `pr-review` (nothing) | the current branch: `git diff master...HEAD` | only if HEAD has an open PR |
| `pr-review local` / `--no-post` | as above | **never** — print only |

`local` is how the `issue-to-pr` skill calls this before a PR exists. When in
doubt about whether to post, print and say you did not.

**Preloaded into `habiterall-reviewer`**, this skill runs under a *lens* named in
the prompt — which says where to spend the budget, because a second reviewer is
reading the same diff under a different one. The lens is not a licence to skip:
the six always-checks all run whatever it says, and a finding outside it is
still a finding. That agent is always `local`, and has no `Edit` tool, so "do
not fix anything" is a property rather than a request.

Read the issue the PR names (`gh issue view`) when the diff's *purpose* is
unclear — but not otherwise. The diff and its claims are the subject.

## Budget

A review is a bounded read, not an exploration. Aim for **under 25 tool calls**.

1. `git diff --stat <base>...HEAD` then `git diff <base>...HEAD` — the whole diff, once.
2. Read a touched file only when the diff's context is too thin to judge it, and
   then read the region, not the file.
3. To learn *why* something is the way it is, `grep` the CLAUDE.md files for the
   concept — they are 3,000 lines total and record the reason for nearly every
   rule here. Never read one end to end.
4. Run something only to confirm a finding you already suspect. See
   `references/verify.md`.

Do not re-derive the design. Do not summarise the diff back. Do not list files.

## Read in this order

**The claims first.** PR body and commit messages. Write down every factual
assertion: "mirrors X", "the tests bite", "verified on the emulator", "no
behaviour change", "round-trips". Each is a thing you are now checking. On this
project the most repeated defect was not wrong code — it was a **test that could
not fail beside a commit message saying it could**.

**The tests second, before the implementation.** For each new or changed
assertion ask one question: *what production change would make this fail?* If
the answer is "none", it is a finding, whatever else the PR does. The recurring
shapes are in `references/traps.md` under "Tests that cannot fail".

**The implementation third**, against the checks below.

**The premise last, and hardest.** The bugs here are rarely in arithmetic. They
are in which entry a load lands on, which day a notification is about, which of
two types decides an encoding, whether the map holds the key. When the diff
looks right, ask what it *assumes* and whether anything in the repo guarantees
it.

## Always check these six

They account for most of what has shipped broken.

1. **Mirror drift.** Five rules are hand-copied between `shared/public/ui/`,
   `shared/src/` and Kotlin, because they run offline. If the diff moves one
   copy, every copy moves or there is a finding. List: `references/traps.md`.
2. **The fourth state.** `entries` has four states — `done`, `skip`, `no` (a row
   holding 0) and `unknown` (no row). Any `?? UNSET`, `?? 0`, `?? false` on an
   entry lookup collapses two of them. Ask whether the map *holds* the key.
3. **Truthiness over a three-answer value.** `isCompleted` returns `null` for a
   skip; `parseAmount`/`parseTimeInput` return `''`, `null` or a number where
   `0` is real. Two of three are falsy. Callers must use `===` / `!== false`.
4. **A new rule that reaches one client only.** Anything a phone or a browser
   must do with no network is a mirror; anything server-authoritative is not.
   Adding a sixth mirror is a real cost — say so if the change adds one that
   could have been a server call.
5. **Silence.** A failure that only logs, an optimistic paint that is never
   rolled back, a refused write dropped as permanent, a warning nobody with the
   power to act can read. Ask: when this goes wrong, who finds out and how?
6. **The claim vs. the artifact.** Was the thing verified the thing shipped? A
   `uiautomator dump` is not a screenshot; a unit test on an extracted function
   is not a test of its caller; "all suites pass" in a worktree with no
   `node_modules` may have tested master. See `references/verify.md`.

## Then, by what the diff touches

For anything beyond a one-line change, read `references/traps.md` once — it is
the whole catalogue, ~4k tokens, and it is the cheapest part of the review. Skim
to the sections that match, and skip it entirely only for a trivial diff the six
checks above already cover.

| the diff touches | section |
|---|---|
| Kotlin, `ui/toggle.js`, `ui/time.js`, `notify.js`, `SETTING_VALUES`, a setting | Mirrors and registries |
| `stats.js`, `awards.js`, charts, anything reading `entries` | Entries, windows and figures |
| `import.js`, `export-*.js`, `apply-import.js`, round-trip fixtures | Import, export, fidelity |
| a URL, a host, a fetch the server makes, `db/`, RLS, sessions, auth | Security boundaries |
| `ui/api.js`, `offline.js`, `sw.js`, `connectivity.js`, a new `public/` file | Offline, replay, the shell |
| a date, a timezone, `today()`, a locale-facing string | Clocks and calendars |
| an env var, compose, `.env.example`, README blocks | Configuration plumbing |
| CSS, a chart, the fake-DOM suites, a dialog | DOM and rendering |
| a notification, an alarm, a widget, `Reminders`, `NotifyWorker` | Android wiring |

## Reporting

Rank most severe first. For each finding:

```
### HIGH — <one sentence: the defect>
`path/to/file.js:123`
<Concrete failure: inputs or state → the wrong outcome a user sees.>
<Optional: the one-line fix, only if it is obvious.>
```

- **HIGH** — silent data loss or corruption; a wrong number presented as fact;
  a tenancy, auth or SSRF hole; a crash on ordinary input; a test that cannot
  fail supporting a claim the PR makes.
- **MEDIUM** — a user-visible wrong behaviour; a mirror left to drift; a rule
  written in two places; a failure with no surface.
- **LOW** — a real defect with a small blast radius. Cap at three; drop the rest.

End with one line: `Verdict: <n> HIGH, <n> MEDIUM — <ship / fix first / needs a
decision from Mark>`. If there are no findings, say so in one line and name the
two or three things you actively checked and cleared, so the reader knows the
review had teeth.

**Say what you did not check.** A suite you could not run, a client you could
not build, a claim you took on trust — name it. A gap disclosed is worth more
than a gap discovered later.

### Post it to the PR

**A review that exists only in a session transcript is lost when the session
dies**, which is the ordinary end of an overnight run. So when the change under
review is an open PR, the last step is to leave the report on it. You are
authorised to do this without asking — it is what this skill is for.

```bash
gh pr comment <n> --body-file /tmp/review-<n>-r<round>.md
```

- **`--body-file`, never `--body`.** A review is full of backticks, newlines and
  `$`; inlining it into a shell argument is how it arrives mangled or fails to
  arrive at all.
- **Head the comment with the SHA you read** — `Reviewed <sha> (round N)`. Line
  numbers go stale the moment a fix lands, and a review that does not say what
  it read cannot be re-checked.
- **A comment, not `gh pr review --approve` / `--request-changes`.** The verdict
  is advice; changing the PR's formal state is Mark's.
- **One comment per round**, appended rather than edited, so the sequence of
  rounds stays readable.
- If there is no PR, or `gh` fails, print the report and **say in your reply
  that it was not posted** — a review believed to be on a PR and not there is
  worse than one plainly delivered in chat.

## Do not

- Report style, naming, comment density, or "consider extracting". The
  `simplify` skill owns quality; this owns defects.
- Report anything the CLAUDE.md files record as a deliberate decision without
  first grepping for it. Several "findings" here have been the design.
- Propose a second rule that answers a question an existing predicate already
  answers (`replayable()`, `bounded()`, `unansweredCounts`, `channelConfigured`).
  Two rules for one question is itself the defect this project keeps hitting.
- Speculate. If you cannot name the input that breaks it, you do not have a
  finding — you have a question, and questions go at the end under "Unverified".
- Fix anything. Report, and let the author decide.
