package com.habiterall.app

import android.app.Application
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.test.core.app.ActivityScenario
import androidx.work.testing.WorkManagerTestInitHelper
import com.habiterall.app.data.DayEnd
import com.habiterall.app.data.Settings
import com.habiterall.app.ui.MainActivity
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.time.Clock
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Collections

/**
 * The list's fetch, driven through the REAL `MainActivity` (#76).
 *
 * `HabitListScreen` is a private member of the activity, so the guard in
 * `MainActivityWiringTest` could only read its source; this launches it against
 * a server and asks what reached the wire and what reached the screen. Two
 * things only the fetch effect can get wrong, and each of them is one line:
 *
 * - `DayEnd.adopt` has to run BEFORE `api.overview`, because the overview is the
 *   request that carries the boundary and anchors the window on it. Adopted
 *   after, the fetch that first learns a new boundary is the one sent under the
 *   old one, and the grid draws a day it has just been told has not ended.
 * - the `today` the grid is built from is re-read from [DayEnd] after it.
 *
 * The clock is 00:30 on a Monday and the server says 03:00, so the screen is
 * right only if both lines are: the newest column is Sunday, and Monday has no
 * column at all.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class MainActivityDayEndTest {

    @get:Rule val compose = createEmptyComposeRule()

    private val context get() = RuntimeEnvironment.getApplication()
    private lateinit var server: MockWebServer
    private val requests = Collections.synchronizedList(mutableListOf<RecordedRequest>())

    @Before
    fun setUp(): Unit = runBlocking {
        DayEnd.load(context)
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.path.orEmpty()
                val body = when {
                    path.startsWith("/api/me") -> """{"mode":"none"}"""
                    path.startsWith("/api/settings") -> """{"dayEndsAt":"03:00"}"""
                    path.startsWith("/api/overview") ->
                        """{"start":"2026-08-04","end":"2026-08-17",
                            "habits":[{"id":1,"name":"Water"}]}"""
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setResponseCode(200).setBody(body)
            }
        }
        server.start()
        Settings(context).setServerUrl(server.url("/").toString())
    }

    /** `DayEnd` is an `object` and outlives this class: see `DayEndTest`. */
    @After
    fun tearDown() {
        scenario?.close()
        DayEnd.clock = null
        DayEnd.load(context)
        server.shutdown()
    }

    private fun mondayAt0030() {
        val toronto = ZoneId.of("America/Toronto")
        DayEnd.clock = Clock.fixed(
            ZonedDateTime.of(2026, 8, 17, 0, 30, 0, 0, toronto).toInstant(),
            toronto,
        )
    }

    private var scenario: ActivityScenario<MainActivity>? = null

    private fun launchList() {
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    @Test
    fun `the fetch that first learns a 03-00 boundary draws yesterday as the newest day`() {
        mondayAt0030()
        launchList()

        compose.waitUntil(15_000) { hasCell("Water, Sunday 16 August") }
        compose.onNodeWithContentDescription("Water, Sunday 16 August", substring = true)
            .assertIsDisplayed()
        assertFalse(
            "Monday has not started for this account, so it has no column",
            hasCell("Water, Monday 17 August"),
        )
    }

    @Test
    fun `the overview of that same fetch already carries the boundary it just learned`() {
        mondayAt0030()
        launchList()

        compose.waitUntil(15_000) { requests.any { it.path.orEmpty().startsWith("/api/overview") } }
        val paths = synchronized(requests) { requests.map { it.path.orEmpty() } }
        val settingsAt = paths.indexOfFirst { it.startsWith("/api/settings") }
        val overviewAt = paths.indexOfFirst { it.startsWith("/api/overview") }
        assertTrue("settings is read first", settingsAt in 0 until overviewAt)
        assertEquals(
            "the default was in force when the fetch began; the answer must have been adopted " +
                "before the overview went out",
            "03:00",
            synchronized(requests) { requests[overviewAt] }.getHeader("X-Habiterall-Day-End"),
        )
        // The control: the request that LEARNED it was sent under the old one.
        assertEquals(
            "00:00",
            synchronized(requests) { requests[settingsAt] }.getHeader("X-Habiterall-Day-End"),
        )
    }

    private fun hasCell(description: String): Boolean =
        compose.onAllNodesWithContentDescription(description, substring = true)
            .fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()
}
