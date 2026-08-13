package com.habiterall.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * The habiterall REST API.
 *
 * Field names and the value encoding mirror the server exactly — see
 * shared/src/types.js and shared/src/constants.js. Getting these wrong is the
 * one way a native client can silently corrupt data, so the sentinels below
 * are defined once and never inlined.
 */
object Sentinels {
    /** No entry recorded. */
    const val UNSET = 0.0
    /** A completed yes/no habit. */
    const val YES = 2.0
    /**
     * A skipped day — the wire value only. It is never stored in `value`:
     * a measurable habit may legitimately record 3, so skips travel in
     * `status` instead.
     */
    const val SKIP = 3.0
}

@Serializable
data class Habit(
    val id: Long,
    val name: String,
    val description: String = "",
    /** "boolean" or "numerical". */
    val type: String = "boolean",
    val unit: String = "",
    @SerialName("target_value") val targetValue: Double = 0.0,
    /** "at_least" or "at_most". */
    @SerialName("target_type") val targetType: String = "at_least",
    @SerialName("freq_numerator") val freqNumerator: Int = 1,
    @SerialName("freq_denominator") val freqDenominator: Int = 1,
    val color: String = "#3b82f6",
    /** Local "HH:MM", or "" for no reminder. */
    @SerialName("reminder_time") val reminderTime: String = "",
    /**
     * What the reminder asks — "Did you exercise today?". "" means the
     * notification falls back to the habit's name and goal, which is what it
     * always used to show.
     */
    @SerialName("reminder_message") val reminderMessage: String = "",
    val position: Int = 0,
    val archived: Boolean = false,
    // Present on /overview only.
    val score: Double = 0.0,
    @SerialName("currentStreak") val currentStreak: Int = 0,
    @SerialName("bestStreak") val bestStreak: Int = 0,
    @SerialName("totalCompleted") val totalCompleted: Int = 0,
    /** date -> value, for the days the overview window covers. */
    val entries: Map<String, Double> = emptyMap(),
    /** dates that are skips, kept apart from `entries` for the reason above. */
    val skips: List<String> = emptyList(),
) {
    val isNumerical get() = type == "numerical"

    /** Whether this habit was satisfied on a day, given its raw value. */
    fun isMet(value: Double?, skipped: Boolean): Boolean? {
        if (skipped) return null                       // not applicable
        if (value == null) return false
        return if (isNumerical) {
            if (targetType == "at_most") value <= targetValue else value >= targetValue
        } else {
            value == Sentinels.YES
        }
    }
}

/**
 * The account's preferences, of which this client cares about exactly one.
 *
 * `notifyChannels` says where reminders are meant to go. It is a LIST because
 * the destinations are not exclusive — a phone alarm and a Discord message are
 * useful at once — and this app is responsible for its own entry in it: the
 * server delivers the webhook channels and never sends push, so switching the
 * Android destination off has to be honoured here or it does nothing at all.
 *
 * A null list means the setting has never been touched, which is not the same
 * as an empty one. The default is on-device only, matching `DEFAULT_CHANNELS`
 * in shared/src/notify.js — change one and change the other.
 */
@Serializable
data class AppSettings(
    @SerialName("notifyChannels") val notifyChannels: List<String>? = null,
) {
    val androidRemindersEnabled: Boolean
        get() = notifyChannels?.contains(CHANNEL_ANDROID) ?: true

    companion object {
        const val CHANNEL_ANDROID = "android"
    }
}

@Serializable
data class Overview(
    val start: String,
    val end: String,
    val habits: List<Habit>,
)

@Serializable
data class Entry(
    val date: String,
    val value: Double,
    val status: String = "",
    val notes: String = "",
)

/** Thrown for any non-2xx response, carrying the server's message. */
class ApiException(val status: Int, message: String) : Exception(message)

class Api(private val baseUrl: String) {

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    private val http = OkHttpClient.Builder()
        // A phone on a flaky connection should fail fast and queue, rather
        // than hang a notification action for half a minute.
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private fun url(path: String) = baseUrl.trimEnd('/') + path

    private suspend fun request(req: Request): String = withContext(Dispatchers.IO) {
        http.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                val message = runCatching {
                    json.parseToJsonElement(body).toString()
                }.getOrElse { body.ifBlank { "request failed" } }
                throw ApiException(res.code, message)
            }
            body
        }
    }

    /** Cheap liveness probe, used when validating a server URL. */
    suspend fun health(): Boolean = probe() == null

    /**
     * Probe the server; returns null on success, or a message explaining what
     * went wrong.
     *
     * `health()` used to swallow every exception into a bare false, so the
     * setup screen could only ever say "Could not reach <url>" — identical
     * whether the name did not resolve, the port was closed, a firewall
     * dropped the packets, or the server answered with a 500. That is the one
     * screen where the user has nothing else to go on.
     */
    suspend fun probe(): String? = try {
        request(Request.Builder().url(url("/healthz")).get().build())
        null
    } catch (e: java.net.UnknownHostException) {
        "Cannot find \"${e.message}\". Check the name, or use the server's IP address."
    } catch (e: java.net.ConnectException) {
        "Nothing is listening there. Is the server running, and is the port right?"
    } catch (e: java.net.SocketTimeoutException) {
        "The server did not answer in time. If it is on another network, it may be firewalled."
    } catch (e: javax.net.ssl.SSLException) {
        "The secure connection failed: ${e.message}"
    } catch (e: ApiException) {
        // It answered, just not with a 200 — a proxy or the wrong host.
        "The server answered with an error (${e.status}). Is this a habiterall server?"
    } catch (e: Exception) {
        e.message ?: e.javaClass.simpleName
    }

    /**
     * The dashboard payload: habits plus their entries for a window.
     * @param end last day to include, "YYYY-MM-DD"; null means today
     */
    suspend fun overview(days: Int = 14, end: String? = null): Overview {
        val query = buildString {
            append("/api/overview?days=").append(days)
            if (end != null) append("&end=").append(end)
        }
        return json.decodeFromString(request(Request.Builder().url(url(query)).get().build()))
    }

    suspend fun habits(): List<Habit> =
        json.decodeFromString(request(Request.Builder().url(url("/api/habits")).get().build()))

    /**
     * The account's preferences. Every key but the ones declared above is
     * ignored, so a server that gains a setting does not break this client.
     */
    suspend fun settings(): AppSettings =
        json.decodeFromString(request(Request.Builder().url(url("/api/settings")).get().build()))

    suspend fun entries(habitId: Long): List<Entry> =
        json.decodeFromString(
            request(Request.Builder().url(url("/api/habits/$habitId/entries")).get().build())
        )

    /**
     * Record a value for a day.
     *
     * Pass [skip] rather than the SKIP sentinel for measurable habits: 3 is a
     * real amount there, and conflating the two once corrupted real data.
     */
    suspend fun setEntry(
        habitId: Long,
        date: String,
        value: Double? = null,
        skip: Boolean = false,
        notes: String? = null,
    ) {
        val payload = buildJsonObject {
            if (skip) put("status", "skip") else if (value != null) put("value", value)
            if (notes != null) put("notes", notes)
        }
        val body = payload.toString().toRequestBody("application/json".toMediaType())

        request(
            Request.Builder().url(url("/api/habits/$habitId/entries/$date")).put(body).build()
        )
    }

    /** Clear a day entirely. */
    suspend fun clearEntry(habitId: Long, date: String) {
        request(
            Request.Builder().url(url("/api/habits/$habitId/entries/$date")).delete().build()
        )
    }

    /**
     * Update a habit's reminder time and prompt; a blank time removes the
     * reminder. Both travel together because the dialog edits them together —
     * and because this is a whole-habit PUT, so sending one without the other
     * would reset it.
     */
    suspend fun setReminder(habit: Habit, time: String, message: String = habit.reminderMessage) {
        // The explicit serializer rather than the reified `encodeToString(value)`:
        // the reified overload is an extension that needs its own import, and
        // without it the compiler binds to the two-argument
        // `encodeToString(strategy, value)` and reports a baffling type error.
        val updated = json.encodeToString(
            Habit.serializer(),
            habit.copy(reminderTime = time, reminderMessage = message),
        )
        request(
            Request.Builder().url(url("/api/habits/${habit.id}"))
                .put(updated.toRequestBody("application/json".toMediaType()))
                .build()
        )
    }
}
