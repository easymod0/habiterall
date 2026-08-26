package com.habiterall.app

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.isSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsDisplayed
import com.habiterall.app.data.AppSettings
import com.habiterall.app.ui.PatchOutcome
import com.habiterall.app.ui.SettingsScreen
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What the settings screen DRAWS, and what a tap on it does.
 *
 * [AppSettingsDefaultsTest] pins the constants — that `DEFAULT_HISTORY_GRANULARITY`
 * is `week` and that `historyGranularityOrDefault` returns it. What it cannot see
 * is whether the screen asks. A `?: "day"` written at the call site in
 * `SettingsScreen` is a second copy of the registry that every existing test
 * passes, and it is the exact bug this project already had: the screen showed a
 * value the charts were not using, and — because a chip already drawn as selected
 * does not fire — it was the one value that could not then be stored.
 *
 * Those are two rules and both are only observable on a rendered screen, which is
 * why they are here rather than in a unit test:
 *
 * - the chip drawn as selected for an untouched account is the ACCOUNT's default;
 * - a chip that is already selected issues no write, and every other one does.
 *
 * The third is `PatchOutcome.ignored`, which exists because `PUT /settings`
 * answers 200 for a key it will not store. Read as success, the control springs
 * back to where it was and nothing says why — a failure with no exception, no
 * error status and no visible effect. Only the rendered screen can be asked
 * whether it said something.
 */
@RunWith(RobolectricTestRunner::class)
@Config(
    application = android.app.Application::class,
    // A viewport tall enough for the whole screen, so a control being below the
    // fold is not something these tests can trip over. `performClick` injects a
    // touch at the node's centre, so an off-screen chip silently receives
    // nothing — and a test asserting that a tap wrote nothing would then pass
    // for the wrong reason. The scrolling is real and is not what is under test
    // here; [ReminderTimeFieldTest] is where a genuine width is used, because
    // there the layout IS the rule.
    qualifiers = "w400dp-h3000dp",
)
class SettingsScreenTest {

    @get:Rule val compose = createComposeRule()

    /** Every patch the screen sent, in order, flattened to `key=value`. */
    private val sent = mutableListOf<String>()

    /** What [onClose] was told, or null while the screen is still open. */
    private var closedWith: Boolean? = null

    /**
     * Render the screen over a server that stores everything it is sent.
     *
     * [ignored] is the other answer `PUT /settings` can give: 200, with the key
     * listed as thrown away.
     */
    private fun show(
        initial: AppSettings = AppSettings(),
        ignored: List<String> = emptyList(),
    ) {
        compose.setContent {
            SettingsScreen(
                initial = initial,
                androidRemindersSupported = true,
                onPatch = { patch ->
                    patch.forEach { (k, v) -> sent += "$k=${(v as JsonPrimitive).content}" }
                    // A server that stored it answers with the new settings; one
                    // that ignored it answers with the old. Both are a 200.
                    PatchOutcome(
                        settings = if (ignored.isEmpty()) applied(initial, patch) else initial,
                        ignored = ignored,
                    )
                },
                onClose = { closedWith = it },
            )
        }
        compose.waitForIdle()
    }

    /** The one key this test ever patches, folded into the settings object. */
    private fun applied(base: AppSettings, patch: Map<String, JsonElement>): AppSettings {
        var next = base
        patch.forEach { (k, v) ->
            val value = (v as JsonPrimitive).content
            next = when (k) {
                "dayOrder" -> next.copy(dayOrder = value)
                "historyGranularity" -> next.copy(historyGranularity = value)
                else -> next
            }
        }
        return next
    }

    /** The label on every chip the screen has drawn as selected. */
    private fun selectedChipLabels(): List<String> =
        compose.onAllNodes(isSelected()).fetchSemanticsNodes().mapNotNull { node ->
            node.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
        }

    /**
     * An account that has stored nothing shows the SERVER's defaults.
     *
     * Every choice row at once rather than one, and deliberately: the defect this
     * guards is a default copied at a call site, and a test naming only the one
     * key that drifted would not see the next one. Reading the labels back off
     * whatever the screen marked selected also means no chip can be checked by
     * position, so re-ordering the screen does not falsify this.
     *
     * `Week` is the entry worth staring at. It is the only default in the whole
     * registry that is not the first option in its own list, which is exactly how
     * it got copied as `Day` the first time this screen was written — and `Day`
     * IS here, legitimately, as the strength resolution's own default. A screen
     * that reads history as `day` therefore still shows a plausible list; it
     * simply has two `Day`s and no `Week`.
     */
    @Test
    fun `an untouched account draws the server's defaults as selected`() {
        show()

        assertEquals(
            listOf(
                // Habits with a limit → atMostUnlogged: miss
                "Counts as a miss",
                // Display → dayOrder: newest-left, weekStart: monday
                "Today on the left",
                "Monday",
                // Charts → historyGranularity: WEEK, historyMode: percent,
                // scoreGranularity: day, calendarZoom: default
                "Week",
                "Percent",
                "Day",
                "Default",
            ),
            selectedChipLabels(),
        )
    }

    /**
     * A stored value wins, and the screen shows it rather than the default.
     *
     * The other direction of the same wiring: an account set to `day` must draw
     * `Day` under History resolution. Without this, a screen hard-coded to the
     * default would pass the test above.
     */
    @Test
    fun `a stored value is what the chip shows`() {
        show(AppSettings(historyGranularity = "day", dayOrder = "newest-right"))

        val labels = selectedChipLabels()
        assertEquals(
            "history resolution should follow the account, not the default",
            2,
            labels.count { it == "Day" },
        )
        assertEquals(0, labels.count { it == "Week" })
        compose.onNodeWithText("Today on the right").assertIsSelected()
    }

    /**
     * Tapping the chip that is already selected writes nothing.
     *
     * This is the half that makes a wrong default unrecoverable rather than
     * merely wrong, and it is a real rule in its own right: without it every
     * settled screen re-sends its own state on any stray tap. `dayOrder` is used
     * because its two labels appear nowhere else on the screen, so neither node
     * can be confused with a chip from another row.
     */
    @Test
    fun `a chip already selected does not fire, and the others do`() {
        show()

        compose.onNodeWithText("Today on the left").assertIsSelected().performClick()
        compose.waitForIdle()
        assertEquals("the selected chip must not write", emptyList<String>(), sent)

        compose.onNodeWithText("Today on the right").performClick()
        compose.waitUntil { sent.isNotEmpty() }
        // The KEY the server knows and the VALUE, not the label on the button.
        assertEquals(listOf("dayOrder=newest-right"), sent)
    }

    /**
     * A key the server threw away is reported, and does not count as a change.
     *
     * `PUT /settings` answers 200 and lists the key in `ignored` — which is what
     * lets an older server tolerate a newer client, and is indistinguishable from
     * success unless the screen looks. The label in the sentence is the point:
     * "this server did not store the day order" is a different message from "this
     * app is broken", and it is the only one the user can act on.
     *
     * `changed` is the second half. It decides whether the grid behind this
     * screen refetches, so counting a dropped key as a change costs a request
     * that can only report the same value back.
     */
    @Test
    fun `a key the server ignored is explained and is not a change`() {
        show(ignored = listOf("dayOrder"))

        compose.onNodeWithText("Today on the right").performClick()
        compose.waitUntil { sent.isNotEmpty() }
        compose.waitForIdle()

        compose.onNodeWithText("This server did not store the day order.", substring = true)
            .assertIsDisplayed()
        // ...and the chip is back where it was, because the re-read says so.
        compose.onNodeWithText("Today on the left").assertIsSelected()

        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitForIdle()
        assertEquals("a dropped key is not a change", false, closedWith)
    }

    /**
     * A key the server DID store is a change, and is not complained about.
     *
     * The control for the test above: the same tap, the same screen, a server
     * that stores it. Without this, a screen that reported every write as ignored
     * would pass that one.
     */
    @Test
    fun `a stored key closes as a change and says nothing`() {
        show()

        compose.onNodeWithText("Today on the right").performClick()
        compose.waitUntil { sent.isNotEmpty() }
        compose.waitForIdle()

        compose.onAllNodes(
            androidx.compose.ui.test.hasText("did not store", substring = true)
        ).assertCountEquals(0)
        compose.onNodeWithText("Today on the right").assertIsSelected()

        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitForIdle()
        assertEquals(true, closedWith)
    }

    /**
     * Toggling "Group by category" patches exactly that key.
     *
     * The switch is reached by `SwitchRow`'s own `contentDescription`, which
     * is what names one of five otherwise identical switches — neither the
     * `Row` nor the `Column` around it carries a semantics node, so the title
     * `Text` is a sibling leaf rather than an ancestor and cannot label it.
     *
     * The KEY sent is the point of the test. `AppSettings.groupByCategory`
     * being right does not make this call site right: a typo here —
     * `groupByCategories`, say — draws the same switch, flips it under the
     * thumb, and stores nothing, because `PUT /settings` drops an unknown key
     * in silence with a 200 so an older server tolerates a newer client.
     */
    @Test
    fun `toggling group by category patches exactly that key`() {
        show()

        compose.onNodeWithContentDescription("Group by category").assertIsOff().performClick()
        compose.waitUntil { sent.isNotEmpty() }

        assertEquals(listOf("groupByCategory=true"), sent)
    }

    /**
     * Closing without touching anything reports no change.
     *
     * Cheap, and it is the case the flag exists for: the grid behind must not
     * refetch because somebody looked at their settings.
     */
    @Test
    fun `looking and leaving is not a change`() {
        show()
        assertNull(closedWith)

        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitForIdle()

        assertEquals(false, closedWith)
        assertEquals(emptyList<String>(), sent)
    }
}
