package com.habiterall.app

import com.habiterall.app.notify.Reminders
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

class RemindersTest {

    private val toronto = ZoneId.of("America/Toronto")

    private fun at(y: Int, m: Int, d: Int, h: Int, min: Int) =
        ZonedDateTime.of(y, m, d, h, min, 0, 0, toronto)

    @Test
    fun `a time later today fires today`() {
        val now = at(2026, 3, 10, 6, 0)
        val next = Reminders.nextOccurrence(LocalTime.of(8, 30), now)
        assertEquals(at(2026, 3, 10, 8, 30).toInstant().toEpochMilli(), next)
    }

    @Test
    fun `a time already past fires tomorrow`() {
        val now = at(2026, 3, 10, 9, 0)
        val next = Reminders.nextOccurrence(LocalTime.of(8, 30), now)
        assertEquals(at(2026, 3, 11, 8, 30).toInstant().toEpochMilli(), next)
    }

    @Test
    fun `the exact current minute rolls to tomorrow`() {
        // Not "fire immediately": an alarm set for the instant it is scheduled
        // would re-fire the notification that just triggered the reschedule.
        val now = at(2026, 3, 10, 8, 30)
        val next = Reminders.nextOccurrence(LocalTime.of(8, 30), now)
        assertEquals(at(2026, 3, 11, 8, 30).toInstant().toEpochMilli(), next)
    }

    @Test
    fun `08 30 stays 08 30 local across a spring DST change`() {
        // Toronto springs forward on 2026-03-08. A reminder is a wall-clock
        // promise, so the gap between two firings is 23 hours here, not 24 —
        // computing in UTC millis instead would drift the time by an hour.
        val now = at(2026, 3, 7, 9, 0)
        val next = Reminders.nextOccurrence(LocalTime.of(8, 30), now)

        val fired = ZonedDateTime.ofInstant(java.time.Instant.ofEpochMilli(next), toronto)
        assertEquals(8, fired.hour)
        assertEquals(30, fired.minute)
        assertEquals(8, fired.dayOfMonth)
    }

    @Test
    fun `a time inside the spring-forward gap still resolves`() {
        // 02:30 does not exist on 2026-03-08 in Toronto. java.time shifts it
        // forward rather than throwing; the point is that scheduling must not
        // crash for a user who picked that minute.
        val now = at(2026, 3, 7, 9, 0)
        val next = Reminders.nextOccurrence(LocalTime.of(2, 30), now)
        assertTrue(next > now.toInstant().toEpochMilli())
    }

    @Test
    fun `08 30 stays 08 30 local across an autumn DST change`() {
        val now = at(2026, 11, 1, 9, 0)
        val next = Reminders.nextOccurrence(LocalTime.of(8, 30), now)

        val fired = ZonedDateTime.ofInstant(java.time.Instant.ofEpochMilli(next), toronto)
        assertEquals(8, fired.hour)
        assertEquals(30, fired.minute)
        assertEquals(2, fired.dayOfMonth)
    }

    @Test
    fun `midnight is handled`() {
        val now = at(2026, 3, 10, 23, 50)
        val next = Reminders.nextOccurrence(LocalTime.of(0, 0), now)
        assertEquals(at(2026, 3, 11, 0, 0).toInstant().toEpochMilli(), next)
    }
}
