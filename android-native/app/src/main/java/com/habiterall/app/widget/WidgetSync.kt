package com.habiterall.app.widget

import android.content.Context
import com.habiterall.app.data.Api
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Outbox
import com.habiterall.app.data.Settings
import com.habiterall.app.data.Widgets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import java.time.LocalDate

/**
 * Keeps the home screen in step with the account.
 *
 * A widget cannot poll and nothing pushes to it, so every path that learns
 * something has to hand it on — the rule `Reminders.armFrom` was written for,
 * arriving at a second surface. There are four ways in and they are deliberately
 * the ones that already exist: the list's own fetch ([refreshFrom]), the
 * six-hourly heartbeat that already re-arms alarms ([refreshFromServer], called
 * from `Reminders.ScheduleWorker`), an answer given elsewhere on this phone
 * ([noteAnswer]), and the widget's own tap.
 */
object WidgetSync {

    /**
     * Update every widget from habits that have just been fetched.
     *
     * `NonCancellable`, for the reason `Reminders.armFrom` is: the caller is a
     * fetch effect that restarts whenever the visible window grows, and half a
     * home screen updated is worse than none of it. It is a DataStore write and
     * a handful of binder calls.
     */
    suspend fun refreshFrom(context: Context, habits: List<Habit>) {
        val app = context.applicationContext
        withContext(NonCancellable + Dispatchers.IO) {
            runCatching {
                val settings = Settings(app)
                val records = settings.cachedWidgets()
                if (records.isEmpty()) return@runCatching
                val today = LocalDate.now().toString()

                val updated = records.mapNotNull { record ->
                    // A habit that is not in this list — deleted, or archived —
                    // keeps whatever it last showed. Blanking it would claim the
                    // day is unanswered, which is a different and louder lie
                    // than a name that has stopped moving.
                    val habit = habits.firstOrNull { it.id == record.habitId }
                        ?: return@mapNotNull null
                    // A tap still on its way wins over the server's answer,
                    // which is by definition older than it. This is the
                    // `pending` overlay of the list screen, asked of the outbox
                    // instead of held in memory: a widget's tap happens in a
                    // broadcast receiver that may not outlive the write, so
                    // there is nowhere in this process to hold it.
                    if (record.date == today && Outbox.isPending(app, record.habitId, today)) {
                        return@mapNotNull null
                    }
                    Widgets.refreshed(record, habit, today)
                }

                settings.putWidgets(updated)
                HabitWidget.redraw(app)
            }
        }
    }

    /**
     * Fetch and update, for a caller that has an [Api] but no habits in hand.
     *
     * One request, and only when a widget exists — the overview rather than the
     * habit list because it carries the DAYS, which is the half a widget is
     * about.
     */
    suspend fun refreshFromServer(context: Context, api: Api) {
        val app = context.applicationContext
        if (runCatching { Settings(app).cachedWidgets() }.getOrDefault(emptyList()).isEmpty()) return
        val data = runCatching { api.overview(days = 1) }.getOrNull() ?: return
        refreshFrom(app, data.habits)
    }

    /**
     * Note an answer given somewhere else on this phone — the notification's
     * buttons, or its number pad.
     *
     * Those write through the outbox and never touch the server, so without
     * this the home screen goes on showing an unanswered day until a refresh
     * arrives, which offline can be hours. Same optimistic paint the widget's
     * own tap makes, from the same two values.
     */
    suspend fun noteAnswer(
        context: Context,
        habitId: Long,
        date: String,
        value: Double?,
        skip: Boolean,
    ) {
        val app = context.applicationContext
        withContext(NonCancellable + Dispatchers.IO) {
            runCatching {
                val settings = Settings(app)
                val mine = settings.cachedWidgets().filter { it.habitId == habitId }
                if (mine.isEmpty()) return@runCatching
                settings.putWidgets(mine.map { Widgets.answered(it, date, value, skip) })
                HabitWidget.redraw(app)
            }
        }
    }
}
