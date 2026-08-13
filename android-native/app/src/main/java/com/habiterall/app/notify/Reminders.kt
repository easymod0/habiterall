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
        var next = now.with(time).withSecond(0).withNano(0)
        if (!next.isAfter(now)) next = next.plusDays(1)
        return next.toInstant().toEpochMilli()
    }

    private fun parseTime(value: String): LocalTime? =
        runCatching { LocalTime.parse(value) }.getOrNull()

    fun schedule(context: Context, habit: Habit) {
        val time = parseTime(habit.reminderTime)
        if (habit.archived || time == null) {
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
        enqueueSync(context, habitId)
    }

    /** Re-arms every habit's alarm — after a reboot, or a habit list change. */
    fun rescheduleAll(context: Context) {
        enqueueSync(context, null)
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
     * Fetches habits and arms their alarms. Needs the network, hence a worker:
     * the reminder times are the server's, so there is nothing local to read.
     */
    class ScheduleWorker(
        appContext: Context,
        params: WorkerParameters,
    ) : CoroutineWorker(appContext, params) {

        override suspend fun doWork(): Result {
            val api = Settings(applicationContext).api() ?: return Result.success()
            val only = if (inputData.hasKeyWithValueOfType<Long>(Notifications.EXTRA_HABIT_ID)) {
                inputData.getLong(Notifications.EXTRA_HABIT_ID, -1)
            } else {
                null
            }

            val habits = try {
                api.habits()
            } catch (e: Exception) {
                return Result.retry()
            }

            Notifications.ensureChannel(applicationContext)

            if (only != null) {
                // A habit deleted server-side would otherwise keep its alarm
                // and re-fire every day forever: an absent habit must cancel,
                // not just skip. `schedule` already cancels for archived or
                // reminder-less habits.
                val habit = habits.firstOrNull { it.id == only }
                if (habit == null) cancel(applicationContext, only)
                else schedule(applicationContext, habit)
            } else {
                habits.forEach { schedule(applicationContext, it) }
            }
            return Result.success()
        }
    }
}
