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


