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

        // NO network constraint. The notification is the entire point of the
        // app, and it must appear whether or not the server is reachable —
        // requiring connectivity meant an offline morning silently produced no
        // reminder at all. The worker falls back to the cached habit and, if
        // it cannot check today's entries, errs toward notifying.
        val request = OneTimeWorkRequestBuilder<NotifyWorker>()
            .setInputData(Data.Builder().putLong(Notifications.EXTRA_HABIT_ID, habitId).build())
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

            val settings = Settings(applicationContext)
            val api = settings.api()

            // An alarm already armed when the account stopped wanting reminders
            // here still fires once — `Reminders` cannot reach into a pending
            // alarm from the moment the setting changes. Check again at the
            // point of posting, or switching this destination off would appear
            // not to work until the next sync.
            if (!settings.cachedAndroidReminders()) {
                Reminders.cancel(applicationContext, habitId)
                return Result.success()
            }

            // Prefer the live habit — its name and target may have changed —
            // but fall back to the cache rather than dropping the reminder.
            // `null` here means "we could not ask", which is NOT the same as
            // "the habit was deleted", and only the latter should stay silent.
            val fresh = if (api == null) null else try {
                api.habits().firstOrNull { it.id == habitId }
                    ?: return Result.success()   // genuinely gone server-side
            } catch (e: Exception) {
                null                              // unreachable; use the cache
            }

            val habit = fresh
                ?: settings.cachedReminders().firstOrNull { it.id == habitId }
                ?: return Result.success()

            if (habit.archived || habit.reminderTime.isBlank()) return Result.success()

            val today = LocalDate.now().toString()
            // Already answered today — a reminder would be noise. If the check
            // itself fails we notify anyway: a redundant reminder is a far
            // smaller harm than a missed one.
            val alreadyDone = if (api == null) false else try {
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
