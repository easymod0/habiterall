package com.habiterall.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import com.habiterall.app.data.DEFAULT_HABIT_COLOR
import com.habiterall.app.data.Habit
import com.habiterall.app.data.HabitInput
import com.habiterall.app.notify.ReminderTime
import kotlinx.coroutines.launch

/**
 * Colours offered for a habit.
 *
 * The web dialog uses `<input type="color">` — the whole space, through the
 * platform's own picker. Android has no equivalent widget, so this is a fixed
 * palette instead, and it is deliberately NOT a mirror of anything: the server
 * accepts any `#rrggbb` (`COLOR_RE` in shared/src/validate.js), a habit created
 * on the web keeps whatever colour it was given, and that colour is shown as
 * selected here even when it is not in this list. Adding to it changes what this
 * app offers and nothing else.
 */
private val PALETTE = listOf(
    "#ef4444", "#f97316", "#f59e0b", "#eab308",
    "#84cc16", "#22c55e", "#10b981", "#14b8a6",
    "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6",
    "#a855f7", "#d946ef", "#ec4899", "#64748b",
)

/** The form's editable state. Numbers are text, because a half-typed number is text. */
private data class Draft(
    val name: String = "",
    val description: String = "",
    val numerical: Boolean = false,
    val unit: String = "",
    val target: String = "",
    val atMost: Boolean = false,
    val freqNumerator: String = "1",
    val freqDenominator: String = "1",
    val color: String = DEFAULT_HABIT_COLOR,
    val reminderTime: String = "",
    val reminderMessage: String = "",
    val archived: Boolean = false,
)

private fun Habit.toDraft() = Draft(
    name = name,
    description = description,
    numerical = isNumerical,
    unit = unit,
    // A whole number types as "3", not "3.0" — the field is what the user sees.
    target = if (targetValue == 0.0) "" else formatAmount(targetValue),
    atMost = targetType == "at_most",
    freqNumerator = freqNumerator.toString(),
    freqDenominator = freqDenominator.toString(),
    color = color,
    reminderTime = reminderTime,
    reminderMessage = reminderMessage,
    archived = archived,
)

internal fun formatAmount(v: Double): String =
    if (v == v.toLong().toDouble()) v.toLong().toString() else v.toString()

/**
 * A typed amount as a number, or null if it is not one yet.
 *
 * The comma is the point. `KeyboardType.Decimal` shows whatever separator the
 * phone's locale uses, which across most of Europe is `,` — so "8,5" is what the
 * keyboard invites and `toDoubleOrNull` refuses, and the old elvis turned that
 * refusal into a silent target of 0 that no entry could ever meet. Half-typed
 * text still returns null; [HabitFormScreen] disables Save for it rather than
 * guessing, which is the same treatment the reminder time already gets.
 */
internal fun parseAmount(text: String): Double? =
    text.trim().replace(',', '.').toDoubleOrNull()

/**
 * The draft as the server accepts it.
 *
 * Nothing here re-implements `parseHabit` (shared/src/validate.js), and that is
 * the rule rather than an omission: the phone submits and renders whatever comes
 * back, including the error. A second copy of the frequency bounds or the name
 * length would be one more thing to keep in step for no gain, since the server
 * checks them anyway and is the only opinion that decides what gets stored.
 *
 * What IS done here is coercion the wire format needs — an empty target box is
 * the number 0, and a habit that is not numerical has no unit or target to send.
 */
private fun Draft.toInput() = HabitInput(
    name = name.trim(),
    description = description.trim(),
    type = if (numerical) "numerical" else "boolean",
    unit = if (numerical) unit.trim() else "",
    // An empty box is a habit with no target, which parseHabit reads as 0.
    // Anything else has been through `parseAmount` and Save, so the elvis here
    // is unreachable rather than lossy — see [canSave].
    targetValue = if (numerical) parseAmount(target) ?: 0.0 else 0.0,
    targetType = if (atMost) "at_most" else "at_least",
    freqNumerator = freqNumerator.toIntOrNull() ?: 1,
    freqDenominator = freqDenominator.toIntOrNull() ?: 1,
    color = color,
    // Parsed, not pattern-matched: '8:30 pm' and '830' are what people type, and
    // ReminderTime is the mirror of shared/public/ui/time.js that turns them
    // into the '08:30' the field stores. Null means unparseable, and Save is
    // disabled for that, so the elvis is unreachable rather than lossy.
    reminderTime = ReminderTime.parse(reminderTime) ?: "",
    reminderMessage = reminderMessage.replace("\n", " ").trim().take(200),
    archived = archived,
)

/**
 * Create or edit a habit.
 *
 * A full screen rather than the `AlertDialog` the other editors use, because
 * this has eleven fields and a dialog that scrolls is a dialog that should have
 * been a screen.
 *
 * [existing] null means create. The only structural difference between the two
 * is which call is made on save and whether Delete is offered, so they are one
 * composable — a second one would be the same eleven fields, drifting.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HabitFormScreen(
    existing: Habit?,
    confirmDelete: Boolean,
    onSave: suspend (HabitInput) -> Unit,
    onDelete: (suspend () -> Unit)? = null,
    /**
     * Closes the screen, saying whether anything was WRITTEN.
     *
     * The distinction is not cosmetic: the caller refetches the list on `true`,
     * and a refetch puts the pull indicator up. Backing out of a form without
     * saving would otherwise look like the list doing work in response to a
     * change nobody made.
     */
    onClose: (changed: Boolean) -> Unit,
) {
    var draft by rememberSaveableDraft(existing)
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var askDelete by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // Without this the system Back gesture falls past this screen to the
    // list underneath — which is still composed, so Back would leave the app
    // entirely with the form apparently still open behind it. Disabled while
    // a write is in flight, so Back cannot orphan a request.
    BackHandler(enabled = !busy) { onClose(false) }

    val timeParsed = ReminderTime.parse(draft.reminderTime)
    // A blank target is a habit with no target; anything else has to be a
    // number, because the alternative is sending 0 for text the user typed.
    val targetOk = !draft.numerical || draft.target.isBlank() ||
        parseAmount(draft.target) != null
    // The only three things that disable Save, and none is a validation rule
    // duplicated from the server: a habit with no name has nothing to submit, an
    // unparseable time would be silently sent as "no reminder", and an
    // unparseable target would be silently sent as zero.
    val canSave = draft.name.isNotBlank() && timeParsed != null && targetOk && !busy

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (existing == null) "New habit" else "Edit habit") },
                navigationIcon = {
                    IconButton(onClick = { onClose(false) }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (busy) {
                        CircularProgressIndicator(Modifier.size(22.dp).padding(end = 4.dp))
                    }
                    TextButton(
                        enabled = canSave,
                        onClick = {
                            busy = true
                            error = null
                            scope.launch {
                                try {
                                    onSave(draft.toInput())
                                    onClose(true)
                                } catch (e: Exception) {
                                    // The server's own message. It is the only
                                    // thing that knows why, and repeating its
                                    // rules here to guess would be the mirror
                                    // this deliberately does not keep.
                                    error = e.message ?: "Could not save"
                                    busy = false
                                }
                            }
                        },
                    ) { Text("Save") }
                },
            )
        }
    ) { pad ->
        Column(
            Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
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

            OutlinedTextField(
                value = draft.name,
                onValueChange = { draft = draft.copy(name = it.take(100)) },
                label = { Text("Name") },
                placeholder = { Text("Meditate") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = draft.description,
                onValueChange = { draft = draft.copy(description = it.take(500)) },
                label = { Text("Description") },
                supportingText = { Text("Optional") },
                modifier = Modifier.fillMaxWidth(),
            )

            /* ---------------------------------------------------------- type */

            SectionLabel("Type")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = !draft.numerical,
                    onClick = { draft = draft.copy(numerical = false) },
                    label = { Text("Yes / no") },
                )
                FilterChip(
                    selected = draft.numerical,
                    onClick = { draft = draft.copy(numerical = true) },
                    label = { Text("Measurable") },
                )
            }

            if (draft.numerical) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = draft.target,
                        onValueChange = { draft = draft.copy(target = it) },
                        label = { Text("Target") },
                        placeholder = { Text("8") },
                        singleLine = true,
                        isError = !targetOk,
                        supportingText = if (targetOk) null else {
                            { Text("Not a number", color = MaterialTheme.colorScheme.error) }
                        },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedTextField(
                        value = draft.unit,
                        onValueChange = { draft = draft.copy(unit = it.take(20)) },
                        label = { Text("Unit") },
                        placeholder = { Text("glasses") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(
                        selected = !draft.atMost,
                        onClick = { draft = draft.copy(atMost = false) },
                        label = { Text("At least") },
                    )
                    FilterChip(
                        selected = draft.atMost,
                        onClick = { draft = draft.copy(atMost = true) },
                        label = { Text("At most") },
                    )
                }
                // The trap this note exists for is in CLAUDE.md: entry VALUES
                // scale by x1000 on the wire and targets do not. Nothing here
                // scales anything, and nothing should start.
                Text(
                    "A target of 8 with \"at least\" is met by 8 or more.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            /* ----------------------------------------------------- frequency */

            SectionLabel("How often")
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = draft.freqNumerator,
                    onValueChange = { draft = draft.copy(freqNumerator = it.filter(Char::isDigit)) },
                    label = { Text("Times") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.weight(1f),
                )
                Text("per")
                OutlinedTextField(
                    value = draft.freqDenominator,
                    onValueChange = {
                        draft = draft.copy(freqDenominator = it.filter(Char::isDigit))
                    },
                    label = { Text("Days") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.weight(1f),
                )
            }
            Text(
                "1 per 1 is every day. 3 per 7 is three times a week.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            /* --------------------------------------------------------- colour */

            SectionLabel("Colour")
            ColorPicker(
                selected = draft.color,
                onPick = { draft = draft.copy(color = it) },
            )

            /* ------------------------------------------------------- reminder */

            SectionLabel("Reminder")
            OutlinedTextField(
                value = draft.reminderTime,
                onValueChange = { draft = draft.copy(reminderTime = it) },
                label = { Text("Time") },
                placeholder = { Text("08:30") },
                singleLine = true,
                isError = timeParsed == null,
                supportingText = {
                    Text(
                        when {
                            timeParsed == null ->
                                "\"${draft.reminderTime}\" is not a time — try 08:30, 8:30 pm or 2030."
                            timeParsed.isEmpty() -> "Blank means no reminder."
                            else -> ReminderTime.describe(timeParsed)
                        },
                        color = if (timeParsed == null) MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (common in ReminderTime.COMMON) {
                    TextButton(onClick = { draft = draft.copy(reminderTime = common) }) {
                        Text(common)
                    }
                }
                if (draft.reminderTime.isNotBlank()) {
                    TextButton(onClick = { draft = draft.copy(reminderTime = "") }) {
                        Text("None")
                    }
                }
            }
            OutlinedTextField(
                value = draft.reminderMessage,
                onValueChange = {
                    // One line, capped at LIMITS.reminderMessage: the phone's
                    // reminder cache is line-delimited, so a newline here would
                    // corrupt the record it is stored in.
                    draft = draft.copy(reminderMessage = it.replace("\n", " ").take(200))
                },
                label = { Text("What the reminder asks") },
                placeholder = { Text("Did you meditate today?") },
                singleLine = true,
                supportingText = { Text("Optional — blank uses the habit's name and goal.") },
                modifier = Modifier.fillMaxWidth(),
            )

            /* -------------------------------------------------------- archive */

            if (existing != null) {
                SectionLabel("Archive")
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Archived")
                        Text(
                            "Keeps every entry, and takes the habit out of the list and " +
                                "out of reminders.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = draft.archived,
                        onCheckedChange = { draft = draft.copy(archived = it) },
                    )
                }

                if (onDelete != null) {
                    TextButton(
                        onClick = {
                            // The account's `confirmDelete` decides, not this
                            // screen — it is already the web's setting and this
                            // is the same account. Defaulting it ON is in
                            // AppSettings, with the reason.
                            if (confirmDelete) askDelete = true else scope.launch {
                                busy = true
                                try { onDelete(); onClose(true) } catch (e: Exception) {
                                    error = e.message ?: "Could not delete"; busy = false
                                }
                            }
                        },
                        enabled = !busy,
                    ) {
                        Text("Delete habit", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }

    if (askDelete && onDelete != null) {
        AlertDialog(
            onDismissRequest = { askDelete = false },
            title = { Text("Delete \"${existing?.name.orEmpty()}\"?") },
            text = {
                Text(
                    "Every day recorded for this habit goes with it, and that cannot be " +
                        "undone. Archiving keeps the history and hides the habit."
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    askDelete = false
                    busy = true
                    scope.launch {
                        try { onDelete(); onClose(true) } catch (e: Exception) {
                            error = e.message ?: "Could not delete"; busy = false
                        }
                    }
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { askDelete = false }) { Text("Cancel") }
            },
        )
    }
}

/**
 * The draft, surviving rotation.
 *
 * `rememberSaveable` cannot carry a data class without a Saver, and writing one
 * for twelve fields is more code than it is worth — so the draft is remembered
 * against the habit's identity instead. Rotating mid-edit therefore keeps the
 * form open and loses unsaved typing, which is the same trade the day editor
 * already makes; a Saver is the fix if that ever proves annoying.
 */
@Composable
private fun rememberSaveableDraft(existing: Habit?) =
    remember(existing?.id) { mutableStateOf(existing?.toDraft() ?: Draft()) }

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/**
 * The palette, plus whatever colour the habit already has.
 *
 * That last part matters: a habit coloured on the web through the browser's full
 * picker would otherwise show nothing selected here, and saving would silently
 * move it to a colour the user never chose.
 */
@Composable
private fun ColorPicker(selected: String, onPick: (String) -> Unit) {
    val swatches = if (PALETTE.any { it.equals(selected, ignoreCase = true) }) PALETTE
    else PALETTE + selected

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        swatches.chunked(8).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { hex ->
                    val isSelected = hex.equals(selected, ignoreCase = true)
                    Column(
                        Modifier
                            .size(34.dp)
                            .background(habitColor(hex), CircleShape)
                            .then(
                                if (isSelected) Modifier.border(
                                    3.dp,
                                    MaterialTheme.colorScheme.onSurface,
                                    CircleShape,
                                ) else Modifier
                            )
                            .clickable { onPick(hex) }
                    ) {}
                }
            }
        }
    }
}

