package com.habiterall.app.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.habiterall.app.R
import com.habiterall.app.data.Grid
import com.habiterall.app.data.Habit
import com.habiterall.app.ui.CountEntryActivity
import com.habiterall.app.ui.MainActivity
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Builds the reminder notification and its actions.
 *
 * The whole point of the native app: answering from the shade, without the app
 * ever coming to the foreground. A yes/no habit gets Yes / No / Skip inline; a
 * measurable one gets a small activity to type the number, because a
 * notification action cannot collect an arbitrary value.
 *
 * Tapping anywhere *else* — the text, the icon, the gap around the buttons —
 * opens the app on the habit the reminder was about. That is the platform's
 * own convention for a notification body, and a reminder that answered nothing
 * and did nothing when tapped read as broken.
 */
object Notifications {

    const val CHANNEL_REMINDERS = "reminders"

    const val ACTION_YES = "com.habiterall.app.YES"
    const val ACTION_NO = "com.habiterall.app.NO"
    const val ACTION_SKIP = "com.habiterall.app.SKIP"

    /**
     * Ask again later. Not an answer, and deliberately not shaped like one: it
     * records nothing, so it is the one action that leaves the day outstanding.
     */
    const val ACTION_SNOOZE = "com.habiterall.app.SNOOZE"

    const val EXTRA_HABIT_ID = "habit_id"
    const val EXTRA_HABIT_NAME = "habit_name"
    const val EXTRA_DATE = "date"

    /** Set on the alarm a snooze arms, so the receiver can tell it apart. */
    const val EXTRA_SNOOZED = "snoozed"

    /**
     * What the tapped action records, decided where the habit is in hand.
     *
     * [ActionReceiver] gets an id and a date and nothing else; loading the
     * habit there would mean a DataStore read inside a broadcast receiver's ten
     * seconds, for an answer this side already has.
     */
    const val EXTRA_VALUE = "value"

    /** Whether the habit is shown as something to avoid — for the toast only. */
    const val EXTRA_AVOIDED = "avoided"
    const val EXTRA_UNIT = "unit"
    const val EXTRA_TARGET = "target"

    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_REMINDERS,
            context.getString(R.string.channel_reminders),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.channel_reminders_desc)
            setShowBadge(true)
        }
        NotificationManagerCompat.from(context).createNotificationChannel(channel)
    }

    /**
     * One notification id per habit, so a reminder replaces yesterday's rather
     * than stacking up a column of unanswered days.
     */
    fun notificationId(habitId: Long): Int = (habitId % Int.MAX_VALUE).toInt()

    private fun actionIntent(
        context: Context,
        action: String,
        habit: Habit,
        date: String,
    ): PendingIntent {
        val intent = Intent(context, ActionReceiver::class.java).apply {
            this.action = action
            putExtra(EXTRA_HABIT_ID, habit.id)
            putExtra(EXTRA_DATE, date)
            // The VALUE travels with the action, because the receiver has only
            // an id and a date — and reading the habit back would mean a
            // DataStore read inside a BroadcastReceiver's ten seconds. Here the
            // habit is in hand, so `Grid.valueForState` answers once: a clean
            // day on an avoided habit is 0 and a slip is the smallest amount
            // over, where a yes/no habit is YES and UNSET as before.
            //
            // Safe to attach because `filterEquals` ignores extras BUT the data
            // URI above already separates the three actions and the flags below
            // include FLAG_UPDATE_CURRENT — without that this would post a
            // notification carrying the previous habit's numbers.
            when (action) {
                ACTION_YES -> putExtra(EXTRA_VALUE, Grid.valueForState(habit, Grid.DayState.DONE))
                ACTION_NO -> putExtra(EXTRA_VALUE, Grid.valueForState(habit, Grid.DayState.NO))
                else -> {}
            }
            putExtra(EXTRA_AVOIDED, habit.isAvoided)
            // Distinct data keeps the three actions from collapsing into one
            // PendingIntent — filterEquals ignores extras.
            data = android.net.Uri.parse("habiterall://${habit.id}/$date/$action")
        }
        return PendingIntent.getBroadcast(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun countIntent(context: Context, habit: Habit, date: String): PendingIntent {
        val intent = Intent(context, CountEntryActivity::class.java).apply {
            putExtra(EXTRA_HABIT_ID, habit.id)
            putExtra(EXTRA_HABIT_NAME, habit.name)
            putExtra(EXTRA_DATE, date)
            putExtra(EXTRA_UNIT, habit.unit)
            putExtra(EXTRA_TARGET, habit.targetValue)
            data = android.net.Uri.parse("habiterall://${habit.id}/$date/count")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        }
        return PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /**
     * Opens the app on this habit — what a tap on the notification body does.
     *
     * `CLEAR_TOP` with MainActivity's `singleTop` launch mode reuses the
     * instance that is already there and delivers the habit through
     * `onNewIntent`, rather than stacking a second copy of the app on top of
     * the one the user left. The distinct `data` is again what keeps two
     * habits' reminders from sharing one PendingIntent.
     */
    private fun openIntent(context: Context, habit: Habit, date: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            putExtra(EXTRA_HABIT_ID, habit.id)
            data = android.net.Uri.parse("habiterall://${habit.id}/$date/open")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /**
     * @param skipEnabled whether the account offers skip days. Read from the
     *   local mirror by the caller, because an alarm can fire on a phone that has
     *   not reached the server in a week and the shade must still agree with the
     *   grid about which answers exist.
     */
    /**
     * The buttons a reminder can offer, in the order they are added.
     *
     * A list rather than a sequence of `addAction` calls, because the ORDER is
     * a decision and a decision that only exists inside a builder cannot be
     * tested: every wrong arrangement of it still posts a notification.
     */
    enum class ReminderAction { YES, NO, COUNT, SKIP, SNOOZE }

    /**
     * How many buttons the collapsed shade shows. Android's own cap, not ours.
     */
    const val VISIBLE_ACTIONS = 3

    /**
     * Which buttons this reminder gets, in order.
     *
     * Snooze is LAST, and that is the whole decision. Where the list runs past
     * [VISIBLE_ACTIONS] the collapsed shade drops the tail, and snooze is the
     * right one to lose: the others ANSWER the day and it only defers one, so
     * an answer you cannot give would be the worse loss. It is still offered
     * rather than omitted, because three is the phone's shade and not every
     * surface — a watch or a car shows more.
     *
     * Note which habits that costs, because it is narrower than "an account
     * that uses skip days": a yes/no habit and one shown as something to avoid
     * both spend two buttons on Yes and No, so with skips on they have four and
     * snooze falls off. A MEASURABLE habit spends one on the number pad, so it
     * has three and keeps its snooze.
     */
    fun reminderActions(
        habit: Habit,
        skipEnabled: Boolean,
        snoozeAvailable: Boolean,
    ): List<ReminderAction> = buildList {
        // A habit shown as something to avoid is answered yes-or-no even though
        // it is stored as a measurable one — offering a number pad for "did you
        // smoke?" is the friction the rendering exists to remove.
        if (habit.isNumerical && !habit.isAvoided) {
            add(ReminderAction.COUNT)
        } else {
            add(ReminderAction.YES)
            add(ReminderAction.NO)
        }
        if (skipEnabled) add(ReminderAction.SKIP)
        if (snoozeAvailable) add(ReminderAction.SNOOZE)
    }

    fun buildReminder(
        context: Context,
        habit: Habit,
        date: String,
        skipEnabled: Boolean = false,
        now: ZonedDateTime = ZonedDateTime.now(ZoneId.systemDefault()),
    ): Notification {
        // A custom prompt leads, because "Did you exercise today?" is a question
        // where the habit's name is a label. The name then becomes the second
        // line, so a shade holding several reminders still says which is which.
        val prompt = habit.reminderMessage.trim()

        val builder = NotificationCompat.Builder(context, CHANNEL_REMINDERS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (prompt.isEmpty()) habit.name else prompt)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            // The body opens the app for every habit type. It used to open the
            // number pad for a measurable habit and do nothing at all for a
            // yes/no one — so the most ordinary gesture there is, a tap on the
            // notification, was a dead spot on two thirds of the shade.
            .setContentIntent(openIntent(context, habit, date))

        val avoided = habit.isAvoided
        if (habit.isNumerical && !avoided) {
            val target = formatTarget(habit)
            builder.setContentText(
                if (prompt.isEmpty()) {
                    context.getString(R.string.reminder_measurable, target)
                } else {
                    // The prompt has taken the title, so this line carries the
                    // two things it does not say: which habit, and the goal.
                    "${habit.name} · ${context.getString(R.string.reminder_measurable, target)}"
                }
            )
        } else {
            builder.setContentText(
                if (prompt.isNotEmpty()) habit.name
                else if (avoided) context.getString(R.string.reminder_avoid)
                else context.getString(R.string.reminder_boolean)
            )
        }

        // Snooze is absent entirely when there is no room left in the reminder's
        // own day for one, which `Reminders.snoozeUntil` decides — a button that
        // can only say "too late" is worse than no button. `ActionReceiver` asks
        // the same question again on the press, because a notification built at
        // 20:00 is still there at 00:30 the next morning.
        val actions = reminderActions(
            habit,
            skipEnabled,
            snoozeAvailable = Reminders.snoozeUntil(now, date) != null,
        )

        actions.forEach { action ->
            when (action) {
                // "Yes" on "did you smoke?" records the opposite of what it
                // looks like, so the labels invert with the rendering. The
                // ACTIONS do not — YES is still the good answer and NO the bad
                // one, and what each records is decided once, in `actionIntent`.
                ReminderAction.YES -> builder.addAction(
                    0,
                    context.getString(if (avoided) R.string.action_clean else R.string.action_yes),
                    actionIntent(context, ACTION_YES, habit, date),
                )
                ReminderAction.NO -> builder.addAction(
                    0,
                    context.getString(if (avoided) R.string.action_slipped else R.string.action_no),
                    actionIntent(context, ACTION_NO, habit, date),
                )
                ReminderAction.COUNT -> builder.addAction(
                    0,
                    context.getString(R.string.action_enter_count),
                    countIntent(context, habit, date),
                )
                ReminderAction.SKIP -> builder.addAction(
                    0,
                    context.getString(R.string.action_skip),
                    actionIntent(context, ACTION_SKIP, habit, date),
                )
                ReminderAction.SNOOZE -> builder.addAction(
                    0,
                    context.getString(R.string.action_snooze),
                    actionIntent(context, ACTION_SNOOZE, habit, date),
                )
            }
        }
        return builder.build()
    }

    private fun formatTarget(habit: Habit): String {
        val n = habit.targetValue
        val amount = if (n == n.toLong().toDouble()) n.toLong().toString() else n.toString()
        return if (habit.unit.isBlank()) amount else "$amount ${habit.unit}"
    }

    /** Posts a notification, silently doing nothing if the user denied the permission. */
    fun post(context: Context, id: Int, notification: Notification) {
        val granted = ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        // Pre-33 there is no such permission and the check above always passes.
        if (!granted && android.os.Build.VERSION.SDK_INT >= 33) return
        NotificationManagerCompat.from(context).notify(id, notification)
    }

    fun cancel(context: Context, id: Int) {
        NotificationManagerCompat.from(context).cancel(id)
    }
}
