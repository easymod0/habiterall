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
        // Check the action rather than acting on anything that arrives. The
        // receiver is not exported, so this is not remotely triggerable, but
        // an unfiltered `onReceive` silently inherits any filter added later.
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED" -> Unit
            else -> return
        }

        // `goAsync` holds the process alive while the cache is read off the
        // main thread. Without it the reschedule races process death on the
        // one occasion it matters most — the boot that wiped every alarm.
        val pending = goAsync()
        Reminders.rescheduleAll(context) { pending.finish() }
    }
}
