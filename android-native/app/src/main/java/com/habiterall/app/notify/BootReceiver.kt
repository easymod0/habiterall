package com.habiterall.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.habiterall.app.widget.HabitWidget

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

        // A reboot wipes the home-screen widget's midnight alarm along with
        // every other one, and nothing else re-arms it: `armMidnight`'s only
        // other caller is `redraw`, which a boot does not reach. The system's
        // own `APPWIDGET_UPDATE` eventually arrives — `updatePeriodMillis`
        // later, on an inexact alarm Doze defers — which is precisely the
        // reason that setting is not the midnight answer. Reboot at 23:50 and
        // the widget shows yesterday until the phone is next used. The
        // exact-alarm permission changing is the same story: it re-arms every
        // reminder exactly and would have left this one inexact.
        //
        // Synchronous, so it needs no share of the hold below: AlarmManager
        // and AppWidgetManager, no DataStore, no coroutine.
        HabitWidget.armMidnight(context)

        // `goAsync` holds the process alive while the cache is read off the
        // main thread. Without it the reschedule races process death on the
        // one occasion it matters most — the boot that wiped every alarm.
        val pending = goAsync()
        Reminders.rescheduleAll(context) { pending.finish() }
    }
}
