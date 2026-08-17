package com.habiterall.app

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.habiterall.app.notify.ReminderTime
import com.habiterall.app.ui.ReminderTimeField
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The reminder field, rendered — which is the only place three of its rules exist.
 *
 * `ReminderTimeTest` pins [ReminderTime] itself: that `830` parses, that blank is
 * `""` and garbage is `null`, that `minutes(37)` carries the odd minute. None of
 * that says the FIELD asks. A control that calls `minutes(null)`, or that reads
 * blank as a mistake, or that drops its accessibility complaint, passes every one
 * of those tests — and each has a consequence a person only sees on a screen.
 *
 * This is issue #110's own worked example. The accessibility rule below was
 * settled during #105 by decompiling the resolved Compose version and rendering
 * it on an emulator, with a negative control against the parent commit. That is
 * the measurement being made permanent here.
 *
 * The viewport is a real 360dp phone, deliberately and unlike
 * [SettingsScreenTest]'s tall one: the last rule in this file is about what
 * fits, and it narrows the field further still to the width a dialog gives it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, qualifiers = "w360dp-h640dp")
class ReminderTimeFieldTest {

    @get:Rule val compose = createComposeRule()

    /**
     * Renders the field over a fixed value.
     *
     * [quickPicks] adds one caller-supplied button. It is labelled as the habit
     * form's is, since that is the only caller that passes one at all — the
     * reminder dialog passes none, and the form passes this one only when the
     * draft already holds a time.
     */
    private fun show(value: String, quickPicks: Boolean = false, width: Dp? = null) {
        compose.setContent {
            ReminderTimeField(
                value = value,
                onValueChange = {},
                modifier = if (width == null) Modifier.fillMaxWidth() else Modifier.width(width),
                quickPicks = {
                    if (quickPicks) TextButton(onClick = {}) { Text(CALLER_PICK) }
                },
            )
        }
        compose.waitForIdle()
    }

    /** What a screen reader is told is wrong with the box, or null. */
    private fun spokenError(): String? = compose.onNode(hasSetTextAction())
        .fetchSemanticsNode().config.getOrNull(SemanticsProperties.Error)

    /**
     * A mistake is announced in this app's words, not Material's.
     *
     * `OutlinedTextField(isError = true)` sets an Error semantics property of its
     * own — the generic "Invalid input" — so the box is already marked as wrong
     * without any help. What that costs is the only thing a screen reader has to
     * go on: Save is disabled and the spoken reason says nothing about what a
     * time looks like. The complaint is a SIBLING of the field, because it
     * describes the two menus as well, so the association has to be made by hand
     * with `Modifier.semantics { error(...) }`.
     *
     * Asserted as the exact string rather than "contains a complaint": whether
     * the hand-written value REPLACES Material's or is discarded by it is
     * precisely the question, and the wrong answer is a perfectly plausible
     * non-empty string.
     */
    @Test
    fun `an unparseable time announces what a time looks like`() {
        show("half seven")

        assertEquals(
            "\"half seven\" is not a time — try 08:30, 8:30 pm or 2030",
            spokenError(),
        )
        // ...and the sighted half of the same message.
        compose.onNodeWithText("is not a time", substring = true).assertIsDisplayed()
    }

    /**
     * Blank is not a mistake — it is "no reminder", and it says so.
     *
     * [ReminderTime.parse] answers `""` for blank and `null` for garbage, and the
     * whole point of the pair is that the callers do different things with them:
     * the habit form disables Save on the second and stores the first. A field
     * that collapsed the two would mark an empty box as an error, which is a
     * screen telling somebody they have made a mistake by not setting a
     * reminder they never wanted.
     */
    @Test
    fun `blank is no reminder rather than an error`() {
        show("")

        assertNull("an empty field is not a mistake", spokenError())
        compose.onNodeWithText("No reminder — nothing will be sent for this habit.")
            .assertIsDisplayed()
    }

    /** The control for the two above: a real time is neither. */
    @Test
    fun `a valid time reads itself back`() {
        show("8:30 pm")

        assertNull(spokenError())
        compose.onNodeWithText(ReminderTime.describe("20:30")).assertIsDisplayed()
    }

    /**
     * An odd minute stays selectable once it has been typed.
     *
     * `MINUTE_STEP` bounds the MENU, never the field — so `08:37` must appear in
     * the minute list rather than being rounded to `08:35`. The rounding would
     * not be a display glitch: opening the menu on a saved 08:37 and picking
     * anything would move the reminder by two minutes without saying so.
     *
     * `minutes(extra)` is unit-tested; what is only visible here is that the
     * field passes the typed minute IN. `ReminderTime.minutes(null)` at this call
     * site is a one-word change that no existing test can see.
     *
     * Counted rather than matched, because the button that opens the menu is
     * labelled `37` too: one node before opening, two after.
     */
    @Test
    fun `a typed odd minute is in the minute menu`() {
        show("08:37")

        compose.onAllNodesWithText("37").assertCountEquals(1)
        compose.onNodeWithText("37").performClick()
        compose.waitForIdle()

        compose.onAllNodesWithText("37").assertCountEquals(2)
        // The stepped minutes are still there — the odd one is added, not
        // substituted.
        compose.onAllNodesWithText("35").assertCountEquals(1)
    }

    /**
     * No quick pick is clipped by the width the reminder DIALOG gives them.
     *
     * A layout rule, and the only one here. The picks were a plain `Row`, which
     * clips in silence: `21:00` — the last of [ReminderTime.COMMON] — was simply
     * unreachable from the reminder dialog, with nothing on screen to say a
     * button was missing. Found on an emulator during #105 and invisible to every
     * JVM test, because a clipped button is still composed and still has its
     * click action.
     *
     * THREE things had to be got right before it could catch anything, and the
     * first two were got wrong first. Each wrong version is a test that passes
     * against a plain `Row`, so they are worth writing down:
     *
     * - **`assertIsDisplayed` is not the question.** It is satisfied by any part
     *   of a node being visible, so a squeezed or half-off button passes it.
     * - **The full screen width is not the width.** #105's emulator measurement
     *   was explicit that the full-screen form fit all six and the DIALOG fit
     *   four. At the screen's own 360dp the five common picks fit a plain `Row`
     *   with room to spare, so a test at that width pins nothing. [DIALOG_CONTENT]
     *   is what a Material dialog leaves its content on a 360dp phone.
     * - **A `Row` does not overflow — it SQUEEZES.** This is the one that matters
     *   and it is the opposite of what "clipped" suggests. `Row` measures each
     *   child against what the previous ones left, so the overflow lands *inside*
     *   the bounds: measured under the mutation, `21:00` came out 8px wide
     *   instead of 58 and the caller's own pick was 0 x 52, placed at the origin.
     *   A containment check therefore passes — every button really is within the
     *   field. What has gone is the SIZE.
     *
     * So the rule is asserted as what it says: they WRAP (more than one line) and
     * are not CLIPPED (nothing is narrower than its identical siblings). Either
     * assertion alone kills the `Row` — verified separately, by deleting each and
     * re-running against the mutation — and both are here because they are two
     * claims, and a future layout could satisfy one without the other.
     *
     * What this does NOT catch, so that nobody discovers it as a surprise:
     * `FlowRow(maxItemsInEachRow = 1)` passes. Six picks one per line have
     * differing tops, identical widths and a non-zero caller's pick. That is
     * correct rather than a hole — the property being asserted is that no pick is
     * made unreachable, and one per line makes none of them so. It is ugly, and
     * ugly is not what this test is about.
     */
    @Test
    fun `the quick picks wrap rather than being squeezed`() {
        // A value that is not itself one of the quick picks, or the box's own
        // text is a second node with the same string and the search is ambiguous.
        show("09:15", quickPicks = true, width = DIALOG_CONTENT)

        // Six picks: the five common ones plus the caller's own.
        //
        // Be precise about what that is and is not, because the obvious reading
        // is wrong in a way that would invite weakening this test. Six at this
        // width is NOT a configuration either caller renders — the dialog passes
        // no quick pick at all, and the habit form passes one but is full-screen.
        // Nor is the sixth needed to trip anything. Measured at 264dp with the
        // five common picks ALONE:
        //
        //   FlowRow  four at top 125, `21:00` at top 177, every width 58
        //   Row      all five at top 125, `21:00` squeezed 58 -> 8
        //
        // So five alone fails both assertions under the mutation, and five is the
        // configuration the dialog actually renders — which is where `21:00` was
        // unreachable in the first place. The sixth is here because it exercises
        // the `quickPicks` slot and because it is the pick that reaches zero
        // width, which is a distinct failure mode from being squeezed to a sliver.
        // Dropping it costs that second mode and nothing else; the test goes on
        // pinning the rule.
        val picks = (ReminderTime.COMMON + CALLER_PICK).associateWith {
            compose.onNodeWithText(it).fetchSemanticsNode()
        }

        // Wrapped: the five common picks are 58dp each and cannot share one line
        // at this width, so they sit on at least two.
        //
        // Read from the COMMON five and not from all six, which is a trap this
        // test fell into: an unplaced node reports its bounds at the ORIGIN, so
        // the squeezed-to-nothing caller's pick sat at top 0 against everything
        // else's 125 and made a single-line layout look like two. A node that was
        // never given a size must not be allowed to answer a question about lines.
        val lines = ReminderTime.COMMON.map { picks.getValue(it).boundsInRoot.top }.distinct()
        assertTrue(
            "the common quick picks are all on one line at ${DIALOG_CONTENT.value}dp, " +
                "so the row is not wrapping: ${picks.mapValues { it.value.size.width }}",
            lines.size > 1,
        )

        // ...and not squeezed. The five common labels are the same shape in the
        // same style, so they must measure the same; a layout that has run out of
        // room shrinks the last one it reaches rather than saying so.
        val widths = ReminderTime.COMMON.map { picks.getValue(it).size.width }
        assertEquals(
            "the common quick picks should all be one width; a differing one has " +
                "been squeezed to fit and is unreachable at that size",
            1,
            widths.distinct().size,
        )
        // The caller's own pick is the one that vanished entirely — 0 x 52 at the
        // origin, which no assertion about the others would have noticed.
        assertTrue(
            "the caller's quick pick was given no width at all",
            picks.getValue(CALLER_PICK).size.width > 0,
        )
    }

    private companion object {
        /**
         * Roughly what a Material dialog leaves its content on a 360dp phone.
         *
         * **Derived, not measured**, and worth saying so plainly because the
         * number reads like a measurement: 360 less the dialog's window inset
         * either side, less its own content padding either side. Nothing in this
         * suite renders a dialog, so it is arithmetic that agrees with Material's
         * defaults rather than an observation of one.
         *
         * There is real margin, which is why it can be approximate without the
         * test becoming luck: the five common picks need 314px to sit on one line
         * (5 x 58 plus 4 x 6 of spacing), so anything meaningfully under that
         * forces the wrap this asserts, and the full 360dp screen does not.
         *
         * Measuring it properly is a trap rather than a chore — see the README:
         * a real `AlertDialog` under `createComposeRule` hangs `waitForIdle`.
         */
        val DIALOG_CONTENT = 264.dp

        /**
         * The habit form's own quick pick, verbatim.
         *
         * The only caller that passes one, and only when the draft already holds
         * a time. The reminder dialog passes none — its "Remove" is a dialog
         * button, because it saves rather than editing the field.
         */
        const val CALLER_PICK = "None"
    }
}
