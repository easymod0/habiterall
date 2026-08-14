package com.habiterall.app

import com.habiterall.app.data.Grid
import com.habiterall.app.data.Grid.DayState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/**
 * The day grid's arithmetic.
 *
 * These are the rules that only misbehave on a real phone mid-gesture — the
 * scroll jumping a month sideways as history loads, or the grid paging itself
 * to the cap before anyone has touched it — so they are pulled out of Compose
 * and pinned here, exactly as `ScrollRestore` was.
 */
class GridTest {

    private val today = LocalDate.parse("2026-08-13")

    @Test
    fun `newest-left puts today first and runs backwards`() {
        val dates = Grid.dates(today, 5, newestLeft = true)
        assertEquals(
            listOf("2026-08-13", "2026-08-12", "2026-08-11", "2026-08-10", "2026-08-09"),
            dates
        )
    }

    @Test
    fun `newest-right puts today last`() {
        val dates = Grid.dates(today, 5, newestLeft = false)
        assertEquals(
            listOf("2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13"),
            dates
        )
    }

    @Test
    fun `a window always ends today, whichever way it runs`() {
        // No future column exists, in either order, so nothing downstream has
        // to guard against writing to one.
        for (newestLeft in listOf(true, false)) {
            val dates = Grid.dates(today, 30, newestLeft)
            assertEquals(30, dates.size)
            assertEquals(today.toString(), if (newestLeft) dates.first() else dates.last())
            assertTrue(dates.all { it <= today.toString() })
        }
    }

    /* ---------- the cycle ---------- */

    @Test
    fun `tapping cycles unset to done to skipped and back`() {
        // The same order as the web grid's onCheckClick. If one changes, both
        // must: they are the same squares to the same person.
        assertEquals(DayState.DONE, Grid.nextState(DayState.UNSET))
        assertEquals(DayState.SKIPPED, Grid.nextState(DayState.DONE))
        assertEquals(DayState.UNSET, Grid.nextState(DayState.SKIPPED))
    }

    @Test
    fun `three taps return a day to where it started`() {
        var state = DayState.UNSET
        repeat(3) { state = Grid.nextState(state) }
        assertEquals(DayState.UNSET, state)
    }

    /* ---------- when to load more ---------- */

    @Test
    fun `newest-left loads more at the end of the scroll`() {
        // Older days are appended past the right edge, so the trigger is the
        // maximum.
        assertTrue(Grid.needsMore(900, 1000, 30, newestLeft = true, threshold = 120))
        assertFalse(Grid.needsMore(400, 1000, 30, newestLeft = true, threshold = 120))
    }

    @Test
    fun `newest-right loads more at the start of the scroll`() {
        // Mirrored: older days are prepended, so approaching zero is what asks
        // for them. Getting this backwards means the grid loads history when
        // you scroll towards today and never when you scroll away from it.
        assertTrue(Grid.needsMore(60, 1000, 30, newestLeft = false, threshold = 120))
        assertFalse(Grid.needsMore(600, 1000, 30, newestLeft = false, threshold = 120))
    }

    @Test
    fun `nothing is loaded before there is anything to scroll`() {
        // The first frame reports a max of 0. Treating that as "at the start"
        // pages straight to the cap without anyone touching the screen —
        // twelve requests, on launch, every launch.
        assertFalse(Grid.needsMore(0, 0, 30, newestLeft = false, threshold = 120))
        assertFalse(Grid.needsMore(0, 0, 30, newestLeft = true, threshold = 120))
    }

    @Test
    fun `the cap is honoured, since the server has one too`() {
        // /api/overview clamps days to 365, so past the cap every extra request
        // returns the same window and the grid would ask forever.
        assertFalse(
            Grid.needsMore(1000, 1000, Grid.MAX_DAYS, newestLeft = true, threshold = 120)
        )
        assertTrue(Grid.MAX_DAYS >= Grid.INITIAL_DAYS)
    }

    /* ---------- keeping your place ---------- */

    @Test
    fun `appending history leaves the scroll alone`() {
        // Newest-left grows off the right edge: nothing under the finger moves.
        assertEquals(500, Grid.scrollAfterGrowth(500, 30, 100, newestLeft = true))
    }

    @Test
    fun `prepending history moves the scroll by exactly what was added`() {
        // Newest-right grows off the LEFT edge, so every column shifts by its
        // own width. Without the correction the grid jumps a month sideways at
        // the moment it loads more, which reads as losing your place.
        assertEquals(3500, Grid.scrollAfterGrowth(500, 30, 100, newestLeft = false))
    }

    @Test
    fun `growing by nothing changes nothing`() {
        for (newestLeft in listOf(true, false)) {
            assertEquals(500, Grid.scrollAfterGrowth(500, 0, 100, newestLeft))
        }
    }
}
