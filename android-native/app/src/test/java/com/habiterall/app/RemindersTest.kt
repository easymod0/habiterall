package com.habiterall.app

import com.habiterall.app.data.AppSettings
import com.habiterall.app.data.Entry
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Sentinels
import com.habiterall.app.notify.Reminders
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    fun `a time inside the spring-forward gap does not shift the following day`() {
        // 02:30 does not exist on 2026-03-08 in Toronto. java.time shifts it
        // to 03:30 that day, which is unavoidable — but the day AFTER must be
        // 02:30 again.
        //
        // The old implementation computed `now.with(time).plusDays(1)`, which
        // carried the shifted 03:30 forward, so the reminder fired an hour
        // late on the transition day AND the next one. The test that was
        // supposed to guard this asserted only `next > now`, which is true of
        // any future instant whatsoever — it could not fail for the bug it
        // was named after.
        val gapDay = at(2026, 3, 8, 0, 30)
        val onGapDay = ZonedDateTime.ofInstant(
            java.time.Instant.ofEpochMilli(Reminders.nextOccurrence(LocalTime.of(2, 30), gapDay)),
            toronto,
        )
        assertEquals(8, onGapDay.dayOfMonth)
        assertEquals(3, onGapDay.hour)   // pushed out of the missing hour

        // The day after the transition: back to the time the user asked for.
        val dayAfterGap = at(2026, 3, 8, 12, 0)
        val nextDay = ZonedDateTime.ofInstant(
            java.time.Instant.ofEpochMilli(
                Reminders.nextOccurrence(LocalTime.of(2, 30), dayAfterGap)
            ),
            toronto,
        )
        assertEquals(9, nextDay.dayOfMonth)
        assertEquals("the day after the gap must be 02:30, not 03:30", 2, nextDay.hour)
        assertEquals(30, nextDay.minute)
    }

    @Test
    fun `a reminder keeps its local time across a whole DST transition week`() {
        // The property that matters, stated directly: whatever the clocks do,
        // 08:30 means 08:30. Walk each day across both transitions.
        for ((start, days) in listOf(
            at(2026, 3, 5, 12, 0) to 6,    // spring forward on the 8th
            at(2026, 10, 30, 12, 0) to 6,  // fall back on Nov 1st
        )) {
            var cursor = start
            repeat(days) {
                val fired = ZonedDateTime.ofInstant(
                    java.time.Instant.ofEpochMilli(
                        Reminders.nextOccurrence(LocalTime.of(8, 30), cursor)
                    ),
                    toronto,
                )
                assertEquals("drifted on ${fired.toLocalDate()}", 8, fired.hour)
                assertEquals("drifted on ${fired.toLocalDate()}", 30, fired.minute)
                cursor = cursor.plusDays(1)
            }
        }
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

    /* ---------- this device as a notification destination ---------- */

    private fun habit(time: String = "08:30", archived: Boolean = false) =
        Habit(id = 1, name = "Meditate", reminderTime = time, archived = archived)

    @Test
    fun `an alarm is wanted only when this device is a destination`() {
        assertTrue(Reminders.wantsAlarm(habit(), androidEnabled = true))
        // Reminders may be going to a Discord channel instead. Nothing else can
        // stop the alarms: the server sends no push and knows nothing of them.
        assertFalse(Reminders.wantsAlarm(habit(), androidEnabled = false))
    }

    @Test
    fun `a habit with no reminder time or an archived one never holds an alarm`() {
        assertFalse(Reminders.wantsAlarm(habit(time = ""), androidEnabled = true))
        assertFalse(Reminders.wantsAlarm(habit(time = "nonsense"), androidEnabled = true))
        assertFalse(Reminders.wantsAlarm(habit(archived = true), androidEnabled = true))
    }

    @Test
    fun `an account that has never chosen destinations still gets its alarms`() {
        // Absent is not the same as empty: the server's default is on-device
        // only, so a fresh install must arm alarms rather than wait to be told.
        assertTrue(AppSettings(notifyChannels = null).androidRemindersEnabled)
        assertTrue(AppSettings().androidRemindersEnabled)
    }

    @Test
    fun `an explicit choice is honoured, including choosing nothing`() {
        assertTrue(AppSettings(listOf("android")).androidRemindersEnabled)
        assertTrue(AppSettings(listOf("discord", "android")).androidRemindersEnabled)
        assertFalse(AppSettings(listOf("discord")).androidRemindersEnabled)
        assertFalse(AppSettings(emptyList()).androidRemindersEnabled)
    }

    /* ---------- whether the day still needs asking about ---------- */

    private val today = "2026-08-14"

    private fun entry(value: Double, status: String = "", date: String = today) =
        Entry(date = date, value = value, status = status)

    private fun boolHabit() = Habit(id = 1, name = "Meditate")

    private fun countHabit(target: Double = 8.0, type: String = "at_least") =
        Habit(id = 1, name = "Water", type = "numerical", targetValue = target, targetType = type)

    @Test
    fun `a day with nothing recorded needs its reminder`() {
        assertTrue(Reminders.needsReminder(boolHabit(), emptyList(), today))
        // A row for another day is not a row for this one.
        assertTrue(Reminders.needsReminder(
            boolHabit(), listOf(entry(Sentinels.YES, date = "2026-08-13")), today))
    }

    @Test
    fun `a completion or a skip is an answer`() {
        assertFalse(Reminders.needsReminder(boolHabit(), listOf(entry(Sentinels.YES)), today))
        assertFalse(Reminders.needsReminder(boolHabit(), listOf(entry(0.0, "skip")), today))
        assertFalse(Reminders.needsReminder(countHabit(), listOf(entry(8.0)), today))
        // A skip carried as a bare 3, the way an imported Loop history has it.
        // Only for a yes/no habit: for a measurable one 3 is an amount.
        assertFalse(Reminders.needsReminder(boolHabit(), listOf(entry(Sentinels.SKIP)), today))
    }

    @Test
    fun `a miss still needs asking about, however it is recorded`() {
        // The three that a bare "is there a row for today?" silenced, while the
        // server went on asking about the same day. `answeredIds` in
        // shared/src/notify.js is the rule this mirrors.
        assertTrue(Reminders.needsReminder(countHabit(), listOf(entry(3.0)), today))
        assertTrue(Reminders.needsReminder(boolHabit(), listOf(entry(Sentinels.UNSET)), today))
        assertTrue(Reminders.needsReminder(countHabit(), listOf(entry(Sentinels.SKIP)), today))
    }

    @Test
    fun `an at-most habit is met by staying under its target`() {
        val smoking = countHabit(target = 2.0, type = "at_most")
        assertFalse(Reminders.needsReminder(smoking, listOf(entry(1.0)), today))
        assertTrue(Reminders.needsReminder(smoking, listOf(entry(5.0)), today))
    }
}
