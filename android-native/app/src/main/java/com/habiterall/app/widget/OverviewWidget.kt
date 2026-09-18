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
import java.time.format.TextStyle
import java.util.Locale

/**
 * Every habit down one side, the last few days across — the dashboard's grid
 * at widget size, read-only. A tap on a row opens the app on that habit; the
 * widget itself answers nothing.
 *
 * A THIRD provider over [Widgets.Record]'s ONE store, and still not a third
 * cache. What it needed was to relax "one record per widget id" to one per
 * `(widgetId, habitId)` — `Settings.putWidgets`, plus [Settings.putWidgetSet]
 * for "these are this widget's habits now". Every field of `Record` means the
 * same thing for an overview row as it does for a checkmark widget, and a
 * second record type would have had to re-implement `remap`/`onRestored`,
 * `refreshedOrGone` and the encode/decode fail-safes — three hard-won
 * mechanisms, and exactly where this package's bugs have lived.
 *
 * **Name and cells only: no score number, no streak number.** With a name
 * column and up to seven day columns there is no room for a figure, and the
 * per-habit `StatsWidget` is the surface where a number lives. A direct
 * consequence, stated here because a reader would otherwise think it was
 * forgotten: **this widget never reads [Widgets.Record.figuresStale]**. That
 * flag exists because `StatsWidget` PAINTS `score` and `currentStreak`, which
 * `Widgets.answered` can move out of date with no fetch behind them. Nothing
 * on this screen is one of those figures, so the flag says nothing about
 * anything drawn here. What the note line DOES report is [Widgets.Record.date]
 * staleness, which is a claim about the grid itself: a record not refreshed
 * today has no data for today's column, so it paints UNKNOWN — which is
 * indistinguishable from "answered nothing today" until the line says
 * otherwise.
 */
class OverviewWidget : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        // The same central redraw the other two providers use — one function
        // that knows which renderer belongs to which widget id, not a third
        // copy of the drawing loop.
        async { HabitWidget.redraw(context) }
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        async {
            // `removeWidgets` filters by widget id, so it already takes every
            // one of an overview widget's N records rather than one of them.
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
            // No `ACTION_MIDNIGHT` case, for the reason `StatsWidget` states:
            // the midnight alarm is the ONE alarm `HabitWidget.armMidnight`
            // arms, and its handler redraws every provider. A clock change
            // needs only a redraw here too — every date this grid draws is a
            // function of `today`.
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED -> async { HabitWidget.redraw(context) }
        }
    }

    /**
     * A resize is the one thing only this widget's own instance hears about,
     * and it reads BOTH dimensions where `StatsWidget` reads only width: the
     * height decides how many habits are listed and the width how many days
     * are drawn across each of them.
     */
    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        async { resized(context, appWidgetManager, appWidgetId, newOptions) }
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
        private const val DEFAULT_MIN_WIDTH_DP = 250

        /** The provider XML's own `minHeight`, for the same reason. */
        private const val DEFAULT_MIN_HEIGHT_DP = 180

        /**
         * How many day columns an options [Bundle] asks for, and how many
         * habit rows.
         *
         * Two readers, as on `StatsWidget`: [onAppWidgetOptionsChanged]'s own
         * bundle, and `HabitWidget.redraw`'s read of
         * `AppWidgetManager.getAppWidgetOptions` for a widget it did not just
         * hear a resize from. One function each so the two cannot answer "how
         * big is this widget" two different ways; a null or zero bundle — never
         * yet reported, or a launcher that supplies none — falls back to the
         * provider XML's own size rather than asking for zero cells.
         */
        internal fun columnsFor(options: Bundle?): Int {
            val minWidth = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0) ?: 0
            return Widgets.overviewColumns(if (minWidth > 0) minWidth else DEFAULT_MIN_WIDTH_DP)
        }

        internal fun rowsFor(options: Bundle?): Int {
            val minHeight = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0) ?: 0
            return Widgets.overviewRows(if (minHeight > 0) minHeight else DEFAULT_MIN_HEIGHT_DP)
        }

        /**
         * Re-draw one widget at the size the launcher has just reported.
         *
         * A companion function rather than the body of
         * [onAppWidgetOptionsChanged], for the reason `HabitWidget.redraw` is
         * one: the override is a `goAsync()` wrapper a test cannot enter
         * without a real broadcast dispatch, and everything it decides is here.
         */
        internal suspend fun resized(
            context: Context,
            manager: AppWidgetManager,
            widgetId: Int,
            options: Bundle?,
        ) {
            val app = context.applicationContext
            val records = Settings(app).cachedWidgetSet(widgetId)
            if (records.isEmpty()) return
            manager.updateAppWidget(
                widgetId,
                render(
                    app,
                    records,
                    LocalDate.now().toString(),
                    rows = rowsFor(options),
                    columns = columnsFor(options),
                ),
            )
        }

        /**
         * What one overview widget looks like.
         *
         * [records] is the widget's whole set, in whatever order the store
         * handed them back — which is not an ordering signal, because
         * `Settings.putWidgetSet` writes a widget's records at the TAIL of the
         * blob. The rows are sorted by [Widgets.Record.rank], the index the
         * habit held in the `/api/overview` reply, so the widget agrees with
         * the app's own list by construction rather than by a second sort here.
         *
         * A `gone` record is not drawn and the rows below it close up. That is
         * a deliberate difference from the two single-habit widgets, which say
         * "Removed" instead: hiding the one thing on THEIR screen would leave a
         * blank widget with nothing to explain it, whereas here the overview is
         * "your habits" and a habit that has left the account is not one of
         * them — the disappearing row IS the signal. The filter is here as well
         * as in `Widgets.reconcileOverview` because `WidgetSync.refreshFrom`
         * marks records gone knowing nothing about overview widgets, so a gone
         * record can sit in the store between a refresh and the next reconcile.
         */
        fun render(
            context: Context,
            records: List<Widgets.Record>,
            today: String,
            rows: Int,
            columns: Int,
        ): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_overview)
            val ordered = records.filterNot { it.gone }.sortedBy { it.rank }
            val shown = ordered.take(rows)

            drawDayHeader(context, views, today, columns)

            ROW_IDS.forEachIndexed { index, rowId ->
                val record = shown.getOrNull(index)
                if (record == null) {
                    views.setViewVisibility(rowId, android.view.View.GONE)
                    return@forEachIndexed
                }
                views.setViewVisibility(rowId, android.view.View.VISIBLE)
                views.setTextViewText(NAME_IDS[index], record.name)
                drawCells(context, views, index, record, today, columns)
                views.setOnClickPendingIntent(rowId, clickIntent(context, record))
            }

            // `gone` beats everything else on the note line, exactly as it does
            // on the stats widget's — except that here a gone record is not
            // drawn at all, so the only way it reaches this line is by taking
            // the whole grid with it, which is the empty case below.
            //
            // The dated case asks the OLDEST record drawn, not the newest: "as
            // of" is a claim about every row above it, and one row a day behind
            // the rest makes the newest date a false claim about that row. Over
            // -reporting staleness is the fail-safe direction, the same one
            // `figuresStale` takes on the stats widget.
            val asOf = shown.map { it.date }.filter { it.isNotEmpty() }.minOrNull()
            views.setViewVisibility(
                R.id.overview_note,
                if (shown.isEmpty() || (asOf != null && asOf != today)) {
                    android.view.View.VISIBLE
                } else {
                    android.view.View.GONE
                },
            )
            if (shown.isEmpty()) {
                // A brand-new account, or every habit archived. The grid is
                // then blank with nothing on it able to say why — the same
                // mistake the checkmark widget's gone note was added to fix,
                // and the reason this is a real view rather than a content
                // description.
                views.setTextViewText(R.id.overview_note, context.getString(R.string.overview_empty))
            } else if (asOf != null && asOf != today) {
                views.setTextViewText(
                    R.id.overview_note,
                    context.getString(R.string.overview_stale, asOf),
                )
            }

            // The widget must not pretend it is showing all of them. Counted
            // against `ordered` rather than `records`, so a habit that has left
            // the account is not reported as one the widget merely had no room
            // for.
            val hidden = ordered.size - shown.size
            views.setViewVisibility(
                R.id.overview_more,
                if (hidden > 0) android.view.View.VISIBLE else android.view.View.GONE,
            )
            if (hidden > 0) {
                views.setTextViewText(
                    R.id.overview_more,
                    context.resources.getQuantityString(R.plurals.overview_more, hidden, hidden),
                )
            }

            views.setContentDescription(
                R.id.overview_root,
                context.getString(R.string.overview_summary, shown.size, ordered.size),
            )
            return views
        }

        /**
         * The narrow weekday initials above the columns, oldest on the left.
         *
         * `minSdk` is 26, so `java.time` is here unconditionally and the
         * locale's own initials come from it rather than from a hand-written
         * seven-string array that would be English on every phone. Duplicates
         * (T/T, S/S) are accepted: every calendar has them, and each cell's own
         * content description carries the real date.
         *
         * Today's column is emphasised by drawing the other labels at reduced
         * alpha — derived from the themed `widget_text` rather than stated as a
         * second colour resource, so it follows the launcher's light/dark for
         * free. The same technique the strip's partial-credit fill uses.
         */
        private fun drawDayHeader(
            context: Context,
            views: RemoteViews,
            today: String,
            columns: Int,
        ) {
            val end = LocalDate.parse(today)
            val text = ContextCompat.getColor(context, R.color.widget_text)
            val faded = (text and 0x00FFFFFF) or 0x99000000.toInt()
            DAY_IDS.forEachIndexed { index, dayId ->
                if (index >= columns) {
                    views.setViewVisibility(dayId, android.view.View.GONE)
                    return@forEachIndexed
                }
                views.setViewVisibility(dayId, android.view.View.VISIBLE)
                val date = end.minusDays((columns - 1 - index).toLong())
                views.setTextViewText(
                    dayId,
                    date.dayOfWeek.getDisplayName(TextStyle.NARROW, Locale.getDefault()),
                )
                views.setTextColor(dayId, if (index == columns - 1) text else faded)
            }
        }

        /** One habit's row of day cells, oldest on the left, ending at [today]. */
        private fun drawCells(
            context: Context,
            views: RemoteViews,
            row: Int,
            record: Widgets.Record,
            today: String,
            columns: Int,
        ) {
            val states = Widgets.stripStates(record, today, columns)
            val history = Widgets.decodeHistory(record.history)
            val habit = record.habit
            CELL_IDS[row].forEachIndexed { index, cellId ->
                if (index >= states.size) {
                    views.setViewVisibility(cellId, android.view.View.GONE)
                    return@forEachIndexed
                }
                views.setViewVisibility(cellId, android.view.View.VISIBLE)
                val (date, state) = states[index]
                // `record.date` is the one exception `stripStates` already
                // carves out — read from `record.value`, not `history` — and the
                // VALUE has to follow the same exception or every cell in the
                // row is shaded from one day's number. That was one of #332's
                // findings on the stats widget's seven cells; there are seven
                // times as many here.
                val value = if (date == record.date) record.value else history[date]?.first
                // `stripFill`, not `fill`: this grid has no glyphs either, so
                // it needs the ghost-kept arm `Widgets.markFor` draws for the
                // big checkmark cell with a `✓` instead — see the KDoc on
                // `HabitWidget.stripFill`. The avoided-habit inversion (a clean
                // day in the habit's own colour, a slip in red) comes free from
                // the same reuse.
                views.setInt(
                    cellId,
                    "setColorFilter",
                    HabitWidget.stripFill(context, habit, record.color, state, value),
                )
                // `describeStrip`, not `describe`, for the reason the tint
                // above is `stripFill`: a ghost-kept day would otherwise paint
                // kept and announce itself unanswered in the same breath. The
                // date is prepended here, at the grid's own call site, because
                // a screen reader swiping across a row would otherwise hear the
                // same sentence seven times with nothing to tell the days apart.
                views.setContentDescription(
                    cellId,
                    "$date: ${HabitWidget.describeStrip(context, record, state)}",
                )
            }
        }

        private val ROW_IDS = intArrayOf(
            R.id.overview_row_0,
            R.id.overview_row_1,
            R.id.overview_row_2,
            R.id.overview_row_3,
            R.id.overview_row_4,
            R.id.overview_row_5,
            R.id.overview_row_6,
        )

        private val NAME_IDS = intArrayOf(
            R.id.overview_name_0,
            R.id.overview_name_1,
            R.id.overview_name_2,
            R.id.overview_name_3,
            R.id.overview_name_4,
            R.id.overview_name_5,
            R.id.overview_name_6,
        )

        private val DAY_IDS = intArrayOf(
            R.id.overview_day_0,
            R.id.overview_day_1,
            R.id.overview_day_2,
            R.id.overview_day_3,
            R.id.overview_day_4,
            R.id.overview_day_5,
            R.id.overview_day_6,
        )

        /** `CELL_IDS[row][column]`, oldest column on the left. */
        private val CELL_IDS = arrayOf(
            intArrayOf(
                R.id.overview_cell_0_0, R.id.overview_cell_0_1, R.id.overview_cell_0_2,
                R.id.overview_cell_0_3, R.id.overview_cell_0_4, R.id.overview_cell_0_5,
                R.id.overview_cell_0_6,
            ),
            intArrayOf(
                R.id.overview_cell_1_0, R.id.overview_cell_1_1, R.id.overview_cell_1_2,
                R.id.overview_cell_1_3, R.id.overview_cell_1_4, R.id.overview_cell_1_5,
                R.id.overview_cell_1_6,
            ),
            intArrayOf(
                R.id.overview_cell_2_0, R.id.overview_cell_2_1, R.id.overview_cell_2_2,
                R.id.overview_cell_2_3, R.id.overview_cell_2_4, R.id.overview_cell_2_5,
                R.id.overview_cell_2_6,
            ),
            intArrayOf(
                R.id.overview_cell_3_0, R.id.overview_cell_3_1, R.id.overview_cell_3_2,
                R.id.overview_cell_3_3, R.id.overview_cell_3_4, R.id.overview_cell_3_5,
                R.id.overview_cell_3_6,
            ),
            intArrayOf(
                R.id.overview_cell_4_0, R.id.overview_cell_4_1, R.id.overview_cell_4_2,
                R.id.overview_cell_4_3, R.id.overview_cell_4_4, R.id.overview_cell_4_5,
                R.id.overview_cell_4_6,
            ),
            intArrayOf(
                R.id.overview_cell_5_0, R.id.overview_cell_5_1, R.id.overview_cell_5_2,
                R.id.overview_cell_5_3, R.id.overview_cell_5_4, R.id.overview_cell_5_5,
                R.id.overview_cell_5_6,
            ),
            intArrayOf(
                R.id.overview_cell_6_0, R.id.overview_cell_6_1, R.id.overview_cell_6_2,
                R.id.overview_cell_6_3, R.id.overview_cell_6_4, R.id.overview_cell_6_5,
                R.id.overview_cell_6_6,
            ),
        )

        /**
         * Opens the app on THIS row's habit — the whole of what a tap does
         * here, and it is still read-only.
         *
         * Distinct `data` per row, not merely per widget: `filterEquals`
         * ignores extras, so seven rows built from one `Intent` differing only
         * in `EXTRA_HABIT_ID` collapse onto ONE PendingIntent and every row
         * opens whichever habit was drawn last. The checkmark widget and the
         * stats widget both learned the same thing one id coarser
         * (`habiterall://widget/<widgetId>/tap`, `habiterall://stats/<widgetId>`);
         * this widget has N targets inside one widget, so the habit id is in
         * the URI too.
         */
        private fun clickIntent(context: Context, record: Widgets.Record): PendingIntent {
            val intent = Intent(context, MainActivity::class.java).apply {
                putExtra(Notifications.EXTRA_HABIT_ID, record.habitId)
                data = android.net.Uri.parse(
                    "habiterall://overview/${record.widgetId}/${record.habitId}",
                )
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
