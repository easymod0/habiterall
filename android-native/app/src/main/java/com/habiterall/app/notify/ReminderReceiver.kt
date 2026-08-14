package com.habiterall.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
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

/** `adb logcat -s habiterall.notify` is the whole point of this being one tag. */
private const val TAG = "habiterall.notify"

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
        //
        // `goAsync`, because arming it reads DataStore on another dispatcher and
        // this process may be killed the moment `onReceive` returns — the same
        // race BootReceiver holds itself open for, on the occasion that decides
        // whether there is a reminder tomorrow at all. Losing it silently is
        // most of what "sometimes I get it, sometimes I don't" was.
        val pending = goAsync()
        Reminders.rescheduleOne(context, habitId) { pending.finish() }
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
                drop(habitId, "this device is not a destination")
                Reminders.cancel(applicationContext, habitId)
                return Result.success()
            }

            // Prefer the live habit — its name and target may have changed —
            // but fall back to the cache rather than dropping the reminder.
            // `null` here means "we could not ask", which is NOT the same as
            // "the habit was deleted", and only the latter should stay silent.
            val fresh = if (api == null) null else try {
                api.habits().firstOrNull { it.id == habitId }
                    ?: return drop(habitId, "no such habit on the server")
            } catch (e: Exception) {
                null                              // unreachable; use the cache
            }

            val habit = fresh
                ?: settings.cachedReminders().firstOrNull { it.id == habitId }
                ?: return drop(habitId, "not on the server and not in the cache")

            if (habit.archived || habit.reminderTime.isBlank()) {
                return drop(habitId, "archived, or its reminder time was cleared")
            }

            val today = LocalDate.now().toString()
            // Already answered today — a reminder would be noise. If the check
            // itself fails we notify anyway: a redundant reminder is a far
            // smaller harm than a missed one.
            //
            // `needsReminder`, not "a row exists for today": the two are not the
            // same question, and the difference silenced a day recorded as three
            // of eight glasses while the server went on asking about it.
            val needed = if (api == null) true else try {
                Reminders.needsReminder(habit, api.entries(habitId), today)
            } catch (e: Exception) {
                true
            }
            if (!needed) return drop(habitId, "already answered today")

            Notifications.ensureChannel(applicationContext)
            Notifications.post(
                applicationContext,
                Notifications.notificationId(habitId),
                // From the mirror, not the network: this worker runs on whatever
                // connectivity the phone has at 08:00, and the actions offered
                // must not depend on that.
                Notifications.buildReminder(
                    applicationContext, habit, today, settings.cachedSkipDays()
                ),
            )
            Log.i(TAG, "posted reminder for habit $habitId")
            return Result.success()
        }

        /**
         * Say why nothing was posted, and succeed.
         *
         * Six conditions end this worker early and every one of them is
         * invisible from outside — a reminder that does not arrive looks
         * identical to a broken alarm, which sends people to check the thing
         * that is working. The server's tick has explained itself per habit for
         * exactly this reason (`notify.skip` in shared/src/notify-send.js); this
         * is the phone's half, readable with:
         *
         *     adb logcat -s habiterall.notify
         *
         * Ids only, never a habit name: a log is read by more people than the
         * app, and the naming policy in shared/src/log.js applies here too.
         */
        private fun drop(habitId: Long, reason: String): Result {
            Log.i(TAG, "no reminder for habit $habitId: $reason")
            return Result.success()
        }
    }
}
