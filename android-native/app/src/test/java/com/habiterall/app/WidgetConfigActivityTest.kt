package com.habiterall.app

import android.app.Application
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Intent
import android.os.Looper
import androidx.work.testing.WorkManagerTestInitHelper
import com.habiterall.app.data.Settings
import com.habiterall.app.data.Widgets
import com.habiterall.app.widget.HabitWidget
import com.habiterall.app.widget.OverviewWidget
import com.habiterall.app.widget.WidgetConfigActivity
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlertDialog

/**
 * The configuration activity itself, launched — not the predicate it asks or
 * the store it writes to, each of which is pinned elsewhere.
 *
 * What only this can see is the WIRING: that a bound overview id reaches
 * `seed` and writes its whole set through `putWidgetSet`, and that a
 * reconfigured single-habit id reaches `choose` and REPLACES rather than
 * merges. Both are one line in a private method that every other test reaches
 * around, and `putWidgets` in either place still compiles and still looks right
 * on a first configuration.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class WidgetConfigActivityTest {

    private val context get() = RuntimeEnvironment.getApplication()
    private lateinit var server: MockWebServer

    @Before
    fun setUp(): Unit = runBlocking {
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
        Settings(context).replaceWidgets(emptyList())
        server = MockWebServer()
        server.start()
        Settings(context).setServerUrl(server.url("/").toString())
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun bind(widgetId: Int, type: Class<*>) {
        shadowOf(AppWidgetManager.getInstance(context)).addBoundWidget(
            widgetId,
            AppWidgetProviderInfo().apply { provider = ComponentName(context, type) },
        )
    }

    private fun serve(vararg names: String) {
        val habits = names.mapIndexed { i, n -> """{"id":${i + 1},"name":"$n"}""" }
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"start":"2026-08-10","end":"2026-08-16","habits":[${habits.joinToString(",")}]}""",
            ),
        )
    }

    private fun launch(widgetId: Int) = Robolectric.buildActivity(
        WidgetConfigActivity::class.java,
        Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId),
    ).create()

    /** The activity works on IO threads and the main looper; wait for [done] on both. */
    private fun await(what: String, done: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            if (done()) return
            Thread.sleep(25)
        }
        throw AssertionError("timed out waiting for: $what")
    }

    private fun stored(widgetId: Int) =
        runBlocking { Settings(context).cachedWidgetSet(widgetId) }

    @Test
    fun `placing an overview widget seeds every habit as its whole set`() {
        bind(41, OverviewWidget::class.java)
        // A leftover row for a habit the account no longer has: `seed` must
        // REPLACE the set, and a `putWidgets` merge would leave it standing.
        runBlocking {
            Settings(context).putWidgets(
                listOf(Widgets.blank(41, 99).copy(name = "Left over")),
            )
        }
        serve("Meditate", "Water")

        val controller = launch(41)
        await("the overview widget's set to be seeded") {
            stored(41).map { it.name } == listOf("Meditate", "Water")
        }

        assertEquals(listOf(0, 1), stored(41).map { it.rank })
        await("the activity to finish") { controller.get().isFinishing }
    }

    @Test
    fun `reconfiguring a checkmark widget replaces its habit rather than adding one`() {
        bind(42, HabitWidget::class.java)
        runBlocking {
            Settings(context).putWidgets(listOf(Widgets.blank(42, 1).copy(name = "Meditate")))
        }
        serve("Meditate", "Water")

        launch(42)
        await("the habit picker") { ShadowAlertDialog.getLatestAlertDialog() != null }
        val dialog = ShadowAlertDialog.getLatestAlertDialog()!!
        shadowOf(dialog).clickOnItem(1)

        await("the reconfigured widget to hold only Water") {
            stored(42).map { it.name } == listOf("Water")
        }
        assertTrue(stored(42).none { it.habitId == 1L })
    }
}
