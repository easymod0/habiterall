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
                    val habit = habits.firstOrNull { it.id == record.habitId }
                    // A tap still on its way wins over the server's answer,
                    // which is by definition older than it. This is the
                    // `pending` overlay of the list screen, asked of the outbox
                    // instead of held in memory: a widget's tap happens in a
                    // broadcast receiver that may not outlive the write, so
                    // there is nowhere in this process to hold it.
                    //
                    // A habit that has disappeared is the exception: whether
                    // its widget still accepts taps is not a question about the
                    // day, and it has to be answered even while one is queued.
                    if (habit != null &&
                        record.date == today &&
                        Outbox.isPending(app, record.habitId, today)
                    ) {
                        return@mapNotNull null
                    }
                    // Marked gone, or brought back — `Widgets.refreshedOrGone`
                    // is the rule, and it is there rather than here so a test
                    // can reach it. Unchanged records are dropped so a refresh
                    // that decided nothing writes nothing.
                    Widgets.refreshedOrGone(record, habit, today)
                        .takeIf { it != record }
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
     * A write the server refused for good, taken back off the home screen.
     *
     * The widget paints a tap before it is delivered, and `SyncWorker` drops a
     * 4xx as permanently inapplicable — so without this the cell goes on
     * claiming an answer that was never stored, until some later refresh
     * silently repaints the server's version hours afterwards. The reliable way
     * to produce one is a phone whose local date is ahead of the server's,
     * which `Outbox.awaitWrite` already records as the case that cost the list
     * screen a wrong cell.
     *
     * The day is returned to UNANSWERED rather than to what it held before,
     * because the record does not keep a previous value and inventing one would
     * be a second claim about the same day. A refresh replaces it with the
     * server's answer as soon as there is a network.
     *
     * What this does NOT do is tell the user. The shade's buttons are equally
     * silent about a refused write and there is nowhere on a 2x2 cell to say
     * it; the list screen is the surface that reports one.
     */
    suspend fun noteRefused(context: Context, habitId: Long, date: String) {
        val app = context.applicationContext
        withContext(NonCancellable + Dispatchers.IO) {
            runCatching {
                // Read and change inside ONE `edit`: this derives new values
                // from what it read, so a tap landing between a separate read
                // and write would either be lost or lose its rollback.
                Settings(app).updateWidgets { records ->
                    records.map {
                        if (it.habitId == habitId && it.date == date) {
                            it.copy(value = null, skip = false)
                        } else {
                            it
                        }
                    }
                }
                HabitWidget.redraw(app)
            }
        }
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
                // One `edit` for the same reason: `answered` reads the
                // record's own date to decide whether this answer is newer.
                Settings(app).updateWidgets { records ->
                    records.map {
                        if (it.habitId == habitId) Widgets.answered(it, date, value, skip) else it
                    }
                }
                HabitWidget.redraw(app)
            }
        }
    }
}
