package com.habiterall.app.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
// A subpackage, so the wildcard above does not reach it.
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.work.WorkInfo
import com.habiterall.app.data.*
import com.habiterall.app.notify.Notifications
import com.habiterall.app.notify.Reminders
import com.habiterall.app.notify.ReminderTime
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.LocalDate

/**
 * The least time the refresh indicator stays up, once it is up at all.
 *
 * A refresh that resolves within a frame of starting — an instant failure with
 * no network, or a LAN server answering in 20ms — flips `isRefreshing` true and
 * back before the indicator's own animation has anywhere to go, and it is left
 * stranded on screen until the next resume clears it. Found on an emulator with
 * Wi-Fi switched off, where the fetch fails so fast the indicator never had a
 * chance to retract; the same instant also reads as a glitch rather than as
 * work, since something appeared and vanished with no result to show for it.
 */
private const val REFRESH_FLOOR_MS = 350L

/**
 * A write that has been made but not yet acknowledged by the server.
 *
 * These are kept apart from the fetched habits and laid over them, because a
 * refetch replaces the list wholesale and the outbox delivers on its own
 * schedule. Scrolling far enough to load more history seconds after a tap used
 * to return the state from *before* the write, so the cell emptied itself again
 * — and the tap cycle then recomputed from the wrong value, so the next tap
 * repeated the write instead of advancing.
 */
private data class PendingWrite(val value: Double?, val skip: Boolean)

/**
 * The habits as they should appear: what the server said, with anything still
 * in flight laid on top.
 */
private fun List<Habit>.withPending(
    pending: Map<Pair<Long, String>, PendingWrite>,
): List<Habit> {
    if (pending.isEmpty()) return this
    return map { habit ->
        val mine = pending.filterKeys { it.first == habit.id }
        if (mine.isEmpty()) return@map habit

        val entries = habit.entries.toMutableMap()
        val skips = habit.skips.toMutableList()
        for ((key, write) in mine) {
            val date = key.second
            if (write.value == null || write.skip) entries.remove(date)
            else entries[date] = write.value
            // A skip lives out of band, so it is removed here as well as added:
            // the value alone cannot say a day stopped being skipped.
            if (write.skip) { if (date !in skips) skips.add(date) } else skips.remove(date)
        }
        habit.copy(entries = entries, skips = skips)
    }
}

/**
 * The scroll offset at which today is on screen.
 *
 * Which end that is depends on the day order, and it is asked for in three
 * places — first layout, a change of order, and coming back to the app — so it
 * is named rather than repeated as a conditional nobody reads twice.
 */
private fun todayEdge(scroll: androidx.compose.foundation.ScrollState, newestLeft: Boolean) =
    if (newestLeft) 0 else scroll.maxValue

class MainActivity : ComponentActivity() {

    private lateinit var settings: Settings

    /**
     * The habit a notification tap asked for, until the list has shown it.
     *
     * Snapshot state rather than a plain field: `setContent` runs once, and the
     * second and later taps arrive at `onNewIntent` long after it — nothing
     * would recompose to notice them otherwise.
     */
    private var openHabit by mutableStateOf<Long?>(null)

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best effort */ }

    /** The habit id a reminder's content intent carries, if this launch is one. */
    private fun habitFrom(intent: Intent?): Long? =
        intent?.getLongExtra(Notifications.EXTRA_HABIT_ID, -1L)?.takeIf { it >= 0 }

    /**
     * A tap that arrives while the app is already up. `singleTop` sends it
     * here instead of building a second copy of the activity.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openHabit = habitFrom(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        openHabit = habitFrom(intent)

        // Say what we want of the window instead of inheriting it. From
        // targetSdk 35 the system draws every app edge to edge whether it asked
        // or not, and then the app owes the insets back — Scaffold and
        // TopAppBar do that, but only once someone has declared the intent.
        // Without this the window's insets were applied on the first layout and
        // came back as zero after a resume, which slid the list up under the
        // bar: the app looked right until you closed and reopened it.
        enableEdgeToEdge()

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

                // The web UI is a screen of this app, not a trip to a
                // browser. See WebScreen for why that matters.
                //
                // Saveable, and two plain strings rather than one small class:
                // rotating while reading a habit's charts used to drop you back
                // on the list, and surviving that needs a Saver for a data class
                // where a String needs nothing.
                var webUrl by rememberSaveable { mutableStateOf<String?>(null) }
                var webTitle by rememberSaveable { mutableStateOf("") }

                // A reminder tap lands on the list, whatever was on screen when
                // the app was last left. Coming back to a chart from three days
                // ago is not an answer to "did you exercise today?".
                LaunchedEffect(openHabit) { if (openHabit != null) webUrl = null }

                when {
                    !checked -> Loading()
                    url == null -> SetupScreen(onSaved = {
                        url = it
                        Reminders.rescheduleAll(this@MainActivity)
                    })
                    // The list stays composed underneath rather than being
                    // swapped out. Swapping discarded everything it remembers —
                    // so scrolling back to March, opening that habit's chart and
                    // coming back put you at today with a spinner and a fresh
                    // 30-day window, every time. It is covered, not gone.
                    else -> Box(Modifier.fillMaxSize()) {
                        Box(
                            Modifier.fillMaxSize().then(
                                // Out of the accessibility tree while covered,
                                // or a screen reader walks a grid nobody can see.
                                if (webUrl != null) Modifier.clearAndSetSemantics {}
                                else Modifier
                            )
                        ) {
                            HabitListScreen(
                                serverUrl = url!!,
                                focusHabit = openHabit,
                                onFocused = { openHabit = null },
                                onOpenStats = { webUrl = url; webTitle = "Statistics" },
                                // Straight to that habit's own page, titled with
                                // its name: landing on the dashboard and hunting
                                // for the habit you just tapped is the seam this
                                // removes.
                                onOpenHabit = { habit ->
                                    webUrl = ServerUrl.habitRoute(url!!, habit.id)
                                    webTitle = habit.name
                                },
                                onChangeServer = { url = null },
                            )
                        }

                        if (webUrl != null) {
                            // Between the two, and doing nothing but swallowing
                            // input. Compose hit-tests front to back and a plain
                            // background does not consume, so without this a tap
                            // on the web screen's toolbar would fall through and
                            // record a day on the grid underneath — invisibly.
                            Box(
                                Modifier.fillMaxSize().pointerInput(Unit) {
                                    awaitPointerEventScope {
                                        while (true) {
                                            awaitPointerEvent().changes.forEach { it.consume() }
                                        }
                                    }
                                }
                            )
                            WebScreen(
                                url = webUrl!!,
                                title = webTitle,
                                onClose = { webUrl = null },
                            )
                        }
                    }
                }
            }
        }
    }

    /**
     * Open the web UI in a real browser.
     *
     * No longer how Stats works — that is `WebScreen`, in-app. This is kept for
     * the cases a WebView is the wrong container for: a user who wants the site
     * in their own browser, with their own extensions and password manager.
     */
    fun openInBrowser(serverUrl: String) {
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
        focusHabit: Long?,
        onFocused: () -> Unit,
        onOpenStats: () -> Unit,
        onOpenHabit: (Habit) -> Unit,
        onChangeServer: () -> Unit,
    ) {
        var habits by remember { mutableStateOf<List<Habit>>(emptyList()) }
        var error by remember { mutableStateOf<String?>(null) }
        var loading by remember { mutableStateOf(true) }
        /** True once a fetch has finished, however it went. See the spinner rule below. */
        var loaded by remember { mutableStateOf(false) }
        var reload by remember { mutableStateOf(0) }
        /**
         * Whether the fetch `reload` is about to start should show itself.
         *
         * Recording a day has to re-ask the server — the streak on each row is
         * its arithmetic, not something this client can advance — but that is
         * not a refresh the user asked for, and putting the pull indicator up
         * on every tap turns a check-off into something that looks like work.
         * Written together with `reload`, in the same event, so the effect
         * below reads the two as one decision.
         */
        var quiet by remember { mutableStateOf(false) }
        var reminderFor by remember { mutableStateOf<Habit?>(null) }
        /** Writes made here that the server has not confirmed yet. */
        var pending by remember { mutableStateOf(mapOf<Pair<Long, String>, PendingWrite>()) }
        /** The day a dialog is editing, and which habit's. */
        var editing by remember { mutableStateOf<Pair<Habit, String>?>(null) }
        var holding by remember { mutableStateOf<Pair<Habit, String>?>(null) }

        /**
         * How much history is loaded, and which way the days run.
         *
         * The window is always "the last N days ending today", which is what
         * `/api/overview` answers: a grid showing days it never fetched
         * renders them all as unrecorded, which is the paging bug the web
         * dashboard already paid for once.
         */
        var windowDays by remember { mutableStateOf(Grid.INITIAL_DAYS) }
        /**
         * Days actually received, which is what the grid draws.
         *
         * Kept apart from `windowDays` because raising the request drew the new
         * columns immediately, against habits still holding the old window: a
         * month of recorded days rendered as blank, and blank is not a neutral
         * state here — the cells are tappable, so the cycle started from the
         * wrong value and a tap on a day that was DONE on the server wrote a
         * skip over it.
         */
        var loadedDays by remember { mutableStateOf(Grid.INITIAL_DAYS) }
        var newestLeft by remember { mutableStateOf(true) }

        /** One scroll position, shared by the header and every habit row. */
        val dayScroll = rememberScrollState()

        val snackbar = remember { SnackbarHostState() }
        val scope = rememberCoroutineScope()

        /**
         * Say something that is worth saying once.
         *
         * `error` drives the full-screen failure state, which only ever shows
         * when there is no list to show instead. Anything that fails while the
         * list IS on screen has nowhere to appear, so it comes through here.
         */
        fun notify(message: String) {
            scope.launch { snackbar.showSnackbar(message) }
        }

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

        /**
         * Today, as the phone reckons it — re-read whenever the app is resumed.
         *
         * It used to be captured once for the life of the composition. A
         * process that survives the night then draws a window ending
         * yesterday: today has no column at all, the cell outlined as "today"
         * writes to yesterday, and long-pressing that same cell opens a dialog
         * headed "Yesterday", because `dayLabel` asks the clock afresh. The
         * reminder that wakes you at 8am is exactly the path that gets there.
         */
        var today by remember { mutableStateOf(LocalDate.now().toString()) }
        val api = remember(serverUrl) { Api(serverUrl) }

        LaunchedEffect(reload, serverUrl, windowDays) {
            // Read and cleared in one go: `quiet` describes THIS fetch only,
            // and clearing it here rather than at the end means a fetch cut
            // short — by paging into more history, say — cannot leave the next
            // one silent as well.
            val silent = quiet
            quiet = false
            if (!silent) loading = true
            val started = SystemClock.elapsedRealtime()

            // Cancellation is rethrown rather than reported, here and below.
            // `runCatching` catches CancellationException like any other, and
            // this effect is restarted every time the window grows — so a fetch
            // cut short by scrolling into more history was being shown to the
            // user as a failed refresh, reading "The coroutine scope left the
            // composition". A restart is not an error; it is this code's own
            // doing.
            try {
                // The day order is the account's, not this device's, so it is
                // read from the server with everything else. Its own failure is
                // not worth a message: the grid renders perfectly well in the
                // default order, and the overview below is the fetch that
                // matters.
                val fetched = api.settings()
                newestLeft = fetched.newestLeft
                // The same fetch answers whether this phone is still a
                // destination, and the alarms read that from the local mirror —
                // so this is where a choice made in a browser reaches them.
                // Free: the request was already being made for the day order.
                settings.cacheAndroidReminders(fetched.androidRemindersEnabled)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // keep whatever order is already showing
            }

            try {
                val data = api.overview(days = windowDays)
                habits = data.habits.filter { h -> !h.archived }
                loadedDays = windowDays
                error = null
                // Re-arm from what just arrived. A reminder time set in a
                // browser shows up in this list immediately and used to change
                // nothing about the alarms — see `Reminders.armFrom`, which is
                // where the whole reason is written down.
                Reminders.armFrom(this@MainActivity, data.habits)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: "Could not reach the server"
                // A refresh that fails with a list already on screen used to
                // say nothing at all, and pulling makes that worse than the
                // button did: the indicator retracts, nothing moves, and
                // there is no hint the server was even asked.
                if (habits.isNotEmpty()) notify(error!!)
                // Give back the days this attempt was for. `dates` is drawn
                // from `loadedDays` below, but the *next* paging decision reads
                // `windowDays`: leaving it raised after a failure means the
                // grid believes it holds history it never received, and quietly
                // stops asking for it again.
                windowDays = loadedDays
            }

            // Hold the indicator up for a moment, but only once it is the
            // thing on screen — the first load has the full-screen spinner
            // instead, and delaying that would just make the app slower. A
            // silent fetch has no indicator to hold up.
            if (loaded && !silent) {
                val left = REFRESH_FLOOR_MS - (SystemClock.elapsedRealtime() - started)
                if (left > 0) delay(left)
            }

            loading = false
            loaded = true
        }

        // Correct a restored scroll position that no longer fits the list.
        //
        // See ScrollRestore for what can go wrong and why; the rule is there,
        // and unit-tested, because the version inlined here only covered a
        // clipped FIRST row and left a clipped row at any other index — which
        // is the case that kept being reported.
        LaunchedEffect(habits.size) {
            if (ScrollRestore.needsSnapToTop(
                    listState.firstVisibleItemIndex,
                    listState.firstVisibleItemScrollOffset,
                    habits.size,
                )
            ) {
                listState.scrollToItem(0)
            }
        }

        // Everything below renders from this, never from `habits` directly.
        val shown = remember(habits, pending) { habits.withPending(pending) }

        val dates = remember(today, loadedDays, newestLeft) {
            Grid.dates(LocalDate.parse(today), loadedDays, newestLeft)
        }
        val cellPx = with(LocalDensity.current) { CELL_WIDTH.roundToPx() }

        // Put today on screen, and keep it there when history arrives.
        //
        // With the newest day on the left there is nothing to do: today is at
        // offset zero and older days are appended off the right-hand edge. With
        // it on the right, today is at the FAR end, so the grid has to be sent
        // there once the width is known — and sent again by exactly the width
        // of whatever was just prepended, or loading a month of history slides
        // the day being looked at off the screen.
        // Keyed on the order, so flipping it re-anchors. Without that, changing
        // the setting reversed the columns but left the offset where it was,
        // and the grid stayed parked in July with today off the far end — the
        // one day you are most likely to want after changing anything.
        var anchored by remember(newestLeft) { mutableStateOf(false) }
        var drawnDays by remember(newestLeft) { mutableStateOf(dates.size) }

        LaunchedEffect(newestLeft, dayScroll.maxValue, dates.size) {
            if (!anchored) {
                dayScroll.scrollTo(todayEdge(dayScroll, newestLeft))
                // Newest-right cannot anchor until there is a width to anchor
                // against; newest-left is at zero and needs none.
                if (newestLeft || dayScroll.maxValue > 0) anchored = true
                drawnDays = dates.size
                return@LaunchedEffect
            }

            if (dates.size > drawnDays) {
                dayScroll.scrollTo(
                    Grid.scrollAfterGrowth(
                        dayScroll.value, dates.size - drawnDays, cellPx, newestLeft
                    )
                )
            }
            drawnDays = dates.size
        }

        // Load more history as the far edge comes into view. Reading the scroll
        // through snapshotFlow rather than on every recomposition keeps this to
        // one decision per settled scroll position instead of one per frame.
        //
        // `armed` is what makes it ONE page per approach. The effect must not be
        // keyed on `windowDays` — it writes it, so the collector tore itself
        // down and restarted, and `snapshotFlow` re-emits on collection while
        // `maxValue` still describes the old column count. The edge therefore
        // still looked near and the window grew twice: measured through a proxy,
        // one swipe to the edge went `days=30` straight to `days=90`, skipping
        // 60 entirely and reaching the cap in half the scrolls. Growing the
        // window moves the scroll away from the edge, which re-arms it.
        LaunchedEffect(dayScroll, newestLeft) {
            var armed = true
            snapshotFlow { dayScroll.value to dayScroll.maxValue }
                .collect { (value, max) ->
                    val atEdge = Grid.needsMore(value, max, windowDays, newestLeft, cellPx * 3)
                    if (atEdge && armed) {
                        windowDays = minOf(windowDays + Grid.PAGE_DAYS, Grid.MAX_DAYS)
                        armed = false
                    } else if (!atEdge) {
                        armed = true
                    }
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
        LaunchedEffect(focusHabit, shown, loaded) {
            if (focusHabit == null || !loaded) return@LaunchedEffect
            val index = shown.indexOfFirst { it.id == focusHabit }
            if (index >= 0) listState.scrollToItem(index)
            onFocused()
        }

        // Coming back to the app shows today, from the top.
        //
        // The check above runs when the list SIZE changes, which is not the same
        // as "the app was reopened": close and reopen with the same five habits
        // and it never fires, so a stale position survives. This is the event
        // that actually matters, and it is also the right moment to refetch —
        // the app is most often reopened because the day moved on.
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        // Read inside the coroutine below, which outlives the composition that
        // launched it: the parameter captured there would be whatever it was
        // when the screen first appeared, and a tap only ever changes it later.
        val pendingFocus = rememberUpdatedState(focusHabit)
        LaunchedEffect(lifecycle) {
            var first = true
            lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                // The first RESUMED is the launch that is already loading.
                if (first) {
                    first = false
                } else {
                    // Before the refetch, so the window asked for is the one
                    // the phone believes in. Past midnight this is a different
                    // day and every column moves.
                    today = LocalDate.now().toString()
                    reload++
                    // Unless this resume IS a notification tap: the two would
                    // race, and whichever landed second decided where the list
                    // sat. Snapping to the top is the right default for coming
                    // back to the app; it is the wrong answer to "show me the
                    // habit I was just asked about".
                    if (pendingFocus.value == null) listState.scrollToItem(0)
                    // Horizontally too: reopening the app to a grid still
                    // scrolled to last March is the same staleness the vertical
                    // snap above exists to fix.
                    dayScroll.scrollTo(todayEdge(dayScroll, newestLeft))
                }
            }
        }

        /**
         * Record one day, on any day the grid shows.
         *
         * A null [value] with no skip means "clear" — which `Outbox` sends as a
         * DELETE. It has to REMOVE the entry rather than store a zero: zero is
         * a real amount for a measurable habit, and "not done" is the absence
         * of a row, so writing 0.0 for a cleared day left it looking recorded.
         */
        fun record(habit: Habit, date: String, value: Double?, skip: Boolean) {
            val key = habit.id to date
            val mine = PendingWrite(value, skip)
            pending = pending + (key to mine)
            Outbox.enqueue(this@MainActivity, habit.id, date, value, skip)

            scope.launch {
                val state = Outbox.awaitWrite(this@MainActivity, habit.id, date)
                // Superseded by a later tap on the same day, which is already
                // holding its own override and waiting on its own work.
                if (state == WorkInfo.State.CANCELLED) return@launch
                // Identity, not equality: only retire the override this call
                // put there. A newer tap's override must outlive this one.
                if (pending[key] === mine) {
                    // Fold it in before dropping it. `habits` still holds the
                    // fetch from *before* this write, so retiring the override
                    // without this puts the old value back on screen the moment
                    // the write succeeds — the cell filling in and then quietly
                    // emptying itself a second later.
                    if (state == WorkInfo.State.SUCCEEDED) {
                        habits = habits.withPending(mapOf(key to mine))
                    }
                    pending = pending - key
                }
                if (state == WorkInfo.State.SUCCEEDED) {
                    // The row shows a streak, and a streak is the server's
                    // arithmetic over the whole history — not something the
                    // overlay above can advance, since it knows one day. Ticking
                    // today and watching the number sit still is exactly the
                    // moment it is being looked at. Silent, and only once the
                    // write is acknowledged, so the answer includes it.
                    quiet = true
                    reload++
                }
                if (state != WorkInfo.State.SUCCEEDED) {
                    // A write the server refused for good. Saying nothing left
                    // the cell showing a value that was never stored, and the
                    // next tap then cycled on from a state the server does not
                    // share.
                    notify("${habit.name} — ${dayLabel(date)} could not be saved")
                    reload++
                }
            }
        }

        /** What a tap does: the web grid's cycle, or the number dialog. */
        fun tapDay(habit: Habit, date: String) {
            if (habit.isNumerical) {
                editing = habit to date
                return
            }
            val current = when {
                habit.isSkipped(date) -> Grid.DayState.SKIPPED
                habit.isMet(habit.valueOn(date), false) == true -> Grid.DayState.DONE
                else -> Grid.DayState.UNSET
            }
            when (Grid.nextState(current)) {
                Grid.DayState.DONE -> record(habit, date, Sentinels.YES, false)
                Grid.DayState.SKIPPED -> record(habit, date, null, true)
                Grid.DayState.UNSET -> record(habit, date, null, false)
            }
        }

        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text("Today") },
                    actions = {
                        TextButton(onClick = onOpenStats) { Text("Stats") }
                    },
                )
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
                onRefresh = { reload++ },
                modifier = Modifier.padding(pad).fillMaxSize(),
            ) {
                when {
                    loading && !loaded -> Loading()
                    error != null && shown.isEmpty() -> Column(
                        // Scrollable so the pull gesture reaches this screen at
                        // all: PullToRefreshBox only hears about a drag that a
                        // scrollable child hands up to it, and this is the one
                        // screen where a retry is the entire point.
                        Modifier.fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(error!!, color = MaterialTheme.colorScheme.error)
                        Button(onClick = { reload++ }) { Text("Try again") }
                        TextButton(onClick = onChangeServer) { Text("Change server") }
                    }
                    shown.isEmpty() -> Column(
                        Modifier.fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(24.dp),
                    ) {
                        Text("No habits yet. Add one in the web app.")
                        TextButton(onClick = onOpenStats) { Text("Open habiterall") }
                    }
                    else -> Column(Modifier.fillMaxSize()) {
                        DayHeader(dates = dates, today = today, scroll = dayScroll)
                        HorizontalDivider()
                        LazyColumn(Modifier.fillMaxSize(), state = listState) {
                            items(shown, key = { it.id }) { habit ->
                                HabitGridRow(
                                    habit = habit,
                                    dates = dates,
                                    today = today,
                                    scroll = dayScroll,
                                    onOpen = { onOpenHabit(habit) },
                                    onSetReminder = { reminderFor = habit },
                                    onTapDay = { date -> tapDay(habit, date) },
                                    onHoldDay = { date -> holding = habit to date },
                                )
                                HorizontalDivider()
                            }
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
                        try {
                            api.setReminder(habit, time, message)
                            // Re-arm immediately: the schedule lives on the
                            // server, but the alarm is local.
                            Reminders.rescheduleAll(this@MainActivity)
                            reload++
                        } catch (e: CancellationException) {
                            throw e            // see the fetch above
                        } catch (e: Exception) {
                            // Not `error`: that drives the "could not load the
                            // list" screen, which is not what happened, and
                            // setting it here would have replaced a real
                            // connection error with this one.
                            notify(e.message ?: "Could not save the reminder")
                        }
                    }
                },
            )
        }

        editing?.let { (habit, date) ->
            CountDialog(
                habit = habit,
                date = date,
                initial = habit.valueOn(date),
                onDismiss = { editing = null },
                onConfirm = { value -> record(habit, date, value, false); editing = null },
                onClear = { record(habit, date, null, false); editing = null },
            )
        }

        holding?.let { (habit, date) ->
            DayDialog(
                habit = habit,
                date = date,
                onDismiss = { holding = null },
                onPick = { value, skip ->
                    holding = null
                    record(habit, date, value, skip)
                },
                onEnterAmount = {
                    holding = null
                    editing = habit to date
                },
            )
        }
    }

    /**
     * How much, on one day.
     *
     * Prefilled with the day's own amount, or the target when there is none —
     * "20 pages" is nearly always what you are about to record, and a habit
     * with no entry yet has nothing better to offer.
     */
    @Composable
    private fun CountDialog(
        habit: Habit,
        date: String,
        initial: Double?,
        onDismiss: () -> Unit,
        onConfirm: (Double) -> Unit,
        onClear: () -> Unit,
    ) {
        var text by remember(date) {
            mutableStateOf(initial?.let { trim(it) } ?: trim(habit.targetValue))
        }
        val parsed = text.trim().toDoubleOrNull()

        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(habit.name) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(dayLabel(date), style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(
                        value = text,
                        onValueChange = { text = it },
                        singleLine = true,
                        label = { Text(habit.unit.ifBlank { "Amount" }) },
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = parsed != null && parsed >= 0,
                    onClick = { parsed?.let(onConfirm) },
                ) { Text("Save") }
            },
            dismissButton = {
                Row {
                    // Only when there is something to remove: an empty day
                    // offering to be emptied is a button that does nothing.
                    if (initial != null || habit.isSkipped(date)) {
                        TextButton(onClick = onClear) { Text("Clear") }
                    }
                    TextButton(onClick = onDismiss) { Text("Cancel") }
                }
            },
        )
    }

    /**
     * Everything a day can be, named rather than cycled to.
     *
     * The tap cycle is quicker once you know it, and unreadable until you do —
     * this is where "skip" is a word instead of a third tap. It mirrors the
     * web's day dialog, minus its Clear button: with no notes in this client,
     * clearing a day and marking it not done are the same write, and two
     * buttons that do one thing is worse than one.
     */
    @Composable
    private fun DayDialog(
        habit: Habit,
        date: String,
        onDismiss: () -> Unit,
        onPick: (Double?, Boolean) -> Unit,
        onEnterAmount: () -> Unit,
    ) {
        val skipped = habit.isSkipped(date)
        val value = habit.valueOn(date)

        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(habit.name) },
            // The choices are the dialog's body, not its buttons. An
            // AlertDialog lays its buttons out in a row, so three of them plus
            // Cancel wrapped into an L-shape where the first choice sat beside
            // Cancel and the rest stacked under it — a menu that reads as a
            // mistake. As full-width rows they read as what they are: a list of
            // what this day could be.
            text = {
                Column {
                    Text(dayLabel(date), style = MaterialTheme.typography.bodySmall)
                    Text(
                        when {
                            skipped -> "Skipped"
                            habit.isNumerical && value != null ->
                                "${trim(value)} / ${trim(habit.targetValue)} ${habit.unit}".trim()
                            habit.isMet(value, false) == true -> "Done"
                            else -> "Not done"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                    )

                    HorizontalDivider(Modifier.padding(vertical = 8.dp))

                    val option = Modifier.fillMaxWidth()
                    if (habit.isNumerical) {
                        TextButton(onClick = onEnterAmount, modifier = option) {
                            Text("Enter an amount", Modifier.fillMaxWidth())
                        }
                    } else {
                        TextButton(
                            onClick = { onPick(Sentinels.YES, false) },
                            modifier = option,
                        ) { Text("Done", Modifier.fillMaxWidth()) }
                    }
                    TextButton(onClick = { onPick(null, false) }, modifier = option) {
                        Text("Not done", Modifier.fillMaxWidth())
                    }
                    TextButton(onClick = { onPick(null, !skipped) }, modifier = option) {
                        Text(if (skipped) "Unskip" else "Skip", Modifier.fillMaxWidth())
                    }
                }
            },
            confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
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

    /**
     * `2026-08-13` as "Today", "Yesterday", or "Thu 13 Aug".
     *
     * A dialog opened from a grid cell has to say which day it is editing, and
     * the ISO date is the one form that reads as a serial number rather than a
     * day — the whole risk of an editable history is fixing the wrong square.
     */
    private fun dayLabel(date: String): String = runCatching {
        val day = LocalDate.parse(date)
        val today = LocalDate.now()
        when (day) {
            today -> "Today"
            today.minusDays(1) -> "Yesterday"
            else -> day.format(java.time.format.DateTimeFormatter.ofPattern("EEE d MMM"))
        }
    }.getOrElse { date }

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
