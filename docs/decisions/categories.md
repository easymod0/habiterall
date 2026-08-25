# Categories (issue #65, phases 1 and 2)

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
