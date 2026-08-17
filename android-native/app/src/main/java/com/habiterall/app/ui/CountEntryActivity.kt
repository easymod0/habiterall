package com.habiterall.app.ui

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.text.InputType
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import com.habiterall.app.R
import com.habiterall.app.data.Outbox
import com.habiterall.app.notify.Notifications
import com.habiterall.app.widget.WidgetSync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.LocalDate

/**
 * Collects a number for a measurable habit.
 *
 * A notification action cannot take arbitrary input, so tapping "Enter count"
 * opens this — a bare dialog over whatever is on screen, excluded from
 * recents, so it reads as part of the shade rather than a trip into the app.
 */
class CountEntryActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val habitId = intent.getLongExtra(Notifications.EXTRA_HABIT_ID, -1)
        // A reminder names its day; the home-screen widget asks for "today" and
        // means whichever day it is now — see [Notifications.EXTRA_TODAY]. The
        // flag rather than a missing date, because an absent field is not a
        // statement and inventing a day from one would be exactly that.
        val date = if (intent.getBooleanExtra(Notifications.EXTRA_TODAY, false)) {
            LocalDate.now().toString()
        } else {
            intent.getStringExtra(Notifications.EXTRA_DATE)
        }
        val name = intent.getStringExtra(Notifications.EXTRA_HABIT_NAME) ?: ""
        val unit = intent.getStringExtra(Notifications.EXTRA_UNIT).orEmpty()
        val target = intent.getDoubleExtra(Notifications.EXTRA_TARGET, 0.0)

        if (habitId < 0 || date == null) {
            finish()
            return
        }

        val input = EditText(this).apply {
            // decimal, not just number: amounts like 2.5 km are ordinary.
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
            hint = if (unit.isBlank()) getString(R.string.count_hint) else unit
            setText(if (target > 0) trimNumber(target) else "")
            setSelection(text.length)
        }

        // A bare EditText sits flush against the dialog edges; wrap it so the
        // field has the padding the platform dialogs normally give.
        val pad = (24 * resources.displayMetrics.density).toInt()
        val container = FrameLayout(this).apply {
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
        }

        AlertDialog.Builder(this)
            .setTitle(name)
            .setView(container)
            .setPositiveButton(R.string.save) { _, _ ->
                val value = input.text.toString().trim().toDoubleOrNull()
                if (value == null || value < 0) {
                    Toast.makeText(this, R.string.invalid_amount, Toast.LENGTH_SHORT).show()
                } else {
                    Outbox.enqueue(this, habitId, date, value, skip = false)
                    Notifications.cancel(this, Notifications.notificationId(habitId))
                    // A home-screen widget for this habit is showing the day
                    // this just answered, and nothing else would tell it until
                    // the next refresh — which offline is hours.
                    noteWidgets(habitId, date, value)
                    Toast.makeText(this, R.string.recorded_yes, Toast.LENGTH_SHORT).show()
                }
                finish()
            }
            .setNegativeButton(R.string.cancel) { _, _ -> finish() }
            .setOnCancelListener { finish() }
            .show()
    }

    /**
     * Paint the amount onto any widget for this habit.
     *
     * Fire and forget on the application context, because this activity is
     * finishing: the write itself is already durable in the outbox, and all
     * this can lose is a repaint the next refresh makes anyway.
     */
    private fun noteWidgets(habitId: Long, date: String, value: Double) {
        val app = applicationContext
        CoroutineScope(Dispatchers.IO).launch {
            WidgetSync.noteAnswer(app, habitId, date, value, skip = false)
        }
    }

    /** 8.0 -> "8", 12.5 -> "12.5" — an integer target should not read as a decimal. */
    private fun trimNumber(n: Double): String =
        if (n == n.toLong().toDouble()) n.toLong().toString() else n.toString()
}
