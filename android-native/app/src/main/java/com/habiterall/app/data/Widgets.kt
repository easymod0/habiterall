package com.habiterall.app.data

import java.time.LocalDate
import java.time.ZonedDateTime

/**
 * The home-screen widget's arithmetic, kept away from Android so it can be
 * tested — the same reason [Grid] is a plain object.
 *
 * Nothing here is a new rule. The cycle is `Grid.nextState`, the encoding is
 * `Grid.valueForState` (including the inversion for a habit shown as something
 * to avoid), what a stored day MEANS is `Habit`'s, and the write is [Outbox]'s.
 * A widget is squarely on the offline side of "a client mirrors a rule only if
 * it must work offline", and it needed no sixth mirror to get there: what it
 * adds is a CACHE, and the two questions a cache raises — which day is this
 * about, and who wins while a write is in flight.
 */
object Widgets {

    /**
     * One widget's whole world: which habit, and what it last knew about a day.
     *
     * It carries the habit's SHAPE and not just its id, because everything the
     * widget does happens with no network: `isAvoided` decides which way up the
     * colours go, `valueForState` needs the target to encode a slip, and the
     * name has to be drawable on a phone that has not reached the server in a
     * week. That is the reminder cache's reasoning applied to a second surface
     * — and a second record rather than a wider cache, because that one holds
     * only the habits carrying a reminder, and a widget is for whichever habit
     * you put on the home screen.
     *
     * The day is stored as a VALUE and a SKIP rather than as one of the four
     * states, because that is what the server sent and what the outbox will
     * send back, and because "6 of 8 glasses" is a number the widget shows. The
     * state is derived — by [stateOn], which is also where the date is checked.
     *
     * @param date  the day [value] is about, never assumed to be today.
     */
    data class Record(
        val widgetId: Int,
        val habitId: Long,
        val name: String,
        val type: String,
        val targetValue: Double,
        val targetType: String,
        val showAs: String,
        val color: String,
        val unit: String,
        val date: String,
        /** What the day holds, or null for a day with no row at all. */
        val value: Double?,
        val skip: Boolean,
        /**
         * Whether a day with NO ROW already counts as kept, for this habit —
         * the server-resolved [Habit.unloggedIsSuccess]. Cached here for the
         * same reason the shape fields above are: a tap happens with no
         * network, and this is what tells [markFor] whether the day's ghost
         * tick has to survive a refresh. Defaults to `false`, so a record
         * written before this field existed, or a blank one still waiting on
         * [refreshed], draws the fail-safe way until the next refresh fills
         * it in.
         */
        val unloggedIsSuccess: Boolean = false,
        /**
         * The habit is no longer on the account — deleted, or archived.
         *
         * Kept rather than dropped, because a widget the launcher still shows
         * is a widget somebody can still press, and a record quietly removed
         * leaves the LAST DRAWING on the home screen with its click intent
         * intact: a tap then paints a tick, the write 404s, `isPermanent` drops
         * it, and nothing ever repaints the cell. `Reminders.armFrom` has the
         * same problem and answers it the same way, by acting on the habits
         * that have gone rather than only on the ones that remain.
         */
        val gone: Boolean = false,
        /**
         * The SERVER's score, as of [date] — cached, not recomputed. `/api/overview`
         * already returns it per habit, and the arithmetic behind it (Loop's
         * `0.5^(sqrt(frequency)/13)` decay, the most intricate figure in the
         * project) is deliberately NOT mirrored here: a second implementation
         * would drift from the first invisibly. See the comment on [refreshed],
         * where this is taken from the fetch.
         */
        val score: Double = 0.0,
        /**
         * The SERVER's current streak, as of [date] — the same cached-answer
         * rule as [score], and for the same reason: the streak arithmetic is
         * not this client's to compute a second time.
         */
        val currentStreak: Int = 0,
        /**
         * The stats widget's history strip, encoded — see [encodeHistory] /
         * [decodeHistory]. Only the dates the habit has a STATED answer for;
         * an absent date is unknown, never "no" (root `CLAUDE.md`: never
         * collapse the two).
         */
        val history: String = "",
        /**
         * Whether [score]/[currentStreak] are known to be behind an ANSWER
         * this phone has recorded — not whether the strip itself has moved.
         *
         * [date] names the day the ENTRY is about; it does not say when the
         * figures were last fetched, and [answered] can record an answer with
         * no network at all — a notification's buttons, its number pad, or
         * the checkmark widget's own tap. Left unset, a local answer left the
         * score and streak exactly what the last `/overview` fetch said, and
         * `record.date == today` then read as "everything here is current"
         * when only the strip was. Set wherever an ANSWER IS RECORDED without
         * a fetch — both of [answered]'s branches, including the one that
         * hands the record back with `date`/`value` unchanged because the
         * answer named an older day than the record already held: something
         * was still recorded there (a notification still in the shade,
         * answered after a sync), so the figures are exactly as behind as
         * they were the instant before. The definition used to be "wherever
         * the strip moves", which the early-return branch satisfied by
         * construction — nothing moved — while leaving exactly the case
         * above presenting stale figures as current; the field is defined by
         * what its one reader (`StatsWidget.render`) asks of it, not by the
         * mechanism that happens to make it true elsewhere. Cleared in
         * [refreshed] — a successful fetch is exactly what makes the figures
         * current again. `WidgetSync.noteRefused` is the one exception: a
         * refusal never reached the server, so the last fetch's figures are
         * unaffected by it, and it leaves this flag exactly as it found it.
         *
         * Defaults to `false`, same fail-safe direction as
         * [unloggedIsSuccess] — but not because a record from before this
         * field existed cannot hold a local answer the figures have not
         * caught up with; it can, from a tap on the previous build waiting on
         * its first fetch under this one. `false` is still the right
         * default: `true` would put a spurious note on every widget on every
         * upgrading phone, and the window `false` leaves open is one
         * pre-upgrade local answer, closing at the very next fetch.
         */
        val figuresStale: Boolean = false,
    ) {
        /**
         * Enough of a habit for the rules that decide a tap and its colour.
         * Only the fields above are stored, so this is the habit as far as
         * `isAvoided`, `isMet` and `valueForState` are concerned, and no
         * further.
         */
        val habit get() = Habit(
            id = habitId,
            name = name,
            type = type,
            unit = unit,
            targetValue = targetValue,
            targetType = targetType,
            showAs = showAs,
            color = color,
            unloggedIsSuccess = unloggedIsSuccess,
        )
    }

    /** What a tap should record, and what to paint while it is in flight. */
    data class Tap(val next: Grid.DayState, val value: Double?, val skip: Boolean)

    /**
     * What to paint for [today].
     *
     * A record is about ONE day and says which, so a day that has rolled over
     * paints as unknown rather than as yesterday's answer. That is the whole of
     * the midnight problem: a widget has no `onResume` — `MainActivity` re-reads
     * `LocalDate.now()` on every one and nothing here can — so a record made
     * yesterday would otherwise show a tick against today, and be tapped from
     * the wrong state into the wrong write.
     */
    fun stateOn(record: Record, today: String): Grid.DayState {
        if (record.date != today) return Grid.DayState.UNKNOWN
        return Grid.dayStateOf(
            record.value,
            record.skip,
            record.habit.isMet(record.value, record.skip) == true,
        )
    }

    /**
     * Whether a tap should ask for a number instead of cycling.
     *
     * The same predicate the notification uses, and for the same reason: a
     * habit shown as something to avoid is answered yes-or-no even though it is
     * stored as a measurable one, while "8 glasses" cannot be answered by a
     * tap at all. Cycling one anyway would record `YES` — 2 — as the day's
     * amount, which is `valueForState` being asked a question it is not for.
     */
    fun needsAmount(record: Record): Boolean =
        record.habit.isNumerical && !record.habit.isAvoided

    /**
     * What a tap on the widget records.
     *
     * The cycle is `Grid.nextState` — the pinned mirror of the web grid's,
     * which is Loop's — and both settings come from the local mirrors, because
     * a home-screen tap must work with no network, and the widget and the grid
     * disagreeing about what a tap does is exactly the drift those mirrors
     * exist to prevent.
     *
     * The three shapes of write are the outbox's, not new ones: a skip is the
     * status column and carries no value, an unknown day is the ABSENCE of a
     * row and so is a clear (`value == null && !skip`, which [Outbox] sends as
     * a DELETE), and anything else is a value that `valueForState` encodes —
     * which is where an avoided habit's clean day becomes 0 and its slip
     * becomes target + 1.
     */
    fun tap(
        record: Record,
        today: String,
        skipDays: Boolean,
        questionMarks: Boolean,
    ): Tap? {
        // A habit that has left the account cannot be answered: the write would
        // 404, `isPermanent` would drop it, and the tick would sit on the home
        // screen for good. The click intent is removed as well — this is the
        // rule, that is the surface — because a PendingIntent the launcher
        // already holds outlives the drawing that came with it.
        if (record.gone) return null
        val next = Grid.nextState(stateOn(record, today), skipDays, questionMarks)
        return when (next) {
            Grid.DayState.SKIPPED -> Tap(next, null, skip = true)
            Grid.DayState.UNKNOWN -> Tap(next, null, skip = false)
            else -> Tap(next, Grid.valueForState(record.habit, next), skip = false)
        }
    }

    /**
     * The mark drawn in the cell, mirroring `DayCell` in ui/DayGrid.kt state for
     * state — including the case that reads like a detail and is a judgement:
     * an avoided habit shows the COUNT when it is over a limit above zero,
     * because how far over matters on a limit of two, and a bare cross only
     * where the count would add nothing the cross does not already say.
     *
     * Here rather than in the widget's rendering code so it can be held to that
     * claim by a test; the drawing around it is RemoteViews and cannot be.
     */
    fun markFor(record: Record, state: Grid.DayState, questionMarks: Boolean): String {
        val habit = record.habit
        return when {
            state == Grid.DayState.SKIPPED -> "–"
            // The ghost tick replaces the `?` rather than sitting beside it,
            // ahead of the `questionMarks` arm for the same reason `DayCell`
            // puts its own version first: one glyph, one slot.
            state == Grid.DayState.UNKNOWN && habit.unloggedIsSuccess -> "✓"
            state == Grid.DayState.UNKNOWN -> if (questionMarks) "?" else ""
            habit.isAvoided && state == Grid.DayState.DONE -> "✓"
            habit.isAvoided -> record.value?.let {
                if (habit.targetValue == 0.0 && it == 1.0) "✗" else trimNumber(it)
            } ?: ""
            habit.isNumerical -> record.value?.let { trimNumber(it) } ?: ""
            state == Grid.DayState.DONE -> "✓"
            else -> ""
        }
    }

    /** 2.0 -> "2", 2.5 -> "2.5". A formatter, not a rule. */
    fun trimNumber(n: Double): String =
        if (n == n.toLong().toDouble()) n.toLong().toString() else n.toString()

    /**
     * The next local midnight, which is when a widget's day becomes the wrong
     * day.
     *
     * `atStartOfDay` rather than `atTime(0, 0)`, because in a zone that springs
     * forward AT midnight — America/Santiago does — there is no 00:00 on that
     * date at all, and java.time answers 01:00 rather than throwing or landing
     * on the day before.
     */
    fun nextMidnight(now: ZonedDateTime): ZonedDateTime =
        now.toLocalDate().plusDays(1).atStartOfDay(now.zone)

    /**
     * Re-point records at the widget ids a restore has just handed out.
     *
     * A backup restores the DataStore and the launcher's widgets separately,
     * and the ids do not survive: `ACTION_APPWIDGET_RESTORED` is where the
     * system says which old id became which new one. Without this every record
     * names an id nobody holds, `redraw` matches none of them, and every widget
     * on the restored phone is permanently dead — the same terminal state as a
     * record that will not parse, reached by an ordinary device transfer.
     */
    fun remap(records: List<Record>, oldIds: IntArray, newIds: IntArray): List<Record> {
        val moved = oldIds.zip(newIds.toList()).toMap()
        val taken = newIds.toSet()
        return records
            // A record the restore did not mention keeps its id — it may be a
            // widget that was never in the backup — EXCEPT where that id is one
            // the restore has just handed to somebody else. Measured:
            // `remap([7, 12], old=[7], new=[12])` returned two records both
            // holding 12, and the launcher's new ids come off a low counter
            // that overlaps the backup's heavily. `redraw` then drew one and
            // `tap` resolved the other with `firstOrNull`, so the home screen
            // showed habit B and recording it wrote habit A.
            .filterNot { it.widgetId in taken && moved[it.widgetId] == null }
            .map { r -> moved[r.widgetId]?.let { r.copy(widgetId = it) } ?: r }
    }

    /**
     * How many strip cells a widget of this width should draw.
     *
     * Explicit thresholds rather than an arithmetic formula, because there is
     * no calculation to justify — this is a designer's answer to "how many
     * cells fit", pinned as literals so a test asserts the literals and not a
     * constant that could drift with the layout unnoticed.
     */
    const val MAX_STRIP_DAYS = 7

    fun stripDays(minWidthDp: Int): Int = when {
        minWidthDp >= 250 -> 7
        minWidthDp >= 210 -> 6
        minWidthDp >= 170 -> 5
        minWidthDp >= 130 -> 4
        else -> 3
    }

    /**
     * The stats widget's history strip, encoded into one field of [Record].
     *
     * Comma-separated `date:value` tokens, or `date:s` for a skip — only for
     * dates the habit has a STATED answer for; an absent date means unknown,
     * never "no" (root `CLAUDE.md`: never collapse the two). Read through
     * `habit.isSkipped`/`valueOn`, the same pair [refreshed] itself reads, so
     * a Loop SKIP sentinel and the out-of-band skip list resolve to the same
     * date only once.
     *
     * Machine-built from dates and doubles, so unlike [Record.name] or
     * [Record.unit] this can never itself hold `|`, `\n` or `\r` — there is
     * nothing here [flatten] would ever have to strip.
     */
    fun encodeHistory(habit: Habit, endDate: String, days: Int): String {
        val end = LocalDate.parse(endDate)
        return (0 until days)
            .map { end.minusDays(it.toLong()).toString() }
            .mapNotNull { date ->
                if (habit.isSkipped(date)) "$date:s"
                else habit.valueOn(date)?.let { "$date:$it" }
            }
            .joinToString(",")
    }

    /**
     * The reverse of [encodeHistory]: date -> (value, isSkip).
     *
     * A malformed token is skipped rather than fatal, [decode]'s own rule
     * applied one field deeper — one bad token in the strip must not cost the
     * rest of it.
     */
    fun decodeHistory(s: String): Map<String, Pair<Double?, Boolean>> {
        if (s.isEmpty()) return emptyMap()
        return s.split(",").mapNotNull { token ->
            val parts = token.split(":")
            if (parts.size != 2) return@mapNotNull null
            val (date, v) = parts
            if (v == "s") date to (null as Double? to true)
            else v.toDoubleOrNull()?.let { date to (it as Double? to false) }
        }.toMap()
    }

    /**
     * The strip's resolution: [columns] days, oldest first, ending at [today].
     *
     * `record.date` is the one exception to reading [decodeHistory]: it
     * resolves from `record.value`/`record.skip` instead, because that pair is
     * what `WidgetSync.noteAnswer` keeps current — the notification's buttons
     * and its number pad map over every record for the habit, so an answer
     * given there has to show on every one of its widgets immediately, or two
     * widgets for the same habit on one home screen would disagree about the
     * same day. A widget's own tap does NOT reach that far: `HabitWidget.tap`
     * writes back only its own record (`putWidgets(listOf(...))`, and
     * `Settings.putWidgets` upserts keyed by `widgetId`), so a second widget
     * for the same habit is untouched by it and the two stay disagreeing
     * until the next fetch — the carve-out below is still worth having for
     * the case it actually closes, `noteAnswer`'s. [stateOn] already draws
     * exactly that distinction (unknown unless the date matches
     * `record.date`), so it is reused rather than a fifth opinion about what
     * a stored day means.
     *
     * A date with no answer — including every date AFTER `record.date` on a
     * stale record, [today] itself among them — is UNKNOWN, never NO.
     *
     * No `questionMarks` parameter: the strip has no glyphs (see the comment
     * on `StatsWidget.render`), so there is nothing here for the setting to
     * govern, and the tap cycle it otherwise feeds (`Grid.nextState`) is
     * unreachable from a read-only widget. STEP 1 carried it to match this
     * function's brief signature; it was unused, and an unused parameter is a
     * false claim that the function honours the setting.
     */
    fun stripStates(
        record: Record,
        today: String,
        columns: Int,
    ): List<Pair<String, Grid.DayState>> {
        val history = decodeHistory(record.history)
        val end = LocalDate.parse(today)
        val dates = (0 until columns).map { end.minusDays(it.toLong()).toString() }.reversed()
        return dates.map { date ->
            val state = if (date == record.date) {
                stateOn(record, date)
            } else {
                val entry = history[date]
                if (entry == null) Grid.DayState.UNKNOWN
                else Grid.dayStateOf(
                    entry.first,
                    entry.second,
                    record.habit.isMet(entry.first, entry.second) == true,
                )
            }
            date to state
        }
    }

    /**
     * The record after a refresh, whether or not the habit is still there.
     *
     * A null [habit] means the account no longer has it — deleted, or archived,
     * since `/api/overview` carries neither. The record is kept and marked, not
     * dropped: a widget the launcher still shows is one somebody can still
     * press, and a record quietly removed leaves the last drawing up with its
     * click intent intact. The reverse is a real case too, so un-archiving
     * clears the flag rather than requiring the widget to be placed again.
     *
     * Here rather than in `WidgetSync` because it is the decision, and a
     * decision inside a suspend function that needs a Context is one no test
     * can reach.
     */
    fun refreshedOrGone(record: Record, habit: Habit?, today: String): Record =
        if (habit == null) record.copy(gone = true)
        else refreshed(record, habit, today).copy(gone = false)

    /** The record as the server's answer for [today] leaves it. */
    fun refreshed(record: Record, habit: Habit, today: String) = record.copy(
        // The habit's own fields move too: renaming it, or changing its target,
        // has to reach the home screen, and this is the only path that carries
        // it there.
        name = habit.name,
        type = habit.type,
        targetValue = habit.targetValue,
        targetType = habit.targetType,
        showAs = habit.showAs,
        color = habit.color,
        unit = habit.unit,
        date = today,
        // Through the habit rather than the raw map, exactly as the day grid
        // reads it: a yes/no day carrying Loop's old SKIP sentinel is a skip,
        // and `valueOn` is null for a day with no row — which is what tells an
        // unanswered day from a stated lapse further down.
        value = habit.valueOn(today),
        skip = habit.isSkipped(today),
        // Server-resolved, and not this client's to compute — see
        // `Habit.unloggedIsSuccess`.
        unloggedIsSuccess = habit.unloggedIsSuccess,
        // The cached ANSWER, not the rule: `/api/overview` already computed
        // these, and the decay behind `score` and the arithmetic behind
        // `currentStreak` are deliberately NOT reimplemented here — see the
        // KDoc on `Record.score`. This is the one place the figures are taken
        // from the fetch; if "make the strip update between syncs" ever looks
        // tempting, the answer is still no.
        score = habit.score,
        currentStreak = habit.currentStreak,
        history = encodeHistory(habit, today, MAX_STRIP_DAYS),
        // A successful fetch is exactly what makes the figures current
        // again — see the KDoc on `Record.figuresStale`.
        figuresStale = false,
    )

    /**
     * The record after an answer given somewhere else on this phone — the
     * notification's buttons, or its number pad.
     *
     * Those write through the outbox and never touch the server directly, so
     * without this the home screen would go on showing an unanswered day for
     * as long as it took a refresh to arrive. It is the same optimistic paint
     * the widget's own tap makes, from the same two values.
     *
     * An answer about an OLDER day than the record holds is ignored, because a
     * record is about one day and that day is the newest anything has told it:
     * answering a reminder posted at 23:50 at five past midnight would
     * otherwise rewrite the record back to yesterday and blank the day the
     * widget has already moved on to.
     */
    fun answered(record: Record, date: String, value: Double?, skip: Boolean) =
        if (date < record.date) {
            // `date`/`value` stay put — an older answer must not rewind the
            // record — but an ANSWER was still just recorded with no fetch
            // behind it: a notification still in the shade about yesterday,
            // pressed after this morning's sync. `figuresStale` is defined by
            // that, not by whether the strip moved, so it is set here too.
            // Handing back `record` unchanged used to leave the flag exactly
            // as it was before this answer — `false`, if the morning's fetch
            // had cleared it — presenting the 08:00 score and streak as
            // current while this write sits in the outbox.
            record.copy(figuresStale = true)
        } else {
            // The strip has moved too; the score and streak have not —
            // nothing here re-fetched `/overview`, so `figuresStale` records
            // that the two have parted ways until the next one does.
            record.copy(date = date, value = value, skip = skip, figuresStale = true)
        }

    /**
     * `widgetId|habitId|name|type|target|targetType|showAs|color|unit|date|value|skip`.
     *
     * A flat line for the reason the reminder cache is one: it is read with no
     * network by a broadcast receiver, and parsing it must never be able to
     * cost the user their widget. Separators are stripped from the free text, a
     * malformed line is skipped rather than fatal, and anything added later
     * goes on the END and is read with `getOrNull`, so a record written by an
     * older build still draws.
     *
     * An empty value field is a day with NO ROW, which is not the same as a day
     * holding zero — the distinction the whole four-state model exists to draw,
     * and one an empty string would quietly lose if `toDoubleOrNull` were read
     * as `?: 0.0`.
     */
    fun encode(r: Record): String = listOf(
        r.widgetId.toString(),
        r.habitId.toString(),
        flatten(r.name),
        r.type,
        r.targetValue.toString(),
        r.targetType,
        r.showAs,
        r.color,
        flatten(r.unit),
        r.date,
        r.value?.toString() ?: "",
        if (r.skip) "1" else "0",
        if (r.gone) "1" else "0",
        // Appended after `gone` for the same reason that field went on the
        // end: a record written before this one existed has thirteen fields
        // and must still draw.
        if (r.unloggedIsSuccess) "1" else "0",
        // Fields 14-15-16, the stats widget's cached figures. Same rule again:
        // a record written before these existed has fourteen fields and must
        // still draw, reading `0.0` / `0` / "" back for them.
        r.score.toString(),
        r.currentStreak.toString(),
        // Not `flatten`ed: `encodeHistory` builds this from dates and doubles
        // only, so it never contains `|`, `\n` or `\r` to strip.
        r.history,
        // Field 17, same append-only rule as 14-16: a record written before
        // this existed has seventeen fields and must still draw, reading
        // `false` back — the strip's own currency, not the figures'.
        if (r.figuresStale) "1" else "0",
    ).joinToString("|")

    /**
     * Free text, made safe for a line-delimited record.
     *
     * `\r` is in here and was not, which cost the whole widget: Kotlin's
     * `lineSequence` splits on a bare carriage return as well as a newline, so
     * a habit named `Run\rfast` wrote one record and read back as two
     * unparseable halves — leaving the widget on its `initialLayout` with no
     * click intent at all, unable to draw and unable to be tapped back to life.
     * `parseHabit` only trims, so an interior `\r` reaches storage from a
     * paste, a Loop import or the API, and `validate.js` already flattens
     * `[\r\n]` out of `reminder_message` for exactly this reader.
     */
    fun flatten(text: String): String =
        text.replace('|', ' ').replace('\n', ' ').replace('\r', ' ')

    fun decode(line: String): Record? {
        val f = line.split('|')
        if (f.size < 12) return null
        val widgetId = f[0].toIntOrNull() ?: return null
        val habitId = f[1].toLongOrNull() ?: return null
        return Record(
            widgetId = widgetId,
            habitId = habitId,
            name = f[2],
            type = f[3],
            targetValue = f[4].toDoubleOrNull() ?: 0.0,
            targetType = f[5],
            showAs = f[6],
            color = f[7],
            unit = f[8],
            date = f[9],
            value = f[10].toDoubleOrNull(),
            skip = f[11] == "1",
            // Appended, never inserted, and read with getOrNull: a record
            // written before this field existed has twelve fields and must
            // still draw.
            gone = f.getOrNull(12) == "1",
            // Same reasoning, one field later: a record written before this
            // one existed has thirteen fields, and an absent flag means "not
            // known to be kept" — the fail-safe direction, same as `Habit`'s
            // own default — rather than a claim either way.
            unloggedIsSuccess = f.getOrNull(13) == "1",
            // Fields 14-15-16. A record written before the stats widget
            // existed has fourteen fields; a junk token in any of these three
            // (a future field this build does not understand shifting them,
            // or plain corruption) falls back rather than throwing — a bad
            // score must not cost the whole record the way a bad widgetId or
            // habitId already does above.
            score = f.getOrNull(14)?.toDoubleOrNull() ?: 0.0,
            currentStreak = f.getOrNull(15)?.toIntOrNull() ?: 0,
            history = f.getOrNull(16) ?: "",
            // Field 17. Absent defaults to `false` — not because a record
            // from before this field existed cannot hold a local answer the
            // figures have not caught up with (it can: a tap on the previous
            // build, still waiting on its first fetch under this one), but
            // because `true` instead would put a spurious note on every
            // widget on every upgrading phone. The window `false` leaves
            // open is one pre-upgrade local answer, closing at the very next
            // fetch — same fail-safe direction as `unloggedIsSuccess` above,
            // for a real and bounded cost rather than none.
            figuresStale = f.getOrNull(17) == "1",
        )
    }

    fun decodeAll(raw: String): List<Record> =
        raw.lineSequence().mapNotNull { decode(it) }.toList()

    fun encodeAll(records: List<Record>): String =
        records.joinToString("\n") { encode(it) }
}
