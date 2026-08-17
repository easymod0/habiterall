package com.habiterall.app

import com.habiterall.app.data.Grid
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Sentinels
import com.habiterall.app.data.Widgets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The home-screen widget's own arithmetic.
 *
 * The cycle and the encoding are `GridTest`'s and are not repeated here. What
 * this pins is what only the widget has: a record that names the day it is
 * about, and a tap that has to be judged against TODAY rather than against
 * whatever the widget was drawn with.
 */
class WidgetTest {

    private val today = "2026-08-16"
    private val yesterday = "2026-08-15"

    private fun record(
        habit: Habit,
        date: String = today,
        value: Double? = null,
        skip: Boolean = false,
    ) = Widgets.Record(
        widgetId = 7,
        habitId = habit.id,
        name = habit.name,
        type = habit.type,
        targetValue = habit.targetValue,
        targetType = habit.targetType,
        showAs = habit.showAs,
        color = habit.color,
        unit = habit.unit,
        date = date,
        value = value,
        skip = skip,
    )

    private fun boolHabit() = Habit(id = 1, name = "Meditate")

    private fun waterHabit() =
        Habit(id = 2, name = "Water", type = "numerical", targetValue = 8.0)

    private fun avoidedHabit() = Habit(
        id = 3,
        name = "Smoking",
        type = "numerical",
        targetValue = 2.0,
        targetType = "at_most",
        showAs = "avoid",
    )

    /* ---------- which day the record is about ---------- */

    @Test
    fun `a record made yesterday paints as unanswered today`() {
        // The whole of the midnight problem. A widget has no `onResume` — the
        // list re-reads the date on every one — so a record that named no day
        // would show yesterday's tick against today, and be tapped from there.
        val done = record(boolHabit(), date = yesterday, value = Sentinels.YES)
        assertEquals(Grid.DayState.DONE, Widgets.stateOn(done, yesterday))
        assertEquals(Grid.DayState.UNKNOWN, Widgets.stateOn(done, today))
    }

    @Test
    fun `a tap after midnight starts today from unanswered`() {
        // The consequence that costs a day rather than a pixel: read as DONE,
        // the tap would advance to "not done" and record a MISS against a day
        // nobody has touched.
        val done = record(boolHabit(), date = yesterday, value = Sentinels.YES)
        val tap = Widgets.tap(done, today, skipDays = false, questionMarks = false)
        assertEquals(Grid.DayState.DONE, tap.next)
        assertEquals(Sentinels.YES, tap.value)
    }

    @Test
    fun `the four states come from the value and the status, not from a fourth rule`() {
        assertEquals(
            Grid.DayState.UNKNOWN,
            Widgets.stateOn(record(boolHabit(), value = null), today),
        )
        assertEquals(
            Grid.DayState.NO,
            Widgets.stateOn(record(boolHabit(), value = Sentinels.UNSET), today),
        )
        assertEquals(
            Grid.DayState.DONE,
            Widgets.stateOn(record(boolHabit(), value = Sentinels.YES), today),
        )
        assertEquals(
            Grid.DayState.SKIPPED,
            Widgets.stateOn(record(boolHabit(), value = null, skip = true), today),
        )
        // Six of eight glasses is a day with something on it and not a done
        // one — the distinction `needsReminder` is also built on.
        assertEquals(
            Grid.DayState.NO,
            Widgets.stateOn(record(waterHabit(), value = 6.0), today),
        )
    }

    /* ---------- what a tap writes ---------- */

    @Test
    fun `a tap on an avoided habit records the other way up`() {
        // `Grid.valueForState`'s job, reached through the record: a clean day
        // is none of the thing and a slip is the smallest amount that fails.
        // Encoding it here instead — YES for done — would paint a red cell for
        // a day the user just said was clean.
        val clean = Widgets.tap(record(avoidedHabit()), today, skipDays = false, questionMarks = false)
        assertEquals(Grid.DayState.DONE, clean.next)
        assertEquals(Sentinels.UNSET, clean.value)

        val slip = Widgets.tap(
            record(avoidedHabit(), value = Sentinels.UNSET),
            today,
            skipDays = false,
            questionMarks = false,
        )
        assertEquals(Grid.DayState.NO, slip.next)
        assertEquals(3.0, slip.value!!, 0.0)
    }

    @Test
    fun `a skip is the status column and an unknown day is a clear`() {
        val skipped = Widgets.tap(
            record(boolHabit(), value = Sentinels.YES),
            today,
            skipDays = true,
            questionMarks = false,
        )
        assertEquals(Grid.DayState.SKIPPED, skipped.next)
        assertTrue(skipped.skip)
        assertNull("a skip never carries a value", skipped.value)

        // With question marks on there is a way back to no row at all, and the
        // outbox spells that `value == null && !skip` — a DELETE.
        val cleared = Widgets.tap(
            record(boolHabit(), value = Sentinels.UNSET),
            today,
            skipDays = false,
            questionMarks = true,
        )
        assertEquals(Grid.DayState.UNKNOWN, cleared.next)
        assertFalse(cleared.skip)
        assertNull(cleared.value)
    }

    @Test
    fun `a measurable habit is asked for a number, unless it is one to avoid`() {
        // Cycling a measurable habit would record YES — 2 — as the amount.
        assertTrue(Widgets.needsAmount(record(waterHabit())))
        // Both of these are answered yes-or-no, exactly as the notification
        // decides it with the same predicate.
        assertFalse(Widgets.needsAmount(record(boolHabit())))
        assertFalse(Widgets.needsAmount(record(avoidedHabit())))
    }

    /* ---------- what a refresh takes from the server ---------- */

    @Test
    fun `a refresh reads the day through the habit`() {
        val habit = boolHabit().copy(
            name = "Meditate daily",
            // A skip carried as a bare 3, the way an imported Loop history has
            // it. Read from the raw map instead, this is a day with a 3 on it.
            entries = mapOf(today to Sentinels.SKIP, yesterday to Sentinels.YES),
        )
        val fresh = Widgets.refreshed(record(boolHabit()), habit, today)
        assertEquals("Meditate daily", fresh.name)
        assertEquals(today, fresh.date)
        assertTrue(fresh.skip)
        assertEquals(Grid.DayState.SKIPPED, Widgets.stateOn(fresh, today))
    }

    @Test
    fun `a day with no row is refreshed as no row, not as a zero`() {
        // The four-state distinction, at the one point a widget could lose it:
        // an unanswered day and a stated lapse are different answers, and only
        // one of them ends a streak.
        val fresh = Widgets.refreshed(record(boolHabit()), boolHabit(), today)
        assertNull(fresh.value)
        assertEquals(Grid.DayState.UNKNOWN, Widgets.stateOn(fresh, today))
    }

    /* ---------- the record on disk ---------- */

    @Test
    fun `a record survives a round trip through the cache`() {
        val original = record(avoidedHabit(), value = 3.0).copy(name = "Smoking|rolled\nup")
        val back = Widgets.decode(Widgets.encode(original))!!
        // The separators are stripped from free text rather than escaped, so a
        // habit named "a|b" cannot shift every field one place over.
        assertEquals("Smoking rolled up", back.name)
        assertEquals(original.copy(name = "Smoking rolled up"), back)
    }

    @Test
    fun `an empty value field is a day with no row`() {
        // `toDoubleOrNull() ?: 0.0` here would turn every unanswered day into a
        // stated lapse the moment it was written to disk and read back.
        val unanswered = record(boolHabit(), value = null)
        assertNull(Widgets.decode(Widgets.encode(unanswered))!!.value)

        val lapse = record(boolHabit(), value = 0.0)
        assertEquals(0.0, Widgets.decode(Widgets.encode(lapse))!!.value!!, 0.0)
    }

    @Test
    fun `a malformed line is skipped rather than fatal`() {
        val good = Widgets.encode(record(boolHabit()))
        // The third is the one that matters: a SHORT line — a record written by
        // a build with fewer fields — parses as far as a valid widget id and
        // then runs off the end. Reading it positionally without a length check
        // throws, and one bad line would cost every widget on the phone.
        val records = Widgets.decodeAll("nonsense\n$good\n7|1|Meditate|boolean\n|||\n")
        assertEquals(1, records.size)
        assertEquals(7, records[0].widgetId)
    }
}
