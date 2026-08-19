# habiterall.ca

The public website, added 2026-08-19. Operative rules are in `site/CLAUDE.md`;
this is the reasoning, the alternatives that were refused, and what the first
version got wrong.

The brief was three things: a landing page, a wiki carrying deployment and
configuration, and a changelog generated from the release history — hosted on
GitHub Pages out of this repository, linking to `app.habiterall.ca` for sign-in.

## Why it is generated, and what that ruled out

The project's whole manual is `README.md`: 2073 lines covering the editions,
both installs, reminders, every environment variable, the API and the security
model. A website needs all of it.

Writing it again was the obvious approach and is the one this repository has
already refused twice, in code. `scripts/sync-compose-docs.mjs` **generates** the
README's compose blocks from `examples/` rather than comparing them, and says
why: comparing "is enough to catch drift and still leaves the README a place you
can forget to edit; the failure then names the right file but hands you a
copy-and-paste job." `shared/test/readme-assets.test.js` exists because a
renamed screenshot is invisible until a reader hits it. A hand-written wiki
would have been a second copy of the entire configuration reference, and the
copy that goes stale is always the one nobody is reading while they edit.

So the README is sliced. Three consequences were accepted going in:

- **The wiki reads like a manual, because it is one.** A site-specific
  getting-started walkthrough would read better and would be the thing that
  drifts. It can be added later as a hand-written page; the generator does not
  prevent it.
- **A README heading is now a URL.** Renaming one moves a page. This is loud
  rather than silent — see below — but it is a real new cost on editing the
  README, and it is stated in the root `CLAUDE.md` for that reason.
- **The landing page is hand-written and is the one place a fact can go stale.**
  The rule written down instead: it may not state a version, a port, a variable
  name or a limit. Those are the wiki's, and generated.

`docs/decisions/` is deliberately **not** published. It would make a good
contributors' section and it is written as agent-facing notes — candid about
which wrong version shipped first — which reads differently in public. Left for
a decision of its own rather than swept in.

## Slicing: an explicit map, not a rule

The first attempt split at every `##`. That gives fourteen pages, one of which
is **1055 lines** — `## Quick start` is half the README, because it embeds the
generated compose and env listings.

The repair that suggests itself is "split at `###` too, when a section is over N
lines". It was refused: it is an *implicit* rule, so adding a paragraph to a
section can push it over the threshold and silently re-split the page,
**changing the URL of everything under it**. A documentation site whose URLs
move when prose is added is one nobody can link to.

`site/pages.js` names the headings instead — the same argument, in the same
words, as `PRINTED` in `sync-compose-docs.mjs`: "an explicit list rather than a
directory scan, because forgetting to add one here is caught by a test." The
test walks every heading in the README and fails on one no page claims, so
adding a section fails the build until it is placed.

`NOT_ON_THE_WIKI` is the escape hatch and is a **map, not a set**, so each
exclusion carries its reason. That is copied from `notMirrored` in
`shared/public/ui/settings.js`, and for the reason stated there: an unexplained
exclusion list is indistinguishable from an oversight, and the next reader
deletes an entry to find out what breaks.

`GROUPS` is a second list, apart from `PAGES`. They answer different questions —
the order you read a manual in, and what a sidebar has to look like to be
scannable — and keeping them apart means changing one does not silently reorder
the other. A page in neither is a page on no sidebar, which is also a test.

## The link check is the point of the whole generator

A generated site fails in one direction: **silently, into a 404 that only a
visitor finds.** It survives review, because a diff of a template shows nothing;
it survives the build, because a wrong `href` is a perfectly good string.

Three shapes of link stop working the instant the README is sliced, and the
README contains all three:

| in the README | on the site |
|---|---|
| `(#published-images)` — 26 of these | cross-page, `/wiki/configuration/#published-images` |
| `(LICENSE)`, `(examples/personal.env.example)` — 12 | absolute `github.com` URLs |
| `<img src="docs/screenshots/…">` — 11 | copied, and rewritten to `/assets/screenshots/` |

So `render.mjs` **resolves** each one and throws on anything it cannot, naming
the link. That is what turns "somebody renamed a README heading" from a broken
site into a red pull request, which is the only point at which it is cheap.

`repoLink` also checks the path exists on disk, so a link to a moved file fails
here rather than 404ing later.

**The changelog is lenient, and that asymmetry is deliberate.** README links are
ours and current: an unresolvable one is a mistake and stopping is right.
Release notes are historical, immutable once published, and may point at a file
that existed at that tag and does not exist now. Refusing to deploy the site
over a two-year-old release note would be the check doing harm.

## Anchors: GitHub's algorithm, written out

`githubSlug` is ten lines rather than a `marked` plugin, because the anchors are
not ours to choose. README.md contains 26 links to its own sections; so does
every link anyone has ever shared to a part of the README on GitHub. A plugin
that is 95% compatible breaks one of them.

The test asserts **literal** slugs — `'Both editions: the reminder scheduler'`
to `'both-editions-the-reminder-scheduler'` — because a test comparing
`githubSlug(x)` against itself passes against every possible implementation of
it. That is the root `CLAUDE.md`'s "a test that imports the constant it checks
pins the name and nothing else", applied to a function.

## The changelog comes from the API, not from git

`release.yml` already writes grouped notes by walking `git log` between two
tags — Fixes, Features, Web app, Android, Server, Tests and CI, Docs, and an
`Other` bucket that exists because "a changelog that silently omits commits is
worse than one that is untidy". Re-deriving any of that here would be a second
answer to a question already answered, and the two would disagree the first time
a commit prefix changed.

So the site reads what was actually published: `GET /repos/:owner/:repo/releases`.
The downloads page takes the APK's real filename, size and URL from the newest
release, which is the only version of those three that cannot be stale.

Three decisions inside that:

- **Failure is asymmetric.** In CI, an API failure fails the build — deploying a
  silently empty changelog is worse than not deploying. Locally, `--offline`
  skips both pages with a loud warning, so the site can be worked on with no
  network. `ci.yml`'s `site` job passes `--offline` deliberately: a rate-limited
  API answer must not fail a pull request over something nobody in it changed.
- **The install block is trimmed.** Every release carries the same three
  paragraphs — two `docker pull` lines, the tag list, and the "App not
  installed" sideloading warning. Right on a release page; on a changelog it is
  the same block twenty-five times, outweighing the one line per release that
  says what changed. `withoutInstall` cuts at `### Install`, which is a contract
  with `release.yml`'s wording — and if that wording changes, the block
  reappears, visibly and harmlessly. Throwing would let an old release note stop
  a deploy.
- **Prereleases are skipped for Downloads, not for the changelog.** Somebody on
  the downloads page is installing this for the first time; a release candidate
  is not what "Download" means. The changelog lists them, tagged.

## What the first version got wrong

Kept because each was invisible until it was looked at, and each is the kind of
thing a build that "succeeds" hides.

**The API page was blank.** The README wraps that entire section in a collapsed
`<details>` — right there, where it is one section of fifteen and the table is
twenty rows. On a dedicated page it is the whole content, and the page rendered
as a title above a closed box reading "Full reference". `expand` is per-page, not
global: the other eight `<details>` in the README are genuine asides and three of
them are entire env templates, which would put 200 lines of INI in front of
somebody reading the install steps wrapped around them.

**Tables on a phone were nine lines tall.** A `table-scroll` wrapper with a
100%-wide table never scrolls: it squeezes the description column to about eight
characters, so every row wraps to nine lines while the two narrow columns beside
it are nine lines of empty space. The fix is a `min-width` — a floor, so the
table is wider than the viewport and the container does the job it was added for.

**Every search excerpt repeated its own heading.** The extraction started after
the heading's *opening* tag, so it swept up the heading text and the `#` of its
permalink: `"ntfy # ntfy asks least of you…"` under a result titled `ntfy`.

**Several pages could not be searched at all.** A page's own search record
carried only its blurb, and pages claiming a single README section — Security,
Backup, Loop import — have no `h2` beneath them to index separately. "row-level
security" found nothing.

**The changelog repeated 50 `docker pull` lines** — the trim above.

**A backtick in a comment inside `layout.mjs`'s inline `<script>`** ended the
template literal and the module stopped parsing, with an error pointing at the
comment. There is a warning in the file now. The same trap has cost this project
time before, in CDP-injected test source.

**The gallery's alt-text test could not fail.** It asserted the README's
description appeared *somewhere* in the page HTML — which the visible caption
satisfies on its own. Replacing every `<img alt>` with the word `screenshot` left
it green, on eleven images that had just become invisible to a screen reader,
which is the one reader the borrowed guarantee exists for. It asserts the `alt`
attribute now. This is the root `CLAUDE.md`'s "pinning the DECISION is not
pinning the WIRING", found in the tests written to enforce that very rule.

**A `sed` mutation and a `node --test` in the same shell command produced a false
pass.** The slug mutation reported green, and re-running the two as separate
invocations showed nine failures. Worth knowing when mutation-testing anything
here.

## The build step, and the one dependency

The root `CLAUDE.md` said "No build step anywhere — what runs is what's on disk",
and that sentence was amended in the same change rather than left to contradict
this directory. It remains true of the app, which is what it was about: no
bundler, no transpiler, nothing in `node_modules` reaching a browser. Nobody
*runs* the marketing site's generator; it produces static files, and neither
edition nor the Android client loads a byte of them.

`marked` is the one new dependency, a root `devDependency`. Two alternatives:

- **A hand-written Markdown parser.** The README uses nested `<details>`, raw
  `<img>` inside `<div align="center">`, GFM tables and six fence languages. A
  hand parser fails silently on one of them, which is the failure mode this
  whole design is built to avoid.
- **GitHub's `POST /markdown`.** Renders exactly as GitHub does and needs no
  dependency — but makes local preview require a network and a token, and the
  wiki is styled to match the site rather than to match GitHub anyway.

**Syntax highlighting was refused.** `highlight.js` is large and has no
`caddyfile` grammar and a poor `ini` one, which is two of the six languages the
README actually uses. Code blocks get a mono font and real contrast.

## `www`, and why three files are generated from one constant

The site is served at **`www.habiterall.ca`**. Planning assumed the apex, and it
was corrected before the first deploy — worth writing down, because the two are
not interchangeable to GitHub Pages and the difference is invisible locally.

Pages treats whichever host the `CNAME` file names as **canonical**; the other is
at best a redirect it may or may not be configured to serve. So a site whose
pages link to `habiterall.ca` while Pages is set up for `www` works — every link
takes a redirect, every `<link rel="canonical">` names a host the content is not
served from, and the sitemap is on the wrong origin. Nothing errors. It is
exactly the class of failure the link check was built for, one level up.

Three files have to agree about the host, and each disagrees in its own quiet
way:

| file | what a wrong host does |
|---|---|
| `CNAME` | Pages drops the custom domain entirely, on the next deploy, silently |
| `robots.txt` | a `Sitemap:` on another origin is ignored by crawlers |
| every canonical and `og:` URL | search engines and link previews point elsewhere |

All three are now **generated in `build.mjs` from `SITE.baseUrl`**, and the two
static files that used to hold them by hand were deleted. The test asserts the
**literal** `www.habiterall.ca` rather than `new URL(SITE.baseUrl).hostname` —
deriving the expectation from the same constant the code derives it from is a
test that passes against any hostname, including the apex it is there to rule
out.

DNS is simpler for it: `www` is a single `CNAME` record to `easymod0.github.io`,
where the apex would have needed four `A` records and four `AAAA` records,
because an apex `CNAME` is not legal DNS.

## The palette is copied, and that is a decision

`site/static/site.css` repeats the twelve custom properties from
`shared/public/style.css`. Reading the app's stylesheet at build time would
couple the site to every refactor of it, to prevent a drift whose worst case is
that a marketing page's blue is one shade off. The app's file is the original and
the CSS says so.

The **logo is not** copied — `COPIED_ASSETS` copies `shared/public/icons/logo.svg`
itself, because a second SVG would drift from the one the PWA installs with, and
the two appear side by side the moment somebody adds the site to a home screen.

## The hosted call to action has two states

`app.habiterall.ca` runs the cloud edition and takes sign-ins, but is not yet
open to public registration. "Get started free" would send every first-time
visitor to a wall.

`hostedSignups` in `site/config.js` is `false`, and the hero, header and footer
read "Sign in" with a note saying signups are opening soon. Flipping it to `true`
changes all three to "Create a free account" and removes the note.

The test asserts **both rendered outputs**, not the flag — a test reading
`SITE.hostedSignups` would pass just as well against a template that never
consulted it.
