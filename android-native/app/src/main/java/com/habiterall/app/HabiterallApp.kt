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
        //
        // Note this runs on a COLD start only. Android commonly keeps the
        // process alive, so closing and reopening the app is not a re-sync —
        // which is why the habit list re-arms from every fetch it makes, and
        // why the heartbeat below exists rather than trusting launches.
        Reminders.rescheduleAll(this)

        // The backstop: every other path here is an event that hands off to the
        // next, so one dropped link leaves a habit silent with nothing scheduled
        // to notice.
        Reminders.enqueuePeriodicSync(this)
    }
}
