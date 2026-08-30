package com.habiterall.app

import com.habiterall.app.data.AppSettings
import com.habiterall.app.data.Entry
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Sentinels
import com.habiterall.app.notify.Reminders
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    /* ---------- ask me later ---------- */

    private fun snoozeGap(now: ZonedDateTime, date: String): Long? =
        Reminders.snoozeUntil(now, date)?.let {
            it.toInstant().toEpochMilli() - now.toInstant().toEpochMilli()
        }

    @Test
    fun `a snooze fires an hour later on the same day`() {
        val now = at(2026, 3, 10, 8, 0)
        assertEquals(at(2026, 3, 10, 9, 0), Reminders.snoozeUntil(now, "2026-03-10"))
    }

    @Test
    fun `a snooze that would land after local midnight is refused`() {
        // Never re-dated onto tomorrow: the notification names a date, and one
        // posted at 00:30 would ask about a day the user has not lived while
        // the day it was about goes unasked. `dueReminders` drops a straddling
        // reminder for the same reason.
        assertNull(Reminders.snoozeUntil(at(2026, 3, 10, 23, 30), "2026-03-10"))
        // Exactly midnight is already tomorrow, which is the boundary every
        // "is it still today?" test gets wrong in the same direction.
        assertNull(Reminders.snoozeUntil(at(2026, 3, 10, 23, 0), "2026-03-10"))
        // One minute of room is still room.
        assertEquals(
            at(2026, 3, 10, 23, 59),
            Reminders.snoozeUntil(at(2026, 3, 10, 22, 59), "2026-03-10"),
        )
    }

    @Test
    fun `a snooze pressed after midnight on yesterday's reminder is refused`() {
        // The case the rule is named after, and the one asking about the day of
        // the PRESS gets wrong. A notification is not removed by pressing an
        // action and has no timeout, so the 16th's reminder is still in the
        // shade at 00:30 on the 17th. An hour fits inside the 17th — which is
        // why the press-only question armed one — and the re-post reads
        // `LocalDate.now()`, so it would have asked about the 17th while the
        // 16th left the shade unanswered.
        assertNull(Reminders.snoozeUntil(at(2026, 8, 17, 0, 30), "2026-08-16"))
        // Hours later on the wrong day is the same answer, not a nearer miss.
        assertNull(Reminders.snoozeUntil(at(2026, 8, 17, 9, 0), "2026-08-16"))
        // And the same day is unaffected: this is one question, not two guards.
        assertEquals(
            at(2026, 8, 17, 10, 0),
            Reminders.snoozeUntil(at(2026, 8, 17, 9, 0), "2026-08-17"),
        )
    }

    @Test
    fun `a delivery that names a day may only be posted on that day`() {
        // The other half, because arming is not the last chance to be wrong: an
        // inexact alarm — API 31-32 with "Alarms & reminders" revoked, since
        // USE_EXACT_ALARM covers 33+ unconditionally — armed at 22:52 for 23:52
        // can arrive at 00:03 with nobody having pressed anything late. The
        // rule below is version-independent and so is this assertion; what
        // changed with the manifest is only how often the loose case is hit.
        assertTrue(Reminders.stillAboutToday("2026-08-16", "2026-08-16"))
        assertFalse(Reminders.stillAboutToday("2026-08-16", "2026-08-17"))
        // The DAILY alarm names no day and means whichever one it arrives on,
        // so a check that refused a null would silence every reminder.
        assertTrue(Reminders.stillAboutToday(null, "2026-08-16"))
    }

    @Test
    fun `a snooze is an hour of real time, not an hour of wall clock`() {
        // The opposite of `nextOccurrence`, which is a wall-clock promise —
        // 08:30 must stay 08:30 across a clock change. "Ask me again in an
        // hour" is a duration, so on the night the clocks go back it is ONE
        // hour later and not two, and on the night they go forward it is one
        // hour and not none.
        //
        // Toronto falls back on 2026-11-01: 01:30 EDT plus an hour is 01:30
        // EST, the same local time and the same date, so the snooze stands.
        assertEquals(3_600_000L, snoozeGap(at(2026, 11, 1, 1, 30), "2026-11-01"))
        assertEquals(
            1,
            Reminders.snoozeUntil(at(2026, 11, 1, 1, 30), "2026-11-01")!!.dayOfMonth,
        )

        // And springs forward on 2026-03-08: 01:30 plus an hour is 03:30,
        // because 02:30 does not exist that day.
        assertEquals(3_600_000L, snoozeGap(at(2026, 3, 8, 1, 30), "2026-03-08"))
        assertEquals(3, Reminders.snoozeUntil(at(2026, 3, 8, 1, 30), "2026-03-08")!!.hour)
    }

    @Test
    fun `a snooze late on a day the clocks change is still judged by the date`() {
        // The refusal asks whether the target lands on the reminder's own DATE,
        // which is the only form of the question that survives a day being 23
        // or 25 hours long — and the only one that holds where the transition
        // is at midnight itself, as it is in America/Santiago, where "before
        // 24:00" is not even a time that exists.
        assertNull(Reminders.snoozeUntil(at(2026, 3, 8, 23, 30), "2026-03-08"))
        assertNull(Reminders.snoozeUntil(at(2026, 11, 1, 23, 30), "2026-11-01"))

        val santiago = ZoneId.of("America/Santiago")
        // 2026-09-06 has no 00:00 in Santiago: the clocks go straight to 01:00.
        val eve = ZonedDateTime.of(2026, 9, 5, 23, 30, 0, 0, santiago)
        assertNull(Reminders.snoozeUntil(eve, "2026-09-05"))
    }

    /* ---------- the plumbing, which unit tests cannot reach through Android ---------- */

    @Test
    fun `a habit's two alarms are two alarms`() {
        // A PendingIntent's identity is `filterEquals`, which ignores extras —
        // so this string is the whole of the difference. Point both at the
        // daily uri and `setExactAndAllowWhileIdle` REPLACES: "in an hour"
        // becomes the habit's new daily time, tomorrow's reminder never fires,
        // and nothing in the app looks wrong until the next morning.
        val daily = Reminders.alarmUri(1, snoozed = false)
        val snooze = Reminders.alarmUri(1, snoozed = true)
        assertTrue("the two alarms must not share a uri", daily != snooze)
        // And one habit's alarms are not another's.
        assertTrue(daily != Reminders.alarmUri(2, snoozed = false))
        assertTrue(snooze != Reminders.alarmUri(2, snoozed = true))
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
