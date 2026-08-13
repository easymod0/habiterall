package com.habiterall.app.notify

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Settings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * Turns each habit's `reminder_time` into an Android alarm.
 *
 * Reminder times live on the server so they follow the account to a new phone,
 * but the alarms are local: a reminder must fire when the phone is offline or
 * the server is down, which rules out any form of push.
 */
object Reminders {

    private fun alarmManager(context: Context) =
        context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    private fun pendingIntent(context: Context, habitId: Long): PendingIntent {
        val intent = Intent(context, ReminderReceiver::class.java).apply {
            putExtra(Notifications.EXTRA_HABIT_ID, habitId)
            data = android.net.Uri.parse("habiterall://remind/$habitId")
        }
        return PendingIntent.getBroadcast(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /**
     * Next occurrence of [time] in the phone's own zone, in epoch millis.
     * Local time, not UTC: "remind me at 08:00" means eight in the morning
     * wherever you are, and must survive a flight and a DST boundary.
     */
    fun nextOccurrence(time: LocalTime, now: java.time.ZonedDateTime): Long {
        // Pick the DATE on the local calendar, then resolve to the zone once.
        //
        // `now.with(time).plusDays(1)` looks equivalent and is not: `with`
        // resolves against the zone straight away, so on a spring-forward day
        // a time inside the missing hour is pushed to 03:30 — and `plusDays`
        // then preserves that shifted local time, firing the NEXT day at 03:30
        // too. The reminder only righted itself on day three.
        val wanted = time.withSecond(0).withNano(0)
        var date = now.toLocalDate()

        // Resolve on the local date first; the zone decides what that instant
        // is. On a gap day java.time shifts forward (unavoidable and correct);
        // the point is that tomorrow is computed from the DATE, not from the
        // shifted result.
        var next = java.time.ZonedDateTime.of(date, wanted, now.zone)
        if (!next.isAfter(now)) {
            date = date.plusDays(1)
            next = java.time.ZonedDateTime.of(date, wanted, now.zone)
        }
        return next.toInstant().toEpochMilli()
    }

    private fun parseTime(value: String): LocalTime? =
        runCatching { LocalTime.parse(value) }.getOrNull()

    /**
     * Whether this habit should hold an alarm on this phone.
     *
     * [androidEnabled] is the account's `notifyChannels` setting: reminders can
     * be sent to a Discord channel by the server instead of, or as well as,
     * here. Switching this destination off has to stop the alarms — nothing
     * else can, since the server never sends push and does not know about them.
     */
    fun wantsAlarm(habit: Habit, androidEnabled: Boolean): Boolean =
        androidEnabled && !habit.archived && parseTime(habit.reminderTime) != null

    fun schedule(context: Context, habit: Habit, androidEnabled: Boolean) {
        // The null check is stated again here rather than left to `wantsAlarm`
        // so `time` smart-casts below; the two cannot disagree.
        val time = parseTime(habit.reminderTime)
        if (time == null || !wantsAlarm(habit, androidEnabled)) {
            cancel(context, habit.id)
            return
        }

        val at = nextOccurrence(time, java.time.ZonedDateTime.now(ZoneId.systemDefault()))
        val manager = alarmManager(context)
        val intent = pendingIntent(context, habit.id)

        // Exact alarms can be revoked by the user on API 31+. Falling back to
        // an inexact alarm keeps reminders working, just less punctually —
        // better than silently dropping them.
        val canBeExact = Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms()
        if (canBeExact) {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
        } else {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
        }
    }

    fun cancel(context: Context, habitId: Long) {
        alarmManager(context).cancel(pendingIntent(context, habitId))
    }

    /** Re-arms one habit's alarm after it fired. */
    fun rescheduleOne(context: Context, habitId: Long) {
        armFromCache(context, habitId)
        enqueueSync(context, habitId)
    }

    /**
     * Re-arms every habit's alarm — after a reboot, or a habit list change.
     *
     * `onDone` lets a BroadcastReceiver hold its process open via `goAsync`
     * until the cache has actually been read; without it the reschedule races
     * process death on exactly the occasion that matters most, a boot that
     * has just wiped every pending alarm.
     */
    fun rescheduleAll(context: Context, onDone: (() -> Unit)? = null) {
        armFromCache(context, null, onDone)
        enqueueSync(context, null)
    }

    /**
     * Arm alarms from the local cache, immediately and without any network.
     *
     * This is the path that actually keeps reminders working. `enqueueSync`
     * below only *refreshes* the cache; if it were the only path — as it was
     * — then a phone rebooted in airplane mode would arm nothing at all,
     * because its worker is constrained to `NetworkType.CONNECTED` and simply
     * waits. Reminders would stay silently dead until connectivity returned,
     * which is the one failure this app cannot have.
     *
     * Runs on the IO dispatcher against DataStore; callers are receivers with
     * a short window, so it must not block them.
     */
    private fun armFromCache(context: Context, habitId: Long?, onDone: (() -> Unit)? = null) {
        val app = context.applicationContext
        // A standalone scope, not the caller's: a BroadcastReceiver's lifetime
        // ends the moment onReceive returns.
        CoroutineScope(Dispatchers.IO).launch {
            try {
                runCatching {
                    val settings = Settings(app)
                    // The cached answer, not an assumption: a phone the account
                    // has switched off as a destination must not re-arm every
                    // alarm on each reboot while it waits for connectivity.
                    val enabled = settings.androidRemindersEnabled()
                    val cached = settings.cachedReminders()
                    Notifications.ensureChannel(app)
                    cached.filter { habitId == null || it.id == habitId }
                        // `schedule` cancels when it is not wanted, so a
                        // destination that has just been switched off clears the
                        // alarms it already holds rather than merely stopping
                        // new ones.
                        .forEach { schedule(app, it, enabled) }
                }
            } finally {
                onDone?.invoke()
            }
        }
    }

    private fun enqueueSync(context: Context, habitId: Long?) {
        val data = Data.Builder()
        if (habitId != null) data.putLong(Notifications.EXTRA_HABIT_ID, habitId)

        val request = OneTimeWorkRequestBuilder<ScheduleWorker>()
            .setInputData(data.build())
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            )
            .build()

        WorkManager.getInstance(context).enqueueUniqueWork(
            if (habitId != null) "schedule:$habitId" else "schedule:all",
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }

    /**
     * Refreshes the local cache from the server and re-arms from it.
     *
     * Network-constrained, and that is now acceptable: `armFromCache` has
     * already scheduled from whatever was last known, so this only corrects
     * the schedule after a change made elsewhere. Losing it costs accuracy,
     * not the reminder itself.
     */
    class ScheduleWorker(
        appContext: Context,
        params: WorkerParameters,
    ) : CoroutineWorker(appContext, params) {

        override suspend fun doWork(): Result {
            val settings = Settings(applicationContext)
            val api = settings.api() ?: return Result.success()
            // See Outbox.SyncWorker: `hasKeyWithValueOfType` is not reified.
            val only = if (inputData.keyValueMap.containsKey(Notifications.EXTRA_HABIT_ID)) {
                inputData.getLong(Notifications.EXTRA_HABIT_ID, -1)
            } else {
                null
            }

            val habits = try {
                api.habits()
            } catch (e: Exception) {
                return Result.retry()
            }

            // Refresh the offline cache on every successful fetch. This is
            // what makes the next cold boot able to arm alarms with no
            // network — the whole point of the cache.
            runCatching { settings.cacheReminders(habits) }

            // Whether this device is still a destination for reminders. A
            // failed settings fetch falls back to the cached answer rather than
            // to "enabled": one flaky request must not resurrect alarms the
            // user turned off.
            val enabled = try {
                api.settings().androidRemindersEnabled().also {
                    runCatching { settings.cacheAndroidReminders(it) }
                }
            } catch (e: Exception) {
                settings.androidRemindersEnabled()
            }

            Notifications.ensureChannel(applicationContext)

            if (only != null) {
                // A habit deleted server-side would otherwise keep its alarm
                // and re-fire every day forever: an absent habit must cancel,
                // not just skip. `schedule` already cancels for archived or
                // reminder-less habits.
                val habit = habits.firstOrNull { it.id == only }
                if (habit == null) cancel(applicationContext, only)
                else schedule(applicationContext, habit, enabled)
            } else {
                habits.forEach { schedule(applicationContext, it, enabled) }
            }
            return Result.success()
        }
    }
}
