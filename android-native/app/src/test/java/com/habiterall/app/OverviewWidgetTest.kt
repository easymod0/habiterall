package com.habiterall.app

import android.app.AlarmManager
import android.app.Application
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.ImageView
import android.widget.RemoteViews
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import com.habiterall.app.data.Api
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Outbox
import com.habiterall.app.data.Sentinels
import com.habiterall.app.data.Settings
import com.habiterall.app.data.Widgets
import com.habiterall.app.notify.Notifications
import com.habiterall.app.notify.Reminders
import com.habiterall.app.widget.HabitWidget
import com.habiterall.app.widget.OverviewWidget
import com.habiterall.app.widget.StatsWidget
import com.habiterall.app.widget.WidgetConfigActivity
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
import java.util.concurrent.TimeUnit

/**
 * The overview widget's OWN wiring — what reaches the platform, not what a
 * pure function returns. `WidgetTest` pins `Widgets.reconcileOverview`,
 * `overviewRows`/`overviewColumns` and the `rank` field's encoding; none of
 * that proves `OverviewWidget.render` reads any of them, and this package's
 * repeated lesson is that the gap between the two is exactly where the bug
 * lives — four Android bugs and then two more have lived one line below the
 * pure function that pinned them.
 *
 * So every assertion here is against the INFLATED `RemoteViews`
 * (`render(...).apply(context, null)`), read back with `findViewById`, the
 * same shape `StatsWidgetTest` uses for the same reason.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class OverviewWidgetTest {

    private val context get() = RuntimeEnvironment.getApplication()

    private val today = "2026-08-16"
    private val yesterday = "2026-08-15"
    private val dayBefore = "2026-08-14"

    /** See `StatsWidgetTest.forgetTheLastArm` — an `object`'s field outlives the class that set it. */
    @Before
    fun forgetTheLastArm() {
        Reminders.lastArmWasExact = null
    }

    /**
     * See `StatsWidgetTest.emptyTheWidgetStore`. The same latent leak applies
     * here and would hide the same way: every read below filters by an explicit
     * widget id, so another class's leftover blob would go unnoticed right up
     * until a test asked about the store as a whole.
     */
    @Before
    fun emptyTheWidgetStore(): Unit = runBlocking {
        Settings(context).replaceWidgets(emptyList())
    }

    private fun boolHabit(id: Long = 1, name: String = "Meditate") = Habit(id = id, name = name)

    private fun waterHabit(id: Long = 2, name: String = "Water") =
        Habit(id = id, name = name, type = "numerical", targetValue = 8.0)

    private fun avoidedHabit(id: Long = 3, name: String = "Smoking"): Habit = Habit(
        id = id,
        name = name,
        type = "numerical",
        targetValue = 2.0,
        targetType = "at_most",
        showAs = "avoid",
    )

    private fun record(
        habit: Habit,
        widgetId: Int = 7,
        rank: Int = 0,
        date: String = today,
        value: Double? = null,
        skip: Boolean = false,
        gone: Boolean = false,
        history: String = "",
        unloggedIsSuccess: Boolean = false,
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
        history = history,
        unloggedIsSuccess = unloggedIsSuccess,
        rank = rank,
    )

    /** `overview_row_0` .. `overview_row_6`, top to bottom — the layout's own order. */
    private val rowIds = intArrayOf(
        R.id.overview_row_0,
        R.id.overview_row_1,
        R.id.overview_row_2,
        R.id.overview_row_3,
        R.id.overview_row_4,
        R.id.overview_row_5,
        R.id.overview_row_6,
    )

    private val nameIds = intArrayOf(
        R.id.overview_name_0,
        R.id.overview_name_1,
        R.id.overview_name_2,
        R.id.overview_name_3,
        R.id.overview_name_4,
        R.id.overview_name_5,
        R.id.overview_name_6,
    )

    private val dayIds = intArrayOf(
        R.id.overview_day_0,
        R.id.overview_day_1,
        R.id.overview_day_2,
        R.id.overview_day_3,
        R.id.overview_day_4,
        R.id.overview_day_5,
        R.id.overview_day_6,
    )

    /** `cellIds[row][column]`, oldest column on the left. */
    private val cellIds = arrayOf(
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

    private fun inflate(views: RemoteViews): View = views.apply(context, null)

    /** See `StatsWidgetTest.tint` — `PorterDuffColorFilter.getColor()` by reflection, and why. */
    private fun tint(view: ImageView): Int {
        val filter = view.colorFilter ?: return 0
        return filter.javaClass.getMethod("getColor").invoke(filter) as Int
    }

    /** See `StatsWidgetTest.tappedIntent` — a real `performClick()`, and what it actually started. */
    private fun tappedIntent(views: RemoteViews, targetId: Int): Intent {
        val view = inflate(views)
        view.findViewById<View>(targetId).performClick()
        return shadowOf(context).nextStartedActivity
    }

    private fun name(view: View, row: Int): String =
        view.findViewById<TextView>(nameIds[row]).text.toString()

    /** The visible note line, and what `overview_root` announces — the two that must agree. */
    private fun noteOf(view: View): TextView = view.findViewById(R.id.overview_note)

    private fun spoken(view: View): String =
        view.findViewById<View>(R.id.overview_root).contentDescription.toString()

    /* ---------- case 1: rows are drawn in RANK order ---------- */

    @Test
    fun `rows render in rank order, not in the order the store handed them back`() {
        // Stored order, habit-id order and rank order are all different, which
        // is the only fixture that can tell the three apart — `putWidgetSet`
        // writes a widget's records at the TAIL of the blob, so stored order is
        // not an ordering signal and a render that trusted it would be wrong
        // the first time a habit was added to the account.
        //   stored: Gamma, Alpha, Beta   ids: Beta(2), Alpha(5), Gamma(9)
        //   rank:   Alpha(0), Beta(1), Gamma(2)
        val stored = listOf(
            record(boolHabit(id = 9, name = "Gamma"), rank = 2),
            record(boolHabit(id = 5, name = "Alpha"), rank = 0),
            record(boolHabit(id = 2, name = "Beta"), rank = 1),
        )
        val view = inflate(OverviewWidget.render(context, stored, today, rows = 7, columns = 3))
        assertEquals("Alpha", name(view, 0))
        assertEquals("Beta", name(view, 1))
        assertEquals("Gamma", name(view, 2))
    }

    /* ---------- case 2: the shown counts follow the options bundle ---------- */

    @Test
    fun `surplus rows and surplus cells are gone, and the counts follow the reported size`() {
        // Through the bundle readers rather than by passing 5 and 5 in
        // directly: a render that ignored its arguments and a `rowsFor` that
        // ignored the bundle are two different bugs with the same symptom, and
        // this is the path the launcher actually takes.
        val options = Bundle().apply {
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 130)
        }
        // The literals, never `Widgets.MAX_OVERVIEW_ROWS` or any other constant
        // this test could import — a test that imports the constant it checks
        // pins the name and nothing else.
        assertEquals(5, OverviewWidget.rowsFor(options))
        assertEquals(5, OverviewWidget.columnsFor(options))

        val records = (0 until 5).map { record(boolHabit(id = it + 1L, name = "H$it"), rank = it) }
        val view = inflate(
            OverviewWidget.render(
                context,
                records,
                today,
                rows = OverviewWidget.rowsFor(options),
                columns = OverviewWidget.columnsFor(options),
            ),
        )

        (0..4).forEach { assertEquals("row $it", View.VISIBLE, view.findViewById<View>(rowIds[it]).visibility) }
        (5..6).forEach { assertEquals("row $it", View.GONE, view.findViewById<View>(rowIds[it]).visibility) }
        (0..4).forEach {
            assertEquals("cell 0,$it", View.VISIBLE, view.findViewById<View>(cellIds[0][it]).visibility)
            assertEquals("day $it", View.VISIBLE, view.findViewById<View>(dayIds[it]).visibility)
        }
        (5..6).forEach {
            assertEquals("cell 0,$it", View.GONE, view.findViewById<View>(cellIds[0][it]).visibility)
            assertEquals("day $it", View.GONE, view.findViewById<View>(dayIds[it]).visibility)
        }
    }

    /* ---------- case 3: the avoided inversion survives the new surface ---------- */

    @Test
    fun `an avoided habit paints a clean day in its own colour and a slip in red`() {
        // "Pinning the decision is not pinning the wiring": `HabitWidget.fill`
        // already carries the inversion and `StatsWidgetTest` already pins it
        // on the strip — this is a new caller, and a new caller is where the
        // decision stops being applied.
        val habit = avoidedHabit()
        val rec = record(habit, date = today, value = 0.0, history = "$yesterday:3")
        val view = inflate(OverviewWidget.render(context, listOf(rec), today, rows = 7, columns = 2))
        val slipCell = view.findViewById<ImageView>(cellIds[0][0]) // yesterday
        val cleanCell = view.findViewById<ImageView>(cellIds[0][1]) // today

        assertEquals("a slip is the day grid's red", 0xFFDC2626.toInt(), tint(slipCell))
        assertEquals(
            "a clean day on an avoided habit is the habit's own colour",
            android.graphics.Color.parseColor(habit.color),
            tint(cleanCell),
        )
    }

    /* ---------- case 4: a day the model counts as KEPT is not a blank one ---------- */

    @Test
    fun `an unlogged-is-success habit ghost-tints an unanswered day`() {
        val habit = avoidedHabit()
        // No `history` at all: every day before `record.date` resolves UNKNOWN,
        // and on this habit that is a KEPT day. Built from `fill` instead of
        // `stripFill`, a full-marks week on this grid reads as a blank one.
        val rec = record(habit, date = today, value = 0.0, unloggedIsSuccess = true)
        val view = inflate(OverviewWidget.render(context, listOf(rec), today, rows = 7, columns = 7))
        val empty = ContextCompat.getColor(context, R.color.widget_cell_empty)
        val ghostTint = (android.graphics.Color.parseColor(habit.color) and 0x00FFFFFF) or 0x59000000
        (0..5).forEach {
            val actual = tint(view.findViewById<ImageView>(cellIds[0][it]))
            assertEquals("day $it must ghost-tint, not paint empty", ghostTint, actual)
            assertNotEquals("a kept day must not read as a blank one", empty, actual)
        }
    }

    @Test
    fun `without unlogged-is-success the same unanswered day is still empty`() {
        // The negative half: the arm must not apply unconditionally.
        val habit = avoidedHabit()
        val rec = record(habit, date = today, value = 0.0, unloggedIsSuccess = false)
        val view = inflate(OverviewWidget.render(context, listOf(rec), today, rows = 7, columns = 7))
        val empty = ContextCompat.getColor(context, R.color.widget_cell_empty)
        (0..5).forEach { assertEquals(empty, tint(view.findViewById<ImageView>(cellIds[0][it]))) }
    }

    /* ---------- case 5: a gone row disappears and the rows below close up ---------- */

    @Test
    fun `a gone record's row is not drawn and the rows below it move up`() {
        // The NAME in row 0, not merely "some row is gone": a render that drew
        // the gone record and hid the last row instead would satisfy a count
        // assertion and put the wrong habit at the top of the widget. This is
        // deliberately different from the two single-habit widgets, which keep
        // a gone record and say "Removed" — there, hiding the one thing on
        // screen would leave a blank widget with nothing to explain it.
        val records = listOf(
            record(boolHabit(id = 1, name = "Departed"), rank = 0, gone = true),
            record(boolHabit(id = 2, name = "Beta"), rank = 1),
            record(boolHabit(id = 3, name = "Gamma"), rank = 2),
        )
        val view = inflate(OverviewWidget.render(context, records, today, rows = 7, columns = 3))
        assertEquals("the row below the gone one moves to the top", "Beta", name(view, 0))
        assertEquals("Gamma", name(view, 1))
        assertEquals(View.GONE, view.findViewById<View>(rowIds[2]).visibility)
    }

    /* ---------- case 6: the widget does not pretend it shows all of them ---------- */

    @Test
    fun `more habits than rows shows the count, and exactly as many shows nothing`() {
        val five = (0 until 5).map { record(boolHabit(id = it + 1L, name = "H$it"), rank = it) }
        val cramped = inflate(OverviewWidget.render(context, five, today, rows = 3, columns = 3))
        val more = cramped.findViewById<TextView>(R.id.overview_more)
        assertEquals(View.VISIBLE, more.visibility)
        assertTrue(
            "the footer must name how many are not shown, got \"${more.text}\"",
            more.text.toString().contains("2"),
        )

        val three = five.take(3)
        val exact = inflate(OverviewWidget.render(context, three, today, rows = 3, columns = 3))
        assertEquals(View.GONE, exact.findViewById<View>(R.id.overview_more).visibility)
    }

    @Test
    fun `one habit over the bound reads as a singular, never as 1 more habits`() {
        // The reason this is a `plurals` and not `%d more`. Eight habits in a
        // seven-row widget is the common case, not an exotic one.
        val four = (0 until 4).map { record(boolHabit(id = it + 1L, name = "H$it"), rank = it) }
        val view = inflate(OverviewWidget.render(context, four, today, rows = 3, columns = 3))
        assertEquals(
            context.resources.getQuantityString(R.plurals.overview_more, 1, 1),
            view.findViewById<TextView>(R.id.overview_more).text.toString(),
        )
    }

    /* ---------- case 7: no rows at all is explained, visibly ---------- */

    @Test
    fun `zero renderable rows shows the empty message on a real view`() {
        // The renderer's own two roads into the state. Nothing in the app calls
        // `render` with an empty list directly, so this case pins the DECISION
        // and not the wiring — `redraw draws a live overview widget that holds
        // no records at all` and `an overview widget that loses every habit …`
        // below are the ones that go through the store and the launcher.
        val empty = inflate(OverviewWidget.render(context, emptyList(), today, rows = 7, columns = 3))
        val note = empty.findViewById<TextView>(R.id.overview_note)
        assertEquals(View.VISIBLE, note.visibility)
        assertEquals(context.getString(R.string.overview_empty), note.text.toString())

        // The other road to the same state: every habit archived, so every
        // record is gone and the filter takes the whole grid with it.
        val allGone = listOf(
            record(boolHabit(id = 1, name = "A"), rank = 0, gone = true),
            record(boolHabit(id = 2, name = "B"), rank = 1, gone = true),
        )
        val goneView = inflate(OverviewWidget.render(context, allGone, today, rows = 7, columns = 3))
        val goneNote = goneView.findViewById<TextView>(R.id.overview_note)
        assertEquals(View.VISIBLE, goneNote.visibility)
        assertEquals(context.getString(R.string.overview_empty), goneNote.text.toString())
    }

    /* ---------- case 8: a record not refreshed today says so ---------- */

    @Test
    fun `an unrefreshed record shows the as-of line naming its day, and a current one shows none`() {
        // Today's column has no data behind a record dated yesterday, so it
        // paints UNKNOWN — indistinguishable from "answered nothing today"
        // until this line resolves it.
        val stale = listOf(record(boolHabit(), rank = 0, date = yesterday, value = Sentinels.YES))
        val staleNote = inflate(OverviewWidget.render(context, stale, today, rows = 7, columns = 3))
            .findViewById<TextView>(R.id.overview_note)
        assertEquals(View.VISIBLE, staleNote.visibility)
        assertTrue(
            "the as-of line must name the day it is about, got \"${staleNote.text}\"",
            staleNote.text.toString().contains(yesterday),
        )

        val fresh = listOf(record(boolHabit(), rank = 0, date = today, value = Sentinels.YES))
        val freshNote = inflate(OverviewWidget.render(context, fresh, today, rows = 7, columns = 3))
            .findViewById<TextView>(R.id.overview_note)
        assertEquals(View.GONE, freshNote.visibility)
    }

    @Test
    fun `the as-of line reports the oldest row drawn, not the newest`() {
        // "As of" is a claim about every row above it. One row a day behind the
        // rest makes the newest date a false claim about that row, so the
        // oldest is what the line names — over-reporting staleness is the
        // fail-safe direction.
        val mixed = listOf(
            record(boolHabit(id = 1, name = "Current"), rank = 0, date = today),
            record(boolHabit(id = 2, name = "Behind"), rank = 1, date = dayBefore),
        )
        val note = inflate(OverviewWidget.render(context, mixed, today, rows = 7, columns = 3))
            .findViewById<TextView>(R.id.overview_note)
        assertEquals(View.VISIBLE, note.visibility)
        assertTrue(
            "the line must name the OLDEST row's day, got \"${note.text}\"",
            note.text.toString().contains(dayBefore),
        )
    }

    @Test
    fun `an answer recorded with no fetch behind it still says the grid is behind`(): Unit =
        runBlocking {
            // Through the REAL event, never a hand-built `figuresStale = true`:
            // the defect is that `record.date` is not a FETCH date, and only
            // the path that proves it — an answer given on this phone with no
            // network — can show that the note line asks the wrong question.
            // T-3 was the last fetch; the browser answered T-2 and T-1 while
            // the phone was offline; at T the reminder still in the shade is
            // pressed. `Widgets.answered` advances `date` to T and leaves
            // `history` stopping at T-3, so a note line reading `date` alone
            // goes quiet exactly while the T-2 and T-1 columns paint UNKNOWN
            // off nothing — the "indistinguishable from answered-nothing"
            // confusion the line exists to resolve.
            val manager = AppWidgetManager.getInstance(context)
            val shadowManager = shadowOf(manager)
            val widgetId = 95
            shadowManager.bindAppWidgetId(widgetId, ComponentName(context, OverviewWidget::class.java))
            // The REAL current date, not this class's frozen `today`:
            // `noteAnswer` and `redraw` both read `LocalDate.now()`, and a
            // fixture on a frozen day would take the dated arm instead and
            // pass against a note line with no third arm at all.
            val now = java.time.LocalDate.now()
            val lastFetch = now.minusDays(3).toString()
            val habit = boolHabit()
            val settings = Settings(context)
            settings.putWidgetSet(
                widgetId,
                listOf(
                    record(
                        habit,
                        widgetId = widgetId,
                        rank = 0,
                        date = lastFetch,
                        value = Sentinels.YES,
                        history = "$lastFetch:2",
                    ),
                ),
            )

            WidgetSync.noteAnswer(context, habit.id, now.toString(), Sentinels.YES, skip = false)

            val row = settings.cachedWidgetSet(widgetId).single()
            assertEquals(
                "the fixture only means anything once the real event has advanced the row's date",
                now.toString(),
                row.date,
            )
            assertEquals(
                "and left the history exactly where the last fetch stopped",
                "$lastFetch:2",
                row.history,
            )

            val view = shadowManager.getViewFor(widgetId)
            assertNotNull("the answer must have redrawn the widget", view)
            val note = view!!.findViewById<TextView>(R.id.overview_note)
            assertEquals(
                "a row dated today off a LOCAL answer is not a refreshed row",
                View.VISIBLE,
                note.visibility,
            )
            assertEquals(
                context.getString(R.string.overview_grid_behind),
                note.text.toString(),
            )
            assertFalse(
                "the line must not name a date — the date IS today, and naming it would be false",
                note.text.toString().contains(now.toString()),
            )
            assertEquals(
                "the spoken sentence must not disagree with the visible one",
                context.getString(R.string.overview_summary_grid_behind, 1, 1),
                view.findViewById<View>(R.id.overview_root).contentDescription.toString(),
            )
        }

    /* ---------- case 8b: the note line and the spoken sentence take the SAME arm ---------- */

    // #332's finding, one layer up: the visible note line grew to three arms
    // while `overview_root`'s content description branched on ONE of them
    // (`figuresStale`), so a widget whose line read "As of 2026-08-14" was
    // announced, unqualified, as "Your habits: 2 of 2", and one reading "No
    // habits to show yet" as "Your habits: 0 of 0" — a COUNT where the screen
    // states a REASON. Four tests rather than one walking four arms, because a
    // single test stops at its first failed assertion and the arms fail
    // independently: the description this replaced gets TWO of them wrong, and
    // one test would only ever quote whichever came first.
    //
    // Each arm asserts the VISIBLE line and the SPOKEN one together, since the
    // defect is the two disagreeing, and each qualified arm also asserts what
    // the spoken sentence must NOT be — the plain one built from that arm's own
    // counts, rather than a literal that would drift from it.

    @Test
    fun `an empty widget's spoken sentence states the reason, not a count of nothing`() {
        // `overview_summary` is not a weaker claim here, it is a false one:
        // there are no habits for "0 of 0" to be a count of, and the screen
        // says so in words.
        val view = inflate(OverviewWidget.render(context, emptyList(), today, rows = 7, columns = 3))
        assertEquals(context.getString(R.string.overview_empty), noteOf(view).text.toString())
        assertEquals(context.getString(R.string.overview_summary_empty), spoken(view))
        assertNotEquals(
            "an empty widget must not be announced as a count",
            context.getString(R.string.overview_summary, 0, 0),
            spoken(view),
        )
    }

    @Test
    fun `a dated widget's spoken sentence names the day its visible line names`() {
        // The same fixture `the as-of line reports the oldest row drawn` uses,
        // asked of the other half of the widget: the line names `dayBefore`, so
        // the sentence read out over it has to name `dayBefore` too.
        val mixed = listOf(
            record(boolHabit(id = 1, name = "Current"), rank = 0, date = today),
            record(boolHabit(id = 2, name = "Behind"), rank = 1, date = dayBefore),
        )
        val view = inflate(OverviewWidget.render(context, mixed, today, rows = 7, columns = 3))
        assertTrue(
            "the visible line must name the oldest row's day, got \"${noteOf(view).text}\"",
            noteOf(view).text.toString().contains(dayBefore),
        )
        assertTrue(
            "the spoken sentence must name the day the visible line names, got \"${spoken(view)}\"",
            spoken(view).contains(dayBefore),
        )
        assertEquals(
            context.getString(R.string.overview_summary_stale, 2, 2, dayBefore),
            spoken(view),
        )
        assertNotEquals(
            "a widget dated three days back must not be announced as current",
            context.getString(R.string.overview_summary, 2, 2),
            spoken(view),
        )
    }

    @Test
    fun `a grid-behind widget's spoken sentence says so, through the real answer path`(): Unit =
        runBlocking {
            // Built the way `an answer recorded with no fetch behind it …`
            // above builds it, and for the reason stated there: a hand-set
            // `figuresStale = true` would prove nothing about the one event
            // that sets it, and the real one is what makes `date` stop being a
            // fetch date. This arm is the one the description already got
            // right; it is here so the four are asserted as a set, and so a
            // later change cannot fix two arms by breaking this one.
            val manager = AppWidgetManager.getInstance(context)
            val shadowManager = shadowOf(manager)
            val widgetId = 96
            shadowManager.bindAppWidgetId(widgetId, ComponentName(context, OverviewWidget::class.java))
            // The REAL current date, not this class's frozen `today`, for the
            // reason that test states: a frozen day takes the dated arm instead.
            val now = java.time.LocalDate.now()
            val lastFetch = now.minusDays(3).toString()
            val habit = boolHabit()
            val settings = Settings(context)
            settings.putWidgetSet(
                widgetId,
                listOf(
                    record(
                        habit,
                        widgetId = widgetId,
                        rank = 0,
                        date = lastFetch,
                        value = Sentinels.YES,
                        history = "$lastFetch:2",
                    ),
                ),
            )
            WidgetSync.noteAnswer(context, habit.id, now.toString(), Sentinels.YES, skip = false)

            val view = shadowManager.getViewFor(widgetId)
            assertNotNull("the answer must have redrawn the widget", view)
            assertEquals(
                context.getString(R.string.overview_grid_behind),
                noteOf(view!!).text.toString(),
            )
            assertEquals(
                context.getString(R.string.overview_summary_grid_behind, 1, 1),
                spoken(view),
            )
            assertNotEquals(
                "a grid with no fetch behind it must not be announced as current",
                context.getString(R.string.overview_summary, 1, 1),
                spoken(view),
            )
        }

    @Test
    fun `a current widget is announced plainly, with no note line at all`() {
        // The negative half, and the reason the other three cannot be passed by
        // "always qualify it": nothing is wrong with this widget, so the note
        // line is GONE and the plain sentence is the whole of what is said.
        val current = listOf(record(boolHabit(id = 4, name = "Fresh"), rank = 0, date = today))
        val view = inflate(OverviewWidget.render(context, current, today, rows = 7, columns = 3))
        assertEquals(View.GONE, noteOf(view).visibility)
        assertEquals(context.getString(R.string.overview_summary, 1, 1), spoken(view))
    }

    /* ---------- case 9: one tap target per row, and they must not collapse ---------- */

    @Test
    fun `each row opens the app on its own habit, and two rows are two PendingIntents`() {
        // `filterEquals` ignores extras, so seven rows differing only in
        // `EXTRA_HABIT_ID` collapse onto ONE PendingIntent and FLAG_UPDATE_CURRENT
        // leaves every row opening whichever habit was drawn last. The alarms,
        // the checkmark widget and the stats widget have each learned this; a
        // widget with N targets inside one id is where it recurs.
        val records = listOf(
            record(boolHabit(id = 11, name = "First"), rank = 0),
            record(boolHabit(id = 22, name = "Second"), rank = 1),
        )
        val first = tappedIntent(
            OverviewWidget.render(context, records, today, rows = 7, columns = 3),
            rowIds[0],
        )
        val second = tappedIntent(
            OverviewWidget.render(context, records, today, rows = 7, columns = 3),
            rowIds[1],
        )

        assertEquals(
            "row 0 must open the app on row 0's habit",
            11L,
            first.getLongExtra(Notifications.EXTRA_HABIT_ID, -1),
        )
        assertEquals(
            "row 1 must open the app on row 1's habit",
            22L,
            second.getLongExtra(Notifications.EXTRA_HABIT_ID, -1),
        )
        assertFalse(
            "two rows must not collapse onto one PendingIntent",
            first.filterEquals(second),
        )
    }

    /* ---------- case 10: every cell says which day it is and what it holds ---------- */

    @Test
    fun `each cell's content description names its own day and its own state`() {
        // Two DONE days a day apart — same state, different date — so a
        // description that dropped the date would read identically for both.
        val rec = record(boolHabit(), date = today, value = Sentinels.YES, history = "$yesterday:2")
        val view = inflate(OverviewWidget.render(context, listOf(rec), today, rows = 7, columns = 2))
        val older = view.findViewById<ImageView>(cellIds[0][0]).contentDescription.toString()
        val newer = view.findViewById<ImageView>(cellIds[0][1]).contentDescription.toString()

        assertTrue("the older cell must name its own day", older.contains(yesterday))
        assertTrue("the newer cell must name its own day", newer.contains(today))
        assertTrue(
            "the description must say what the day was",
            newer.contains(context.getString(R.string.widget_done)),
        )
        assertNotEquals(
            "two cells in the same state must not read as the identical sentence",
            older,
            newer,
        )
    }

    /* ---------- case 11: a resize redraws that id at the new size ---------- */

    @Test
    fun `onAppWidgetOptionsChanged redraws that id with the counts the new size asks for`(): Unit =
        runBlocking {
            val manager = AppWidgetManager.getInstance(context)
            val shadowManager = shadowOf(manager)
            val widgetId = 71
            shadowManager.bindAppWidgetId(widgetId, ComponentName(context, OverviewWidget::class.java))
            Settings(context).putWidgetSet(
                widgetId,
                (0 until 5).map {
                    record(boolHabit(id = it + 1L, name = "H$it"), widgetId = widgetId, rank = it)
                },
            )

            // 105dp -> 4 rows, 210dp -> 4 columns: both dimensions read, which
            // is what this widget needs and `StatsWidget` does not.
            val options = Bundle().apply {
                putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 210)
                putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 105)
            }
            OverviewWidget.resized(context, manager, widgetId, options)

            val view = shadowManager.getViewFor(widgetId)
            assertNotNull("the resized id must have been drawn", view)
            assertEquals(View.VISIBLE, view!!.findViewById<View>(rowIds[3]).visibility)
            assertEquals("a fifth habit must not be drawn in a four-row widget", View.GONE, view.findViewById<View>(rowIds[4]).visibility)
            assertEquals(View.VISIBLE, view.findViewById<View>(cellIds[0][3]).visibility)
            assertEquals(View.GONE, view.findViewById<View>(cellIds[0][4]).visibility)
            // And the row it had no room for is still reported.
            assertEquals(View.VISIBLE, view.findViewById<View>(R.id.overview_more).visibility)
        }

    @Test
    fun `a resize of a widget holding no records draws the empty note, not nothing`(): Unit =
        runBlocking {
            // The same asymmetry `redraw`'s union states, on the one path only
            // this widget's own instance hears about: an empty record set here
            // is an account with every habit archived, not an unconfigured
            // widget, and returning early left it on whatever frame it was last
            // handed — during the one gesture a user makes expecting a redraw.
            val manager = AppWidgetManager.getInstance(context)
            val shadowManager = shadowOf(manager)
            val widgetId = 72
            shadowManager.bindAppWidgetId(widgetId, ComponentName(context, OverviewWidget::class.java))
            Settings(context).putWidgetSet(widgetId, emptyList())

            OverviewWidget.resized(context, manager, widgetId, Bundle())

            val view = shadowManager.getViewFor(widgetId)
            assertNotNull("the resized id must have been drawn", view)
            val note = view!!.findViewById<TextView>(R.id.overview_note)
            assertEquals(View.VISIBLE, note.visibility)
            assertEquals(context.getString(R.string.overview_empty), note.text.toString())
        }

    /* ---------- case 12: each cell is shaded from ITS OWN day ---------- */

    @Test
    fun `each cell is shaded from its own day's value, not from the record's one day`() {
        // Seven times as many cells as the strip, so a `fill` reading
        // `record.value` for all of them is seven times as wrong — and it is
        // the same mistake #332 found on the stats widget.
        val habit = waterHabit() // target 8
        val rec = record(
            habit,
            date = today,
            value = null, // today itself has no answer
            history = "$dayBefore:8,$yesterday:3",
        )
        val view = inflate(OverviewWidget.render(context, listOf(rec), today, rows = 7, columns = 3))
        val fullTint = tint(view.findViewById(cellIds[0][0])) // dayBefore: full target
        val partialTint = tint(view.findViewById(cellIds[0][1])) // yesterday: short of it
        val unansweredTint = tint(view.findViewById(cellIds[0][2])) // today: no answer

        val ownColor = android.graphics.Color.parseColor(habit.color)
        val partialShade = (ownColor and 0x00FFFFFF) or 0x59000000
        val empty = ContextCompat.getColor(context, R.color.widget_cell_empty)

        assertEquals("a full day is the habit's own colour", ownColor, fullTint)
        assertEquals("a partial day is the faint alpha variant of it", partialShade, partialTint)
        assertEquals("an unanswered day is the empty cell", empty, unansweredTint)
        assertEquals(
            "three days in three different states must paint three different tints",
            3,
            setOf(fullTint, partialTint, unansweredTint).size,
        )
    }

    /* ---------- the day header ---------- */

    @Test
    fun `the day header runs oldest to newest and emphasises today's column`() {
        val rec = record(boolHabit(), date = today)
        val view = inflate(OverviewWidget.render(context, listOf(rec), today, rows = 7, columns = 3))
        // 2026-08-16 is a Sunday, 2026-08-14 a Friday — the locale's own narrow
        // initials, read from `java.time` rather than a hand-written array that
        // would be English on every phone.
        val locale = java.util.Locale.getDefault()
        assertEquals(
            java.time.DayOfWeek.FRIDAY.getDisplayName(java.time.format.TextStyle.NARROW, locale),
            view.findViewById<TextView>(dayIds[0]).text.toString(),
        )
        assertEquals(
            java.time.DayOfWeek.SUNDAY.getDisplayName(java.time.format.TextStyle.NARROW, locale),
            view.findViewById<TextView>(dayIds[2]).text.toString(),
        )
        assertNotEquals(
            "today's column must be emphasised against the ones before it",
            view.findViewById<TextView>(dayIds[0]).currentTextColor,
            view.findViewById<TextView>(dayIds[2]).currentTextColor,
        )
    }

    /* ==========================================================================
     * STEP 4 — the cross-cutting wiring. `HabitWidget.liveIds` returned a
     * two-provider `Pair`, and its own KDoc warned that a third provider would
     * hit the same trap `StatsWidget` did. This is that third provider, and the
     * two call sites below are where "pinning the decision is not pinning the
     * wiring" would have cost a release again.
     * ========================================================================== */

    private val alarmManager get() = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    private fun scheduledAlarms() = shadowOf(alarmManager).scheduledAlarms

    /* ---------- armMidnight: the sharper of the two failure modes ---------- */

    @Test
    fun `armMidnight is armed by an overview widget alone, and is not cancelled by it`() {
        val shadowManager = shadowOf(AppWidgetManager.getInstance(context))
        // ONLY an overview id is bound — no checkmark widget and no stats
        // widget anywhere on the phone. A `wanted` that does not count overview
        // ids reads false here and takes the `!wanted` branch, which CANCELS
        // the one alarm that would ever redraw anything at midnight — and this
        // is the widget that needs it most, because its whole GRID of columns
        // moves at midnight rather than one cell.
        shadowManager.bindAppWidgetId(81, ComponentName(context, OverviewWidget::class.java))

        HabitWidget.armMidnight(context)
        assertEquals(
            "an overview widget alone must arm the midnight alarm",
            1,
            scheduledAlarms().size,
        )

        // And arming twice must not be a cancel: `armMidnight` runs from every
        // redraw, so the second call is the ordinary case rather than an
        // unusual one.
        HabitWidget.armMidnight(context)
        assertEquals(
            "a second arm must leave the alarm standing, not take it away",
            1,
            scheduledAlarms().size,
        )

        // Re-point the id away from all three providers — the shadow has no
        // "unbind", so this stands in for the launcher having deleted it.
        shadowManager.bindAppWidgetId(81, ComponentName("com.example.none", ".NoSuchProvider"))
        HabitWidget.armMidnight(context)
        assertEquals(
            "no widget of any kind left: the alarm must be given back",
            0,
            scheduledAlarms().size,
        )
    }

    /* ---------- redraw: an overview id is drawn, and drawn from its whole GROUP ---------- */

    @Test
    fun `redraw draws an overview widget, from its whole set of records at once`(): Unit =
        runBlocking {
            val manager = AppWidgetManager.getInstance(context)
            val shadowManager = shadowOf(manager)
            val widgetId = 82
            shadowManager.bindAppWidgetId(widgetId, ComponentName(context, OverviewWidget::class.java))
            Settings(context).putWidgetSet(
                widgetId,
                listOf(
                    record(boolHabit(id = 1, name = "Alpha"), widgetId = widgetId, rank = 0),
                    record(boolHabit(id = 2, name = "Beta"), widgetId = widgetId, rank = 1),
                    record(boolHabit(id = 3, name = "Gamma"), widgetId = widgetId, rank = 2),
                ),
            )

            HabitWidget.redraw(context)

            val view = shadowManager.getViewFor(widgetId)
            // The pre-fix `redraw` asked only the checkmark and stats ids,
            // found neither, and returned before `updateAppWidget` was ever
            // called for this one — leaving it undrawn for good.
            assertNotNull("an overview widget must be redrawn like any other", view)
            assertNotNull(
                "an overview id must get OverviewWidget's layout",
                view!!.findViewById<View>(R.id.overview_root),
            )
            // THREE names in one frame, not one: a `redraw` that still
            // dispatched per RECORD would call `render` three times with a
            // single row each, and the launcher would hold whichever one was
            // drawn last — a widget showing "Gamma" alone and nothing else.
            assertEquals("Alpha", name(view, 0))
            assertEquals("Beta", name(view, 1))
            assertEquals("Gamma", name(view, 2))
        }

    @Test
    fun `redraw still routes a checkmark id and an overview id to their own renderers`(): Unit =
        runBlocking {
            // The crossed-renderer failure, with the third provider in it: an
            // overview layout over a checkmark id, or the reverse, is what a
            // `when` branch in the wrong order produces.
            val manager = AppWidgetManager.getInstance(context)
            val shadowManager = shadowOf(manager)
            val checkmarkId = 83
            val overviewId = 84
            shadowManager.bindAppWidgetId(checkmarkId, ComponentName(context, HabitWidget::class.java))
            shadowManager.bindAppWidgetId(overviewId, ComponentName(context, OverviewWidget::class.java))
            val settings = Settings(context)
            settings.putWidgets(listOf(record(boolHabit(), widgetId = checkmarkId)))
            settings.putWidgetSet(
                overviewId,
                listOf(record(boolHabit(id = 4, name = "Delta"), widgetId = overviewId, rank = 0)),
            )

            HabitWidget.redraw(context)

            val checkmarkView = shadowManager.getViewFor(checkmarkId)
            val overviewView = shadowManager.getViewFor(overviewId)
            assertNotNull("the checkmark id must have been drawn", checkmarkView)
            assertNotNull("the overview id must have been drawn", overviewView)
            assertNotNull(
                "an overview id must get OverviewWidget's layout",
                overviewView!!.findViewById<View>(R.id.overview_root),
            )
            assertNull(
                "a checkmark id must NOT get OverviewWidget's layout",
                checkmarkView!!.findViewById<View>(R.id.overview_root),
            )
            assertNotNull(
                "a checkmark id must get HabitWidget's layout",
                checkmarkView.findViewById<View>(R.id.widget_root),
            )
            assertNull(
                "an overview id must NOT get HabitWidget's layout",
                overviewView.findViewById<View>(R.id.widget_root),
            )
        }

    @Test
    fun `redraw draws a live overview widget that holds no records at all`(): Unit =
        runBlocking {
            // The one id-set asymmetry in `redraw`. A widget id holding no
            // records produces no `groupBy` entry, so a dispatch over the
            // groups alone never draws it — right for a checkmark or a stats
            // id, where no record means an UNCONFIGURED widget that must stay
            // on its `initialLayout`, and wrong here: `putWidgetSet(id,
            // emptyList())` is the legitimate purge for an account whose
            // habits have all been archived or deleted, and this is precisely
            // the state `overview_empty` exists for.
            val manager = AppWidgetManager.getInstance(context)
            val shadowManager = shadowOf(manager)
            val widgetId = 89
            shadowManager.bindAppWidgetId(widgetId, ComponentName(context, OverviewWidget::class.java))
            Settings(context).putWidgetSet(widgetId, emptyList())

            HabitWidget.redraw(context)

            val view = shadowManager.getViewFor(widgetId)
            assertNotNull("a live overview widget holding no records must still be drawn", view)
            val note = view!!.findViewById<TextView>(R.id.overview_note)
            assertEquals(View.VISIBLE, note.visibility)
            assertEquals(context.getString(R.string.overview_empty), note.text.toString())
        }

    @Test
    fun `an overview widget that loses every habit is redrawn empty, not frozen on its last frame`(): Unit =
        runBlocking {
            // The reachable road to the case above, end to end: archive or
            // delete every habit and the fetch arrives as an empty list, which
            // `reconciledRows` turns into no rows and `putWidgetSet` purges the
            // id with. Undrawn, the launcher goes on showing the last frame it
            // was handed — the archived habits, their old cells, and no note —
            // and the 30-minute backstop and the midnight alarm both come back
            // through the same `redraw`, so nothing recovers it.
            val manager = AppWidgetManager.getInstance(context)
            val shadowManager = shadowOf(manager)
            val widgetId = 90
            shadowManager.bindAppWidgetId(widgetId, ComponentName(context, OverviewWidget::class.java))
            val settings = Settings(context)
            settings.putWidgetSet(
                widgetId,
                listOf(record(boolHabit(id = 1, name = "Alpha"), widgetId = widgetId, rank = 0)),
            )
            HabitWidget.redraw(context)
            assertEquals(
                "the fixture is only meaningful from a frame that really had a row on it",
                "Alpha",
                name(shadowManager.getViewFor(widgetId)!!, 0),
            )

            WidgetSync.refreshFrom(context, emptyList())

            val view = shadowManager.getViewFor(widgetId)!!
            val note = view.findViewById<TextView>(R.id.overview_note)
            assertEquals(View.VISIBLE, note.visibility)
            assertEquals(context.getString(R.string.overview_empty), note.text.toString())
            assertEquals(
                "the archived habit's row must go with it, not stay on the last good frame",
                View.GONE,
                view.findViewById<View>(rowIds[0]).visibility,
            )
        }

    /* ---------- refreshFrom: the list's own fetch reconciles the rows ---------- */

    @Test
    fun `refreshFrom adds a row for a new habit and drops one that has left, through the store`(): Unit =
        runBlocking {
            // Read back through `Settings`, never through
            // `Widgets.reconcileOverview` — `WidgetTest` already pins the pure
            // function, and this package's repeated lesson is that a correct
            // pure function with a caller that does not reach it is exactly
            // where the bug lives.
            val manager = AppWidgetManager.getInstance(context)
            shadowOf(manager).bindAppWidgetId(85, ComponentName(context, OverviewWidget::class.java))
            val settings = Settings(context)
            settings.putWidgetSet(
                85,
                listOf(
                    record(boolHabit(id = 1, name = "Stays"), widgetId = 85, rank = 0),
                    record(boolHabit(id = 2, name = "Leaves"), widgetId = 85, rank = 1),
                ),
            )

            // The served list: "Leaves" is gone from the account and "Arrives"
            // is new, and the SERVED order puts the newcomer FIRST — which is
            // also what the ranks have to follow, or a habit added to an
            // account sorting by name would render last for ever.
            WidgetSync.refreshFrom(
                context,
                listOf(boolHabit(id = 3, name = "Arrives"), boolHabit(id = 1, name = "Stays")),
            )

            val rows = settings.cachedWidgetSet(85).sortedBy { it.rank }
            assertEquals(
                "the widget's rows must be exactly the habits the server served",
                listOf("Arrives", "Stays"),
                rows.map { it.name },
            )
            assertEquals("the newcomer takes the served list's own first rank", 0, rows[0].rank)
            assertEquals(1, rows[1].rank)
            assertTrue(
                "a habit that has left the account is dropped here, not kept and marked gone",
                settings.cachedWidgetSet(85).none { it.habitId == 2L },
            )
        }

    @Test
    fun `refreshFrom leaves a single-habit widget's untouched record in the store`(): Unit =
        runBlocking {
            // The regression `putWidgetSet` would introduce if the single-habit
            // records were pushed through it too: `refreshFrom` drops records a
            // refresh did not change, so "these are the widget's records now"
            // over that filtered list would purge every widget whose record was
            // already current.
            val manager = AppWidgetManager.getInstance(context)
            shadowOf(manager).bindAppWidgetId(86, ComponentName(context, HabitWidget::class.java))
            val settings = Settings(context)
            val habit = boolHabit(id = 1, name = "Meditate")
            val current = Widgets.refreshed(
                record(habit, widgetId = 86),
                habit,
                today,
            )
            settings.putWidgets(listOf(current))

            WidgetSync.refreshFrom(context, listOf(habit))

            assertEquals(
                "an unchanged single-habit record must survive a refresh that decided nothing",
                1,
                settings.cachedWidgetSet(86).size,
            )
        }

    @Test
    fun `refreshFrom keeps an answer still in the outbox over the server's older one`(): Unit =
        runBlocking {
            // The overview never writes, but the habit in a row is answered
            // elsewhere on this phone — a notification button, its number pad,
            // or a checkmark widget for the same habit — and all of those paint
            // through `noteAnswer` and then queue. A fetch landing while that
            // write is still pending carries an answer older than the tap, and
            // writing it over the row blanks a cell the user has answered.
            WorkManagerTestInitHelper.initializeTestWorkManager(context)
            val manager = AppWidgetManager.getInstance(context)
            shadowOf(manager).bindAppWidgetId(87, ComponentName(context, OverviewWidget::class.java))
            val settings = Settings(context)
            // The REAL current date, not this class's frozen `today`:
            // `refreshFrom` reads `LocalDate.now()` itself — a fetch is about
            // whenever it lands — and the "is a write still on its way for THIS
            // day" guard is asked about that day and no other. A fixture dated
            // 2026-08-16 exercises the `prior.date != today` arm instead and
            // passes against a `refreshFrom` with no guard in it at all.
            val now = java.time.LocalDate.now().toString()
            val answered = boolHabit(id = 1, name = "Meditate")
            val pendingRow = record(answered, widgetId = 87, rank = 0, date = now, value = Sentinels.YES)
            val quiet = boolHabit(id = 2, name = "Read")
            settings.putWidgetSet(
                87,
                listOf(pendingRow, record(quiet, widgetId = 87, rank = 1, date = now, value = Sentinels.YES)),
            )
            // Enqueued under `Outbox.workName` — the exact unique name
            // `Outbox.isPending` asks about, so this cannot drift from what the
            // real write does — but held unfinished by an initial delay the
            // test driver never meets. `Outbox.enqueue` itself cannot stand in
            // here: the test harness runs work synchronously and Robolectric
            // reports a connected network, so `SyncWorker` runs immediately,
            // finds no server configured, and answers `failure()` — FINISHED,
            // and so not pending, before the fetch below could ever overtake
            // it. The fixture has to be a write that is genuinely still on its
            // way, and the assertion under it is what proves it is one.
            WorkManager.getInstance(context).enqueueUniqueWork(
                Outbox.workName(answered.id, now),
                ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<Outbox.SyncWorker>()
                    .setInitialDelay(1, TimeUnit.HOURS)
                    .build(),
            )
            assertTrue(
                "the fixture is only meaningful while the write is actually pending",
                Outbox.isPending(context, answered.id, now),
            )

            // The server knows about neither answer: both habits come back with
            // no entry for today at all.
            WidgetSync.refreshFrom(context, listOf(answered, quiet))

            val rows = settings.cachedWidgetSet(87).associateBy { it.habitId }
            assertEquals(
                "a tap still in the outbox must survive the fetch that overtook it",
                Sentinels.YES,
                rows.getValue(1L).value,
            )
            assertNull(
                "a habit with nothing pending must take the server's answer, blank or not",
                rows.getValue(2L).value,
            )
        }

    /* ---------- the config activity's branch: which provider owns this id ---------- */

    /**
     * An installed provider whose `provider` names [type], which is the only
     * shape `getAppWidgetInfo` can answer from.
     *
     * `addBoundWidget` rather than the `bindAppWidgetId` the tests above use,
     * and the difference is not cosmetic: Robolectric's plain bind records only
     * the `ComponentName`, and its `getAppWidgetInfo` reads a field it sets
     * ONLY from a matching entry in the installed-provider list — so after a
     * bare `bindAppWidgetId` the info is NULL and the predicate below is false
     * for every id, including the overview one. A test written on that would
     * assert `false, false, false` and pass against a predicate that always
     * answers false. Confirmed by running it before this test was written.
     * `addBoundWidget` installs the provider AND binds the id, so
     * `getAppWidgetIds` still answers it too and this fixture agrees with the
     * one `liveIds` reads.
     */
    private fun bindProvider(widgetId: Int, type: Class<*>) {
        shadowOf(AppWidgetManager.getInstance(context)).addBoundWidget(
            widgetId,
            AppWidgetProviderInfo().apply { provider = ComponentName(context, type) },
        )
    }

    @Test
    fun `the config activity's branch answers true for an overview id and for neither other provider`() {
        // This predicate is the ONE path by which an overview widget ever
        // acquires records, and every way of being wrong in it is silent: the
        // wrong provider's name, `shortClassName` instead of `className`, the
        // ComponentName's own `toString`, or a null info swallowed the wrong
        // way. Each one sends a freshly placed overview widget into the habit
        // PICKER, which seeds it a single record and leaves a seven-row grid
        // holding one row — with nothing on screen saying why. Nothing else in
        // this suite reaches it: `seed`'s two effects are pinned above through
        // `reconcileOverview` and `putWidgetSet`, and both are reached only
        // once this answers true.
        val manager = AppWidgetManager.getInstance(context)
        bindProvider(91, OverviewWidget::class.java)
        bindProvider(92, HabitWidget::class.java)
        bindProvider(93, StatsWidget::class.java)

        // The fixture has to be able to tell the two name forms apart, or the
        // assertion below cannot see a `shortClassName` comparison at all.
        assertNotEquals(
            "className and shortClassName must differ in this fixture",
            manager.getAppWidgetInfo(91)!!.provider.className,
            manager.getAppWidgetInfo(91)!!.provider.shortClassName,
        )

        assertTrue(
            "an overview id must take the seed branch",
            WidgetConfigActivity.isOverview(manager, 91),
        )
        assertFalse(
            "a checkmark id must take the picker",
            WidgetConfigActivity.isOverview(manager, 92),
        )
        assertFalse(
            "a stats id must take the picker",
            WidgetConfigActivity.isOverview(manager, 93),
        )
        assertFalse(
            "an id the launcher no longer holds has no info, and must not read as an overview",
            WidgetConfigActivity.isOverview(manager, 94),
        )
    }

    /* ---------- the heartbeat reaches a widget that holds nothing yet ---------- */

    @Test
    fun `refreshFromServer fetches for an overview widget that holds no records yet`(): Unit =
        runBlocking {
            // The six-hourly heartbeat used to ask the STORE alone whether any
            // widget existed, and an overview widget placed but never seeded —
            // its configuration activity dismissed, killed, or run with no
            // server reachable — holds no records at all. So the one path that
            // could ever have filled it was the one path that skipped it, and
            // the grid stayed empty until it was deleted and placed again.
            val server = MockWebServer()
            server.enqueue(
                MockResponse().setResponseCode(200).setBody(
                    """{"start":"2026-08-10","end":"2026-08-16","habits":[]}""",
                ),
            )
            server.start()
            try {
                shadowOf(AppWidgetManager.getInstance(context))
                    .bindAppWidgetId(88, ComponentName(context, OverviewWidget::class.java))
                assertTrue(
                    "the fixture is only meaningful while the store is genuinely empty",
                    Settings(context).cachedWidgets().isEmpty(),
                )

                WidgetSync.refreshFromServer(context, Api(server.url("/").toString()))

                assertEquals(
                    "an overview widget with no records is exactly the one that needs filling",
                    1,
                    server.requestCount,
                )
            } finally {
                server.shutdown()
            }
        }

    @Test
    fun `refreshFromServer still asks nothing when there is no widget of any kind`(): Unit =
        runBlocking {
            // The other half, and it is the reason the guard exists: a phone
            // with no widget on its home screen must not spend a request every
            // six hours. Widening the guard must not cost this.
            val server = MockWebServer()
            server.start()
            try {
                WidgetSync.refreshFromServer(context, Api(server.url("/").toString()))
                assertEquals(
                    "no records and no widget bound: the heartbeat must make no request",
                    0,
                    server.requestCount,
                )
            } finally {
                server.shutdown()
            }
        }
}
