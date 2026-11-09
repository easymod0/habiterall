package com.habiterall.app

import android.app.AlarmManager
import android.app.Application
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import com.habiterall.app.data.Api
import com.habiterall.app.data.DayEnd
import com.habiterall.app.widget.HabitWidget
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.SimpleTimeZone
import java.util.TimeZone

/**
 * The holder of where the account's day ends, and the header that reports it.
 *
 * `ReminderTimeTest` pins the RULE on the web's own examples; this is what
 * holds the answer, and what says it to the server. A plain `Application`, not
 * `HabiterallApp`, like every suite here — so `DayEnd.load` never ran at
 * startup, and each test starts by calling it on a clean preferences file.
 * `DayEnd` is an `object` and Robolectric keeps one sandbox per SDK across test
 * classes, so what an earlier test adopted would otherwise still be in force.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class DayEndTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()

    private val berlin = ZoneId.of("Europe/Berlin")

    private fun at(instant: String) = Clock.fixed(Instant.parse(instant), berlin)

    private fun prefs() = app.getSharedPreferences("habiterall_day", Context.MODE_PRIVATE)

    @Before
    fun startAtMidnight() {
        DayEnd.load(app)
    }

    @After
    fun putTheClockBack() {
        DayEnd.reset(app)
    }

    @Test
    fun `reset leaves a phone that has never been told`() {
        runBlocking { DayEnd.adopt(app, "03:00") }
        DayEnd.clock = Clock.fixed(Instant.EPOCH, ZoneId.of("UTC"))
        DayEnd.reset(app)
        assertEquals("00:00", DayEnd.current)
        assertNull(DayEnd.clock)
        DayEnd.load(app)
        assertEquals("the file went too, or a later load brings 03:00 back", "00:00", DayEnd.current)
    }

    @Test
    fun `at 00-30 with a 03-00 boundary it is still yesterday`() = runBlocking<Unit> {
        // 2026-08-13T00:30 in Berlin (UTC+2) is 2026-08-12T22:30Z.
        DayEnd.clock = at("2026-08-12T22:30:00Z")
        assertEquals("2026-08-13", DayEnd.today())

        DayEnd.adopt(app, "03:00")
        assertEquals("2026-08-12", DayEnd.today())
    }

    @Test
    fun `the boundary minute itself is today, and the one before is not`() = runBlocking<Unit> {
        DayEnd.adopt(app, "03:00")
        DayEnd.clock = at("2026-08-13T00:59:00Z") // 02:59 in Berlin
        assertEquals("2026-08-12", DayEnd.today())
        DayEnd.clock = at("2026-08-13T01:00:00Z") // 03:00
        assertEquals("2026-08-13", DayEnd.today())
    }

    @Test
    fun `the wall clock is what is compared, across a spring-forward night`() = runBlocking<Unit> {
        // Europe/Berlin, 2027-03-28: the clock goes 01:59 to 03:00. An hour is
        // missing from the night, and "03:00 minus an instant" would be off by
        // it. At 03:00 wall-clock the day has ended, however many hours that is
        // after midnight; at 01:30 it has not.
        DayEnd.adopt(app, "03:00")
        DayEnd.clock = at("2027-03-28T00:30:00Z") // 01:30 CET
        assertEquals("2027-03-27", DayEnd.today())
        DayEnd.clock = at("2027-03-28T01:00:00Z") // 03:00 CEST
        assertEquals("2027-03-28", DayEnd.today())
    }

    @Test
    fun `load reads what adopt wrote`() = runBlocking<Unit> {
        assertTrue(DayEnd.adopt(app, "03:00"))
        // What adopt stored, under the literal file and key `load` reads...
        assertEquals("03:00", prefs().getString("dayEndsAt", null))
        // ...and `load` takes whatever is there, so a changed value shows that
        // it reads that file rather than only echoing what is already held.
        prefs().edit().putString("dayEndsAt", "05:00").commit()
        DayEnd.load(app)
        assertEquals("05:00", DayEnd.current)
    }

    @Test
    fun `a junk stored value reads as midnight`() = runBlocking<Unit> {
        for (junk in listOf("07:00", "3:00", "03:30", "junk", "")) {
            DayEnd.adopt(app, "03:00")
            prefs().edit().putString("dayEndsAt", junk).commit()
            DayEnd.load(app)
            assertEquals("`$junk` moved the day", "00:00", DayEnd.current)
        }
        // And a file with nothing in it.
        DayEnd.adopt(app, "03:00")
        prefs().edit().clear().commit()
        DayEnd.load(app)
        assertEquals("00:00", DayEnd.current)
    }

    @Test
    fun `adopt says whether anything changed`() = runBlocking<Unit> {
        assertFalse("midnight to midnight", DayEnd.adopt(app, "00:00"))
        assertTrue(DayEnd.adopt(app, "03:00"))
        assertFalse("the same value again", DayEnd.adopt(app, "03:00"))
        // Junk normalises to midnight, which IS a change from 03:00.
        assertTrue(DayEnd.adopt(app, "junk"))
        assertEquals("00:00", DayEnd.current)
        assertFalse("junk over midnight changes nothing", DayEnd.adopt(app, "junk"))
    }

    @Test
    fun `now follows the phone changing zone while the process lives`() {
        val saved = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("Europe/Berlin"))
            assertEquals(ZoneId.of("Europe/Berlin"), DayEnd.now().zone)
            // A flight. Nothing restarts; `TIMEZONE_CHANGED` redraws and the
            // process goes on, so a zone captured when `DayEnd` was first
            // touched would still be Berlin here.
            TimeZone.setDefault(TimeZone.getTimeZone("America/Toronto"))
            assertEquals(ZoneId.of("America/Toronto"), DayEnd.now().zone)
        } finally {
            TimeZone.setDefault(saved)
        }
    }

    /* ---------- what a change of boundary redraws ---------- */

    private val alarmManager get() = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    private fun alarmAt(): ZonedDateTime? =
        shadowOf(alarmManager).scheduledAlarms.singleOrNull()?.let {
            Instant.ofEpochMilli(it.triggerAtTime).atZone(berlin)
        }

    @Test
    fun `a changed boundary re-aims the day alarm and an unchanged one does not`() =
        runBlocking<Unit> {
            // 2026-08-13T00:30 in Berlin. A live widget is what makes the alarm
            // exist at all (`armMidnight` cancels it when nothing is placed).
            DayEnd.clock = at("2026-08-12T22:30:00Z")
            shadowOf(AppWidgetManager.getInstance(app))
                .bindAppWidgetId(77, ComponentName(app, HabitWidget::class.java))
            HabitWidget.armMidnight(app)
            assertEquals(
                "armed for the next midnight under the default",
                ZonedDateTime.of(2026, 8, 14, 0, 0, 0, 0, berlin),
                alarmAt(),
            )

            assertTrue(DayEnd.adopt(app, "03:00"))
            assertEquals(
                "re-aimed at today's 03:00 by the adopt itself",
                ZonedDateTime.of(2026, 8, 13, 3, 0, 0, 0, berlin),
                alarmAt(),
            )

            // A day later, so that a redraw WOULD move the alarm: it would be
            // re-aimed at 14 August 03:00, and an adopt that did nothing leaves
            // it where it was.
            DayEnd.clock = at("2026-08-13T22:30:00Z")
            assertFalse(DayEnd.adopt(app, "03:00"))
            assertEquals(
                "an unchanged value redraws nothing",
                ZonedDateTime.of(2026, 8, 13, 3, 0, 0, 0, berlin),
                alarmAt(),
            )
        }

    /* ---------- no other reader of the calendar ---------- */

    /**
     * Every "what day is it" goes through [DayEnd], and nothing else asks the
     * clock.
     *
     * A source guard, which cannot see a renamed binding or an inverted
     * comparison — it is here for the thing it does see, a new `LocalDate.now()`
     * in a file nobody connected to the setting. The behavioural suites pin the
     * sites that exist; this is the one that finds the next. And it proves it
     * SAW the tree: the sites it counts are asserted as a floor, so a guard
     * pointed at the wrong directory fails instead of reading clean.
     */
    @Test
    fun `no main source reads the calendar's day except DayEnd`() {
        val root = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "android-native/app/src/main/java") }
            .firstOrNull { it.isDirectory }
            ?: throw AssertionError("android-native/app/src/main/java not found above ${File("").absolutePath}")

        val banned = Regex("""\b(LocalDate|LocalTime|ZonedDateTime|LocalDateTime|OffsetDateTime)\.now\(""")
        val files = root.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        val offenders = mutableListOf<String>()
        var sites = 0
        for (file in files) {
            val isHolder = file.invariantSeparatorsPath.endsWith("/data/DayEnd.kt")
            file.readLines().forEachIndexed { i, line ->
                val code = line.trim()
                if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return@forEachIndexed
                if (!isHolder && banned.containsMatchIn(code)) {
                    offenders += "${file.name}:${i + 1}: $code"
                }
                sites += Regex("""DayEnd\.today\(""").findAll(code).count()
            }
        }

        // The inventory: Kotlin files seen, and the `DayEnd.today(` call sites in
        // them — 13 today, in code and not in a comment. Asserted as a floor of
        // exactly that, so a reader removed is noticed here and a guard walking
        // the wrong tree cannot read clean on an empty list.
        assertTrue("saw only ${files.size} .kt files — wrong directory?", files.size >= 30)
        assertTrue("saw only $sites `DayEnd.today(` call sites, expected 13", sites >= 13)
        assertEquals(
            "these read the calendar's own day, and an account whose day ends " +
                "after midnight is on a different one — use DayEnd.today() / DayEnd.now():",
            emptyList<String>(),
            offenders,
        )
    }

    /* ---------- the header ---------- */

    private fun requestHeaders(setup: () -> Unit = {}): okhttp3.Headers = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        server.start()
        try {
            setup()
            Api(server.url("/").toString()).settings()
            server.takeRequest().headers
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `every request says where the day ends, midnight included`() {
        assertEquals("00:00", requestHeaders().get("X-Habiterall-Day-End"))
        runBlocking { DayEnd.adopt(app, "03:00") }
        assertEquals("03:00", requestHeaders().get("X-Habiterall-Day-End"))
    }

    @Test
    fun `a blank zone still sends the day-end header, and no zone header`() {
        val saved = TimeZone.getDefault()
        try {
            runBlocking { DayEnd.adopt(app, "03:00") }
            val headers = requestHeaders {
                // `TimeZone.getDefault().id` is "" — the case the zone header
                // is skipped for, and which used to return the bare request.
                TimeZone.setDefault(SimpleTimeZone(0, ""))
                assertEquals("", TimeZone.getDefault().id)
            }
            assertEquals("03:00", headers.get("X-Habiterall-Day-End"))
            assertNull(headers.get("X-Habiterall-Timezone"))
        } finally {
            TimeZone.setDefault(saved)
        }
    }

    @Test
    fun `the zone header is still sent beside it`() {
        val saved = TimeZone.getDefault()
        try {
            val headers = requestHeaders { TimeZone.setDefault(TimeZone.getTimeZone("Europe/Berlin")) }
            assertEquals("Europe/Berlin", headers.get("X-Habiterall-Timezone"))
            assertEquals("00:00", headers.get("X-Habiterall-Day-End"))
        } finally {
            TimeZone.setDefault(saved)
        }
    }
}
