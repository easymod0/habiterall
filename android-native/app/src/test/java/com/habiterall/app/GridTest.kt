package com.habiterall.app

import com.habiterall.app.data.Grid
import com.habiterall.app.data.Grid.DayState
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Sentinels
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

    /* ---------- the tap cycle ---------- */

    // Case for case with `test/toggle.test.js`, which pins the same examples
    // against `nextDayState`. Both mirror Loop's own `Entry.nextToggleValue`.
    // If one changes, all three must: they are the same squares to the same
    // person, and a tap that means something different depending on which client
    // is open is not a difference anyone finds in a changelog.

    @Test
    fun `with both settings off a day is done or not done and never unknown again`() {
        assertEquals(DayState.DONE, Grid.nextState(DayState.UNKNOWN))
        assertEquals(DayState.NO, Grid.nextState(DayState.DONE))
        assertEquals(DayState.DONE, Grid.nextState(DayState.NO))
    }

    @Test
    fun `skip days adds one step between done and not done`() {
        assertEquals(DayState.DONE, Grid.nextState(DayState.UNKNOWN, skipDays = true))
        assertEquals(DayState.SKIPPED, Grid.nextState(DayState.DONE, skipDays = true))
        assertEquals(DayState.NO, Grid.nextState(DayState.SKIPPED, skipDays = true))
        assertEquals(DayState.NO, Grid.nextState(DayState.DONE, skipDays = false))
    }

    @Test
    fun `question marks are what let a tap clear a day`() {
        assertEquals(DayState.UNKNOWN, Grid.nextState(DayState.NO, questionMarks = true))
        assertEquals(DayState.DONE, Grid.nextState(DayState.UNKNOWN, questionMarks = true))
        assertEquals(DayState.NO, Grid.nextState(DayState.DONE, questionMarks = true))
    }

    @Test
    fun `both on is the full four-state cycle`() {
        var state = DayState.UNKNOWN
        val seen = mutableListOf<DayState>()
        repeat(4) {
            state = Grid.nextState(state, skipDays = true, questionMarks = true)
            seen.add(state)
        }
        assertEquals(
            listOf(DayState.DONE, DayState.SKIPPED, DayState.NO, DayState.UNKNOWN),
            seen,
        )
    }

    @Test
    fun `a skipped day still moves on once skips are switched off`() {
        // The setting does not erase the skips already recorded — an imported
        // Loop history is full of them — so a tap on one has to go somewhere.
        assertEquals(DayState.NO, Grid.nextState(DayState.SKIPPED))
        assertEquals(DayState.NO, Grid.nextState(DayState.SKIPPED, questionMarks = true))
    }

    @Test
    fun `no row is unknown and a row holding zero is a stated no`() {
        // The distinction the whole feature rests on. Passing 0.0 where the map
        // held nothing would report every unanswered day as an answered "no".
        assertEquals(DayState.UNKNOWN, Grid.dayStateOf(null, isSkip = false, done = false))
        assertEquals(DayState.NO, Grid.dayStateOf(0.0, isSkip = false, done = false))
        assertEquals(DayState.DONE, Grid.dayStateOf(2.0, isSkip = false, done = true))
        assertEquals(DayState.NO, Grid.dayStateOf(8.0, isSkip = false, done = false))
        assertEquals(DayState.SKIPPED, Grid.dayStateOf(null, isSkip = true, done = false))
        assertEquals(DayState.SKIPPED, Grid.dayStateOf(0.0, isSkip = true, done = false))
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
        // returns the same window and the grid would ask forever. Both
        // directions, because the two take different branches.
        assertFalse(
            Grid.needsMore(1000, 1000, Grid.MAX_DAYS, newestLeft = true, threshold = 120)
        )
        assertFalse(
            Grid.needsMore(0, 1000, Grid.MAX_DAYS, newestLeft = false, threshold = 120)
        )
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

    /* ---------- a habit shown as something to avoid ---------- */

    private val avoid = Habit(
        id = 1, name = "Smoking", type = "numerical",
        targetType = "at_most", targetValue = 0.0, showAs = "avoid",
    )

    @Test
    fun `the cycle is untouched by the rendering`() {
        // The whole reason this feature is small. A habit you are trying not to
        // do walks the same four states in the same order — a clean day is
        // DONE, a slip is NO — so `nextState`, the mirror of `nextDayState` in
        // shared/public/ui/toggle.js, did not have to learn anything about it.
        assertEquals(Grid.DayState.DONE, Grid.nextState(Grid.DayState.UNKNOWN))
        assertEquals(Grid.DayState.NO, Grid.nextState(Grid.DayState.DONE))
    }

    @Test
    fun `what a tap records is what differs`() {
        // Mirrors `valueForState` in shared/public/ui/toggle.js, pinned to the
        // same examples for the reason the cycle beside it is: this runs when a
        // tap is made with no network.
        assertEquals(0.0, Grid.valueForState(avoid, Grid.DayState.DONE), 0.0)
        assertEquals(1.0, Grid.valueForState(avoid, Grid.DayState.NO), 0.0)

        val normal = Habit(id = 2, name = "Meditate", type = "boolean")
        assertEquals(Sentinels.YES, Grid.valueForState(normal, Grid.DayState.DONE), 0.0)
        assertEquals(Sentinels.UNSET, Grid.valueForState(normal, Grid.DayState.NO), 0.0)
    }

    @Test
    fun `a slip is the smallest amount that fails, not always one`() {
        // "At most 2 coffees" shown as a limit: a slip is three, the smallest
        // count that is over. It is the least the app can claim on someone's
        // behalf, and the day editor still takes the exact number.
        val limit = avoid.copy(targetValue = 2.0)
        assertEquals(3.0, Grid.valueForState(limit, Grid.DayState.NO), 0.0)
        assertEquals(0.0, Grid.valueForState(limit, Grid.DayState.DONE), 0.0)
    }

    @Test
    fun `a yes-no habit is never avoided, whatever show_as says`() {
        // Reachable from the form in one sitting: pick Measurable + At most +
        // avoid, then switch to Yes / no and save. `show_as` is sent regardless
        // so that switching back does not lose it. Asking only two of the three
        // questions encoded a tap meaning DONE as 0, which `isMet` reads as NOT
        // done for a yes/no habit — the cell painted red and no sequence of taps
        // could reach a done day.
        val trap = avoid.copy(type = "boolean")
        assertFalse(trap.isAvoided)
        assertEquals(Sentinels.YES, Grid.valueForState(trap, Grid.DayState.DONE), 0.0)
        assertEquals(Sentinels.UNSET, Grid.valueForState(trap, Grid.DayState.NO), 0.0)
    }

    @Test
    fun `a skip is the status column on both sides of the mirror`() {
        // The one input the two `valueForState` functions disagreed on. No
        // caller passes it — skips are handled before the encoding — but they
        // are pinned to each other, and an unreachable disagreement is the kind
        // the next caller discovers.
        assertEquals(Sentinels.SKIP, Grid.valueForState(avoid, Grid.DayState.SKIPPED), 0.0)
        assertEquals(
            Sentinels.SKIP,
            Grid.valueForState(Habit(id = 9, name = "x", type = "boolean"), Grid.DayState.SKIPPED),
            0.0,
        )
    }

    @Test
    fun `the rendering only applies where there is something to avoid`() {
        // `show_as` is kept when a habit's goal is switched to At least, so
        // switching back does not lose it — which means the predicate, not the
        // stored value, is what stops it applying in between.
        assertTrue(avoid.isAvoided)
        assertFalse(avoid.copy(targetType = "at_least").isAvoided)
        assertFalse(avoid.copy(showAs = "amount").isAvoided)
        // And an at-least habit records the ordinary way.
        assertEquals(
            Sentinels.YES,
            Grid.valueForState(avoid.copy(targetType = "at_least"), Grid.DayState.DONE),
            0.0,
        )
    }
}
