package com.habiterall.app.ui

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.unit.dp
import com.habiterall.app.data.Habit
import com.habiterall.app.data.HabitFilter

/**
 * The list screen's shell — top bar, the list itself (or its loading, error or
 * empty state), and the two effects that keep the scroll position and a
 * notification's focus honest.
 *
 * Top-level, and stateless in everything but `menuOpen`, which is the whole
 * point: this was a private method on `MainActivity` with no way to drive it
 * from a test, and this file's own lesson is that four Android bugs have lived
 * one line below a correct pure function for exactly that reason. Hoisting the
 * state here is what makes the wiring reachable from `HabitListTest`.
 *
 * `habits`, `rows` and `visible` are three distinct things and the search box
 * is why: `habits` is the fetched list, unfiltered; `rows` is `habits` with the
 * pending-write overlay laid on, still unfiltered; and `visible` — computed
 * here from `rows.filter { HabitFilter.matches(it, query) }` — is what the
 * `LazyColumn` actually renders. The reorder hand-off, its `enabled`, the
 * full-screen error branch and the search box's own visibility threshold all
 * read `habits`, on purpose: handing any of those a filtered subset is wrong in
 * a way that ranges from "looks wrong" (the box vanishing under the query that
 * would show it) to "corrupts stored data" (a reorder rewriting the position of
 * every habit that was not on screen). `ScrollRestore` and the `focusHabit`
 * index read `visible`, because both are about what the `LazyColumn` actually
 * holds.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HabitList(
    habits: List<Habit>,          // the fetched list, unfiltered
    rows: List<Habit>,            // habits + the pending-write overlay, still unfiltered
    loading: Boolean,
    loaded: Boolean,
    error: String?,
    dates: List<String>,
    today: String,
    questionMarks: Boolean,
    query: String,
    onQueryChange: (String) -> Unit,
    listState: LazyListState,
    dayScroll: ScrollState,
    snackbar: SnackbarHostState,
    focusHabit: Long?,
    onFocused: () -> Unit,
    onRefresh: () -> Unit,
    onReorder: (List<Habit>) -> Unit,
    onNewHabit: () -> Unit,
    onOpenHabit: (Habit) -> Unit,
    onEditHabit: (Habit) -> Unit,
    onSetReminder: (Habit) -> Unit,
    onTapDay: (Habit, String) -> Unit,
    onHoldDay: (Habit, String) -> Unit,
    onOpenStats: () -> Unit,
    onOpenArchive: () -> Unit,
    onOpenSettings: (() -> Unit),
    onSignOut: (() -> Unit)?,
    onChangeServer: () -> Unit,
) {
    // The rendered list: `rows` (habits + the pending overlay) narrowed by the
    // search box, if it holds anything. `remember`ed on both, not recomputed
    // per recomposition for no reason — this runs per keystroke.
    val visible = remember(rows, query) { rows.filter { HabitFilter.matches(it, query) } }
    val filtering = query.isNotBlank()

    // Correct a restored scroll position that no longer fits the list.
    //
    // See ScrollRestore for what can go wrong and why; the rule is there,
    // and unit-tested, because the version inlined here only covered a
    // clipped FIRST row and left a clipped row at any other index — which
    // is the case that kept being reported. Reads `visible`, not `habits`:
    // once a query can make the two differ, a restored offset has to be
    // judged against what the `LazyColumn` actually holds.
    LaunchedEffect(visible.size) {
        if (ScrollRestore.needsSnapToTop(
                listState.firstVisibleItemIndex,
                listState.firstVisibleItemScrollOffset,
                visible.size,
            )
        ) {
            listState.scrollToItem(0)
        }
    }

    // Put the habit a notification was about on screen.
    //
    // Waits for the fetch rather than for the list: a tap that cold-starts
    // the app arrives before there are any habits to look through, and
    // scrolling to "not found" is just the top. Cleared once `loaded`,
    // found or not — a habit archived since its alarm was armed must not
    // leave a focus pending forever, because the resume snap below defers
    // to it.
    //
    // A notification tap wins over a filter: a query live when one arrives is
    // cleared first, on the (separate) pass that follows, rather than have the
    // habit it names hunted for in a list a live query may have narrowed past
    // it. `query` has to be a key and not just read: keyed on `visible` alone,
    // a query that happens to match every habit produces a list that is
    // `equals` to the unfiltered one once it clears, so the effect would never
    // re-run and `onFocused()` would never fire — the focus left pending for
    // the life of the process, which is exactly what suppresses the resume
    // snap-to-top below. Returning without `onFocused()` on the clearing pass
    // is deliberate too: calling it here would clear the focus as though the
    // habit had already been found, when the very next recomposition is the
    // pass that looks for it.
    LaunchedEffect(focusHabit, visible, loaded, query) {
        if (focusHabit == null || !loaded) return@LaunchedEffect
        if (query.isNotBlank()) { onQueryChange(""); return@LaunchedEffect }
        val index = visible.indexOfFirst { it.id == focusHabit }
        if (index >= 0) listState.scrollToItem(index)
        onFocused()
    }

    var menuOpen by remember { mutableStateOf(false) }
    // Whether the search field itself holds focus. Read alongside the query
    // and the unfiltered count so the box never disappears out from under the
    // caret: see `showSearch` below.
    var boxHasFocus by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Today") },
                actions = {
                    TextButton(onClick = onOpenStats) { Text("Stats") }
                    // An overflow rather than more buttons: the bar already
                    // carries Stats, and a 360dp phone runs out of room at
                    // three. Everything in here is a screen, not an action.
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "More")
                    }
                    DropdownMenu(
                        expanded = menuOpen,
                        onDismissRequest = { menuOpen = false },
                    ) {
                        DropdownMenuItem(
                            text = { Text("Reorder habits") },
                            // Two, not one: a single habit has nowhere to
                            // go, and a screen whose every button is
                            // disabled is worse than a menu item that is.
                            //
                            // `habits`, not `visible`: `ReorderScreen` writes
                            // the WHOLE order back to the server — every id's
                            // index becomes its `position` — so handing it a
                            // filtered subset would rewrite the position of
                            // every habit a live query had hidden. This is the
                            // one hazard here that corrupts stored data rather
                            // than just looking wrong, which is also why the
                            // reorder screen is a separate full-screen list
                            // rather than the web's in-place drag handle: it
                            // keeps working under a query that hides most of
                            // the grid.
                            enabled = habits.size > 1,
                            onClick = { menuOpen = false; onReorder(habits) },
                        )
                        DropdownMenuItem(
                            text = { Text("Archived habits") },
                            onClick = { menuOpen = false; onOpenArchive() },
                        )
                        DropdownMenuItem(
                            text = { Text("Settings") },
                            onClick = { menuOpen = false; onOpenSettings() },
                        )
                        onSignOut?.let { signOut ->
                            DropdownMenuItem(
                                text = { Text("Sign out") },
                                onClick = { menuOpen = false; signOut() },
                            )
                        }
                        DropdownMenuItem(
                            text = { Text("Change server") },
                            onClick = { menuOpen = false; onChangeServer() },
                        )
                    }
                },
            )
        },
        floatingActionButton = {
            // Only once a fetch has landed. A phone that cannot reach the
            // server should not offer to create a habit on it — the POST
            // would fail, and the failure would be the first the user heard
            // of a connection problem the error screen is already reporting.
            if (loaded && error == null) {
                FloatingActionButton(onClick = onNewHabit) {
                    Icon(Icons.Default.Add, contentDescription = "New habit")
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { pad ->
        // Exactly one spinner per fetch: the full-screen one until the
        // first result lands, the pull indicator for every fetch after it.
        // Keyed on "has a fetch finished" rather than "is the list empty",
        // or an account with no habits yet would flip between the two on
        // every pull.
        PullToRefreshBox(
            isRefreshing = loading && loaded,
            onRefresh = onRefresh,
            modifier = Modifier.padding(pad).fillMaxSize(),
        ) {
            Column(Modifier.fillMaxSize()) {
                // Above `DayHeader` and outside the `when` below, on purpose:
                // a query that matches nothing switches the `when` to the
                // no-match branch, and a box that lived only inside the list
                // branch would vanish along with it — leaving no way to type
                // the query back out.
                //
                // The threshold reads `habits`, the unfiltered count, mirroring
                // `dashboard.js`: #74's own framing is "fine at eight habits and
                // unpleasant at thirty", and a control above a list of four is
                // clutter. The other two clauses are why the box never
                // disappears out from under the caret — below the threshold,
                // clearing the query would otherwise hide the row the cursor is
                // sitting in.
                val showSearch = habits.size >= SEARCH_FROM ||
                    query.isNotEmpty() ||
                    boxHasFocus
                if (showSearch) {
                    OutlinedTextField(
                        value = query,
                        onValueChange = onQueryChange,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                            .onFocusChanged { boxHasFocus = it.isFocused },
                        singleLine = true,
                        label = { Text("Find a habit") },
                        trailingIcon = {
                            if (query.isNotEmpty()) {
                                IconButton(onClick = { onQueryChange("") }) {
                                    Icon(Icons.Default.Clear, contentDescription = "Clear")
                                }
                            }
                        },
                    )
                    if (filtering) {
                        Text(
                            "${visible.size} of ${habits.size}",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(horizontal = 16.dp),
                        )
                    }
                }
                Box(Modifier.weight(1f)) {
                    when {
                        loading && !loaded -> Loading()
                        error != null && habits.isEmpty() -> Column(
                            // Scrollable so the pull gesture reaches this screen
                            // at all: PullToRefreshBox only hears about a drag
                            // that a scrollable child hands up to it, and this
                            // is the one screen where a retry is the entire
                            // point.
                            Modifier.fillMaxSize()
                                .verticalScroll(rememberScrollState())
                                .padding(24.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Text(error!!, color = MaterialTheme.colorScheme.error)
                            Button(onClick = onRefresh) { Text("Try again") }
                            TextButton(onClick = onChangeServer) { Text("Change server") }
                        }
                        habits.isEmpty() -> Column(
                            Modifier.fillMaxSize()
                                .verticalScroll(rememberScrollState())
                                .padding(24.dp),
                        ) {
                            // "Add one in the web app" is what this said until
                            // the phone could create one, which is the single
                            // change that most decided whether this client was
                            // a companion or a client in its own right.
                            Text("No habits yet.")
                            Button(onClick = onNewHabit) { Text("Add a habit") }
                            TextButton(onClick = onOpenStats) { Text("Open the web app") }
                        }
                        visible.isEmpty() -> Column(
                            // An empty ACCOUNT gets the onboarding panel above;
                            // an empty RESULT gets this sentence instead —
                            // offering "create your first habit" to someone who
                            // has thirty and mistyped one is the app forgetting
                            // what it holds. The web's own wording.
                            Modifier.fillMaxSize()
                                .verticalScroll(rememberScrollState())
                                .padding(24.dp),
                        ) {
                            Text("No habits match that.")
                        }
                        else -> Column(Modifier.fillMaxSize()) {
                            DayHeader(dates = dates, today = today, scroll = dayScroll)
                            HorizontalDivider()
                            LazyColumn(Modifier.fillMaxSize(), state = listState) {
                                items(visible, key = { it.id }) { habit ->
                                    HabitGridRow(
                                        habit = habit,
                                        dates = dates,
                                        today = today,
                                        scroll = dayScroll,
                                        onOpen = { onOpenHabit(habit) },
                                        onEdit = { onEditHabit(habit) },
                                        onSetReminder = { onSetReminder(habit) },
                                        onTapDay = { date -> onTapDay(habit, date) },
                                        onHoldDay = { date -> onHoldDay(habit, date) },
                                        questionMarks = questionMarks,
                                    )
                                    HorizontalDivider()
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * The box appears once there are enough habits to lose one in.
 *
 * #74's own framing: "fine at eight habits and unpleasant at thirty" — a
 * control above a list of four is clutter. Mirrors `dashboard.js`'s
 * `SEARCH_FROM`; not imported from anywhere, because there is nowhere shared
 * to import it from — this predicate reaches no storage and is not a mirror.
 */
private const val SEARCH_FROM = 6

// Not `private`, unlike everything else moved here: MainActivity's own
// `onCreate` still calls this directly for two branches that are not part of
// the list at all (`!checked` and `session == null`), and a top-level
// `private` is file-scoped in Kotlin, not package-scoped — a literal reading
// of "private" here would have made those two spinners fail to compile.
@Composable
fun Loading() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}
