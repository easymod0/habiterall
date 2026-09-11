# Translations: a runtime catalogue, and who localises the server's prose (#144)

Moved out of #144, open. Nothing here is loaded automatically. Unlike most of
this archive, this is not a settled decision — it is the design space and the
open question, kept together so a first slice does not have to re-derive
either. habiterall is English-only today, and nothing about that is a
decision; it is just where the strings happen to be. This is the shape of
making it translatable *reliably* — a new screen cannot ship untranslated by
accident, and a translator never has to read code to know what a string
means.

## Where the strings actually are

Four places, and they are not alike, which is the whole difficulty:

1. **`shared/public/**` — the web UI.** String literals inline in `ui/*.js`
   and in `index.html`. No catalogue, no extraction, and no build step
   anywhere (root `CLAUDE.md`) — so whatever this becomes has to be a
   *runtime* lookup over a file the browser fetches, not a compile-time
   substitution.
2. **`android-native/app/src/main/res/values/strings.xml`** — already a real
   catalogue with real ids. Android's own `values-<lang>/` mechanism means the
   phone half is nearly free.
3. **`shared/src/**` — the server.** This is the hard one, and it has grown
   recently rather than shrunk. See below.
4. **`examples/`, the README and `SETUP.md`** — operator-facing. Almost
   certainly out of scope; say so explicitly rather than leaving it open.

## The part that is genuinely hard: the server now writes prose

Several server-side modules produce English sentences that reach a user, and
a JSON API has no obvious place to say what language the caller wants:

- **Awards** (`shared/src/awards.js`) return `label` and `detail` as finished
  English — *"Your longest run so far is 21 days."* This is the sharpest case
  because it was a deliberate architectural choice: awards are computed
  server-side precisely so the two clients cannot disagree (`awards.md`), and
  the same choice is what makes the strings server-side.
- **`applyImport`** reports per-habit outcomes as sentences.
- **`notify_status`** deliberately shows the sender's own wording for a
  failed delivery, because re-phrasing it in the UI is how the dialog and the
  log come to say different things about the same 404 (`shared/CLAUDE.md`,
  "How it WENT is written down too, and that one is for the user").
- **Discord reminder text** and the Android notification body, built from
  `reminder_message` plus fixed scaffolding.

Two shapes to choose between, and this is the decision the issue exists to
make:

- **The server returns a key plus data** (`{key: 'award.streak', days: 21}`)
  and every client renders it. Correct, and it costs the thing awards were
  designed to avoid — each client now needs the phrasing, which is a mirror,
  and the root `CLAUDE.md` rule is that a client mirrors a rule only if it
  must work offline. A widget and a notification genuinely are offline, so
  this may be unavoidable for those two surfaces even if the rest localises
  server-side.
- **The server localises**, from an `Accept-Language` header or a stored
  preference. Keeps one renderer; means the server carries every catalogue,
  and a cached response is now language-specific (the service worker's data
  cache and the Android reminder cache both hold text).

**There is already a worked example of this biting**, confirmed against the
tree: `shared/src/awards.js` rejected a "beat your worst day" award partly
because `shared/src` has no locale and therefore cannot name a weekday — it
would have had to hand the client a number to compose prose around, which is
exactly the key-plus-data shape above (`shared/CLAUDE.md`, "Refused, and each
looked cheap"). That decision is currently recorded as a reason not to build
a feature. It should be read as a reason to build this one.

## What "reliably" has to mean here

The ask is not just "add a catalogue" — it is that this keeps working. Three
mechanisms, in ascending order of value:

- **A test that fails on an untranslated string.** This repo already has the
  pattern in two places: `shared/test/settings.test.js` fails when the UI
  registry drifts from `SETTING_VALUES`, and `AppSettingsDefaultsTest`
  enumerates the registry and fails on any key in neither the defaults nor
  `notMirrored`. The equivalent here is a test that walks the UI modules and
  fails on a user-visible literal that is not a catalogue lookup. Getting the
  *detector* right is most of the work: `'✓'`, `'YYYY-MM-DD'` and a CSS class
  are not translatable strings.
- **A completeness check per language**, with an explicit list of what is
  deliberately untranslated — the `notMirrored` pattern, a map carrying a
  reason per entry, because "we thought about it" has to be distinguishable
  from "we forgot".
- **A fallback that is visible in development and silent in production.** A
  missing key must never render as `undefined` or as a bare id to a user.

## On generating translations

Machine translation is the realistic first pass for a self-hosted project
with no translator community, and it is fine — with two conditions worth
writing into the process rather than discovering later:

- **The source strings need context**, or the output is confidently wrong.
  "Skip" is a verb on a button and a noun in the stats; "at most" is a target
  type; "clean day" is this app's own coinage. Whatever format is chosen has
  to carry a comment per string.
- **Nothing generated ships unreviewed for a language nobody on the project
  reads.** Better to offer three languages that are right than twelve that
  are plausible. A translation that inverts a habit's meaning — *clean* vs
  *slipped*, *at least* vs *at most* — is worse than English.

## Things that will bite

- **Pluralisation.** `plural(n, word)` in `shared/src/awards.js` is, checked
  against the tree, `` `${n} ${word}${n === 1 ? '' : 's'}` `` — wrong for most
  of Europe and unrelatable to Slavic or Arabic plural rules. `Intl.PluralRules`
  exists and Android has `<plurals>`; both need the count passed through,
  which the key-plus-data shape gives for free and string concatenation does
  not.
- **Dates and numbers are already partly handled** — `npm run test:locales`
  exists (`shared/package.json`: `node test/locales.mjs`), and
  `Intl.DateTimeFormat` is used with a canonical timezone name. Check what it
  covers before rebuilding any of it.
- **RTL.** The day grid is a horizontal strip whose direction is already a
  setting (`dayOrder`, confirmed in `shared/src/validate.js` and
  `shared/public/ui/settings.js`), and `Grid.scrollAfterGrowth` exists because
  only one direction is free. An RTL locale interacts with that, and with
  `scrollAfterGrowth`'s arithmetic, in a way that wants checking rather than
  assuming.
- **The service worker.** Any new file under `shared/public/` must join
  `sw.js`'s `SHELL` and bump `CACHE_VERSION`, which costs every installed
  client its data cache. A catalogue per language is several files; decide
  whether they are shell or data before shipping, not after.
- **Language choice is a setting**, which means `SETTING_VALUES`, a default
  every client mirrors, an `AppSettingsDefaultsTest` entry, and a decision
  about whether it is portable. Probably it should follow the device by
  default — the same `system` / explicit-value shape `theme` already uses.

## Suggested first slice

Web UI only, one non-English language, key-plus-data for anything with a
number in it, the untranslated-literal test, and an explicit written decision
about the server-prose question above — because everything else follows from
that one. The choice between "server returns a key" and "server localises" is
Mark's to make before any of the rest is worth starting; this record is the
brief for that decision, not the decision itself.
