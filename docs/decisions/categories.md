# Categories (issue #65, phases 1 to 3)

Long-form reasoning moved out of `CLAUDE.md` to keep that file under the size
that is loaded into every session. Nothing here is loaded automatically; the
operative rules live in the nearest `CLAUDE.md` (root, `shared/CLAUDE.md`,
`habiterall-cloud/CLAUDE.md`).

**One category per habit, in a table of its own — not a free-text column and
not a many-to-many join.** A free-text column makes "Health" and "health" two
categories by construction and gives a colour nowhere to live: colour belongs
to the category, not to each habit's spelling of it. A join looked more
flexible and was rejected for what phase 2 actually needs. Grouping a list
into sections is a *partition* — every habit in exactly one bucket — and a
join does not produce one: a habit in two categories would have to be drawn
twice, once per section, and the always-present Uncategorised section would
have to somehow not count it either time. Phase 3 (comparing categories,
explicitly out of this change) would have the same habit double-counted into
both sides of whatever it compares. A table with a nullable foreign key on
`habits` gives every habit exactly one category or none, which is the only
shape the grouped dashboard and any future comparison can both use without a
special case.

**`ON DELETE SET NULL`, never `CASCADE`, on `habits.category_id`.** A cascade
there deletes every habit in the category and every day of history attached to
each one, triggered by a control that reads, to the person pressing it, as
tidying up a label. That asymmetry — a labelling action with a data-destroying
side effect — is the most expensive mistake available in this change, and
nothing about "delete category" implies "delete its habits" the way "delete
account" implies "delete its data" in the cloud edition's own
`ON DELETE CASCADE` on `categories.user_id`. Those are deliberately different
policies on two different foreign keys for two different reasons: an account
being gone means nothing under it can mean anything either, while a category
being gone means only that its habits have lost a label they can regain.

**Uncategorised is a state, never a category.** It is represented as
`category_id IS NULL` and nothing else — there is no seeded row called
"Other" that a user could rename, recolour, or accidentally delete, and the
grouped dashboard always draws its trailing section even when it is empty,
the same way a day with no row at all is still drawn as `unknown` rather than
silently becoming a fourth kind of `no`. Making it a real row was briefly
attractive because it would let the DB `NOT NULL`-constrain `category_id` and
make every habit's category "an id, always" — and was rejected because a real
row is a category someone can act on, and this one must not be actable on.

**Default categories are not seeded, on purpose.** Six empty sections on a
fresh account, before a single habit has been sorted into any of them, is
noise rather than help — an empty section with a header is exactly the
"nothing folds, sections may be empty" model working as intended, just with
nothing in it yet and no habits to justify the header. The six common names
(Health, Work, Fitness, Mind, Social, Home) ship instead as suggestion chips
in the habit dialog's category picker, each with its own default colour so a
freshly grouped dashboard is not six identical-looking headers, and a chip
only creates its category the moment it is tapped.

**A category's own colour and declared position are carried faithfully by
exactly one backup format, and that is a per-format fidelity gap like every
other one this project already keeps a list for — not a bug in the other
two.** A habit's `category` field is a NAME, and the three formats disagree
about whether there is anywhere else to put the rest of what a category is:

- **Loop's `.db` carries no concept of a category at all.** There is no
  column and no table for one, so a `.db` round trip correctly returns every
  habit to uncategorised — the same asymmetry `icon` and `at_most_unlogged`
  already have against this format, for the same reason (nowhere to write
  it down).
- **The CSV pair carries the ASSIGNMENT only.** `buildHabitsCsv` writes a
  `Category` column of names, and `parseLoopHabitsCSV` reads it back — so a
  habit's grouping survives — but the archive has no second file for
  categories themselves, so `backupCategories` answers `null` for a zip and
  neither colour nor position travels with it. Both import routes pass `[]`
  in that case, and `resolveOrCreateCategory` invents each restored category
  fresh: `DEFAULT_COLOR`, and whatever position it happens to be met in while
  habits are being restored. Export an account with Health `#10b981` and
  Fitness `#f59e0b`, restore that zip in replace mode, and both come back
  `#3b82f6` in a different order — the section headers survive as headers,
  correctly grouping the same habits, but distinguishable no longer.
- **The JSON backup is the only format that carries a category's colour and
  its declared `position`,** as a `categories` array alongside `habits` — so
  "a replace applies the file's own list, including each category's declared
  position" is a claim about THIS format and not the other two. A replace
  restore of a JSON backup is the one round trip where Health and Fitness
  come back the colours and the order they were exported with.

This is a documentation gap, not a behaviour one — `Habits.csv` is Loop-shaped
on purpose (see the `.db`/CSV split above and `shared/CLAUDE.md`'s import
rules), and widening it with a colour column is a bigger cost than the loss.
What was wrong is that the CSV gap went unwritten while the code shipped
claiming a category "restores" without saying which of its three properties
that verb covers for which format. `shared/test/roundtrip-fixture.mjs`'s
`CSV_HABIT_FIELDS` comment states the same rule where the round-trip suites
that would otherwise let it drift can see it.

**The duplicate-name check is a route-level `foldCategoryName`, with the DB
constraints kept only as backstops.** SQLite's `NOCASE` collation folds ASCII
case only; Postgres's `lower()` is Unicode-aware. Concretely, `UNIQUE(name
COLLATE NOCASE)` in `habiterall-personal/src/db.js` treats `Élan` and `élan`
as two different categories, while `UNIQUE (user_id, lower(name))` in
`habiterall-cloud/src/db/migrations/015_categories.sql` treats them as one.
That is exactly the class of edition divergence `shared/src/validate.js`
exists to prevent — the same input succeeding in one edition and failing in
the other, silently, depending on which database happens to be running. So
`foldCategoryName` is one function in shared code (`String(name ??
'').trim().toLowerCase()`) and both editions' routes look up
`categoryByFoldedName` / `WHERE lower(name) = lower($1)`-equivalent through it
before ever reaching the `INSERT`.

That draws the SAME line for every input the two DB-level constraints can
tell apart — it does not make the two editions agree for every input, full
stop, and nothing here should be read as claiming it does. `toLowerCase()`
and glibc's `lower()` are two independent implementations of Unicode case
folding, and U+0130 (İ, LATIN CAPITAL LETTER I WITH DOT ABOVE) is where they
part: JS's `toLowerCase()` answers `'i̇'` — a bare `i` plus a combining dot,
U+0069 U+0307 — while glibc's `lower()` answers a bare `i`, U+0069 alone.
Importing `İstanbul` into an account already holding `Istanbul` therefore
folds to two different strings under `foldCategoryName` and to the SAME
string under Postgres's `lower()`: the route-level lookup misses the existing
row and tries to create a new one, and in cloud that INSERT is what walks
straight into the `lower()`-backed unique index as a genuine collision —
caught as a 409 by the route, or as a constraint violation `apply-import.js`'s
own savepoint has to roll back cleanly for. Personal has no such backstop for
this pair (`NOCASE` is ASCII-only and does not see `İ` vs `I` either), so the
same import there creates a second, genuinely distinct category. Not a bug in
`foldCategoryName` to fix — a fold agreeing with both databases on every
codepoint at once does not exist to reach for — but the reason the INSERT
path has to survive a collision cleanly rather than assume the route-level
check already ruled one out.

That is plain `toLowerCase()`, deliberately never `toLocaleLowerCase()`. A
first version of this reasoned the other way round — "`toLocaleLowerCase()`
for the same Unicode-aware folding Postgres's `lower()` already does" — and
that reasoning was backwards. `toLowerCase()` with no locale argument is
*already* full Unicode Default Case Conversion (`'É'.toLowerCase() ===
'é'`); the only thing a locale argument adds is host-locale TAILORING —
Turkish and Azeri's dotless `ı`, Lithuanian's accent-sensitive casing — which
is wrong in both directions at once here. It makes the same account fold
names differently depending on which server happens to answer a request, and
it is a *looser* match to Postgres's locale-independent `lower()` and
SQLite's `NOCASE` than the plain, locale-free form already is. Plain
`toLowerCase()` is the closer match, not the looser one.

The DB-level `UNIQUE` constraints stay, but only as a backstop against a race
between two concurrent requests passing the route check at once, or against
`foldCategoryName` disagreeing with a constraint it is only an approximation
of (NOCASE's ASCII-only fold, in personal's direction). A duplicate that
reaches the constraint is caught and answered as a **409**
(`isCategoryNameConflict` in each edition's storage module,
`habiterall-personal/src/db.js` and `habiterall-cloud/src/db/pool.js`), matched
on the driver's own report of *which* constraint fired — node:sqlite's error
code plus the column named in its message, Postgres's `23505` plus
`err.constraint` — rather than allowed to surface as that constraint's own
500. `resolveOrCreateCategory` in both editions' `apply-import.js` catches the
same conflict, because that INSERT runs inside the whole import's one
transaction and an uncaught constraint violation there took every habit and
entry down with it, not only the category that collided. Note which way round personal's asymmetry actually runs: the ROUTE is the
stricter of the two, because `toLowerCase()` folds the whole of Unicode while
`NOCASE` folds ASCII alone — so `Élan` and `élan` are one category to the
route and two to the constraint. The consequence is that in personal the
constraint can only fire on a genuine RACE: any pair NOCASE would reject
differs by ASCII case alone, and that is a pair `foldCategoryName` has already
refused. The 409 mapping there is live for the race and otherwise unreachable
through any single request — measured, by removing the route's own duplicate
check and watching every existing assertion still pass. In cloud it is
reachable both ways, because `lower()` and `toLowerCase()` are two
implementations of Unicode case folding rather than one, and they need not
agree on every codepoint.

**The browser holds no copy of that fold, and the suggestion chips are what
made one tempting.** A chip is a shortcut — tap `Health` and get a category
called Health — so the obvious behaviour when the account already holds that
name in some other casing is to hand back the existing row and select it. That
needs the client to answer *which stored name IS this one*, which is
`foldCategoryName`, and `shared/src` is not served to the browser
(`shared/CLAUDE.md`), so having the answer in `habit-dialog.js` means writing
the rule out a third time by hand. A first version did exactly that
(`name.trim().toLowerCase()`, in a `useOrCreateCategory` helper) and called it
unavoidable. It is not: what is unavoidable is the *import*, not the copy.

The rule for a hand-copied rule is the one in the root `CLAUDE.md` — a client
mirrors a rule only if it must work OFFLINE — and this one fails it in the
plainest possible way. The branch is reached only after a 409 from
`POST /categories`, i.e. only when a server that has already computed the
answer has just replied; offline the POST is queued and throws `err.queued`
instead, so the code could never run on a device with no network. A mirror
that cannot be reached offline is buying nothing that a round trip does not
already provide, and costing the standing price of every copy: when
`foldCategoryName` next changes, nothing fails if this line is missed. It
already changed once during this work — `toLocaleLowerCase()` to
`toLowerCase()`, above — which is the whole argument in one event.

So the chip POSTs, and on a 409 it says *"Health" already exists — pick it
above to use it* and refreshes the picker, which is what puts the existing
category in the list if it was created on another device. One extra click, for
a name the account already has, in exchange for the rule living in one file.
The two alternatives that would remove even that click both cost more than it
is worth: returning the conflicting row in the 409 body means teaching
`api()` to stop discarding response bodies (it throws `new Error(body.error)`
and keeps nothing else), which is a shared-surface change reaching every
caller in the app; and resolving server-side with a `POST /categories?upsert`
is a second way for one route to mean two things.

**`CACHE_VERSION` moved to `v24` even though no file was added under
`shared/public/`.** The usual trigger for a bump is a new file joining `sw.js`'s
`SHELL`, which did not happen here. What did happen: `index.html` gained the
category `<select>`, the suggestion chips, and the manage list inside
`#habit-form`, and it is itself one of the files in `SHELL`. `shellFirst` is
stale-while-revalidate — it serves whatever is in the cache immediately and
updates the cache in the background — so an already-installed client can
serve the OLD `index.html` (no category controls in the form) against the NEW
`habit-dialog.js` (which expects `form.category_id` to exist and reads from
it unconditionally). That is not a missing feature, it is a broken one: the
dialog's open handler throws reaching for a control that is not in the DOM,
which the same class of bug the bump exists to prevent has always looked
like. The fix is the same one-line lever the root `CLAUDE.md` already names —
bump the version, force every client to fetch the new shell as a unit — used
here for the first time for an HTML change rather than a new script.

**Phase 3 defines no category-level score formula, and that is not an
oversight — there is no coherent one to define.** The per-habit score in
`shared/src/stats.js` is an EWMA whose decay constant is
`0.5^(sqrt(frequency)/13)`: the `sqrt(frequency)` term is precisely what makes
a daily habit and a 2×/week habit comparable on the same 0–100% scale despite
being asked to happen at different rates. A category is a set of habits that,
in general, do not share a frequency — "Health" might hold a daily walk and a
weekly long run. There is no single frequency to hand that formula for the
category as a whole, and averaging the members' scores answers a different
question ("how are these habits doing on average") than the one a
category-level score would imply ("how strong is this category"), quietly
inheriting whatever cardinality bias comes from some categories having two
habits and others having twelve. Nothing in phases 1–2 forecloses solving
this — `GET /api/categories/stats` and any aggregation belong to a separate
PR, and #65 stays open on phase 3 for it — but shipping a formula now would
have meant picking an answer to a question this change was not asked to
answer, and picking the wrong one is harder to walk back once a chart has
been drawn from it.

**Both category text boxes live inside `#habit-form`, so Enter had to be
routed rather than left to the browser.** The picker manages the account's
categories in place — a section header is not worth a screen of its own — and
that puts the "New category" name box and every rename box inside a form whose
Save button is a `type="submit"`. Enter in either of them is therefore an
implicit submission, which is the browser doing exactly what the markup says:
the dialog closed, the HABIT was written, and the category just typed was
never created. From the create form it was worse than lossy — it invented a
whole habit out of the form's defaults, because Enter does not wait for the
rest of the form to be filled in. Nothing reported any of it: `saveHabit`
succeeds on its own terms, and `#category-hint` is written only by the
category handlers, so the one surface that could have said something stayed
blank. `enterPresses` (`ui/habit-dialog.js`) sends the key to the button
beside the box instead of calling `preventDefault` alone — a box where Enter
does nothing is its own bug report, and Enter after typing a name is the
gesture rather than an edge case. It is wired at `init` for the new-category
box and inside `renderCategoryManage` for a rename box, because the second is
built fresh on every ✎.

Worth knowing before pinning anything like it: the browser only does implicit
submission for a TRUSTED keypress, so a `new KeyboardEvent('keydown')`
dispatched from script does not reproduce it at all and a test built on one
passes against the unguarded code. `categorycheck`'s round-6 block drives CDP
`Input.dispatchKeyEvent` for that reason.

**A reorder id has to be the shape of an id, not merely coerce to one.**
`POST /categories/reorder` asked `Number.isInteger(Number(n))` of every entry
in both editions — tightened from `isFinite` in an earlier round precisely so
a fractional id could not report success and move nothing. It left the same
hole one spelling over: `Number()` answers 0 for `null`, `''` and `[]`, 1 for
`true`, and 7 for `[7]`. Id 0 matches no row, so the request answered 200
having moved nothing; id 1 and a nested real id are rows that exist, so the
request moved a category nobody had named. In the personal edition that is any
category; in cloud RLS narrows it to one of the caller's own, which makes it a
wrong write rather than a cross-tenant one — the nested spelling is the case
that reaches a real row there, and is what that suite asserts behaviourally.
`parseCategoryId` (`shared/src/validate.js`) is the one shape rule now, asked
by both editions' reorder routes and by both copies of `categoryId(req)`; it
gates on `typeof` first, so those spellings are unrepresentable rather than
filtered one at a time. It is deliberately NOT the rule `parseHabit` applies to
`body.category_id`, which refuses a numeric STRING: there the id arrives in a
JSON body where a number is the only honest spelling, and here it arrives as
text by construction.

## Phase 2's Android half

Issue #65 also asked for the native client to draw the grouped list and offer
a category picker, landing after phase 3 and covering only the Android app —
no route, schema or migration changed on either edition, and `shared/public`
was untouched (the web grouping already shipped above). `android-native/CLAUDE.md`
carries the operative rules; this is the reasoning behind the two calls that
were made rather than the ones the issue text originally asked for.

**Options come from `/overview`'s `categories`, not a new `GET /categories`
call.** The issue text asked for the latter. Both editions' `/overview`
already return the account's categories — `habiterall-personal/src/api.js`'s
`categories: q.allCategories.all()`, and cloud's own `/overview` on both its
early and its main return path — and the list screen (`MainActivity.kt`'s
`HabitListScreen`) already makes that call to draw the grid. A second fetch
just for the form would be free to disagree with what the list just drew from,
for no benefit: the form only needs the same list, not a fresher one, and
`Api.kt` gained no `categories()` method.

**The picker picks only.** It offers the account's existing categories, read
off `/overview`, plus an explicit "None" — never a way to create, rename,
recolour or delete one. Those stay web actions, the same stance this client
already takes toward habit icons: a rendering gap, not a data gap. Nothing
here ports `foldCategoryName`, `LIMITS.categories`, the suggestion chips or the
409 duplicate-name answer to Kotlin.

**The picker inherits, and does not fix, the silent-clear hazard #251's web
habit dialog shipped.** A habit whose `categoryId` names a category not in the
list the form was handed — deleted since the last fetch, or the form opened
before any fetch succeeded — must not draw "None" as selected, because saving
without touching the row would then clear a category nobody chose to clear
through `PUT /habits/:id`'s replace semantics. `CategoryPicker`
(`ui/HabitFormScreen.kt`) draws that id as its own extra, disabled, selected
chip instead, so losing a category takes an explicit tap on "None" or another
chip. `selectedId == null` is the only condition that selects "None".

**Grouping the `LazyColumn` turns a habit's index into something a habit count
can no longer answer.** `HabitSections.rows` (new,
`ui/HabitSections.kt`) is a pure partition — ungrouped it is
`habits.map(ListRow::Entry)` and nothing else; grouped it interleaves a
`ListRow.Header` per category, in the order `/overview` sent them, plus an
always-present trailing Uncategorised header, with a habit whose category was
deleted since the fetch falling into Uncategorised rather than being dropped.
It mirrors `shared/public/ui/dashboard.js`'s grouped branch (`:315-330`) so the
two clients draw the same sections from the same input, but it is explicitly
not a sixth mirror: `HabitFilter`'s own KDoc gives the reason it reuses — a
mirror exists so two clients agree about a value that reaches storage, and a
partition that only decides where a habit is drawn reaches none. Once headers
are items, though, `ScrollRestore` and the notification-focus effect in
`ui/HabitList.kt` had to stop reading `visible`'s size and index and start
reading `listRows`'s — the item count is no longer the habit count, and a
habit's position in `visible` is no longer its position in what the
`LazyColumn` holds. `android-native/CLAUDE.md` now carries this as the
specific shape of the "four bugs lived one line below a correct pure function"
lesson it names elsewhere.

**Reorder does not disable while grouped, unlike the web.** `dashboard.js`
disables dragging under `grouped` because its drag writes a flat id list that
would then be read back as the grouped order. Android's reorder is a separate
full-screen `ReorderScreen` handed the unfiltered, ungrouped `habits` in the
server's own position order, so that hazard cannot reach it — `HabitList.kt`'s
`enabled = habits.size > 1` on the reorder hand-off was left exactly as it
was.

Two small things landed alongside the above, neither planned but both
small enough to fold in rather than defer: the section header's count reads
"1 habit" / "N habits" rather than always pluralising, and `SwitchRow`'s
`Switch` (`ui/SettingsScreen.kt`) now carries `contentDescription = title` —
without it, a `Switch` beside a sibling `Text` is not labelled by that text,
and TalkBack announced every one of the settings screen's five switches,
`groupByCategory`'s new one included, as a bare "off, switch".

## Phase 3 — comparing categories

`computeCategoryStats` in `shared/src/stats.js`, one
`GET /api/categories/stats` per edition, and a comparison view at
`#/categories`. Three decisions carried the whole design; the operative form of
each is in `shared/CLAUDE.md` and `shared/public/CLAUDE.md`.

**The paragraph above stands: there is still no category-level score formula,
and what shipped is not one.** Phases 1–2 recorded two objections to defining
one, and only the first is fatal. The first is that `0.5^(sqrt(frequency)/13)`
is what makes a daily habit and a 2×/week habit comparable at all, and a
category has as many frequencies as it has members — so there is no argument to
hand `computeScores` for a category, and nothing to build a formula out of. The
second objection was that averaging the members answers a different question
("how are these habits doing on average") than a category score would, and
inherits a cardinality bias from some categories holding two habits and others
twelve. That is true, and it is the reason the average is shipped **as an
average** rather than corrected into a score: `mean` never travels without
`members` beside it, and `best`/`worst` name the two ends of the spread, so a
reader of a two-habit category can see that it is a two-habit category. A
weighting chosen to cancel the cardinality bias would be a category score
arriving by the back door, picked to make one number look right, and it is
exactly the thing that is hard to walk back once a chart has been drawn from
it. Equal weight per habit is the claim the view makes out loud; per-entry
weighting was refused in the same breath, because it lets one daily member
drown a weekly one while looking like a fairness improvement.

**The score window needs a 400-day warm-up, and that is a fact about
`ui/detail.js` rather than about the arithmetic.** `computeScores` starts its
EWMA at `score = 0` on the first day of the range it is handed. A habit's own
page sends **no `start`** to `/habits/:id/stats`, so the number there is always
converged from the habit's first entry; a comparison starting cold at the
requested `start` therefore reports every habit weaker than its own page does,
by an amount nobody can explain from either screen. Two surfaces disagreeing
about the same habit is indistinguishable from one of them being broken, and it
is the user who has to decide which. So each member's series is computed over
`[start - SCORE_WARMUP_DAYS, end]` and sliced back to `[start, end]`, with
`SCORE_WARMUP_DAYS = 400` — the number both editions' `/overview` already
spends on the same problem as `SUMMARY_WINDOW_DAYS`, declared once in
`stats.js` and imported by both routes rather than spelled twice.

**And it is clamped forward to the member's own first entry, which the first
version was not.** The same sentence that justifies the warm-up justifies the
bound on it: a habit's own page opens at `start ?? firstEntry`, so a comparison
reaching back further is scoring the member over a window it never had. That
costs nothing on an at-least habit — the phantom days before it existed credit
0, so both surfaces agree either way, and every category fixture in
`shared/test/stats.test.js` was one of those, which is why 91 tests passed with
the clamp and without it. Under `at_most_unlogged: 'success'` an unlogged day is
**full** credit, and that setting covers every `show_as: 'avoid'` habit when the
account chooses it. Measured on this branch: an avoid habit with target 0 and a
single slip logged ten days ago reads **0.41327** on its own page and
**0.969536** on an unclamped comparison, while an at-least habit of the identical
shape reads **0.030464** on both. Not an edge case — that is every limit habit's
opening state, for its first ~430 days, on the screen that exists to compare it
with others.

The clamped date is normalised **after** the clamp, never before, for exactly
the reason `resolveWindow` writes out at length: `toISO` pads the month and the
day and not the year, so normalising `0999-12-31` yields `999-12-31`, which
sorts above `2026-…` and walks past every bound. Clamped first, the value is
already inside the window before anything reformats it. `landedAt` then reads
that normalised date rather than the raw `firstEntry`, because the clamp is what
put the two in contact and they did not agree: `computeScores` normalises the
start it is handed (a walk from `2026-02-30` begins on `2026-03-02`) while the
landing rule compares strings and admitted `2026-03-01`, a bucket with a member
and no score point behind it. That summed an `undefined` into NaN, serialised as
`null`, and `ui/categories.js`'s `p.value !== null` filter dropped the vertex —
so the line lost a point and said nothing about it. `mean` survived, because the
last bucket's day is `end`, long past the gap. A phantom day never happened, so
the member lands on the real day the walk reaches instead; `unloggedExcluded` is
unmoved, since the member has an entry whatever it is dated.

What makes this worth writing down at length is how easy it is to remove
without noticing. Measured on this branch, by setting `SCORE_WARMUP_DAYS` to 0
and back: a daily habit logged on 82% of its days for three years scores
**0.79** on its own page. Compared over a **20-day** window it reads **0.79**
with the warm-up and **0.52** without it — a quarter of the scale, on the same
habit, on two screens a tap apart. Compared over a **365-day** window it reads
**0.79 either way**, because a year of real history swamps a cold start
whatever it began at. 365 days is what `COMPARE_WINDOW_DAYS` opens for a caller
that names no `start`, which is to say the ordinary request cannot see this at
all: only an explicitly short `start` falsifies it. That is why the suite's
window is 20 days rather than the route's own year, and why a test written
against the default would have passed against code with the warm-up deleted.

**The comparison links to no habit, and that is two constraints rather than
one.** `ui/routes.js` tracks `ourEntry` as a single boolean and `go(LIST)`
reaches the dashboard with one `history.back()`, so the app is exactly one
fragment entry deep at all times; `android-native/CLAUDE.md`'s back-stack
section states the assumption that rests on it — *"that unwind assumes the
entry underneath a habit is the dashboard"*. dashboard → categories → habit
would be two entries of ours, and Back from that habit would land on
`#/categories` with the dashboard painted underneath it, which in the WebView is
the system back gesture. So `best` and `worst` are named as text and linked to
nothing, **and** the top-bar button is hidden whenever a habit is open — the
second is what stops a habit sitting under the comparison by the other route.
Either alone leaves the invariant reachable; together they make the state
`ourEntry` cannot describe unreachable rather than merely unlikely. The honest
statement of the cost is that a name in the spread is a name you then have to
find on the dashboard, and that is accepted until `routes.js` has a real stack.

**Making `go()` REPLACE for this route is the fix that looks like it works.**
It removes the second entry, which is the stated problem, and it is wrong on
the client that matters: a same-document open still counts an entry in
`WebBackStack.floorAfterShow`, so replacing leaves `currentIndex` at the floor
and the next system Back closes the screen out from under a user who opened a
habit from a notification. `android-native/CLAUDE.md` requires all three
back-stack rules to be re-read together and verified on an emulator whenever
`go()` changes, and records that **every wrong version still passes
`WebBackStackTest`** — so the browser suite going green here is not evidence
about that path. `go()` was left alone.

### What phase 3 refused

- **`MAX_RANGE_DAYS` as the ceiling.** It bounds a route that walks one habit;
  this one walks every habit in the account, so the same span costs the habit
  count times as much — at 50 habits, ~385,000 synchronous day-steps before the
  warm-up is added, the order of the year-0100 entry the root `CLAUDE.md`
  records blocking the event loop for 32 seconds. `MAX_COMPARE_DAYS` is 1830,
  which is what `STREAK_HISTORY_DAYS` already is.
- **Defaulting the window to that ceiling.** It would make the plainest
  possible request the most expensive one the route can answer.
  `COMPARE_WINDOW_DAYS` is 365 and a caller who wants five years asks for it —
  the shape `/overview` already has, where `days` defaults to 30 against a cap
  of 365. Both constants are shared for the same reason the warm-up is: a
  ceiling that drifted would have one edition refuse a URL the other served,
  and a default that drifted would have them answer one `start`-less URL with
  different bucket counts.
- **Filtering archived habits in SQL.** `archivedExcluded` is what lets the
  view say what it left out, and a pure function can only report it from the
  members it was handed — filtering in the query would make that figure
  permanently 0 while looking like an optimisation.
- **Deriving each member's first entry from the fetched slice.** The route
  fetches from `start - 400 days`, so a habit last logged before that comes
  back with no rows — and "has never been logged" and "has nothing in the
  window I happened to fetch" are different facts that the landing rule treats
  oppositely. An abandoned habit has a genuine strength near zero and belongs
  in the mean; a never-logged one has no strength to average. The lifetime
  `MIN(date)` is one grouped query, and it is supplied per member.
- **Counting an unlogged member as 0** — in the mean, in the spread, or in a
  bucket of the series. A habit with no strength yet is undefined, not zero,
  the same claim `recovery.rate === null` already makes; averaged in as zero, a
  new habit reports that your health got worse on the day you decided to do
  more about it, and a habit added in March draws the category as having been
  half as good all January. It is counted into `unloggedExcluded` instead, and
  a null recovery rate into `recoveryExcluded` — two counts that overlap on a
  never-logged member and agree about nothing else.
- **A query per habit.** `shared/CLAUDE.md` records what that shape cost the
  importer (13.5 seconds on one file), and this route would run it against
  however many habits an account has. Entries are one `SELECT` bucketed into a
  Map, exactly as `/overview` reads them.

## Phase 4 — a summary on the grouped dashboard's own headers (#65)

**"No new endpoint" was true about the arithmetic and false about the rule.**
Phase 3 already computed a mean, a spread and an `unloggedExcluded` count for
`#/categories`; putting the same three figures on a grouped section header
therefore looked like reading numbers already on the wire. It is not:
`computeCategoryStats`'s `section()` closure decided which members count
towards that mean, and until this phase its only caller was the comparison
route itself. `/overview` is a different route with a different payload, and
copying the ARITHMETIC into it rather than the RULE would have re-created
exactly the failure this project has already paid for once, in
`foldCategoryName` — two implementations of the same decision, agreeing today
and free to drift the moment one of them changes. `summariseMembers`
(`shared/src/stats.js`, beside `extremeMember`) is that arithmetic pulled out
of `section()`'s closure with nothing about it changed; `summariseByCategory`
is the partition rule beside it — a `category_id` naming no known category
falls into Uncategorised, and Uncategorised (`id: null`) is always present,
even with no members — pulled out a second time so both editions' `/overview`
call the one function rather than each restating that sentence for itself.
`section()` and `summariseByCategory` are now both callers of
`summariseMembers`, and both ask the same RULE for which members are landed:
has this member landed by the day being read, not merely does it have an
entry at all. That is agreement about the rule rather than about the date —
`section()` asks it of `landsOn`, `firstEntry` clamped forward to the
member's warm-up start and then normalised, while `summariseByCategory` asks
it of the raw lifetime `MIN(date)` a route reads straight off storage.
`summariseByCategory` did not carry a reading day at first, and asked only
whether a member had an entry AT ALL — so a habit whose only entry was
dated after the day `/overview` was reading (a write from a device ahead in
time, then a read from one behind it) counted as landed, and its `score` for
that day is 0 with nothing behind it: `resolveWindow` clamps `from` to `end`
for a member that has not started yet, and `computeScores` walks a single
day with no entry on it. Averaged in, that reported 16% for a two-habit
category against `#/categories`' 31% with the same habit correctly excluded
— the exact failure this phase exists to prevent, arrived at through the one
input `section()` never has to ask about: whose "today" a write happened
under.

**The never-logged exclusion cannot be reconstructed in the browser, which is
why it has to be computed server-side and merely drawn client-side.**
`summaryStats` — what `/overview` already calls for each habit's `score` —
answers `0` for a habit with no entries at all, the same number it answers for
one logged with only stated lapses (`value: 0`); `totalCompleted` counts
completions rather than answers, so it cannot tell the two apart either. A
renderer holding only that payload has no way to ask "has this habit ever been
logged" — nothing on the wire says so — which is the premise check this phase
opened with, and the reason the exclusion could not simply move into
`dashboard.js` alongside the rest of the header. The grouped lifetime
`MIN(date)` query (`q.firstEntryPerHabit` in personal, the same
`to_char(MIN(date), 'YYYY-MM-DD')` shape in cloud) already ran for
`/categories/stats`, so `/overview` reads the same query rather than inventing
a second way to ask the same thing; the date it returns never reaches
`addDays`, `dateRange` or `boundedRange` — a null check only, the same
constraint the header comment on `computeCategoryStats` already put on
`firstEntry` there.

**`categorySummaries` is absent, never empty, under `?archived=true`** — the
same opt-out shape `coverage` already has on `computeStats`. An empty array
would claim every category holds nobody worth averaging; the truth is that
mode fetched only archived habits and has nothing active to say anything about.
`dashboard.js` tolerates the key's absence for a second reason besides: an
older cached payload, served by `shellFirst`'s stale-while-revalidate before
the client's next fetch lands, may carry no such key either.

## Phase 5 — giving `POST /categories/reorder` a caller (#65)

**The route existed and was fully tested before anything called it.** Both
editions validated every id through `parseCategoryId`, capped at
`LIMITS.categories`, wrote inside a transaction and returned the full list —
and `grep -rn "categories/reorder" shared/public/ android-native/` returned
nothing. `position` was already honoured everywhere it is read (`ORDER BY
position, id`, and a create's `COALESCE(MAX(position) + 1, 0)`); this phase
gives it a writer, not a new rule.

**Buttons, not drag-and-drop.** `attachDragHandlers`'s own comment on the
habit list already states the reason: HTML5 drag events are unreachable by
keyboard and unreliable on touch. The manage list is a `<dialog>` inside a
`<form>`, capped at 30 rows with `max-height: 160px; overflow-y: auto`, which
is a worse surface for a drag gesture than the dashboard's own uncapped grid
— so the argument that already ruled drag in for the habit list rules it out
here twice over.

**Three disable rules, and the third is the one worth explaining.** The first
two are ordinary boundary conditions: no arrows at all under two categories
(the same gate `reorderable` uses for the dashboard's own drag handle), and
the first row's ↑ / the last row's ↓ disabled because there is nowhere left to
move to. The third — every arrow on every row disabled while a row is
mid-rename — exists because `repaintCategories` *deliberately* refuses to
rebuild the manage list while `editingCategoryId != null` (a rename box is a
live `<input>` a rebuild would tear out from under whoever is typing in it,
the same failure mode `shared/public/CLAUDE.md` documents for the settings
dialog). An arrow left enabled there would send a write and repaint
**nothing**: the row stays exactly where it was, with no sign on screen that
the click did anything — silent, which is the failure class this repo names
most often. Disabling it is not a UX nicety layered on top of the rebuild
guard; it is what keeps a press from being a write with no visible effect.

**`moveCategory`'s `catch` keeps the optimistic order on `err.queued`, and
`persistOrder` (the habit list's own reorder, `dashboard.js`) does not.**
`/categories/reorder` is `replayable()` — everything but `POST /habits` — so
offline the write is already staged before the throw and **will** land on
reconnect; reverting the optimistic order would snap the list back from an
order that is about to be applied anyway. `persistOrder` reverts
unconditionally, `err.queued` included, which is a real, pre-existing defect
in the habit list's own reorder (tracked separately, not fixed here — this
phase's own version is deliberately not a second copy of it).

**The post-move focus restore had to run twice, not once, and the second one
needs a guard the first does not.** `moveCategory` does an OPTIMISTIC
`repaintCategories()` before the write, and `restoreFocus` after it walks
fine — until `refreshCategoryPicker`'s own GET lands and runs a **second**
`repaintCategories()` from the server's answer, whose `renderCategoryManage`
does `list.replaceChildren()` and drops focus to `<body>` with nothing to
restore it. Left alone, holding ↑ only "walks a category up" for as long as
presses outrun the fetch; at an ordinary human pace every press lost focus,
which is exactly the defect the first restore was written to fix and reads as
fixed until it is tested against the SECOND repaint rather than the first.
The second restore is conditional — `document.activeElement == null ||
document.activeElement === document.body` — because by the time the GET
lands the user may have deliberately moved focus elsewhere (to Cancel, to a
different row's own control), and stealing it back would be a new bug rather
than a fix for the old one. `shared/test/browser/categorycheck.mjs` asserts
both halves: that focus survives the refetch's own repaint (polled by node
identity, since the button's `data-focus-key` is identical across both
repaints and only the DOM node itself changes), and that the guard actually
holds when focus is moved away before the refetch lands.

**The manage row had to be checked at 360px, not assumed to fit.** Four
controls (swatch, name, ↑, ↓) plus the pre-existing ✎ and ✕ share one row whose
only flexible member is `.category-manage-name` (`flex: 1; min-width: 0`,
already ellipsising); everything else is `flex: none`, and `.btn-icon`'s
padding inside this row is tighter than the ordinary icon button's so six
controls fit at 360px. `shared/test/browser/responsive.mjs` asserts FIT —
nothing pushed past `.category-manage`'s own right edge, and the name kept
non-zero width — rather than the 44px `MIN_TOUCH` the rest of that suite
checks elsewhere: `.btn-icon`'s existing `padding: 7px 10px` for ✎ and ✕ is
already smaller than 44px, so a touch-size assertion here would fail on
controls this phase did not add.

**Left alone, on purpose, and named rather than fixed:** the reorder payload
names only the category ids the client currently holds, so a category created
on another device since this dialog's own fetch keeps whatever position it
already has — the route's existing semantics, not a new limitation. And rapid
presses put several WRITES in flight at once, each carrying the full order at
the moment it fired; `persistOrder` has the identical exposure for the habit
list, so this does not invent a new mechanism the app was not already living
with.

The concurrent READS are a different matter, and that inheritance argument does
not cover them — see "Two presses race each other's reads" below, which is the
finding that took the claim apart.

**`moveCategory` does not call `announce()`, and that was found in review
rather than designed in up front.** It shipped emitting `announce()`'s
`'reload'` like the dialog's other four category mutations, which is the
event `ui/store.js` defines as "go to the dashboard and fetch it" —
`dashboard.js` answers it with `load()`, which re-fetches `/overview` and
overwrites `state.categories` from that reply (`dashboard.js:173`) before
ending in its own `paint()`. That is a SECOND writer of the same field
`refreshCategoryPicker`'s `GET /categories` had just set, carrying whatever
order was current when the `/overview` request went out — and nothing
repaints the manage list itself from either answer. The failure needs no
exotic timing: press ↓, the reorder's write and its own refetch land,
`'reload'` fires `/overview`; press ↓ again before THAT lands, which is the
ordinary gesture for moving a category more than one slot, and the older
`/overview` order lands on top of the newer one the manage list is already
showing. For about a round trip every arrow is then wrong, because
`moveCategory` computes its next move from the store while the user is
pressing a row in the DOM they can see: one press hits the bounds check and
silently does nothing, another vaults a category two rows and persists an
order that discards the previous press.

`'reload'` was simply the wrong event for this mutation, not a mutation this
event needed to learn to tolerate. A reorder creates no habit, destroys none
and moves no figure — the dashboard already draws its section order straight
from `state.categories`, and `categorySummaries` (phase 4, above) is looked
up by category id, so order does not reach it either. There is nothing here
for a fetch to be FOR. `'change'` is sufficient because every listener that
matters already redraws from `state.categories` as it stands: `paint()`
(`dashboard.js`) does, with no request of its own, and the manage list and
picker are repainted directly inside `moveCategory` regardless of which event
it ends in. Emitting `'change'` unconditionally — not routed through
`announce()`'s dashboard-showing check — costs nothing extra either: the
other four mutations already fall back to `'change'` whenever the dashboard
is not what is showing, and a reorder can only be initiated from the manage
list this dialog itself draws, which needs no event at all to see its own
write.

What this does **not** do is retire `/overview` as a writer of
`state.categories`. `announce()` still sends the dialog's four other category
mutations through `'reload'`, so a `load()` can still be in flight when an
arrow is pressed — see the fourth bullet under "Two presses race each other's
reads" below, which is the review round that found it. Changing the event was
right and was never the whole answer.
**Two presses race each other's reads, and the last answer to arrive used to
win regardless of which was freshest.** The arrows are deliberately not
disabled while a write is in flight — that is what lets a category be walked
several rows without waiting on a round trip between presses — so two
`moveCategory` calls overlapping is the ordinary gesture rather than an edge
case. Each was independent end to end: its own POST, then its OWN
`GET /categories`, whose reply was assigned to `state.categories`
unconditionally. Nothing sequenced the two and no reply carried anything a
later one could be checked against.

The reasoning that let this ship was the paragraph above — "`persistOrder` has
the identical exposure" — and it is true of the WRITES and false of the READS.
`persistOrder` never refetches after its own write: it trusts the optimistic
order or reverts to the pre-write snapshot, so it structurally cannot race a
second call's read. The per-press GET is a mechanism the habit list has no
counterpart for, which is why there was no answer here to inherit.

What it costs is not merely a display: press three computes its whole payload
from `state.categories` as it stands, so a stale list is POSTed straight back
and **the server's own order ends up wrong too**. There is no error, no hint
and no repaint anybody would read as a failure.

`state.categoryReadSeq` (`ui/store.js`) is a monotonic counter, and it is four
halves that fail differently. It shipped as two, module-local to
`ui/habit-dialog.js`, and the next review round found both of the others —
which is the whole argument for where it lives now. **A ticket protects a
FIELD, so it belongs beside the field**: `state.categories` is written from
two modules, and the counter parked next to one of its readers could not see
the other one at all.

- **`refreshCategoryPicker` takes a ticket and may only INSTALL its answer if
  that ticket is still the current one.** A superseded read still repaints —
  from whatever the store holds now, which can only re-confirm what is there —
  because an awaiting caller (the rename handler's `editingCategoryId = null`,
  say) would otherwise be left with controls that do not match the state
  behind them. The assignment is the half that can be stale.
- **`moveCategory` bumps the counter at its optimistic splice**, which retires
  every read already out on the wire. This is *not* covered by the first half,
  and that is the part worth remembering: the read in flight is often
  `openDialog`'s fire-and-forget `refreshCategoryPicker()`, fired before any
  press existed, and at the moment it lands the press's own read has not
  STARTED — its POST is still out. Nothing newer has taken a ticket, so
  without the bump that pre-move answer paints the optimistic move away. It
  needs no response reordering at all, only the dialog's own GET being slower
  than the first press on it, which is an ordinary open-and-press.
- **`load()` (`ui/dashboard.js`) takes a ticket before `/overview` goes out**,
  and installs `data.categories` only while it holds it. This is the writer
  the first two could not see, and the section above names it without closing
  it: `'reload'` is the wrong event for `moveCategory` — but `announce()`
  still sends the dialog's four OTHER category mutations through it, and each
  of those puts an `/overview` on the wire that carries the whole category
  list. The gesture that reaches it is not a race anybody has to try for. A
  category is created at `MAX(position) + 1`, so a fresh one lands at the
  BOTTOM of the manage list, which is exactly where you then press ↑ — and
  that press falls inside the round trip the Add's own `announce()` started.
  `/overview` computes every habit's window plus `categorySummaries` against a
  reorder's few `UPDATE`s, so it is the one likely to lose. `load()`'s own
  `paint()` redraws the dashboard and never the manage list, so nothing on
  screen contradicts the move: the list goes on showing it while the store no
  longer does, and the next press writes the regression to the server.
  `habits` and `categorySummaries` from the same reply are deliberately NOT
  ticketed — neither has a second writer that can be newer than that reply,
  and summaries are read by id rather than by position.
- **`moveCategory`'s catch keeps its ticket and reverts only while it holds
  it.** `previous` is captured before the splice, so the revert is a writer of
  `state.categories` exactly as stale as any reply. Two presses overlapping
  with the EARLIER one failing last — a 5xx, a dropped connection, or the
  write limiter's 429, which is what a held arrow key reaches — put an order
  two presses old back in the store with nothing left in flight to correct it.
  Where something newer HAS run, not reverting is also the more accurate
  answer rather than merely the safer one: a later press's payload was
  computed after this splice, so it carries this move whether or not this
  write ever landed.

Blocks `j`, `k`, `l` and `m` in `shared/test/browser/categorycheck.mjs` pin
one half each, and the split is forced rather than tidy: each one passes with
any of the other three deleted, measured. All four drive the failure
deterministically — the interceptor fires each request against the real server
at the moment the app asks for it, so the body captured is genuinely the stale
one and the server genuinely commits, and only the RESPONSE is held until the
script releases it. (`m` is the exception that proves the shape: its held
answer is a synthetic 500 that never reaches the server at all, because the
thing under test is a write that FAILED.) Each block asserts the DOM or the
dashboard's own section order and then the server's order after a follow-up
press, because the visible half self-heals a round trip later while the write
does not.

What is still shared with `persistOrder`, unchanged: several writes in flight,
each carrying the full order as of when it fired, so the order the server ends
up with is whichever POST commits last rather than whichever press was made
last. That is a write-ordering question, it predates this work in the habit
list, and closing it means sequencing the writes rather than the reads.
