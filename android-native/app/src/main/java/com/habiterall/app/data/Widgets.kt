package com.habiterall.app.data

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
        if (date < record.date) record else
        record.copy(date = date, value = value, skip = skip)

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
        )
    }

    fun decodeAll(raw: String): List<Record> =
        raw.lineSequence().mapNotNull { decode(it) }.toList()

    fun encodeAll(records: List<Record>): String =
        records.joinToString("\n") { encode(it) }
}
