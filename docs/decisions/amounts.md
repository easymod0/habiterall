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
of `HabitFormScreen.kt`, because a comment claiming two clients agree is
precisely the claim that goes stale.

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
`if (parsed === null && form.type.value !== 'numerical')` in `readTarget`:
hidden and unreadable, the stored target stands; hidden and readable, the
typed value is submitted as it would have been visible — `syncTypeFields`'s own
"hidden is not cleared" for the at-most controls. Ungated, mistyping the
target and then switching Type away from Measurable leaves Save writing a
complaint into a `[hidden]` span and calling `focus()` on a `[hidden]` input —
both do nothing, and the dialog simply stops saving with no visible reason and
no visible control to fix. `Number(...) || 0`, the code this replaced, at
least always saved something; a refusal nobody can see is worse than the bug
it fixes.

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


