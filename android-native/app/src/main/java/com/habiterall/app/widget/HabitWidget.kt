package com.habiterall.app.widget

import android.app.AlarmManager
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
import com.habiterall.app.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

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
        async {
            Settings(context.applicationContext).removeWidgets(appWidgetIds.toList())
            // Which may have been the last one, and `redraw` gives the midnight
            // alarm back to the system when none are left.
            redraw(context)
        }
    }

    /**
     * A restore has handed this app's widgets new ids.
     *
     * The default implementation does nothing, and doing nothing is fatal: the
     * DataStore comes back from the backup naming the ids of the phone it left,
     * `redraw` matches none of them, and every widget on the new device is
     * permanently blank and unpressable. This is the one place the system says
     * which old id became which new one.
     */
    override fun onRestored(context: Context, oldWidgetIds: IntArray, newWidgetIds: IntArray) {
        async {
            val settings = Settings(context.applicationContext)
            val moved = Widgets.remap(settings.cachedWidgets(), oldWidgetIds, newWidgetIds)
            settings.replaceWidgets(moved)
            redraw(context)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        // Dispatches APPWIDGET_UPDATE, APPWIDGET_DELETED and APPWIDGET_RESTORED
        // to the three above.
        super.onReceive(context, intent)

        when (intent.action) {
            ACTION_TAP -> {
                val widgetId = intent.getIntExtra(
                    AppWidgetManager.EXTRA_APPWIDGET_ID,
                    AppWidgetManager.INVALID_APPWIDGET_ID,
                )
                if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) async { tap(context, widgetId) }
            }

            // Midnight, from our own alarm — and it has to be an alarm.
            // `ACTION_DATE_CHANGED` was here and is NOT on Android's
            // implicit-broadcast exception list, so a manifest-registered
            // receiver has never once been told about midnight on any device
            // this app supports: the only trigger aimed at the problem was dead
            // code that looked right. `redraw` re-arms, because an alarm is
            // one-shot.
            //
            // The other two ARE on the list and are kept: they change what
            // "today" is without a midnight passing, and they invalidate the
            // alarm that was armed for the old clock.
            // Midnight only redraws. It used to reschedule the reminders too,
            // under a comment about clock changes — but midnight is not a clock
            // change, and `rescheduleAll` enqueues a network-constrained
            // worker, so every phone with a widget made a sync at 00:00 for no
            // reason.
            ACTION_MIDNIGHT -> async { redraw(context) }

            // A clock change is the other thing, and it moves the reminders as
            // well as the day. Held open by the same `async`, where before the
            // reschedule was launched into a process free to die.
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED -> async {
                redraw(context)
                suspendCancellableReschedule(context)
            }
        }
    }

    /** `Reminders.rescheduleAll` with its callback bridged into a suspend. */
    private suspend fun suspendCancellableReschedule(context: Context) =
        kotlin.coroutines.suspendCoroutine { cont ->
            Reminders.rescheduleAll(context) { cont.resumeWith(Result.success(Unit)) }
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
        // Null for a habit that has left the account: the click intent is
        // already gone, but a PendingIntent the launcher took a copy of
        // outlives the drawing it came with, so the rule is asked again here.
        val tap = Widgets.tap(
            record,
            today,
            skipDays = settings.cachedSkipDays(),
            questionMarks = settings.cachedQuestionMarks(),
        ) ?: return

        // Queue first, paint second: the queue is what makes the answer true,
        // and a paint that got ahead of a throw would show one that is not.
        Outbox.enqueue(app, record.habitId, today, tap.value, tap.skip)
        settings.putWidgets(listOf(Widgets.answered(record, today, tap.value, tap.skip)))
        redraw(app)
    }

    companion object {

        private const val ACTION_TAP = "com.habiterall.app.WIDGET_TAP"

        /** Our own midnight, because the platform's broadcast never arrives. */
        const val ACTION_MIDNIGHT = "com.habiterall.app.WIDGET_MIDNIGHT"

        /** A slip, in the same red the day grid paints one. */
        private const val SLIP = 0xFFDC2626.toInt()

        /**
         * Redraw every widget from the cache, and arm the next midnight.
         *
         * Only the ids the launcher still has: a record can outlive its widget
         * if the process died between the deletion and [onDeleted], and
         * updating an id nobody holds throws.
         *
         * The alarm is armed HERE rather than at each of the places that can
         * create a widget, because every one of them redraws and an alarm that
         * re-arms from the drawing cannot drift out of step with what is on the
         * screen. With no widgets left it is given back instead of renewed.
         */
        suspend fun redraw(context: Context) {
            val app = context.applicationContext
            val manager = AppWidgetManager.getInstance(app)
            val live = manager
                .getAppWidgetIds(ComponentName(app, HabitWidget::class.java))
                .toSet()
            armMidnight(app)
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
         * Arm — or give back — the alarm that redraws at the next local
         * midnight.
         *
         * A widget's day goes stale at midnight and nothing tells it. The
         * platform's `ACTION_DATE_CHANGED` looks like the answer and is not:
         * it is not on the implicit-broadcast exception list, so a
         * manifest-registered receiver is never sent it on any version this app
         * supports. `TIME_SET` and `TIMEZONE_CHANGED` *are* on the list, which
         * is exactly why the wrong version of this passes a shell test.
         *
         * So it is an alarm, through the same `Reminders.setAlarm` a reminder
         * uses: exact where the user has allowed exact alarms, inexact where
         * they have not. Above 32 the app holds `USE_EXACT_ALARM`, granted at
         * install with nothing to have allowed, so there is no toggle to check —
         * the refused case is narrowed to 31-32, where `SCHEDULE_EXACT_ALARM`
         * is still the user-revocable permission this arms against. Measured,
         * because the inexact form looked good enough and is not — an alarm set
         * 23 hours out gets a window of an HOUR, on the one alarm whose entire
         * purpose is a date boundary, so the widget would go on showing
         * yesterday until 01:00. Where exact alarms are refused that is still
         * the behaviour, and the other triggers below are what bound it.
         *
         * `updatePeriodMillis` in the provider XML is underneath it and is NOT
         * a substitute: those updates ride an inexact alarm too and Doze defers
         * them across the night, so overnight the redraw lands on wake.
         */
        fun armMidnight(context: Context) {
            val app = context.applicationContext
            val manager = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            // Asked here rather than passed in, so that every caller — a
            // redraw, a boot, the exact-alarm permission changing — is one line
            // and none of them has to know how to answer it.
            val wanted = AppWidgetManager.getInstance(app)
                .getAppWidgetIds(ComponentName(app, HabitWidget::class.java))
                .isNotEmpty()
            val intent = Intent(app, HabitWidget::class.java).apply {
                action = ACTION_MIDNIGHT
                data = android.net.Uri.parse("habiterall://widget/midnight")
            }
            if (!wanted) {
                PendingIntent.getBroadcast(
                    app,
                    0,
                    intent,
                    PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
                )?.let { manager.cancel(it) }
                return
            }
            val at = Widgets.nextMidnight(ZonedDateTime.now(ZoneId.systemDefault()))
            Reminders.setAlarm(
                app,
                at.toInstant().toEpochMilli(),
                PendingIntent.getBroadcast(
                    app,
                    0,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
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
            val filled = !record.gone && (
                state == Grid.DayState.DONE || (state == Grid.DayState.NO && habit.isAvoided)
            )

            val views = RemoteViews(context.packageName, R.layout.widget_habit)
            views.setTextViewText(R.id.widget_name, record.name)

            // A habit that has left the account has to be VISIBLY different,
            // and this is where an earlier version stopped short: the sentence
            // went to `setContentDescription` and nowhere else, so on the day
            // it was archived the cell was pixel-identical to a live habit
            // answered done — full colour, a tick — and the day after it was a
            // blank cell under the habit's name. The only change a sighted user
            // could see was that tapping it opened the app, which reads as a
            // bug rather than as an explanation. A `uiautomator dump` prints
            // the accessibility node, so it showed the sentence and looked
            // right; the dump is not the screen.
            views.setViewVisibility(
                R.id.widget_note,
                if (record.gone) android.view.View.VISIBLE else android.view.View.GONE,
            )
            if (record.gone) {
                views.setTextViewText(R.id.widget_note, context.getString(R.string.widget_gone_short))
            }
            // And the cell says nothing rather than repeating whatever the day
            // held when the habit was still there.
            views.setTextViewText(
                R.id.widget_mark,
                if (record.gone) "" else Widgets.markFor(record, state, questionMarks),
            )
            views.setInt(
                R.id.widget_cell,
                "setColorFilter",
                if (record.gone) ContextCompat.getColor(context, R.color.widget_cell_empty)
                else fill(context, record, state),
            )
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

        private fun describe(
            context: Context,
            record: Widgets.Record,
            state: Grid.DayState,
        ): String {
            if (record.gone) return context.getString(R.string.widget_gone, record.name)
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

            // A habit that has left the account cannot be answered, so the tap
            // opens the app instead of recording — where the user can see that
            // it is gone and take the widget off. Doing nothing would be worse
            // than either: the launcher goes on drawing a live-looking cell,
            // and a tap that produces no effect at all reads as a broken app
            // rather than as a removed habit.
            if (record.gone) {
                val intent = Intent(context, MainActivity::class.java).apply {
                    data = android.net.Uri.parse("habiterall://widget/${record.widgetId}/gone")
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
                return PendingIntent.getActivity(context, 0, intent, pi)
            }

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
