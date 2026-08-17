package com.habiterall.app

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.habiterall.app.data.Habit
import com.habiterall.app.ui.ArchiveScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The archive, and the two things it has to be honest about.
 *
 * Both are screen-only. One is a hand-off that carries a flag no other screen
 * would notice losing; the other is what a screen says when it could not ask the
 * question it is answering.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, qualifiers = "w400dp-h800dp")
class ArchiveScreenTest {

    @get:Rule val compose = createComposeRule()

    private val water = Habit(id = 1, name = "Water", archived = true)
    private val reading = Habit(id = 2, name = "Reading", archived = true)

    private var closedWith: Boolean? = null
    private var edited: Pair<Long, Boolean>? = null

    private fun show(
        load: suspend () -> List<Habit> = { listOf(water, reading) },
        onUnarchive: suspend (Habit) -> Unit = {},
    ) {
        compose.setContent {
            ArchiveScreen(
                load = load,
                onUnarchive = onUnarchive,
                onEdit = { habit, changed -> edited = habit.id to changed },
                onClose = { closedWith = it },
            )
        }
        compose.waitForIdle()
    }

    /**
     * Restoring a habit and then editing another carries the restore with it.
     *
     * `onEdit` takes `changed` because this is a HAND-OFF and not a close: the
     * caller replaces this screen with the habit form, so `onClose` never fires
     * and every restore made before tapping Edit would be forgotten. The list
     * behind would still not know the habit came back — and the only symptom is
     * a dashboard missing a habit that the archive no longer lists either, until
     * something else happens to refetch.
     *
     * Two screens' worth of state, one flag, and nothing but a rendered screen
     * can say whether the flag was set when the hand-off happened.
     */
    @Test
    fun `a restore made before Edit travels with the hand-off`() {
        show()

        compose.onAllNodes(hasText("Restore")).assertCountEquals(2)
        // Restore the first habit, then leave for the OTHER one's form.
        compose.onAllNodes(hasText("Restore"))[0].performClick()
        compose.waitUntil { compose.onAllNodes(hasText("Restore")).fetchSemanticsNodes().size == 1 }

        compose.onNodeWithText("Water").assertDoesNotExist()
        compose.onAllNodes(hasText("Edit"))[0].performClick()
        compose.waitForIdle()

        assertEquals(
            "editing after a restore must carry the restore",
            2L to true,
            edited,
        )
    }

    /**
     * ...and with nothing restored, the hand-off says so.
     *
     * The control. A screen that passed `true` unconditionally would satisfy the
     * test above, and would cost the dashboard a refetch on every visit to the
     * archive.
     */
    @Test
    fun `editing without restoring anything carries no change`() {
        show()

        compose.onAllNodes(hasText("Edit"))[0].performClick()
        compose.waitForIdle()

        assertEquals(1L to false, edited)
        assertNull(closedWith)
    }

    /**
     * A load that failed is not an empty archive.
     *
     * `rows` stays null on a failure, which is what tells it apart from an
     * archive that is genuinely empty — and the distinction is the whole reason
     * it is nullable. "Nothing archived. Archiving a habit keeps every day
     * recorded for it…" under an error message is the screen confidently
     * answering a question it could not ask, and the reassuring half is the one
     * that gets read.
     *
     * A single `?: emptyList()` is all it takes, it reads as tidying, and no
     * existing test can see it.
     */
    @Test
    fun `a failed load says so and does not claim the archive is empty`() {
        show(load = { throw java.io.IOException("Could not reach the server") })

        compose.onNodeWithText("Could not reach the server").assertIsDisplayed()
        compose.onNodeWithText("Nothing archived", substring = true).assertDoesNotExist()
        // Nor a spinner: nothing is still coming.
        compose.onAllNodes(hasText("Restore")).assertCountEquals(0)
    }

    /** The other side of it: an archive that really is empty says the empty thing. */
    @Test
    fun `an empty archive explains what archiving does`() {
        show(load = { emptyList() })

        compose.onNodeWithText("Nothing archived", substring = true).assertIsDisplayed()
    }

    /**
     * A restore the server refused leaves the habit where it was.
     *
     * The optimistic removal is what makes this worth pinning: `rows` is filtered
     * only inside the `try`, so a failure must leave the row on screen. Dropping
     * it anyway would show a restore that did not happen, and the habit is then
     * in neither list.
     */
    @Test
    fun `a refused restore keeps the habit in the list`() {
        show(onUnarchive = { throw java.io.IOException("Could not restore") })

        compose.onAllNodes(hasText("Restore"))[0].performClick()
        compose.waitUntil {
            compose.onAllNodes(hasText("Could not restore")).fetchSemanticsNodes().isNotEmpty()
        }

        compose.onNodeWithText("Water").assertIsDisplayed()
        compose.onAllNodes(hasText("Restore")).assertCountEquals(2)
    }
}
