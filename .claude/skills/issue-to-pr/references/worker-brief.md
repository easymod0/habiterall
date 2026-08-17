# Writing a brief a worker can execute

A subagent shares **none** of your context. It did not read the issue, it did
not see the premise check, it was not there for the questions Mark answered, and
it cannot ask. What it gets for free is the CLAUDE.md hierarchy and a git status
snapshot. Everything else you know is lost unless it is in this file.

The failure this exists to prevent: **a brief that says what to ACHIEVE gets a
worker re-deriving the scoping you already did, and getting it wrong.** Say what
to change. "Make the widget survive an archived habit" is a second planning
session; "in `Widgets.kt`, `refreshedOrGone` gains …, and `HabitWidget.redraw`
calls it at …" is a step.

Write it to `.claude/work/issue-<n>/brief.md` — ignored by git, so it never
reaches `git status`, and durable enough to survive a session dying overnight.
Hand workers the **absolute** path.

## The template

````markdown
# Brief: issue #<n> — <one line>

## Goal
<One sentence. What is true after this lands that is not true now.>

## The premise, checked
<What you verified about the current code, with the file:line that shows it.
A worker that finds this false must stop — so it has to be written down as a
claim it can test, not as background.>

## Edition matrix
| | affected? | why |
|---|---|---|
| `shared/src` | | |
| `shared/public` | | |
| `habiterall-personal` | | |
| `habiterall-cloud` | | |
| `android-native` | | |
| docs | | |

<Every No carries a reason. Silence is how one edition gets forgotten.>

## Decisions already made
<What Mark answered, and any judgement call you made and why. A worker that
meets one of these must not re-open it — this is where "why not the obvious
thing" lives.>

## Read before you start
<The CLAUDE.md paragraphs that bear on this step, by their opening phrase, and
the neighbouring code to match. Name them; do not make a worker search.>

## Registry rows that apply
<From the checklist in SKILL.md — every row, or the change is half-wired.>

## Steps
### Step 1 — <name>
- Files: `path` — <what changes>
- Test: `<suite>` — <the assertion>
- Mutation: break `<file:line>` by <exact change>; `<command>` must FAIL
- Done when: <the observable thing>

### Step 2 — …

## Out of scope
<What you deliberately are NOT doing, and the follow-up issue if there is one.
A worker with time left over will otherwise find something to fix.>

## Stop and report if
<Beyond the standing triggers: anything specific to this change that means the
plan is wrong rather than the code being difficult.>
````

## What a step has to carry

**Files, and what changes in each.** Not a directory, not "the notifier". If you
cannot name the file, you have not finished planning and the worker will do it
for you, badly.

**Its own test and its own mutation.** The mutation is the load-bearing half:
"break `stats.js:210`'s `?? UNSET` back to the collapsed form; `npm test` must
fail." A step whose mutation you cannot write is a step whose test will not
bite, and you will find that out from a reviewer instead.

**A "done when" that is observable.** A command that passes, a figure that
changes, a cell that paints differently. Not "the logic is correct".

**Steps sized to one worker**, and ordered so each is verifiable alone. If step
2 cannot be checked until step 3 lands, they are one step. Serial dispatch means
you read the diff between them — that is only worth doing if each diff means
something.

## What to leave out

- **The whole issue text.** Quote the part that decides something; link the rest.
- **Anything CLAUDE.md already says.** It is in the worker's context. Name the
  paragraph; do not paste it.
- **A tour of the repo.** Point at files.
- **Reasoning you have already concluded.** The conclusion is the instruction.
  The reasoning belongs under *Decisions already made* only where a worker might
  otherwise undo it.

## The standing stop-and-report triggers

These are in the implementer's own prompt, so the brief need not repeat them —
but a plan that makes any of them likely should say what to do instead:

- the premise as written does not hold;
- a named file, function or registry row is not there;
- two instructions contradict each other;
- the step turns out to need a decision — a default, a representation, a
  semantic change, a new dependency, a sixth offline mirror.

## Fix briefs

A round of review adjudication produces a brief in the same shape, shorter. It
carries: **the finding as adjudicated** (your words, not the reviewer's — you
decided it was real), the file and line, the failure it causes, and the test
that must now exist for it. Never hand a worker a raw review report: it contains
findings you rejected, and it will fix those too.
