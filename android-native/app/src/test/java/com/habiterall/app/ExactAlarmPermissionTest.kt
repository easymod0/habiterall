package com.habiterall.app

import android.app.Application
import android.content.pm.PackageManager
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Which exact-alarm permissions the APK actually asks the platform for.
 *
 * `Reminders.setAlarm` takes the exact branch only when
 * `canScheduleExactAlarms()` says it may, and that answer comes from the
 * MANIFEST rather than from anything Kotlin — so nothing in the notify package
 * can be made to fail by dropping a permission. The client shipped
 * `SCHEDULE_EXACT_ALARM` alone while targeting 33+ — which Android 14 and later
 * deny by default — and every test passed: the exact branch was simply never
 * taken. This suite is the assertion that would have failed.
 *
 * It reads the MERGED manifest — the one AGP produced and the one the platform
 * would see — through `PackageManager`, not the source XML at a hand-written
 * relative path. Pinning the decision is not pinning the wiring.
 *
 * Robolectric DOES apply `maxSdkVersion` filtering, and that was checked before
 * this suite was written rather than assumed: with the manifest as it stands,
 * `requestedPermissions` reports `SCHEDULE_EXACT_ALARM` under `sdk = [32]` and
 * does NOT report it under `sdk = [34]`. So the cap is asserted by running the
 * same read at both levels, which is why there are two tests and why each one
 * carries its own `@Config`. The fallback route — parsing the merged manifest
 * file named by `android_merged_manifest` in
 * `com/android/tools/test_config.properties` — is not needed and is not here;
 * it would assert the XML rather than what the framework does with it.
 *
 * `application = Application::class` rather than `HabiterallApp`, for
 * `ReminderWiringTest`'s reason: that one enqueues WorkManager on creation and
 * none of this goes near it. The permissions read is unaffected either way —
 * `<application>` is not where a `<uses-permission>` lives.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class ExactAlarmPermissionTest {

    /** What the merged manifest asks for, as the framework reports it. */
    private fun requestedPermissions(): List<String> {
        val app: Application = RuntimeEnvironment.getApplication()
        val info = app.packageManager.getPackageInfo(app.packageName, PackageManager.GET_PERMISSIONS)
        return info.requestedPermissions?.toList().orEmpty()
    }

    // The literal strings, never `Manifest.permission.*`: a test that imports
    // the constant it checks pins the name and nothing else.
    private val useExactAlarm = "android.permission.USE_EXACT_ALARM"
    private val scheduleExactAlarm = "android.permission.SCHEDULE_EXACT_ALARM"

    @Test
    @Config(sdk = [34])
    fun `on Android 14 the app asks for USE_EXACT_ALARM and no longer for SCHEDULE_EXACT_ALARM`() {
        val requested = requestedPermissions()
        // USE_EXACT_ALARM is protection level `normal`: granted at install and
        // not revocable, so `canScheduleExactAlarms()` is true unconditionally
        // and every reminder on 33+ takes the exact branch. Without this line
        // the app is back to being denied by default and drifting.
        assertTrue(
            "the APK must request USE_EXACT_ALARM, or every reminder on 33+ is inexact; got $requested",
            useExactAlarm in requested,
        )
        // And the other one is capped, which is the whole of what
        // `android:maxSdkVersion="32"` buys: above 32 it is redundant with the
        // permission above and would be a second, user-revocable answer to the
        // same question.
        assertFalse(
            "SCHEDULE_EXACT_ALARM must be capped at 32, so 33+ never sees it; got $requested",
            scheduleExactAlarm in requested,
        )
    }

    @Test
    @Config(sdk = [32])
    fun `on API 32 the app still asks for SCHEDULE_EXACT_ALARM, where USE_EXACT_ALARM does not exist`() {
        val requested = requestedPermissions()
        // 31-32 is the range the cap keeps: USE_EXACT_ALARM does not exist
        // below 33, so this is the only thing that makes the exact branch
        // reachable there — and it is the range where the inexact fallback in
        // `setAlarm` is still reachable too, for a user who revoked it.
        assertTrue(
            "SCHEDULE_EXACT_ALARM must still be requested on 31-32; got $requested",
            scheduleExactAlarm in requested,
        )
    }

    @Test
    @Config(sdk = [33])
    fun `on API 33 the app asks for USE_EXACT_ALARM and no longer for SCHEDULE_EXACT_ALARM`() {
        // 33 rather than 34: it is the first level the cap actually excludes,
        // so it is the only level that distinguishes `maxSdkVersion="32"` from
        // `maxSdkVersion="33"` — the sdk=34 case above would pass either way.
        val requested = requestedPermissions()
        assertTrue(
            "the APK must request USE_EXACT_ALARM, or every reminder on 33+ is inexact; got $requested",
            useExactAlarm in requested,
        )
        assertFalse(
            "SCHEDULE_EXACT_ALARM must be capped at 32, so 33 must not see it; got $requested",
            scheduleExactAlarm in requested,
        )
    }
}
