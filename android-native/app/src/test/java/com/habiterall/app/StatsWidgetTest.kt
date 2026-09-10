package com.habiterall.app

import android.app.AlarmManager
import android.app.Application
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.RemoteViews
import android.widget.TextView
import androidx.core.content.ContextCompat
import com.habiterall.app.data.Api
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Sentinels
import com.habiterall.app.data.Settings
import com.habiterall.app.data.Widgets
import com.habiterall.app.notify.Reminders
import com.habiterall.app.widget.HabitWidget
import com.habiterall.app.widget.StatsWidget
import com.habiterall.app.widget.WidgetSync
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The stats widget's OWN wiring — what actually reaches the platform, not what
 * a pure function returns. `WidgetTest` pins `Widgets.stripStates`,
 * `Widgets.encodeHistory`/`decodeHistory` and the rest of the record's own
 * arithmetic; none of that proves `StatsWidget.render` wires them up
 * correctly, and this package's repeated lesson is that the gap between the
 * two is exactly where a bug lives — finding (a) in this issue's brief is one:
 * a `fill` that reads `record.value` instead of a per-day value shades every
 * numerical cell in the strip from the SAME day's number, and no test on
 * `Widgets` alone can see that, because `Widgets.stripStates` never calls
 * `fill` at all.
 *
 * So every assertion here is against the INFLATED `RemoteViews`
 * (`render(...).apply(context, null)`), read back with `findViewById`, the
 * same shape `HabitListTest`/`SettingsScreenTest`/`ReminderWiringTest` use for
 * the same reason in this package.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class StatsWidgetTest {

    private val context get() = RuntimeEnvironment.getApplication()

    private val today = "2026-08-16"
    private val yesterday = "2026-08-15"
    private val dayBefore = "2026-08-14"

    /**
     * `Reminders` is an `object`, and Robolectric caches one sandbox per SDK
     * level ACROSS test classes in a JVM fork — `ReminderWiringTest` states
     * the same thing about the same field, which is why the wiring section
     * below (`armMidnight` goes through `Reminders.setAlarm`) has to clear it
     * too, or whichever test in whichever class happened to run first decides
     * this one's outcome.
     */
    @Before
    fun forgetTheLastArm() {
        Reminders.lastArmWasExact = null
    }

    private fun boolHabit() = Habit(id = 1, name = "Meditate")

    private fun waterHabit() =
        Habit(id = 2, name = "Water", type = "numerical", targetValue = 8.0)

    private fun avoidedHabit(): Habit = Habit(
        id = 3,
        name = "Smoking",
        type = "numerical",
        targetValue = 2.0,
        targetType = "at_most",
        showAs = "avoid",
    )

    private fun record(
        habit: Habit,
        widgetId: Int = 7,
        date: String = today,
        value: Double? = null,
        skip: Boolean = false,
        gone: Boolean = false,
        score: Double = 0.0,
        currentStreak: Int = 0,
        history: String = "",
        unloggedIsSuccess: Boolean = false,
        figuresStale: Boolean = false,
    ) = Widgets.Record(
        widgetId = widgetId,
        habitId = habit.id,
        name = habit.name,
        type = habit.type,
        targetValue = habit.targetValue,
        targetType = habit.targetType,
        showAs = habit.showAs,
        color = habit.color,
        unit = habit.unit,
        date = date,
        value = value,
        skip = skip,
        gone = gone,
        score = score,
        currentStreak = currentStreak,
        history = history,
        unloggedIsSuccess = unloggedIsSuccess,
        figuresStale = figuresStale,
    )

    /** `stats_cell_0` .. `stats_cell_6`, oldest to newest — the layout's own order. */
    private val cellIds = intArrayOf(
        R.id.stats_cell_0,
        R.id.stats_cell_1,
        R.id.stats_cell_2,
        R.id.stats_cell_3,
        R.id.stats_cell_4,
        R.id.stats_cell_5,
        R.id.stats_cell_6,
    )

    private fun inflate(views: RemoteViews): View = views.apply(context, null)

    /**
     * The tint an `ImageView`'s `setColorFilter(Int)` actually left behind.
     * `PorterDuffColorFilter.getColor()` is real, public platform API (since
     * API 29) but is not resolvable through this module's compile-time SDK
     * stub for reasons that have nothing to do with the app, so it is read by
     * reflection instead of a cast — the same "read the WIRING, not the
     * decision" reasoning this suite is built on, one layer further down.
     */
    private fun tint(view: ImageView): Int {
        val filter = view.colorFilter ?: return 0
        return filter.javaClass.getMethod("getColor").invoke(filter) as Int
    }

    /**
     * The `Intent` an `EXTRA_APPWIDGET`'s click `PendingIntent` actually
     * starts, read off Robolectric's own record of what `startActivity` was
     * called with — rather than trying to pull the `PendingIntent` back out of
     * an applied `RemoteViews`, which has no supported way to do that. This
     * exercises the exact call a tap makes: `performClick()` on the inflated
     * root triggers the SAME `pendingIntent.send()` a real launcher press does.
     */
    private fun tappedIntent(views: RemoteViews, rootId: Int): Intent {
        val view = inflate(views)
        view.findViewById<View>(rootId).performClick()
        return shadowOf(context).nextStartedActivity
    }

    /* ---------- decision 2: a stale or gone record says so, visibly ---------- */

    @Test
    fun `the stale line is visible and names the day, gone when the record is current`() {
        val stale = record(boolHabit(), date = yesterday, value = Sentinels.YES)
        val staleNote = inflate(StatsWidget.render(context, stale, today, 3))
            .findViewById<TextView>(R.id.stats_note)
        assertEquals(View.VISIBLE, staleNote.visibility)
        assertTrue(
            "the stale line must name the day it is about",
            staleNote.text.toString().contains(yesterday),
        )

        val fresh = record(boolHabit(), date = today, value = Sentinels.YES)
        val freshNote = inflate(StatsWidget.render(context, fresh, today, 3))
            .findViewById<TextView>(R.id.stats_note)
        assertEquals(View.GONE, freshNote.visibility)
    }

    /* ---------- FIX 2: record.date == today is not "the figures are current" ---------- */

    @Test
    fun `figuresStale alone shows the note line, without naming a date`() {
        // `record.date` is TODAY here — a local answer or refusal can move
        // the strip with no fetch behind it, and `date != today` alone would
        // have missed that entirely. The wiring test that matters: this is
        // `StatsWidget.render`'s own condition, not `Widgets`' pure logic.
        val rec = record(boolHabit(), date = today, value = Sentinels.YES, figuresStale = true)
        val note = inflate(StatsWidget.render(context, rec, today, 3))
            .findViewById<TextView>(R.id.stats_note)
        assertEquals(View.VISIBLE, note.visibility)
        assertEquals(
            context.getString(R.string.stats_figures_behind),
            note.text.toString(),
        )
        // The dated sentence must not appear here — the day is not stale,
        // only the figures are, and naming a date would be a false claim.
        assertFalse(note.text.toString().contains(today))
    }

    /* ---------- the strip fits the widget's width ---------- */

    @Test
    fun `surplus strip cells are hidden, and every cell shows at full width`() {
        val rec = record(boolHabit())
        val narrow = inflate(StatsWidget.render(context, rec, today, columns = 3))
        (0..2).forEach { assertEquals(View.VISIBLE, narrow.findViewById<View>(cellIds[it]).visibility) }
        (3..6).forEach { assertEquals(View.GONE, narrow.findViewById<View>(cellIds[it]).visibility) }

        val wide = inflate(StatsWidget.render(context, rec, today, columns = 7))
        (0..6).forEach { assertEquals(View.VISIBLE, wide.findViewById<View>(cellIds[it]).visibility) }
    }

    /* ---------- the server's cached figures reach the screen ---------- */

    @Test
    fun `the score reaches the progress bar and the text, as a literal percentage`() {
        val rec = record(waterHabit(), score = 0.42)
        val view = inflate(StatsWidget.render(context, rec, today, 3))
        assertEquals(42, view.findViewById<ProgressBar>(R.id.stats_score_bar).progress)
        assertEquals("42%", view.findViewById<TextView>(R.id.stats_score).text.toString())
    }

    @Test
    fun `the streak reaches the text`() {
        val rec = record(boolHabit(), currentStreak = 7)
        val text = inflate(StatsWidget.render(context, rec, today, 3))
            .findViewById<TextView>(R.id.stats_streak).text.toString()
        assertTrue(text.contains("7"))
    }

    /* ---------- decision 7: one avoided-habit inversion, reused ---------- */

    @Test
    fun `the avoided inversion reaches the strip`() {
        val habit = avoidedHabit()
        // A clean day on `record.date` itself, a slip the day before, read
        // through `history` — the two paths `stripStates` resolves a cell
        // from, both exercised in one strip.
        val rec = record(habit, date = today, value = 0.0, history = "$yesterday:3")
        val view = inflate(StatsWidget.render(context, rec, today, columns = 2))
        val slipCell = view.findViewById<ImageView>(cellIds[0]) // yesterday
        val cleanCell = view.findViewById<ImageView>(cellIds[1]) // today

        assertEquals(0xFFDC2626.toInt(), tint(slipCell))
        assertEquals(android.graphics.Color.parseColor(habit.color), tint(cleanCell))
    }

    /* ---------- FIX 1: the real encoder, not a hand-written history literal ---------- */

    @Test
    fun `an unanswered day built through the real encoder is empty, not a stated slip`() {
        // This is the test that would have caught the shipped defect: every
        // other test in this class hand-writes `history`, so a collapse
        // inside `Widgets.encodeHistory` itself — the `?: 0.0` mutation that
        // turns a gap into a stated zero — could ship with all of them green.
        val habit = avoidedHabit() // at_most, target 2 — 3.0 is a real slip
            .copy(entries = mapOf(dayBefore to 3.0)) // nothing recorded `yesterday`: a gap
        val history = Widgets.encodeHistory(habit, endDate = yesterday, days = 2)
        val rec = record(habit, date = today, value = 0.0, history = history)

        val view = inflate(StatsWidget.render(context, rec, today, columns = 3))
        val empty = ContextCompat.getColor(context, R.color.widget_cell_empty)
        val unansweredCell = view.findViewById<ImageView>(cellIds[1]) // yesterday: never answered

        assertEquals(
            "a day the encoder correctly left out of `history` must tint empty",
            empty,
            tint(unansweredCell),
        )
        assertNotEquals(
            "an unanswered day must not paint as a stated slip",
            0xFFDC2626.toInt(),
            tint(unansweredCell),
        )
    }

    /* ---------- FIX 3: a day the model counts as KEPT tints as empty ---------- */

    @Test
    fun `an unlogged-is-success habit ghost-tints an unanswered day on the strip`() {
        val habit = avoidedHabit()
        // No `history` at all: every day before `record.date` resolves
        // UNKNOWN, and on this habit that is a KEPT day — the named input
        // from finding 3, a full-marks week that must not read as a blank one.
        val rec = record(habit, date = today, value = 0.0, unloggedIsSuccess = true)
        val view = inflate(StatsWidget.render(context, rec, today, columns = 7))
        val empty = ContextCompat.getColor(context, R.color.widget_cell_empty)
        val ghostTint = (android.graphics.Color.parseColor(habit.color) and 0x00FFFFFF) or 0x59000000
        (0..5).forEach {
            val actual = tint(view.findViewById<ImageView>(cellIds[it]))
            assertEquals("day $it must ghost-tint, not paint empty", ghostTint, actual)
            assertNotEquals("a kept day must not read as a blank one", empty, actual)
        }
    }

    @Test
    fun `without unlogged-is-success an unanswered day is still empty`() {
        // The arm must not apply unconditionally — the same habit, minus the
        // flag, keeps the ordinary strip meaning for a day nobody answered.
        val habit = avoidedHabit()
        val rec = record(habit, date = today, value = 0.0, unloggedIsSuccess = false)
        val view = inflate(StatsWidget.render(context, rec, today, columns = 7))
        val empty = ContextCompat.getColor(context, R.color.widget_cell_empty)
        (0..5).forEach {
            assertEquals(empty, tint(view.findViewById<ImageView>(cellIds[it])))
        }
    }

    /* ---------- distinct tap intents, the alarms' own bug class ---------- */

    @Test
    fun `the tap intent's data is distinct per widget id and per provider`() {
        // A measurable habit's tap goes through `getActivity` on BOTH
        // providers (the number pad on the checkmark side), so
        // `nextStartedActivity` can read every intent in this test the same
        // way. A yes/no habit's checkmark tap is a `getBroadcast` instead
        // (`ACTION_TAP`, cycling in place) and is not what is under test here.
        val rec7 = record(waterHabit(), widgetId = 7)
        val rec12 = record(waterHabit(), widgetId = 12)
        val tap7 = tappedIntent(StatsWidget.render(context, rec7, today, 3), R.id.stats_root)
        val tap12 = tappedIntent(StatsWidget.render(context, rec12, today, 3), R.id.stats_root)
        assertFalse(
            "two stats widgets must not collapse onto one PendingIntent",
            tap7.filterEquals(tap12),
        )

        val checkmarkTap = tappedIntent(
            HabitWidget.render(context, rec7, today, questionMarks = false),
            R.id.widget_root,
        )
        assertFalse(
            "a stats widget and a checkmark widget for the same habit must not collapse either",
            tap7.filterEquals(checkmarkTap),
        )
    }

    /* ---------- gone beats stale, and blanks the whole strip ---------- */

    @Test
    fun `gone beats stale on the note line, and every strip cell blanks`() {
        val rec = record(
            boolHabit(),
            date = yesterday,
            value = Sentinels.YES,
            gone = true,
            history = "$yesterday:1",
        )
        val view = inflate(StatsWidget.render(context, rec, today, columns = 3))
        val note = view.findViewById<TextView>(R.id.stats_note)
        assertEquals(View.VISIBLE, note.visibility)
        assertEquals(context.getString(R.string.widget_gone_short), note.text.toString())

        // A gone record keeps its last figures in storage (`refreshedOrGone`
        // leaves them) — drawing the old strip beside the gone note would be a
        // second, contradicting claim about the same widget.
        val empty = ContextCompat.getColor(context, R.color.widget_cell_empty)
        (0..2).forEach { assertEquals(empty, tint(view.findViewById<ImageView>(cellIds[it]))) }
    }

    /* ---------- FIX 4: gone hides the figures, not only the strip ---------- */

    @Test
    fun `gone hides the score text, the bar and the streak, leaving only the name and note`() {
        val gone = record(waterHabit(), gone = true, score = 0.42, currentStreak = 7)
        val goneView = inflate(StatsWidget.render(context, gone, today, 3))
        assertEquals(View.GONE, goneView.findViewById<View>(R.id.stats_score).visibility)
        assertEquals(View.GONE, goneView.findViewById<View>(R.id.stats_score_bar).visibility)
        assertEquals(View.GONE, goneView.findViewById<View>(R.id.stats_streak).visibility)

        val live = record(waterHabit(), gone = false, score = 0.42, currentStreak = 7)
        val liveView = inflate(StatsWidget.render(context, live, today, 3))
        assertEquals(View.VISIBLE, liveView.findViewById<View>(R.id.stats_score).visibility)
        assertEquals(View.VISIBLE, liveView.findViewById<View>(R.id.stats_score_bar).visibility)
        assertEquals(View.VISIBLE, liveView.findViewById<View>(R.id.stats_streak).visibility)
    }

    /* ---------- finding (a): each cell is shaded from ITS OWN day ---------- */

    @Test
    fun `each strip cell is shaded from its own day's value`() {
        val habit = waterHabit() // target 8
        val rec = record(
            habit,
            date = today,
            value = null, // today itself has no answer
            history = "$dayBefore:8,$yesterday:3",
        )
        val view = inflate(StatsWidget.render(context, rec, today, columns = 3))
        val fullTint = tint(view.findViewById(cellIds[0])) // dayBefore: full target
        val partialTint = tint(view.findViewById(cellIds[1])) // yesterday: short of it
        val unansweredTint = tint(view.findViewById(cellIds[2])) // today: no answer

        val ownColor = android.graphics.Color.parseColor(habit.color)
        val partialShade = (ownColor and 0x00FFFFFF) or 0x59000000
        val empty = ContextCompat.getColor(context, R.color.widget_cell_empty)

        assertEquals("a full day is the habit's own colour", ownColor, fullTint)
        assertEquals("a partial day is the faint alpha variant of it", partialShade, partialTint)
        assertEquals("an unanswered day is the empty cell", empty, unansweredTint)
        // A `fill` still reading `record.value` for every cell would paint the
        // full and partial days identically — this is what catches it.
        assertEquals(3, setOf(fullTint, partialTint, unansweredTint).size)
    }

    /* ---------- polish (i): a strip cell's description names its own day ---------- */

    @Test
    fun `each strip cell's content description names its own day, and no two are the same`() {
        // Two DONE days a day apart — same state, different date — so a
        // description that dropped the date would read identically for both,
        // which is exactly the bug this test exists to catch.
        val rec = record(boolHabit(), date = today, value = Sentinels.YES, history = "$yesterday:2")
        val view = inflate(StatsWidget.render(context, rec, today, columns = 2))
        val olderDescription = view.findViewById<ImageView>(cellIds[0]).contentDescription.toString()
        val newerDescription = view.findViewById<ImageView>(cellIds[1]).contentDescription.toString()
        assertTrue("the older cell must name its own day", olderDescription.contains(yesterday))
        assertTrue("the newer cell must name its own day", newerDescription.contains(today))
        assertNotEquals(
            "two cells in the same state must not read as the identical sentence",
            olderDescription,
            newerDescription,
        )
    }

    /* ---------- polish (iii): a zero streak is absent, not "🔥 0" ---------- */

    @Test
    fun `the streak view is gone at zero and visible otherwise, matching the app's own convention`() {
        val zero = inflate(StatsWidget.render(context, record(boolHabit(), currentStreak = 0), today, 3))
        assertEquals(View.GONE, zero.findViewById<View>(R.id.stats_streak).visibility)

        val nonZero = inflate(StatsWidget.render(context, record(boolHabit(), currentStreak = 3), today, 3))
        assertEquals(View.VISIBLE, nonZero.findViewById<View>(R.id.stats_streak).visibility)
    }

    /* ==========================================================================
     * STEP 3 — the cross-cutting wiring: `redraw` and `armMidnight` used to be
     * hard-coded to `HabitWidget::class.java` alone, which is the same
     * "pinning the decision is not pinning the wiring" shape the rest of this
     * suite is built to catch, one layer further out: a stats widget was
     * never redrawn by any of the five triggers, and — the sharper failure —
     * `armMidnight` cancelled the ONLY alarm that would ever have fixed that
     * when a stats widget was the sole widget on the home screen.
     * ========================================================================== */

    private val alarmManager get() = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    private fun scheduledAlarms() = shadowOf(alarmManager).scheduledAlarms

    /* ---------- armMidnight asks about EITHER provider ---------- */

    @Test
    fun `armMidnight is armed by a stats widget alone, and gives the alarm back with neither kind left`() {
        val shadowManager = shadowOf(AppWidgetManager.getInstance(context))
        // Only a stats id is bound — no checkmark widget at all. The
        // hard-coded pre-fix `wanted` asked only about `HabitWidget` and would
        // have cancelled the alarm here instead of arming it.
        shadowManager.bindAppWidgetId(41, ComponentName(context, StatsWidget::class.java))

        HabitWidget.armMidnight(context)
        assertEquals(
            "a stats widget alone must still arm the midnight alarm",
            1,
            scheduledAlarms().size,
        )

        // Re-point the id away from both providers — the shadow has no
        // "unbind", so this stands in for the launcher having deleted it,
        // which is the real path to "no widgets of either kind left".
        shadowManager.bindAppWidgetId(41, ComponentName("com.example.none", ".NoSuchProvider"))
        HabitWidget.armMidnight(context)
        assertEquals(
            "no widget of either kind left: the alarm must be given back",
            0,
            scheduledAlarms().size,
        )
    }

    /* ---------- redraw routes each id to ITS OWN provider's renderer ---------- */

    @Test
    fun `redraw draws a checkmark id with HabitWidget's layout and a stats id with StatsWidget's`(): Unit =
        runBlocking {
            val manager = AppWidgetManager.getInstance(context)
            val shadowManager = shadowOf(manager)
            val checkmarkId = 21
            val statsId = 22
            shadowManager.bindAppWidgetId(checkmarkId, ComponentName(context, HabitWidget::class.java))
            shadowManager.bindAppWidgetId(statsId, ComponentName(context, StatsWidget::class.java))

            Settings(context).putWidgets(
                listOf(
                    record(boolHabit(), widgetId = checkmarkId),
                    record(waterHabit(), widgetId = statsId),
                ),
            )

            HabitWidget.redraw(context)

            val checkmarkView = shadowManager.getViewFor(checkmarkId)
            val statsView = shadowManager.getViewFor(statsId)
            assertNotNull("the checkmark id must have been drawn", checkmarkView)
            assertNotNull("the stats id must have been drawn", statsView)

            // Assert on something only one layout has — the crossed-renderer
            // failure this test is named for draws the wrong one of these.
            assertNotNull(
                "a stats id must get StatsWidget's layout",
                statsView!!.findViewById<View>(R.id.stats_note),
            )
            assertNull(
                "a checkmark id must NOT get StatsWidget's layout",
                checkmarkView!!.findViewById<View>(R.id.stats_note),
            )
            assertNotNull(
                "a checkmark id must get HabitWidget's layout",
                checkmarkView.findViewById<View>(R.id.widget_root),
            )
            assertNull(
                "a stats id must NOT get HabitWidget's layout",
                statsView.findViewById<View>(R.id.widget_root),
            )
        }

    /* ---------- the regression: a stats-only home screen is drawn at all ---------- */

    @Test
    fun `redraw draws a stats widget when it is the only widget on the home screen`(): Unit = runBlocking {
        val manager = AppWidgetManager.getInstance(context)
        val shadowManager = shadowOf(manager)
        val statsId = 33
        shadowManager.bindAppWidgetId(statsId, ComponentName(context, StatsWidget::class.java))
        Settings(context).putWidgets(listOf(record(boolHabit(), widgetId = statsId)))

        HabitWidget.redraw(context)

        // The pre-fix `redraw` asked only `HabitWidget`'s ids, found the live
        // set empty, and returned before `manager.updateAppWidget` was ever
        // called — leaving this id undrawn for good.
        assertNotNull(
            "a stats widget must be redrawn even with no checkmark widget on the phone",
            shadowManager.getViewFor(statsId),
        )
    }

    /* ---------- refreshFromServer asks for the whole strip, not one day ---------- */

    @Test
    fun `refreshFromServer asks the server for a full week, not one day`(): Unit = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"start":"2026-08-10","end":"2026-08-16","habits":[]}""",
            ),
        )
        server.start()
        try {
            Settings(context).putWidgets(listOf(record(boolHabit(), widgetId = 55)))
            val api = Api(server.url("/").toString())

            WidgetSync.refreshFromServer(context, api)

            val request = server.takeRequest()
            // The literal 7, not `Widgets.MAX_STRIP_DAYS` — a test that
            // imports the constant it checks pins the name and nothing else.
            assertTrue(
                "expected days=7 in the request path, got ${request.path}",
                request.path?.contains("days=7") == true,
            )
        } finally {
            server.shutdown()
        }
    }

    /* ---------- FIX 5: the resize path — the one thing only this provider hears ---------- */

    @Test
    fun `columnsFor reads the reported width, and falls back to the default for an absent or null bundle`() {
        val wide = Bundle().apply { putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250) }
        assertEquals(7, StatsWidget.columnsFor(wide))

        val narrow = Bundle().apply { putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 130) }
        assertEquals(4, StatsWidget.columnsFor(narrow))

        // The literal 5 — `Widgets.stripDays(180)`, the provider XML's own
        // `minWidth` — not `Widgets.MAX_STRIP_DAYS` or any other constant
        // this test could import: a test that imports the constant it checks
        // pins the name and nothing else.
        val noKey = Bundle()
        assertEquals(5, StatsWidget.columnsFor(noKey))
        assertEquals(5, StatsWidget.columnsFor(null))
    }
}
