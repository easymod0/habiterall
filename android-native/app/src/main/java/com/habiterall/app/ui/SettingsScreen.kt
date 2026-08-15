package com.habiterall.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.habiterall.app.data.AppSettings
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray

/**
 * What a patch did, once the server has been asked again.
 *
 * Two things rather than one, because a settings write has three outcomes and
 * not two. It can fail — an exception. It can be stored. Or it can be ACCEPTED
 * with a 200 and quietly dropped, which is what `ignored` reports and what an
 * older server does with a key it has never heard of. Returning only the fresh
 * settings collapses the third case into the second: the control springs back to
 * where it was and nothing anywhere says why.
 */
data class PatchOutcome(
    /** The settings as the server reports them AFTER the write — not the patch. */
    val settings: AppSettings,
    /** The keys it threw away, verbatim from the reply's `ignored`. */
    val ignored: List<String>,
)

/**
 * The account's preferences, edited from the phone.
 *
 * These are the SAME settings the web dialog edits — one row per user in the
 * `settings` table (personal) or the JSONB column (cloud) — so this screen is
 * not a second set of preferences that happens to look similar. Changing
 * "today on the left" here moves the laptop, and vice versa. That is the whole
 * requirement, and it is met by never keeping an opinion locally: every change
 * is a `PUT /settings` followed by a re-read, and what the re-read says is what
 * the screen shows.
 *
 * **Nothing here validates.** `SETTING_VALUES` in shared/src/validate.js is what
 * is enforced, it normalises as well as checks, and it drops keys it does not
 * know so that an older server tolerates a newer client. The option lists below
 * are therefore this app's MENU, not a copy of the rules: a value the server
 * refuses comes back in `ignored` and the screen says so, rather than being
 * prevented here by a rule that could drift out of step.
 *
 * Deliberately absent: the Discord keys. `discordWebhook` is a bearer capability
 * — whoever holds the URL can post to that channel — and a phone form is a poor
 * place to type one. They stay in the web dialog, where they already are.
 * `notifyTimezone` is absent for a duller reason: it is a zone NAME, and a
 * picker over the whole tz database is a screen of its own.
 *
 * **The option lists are this app's menu; the DEFAULTS are a mirror.** Nothing
 * here supplies one — `AppSettings` does, pinned to the web registry by
 * `AppSettingsDefaultsTest`. A `?: "day"` written at a call site below is how a
 * screen ends up naming a value the account is not set to, and then refusing to
 * store the one it claims is already selected.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    initial: AppSettings,
    androidRemindersSupported: Boolean,
    onPatch: suspend (Map<String, JsonElement>) -> PatchOutcome,
    /** Closes, saying whether any setting was actually stored. */
    onClose: (changed: Boolean) -> Unit,
) {
    var settings by remember { mutableStateOf(initial) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    /**
     * Whether anything reached the database.
     *
     * Two of these settings change what the LIST draws — `dayOrder` flips
     * which end today sits at, `skipDays` changes what a tap can record — so
     * the grid behind this screen has to be refetched when one of them moves,
     * and must not be when the user only looked.
     */
    var changed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    BackHandler(enabled = !busy) { onClose(changed) }

    /**
     * Send one key, and take whatever the server then says the settings are.
     *
     * [label] is only ever used to explain a refusal, and that is the case worth
     * spelling out. `PUT /settings` does not fail on a key it will not store: it
     * returns 200 with the key listed in `ignored`, which is what lets an older
     * server tolerate a newer client. So the failure has no exception, no error
     * status and — since the re-read simply reports the old value — no visible
     * effect beyond a control that springs back. Saying so is the difference
     * between "this server does not support that" and "this app is broken".
     */
    fun put(key: String, label: String, value: JsonElement) {
        busy = true
        error = null
        scope.launch {
            try {
                val outcome = onPatch(mapOf(key to value))
                settings = outcome.settings
                if (key in outcome.ignored) {
                    error = "This server did not store $label. It may be older than " +
                        "this app, or may no longer allow that value."
                } else {
                    changed = true
                }
            } catch (e: Exception) {
                error = e.message ?: "Could not save"
            } finally {
                busy = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = { onClose(changed) }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (busy) CircularProgressIndicator(Modifier.size(22.dp).padding(end = 12.dp))
                },
            )
        }
    ) { pad ->
        Column(
            Modifier.padding(pad).fillMaxSize().imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            error?.let {
                Card(Modifier.fillMaxWidth()) {
                    Text(
                        it,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }

            Text(
                "These belong to your account, not to this phone — changing one here " +
                    "changes it in the web app too.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            /* --------------------------------------------------- reminders */

            Heading("Reminders")
            SwitchRow(
                title = "Remind me on this phone",
                subtitle = if (androidRemindersSupported) {
                    "A local alarm, so it fires with no network. Off here also stops the " +
                        "other devices on this account from arming one."
                } else {
                    "Notifications are switched off for this app in Android settings."
                },
                checked = settings.androidRemindersEnabled,
                enabled = !busy,
                onChange = { on ->
                    // A list, not a flag: the destinations are not exclusive, so
                    // this adds or removes exactly this app's entry and leaves
                    // any Discord destination alone. `parseChannelList` on the
                    // server dedupes and orders whatever arrives.
                    val current = settings.notifyChannels
                        ?: listOf(AppSettings.CHANNEL_ANDROID)
                    val next = if (on) (current + AppSettings.CHANNEL_ANDROID).distinct()
                    else current - AppSettings.CHANNEL_ANDROID
                    put("notifyChannels", "the reminder destinations",
                        JsonArray(next.map { JsonPrimitive(it) }))
                },
            )

            HorizontalDivider()

            /* ---------------------------------------------------- what a tap does */

            Heading("What a tap can record")
            SwitchRow(
                title = "Skip days",
                subtitle = "Adds \"not applicable today\" to the tap cycle. A skip does not " +
                    "break a streak and does not count as a miss.",
                checked = settings.skipDaysEnabled,
                enabled = !busy,
                onChange = { put("skipDays", "skip days", JsonPrimitive(it)) },
            )
            SwitchRow(
                title = "Question marks",
                subtitle = "Draws a day nobody has answered differently from one answered " +
                    "\"no\". With this off the two look the same, and the tap cycle has no " +
                    "step back to unanswered — the day editor's Clear is how you get there.",
                checked = settings.questionMarksEnabled,
                enabled = !busy,
                onChange = { put("questionMarks", "question marks", JsonPrimitive(it)) },
            )

            HorizontalDivider()

            /* ------------------------------------------------ habits that are limits */

            Heading("Habits with a limit")
            ChoiceRow(
                title = "A day you never logged",
                options = listOf(
                    "miss" to "Counts as a miss",
                    "success" to "Counts as staying under",
                ),
                selected = settings.atMostUnloggedOrDefault,
                enabled = !busy,
                onPick = { put("atMostUnlogged", "what an unlogged day counts as",
                    JsonPrimitive(it)) },
            )
            Text(
                "\"At most\" habits — at most 2 coffees, no smoking — are the one kind " +
                    "where saying nothing could mean either thing, because zero is under " +
                    "the limit. A day you did record as 0 counts as staying under either " +
                    "way. Every other habit already treats an unlogged day as a miss.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            HorizontalDivider()

            /* ------------------------------------------------------- display */

            Heading("Display")
            ChoiceRow(
                title = "Day order",
                options = listOf(
                    "newest-left" to "Today on the left",
                    "newest-right" to "Today on the right",
                ),
                selected = settings.dayOrderOrDefault,
                enabled = !busy,
                onPick = { put("dayOrder", "the day order", JsonPrimitive(it)) },
            )
            ChoiceRow(
                title = "Week starts on",
                options = listOf("monday" to "Monday", "sunday" to "Sunday"),
                selected = settings.weekStartOrDefault,
                enabled = !busy,
                onPick = { put("weekStart", "the first day of the week", JsonPrimitive(it)) },
            )
            SwitchRow(
                title = "Confirm before deleting",
                subtitle = "Deleting a habit takes every day recorded for it.",
                checked = settings.confirmDeleteEnabled,
                enabled = !busy,
                onChange = { put("confirmDelete", "the delete confirmation", JsonPrimitive(it)) },
            )

            HorizontalDivider()

            /* -------------------------------------------------------- charts */

            Heading("Charts")
            Text(
                "These change the statistics screens, which this app shows through the " +
                    "web app — so they take effect there and on your laptop.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            ChoiceRow(
                title = "History resolution",
                options = listOf(
                    "day" to "Day", "week" to "Week", "month" to "Month",
                    "quarter" to "Quarter", "year" to "Year",
                ),
                selected = settings.historyGranularityOrDefault,
                enabled = !busy,
                onPick = { put("historyGranularity", "the history resolution", JsonPrimitive(it)) },
            )
            ChoiceRow(
                title = "History shows",
                options = listOf("percent" to "Percent", "count" to "Count"),
                selected = settings.historyModeOrDefault,
                enabled = !busy,
                onPick = { put("historyMode", "what the history shows", JsonPrimitive(it)) },
            )
            ChoiceRow(
                title = "Strength resolution",
                options = listOf(
                    "day" to "Day", "week" to "Week", "month" to "Month",
                    "quarter" to "Quarter", "year" to "Year",
                ),
                selected = settings.scoreGranularityOrDefault,
                enabled = !busy,
                onPick = { put("scoreGranularity", "the strength resolution", JsonPrimitive(it)) },
            )
            ChoiceRow(
                title = "Calendar zoom",
                options = listOf(
                    "closest" to "Closest", "close" to "Close",
                    "default" to "Default", "wide" to "Wide",
                ),
                selected = settings.calendarZoomOrDefault,
                enabled = !busy,
                onPick = { put("calendarZoom", "the calendar zoom", JsonPrimitive(it)) },
            )

            Text(
                "Discord reminders and the reminder time zone are set in the web app.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun SwitchRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    enabled: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(title)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}

@Composable
private fun ChoiceRow(
    title: String,
    options: List<Pair<String, String>>,
    selected: String,
    enabled: Boolean,
    onPick: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title)
        // Wrapped rather than a single Row: five granularity chips do not fit
        // across a 360dp phone, and a chip cut off at the edge is a control the
        // user cannot reach.
        options.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { (value, label) ->
                    FilterChip(
                        selected = value == selected,
                        onClick = { if (value != selected) onPick(value) },
                        enabled = enabled,
                        label = { Text(label) },
                    )
                }
            }
        }
    }
}
