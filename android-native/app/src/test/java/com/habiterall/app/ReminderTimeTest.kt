package com.habiterall.app

import com.habiterall.app.notify.ReminderTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The same cases as `shared/test/time.test.js`, deliberately.
 *
 * Both clients write the same `reminder_time` field on the same habit, so a
 * time typed here has to mean what the browser would have meant by it. Two
 * parsers with one contract only stay honest if both are pinned to the same
 * examples.
 */
class ReminderTimeTest {

    @Test
    fun `a canonical time is returned unchanged`() {
        for (value in listOf("00:00", "08:30", "13:45", "23:59")) {
            assertEquals(value, ReminderTime.parse(value))
        }
    }

    @Test
    fun `the separator can be anything reasonable`() {
        for (typed in listOf("8:30", "08:30", "8.30", "8h30", "8 30", "830")) {
            assertEquals("failed on $typed", "08:30", ReminderTime.parse(typed))
        }
    }

    @Test
    fun `a bare hour means the top of it`() {
        assertEquals("08:00", ReminderTime.parse("8"))
        assertEquals("08:00", ReminderTime.parse("08"))
        assertEquals("23:00", ReminderTime.parse("23"))
        assertEquals("00:00", ReminderTime.parse("0"))
    }

    @Test
    fun `four digits are read as HHMM`() {
        assertEquals("20:30", ReminderTime.parse("2030"))
        assertEquals("07:15", ReminderTime.parse("0715"))
        assertEquals("08:30", ReminderTime.parse("830"))
    }

    @Test
    fun `am and pm are understood however they are written`() {
        for (typed in listOf("8:30 pm", "8:30pm", "8:30 PM", "8:30 p.m.", "830 pm")) {
            assertEquals("failed on $typed", "20:30", ReminderTime.parse(typed))
        }
        assertEquals("07:00", ReminderTime.parse("7 am"))
        assertEquals("23:45", ReminderTime.parse("11:45 pm"))
    }

    @Test
    fun `the two times that are always off by twelve`() {
        assertEquals("00:00", ReminderTime.parse("12 am"))
        assertEquals("00:30", ReminderTime.parse("12:30 am"))
        assertEquals("12:00", ReminderTime.parse("12 pm"))
        assertEquals("12:30", ReminderTime.parse("12:30 pm"))
    }

    @Test
    fun `blank means no reminder, which is not the same as invalid`() {
        // The dialog does different things with these: one removes the
        // reminder, the other is a mistake worth showing.
        assertEquals("", ReminderTime.parse(""))
        assertEquals("", ReminderTime.parse("   "))
        assertEquals("", ReminderTime.parse(null))
        assertNull(ReminderTime.parse("lunchtime"))
    }

    @Test
    fun `nonsense is rejected rather than coerced`() {
        val bad = listOf(
            "25:00", "24:00", "8:60", "99", "12:345", "-1:00", "1:2:3",
            "8 xm", "8:30 zm", "pm", ":30", "8:", "013000",
            "13 pm",   // a 24-hour hour with a meridiem is a contradiction
            "0 am",    // there is no 0 o'clock in 12-hour time
        )
        for (value in bad) {
            assertNull("accepted \"$value\"", ReminderTime.parse(value))
        }
    }

    @Test
    fun `everything it returns is a time the server will accept`() {
        val serverRule = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")
        val inputs = listOf(
            "8", "8:3", "830", "2030", "12 am", "12 pm", "11:45 pm", "7am", "0",
            "23:59", "00:00", "9.05", "1 30 pm",
        )
        for (value in inputs) {
            val parsed = ReminderTime.parse(value)
            assertTrue("$value should parse", parsed != null)
            assertTrue(
                "$value produced $parsed, which the server rejects",
                serverRule.matches(parsed!!),
            )
        }
    }

    @Test
    fun `there is one option per hour, labelled both ways`() {
        val hours = ReminderTime.hours()
        assertEquals(24, hours.size)
        assertEquals("00", hours.first().first)
        assertEquals("23", hours.last().first)
        assertTrue(hours[13].second.contains("(1 pm)"))
        assertTrue(hours[0].second.contains("(12 am)"))
        assertTrue(hours[12].second.contains("(12 pm)"))
    }

    @Test
    fun `minutes step through the hour`() {
        val minutes = ReminderTime.minutes()
        assertEquals(60 / ReminderTime.MINUTE_STEP, minutes.size)
        assertEquals("00", minutes.first())
    }

    @Test
    fun `a typed odd minute stays selectable`() {
        val minutes = ReminderTime.minutes(37)
        assertEquals(60 / ReminderTime.MINUTE_STEP + 1, minutes.size)
        assertTrue(minutes.contains("37"))
        assertEquals(minutes.sorted(), minutes)
        // Already a step: not duplicated.
        assertEquals(60 / ReminderTime.MINUTE_STEP, ReminderTime.minutes(30).size)
    }

    @Test
    fun `helpers agree with the stored form`() {
        assertTrue(ReminderTime.isCanonical(""))
        assertTrue(ReminderTime.isCanonical("08:30"))
        assertFalse(ReminderTime.isCanonical("8:30"))
        assertFalse(ReminderTime.isCanonical("24:00"))

        assertEquals("08" to "30", ReminderTime.split("08:30"))
        assertNull(ReminderTime.split(""))

        assertEquals("08:30 (8:30 am)", ReminderTime.describe("08:30"))
        assertEquals("20:05 (8:05 pm)", ReminderTime.describe("20:05"))
        assertEquals("00:00 (12:00 am)", ReminderTime.describe("00:00"))
        assertEquals("12:00 (12:00 pm)", ReminderTime.describe("12:00"))
        assertEquals("", ReminderTime.describe(""))
    }

    @Test
    fun `the shortcuts are all real times`() {
        for (value in ReminderTime.COMMON) {
            assertTrue(ReminderTime.isCanonical(value))
            assertEquals(value, ReminderTime.parse(value))
        }
    }

    /* ---------- which weekdays a reminder fires on ---------- */

    /*
     * The same fixtures as `shared/test/time.test.js`, down to the dates, and
     * for the same reason as everything above: one habit's `reminder_days` is
     * read by both clients, so a mask read the other way round here fires a
     * Monday-only reminder on Sunday with nothing on any screen saying so.
     *
     * Every number below is a LITERAL and, wherever it can be, neither 127 nor
     * 0 — those two are the fixed points of the rotation into Loop's own
     * Saturday-based mask, and a suite written entirely in them passes against
     * a mask read backwards. That is exactly how Loop's bit order went
     * unverified for as long as it did.
     *
     *   Mon-Fri  = 62   (bits 1..5)
     *   Sat only = 64   (bit 6)
     *   Sun only = 1    (bit 0)
     *
     * The dates are a real, consecutive week: 2026-09-13 is a Sunday and
     * 2026-09-19 is the Saturday after it.
     */
    private val sunday = "2026-09-13"
    private val monday = "2026-09-14"
    private val friday = "2026-09-18"
    private val saturday = "2026-09-19"

    @Test
    fun `the default is every day, written as the literal 127`() {
        // Asserted as a number rather than against the constant: a test that
        // imports the value it checks pins the name and nothing else, and this
        // default is what every habit created before the field existed means.
        assertEquals(127, ReminderTime.parseReminderDays(null))
        assertEquals(127, ReminderTime.ALL_DAYS)
    }

    @Test
    fun `a mask of 0 is legal and is never repaired to every day`() {
        // The bug #78 refused to ship: a Loop reminder mask of 0 became a daily
        // reminder. 0 means the habit reminds on no day, and the alarm is
        // simply never armed.
        assertEquals(0, ReminderTime.parseReminderDays(0))
        for (date in listOf(sunday, monday, friday, saturday)) {
            assertFalse("0 must fire on no day, failed on $date", ReminderTime.remindsOn(0, date))
        }
    }

    @Test
    fun `a real mask is kept exactly`() {
        assertEquals(62, ReminderTime.parseReminderDays(62))
        assertEquals(64, ReminderTime.parseReminderDays(64))
        assertEquals(1, ReminderTime.parseReminderDays(1))
        assertEquals(127, ReminderTime.parseReminderDays(127))
    }

    @Test
    fun `anything that is not a mask lands on every day`() {
        // The junk the JS side has to refuse — a string, a float — cannot be
        // spelled here, so what is left is the range and the null: an older
        // server's response, and a cache line written before the field existed.
        for (junk in listOf(null, -1, 128, Int.MIN_VALUE, Int.MAX_VALUE)) {
            assertEquals("failed on $junk", 127, ReminderTime.parseReminderDays(junk))
        }
    }

    @Test
    fun `bit 0 is Sunday and bit 6 is Saturday, both ends asserted`() {
        assertEquals(0, ReminderTime.weekdayOf(sunday))
        assertEquals(1, ReminderTime.weekdayOf(monday))
        assertEquals(5, ReminderTime.weekdayOf(friday))
        assertEquals(6, ReminderTime.weekdayOf(saturday))
    }

    @Test
    fun `weekdayOf reads the string and never a clock`() {
        // The caller has already decided whose day this is. Nothing here may
        // consult the phone's clock, so the answer is the same in any zone.
        assertEquals(4, ReminderTime.weekdayOf("2026-01-01"))
        assertEquals(4, ReminderTime.weekdayOf("2026-12-31"))
        assertNull(ReminderTime.weekdayOf(""))
        assertNull("the padding is not cosmetic", ReminderTime.weekdayOf("2026-9-13"))
        assertNull(ReminderTime.weekdayOf(null))
    }

    @Test
    fun `a two-digit year is that year, not nineteen hundred and something`() {
        // The JS side's own trap, asserted here to the same two answers: the
        // year 99 opens on a Thursday while 1999 opens on a Friday, so these
        // two literals are what say the two implementations agree about a date
        // an import can genuinely carry.
        assertEquals(4, ReminderTime.weekdayOf("0099-01-01"))
        assertEquals(0, ReminderTime.weekdayOf("0001-03-04"))
    }

    @Test
    fun `Mon-Fri is 62, and it is off at both weekend ends`() {
        assertTrue(ReminderTime.remindsOn(62, monday))
        assertTrue(ReminderTime.remindsOn(62, friday))
        assertFalse(ReminderTime.remindsOn(62, sunday))
        assertFalse(ReminderTime.remindsOn(62, saturday))
    }

    @Test
    fun `Saturday only is 64 and Sunday only is 1, not the other way round`() {
        // The one pair that catches a mask read against Loop's own
        // Saturday-based bit order, where these two numbers are 1 and 2.
        assertTrue(ReminderTime.remindsOn(64, saturday))
        assertFalse(ReminderTime.remindsOn(64, sunday))
        assertTrue(ReminderTime.remindsOn(1, sunday))
        assertFalse(ReminderTime.remindsOn(1, saturday))
    }

    @Test
    fun `every day fires on every day of a real week`() {
        val week = listOf(
            sunday, monday, "2026-09-15", "2026-09-16", "2026-09-17", friday, saturday,
        )
        for (date in week) {
            assertTrue("failed on $date", ReminderTime.remindsOn(127, date))
        }
        // And a null mask — an older server, a pre-upgrade cache line — is the
        // same answer, because it is the same default.
        for (date in week) {
            assertTrue("failed on $date", ReminderTime.remindsOn(null, date))
        }
    }

    @Test
    fun `an unreadable date is on no mask`() {
        assertFalse(ReminderTime.remindsOn(127, "not-a-date"))
        assertFalse(ReminderTime.remindsOn(127, ""))
        assertFalse(ReminderTime.remindsOn(127, null))
    }
}
