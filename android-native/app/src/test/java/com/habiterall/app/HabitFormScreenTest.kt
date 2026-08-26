package com.habiterall.app

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.habiterall.app.data.Category
import com.habiterall.app.data.Habit
import com.habiterall.app.data.HabitInput
import com.habiterall.app.ui.HabitFormScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The habit form's category picker, and the one hazard it exists to avoid.
 *
 * #251's web habit dialog shipped a silent category clear: a habit whose
 * category was not among the options on screen drew as uncategorised, and
 * saving without touching the row cleared it through `PUT /habits/:id`'s
 * replace semantics. `Draft.categoryId`'s own KDoc states the fix; this file
 * is what proves the form actually behaves that way rather than merely
 * saying so.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, qualifiers = "w400dp-h3000dp")
class HabitFormScreenTest {

    // `createAndroidComposeRule`, not `createComposeRule`: HabitFormScreen calls
    // `BackHandler`, which needs a real `ComponentActivity` behind it — see
    // HabitListTest's own comment on the identical requirement.
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val health = Category(id = 1, name = "Health", color = "#22c55e")
    private val work = Category(id = 2, name = "Work", color = "#3b82f6")

    private var saved: HabitInput? = null
    private var closedWith: Boolean? = null

    private fun show(
        existing: Habit? = null,
        categories: List<Category> = listOf(health, work),
    ) {
        saved = null
        closedWith = null
        compose.setContent {
            HabitFormScreen(
                existing = existing,
                confirmDelete = true,
                categories = categories,
                onSave = { saved = it },
                onDelete = if (existing != null) ({}) else null,
                onClose = { closedWith = it },
            )
        }
        compose.waitForIdle()
    }

    /** A name has to be typed, or Save stays disabled — every test below needs one. */
    private fun typeName(name: String = "Meditate") {
        compose.onNodeWithText("Name").performTextInput(name)
    }

    @Test
    fun `a new habit shows None selected, and tapping a category sends its id`() {
        show()

        compose.onNodeWithText("None").assertIsSelected()
        compose.onNodeWithText("Work").assertIsNotSelected()

        compose.onNodeWithText("Work").performClick()
        compose.onNodeWithText("None").assertIsNotSelected()
        compose.onNodeWithText("Work").assertIsSelected()

        typeName()
        compose.onNodeWithText("Save").performClick()
        compose.waitForIdle()

        assertEquals(2L, saved?.categoryId)
        assertEquals(true, closedWith)
    }

    @Test
    fun `an existing habit's category chip is selected when the form opens`() {
        show(existing = Habit(id = 9, name = "Water", categoryId = 1))

        compose.onNodeWithText("Health").assertIsSelected()
        compose.onNodeWithText("Work").assertIsNotSelected()
        compose.onNodeWithText("None").assertIsNotSelected()
    }

    @Test
    fun `tapping None and saving sends a null category`() {
        show(existing = Habit(id = 9, name = "Water", categoryId = 1))

        compose.onNodeWithText("Health").assertIsSelected()
        compose.onNodeWithText("None").performClick()
        compose.onNodeWithText("None").assertIsSelected()

        compose.onNodeWithText("Save").performClick()
        compose.waitForIdle()

        assertNull(saved?.categoryId)
    }

    /**
     * The load-bearing case. `categories` does not carry id 7 — deleted since
     * the overview was last fetched — and the habit's own category must
     * survive a save nobody touched. A non-empty `categories` that merely
     * lacks id 7 is genuinely "the category is gone", so this is where the
     * "not in your list" wording belongs — see the sibling test below for the
     * other input that reaches the same disabled chip and must NOT say this.
     */
    @Test
    fun `an unresolvable category id is kept across an untouched save, and None is not selected`() {
        show(existing = Habit(id = 9, name = "Water", categoryId = 7))

        compose.onNodeWithText("None").assertIsNotSelected()
        compose.onNodeWithText("Health").assertIsNotSelected()
        compose.onNodeWithText("Work").assertIsNotSelected()
        compose.onNodeWithText("Not in your list (#7)").assertIsSelected()

        compose.onNodeWithText("Save").performClick()
        compose.waitForIdle()

        assertEquals(
            "an untouched save must keep the habit's own unresolvable category id",
            7L,
            saved?.categoryId,
        )
    }

    /**
     * The other input that reaches the same disabled chip: a form opened
     * before the account's first `/overview` fetch has landed, where
     * `categories` is empty rather than merely missing id 7. Reusing "not in
     * your list" here would tell a user their category is gone when it has
     * only not loaded yet — the defect this pair of tests exists to catch.
     */
    @Test
    fun `an unresolvable category id with no categories loaded yet reads as not-loaded, not gone`() {
        show(existing = Habit(id = 9, name = "Water", categoryId = 7), categories = emptyList())

        compose.onNodeWithText("None").assertIsNotSelected()
        compose.onNodeWithText("Categories haven't loaded yet (#7)").assertIsSelected()

        compose.onNodeWithText("Save").performClick()
        compose.waitForIdle()

        assertEquals(
            "an untouched save must keep the habit's own category id even before categories loaded",
            7L,
            saved?.categoryId,
        )
    }

    /**
     * Named for what it pins, which is NOT "the account has none": an empty
     * list is equally a fetch that has not landed, and this screen cannot tell
     * the two apart. What it can say is that there is nothing here to pick,
     * and where picking anything would have to come from.
     */
    @Test
    fun `with nothing to pick and no category set, the picker says where one comes from`() {
        show(categories = emptyList())

        compose.onNodeWithText("Categories are made in the web app.").assertExists()
    }

    /**
     * The hint stands down for a habit that already carries a category, and
     * the reason is the contradiction it would otherwise produce: an empty
     * list plus a category id draws "Categories haven't loaded yet (#7)", and
     * a line implying there are none to load directly beneath it says the
     * opposite about the same state. The chip is the accurate one of the two,
     * so it is the one that stays.
     */
    @Test
    fun `the where-they-come-from hint does not sit under a not-loaded-yet chip`() {
        show(existing = Habit(id = 9, name = "Water", categoryId = 7), categories = emptyList())

        compose.onNodeWithText("Categories haven't loaded yet (#7)").assertExists()
        compose.onAllNodesWithText("Categories are made in the web app.").assertCountEquals(0)
    }

    @Test
    fun `a full category list does not draw the where-they-come-from hint`() {
        show()

        compose.onAllNodesWithText("Categories are made in the web app.").assertCountEquals(0)
    }
}
