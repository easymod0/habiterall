package com.habiterall.app

import android.app.NotificationManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onNodeWithText
import com.habiterall.app.data.Api
import com.habiterall.app.data.AppSettings
import com.habiterall.app.ui.Manage
import com.habiterall.app.ui.ManageScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The two platform questions the settings branch asks, over the CALL SITE that
 * asks them.
 *
 * [SettingsScreenTest] pins the rendering — given `exactAlarmsRevoked = true`,
 * the line is drawn — and `RemindersTest` pins the predicate. Neither can see
 * `ManageScreen`, where the two are joined:
 *
 * ```
 * androidRemindersSupported = NotificationManagerCompat.from(context).areNotificationsEnabled(),
 * exactAlarmsRevoked = Reminders.exactAlarmsRevoked(context),
 * ```
 *
 * Both are required parameters, so neither can be deleted — but either can be
 * replaced by a constant, or the two can be swapped for each other, and every
 * other test in this package stays green. That is this project's most expensive
 * defect shape and this file's own history: four Android bugs, and then two
 * more, lived one line below the pure function that pinned them.
 *
 * So nothing here passes a boolean in. The cases move the PLATFORM — the SDK
 * level Robolectric reports, `ShadowAlarmManager`'s answer to
 * `canScheduleExactAlarms()`, `ShadowNotificationManager`'s answer to
 * `areNotificationsEnabled()` — and assert what reaches the screen. A constant
 * at either call site fails at least one case in each pair below.
 */
@RunWith(RobolectricTestRunner::class)
@Config(
    application = android.app.Application::class,
    // Tall enough that nothing under test is below the fold, for the reason
    // [SettingsScreenTest] gives.
    qualifiers = "w400dp-h3000dp",
)
class ManageScreenWiringTest {

    @get:Rule val compose = createComposeRule()

    /**
     * Render the real management screen on its settings branch.
     *
     * The [Api] is constructed and never called: `ManageScreen` only reaches it
     * from inside a callback, and no case here presses a control. Constructing
     * it is cheap and does no I/O — [com.habiterall.app.data.WebSession.jar]
     * asks `CookieManager` lazily, per request.
     */
    private fun show() {
        compose.setContent {
            ManageScreen(
                screen = Manage.Settings,
                api = Api("http://127.0.0.1:1/"),
                account = AppSettings(),
                onAccount = {},
                categories = emptyList(),
                onEditArchived = { _, _ -> },
                onDone = {},
            )
        }
    }

    private fun notificationsEnabled(on: Boolean) {
        val manager = RuntimeEnvironment.getApplication()
            .getSystemService(NotificationManager::class.java)
        shadowOf(manager).setNotificationsEnabled(on)
    }

    /**
     * 31-32 with "Alarms & reminders" revoked is the one range the whole split
     * exists for, and `ShadowAlarmManager` answers `canScheduleExactAlarms()`
     * false by default — so this is the platform saying revoked and the call
     * site carrying it to the screen.
     */
    @Test
    @Config(sdk = [32])
    fun `a revoked exact-alarm toggle reaches the screen from the call site`() {
        show()
        compose.onNodeWithText("can arrive late", substring = true).assertIsDisplayed()
    }

    /**
     * The upper bound, which is the load-bearing half: from 33 the app holds
     * `USE_EXACT_ALARM` at protection level `normal`, so there is nothing to
     * have revoked and the sentence would be false on every current phone.
     *
     * `ShadowAlarmManager` still answers `canScheduleExactAlarms()` false here,
     * so a call site that hardcoded `exactAlarmsRevoked = true` — or one that
     * asked `AlarmManager` directly instead of [com.habiterall.app.notify.Reminders.exactAlarmsRevoked] —
     * fails exactly this case. Absence is keyed on "Alarms & reminders": the
     * notifications subtitle also contains "in Android settings", so keying on
     * that would pass for the wrong reason.
     */
    @Test
    @Config(sdk = [33])
    fun `the SDK upper bound reaches the screen from the call site`() {
        show()
        compose.onAllNodes(hasText("Alarms & reminders", substring = true))
            .assertCountEquals(0)
    }

    /** The sibling hop, moved from the platform rather than passed in. */
    @Test
    @Config(sdk = [32])
    fun `notifications switched off in Android settings reach the screen`() {
        notificationsEnabled(false)
        show()
        compose.onNodeWithText(
            "Notifications are switched off for this app in Android settings.",
        ).assertIsDisplayed()
    }

    /**
     * The other half of that pair. Without it, `androidRemindersSupported =
     * false` written as a constant would pass the case above — a subtitle that
     * is always the `else` branch is not the platform being consulted.
     */
    @Test
    @Config(sdk = [32])
    fun `notifications left alone leave the ordinary subtitle in place`() {
        notificationsEnabled(true)
        show()
        compose.onNodeWithText("A local alarm, so it fires with no network", substring = true)
            .assertIsDisplayed()
    }
}
