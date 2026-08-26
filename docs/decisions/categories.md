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
