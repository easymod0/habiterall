package com.habiterall.app.data

import android.content.Context
import com.habiterall.app.notify.ReminderTime
import com.habiterall.app.widget.HabitWidget
import java.time.Clock
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Where this account's day ends (#76), held where every reader can get at it
 * with no suspend call and no network.
 *
 * The rule is [ReminderTime.effectiveDay]; this is its HOLDER, and the one
 * answer to "what day is it" that every site on this client asks — a tap, a
 * widget, a reminder's alarm, the grid's newest column. `LocalDate.now()` is
 * the calendar's day and is wrong for an account whose day ends at 03:00.
 *
 * **SharedPreferences, and not [Settings]'s DataStore, on purpose.** DataStore
 * is asynchronous, and four of the readers here have no suspend path to reach
 * it from: the OkHttp interceptor that stamps every request, the first
 * composition of the list (which must not paint a frame on the wrong day and
 * then correct it), `dayLabel`, and `ActionReceiver`'s snooze. A blocking read
 * from any of them is an ANR waiting on a slow disk. One string, read once in
 * [load] and then served from memory, needs nothing DataStore is for.
 *
 * It is a mirror of the server's SETTING, not a cache of its habits: the server
 * wins, [adopt] is how it is told, and an account that has never changed it
 * stays at midnight, which is every behaviour from before the setting existed.
 */
object DayEnd {

    private const val PREFS = "habiterall_day"
    private const val KEY = "dayEndsAt"

    @Volatile
    private var held: String = ReminderTime.DEFAULT_DAY_END

    /** The boundary in force, always one of [ReminderTime.DAY_END_TIMES]. */
    val current: String get() = held

    /**
     * The clock every "now" here is read from. A test seam and nothing else:
     * `java.time` is not instrumented by Robolectric, so a wiring test has no
     * other way to be at 00:30. Production never writes it, so it is null; a
     * test that does puts it back to null in `@After`.
     *
     * It is null, and not a stored `Clock.systemDefaultZone()`, because that
     * captures the zone when it is BUILT — once, at class load — and a phone
     * that changes zone with the process alive (a flight; `TIMEZONE_CHANGED`
     * redraws but the process lives) would keep the old zone for [today] and
     * every alarm. `ZoneId.systemDefault()` is asked on every call.
     */
    @Volatile
    internal var clock: Clock? = null

    fun now(): ZonedDateTime =
        clock?.let { ZonedDateTime.now(it) } ?: ZonedDateTime.now(ZoneId.systemDefault())

    /**
     * The date this account is on, as 'YYYY-MM-DD'.
     *
     * Wall-clock minutes against the boundary, read once from [now]'s own local
     * time — never `now` minus the boundary, which is an hour out twice a year.
     */
    fun today(now: ZonedDateTime = now()): String {
        val time = now.toLocalTime()
        return ReminderTime.effectiveDay(now.toLocalDate(), time.hour * 60 + time.minute, held)
            .date.toString()
    }

    /** Anything not in the list is midnight, so a damaged file cannot move the day. */
    private fun normalise(value: String?): String =
        if (value != null && value in ReminderTime.DAY_END_TIMES) value
        else ReminderTime.DEFAULT_DAY_END

    /**
     * Read what was last [adopt]ed. First thing in `HabiterallApp.onCreate`: an
     * alarm or a widget drawn before this runs would use midnight.
     */
    fun load(context: Context) {
        held = normalise(
            context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY, null)
        )
    }

    /**
     * Take the server's answer, and be the ONE place that does.
     *
     * @return true when it changed. A change redraws the widgets, and that is
     *   the whole reason this is a single entry rather than a setter: the
     *   widgets paint a date, and the midnight alarm is aimed at the boundary,
     *   so a new boundary with the old frame on the screen shows the wrong day
     *   until the next scheduled redraw — which was aimed at the OLD boundary.
     *   `redraw` re-arms the alarm as well as drawing. Unchanged is false and
     *   does nothing, because every list fetch and every worker run calls this.
     */
    suspend fun adopt(context: Context, value: String): Boolean {
        val next = normalise(value)
        if (next == held) return false
        val app = context.applicationContext
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, next).apply()
        held = next
        HabitWidget.redraw(app)
        return true
    }
}
