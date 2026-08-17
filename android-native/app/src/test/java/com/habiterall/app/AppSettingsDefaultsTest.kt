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

    /**
     * Every key the registry has is one somebody decided about.
     *
     * The tests above name their keys, so a key ADDED to the registry could not
     * fail any of them — and the mirror it needs would go missing in exactly
     * the silence this whole file exists to end. `theme` is what showed it up:
     * it landed as a real setting, the WebView this app embeds now paints from
     * the account, and nothing here noticed there was no default for it.
     *
     * So the registry is enumerated and every key must be in one list or the
     * other. [notMirrored] is the deliberate half, and each entry carries its
     * reason — the same shape as `ELSEWHERE` in shared/test/compose.test.js,
     * and for the same purpose: "we thought about it" has to be written down,
     * or it is indistinguishable from "we forgot".
     */
    private val mirrored = setOf(
        "dayOrder", "weekStart", "calendarZoom", "skipDays", "questionMarks",
        "atMostUnlogged", "scoreGranularity", "historyGranularity", "historyMode",
        "notifyChannels", "confirmDelete",
    )

    private val notMirrored = mapOf(
        // Painted by the WebView from the account, through the same cascade the
        // browser uses. The native chrome around it follows the system theme,
        // which is Android's own setting and not this account's — so a default
        // here would be a value nothing on this client reads.
        //
        // Two costs come with that and are accepted rather than unnoticed. A
        // phone in light mode with the account set to dark shows light chrome
        // around a dark page; and `WebScreen`'s pre-paint background is the
        // Material one, so that combination flashes light on the way into each
        // habit — the very flash that colour is set to prevent, corrected for
        // the wrong theme. Fixing either properly means the phone knowing the
        // account's theme, which is a mirror, and this list is where that is
        // refused. If it is ever worth it, the honest shape is an OBSERVATION
        // (cache the colour the WebView last painted) and not a copy of the
        // setting — the distinction `notifyTimezone` already draws.
        "theme" to "the WebView paints it; native chrome follows Android",
        // How many day columns the WEB dashboard draws. This client's grid does
        // not page a fixed window at all — it starts at `Grid.INITIAL_DAYS`,
        // grows by `PAGE_DAYS` as you scroll toward the edge up to `MAX_DAYS`,
        // and sends `end = null` — so there is no count here for the setting to
        // govern. Mirroring it would be a value nothing on this client reads.
        "gridDays" to "the native grid scrolls and grows; it has no fixed count",
        // The detail view IS the WebView (`#/habit/42`), so this client already
        // honours the setting — through the web registry's own default, not a
        // copy of it. One renderer, so a second default would be the drift this
        // list exists to avoid rather than the mirror that prevents it.
        "detailCards" to "the detail view is the WebView, which reads it already",
        // Server-sent destinations. The phone's own channel is `notifyChannels`,
        // which IS mirrored; these three configure Discord, which this client
        // neither posts to nor holds the credential for.
        "discordChannelId" to "a server-sent destination this client never posts to",
        "discordUserId" to "a server-sent destination this client never posts to",
        "discordWebhook" to "a server-sent destination this client never posts to",
        // The other server-sent destination, and the reason it is listed rather
        // than mirrored is sharper than Discord's: ntfy HAS an Android app, so
        // "the phone is involved" is true and still does not make this a value
        // this client reads. The subscribing app is ntfy's, the publisher is
        // this account's server, and nothing in habiterall's own client posts to
        // a topic or holds its token. Copying either here would be a mirror with
        // no second reader — cost with no property.
        "ntfyTopicUrl" to "a server-sent destination this client never posts to",
        "ntfyToken" to "a credential for a destination this client never posts to",
        // The phone's alarms are local and already on the device's own clock,
        // so there is nothing here for this to govern. `resolveTimeZone` reads
        // it for the SERVER's sends only.
        "notifyTimezone" to "the local alarm is already on this device's clock",
        // The one entry here that records a COST rather than an absence of one,
        // and it is written down as such deliberately.
        //
        // This decides which character a decimal point is where an amount is
        // TYPED, and this client has three places that read one: `parseAmount`
        // in HabitFormScreen, and a bare `toDoubleOrNull` in both
        // CountEntryActivity and MainActivity's day dialog — which already
        // disagree with each other about "8,5", never mind with the web. So the
        // honest statement is not "the phone does not read this", it is "the
        // phone has no single reader to give it to", and handing an account's
        // answer to three rules that differ would make it mean three things.
        //
        // What that costs: an account that has CHOSEN a convention is followed
        // in the browser and not here, where the notification's number pad goes
        // on reading a dot as a decimal point whatever the account says. Under
        // `auto` — the default, and almost everybody — the phone would resolve
        // its own locale and there would be nothing to carry. Issue #157 is the
        // whole of it: unify the three readers, then choose between the device
        // tier and a real mirror.
        "numberFormat" to "three Kotlin readers that do not yet agree — see #157",
    )

    /**
     * The text of the `SETTINGS` object literal, and nothing else in the file.
     *
     * Scoped rather than scanned whole. The key pattern is "two spaces, a name,
     * a brace", which inside this literal means a setting and outside it means
     * any two-space-indented object — a `CHANNELS`-shaped map, an options
     * table, a nested literal in some later function — so a scan over the file
     * would invent settings and demand a mirror decision for each. The floor
     * below catches the opposite failure and could not catch this one.
     */
    private val settingsLiteral: String by lazy {
        val open = registry.indexOf("\nexport const SETTINGS = {")
        assertTrue("no `export const SETTINGS = {` in the registry", open >= 0)
        val close = registry.indexOf("\n};", open)
        assertTrue("`export const SETTINGS` is not closed by a `};` at column 0", close > open)
        registry.substring(open, close)
    }

    @Test
    fun `every registry key is mirrored or deliberately not`() {
        val keys = Regex("""\n {2}([a-zA-Z][a-zA-Z0-9]*): \{""")
            .findAll(settingsLiteral)
            .map { it.groupValues[1] }
            .toList()

        // A registry that suddenly parses as nothing would pass every assertion
        // below it, so the count is checked before the contents.
        assertTrue(
            "found ${keys.size} keys in the registry — the shape it is read by " +
                "must have changed",
            keys.size >= 12,
        )

        // ...and the other direction: a name in either list that the registry no
        // longer has. Without this a setting could be REMOVED from the web and
        // its entry here would sit on, reading as a decision about something
        // that does not exist — and if the scan ever widened to match too much,
        // the lists would still be satisfied and only this would notice.
        for (listed in mirrored + notMirrored.keys) {
            assertTrue(
                "`$listed` is listed here but is not a key in SETTINGS. Either it " +
                    "was renamed or removed from shared/public/ui/settings.js, or " +
                    "this list has outlived it.",
                listed in keys,
            )
        }

        for (key in keys) {
            assertTrue(
                "`$key` is in SETTINGS and is neither mirrored in AppSettings nor " +
                    "listed in notMirrored with a reason. Decide which it is: a " +
                    "setting this client should honour needs a default here, and " +
                    "one it should not needs a line saying so.",
                key in mirrored || key in notMirrored,
            )
        }

        // And the other direction, so a key REMOVED from the registry does not
        // leave a mirror behind claiming to track something that is gone.
        for (key in mirrored + notMirrored.keys) {
            assertTrue("`$key` is listed here but is no longer in SETTINGS", key in keys)
        }
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

        // ...and that it is actually SENT. The constant alone passing was the
        // gap: deleting the whole `addInterceptor` block left the header
        // unspelled on every request and this test green, so the phone would
        // silently stop reporting and an account following its device would
        // quietly go back to the server's clock.
        //
        // Read from the source because the interceptor is built into a private
        // OkHttpClient at construction; standing an HTTP server up in a unit
        // test to observe one header is a lot of machinery for a line.
        assertTrue(
            "Api.kt declares DEVICE_ZONE_HEADER but no interceptor sends it",
            Regex("""addInterceptor[\s\S]{0,900}?DEVICE_ZONE_HEADER""").containsMatchIn(kotlin),
        )
        assertTrue(
            "the interceptor should read the phone's own zone",
            Regex("""TimeZone\.getDefault\(\)\.id""").containsMatchIn(kotlin),
        )
    }
}
