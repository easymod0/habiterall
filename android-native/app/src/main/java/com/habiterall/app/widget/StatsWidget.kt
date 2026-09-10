package com.habiterall.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import com.habiterall.app.R
import com.habiterall.app.data.Settings
import com.habiterall.app.data.Widgets
import com.habiterall.app.notify.Notifications
import com.habiterall.app.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.LocalDate
import kotlin.math.roundToInt

/**
 * A habit's score, streak and a seven-day strip on the home screen —
 * read-only (decision 3 of the brief this issue was built from): a tap opens
 * the app on that habit, and the widget itself answers nothing. There is no
 * `Api.stats()` and no new Kotlin model behind it — `/api/overview` already
 * returns `score` and `currentStreak` per habit, and `Api.kt`'s `Habit`
 * already deserializes both; this widget needed neither.
 *
 * A SECOND provider over [Widgets.Record]'s ONE store, not a second cache.
 * `remap`/`onRestored`, `refreshedOrGone` and the encode/decode
 * recoverability apparatus are three hard-won mechanisms — see
 * `HabitWidget`'s KDoc and `docs/decisions/android.md` — and this widget
 * reuses all three for free by staying on the one record type rather than
 * re-implementing them for a second one.
 *
 * `score` and `currentStreak` are cached ANSWERS, never recomputed: the
 * arithmetic behind them (Loop's `0.5^(sqrt(frequency)/13)` decay, the most
 * intricate figure in the project) stays where `Widgets.refreshed` reads it
 * from the fetch. "Make the strip update between syncs" is refused for the
 * same reason a second implementation would drift from the first invisibly —
 * see the KDoc on `Widgets.Record.score`.
 */
class StatsWidget : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        // The same central redraw `HabitWidget` uses — one function that
        // knows which renderer belongs to which widget id, not a second copy
        // of the drawing loop for this provider.
        async { HabitWidget.redraw(context) }
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        async {
            Settings(context.applicationContext).removeWidgets(appWidgetIds.toList())
            HabitWidget.redraw(context)
        }
    }

    /** See `HabitWidget.onRestored` — the same remap, over the same store. */
    override fun onRestored(context: Context, oldWidgetIds: IntArray, newWidgetIds: IntArray) {
        async {
            val settings = Settings(context.applicationContext)
            val moved = Widgets.remap(settings.cachedWidgets(), oldWidgetIds, newWidgetIds)
            settings.replaceWidgets(moved)
            HabitWidget.redraw(context)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        // Dispatches APPWIDGET_UPDATE, APPWIDGET_DELETED, APPWIDGET_RESTORED
        // and APPWIDGET_OPTIONS_CHANGED to the methods above and below.
        super.onReceive(context, intent)

        when (intent.action) {
            // No `ACTION_MIDNIGHT` case here: the midnight alarm is the ONE
            // alarm `HabitWidget.armMidnight` arms, targeted explicitly at
            // `HabitWidget::class.java`, and its handler redraws every
            // provider. A second alarm targeting this class would be the
            // second alarm the brief this issue was built from rejected.
            //
            // This widget carries no reminder of its own to reschedule on a
            // clock change — that stays `HabitWidget`'s job on the same
            // broadcast — so a redraw is all a clock change needs here: the
            // strip's dates and the stale/gone note are both a function of
            // `today`.
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED -> async { HabitWidget.redraw(context) }
        }
    }

    /**
     * A resize is the one thing only this widget's own instance hears about:
     * `Widgets.stripDays` reads the NEW width, so growing a stats widget can
     * reveal more of the strip without waiting for one of the five broader
     * triggers.
     */
    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        async {
            val settings = Settings(context.applicationContext)
            val record = settings.cachedWidget(appWidgetId) ?: return@async
            val columns = columnsFor(newOptions)
            val today = LocalDate.now().toString()
            appWidgetManager.updateAppWidget(appWidgetId, render(context, record, today, columns))
        }
    }

    /** See `HabitWidget.async` — the same reason, the same shape. */
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

    companion object {

        /** The provider XML's own `minWidth`, for an options bundle that has not reported one yet. */
        private const val DEFAULT_MIN_WIDTH_DP = 180

        /**
         * The strip's column count for an options [Bundle] — [onAppWidgetOptionsChanged]'s
         * own, or `HabitWidget.redraw`'s read of `AppWidgetManager.getAppWidgetOptions`
         * for a widget it did not just hear a resize from. One function so the
         * two readers cannot answer "how wide is this widget" two different
         * ways; a null or zero-width bundle — never yet reported, or a
         * launcher that supplies none — falls back to [DEFAULT_MIN_WIDTH_DP]
         * rather than asking [Widgets.stripDays] for zero cells.
         */
        internal fun columnsFor(options: Bundle?): Int {
            val minWidth = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0) ?: 0
            return Widgets.stripDays(if (minWidth > 0) minWidth else DEFAULT_MIN_WIDTH_DP)
        }

        /**
         * What one stats widget looks like.
         *
         * No `questionMarks` parameter: the strip has no glyphs at ~20dp a
         * cell, so there is nothing for the setting to govern and the tap
         * cycle it would otherwise feed is unreachable from a read-only
         * widget (see the KDoc on `Widgets.stripStates`).
         */
        fun render(
            context: Context,
            record: Widgets.Record,
            today: String,
            columns: Int,
        ): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_stats)
            views.setTextViewText(R.id.stats_name, record.name)

            val scorePercent = (record.score * 100).roundToInt().coerceIn(0, 100)
            views.setTextViewText(R.id.stats_score, "$scorePercent%")
            views.setProgressBar(R.id.stats_score_bar, 100, scorePercent, false)
            views.setTextViewText(R.id.stats_streak, "🔥 ${record.currentStreak}")
            // Absent at zero rather than shown as "🔥 0", the same rule
            // `DayGrid.kt` draws the app's own streak by: a habit with no
            // streak has nothing to report, and the widget claiming an
            // indicator the app itself withholds is the small inconsistency
            // this repo treats as a defect.
            views.setViewVisibility(
                R.id.stats_streak,
                if (record.currentStreak > 0) android.view.View.VISIBLE else android.view.View.GONE,
            )

            // `gone` beats `stale` on the note line, the same precedent
            // `HabitWidget.render` follows: a habit that has left the account
            // is a stronger and more actionable claim than "these figures are
            // a day old", and both cannot be shown in one line.
            val stale = record.date != today
            views.setViewVisibility(
                R.id.stats_note,
                if (record.gone || stale) android.view.View.VISIBLE else android.view.View.GONE,
            )
            if (record.gone) {
                views.setTextViewText(R.id.stats_note, context.getString(R.string.widget_gone_short))
            } else if (stale) {
                views.setTextViewText(
                    R.id.stats_note,
                    context.getString(R.string.stats_stale, record.date),
                )
            }

            val states = Widgets.stripStates(record, today, columns)
            val history = Widgets.decodeHistory(record.history)
            val habit = record.habit
            CELL_IDS.forEachIndexed { index, cellId ->
                if (index >= states.size) {
                    views.setViewVisibility(cellId, android.view.View.GONE)
                    return@forEachIndexed
                }
                views.setViewVisibility(cellId, android.view.View.VISIBLE)
                val (date, state) = states[index]
                val tint = if (record.gone) {
                    // A gone record keeps its last figures in storage
                    // (`Widgets.refreshedOrGone` leaves them), so the strip is
                    // blanked here rather than drawn as if it were current —
                    // the note line already carries the explanation, and
                    // painting the old strip beside it would be a second,
                    // contradicting claim about the same widget.
                    ContextCompat.getColor(context, R.color.widget_cell_empty)
                } else {
                    // `record.date` itself is the one exception `stripStates`
                    // already carves out — read from `record.value`, not
                    // `history` — and the value has to follow the same
                    // exception here, or the FULL/PARTIAL shading below would
                    // go back to reading one day's number for every cell,
                    // which is the bug finding (a) named.
                    val value = if (date == record.date) record.value else history[date]?.first
                    HabitWidget.fill(context, habit, record.color, state, value)
                }
                views.setInt(cellId, "setColorFilter", tint)
                // `HabitWidget.describe` says WHAT a day was and stays right
                // for the checkmark widget's one cell; a strip of up to seven
                // needs to say WHICH day too, or a screen reader swiping
                // across it hears the same sentence seven times with nothing
                // to tell the days apart. `describe` itself is left alone —
                // the date is prepended here, at the strip's own call site.
                views.setContentDescription(
                    cellId,
                    "$date: ${HabitWidget.describe(context, record, state)}",
                )
            }

            views.setContentDescription(
                R.id.stats_root,
                if (record.gone) context.getString(R.string.widget_gone, record.name)
                // Through `strings.xml`, positionally, the way every other
                // spoken sentence here is built — `${...}` concatenation was
                // the one place on this screen that was not.
                else context.getString(R.string.stats_summary, record.name, scorePercent, record.currentStreak),
            )
            views.setOnClickPendingIntent(R.id.stats_root, clickIntent(context, record))
            return views
        }

        private val CELL_IDS = intArrayOf(
            R.id.stats_cell_0,
            R.id.stats_cell_1,
            R.id.stats_cell_2,
            R.id.stats_cell_3,
            R.id.stats_cell_4,
            R.id.stats_cell_5,
            R.id.stats_cell_6,
        )

        /**
         * Opens the app on this habit — the whole of what a tap does here.
         *
         * Distinct `data` per widget, the same reason `HabitWidget.clickIntent`
         * and the alarms give: `filterEquals` ignores extras, so without this
         * every stats widget — and a stats widget alongside a checkmark widget
         * for the same habit — would collapse onto one PendingIntent. A gone
         * record's tap still opens the app; there is nothing else useful for
         * it to do, and it answers nothing either way, so there is no
         * tappability hazard the checkmark widget's `gone` handling has to
         * repeat here.
         */
        private fun clickIntent(context: Context, record: Widgets.Record): PendingIntent {
            val intent = Intent(context, MainActivity::class.java).apply {
                putExtra(Notifications.EXTRA_HABIT_ID, record.habitId)
                data = android.net.Uri.parse("habiterall://stats/${record.widgetId}")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            return PendingIntent.getActivity(
                context,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }
}
