package com.habiterall.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.habiterall.app.notify.ReminderTime

/**
 * Picking a reminder time: an hour menu, a minute menu, and a box to type into.
 *
 * **All three edit one value, and the box is what gets submitted.** That is the
 * rule `shared/public/ui/reminder-field.js` states for the web dialog, and it is
 * the reason this is one control rather than a picker beside a field: with two
 * sources of truth there is a state where the menus say 08:30 and the value
 * saved is something else.
 *
 * The menus exist because picking 08:30 should not require typing a colon. The
 * box stays because `830`, `8:30 pm` and `8` are what people actually type, and
 * [ReminderTime.parse] — the mirror of `shared/public/ui/time.js` — is what makes
 * those equal to the picked forms. A picker that REPLACED the field would regress
 * the thing both of those files were written to support, which is why the
 * platform `TimePicker` is not used here: it cannot express "no reminder" and
 * cannot accept `830`, so it would be a third control rather than a replacement.
 *
 * This lived inside the habit list's reminder dialog, while the habit form — the
 * screen you get creating a habit — had the bare text box and the quick picks
 * alone. Same field, same habit, two different affordances depending on which
 * way in you took. Now both call this.
 *
 * Two properties it must not lose, both of which are about what the caller can
 * tell afterwards:
 *
 * - **Blank and unparseable are different answers.** `parse` returns `""` for
 *   blank (no reminder) and `null` for a mistake, and callers do different
 *   things with them — the form disables Save on the second rather than sending
 *   `""`. Nothing here may collapse one into the other.
 * - **`MINUTE_STEP` bounds the MENU, never the field.** The minute list carries
 *   the typed minute when it falls between the steps, so an odd `08:37` is not
 *   silently rounded to `08:35` by opening a menu.
 *
 * @param value the current text, verbatim as typed — not a parsed time
 * @param onValueChange called with the new text by every control here
 * @param quickPicks extra buttons beside [ReminderTime.COMMON]. The two callers
 *   want different ones — the form clears the draft, the dialog saves an empty
 *   time and closes — so clearing is deliberately NOT built in here. A button
 *   that means "no reminder" has to be a first-class one wherever it appears,
 *   rather than a hidden gesture on the field.
 */
@OptIn(ExperimentalLayoutApi::class)   // FlowRow, for the quick picks below
@Composable
fun ReminderTimeField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    quickPicks: @Composable RowScope.() -> Unit = {},
) {
    val parsed = ReminderTime.parse(value)
    val valid = parsed != null
    val current = ReminderTime.split(parsed ?: "")
    val complaint = "\"$value\" is not a time — try 08:30, 8:30 pm or 2030"

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            TimeMenu(
                label = current?.first ?: "--",
                options = ReminderTime.hours(),
                // The other half is kept as it stands: picking an hour on a
                // field that holds no minute yet must not invent one that
                // reads as a choice, and "00" is the honest one to land on.
                onPick = { hour -> onValueChange("$hour:${current?.second ?: "00"}") },
            )
            Text(":")
            TimeMenu(
                label = current?.second ?: "--",
                options = ReminderTime.minutes(current?.second?.toIntOrNull()).map { it to it },
                onPick = { minute -> onValueChange("${current?.first ?: "08"}:$minute") },
            )
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                label = { Text("or type") },
                placeholder = { Text("08:30") },
                singleLine = true,
                isError = !valid,
                // The complaint is a SIBLING of the field rather than its
                // `supportingText`, because it describes the two menus as well
                // — so the association a screen reader needs has to be made by
                // hand. Without it `isError` announces Material's generic
                // "Invalid input" and Save is disabled with no spoken reason,
                // which is what the habit form lost when it gained the picker.
                modifier = Modifier
                    .weight(1f)
                    .semantics { if (!valid) error(complaint) },
            )
        }

        Text(
            when {
                !valid -> "$complaint."
                parsed.isNullOrEmpty() -> "No reminder — nothing will be sent for this habit."
                else -> ReminderTime.describe(parsed)
            },
            style = MaterialTheme.typography.bodySmall,
            color = if (valid) MaterialTheme.colorScheme.onSurfaceVariant
            else MaterialTheme.colorScheme.error,
        )

        // Wrapping, not a Row. Five quick picks plus whatever the caller adds
        // do not fit the width of a dialog on a 360dp phone, and a plain Row
        // clips silently — `21:00` was simply unreachable from the reminder
        // dialog, with nothing on screen to say a button was missing. Measured
        // on an emulator rather than guessed: the full-screen form fit all six
        // and the dialog fit four.
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (common in ReminderTime.COMMON) {
                TextButton(onClick = { onValueChange(common) }) { Text(common) }
            }
            quickPicks()
        }
    }
}

/**
 * One dropdown of `value to label` pairs.
 *
 * A button that opens a `DropdownMenu`, rather than an `ExposedDropdownMenuBox`:
 * the hour list is 24 items and the minute list grows by one when an odd minute
 * is typed, so the menu has to be rebuildable without the text-field plumbing
 * the exposed variant brings.
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
