package com.habiterall.app.widget

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.habiterall.app.R
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Settings
import com.habiterall.app.data.Widgets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDate

/**
 * Asks which habit a newly-placed widget is for — and, for the one provider
 * that needs no such question, seeds it anyway.
 *
 * A list of names in a dialog rather than a screen: it is one question, asked
 * once, from the launcher — the same shape `CountEntryActivity` uses, and for
 * the same reason. It is the ONE part of the widget that needs the server,
 * deliberately: a widget names a habit, and a phone that has never reached the
 * account has no habits to name. Everything after this point works offline.
 *
 * The fetch is the overview rather than the habit list, so the widget can be
 * drawn correctly the instant it is placed instead of waiting for a refresh to
 * tell it what today holds. It asks for [Widgets.MAX_STRIP_DAYS], not one day
 * — a freshly placed STATS widget needs the whole strip populated on the
 * spot, and the checkmark widget draws no differently off a wider window than
 * it did off a narrow one, so there is no cost to widening the fetch for both.
 * [OverviewWidget] draws at most [Widgets.MAX_STRIP_DAYS] columns too, so the
 * same window fills its widest grid.
 *
 * [OverviewWidget] takes this activity's every failure path and none of its
 * question. It names no habit, so there is nothing to pick — but it has the
 * identical need of the server, and with no configuration step at all it would
 * sit blank until `ScheduleWorker`'s six-hourly heartbeat, with nothing on
 * screen to say that no server was ever configured. So the branch is one
 * question of the launcher (which provider owns this id) and then a seed rather
 * than a dialog, and `api == null`, a failed fetch and an empty account still
 * report exactly as they do for the other two.
 */
class WidgetConfigActivity : ComponentActivity() {

    /**
     * Held so it can be dismissed in [onDestroy]: a dialog belonging to an
     * activity that is going away leaks its window, and a rotation is enough to
     * do it.
     */
    private var dialog: AlertDialog? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val widgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID,
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID

        // CANCELLED first and always: a configuration activity that finishes
        // any other way without saying so leaves the launcher holding a widget
        // that was never configured.
        setResult(Activity.RESULT_CANCELED, Intent().putExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId
        ))
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }

        lifecycleScope.launch {
            val settings = Settings(applicationContext)
            val api = withContext(Dispatchers.IO) { settings.api() }
            if (api == null) {
                fail(R.string.widget_needs_server)
                return@launch
            }

            val habits = withContext(Dispatchers.IO) {
                runCatching { api.overview(days = Widgets.MAX_STRIP_DAYS).habits.filter { !it.archived } }
                    .getOrNull()
            }
            if (habits == null) {
                fail(R.string.widget_needs_network)
                return@launch
            }
            if (habits.isEmpty()) {
                fail(R.string.widget_no_habits)
                return@launch
            }
            val manager = AppWidgetManager.getInstance(this@WidgetConfigActivity)
            if (isOverview(manager, widgetId)) seed(widgetId, habits) else choose(widgetId, habits)
        }
    }

    /**
     * Every non-archived habit, in the order the server served them, written as
     * this widget's whole set.
     *
     * `reconcileOverview` from an EMPTY existing set rather than a hand-rolled
     * loop here, so that placing a widget and refreshing one take the same
     * decision about which habits, in what order and with what rank — the rule
     * lives in one pure function, and this activity is not a second opinion
     * about it.
     */
    private suspend fun seed(widgetId: Int, habits: List<Habit>) {
        val today = LocalDate.now().toString()
        withContext(Dispatchers.IO) {
            Settings(applicationContext).putWidgetSet(
                widgetId,
                Widgets.reconcileOverview(emptyList(), widgetId, habits, today),
            )
            HabitWidget.redraw(applicationContext)
        }
        setResult(Activity.RESULT_OK, Intent().putExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId
        ))
        finish()
    }

    private fun choose(widgetId: Int, habits: List<Habit>) {
        val names = habits.map { it.name }.toTypedArray()
        dialog = AlertDialog.Builder(this)
            .setTitle(R.string.widget_pick_habit)
            .setItems(names) { _, which ->
                lifecycleScope.launch {
                    val today = LocalDate.now().toString()
                    val habit = habits[which]
                    val record =
                        Widgets.refreshed(Widgets.blank(widgetId, habit.id), habit, today)
                    withContext(Dispatchers.IO) {
                        // `putWidgetSet`, not `putWidgets`: this activity is
                        // reachable a second time (`widgetFeatures="reconfigurable"`),
                        // and pointing the widget at a different habit has to
                        // take the old habit's record away with it. `putWidgets`
                        // merges per (widget, habit), so it would leave both and
                        // `cachedWidget`'s `firstOrNull` could answer the habit
                        // this widget no longer shows — a tick painted for one
                        // habit and recorded against another.
                        Settings(applicationContext).putWidgetSet(widgetId, listOf(record))
                        HabitWidget.redraw(applicationContext)
                    }
                    setResult(Activity.RESULT_OK, Intent().putExtra(
                        AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId
                    ))
                    finish()
                }
            }
            .setOnCancelListener { finish() }
            .show()
    }

    override fun onDestroy() {
        dialog?.dismiss()
        dialog = null
        super.onDestroy()
    }

    private fun fail(message: Int) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        finish()
    }

    companion object {

        /**
         * Which of the three providers owns this id — asked of the LAUNCHER
         * rather than of the intent, because the widget id is the only thing a
         * configuration activity is told and `getAppWidgetInfo` is what turns
         * it back into the provider that holds it.
         *
         * `internal`, and taking the manager rather than reading it off `this`,
         * for the reason `HabitList` and `ManageScreen` are: this is the ONE
         * path by which an overview widget ever acquires records, and a
         * predicate embedded in an activity is a decision no test can reach.
         * Every way of being wrong here is silent — `shortClassName` (`.widget
         * .OverviewWidget`) rather than `className`, the ComponentName's own
         * `toString`, or the other provider's name — and each one sends a
         * freshly placed overview widget into the habit PICKER, which seeds it
         * one single-habit record and leaves a grid with one row in it.
         *
         * A null info — an id the launcher has already dropped — answers false
         * and falls through to the picker, which then finishes CANCELLED like
         * any other failure path here.
         */
        internal fun isOverview(manager: AppWidgetManager, widgetId: Int): Boolean =
            manager.getAppWidgetInfo(widgetId)?.provider?.className ==
                OverviewWidget::class.java.name
    }
}
