package com.habiterall.app

import com.habiterall.app.data.Grid
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Sentinels
import com.habiterall.app.data.Widgets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

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
        unloggedIsSuccess: Boolean = false,
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
        unloggedIsSuccess = unloggedIsSuccess,
    )

    private fun boolHabit() = Habit(id = 1, name = "Meditate")

    private fun waterHabit() =
        Habit(id = 2, name = "Water", type = "numerical", targetValue = 8.0)

    private fun avoidedHabit(): Habit = Habit(
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
        val tap = Widgets.tap(done, today, skipDays = false, questionMarks = false)!!
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
        val clean =
            Widgets.tap(record(avoidedHabit()), today, skipDays = false, questionMarks = false)!!
        assertEquals(Grid.DayState.DONE, clean.next)
        assertEquals(Sentinels.UNSET, clean.value)

        val slip = Widgets.tap(
            record(avoidedHabit(), value = Sentinels.UNSET),
            today,
            skipDays = false,
            questionMarks = false,
        )!!
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
        )!!
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
        )!!
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

    @Test
    fun `a refresh carries the server's resolved kept-unlogged flag onto the record`() {
        // Not this client's to compute — a stale cached `false` would go on
        // drawing a plain empty square after the account or the habit turned
        // the setting on, until the process died and restarted.
        val habit = waterHabit().copy(unloggedIsSuccess = true)
        val fresh = Widgets.refreshed(record(waterHabit()), habit, today)
        assertTrue(fresh.unloggedIsSuccess)

        val back = Widgets.refreshed(fresh, waterHabit(), today)
        assertFalse(back.unloggedIsSuccess)
    }

    /* ---------- a habit that is no longer there ---------- */

    @Test
    fun `a habit that has left the account stops accepting taps`() {
        // `/api/overview` carries neither a deleted habit nor an archived one,
        // so both arrive here as an absence. Leaving the record alone was the
        // first version and it left the widget TAPPABLE: the launcher goes on
        // drawing the last cell with its click intent, a tap paints a tick, the
        // write 404s, `isPermanent` drops it, and nothing ever repaints — a
        // tick that stays up for good on a habit that does not exist.
        val live = record(boolHabit())
        val gone = Widgets.refreshedOrGone(live, null, today)
        assertTrue(gone.gone)
        assertNull(Widgets.tap(gone, today, skipDays = false, questionMarks = false))
        // The name is kept, because it is what the widget still says.
        assertEquals("Meditate", gone.name)
    }

    @Test
    fun `un-archiving a habit brings its widget back`() {
        val gone = record(boolHabit()).copy(gone = true)
        val back = Widgets.refreshedOrGone(gone, boolHabit(), today)
        assertFalse(back.gone)
        assertNotNull(Widgets.tap(back, today, skipDays = false, questionMarks = false))
    }

    /* ---------- midnight, and the restore ---------- */

    @Test
    fun `the next midnight is the start of tomorrow, in the phone's own zone`() {
        val toronto = ZoneId.of("America/Toronto")
        val at = Widgets.nextMidnight(ZonedDateTime.of(2026, 8, 16, 22, 30, 0, 0, toronto))
        assertEquals(ZonedDateTime.of(2026, 8, 17, 0, 0, 0, 0, toronto), at)
    }

    @Test
    fun `a day with no midnight still has a next midnight`() {
        // Santiago springs forward AT midnight: 2026-09-06 has no 00:00 at all.
        // `atTime(0, 0).atZone(...)` is the obvious spelling and it resolves
        // forward to 01:00 too — but `atStartOfDay` is the one that SAYS so,
        // and a zone that ever goes backward over midnight is why the two are
        // not the same function.
        val santiago = ZoneId.of("America/Santiago")
        val at = Widgets.nextMidnight(ZonedDateTime.of(2026, 9, 5, 22, 0, 0, 0, santiago))
        assertEquals(6, at.dayOfMonth)
        assertEquals(1, at.hour)
        assertTrue(at.toInstant().isAfter(
            ZonedDateTime.of(2026, 9, 5, 22, 0, 0, 0, santiago).toInstant()
        ))
    }

    @Test
    fun `a restore re-points records at the ids the launcher now holds`() {
        // A backup restores the DataStore and the widgets separately and the
        // ids do not survive. Without the remap every record names an id nobody
        // holds, `redraw` matches none of them, and every widget on the new
        // phone is blank and unpressable for good.
        val records = listOf(
            record(boolHabit()).copy(widgetId = 7),
            record(waterHabit()).copy(widgetId = 9),
        )
        val moved = Widgets.remap(records, intArrayOf(7, 9), intArrayOf(21, 22))
        assertEquals(listOf(21, 22), moved.map { it.widgetId })
        // Everything else is untouched, and an id the restore did not mention
        // stays as it is.
        assertEquals(records[0].habitId, moved[0].habitId)
        assertEquals(
            listOf(7),
            Widgets.remap(listOf(records[0]), intArrayOf(99), intArrayOf(100)).map { it.widgetId },
        )
    }

    @Test
    fun `a restore never leaves two records holding one widget id`() {
        // The two documented behaviours collide: ids move, and a record the
        // restore did not mention keeps the id it had. A fresh launcher hands
        // out ids from a low counter and a backup's ids are low too, so the
        // overlap is ordinary rather than exotic. Measured before the fix:
        // remapping [7, 12] with old=[7] new=[12] returned 12 twice, `redraw`
        // drew one of them and `tap` resolved the other with `firstOrNull` —
        // the home screen showing habit B while a tap recorded habit A.
        val records = listOf(
            record(boolHabit()).copy(widgetId = 7),
            record(waterHabit()).copy(widgetId = 12),
        )
        val moved = Widgets.remap(records, intArrayOf(7), intArrayOf(12))
        assertEquals(listOf(12), moved.map { it.widgetId })
        // And it is the RESTORED record that survives: the other names a widget
        // the launcher has just given to somebody else.
        assertEquals(records[0].habitId, moved.single().habitId)
    }

    @Test
    fun `a record written before the gone field still reads`() {
        // Twelve fields is what every widget on a phone that upgrades holds,
        // and the reader indexes positionally: a length check of 13 would
        // discard the lot, which is the unrecoverable state — blank, dead to
        // taps, with nothing left to repair it.
        val twelve = Widgets.encode(record(boolHabit())).split('|').take(12).joinToString("|")
        val back = Widgets.decode(twelve)
        assertNotNull(back)
        assertFalse("an absent field is not a claim that the habit is gone", back!!.gone)
        assertEquals(7, back.widgetId)
    }

    @Test
    fun `a record written before unloggedIsSuccess existed still reads`() {
        // Thirteen fields is what every widget holds today; the fourteenth is
        // this one, appended the same way `gone` was, and an absent flag must
        // not read as a claim the day was kept.
        val thirteen =
            Widgets.encode(record(boolHabit())).split('|').take(13).joinToString("|")
        val back = Widgets.decode(thirteen)
        assertNotNull(back)
        assertFalse(
            "an absent field is not a claim the day is counted as kept",
            back!!.unloggedIsSuccess,
        )
    }

    @Test
    fun `unloggedIsSuccess survives a round trip through the cache`() {
        val kept = record(waterHabit(), unloggedIsSuccess = true)
        assertTrue(Widgets.decode(Widgets.encode(kept))!!.unloggedIsSuccess)
        val notKept = record(waterHabit(), unloggedIsSuccess = false)
        assertFalse(Widgets.decode(Widgets.encode(notKept))!!.unloggedIsSuccess)
    }

    /* ---------- what the cell says ---------- */

    @Test
    fun `an avoided habit over a limit shows how far over`() {
        // `DayCell` shows the COUNT for a slip on a limit above zero, because
        // how far over matters on a limit of two — and a bare cross only where
        // the count would add nothing. The widget said "✗" for both under a
        // comment claiming it mirrored the grid state for state.
        val slip = record(avoidedHabit(), value = 3.0)
        assertEquals("3", Widgets.markFor(slip, Grid.DayState.NO, questionMarks = false))

        val limitOfNone = avoidedHabit().copy(targetValue = 0.0)
        val once = record(limitOfNone, value = 1.0)
        assertEquals("✗", Widgets.markFor(once, Grid.DayState.NO, questionMarks = false))
        // Two on a limit of none is still worth counting.
        assertEquals(
            "2",
            Widgets.markFor(record(limitOfNone, value = 2.0), Grid.DayState.NO, false),
        )
        // A clean day is a tick either way: the number says nothing on a limit.
        assertEquals(
            "✓",
            Widgets.markFor(record(avoidedHabit(), value = 0.0), Grid.DayState.DONE, false),
        )
    }

    @Test
    fun `the other three states say what the grid says`() {
        assertEquals("–", Widgets.markFor(record(boolHabit()), Grid.DayState.SKIPPED, false))
        assertEquals("", Widgets.markFor(record(boolHabit()), Grid.DayState.UNKNOWN, false))
        assertEquals("?", Widgets.markFor(record(boolHabit()), Grid.DayState.UNKNOWN, true))
        assertEquals("✓", Widgets.markFor(record(boolHabit()), Grid.DayState.DONE, false))
        // A yes/no "no" is an empty cell, exactly as the grid leaves it — with
        // question marks off it is the same square as a day with no row, which
        // is the whole reason the cycle has no step between them.
        assertEquals("", Widgets.markFor(record(boolHabit(), value = 0.0), Grid.DayState.NO, false))
        // A measurable habit shows its amount rather than a tick.
        assertEquals(
            "6",
            Widgets.markFor(record(waterHabit(), value = 6.0), Grid.DayState.NO, false),
        )
    }

    @Test
    fun `a day nobody answered on a kept-unlogged habit shows a ghost tick, not a question mark`() {
        // `Habit.unloggedIsSuccess` cached on the record, mirroring `DayCell`
        // state for state: the tick wins whether or not `questionMarks` is on,
        // because it replaces the `?` rather than sitting beside it — one
        // glyph, one slot.
        val kept = record(waterHabit(), value = null, unloggedIsSuccess = true)
        assertEquals("✓", Widgets.markFor(kept, Grid.DayState.UNKNOWN, questionMarks = false))
        assertEquals("✓", Widgets.markFor(kept, Grid.DayState.UNKNOWN, questionMarks = true))

        // The flag off is the ordinary rule: `questionMarks` alone decides.
        val notKept = record(waterHabit(), value = null, unloggedIsSuccess = false)
        assertEquals("", Widgets.markFor(notKept, Grid.DayState.UNKNOWN, questionMarks = false))
        assertEquals("?", Widgets.markFor(notKept, Grid.DayState.UNKNOWN, questionMarks = true))

        // A stored row is unaffected either way — the flag only ever answers
        // for the day with NO row at all.
        assertEquals(
            "6",
            Widgets.markFor(
                record(waterHabit(), value = 6.0, unloggedIsSuccess = true),
                Grid.DayState.NO,
                questionMarks = true,
            ),
        )
    }

    /* ---------- an answer that arrives about an older day ---------- */

    @Test
    fun `an answer about an older day does not rewind the record`() {
        // A reminder posted at 23:50 and answered at 00:05 names YESTERDAY, and
        // it is right to: the notification is about that day. But the widget
        // has already moved on, and taking the older answer would blank today
        // and paint a day that is over.
        val onToday = record(boolHabit(), value = Sentinels.YES)
        val stale = Widgets.answered(onToday, yesterday, Sentinels.YES, skip = false)
        assertEquals(today, stale.date)
        assertEquals(Sentinels.YES, stale.value)
        // The same day, and a later one, are taken as they always were.
        assertEquals(
            Sentinels.UNSET,
            Widgets.answered(onToday, today, Sentinels.UNSET, false).value,
        )
        assertEquals(
            "2026-08-17",
            Widgets.answered(onToday, "2026-08-17", Sentinels.YES, false).date,
        )
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
    fun `a carriage return in a habit name does not destroy the record`() {
        // Kotlin's `lineSequence` splits on a bare \r as well as a \n, so a
        // habit named "Run\rfast" wrote ONE line and read back as two
        // unparseable halves — and a widget with no record draws its
        // `initialLayout` with no click intent, so it is blank, dead to taps,
        // and cannot recover. `parseHabit` only trims, so an interior \r
        // reaches storage from a paste, a Loop import or the API.
        val record = record(boolHabit()).copy(name = "Run\rfast", unit = "km\rper day")
        val back = Widgets.decodeAll(Widgets.encodeAll(listOf(record)))
        assertEquals(1, back.size)
        assertEquals("Run fast", back[0].name)
        assertEquals("km per day", back[0].unit)
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
