package com.habiterall.app.data

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.util.concurrent.TimeUnit

/**
 * Retries a check-off that could not be sent immediately.
 *
 * Tapping "Yes" on a notification has to feel done the instant it is tapped,
 * including on a train with no signal. The tap hands the write to WorkManager,
 * which owns the retry across process death and reboots — the same guarantee
 * the web app's IndexedDB outbox gives.
 */
object Outbox {

    private const val KEY_HABIT = "habit"
    private const val KEY_DATE = "date"
    private const val KEY_VALUE = "value"
    private const val KEY_SKIP = "skip"

    /** The name of the unique work for one habit-day, so callers can watch it. */
    fun workName(habitId: Long, date: String) = "entry:$habitId:$date"

    /**
     * Wait for a queued write to finish, and say whether it landed.
     *
     * Nothing observed the result before, which cost two things. A write the
     * server refuses for good — a 4xx, which `SyncWorker` correctly does not
     * retry — used to vanish in silence, leaving the cell showing a value that
     * was never stored; the reliable way to produce one is a phone whose local
     * date is ahead of the server's, where today's column is a future date the
     * server rejects every evening. And a refetch that arrives before the write
     * does would paint the old value back, so the caller needs to know when it
     * is safe to stop overriding.
     *
     * Returns the terminal state, which the caller must tell apart three ways.
     * SUCCEEDED landed. FAILED did not and never will. CANCELLED means a later
     * tap on the same day REPLACEd this work — not a failure, and reporting it
     * as one would put "could not be saved" on screen every time somebody
     * tapped a cell twice in quick succession.
     *
     * There is a fourth outcome and it is deliberately not one of the three:
     * work that is RETRYING never reaches a terminal state, so this never
     * returns and the caller's optimistic overlay stays up. That is the right
     * answer for the case it has always covered — a write made offline, which
     * lands when the signal does — and now also covers a session that has
     * expired, which lands when the user signs in. The value on screen is one
     * that WILL be stored; what is missing is any word to the user while it
     * waits, and the same silence has always applied to the offline case.
     */
    suspend fun awaitWrite(context: Context, habitId: Long, date: String): WorkInfo.State {
        val manager = WorkManager.getInstance(context)
        return manager.getWorkInfosForUniqueWorkFlow(workName(habitId, date))
            .map { infos -> infos.lastOrNull() }
            .filter { it != null && it.state.isFinished }
            .map { it!!.state }
            .first()
    }

    /**
     * Queue a write. Uniqueness is per habit+day and [ExistingWorkPolicy.REPLACE]:
     * if you tap Yes then No before either reaches the server, the last tap is
     * the one that lands, rather than the two racing.
     */
    fun enqueue(context: Context, habitId: Long, date: String, value: Double?, skip: Boolean) {
        val data = Data.Builder()
            .putLong(KEY_HABIT, habitId)
            .putString(KEY_DATE, date)
            .putBoolean(KEY_SKIP, skip)
        if (value != null) data.putDouble(KEY_VALUE, value)

        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setInputData(data.build())
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context)
            .enqueueUniqueWork(workName(habitId, date), ExistingWorkPolicy.REPLACE, request)
    }

    class SyncWorker(
        appContext: Context,
        params: WorkerParameters,
    ) : CoroutineWorker(appContext, params) {

        override suspend fun doWork(): Result {
            val api = Settings(applicationContext).api() ?: return Result.failure()
            val habitId = inputData.getLong(KEY_HABIT, -1)
            val date = inputData.getString(KEY_DATE) ?: return Result.failure()
            if (habitId < 0) return Result.failure()

            val skip = inputData.getBoolean(KEY_SKIP, false)
            // `hasKeyWithValueOfType` is a plain Java generic, not reified, so
            // it needs the Class object — the angle-bracket form does not
            // compile. `keyValueMap` avoids the question entirely.
            val value = if (inputData.keyValueMap.containsKey(KEY_VALUE)) {
                inputData.getDouble(KEY_VALUE, 0.0)
            } else {
                null
            }

            return try {
                if (!skip && value == null) {
                    api.clearEntry(habitId, date)
                } else {
                    api.setEntry(habitId, date, value = value, skip = skip)
                }
                Result.success()
            } catch (e: ApiException) {
                // `isPermanent` is the whole rule, and it lives on the exception
                // so it can be tested without Android — see it for why 401 and
                // 403 are not in it. This worker did not have to tell a refused
                // SESSION from a refused WRITE until the app could be signed out
                // at all: a 401 dropped here loses an answer the user actually
                // gave, silently, which is the one failure an outbox exists to
                // prevent. Both come back when they sign in again, and
                // WorkManager's exponential backoff is what keeps the wait cheap.
                if (e.isPermanent) Result.failure() else Result.retry()
            } catch (e: Exception) {
                Result.retry()
            }
        }
    }
}
