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
import java.util.TimeZone
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
    /** See [HabitInput.atMostUnlogged]; this is the stored value coming back. */
    @SerialName("at_most_unlogged") val atMostUnlogged: String = "default",
    /** See [HabitInput.showAs]. */
    @SerialName("show_as") val showAs: String = "amount",
    /** See [HabitInput.icon]. */
    val icon: String = "",
    /**
     * The user-created category this habit belongs to, or `null` for
     * uncategorised. See [HabitInput.categoryId] for why this client carries
     * the id untouched — creating, renaming, recolouring and deleting a
     * category stay web actions, but the id is picked and shown here.
     */
    @SerialName("category_id") val categoryId: Long? = null,
    val position: Int = 0,
    val archived: Boolean = false,
    // Present on /overview only.
    val score: Double = 0.0,
    @SerialName("currentStreak") val currentStreak: Int = 0,
    @SerialName("bestStreak") val bestStreak: Int = 0,
    @SerialName("totalCompleted") val totalCompleted: Int = 0,
    /**
     * Whether a day with NO ROW already counts as kept, for THIS habit —
     * `unansweredCounts` (shared/src/stats.js) resolved against the account's
     * `atMostUnlogged` and this habit's own override. Response-only: it is not
     * stored anywhere and does not belong on [HabitInput] or in `toInput()`,
     * the way [score] and the streaks above do not either. Defaults to
     * `false` so a habit from `/habits` (which does not carry it) or an older
     * server degrades to the fail-safe direction — today's drawing, with
     * nothing painted for an unanswered day.
     */
    @SerialName("unlogged_is_success") val unloggedIsSuccess: Boolean = false,
    /** date -> value, for the days the overview window covers. */
    val entries: Map<String, Double> = emptyMap(),
    /** dates that are skips, kept apart from `entries` for the reason above. */
    val skips: List<String> = emptyList(),
) {
    val isNumerical get() = type == "numerical"

    /**
     * Is this habit shown as something to avoid?
     *
     * All THREE questions, and the third was missing. `show_as` is a rendering
     * choice that only means anything for a MEASURABLE habit with an at-most
     * target: "at least 8 glasses" has nothing to avoid, and a yes/no habit has
     * no amount for a limit to bound. A habit keeps its `show_as` when its type
     * or goal is switched — so switching back does not lose it — which is why
     * the predicate and not the stored value is what stops it applying in
     * between, and why leaving a question out is a trap rather than an omission.
     *
     * Asking only two put a habit somewhere it could not leave: boolean +
     * at_most + avoid is reachable from the form in one sitting, and then
     * `Grid.valueForState` encoded a tap meaning DONE as 0, which `isMet` reads
     * as not done for a yes/no habit. The cell painted red and no sequence of
     * taps could reach a done day.
     *
     * Mirrors `isAvoided` in shared/public/ui/toggle.js.
     */
    val isAvoided get() =
        showAs == "avoid" && targetType == "at_most" && isNumerical

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
        showAs = showAs,
        icon = icon,
        // Every field, and this is the bridge that has to carry them: a habit
        // PUT REPLACES, so a field dropped here is a field RESET on the server
        // by the two callers that flip one thing about a habit they fetched —
        // unarchiving, and setting a reminder from the list. `HabitApiTest`
        // compares the two encodings rather than restating this list.
        atMostUnlogged = atMostUnlogged,
        // No picker on this client, but a habit PUT still REPLACES — omitting
        // this would clear a category set on the web the next time either of
        // the two callers above touches the habit from a phone.
        categoryId = categoryId,
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
    /**
     * What a day with NO ROW is worth on an at-most target — `"default"` to
     * follow the account's `atMostUnlogged`. Carried here because a habit PUT
     * REPLACES: omit it and the server's `parseHabit` supplies its own default,
     * silently resetting an override set on another client.
     */
    @SerialName("at_most_unlogged") val atMostUnlogged: String = "default",
    /**
     * How the habit is SHOWN — `"amount"`, or `"avoid"` for something you are
     * trying not to do. Presentation only: the verdict still comes from the
     * target, which is what lets a Loop file lose this without losing what the
     * rows mean. Carried here because a habit PUT REPLACES.
     */
    @SerialName("show_as") val showAs: String = "amount",
    /**
     * One grapheme, decided by the server's `parseIcon` — this client holds
     * whatever it was sent and never segments it itself. Carried here because
     * a habit PUT REPLACES: omit it and the server's `parseHabit` resets it
     * to `''` on the next write, however it got here.
     */
    val icon: String = "",
    /**
     * A positive id naming a category, or `null` for uncategorised. Carried
     * here for the usual reason — a habit PUT REPLACES, so leaving this out
     * clears a category set on another client — and it is now also a value
     * this client's own form can set, through the picker's `FilterChip` row.
     * `null` here and an absent key are the same thing to `parseHabit`
     * (`shared/src/validate.js`) — both resolve to "no category" — so this
     * client's `explicitNulls = false` on write costs nothing.
     */
    @SerialName("category_id") val categoryId: Long? = null,
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
     * What a day with NO ROW counts as on a habit with an at-most target — the
     * one kind where zero is *under* the goal, so silence reads as success.
     *
     * The phone neither computes nor mirrors the rule: every figure it draws
     * for a habit is the server's arithmetic, so this is here to be SET, and
     * the streak that comes back on the next fetch is already computed with it.
     * `unansweredCounts` in shared/src/stats.js is the rule itself.
     */
    @SerialName("atMostUnlogged") val atMostUnlogged: String? = null,
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
    /**
     * Whether the list draws one section per category, with an Uncategorised
     * section last. Null means untouched — matches
     * `SETTINGS.groupByCategory.default` in shared/public/ui/settings.js, and
     * the two must not drift. Read from the settings fetch and used to draw;
     * nothing about a category runs from an alarm, so this is not cached to
     * `Settings.kt` alongside the reminder mirrors.
     */
    @SerialName("groupByCategory") val groupByCategory: Boolean? = null,
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

    /*
     * The value a setting HAS, which for an untouched account is the server's
     * default and not null.
     *
     * Every one of these exists so that no screen writes `?: "something"` at a
     * call site. That is not tidiness: `GET /settings` returns only the keys
     * that have been stored, so a default written at the point of use is a
     * silent second copy of the registry, and the first one of those drifted the
     * day it was written — `historyGranularity` defaults to WEEK on the server
     * and was read here as day, which made the settings screen show a value the
     * charts were not using and then refuse to store it (the chip was already
     * "selected", so tapping it did nothing).
     *
     * `AppSettingsDefaultsTest` pins all of them against
     * shared/public/ui/settings.js, which is the only reason this can be trusted
     * to stay in step.
     */

    val dayOrderOrDefault: String get() = dayOrder ?: DEFAULT_DAY_ORDER

    val weekStartOrDefault: String get() = weekStart ?: DEFAULT_WEEK_START

    val calendarZoomOrDefault: String get() = calendarZoom ?: DEFAULT_CALENDAR_ZOOM

    val historyGranularityOrDefault: String
        get() = historyGranularity ?: DEFAULT_HISTORY_GRANULARITY

    val historyModeOrDefault: String get() = historyMode ?: DEFAULT_HISTORY_MODE

    val scoreGranularityOrDefault: String
        get() = scoreGranularity ?: DEFAULT_SCORE_GRANULARITY

    val atMostUnloggedOrDefault: String
        get() = atMostUnlogged ?: DEFAULT_AT_MOST_UNLOGGED

    val groupByCategoryEnabled: Boolean
        get() = groupByCategory ?: DEFAULT_GROUP_BY_CATEGORY

    companion object {
        const val CHANNEL_ANDROID = "android"

        /** Matches `SETTINGS.dayOrder.default` in shared/public/ui/settings.js. */
        const val DEFAULT_DAY_ORDER = "newest-left"

        /** Matches `SETTINGS.weekStart.default` in the same registry. */
        const val DEFAULT_WEEK_START = "monday"

        /** `SETTINGS.calendarZoom.default`. */
        const val DEFAULT_CALENDAR_ZOOM = "default"

        /**
         * `SETTINGS.historyGranularity.default` — WEEK, not day, and the
         * registry says why: a day-level history of a year is ~365 bars, which
         * reads as noise. It is the one default here that is not the first
         * option in its own list, which is exactly how it got copied wrong.
         */
        const val DEFAULT_HISTORY_GRANULARITY = "week"

        /** `SETTINGS.historyMode.default`. */
        const val DEFAULT_HISTORY_MODE = "percent"

        /** `SETTINGS.scoreGranularity.default`. */
        const val DEFAULT_SCORE_GRANULARITY = "day"

        /**
         * `SETTINGS.atMostUnlogged.default` — and `UNLOGGED_DEFAULT` in
         * shared/src/stats.js, which is what the score is actually computed
         * with. A drift here would show one answer on this screen while the
         * streaks on the list were computed with the other.
         */
        const val DEFAULT_AT_MOST_UNLOGGED = "miss"

        /** `SETTINGS.groupByCategory.default` in shared/public/ui/settings.js. */
        const val DEFAULT_GROUP_BY_CATEGORY = false
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

/**
 * A category as `/api/overview` carries it — the picker's options, and the
 * grouped list's sections. The server also sends `created_at` and, in cloud,
 * `user_id`; this client's `Json` is `ignoreUnknownKeys`, so neither is here.
 *
 * Pick-only: creating, renaming, recolouring and deleting a category stay web
 * actions, the same stance this client already takes toward habit icons.
 */
@Serializable
data class Category(
    val id: Long,
    val name: String,
    val color: String = "",
    val position: Int = 0,
)

@Serializable
data class Overview(
    val start: String,
    val end: String,
    val habits: List<Habit>,
    // Defaults to empty rather than being required: `/habits` and an older
    // server do not carry it, and a missing list must degrade to an
    // ungrouped list rather than failing to parse the whole response.
    val categories: List<Category> = emptyList(),
)

@Serializable
data class Entry(
    val date: String,
    val value: Double,
    val status: String = "",
    val notes: String = "",
)

/** Thrown for any non-2xx response, carrying the server's message. */
class ApiException(val status: Int, message: String) : Exception(message) {
    /**
     * Whether this is the session's fault rather than the request's.
     *
     * 403 belongs here with 401, and that is not obvious. `sameOriginOnly` on
     * both editions refuses a write whose `Origin` does not match, and
     * `req.host` is trust-proxy-aware — so a proxy that rewrites `Host` with no
     * hop trusted makes every write from this app look cross-origin. The web
     * outbox treated that as a verdict on the write and destroyed its queue on
     * the first flush; see the root CLAUDE.md. It is a misconfiguration that
     * gets fixed, so the write should still be there when it is.
     */
    val isAuthFailure: Boolean get() = status == 401 || status == 403

    /**
     * Whether retrying this write could only ever fail the same way.
     *
     * The outbox's whole rule, here rather than in the worker so it can be
     * tested without Android. A 4xx is the request's fault and will be refused
     * identically forever — a habit that no longer exists, a date the server
     * will not take — so retrying it only burns battery. The two above are the
     * exception: they are about the SESSION, they stop being true the moment
     * somebody signs in or a proxy is corrected, and the answer that was tapped
     * on a notification is still a true statement about that day.
     */
    val isPermanent: Boolean get() = status in 400..499 && !isAuthFailure
}

/**
 * @param onUnauthorized called when the server refuses the session, so one
 *   screen can send the whole app back to sign-in. Absent for background
 *   callers, which queue and retry instead of asking anybody anything.
 */
/**
 * Mirrors `DEVICE_ZONE_HEADER` in shared/src/notify.js. A header name, not a
 * rule — but the two clients and the server all have to spell it the same.
 */
private const val DEVICE_ZONE_HEADER = "X-Habiterall-Timezone"

class Api(
    private val baseUrl: String,
    private val onUnauthorized: (() -> Unit)? = null,
) {

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
        // Both editions authenticate with one cookie, and [WebSession] is where
        // it lives — shared with the WebView, which is what lets the charts and
        // this client be signed in together, and what makes the cloud edition's
        // redirect sign-in reachable from a native app at all.
        .cookieJar(WebSession.jar())
        // The OIDC flow is redirects, and OkHttp follows them by default. That
        // is left ON deliberately: `POST /auth/logout` answers with where to go
        // next, and a login that lands mid-chain would leave the cookie unset.
        //
        // Which clock this phone is on, for an account whose reminder timezone
        // is `auto`. An interceptor rather than a line at each `Request.Builder`
        // for the same reason the web sets it inside `api()`: one chokepoint, so
        // a request added later cannot forget it.
        //
        // This is NOT a mirrored rule — the phone reports a fact and the server
        // decides what to do with it, so there is nothing here that could drift
        // from `resolveTimeZone`. The phone's own alarms never consult it; they
        // are already on this clock by construction.
        .addInterceptor { chain ->
            val zone = runCatching { TimeZone.getDefault().id }.getOrNull()
            val req = chain.request()
            chain.proceed(
                if (zone.isNullOrBlank()) req
                else req.newBuilder().header(DEVICE_ZONE_HEADER, zone).build()
            )
        }
        .build()

    private fun url(path: String) = baseUrl.trimEnd('/') + path

    /** A response's status and body, with nothing decided about either. */
    private data class Raw(val status: Int, val body: String)

    private suspend fun raw(req: Request): Raw = withContext(Dispatchers.IO) {
        http.newCall(req).execute().use { res ->
            // `body` is non-null from OkHttp 5; a safe call here is dead code
            // the compiler warns about rather than a guard against anything.
            Raw(res.code, res.body.string())
        }
    }

    private suspend fun request(req: Request): String {
        val (status, body) = raw(req)
        if (status in 200..299) return body

        val message = runCatching {
            json.parseToJsonElement(body).toString()
        }.getOrElse { body.ifBlank { "request failed" } }
        val failure = ApiException(status, message)

        // Announced before it is thrown, so a caller that only catches to show a
        // message still sends the app back to sign-in. Every screen catches
        // something; not every screen would remember to ask about the status.
        //
        // **401 only**, though `isAuthFailure` also covers 403, and the two are
        // not interchangeable here. A 401 says "sign in again", which re-asking
        // resolves. A 403 says the session is fine and this is refused anyway —
        // a suspended cloud account, or `sameOriginOnly` behind a proxy that
        // rewrites `Host` — and re-asking cannot help. Firing on it built a
        // loop with no delay in it: `/api/me` answers 403, `Auth.read` calls
        // that Unknown, the app carries on to the list, the list's fetch 403s,
        // that bumps the key, and the session is asked for again. Twice per
        // pass, since two requests fail. The screen's own error state is where a
        // 403 belongs, and it says what the server said.
        if (status == 401) onUnauthorized?.invoke()
        throw failure
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

    /* -------------------------------------------------------------- auth */

    /**
     * Who this client is, and how this instance signs people in.
     *
     * The one route that reads a session WITHOUT requiring one, so it answers a
     * caller who has none — which is the whole point: a signed-out client is
     * exactly the one that needs to know whether to draw a form or a link, and
     * this response is all it gets. [Auth.read] is where that answer is
     * interpreted, and why a 429 or a captive portal's 200 is not read as a
     * statement about authentication.
     *
     * Deliberately does not go through `request`: a 401 here is an answer, not
     * a failure, and routing it through the shared error path would fire
     * [onUnauthorized] while asking the very question that decides it.
     */
    suspend fun me(): Session = try {
        val (status, body) = raw(Request.Builder().url(url("/api/me")).get().build())
        Auth.read(status, body)
    } catch (e: kotlinx.coroutines.CancellationException) {
        // Cancellation is not a failure, and swallowing it here is not merely
        // untidy: this runs in a `LaunchedEffect` keyed on the session, so a
        // second bump cancels the first probe — and a cancelled probe that
        // RETURNS goes on to assign its stale answer over the state the new
        // effect has already reset. The list then composes against a session
        // that is not the current one. The list's own fetch already rethrows for
        // the same reason.
        throw e
    } catch (e: Exception) {
        // Unreachable is not signed-out, and it is not fatal either — status 0
        // is [Session.Unknown]'s "no answer at all", which the app carries on
        // past. Anything else would put a screen in front of someone whose train
        // went into a tunnel.
        Session.Unknown(0, e.message ?: "Could not reach the server")
    }

    /**
     * Sign in with a username and password (the personal edition).
     *
     * @return null when it worked, or the server's own message. The wording is
     *   the server's on purpose: it answers one message for a wrong username
     *   and a wrong password alike, and improving on that here would leak which
     *   half was right.
     */
    suspend fun signIn(username: String, password: String): String? =
        postCredentials("/auth/login", username, password)

    /**
     * Claim an instance that has auth on and no account yet ([AuthMode.SETUP]).
     *
     * The same form and a different endpoint, because it is a different act:
     * this one CREATES the account, and the server guards it with nothing —
     * whoever reaches it first owns the instance.
     */
    suspend fun createAccount(username: String, password: String): String? =
        postCredentials("/auth/setup", username, password)

    private suspend fun postCredentials(path: String, username: String, password: String): String? {
        val payload = buildJsonObject {
            put("username", username)
            put("password", password)
        }
        return try {
            val (status, body) = raw(
                Request.Builder().url(url(path)).post(payload.toString().asBody()).build()
            )
            if (status in 200..299) null else errorIn(body) ?: "Sign-in failed ($status)."
        } catch (e: Exception) {
            e.message ?: "Could not reach the server"
        }
    }

    /**
     * Where the browser flow starts, for an instance whose sign-in this client
     * cannot draw. It is a normal page load: the server redirects to the
     * identity provider and the cookie is set on the way back.
     *
     * Cloud's route, and only cloud's. The personal edition mounts `/auth/login`
     * as a POST and would answer a page load with "Cannot GET" — which matters
     * because [AuthMode.of] sends an unrecognised mode down this path too. That
     * is a dead end rather than a wrong session, and it is reachable only from a
     * server newer than this app; the alternative, loading `/` and letting the
     * web UI offer its own sign-in, costs the cloud path an extra tap on the one
     * mode that is not hypothetical.
     */
    val signInUrl: String get() = url("/auth/login")

    /**
     * End the session, on the server and on the device.
     *
     * The local half runs whether or not the request does. A sign-out that
     * fails because the network did is one the user has every reason to believe
     * happened — and the cookie they wanted gone is still on the phone.
     *
     * @return the identity provider's end-session URL, which the caller has to
     *   load **in a WebView** — see [Auth.endSession] for why there is one and
     *   why an OkHttp call here would end nothing. Null when there is nowhere
     *   to go, which covers the personal edition, a provider with no
     *   end-session endpoint, and every way the request can fail: with no
     *   answer there is no URL, and this client cannot invent one, since the
     *   only address it knows is this server's. A sign-out done with no network
     *   therefore ends the local session only, and the next one online ends the
     *   rest.
     */
    suspend fun signOut(): String? {
        val next = runCatching {
            val res = raw(Request.Builder().url(url("/auth/logout")).post("{}".asBody()).build())
            Auth.endSession(baseUrl, res.status, res.body)
        }.getOrNull()
        WebSession.clear(baseUrl)
        return next
    }

    /** The `error` a failed auth response carries, if it carries one. */
    private fun errorIn(body: String): String? = runCatching {
        (json.parseToJsonElement(body) as kotlinx.serialization.json.JsonObject)["error"]
            ?.let { (it as kotlinx.serialization.json.JsonPrimitive).content }
    }.getOrNull()

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
