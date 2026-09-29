package com.habiterall.app

import android.app.Application
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Sentinels
import com.habiterall.app.data.Settings
import com.habiterall.app.data.Widgets
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * What the record store does with SEVERAL records under one widget id.
 *
 * The store used to assume one record per widget, which was true while every
 * provider showed one habit. The overview widget holds one record per habit,
 * so `Settings.putWidgets` keys on the PAIR — and that change, on its own,
 * introduces a regression at the other end: a reconfigure that used to REPLACE
 * a widget's record now merges alongside it, leaving `cachedWidget`'s
 * `firstOrNull` free to answer the habit the launcher stopped showing.
 * `putWidgetSet` is what closes it, and the third test here is that pairing.
 *
 * Robolectric rather than `WidgetTest`, which is a plain JVM suite: this is
 * the store, `Settings` needs a `Context`, and the assertions are what comes
 * back OUT of DataStore rather than what a pure function returned.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class WidgetStoreTest {

    private val context get() = RuntimeEnvironment.getApplication()

    private val today = "2026-08-16"

    /**
     * `preferencesDataStore` is a JVM-static singleton, so the widget blob one
     * test writes is still there for the next one in the same fork — and
     * unlike `StatsWidgetTest`, whose readers all filter by an explicit widget
     * id, this suite asserts over the SIZE of a widget's set, where another
     * test's leftovers under the same id would read as a real record.
     * `replaceWidgets(emptyList())` rather than `removeWidgets`, which would
     * need the ids before each test has chosen them.
     */
    @Before
    fun emptyTheWidgetStore(): Unit = runBlocking {
        Settings(context).replaceWidgets(emptyList())
    }

    private fun habit(id: Long, name: String) = Habit(id = id, name = name)

    /**
     * Nothing here holds a field's default where the test is about that field:
     * the names differ, the colours differ, and the day carries a stated
     * answer, so a record that came back as the WRONG one of two is visible
     * rather than equal to its sibling.
     */
    private fun record(
        habit: Habit,
        widgetId: Int,
        color: String = "#ff0000",
        value: Double? = Sentinels.YES,
    ) = Widgets.Record(
        widgetId = widgetId,
        habitId = habit.id,
        name = habit.name,
        type = habit.type,
        targetValue = habit.targetValue,
        targetType = habit.targetType,
        showAs = habit.showAs,
        color = color,
        unit = habit.unit,
        date = today,
        value = value,
        skip = false,
    )

    /* ---------- one widget id, several habits ---------- */

    @Test
    fun `two records under one widget id both survive putWidgets`(): Unit = runBlocking {
        val settings = Settings(context)
        val widgetId = 11
        settings.putWidgets(
            listOf(
                record(habit(1, "Meditate"), widgetId),
                record(habit(2, "Water"), widgetId),
            ),
        )

        // Keyed on the widget id alone this was ONE record — the second write
        // overwriting the first inside the same call — and an overview widget
        // would draw a single row however many habits the account has.
        val set = settings.cachedWidgetSet(widgetId)
        assertEquals("both habits must be stored under the one widget id", 2, set.size)
        assertEquals(listOf("Meditate", "Water"), set.map { it.name })
        assertEquals(listOf(1L, 2L), set.map { it.habitId })
    }

    @Test
    fun `putWidgets still replaces the record for the same widget and habit`(): Unit = runBlocking {
        val settings = Settings(context)
        val widgetId = 12
        settings.putWidgets(listOf(record(habit(1, "Meditate"), widgetId, value = Sentinels.YES)))
        settings.putWidgets(listOf(record(habit(1, "Meditate"), widgetId, value = null)))

        // The upsert half of the pair key: a tap writing its own record back
        // must not accumulate a second copy of the same habit's day.
        val set = settings.cachedWidgetSet(widgetId)
        assertEquals("one habit on one widget is still one record", 1, set.size)
        assertNull("the later write wins", set.single().value)
    }

    @Test
    fun `cachedWidgetSet answers only the id asked for`(): Unit = runBlocking {
        val settings = Settings(context)
        settings.putWidgets(
            listOf(
                record(habit(1, "Meditate"), widgetId = 13),
                record(habit(2, "Water"), widgetId = 14),
            ),
        )

        assertEquals(listOf("Meditate"), settings.cachedWidgetSet(13).map { it.name })
        assertEquals(listOf("Water"), settings.cachedWidgetSet(14).map { it.name })
    }

    /* ---------- putWidgetSet purges before it writes ---------- */

    @Test
    fun `putWidgetSet drops the widget's previous records`(): Unit = runBlocking {
        val settings = Settings(context)
        val widgetId = 15
        settings.putWidgets(
            listOf(
                record(habit(1, "Meditate"), widgetId),
                record(habit(2, "Water"), widgetId),
                record(habit(3, "Read"), widgetId),
            ),
        )

        settings.putWidgetSet(widgetId, listOf(record(habit(2, "Water"), widgetId)))

        // "These are the widget's habits now" — a habit the new set does not
        // name is gone, which a merge would have kept drawing.
        val set = settings.cachedWidgetSet(widgetId)
        assertEquals(1, set.size)
        assertEquals(2L, set.single().habitId)
        assertEquals("Water", set.single().name)
    }

    @Test
    fun `putWidgetSet leaves every other widget's records alone`(): Unit = runBlocking {
        val settings = Settings(context)
        settings.putWidgets(
            listOf(
                record(habit(1, "Meditate"), widgetId = 16),
                record(habit(2, "Water"), widgetId = 17),
            ),
        )

        settings.putWidgetSet(16, listOf(record(habit(3, "Read"), widgetId = 16)))

        assertEquals(listOf("Read"), settings.cachedWidgetSet(16).map { it.name })
        assertEquals(
            "a purge is one widget id's, not the blob's",
            listOf("Water"),
            settings.cachedWidgetSet(17).map { it.name },
        )
    }

    /* ---------- the regression the pair key introduces, closed ---------- */

    @Test
    fun `reconfiguring a widget from one habit to another leaves only the new habit`(): Unit =
        runBlocking {
            val settings = Settings(context)
            val widgetId = 18
            settings.putWidgets(listOf(record(habit(1, "Meditate"), widgetId)))

            // What `WidgetConfigActivity` does the second time it is opened,
            // through the store rather than around it.
            settings.putWidgetSet(widgetId, listOf(record(habit(2, "Water"), widgetId)))

            assertEquals(
                "the old habit's record must not survive a reconfigure",
                1,
                settings.cachedWidgetSet(widgetId).size,
            )
            val single = settings.cachedWidget(widgetId)
            assertEquals(
                "the home screen shows the new habit, so a tap must record it too",
                2L,
                single?.habitId,
            )
            assertEquals("Water", single?.name)
        }

    /* ---------- deletion ---------- */

    @Test
    fun `removeWidgets drops every row of a multi-record widget id`(): Unit = runBlocking {
        val settings = Settings(context)
        val doomed = 19
        val kept = 20
        settings.putWidgets(
            listOf(
                record(habit(1, "Meditate"), doomed),
                record(habit(2, "Water"), doomed),
                record(habit(3, "Read"), kept),
            ),
        )

        settings.removeWidgets(listOf(doomed))

        assertEquals(
            "a deleted widget leaves none of its habits behind",
            emptyList<String>(),
            settings.cachedWidgetSet(doomed).map { it.name },
        )
        assertEquals(listOf("Read"), settings.cachedWidgetSet(kept).map { it.name })
    }
}
