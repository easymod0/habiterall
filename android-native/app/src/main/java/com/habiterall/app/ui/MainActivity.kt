package com.habiterall.app.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.habiterall.app.data.*
import com.habiterall.app.notify.Reminders
import com.habiterall.app.notify.ReminderTime
import kotlinx.coroutines.launch
import java.time.LocalDate

class MainActivity : ComponentActivity() {

    private lateinit var settings: Settings

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best effort */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = Settings(this)

        // The whole point of the app is notifications, so ask up front rather
        // than at the first reminder — by then the user is not looking.
        if (Build.VERSION.SDK_INT >= 33) {
            requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        setContent {
            HabiterallTheme {
                var url by remember { mutableStateOf<String?>(null) }
                var checked by remember { mutableStateOf(false) }

                LaunchedEffect(Unit) {
                    url = settings.serverUrlOnce()
                    checked = true
                }

                when {
                    !checked -> Loading()
                    url == null -> SetupScreen(onSaved = {
                        url = it
                        Reminders.rescheduleAll(this@MainActivity)
                    })
                    else -> HabitListScreen(
                        serverUrl = url!!,
                        onOpenStats = { openWeb(url!!) },
                        onChangeServer = { url = null },
                    )
                }
            }
        }
    }

    /**
     * Stats, charts and history editing are the server's own web UI, opened in
     * a Custom Tab. One implementation of the charts rather than two, and it
     * inherits whatever the web app gains without an app update.
     */
    private fun openWeb(serverUrl: String) {
        runCatching {
            CustomTabsIntent.Builder()
                .setShowTitle(true)
                .build()
                .launchUrl(this, Uri.parse(serverUrl))
        }.onFailure {
            // No browser that supports Custom Tabs; fall back to any browser.
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(serverUrl))) }
        }
    }

    @Composable
    private fun Loading() {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun SetupScreen(onSaved: (String) -> Unit) {
        var input by remember { mutableStateOf("") }
        var error by remember { mutableStateOf<String?>(null) }
        var busy by remember { mutableStateOf(false) }

        Scaffold(topBar = { TopAppBar(title = { Text("Connect to habiterall") }) }) { pad ->
            Column(
                Modifier.padding(pad).padding(24.dp).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    "Enter the address of your habiterall server. A LAN address " +
                        "works over plain http; anything public needs https.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it; error = null },
                    label = { Text("Server address") },
                    placeholder = { Text("192.168.1.50:3000") },
                    singleLine = true,
                    isError = error != null,
                    supportingText = { error?.let { Text(it) } },
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    enabled = !busy && input.isNotBlank(),
                    onClick = {
                        when (val parsed = ServerUrl.parse(input)) {
                            is ServerUrl.Result.Invalid -> error = parsed.reason
                            is ServerUrl.Result.Ok -> {
                                busy = true
                                lifecycleScope.launch {
                                    // Verify before saving, so a typo surfaces
                                    // here rather than as an empty habit list.
                                    // `probe` reports WHY: "could not reach"
                                    // alone left the user with nothing to act
                                    // on, since it covered DNS failure, a
                                    // closed port, a firewall and a bad
                                    // response identically.
                                    val why = Api(parsed.url).probe()
                                    if (why == null) {
                                        settings.setServerUrl(parsed.url)
                                        onSaved(parsed.url)
                                    } else {
                                        error = why
                                    }
                                    busy = false
                                }
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (busy) "Checking…" else "Connect")
                }
            }
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun HabitListScreen(
        serverUrl: String,
        onOpenStats: () -> Unit,
        onChangeServer: () -> Unit,
    ) {
        var habits by remember { mutableStateOf<List<Habit>>(emptyList()) }
        var error by remember { mutableStateOf<String?>(null) }
        var loading by remember { mutableStateOf(true) }
        var reload by remember { mutableStateOf(0) }
        var countFor by remember { mutableStateOf<Habit?>(null) }
        var reminderFor by remember { mutableStateOf<Habit?>(null) }

        /**
         * Explicit scroll state, so it can be corrected after a reload.
         *
         * Without this the list kept whatever offset it had, and the offset
         * survived the empty moment between "app resumed" and "habits
         * fetched". Restoring it against a list that had briefly been empty
         * left the view scrolled past the top with the first habit clipped
         * off — reachable just by closing and reopening the app.
         */
        val listState = rememberLazyListState()

        val today = remember { LocalDate.now().toString() }
        val api = remember(serverUrl) { Api(serverUrl) }

        LaunchedEffect(reload, serverUrl) {
            loading = true
            runCatching { api.overview(days = 1) }
                .onSuccess { habits = it.habits.filter { h -> !h.archived }; error = null }
                .onFailure { error = it.message ?: "Could not reach the server" }
            loading = false
        }

        // Bring an out-of-range scroll position back into the list.
        //
        // A retained offset can outlive the list it belonged to — the app is
        // resumed, the list is empty for a moment, and the restored offset
        // then points past the end. Clamping only when the index no longer
        // exists leaves a deliberate mid-list scroll alone.
        LaunchedEffect(habits.size) {
            if (habits.isEmpty()) return@LaunchedEffect

            val index = listState.firstVisibleItemIndex
            // Two bad states, both reachable by closing and reopening the app:
            //   - the index points past the end of a list that shrank
            //   - the index is 0 but a leftover pixel offset clips the first
            //     habit, which is what "the top one was cut off" looks like
            if (index >= habits.size ||
                (index == 0 && listState.firstVisibleItemScrollOffset > 0)
            ) {
                listState.scrollToItem(0)
            }
        }

        fun record(habit: Habit, value: Double?, skip: Boolean) {
            Outbox.enqueue(this@MainActivity, habit.id, today, value, skip)
            // Optimistic: the outbox owns delivery, so the row is already
            // committed as far as the user is concerned.
            habits = habits.map {
                if (it.id != habit.id) it
                else it.copy(
                    entries = it.entries + (today to (value ?: 0.0)),
                    skips = if (skip) it.skips + today else it.skips - today,
                )
            }
        }

        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text("Today") },
                    actions = {
                        TextButton(onClick = onOpenStats) { Text("Stats") }
                        TextButton(onClick = { reload++ }) { Text("Refresh") }
                    },
                )
            }
        ) { pad ->
            Column(Modifier.padding(pad).fillMaxSize()) {
                when {
                    loading && habits.isEmpty() -> Loading()
                    error != null && habits.isEmpty() -> Column(
                        Modifier.padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(error!!, color = MaterialTheme.colorScheme.error)
                        Button(onClick = { reload++ }) { Text("Try again") }
                        TextButton(onClick = onChangeServer) { Text("Change server") }
                    }
                    habits.isEmpty() -> Column(Modifier.padding(24.dp)) {
                        Text("No habits yet. Add one in the web app.")
                        TextButton(onClick = onOpenStats) { Text("Open habiterall") }
                    }
                    else -> LazyColumn(Modifier.weight(1f), state = listState) {
                        items(habits, key = { it.id }) { habit ->
                            HabitRow(
                                habit = habit,
                                value = habit.entries[today],
                                skipped = today in habit.skips,
                                onYes = { record(habit, Sentinels.YES, false) },
                                onNo = { record(habit, Sentinels.UNSET, false) },
                                onCount = { countFor = habit },
                                onSetReminder = { reminderFor = habit },
                            )
                            HorizontalDivider()
                        }
                    }
                }
            }
        }

        reminderFor?.let { habit ->
            ReminderDialog(
                habit = habit,
                onDismiss = { reminderFor = null },
                onSave = { time, message ->
                    reminderFor = null
                    lifecycleScope.launch {
                        runCatching { api.setReminder(habit, time, message) }
                            .onSuccess {
                                // Re-arm immediately: the schedule lives on the
                                // server, but the alarm is local.
                                Reminders.rescheduleAll(this@MainActivity)
                                reload++
                            }
                            .onFailure { error = it.message ?: "Could not save the reminder" }
                    }
                },
            )
        }

        countFor?.let { habit ->
            CountDialog(
                habit = habit,
                initial = habit.entries[today],
                onDismiss = { countFor = null },
                onConfirm = { value -> record(habit, value, false); countFor = null },
            )
        }
    }

    @Composable
    private fun HabitRow(
        habit: Habit,
        value: Double?,
        skipped: Boolean,
        onYes: () -> Unit,
        onNo: () -> Unit,
        onSetReminder: () -> Unit,
        onCount: () -> Unit,
    ) {
        val met = habit.isMet(value, skipped)

        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(habit.name, fontWeight = FontWeight.Medium)
                val subtitle = when {
                    skipped -> "Skipped"
                    habit.isNumerical -> {
                        val v = value?.let { trim(it) } ?: "—"
                        val target = trim(habit.targetValue)
                        val unit = if (habit.unit.isBlank()) "" else " ${habit.unit}"
                        "$v / $target$unit"
                    }
                    met == true -> "Done"
                    else -> "Not done"
                }
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (met == true) Color(0xFF16a34a)
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )

                // The reminder is the app's entire reason to exist, so setting
                // one has to be reachable from the habit itself — it was
                // previously only editable through the web UI, which meant the
                // notification feature had no way to be switched on from here.
                TextButton(
                    onClick = onSetReminder,
                    contentPadding = PaddingValues(horizontal = 0.dp, vertical = 2.dp),
                ) {
                    Text(
                        if (habit.reminderTime.isBlank()) "Add reminder"
                        else "Reminder ${habit.reminderTime}",
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
            }

            // Measurable habits get one button that asks for a number; yes/no
            // habits get the two-state pair. Showing both sets for both kinds
            // is the exact confusion the web UI had to fix.
            if (habit.isNumerical) {
                Button(onClick = onCount) { Text(value?.let { trim(it) } ?: "Enter") }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTonalButton(onClick = onNo) { Text("No") }
                    Button(onClick = onYes) { Text("Yes") }
                }
            }
        }
    }

    @Composable
    private fun CountDialog(
        habit: Habit,
        initial: Double?,
        onDismiss: () -> Unit,
        onConfirm: (Double) -> Unit,
    ) {
        var text by remember {
            mutableStateOf(initial?.let { trim(it) } ?: trim(habit.targetValue))
        }
        val parsed = text.trim().toDoubleOrNull()

        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(habit.name) },
            text = {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    singleLine = true,
                    label = { Text(habit.unit.ifBlank { "Amount" }) },
                )
            },
            confirmButton = {
                TextButton(
                    enabled = parsed != null && parsed >= 0,
                    onClick = { parsed?.let(onConfirm) },
                ) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        )
    }

    /**
     * A dropdown for the hour, one for the minute, and a box to type into.
     *
     * All three edit one value, which is submitted verbatim as `reminder_time`.
     * The dropdowns exist because picking 08:30 should not require typing a
     * colon, and the text box stays because typing "830" or "8:30 pm" is
     * faster than two menus — [ReminderTime.parse] is what makes those equal.
     *
     * This was a bare text field validated against `^HH:MM$`, which rejected
     * every form anyone naturally types.
     *
     * "Remove" is a first-class button rather than a hidden gesture: clearing
     * the field is how a reminder is deleted, and that should not be a guess.
     */
    @Composable
    private fun ReminderDialog(
        habit: Habit,
        onDismiss: () -> Unit,
        onSave: (String, String) -> Unit,
    ) {
        // The typed box is the source of truth, exactly as in the web dialog;
        // the menus write into it.
        var typed by remember { mutableStateOf(habit.reminderTime) }
        var message by remember { mutableStateOf(habit.reminderMessage) }
        val parsed = ReminderTime.parse(typed)
        val valid = parsed != null

        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(habit.name) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        "A notification with " +
                            (if (habit.isNumerical) "a count field" else "Yes / No buttons") +
                            " appears at this time, so you can answer without opening the app.",
                        style = MaterialTheme.typography.bodySmall,
                    )

                    val current = ReminderTime.split(parsed ?: "")
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        TimeMenu(
                            label = current?.first ?: "--",
                            options = ReminderTime.hours(),
                            onPick = { hour ->
                                typed = "$hour:${current?.second ?: "00"}"
                            },
                        )
                        Text(":")
                        TimeMenu(
                            // The typed minute is included in the list, so an
                            // odd 08:37 is not silently rounded to 08:35.
                            label = current?.second ?: "--",
                            options = ReminderTime.minutes(current?.second?.toIntOrNull())
                                .map { it to it },
                            onPick = { minute ->
                                typed = "${current?.first ?: "08"}:$minute"
                            },
                        )
                        OutlinedTextField(
                            value = typed,
                            onValueChange = { typed = it },
                            label = { Text("or type") },
                            placeholder = { Text("08:30") },
                            singleLine = true,
                            isError = !valid,
                            modifier = Modifier.weight(1f),
                        )
                    }

                    Text(
                        if (!valid) {
                            "\"$typed\" is not a time — try 08:30, 8:30 pm or 2030."
                        } else if (parsed.isNullOrEmpty()) {
                            "No reminder — nothing will be sent for this habit."
                        } else {
                            ReminderTime.describe(parsed)
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = if (valid) {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        } else {
                            MaterialTheme.colorScheme.error
                        },
                    )

                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (common in ReminderTime.COMMON) {
                            TextButton(onClick = { typed = common }) { Text(common) }
                        }
                    }

                    OutlinedTextField(
                        value = message,
                        onValueChange = {
                            // One line, capped, matching LIMITS.reminderMessage:
                            // the reminder cache is line-delimited, so a newline
                            // here would corrupt the record it sits in.
                            message = it.replace("\n", " ").take(200)
                        },
                        label = { Text("What the reminder asks") },
                        placeholder = {
                            Text(
                                if (habit.isNumerical) "How many cups of water today?"
                                else "Did you exercise today?"
                            )
                        },
                        singleLine = true,
                        supportingText = {
                            Text("Optional — blank uses the habit's name and goal.")
                        },
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = valid,
                    onClick = { onSave(parsed ?: "", message.trim()) },
                ) { Text("Save") }
            },
            dismissButton = {
                Row {
                    if (habit.reminderTime.isNotBlank()) {
                        TextButton(onClick = { onSave("", message.trim()) }) { Text("Remove") }
                    }
                    TextButton(onClick = onDismiss) { Text("Cancel") }
                }
            },
        )
    }

    /**
     * One dropdown of `value to label` pairs.
     *
     * A button that opens a `DropdownMenu`, rather than an
     * `ExposedDropdownMenuBox`: the hour list is 24 items and the minute list
     * grows by one when an odd minute is typed, so the menu has to be
     * rebuildable without the text-field plumbing the exposed variant brings.
     */
    @Composable
    private fun TimeMenu(
        label: String,
        options: List<Pair<String, String>>,
        onPick: (String) -> Unit,
    ) {
        var open by remember { mutableStateOf(false) }
        Box {
            OutlinedButton(onClick = { open = true }) { Text(label) }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                for ((value, text) in options) {
                    DropdownMenuItem(
                        text = { Text(text) },
                        onClick = {
                            open = false
                            onPick(value)
                        },
                    )
                }
            }
        }
    }

    private fun trim(n: Double): String =
        if (n == n.toLong().toDouble()) n.toLong().toString() else n.toString()
}

@Composable
private fun HabiterallTheme(content: @Composable () -> Unit) {
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    MaterialTheme(
        colorScheme = if (dark) darkColorScheme() else lightColorScheme(),
        content = content,
    )
}
