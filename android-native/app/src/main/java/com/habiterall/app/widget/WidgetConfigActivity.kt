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
 * Asks which habit a newly-placed widget is for.
 *
 * A list of names in a dialog rather than a screen: it is one question, asked
 * once, from the launcher — the same shape `CountEntryActivity` uses, and for
 * the same reason. It is the ONE part of the widget that needs the server,
 * deliberately: a widget names a habit, and a phone that has never reached the
 * account has no habits to name. Everything after this point works offline.
 *
 * The fetch is the overview rather than the habit list, so the widget can be
 * drawn correctly the instant it is placed instead of waiting for a refresh to
 * tell it what today holds.
 */
class WidgetConfigActivity : ComponentActivity() {

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
                runCatching { api.overview(days = 1).habits.filter { !it.archived } }
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
            choose(widgetId, habits)
        }
    }

    private fun choose(widgetId: Int, habits: List<Habit>) {
        val names = habits.map { it.name }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle(R.string.widget_pick_habit)
            .setItems(names) { _, which ->
                lifecycleScope.launch {
                    val today = LocalDate.now().toString()
                    val habit = habits[which]
                    val record = Widgets.refreshed(blank(widgetId, habit.id), habit, today)
                    withContext(Dispatchers.IO) {
                        Settings(applicationContext).putWidgets(listOf(record))
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

    /**
     * An empty record for [Widgets.refreshed] to fill.
     *
     * Every field it leaves alone is one the server is about to supply, so
     * there is no second place that decides what a record starts as.
     */
    private fun blank(widgetId: Int, habitId: Long) = Widgets.Record(
        widgetId = widgetId,
        habitId = habitId,
        name = "",
        type = "boolean",
        targetValue = 0.0,
        targetType = "at_least",
        showAs = "amount",
        color = "",
        unit = "",
        date = "",
        value = null,
        skip = false,
    )

    private fun fail(message: Int) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        finish()
    }
}
