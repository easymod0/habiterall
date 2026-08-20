package com.habiterall.app

import androidx.compose.ui.graphics.Color
import com.habiterall.app.data.Habit
import com.habiterall.app.ui.dayFill
import com.habiterall.app.ui.dayLabel
import com.habiterall.app.ui.describe
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * `DayCell`'s three decisions, pulled out into `dayFill`, `dayLabel` and
 * `describe` for exactly this reason: a Compose `@Composable` cannot be held
 * to a test, and the drawing around these three is.
 *
 * What these pin is the kept-unlogged day — `Habit.unloggedIsSuccess`,
 * server-resolved — because it is the one day the grid used to say nothing
 * about while every other figure the server computes already counted it.
 */
class DayGridTest {

    private val color = Color(0xFF3B82F6)

    private fun waterHabit(unloggedIsSuccess: Boolean = false) = Habit(
        id = 1,
        name = "Water",
        type = "numerical",
        targetValue = 8.0,
        targetType = "at_most",
        unloggedIsSuccess = unloggedIsSuccess,
    )

    private fun avoidedHabit(unloggedIsSuccess: Boolean = false) = Habit(
        id = 2,
        name = "Smoking",
        type = "numerical",
        targetValue = 2.0,
        targetType = "at_most",
        showAs = "avoid",
        unloggedIsSuccess = unloggedIsSuccess,
    )

    /* ---------- fill ---------- */

    @Test
    fun `a kept-unlogged day is a faint version of the habit colour, clearly under a fallen-short fill`() {
        val fallenShort = dayFill(
            habit = waterHabit(),
            color = color,
            skipped = false,
            value = 3.0,
            met = false,
            unknown = false,
        )
        val keptUnlogged = dayFill(
            habit = waterHabit(unloggedIsSuccess = true),
            color = color,
            skipped = false,
            value = null,
            met = false,
            unknown = true,
        )
        assertNotEquals(fallenShort, keptUnlogged)
        assertEquals(color.copy(alpha = 0.15f), keptUnlogged)
        assertEquals(color.copy(alpha = 0.35f), fallenShort)
    }

    @Test
    fun `the faint fill applies the same way on a habit shown as something to avoid`() {
        // One idea drawn once: the avoided branch does not get a second,
        // differently-coloured answer for the same day.
        val keptUnlogged = dayFill(
            habit = avoidedHabit(unloggedIsSuccess = true),
            color = color,
            skipped = false,
            value = null,
            met = false,
            unknown = true,
        )
        assertEquals(color.copy(alpha = 0.15f), keptUnlogged)
    }

    @Test
    fun `the flag off draws nothing for an unanswered day, as before`() {
        val fill = dayFill(
            habit = waterHabit(unloggedIsSuccess = false),
            color = color,
            skipped = false,
            value = null,
            met = false,
            unknown = true,
        )
        assertEquals(Color.Transparent, fill)
    }

    @Test
    fun `a stored row is unaffected by the flag`() {
        val fill = dayFill(
            habit = waterHabit(unloggedIsSuccess = true),
            color = color,
            skipped = false,
            value = 3.0,
            met = false,
            unknown = false,
        )
        assertEquals(color.copy(alpha = 0.35f), fill)
    }

    /* ---------- label ---------- */

    @Test
    fun `flag on and no row is a ghost tick, question marks or not`() {
        val habit = waterHabit(unloggedIsSuccess = true)
        assertEquals(
            "✓",
            dayLabel(habit, questionMarks = false, skipped = false, value = null, met = false, unknown = true),
        )
        // The tick wins over `?` — one glyph, one slot — rather than the two
        // sitting beside each other.
        assertEquals(
            "✓",
            dayLabel(habit, questionMarks = true, skipped = false, value = null, met = false, unknown = true),
        )
    }

    @Test
    fun `flag off and no row falls back to the ordinary question mark rule`() {
        val habit = waterHabit(unloggedIsSuccess = false)
        assertEquals(
            "?",
            dayLabel(habit, questionMarks = true, skipped = false, value = null, met = false, unknown = true),
        )
        assertEquals(
            "",
            dayLabel(habit, questionMarks = false, skipped = false, value = null, met = false, unknown = true),
        )
    }

    @Test
    fun `a stored row keeps its own label regardless of the flag`() {
        val habit = waterHabit(unloggedIsSuccess = true)
        assertEquals(
            "6",
            dayLabel(habit, questionMarks = true, skipped = false, value = 6.0, met = false, unknown = false),
        )
    }

    /* ---------- describe ---------- */

    @Test
    fun `the accessibility text keeps both facts, ahead of the plain no-entry case`() {
        val habit = waterHabit(unloggedIsSuccess = true)
        val text = describe(habit, "2026-08-13", skipped = false, value = null, met = false, unanswered = true)
        assertEquals("Water, Thursday 13 August: counted as kept, no entry", text)
    }

    @Test
    fun `the flag off describes a plain unanswered day as before`() {
        val habit = waterHabit(unloggedIsSuccess = false)
        val text = describe(habit, "2026-08-13", skipped = false, value = null, met = false, unanswered = true)
        assertEquals("Water, Thursday 13 August: no entry", text)
    }
}
