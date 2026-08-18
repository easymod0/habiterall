package com.habiterall.app

import androidx.activity.ComponentActivity
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Sentinels
import com.habiterall.app.ui.HabitList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    // `createAndroidComposeRule`, not `createComposeRule`: `HabitList` now
    // calls `BackHandler`, which reads `LocalOnBackPressedDispatcherOwner` and
    // silently no-ops with nothing behind it — a bare `createComposeRule` host
    // is not an `OnBackPressedDispatcherOwner`, only a real `ComponentActivity`
    // is. `debugImplementation("...ui-test-manifest")` is what puts one in the
    // merged test manifest.
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    /**
     * COMBINING ACUTE ACCENT, U+0301, as an escape rather than as itself: a
     * literal one is invisible and attaches to whatever character precedes it
     * in the source. `HabitFilterTest` holds the same constant for the same
     * reason, and pins what the predicate does with it; this file pins what
     * the bar does.
     */
    private val COMBINING_ACUTE = "\u0301"

    private val water = Habit(id = 1, name = "Water")
    private val reading = Habit(id = 2, name = "Reading")
    private val cycling = Habit(id = 3, name = "Cycling")

    private var focused = false
    private var reordered: List<Habit>? = null

    /** The query text as [HabitList] currently sees it, read back after a test acts. */
    private var currentQuery: String = ""

    /** Whether the search field is expanded, read back the same way as [currentQuery]. */
    private var currentSearchOpen: Boolean = false

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
        searchOpen: Boolean = false,
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
            var open by remember { mutableStateOf(searchOpen) }
            currentSearchOpen = open
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
                searchOpen = open,
                onSearchOpenChange = { open = it; currentSearchOpen = it },
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

    /**
     * The count is ungated on `searchOpen`: it reads whenever a filter is
     * live, whether or not the field that produced it is still open — and
     * the field is collapsed by default, which is what this pins. A version
     * that re-gates the count on `searchOpen` passes only while the field
     * happens to be open.
     */
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
     * The search icon (not a permanent box) is what has to survive it now,
     * and it has to read as active — asserted via its
     * "Search, filter active" description, since the live query behind it
     * is what makes the icon active in the first place.
     */
    @Test
    fun `a fetch error with habits present and a no-match query still shows the search box, not the error screen`() {
        show(
            habits = listOf(water, reading),
            rows = listOf(water, reading),
            error = "Could not reach the server",
            query = "zzzznomatch",
        )

        compose.onNodeWithContentDescription("Search, filter active").assertIsDisplayed()
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

        compose.onNodeWithContentDescription("Search").performClick()
        // Selected by `hasSetTextAction()`, never by the placeholder text:
        // "Find a habit" disappears the moment a character is typed into it,
        // so a placeholder-based selector would only ever find the field
        // before the first keystroke.
        compose.onNode(hasSetTextAction()).performTextInput("Wat")

        compose.onNodeWithText("Water").assertIsDisplayed()
        compose.onNodeWithText("Reading").assertDoesNotExist()
    }

    // --- The bar-icon search: expand, confirm, clear, tap-off (step 2) ---

    /**
     * Settles `AnimatedVisibility`'s enter/exit transition. A test that
     * asserts mid-transition can pass against a version that never actually
     * finishes expanding or collapsing the field — this is the harness's own
     * defect-shape #1 (root `CLAUDE.md`, "Writing tests here"), applied to an
     * animation instead of a sleep.
     */
    private fun settleAnimation() {
        compose.mainClock.advanceTimeBy(500)
        compose.waitForIdle()
    }

    /**
     * A node carrying an `OnLongClick` accessibility action labelled
     * `"Clear filter"` — TalkBack's only way to know the long-press shortcut
     * exists, since a gesture with no matching `semantics { onLongClick }` is
     * invisible to it even though the touch handler still fires. This is the
     * SAME semantics action `combinedClickable`'s own long click already
     * registers, just with a label attached — `semantics { onLongClick(...) }`
     * does not add a second, distinct action.
     */
    private val hasClearFilterAction = SemanticsMatcher(
        "has an OnLongClick accessibility action labelled 'Clear filter'",
    ) { node ->
        node.config.contains(SemanticsActions.OnLongClick) &&
            node.config[SemanticsActions.OnLongClick].label == "Clear filter"
    }

    /**
     * Any `OnLongClick` action at all, labelled or not — the check that
     * `hasClearFilterAction` above cannot make: a version that still passed
     * `combinedClickable` an unconditional (unlabelled) `onLongClick` would
     * carry no action matching `hasClearFilterAction` (no label) and would
     * still fail `assertDoesNotExist(hasClearFilterAction)` for the wrong
     * reason — it has no OTHER `OnLongClick` action to collide with, so
     * nothing here would notice one being registered anyway.
     */
    private val hasAnyLongClickAction = SemanticsMatcher(
        "has an OnLongClick accessibility action",
    ) { node -> node.config.contains(SemanticsActions.OnLongClick) }

    /**
     * Pressing the icon has to both show the field AND move keyboard focus
     * into it — a version that only toggles `searchOpen` without the
     * `FocusRequester` effect would pass every other test in this file (the
     * field would still be there for `performTextInput` to find) while
     * leaving the user staring at a text box the keyboard never opened for.
     */
    @Test
    fun `pressing the search icon expands the field and focuses it`() {
        show(habits = listOf(water, reading), rows = listOf(water, reading))

        compose.onNodeWithContentDescription("Search").performClick()
        settleAnimation()

        compose.onNode(hasSetTextAction()).assertIsDisplayed().assertIsFocused()
    }

    /**
     * The list narrows on every keystroke, before Confirm is ever pressed.
     * Asserting only after Confirm would pass just as well against a version
     * that stashed the typed text and applied it to `visible` solely on
     * submission — this is what tells the two apart.
     */
    @Test
    fun `typing narrows the list before Confirm is pressed`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits)

        compose.onNodeWithContentDescription("Search").performClick()
        settleAnimation()
        compose.onNode(hasSetTextAction()).performTextInput("Wat")
        compose.waitForIdle()

        compose.onNodeWithText("Water").assertIsDisplayed()
        compose.onNodeWithText("Reading").assertDoesNotExist()
    }

    /**
     * The single most important assertion in this step: Confirm collapses
     * the field but the filter it produced survives the collapse, unchanged.
     * Every "closing means clearing" version — an ✕-shaped Confirm, a
     * `confirmSearch` that also calls `onQueryChange("")` — fails this one
     * and only this one, since every earlier test either never presses
     * Confirm or never checks the list afterwards.
     */
    @Test
    fun `pressing Confirm collapses the field and the list stays narrowed`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits)

        compose.onNodeWithContentDescription("Search").performClick()
        settleAnimation()
        compose.onNode(hasSetTextAction()).performTextInput("Wat")
        compose.waitForIdle()

        compose.onNodeWithContentDescription("Confirm").performClick()
        settleAnimation()

        compose.onNode(hasSetTextAction()).assertDoesNotExist()
        compose.onNodeWithText("Water").assertIsDisplayed()
        compose.onNodeWithText("Reading").assertDoesNotExist()
        assertEquals("Wat", currentQuery)
    }

    /**
     * Tap-off: focus leaving the field-and-buttons group behaves exactly
     * like Confirm. Driven here by moving focus onto the FAB — the one
     * always-present focusable target that sits entirely outside
     * `Modifier.focusGroup()`, since the bar's own Stats/overflow icons are
     * gone from the tree while the field is expanded and cannot be tapped to
     * pull focus away. See the brief's *Stop and report if*: this is the one
     * line in the change whose testability was not certain in advance, and
     * this FAB turned out to be a route into it.
     */
    @Test
    fun `focus leaving the field and its buttons behaves as Confirm`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits)

        compose.onNodeWithContentDescription("Search").performClick()
        settleAnimation()
        compose.onNode(hasSetTextAction()).performTextInput("Wat")
        compose.waitForIdle()

        compose.onNodeWithContentDescription("New habit").requestFocus()
        settleAnimation()

        compose.onNode(hasSetTextAction()).assertDoesNotExist()
        compose.onNodeWithText("Water").assertIsDisplayed()
        compose.onNodeWithText("Reading").assertDoesNotExist()
        assertEquals("Wat", currentQuery)
    }

    /**
     * Back press is a separate code path from Confirm, Clear and tap-off —
     * `BackHandler`, not a click at all — and left to the system it would
     * exit the screen entirely rather than just closing the field. No other
     * test here drives the back dispatcher, so none of them would notice
     * `BackHandler` being deleted.
     */
    @Test
    fun `back press behaves as Confirm`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits)

        compose.onNodeWithContentDescription("Search").performClick()
        settleAnimation()
        compose.onNode(hasSetTextAction()).performTextInput("Wat")
        compose.waitForIdle()

        compose.runOnUiThread {
            compose.activity.onBackPressedDispatcher.onBackPressed()
        }
        settleAnimation()

        compose.onNode(hasSetTextAction()).assertDoesNotExist()
        compose.onNodeWithText("Water").assertIsDisplayed()
        compose.onNodeWithText("Reading").assertDoesNotExist()
    }

    /**
     * Clear (✕) is not a second Confirm wearing an X: it drops the typed
     * text, keeps the field open and keeps the caret focused, so all three
     * have to be checked. Dropping the third assertion alone would still
     * pass against a version where Clear also collapses the field — a
     * "clear-and-close" button rather than the one control decision 3
     * specifies.
     */
    @Test
    fun `Clear drops the filter, the whole list is back, and the field is still open`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits)

        compose.onNodeWithContentDescription("Search").performClick()
        settleAnimation()
        compose.onNode(hasSetTextAction()).performTextInput("Wat")
        compose.waitForIdle()

        compose.onNodeWithContentDescription("Clear").performClick()
        compose.waitForIdle()

        compose.onNodeWithText("Water").assertIsDisplayed()
        compose.onNodeWithText("Reading").assertIsDisplayed()
        compose.onNode(hasSetTextAction()).assertIsDisplayed()
    }

    /**
     * The collapsed icon's own long-press, decision 5's route to dropping a
     * filter without opening the field at all. `performTouchInput { longClick() }`
     * exercises the actual gesture registered on `combinedClickable`, not the
     * semantics-only custom action the next two tests check.
     */
    @Test
    fun `long-pressing the collapsed search icon drops the filter`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits, query = "Wat")

        compose.onNodeWithContentDescription("Search, filter active")
            .performTouchInput { longClick() }
        compose.waitForIdle()

        compose.onNodeWithText("Water").assertIsDisplayed()
        compose.onNodeWithText("Reading").assertIsDisplayed()
    }

    /**
     * The gesture working proves nothing about TalkBack, which never
     * performs a touch gesture at all — it reads registered custom
     * accessibility actions. This is the assertion that actually stands in
     * for a screen reader: a version with the long-click wired up but no
     * matching `semantics { onLongClick(...) }` passes the test above and
     * fails only this one.
     */
    @Test
    fun `the Clear filter accessibility action is registered while a filter is live`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits, query = "Wat")

        compose.onNode(hasClearFilterAction).assertExists()
    }

    /**
     * The collapsed search icon's long-press is spoken for by
     * `combinedClickable` + `semantics { onLongClick(label = "Clear filter") }`
     * alone — no `TooltipBox` wraps it, unlike Stats/Clear/Confirm. A
     * `TooltipBox` there would put a SECOND `OnLongClick`-carrying node
     * (`anchorSemantics`) directly around this one.
     *
     * `useUnmergedTree = true` is why this test can see that at all: the
     * MERGED tree — what every assertion above queries — collapses the two
     * nodes into one, and `AccessibilityAction`'s own merge policy prefers the
     * more deeply nested value's label, so a merged-tree check of the label
     * alone reads "Clear filter" whether or not a `TooltipBox` sits on top
     * contributing a second, unlabelled one. Counting UNMERGED nodes is the
     * only way to see the second contributor.
     *
     * Scoped to a node with a "Search" descendant: `DayGrid`'s own habit-row
     * and day-cell long presses ("Edit habit" / "Edit $date") are real
     * `OnLongClick` actions elsewhere on this same screen, so counting every
     * unmerged long-click node on screen (4, with two habits and one date
     * column) would not isolate this control at all.
     */
    @Test
    fun `the collapsed search icon is the only unmerged node carrying a long-click action`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits, query = "Wat")

        val searchLongClickNodes = compose.onAllNodes(
            hasAnyLongClickAction.and(hasAnyDescendant(hasContentDescription("Search", substring = true))),
            useUnmergedTree = true,
        ).fetchSemanticsNodes()

        assertEquals(1, searchLongClickNodes.size)
        assertEquals(
            "Clear filter",
            searchLongClickNodes.single().config[SemanticsActions.OnLongClick].label,
        )
    }

    /**
     * The control for the test above: registering the action unconditionally
     * would advertise a shortcut to clear a filter that is not there — a
     * no-op TalkBack action offered for no reason. Strengthened past "no
     * action labelled 'Clear filter'" to "no `OnLongClick` action at all":
     * `combinedClickable(onLongClick = { clearFilter() })` passed unconditionally
     * registers an UNLABELLED `OnLongClick` action, which `hasClearFilterAction`
     * (label-gated) cannot see — so the weaker assertion alone would pass
     * against a version whose gesture still fires, and fires a haptic, for a
     * long-press with nothing to clear.
     */
    @Test
    fun `the Clear filter accessibility action is absent with no filter live`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits)

        compose.onNode(hasClearFilterAction).assertDoesNotExist()
        compose.onNodeWithContentDescription("Search").assert(hasAnyLongClickAction.not())
    }

    /**
     * Pressing the icon while a filter is already live has to reopen the
     * field showing the query that produced it, not an empty box — the
     * query was never touched by collapsing, so there is a live filter's
     * text to edit. A version whose `onClick` cleared the query before
     * reopening would pass every test above (none of them presses the icon
     * a second time with a filter already live) and fail only this one.
     */
    @Test
    fun `pressing the icon with a filter live reopens the field showing the query`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits, query = "Wat")

        compose.onNodeWithContentDescription("Search, filter active").performClick()
        settleAnimation()

        compose.onNode(hasSetTextAction()).assertTextEquals("Wat")
    }

    /**
     * Collapsed with a filter live, the icon and the count are the only two
     * things on screen saying the list is not the whole of it — hard-coding
     * the plain description (mutation 10) would pass every other test here,
     * since none of the earlier ones checks the description's exact text
     * while a filter is live and the field is collapsed at the same time.
     */
    @Test
    fun `collapsed with a filter live, the active icon and the count are both present`() {
        val thirty = (1..30).map { i ->
            Habit(id = i.toLong(), name = if (i <= 3) "Match $i" else "Habit $i")
        }
        show(habits = thirty, rows = thirty, query = "Match")

        compose.onNodeWithContentDescription("Search, filter active").assertIsDisplayed()
        compose.onNodeWithText("3 of 30").assertIsDisplayed()
    }

    /**
     * The control for the test above: with no filter live the icon reads
     * plain `"Search"` and no `"N of M"` count renders at all. Registering
     * the active description unconditionally (mutation 11) passes the test
     * above and fails only this one.
     */
    @Test
    fun `collapsed with no filter live, the icon reads plain Search and no count shows`() {
        show(habits = listOf(water, reading), rows = listOf(water, reading))

        compose.onNodeWithContentDescription("Search, filter active").assertDoesNotExist()
        compose.onNodeWithContentDescription("Search").assertIsDisplayed()
        compose.onNode(hasText(" of ", substring = true)).assertDoesNotExist()
    }

    /**
     * The bar's five "a filter is live" claims have to agree with the filter.
     *
     * `HabitFilter.fold` strips every `Mn` codepoint before `matches` looks at
     * what is left, so a query of nothing but a combining acute (U+0301, with
     * no base letter — a paste, or an orphaned dead key) matches every habit:
     * the list on screen is the WHOLE account. Asked `query.isNotBlank()`, the
     * bar answered yes anyway — badge, `primary` tint, "Search, filter active"
     * to TalkBack, a "2 of 2" count and a long-press advertised as clearing a
     * filter that does not exist. The whole list being asserted present is the
     * half that makes the rest a contradiction rather than a preference.
     */
    @Test
    fun `a query that folds to nothing is not shown as a live filter`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits, query = COMBINING_ACUTE)

        compose.onNodeWithText("Water").assertIsDisplayed()
        compose.onNodeWithText("Reading").assertIsDisplayed()

        compose.onNodeWithContentDescription("Search, filter active").assertDoesNotExist()
        compose.onNodeWithContentDescription("Search").assertIsDisplayed()
        compose.onNode(hasText(" of ", substring = true)).assertDoesNotExist()
        compose.onNode(hasClearFilterAction).assertDoesNotExist()
    }

    /**
     * The test that catches the missing `onSearchOpenChange(false)` in the
     * focus effect (step 1's second mutation, left green at that step on
     * purpose): a notification tap has to beat an OPEN field as well as a
     * live query, or it lands on exactly the hidden-filter state this issue
     * exists to prevent.
     *
     * The query starts BLANK on purpose, not "something": with a live query,
     * `query` itself changes value inside the collapse branch (to `""`), and
     * that change alone re-runs the effect regardless of whether `searchOpen`
     * is one of its keys — so a version that also dropped `searchOpen` from
     * the key list would still pass. With the query blank throughout,
     * `searchOpen` going true→false in that same branch is the ONLY key that
     * changes value, so the second run (the one that resolves `focusHabit`
     * and scrolls) only happens if `searchOpen` stays in the key list. This
     * is what makes this one test catch both halves of step 1's second
     * mutation: the missing call, and the guard never being re-evaluated at
     * all.
     */
    @Test
    fun `a focusHabit arriving with the field open ends collapsed, unfiltered and scrolled`() {
        val many = manyHabits(20)
        val target = many[18]
        show(
            habits = many,
            rows = many,
            query = "",
            searchOpen = true,
            focusHabit = target.id,
        )

        assertTrue(focused)
        assertEquals("", currentQuery)
        assertFalse(currentSearchOpen)
        assertTrue(listState.firstVisibleItemIndex > 0)
    }

    /**
     * `IconButton` with no `contentDescription` compiles, renders, and is
     * invisible to TalkBack and to every test that would have caught it —
     * this is that test, and its control, in one: Stats has to be reachable
     * by description and must NOT still be reachable by the text it lost.
     */
    @Test
    fun `Stats is reachable by content description and no longer by text`() {
        show(habits = listOf(water, reading), rows = listOf(water, reading))

        compose.onNodeWithContentDescription("Stats").assertIsDisplayed()
        compose.onNodeWithText("Stats").assertDoesNotExist()
    }

    /**
     * Decision 2: the icon is hidden at zero habits, where the onboarding
     * panel is what shows instead and there is nothing to search.
     */
    @Test
    fun `no search icon on an empty account`() {
        show(habits = emptyList(), rows = emptyList())

        compose.onNodeWithContentDescription("Search").assertDoesNotExist()
        compose.onNodeWithText("No habits yet.").assertIsDisplayed()
    }

    /**
     * Not decision 2 reopened: with no habits AND no filter the icon stays
     * hidden (the test above). But filter down to nothing and then archive
     * every matching habit — `habits` itself goes empty while the query that
     * emptied it is still live — and the icon is the only control that can
     * clear or reopen that filter. Gate it on `habits.isNotEmpty()` alone and
     * it vanishes along with the last habit, leaving the filter live,
     * unclearable, and hiding whatever gets created next. Inherited from
     * #173's `showSearch`, which carried `|| query.isNotEmpty()` for the
     * identical reason.
     */
    @Test
    fun `the active search icon survives habits going empty under a live filter`() {
        show(habits = emptyList(), rows = emptyList(), query = "x")

        compose.onNodeWithContentDescription("Search, filter active").assertIsDisplayed()
    }

    /**
     * This client has no equivalent of the web's `responsive.mjs`, so a
     * width is asserted here deliberately or not at all. `assertIsDisplayed()`
     * fails on a clipped node — that is the entire point of driving this at
     * `w360dp`, the narrowest phone width this project targets, rather than
     * the class's own `w400dp`, which the scroll-restore test needs left
     * alone. Clear only renders once the query is non-empty, so the field is
     * typed into before the expanded assertions — otherwise this would never
     * catch a version that clips only once all three trailing controls are
     * on screen.
     *
     * `assertIsDisplayed` alone would not catch a field given a FIXED width
     * instead of `fillMaxWidth()`: Compose's size modifiers coerce a request
     * down to the incoming constraint rather than ever overflowing it, so a
     * fixed width — whatever value it names — never produces a clipped node;
     * it produces one that simply stops short of the bar's edge, still fully
     * displayed. That is what is checked directly: `fillMaxWidth()` measures
     * the field to the root's own right edge (confirmed empirically at
     * 360dp with no trailing gap), so its `right` edge — read via
     * `getUnclippedBoundsInRoot`, which reports where a node was measured and
     * placed regardless of what a parent did to it afterward — is asserted
     * to reach nearly all the way there. A fixed width stops well short of
     * that (320dp measures to 336dp, a 24dp gap this floor catches).
     */
    @Config(qualifiers = "w360dp-h800dp")
    @Test
    fun `the bar fits at 360dp, collapsed and expanded`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits)

        compose.onNodeWithText("Today").assertIsDisplayed()
        compose.onNodeWithContentDescription("Stats").assertIsDisplayed()
        compose.onNodeWithContentDescription("Search").assertIsDisplayed()
        compose.onNodeWithContentDescription("More").assertIsDisplayed()

        compose.onNodeWithContentDescription("Search").performClick()
        settleAnimation()
        compose.onNode(hasSetTextAction()).performTextInput("W")
        compose.waitForIdle()

        compose.onNode(hasSetTextAction()).assertIsDisplayed()
        compose.onNodeWithContentDescription("Clear").assertIsDisplayed()
        compose.onNodeWithContentDescription("Confirm").assertIsDisplayed()
        val fieldRight = compose.onNode(hasSetTextAction()).getUnclippedBoundsInRoot().right
        assertTrue(fieldRight >= 355.dp)
    }

    /**
     * The state this whole issue is for: a query confirmed, the field
     * dismissed, and the list empty as a RESULT rather than an account with
     * nothing in it. "No habits match that.", the ungated `"0 of 30"` and the
     * active icon are the only three things on screen explaining why the
     * list looks the way it does — re-gating the count on `searchOpen`
     * (mutation 16) would make this exact state show a partial list with
     * nothing that says so.
     */
    @Test
    fun `the empty-result branch reached while collapsed still shows the ungated count and active icon`() {
        val thirty = (1..30).map { Habit(id = it.toLong(), name = "Habit $it") }
        show(habits = thirty, rows = thirty)

        compose.onNodeWithContentDescription("Search").performClick()
        settleAnimation()
        compose.onNode(hasSetTextAction()).performTextInput("zzzznomatch")
        compose.waitForIdle()

        compose.onNodeWithContentDescription("Confirm").performClick()
        settleAnimation()

        compose.onNodeWithText("No habits match that.").assertIsDisplayed()
        compose.onNodeWithText("0 of 30").assertIsDisplayed()
        compose.onNodeWithContentDescription("Search, filter active").assertIsDisplayed()
    }

    /**
     * The search icon is a bare `Box` + `combinedClickable` rather than an
     * `IconButton` (which gives no long-press), and that trade has one thing
     * to pay back: `IconButton` passes `Role.Button` to its own `clickable`
     * and a bare `combinedClickable` leaves `Role` out of the semantics
     * config entirely. Measured before the fix — `search role=null` against
     * `stats role=Button` — so TalkBack announced the one control carrying
     * "a filter is live" as neither a button nor anything else, alone among
     * the four `IconButton`s beside it.
     *
     * Two tests rather than one because `show()` can only be called once per
     * test: the role is the one thing on this control that must NOT vary with
     * `filtering`, while the description, the badge, the tint and the
     * long-click action all do, so both states are asserted.
     */
    @Test
    fun `the search icon is announced as a button, with no filter live`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits)

        compose.onNodeWithContentDescription("Search")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
        // The control it is announced beside, so a version that dropped the
        // role from BOTH — an `IconButton` regression, say — cannot pass this
        // by making the comparison vacuous.
        compose.onNodeWithContentDescription("Stats")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
    }

    /** The half of the case above that the badge and the tint also change. */
    @Test
    fun `the active search icon is announced as a button too`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits, query = "Wat")

        compose.onNodeWithContentDescription("Search, filter active")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
    }

    /**
     * The field lives in `TopAppBar`'s TITLE slot — which is what gives it the
     * bar's whole width — and that slot is wrapped in
     * `ProvideTextStyle(titleTextStyle)`. `TextField`'s `textStyle` defaults
     * to `LocalTextStyle.current`, so with none passed the query rendered at
     * the bar's headline size. Measured, not reasoned: a probe reading
     * `LocalTextStyle.current` from inside a bare `TopAppBar(title = …)`
     * returns `size=22.0.sp lh=28.0.sp`, roughly a third fewer characters
     * visible on a 360dp bar before the text scrolls under the caret.
     *
     * Asserted through `GetTextLayoutResult` — the style the text layout was
     * actually performed with — because nothing else discriminates the two:
     * the field measures to the bar's 64dp height either way, so
     * `the bar fits at 360dp` and every other bounds assertion here passes
     * against both. This is the "assert the output that reached the platform"
     * rule; a test that read the constant back would pin the decision and not
     * the wiring, and the wiring is the entire defect.
     */
    @Config(qualifiers = "w360dp-h800dp")
    @Test
    fun `the expanded field renders its query at body size, not the bar's title size`() {
        val habits = listOf(water, reading)
        show(habits = habits, rows = habits)

        compose.onNodeWithContentDescription("Search").performClick()
        settleAnimation()
        compose.onNode(hasSetTextAction()).performTextInput("Wat")
        compose.waitForIdle()

        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNode(hasSetTextAction())
            .fetchSemanticsNode()
            .config[SemanticsActions.GetTextLayoutResult]
            .action!!(layouts)

        assertEquals(16.sp, layouts.single().layoutInput.style.fontSize)
    }
}
