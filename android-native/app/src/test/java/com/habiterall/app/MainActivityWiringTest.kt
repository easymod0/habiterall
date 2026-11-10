package com.habiterall.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The one line `MainActivity`'s fetch effect owes issue #200's review round:
 * `manualOrder` must come from the OVERVIEW reply, never the settings one.
 *
 * `MainActivity`'s fetch effect calls `api.settings()` and `api.overview()` as
 * two separate, sequential `try`/`catch` blocks — see the paragraph this
 * fix replaced in `android-native/CLAUDE.md`. Nothing here can drive that
 * race end-to-end: `HabitListScreen` is a private method on `MainActivity`
 * with no seam a Robolectric test can reach, which is the exact reason
 * `HabitList` had to be pulled out top-level before `HabitListTest` could
 * exist at all (see that file's own header comment). Standing up a real
 * `MainActivity`, a fake server for both endpoints and the auth flow in front
 * of them, to prove one assignment picks the right of two objects, is exactly
 * the disproportionate machinery the root CLAUDE.md warns a mirror is not
 * worth — this is not a mirror, but the same cost argument applies to the
 * test.
 *
 * So this is the guard the root CLAUDE.md asks for beside a behavioural one
 * it cannot have here: it reads the SOURCE and asserts `manualOrder` is
 * assigned inside the OVERVIEW try block, from `data.manualOrderEnabled`, and
 * nowhere inside the SETTINGS try block (`fetched`'s), which is the exact
 * defect issue #200's review round found (`fetched.manualOrderEnabled`,
 * seeded from a request that could fail independently of the overview one).
 *
 * `Overview.manualOrderEnabled` itself — the DECISION half — is pinned
 * behaviourally in `AppSettingsDefaultsTest`'s "Overview parses habitSort"
 * case. This guard is only for the WIRING half neither that test nor
 * `HabitListTest` can reach, and it is deliberately narrow: see the root
 * CLAUDE.md's "Writing tests here" on why a guard like this is kept for what
 * it can see and not mistaken for a substitute — check that it SEES the
 * sites it claims, not merely that an empty offender list reads clean.
 */
class MainActivityWiringTest {

    private val source: String by lazy {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(
                dir,
                "android-native/app/src/main/java/com/habiterall/app/ui/MainActivity.kt",
            )
            if (candidate.isFile) return@lazy candidate.readText()
            dir = dir.parentFile
        }
        throw AssertionError(
            "MainActivity.kt not found above ${File("").absolutePath}. It is the " +
                "file this guard reads; without it this test proves nothing."
        )
    }

    @Test
    fun `manualOrder is assigned from the overview reply, never the settings one`() {
        val settingsBlockStart = source.indexOf("val fetched = api.settings()")
        assertTrue(
            "the settings fetch call site (`val fetched = api.settings()`) is " +
                "not where this test expects it — has it moved or been renamed?",
            settingsBlockStart >= 0,
        )
        val overviewBlockStart = source.indexOf("val data = api.overview(", settingsBlockStart)
        assertTrue(
            "the overview fetch call site (`val data = api.overview(`) is not " +
                "where this test expects it, after the settings one",
            overviewBlockStart > settingsBlockStart,
        )
        // Everything from the settings fetch up to (not including) the overview
        // fetch — the settings `try` body plus its two `catch` clauses plus the
        // `try {` that opens the overview block. `manualOrder` must appear
        // NOWHERE in here: issue #200's review-round bug was exactly
        // `manualOrder = fetched.manualOrderEnabled` sitting in this span.
        val settingsSpan = source.substring(settingsBlockStart, overviewBlockStart)
        assertFalse(
            "`manualOrder` must not be assigned anywhere in the settings " +
                "fetch's try/catch — a failed `api.settings()` must leave it " +
                "at whatever the overview reply last set it to, not seed it " +
                "from `fetched`. See `Overview.manualOrderEnabled`'s KDoc in " +
                "Api.kt for why the two responses must not be allowed to " +
                "disagree about this.",
            Regex("""\bmanualOrder\s*=""").containsMatchIn(settingsSpan),
        )

        val overviewCatchAt = source.indexOf("} catch (e: CancellationException)", overviewBlockStart)
        assertTrue(
            "the overview try block's own `catch (e: CancellationException)` " +
                "could not be found after the overview fetch call site",
            overviewCatchAt > overviewBlockStart,
        )
        val overviewSpan = source.substring(overviewBlockStart, overviewCatchAt)
        assertTrue(
            "`manualOrder` must be assigned from the OVERVIEW reply " +
                "(`manualOrder = data.manualOrderEnabled`) inside this try block " +
                "— the same response `habits` and `categories` above it come " +
                "from, so the gate and the order it guards cannot land apart",
            Regex("""\bmanualOrder\s*=\s*data\.manualOrderEnabled\b""").containsMatchIn(overviewSpan),
        )
    }

    /**
     * The patch path — a setting changed on the phone's own settings screen —
     * must adopt the boundary BEFORE it reschedules: a reminder's owner date is
     * decided against the boundary held when `schedule` runs, so the other
     * order arms every alarm under the old one.
     *
     * A source guard for the reason the one above is: the patch lambda is inside
     * `MainActivity`, with no seam a test can reach. It checks that it SEES both
     * calls, in this lambda, and not merely that they are in order somewhere.
     */
    @Test
    fun `the patch path adopts the day boundary before it reschedules`() {
        val fresh = source.indexOf("val fresh = api.settings()")
        assertTrue(
            "the patch path's settings re-read (`val fresh = api.settings()`) is " +
                "not where this test expects it — has it moved or been renamed?",
            fresh >= 0,
        )
        val adopt = source.indexOf("DayEnd.adopt(", fresh)
        val reschedule = source.indexOf("Reminders.rescheduleAll(", fresh)
        assertTrue("no DayEnd.adopt( after the patch path's re-read", adopt > fresh)
        assertTrue("no Reminders.rescheduleAll( after the patch path's re-read", reschedule > fresh)
        assertTrue(
            "in the patch lambda `DayEnd.adopt(` must come before " +
                "`Reminders.rescheduleAll(`, or the reschedule arms under the old boundary",
            adopt < reschedule,
        )
        // Both belong to the SAME lambda: nothing between the re-read and the
        // reschedule may close it, or the order proved is of two unrelated spans.
        assertFalse(
            "the re-read and the reschedule are not in one lambda",
            source.substring(fresh, reschedule).contains("PatchOutcome("),
        )
    }

    /**
     * `HabiterallApp.onCreate` is never run by a test (every suite is
     * `@Config(application = Application::class)`), so nothing but this reads
     * that `DayEnd.load` happens, and before `rescheduleAll`: an alarm armed
     * from the cache before the boundary is loaded is armed under midnight.
     * Both calls are asserted PRESENT, so a rename reads as a failure and not
     * as an order that holds vacuously.
     */
    @Test
    fun `the app loads the day boundary before it reschedules the alarms`() {
        var dir: File? = File("").absoluteFile
        var app: String? = null
        while (dir != null && app == null) {
            val candidate = File(dir, "android-native/app/src/main/java/com/habiterall/app/HabiterallApp.kt")
            if (candidate.isFile) app = candidate.readText()
            dir = dir.parentFile
        }
        assertTrue("HabiterallApp.kt not found above ${File("").absolutePath}", app != null)
        val load = app!!.indexOf("DayEnd.load(this)")
        val reschedule = app.indexOf("Reminders.rescheduleAll(")
        assertTrue("no DayEnd.load(this) in HabiterallApp", load >= 0)
        assertTrue("no Reminders.rescheduleAll( in HabiterallApp", reschedule >= 0)
        assertTrue(
            "`DayEnd.load(this)` must come before `Reminders.rescheduleAll(`, or " +
                "the alarms re-armed at launch are aimed under midnight",
            load < reschedule,
        )
    }
}
