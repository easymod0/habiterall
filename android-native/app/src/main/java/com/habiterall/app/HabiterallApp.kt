package com.habiterall.app

import android.app.Application
import com.habiterall.app.notify.Notifications
import com.habiterall.app.notify.Reminders

class HabiterallApp : Application() {

    override fun onCreate() {
        super.onCreate()
        // Creating a channel is idempotent, and a notification posted before
        // its channel exists is silently dropped on API 26+.
        Notifications.ensureChannel(this)

        // Reminder times live on the server, so the local alarms are only ever
        // a cache of them. Re-syncing on launch is what corrects drift after
        // the web UI changes a time.
        Reminders.rescheduleAll(this)
    }
}
