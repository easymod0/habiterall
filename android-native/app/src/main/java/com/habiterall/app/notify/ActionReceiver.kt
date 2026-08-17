package com.habiterall.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.widget.Toast
import com.habiterall.app.R
import com.habiterall.app.data.Outbox
import com.habiterall.app.data.Sentinels

/**
 * Handles a Yes / No / Skip tap from the notification shade.
 *
 * Nothing here touches the network. The write goes to the outbox, which owns
 * delivery — a broadcast receiver has about ten seconds to live and must not
 * be the thing holding an HTTP request, and the tap must register whether or
 * not the phone has signal.
 */
class ActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val habitId = intent.getLongExtra(Notifications.EXTRA_HABIT_ID, -1)
        val date = intent.getStringExtra(Notifications.EXTRA_DATE) ?: return
        if (habitId < 0) return

        // Snooze answers nothing, so it leaves this receiver before the outbox
        // is reached. It is asked again HERE rather than trusted from the
        // button's existence: the notification was built when the alarm fired
        // and may be pressed hours later, and by then the hour can have run out
        // of the day. A refused snooze leaves the notification standing — the
        // day is still unanswered, and taking it away would be the loss the
        // button was pressed to avoid.
        if (intent.action == Notifications.ACTION_SNOOZE) {
            val armed = Reminders.snooze(context, habitId)
            if (armed) Notifications.cancel(context, Notifications.notificationId(habitId))
            Toast.makeText(
                context,
                if (armed) R.string.snoozed else R.string.snooze_too_late,
                Toast.LENGTH_SHORT,
            ).show()
            return
        }

        // The value was decided when the notification was built, where the
        // habit was in hand — a habit shown as something to avoid records 0 for
        // a clean day and the smallest amount over for a slip, and this
        // receiver has only an id and a date. The defaults are what every
        // notification posted before this existed carries, so one already in
        // the shade across an upgrade still records what it always did.
        val stated = intent.getDoubleExtra(Notifications.EXTRA_VALUE, Double.NaN)
        val (value, skip) = when (intent.action) {
            Notifications.ACTION_YES ->
                (if (stated.isNaN()) Sentinels.YES else stated) to false
            // "No" is an explicit zero, not an absence: it must overwrite any
            // earlier value for the day rather than leave it standing.
            Notifications.ACTION_NO ->
                (if (stated.isNaN()) Sentinels.UNSET else stated) to false
            Notifications.ACTION_SKIP -> null to true
            else -> return
        }

        // Note there is no snooze to cancel here, and that is a property of the
        // shade rather than an oversight: a snooze takes the notification away,
        // so from that moment there is nothing left to press until the re-post
        // — by which time the snooze has already fired. A day answered
        // ELSEWHERE while one is pending is the case that does exist, and
        // `needsReminder` is what answers it, in the worker, once.
        Outbox.enqueue(context, habitId, date, value, skip)
        Notifications.cancel(context, Notifications.notificationId(habitId))

        val avoided = intent.getBooleanExtra(Notifications.EXTRA_AVOIDED, false)
        val message = when (intent.action) {
            Notifications.ACTION_SKIP -> R.string.recorded_skip
            Notifications.ACTION_NO ->
                if (avoided) R.string.recorded_slipped else R.string.recorded_no
            else -> if (avoided) R.string.recorded_clean else R.string.recorded_yes
        }
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }
}
