package com.habiterall.app

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Sentinels
import com.habiterall.app.ui.HabitList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The list screen's shell, driven directly rather than through `MainActivity`.
 *
 * `HabitListScreen` was a private method with no way to compose it in a test —
 * this file is the reason [HabitList] was pulled out top-level at all. These
 * cases are the regression net for the search box that follows: two hazards
 * (the reorder hand-off reading a subset, and a focus left pending forever by
 * an archived habit) are exactly the ones step 3 has to keep answering once
 * `rows` stops being the same list as `habits`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, qualifiers = "w400dp-h800dp")
class HabitListTest {

    @get:Rule val compose = createComposeRule()

    private val water = Habit(id = 1, name = "Water")
    private val reading = Habit(id = 2, name = "Reading")
    private val cycling = Habit(id = 3, name = "Cycling")

    private var focused = false
    private var reordered: List<Habit>? = null

    /** The query text as [HabitList] currently sees it, read back after a test acts. */
    private var currentQuery: String = ""

    /**
     * The list's own scroll position, hoisted out of `show()` so a test can
     * read it back after acting — otherwise `scrollToItem` can only be
     * trusted, never checked.
     */
    private lateinit var listState: LazyListState

    private fun manyHabits(count: Int): List<Habit> =
        (1..count).map { Habit(id = it.toLong(), name = "Habit $it") }

    private fun show(
        habits: List<Habit> = listOf(water, reading),
        rows: List<Habit> = habits,
        loading: Boolean = false,
        loaded: Boolean = true,
        error: String? = null,
        focusHabit: Long? = null,
        query: String = "",
        // Non-zero simulates a `rememberSaveable` `LazyListState` restored
        // from before process death: this is the actual origin of the
        // ScrollRestore case (see its own KDoc), not something a test drives
        // by scrolling live — a restored index is applied before the list it
        // now names has ever been measured at all.
        initialScrollIndex: Int = 0,
    ) {
        compose.setContent {
            var q by remember { mutableStateOf(query) }
            currentQuery = q
            val ls = remember { LazyListState(firstVisibleItemIndex = initialScrollIndex) }
            listState = ls
            // Mirrors MainActivity's own `onFocused = { focusHabit = null }`:
            // a bare flag here is what let the dropped-`return` bug in the
            // focus effect pass every test, since only a caller that actually
            // nulls the habit on focus can be short-circuited by it.
            var fh by remember { mutableStateOf(focusHabit) }
            HabitList(
                habits = habits,
                rows = rows,
                loading = loading,
                loaded = loaded,
                error = error,
                dates = listOf("2026-08-17"),
                today = "2026-08-17",
                questionMarks = false,
                query = q,
                onQueryChange = { q = it; currentQuery = it },
                listState = ls,
                dayScroll = ScrollState(0),
                snackbar = SnackbarHostState(),
                focusHabit = fh,
                onFocused = { focused = true; fh = null },
                onRefresh = {},
                onReorder = { reordered = it },
                onNewHabit = {},
                onOpenHabit = {},
                onEditHabit = {},
                onSetReminder = {},
                onTapDay = { _, _ -> },
                onHoldDay = { _, _ -> },
                onOpenStats = {},
                onOpenArchive = {},
                onOpenSettings = {},
                onSignOut = null,
                onChangeServer = {},
            )
        }
        compose.waitForIdle()
    }

    /**
     * The onboarding panel, not the list's own empty `LazyColumn`.
     *
     * `habits.isEmpty()` picks this branch over `else`, which would render a
     * `DayHeader` and a `LazyColumn` with nothing in it — visually blank, and a
     * mutation that dropped the branch check would still compile and still show
     * *something*, just not the sentence a first-time user needs.
     */
    @Test
    fun `an empty account renders No habits yet and an Add a habit button`() {
        show(habits = emptyList(), rows = emptyList())

        compose.onNodeWithText("No habits yet.").assertIsDisplayed()
        compose.onNodeWithText("Add a habit").assertIsDisplayed()
    }

    /**
     * Two, not one: a single habit has nowhere to go, per the comment beside
     * `enabled` in [HabitList] itself.
     */
    @Test
    fun `the overflow's Reorder habits is enabled with two habits`() {
        show(habits = listOf(water, reading), rows = listOf(water, reading))

        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Reorder habits").assertIsEnabled()
    }

    /**
     * The control for the test above: a version that hard-codes `enabled = true`
     * passes the first case and only this one catches it.
     */
    @Test
    fun `the overflow's Reorder habits is disabled with one habit`() {
        show(habits = listOf(water), rows = listOf(water))

        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Reorder habits").assertIsNotEnabled()
    }

    /**
     * `rows` is what the `LazyColumn` renders, and `withPending` is the only
     * difference from `habits` — an optimistic write laid over the fetched
     * state. `habits` here carries Water with no entry at all; `rows` carries
     * the SAME id with today already recorded. If the grid ever fell back to
     * filtering `habits` instead, the cell would paint nothing until the next
     * refetch landed, and nothing at all while the write sat in the offline
     * outbox — the one interaction this screen exists for.
     *
     * Addressed by the day cell's own content description (`DayGrid.describe`),
     * not by text: the visible label for a done day is a bare "✓", which is not
     * unique enough to say which habit it belongs to.
     */
    @Test
    fun `the grid renders rows' pending overlay, not habits' fetched state`() {
        val fetchedWater = water
        val pendingWater = water.copy(entries = mapOf("2026-08-17" to Sentinels.YES))
        show(
            habits = listOf(fetchedWater, reading),
            rows = listOf(pendingWater, reading),
        )

        compose.onNodeWithContentDescription("Water, Monday 17 August: done").assertIsDisplayed()
    }

    /**
     * A notification tap that names a habit still in the list.
     *
     * `onFocused` has to fire once the fetch has landed and the habit has been
     * found, or the resume snap-to-top (which defers to a pending focus) never
     * comes back.
     */
    @Test
    fun `a focusHabit naming a habit in the list calls onFocused`() {
        show(focusHabit = reading.id)

        assertTrue(focused)
    }

    /**
     * The archived-habit case `android-native/CLAUDE.md` records: a focus
     * naming a habit no longer in the list must ALSO clear itself, or the resume
     * snap stays suppressed for the life of the process.
     */
    @Test
    fun `a focusHabit naming a habit not in the list still calls onFocused`() {
        show(focusHabit = 999L)

        assertTrue(focused)
    }

    // --- The search box, and the five hazards (step 3) ---

    /**
     * The reorder hand-off is the one hazard that reaches storage:
     * `ReorderScreen` writes the WHOLE order back, so a subset would rewrite
     * the position of every habit a live query had hidden from view.
     */
    @Test
    fun `with a query live, Reorder habits hands back every habit, in order`() {
        val all = listOf(water, reading, cycling)
        show(habits = all, rows = all, query = "wat")

        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Reorder habits").performClick()

        assertEquals(all, reordered)
    }

    /** Its own `enabled`, read from the same unfiltered list. */
    @Test
    fun `Reorder habits stays enabled when the filter has left one row`() {
        val all = listOf(water, reading, cycling)
        show(habits = all, rows = all, query = "wat")

        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Reorder habits").assertIsEnabled()
    }

    /**
     * A notification tap beats a filter: the query is cleared first, and only
     * once it is gone does the effect look for the habit and call `onFocused`.
     *
     * This does not check the scroll itself — with only two habits, both rows
     * fit on screen and `scrollToItem` would be a no-op whether or not the
     * line calling it existed. See the test below for that half.
     */
    @Test
    fun `a focusHabit arriving with a query live clears the query and calls onFocused`() {
        show(
            habits = listOf(water, reading),
            rows = listOf(water, reading),
            query = "something",
            focusHabit = reading.id,
        )

        assertEquals("", currentQuery)
        assertTrue(focused)
    }

    /**
     * The scroll the test above cannot see: with the target habit off
     * screen — 20 habits at `w400dp-h800dp` shows well under that many rows —
     * `scrollToItem` has to actually move `listState` for this to pass.
     * Deleting `if (index >= 0) listState.scrollToItem(index)` leaves
     * `firstVisibleItemIndex` at 0 and only this test notices.
     */
    @Test
    fun `a focusHabit arriving with a query live scrolls to that habit once the query clears`() {
        val many = manyHabits(20)
        val target = many[18]
        show(
            habits = many,
            rows = many,
            query = "something",
            focusHabit = target.id,
        )

        assertTrue(focused)
        assertTrue(listState.firstVisibleItemIndex > 0)
    }

    /**
     * An empty RESULT, not an empty account: offering "create your first
     * habit" to someone who has habits and mistyped one is the app forgetting
     * what it holds.
     */
    @Test
    fun `a query matching nothing shows No habits match that and no Add a habit button`() {
        show(habits = listOf(water, reading), rows = listOf(water, reading), query = "zzzznomatch")

        compose.onNodeWithText("No habits match that.").assertIsDisplayed()
        compose.onNodeWithText("Add a habit").assertDoesNotExist()
    }

    /** The control for the case above. */
    @Test
    fun `an empty account still gets Add a habit and not No habits match that`() {
        show(habits = emptyList(), rows = emptyList())

        compose.onNodeWithText("Add a habit").assertIsDisplayed()
        compose.onNodeWithText("No habits match that.").assertDoesNotExist()
    }

    @Test
    fun `the box appears with 6 habits`() {
        val six = manyHabits(6)
        show(habits = six, rows = six)

        compose.onNodeWithText("Find a habit").assertIsDisplayed()
    }

    @Test
    fun `the box does not appear with 5 habits`() {
        val five = manyHabits(5)
        show(habits = five, rows = five)

        compose.onNodeWithText("Find a habit").assertDoesNotExist()
    }

    /** Below the threshold, but the box has to stay up while it holds a query. */
    @Test
    fun `the box appears with 5 habits once it holds a query`() {
        val five = manyHabits(5)
        show(habits = five, rows = five, query = "x")

        compose.onNodeWithText("Find a habit").assertIsDisplayed()
    }

    @Test
    fun `the count reads exactly 2 of 7`() {
        val seven = (1..7).map { i ->
            Habit(id = i.toLong(), name = if (i <= 2) "Yoga $i" else "Filler $i")
        }
        show(habits = seven, rows = seven, query = "Yoga")

        compose.onNodeWithText("2 of 7").assertIsDisplayed()
    }

    /**
     * A failed background refresh must not steal the screen from a live,
     * merely unlucky, search: the full-screen error is for when there is
     * nothing to show at all, not for a query that happens to match nothing.
     */
    @Test
    fun `a fetch error with habits present and a no-match query still shows the search box, not the error screen`() {
        show(
            habits = listOf(water, reading),
            rows = listOf(water, reading),
            error = "Could not reach the server",
            query = "zzzznomatch",
        )

        compose.onNodeWithText("Find a habit").assertIsDisplayed()
        compose.onNodeWithText("No habits match that.").assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()
    }

    /**
     * `ScrollRestore` has to be asked about the list the `LazyColumn` actually
     * holds. 30 habits fetched, a query already narrowing to 10 (as after a
     * process restore, where the query is `rememberSaveable` too), and a
     * restored scroll position of row 15: `needsSnapToTop(15, 0, 10)` is true
     * (the restored index is now past the end) and Compose's own layout is
     * asked, through our effect, to put the list back at the top. Keyed on
     * `habits.size` (30) instead, `needsSnapToTop(15, 0, 30)` is false, our
     * effect never calls `scrollToItem(0)`, and the `LazyColumn` is left to
     * its own devices — measured here, it lands mid-list rather than at the
     * top, which is not a state a restored session should ever show.
     *
     * A live scroll-then-narrow within one session cannot show this: Compose's
     * `LazyColumn` already reflows a `firstVisibleItemIndex` that has run past
     * an in-place shrink on its own, back to exactly the same index 0 either
     * way, which is what made an earlier version of this test pass under the
     * `habits.size` mutation too. Restoring the index directly — the actual
     * origin of `ScrollRestore`, a `LazyListState` deserialized from before
     * process death — is the one place Compose does not already paper over
     * the difference, which is why this constructs `initialScrollIndex`
     * rather than driving a real scroll gesture.
     *
     * The class's `qualifiers = "w400dp-h800dp"` is load bearing here, not
     * decoration: the ten matches have to OVERFLOW the viewport for the
     * clamped position to land anywhere but 0. Raise that height — adding a
     * tablet case to this class would do it — and the filtered list fits, both
     * implementations land at 0, and this test goes on passing while pinning
     * nothing. If you change the qualifier, raise the match count with it.
     */
    @Test
    fun `a restored scroll position past the filtered list snaps back to the top`() {
        val many = (1..30).map {
            Habit(id = it.toLong(), name = if (it <= 10) "Match $it" else "Habit $it")
        }
        show(habits = many, rows = many, query = "Match", initialScrollIndex = 15)

        assertEquals(0, listState.firstVisibleItemIndex)
        assertEquals(0, listState.firstVisibleItemScrollOffset)
    }

    /**
     * The whole feature, unpinned without this: every other assertion here
     * goes through the count text, the no-match branch or the reorder
     * hand-off — none of them inspects what the `LazyColumn` actually shows.
     * `items(rows, key = { it.id })` instead of `items(visible, ...)` renders
     * every habit regardless of the query and makes every other test in this
     * class pass unchanged.
     */
    @Test
    fun `a live query renders only the matching habits`() {
        show(
            habits = listOf(water, reading, cycling),
            rows = listOf(water, reading, cycling),
            query = "wat",
        )

        compose.onNodeWithText("Water").assertIsDisplayed()
        compose.onNodeWithText("Reading").assertDoesNotExist()
        compose.onNodeWithText("Cycling").assertDoesNotExist()
    }

    /**
     * The end-to-end path every other test skips: each of them drives `query`
     * as an initial value, none types into the real field. This pins
     * `onValueChange` -> `query` -> `visible` together rather than trusting
     * that the wiring between them holds.
     */
    @Test
    fun `typing in the search box narrows the list`() {
        val yoga = Habit(id = 4, name = "Yoga")
        val running = Habit(id = 5, name = "Running")
        val swimming = Habit(id = 6, name = "Swimming")
        val habits = listOf(water, reading, cycling, yoga, running, swimming)
        show(habits = habits, rows = habits)

        compose.onNodeWithText("Find a habit").performTextInput("Wat")

        compose.onNodeWithText("Water").assertIsDisplayed()
        compose.onNodeWithText("Reading").assertDoesNotExist()
    }
}
