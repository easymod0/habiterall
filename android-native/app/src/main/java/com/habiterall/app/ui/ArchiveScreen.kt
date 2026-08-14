package com.habiterall.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.habiterall.app.data.Habit
import kotlinx.coroutines.launch

/**
 * The habits that are archived, and the way back out.
 *
 * This screen exists because the alternative is a one-way door. `/overview` does
 * not carry archived habits — correctly, it is the day grid's data — so the
 * moment the habit form grew an Archived switch, using it removed the habit from
 * the only list the phone had and there was no way to reach it again short of
 * opening the web app. An archive you cannot browse is a delete that lies about
 * what it did.
 *
 * Unarchiving is a whole-habit PUT with one field flipped, for the reason
 * [com.habiterall.app.data.HabitInput] gives: the route replaces rather than
 * patches, so sending `{archived: false}` alone would blank the name.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArchiveScreen(
    load: suspend () -> List<Habit>,
    onUnarchive: suspend (Habit) -> Unit,
    /**
     * Leaves for the habit's edit form, carrying whether this screen has already
     * written something.
     *
     * The flag travels because this is a hand-off and not a close: the caller
     * REPLACES this screen with the form, so an `onClose` never fires and every
     * restore done before tapping Edit would otherwise be forgotten. Restore a
     * habit, edit another, back out unchanged, and the list behind would still
     * not know the first one came back.
     */
    onEdit: (habit: Habit, changed: Boolean) -> Unit,
    onClose: (changed: Boolean) -> Unit,
) {
    var rows by remember { mutableStateOf<List<Habit>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var changed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    BackHandler(enabled = !busy) { onClose(changed) }

    LaunchedEffect(Unit) {
        try {
            rows = load()
        } catch (e: Exception) {
            // `rows` stays null, which is what tells the body apart from an
            // archive that is genuinely empty: "Nothing archived" under an error
            // message is the screen confidently answering a question it could
            // not ask.
            error = e.message ?: "Could not load the archive"
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Archived") },
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
        Column(Modifier.padding(pad).fillMaxSize()) {
            error?.let {
                Text(
                    it,
                    Modifier.padding(16.dp),
                    color = MaterialTheme.colorScheme.error,
                )
            }

            when {
                // The load failed, and the message above is the whole screen. No
                // spinner, because nothing is still coming.
                rows == null && error != null -> Unit
                rows == null -> Row(
                    Modifier.fillMaxWidth().padding(24.dp),
                    horizontalArrangement = Arrangement.Center,
                ) { CircularProgressIndicator() }
                rows!!.isEmpty() -> Text(
                    "Nothing archived. Archiving a habit keeps every day recorded for it " +
                        "and takes it out of the list and out of reminders.",
                    Modifier.padding(24.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> LazyColumn(
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(rows!!, key = { it.id }) { habit ->
                        Card(Modifier.fillMaxWidth()) {
                            Row(
                                Modifier.fillMaxWidth().padding(start = 16.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(habit.name, Modifier.weight(1f))
                                TextButton(onClick = { onEdit(habit, changed) }, enabled = !busy) {
                                    Text("Edit")
                                }
                                TextButton(
                                    enabled = !busy,
                                    onClick = {
                                        busy = true
                                        // Cleared before the attempt, so a
                                        // message from a failure two taps ago
                                        // does not sit over one that worked.
                                        error = null
                                        scope.launch {
                                            try {
                                                onUnarchive(habit)
                                                changed = true
                                                rows = rows?.filterNot { it.id == habit.id }
                                            } catch (e: Exception) {
                                                error = e.message ?: "Could not restore"
                                            } finally {
                                                busy = false
                                            }
                                        }
                                    },
                                ) { Text("Restore") }
                            }
                        }
                    }
                }
            }
        }
    }
}
