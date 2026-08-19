# site — working notes

**habiterall.ca**, the public website: a landing page, a wiki, a changelog, a
screenshot gallery and a downloads page. Static files on GitHub Pages, built by
`.github/workflows/site.yml` and served from `site/dist`, which is generated and
not committed.

```bash
npm run site:build              # everything, hits the GitHub Releases API
npm run site:build -- --offline # no network; skips the two pages that need it
npm run site:serve              # http://localhost:4321
npm test                        # includes shared/test/site.test.js
```

Long-form reasoning: `docs/decisions/site.md`.

## The rule this whole directory exists to keep

**Almost nothing here is written. It is GENERATED from files the repository
already keeps honest.**

| page | source |
|---|---|
| the wiki | `README.md`, sliced by `pages.js` |
| every figure, and the gallery | `docs/screenshots/`, captioned with the README's alt text |
| the changelog and downloads | the GitHub Releases API |
| the landing page | **hand-written — the one exception** |

That is not tidiness. This repository already decided the question twice:
`scripts/sync-compose-docs.mjs` *generates* the README's compose blocks rather
than comparing them, because a second copy of a config file goes wrong; and
`shared/test/readme-assets.test.js` exists because a renamed screenshot is
invisible until a reader hits it. A hand-written wiki would be a second copy of
the entire configuration reference, and it would be wrong within a month.

**The landing page may not state a fact that can go stale.** No version numbers,
no ports, no environment variable names, no limits. Those belong to the wiki,
which is generated. What the landing page is for is the sentence a manual cannot
open with.

## A generated site fails silently, so the build throws

A wrong link renders perfectly and 404s. Nobody sees it in a diff and nobody
sees it in review — only a visitor does, later. So `render.mjs` **resolves**
every link rather than copying it, and anything it cannot resolve is a build
failure with the offending link in the message. Three shapes, all of which stop
working the moment the README is sliced up:

- `(#published-images)` was same-page and is now cross-page.
- `(LICENSE)`, `(examples/personal.env.example)` were repo-relative and are now
  nothing at all.
- `<img src="docs/screenshots/…">` pointed into the repository.

`ci.yml`'s `site` job runs this on every pull request and is **not** gated on the
`changes` filter, because a documentation-only change is exactly when it has to
run.

**The changelog is the one place that is LENIENT** (`resolveHref`'s `lenient`).
README links are ours and current, so an unresolvable one is a mistake worth
stopping for. Release notes are historical and immutable, and may point at a file
that existed at that tag — refusing to deploy over a two-year-old note would be
the check doing harm.

## `pages.js` is explicit, and a test enforces it

`PAGES` names the README headings each wiki page claims. Slicing mechanically at
`##` was tried and gives one 1055-line page, because `## Quick start` is half the
README. The repair that suggests itself — "split at `###` when a section is over
N lines" — is worse: it is implicit, so adding a paragraph silently re-splits a
page and changes the URL of everything under it.

`shared/test/site.test.js` fails on a heading no page claims, so **adding a
section to README.md fails the build until it is placed**. `NOT_ON_THE_WIKI` is
the escape hatch and it is a map, not a set, so each exclusion carries its
reason — the same argument as `notMirrored` in `ui/settings.js`.

`GROUPS` is separate from `PAGES` on purpose: one is the order you read the
manual in, the other is what a sidebar has to look like. A page in no group is a
page on no sidebar, and that is also a test.

**A page's first claim is special.** Its heading is replaced by the page's
`title` and its body becomes the opening prose, so `## Quick start`'s lead-in
survives being split from what it introduces. Its ANCHOR moves to the `<h1>`,
which is what keeps `(#quick-start)` working.

## Things that have already cost something here

**A backtick inside the inline `<script>` in `layout.mjs` ends the template
literal** and the module stops parsing, with an error pointing at a comment.
There is a warning in the file. The same trap has bitten this project before,
in CDP-injected test source.

**`githubSlug` is written out rather than taken from a `marked` plugin.** The
anchors are not ours to choose — README.md contains 26 links to them and every
one has to keep working, as does every link anyone has shared to a section of the
README on GitHub. A plugin that is 95% compatible breaks one of them. The test
asserts **literal** slugs; asserting `githubSlug(x)` against itself would pass
against every possible implementation.

**Mutation-test the slug and the test runner separately.** A `sed` that mutates a
file and a `node --test` in the *same* shell command produced a false pass once —
the mutation and the check must be separate invocations.

**The API page opens its `<details>`; the other eight do not.** `expand` is
per-page. The README collapses that section because it is one of fifteen and the
table is twenty rows; here it is the whole page, and a page titled "API" whose
body is a closed box has nothing on it. The other `<details>` are genuine asides
and three of them are entire env templates.

**Tables get `min-width: 46rem` inside a scroll container.** Without it a table
on a phone is exactly as wide as the phone, so it never scrolls — it squeezes the
description column to eight characters and every row becomes nine lines tall
beside two columns of empty space.

**The search excerpt starts after the heading's CLOSING tag.** Starting after the
opening one swept up the heading text and the `#` of its permalink, so every
result began by repeating the title it was listed under.

**A page whose record is only its blurb is a page you cannot search.** Several
pages claim one README section and have no `h2` beneath them; indexing the page
body as well is what makes "row-level security" find the Security page.

## The one deliberate duplication

The palette in `static/site.css` is copied from `shared/public/style.css` — the
same twelve custom properties, the same two themes. Reading the app's stylesheet
at build time would couple this site to every refactor of it, to prevent a drift
whose worst case is that a marketing page's blue is one shade off. **The app's
file is the original.** If they disagree, it wins.

The logo is *not* duplicated: `config.js`'s `COPIED_ASSETS` copies
`shared/public/icons/logo.svg` itself, because a second SVG would drift from the
one the PWA installs with, and the two appear side by side the moment somebody
adds the site to a home screen.

## Deploying

`.github/workflows/site.yml`, on a push to master that touches a source of the
site, **and on every published release** — the changelog and downloads move when
a tag is cut, and without that trigger the site would advertise the previous
version until somebody edited the README.

**The domain is `www.habiterall.ca`, and `www` is not interchangeable with the
apex.** Pages treats whichever host the `CNAME` file names as canonical and the
other as, at best, a redirect — so pages linking to `habiterall.ca` while Pages
is configured for `www` put a redirect on every internal link and point every
canonical URL at a host the site is not on.

`CNAME`, `robots.txt` and every absolute URL are therefore all **derived from
`SITE.baseUrl`** in `build.mjs`. None of them is a file you edit; change the
constant. GitHub drops the custom domain if `CNAME` stops being published —
silently, on the next deploy — which is why there is a test for it, asserting
the literal host rather than re-deriving it from the same constant.

`app.habiterall.ca` is a different thing entirely: the hosted cloud edition,
which this site links to and does not serve.

`hostedSignups` in `config.js` is `false` while `app.habiterall.ca` is not open
to registration. Flipping it changes the hero, the header and the footer from
"Sign in" to "Create a free account" and removes the coming-soon note. Both
states are asserted against the rendered HTML, not against the flag.
