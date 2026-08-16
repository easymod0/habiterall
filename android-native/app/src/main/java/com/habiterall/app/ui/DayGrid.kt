package com.habiterall.app.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.habiterall.app.data.Habit
import java.time.LocalDate

/**
 * A day that went over the limit, on a habit shown as something to avoid.
 *
 * Not the habit's own colour at reduced alpha, which is what a measurable
 * habit's shortfall uses: on a habit you are trying not to do, wearing the
 * habit's colour is what a GOOD day wears. A slip has to read as the thing it
 * is at a glance, in a grid where every other filled square is an achievement.
 */
private val SLIP = Color(0xFFDC2626)

/**
 * The day grid: one row per habit, and one column per day.
 *
 * The habit's name is pinned and the days scroll, all of them together — a
 * frozen first column over one shared [ScrollState], which is also why this is
 * a plain scrolling Row rather than a lazy one. Two lazy rows cannot share a
 * single state, and rows that scroll independently turn a grid into a set of
 * unrelated sliders where nothing lines up with the date above it.
 */

/**
 * Width of one day column.
 *
 * Chosen against the narrowest phone this app supports rather than by eye: at
 * 360dp, the pinned name column and the row's padding leave about 208dp, which
 * is five of these. Five days is the least that makes the grid worth having —
 * fewer and it says nothing the old single-day row did not.
 */
val CELL_WIDTH = 40.dp

/** Pinned habit-name column. Wide enough for "No late-night snacks" to wrap to two lines. */
val NAME_WIDTH = 120.dp

private val CELL_SIZE = 34.dp

/** Material's minimum touch target. The square drawn inside stays smaller. */
private val MIN_TOUCH = 48.dp

/**
 * What a screen reader says about one day.
 *
 * The cell's own text is a tick, a dash, a bare number or nothing at all —
 * none of which says which habit, which day, or what state. Announcing the
 * date alone was no better: "Record 2026-08-13" is a serial number read aloud,
 * and it left the one thing that matters, whether the day is already done,
 * entirely unspoken.
 */
private fun describe(
    habit: Habit,
    date: String,
    skipped: Boolean,
    value: Double?,
    met: Boolean?,
    unanswered: Boolean = false,
): String {
    val state = when {
        skipped -> "skipped"
        // Said whether or not question marks are on: a screen reader has no
        // square to look at, and "not done" for a day nobody has answered is the
        // same conflation the setting exists to undo.
        unanswered -> "no entry"
        habit.isNumerical && value != null ->
            "${trimNumber(value)} of ${trimNumber(habit.targetValue)} ${habit.unit}".trim()
        met == true -> "done"
        else -> "not done"
    }
    return "${habit.name}, ${spokenDate(date)}: $state"
}

/** What a screen reader says about a streak, since "🔥" is not a word. */
fun streakSpoken(days: Int): String =
    if (days == 1) "Current streak: 1 day" else "Current streak: $days days"

/** `2026-08-13` → `Thursday 13 August`, or the raw string if it will not parse. */
private fun spokenDate(date: String): String = runCatching {
    LocalDate.parse(date).format(java.time.format.DateTimeFormatter.ofPattern("EEEE d MMMM"))
}.getOrElse { date }

/**
 * The date row above the grid, scrolling in lockstep with every habit row.
 *
 * The dates live here rather than in each row for the obvious reason — one
 * label per column, not one per column per habit — and today is marked here
 * for the same reason: a marker repeated down every row is wallpaper.
 */
@Composable
fun DayHeader(dates: List<String>, today: String, scroll: ScrollState) {
    Row(
        Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(NAME_WIDTH))
        Row(Modifier.horizontalScroll(scroll)) {
            for (date in dates) {
                val isToday = date == today
                Column(
                    Modifier.width(CELL_WIDTH),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        weekdayLetter(date),
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        dayOfMonth(date),
                        fontSize = 12.sp,
                        fontWeight = if (isToday) FontWeight.Bold else FontWeight.Normal,
                        color = if (isToday) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}

/**
 * One habit: its name, its streak, its reminder, and its days.
 *
 * The Yes/No buttons this replaced only ever spoke about today. They are gone
 * rather than kept alongside, because two ways to record the same day — one of
 * which silently means "today" — is the confusion the web UI already had to
 * remove once.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun HabitGridRow(
    habit: Habit,
    dates: List<String>,
    today: String,
    scroll: ScrollState,
    onOpen: () -> Unit,
    onEdit: () -> Unit,
    onSetReminder: () -> Unit,
    onTapDay: (String) -> Unit,
    onHoldDay: (String) -> Unit,
    questionMarks: Boolean = false,
) {
    val color = habitColor(habit.color)

    Row(
        Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.width(NAME_WIDTH)) {
            Text(
                habit.name,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                // Tap opens, hold edits — the same pairing a day cell already
                // uses (`onTapDay` / `onHoldDay`), so the gesture is learned
                // once. Both are labelled, which is also what puts Edit in the
                // accessibility menu: a long press is not discoverable to a
                // screen reader, and `onLongClickLabel` is what makes it an
                // action rather than a secret.
                modifier = Modifier.combinedClickable(
                    onClickLabel = "Open habit",
                    onLongClickLabel = "Edit habit",
                    onLongClick = onEdit,
                    onClick = onOpen,
                ),
            )

            // The same "🔥 5" the web dashboard puts under a habit's name, and
            // the server's own arithmetic either way — `currentStreak` arrives
            // with the overview, so nothing here recomputes what `computeStats`
            // already decided.
            //
            // Absent at zero rather than shown as "🔥 0", which is the web's
            // rule too: a habit you have not started yet has no streak to
            // report, and a row of zeroes reads as a scolding.
            if (habit.currentStreak > 0) {
                Text(
                    "🔥 ${habit.currentStreak}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    // The emoji is decoration to a screen reader and a
                    // pictogram name to some of them; say the number instead.
                    modifier = Modifier.semantics {
                        contentDescription = streakSpoken(habit.currentStreak)
                    },
                )
            }

            TextButton(
                onClick = onSetReminder,
                contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp),
            ) {
                Text(
                    if (habit.reminderTime.isBlank()) "Add reminder"
                    else habit.reminderTime,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }

        Row(Modifier.horizontalScroll(scroll)) {
            for (date in dates) {
                DayCell(
                    habit = habit,
                    date = date,
                    isToday = date == today,
                    color = color,
                    questionMarks = questionMarks,
                    onTap = { onTapDay(date) },
                    onHold = { onHoldDay(date) },
                )
            }
        }
    }
}

/**
 * One day of one habit.
 *
 * A tap cycles, a long press opens the day's own dialog. The long press is not
 * the only way to reach anything — everything it offers is reachable by
 * tapping through the cycle — so nothing is hidden behind a gesture nobody
 * discovers; it is the shortcut, not the door.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DayCell(
    habit: Habit,
    date: String,
    isToday: Boolean,
    color: Color,
    questionMarks: Boolean,
    onTap: () -> Unit,
    onHold: () -> Unit,
) {
    // Through the habit, not the raw map: a yes/no day carrying Loop's old
    // SKIP sentinel is a skip, and reading `entries` directly paints it as a
    // partly-done day instead.
    val skipped = habit.isSkipped(date)
    val value = habit.valueOn(date)
    val met = habit.isMet(value, skipped)
    // No row at all, as against a day answered "no" — which is `entries` holding
    // 0. Only visible when the account asks for it, and the two are the same
    // empty square when it does not.
    val unknown = !skipped && habit.entries[date] == null

    // How full the square looks. A measurable habit that fell short shows a
    // faint version of its own colour rather than nothing, because "8 of 20
    // pages" is not the same day as one with no entry at all.
    // Shown as something to avoid: a clean day is the achievement and a slip
    // is the thing to see, so the colours are the other way up. Filling a slip
    // with the habit's own colour — right for a habit read as an amount, where
    // a bigger number is more done — reads as having done well.
    val avoided = habit.isAvoided

    val fill = when {
        skipped -> Color.Transparent
        avoided -> when {
            met == true -> color
            value != null -> SLIP
            else -> Color.Transparent
        }
        met == true -> color
        value != null && value > 0 -> color.copy(alpha = 0.35f)
        else -> Color.Transparent
    }

    val label = when {
        skipped -> "–"
        questionMarks && unknown -> "?"
        // A clean day is a tick rather than a nought: the number says nothing
        // on a limit of none, and the tick is what the day WAS. Over the limit
        // the count is the answer, because how far over matters on a limit of
        // two — except a bare 1 over a limit of 0, where the count adds nothing
        // the cross does not already say.
        avoided && met == true -> "✓"
        avoided -> value?.let {
            if (habit.targetValue == 0.0 && it == 1.0) "✗" else trimNumber(it)
        } ?: ""
        habit.isNumerical -> value?.let { trimNumber(it) } ?: ""
        met == true -> "✓"
        else -> ""
    }

    // The whole column is the target, not the square drawn inside it: 34dp was
    // well under the 48dp minimum, and on a grid every neighbour is a valid
    // target of the same kind, so a near miss did not do nothing — it recorded
    // the wrong day. Height reaches 48dp, which is free; width stays at the
    // column, because 48dp columns leave room for four days on a 360dp phone
    // and five is the least that makes this grid worth having.
    Box(
        Modifier
            .width(CELL_WIDTH)
            .heightIn(min = MIN_TOUCH)
            .combinedClickable(
                onClickLabel = "Record $date",
                onLongClickLabel = "Edit $date",
                onClick = onTap,
                onLongClick = onHold,
            )
            .semantics {
                contentDescription = describe(habit, date, skipped, value, met, unknown)
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(CELL_SIZE)
                .clip(RoundedCornerShape(8.dp))
                .background(
                    if (fill == Color.Transparent) MaterialTheme.colorScheme.surfaceVariant
                    else fill
                )
                .then(
                    // Today is outlined rather than filled: the fill already
                    // means "recorded", so borrowing it to also mean "today"
                    // would make an untouched today look done.
                    if (isToday) Modifier.border(
                        2.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(8.dp)
                    ) else Modifier
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (label.isNotEmpty()) {
                Text(
                    label,
                    fontSize = if (habit.isNumerical) 11.sp else 14.sp,
                    textAlign = TextAlign.Center,
                    color = if (met == true && !skipped) Color.White
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** `#8b5cf6` as a Compose colour, falling back rather than throwing on junk. */
@Composable
fun habitColor(hex: String): Color =
    runCatching { Color(android.graphics.Color.parseColor(hex)) }
        .getOrElse { MaterialTheme.colorScheme.primary }

/** `2026-08-13` → `13`. */
private fun dayOfMonth(date: String): String = date.takeLast(2).trimStart('0')

/** `2026-08-13` → `T`. Sunday-first initials, as the web header uses. */
private fun weekdayLetter(date: String): String =
    runCatching { "SMTWTFS"[LocalDate.parse(date).dayOfWeek.value % 7].toString() }
        .getOrElse { "" }

/** 2.0 → "2", 2.5 → "2.5". */
fun trimNumber(n: Double): String =
    if (n == n.toLong().toDouble()) n.toLong().toString() else n.toString()
