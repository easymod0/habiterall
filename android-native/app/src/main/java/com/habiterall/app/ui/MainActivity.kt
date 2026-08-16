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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.*
// A subpackage, so the wildcard above does not reach it.
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.zIndex
import androidx.core.app.NotificationManagerCompat
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
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
 * A screen that MANAGES habits, as opposed to answering them.
 *
 * Creating, editing, reordering and the preferences are all things the phone
 * could not do at all until now — `Api` had no POST anywhere in it, so the app
 * was an excellent answering device that could not manage what it answered
 * about. They are grouped rather than routed individually because they share one
 * rule: each is a full-screen sheet over the list, and each reports on the way
 * out whether it wrote anything, because that is what decides if the grid behind
 * it has to be fetched again.
 */
private sealed interface Manage {
    data object NewHabit : Manage
    data class EditHabit(val habit: Habit) : Manage
    data class Reorder(val habits: List<Habit>) : Manage
    data object Settings : Manage
    data object Archive : Manage
}

/**
 * One management screen, chosen by [screen].
 *
 * The API calls live here rather than inside each screen so that the screens
 * stay ignorant of transport — and, more usefully, so the rule the whole feature
 * turns on is written once and in one place: **the server is the source of
 * truth, and every write is followed by taking what the server then says.** A
 * habit write returns the stored habit, a reorder returns the whole list in its
 * new order, and a settings patch is followed by a re-read. Nothing here decides
 * locally what the database now holds.
 */
@Composable
private fun ManageScreen(
    screen: Manage,
    api: Api,
    account: AppSettings,
    onAccount: (AppSettings) -> Unit,
    onEditArchived: (habit: Habit, changed: Boolean) -> Unit,
    onDone: (changed: Boolean) -> Unit,
) {
    val context = LocalContext.current

    when (screen) {
        Manage.NewHabit -> HabitFormScreen(
            existing = null,
            confirmDelete = account.confirmDeleteEnabled,
            onSave = { input -> api.createHabit(input) },
            onClose = onDone,
        )

        is Manage.EditHabit -> HabitFormScreen(
            existing = screen.habit,
            confirmDelete = account.confirmDeleteEnabled,
            onSave = { input -> api.updateHabit(screen.habit.id, input) },
            onDelete = { api.deleteHabit(screen.habit.id) },
            onClose = onDone,
        )

        is Manage.Reorder -> ReorderScreen(
            habits = screen.habits,
            onReorder = { ids -> api.reorderHabits(ids) },
            onClose = onDone,
        )

        Manage.Archive -> ArchiveScreen(
            load = { api.habits(archived = true) },
            // A whole habit with one field flipped, not a patch: the route
            // replaces, so `{archived: false}` on its own would blank the name.
            onUnarchive = { habit ->
                api.updateHabit(habit.id, habit.toInput().copy(archived = false))
            },
            onEdit = onEditArchived,
            onClose = onDone,
        )

        Manage.Settings -> SettingsScreen(
            initial = account,
            // Whether Android itself will let a notification through, which is a
            // different question from whether the account wants one here. The
            // switch stays usable either way — the setting is the account's and
            // governs other devices too — but the subtitle has to say when the
            // answer will be ignored by the system regardless.
            androidRemindersSupported =
                NotificationManagerCompat.from(context).areNotificationsEnabled(),
            onPatch = { patch ->
                // What it would not take, kept: a key this server does not know
                // comes back in `ignored` with a 200 rather than as an error, so
                // this is the only evidence that a control which sprang back did
                // so because the write never happened.
                val ignored = api.updateSettings(patch).ignored
                // Re-read rather than trusting the patch. `PUT /settings`
                // answers with what it ACCEPTED, not with the settings — and
                // `SETTING_VALUES` normalises as well as validates, so the
                // stored value can differ from the one sent. Asking again is
                // also what makes a change the web made in the meantime show up
                // here rather than being written over.
                val fresh = api.settings()
                onAccount(fresh)
                // The two the alarms read offline. `Reminders.armFrom` is the
                // other half of this and runs from the list's fetch; these are
                // the mirrors a receiver reads when there is no network at all,
                // and a setting changed here has to reach them now rather than
                // at the next successful overview.
                Settings(context).cacheAndroidReminders(fresh.androidRemindersEnabled)
                Settings(context).cacheSkipDays(fresh.skipDaysEnabled)
                Reminders.rescheduleAll(context)
                PatchOutcome(fresh, ignored)
            },
            onClose = onDone,
        )
    }
}

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

                /**
                 * What the server says about this client's session, and null
                 * while nothing has asked yet.
                 *
                 * Asked once per server rather than per screen. `/api/me` is the
                 * only route that answers a caller with no session, so it is
                 * both how the app learns it is signed out and how it learns
                 * which sign-in this instance HAS — a personal server with a
                 * password and a cloud one behind an identity provider need
                 * different screens, and only the server knows which it is.
                 */
                var session by remember { mutableStateOf<Session?>(null) }

                /** Bumped to re-ask, after a sign-in, a sign-out, or a 401. */
                var authKey by remember { mutableIntStateOf(0) }

                /**
                 * The identity provider's end-session URL, while the trip to it
                 * is on screen. Null the rest of the time, which is always for
                 * an edition or a provider with nowhere to go — see
                 * `Auth.endSession`.
                 *
                 * Saveable, for the reason `webUrl` below is: rotating in the
                 * middle of it would otherwise drop the visit and leave the
                 * provider signed in, which is the bug this whole path exists
                 * to fix, arrived at from a different direction.
                 */
                var endSession by rememberSaveable { mutableStateOf<String?>(null) }

                /**
                 * One client for asking about the session and ending it.
                 *
                 * `Api` builds an OkHttpClient with its own dispatcher and
                 * connection pool, and this is asked again on every 401 from
                 * anywhere — so building one per check is the cost the
                 * management screens already take care to avoid.
                 */
                val authApi = remember(url) { url?.let { Api(it) } }

                LaunchedEffect(authApi, authKey) {
                    // Null first, so the app is never on screen against a
                    // session belonging to the previous server.
                    session = null
                    session = authApi?.me()
                }

                /**
                 * A refused session, from anywhere, sends the whole app back to
                 * the sign-in screen.
                 *
                 * One handler rather than one per screen: every screen already
                 * catches something to show a message, and not every one of them
                 * would remember to ask what the status was. Hopped onto the
                 * main thread because this is called from OkHttp's.
                 *
                 * Remembered, and that is not tidiness: the screens below key
                 * their `Api` on it, and a lambda rebuilt every recomposition
                 * would rebuild the client — and its connection pool — with it.
                 */
                val onUnauthorized: () -> Unit = remember { { runOnUiThread { authKey++ } } }

                /**
                 * Whether there is a session to end.
                 *
                 * False on an instance with `HABITERALL_AUTH=off`, where the
                 * menu item would offer to sign out of something that does not
                 * exist — and raise the question of why signing in is not on
                 * offer either.
                 */
                val canSignOut = (session as? Session.Active)?.mode?.needsSignIn == true

                // The web UI is a screen of this app, not a trip to a
                // browser. See WebScreen for why that matters.
                //
                // Saveable, and two plain strings rather than one small class:
                // rotating while reading a habit's charts used to drop you back
                // on the list, and surviving that needs a Saver for a data class
                // where a String needs nothing.
                var webUrl by rememberSaveable { mutableStateOf<String?>(null) }
                var webTitle by rememberSaveable { mutableStateOf("") }

                // One WebView for the life of the activity, rather than one per
                // tap. See WebHost — this is what stops every habit opening with
                // a cold browser start in front of the user.
                val webHost = remember { WebHost() }

                // Stopped while the app is not being looked at. A WebView that
                // outlives the screen also outlives the app being on screen, and
                // destroying it on the way out is what used to guarantee its
                // JavaScript was not still running in a pocket — see WebHost.pause.
                val lifecycleOwner = LocalLifecycleOwner.current
                DisposableEffect(lifecycleOwner, webHost) {
                    val observer = LifecycleEventObserver { _, event ->
                        when (event) {
                            Lifecycle.Event.ON_PAUSE -> webHost.pause()
                            Lifecycle.Event.ON_RESUME -> webHost.resume()
                            else -> Unit
                        }
                    }
                    lifecycleOwner.lifecycle.addObserver(observer)
                    onDispose {
                        lifecycleOwner.lifecycle.removeObserver(observer)
                        webHost.destroy()
                    }
                }

                // Warm while nothing is open, and navigate when something is.
                // Keyed on both, so closing the screen re-enters with a target of
                // null and `warm()` declines to undo the habit already loaded.
                LaunchedEffect(url, webUrl) {
                    if (url == null) return@LaunchedEffect
                    val target = webUrl
                    if (target == null) webHost.warm() else webHost.show(target)
                }

                // A web screen belongs to the session that opened it. `show()`
                // declines to navigate when the WebView is already on the target
                // URL, so leaving one open across a sign-out would re-show the
                // previous account's page to the next one — same habit id, same
                // URL, nothing to tell it to reload. Closing it means the next
                // open is a real load.
                //
                // `is Absent`, NOT `!is Active`, and the difference is a bug that
                // shipped in the first version of this. `session` is plain
                // `remember`, so it is null on every activity recreation, while
                // `webUrl` is `rememberSaveable` precisely so that rotating while
                // reading a habit's charts does not drop you back on the list —
                // see its declaration. `!is Active` fires during that null phase
                // and throws the restored value away, undoing the one thing
                // saving it was for. It also fired on every silent re-check.
                LaunchedEffect(session) {
                    if (session is Session.Absent) webUrl = null
                }

                /** Which management screen is over the list, if any. */
                var manage by remember { mutableStateOf<Manage?>(null) }
                /** Bumped when one of them writes something the list must refetch. */
                var refreshKey by remember { mutableIntStateOf(0) }
                /**
                 * The account's settings, reported up by the list after each of
                 * its fetches and updated in place by the settings screen.
                 *
                 * One copy for the whole activity, because the alternative is
                 * each screen fetching its own and two of them disagreeing —
                 * which for `confirmDelete` means a delete that does or does not
                 * ask depending on which screen you reached it from.
                 */
                var account by remember { mutableStateOf(AppSettings()) }

                // A reminder tap lands on the list, whatever was on screen when
                // the app was last left. Coming back to a chart from three days
                // ago is not an answer to "did you exercise today?". A management
                // screen goes with it: the notification asked about today, and
                // answering it should not be behind a form.
                LaunchedEffect(openHabit) {
                    if (openHabit != null) { webUrl = null; manage = null }
                }

                when {
                    !checked -> Loading()
                    url == null -> SetupScreen(onSaved = {
                        url = it
                        Reminders.rescheduleAll(this@MainActivity)
                    })
                    // Above the session branches, and both orderings matter.
                    // `authKey++` nulls the session while it is re-asked, so
                    // below `session == null` this would be a spinner over a
                    // sign-out nobody can see; below `Absent` it would be the
                    // sign-in screen offering to undo what was just asked for.
                    // The trip is the last thing signing out does, so it is what
                    // is on screen until it is finished.
                    endSession != null -> SignOutScreen(
                        serverUrl = url!!,
                        endSessionUrl = endSession!!,
                        onDone = { endSession = null },
                    )
                    // Nothing is drawn against an unknown session. The
                    // alternative is showing the list and replacing it a request
                    // later, which is the flash of the wrong screen that
                    // `start()` was rewritten in the web app to avoid.
                    session == null -> Loading()
                    // `Session.Unknown` is deliberately not a branch here. The
                    // app carries on to the list, whose own error handling is
                    // better at reporting a broken server than a screen invented
                    // for the purpose — and an instance with NO sign-in must not
                    // acquire a way to fail at boot that it never had. See
                    // Session.Unknown for the whole argument.
                    session is Session.Absent && authApi != null -> SignInScreen(
                        api = authApi,
                        mode = (session as Session.Absent).mode,
                        onSignedIn = { authKey++ },
                        onChangeServer = { url = null },
                    )
                    // The list stays composed underneath rather than being
                    // swapped out. Swapping discarded everything it remembers —
                    // so scrolling back to March, opening that habit's chart and
                    // coming back put you at today with a spinner and a fresh
                    // 30-day window, every time. It is covered, not gone.
                    else -> Box(Modifier.fillMaxSize()) {
                        // One client for every management screen, rather than one
                        // per opening: `Api` builds an OkHttpClient, and a screen
                        // that can be opened and closed all afternoon should not
                        // leave a connection pool behind each time.
                        val manageApi = remember(url) { Api(url!!, onUnauthorized) }

                        Box(
                            Modifier.fillMaxSize().then(
                                // Out of the accessibility tree while covered,
                                // or a screen reader walks a grid nobody can see.
                                // Both covers count: the management sheets stop
                                // TOUCHES with the pointer-consuming Box below,
                                // and a swipe-to-explore gesture is not a touch —
                                // it would otherwise read out the grid behind an
                                // open form.
                                if (webUrl != null || manage != null) {
                                    Modifier.clearAndSetSemantics {}
                                } else {
                                    Modifier
                                }
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
                                // Null when this instance has no sign-in, so the
                                // personal edition with `HABITERALL_AUTH=off`
                                // does not offer to sign out of nothing.
                                onSignOut = if (canSignOut && authApi != null) {
                                    {
                                        lifecycleScope.launch {
                                            // The local session ends here
                                            // regardless; what comes back is
                                            // the identity provider's own
                                            // sign-out, which has to be a page
                                            // rather than a request. Both
                                            // happen: the app is signed out
                                            // whether or not that trip works,
                                            // and `authKey` is what takes the
                                            // screens down.
                                            endSession = authApi.signOut()
                                            authKey++
                                        }
                                    }
                                } else {
                                    null
                                },
                                onUnauthorized = onUnauthorized,
                                refreshKey = refreshKey,
                                onNewHabit = { manage = Manage.NewHabit },
                                onEditHabit = { manage = Manage.EditHabit(it) },
                                onReorder = { manage = Manage.Reorder(it) },
                                onOpenSettings = { manage = Manage.Settings },
                                onOpenArchive = { manage = Manage.Archive },
                                onAccount = { account = it },
                            )
                        }

                        // The management screens, over the list for the reason
                        // the list itself is kept underneath the web screen:
                        // covering costs nothing and swapping loses the grid's
                        // scroll position, its window and its pending writes.
                        manage?.let { screen ->
                            Box(
                                Modifier.fillMaxSize().zIndex(2f).pointerInput(Unit) {
                                    awaitPointerEventScope {
                                        while (true) {
                                            awaitPointerEvent().changes.forEach { it.consume() }
                                        }
                                    }
                                }
                            )
                            Box(Modifier.fillMaxSize().zIndex(3f)) {
                                ManageScreen(
                                    screen = screen,
                                    api = manageApi,
                                    account = account,
                                    onAccount = { account = it },
                                    // Straight from the archive into the form,
                                    // replacing this screen rather than stacking
                                    // on it: the form's own Archived switch is
                                    // the other way to restore, and coming back
                                    // to a list that no longer holds the habit
                                    // is a screen showing a stale row.
                                    onEditArchived = { habit, wrote ->
                                        // The archive's own writes are banked
                                        // here rather than at a close it never
                                        // gets: this replaces that screen, so a
                                        // habit restored a moment ago would
                                        // otherwise be forgotten if the form is
                                        // then backed out of unchanged.
                                        if (wrote) refreshKey++
                                        manage = Manage.EditHabit(habit)
                                    },
                                    onDone = { changed ->
                                        manage = null
                                        // Only when something was actually
                                        // written. Backing out of the form
                                        // should not cost a refetch, and a
                                        // refetch is what puts the pull
                                        // indicator up on a list nobody touched.
                                        if (changed) refreshKey++
                                    },
                                )
                            }
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
                        }

                        // Unconditional, unlike the blocker above it: the screen
                        // is hidden rather than removed, because a WebView that
                        // leaves the tree is a WebView that has to be built again
                        // on the next tap. `shown` carries the difference, and
                        // WebScreen raises its own zIndex above this Box when it
                        // is true.
                        WebScreen(
                            host = webHost,
                            title = webTitle,
                            shown = webUrl != null,
                            onClose = { webUrl = null },
                        )
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

    // There is deliberately no "the server answered oddly" screen. An early
    // version had one, and it was a new way to break the one configuration that
    // never needed this endpoint: an instance with no sign-in, where a 429 from
    // the IP-keyed read limiter would have covered a working app. The list's own
    // error state already reports a broken server, with a retry, and it is
    // reached by the requests that actually need the server to work.

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
        /**
         * End the session and go back to the sign-in screen. Absent — as a
         * disabled menu item — on an instance with no sign-in, where there is
         * nothing to end and the control would only raise the question.
         */
        onSignOut: (() -> Unit)?,
        /** Hands a refused session up to the activity; see its declaration. */
        onUnauthorized: () -> Unit,
        /**
         * Bumped by the caller when a screen it owns has changed the data.
         *
         * Creating, editing, deleting or reordering a habit all happen on other
         * screens, and this one holds the fetched list — so without a key to
         * change, coming back from the form showed the list as it was before the
         * edit until something else happened to refetch.
         */
        refreshKey: Int,
        onNewHabit: () -> Unit,
        onEditHabit: (Habit) -> Unit,
        onReorder: (List<Habit>) -> Unit,
        onOpenSettings: () -> Unit,
        onOpenArchive: () -> Unit,
        /**
         * Reports the account's settings upward after every fetch.
         *
         * This screen already asks for them on each reload, and two of the
         * screens above it need the answer — the settings screen to open on it,
         * and the habit form to know whether Delete confirms. A second fetch of
         * the same endpoint would be free to disagree with the grid on screen,
         * which is the kind of difference nobody tracks down.
         */
        onAccount: (AppSettings) -> Unit,
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
        // Both default off until the settings fetch says otherwise, matching the
        // server's defaults: a phone that has not asked yet must not offer a
        // state the account has switched off.
        var skipDays by remember { mutableStateOf(false) }
        var questionMarks by remember { mutableStateOf(false) }
        // Seeded from the mirror the notification already reads, so the grid and
        // the shade agree during the first paint — before any fetch lands, and for
        // as long as one cannot (the mirror is what works offline).
        LaunchedEffect(Unit) {
            runCatching { skipDays = settings.cachedSkipDays() }
        }

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
        val api = remember(serverUrl, onUnauthorized) { Api(serverUrl, onUnauthorized) }

        LaunchedEffect(reload, serverUrl, windowDays, refreshKey) {
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
                // Reported upward, not kept: the three flags below are all this
                // screen itself obeys, and the whole object belongs to the
                // activity, which is where the screens above it read it from. A
                // second copy here would be a second thing to keep current.
                onAccount(fetched)
                newestLeft = fetched.newestLeft
                skipDays = fetched.skipDaysEnabled
                questionMarks = fetched.questionMarksEnabled
                // The same fetch answers whether this phone is still a
                // destination, and the alarms read that from the local mirror —
                // so this is where a choice made in a browser reaches them.
                // Free: the request was already being made for the day order.
                settings.cacheAndroidReminders(fetched.androidRemindersEnabled)
                // Mirrored for the notification, which is built by a receiver
                // with no chance to ask the server: an alarm can fire on a phone
                // that has been offline for a week, and a Skip action the account
                // has switched off must not appear in the shade.
                settings.cacheSkipDays(fetched.skipDaysEnabled)
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
            // `entries[date]`, not `valueOn`: the map holding nothing for a day is
            // what makes it UNKNOWN rather than an answered "no", and valueOn
            // also returns null for a skip.
            val current = Grid.dayStateOf(
                value = habit.entries[date],
                isSkip = habit.isSkipped(date),
                done = habit.isMet(habit.valueOn(date), false) == true,
            )
            when (Grid.nextState(current, skipDays, questionMarks)) {
                Grid.DayState.DONE -> record(habit, date, Sentinels.YES, false)
                Grid.DayState.SKIPPED -> record(habit, date, null, true)
                // A stated lapse is a row holding 0; only UNKNOWN clears the day,
                // which the outbox turns into a DELETE.
                Grid.DayState.NO -> record(habit, date, Sentinels.UNSET, false)
                Grid.DayState.UNKNOWN -> record(habit, date, null, false)
            }
        }

        var menuOpen by remember { mutableStateOf(false) }

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
                                enabled = shown.size > 1,
                                onClick = { menuOpen = false; onReorder(shown) },
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
                        // "Add one in the web app" is what this said until the
                        // phone could create one, which is the single change
                        // that most decided whether this client was a companion
                        // or a client in its own right.
                        Text("No habits yet.")
                        Button(onClick = onNewHabit) { Text("Add a habit") }
                        TextButton(onClick = onOpenStats) { Text("Open the web app") }
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
                                    onEdit = { onEditHabit(habit) },
                                    onSetReminder = { reminderFor = habit },
                                    onTapDay = { date -> tapDay(habit, date) },
                                    onHoldDay = { date -> holding = habit to date },
                                    questionMarks = questionMarks,
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
                skipDays = skipDays,
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
        skipDays: Boolean,
        onDismiss: () -> Unit,
        onPick: (Double?, Boolean) -> Unit,
        onEnterAmount: () -> Unit,
    ) {
        val skipped = habit.isSkipped(date)
        val value = habit.valueOn(date)
        // A row exists for this day, whatever it says. Not `value != null`, which
        // is null for a skip too.
        val answered = skipped || habit.entries[date] != null

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
                            !answered -> "No entry"
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
                    // A stated lapse: a row holding 0, not the absence of one. It
                    // used to pass `null`, which cleared the day — the same
                    // conflation the web dialog had, and the reason "Clear" is
                    // now its own row rather than this one wearing two hats.
                    TextButton(
                        onClick = { onPick(Sentinels.UNSET, false) },
                        modifier = option,
                    ) { Text("Not done", Modifier.fillMaxWidth()) }
                    // Hidden when the account does not use skips — but never on a
                    // day that already is one, or an imported Loop skip could not
                    // be undone from here at all.
                    if (skipDays || skipped) {
                        TextButton(onClick = { onPick(null, !skipped) }, modifier = option) {
                            Text(if (skipped) "Unskip" else "Skip", Modifier.fillMaxWidth())
                        }
                    }
                    // Back to "nothing is known about this day", which with
                    // question marks off is the only way there: the tap cycle
                    // deliberately does not return to it. Offered only when there
                    // is something to remove — and not on a skipped day, where
                    // "Unskip" above is the same write and two differently-labelled
                    // buttons doing one thing reads as one of them doing something
                    // else.
                    if (answered && !skipped) {
                        TextButton(onClick = { onPick(null, false) }, modifier = option) {
                            Text("Clear", Modifier.fillMaxWidth())
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        )
    }

    /**
     * Setting a habit's reminder from the list, without opening the form.
     *
     * The time control is [ReminderTimeField], shared with the habit form —
     * that is where the rule about the box being the submitted value lives, and
     * why this was never a bare `^HH:MM$` field.
     *
     * What is this dialog's own is the pair of exits. "Remove" is a first-class
     * button rather than a hidden gesture, and it does not merely clear the box:
     * it SAVES an empty time and closes, because that is what deleting a
     * reminder from here means. The habit form's equivalent clears its draft
     * instead, since nothing there is written until Save.
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

                    // The picker, the box and the quick picks, shared with the
                    // habit form — see [ReminderTimeField]. "Remove" stays a
                    // dialog button rather than a quick pick here, because it
                    // does not edit the field: it saves an empty time and
                    // closes.
                    ReminderTimeField(value = typed, onValueChange = { typed = it })

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
