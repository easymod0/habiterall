package com.habiterall.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
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
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.habiterall.app.data.Category
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
 * search box narrows the list to. The reorder hand-off, its `enabled`, the
 * full-screen error branch and the search icon's own
 * `habits.isNotEmpty() || filtering` gate all read `habits`, on purpose:
 * handing any of those a filtered subset is wrong in a way that ranges from
 * "looks wrong" (the icon vanishing while a query it is showing is still live)
 * to "corrupts stored data" (a reorder rewriting the position of every habit
 * that was not on screen). The icon's second clause is not a hedge on the
 * first: `filtering` is what keeps the only control that can clear a filter on
 * screen once `habits` itself goes empty underneath one.
 *
 * `listRows` — `HabitSections.rows(visible, categories, grouped)` — is a
 * fourth list and the one the `LazyColumn` actually renders: ungrouped it is
 * `visible` wearing `ListRow.Entry`, grouped it interleaves a `ListRow.Header`
 * per category. `ScrollRestore` and the `focusHabit` index read `listRows`,
 * not `visible`, because once a header can be an item the item count is not
 * the habit count and a habit's index is not its position in `visible` — see
 * `HabitSections`'s own KDoc for the defect shape this avoids.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun HabitList(
    habits: List<Habit>,          // the fetched list, unfiltered
    rows: List<Habit>,            // habits + the pending-write overlay, still unfiltered
    categories: List<Category>,   // this account's categories, in the server's own order
    grouped: Boolean,             // whether to draw one section per category
    loading: Boolean,
    loaded: Boolean,
    error: String?,
    dates: List<String>,
    today: String,
    questionMarks: Boolean,
    query: String,
    onQueryChange: (String) -> Unit,
    searchOpen: Boolean,
    onSearchOpenChange: (Boolean) -> Unit,
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

    // What the `LazyColumn` below actually iterates. Ungrouped this is
    // `visible` wearing `ListRow.Entry` and nothing else — see `HabitSections`.
    // `ScrollRestore` and the `focusHabit` index below read THIS list, not
    // `visible`: once a category header can be an item, the item count is not
    // the habit count and a habit's position in `listRows` is not its
    // position in `visible`.
    val listRows = remember(visible, categories, grouped) {
        HabitSections.rows(visible, categories, grouped)
    }

    // `HabitFilter.isActive`, not `query.isNotBlank()`: this drives the active
    // badge, the tint, the "filter active" description, the long-press to clear
    // and the "N of M" count — five claims that a filter is narrowing the list
    // — so it has to be the predicate the FILTER decides by rather than a
    // second, near-enough one. `matches` folds before it looks, and a query of
    // only combining marks folds to nothing and matches everything: not blank,
    // not filtering.
    val filtering = HabitFilter.isActive(query)

    // Correct a restored scroll position that no longer fits the list.
    //
    // See ScrollRestore for what can go wrong and why; the rule is there,
    // and unit-tested, because the version inlined here only covered a
    // clipped FIRST row and left a clipped row at any other index — which
    // is the case that kept being reported. Reads `listRows`, not `habits`
    // or `visible`: once a query can make those differ, and a header can be
    // an item, a restored offset has to be judged against what the
    // `LazyColumn` actually holds.
    LaunchedEffect(listRows.size) {
        if (ScrollRestore.needsSnapToTop(
                listState.firstVisibleItemIndex,
                listState.firstVisibleItemScrollOffset,
                listRows.size,
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
    // pass that looks for it. `searchOpen` joins `query` as both a guard and a
    // key for the identical reason: a tap arriving with the field expanded but
    // no text typed would otherwise leave the field open over a list the user
    // never filtered, and keyed on `visible` alone this effect would not even
    // re-run to collapse it once `query` had nothing to change.
    //
    // This one guard stays `query.isNotBlank()` rather than `filtering`, and
    // the difference is deliberate: `filtering` asks whether the query narrows
    // the list, while this asks whether the BOX still holds text a tap should
    // take away. A query that folds to nothing narrows nothing but is still
    // text, and leaving it there means the next thing typed is appended to it.
    // Being the wider predicate costs one extra pass and ends in the same
    // empty box.
    LaunchedEffect(focusHabit, visible, loaded, query, searchOpen) {
        if (focusHabit == null || !loaded) return@LaunchedEffect
        if (query.isNotBlank() || searchOpen) {
            onQueryChange("")
            onSearchOpenChange(false)
            return@LaunchedEffect
        }
        // `listRows`, not `visible`: once a category header can be an item,
        // a habit's index in `visible` is not its index in what the
        // `LazyColumn` actually holds, and scrolling by the latter lands on
        // whatever row is that many slots down — a different habit's row,
        // once headers are in the mix.
        val index = listRows.indexOfFirst { it is ListRow.Entry && it.habit.id == focusHabit }
        if (index >= 0) listState.scrollToItem(index)
        onFocused()
    }

    var menuOpen by remember { mutableStateOf(false) }

    val haptic = LocalHapticFeedback.current
    val keyboard = LocalSoftwareKeyboardController.current
    val searchFocusRequester = remember { FocusRequester() }

    // The group's FIRST `onFocusChanged` callback after it is composed always
    // reports `hasFocus = false` — nothing has been granted focus yet, and
    // `requestFocus()` below is still pending in its own effect. Confirming on
    // that callback treated "never focused" the same as "lost focus", so
    // opening the field closed it again on the very next frame. `everFocused`
    // is keyed on `searchOpen` so it starts fresh each time the field opens,
    // and tap-off only fires past the point focus was actually granted once.
    var everFocused by remember(searchOpen) { mutableStateOf(false) }

    // Long-press-to-clear, shared by the collapsed icon's gesture and its
    // TalkBack custom action below, so the two cannot drift apart on what
    // "clear" means. No snackbar: the list visibly growing back and the icon
    // visibly deactivating are the feedback, and the haptic tells a user who
    // is not looking at the screen that the press landed.
    fun clearFilter() {
        onQueryChange("")
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
    }

    // The one path back to collapsed with the filter kept, called from
    // Confirm, the IME action, back and tap-off — so the four exits cannot
    // disagree about what "confirm" does.
    fun confirmSearch() {
        onSearchOpenChange(false)
        keyboard?.hide()
    }

    // Left to the system, back exits the screen entirely, which is the wrong
    // answer while the field is open rather than the list.
    BackHandler(enabled = searchOpen) { confirmSearch() }

    LaunchedEffect(searchOpen) {
        if (searchOpen) searchFocusRequester.requestFocus()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    // "Today" gives way the instant the field expands; the
                    // field itself fades back in over the shrink animation on
                    // the way down, which is the one place the two visibly
                    // overlap. Not worth a crossfade for a transition this
                    // short-lived.
                    if (!searchOpen) {
                        Text("Today")
                    }
                    // In the title slot, not the actions row: that is what
                    // gives it the bar's width once Stats, the search icon and
                    // the overflow give way below. The animation is what makes
                    // the icon and the field read as one control rather than
                    // one replacing the other with no relationship shown.
                    AnimatedVisibility(
                        visible = searchOpen,
                        enter = expandHorizontally(expandFrom = Alignment.End),
                        exit = shrinkHorizontally(shrinkTowards = Alignment.End),
                    ) {
                        TextField(
                            value = query,
                            onValueChange = onQueryChange,
                            modifier = Modifier
                                .fillMaxWidth()
                                .focusRequester(searchFocusRequester)
                                .focusGroup()
                                .onFocusChanged {
                                    // The GROUP's focus, not the field's own:
                                    // pressing Clear or Confirm moves focus to
                                    // that button first, and an `isFocused`
                                    // check on just the field would read that
                                    // as focus having left and auto-confirm
                                    // out from under the press.
                                    //
                                    // Gated on `everFocused`: this callback
                                    // also fires once on composition, before
                                    // `requestFocus()` below has run, reporting
                                    // `hasFocus = false` for a group nothing
                                    // has touched yet — treating that as a
                                    // loss confirmed the field shut on the same
                                    // frame it opened.
                                    if (it.hasFocus) {
                                        everFocused = true
                                    } else if (searchOpen && everFocused) {
                                        confirmSearch()
                                    }
                                },
                            singleLine = true,
                            // Explicit, because this field is in the TITLE
                            // slot: `TopAppBar` wraps that slot in
                            // `ProvideTextStyle(titleTextStyle)`, and
                            // `TextField`'s `textStyle` defaults to
                            // `LocalTextStyle.current` — so a query typed here
                            // renders at the bar's 22sp/28sp headline rather
                            // than the 16sp every other field in this app
                            // uses, roughly a third fewer characters visible
                            // on a 360dp bar before it scrolls under the
                            // caret. Nothing chose 22sp; it was inherited.
                            textStyle = MaterialTheme.typography.bodyLarge,
                            placeholder = { Text("Find a habit") },
                            colors = TextFieldDefaults.colors(
                                focusedContainerColor = Color.Transparent,
                                unfocusedContainerColor = Color.Transparent,
                                focusedIndicatorColor = Color.Transparent,
                                unfocusedIndicatorColor = Color.Transparent,
                            ),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                            keyboardActions = KeyboardActions(onSearch = { confirmSearch() }),
                            trailingIcon = {
                                Row {
                                    // Absent on an empty query, where it would
                                    // mean the same thing as Confirm beside it.
                                    if (query.isNotEmpty()) {
                                        TooltipBox(
                                            positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
                                            tooltip = { PlainTooltip { Text("Clear") } },
                                            state = rememberTooltipState(),
                                        ) {
                                            IconButton(onClick = { onQueryChange("") }) {
                                                Icon(Icons.Default.Clear, contentDescription = "Clear")
                                            }
                                        }
                                    }
                                    TooltipBox(
                                        positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
                                        tooltip = { PlainTooltip { Text("Confirm") } },
                                        state = rememberTooltipState(),
                                    ) {
                                        IconButton(onClick = { confirmSearch() }) {
                                            Icon(Icons.Default.Check, contentDescription = "Confirm")
                                        }
                                    }
                                }
                            },
                        )
                    }
                },
                actions = {
                    // Stats, the search icon and the overflow all give way
                    // while the field is expanded, so it gets the bar's width
                    // rather than what is left over from three 48dp icons;
                    // all three come back the moment `confirmSearch` collapses
                    // it.
                    if (!searchOpen) {
                        TooltipBox(
                            positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
                            tooltip = { PlainTooltip { Text("Stats") } },
                            state = rememberTooltipState(),
                        ) {
                            IconButton(onClick = onOpenStats) {
                                Icon(Icons.Default.BarChart, contentDescription = "Stats")
                            }
                        }
                        // Hidden on an empty account: the onboarding panel or
                        // the full-screen error branch is what shows instead,
                        // and neither is a thing to search. Reads `habits`,
                        // the unfiltered list, for the same reason the reorder
                        // hand-off and the error branch do.
                        //
                        // `|| filtering` is inherited from #173's `showSearch`
                        // (`habits.size >= SEARCH_FROM || query.isNotEmpty() ||
                        // boxHasFocus`), which carried the identical clause for
                        // the identical reason: the icon is the only control
                        // that can clear or re-open a live filter, so it must
                        // not disappear along with the last habit a filter
                        // narrowed the list to. This does not reopen the
                        // decision that the icon is hidden on an empty
                        // account — with no habits AND no filter it stays
                        // hidden; the clause only keeps the escape hatch alive
                        // while a filter it produced is still narrowing
                        // something.
                        if (habits.isNotEmpty() || filtering) {
                            val searchDescription =
                                if (filtering) "Search, filter active" else "Search"
                            // No `TooltipBox` here, unlike Stats/Clear/Confirm
                            // below: `TooltipBox(enableUserInput = true)`
                            // (the default) drives `anchorSemantics`, which
                            // adds the tooltip's OWN long-click semantics
                            // action to this node — on top of the
                            // `onLongClick(label = "Clear filter")` below, two
                            // long-click consumers on one control, a "Search"
                            // bubble popping up over the gesture that drops
                            // the filter, and TalkBack left to choose between
                            // two long-click actions on one node. This
                            // control's long-press is already spoken for, so
                            // it cannot also carry a tooltip. It also does not
                            // need one the other three do: a magnifying glass
                            // is self-evident in a way a bar-chart glyph is
                            // not, and Search never had a word on the bar to
                            // lose the way Stats just did.
                            Box(
                                modifier = Modifier
                                    .size(48.dp)
                                    .combinedClickable(
                                        // Stats, More, Clear and Confirm are
                                        // all `IconButton`, which passes this
                                        // for them; a bare `combinedClickable`
                                        // leaves `Role` out of the config
                                        // entirely, so TalkBack announced this
                                        // one control — the one carrying "a
                                        // filter is live" — as neither a
                                        // button nor anything else, alone
                                        // among its four neighbours.
                                        role = Role.Button,
                                        onClick = { onSearchOpenChange(true) },
                                        // `null`, not an empty lambda, when
                                        // there is nothing to clear:
                                        // `combinedClickable` registers no
                                        // `OnLongClick` semantics action at
                                        // all for a null handler, which is
                                        // what stops an unconditional press
                                        // from firing the haptic for a no-op
                                        // and stops TalkBack advertising a
                                        // long-press that does nothing.
                                        onLongClick = if (filtering) ({ clearFilter() }) else null,
                                    )
                                    // A custom accessibility action, only
                                    // while there is something to clear —
                                    // a long-press handler is otherwise
                                    // invisible to TalkBack, and
                                    // advertising it with no filter live
                                    // advertises a no-op.
                                    .then(
                                        if (filtering) {
                                            Modifier.semantics {
                                                onLongClick(label = "Clear filter") {
                                                    clearFilter()
                                                    true
                                                }
                                            }
                                        } else {
                                            Modifier
                                        },
                                    ),
                                contentAlignment = Alignment.Center,
                            ) {
                                // Badge AND tint, not tint alone: colour
                                // must not be the only channel a filter's
                                // liveness is shown on, and the
                                // description is the only channel TalkBack
                                // has.
                                if (filtering) {
                                    BadgedBox(badge = { Badge() }) {
                                        Icon(
                                            Icons.Default.Search,
                                            contentDescription = searchDescription,
                                            tint = MaterialTheme.colorScheme.primary,
                                        )
                                    }
                                } else {
                                    Icon(Icons.Default.Search, contentDescription = searchDescription)
                                }
                            }
                        }
                        // An overflow rather than more buttons: everything in
                        // here is a screen, not an action — three 48dp
                        // targets plus a "Today" comfortably fit a 360dp bar,
                        // so width was never the reason.
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
                // no-match branch, and a count that lived only inside the list
                // branch would vanish along with it — leaving a partial list
                // on screen with nothing that says it is partial.
                //
                // Ungated on `searchOpen`: a filter survives the field
                // collapsing, and once it does, this line plus the active
                // search icon are the only two things on screen saying the
                // list is not the whole of it. Divisor stays `habits.size`,
                // the unfiltered count.
                if (filtering) {
                    Text(
                        "${visible.size} of ${habits.size}",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
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
                                // Iterates `listRows`, not `visible`: ungrouped that is
                                // `visible` wearing `ListRow.Entry` and nothing else, so
                                // this collapses to the old `items(visible, …)` byte for
                                // byte. Grouped, a `ListRow.Header` is a `stickyHeader` so
                                // it stays pinned over its own section while that section
                                // scrolls underneath it, and a `ListRow.Entry` is the same
                                // `HabitGridRow` + `HorizontalDivider` as before. Keys must
                                // not collide across the two kinds.
                                for (row in listRows) {
                                    when (row) {
                                        is ListRow.Header -> stickyHeader(key = "c:${row.categoryId ?: "none"}") {
                                            CategorySectionHeader(row)
                                        }
                                        is ListRow.Entry -> item(key = "h:${row.habit.id}") {
                                            val habit = row.habit
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
    }
}

/**
 * A category's section header, drawn as a `stickyHeader` so it stays pinned
 * over its own section as the grid scrolls beneath it — the same information
 * the web draws (`dashboard.js`'s `sectionHeader`): the category's colour, its
 * name and its count, and no collapse control (#74).
 *
 * `row.color` is `null` for Uncategorised and `""` for a category whose colour
 * a server omitted (`Category.color`'s own default) — both are "no colour" and
 * neither is handed to [habitColor], which would otherwise try to parse `""`
 * as hex and fall back to the theme's primary rather than drawing no dot.
 *
 * `clearAndSetSemantics`, not a bare `semantics {}`: without it TalkBack would
 * still walk the name and count as two further nodes underneath this one's own
 * description, saying the same thing twice.
 */
@Composable
private fun CategorySectionHeader(row: ListRow.Header) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .clearAndSetSemantics {
                // "1 habit", not "1 habits". A section of one is the ordinary
                // case on an account that has just made a category, so the
                // ungrammatical form is the one most people would hear.
                val unit = if (row.count == 1) "habit" else "habits"
                contentDescription = "${row.name} section, ${row.count} $unit"
            },
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!row.color.isNullOrEmpty()) {
                Box(Modifier.size(12.dp).background(habitColor(row.color), CircleShape))
            }
            Text(row.name, fontWeight = FontWeight.Medium)
        }
        Text(row.count.toString())
    }
}

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
