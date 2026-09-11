package com.habiterall.app

import android.app.AlertDialog
import android.app.Application
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.work.testing.WorkManagerTestInitHelper
import com.habiterall.app.data.HabitInput
import com.habiterall.app.notify.Notifications
import com.habiterall.app.ui.CountEntryActivity
import com.habiterall.app.ui.HabitFormScreen
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.shadows.ShadowToast
import java.io.File
import java.util.Locale

/**
 * The wiring between the one reader (`ui/Amount.kt`) and each of the three
 * places that used to read one differently.
 *
 * `HabitAmountTest` proves `parseAmount`/`amountComplaint`/`deviceAmountFormat`
 * themselves. That says nothing about whether a call site uses them — this
 * repo's own named defect class, stated in the root CLAUDE.md: "four Android
 * bugs and then two more lived one line below the pure function that pinned
 * them." So every case here asserts the OUTPUT that reached the platform — a
 * captured `HabitInput`, an `onConfirm` argument, a shown `Toast` — never a
 * return value of `parseAmount` itself.
 *
 * Every case sets `Locale.GERMANY` before rendering. Under the default JVM
 * test locale (en-US) `deviceAmountFormat()` resolves to `POINT`, where
 * "10.000" is an ordinary decimal (ten) and would not tell a fixed-convention
 * reader (the pre-#157 code, and a `toDoubleOrNull` reversion alike) apart
 * from a device-aware one. Only under `COMMA` does "10.000" become a thousands
 * group `parseAmount` must refuse and a bare `toDoubleOrNull` cannot — it
 * happily parses "10.000" as ten either way, which is the silent-wrong-answer
 * shape this whole feature exists to end.
 */

/** 1. `HabitFormScreen` -> the captured `HabitInput`. */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, qualifiers = "w400dp-h3000dp")
class HabitFormScreenAmountWiringTest {

    private lateinit var previousLocale: Locale

    @Before
    fun setGermanLocale() {
        previousLocale = Locale.getDefault()
        Locale.setDefault(Locale.GERMANY)
    }

    @After
    fun restoreLocale() {
        Locale.setDefault(previousLocale)
    }

    // `createAndroidComposeRule`, not `createComposeRule`: `HabitFormScreen`
    // calls `BackHandler`, which needs a real `ComponentActivity` behind it —
    // see `HabitFormScreenTest`'s identical comment.
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private var saved: HabitInput? = null

    @Test
    fun `a comma target reaches HabitInput, and a dot-grouped one is refused`() {
        compose.setContent {
            HabitFormScreen(
                existing = null,
                confirmDelete = true,
                categories = emptyList(),
                onSave = { saved = it },
                onDelete = null,
                onClose = {},
            )
        }
        compose.waitForIdle()

        compose.onNodeWithText("Name").performTextInput("Water")
        compose.onNodeWithText("Measurable").performClick()

        // Under the device tier (German locale here), a comma is the decimal
        // point. This already worked before this step — `HabitFormScreen` was
        // the one surface with a real parser — so this half proves the
        // extraction into `Amount.kt` did not break the surface that already
        // had the rule, not that it fixed something here.
        compose.onNodeWithText("Target").performTextInput("8,5")
        compose.onNodeWithText("Save").performClick()
        compose.waitForIdle()

        assertEquals(8.5, saved?.targetValue)

        // The half that IS new: before this step, `HabitFormScreen.parseAmount`
        // read a dot as a decimal point regardless of locale, so "10.000"
        // silently parsed as ten. Under the device tier this is now a thousands
        // group and is refused.
        saved = null
        compose.onNodeWithText("Target").performTextClearance()
        compose.onNodeWithText("Target").performTextInput("10.000")
        compose.waitForIdle()

        compose.onNodeWithText("Save").assertIsNotEnabled()
        compose.onNodeWithText(
            "Type it without the thousands separator — 10000, not 10.000.",
        ).assertExists()
        assertNull("Save must not have fired while the target is refused", saved)
    }
}

// ---------------------------------------------------------------------------
// 2. `CountDialog` -> its `onConfirm` callback: DELIBERATELY NOT HERE.
//
// `CountDialog` is a real Compose `AlertDialog`, and this project's own
// android-native/README.md already names the trap this hits: "a real
// `AlertDialog` under `createComposeRule` hangs `waitForIdle` indefinitely...
// there is no timeout and no failure — the test simply never returns."
// `ReminderTimeFieldTest` was written around the identical wall for the
// reminder dialog. A version of this case was written, run standalone, and
// reproduced exactly that: `compose.setContent { CountDialog(...) }` followed
// by `compose.waitForIdle()` (invoked explicitly and implicitly by every
// `onNodeWithText` query after it) ran for ~65s and then the test JVM died of
// `java.lang.OutOfMemoryError: Java heap space` rather than failing an
// assertion — consistent with "no timeout, never returns" rather than a bug in
// the test itself. `createAndroidComposeRule<ComponentActivity>()` shares the
// same idling primitive the README's argument is about (a dialog is its own
// window the rule's recomposer never reports idle for), so switching rules was
// not attempted as a second experiment.
//
// `CountDialog`'s extraction to top-level and its wiring onto `parseAmount`/
// `amountComplaint` are done in `ui/MainActivity.kt` regardless — that part of
// this step does not depend on this test existing.
//
// The lead then re-ran that experiment independently with the OTHER rule
// flavour and a JUnit bound — `createAndroidComposeRule<ComponentActivity>()`
// plus `@Test(timeout = 60_000)` — and it hung too: killed externally at 900
// seconds with no result XML written at all, so the JUnit timeout never even
// got to fail it. Two rule flavours, one of them bounded. The wall is real and
// is not a property of how the first attempt was written.
//
// So what stands in its place is `CountDialogWiringGuard` below, and it is a
// deliberate second-best rather than a substitute: the root CLAUDE.md's rule is
// that a source-text guard is kept for what it DOES catch — a call site that
// reads no shared rule at all — and has a behavioural test beside it. Here two
// of the three call sites have one and the third cannot, which is the same
// settlement `MainActivityWiringTest` records for `HabitListScreen`.
// ---------------------------------------------------------------------------

/**
 * 2', the second-best: `CountDialog` reads the one reader, and nothing under
 * `ui/` reads a typed amount any other way.
 *
 * Read the comment block above first — this exists because the behavioural case
 * cannot. What a guard like this cannot see is a renamed binding or an inverted
 * comparison, and the root CLAUDE.md says so; what it CAN see is the thing that
 * actually regressed here historically, which is a call site going back to
 * `toDoubleOrNull` because that is what `.toString()` invites.
 *
 * **The inventory is part of the assertion.** An empty offender list means
 * nothing until the denominator is known — #184's guard matched nothing and read
 * as clean — so the second case below names every file it scanned and every
 * occurrence it found, in the failure message, and asserts the scan is non-empty
 * before it asserts the offenders are.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class CountDialogWiringGuard {

    private val uiDir: File by lazy {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "android-native/app/src/main/java/com/habiterall/app/ui")
            if (candidate.isDirectory) return@lazy candidate
            dir = dir.parentFile
        }
        throw AssertionError(
            "the ui source directory was not found above ${File("").absolutePath}. " +
                "It is what this guard reads; without it this test proves nothing."
        )
    }

    @Test
    fun `CountDialog reads the one reader`() {
        val source = File(uiDir, "MainActivity.kt").readText()

        // Found by name, so a rename or a move fails HERE rather than leaving an
        // empty span that trivially satisfies everything below it.
        val start = source.indexOf("internal fun CountDialog(")
        assertTrue(
            "`internal fun CountDialog(` is not in MainActivity.kt — it has been " +
                "renamed, moved or made private again. This guard reads that " +
                "declaration; with it gone the guard proves nothing, so fix the " +
                "guard rather than deleting it.",
            start >= 0,
        )
        // To the next top-level declaration, which in this file is the
        // `@Composable` before `HabiterallTheme`. Bounded rather than
        // open-ended, or the span swallows unrelated code and the
        // does-not-contain assertion below stops being about this function.
        val end = source.indexOf("\n@Composable", start)
        assertTrue("no declaration follows CountDialog — the span is unbounded", end > start)
        val body = source.substring(start, end)

        assertTrue(
            "`CountDialog` must read the typed box through `parseAmount` — the one " +
                "reader in ui/Amount.kt. Found instead:\n" +
                body.lines().filter { it.contains("parsed") }.joinToString("\n"),
            body.contains("parseAmount(text)"),
        )
        assertFalse(
            "`CountDialog` reads a typed amount with `toDoubleOrNull`, which is " +
                "exactly the pre-#157 defect: it refuses `8,5` that the keyboard " +
                "invites, and reads `10.000` as ten on a comma device.",
            body.contains("toDoubleOrNull"),
        )
        assertTrue(
            "`CountDialog` must show `amountComplaint(...)` when its refusal is " +
                "non-blank, matching `HabitFormScreen`'s treatment — this is the " +
                "one of the three amount surfaces that cannot be driven by a " +
                "behavioural test (see the comment block above), so this guard is " +
                "the only thing that can pin it.",
            body.contains("amountComplaint("),
        )
    }

    @Test
    fun `nothing under ui reads a typed amount any other way`() {
        // Amount.kt is the one legitimate site: `parseAmount`'s own final
        // conversion, reached only after the group test and the DECIMAL shape
        // test have both passed, plus two mentions in its KDoc explaining what
        // it is not. Every other file under ui/ must go through it.
        val scanned = uiDir.listFiles { f -> f.name.endsWith(".kt") }
            .orEmpty()
            .filter { it.name != "Amount.kt" }
            .sortedBy { it.name }

        // The denominator. A guard whose glob silently matched nothing would
        // report a clean run against a tree full of offenders.
        assertTrue(
            "no Kotlin files were scanned under $uiDir — the guard's own glob is " +
                "broken, and an empty offender list below would mean nothing",
            scanned.size >= 5,
        )

        // A comment-ONLY line is skipped, and nothing more: a line whose trimmed
        // form begins with `*`, `//` or `/*` is prose, and this paragraph exists
        // because a KDoc sentence explaining what this guard protects against
        // failed the guard itself. Anything with code on it is still scanned
        // whole, so `s.toDoubleOrNull() // still fine, honest` is still an
        // offender — which is the spelling that would actually regress.
        val offenders = scanned.flatMap { file ->
            file.readLines().withIndex()
                .filterNot { (_, line) ->
                    val t = line.trimStart()
                    t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")
                }
                .filter { (_, line) -> line.contains("toDoubleOrNull") }
                .map { (i, line) -> "${file.name}:${i + 1}: ${line.trim()}" }
        }

        assertEquals(
            "a typed amount is read outside `parseAmount`. Scanned " +
                "${scanned.size} files under ui/ (${scanned.joinToString(", ") { it.name }}), " +
                "Amount.kt deliberately excluded as the one reader. Offenders:\n" +
                offenders.joinToString("\n"),
            emptyList<String>(),
            offenders,
        )
    }
}

/** 3. `CountEntryActivity` -> the platform: the shown `Toast`. */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class CountEntryActivityAmountWiringTest {

    private lateinit var previousLocale: Locale

    @Before
    fun setUp() {
        previousLocale = Locale.getDefault()
        Locale.setDefault(Locale.GERMANY)
        WorkManagerTestInitHelper.initializeTestWorkManager(RuntimeEnvironment.getApplication())
    }

    @After
    fun restoreLocale() {
        Locale.setDefault(previousLocale)
    }

    private fun launch(): AlertDialog {
        val app = RuntimeEnvironment.getApplication()
        val intent = Intent(app, CountEntryActivity::class.java).apply {
            putExtra(Notifications.EXTRA_HABIT_ID, 7L)
            putExtra(Notifications.EXTRA_DATE, "2026-09-10")
            putExtra(Notifications.EXTRA_HABIT_NAME, "Water")
            putExtra(Notifications.EXTRA_UNIT, "glasses")
            putExtra(Notifications.EXTRA_TARGET, 8.0)
        }
        Robolectric.buildActivity(CountEntryActivity::class.java, intent).create()
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertNotNull("CountEntryActivity did not show an AlertDialog", dialog)
        return dialog as AlertDialog
    }

    /**
     * The dialog's own `EditText`, walking the view tree from the dialog's
     * window — there is no id to look up by, since `CountEntryActivity` builds
     * the view entirely in code rather than inflating a layout.
     */
    private fun findEditText(dialog: AlertDialog): EditText? {
        fun walk(view: View): EditText? {
            if (view is EditText) return view
            if (view is ViewGroup) {
                for (i in 0 until view.childCount) {
                    walk(view.getChildAt(i))?.let { return it }
                }
            }
            return null
        }
        return dialog.window?.decorView?.let(::walk)
    }

    @Test
    fun `a comma reading is recorded, a dot-grouped one is toasted the thousands complaint`() {
        val app = RuntimeEnvironment.getApplication()

        val dialog = launch()
        val input = findEditText(dialog)
        assertNotNull("the number pad's EditText could not be found", input)

        // Under the UNFIXED code
        // (`input.text.toString().trim().toDoubleOrNull()`), "8,5" parses to
        // null and the toast is the OLD, now-deleted "Enter a number of zero or
        // more" string — this is the half that fails loudly against master.
        input!!.setText("8,5")
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()

        assertEquals(
            app.getString(R.string.recorded_yes),
            ShadowToast.getTextOfLatestToast(),
        )

        val dialog2 = launch()
        val input2 = findEditText(dialog2)
        assertNotNull("the number pad's EditText could not be found", input2)
        input2!!.setText("10.000")
        dialog2.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()

        assertEquals(
            "Type it without the thousands separator — 10000, not 10.000.",
            ShadowToast.getTextOfLatestToast(),
        )
    }
}
