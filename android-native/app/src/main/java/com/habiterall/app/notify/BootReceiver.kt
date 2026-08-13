package com.habiterall.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms every reminder after a reboot, an app update, or the exact-alarm
 * permission changing. AlarmManager forgets all pending alarms across a
 * reboot; without this, reminders quietly stop after the first restart.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        Reminders.rescheduleAll(context)
    }
}
