package com.habiterall.app

import android.app.AlarmManager
import android.app.Application
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.widget.TextView
import androidx.work.testing.WorkManagerTestInitHelper
import com.habiterall.app.data.DayEnd
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Outbox
import com.habiterall.app.data.Sentinels
import com.habiterall.app.data.Settings
import com.habiterall.app.data.Widgets
import com.habiterall.app.widget.WidgetSync
import com.habiterall.app.notify.Reminders
import com.habiterall.app.widget.HabitWidget
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * A day that ends after midnight (#76), reaching the widgets: the date a tap is
 * recorded against, the date a frame is drawn for, and the instant the redraw
 * alarm is aimed at.
 *
 * `WidgetTest` pins `nextDayStart` and `stateOn` as arithmetic; none of that
 * proves `tap`, `redraw` or `armMidnight` ask [DayEnd] — each of them used to
 * read `LocalDate.now()` and a wrong one reads as clean everywhere else. So the
 * assertions are what reached the work queue, the inflated view and the alarm
 * manager, at a clock this suite sets: 00:30 on a Monday, under a 03:00 day end,
 * is still Sunday.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class WidgetDayEndTest {

    private val context get() = RuntimeEnvironment.getApplication()

    private val toronto = ZoneId.of("America/Toronto")

    /** Monday 2026-08-17, 00:30 local: calendar-today is the 17th. */
    private val monday0030 = ZonedDateTime.of(2026, 8, 17, 0, 30, 0, 0, toronto)
    private val sunday = "2026-08-16"
    private val monday = "2026-08-17"

    private fun clockAt(at: ZonedDateTime): Clock = Clock.fixed(at.toInstant(), toronto)

    @Before
    fun cleanSlate(): Unit = runBlocking {
        Reminders.lastArmWasExact = null
        Settings(context).replaceWidgets(emptyList())
        DayEnd.load(context)
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
    }

    /** `DayEnd` is an `object` and outlives this class: see `DayEndTest`. */
    @After
    fun putTheDayBack() {
        DayEnd.reset(context)
    }

    private fun habit() = Habit(id = 1, name = "Meditate")

    private fun record(habit: Habit, widgetId: Int, date: String, value: Double? = null) =
        Widgets.Record(
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
            skip = false,
        )

    private fun bind(widgetId: Int) {
        shadowOf(AppWidgetManager.getInstance(context))
            .bindAppWidgetId(widgetId, ComponentName(context, HabitWidget::class.java))
    }

    private val alarmManager get() = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    @Test
    fun `a tap at 00-30 under a 03-00 day end is recorded against yesterday, and painted there`(): Unit =
        runBlocking {
            DayEnd.adopt(context, "03:00")
            DayEnd.clock = clockAt(monday0030)
            val settings = Settings(context)
            // The record is about a stale day, as one is on a home screen left
            // across the night; the tap has to resolve its own day.
            settings.putWidgets(listOf(record(habit(), 51, date = "2026-08-15")))

            HabitWidget().tap(context, 51)

            assertTrue(
                "the write is queued for the day that has not ended",
                Outbox.isPending(context, 1, sunday),
            )
            assertFalse(
                "and not for the calendar's today",
                Outbox.isPending(context, 1, monday),
            )
            val after = settings.cachedWidget(51)!!
            assertEquals("the frame is painted for that day", sunday, after.date)
            assertEquals(Sentinels.YES, after.value)
        }

    @Test
    fun `the same tap with the default boundary is recorded against the calendar's day`(): Unit =
        runBlocking {
            // The control: it is the boundary that moves the date, not the clock.
            DayEnd.clock = clockAt(monday0030)
            Settings(context).putWidgets(listOf(record(habit(), 51, date = "2026-08-15")))

            HabitWidget().tap(context, 51)

            assertTrue(Outbox.isPending(context, 1, monday))
            assertFalse(Outbox.isPending(context, 1, sunday))
        }

    @Test
    fun `armMidnight at 00-30 under a 03-00 day end aims at 03-00 today`() {
        DayEnd.clock = clockAt(monday0030)
        runBlocking { DayEnd.adopt(context, "03:00") }
        bind(52)
        shadowOf(alarmManager).scheduledAlarms.clear()

        HabitWidget.armMidnight(context)

        val at = Instant.ofEpochMilli(shadowOf(alarmManager).scheduledAlarms.single().triggerAtTime)
            .atZone(toronto)
        assertEquals(ZonedDateTime.of(2026, 8, 17, 3, 0, 0, 0, toronto), at)
    }

    @Test
    fun `armMidnight at the default still aims at the next midnight`() {
        DayEnd.clock = clockAt(monday0030)
        bind(52)
        shadowOf(alarmManager).scheduledAlarms.clear()

        HabitWidget.armMidnight(context)

        val at = Instant.ofEpochMilli(shadowOf(alarmManager).scheduledAlarms.single().triggerAtTime)
            .atZone(toronto)
        assertEquals(ZonedDateTime.of(2026, 8, 18, 0, 0, 0, 0, toronto), at)
    }

    private fun markDrawnFor(widgetId: Int): String =
        shadowOf(AppWidgetManager.getInstance(context)).getViewFor(widgetId)
            .findViewById<TextView>(R.id.widget_mark).text.toString()

    @Test
    fun `redraw at 00-30 under a 03-00 day end keeps yesterday's answer on the cell`(): Unit =
        runBlocking {
            DayEnd.adopt(context, "03:00")
            DayEnd.clock = clockAt(monday0030)
            bind(53)
            Settings(context).putWidgets(
                listOf(record(habit(), 53, date = sunday, value = Sentinels.YES))
            )

            HabitWidget.redraw(context)

            assertEquals("Sunday is the day still being lived, and was answered", "✓", markDrawnFor(53))
        }

    @Test
    fun `redraw at 00-30 with the default boundary has rolled the same cell over`(): Unit =
        runBlocking {
            DayEnd.clock = clockAt(monday0030)
            bind(53)
            Settings(context).putWidgets(
                listOf(record(habit(), 53, date = sunday, value = Sentinels.YES))
            )

            HabitWidget.redraw(context)

            assertEquals("the control: at midnight Sunday's answer is yesterday's", "", markDrawnFor(53))
        }

    @Test
    fun `a refresh at 00-30 under a 03-00 day end dates the record yesterday and reads yesterday's answer`(): Unit =
        runBlocking {
            DayEnd.adopt(context, "03:00")
            DayEnd.clock = clockAt(monday0030)
            val settings = Settings(context)
            settings.putWidgets(listOf(record(habit(), 54, date = "2026-08-15")))

            // Sunday answered yes, Monday (calendar-today) answered no: a refresh
            // that read the calendar would date the record the 17th and show the
            // lapse.
            WidgetSync.refreshFrom(
                context,
                listOf(habit().copy(entries = mapOf(sunday to Sentinels.YES, monday to 0.0))),
            )

            val after = settings.cachedWidget(54)!!
            assertEquals(sunday, after.date)
            assertEquals(Sentinels.YES, after.value)
            assertEquals(sunday, after.historyThrough)
        }

    /**
     * The boundary moving LATER at 00:45 on a Tuesday takes "today" backwards to
     * Monday, which nothing else does. A record dated Tuesday would then read
     * unknown, a tap would cycle from there over a stored Monday answer, and
     * `answered` would ignore it as older — until a refresh the phone may not
     * get for hours.
     */
    @Test
    fun `adopting a later boundary at 00-45 rewinds a record dated past the new today`(): Unit =
        runBlocking {
            val tuesday = "2026-08-18"
            DayEnd.clock = clockAt(ZonedDateTime.of(2026, 8, 18, 0, 45, 0, 0, toronto))
            bind(55)
            val settings = Settings(context)
            settings.putWidgets(
                listOf(
                    record(habit(), 55, date = tuesday).copy(
                        history = "$monday:${Sentinels.YES}",
                    )
                )
            )

            assertTrue(DayEnd.adopt(context, "03:00"))

            val rewound = settings.cachedWidget(55)!!
            assertEquals(monday, rewound.date)
            assertEquals("Monday's own answer, read from the history", Sentinels.YES, rewound.value)
            assertFalse(rewound.skip)
            assertEquals("and it is drawn", "✓", markDrawnFor(55))

            HabitWidget().tap(context, 55)

            val after = settings.cachedWidget(55)!!
            assertEquals(monday, after.date)
            assertEquals("DONE cycles to NO, where unknown would have cycled to YES", 0.0, after.value)
            assertTrue(Outbox.isPending(context, 1, monday))
            assertFalse(Outbox.isPending(context, 1, tuesday))
        }

    /**
     * Not only `adopt`: `redraw` is where every path ends, so a record dated
     * past today is rewound there whoever put it there.
     */
    @Test
    fun `redraw rewinds a record dated past today`(): Unit = runBlocking {
        DayEnd.clock = clockAt(ZonedDateTime.of(2026, 8, 17, 12, 0, 0, 0, toronto))
        bind(58)
        val settings = Settings(context)
        settings.putWidgets(
            listOf(
                record(habit(), 58, date = "2026-08-18").copy(history = "$monday:${Sentinels.YES}")
            )
        )

        HabitWidget.redraw(context)

        val after = settings.cachedWidget(58)!!
        assertEquals(monday, after.date)
        assertEquals(Sentinels.YES, after.value)
        assertEquals("✓", markDrawnFor(58))
    }

    /**
     * A write made under the old boundary and delivered after the change: its
     * date is Tuesday's, so `answered` moves the record forward past today, and
     * the redraw it ends in has to bring it back.
     */
    @Test
    fun `a late delivery of a write dated past today leaves the record on today`(): Unit =
        runBlocking {
            val tuesday = "2026-08-18"
            DayEnd.clock = clockAt(ZonedDateTime.of(2026, 8, 18, 0, 45, 0, 0, toronto))
            bind(59)
            val settings = Settings(context)
            settings.putWidgets(listOf(record(habit(), 59, date = monday, value = 0.0)))
            assertTrue(DayEnd.adopt(context, "03:00"))

            WidgetSync.noteAnswer(context, 1, tuesday, Sentinels.YES, false)

            assertEquals(monday, settings.cachedWidget(59)!!.date)
        }

    @Test
    fun `rewound takes the day's answer from the history, and unanswered when there is none`() {
        val base = record(habit(), 56, date = "2026-08-18", value = Sentinels.YES)

        val no = Widgets.rewound(base.copy(history = "$monday:0.0"), monday)
        assertEquals(monday, no.date)
        assertEquals(0.0, no.value)
        assertFalse(no.skip)

        val skipped = Widgets.rewound(base.copy(history = "$monday:s"), monday)
        assertEquals(null, skipped.value)
        assertTrue(skipped.skip)

        val unknown = Widgets.rewound(base.copy(skip = true, history = ""), monday)
        assertEquals(monday, unknown.date)
        assertEquals(null, unknown.value)
        assertFalse(unknown.skip)
    }

    @Test
    fun `rewound leaves a record that is not after today exactly as it was`() {
        val same = record(habit(), 57, date = monday, value = Sentinels.YES)
            .copy(history = "$sunday:0.0")
        assertEquals(same, Widgets.rewound(same, monday))

        val older = record(habit(), 57, date = sunday, value = 0.0)
        assertEquals(older, Widgets.rewound(older, monday))
    }
}
