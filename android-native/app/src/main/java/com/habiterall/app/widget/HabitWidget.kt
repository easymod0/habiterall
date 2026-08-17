package com.habiterall.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import com.habiterall.app.R
import com.habiterall.app.data.Grid
import com.habiterall.app.data.Outbox
import com.habiterall.app.data.Settings
import com.habiterall.app.data.Widgets
import com.habiterall.app.notify.Notifications
import com.habiterall.app.notify.Reminders
import com.habiterall.app.ui.CountEntryActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.LocalDate

/**
 * One habit, today, tap to record — without opening anything.
 *
 * The notification already answers a day from outside the app, but only when a
 * reminder fires. This is the same idea with the habit sitting on the home
 * screen instead, and it is built out of what already exists: the cycle is
 * `Grid.nextState`, the encoding `Grid.valueForState`, the write [Outbox], and
 * the offline record [Widgets.Record] — which is a cache, not a sixth mirror.
 *
 * Three things about it are not obvious and each has a comment where it lives:
 * which day a tap is about (resolved when the tap arrives, never when the
 * widget was drawn), who wins while a write is in flight ([WidgetSync]), and
 * what a measurable habit does with a tap (asks for a number, as the
 * notification does).
 */
class HabitWidget : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        // Drawn from the cache, with no network: this runs on a restore, a
        // resize, a reboot and every `updatePeriodMillis`, and a widget that
        // could only draw when the server was reachable would be blank on the
        // one morning it matters.
        async { redraw(context) }
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        async { Settings(context.applicationContext).removeWidgets(appWidgetIds.toList()) }
    }

    override fun onReceive(context: Context, intent: Intent) {
        // Dispatches APPWIDGET_UPDATE and APPWIDGET_DELETED to the two above.
        super.onReceive(context, intent)

        when (intent.action) {
            ACTION_TAP -> {
                val widgetId = intent.getIntExtra(
                    AppWidgetManager.EXTRA_APPWIDGET_ID,
                    AppWidgetManager.INVALID_APPWIDGET_ID,
                )
                if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) async { tap(context, widgetId) }
            }

            // Midnight, and the two ways a phone can arrive at a different day
            // without one passing. The record says which day it is about, so
            // the drawing corrects itself the moment anything redraws it —
            // this is what makes something redraw it. `rescheduleAll` is
            // deliberate reuse: it enqueues the sync that also refreshes
            // widgets, and re-arming alarms on a date change is idempotent.
            Intent.ACTION_DATE_CHANGED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED -> {
                async { redraw(context) }
                Reminders.rescheduleAll(context)
            }
        }
    }

    /**
     * Hold the process open while a DataStore read finishes.
     *
     * A BroadcastReceiver's lifetime ends when `onReceive` returns, and every
     * path here reads the cache off the main thread — the same race
     * `BootReceiver` and `ReminderReceiver` hold themselves open for.
     */
    private fun async(block: suspend () -> Unit) {
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                runCatching { block() }
            } finally {
                pending.finish()
            }
        }
    }

    private suspend fun tap(context: Context, widgetId: Int) {
        val app = context.applicationContext
        val settings = Settings(app)
        val record = settings.cachedWidget(widgetId) ?: return

        // TODAY is resolved here, when the tap arrives — never when the widget
        // was drawn. A home screen can sit untouched across midnight, and a
        // date baked into the click intent would record the tap against
        // yesterday, which is the one mistake a widget is uniquely able to make.
        val today = LocalDate.now().toString()
        val tap = Widgets.tap(
            record,
            today,
            skipDays = settings.cachedSkipDays(),
            questionMarks = settings.cachedQuestionMarks(),
        )

        // Queue first, paint second: the queue is what makes the answer true,
        // and a paint that got ahead of a throw would show one that is not.
        Outbox.enqueue(app, record.habitId, today, tap.value, tap.skip)
        settings.putWidgets(listOf(Widgets.answered(record, today, tap.value, tap.skip)))
        redraw(app)
    }

    companion object {

        private const val ACTION_TAP = "com.habiterall.app.WIDGET_TAP"

        /** A slip, in the same red the day grid paints one. */
        private const val SLIP = 0xFFDC2626.toInt()

        /**
         * Redraw every widget from the cache.
         *
         * Only the ids the launcher still has: a record can outlive its widget
         * if the process died between the deletion and [onDeleted], and
         * updating an id nobody holds throws.
         */
        suspend fun redraw(context: Context) {
            val app = context.applicationContext
            val manager = AppWidgetManager.getInstance(app)
            val live = manager
                .getAppWidgetIds(ComponentName(app, HabitWidget::class.java))
                .toSet()
            if (live.isEmpty()) return

            val settings = Settings(app)
            val questionMarks = settings.cachedQuestionMarks()
            val today = LocalDate.now().toString()
            settings.cachedWidgets()
                .filter { it.widgetId in live }
                .forEach { record ->
                    manager.updateAppWidget(
                        record.widgetId,
                        render(app, record, today, questionMarks),
                    )
                }
        }

        /**
         * What one widget looks like.
         *
         * The colours are the day grid's, decided by the four states rather
         * than re-derived: a clean day on an avoided habit is the habit's own
         * colour and a slip is red, because filling a slip with the habit's
         * colour — right where a bigger number is more done — reads as having
         * done well. Nothing here knows it is inverting anything; `isAvoided`
         * and `isMet` do that, once, where they already live.
         */
        fun render(
            context: Context,
            record: Widgets.Record,
            today: String,
            questionMarks: Boolean,
        ): RemoteViews {
            val state = Widgets.stateOn(record, today)
            val habit = record.habit
            val filled = state == Grid.DayState.DONE ||
                (state == Grid.DayState.NO && habit.isAvoided)

            val views = RemoteViews(context.packageName, R.layout.widget_habit)
            views.setTextViewText(R.id.widget_name, record.name)
            views.setTextViewText(R.id.widget_mark, label(record, state, questionMarks))
            views.setInt(R.id.widget_cell, "setColorFilter", fill(context, record, state))
            views.setTextColor(
                R.id.widget_mark,
                ContextCompat.getColor(
                    context,
                    if (filled) R.color.widget_on_fill else R.color.widget_text,
                ),
            )
            views.setContentDescription(R.id.widget_root, describe(context, record, state))
            views.setOnClickPendingIntent(R.id.widget_root, clickIntent(context, record))
            return views
        }

        /**
         * The label, mirroring `DayCell` state for state.
         *
         * A measurable habit shows its amount, because "6" against a target of
         * 8 is the answer and a tick is not. An avoided one shows a tick for a
         * clean day and a cross for a slip — the count says nothing useful on a
         * limit of none, and this widget is one cell rather than a row.
         */
        private fun label(
            record: Widgets.Record,
            state: Grid.DayState,
            questionMarks: Boolean,
        ): String {
            val habit = record.habit
            return when {
                state == Grid.DayState.SKIPPED -> "–"
                state == Grid.DayState.UNKNOWN -> if (questionMarks) "?" else ""
                habit.isAvoided -> if (state == Grid.DayState.DONE) "✓" else "✗"
                habit.isNumerical -> record.value?.let { trimNumber(it) } ?: ""
                state == Grid.DayState.DONE -> "✓"
                else -> ""
            }
        }

        private fun fill(
            context: Context,
            record: Widgets.Record,
            state: Grid.DayState,
        ): Int {
            val habit = record.habit
            val empty = ContextCompat.getColor(context, R.color.widget_cell_empty)
            return when {
                state == Grid.DayState.DONE -> habitColor(record.color)
                state != Grid.DayState.NO -> empty
                habit.isAvoided -> SLIP
                // A measurable habit that fell short is a faint version of its
                // own colour, because "8 of 20 pages" is not a day with nothing
                // on it. A yes/no "no" is the empty cell, exactly as the grid
                // leaves it.
                habit.isNumerical && (record.value ?: 0.0) > 0.0 ->
                    (habitColor(record.color) and 0x00FFFFFF) or 0x59000000
                else -> empty
            }
        }

        /** `#8b5cf6` as a colour int, falling back rather than throwing on junk. */
        private fun habitColor(hex: String): Int =
            runCatching { android.graphics.Color.parseColor(hex) }.getOrElse { 0xFF3B82F6.toInt() }

        /** 2.0 -> "2", 2.5 -> "2.5". */
        private fun trimNumber(n: Double): String =
            if (n == n.toLong().toDouble()) n.toLong().toString() else n.toString()

        private fun describe(
            context: Context,
            record: Widgets.Record,
            state: Grid.DayState,
        ): String {
            val word = context.getString(
                when (state) {
                    Grid.DayState.DONE ->
                        if (record.habit.isAvoided) R.string.widget_clean else R.string.widget_done
                    Grid.DayState.NO ->
                        if (record.habit.isAvoided) R.string.widget_slipped else R.string.widget_not_done
                    Grid.DayState.SKIPPED -> R.string.widget_skipped
                    Grid.DayState.UNKNOWN -> R.string.widget_unanswered
                }
            )
            return "${record.name}: $word"
        }

        /**
         * What a tap opens or sends.
         *
         * A measurable habit gets the number pad the notification already uses,
         * because a tap cannot say "six glasses" — and cycling one anyway would
         * record `YES`, which is 2, as the amount. It has to be a
         * `getActivity`: starting one from the receiver instead would be a
         * background activity launch, which Android 10 refuses. The DAY is
         * therefore resolved by the activity rather than baked in here, since
         * this intent is built when the widget is drawn and pressed whenever
         * the user presses it.
         *
         * Distinct `data` per widget, because `filterEquals` ignores extras and
         * two widgets would otherwise share one PendingIntent — which is how
         * every habit on the home screen ends up recording the same one.
         */
        private fun clickIntent(context: Context, record: Widgets.Record): PendingIntent {
            val pi = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            if (Widgets.needsAmount(record)) {
                val intent = Intent(context, CountEntryActivity::class.java).apply {
                    putExtra(Notifications.EXTRA_HABIT_ID, record.habitId)
                    putExtra(Notifications.EXTRA_HABIT_NAME, record.name)
                    putExtra(Notifications.EXTRA_TODAY, true)
                    putExtra(Notifications.EXTRA_UNIT, record.unit)
                    putExtra(Notifications.EXTRA_TARGET, record.targetValue)
                    data = android.net.Uri.parse("habiterall://widget/${record.widgetId}/count")
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                }
                return PendingIntent.getActivity(context, 0, intent, pi)
            }

            val intent = Intent(context, HabitWidget::class.java).apply {
                action = ACTION_TAP
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, record.widgetId)
                data = android.net.Uri.parse("habiterall://widget/${record.widgetId}/tap")
            }
            return PendingIntent.getBroadcast(context, 0, intent, pi)
        }
    }
}
