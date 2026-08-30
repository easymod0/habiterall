package com.habiterall.app

import android.app.AlarmManager
import android.app.Application
import android.content.Context
import android.content.Intent
import com.habiterall.app.data.Habit
import com.habiterall.app.notify.Notifications
import com.habiterall.app.notify.ReminderReceiver
import com.habiterall.app.notify.Reminders
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlarmManager
import org.robolectric.shadows.ShadowLog
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * The wiring between a decision and its effect.
 *
 * Everything else in this package is a pure function with a test beside it, and
 * that was not enough twice over: a review broke four plumbing rules with every
 * test still passing, and after `alarmUri` and `reminderActions` were extracted
 * to fix that, two of the four could STILL be broken with impunity — because
 * `alarmUri` returning the right string does not prove the snooze intent uses
 * it, and a list in the right order does not prove the builder consumes it that
 * way. Both bugs live one line below the function that pins them.
 *
 * So this suite asserts the OUTPUTS: what AlarmManager was actually handed, and
 * what the Notification actually carries. Robolectric is here for that and for
 * nothing else — no rule is expressed in this file, only the question of
 * whether the rules reach the platform.
 *
 * `sdk = 34` rather than the app's 37: the shadows are what is being used, none
 * of this is version-sensitive, and pinning it keeps the suite off whatever the
 * newest android-all jar happens to be. A plain `Application` rather than
 * `HabiterallApp`, because that one enqueues WorkManager jobs on creation and
 * none of the code under test here goes anywhere near WorkManager.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ReminderWiringTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()

    /**
     * `Reminders` is an `object`, and Robolectric caches one sandbox per SDK
     * level ACROSS test classes in a JVM fork — so `lastArmWasExact` outlives
     * the test that set it, and "does the fallback log?" would otherwise depend
     * on which test in which class ran first. Cleared here so each test below
     * starts from "nothing armed yet in this process", which is the state a
     * cold start is in and the one the dedupe is specified against.
     */
    @Before
    fun forgetTheLastArm() {
        Reminders.lastArmWasExact = null
    }

    private val manager
        get() = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    private fun alarms() = shadowOf(manager).scheduledAlarms

    /** The `data` uri of a scheduled alarm's PendingIntent. */
    private fun uris(): List<String?> =
        alarms().map { shadowOf(it.operation).savedIntent?.data?.toString() }

    private fun habit(time: String = "08:00") =
        Habit(id = 42, name = "Meditate", reminderTime = time)

    private val today = "2026-08-16"
    private val noon = ZonedDateTime.of(2026, 8, 16, 12, 0, 0, 0, ZoneId.of("America/Toronto"))

    /* ---------- a snooze is a second alarm, in fact and not only in theory ---------- */

    @Test
    fun `a snooze does not replace the habit's daily alarm`() {
        // The bug this whole design exists to prevent, asserted where it would
        // happen. `filterEquals` ignores extras, so an intent built with the
        // DAILY uri collides with the daily alarm and
        // `setExactAndAllowWhileIdle` REPLACES it: the snooze fires an hour
        // later looking perfect and tomorrow's reminder never comes. Nothing in
        // the app looks wrong until the morning after.
        Reminders.schedule(app, habit(), androidEnabled = true)
        assertEquals(1, alarms().size)

        Reminders.snooze(app, 42, today, noon)
        assertEquals("a snooze must ADD an alarm, not re-point one", 2, alarms().size)
        assertTrue(Reminders.alarmUri(42, snoozed = false) in uris())
        assertTrue(Reminders.alarmUri(42, snoozed = true) in uris())
    }

    @Test
    fun `the snooze alarm is an hour out and carries the day it is about`() {
        Reminders.snooze(app, 42, today, noon)
        val alarm = alarms().single()
        assertEquals(
            noon.plusHours(1).toInstant().toEpochMilli(),
            alarm.triggerAtTime,
        )
        val intent = shadowOf(alarm.operation).savedIntent
        // Both extras, because the receiver reads one to decide whether to
        // re-arm tomorrow and the worker reads the other to decide whether the
        // day it was armed for is still today.
        assertTrue(intent.getBooleanExtra(Notifications.EXTRA_SNOOZED, false))
        assertEquals(today, intent.getStringExtra(Notifications.EXTRA_DATE))
        assertEquals(42L, intent.getLongExtra(Notifications.EXTRA_HABIT_ID, -1))
    }

    @Test
    fun `the daily alarm carries no day, because it means whichever one it arrives on`() {
        Reminders.schedule(app, habit(), androidEnabled = true)
        val intent = shadowOf(alarms().single().operation).savedIntent
        assertEquals(null, intent.getStringExtra(Notifications.EXTRA_DATE))
        assertFalse(intent.getBooleanExtra(Notifications.EXTRA_SNOOZED, false))
    }

    @Test
    fun `a refused snooze arms nothing at all`() {
        // 23:30 on the day the reminder is about: an hour does not fit inside
        // it. The daily alarm stays exactly as it was.
        Reminders.schedule(app, habit(), androidEnabled = true)
        val armed = Reminders.snooze(app, 42, today, noon.withHour(23).withMinute(30))
        assertFalse(armed)
        assertEquals(1, alarms().size)
        assertEquals(listOf(Reminders.alarmUri(42, snoozed = false)), uris())
    }

    @Test
    fun `a fetch re-arms the daily alarm and leaves a snooze alone`() {
        // `schedule` runs on every fetch. If the two shared an intent this
        // would silently eat the snooze the user just asked for.
        Reminders.snooze(app, 42, today, noon)
        Reminders.schedule(app, habit(), androidEnabled = true)
        assertEquals(2, alarms().size)
        assertTrue(Reminders.alarmUri(42, snoozed = true) in uris())
    }

    @Test
    fun `cancelling a habit drops both of its alarms`() {
        Reminders.schedule(app, habit(), androidEnabled = true)
        Reminders.snooze(app, 42, today, noon)
        assertEquals(2, alarms().size)

        Reminders.cancel(app, 42)
        assertEquals(0, alarms().size)
    }

    @Test
    fun `one habit's alarms are not another's`() {
        Reminders.schedule(app, habit(), androidEnabled = true)
        Reminders.snooze(app, 42, today, noon)
        Reminders.schedule(app, habit().copy(id = 43), androidEnabled = true)
        Reminders.snooze(app, 43, today, noon)
        assertEquals(4, alarms().size)

        Reminders.cancel(app, 42)
        assertEquals(2, alarms().size)
        assertTrue(Reminders.alarmUri(43, snoozed = false) in uris())
        assertTrue(Reminders.alarmUri(43, snoozed = true) in uris())
    }

    /* ---------- soft, not loud: an inexact arm still arms, and says so ---------- */

    /**
     * On 31-32 with "Alarms & reminders" revoked, `setAlarm` still arms — that
     * is decision 1, "soft, not loud", and it is written down HERE: refusing
     * (Loop's `SchedulerResult.IGNORED`) was rejected, so a future change
     * toward that shape has to fail this test. It also stops being silent: a
     * WARN reaches the tag this subsystem's logs share.
     */
    @Config(sdk = [32])
    @Test
    fun `an inexact arm still arms, and logs that it did`() {
        // Stated rather than inherited. The shadow's own default IS "revoked",
        // and that is the state a user who has not touched the toggle in this
        // range is in — but a Robolectric bump that flipped the default would
        // send this test down the EXACT branch, where the alarm count below is
        // still 1 and only the window assertion notices. A test about the
        // fallback must not be able to stop exercising the fallback quietly.
        ShadowAlarmManager.setCanScheduleExactAlarms(false)
        Reminders.schedule(app, habit(), androidEnabled = true)

        assertEquals("refusing here is the rejected design", 1, alarms().size)

        // WHAT ALARMMANAGER WAS HANDED, which is the half a count and a log
        // line cannot see: `setAndAllowWhileIdle` records `WINDOW_HEURISTIC`
        // (-1) and `setExactAndAllowWhileIdle` records `WINDOW_EXACT` (0), so
        // this is the only assertion here that can tell the two branches apart.
        // Both other assertions in this test are true whichever call was made.
        assertEquals(
            "the fallback must be the INEXACT call and not merely a logged one",
            ShadowAlarmManager.WINDOW_HEURISTIC,
            alarms().single().windowLengthMs,
        )

        val warnings = ShadowLog.getLogsForTag("habiterall.notify")
            .filter { it.type == android.util.Log.WARN }
        assertTrue(
            "expected a WARN naming the fallback",
            warnings.any { it.msg.contains("inexactly") },
        )
    }

    /**
     * The dedupe is a property of the WARN and not of the arming, so both
     * halves are asserted: a second arm in the same state adds no line, and the
     * alarm it was quiet about is armed exactly as the first one was.
     *
     * Without this, moving the `Log.w` back above the `stateChanged` gate — or
     * deleting the gate — is invisible, and the tag goes back to one line per
     * habit per fetch, which is what made it unreadable.
     */
    @Config(sdk = [32])
    @Test
    fun `the fallback warns once per state, not once per alarm`() {
        ShadowAlarmManager.setCanScheduleExactAlarms(false)
        Reminders.schedule(app, habit(), androidEnabled = true)
        Reminders.schedule(app, habit().copy(id = 43), androidEnabled = true)
        Reminders.schedule(app, habit().copy(id = 44), androidEnabled = true)

        val warnings = ShadowLog.getLogsForTag("habiterall.notify")
            .filter { it.type == android.util.Log.WARN }
        assertEquals(
            "three habits armed inexactly must be one line, not three: $warnings",
            1,
            warnings.size,
        )
        // And the two it said nothing about are still inexact alarms, so the
        // dedupe cannot be read as the fallback having stopped.
        assertEquals(3, alarms().size)
        assertTrue(
            "every arm must still be inexact, silent or not",
            alarms().all { it.windowLengthMs == ShadowAlarmManager.WINDOW_HEURISTIC },
        )
    }

    /**
     * The control for the two tests above: with the permission held, the alarm
     * is still scheduled — unsurprising — it is scheduled EXACTLY, and nothing
     * is logged for this tag. Without this, a `Log.w` fired unconditionally
     * (not just in the `else`) would pass them for the wrong reason.
     */
    @Config(sdk = [34])
    @Test
    fun `a granted permission arms exactly and logs nothing`() {
        ShadowAlarmManager.setCanScheduleExactAlarms(true)
        Reminders.schedule(app, habit(), androidEnabled = true)

        assertEquals(1, alarms().size)
        // The half this test is NAMED for, and it was missing. An alarm count
        // and an empty log are both equally true of `setAndAllowWhileIdle`, so
        // swapping the call inside `if (canBeExact)` — #233's own symptom, every
        // reminder on every phone inexact again — left this green.
        assertEquals(
            "the granted branch must make the EXACT call",
            ShadowAlarmManager.WINDOW_EXACT,
            alarms().single().windowLengthMs,
        )
        assertTrue(ShadowLog.getLogsForTag("habiterall.notify").isEmpty())
    }

    /* ---------- what a delivery does when it arrives ---------- */

    @Test
    fun `a snoozed delivery does not re-arm anything`() {
        // The third of the four rules a review once broke with impunity. A
        // snooze firing says nothing about the schedule — the daily alarm is a
        // separate PendingIntent and is still pending — so re-arming from here
        // would spend a network sync per press. Dropping the early return is
        // invisible everywhere else.
        WorkManagerTestInitHelper.initializeTestWorkManager(app)
        val work = WorkManager.getInstance(app)

        val snoozed = Intent(app, ReminderReceiver::class.java).apply {
            putExtra(Notifications.EXTRA_HABIT_ID, 42L)
            putExtra(Notifications.EXTRA_SNOOZED, true)
            putExtra(Notifications.EXTRA_DATE, today)
        }
        ReminderReceiver().onReceive(app, snoozed)

        // It posts — that is the whole job —
        assertTrue(work.getWorkInfosForUniqueWork("remind:42").get().isNotEmpty())
        // — and arranges nothing else.
        assertTrue(work.getWorkInfosForUniqueWork("schedule:42").get().isEmpty())
    }

    /* ---------- the shade shows the buttons in the order the list gives ---------- */

    private fun titles(
        habit: Habit,
        skipEnabled: Boolean,
        now: ZonedDateTime = noon,
    ): List<String> =
        Notifications.buildReminder(app, habit, today, skipEnabled, now)
            .actions.orEmpty().map { it.title.toString() }

    @Test
    fun `the notification's buttons are in the order reminderActions gives them`() {
        // `ReminderActionsTest` pins the list; this pins that the builder
        // consumes it in that order, which is the half that decides what a user
        // sees. Reversing the loop passes every other test in this repo and
        // costs the account that uses skip days its snooze — or, worse, an
        // answer.
        assertEquals(listOf("Yes", "No", "Skip", "In 1 hour"), titles(habit(), skipEnabled = true))
        assertEquals(listOf("Yes", "No", "In 1 hour"), titles(habit(), skipEnabled = false))
    }

    @Test
    fun `a measurable habit gets the number pad first, and keeps its snooze`() {
        val water = Habit(id = 7, name = "Water", type = "numerical", targetValue = 8.0)
        assertEquals(listOf("Enter count", "Skip", "In 1 hour"), titles(water, skipEnabled = true))
    }

    @Test
    fun `an avoided habit's buttons invert and its snooze is still last`() {
        val smoking = Habit(
            id = 8,
            name = "Smoking",
            type = "numerical",
            targetValue = 2.0,
            targetType = "at_most",
            showAs = "avoid",
        )
        assertEquals(listOf("Clean", "Slipped", "In 1 hour"), titles(smoking, skipEnabled = false))
    }

    @Test
    fun `no snooze button when there is no room left in the day for one`() {
        val lateOn = noon.withHour(23).withMinute(30)
        assertEquals(listOf("Yes", "No"), titles(habit(), skipEnabled = false, now = lateOn))
        // And none on a notification left over from a previous day, which is
        // the case the press-time check exists for.
        val tomorrow = noon.plusDays(1)
        assertEquals(listOf("Yes", "No"), titles(habit(), skipEnabled = false, now = tomorrow))
    }

    @Test
    fun `every button carries the day the notification is about`() {
        // The asymmetry that made the snooze bug a bug: the answers write to
        // the date they carry. If any of them read the clock instead, a
        // notification answered after midnight would record the wrong day.
        val notification = Notifications.buildReminder(app, habit(), today, true, noon)
        notification.actions.forEach { action ->
            val intent = shadowOf(action.actionIntent).savedIntent
            assertNotNull(intent)
            assertEquals(today, intent.getStringExtra(Notifications.EXTRA_DATE))
        }
    }
}
