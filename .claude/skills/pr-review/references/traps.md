# Defect catalogue

Every entry is a bug this repo has actually shipped or nearly shipped. Read only
the sections your diff touches. Format: **the trap** — how it presented — what
to ask.

---

## Tests that cannot fail

The single most repeated defect. Check every new assertion against these.

- **A fixture holding its default everywhere.** The round-trip fixture kept
  `at_most_unlogged` at `'default'` on every habit, so the comparison was two
  defaults agreeing and passed with the field deleted. Same for
  `reminder_message` in the cloud seed, twice. → Does the fixture *vary* the
  field it claims to cover?
- **Asserting against the suite's own literal.** `assert(forHabit.unit ===
  'glasses')` one line after `assert(forHabit === numHabit)` — no production
  change can move it.
- **Importing the number you are checking.** A test reading `COMEBACK_FRESH_DAYS`
  back pins the off-by-one and nothing else; it passed with the window widened
  to 30 while its comment claimed the boundary was covered. → Assert the literal.
- **A fixture that does not straddle the boundary.** A ten-day first run put
  start-to-end and end-to-end both over a year, so measuring from the wrong end
  passed every assertion. → Do the right and wrong answers land on opposite
  sides?
- **A property test whose generated shapes exclude the bug.** The awards
  invariant walked a *daily* habit from a fixed first entry, so `from` never
  moved and the leniency window never applied. It could not have seen either
  real mechanism.
- **The wrong harness.** `test/browser/atmost.mjs`, `rendercheck.mjs` and
  `daydialog.mjs` build a ~15-line fake DOM. A handler reached through a
  `keydown` listener, or reading `dataset`, is not covered there however much
  the suite name suggests it — `weekcheck.mjs` claimed Home/End and the
  `getDay()` mutation passed every suite in the repo.
- **Pinning the rule, not the wiring.** See "Android wiring" below; it
  generalises. An extracted pure function with a test, and the caller one line
  below it wrong, has passed twice here.

→ If the PR says "verified the tests bite", check `references/verify.md` and say
whether you believe it.

---

## Mirrors and registries

A rule is copied only when it must run **offline**. Five copies exist; adding a
sixth is a cost worth flagging.

| rule | copies |
|---|---|
| tap cycle | `ui/toggle.js` ↔ `Grid.nextState` (`toggle.test.js` / `GridTest`, same examples) |
| entry encoding | `valueForState` ↔ `Grid.valueForState` |
| reminder time parsing | `ui/time.js` ↔ `ReminderTime.kt` |
| is a day answered | `answeredIds` (`notify.js`) ↔ `Reminders.needsReminder` |
| channel default / `skipDays` / `questionMarks` | server settings ↔ `AppSettings` |
| wire values | `src/constants.js` ↔ `public/ui/values.js` ↔ `toggle.js`'s local decls |
| channel list | `notify.js` `CHANNELS` ↔ `ui/settings.js` (`shared/src` is not served) |

Checks:

- **A setting needs both halves**: `SETTING_VALUES` in `validate.js` (what the
  server accepts) and the `ui/settings.js` registry (what the dialog renders).
  One without the other is unenforced or dead. `test/settings.test.js` pins it.
- **A setting's DEFAULT is a mirror** even though its rule is not — `GET
  /settings` returns only stored keys. A new setting must reach `AppSettings` or
  be listed in `AppSettingsDefaultsTest`'s `notMirrored` **with its reason**.
  The trap is `historyGranularity`, whose default is not the first option.
- **`PUT /habits/:id` REPLACES; `PUT /settings` MERGES.** A partial habit write
  resets what it omits. Kotlin `HabitInput` needs `encodeDefaults = true` or
  omitted fields are cleared.
- **A new habit field**: does it belong in `JSON_HABIT_FIELDS`? In
  `LOOP_HABIT_FIELDS` / `LOOP_DB_HABIT_FIELDS`? A display-only or
  habiterall-only field goes in neither Loop list, and a Loop round trip must
  correctly return it to its default.
- **`isAvoided` asks three questions** — avoid, at-most and measurable. Asking
  two put a habit in a state it could not leave.

---

## Entries, windows and figures

- **The fourth state.** `done` / `skip` / `no` (row holding 0) / `unknown` (no
  row). `entryMap.get(date) ?? UNSET` is the collapse — it did this in six places
  in `stats.js`, harmless for an at-least habit and handing an **at-most** habit
  a full success for a day nobody answered: a limit with no entries reported a
  30-day streak and a rising strength. Ask `Object.hasOwn` / null-check, never
  what the map holds.
- **`entryWrite` never deletes.** `PUT {value: 0}` is a stated lapse; `DELETE`
  is how a day returns to unknown. A new write path must go through
  `entryWrite` (shared/src/validate.js) — three callers need it.
- **A stored lapse moves the WINDOW.** Ranges start at `from = start ??
  firstEntry`. Adding an earlier row re-judges everything after it: `recovery.rate
  === null` becomes a real lapse, and an award read off `bestStreak` can go DOWN
  when a user logs a forgotten session. Any change touching the earliest entry
  is a figures change.
- **`dateRange` vs `boundedRange`.** Never call `dateRange` on a start date from
  the database — one entry dated year 0100 blocked the event loop for 32
  seconds. Every range needs `MAX_RANGE_DAYS`.
- **Two questions, one variable.** `/overview`'s `end` decides the grid window;
  `summaryEnd` (`today()`) decides what the streak is computed as of. They were
  one variable and paging back a month silently restated every summary.
- **`totalCompleted` counts ANSWERS; window figures count DAYS.** Under
  `atMostUnlogged: 'success'` a streak can sit beside a "total done" of zero.
  Both are right; a change making them "agree" is probably wrong.
- **An at-most rule must be GATED to at-most habits.** Ungated, `success` fell
  through to at-least habits with a target of 0 and reported a 30-day streak
  beside a strength of 0.
- **The score is a trailing-window ratio into an EWMA**, decay `0.5^(sqrt(freq)/13)`,
  read from Loop's source. Any "simplification" to per-day credit scaled by
  frequency overshoots for every non-daily habit. `stats.test.js` pins days 13,
  30, 60.
- A **skip is an answer**: `isCompleted` returns `null`, so `!== false` is the
  test, never truthiness.

---

## Import, export, fidelity

- **`Number()` is too generous about form.** `Number('')` and `Number(null)` are
  `0`, and `0` is a legitimate value — so `{value: null}` was written as a stated
  lapse while `{date}` alone was correctly refused. `'0x10'` and `'1e3'` read as
  16 and 1000. Silence must be reported in `skipped`, not invented.
- **The FILE's type decides the encoding; the ACCOUNT's decides what may be
  stored.** Answering both with one type put an `8` on a boolean habit. A `3` is
  Loop's SKIP sentinel in a boolean column and three-of-something in a numerical
  one.
- **A merge may add an answer and must never delete one.** A bare lapse yields
  to an existing row (`entriesKept`); a skip does not, because it is an answer.
  "Bare" is `!notes.trim()`, not `!notes`.
- **Match a habit by the name it is STORED under**, after
  `normaliseImportedHabit` clamps it — a raw-name lookup could never match past
  100 characters, so three merges of one backup left three identical habits.
- **Three parse ceilings.** A row count is *declared*, not stored: a recursive
  CTE makes 8KB claim five million rows, a CSV header of two million columns is
  7.6MB, `{"name":"a","entries":[]}` is 26 bytes. The abort is inside V8 and
  `try`/`catch` cannot catch it. Bound **where the rows are produced**, bill
  every row **before** the Map lookup, and keep the entry budget a total across
  the file, never per habit.
- **One pass over `Repetitions`**, bucketed into a Map — `WHERE habit = ?` per
  habit is a full scan each time on a file whose indexes are the attacker's
  choice.
- **An export reports what it could not carry; it does not fail.** `Date.UTC`
  rolls `2026-02-30` to March 2 — a collision 500s the route, and *no*
  collision silently files the entry under a day the user never recorded. The
  count-only header exists because a habit name is free text and a `\r\n` in one
  throws inside the route.
- **Only entry values scale ×1000. Targets do not.**
- **`Habits.csv` is a source of habits**, not only a lookup table for
  `Checkmarks.csv` columns.
- **Loop carries no preferences.** Settings travel only in habiterall's own
  JSON, through `PORTABLE_SETTINGS`; `UNPORTABLE_SETTINGS` holds back anything
  that is a bearer capability (Discord webhook, ntfy topic URL).

---

## Security boundaries

- **A user-supplied URL the server fetches is an SSRF primitive.** The shape:
  https only, no credentials in the URL, host matched **whole and with its
  port** (never a suffix test — `evilntfy.sh` ends with `ntfy.sh`), the **base
  path pinned** as a whole-segment match (never a string prefix), segments with
  no dots at all, the URL **rebuilt from the parts that were checked**, and
  **re-checked at send time** because the operator's allowlist can narrow after
  a value was stored.
- **`Object.hasOwn` when looking up a key from user input.**
  `SETTING_VALUES['__proto__']` is truthy and has no `.includes`.
- **Cloud tenancy.** Every table is `FORCE ROW LEVEL SECURITY`; `withUser` sets
  `app.user_id` transaction-locally. New `withoutUser` call sites are a finding
  unless they are migrations, the session store or provisioning. Never for habit
  or entry data. A new table needs its policy and the grant list in
  `habiterall-cloud/CLAUDE.md` kept exact.
- **Identity is `(issuer, subject)`**, never subject alone.
- **A Discord press is authorised by the CHANNEL**, never by its `custom_id`;
  the habit is looked up *inside* the resolved account.
- **A press is acknowledged before storage is touched** (`DEFER_UPDATE`, type 6
  not 5), and the `try` wraps the defer too. A modal cannot be deferred.
- **Frames from the gateway are remote input**: `resume_gateway_url` steers the
  next socket, `heartbeat_interval` sets a timer in this process.
- **A cookie session needs an origin check, and a missing `Origin` must pass**
  (native clients send none). Its 403 must not be treated by the outbox as a
  verdict on the write.
- **Only 200 and 401 say anything about how an instance authenticates.** A 429
  or the service worker's synthetic 503 read as an auth answer replaced a working
  app with a broken sign-in screen.
- **`/api/me` sits above `requireAuth`** and must repeat *both* questions by
  hand — that a session exists, and that it still matches the current credential.
- Auth flags: `HABITERALL_AUTH` is on unless the value is exactly `off`.
  `HABITERALL_RATE_LIMIT=off` must never reach the credential limiter.
- **`TRUST_PROXY` decides three things** — the limiter key, `req.host` for the
  origin check, and whether the cookie can be `Secure`. All three fail quietly
  and in different directions.
- **Authenticate before you buffer.** A raw body parser above `requireAuth` read
  70MB from an unauthenticated caller and then refused it.

---

## Offline, replay, the shell

- **`replayable()` is one predicate answering one question** — is this write
  safe to arrive twice? Three rules turn on it (what may be staged, pre-empted,
  queued). A second opinion about the same call is the defect.
- **`POST /habits` is bounded but never queued.** It is the only write that is
  not replayable.
- **The write is staged BEFORE the attempt** and unstaged on *any* response.
- **A 4xx is not always permanent.** 401 and 403 keep their place in the queue;
  dropping them silently destroyed the outbox on a proxy misconfiguration and
  lost notification answers when a cookie aged out.
- **`flush()` rebuilds a request from a record** — anything added to a live
  request (e.g. `X-Habiterall-Timezone`) must also be added there, or replayed
  writes are judged differently and dropped.
- **A new file under `shared/public/` must join `sw.js`'s `SHELL` and bump
  `CACHE_VERSION`** — which costs every installed client its data cache. That
  price is why several rules live in existing files. `ui-modules.test.js` walks
  the imports and fails when `SHELL` falls behind.
- **`/healthz` must never 429 and must not go through the service worker.** Four
  callers read anything but 200 as "the server is unreachable", and `shellFirst`
  cached the first 200 forever.
- **Connectivity state has two inputs**: the probe, and the app's own failed
  write via `reportOffline` — not a bare `setOffline`, or the watcher's `last`
  stays `true` and it never polls or reports the transition.
- **A module owns its element ids.** No id may be reached for by two modules
  (`ui-modules.test.js`). Mutators announce through the store; nothing calls
  another view's render.

---

## Clocks and calendars

- **Whose day is it?** `callerDay` reads the request header and nothing else —
  for "is this today?" on a write, and for the read anchors. `resolveTimeZone`
  answers where an *account* is, for server-sent reminders. Folding them
  together breaks whichever loses.
- **The spread is 26 hours**, so `today + 1` is both too narrow at the edges and
  too wide everywhere else. Keep the guard exact; move the day it is exact about.
- **A zone must be a canonical NAME.** `parseTimeZone` refuses offsets and
  canonicalises aliases — otherwise a header can mint unbounded distinct keys
  for a formatter cache that never evicts (16,384 case variants retained 2.2MB).
- **`new Intl.DateTimeFormat` throws for an unknown zone**, inside a per-account
  loop. `hourCycle: 'h23'`, never `hour12: false` — en-US formats midnight as
  `'24'`.
- **A localised name is never indexed by a Gregorian field.** `MONTHS[d.getMonth()]`
  or `String(d.getDate())` assumes the locale's calendar is Gregorian; it is not
  for fa-IR, th-TH, ar-SA. Found five times in the same shape. Hand the DATE to
  `Intl` and read a *change* of month or year from the formatted string. These
  are invisible in en-US — `npm run test:locales`.
- **`weekStart` must reach the labels AND the data through one translation.**
  Rotating captions alone captions Monday's row "Sunday".
- **The calendar is anchored on its END**, not its start.

---

## Configuration plumbing

- **A `.env` line is inert unless a compose file NAMES the variable.** No
  service uses `env_file:`, deliberately. Four cloud limits sat in the template
  doing nothing. `ENV_TEMPLATES` in `compose.test.js` runs both ways.
- **A new env var must reach**: the code, both the checkout and the published
  compose file for its edition, the `.env` template, and the generated README
  block (`npm run docs:compose`). `compose.test.js` walks the module graph from
  the entry points — but it cannot see `process.env[name]` with a **computed
  key**, which needs an `@env NAME` marker beside it.
- **`extends`, not `include`.** Include loads services alongside and yields a
  container with a build and no environment at all. `depends_on` *is* inherited
  (measured); top-level `volumes:` are not.
- Templates ship limits at their **code** defaults — repairing inert wiring must
  not silently change what a running instance enforces.

---

## DOM and rendering

- **`[hidden]` needs `display: none !important`** — a `display` rule silently
  beats the attribute.
- **A chart names a theme colour; it never resolves one.** No `getComputedStyle`
  at draw time — a resolved colour freezes the palette the chart was drawn under
  and only a *refetch* corrects it.
- **`charts.js` must survive the fake DOM**: `setAttribute('data-x')` not
  `.dataset.x`, `class` through the attribute object not `classList.add`.
- **Text on a fill must not use the habit's colour** — nothing constrains its
  lightness, and `#fff` on a pale habit is invisible.
- **`WIDTH_SAFETY` reserves; it never decides to degrade.** Applying the margin
  to a decision about dropping a caption throws away labels that would have fitted.
- **A caption thinned away must not be the newest one** — reserve the last
  column first.
- **The search box is outside `#grid`** because `paint()` rebuilds that subtree
  on every keystroke. A rebuilt control keeps focus via `data-focus-key` (what a
  control *is*, never where it sat); `.focus()` on a disabled button is a silent
  no-op.
- **An amount is parsed, not `<input type="number">`** — that input filters
  keystrokes and hands back what survived: `8,5` became `85`.
- **A dialog holds a draft**; dependent controls and section notices read the
  *draft*, a `multi` handler must read `draft[key]` at event time, and a late
  answer must not rebuild while a field has focus.

---

## Android wiring

- **Pinning the DECISION is not pinning the WIRING.** Two separate reviews broke
  four things each here — a PendingIntent's data uri, an early return, an action
  list read `.reversed()` — one line below the pure function that pinned the
  rule, and every test passed. Assert the **outputs**: what AlarmManager was
  handed, what the Notification carries (`ReminderWiringTest`, Robolectric).
- **`filterEquals` ignores extras** — two purposes need two data uris, or one
  quietly becomes the other.
- **A notification names a DAY.** A snooze must land on the day the reminder is
  about, never on the day of the press; an alarm may be inexact, so the date
  rides on the intent and is re-checked before posting.
- **An hour is real time (`plusMinutes`); a daily reminder is a wall-clock
  promise.** They differ on two nights a year and both are pinned.
- **The collapsed shade shows three actions and drops the tail** — order matters.
- **A widget is a cache with no `onResume`.** The record names the day it is
  about; a stale record must read `unknown`, or the next tap records a miss
  against a day nobody touched. Today is resolved when the tap ARRIVES.
- **Redraw triggers must be arranged**, not assumed — `ACTION_DATE_CHANGED` is
  not on the implicit-broadcast exception list and never fires.
- **A record that will not parse leaves the widget blank with no click intent.**
  Flatten `\r` as well as `\n` and `|`.
- **A habit that leaves the account must stop being tappable**, and the
  explanation must be visible on the *screen* — a `uiautomator dump` prints the
  accessibility tree, which is not what a sighted user sees.
- **`WebBackStack`**: a document load truncates on `doUpdateVisitedHistory` (an
  error page commits after `onPageFinished`); a habit over the dashboard pushes;
  a habit over a habit replaces. Changing what `app.js` writes to history during
  boot re-opens all three.
- **`Outbox`'s 4xx rule** and `taskAffinity=""` on `CountEntryActivity` — see
  Offline, and the root CLAUDE.md.
