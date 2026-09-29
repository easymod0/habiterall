package com.habiterall.app

import com.habiterall.app.data.AppSettings
import com.habiterall.app.data.Entry
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Sentinels
import com.habiterall.app.data.reminderCacheLine
import com.habiterall.app.data.reminderFromCacheLine
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

    /* ---------- and only on the weekdays the habit asks for ---------- */

    /*
     * The masks are the same literals the rest of this change is pinned with —
     * bit 0 Sunday … bit 6 Saturday, so 62 is Mon-Fri, 64 Saturday only and 1
     * Sunday only — and none of them is 127, which is the default AND fires on
     * every day, so a walk that ignored the mask entirely would pass.
     *
     * September 2026: the 13th is a Sunday and the 19th the Saturday after it.
     */
    private fun firesOn(millis: Long) =
        ZonedDateTime.ofInstant(java.time.Instant.ofEpochMilli(millis), toronto)

    @Test
    fun `a masked-out weekday is skipped and the next allowed one is armed`() {
        // Sunday morning, on a habit that reminds Mon-Fri: today is out, so the
        // alarm belongs on Monday — not on Sunday, which is what
        // `nextOccurrence` alone answers.
        val sundayMorning = at(2026, 9, 13, 6, 0)
        val fired = firesOn(
            Reminders.nextAllowedOccurrence(LocalTime.of(8, 30), 62, sundayMorning)!!
        )
        assertEquals(14, fired.dayOfMonth)
        assertEquals(8, fired.hour)
        assertEquals(30, fired.minute)
    }

    @Test
    fun `the walk crosses as many masked-out days as it has to`() {
        // Monday, Saturdays only: five days of skipping, which is what says the
        // search advances rather than checking tomorrow and giving up.
        val mondayMorning = at(2026, 9, 14, 6, 0)
        val fired = firesOn(
            Reminders.nextAllowedOccurrence(LocalTime.of(8, 30), 64, mondayMorning)!!
        )
        assertEquals(19, fired.dayOfMonth)
        assertEquals(8, fired.hour)

        // And the far edge of the bound: Saturday, after the time has passed,
        // on a Saturday-only habit is a whole week out. Seven candidate days
        // are needed for this one and no more are ever needed.
        val saturdayEvening = at(2026, 9, 19, 20, 0)
        val nextWeek = firesOn(
            Reminders.nextAllowedOccurrence(LocalTime.of(8, 30), 64, saturdayEvening)!!
        )
        assertEquals(26, nextWeek.dayOfMonth)
        assertEquals(8, nextWeek.hour)
    }

    @Test
    fun `a mask of 0 arms nothing rather than searching forever`() {
        // 0 is legal — it means the habit reminds on no day — so this must
        // terminate with an answer of "no alarm", on every day of the week.
        var cursor = at(2026, 9, 13, 6, 0)
        repeat(7) {
            assertNull(
                "a mask of 0 must arm nothing, failed on ${cursor.toLocalDate()}",
                Reminders.nextAllowedOccurrence(LocalTime.of(8, 30), 0, cursor),
            )
            cursor = cursor.plusDays(1)
        }
    }

    @Test
    fun `every day is exactly the schedule this client has always armed`() {
        // The degeneration case: with 127 the weekday walk must be the identity
        // over `nextOccurrence`, or this change moves every existing reminder.
        // Walked across a fortnight that contains a DST boundary, which is
        // where an implementation that added 24 hours' millis would part
        // company with one that takes a calendar day.
        var cursor = at(2026, 2, 28, 12, 0)
        repeat(14) {
            assertEquals(
                "127 must be the identity, failed at $cursor",
                Reminders.nextOccurrence(LocalTime.of(8, 30), cursor),
                Reminders.nextAllowedOccurrence(LocalTime.of(8, 30), 127, cursor),
            )
            cursor = cursor.plusDays(1)
        }
    }

    @Test
    fun `a weekday reminder keeps its local time across a DST boundary`() {
        // Toronto springs forward on 2026-03-08, a Sunday. A Mon-Fri habit
        // asked on the Friday before it must land on Monday the 9th at 08:30
        // LOCAL — the wall-clock promise `nextOccurrence` makes, which is the
        // whole reason the weekday filter is layered on top of that function
        // rather than folded into it.
        val fridayBefore = at(2026, 3, 6, 9, 0)
        val fired = firesOn(
            Reminders.nextAllowedOccurrence(LocalTime.of(8, 30), 62, fridayBefore)!!
        )
        assertEquals(9, fired.dayOfMonth)
        assertEquals(8, fired.hour)
        assertEquals(30, fired.minute)
    }

    @Test
    fun `an allowed weekday later today still fires today`() {
        // The ordinary case, stated so a walk that always advanced a day would
        // fail: Monday at 06:00 on a Mon-Fri habit is Monday at 08:30.
        val fired = firesOn(
            Reminders.nextAllowedOccurrence(LocalTime.of(8, 30), 62, at(2026, 9, 14, 6, 0))!!
        )
        assertEquals(14, fired.dayOfMonth)
    }

    /* ---------- the offline cache, which is what arms all of the above ---------- */

    @Test
    fun `the cached reminder line carries the weekday mask`() {
        val habit = Habit(
            id = 4,
            name = "Meditate",
            reminderTime = "08:30",
            reminderMessage = "Did you sit?",
            reminderDays = 62,
        )
        val line = reminderCacheLine(habit)

        assertEquals(62, reminderFromCacheLine(line)!!.reminderDays)
        // APPENDED, never inserted — the assertion a round trip through
        // DataStore could not make, because there the writer and the reader
        // move together and a field put in the middle passes just as happily.
        assertEquals("the mask must be the LAST field", "62", line.split('|').last())
        assertEquals(10, line.split('|').size)
    }

    @Test
    fun `a line written before the mask existed still arms, every day`() {
        // The case the append rule exists for: an upgraded phone reads a cache
        // its previous version wrote, possibly with no network to correct it.
        // Every field before the mask must still be read from its own position,
        // and the absent mask must mean every day — which is what that phone
        // was already arming yesterday.
        val nineFields = "4|08:30|Meditate|numerical|8.0|glasses|Did you sit?|avoid|at_most"
        val upgraded = reminderFromCacheLine(nineFields)!!
        assertEquals(127, upgraded.reminderDays)
        assertEquals("08:30", upgraded.reminderTime)
        assertEquals("avoid", upgraded.showAs)
        assertEquals("at_most", upgraded.targetType)
        assertEquals("glasses", upgraded.unit)

        // And the oldest shape this reader has ever tolerated, six fields, is
        // unaffected by the new one.
        val sixFields = "4|08:30|Meditate|boolean|0.0|"
        val ancient = reminderFromCacheLine(sixFields)!!
        assertEquals(127, ancient.reminderDays)
        assertEquals("08:30", ancient.reminderTime)

        // Junk in the mask's own position is not a reason to lose the alarm.
        assertEquals(127, reminderFromCacheLine("$nineFields|banana")!!.reminderDays)
        assertEquals(127, reminderFromCacheLine("$nineFields|999")!!.reminderDays)
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

    @Test
    fun `a day the mask does not name needs no reminder, however it stands`() {
        // The second guard, and the one `NotifyWorker` leans on when it has no
        // network: there it errs toward notifying by asking this with NO
        // entries, so the mask is the only thing left that can say no.
        //
        // 2026-08-14 is a Friday and 2026-08-15 the Saturday after it, so 62
        // (Mon-Fri) names the first and not the second.
        val friday = "2026-08-14"
        val saturday = "2026-08-15"
        val weekdaysOnly = Habit(id = 1, name = "Meditate", reminderDays = 62)

        assertTrue("Friday is on 62", Reminders.needsReminder(weekdaysOnly, emptyList(), friday))
        assertFalse(
            "Saturday is not on 62, so there is nothing to ask about",
            Reminders.needsReminder(weekdaysOnly, emptyList(), saturday),
        )
        // An unanswered day on a masked-out weekday is still not a reminder —
        // the gate is asked before anything about the entries is.
        assertFalse(
            "an unanswered Saturday is still not a Saturday reminder",
            Reminders.needsReminder(
                weekdaysOnly, listOf(entry(Sentinels.UNSET, date = saturday)), saturday
            ),
        )
        // And an alarm that arrives on a day the mask names is unaffected.
        assertTrue(
            "an unanswered Friday must still be asked about",
            Reminders.needsReminder(
                weekdaysOnly, listOf(entry(Sentinels.UNSET, date = friday)), friday
            ),
        )
        // A mask of 0 is never asked about at all.
        val never = Habit(id = 1, name = "Meditate", reminderDays = 0)
        assertFalse(
            "a mask of 0 names no day, so no day needs a reminder",
            Reminders.needsReminder(never, emptyList(), friday),
        )
    }
}
