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
}
