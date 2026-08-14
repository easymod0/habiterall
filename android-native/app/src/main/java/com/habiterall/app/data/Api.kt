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

    /**
     * Whether a day is a skip.
     *
     * Two encodings reach this client and both are real. `skips` is where a
     * skip lives now; a bare value of 3 is where it lived in Loop, and an
     * imported history — or a database seeded before the change — still
     * carries it. The sentinel counts only for a yes/no habit, where 3 cannot
     * mean anything else. For a measurable habit 3 is an amount, and reading
     * it as a skip is the collision that turns a real failure into a bridged
     * streak. This mirrors `normalizeEntry` in shared/src/stats.js, which is
     * what the server scores with.
     */
    fun isSkipped(date: String): Boolean =
        date in skips || (!isNumerical && entries[date] == Sentinels.SKIP)

    /** The amount recorded on a day, or null if there is none to show. */
    fun valueOn(date: String): Double? =
        if (isSkipped(date)) null else entries[date]

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

    /** This habit as a write payload — see [HabitInput] for why that is its own type. */
    fun toInput() = HabitInput(
        name = name,
        description = description,
        type = type,
        unit = unit,
        targetValue = targetValue,
        targetType = targetType,
        freqNumerator = freqNumerator,
        freqDenominator = freqDenominator,
        color = color,
        reminderTime = reminderTime,
        reminderMessage = reminderMessage,
        archived = archived,
    )
}

/** Mirrors `DEFAULT_COLOR` in shared/src/validate.js. */
const val DEFAULT_HABIT_COLOR = "#3b82f6"

/**
 * A habit as the server ACCEPTS one, which is not a habit as the server returns
 * one. Two things make this its own type rather than a reused [Habit].
 *
 * **`PUT /habits/:id` is a replace, not a patch.** It runs the whole body
 * through `parseHabit` (shared/src/validate.js), which supplies a default for
 * every absent field — so a field left out of the payload is not left alone, it
 * is RESET. A partial habit silently clears its description, unit, frequency and
 * reminder.
 *
 * **kotlinx.serialization omits defaults unless told otherwise**, which is what
 * makes the above dangerous rather than theoretical: serialising a [Habit] with
 * `encodeDefaults = false` drops every field that happens to equal its Kotlin
 * default, and the write then resets exactly those fields. That has been correct
 * so far only because the defaults here were chosen to match `parseHabit`'s — a
 * coincidence that holds until one of the two moves, and fails silently when it
 * does.
 *
 * So: an explicit type carrying exactly the fields `parseHabit` reads, written
 * with `encodeDefaults = true`. The read model keeps the response-only figures
 * ([Habit.score], the streaks, [Habit.entries]) that have no business in a write.
 */
@Serializable
data class HabitInput(
    val name: String,
    val description: String = "",
    val type: String = "boolean",
    val unit: String = "",
    @SerialName("target_value") val targetValue: Double = 0.0,
    @SerialName("target_type") val targetType: String = "at_least",
    @SerialName("freq_numerator") val freqNumerator: Int = 1,
    @SerialName("freq_denominator") val freqDenominator: Int = 1,
    val color: String = DEFAULT_HABIT_COLOR,
    @SerialName("reminder_time") val reminderTime: String = "",
    @SerialName("reminder_message") val reminderMessage: String = "",
    val archived: Boolean = false,
)

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
    /**
     * Which end of the day grid today sits at: 'newest-left' or 'newest-right'.
     *
     * The account's setting, not this app's — it is already in the web app's
     * dialog and already stored per user, so setting "today on the left" on a
     * laptop has to move the phone too. Null means untouched, which is not the
     * same as empty: the default below mirrors `SETTINGS.dayOrder.default` in
     * shared/public/ui/settings.js, and the two must not drift.
     */
    @SerialName("dayOrder") val dayOrder: String? = null,
    /**
     * Loop's two tracking preferences, read for the same reason `dayOrder` is:
     * they are the account's, they are already in the web dialog, and a tap has
     * to mean the same thing on both clients. Null means untouched, which reads
     * as off — `SETTINGS.skipDays.default` and `questionMarks.default` in
     * shared/public/ui/settings.js, and Loop's own defaults before that.
     */
    @SerialName("skipDays") val skipDays: Boolean? = null,
    @SerialName("questionMarks") val questionMarks: Boolean? = null,
    /**
     * The rest of the account's display preferences, carried so the phone can
     * SET them as well as be governed by them.
     *
     * Null throughout means "the server has never been told", which is not the
     * same as a value — and it is why nothing here has a Kotlin default matching
     * the server's. The defaults live in one place, `SETTINGS` in
     * shared/public/ui/settings.js, and are applied by the accessors below;
     * duplicating them into the field initialisers would put a second copy in
     * the type where a `null` check cannot tell them apart.
     *
     * The four chart keys do nothing to this app's own UI. They are here because
     * they are the ACCOUNT's, and a settings screen that silently governs less
     * than the web's is how the two clients start disagreeing about what the
     * user set. `PUT /settings` merges a patch, so sending only what changed is
     * safe — unlike a habit write, which replaces.
     */
    @SerialName("weekStart") val weekStart: String? = null,
    @SerialName("confirmDelete") val confirmDelete: Boolean? = null,
    @SerialName("calendarZoom") val calendarZoom: String? = null,
    @SerialName("historyGranularity") val historyGranularity: String? = null,
    @SerialName("historyMode") val historyMode: String? = null,
    @SerialName("scoreGranularity") val scoreGranularity: String? = null,
) {
    val androidRemindersEnabled: Boolean
        get() = notifyChannels?.contains(CHANNEL_ANDROID) ?: true

    /** True when today belongs at the left-hand end of the grid. */
    val newestLeft: Boolean
        get() = (dayOrder ?: DEFAULT_DAY_ORDER) == DEFAULT_DAY_ORDER

    val skipDaysEnabled: Boolean get() = skipDays ?: false

    val questionMarksEnabled: Boolean get() = questionMarks ?: false

    /**
     * Whether deleting a habit asks first.
     *
     * Defaults to ON when the server has never been told, and that direction is
     * deliberate: the phone is the client where a destructive action is a stray
     * thumb, and `DELETE /habits/:id` cascades to every entry the habit ever had.
     * The web's own default is the same.
     */
    val confirmDeleteEnabled: Boolean get() = confirmDelete ?: true

    val weekStartsMonday: Boolean get() = (weekStart ?: DEFAULT_WEEK_START) == DEFAULT_WEEK_START

    companion object {
        const val CHANNEL_ANDROID = "android"

        /** Matches `SETTINGS.dayOrder.default` in shared/public/ui/settings.js. */
        const val DEFAULT_DAY_ORDER = "newest-left"

        /** Matches `SETTINGS.weekStart.default` in the same registry. */
        const val DEFAULT_WEEK_START = "monday"
    }
}

/**
 * What `PUT /settings` answers with.
 *
 * Not the whole settings object — the accepted subset and the keys it threw
 * away. That shape is the reason the phone must not assume its own patch was
 * stored: `SETTING_VALUES` in shared/src/validate.js normalises as well as
 * validates, so an ACCEPTED value can differ from the one sent, and an unknown
 * key is dropped in silence so that an older server tolerates a newer client.
 * `ui/settings.js` waits for this answer rather than assuming; so does this one.
 */
@Serializable
data class SettingsPatchResult(
    val settings: Map<String, kotlinx.serialization.json.JsonElement> = emptyMap(),
    val ignored: List<String> = emptyList(),
)

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

    /**
     * The serializer for anything SENT, and the one difference is the point:
     * `encodeDefaults = true`, so a field equal to its Kotlin default is still
     * written. [HabitInput] explains what that prevents — a habit PUT is a
     * replace, and an omitted field is reset rather than left alone.
     */
    private val writeJson = Json { encodeDefaults = true; explicitNulls = false }

    private val http = OkHttpClient.Builder()
        // A phone on a flaky connection should fail fast and queue, rather
        // than hang a notification action for half a minute.
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private fun url(path: String) = baseUrl.trimEnd('/') + path

    private suspend fun request(req: Request): String = withContext(Dispatchers.IO) {
        http.newCall(req).execute().use { res ->
            // `body` is non-null from OkHttp 5; a safe call here is dead code
            // the compiler warns about rather than a guard against anything.
            val body = res.body.string()
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

    /**
     * Every habit, and the archived ones only when asked.
     *
     * `/overview` deliberately does not carry archived habits — it is the day
     * grid's data, and an archived habit has no business in it — so the archive
     * is a separate read rather than a filter over what the list already holds.
     */
    suspend fun habits(archived: Boolean = false): List<Habit> =
        json.decodeFromString(
            request(
                Request.Builder()
                    .url(url(if (archived) "/api/habits?archived=true" else "/api/habits"))
                    .get().build()
            )
        )

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
        updateHabit(habit.id, habit.toInput().copy(reminderTime = time, reminderMessage = message))
    }

    /* ------------------------------------------------------------ habits */

    /** Create a habit. The server answers 201 with the habit as stored. */
    suspend fun createHabit(input: HabitInput): Habit =
        json.decodeFromString(
            request(
                Request.Builder().url(url("/api/habits"))
                    .post(writeJson.encodeToString(HabitInput.serializer(), input).asBody())
                    .build()
            )
        )

    /**
     * Replace a habit. [HabitInput] carries every field for the reason its own
     * documentation gives: this route defaults whatever the payload omits, so a
     * partial write is a reset rather than a patch.
     */
    suspend fun updateHabit(id: Long, input: HabitInput): Habit =
        json.decodeFromString(
            request(
                Request.Builder().url(url("/api/habits/$id"))
                    .put(writeJson.encodeToString(HabitInput.serializer(), input).asBody())
                    .build()
            )
        )

    /** Delete a habit, and with it every entry it ever had. Answers 204. */
    suspend fun deleteHabit(id: Long) {
        request(Request.Builder().url(url("/api/habits/$id")).delete().build())
    }

    /**
     * Store a new order. The ids are positions 0..n-1 in the order given, and
     * the server answers with the unarchived habits as they now stand — which is
     * what the caller should render, rather than the order it just proposed.
     */
    suspend fun reorderHabits(ids: List<Long>): List<Habit> {
        val body = buildJsonObject {
            put("order", kotlinx.serialization.json.JsonArray(
                ids.map { kotlinx.serialization.json.JsonPrimitive(it) }
            ))
        }
        return json.decodeFromString(
            request(
                Request.Builder().url(url("/api/habits/reorder"))
                    .post(body.toString().asBody()).build()
            )
        )
    }

    /* ---------------------------------------------------------- settings */

    /**
     * Merge a settings patch, and report what the server actually stored.
     *
     * A patch rather than a whole object, because `PUT /settings` merges — the
     * opposite of the habit route above, and worth holding in mind when reading
     * the two together. Sending only what changed is therefore both correct and
     * the only way two clients editing different settings do not clobber each
     * other between fetches.
     */
    suspend fun updateSettings(patch: Map<String, kotlinx.serialization.json.JsonElement>):
        SettingsPatchResult =
        json.decodeFromString(
            request(
                Request.Builder().url(url("/api/settings"))
                    .put(kotlinx.serialization.json.JsonObject(patch).toString().asBody())
                    .build()
            )
        )

    private fun String.asBody() = toRequestBody("application/json".toMediaType())
}
