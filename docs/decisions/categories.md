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
'').trim().toLocaleLowerCase()`, which is Unicode-aware in both Node and the
browser) and both editions' routes look up `categoryByFoldedName` /
`WHERE lower(name) = lower($1)`-equivalent through it before ever reaching the
`INSERT`. The DB-level `UNIQUE` constraints stay, but only as a backstop
against a race between two concurrent requests passing the route check at
once — a duplicate that reaches the constraint is answered as a **409**, not
allowed to surface as the constraint's own 500. Note this means personal's DB
constraint is *stricter* than the route check in one direction (ASCII-only
NOCASE would let through a pair the route already folds together) which is
fine: the route is what a client sees, and the constraint only ever fires on
a race the route already meant to refuse.

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
