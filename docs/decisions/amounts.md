# Typed amounts and the number format setting

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**Recording an amount is a control, not a `prompt()` and not a spinner.** The
dashboard asked with `window.prompt()` — which blocks the event loop, cannot
show a unit or a target, and is suppressed outright by a browser that decides
the page makes too many dialogs, after which tapping a measurable day did
nothing at all with no error anywhere. The day editor had
`<input type="number">`, which is worse than it looks: `shared/CLAUDE.md`
records what that does to `8,5`. Both are `ui/count-field.js` now, over the
rules in `ui/amount.js`, and the dashboard keeps its own write path —
`recordValue`, which paints before awaiting, because offline `api()` queues the
write and THEN throws. Routing the grid's writes through the day editor's
`saveDay` would have undone that whole comment, which is why there are two
dialogs over one control rather than one dialog.

**A refusal has to be actionable, and what it QUOTES has to be true of what it
quoted.** `parseAmount` refuses `10,000` because it is ambiguous, and the box
said *"10,000" is not an amount* — true of `eight`, and what somebody gets for
typing their step goal the way their own country writes it. `amountComplaint`
is the sentence, and its first version made the mistake the rule above is
worded against: it named the readings — *could be ten thousand or ten and a
half* — beside whatever had been typed, so `1,500` was told it might be ten
thousand, with the module's own correct example (*fifteen hundred or one and a
half*) sitting forty lines up in `parseAmount`. Naming the reading is what made
it specific and is what made it false. So the sentence names the AMBIGUITY,
which is the same whatever the digits are, and the advice carries the specifics:
the user's own number with the commas taken out, because *like 10000* is an
example where *like 1500* is an instruction. That suggestion is run through the
parser before it is offered, and it decides the whole branch rather than just
the number in it — `1,500 steps` holds a thousands group and is not ambiguous,
it is not an amount, and a box may not suggest something it would then refuse.
The phone has said the actionable thing since #111; a test reads its string out
of `ui/Amount.kt` (`HabitFormScreen.kt` until #157 moved the rule there),
because a comment claiming two clients agree is precisely the claim that goes
stale.

**Three surfaces read a typed amount, and the third was reading it with
`Number()`.** The day editor and the dashboard share `ui/amount.js`; a Discord
modal is the same box arriving over a socket, and `shared/src/discord.js` had
its own answer — a comma-to-dot replace and `Number()` — which read `10,000` as
**ten**. Nothing downstream can catch that, since ten is a valid amount, and it
is the surface with the least to show for it: no box stays open afterwards. So
`discord.js` imports `parseAmount`, and that is **the one import reaching from
`shared/src` into `shared/public`**. The usual answer here is two declarations
pinned by a test (`CHANNELS`, `SETTING_VALUES`), but that is forced by a
direction this does not run in — the browser cannot see `shared/src`, while node
can read anything on disk. What it costs is `ui/amount.js`'s first line:
"DOM-free so it can be tested without one" was a convenience and is now a
contract with a server.

**Which character a decimal point is, is a DECISION with a device-shaped
default.** `10.000` is ten to this parser and ten thousand to a de-DE or es-ES
reader, and reading it the first way was silent — no refusal, no message, a row
a thousand times too small (#108). The three options were: infer from the
habit's target, which makes one input mean two things depending on a different
field; read the browser's locale, which is a DEVICE fact deciding a STORED
value; or a setting, which is correct and asks something of somebody who has
never thought about it. What shipped is the second as the DEFAULT of the third —
`numberFormat`, whose `auto` resolves against `Intl` at parse time, in
`resolveNumberFormat`'s three tiers: the account's stated answer, else what the
device reports, else the app's own. That is `resolveTimeZone`'s shape and it is
here for its reason, and `'auto'` is a stored value rather than the absence of
one exactly as `theme: 'system'` and `at_most_unlogged: 'default'` are.

**A group is refused under every convention, and that asymmetry is the whole
safety argument.** With the convention known, `10,000` on a `point` account is
unambiguously ten thousand and could be accepted — and is not. The reason is
that most accounts are on `auto`, so the convention is a GUESS from a device: a
wrong guess that refuses costs one sentence saying what to type, while a wrong
guess that accepts costs a row out by a thousand that nothing reports. So the
setting only ever moves which spelling is refused. What it accepts is what was
already accepted: anything with fewer than three digits after the separator is
the same number under both conventions, which is most of what anyone types, and
`parseAmount` needed no convention for it before this and needs none now.

`formatAmount` takes it too, because a box that accepts `8,5` and redraws it as
`8.5` has told its owner they typed it wrong — and on the preset buttons what is
drawn is what gets typed. Nothing is grouped at any size, which keeps the
control's own output inside the one domain its parser accepts. The setting is
**portable**: it decides what the next typed amount MEANS, so restoring entries
onto an account without it hands the same keystrokes a different number. It
carries no capability, so unlike the notification keys there is nothing to hold
back.

Two callers, and they resolve it differently on purpose. `count-field.js` asks
the settings cache and `Intl` at the moment of each read or write, never at
import time — `auto` is a question about the device and the setting is a
question about the account, and either can change while the module is loaded.
`discord.js` passes the account's answer and NO device: a press arrives from
Discord, so there is nothing making the request and nothing to report a
separator, which is the same reason `adapter.today` asks the account rather than
a header. The phone reads none of it yet and says so in `notMirrored` — it has
three readers for a typed amount (`HabitFormScreen.parseAmount` and a bare
`toDoubleOrNull` in both `CountEntryActivity` and the day dialog) that already
disagree with each other about `8,5`, so there is no single reader to give an
answer to. That is **issue #157**, and it is a cost written down rather than an
absence: an account that has CHOSEN a convention is followed in the browser and
not on the phone. Under `auto`, which is almost everybody, the phone would
resolve its own locale and there is nothing to carry.

**The habit dialog's Target box was still `<input type="number">`, and #156 is
the same measurement landing a second time.** `index.html`'s `target_value` was
the one box `ui/amount.js`'s own header had already named as the gap this file
leaves — `8,5` typed as a goal was stored as 85, exactly as it was for a day's
amount before this file's first entry. `readTarget` (`ui/habit-dialog.js`) is
the reader now: untouched, the box submits the stored value verbatim; typed, it
goes through `parseAmount` like everything else that reads a typed amount.

**Whether a typed target should share the day amount's bounded, quantised
domain was a real choice, not a formality — Option B, sharing that domain for
what is typed and not for what was merely stored, is what shipped.**
Option A was to run `parseAmount` over whatever the box holds, unconditionally
— inheriting the day amount's bounded, quantised domain whole, no migration
and no server change, three lines shorter than what shipped. Refused: a
colour-only edit would quantise a stored `3.14159265`, and a shared domain
would have made every one of those rows unsavable the moment somebody opened
the dialog and pressed Save without touching Target — the colour, say — with
no in-domain spelling to retype the goal as. Option C was a
`bounded: false` parameter on `parseAmount` itself, so the target box could ask
for the unbounded, unquantised form of the same parser. Refused for a sharper
reason: `parseAmount` is the one function `shared/src/discord.js` imports across
the `src`/`public` boundary, and the bounds are not an accident of the day
editor — they exist so `parseAmount` and `formatAmount` agree about one domain,
which the target box needs as much as any caller that both reads and re-shows
what it read. Threading a flag through a shared function to switch its domain
off for one caller is the shape of bug the bound was written to prevent
elsewhere in this same file.

So Option B: what is **typed** goes through `parseAmount` exactly as a day's
amount does — bounded to `[1e-6, 1e12]`, quantised to six places — and a box
left **untouched** submits the stored value verbatim, whatever it is. The
round trip this settles:

```
typed "3.14159265"    -> stored 3.141593   quantised, same as a day's amount
typed "1e-7"          -> refused           below MIN_AMOUNT, an exponent besides
typed "2000000000000" -> refused           above MAX_AMOUNT
untouched, stored 3.14159265 -> stored 3.14159265   unchanged; the box was never asked
```

A target outside `[1e-6, 1e12]` is reachable today without an import touching
anything: the `type="number"` box this change removes was one way in; the
phone's `HabitFormScreen.parseAmount` has no bounds at all; every import
reader (`shared/src/import.js`, both editions' `apply-import.js`) passes the
file's own number straight through, checking only that it is finite and
non-negative; and `formatAmount` renders a value too small for it to show back
as its raw self rather than as `0`, precisely so a value this narrow has
something true left to preserve rather than being silently rewritten into a
stated lapse on the next Save.

**A refusal is gated on the box being ON SCREEN, not on the parse, and that is
a second choice with its own failure mode if it is not made.** The gate is
`if (parsed === null && form.querySelector('.numerical-only').hidden)` in
`readTarget`:
hidden and unreadable, the stored target stands; hidden and readable, the
typed value is submitted as it would have been visible — `syncTypeFields`'s own
"hidden is not cleared" for the at-most controls. Ungated, mistyping the
target and then switching Type away from Measurable leaves Save writing a
complaint into a `[hidden]` span and calling `focus()` on a `[hidden]` input —
both do nothing, and the dialog simply stops saving with no visible reason and
no visible control to fix. `Number(...) || 0`, the code this replaced, at
least always saved something; a refusal nobody can see is worse than the bug
it fixes.

That gate shipped as `form.type.value !== 'numerical'` and review changed it,
which is worth recording because the two are behaviourally identical today.
What decides whether the box is on screen is `syncTypeFields`, one line:
`form.querySelector('.numerical-only').hidden = !numerical`. Written the first
way, `readTarget` holds a second copy of that expression 750 lines from the
line it has to track — and carries the comment saying why it matters, while
the line it mirrors carries none. A third `HABIT_TYPES` entry, or
`.numerical-only` hidden for any second reason, splits them silently, and what
comes out is exactly the failure the gate exists to prevent. The DOM already
holds the answer; ask it. `countcheck.mjs` has a check that can tell the two
apart — the container hidden by hand with Type still reading Measurable —
because the pre-existing one hides it by switching Type, where the two
readings are the same event and so it passes against either.

**The Target box shows a quantised value, and the string it shows is the one
string that cannot be committed.** `filledTargetText` is `formatAmount(stored)`,
which rounds to 6 dp, and `readTarget`'s untouched shortcut returns the
UNQUANTISED stored number whenever the box still holds that string. So a habit
stored at `3.14159265` is shown `3.141593`; a user who selects the box and
retypes exactly what it was showing gets `3.14159265` back, unchanged. Retyping
it any other way — `3.1415930`, a trailing zero — does commit the shown value,
which is why this is a curiosity rather than a defect: no target is
unreachable, only one spelling of one is inert.

This is the direct price of "untouched is the STRING" and it is not worth
paying to avoid. The alternative is a dirty flag on the box, and a flag is
wrong in the direction that costs something: `input` fires on a keystroke that
leaves the value identical, on a paste of the same text, on an IME commit, and
on an autofill — so a flag marks touched a box nobody meaningfully changed, and
then `PUT /habits/:id`'s replace semantics turn that into a stored target
quietly rewritten during an edit of a different field. A comparison against the
string cannot be wrong that way: it is exactly true when the box holds what the
habit holds. The next person to look at this will reach for the flag; this
paragraph is why not.

**A target is an AMOUNT wherever it is written down, and `targetLabel` was the
surface left out.** `openDialog` fills the Target box through
`formatAmount(storedTarget, convention())` — because a box that reads `8,5` and
writes `8.5` back has told its owner they typed it wrong — and
`count-field.js`'s goal hint already went through the same function
(`Target at most 8,5 pages`). `targetLabel` (`ui/dates.js`) was a raw template
literal, so on a comma account the dashboard row and the detail head read
`≥ 8.5 pages` three lines from a box holding `8,5`: one number, two spellings,
one screen.

It takes the formatter as an argument rather than looking it up, which is
`formatAmount`'s own arrangement one file over and is forced here: `ui/dates.js`
has NO imports, because `shared/test/label-widths.mjs` reads its source, strips
`export` and evaluates it in a page, and `dates.test.js` imports it under Node
where the absolute `/shared/...` specifiers do not resolve. Moving the label
into `ui/amount.js` instead would have been an export moved between two shell
modules, which is the `CACHE_VERSION` bump the paragraph below is about; a
parameter is neither a new file nor a new export.

**Its default is `String`, and the default is insurance rather than
convenience.** `shellFirst` can serve one boot the new `ui/dates.js` over a
cached older `ui/detail.js`; without a default that boot is
`showAmount is not a function` inside `render()`, and with it the label is
merely spelled the way it was spelled before. The cost of a default is that a
future caller can rely on it silently, so the two visible surfaces are pinned
behaviourally on a comma account in `countcheck.mjs` — the dashboard row, and
the detail head compared against the Edit box beside it — and the unit test in
`dates.test.js` asserts the literals `≥ 8.5 pages` and `≥ 8,5 pages` rather
than calling `formatAmount` on both sides of its own assertion.

The third caller is the starter preset's subtitle (`ui/dashboard.js`), whose
targets are whole numbers, so nothing observable turns on it. It passes the
formatter anyway: the argument is about what a target IS, not about which
targets happen to have a fractional part today.

**And there is a FOURTH surface, which is not a `targetLabel` caller at all.**
The day editor's subtitle — `Sunday, 15 March 2026 · target at most 8,5 cigs`
(`openDayDialog`, `ui/day-dialog.js`) — spells the direction in WORDS rather
than as `≤`, because it is a sentence about the day being edited and not a
label, so it had its own template literal and `targetLabel` could not reach it.
It is the worst of the four to get wrong: the amount box it describes is filled
by `dayCountField.set` three lines later, through `formatAmount`, so the two
spellings were four lines apart in one dialog. It takes the same
`formatAmount(n, convention())` the other two declare, as a third declaration of
that one line rather than a new export from either — an export under
`shared/public/` is a `CACHE_VERSION` bump.

**Two suites pin it and they pin different halves, which is this repo's
DECISION-versus-WIRING split arriving in one small change.** `daydialog.mjs`
slices `openDayDialog` out of its module and evals it, so the formatter is
handed in with every other free identifier — built from the REAL `formatAmount`
over a convention the case chooses, since `ui/count-field.js` reaches for
`document` at import time and cannot be loaded there. That pins the
PASS-THROUGH: the subtitle spells the goal with whatever formatter it is given,
read as a fractional target under both conventions, and with the raw literal
restored the comma case reports `target at least 8.5 pages` while the point case
still passes on itself. What it cannot see is which formatter the MODULE asks
for — `convention()` replaced by a literal `'point'` passes every case in it,
with `typecheck` clean, which is measured rather than argued.

So the wiring is pinned in `countcheck.mjs`'s comma section, where an account is
already on `numberFormat: 'comma'` with a fractional target stored: the day
editor is opened from the detail view's calendar and `#day-sub` must end
`at least 9,5 pages` and contain no `9.5`. That is the assertion the literal
mutation fails, and it is the only one that can.

**The fixture's existing goal literals needed no change and that is worth saying
rather than leaving to be rediscovered**: `daydialog.mjs` reads `at least 8
glasses` and `at most 0 cigs`, and `8` and `0` are spelled identically under
both conventions, so they are as true through the formatter as they were beside
it — which also means they could never have failed on this. `countcheck.mjs`'s
own `/at most 0/` waits are a different surface again: they read
`#grid-count`'s hint, which is `count-field.js`'s and already went through
`formatAmount`.

**`countcheck.mjs`'s `dialogClosed` had to move in the same change.** That wait
builds the label it expects, and #307 had it as a literal `≥ ${value} ${unit}` —
correct only while every call site sits above the suite's comma section, which
is an ordering nobody maintains. It derives the separator from the ACCOUNT's own
`numberFormat` plus the device now, an independent restatement of
`resolveNumberFormat`'s three tiers, and deliberately not by importing
`targetLabel` or `formatAmount`: a wait whose expectation is the implementation
is the implementation compared against itself. A save was added INSIDE the comma
section so the derivation is load bearing — with the literal restored, that wait
times out by name on `≥ 9.5 pages` while the page correctly reads `≥ 9,5 pages`.

**An empty Target box is still a stated 0, not a delete.** That is what
`Number(f.target_value.value) || 0` meant before this — a habit with no
target — and it is what `readTarget` maps `''` to as well. It is deliberately
not the day editor's empty box, which is a DELETE of that day's row: there is
no row here to delete, only a field on the habit itself.

**Adding an EXPORT to a shell module is a `CACHE_VERSION` bump**, for the same
reason v14 was one. `shellFirst` serves scripts cache-first and revalidates per
request, so the swap is not atomic: a shell holding the new `count-field.js`
over a cached old `amount.js` is a module link error — `amountComplaint` is not
an export of that file — and nothing downstream of it evaluates, including
`app-entry.js`. It self-heals on the next load, which is a reason to bump rather
than a reason not to: being wrong costs a blank screen, and the bump costs one
refetch of data the client is about to refetch anyway.

**`[hidden]` needs `display: none !important`** in the stylesheet. A `display`
rule silently beats the attribute, which once made the day editor show both
habit types' controls at once. Only a real browser catches this class of bug —
that is why `test/browser/` exists.

## #157: the phone's own three-way disagreement, and the device tier over there too

The web's rule (above) was never the phone's problem. Android had grown three
independent readers of a typed amount, and they disagreed with each other before
ever getting to disagree with the web:

| where | how | `8,5` | `10.000` |
|---|---|---|---|
| `HabitFormScreen.parseAmount` (habit target) | comma→dot, thousands refusal, always POINT | 8.5 | 10 |
| `CountEntryActivity` (notification number pad) | `toDoubleOrNull` | refused | 10 |
| `MainActivity` day dialog (`CountDialog`) | `toDoubleOrNull` | refused | 10 |

Only the habit form had a real parser, and even it was not locale-aware: it
always read a dot as the decimal point and a comma as a thousands separator,
regardless of the device. So a German phone's goal box already silently read
`10.000` as ten — the exact #108 bug the web fixed, unnoticed on Android because
nothing here was testing a non-`en-US` locale.

Two designs were on the table. **A real mirror** — carry the account's
`numberFormat` down to the phone and pick `AmountFormat` from it, the same as
every other client-honoured setting — would agree with an EXPLICIT `point` or
`comma` choice, at the cost of a sixth hand-written mirror the root CLAUDE.md
asks to be justified every time one is proposed. **The device tier** — resolve
`AmountFormat` from `Locale.getDefault()` alone, the same `auto` tier
`resolveNumberFormat` already falls back to — costs nothing over the wire and
gets `auto` (the setting's own default, and almost everybody's value) exactly
right, at the cost of ignoring an account's explicit choice on this one client.

**The device tier is what shipped**, for a reason specific to this parser and not
a general argument against mirrors: the cost of being wrong is bounded by
construction. `parseAmount`'s `format` argument decides only which SPELLING of a
thousands group is refused — `10,000` under `POINT`, `10.000` under `COMMA` —
and never what is accepted, because a group is refused under BOTH conventions
and neither accepts one. `8,5` and `8.5` are eight and a half either way. So a
wrong guess at the device's own convention can only ever refuse a spelling
loudly (an account on `comma` but a phone whose OS is set to `en-US` sees "Type
it without the thousands separator" on an input that was actually fine); it can
never silently store a row out by a factor of a thousand, which is the failure
mode #108 and this issue both exist to close. A mirror would buy a better
refusal message on that one mismatched phone, not a correct row — not the trade
the root CLAUDE.md's mirror rule is for. `numberFormat` therefore stays in
`AppSettingsDefaultsTest`'s `notMirrored` map; only the reason string changed,
from "three readers that do not agree" to "one reader, by design, nothing
crosses the wire."

**What is knowingly left open**: an account that has explicitly set `point` or
`comma` — rather than leaving it on `auto` — is honoured in the browser and not
on the phone. Closing that gap for real is the mirror this issue declined to
build; if it is ever worth it, `Overview` (or `/settings`) is where the value
would have to ride down, the same way `habitSort` already does, rather than a
seventh place reading `GET /settings` directly.

**The fix unified the three readers before changing what any of them decided.**
`ui/Amount.kt` is `HabitFormScreen.kt`'s old `parseAmount`/`amountComplaint`,
moved wholesale and then taught to take an explicit `AmountFormat` (defaulting
to `deviceAmountFormat()`), so `CountEntryActivity` and `CountDialog` could be
pointed at the SAME function rather than each growing their own copy of the
rule. `AmountWiringTest` is the suite that exists because this repo's own
named defect class is pinning the decision without pinning the wiring: it
renders `HabitFormScreen` and drives `CountEntryActivity` under
`Locale.GERMANY`, asserting the `HabitInput` and the shown `Toast` rather than
a return value of `parseAmount` itself. The third call site, `CountDialog`
(`MainActivity`'s day dialog), was pulled out to a top-level composable for the
same seam reason `HabitList` was — but a compose-driven test for it could not
be built: `android-native/README.md` already names the trap ("a real
`AlertDialog` under `createComposeRule` hangs `waitForIdle` indefinitely...
there is no timeout and no failure — the test simply never returns"), and a
version of the test reproduced exactly that, running for roughly a minute
before the test JVM died of an `OutOfMemoryError` rather than failing an
assertion. It was then tried a second time under the other rule flavour
(`createAndroidComposeRule<ComponentActivity>()`) and bounded with a JUnit
`@Test(timeout = 60_000)`, on the theory that the README's claim was about
`createComposeRule` specifically; it hung there too, to an external kill at 900
seconds, without writing a result file at all — so the JUnit bound never got to
fire either. Two flavours, one of them bounded: the wall is a property of the
dialog and not of how the first attempt was written.

What guards that call site instead is `CountDialogWiringGuard`, a source-text
guard, which is the same settlement `MainActivityWiringTest` records for
`HabitListScreen` and is what the root CLAUDE.md prescribes when the
behavioural test cannot exist — kept for what it DOES catch (a call site that
reads no shared rule at all) with behavioural tests beside it for the other
two. Two things make it worth having rather than decorative. It is found BY
NAME, so renaming, moving or re-privatising `CountDialog` fails the guard
naming the declaration it could not find — which is the half that proves it
sees the site it claims, the thing #184's guard did not. And it prints its own
DENOMINATOR: the fourteen `ui/` files it scanned, with `Amount.kt` named as the
one deliberate exclusion, because an empty offender list means nothing until
you know what was looked at. It skips comment-ONLY lines and nothing more —
`s.toDoubleOrNull() // honest` is still an offender — a clause that exists
because a KDoc sentence explaining what the guard protects against failed the
guard itself.

So the honest statement of what is unverified is narrower than "this call site
is untested": what no automated suite in this repo can currently see is
`CountDialog` RENDERED — that its Save button enables on `8,5` and not on
`10.000`, and that `onConfirm` receives 8.5. That its source reads the one
reader, and that nothing else under `ui/` reads an amount any other way, are
both pinned.


