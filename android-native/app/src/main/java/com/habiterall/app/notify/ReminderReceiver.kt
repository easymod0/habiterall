package com.habiterall.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.habiterall.app.data.Settings
import java.time.LocalDate

/**
 * Fires at a habit's reminder time.
 *
 * The alarm carries only the habit id; the habit itself is fetched so the
 * notification reflects the current name, type and target rather than whatever
 * they were when the alarm was set. Fetching means network, so the work is
 * handed to a worker rather than done in onReceive's ten-second window.
 */
class ReminderReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val habitId = intent.getLongExtra(Notifications.EXTRA_HABIT_ID, -1)
        if (habitId < 0) return

        val request = OneTimeWorkRequestBuilder<NotifyWorker>()
            .setInputData(Data.Builder().putLong(Notifications.EXTRA_HABIT_ID, habitId).build())
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            )
            .build()

        WorkManager.getInstance(context)
            .enqueueUniqueWork("remind:$habitId", ExistingWorkPolicy.REPLACE, request)

        // Alarms are one-shot; the next day's must be armed now, and this must
        // happen regardless of whether the notification itself succeeds.
        Reminders.rescheduleOne(context, habitId)
    }

    class NotifyWorker(
        appContext: Context,
        params: WorkerParameters,
    ) : CoroutineWorker(appContext, params) {

        override suspend fun doWork(): Result {
            val habitId = inputData.getLong(Notifications.EXTRA_HABIT_ID, -1)
            if (habitId < 0) return Result.failure()

            val api = Settings(applicationContext).api() ?: return Result.failure()
            val habit = try {
                api.habits().firstOrNull { it.id == habitId }
            } catch (e: Exception) {
                return Result.retry()
            } ?: return Result.success() // deleted server-side; nothing to remind about

            if (habit.archived || habit.reminderTime.isBlank()) return Result.success()

            val today = LocalDate.now().toString()
            // Already answered today — a reminder would be noise.
            val alreadyDone = try {
                api.entries(habitId).any { it.date == today }
            } catch (e: Exception) {
                false
            }
            if (alreadyDone) return Result.success()

            Notifications.ensureChannel(applicationContext)
            Notifications.post(
                applicationContext,
                Notifications.notificationId(habitId),
                Notifications.buildReminder(applicationContext, habit, today),
            )
            return Result.success()
        }
    }
}
