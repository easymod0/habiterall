# Import, merge and Loop compatibility

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**A merge may add an answer and must never delete one.** Now that a bare "not
done" in a file reaches the writer, a plain upsert would overwrite a recorded
completion with it — and a Loop backup is full of explicit `NO` rows, so merging a
phone export taken before the web history would have wiped every completion the
two disagreed about. Both editions' `applyImport` yield to the existing row for
exactly that case — bare lapse, merge mode — and count it as `entriesKept`.

Note "bare" is `!notes.trim()` and not `!notes`: a note of one space is truthy,
and content is what suspends the rule, so whitespace was enough to buy a lapse
the right to overwrite eight recorded glasses.

**On a merge the FILE's type says how a value was written down; the ACCOUNT's
says what may be stored.** These are two questions and answering them with one
type is how a file claiming `numerical` put an `8` on a boolean habit — a value
`PUT /entries/:date` answers 400 to, and one `isCompleted` reads as *not done*
forever. But the file's type still has to decide the *encoding*, because a `3`
is Loop's skip sentinel in a boolean column and three-of-something in a
numerical one; reading that against the account would re-create the value/skip
collision this file opens with. So the two rules run together, and the yield
above was gated on `type === 'boolean'` while they did not — which is what let a
merge rewrite eight glasses to a 2.

Where the two types genuinely disagree only a **lapse and a skip cross**: zero
glasses and "no" mean the same thing, and so does a skipped day. An amount is
not a yes and a yes carries no amount, so those days are reported in `skipped`
rather than invented. One asymmetry, deliberate and pinned by a test: a **skip
does not yield**. It is an answer — `isCompleted` returns `null` for it, not
`false` — so a `SKIP` cell in a bare Checkmarks.csv does overwrite a recorded
amount, where a bare lapse does not.

**A habit is matched by the name it is STORED under, and an absent value is not
an answer.** Two readings the import writers got wrong in the same shape — by
reading the file's word for something instead of asking what it would mean here.
`applyImport` looked an existing habit up by the RAW name while the INSERT wrote
`clean.name`, which `normaliseImportedHabit` has clamped to `LIMITS.name`, so
past 100 characters the lookup could never match a row: three merges of one
backup left three habits carrying one identical visible name, and cloud's
`willAdd` counted each as a fresh addition against `MAX_HABITS_PER_USER`. That
defeats the workflow cloud's own comment names — *restoring twice is the normal
way to check a backup is good*. Every reader of the name inside that loop moved
together, or the file's habit and the account's habit become two habits in one
iteration.

The other is the coercion class this file already records twice, with a sharper
sink than either. `entryValue` in `shared/src/import.js` is the rule, and it is
about the TYPE, because `Number(null)` and `Number('')` are `0` and `0` is a
legitimate value — a row holding zero is a **stated lapse**, one of the four day
states above. So `{date, value: null}` was written as a day the user said they
had missed while `{date}` with no `value` key at all was correctly refused: two
spellings of "the file said nothing", behaving differently. Harmless on a merge,
where a bare lapse yields; in **replace** mode there is nothing to yield to, and
an invented lapse extends the habit's history window back to its own date and
turns `recovery.rate === null` into a real lapse. Silence is therefore read as
silence and reported in `skipped`. It costs no habiterall backup — `entries.value`
is NOT NULL in both schemas, so nothing we export can carry one — and a quoted
`"8"` is still a value that was stated. What goes with `Number()` is its
generosity about the *form*: `'0x10'` and `'1e3'` were read as 16 and 1000.

**Loop's two tracking settings are `skipDays` and `questionMarks`,** both
defaulting off as Loop's own do, and both read from Loop's source rather than
guessed (`pref_skip_enabled`, `pref_unknown_enabled`). The tap cycle is
`Entry.nextToggleValue` verbatim, in `shared/public/ui/toggle.js` and mirrored by
the Kotlin `Grid.nextState` with both test suites pinned to the same examples.
The one surprise in it is deliberate: with question marks off there is no way
back to `unknown` from the grid, because with the setting off the two states
paint the same and a step between them would be a tap that appears to do nothing.
The day editor's Clear is what gets there. Every surface that can record an
answer reads `skipDays` — both grids, both day editors, the Discord buttons
(`reminderComponents`) and the Android notification, which reads it from a local
mirror because an alarm fires whether or not the phone has a network.

**An export reports what it could not carry; it does not fail on it.**
`isoToLoopTimestamp` is `Date.UTC`, which rolls a date over rather than refusing
one, so `2026-02-30` left as 2026-03-02 — and if that day held a real row, the
Loop file's UNIQUE index on (habit, timestamp) rejected the insert and
`/api/export-loop.db` answered **500 for as long as the row existed**, naming
neither the habit nor the date. Restoring your own backup is how such a row gets
in. `isLoopEncodableDate` is the gate, and it asks the exporter's question
rather than the calendar's — *does the timestamp read back as the day it came
from* — which is narrower than `assertDate` on purpose: that one also rejects
years 1-99, as a side effect of the same legacy two-digit mapping, and #81 is
teaching the encoder to carry them. This gate weakens by itself as the encoder
improves, with nothing here to remember to update.

The collision is only the loud half. With no real row on the day it rolled onto,
the export SUCCEEDED and filed the entry under a day the user never recorded, so
catching the UNIQUE violation alone would have left the silent corruption in
place and called it fixed. Two surfaces report the skips because neither reaches
everybody: `X-Habiterall-Export-Skipped` carries the count for a client that
made the request itself, and `export.rows_skipped` carries the rows at warn for
the browser, which downloads through an `<a download>` and reads no headers.
The count-only header is not timidity — a habit name is free text and a `\r\n`
in one would throw inside the route, which is the 500 all over again. For the
same reason the report is `{habit, date, reason}` rather than `applyImport`'s
sentence: its reader is a log, where names never go.


**Every parse path has a row ceiling, and there are THREE of them.** An upload's
size is not a bound on what it describes. A SQLite file's row count is
*declared*, not stored, so `CREATE VIEW Habits AS WITH RECURSIVE …` makes 8KB
claim five million rows; a CSV header is one line, so `Date,a,a,a,…` two million
times is 7.6MB that deflates ~1000:1 and yields one habit object per column; and
`{"name":"a","entries":[]}` is 26 bytes, so the 16MB body limit still describes
several hundred thousand habits. All three aborted the process — and the abort
is inside V8, so the `try`/`catch` that turns a bad upload into a 400 **cannot
catch it**. That is the whole reason this needs a ceiling rather than an error
path.

`MAX_PARSE_HABITS` and `MAX_PARSE_ENTRIES` in `shared/src/import.js` bound all
three, and three things about them are load bearing. The bound goes **where the
rows are produced** — `.iterate()` plus `LIMIT` for SQLite, the header length
for CSV — because anything that materialises the array first has already spent
the memory. The entry budget is a **total** across the file, not per habit, for
the reason `unzip.js` records one attack over: a per-item cap is no defence when
the number of items is also the attacker's to choose. And they are **env-settable
with generous defaults**, because personal's API caps neither habits nor entries
— a fixed ceiling would make the importer refuse a file its own API would have
accepted one habit at a time, which is the divergence `normaliseImportedHabit`
exists to prevent.

Note the name: `PARSE`, not `IMPORT`. Cloud's `MAX_HABITS_PER_IMPORT` is a
product limit applied to the parsed array; these bound what a file may *declare*
before that array exists. One is a defence, the other a policy, and they are one
word apart.

And the entry read is **one pass over `Repetitions`, not one per habit**, which
is the other half of the same problem. `WHERE habit = ?` inside the habit loop
looks like the cheap shape and is the opposite: Loop's own schema indexes
`habit`, an uploaded file need not, and then every execution is a full scan — so
the cost is habits x rows, and the budget could not see it, because a budget
spent by rows RETURNED is never spent by rows that match nothing. A 6.4MB file
of 2,000 habits and 300,000 orphan rows took 13.5 seconds and yielded zero
entries. Read once ordered by `habit, timestamp` and bucket into a Map: one scan
whatever the file's indexes, the same per-habit ordering, and every row billed
before it is looked up. That last clause is the whole correction and there is a
test on it — bill after the Map miss and the free scan is back.


**Loop compatibility is exact and verified against a real backup**: timestamps
are epoch millis at UTC midnight, `YES_AUTO(1)` counts as done, `NO(0)` is a
stated lapse and keeps its row while `UNKNOWN(-1)` has none, and identity is
`(issuer, subject)`. Both round-trip suites now assert every entry with no
documented gap left — Loop's `.db` and the CSV pair can each carry all four
states, so a lapse survives whether or not a note came with it.

**The habit FIELDS are held to that standard too now, and two of them were not
connected at all.** Loop's `question` is the prompt a reminder asks, which is
`reminder_message` under another name; its `reminder_hour` / `reminder_min` are
`reminder_time` in two integer columns. Both were dropped in both directions —
`NULL, NULL` and `''` were literals in the export's INSERT, and none of the
three columns appeared in the import's SELECT — so the one habit field a Loop
file could carry and habiterall refused was the one with a picker on two
clients. `loopReminderToTime` and `timeToLoopReminder` are the pair, and the
case that decides them is **midnight**: `00:00` is both columns holding 0, so
any check for a truthy hour reports a real reminder as none. Absent means
absent, which is why a half-filled row (an hour with a NULL minute) is no
reminder rather than `HH:00` — inventing that puts a notification on a phone
that Loop never had.

The CSV's version of this was a *pair* of bugs that concealed each other: the
export wrote `description` into the `Question` column as well as its own, and
the import read `idx('description', 'question')` — question as a fallback FOR
description. So a habiterall round trip copied the description over the prompt.
Both halves had to move together; fixing either alone looks like it works, and
the fixtures that catch it are the ones where a habit's description and prompt
DIFFER — make them equal and the broken code passes.

Be precise about what the import half did, because the obvious reading is wrong
and issue #67 had it wrong too: `idx` matches on **headers**, and Loop's
Habits.csv always has a `Description` one, so on a real Loop export the fallback
never fired and the question was simply **dropped**. It fired only for a file
with a `Question` header and no `Description` header — and there it was
arguably right. Loop's migration 23 is `update Habits set question =
description`: pre-v2 Loop had one free-text field and v2 renamed it, so in a
backup from a migrated install the user's prose sits in `question` because Loop
moved it. Reading it as a description was true to what they wrote. Following
Loop's reclassification is still correct — it shows that text in the
notification — but this is a reassignment of existing prose, not purely a fix.

**Only an ALL-DAYS Loop reminder is imported.** `reminder_days` is a 7-bit
weekday mask (127 is every bit; `WeekdayList` in Loop's source) and habiterall
has no concept of one, so a Monday-only reminder has no faithful form here.
Taking the time alone turned it into seven notifications a week AND wrote that
widening back into the user's own Loop app on the way out; a mask of `0` — a
reminder that fires on no day — became a daily one, which is exactly what the
hour/minute rule above refuses to do. Missing is the honest answer until #72
lands. On export the mask is `127` for a habit with a reminder and `0` for one
without, which is what Loop's own writer stores.

Two smaller traps in reading those columns, both of which produced a reminder
out of nothing. `Number('')` is `0`, so an empty column passed a
`Number.isInteger(Number(x))` guard as midnight — only digits count now. And the
three columns are selected as **TEXT**: read as INTEGER, a value above 2^53
makes node:sqlite's row decoder throw for the whole `.all()`, so one garbage
cell rejected an entire backup that used to import fine.

That is why the fidelity rules are now two lists. `LOOP_HABIT_FIELDS` is what
both Loop formats carry and `LOOP_DB_HABIT_FIELDS` adds `reminder_time`, because
Loop's own `Habits.csv` has no reminder columns — an asymmetry of the format,
asserted in both suites rather than assumed. Note the cloud suite seeds by
writing columns by hand and had simply never written `reminder_message`, so
every comparison of it held `''` against `''` and passed; the personal suite
seeds through the API and never had the gap.

**Loop's backup carries no preferences** — they live in Android's
SharedPreferences, not the database — so nothing from a Loop file can set one,
and `skipDays` / `questionMarks` arrive only in habiterall's own JSON backup.
That backup does carry settings now — it silently did not for a while — because
two of them decide what the rows in the same file MEAN. Not all of them, though:
`PORTABLE_SETTINGS` is the allowlist and `UNPORTABLE_SETTINGS` says what is held
back, the notification keys, because a backup is a file people email to
themselves and `discordWebhook` is a bearer capability for a channel. A
**replace** applies what does travel and a **merge** does not: "make this account
look like the file" versus "add these habits to what I have".

**Only entry values scale by ×1000 — habit targets do not.** `Repetitions.value`
of `2000` means 2, but `Habits.target_value` of `2` means 2. Scaling the target
turned "brush teeth at most 2 times" into "at most 0.002", which no entry could
ever satisfy. Reading their source was not enough to catch this; it took a real
export.


