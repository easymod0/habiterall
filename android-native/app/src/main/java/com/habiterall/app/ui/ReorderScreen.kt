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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.unit.dp
import com.habiterall.app.data.Habit
import com.habiterall.app.data.HabitOrder
import kotlinx.coroutines.launch

/**
 * The order habits appear in, which is the account's and not this phone's.
 *
 * `habits.position` is a stored column, so a nudge here moves the web app too.
 * That is the reason each move is written immediately and the server's answer
 * adopted, rather than batched behind a Save button: the list this screen shows
 * after a move is the list the database holds, so there is never a moment where
 * the phone is displaying an order nobody else has.
 *
 * **Buttons, not drag.** Compose has no reorderable `LazyColumn`, and a
 * hand-rolled long-press drag is a few hundred lines of hit-testing that fails
 * quietly on exactly the devices hardest to test on. Arrows also work with a
 * screen reader and a switch, which a drag gesture does not. Drag is a fair
 * thing to add later; it is not a prerequisite for being able to reorder at all,
 * which until now was not possible on the phone by any means.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReorderScreen(
    habits: List<Habit>,
    onReorder: suspend (List<Long>) -> List<Habit>,
    /** Closes, saying whether a new order was actually stored. */
    onClose: (changed: Boolean) -> Unit,
) {
    var rows by remember { mutableStateOf(habits) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var changed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    BackHandler(enabled = !busy) { onClose(changed) }

    fun nudge(from: Int, to: Int) {
        if (busy) return
        val moved = HabitOrder.move(rows.map { it.id }, from, to)
        if (moved == rows.map { it.id }) return

        // Optimistic, because a reorder that waits for a round trip before the
        // row moves reads as a button that did not work. The server's answer
        // replaces this a moment later and is authoritative — including when it
        // disagrees, which is what happens if the web reordered meanwhile.
        val byId = rows.associateBy { it.id }
        rows = moved.mapNotNull { byId[it] }

        busy = true
        error = null
        scope.launch {
            try {
                rows = onReorder(moved)
                changed = true
            } catch (e: Exception) {
                error = e.message ?: "Could not save the new order"
                // Put back what the server still believes, rather than leaving
                // an order on screen that was never stored.
                rows = habits
            } finally {
                busy = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Reorder") },
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
                Card(Modifier.fillMaxWidth().padding(12.dp)) {
                    Text(
                        it,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }

            if (rows.isEmpty()) {
                Text(
                    "No habits to reorder yet.",
                    Modifier.padding(24.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            LazyColumn(
                contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                itemsIndexed(rows, key = { _, h -> h.id }) { index, habit ->
                    Card(Modifier.fillMaxWidth()) {
                        Row(
                            Modifier.fillMaxWidth().padding(start = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(habit.name, Modifier.weight(1f))
                            IconButton(
                                enabled = !busy && HabitOrder.canMoveUp(index),
                                onClick = { nudge(index, index - 1) },
                            ) {
                                Icon(
                                    Icons.Default.KeyboardArrowUp,
                                    contentDescription = "Move ${habit.name} up",
                                )
                            }
                            IconButton(
                                enabled = !busy && HabitOrder.canMoveDown(index, rows.size),
                                onClick = { nudge(index, index + 1) },
                            ) {
                                Icon(
                                    Icons.Default.KeyboardArrowDown,
                                    contentDescription = "Move ${habit.name} down",
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
