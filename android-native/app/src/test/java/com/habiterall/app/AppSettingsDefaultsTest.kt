package com.habiterall.app

import com.habiterall.app.data.AppSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The account's settings have ONE set of defaults, and this is what keeps this
 * client's copy of them honest.
 *
 * `GET /api/settings` returns only the keys that have been stored — no gaps
 * filled — so every client has to supply a default for a setting nobody has
 * touched, and every client's copy is a mirror that can drift. It did, on the
 * first day this app grew a settings screen: `historyGranularity` defaults to
 * `week` and was read here as `day`, which is the only default in the registry
 * that is not the first option in its own list. The result was a screen showing
 * a value the charts were not using, and — because a chip already drawn as
 * selected does not fire — no way to set the value it claimed was already set.
 *
 * So this reads the registry itself rather than restating it. A literal-for-
 * literal test would have been written wrong by whoever wrote the constant
 * wrong; only the file can be the source. It is the Kotlin half of what
 * `shared/test/settings.test.js` does for the web UI, and it is why the
 * constants in [AppSettings] can be trusted rather than merely believed.
 */
class AppSettingsDefaultsTest {

    /**
     * The web's settings registry, found by walking up from wherever the test
     * runner started.
     *
     * Gradle runs unit tests from the module directory, so the repository root
     * is two levels up — but the walk means a change to that does not silently
     * turn this test into a no-op. Missing is a FAILURE rather than a skip: this
     * module lives in the habiterall repository and the file it mirrors is
     * always beside it.
     */
    private val registry: String by lazy {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "shared/public/ui/settings.js")
            if (candidate.isFile) return@lazy candidate.readText()
            dir = dir.parentFile
        }
        throw AssertionError(
            "shared/public/ui/settings.js not found above ${File("").absolutePath}. " +
                "It is the source these defaults mirror; without it this test proves nothing."
        )
    }

    /**
     * `SETTINGS.<key>.default` as the registry literally writes it, quotes
     * stripped.
     *
     * Deliberately narrow: it finds the key's own block and reads the one
     * `default:` inside it, so an option list or a neighbouring setting cannot
     * answer for it. A key it cannot find fails rather than returning a
     * plausible empty string.
     */
    private fun default(key: String): String {
        val start = registry.indexOf("\n  $key: {")
        assertTrue("$key is not in SETTINGS — has it been renamed?", start >= 0)
        val end = registry.indexOf("\n  },", start)
        assertTrue("$key's block does not close as expected", end > start)

        // The rest of the `default:` line, then the JS punctuation off it. Read
        // plainly rather than cleverly: a regex that has to be reasoned about is
        // one that can pass by accident, which is the whole thing this is here
        // to prevent.
        val block = registry.substring(start, end)
        val match = Regex("""\n\s*default:\s*([^\n]+)""").find(block)
        assertTrue("$key has no default in the registry", match != null)
        return match!!.groupValues[1].trim().trimEnd(',').trim().trim('\'', '"')
    }

    @Test
    fun `the display defaults match the registry`() {
        assertEquals(default("dayOrder"), AppSettings.DEFAULT_DAY_ORDER)
        assertEquals(default("weekStart"), AppSettings.DEFAULT_WEEK_START)
        assertEquals(default("calendarZoom"), AppSettings.DEFAULT_CALENDAR_ZOOM)
    }

    @Test
    fun `the chart defaults match the registry`() {
        // The one that drifted. Named separately so a failure says which half of
        // the settings screen is lying about what the account is set to.
        assertEquals(
            default("historyGranularity"),
            AppSettings.DEFAULT_HISTORY_GRANULARITY,
        )
        assertEquals(default("historyMode"), AppSettings.DEFAULT_HISTORY_MODE)
        assertEquals(default("scoreGranularity"), AppSettings.DEFAULT_SCORE_GRANULARITY)
    }

    @Test
    fun `the unlogged-day default matches the registry`() {
        // Named on its own because it is the one default here that decides an
        // ARITHMETIC rather than a drawing. The others being wrong shows the
        // wrong chart; this one being wrong would have the screen say a limit's
        // unlogged days count as a miss while the streak beside it was computed
        // as though they did not — and the streak is the server's, so the phone
        // could not be corrected by looking at it.
        assertEquals(default("atMostUnlogged"), AppSettings.DEFAULT_AT_MOST_UNLOGGED)
        assertEquals("miss", AppSettings().atMostUnloggedOrDefault)
        assertEquals("success", AppSettings(atMostUnlogged = "success").atMostUnloggedOrDefault)
    }

    @Test
    fun `the toggle defaults match the registry`() {
        // Read through the accessors, because those are what the app calls: a
        // right constant reached by a wrong `?:` is the same bug.
        val untouched = AppSettings()
        assertEquals(default("skipDays").toBoolean(), untouched.skipDaysEnabled)
        assertEquals(default("questionMarks").toBoolean(), untouched.questionMarksEnabled)
        assertEquals(default("confirmDelete").toBoolean(), untouched.confirmDeleteEnabled)
    }

    @Test
    fun `an untouched account is a phone that reminds`() {
        // `notifyChannels` defaults to the on-device alarm alone — the one
        // destination that needs no setup and the only one that fires with no
        // network. The registry writes it as a list, so this asks the question
        // the app actually asks rather than comparing shapes.
        assertTrue(default("notifyChannels").contains(AppSettings.CHANNEL_ANDROID))
        assertTrue(AppSettings().androidRemindersEnabled)
    }

    @Test
    fun `a stored value wins over every default`() {
        // The other half of the contract: null means untouched, and anything
        // else — including a value equal to the default — is the account's.
        val set = AppSettings(
            notifyChannels = emptyList(),
            dayOrder = "newest-right",
            skipDays = true,
            questionMarks = true,
            weekStart = "sunday",
            confirmDelete = false,
            calendarZoom = "wide",
            historyGranularity = "day",
            historyMode = "count",
            scoreGranularity = "year",
        )
        assertFalse(set.androidRemindersEnabled)
        assertFalse(set.newestLeft)
        assertTrue(set.skipDaysEnabled)
        assertTrue(set.questionMarksEnabled)
        assertFalse(set.weekStartsMonday)
        assertFalse(set.confirmDeleteEnabled)
        assertEquals("newest-right", set.dayOrderOrDefault)
        assertEquals("sunday", set.weekStartOrDefault)
        assertEquals("wide", set.calendarZoomOrDefault)
        assertEquals("day", set.historyGranularityOrDefault)
        assertEquals("count", set.historyModeOrDefault)
        assertEquals("year", set.scoreGranularityOrDefault)
    }

    /**
     * The header this client uses to tell the server which clock it is on, and
     * the name the SERVER reads it back under.
     *
     * A one-string mirror, and unguarded until now: rename `DEVICE_ZONE_HEADER`
     * in shared/src/notify.js and the phone silently stops reporting, with the
     * only symptom being reminders on the wrong clock for accounts set to
     * follow their device — which nothing in either suite would have said.
     *
     * Read out of the source rather than restated, for the reason the defaults
     * above are: a literal-for-literal test would be written wrong by whoever
     * wrote the constant wrong.
     *
     * One caveat worth knowing, and it applies to every test in this file:
     * `shared/` is not a declared Gradle input, so a change THERE alone leaves
     * `testDebugUnitTest` UP-TO-DATE and this never runs. Verified — renaming
     * the JS constant reported success until `--rerun-tasks`. CI checks out
     * clean so it always runs there; locally, use `--rerun-tasks` before
     * believing a green result about a change outside this module.
     */
    @Test
    fun `the device-clock header is spelled the same on both sides`() {
        var dir: java.io.File? = java.io.File("").absoluteFile
        var source: String? = null
        while (dir != null && source == null) {
            val candidate = java.io.File(dir, "shared/src/notify.js")
            if (candidate.isFile) source = candidate.readText()
            dir = dir.parentFile
        }
        assertTrue(
            "shared/src/notify.js not found above ${java.io.File("").absolutePath}",
            source != null,
        )

        val declared = Regex("""DEVICE_ZONE_HEADER\s*=\s*'([^']+)'""")
            .find(source!!)?.groupValues?.get(1)
        assertTrue("DEVICE_ZONE_HEADER is not declared in shared/src/notify.js", declared != null)

        // The Kotlin side is a private top-level const, so it is read from ITS
        // source too rather than exposed just for a test.
        var kdir: java.io.File? = java.io.File("").absoluteFile
        var kotlin: String? = null
        while (kdir != null && kotlin == null) {
            val candidate = java.io.File(kdir, "android-native/app/src/main/java/com/habiterall/app/data/Api.kt")
            if (candidate.isFile) kotlin = candidate.readText()
            kdir = kdir.parentFile
        }
        assertTrue("Api.kt not found", kotlin != null)
        val mine = Regex("""DEVICE_ZONE_HEADER\s*=\s*"([^"]+)"""")
            .find(kotlin!!)?.groupValues?.get(1)

        assertEquals(declared, mine)
    }
}
