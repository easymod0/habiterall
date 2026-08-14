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
}
