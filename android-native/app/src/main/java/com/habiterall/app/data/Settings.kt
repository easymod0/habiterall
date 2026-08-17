package com.habiterall.app.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "habiterall")

/**
 * Device-local preferences.
 *
 * The server remains the source of truth for everything about the habits —
 * a new phone needs nothing but the address typed in again. But reminder
 * times are ALSO mirrored here, and that is not a duplication of state so
 * much as a cache with a hard requirement behind it: an alarm must be armable
 * with no network at all.
 *
 * This class previously stored only the server URL, on the reasoning that
 * habit data belongs to the server. The consequence was that every path which
 * armed an alarm ran inside a worker constrained to `NetworkType.CONNECTED`,
 * so a phone rebooted in airplane mode never scheduled a single reminder —
 * the app's one reason to exist, silently dead until connectivity returned.
 */
class Settings(private val context: Context) {

    private val serverUrlKey = stringPreferencesKey("server_url")

    /**
     * Cached reminder schedule, as `id|HH:MM|name|type|target|unit|prompt`
     * lines.
     *
     * A flat string rather than a JSON blob or a database: it is written on
     * every successful sync and read on a cold boot with no network, so the
     * priority is that parsing it can never fail in a way that costs the user
     * their reminders. A malformed line is skipped, not fatal — and a line
     * written by an older version, before the prompt existed, still parses.
     */
    private val reminderCacheKey = stringPreferencesKey("reminder_cache")

    /**
     * Whether this phone is one of the account's reminder destinations.
     *
     * Mirrored here for the same reason the reminder times are: the decision
     * has to be available on a cold boot with no network, and the alternative
     * — assuming "enabled" until the server can be asked — would arm alarms
     * the user switched off, every reboot, for as long as they were offline.
     *
     * Absent means never synced, which reads as enabled: that is the server's
     * default too, and a fresh install that armed nothing would look broken.
     */
    private val androidRemindersKey = booleanPreferencesKey("android_reminders")

    /**
     * Whether the account offers skip days, mirrored for the notification.
     *
     * The shade's actions are built by a receiver that may run days after the
     * last successful fetch — an alarm fires whether or not there is a network —
     * so "does this account use skips?" has to be answerable offline. Absent
     * reads as off, which is both the server's default and Loop's.
     */
    private val skipDaysKey = booleanPreferencesKey("skip_days")

    /**
     * Whether the account shows question marks, mirrored for the home-screen
     * widget.
     *
     * The pair of it and [skipDaysKey] is what `Grid.nextState` reads, and the
     * widget cycles a day with no network at all — so a tap on the home screen
     * and a tap in the app have to walk the same four states or the two clients
     * disagree about what a tap does. Absent reads as off, which is both the
     * server's default and Loop's.
     */
    private val questionMarksKey = booleanPreferencesKey("question_marks")

    /**
     * One line per home-screen widget: which habit it shows, and the day it
     * last knew about. See [Widgets.encode] for the shape and why it is flat.
     */
    private val widgetCacheKey = stringPreferencesKey("widget_cache")

    val serverUrl: Flow<String?> =
        context.dataStore.data.map { it[serverUrlKey]?.ifBlank { null } }

    suspend fun serverUrlOnce(): String? = serverUrl.first()

    suspend fun setServerUrl(url: String) {
        context.dataStore.edit { it[serverUrlKey] = url }
    }

    /** An [Api] bound to the configured server, or null if unconfigured. */
    suspend fun api(): Api? = serverUrlOnce()?.let { Api(it) }

    /**
     * Mirror the habits that carry a reminder. Called after every successful
     * fetch, so the cache tracks the server within one sync.
     */
    suspend fun cacheReminders(habits: List<Habit>) {
        val line = habits
            .filter { !it.archived && it.reminderTime.isNotBlank() }
            .joinToString("\n") {
                // Fields the notification needs, with separators stripped from
                // free text so a habit named "a|b" cannot corrupt the record.
                listOf(
                    it.id.toString(),
                    it.reminderTime,
                    // `Widgets.flatten`, because a bare `\r` splits a line as
                    // surely as a `\n` does and this cache is read with
                    // `lineSequence` too: a habit named "Run\rfast" wrote one
                    // record and read back as two unparseable halves, taking
                    // its alarm with it. One reader's bug, two caches.
                    Widgets.flatten(it.name),
                    it.type,
                    it.targetValue.toString(),
                    Widgets.flatten(it.unit),
                    Widgets.flatten(it.reminderMessage),
                    // Appended, never inserted: the reader below indexes by
                    // position and tolerates a SHORT line, so a cache written
                    // before this field existed still arms its alarms. Putting
                    // it anywhere but the end would silently re-read every
                    // other field one place over.
                    it.showAs,
                    it.targetType,
                ).joinToString("|")
            }
        context.dataStore.edit { it[reminderCacheKey] = line }
    }

    /** Remember whether the account wants reminders on this device. */
    suspend fun cacheAndroidReminders(enabled: Boolean) {
        context.dataStore.edit { it[androidRemindersKey] = enabled }
    }

    /** The cached answer; true until the server has said otherwise. */
    suspend fun cachedAndroidReminders(): Boolean =
        context.dataStore.data.first()[androidRemindersKey] ?: true

    /** Remember whether the account offers skip days. */
    suspend fun cacheSkipDays(enabled: Boolean) {
        context.dataStore.edit { it[skipDaysKey] = enabled }
    }

    /** The cached answer; off until the server has said otherwise. */
    suspend fun cachedSkipDays(): Boolean =
        context.dataStore.data.first()[skipDaysKey] ?: false

    /** Remember whether the account shows question marks. */
    suspend fun cacheQuestionMarks(enabled: Boolean) {
        context.dataStore.edit { it[questionMarksKey] = enabled }
    }

    /** The cached answer; off until the server has said otherwise. */
    suspend fun cachedQuestionMarks(): Boolean =
        context.dataStore.data.first()[questionMarksKey] ?: false

    /* ---------- home-screen widgets ---------- */

    suspend fun cachedWidgets(): List<Widgets.Record> =
        Widgets.decodeAll(context.dataStore.data.first()[widgetCacheKey] ?: "")

    suspend fun cachedWidget(widgetId: Int): Widgets.Record? =
        cachedWidgets().firstOrNull { it.widgetId == widgetId }

    /**
     * Write these records, replacing any with the same widget id.
     *
     * Read and write inside one `edit`, because two widgets can be tapped in
     * the same second and DataStore only serialises the transform — a
     * read-then-write around it would lose one of the two taps.
     */
    suspend fun putWidgets(records: List<Widgets.Record>) {
        if (records.isEmpty()) return
        context.dataStore.edit { prefs ->
            val byId = Widgets.decodeAll(prefs[widgetCacheKey] ?: "")
                .associateBy { it.widgetId }
                .toMutableMap()
            records.forEach { byId[it.widgetId] = it }
            prefs[widgetCacheKey] = Widgets.encodeAll(byId.values.toList())
        }
    }

    /**
     * Replace the whole set, for the one caller that rewrites ids rather than
     * values: a restore, where every record has to move at once and a
     * key-by-key merge would leave both the old and the new id in the blob.
     */
    suspend fun replaceWidgets(records: List<Widgets.Record>) {
        context.dataStore.edit { it[widgetCacheKey] = Widgets.encodeAll(records) }
    }

    /** Forget widgets the launcher has deleted. */
    suspend fun removeWidgets(widgetIds: List<Int>) {
        if (widgetIds.isEmpty()) return
        context.dataStore.edit { prefs ->
            val kept = Widgets.decodeAll(prefs[widgetCacheKey] ?: "")
                .filterNot { it.widgetId in widgetIds }
            prefs[widgetCacheKey] = Widgets.encodeAll(kept)
        }
    }

    /**
     * The cached schedule. Enough to arm an alarm and post a usable
     * notification with no network.
     */
    suspend fun cachedReminders(): List<Habit> {
        val raw = context.dataStore.data.first()[reminderCacheKey] ?: return emptyList()
        return raw.lineSequence().mapNotNull { line ->
            val f = line.split('|')
            if (f.size < 6) return@mapNotNull null
            val id = f[0].toLongOrNull() ?: return@mapNotNull null
            Habit(
                id = id,
                name = f[2],
                type = f[3],
                targetValue = f[4].toDoubleOrNull() ?: 0.0,
                unit = f[5],
                reminderTime = f[1],
                // getOrNull, not f[6]: a cache written before prompts existed
                // has six fields, and losing every reminder on upgrade would be
                // a far worse bug than a missing prompt for one sync.
                reminderMessage = f.getOrNull(6) ?: "",
                // The notification's own buttons depend on these — a habit
                // shown as something to avoid is answered yes/no, not with a
                // number pad — and the shade is built with no network, which is
                // the whole reason this cache exists. Defaults match the
                // server's, so an older cache posts what it always did.
                showAs = f.getOrNull(7) ?: "amount",
                targetType = f.getOrNull(8) ?: "at_least",
            )
        }.toList()
    }
}
