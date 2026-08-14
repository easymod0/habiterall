package com.habiterall.app

import com.habiterall.app.data.AppSettings
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Sentinels
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * How a day is read off a habit, and which end of the grid today sits at.
 *
 * Both are mirrors of rules that live in the shared JavaScript, and a mirror
 * with nothing holding it in place is the drift `ServerUrlTest` was written to
 * prevent for `habitRoute`. `isSkipped` mirrors `normalizeEntry` in
 * shared/src/stats.js; `DEFAULT_DAY_ORDER` mirrors `SETTINGS.dayOrder.default`
 * in shared/public/ui/settings.js.
 */
class HabitEntryTest {

    private fun habit(
        type: String,
        entries: Map<String, Double> = emptyMap(),
        skips: List<String> = emptyList(),
        target: Double = 0.0,
        targetType: String = "at_least",
    ) = Habit(
        id = 1, name = "h", type = type, targetValue = target, targetType = targetType,
        entries = entries, skips = skips,
    )

    /* ---------- what counts as a skip ---------- */

    @Test
    fun `a listed date is a skip whatever the value beside it`() {
        val h = habit("boolean", entries = mapOf("2026-08-13" to 0.0), skips = listOf("2026-08-13"))
        assertTrue(h.isSkipped("2026-08-13"))
        assertNull(h.valueOn("2026-08-13"))
    }

    @Test
    fun `a bare 3 is a skip for a yes-no habit`() {
        // Loop's sentinel. It cannot mean anything else where the only other
        // values are 0 and 2.
        val h = habit("boolean", entries = mapOf("2026-08-13" to Sentinels.SKIP))
        assertTrue(h.isSkipped("2026-08-13"))
    }

    @Test
    fun `a bare 3 is an AMOUNT for a measurable habit`() {
        // The collision this whole arrangement exists to avoid: read as a skip,
        // three pages read becomes a day that never happened, and a real
        // failure bridges a streak instead of breaking it.
        val h = habit("numerical", entries = mapOf("2026-08-13" to 3.0), target = 20.0)
        assertFalse(h.isSkipped("2026-08-13"))
        assertEquals(3.0, h.valueOn("2026-08-13"))
        assertEquals(false, h.isMet(h.valueOn("2026-08-13"), h.isSkipped("2026-08-13")))
    }

    @Test
    fun `a measurable habit that recorded 3 and IS skipped reports the skip`() {
        // Both encodings at once: `skips` is authoritative, since it is the one
        // the server maintains out of band.
        val h = habit(
            "numerical", entries = mapOf("2026-08-13" to 3.0),
            skips = listOf("2026-08-13"), target = 20.0,
        )
        assertTrue(h.isSkipped("2026-08-13"))
        assertNull(h.valueOn("2026-08-13"))
    }

    @Test
    fun `a day with nothing recorded is neither skipped nor valued`() {
        val h = habit("boolean")
        assertFalse(h.isSkipped("2026-08-13"))
        assertNull(h.valueOn("2026-08-13"))
    }

    @Test
    fun `an at-most habit meets its goal at zero`() {
        // Zero is the good outcome here, and it must not be mistaken for "no
        // entry" — which is why `valueOn` returns null only for a skip.
        val h = habit("numerical", entries = mapOf("2026-08-13" to 0.0), targetType = "at_most")
        assertEquals(0.0, h.valueOn("2026-08-13"))
        assertEquals(true, h.isMet(h.valueOn("2026-08-13"), false))
    }

    /* ---------- which end today sits at ---------- */

    @Test
    fun `an untouched account gets the web app's default order`() {
        // Null is not empty: the setting has never been written, so the default
        // must match what the browser would have shown.
        assertEquals("newest-left", AppSettings.DEFAULT_DAY_ORDER)
        assertTrue(AppSettings().newestLeft)
        assertTrue(AppSettings(dayOrder = null).newestLeft)
    }

    @Test
    fun `the account's stored order is honoured both ways`() {
        assertTrue(AppSettings(dayOrder = "newest-left").newestLeft)
        assertFalse(AppSettings(dayOrder = "newest-right").newestLeft)
    }

    @Test
    fun `an order this client does not know falls back rather than flipping`() {
        // A newer server could add one. Guessing "not newest-left" would
        // silently reverse the grid for a value nobody here understands.
        assertFalse(AppSettings(dayOrder = "sideways").newestLeft)
    }
}
