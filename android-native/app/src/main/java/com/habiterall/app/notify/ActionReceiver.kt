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

        val (value, skip) = when (intent.action) {
            Notifications.ACTION_YES -> Sentinels.YES to false
            // "No" is an explicit zero, not an absence: it must overwrite any
            // earlier value for the day rather than leave it standing.
            Notifications.ACTION_NO -> Sentinels.UNSET to false
            Notifications.ACTION_SKIP -> null to true
            else -> return
        }

        Outbox.enqueue(context, habitId, date, value, skip)
        Notifications.cancel(context, Notifications.notificationId(habitId))

        val message = when (intent.action) {
            Notifications.ACTION_SKIP -> R.string.recorded_skip
            Notifications.ACTION_NO -> R.string.recorded_no
            else -> R.string.recorded_yes
        }
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }
}
