# What must stay fixed, and may never become a setting (#112 §3)

Moved out of #112, the customisation audit. That issue asks two questions of
every candidate, and this file is the answer to the first one for the eleven
places where the answer is *no*:

- **Is it taste, or is it a premise?** A premise that becomes an option is a bug
  with a switch on it.
- **Per user or per habit?** Roughly: if two habits in one account want opposite
  answers, it is per habit and it is a schema change. Otherwise it is a setting
  and it is cheap. `at_most_unlogged` is the worked example of the first
  (the doc comment on `AT_MOST_UNLOGGED` in `validate.js` argues it at length),
  and it is the one to copy.

Nothing here is loaded automatically. What it holds is the list someone will
otherwise propose in six months, with the reason each one is not available
attached to it.

**This file exists because an issue is read as a thing somebody intends to
build.** #112 is labelled `enhancement`, and its §3 is a list of things that must
never be built — so the label inverted the section's meaning for anyone who did
not read to it. That inversion is the whole cost of leaving this material in an
issue tracker, and it is why #203 moved it here. The rest of #112 is still the
audit: the candidates that *are* worth offering, and what each costs. This is
only the half that is settled against.

The costs that apply to any new setting — two files or it does not exist, a
portability decision, a default the phone also holds, a mirror only if it must
work offline — are in `settings-and-mirrors.md` and the root `CLAUDE.md`. They
are why some of the cheap-looking entries below are not cheap.

## The eleven

**1. The score's decay constant.** `0.5^(sqrt(frequency)/13)` — the `alpha` in
`computeScores` (`stats.js`) — read from uhabits' `Score.kt` rather than chosen.
A fixed 30-day half-life sat here for a while and made a perfect habit take four
months to look strong instead of one; `shared/test/stats.test.js` pins the curve at days 13, 30 and 60 so it
cannot drift back. A per-user half-life makes "strength" mean a different thing
per account, and the dashboard and the detail view both put that number in front
of people. It is not carried in a backup either, so a restore on another instance
would silently restate every figure.

  (#112 names two further surfaces here, the Discord embed and the phone, and
  neither shows the score as the code stands: `reminderMessage` builds a name, a
  custom prompt and a goal, `shared/src/notify.js` contains no `score` or
  `strength` at all, and `Habit.score` sits on the Kotlin model with no UI
  reading it. Cut rather than carried over — the conclusion never rested on
  them.)

**2. What a streak is made of.** `onPaceSeries` (`stats.js`) asks the same
trailing-window question the score does, deliberately, so strength and streaks
cannot disagree about the same day; and `computeStreaks` counts **calendar** days
so a 3×/week habit kept for a month reads as 30 rather than 12. An option for
"count only the days I did it" puts those two back into contradiction, which is
the bug `onPaceSeries` exists to fix.

**3. The four day states, and what a write does to storage.** `entryWrite` in
`validate.js`: `PUT {value: 0}` records a stated lapse, `DELETE` is how a day
returns to unknown, and a skip is `status = 'skip'` and never a magic value.
`questionMarks` already offers the only genuine choice here — whether the two are
*drawn* apart. A setting that made `PUT {value: 0}` delete again would make one
request mean two things depending on an account preference, across **four**
`entryWrite` call sites — both editions' `api.js` and both editions'
`notifier.js` — and every row already stored. The notifier pair is not
Discord-only either: it is the storage adapter behind every button press on
either channel, ntfy included, which is what `npm run test:ntfyanswer` exercises
over the real route. `day-states.md` is the long form.

**4. The Loop encoding.** Epoch-millis UTC-midnight timestamps, ×1000 scaling on
entry values only, `YES_AUTO(1)` counting as done, `NO(0)` keeping its row. It is
a wire format, not a preference. See `import-and-loop.md`.

**5. The ceilings.** `MAX_PARSE_HABITS` / `MAX_PARSE_ENTRIES`
(`shared/src/import.js`), `MAX_RANGE_DAYS` and `boundedRange`,
`SUMMARY_WINDOW_DAYS` and `STREAK_HISTORY_DAYS`. The last two look like tuning
and are what keep the dashboard O(window) per habit rather than O(lifetime); the
parse ceilings guard an abort inside V8 that no `try`/`catch` can reach. Where an
operator genuinely needs to move one, the answer is an environment variable with
a generous default — which `MAX_PARSE_*` already is — and never a user setting,
because `GET /api/settings` hands settings to the browser.

**6. A default, once three files hold it.** `atMostUnlogged` should be a setting
and is one; its *default* may not drift, because `UNLOGGED_DEFAULT`
(`stats.js`), the registry and `AppSettings` are pinned together by
`shared/test/settings.test.js` and `AppSettingsDefaultsTest`. The same is true of
every default the phone also holds.

**7. The tap cycle.** `ui/toggle.js` and `Grid.nextState` are Loop's
`Entry.nextToggleValue`, pinned to the same examples in `toggle.test.js` and
`GridTest`. It already reads the two switches Loop itself has, and a client copies a
rule only when it must work offline, which this one must.

#112 prices a third switch as "a sixth hand-written mirror on the phone", and
that is one mirror too many: the tap cycle IS the first of the five the root
`CLAUDE.md` names, so a third switch does not add a mirror, it adds an input to
that one — plus a mirrored DEFAULT, which is a separate category there
(`AppSettings` / `notMirrored`) rather than hand-copied logic. The cost is
therefore two examples in `toggle.test.js` and two in `GridTest` that have to
agree, and one more default pinned in three places. Still a real cost against a
small payoff, and still the conclusion; the arithmetic was just wrong, in the
direction that flatters it.

**8. Anything that would put a credential in a backup.** "Include my notification
settings in the backup" is a plausible-sounding option and must never exist:
`UNPORTABLE_SETTINGS` holds `discordWebhook` and friends out because a backup is
a file people email to themselves and a webhook URL is a bearer capability for a
channel. Same reasoning, one step further out, keeps `DISCORD_BOT_TOKEN` an
environment variable.

**9. The request bound and its one exemption.** 10s in `ui/api.js` and the
worker's `networkFirst`; `POST /habits` bounded but never queued. Both are about
what is safe to arrive twice, not about how patient someone feels.

**10. The origin check and the credential limiter.** `sameOriginOnly` must pass a
missing `Origin` (that is the native client) and refuse a mismatched one, and
`HABITERALL_RATE_LIMIT=off` must never reach `/auth/login`. Neither is a
preference; both have already been wrong once. #202 is the same guard failing a
third way — a limiter silently multiplied by the replica count.

**11. The survival ladder.** New, and the reason §2.4 moved: `awards.js` reads
`SURVIVAL_THRESHOLDS`, so a per-user ladder re-rungs the award grid per account.

## The eleventh is how an entry gets here

#203 describes this section as *"ten premises and why each may never become an
option"*, and there are eleven. The extra one is the mechanism worth keeping.

`SURVIVAL_THRESHOLDS = [2, 3, 5, 7, 14, 21, 30, 60, 100]` and `MISS_BUCKETS`
(both `stats.js`) sat in §2 as a candidate, not refused: `computeSurvival`
already takes thresholds as an argument, so the wiring looked available. Then #63
shipped, and `awards.js` reads `SURVIVAL_THRESHOLDS` directly for its streak
ladder — `SURVIVAL_THRESHOLDS.filter((days) => days <= best).pop()` — which is
exactly the reuse that issue asked for *"rather than inventing a second set of
round numbers that will drift from it"*.

So a per-user ladder now moves the rungs of the award grid with it, silently, per
account, and the candidate was promoted from "not yet" to "never". **A second
reader is what turns a tunable into a premise.** Ask that of anything on this
list somebody proposes unlocking: not whether the wiring is available, but how
many things now read the number.

The argument itself is left in #112 §2.4 rather than moved, deliberately, so it
is attached to the candidate somebody will otherwise re-propose. §2.5 (streak
grace, *"listed so it can be argued down"*) is the same shape and is still there:
a candidate that looks like taste, is refused, and is refused where a proposer
will find it.
