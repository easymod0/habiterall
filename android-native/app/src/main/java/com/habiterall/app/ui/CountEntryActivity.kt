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
        val date = intent.getStringExtra(Notifications.EXTRA_DATE)
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
                    Toast.makeText(this, R.string.recorded_yes, Toast.LENGTH_SHORT).show()
                }
                finish()
            }
            .setNegativeButton(R.string.cancel) { _, _ -> finish() }
            .setOnCancelListener { finish() }
            .show()
    }

    /** 8.0 -> "8", 12.5 -> "12.5" — an integer target should not read as a decimal. */
    private fun trimNumber(n: Double): String =
        if (n == n.toLong().toDouble()) n.toLong().toString() else n.toString()
}
